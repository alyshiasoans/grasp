"""
Background worker functions for real-time EMG classification and training collection.
"""

import os
import json
import time
import random
import threading
import numpy as np
from scipy.signal import butter, lfilter, lfilter_zi, iirnotch
from collections import deque, Counter
from datetime import datetime, timezone

from config import (
    BASE_DIR, MAT_PATH, MODEL_PATH, PLAYBACK_SPEED,
    GESTURE_CLASSES, GESTURE_COLORS,
    F_LOWER, F_UPPER, F_NOTCH, BW_NOTCH,
    N_ON, N_OFF, DET_WIN_MS, DET_STEP_MS, WIN_MS, MAX_GESTURE_S,
    S64_FSAMP, S64_NCH, S64_MODE,
    GESTURE_S, REST_S, INITIAL_REST_S, TRAINING_DIR,
)
import state
from emg_sources import SimulatedSource, LiveSource
from signal_processing import feats
from models import db, User, Gesture, UserGesture, Session, TrainingGesture, TrainingFile, ModelVersion


# ── Prediction worker ─────────────────────────────────────────────────────────

def run_worker(app, socketio, mode="simulated", live_opts=None, user_id=None):
    """
    Process EMG data and emit SocketIO updates.
    Uses absolute RMS thresholds.
    """
    state.worker_running = True
    live_opts = live_opts or {}
    state.test_sample_counter = 0
    test_gesture_start = 0
    print(f"[worker] run_worker started, mode={mode}, user_id={user_id}")

    try:
        import joblib
    except ImportError:
        print("[worker] ERROR: joblib not installed")
        socketio.emit("log", {"text": "ERROR: joblib not installed"})
        state.worker_running = False
        return

    socketio.emit("state", {"label": "LOADING...", "gesture": "—", "color": "#ffffff", "act": 0.0})

    # ── Resolve model path ────────────────────────────────────────────────
    model_path = MODEL_PATH
    if state.runtime_config["model_path"] and os.path.isfile(state.runtime_config["model_path"]):
        model_path = state.runtime_config["model_path"]
        print(f"[worker] using runtime config model: {model_path}")
    elif user_id:
        with app.app_context():
            active_mv = ModelVersion.query.filter_by(user_id=user_id, is_active=True).first()
            if active_mv and active_mv.file_path:
                candidate = os.path.join(BASE_DIR, active_mv.file_path)
                if os.path.isfile(candidate):
                    model_path = candidate
                    print(f"[worker] using active model for user {user_id}: {active_mv.file_path}")
                else:
                    print(f"[worker] active model file missing: {candidate}, trying fallback")
            else:
                print(f"[worker] no active model for user {user_id}, trying fallback")

    if not os.path.isfile(model_path):
        msg = f"ERROR: no model file found (looked for {model_path})"
        print(f"[worker] {msg}")
        socketio.emit("log", {"text": msg})
        state.worker_running = False
        return

    try:
        scaler, model = joblib.load(model_path)
        print(f"[worker] model loaded from {model_path}")
        socketio.emit("log", {"text": f"✓  model loaded ({os.path.basename(model_path)})"})
    except Exception as e:
        print(f"[worker] ERROR loading model: {e}")
        socketio.emit("log", {"text": f"ERROR loading model: {e}"})
        state.worker_running = False
        return

    # ── Create source ─────────────────────────────────────────────────────
    if mode == "live":
        source = LiveSource(
            host=live_opts.get("host", "0.0.0.0"),
            port=int(live_opts.get("port", 45454)),
            fsamp=int(live_opts.get("fsamp", S64_FSAMP)),
            nch=int(live_opts.get("nch", S64_NCH)),
            mode=int(live_opts.get("mode_bits", S64_MODE)),
            emg_channels=int(live_opts.get("emg_channels", 64)),
            on_log=lambda msg: socketio.emit("log", {"text": msg}),
        )
        Fs   = source.Fs
        n_ch = source.emg_channels
    else:
        # Resolve username for user-specific training data
        sim_user = None
        if user_id:
            with app.app_context():
                u = User.query.get(user_id)
                if u:
                    sim_user = u.username
        try:
            source = SimulatedSource(MAT_PATH, PLAYBACK_SPEED, user=sim_user)
        except Exception as e:
            socketio.emit("log", {"text": f"ERROR loading simulation data: {e}"})
            state.worker_running = False
            return
        Fs   = source.Fs
        n_ch = source.n_channels
        socketio.emit("log", {"text": f"Simulating from {source._source_label} @ {Fs:.0f} Hz"})

    state.active_source = source

    # ── Filters ───────────────────────────────────────────────────────────
    nyq = Fs / 2
    b_bp, a_bp = butter(2, [F_LOWER / nyq, F_UPPER / nyq], btype='band')
    b_n,  a_n  = iirnotch(F_NOTCH / nyq, F_NOTCH / BW_NOTCH)
    zi_bp = np.tile(lfilter_zi(b_bp, a_bp), (n_ch, 1))
    zi_n  = np.tile(lfilter_zi(b_n,  a_n),  (n_ch, 1))

    def filt(raw_1d):
        nonlocal zi_bp, zi_n
        y, zi_bp[:] = lfilter(b_bp, a_bp, raw_1d[:, None], zi=zi_bp)
        y, zi_n[:]  = lfilter(b_n,  a_n,  y,               zi=zi_n)
        return y.squeeze()

    # ── Window sizes ──────────────────────────────────────────────────────
    det_win  = int(DET_WIN_MS  / 1000 * Fs)
    det_step = int(DET_STEP_MS / 1000 * Fs)
    win_s    = int(WIN_MS      / 1000 * Fs)
    max_g    = int(MAX_GESTURE_S * Fs)

    t_on  = state.runtime_config["t_on"]
    t_off = state.runtime_config["t_off"]

    rest_mean    = np.ones(n_ch)
    calib_done   = True

    # ── Detection state ───────────────────────────────────────────────────
    det_buf     = deque(maxlen=det_win)
    raw_buf     = deque(maxlen=det_win)
    gest_buf    = []
    det_ctr     = 0
    state_      = 0
    cnt_on      = 0
    cnt_off     = 0
    votes       = []
    last_printed = ""

    sig_flex = []
    sig_ext  = []

    last_signal_emit = 0.0
    last_state_emit  = 0.0
    SIGNAL_EMIT_INTERVAL = 0.25
    STATE_EMIT_INTERVAL  = 0.20

    print(f"[worker] skipping calibration — using absolute thresholds")
    socketio.emit("log", {"text": "✓  No calibration — using absolute thresholds"})
    socketio.emit("log", {"text": f"✓  T_ON={t_on}  T_OFF={t_off}  MIN_VOTES={state.runtime_config['min_votes']}"})
    socketio.emit("state", {"label": "REST", "gesture": "REST", "color": "#444444", "act": 0.0})

    # ── Main sample loop ──────────────────────────────────────────────────
    for raw in source.stream():
        if not state.worker_running:
            break

        if state.test_session_id is not None:
            state.test_sample_buffer.append(raw.copy())
            state.test_sample_counter += 1

        filtered = filt(raw - np.mean(raw))

        if state_ == 1:
            gest_buf.append(filtered)
        det_buf.append(filtered)
        raw_buf.append(raw)

        if len(det_buf) < det_win:
            continue
        det_ctr += 1
        if det_ctr < det_step:
            continue
        det_ctr = 0

        # Filtered activation — used for gesture ON/OFF detection
        w   = np.stack(det_buf, axis=1)
        act_filt = float(np.median(np.sqrt(np.mean(w ** 2, axis=1)) / rest_mean))

        # Raw activation — used for EMG strip display
        w_raw = np.stack(raw_buf, axis=1)
        act = float(np.median(np.sqrt(np.mean(w_raw ** 2, axis=1))))

        act_flex = float(np.median(np.sqrt(np.mean(w_raw[:32] ** 2, axis=1))))
        act_ext  = float(np.median(np.sqrt(np.mean(w_raw[32:n_ch] ** 2, axis=1))))
        sig_flex.append(act_flex)
        sig_ext.append(act_ext)

        now = time.perf_counter()
        if now - last_signal_emit >= SIGNAL_EMIT_INTERVAL:
            last_signal_emit = now
            wf = sig_flex[-100:]
            we = sig_ext[-100:]
            sf = len(sig_flex) - len(wf)
            se = len(sig_ext) - len(we)
            socketio.emit("signal", {
                "flexors":   [{"x": sf + j, "y": round(v, 6)} for j, v in enumerate(wf)],
                "extensors": [{"x": se + j, "y": round(v, 6)} for j, v in enumerate(we)],
                "t_on":  t_on,
                "t_off": t_off,
            })

        if now - last_state_emit >= STATE_EMIT_INTERVAL:
            last_state_emit = now
            socketio.emit("state", {
                "label":   "ACTIVE" if state_ else "REST",
                "gesture": "" if state_ else "REST",
                "color":   "#ffffff" if state_ else "#444444",
                "act":     round(act, 6),
            })

        # Re-read thresholds each step so live changes apply
        t_on  = state.runtime_config["t_on"]
        t_off = state.runtime_config["t_off"]

        if state_ == 0:
            if act_filt > t_on:
                cnt_on += 1
                if cnt_on >= N_ON:
                    socketio.emit("state", {"label": "ACTIVE", "gesture": "", "color": "#ffffff", "act": round(act, 6)})
                    socketio.emit("log",   {"text": "▶  gesture start"})
                    state_ = 1; gest_buf = []; votes = []; last_printed = ""; cnt_on = 0
                    if state.test_session_id is not None:
                        test_gesture_start = state.test_sample_counter
            else:
                cnt_on = 0
        else:
            gest_buf.append(filtered)
            cnt_off = cnt_off + 1 if act_filt < t_off else 0
            gesture_end = (cnt_off >= N_OFF) or (len(gest_buf) >= max_g)

            if len(gest_buf) >= win_s:
                window = np.stack(gest_buf[-win_s:], axis=1)
                f = feats(window)
                v = model.predict(scaler.transform(f.reshape(1, -1)))[0]
                votes.append(v)

            min_v = state.runtime_config["min_votes"]
            if len(votes) >= min_v:
                vc = np.zeros(len(GESTURE_CLASSES))
                for v in votes:
                    if v < len(GESTURE_CLASSES):
                        vc[v] += 1
                gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                col   = GESTURE_COLORS.get(gname, "#ffffff")
                vote_names = [GESTURE_CLASSES.get(int(v), "?") for v in votes if v < len(GESTURE_CLASSES)]
                socketio.emit("state", {
                    "label": "ACTIVE", "gesture": gname, "color": col,
                    "act": round(act, 6), "votes": vote_names,
                })
                if gname != last_printed:
                    socketio.emit("log", {"text": f"  → {gname}"})
                    last_printed = gname

            if gesture_end:
                socketio.emit("log", {"text": "■  gesture end"})
                if state.test_session_id is not None:
                    state.test_gesture_intervals.append([test_gesture_start, state.test_sample_counter, None])
                if len(votes) >= min_v:
                    vc = np.zeros(len(GESTURE_CLASSES))
                    for v in votes:
                        if v < len(GESTURE_CLASSES):
                            vc[v] += 1
                    gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                    col   = GESTURE_COLORS.get(gname, "#ffffff")
                    vote_names = [GESTURE_CLASSES.get(int(v), "?") for v in votes if v < len(GESTURE_CLASSES)]
                    socketio.emit("log",   {"text": f"★  final: {gname}  ({len(votes)} votes)"})
                    socketio.emit("state", {
                        "label": "REST", "gesture": gname, "color": col,
                        "act": round(act, 6), "votes": vote_names,
                    })
                else:
                    socketio.emit("log",   {"text": "  (skipped — too short)"})
                    socketio.emit("state", {"label": "REST", "gesture": "REST", "color": "#444444", "act": round(act, 6)})
                state_ = 0; cnt_off = 0; votes = []

    if mode == "live":
        socketio.emit("state", {"label": "STOPPED", "gesture": "—", "color": "#888888", "act": 0.0})
        socketio.emit("log",   {"text": "— live stream ended —"})
    else:
        socketio.emit("state", {"label": "STOPPED", "gesture": "—", "color": "#888888", "act": 0.0})
        socketio.emit("log",   {"text": "— simulation stopped —"})

    _save_test_signal(app, socketio, Fs, n_ch)

    state.active_source  = None
    state.worker_running = False


def _save_test_signal(app, socketio, Fs, n_ch):
    """Save buffered raw EMG from a live testing session as .npz."""
    sid       = state.test_session_id
    uid       = state.test_session_user_id
    samples   = state.test_sample_buffer
    intervals = list(state.test_gesture_intervals)

    # Clear globals regardless
    state.test_sample_buffer     = []
    state.test_gesture_intervals = []
    state.test_session_user_id   = None
    state.test_session_id        = None

    if not sid or not samples:
        return

    confirmed = [(s, e, lbl) for s, e, lbl in intervals if isinstance(lbl, str)]
    if not confirmed:
        return

    gesture_order       = [lbl for _, _, lbl in confirmed]
    confirmed_intervals = [(s, e) for s, e, _ in confirmed]

    try:
        with app.app_context():
            folder_name = None
            if uid:
                u = db.session.get(User, uid)
                folder_name = u.username if u else None

            user_dir = os.path.join(TRAINING_DIR, folder_name) if folder_name else TRAINING_DIR
            os.makedirs(user_dir, exist_ok=True)

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"testing_{ts}.npz"
            filepath = os.path.join(user_dir, filename)

            np.savez(filepath,
                     Data=np.array(samples),
                     SamplingFrequency=np.array(Fs),
                     gesture_order=json.dumps(gesture_order),
                     gesture_intervals=json.dumps(confirmed_intervals),
                     gesture_classes=json.dumps(GESTURE_CLASSES))

            db.session.add(TrainingFile(
                user_id=uid, session_id=sid,
                file_name=filename,
                file_path=os.path.relpath(filepath, BASE_DIR),
                num_samples=len(gesture_order),
                gestures=json.dumps(gesture_order),
                created_at=datetime.now(timezone.utc),
            ))
            db.session.commit()

            skipped = len(intervals) - len(confirmed)
            skip_note = f", {skipped} skipped" if skipped else ""
            socketio.emit("log", {"text": f"\u2605 Saved testing signal \u2192 {filename} ({len(gesture_order)} gestures{skip_note}, {len(samples)} samples)"})
    except Exception as e:
        print(f"[test-save] error: {e}")
        socketio.emit("log", {"text": f"\u26a0 Failed to save testing signal: {e}"})


# ── Training collector ────────────────────────────────────────────────────────

def run_training_collector(app, socketio, mode="live", live_opts=None,
                           user_id=None, session_minutes=5, gesture_ids=None):
    state.training_running = True
    live_opts   = live_opts or {}
    started_at  = datetime.now(timezone.utc)

    with app.app_context():
        if gesture_ids:
            db_gestures = Gesture.query.filter(Gesture.id.in_(gesture_ids)).all()
        elif user_id:
            ugs = UserGesture.query.filter_by(user_id=user_id, is_unlocked=True, is_enabled=True).all()
            db_gestures = [db.session.get(Gesture, ug.gesture_id) for ug in ugs]
        else:
            db_gestures = Gesture.query.all()

    gesture_names = [g.gesture_name for g in db_gestures] or list(GESTURE_CLASSES.values())

    available_time = session_minutes * 60 - INITIAL_REST_S
    reps_per = max(1, round(available_time / (GESTURE_S + REST_S) / len(gesture_names)))
    sequence = gesture_names * reps_per
    random.shuffle(sequence)
    total = len(sequence)

    socketio.emit("train_log",      {"text": f"Collecting {total} gestures"})
    socketio.emit("train_sequence", {"gestures": sequence})

    if mode == "live":
        source = LiveSource(
            host=live_opts.get("host", "0.0.0.0"),
            port=int(live_opts.get("port", 45454)),
            fsamp=int(live_opts.get("fsamp", S64_FSAMP)),
            nch=int(live_opts.get("nch", S64_NCH)),
            emg_channels=int(live_opts.get("emg_channels", 64)),
            on_log=lambda msg: socketio.emit("train_log", {"text": msg}),
        )
    else:
        sim_user = None
        if user_id:
            with app.app_context():
                u = User.query.get(user_id)
                if u:
                    sim_user = u.username
        try:
            source = SimulatedSource(MAT_PATH, PLAYBACK_SPEED, user=sim_user)
        except Exception as e:
            socketio.emit("train_log", {"text": f"ERROR: {e}"})
            state.training_running = False
            return

    state.training_source = source
    Fs   = source.Fs

    det_win  = int(DET_WIN_MS  / 1000 * Fs)

    # ── Build phase schedule ──────────────────────────────────────────────
    phase_schedule = [(INITIAL_REST_S, "rest", None, 0)]
    for gi, gname in enumerate(sequence):
        phase_schedule.append((GESTURE_S, "gesture", gname, gi + 1))
        phase_schedule.append((REST_S, "rest", None, gi + 1))

    lock = threading.Lock()
    all_samples = []
    collected = []
    current_label = [None]
    current_samples = []
    raw_buf  = deque(maxlen=det_win)
    latest_act = [0.0]

    SIG_EMIT_INTERVAL = 0.20

    def _phase_timer():
        for pi, (dur, ptype, gname, idx) in enumerate(phase_schedule):
            if not state.training_running:
                break

            with lock:
                current_label[0] = gname if ptype == "gesture" else None

            if ptype == "gesture":
                socketio.emit("train_phase", {
                    "phase": "gesture", "gesture": gname,
                    "countdown": int(dur), "index": idx,
                    "total": total, "nextGesture": None,
                })
                socketio.emit("train_log", {"text": f"▶  [{idx}/{total}] {gname}"})
            else:
                next_g = None
                for fp in phase_schedule[pi + 1:]:
                    if fp[1] == "gesture":
                        next_g = fp[2]
                        break
                socketio.emit("train_phase", {
                    "phase": "rest", "gesture": "Relax",
                    "countdown": int(dur), "index": idx,
                    "total": total, "nextGesture": next_g,
                })

            phase_start = time.perf_counter()
            last_sig = phase_start
            while time.perf_counter() - phase_start < dur:
                if not state.training_running:
                    return
                now = time.perf_counter()
                if now - last_sig >= SIG_EMIT_INTERVAL:
                    last_sig = now
                    act = latest_act[0]
                    t_on  = state.runtime_config["t_on"]
                    t_off = state.runtime_config["t_off"]
                    socketio.emit("train_state", {
                        "label": "ACTIVE" if ptype == "gesture" else "REST",
                        "gesture": gname or "REST",
                        "color": "#ffffff",
                        "act": round(act, 6),
                    })
                    socketio.emit("train_signal", {
                        "t_on": t_on,
                        "t_off": t_off,
                    })
                time.sleep(0.05)

            if ptype == "gesture":
                with lock:
                    current_label[0] = None
                    if current_samples:
                        collected.append({"label": gname, "data": np.array(current_samples)})
                        socketio.emit("train_log", {"text": f"  ✓ Recorded {gname} ({len(current_samples)} samples)"})
                        current_samples.clear()

    timer_thread = threading.Thread(target=_phase_timer, daemon=True)
    timer_thread.start()

    # ── Sample loop (raw activation identical to prediction worker) ───────
    for raw in source.stream():
        if not state.training_running:
            break

        with lock:
            all_samples.append(raw.copy())
            raw_buf.append(raw.copy())
            if current_label[0] is not None:
                current_samples.append(raw.copy())

        # Compute raw activation (same formula as prediction worker)
        if len(raw_buf) >= det_win:
            w = np.stack(list(raw_buf), axis=1)
            latest_act[0] = float(np.median(np.sqrt(np.mean(w ** 2, axis=1))))

    timer_thread.join(timeout=2)

    ended_at = datetime.now(timezone.utc)
    n_ch = source.n_channels if hasattr(source, 'n_channels') else 64

    if collected:
        if user_id:
            with app.app_context():
                u = db.session.get(User, user_id)
                folder_name = u.username if u else None
        else:
            folder_name = None
        user_dir = os.path.join(TRAINING_DIR, folder_name) if folder_name else TRAINING_DIR
        os.makedirs(user_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"training_{ts}.npz"
        filepath = os.path.join(user_dir, filename)
        np.savez(filepath,
                 Data=np.array(all_samples),
                 SamplingFrequency=np.array(Fs),
                 gesture_order=json.dumps(sequence),
                 gesture_classes=json.dumps(GESTURE_CLASSES))
        socketio.emit("train_log", {"text": f"★  Saved {len(collected)} recordings → {filename}"})
        if user_id:
            try:
                with app.app_context():
                    actual_dur = (ended_at - started_at).total_seconds()
                    sess = Session(
                        user_id=user_id, session_type="training",
                        planned_duration=session_minutes * 60,
                        actual_duration=actual_dur,
                        status="completed" if state.training_running else "aborted",
                        started_at=started_at, ended_at=ended_at,
                        number_of_connected_channels=n_ch,
                    )
                    db.session.add(sess)
                    db.session.flush()
                    gesture_map = {g.gesture_name: g.id for g in Gesture.query.all()}
                    rep_counter = Counter()
                    for c in collected:
                        gname = c["label"]
                        gid = gesture_map.get(gname)
                        if not gid:
                            continue
                        rep_counter[gname] += 1
                        tg = TrainingGesture(
                            session_id=sess.id, gesture_id=gid,
                            display_order=rep_counter[gname], completed=True,
                        )
                        db.session.add(tg)
                        ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gid).first()
                        if ug:
                            ug.total_times_trained += 1
                            ug.times_trained = max(ug.times_trained, 1)
                    db.session.add(TrainingFile(
                        user_id=user_id, session_id=sess.id, file_name=filename,
                        file_path=os.path.relpath(filepath, BASE_DIR),
                        num_samples=len(collected), gestures=json.dumps(sequence),
                        created_at=ended_at,
                    ))
                    db.session.commit()
                    socketio.emit("train_log", {"text": f"✓ Session saved (id={sess.id})"})
            except Exception as e:
                socketio.emit("train_log", {"text": f"⚠ DB error: {e}"})
        socketio.emit("train_done", {"filename": filename, "count": len(collected)})
    else:
        socketio.emit("train_log", {"text": "No data collected."})
        socketio.emit("train_done", {"filename": None, "count": 0})

    state.training_source = None
    state.training_running = False
