"""
Flask + Flask-SocketIO backend for the EMG Gesture Classifier.
Streams real-time classification results to a React frontend via WebSocket.
Supports two modes:
  • simulated  – replays a .mat file in real time (default)
  • live       – streams from OT BioLab TCP (Quattrocento 64-ch HD-EMG)
"""

import os, sys, threading, time, random, json
import numpy as np
from scipy.signal import butter, lfilter, lfilter_zi, iirnotch
from scipy.io import loadmat
from collections import deque
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

from emg_sources import SimulatedSource, LiveSource
from models import db, User, Gesture, UserGesture, Session, SessionGesture, GestureTrial, ModelVersion

# ── paths (relative to workspace root) ──────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAT_PATH   = os.path.join(BASE_DIR, "KateGesturesRound2Jan20.mat")
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kate_model_1.pkl")

PLAYBACK_SPEED = 1.0

GESTURE_CLASSES = {
    0: "Open", 1: "Close", 2: "Thumbs Up", 3: "Peace",
    4: "Index Point", 5: "Four", 6: "Okay", 7: "Spiderman",
}
GESTURE_COLORS = {
    "Open": "#00e5ff", "Close": "#ff4081", "Thumbs Up": "#69ff47",
    "Peace": "#ffd740", "Index Point": "#e040fb", "Four": "#ff6d00",
    "Okay": "#00e676", "Spiderman": "#ff1744",
}

F_LOWER = 20; F_UPPER = 450; F_NOTCH = 60; BW_NOTCH = 2
T_ON = 1.0; T_OFF = 0.6
DET_WIN_MS = 200; DET_STEP_MS = 100
WIN_MS = 200; STEP_MS = 100
N_ON = 1; N_OFF = 1
MAX_GESTURE_S = 3.5
MIN_VOTES = 8

# ── Flask app ───────────────────────────────────────────────────────────────
app = Flask(__name__) 
CORS(app, origins="*")

# ── Database ────────────────────────────────────────────────────────────────
DB_PATH = os.path.join(BASE_DIR, "emg.db")
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", os.urandom(32).hex())

db.init_app(app)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

TRAINING_DIR = os.path.join(BASE_DIR, "training_data")

worker_thread = None
worker_running = False
active_source = None          # current EMG source (so we can stop it)

training_thread = None
training_running = False
training_source = None


def feats(w, thr=0.01):
    ch, _ = w.shape
    MAV = np.mean(np.abs(w), axis=1)
    WL  = np.sum(np.abs(np.diff(w, axis=1)), axis=1)
    ZC  = np.zeros(ch)
    SSC = np.zeros(ch)
    for i in range(ch):
        x = w[i]; s = np.diff(x)
        ZC[i]  = np.sum(((x[:-1]*x[1:]) < 0) & (np.abs(x[:-1]-x[1:]) >= thr))
        SSC[i] = np.sum(((s[:-1]*s[1:]) < 0) & (np.abs(s[:-1]) >= thr) & (np.abs(s[1:]) >= thr))
    return np.concatenate([MAV, WL, ZC, SSC])


def run_worker(mode="simulated", live_opts=None):
    """
    Process EMG data and emit updates via SocketIO.

    mode: "simulated" or "live"
    live_opts: dict with optional keys host, port, n_channels, Fs,
               calibration_s  (only used when mode == "live")
    """
    global worker_running, active_source
    worker_running = True
    live_opts = live_opts or {}

    try:
        import joblib
    except ImportError:
        socketio.emit("log", {"text": "ERROR: joblib not installed"})
        worker_running = False
        return

    socketio.emit("log", {"text": f"Mode: {mode.upper()}"})
    socketio.emit("state", {"label": "LOADING...", "gesture": "—", "color": "#ffffff", "act": 0.0})

    # ── Load model ──────────────────────────────────────────────────────────
    try:
        scaler, model = joblib.load(MODEL_PATH)
    except Exception as e:
        socketio.emit("log", {"text": f"ERROR loading model: {e}"})
        worker_running = False
        return

    # ── Create data source ──────────────────────────────────────────────────
    if mode == "live":
        source = LiveSource(
            host=live_opts.get("host", "0.0.0.0"),
            port=int(live_opts.get("port", 45454)),
            fsamp=int(live_opts.get("fsamp", 2)),            # 2 = 2000 Hz
            nch=int(live_opts.get("nch", 3)),                # 3 = 72 total (64 EMG + 8 aux)
            emg_channels=int(live_opts.get("emg_channels", 64)),
            calibration_s=float(live_opts.get("calibration_s", 2.0)),
            on_log=lambda msg: socketio.emit("log", {"text": msg}),
        )
        Fs = source.Fs
        socketio.emit("log", {"text": f"Live mode — {source.n_channels}ch @ {Fs} Hz"})
    else:
        try:
            source = SimulatedSource(MAT_PATH, PLAYBACK_SPEED)
        except Exception as e:
            socketio.emit("log", {"text": f"ERROR loading .mat: {e}"})
            worker_running = False
            return
        Fs = source.Fs
        socketio.emit("log", {"text": f"Loaded {source.sig.shape[0]} samples @ {Fs} Hz"})

    active_source = source

    # ── Filters ──────────────────────────────────────────────────────────────
    b_bp, a_bp = butter(2, [F_LOWER/(Fs/2), F_UPPER/(Fs/2)], btype="band")
    b_n, a_n   = iirnotch(F_NOTCH/(Fs/2), F_NOTCH/BW_NOTCH)
    n_ch = source.n_channels if hasattr(source, 'n_channels') else 64
    zi_bp = np.tile(lfilter_zi(b_bp, a_bp), (n_ch, 1))
    zi_n  = np.tile(lfilter_zi(b_n,  a_n),  (n_ch, 1))

    def filt(x):
        nonlocal zi_bp, zi_n
        y, zi_bp[:] = lfilter(b_bp, a_bp, x[:, None], zi=zi_bp)
        y, zi_n[:]  = lfilter(b_n,  a_n,  y,          zi=zi_n)
        return y.squeeze()

    det_win  = int(DET_WIN_MS / 1000 * Fs)
    det_step = int(DET_STEP_MS / 1000 * Fs)
    win_s    = int(WIN_MS / 1000 * Fs)
    max_g    = int(MAX_GESTURE_S * Fs)

    # ── Rest calibration (raw, no filtering — matches Read_sessantaquattroplus.py) ──
    if mode == "live":
        socketio.emit("log", {"text": "Calibrating rest baseline… keep hand relaxed"})
        rest_mean = None
        _cal_raw = []  # collect raw samples for rest baseline
    else:
        rest_raw = source.rest_data
        rest_mean = np.sqrt(np.mean(rest_raw**2, axis=0))
        rest_mean[rest_mean < 1e-6] = 1e-6
        socketio.emit("log", {"text": f"Rest baseline RMS: {np.median(rest_mean):.6f}"})
        _cal_raw = None

    det_buf   = deque(maxlen=det_win)
    gest_buf  = []
    det_ctr   = 0; state_ = 0; cnt_on = 0; cnt_off = 0
    log_ctr = 0
    votes = []
    last_printed = ""
    sig_buf_list = []
    sig_buf_flex = []
    sig_buf_ext  = []
    cal_n = int(float(live_opts.get("calibration_s", 2.0)) * Fs) if mode == "live" else 0

    socketio.emit("state", {"label": "REST", "gesture": "REST", "color": "#444444", "act": 0.0})

    for i, raw in enumerate(source.stream()):
        if not worker_running:
            break

        # Collect raw samples during calibration (live mode)
        if _cal_raw is not None and i < cal_n:
            _cal_raw.append(raw.copy())

        # For live mode, compute rest_mean from raw data
        if mode == "live" and rest_mean is None and i == cal_n:
            if _cal_raw and len(_cal_raw) > 0:
                cal_arr = np.array(_cal_raw)
                rest_mean = np.sqrt(np.mean(cal_arr**2, axis=0))
                rest_mean[rest_mean < 1e-6] = 1e-6
                socketio.emit("log", {"text": f"Calibration done (RMS baseline: {np.median(rest_mean):.6f})"})
            else:
                rest_mean = np.ones(n_ch) * 1e-3
                socketio.emit("log", {"text": "WARNING: no rest data, using defaults"})
            _cal_raw = None  # free memory

        # Skip classification until rest calibration is ready (live mode)
        if rest_mean is None:
            continue

        # Filtered signal — only used for gesture classification features
        filtered = filt(raw - np.mean(raw))
        if state_ == 1:
            gest_buf.append(filtered)

        # Detection buffer uses raw data (no filtering, matching reference)
        det_buf.append(raw)

        if len(det_buf) < det_win:
            continue

        det_ctr += 1
        if det_ctr < det_step:
            continue
        det_ctr = 0

        w   = np.stack(det_buf, axis=1)
        rms_per_ch = np.sqrt(np.mean(w**2, axis=1)) / (rest_mean + 1e-8)
        act = float(np.median(rms_per_ch))

        # Split into flexors (ch 1-32) and extensors (ch 33-64)
        act_flex = float(np.median(rms_per_ch[:32]))
        act_ext  = float(np.median(rms_per_ch[32:64]))

        log_ctr += 1
        sig_buf_list.append(act)
        sig_buf_flex.append(act_flex)
        sig_buf_ext.append(act_ext)
        # Send 10-second window (100 points at 100ms per step)
        win_f = sig_buf_flex[-100:]
        win_e = sig_buf_ext[-100:]
        s_f = len(sig_buf_flex) - len(win_f)
        s_e = len(sig_buf_ext)  - len(win_e)
        socketio.emit("signal", {
            "flexors":   [{"x": s_f + j, "y": round(v, 4)} for j, v in enumerate(win_f)],
            "extensors": [{"x": s_e + j, "y": round(v, 4)} for j, v in enumerate(win_e)],
        })

        if log_ctr % 5 == 0:
            gesture_val = "" if state_ else "REST"
            color_val   = "#ffffff" if state_ else "#444444"
            socketio.emit("state", {
                "label":   "ACTIVE" if state_ else "REST",
                "gesture": gesture_val,
                "color":   color_val,
                "act":     round(act, 4),
            })

        if state_ == 0:
            if act > T_ON:
                cnt_on += 1
                if cnt_on >= N_ON:
                    socketio.emit("state", {"label": "ACTIVE", "gesture": "", "color": "#ffffff", "act": round(act, 4)})
                    socketio.emit("log", {"text": "▶  gesture start"})
                    state_ = 1; gest_buf = []; votes = []; last_printed = ""; cnt_on = 0
            else:
                cnt_on = 0
        else:
            gest_buf.append(filtered)
            cnt_off = cnt_off + 1 if act < T_OFF else 0
            gesture_end = (cnt_off >= N_OFF) or (len(gest_buf) >= max_g)

            if len(gest_buf) >= win_s:
                window = np.stack(gest_buf[-win_s:], axis=1)
                f = feats(window)
                v = model.predict(scaler.transform(f.reshape(1, -1)))[0]
                votes.append(v)

            if len(votes) >= MIN_VOTES:
                vc = np.zeros(len(GESTURE_CLASSES))
                for v in votes:
                    if v < len(GESTURE_CLASSES):
                        vc[v] += 1
                gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                col   = GESTURE_COLORS.get(gname, "#ffffff")
                socketio.emit("state", {"label": "ACTIVE", "gesture": gname, "color": col, "act": round(act, 4)})
                if gname != last_printed:
                    socketio.emit("log", {"text": f"  → {gname}"})
                    last_printed = gname

            if gesture_end:
                socketio.emit("log", {"text": "■  gesture end"})
                if len(votes) >= MIN_VOTES:
                    vc = np.zeros(len(GESTURE_CLASSES))
                    for v in votes:
                        if v < len(GESTURE_CLASSES):
                            vc[v] += 1
                    gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                    col   = GESTURE_COLORS.get(gname, "#ffffff")
                    socketio.emit("log", {"text": f"★  final: {gname}  ({len(votes)} votes)"})
                    socketio.emit("state", {"label": "REST", "gesture": gname, "color": col, "act": round(act, 4)})
                else:
                    socketio.emit("log", {"text": "  (skipped — too short, not a gesture)"})
                    socketio.emit("state", {"label": "REST", "gesture": "REST", "color": "#444444", "act": round(act, 4)})
                state_ = 0; cnt_off = 0; votes = []

    # Stream ended (mat file finished, or live connection closed)
    if mode == "live":
        socketio.emit("state", {"label": "STOPPED", "gesture": "—", "color": "#888888", "act": 0.0})
        socketio.emit("log", {"text": "— live stream ended —"})
    else:
        socketio.emit("state", {"label": "DONE ✓", "gesture": "DONE", "color": "#69ff47", "act": 0.0})
        socketio.emit("log", {"text": "— finished —"})
    active_source = None
    worker_running = False


# ── SocketIO event handlers ─────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    print("[server] client connected")


@socketio.on("disconnect")
def on_disconnect():
    print("[server] client disconnected")


@socketio.on("start")
def on_start(data=None):
    global worker_thread, worker_running
    if worker_running:
        socketio.emit("log", {"text": "Already running!"})
        return
    data = data or {}
    mode = data.get("mode", "simulated")
    live_opts = data.get("liveOpts", {})
    worker_thread = threading.Thread(target=run_worker, args=(mode, live_opts), daemon=True)
    worker_thread.start()


@socketio.on("stop")
def on_stop(_=None):
    global worker_running, active_source
    worker_running = False
    if active_source:
        active_source.stop()
        active_source = None
    socketio.emit("log", {"text": "Stopped by user."})
    socketio.emit("state", {"label": "STOPPED", "gesture": "—", "color": "#888888", "act": 0.0})


@app.route("/")
def index():
    return {"status": "EMG Gesture Classifier backend running"}


# ── Testing API ─────────────────────────────────────────────────────────────

@app.route("/api/testing/gestures/<int:user_id>")
def testing_gestures(user_id):
    """
    Return gestures available for testing, weighted so weak gestures
    appear more often. Enforces 15-rep training minimum.
    """
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    result = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled:
            continue
        g = db.session.get(Gesture, ug.gesture_id)
        eligible = ug.total_times_trained >= 15
        result.append({
            "gestureId": g.id,
            "name": g.gesture_name,
            "image": g.gesture_image,
            "accuracy": round(ug.accuracy, 1),
            "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested,
            "eligible": eligible,
            "weight": max(1, 100 - int(ug.accuracy)) if eligible else 0,
        })
    return jsonify({"gestures": result})


@app.route("/api/testing/sequence/<int:user_id>", methods=["POST"])
def testing_sequence(user_id):
    """
    Build a weighted-random gesture sequence for a test session.
    Weak gestures appear more frequently.
    """
    data = request.get_json(silent=True) or {}
    count = int(data.get("count", 15))

    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    eligible = []
    weights = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled or ug.total_times_trained < 15:
            continue
        g = db.session.get(Gesture, ug.gesture_id)
        eligible.append({"gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image})
        weights.append(max(1, 100 - int(ug.accuracy)))

    if not eligible:
        return jsonify({"error": "No eligible gestures (need ≥15 training reps each)"}), 400

    # Weighted random selection
    sequence = random.choices(eligible, weights=weights, k=count)
    return jsonify({"sequence": sequence})


@app.route("/api/testing/session", methods=["POST"])
def create_test_session():
    """Create a new test session in the DB."""
    data = request.get_json(silent=True) or {}
    user_id = data.get("userId")
    if not user_id:
        return jsonify({"error": "userId required"}), 400

    sess = Session(
        user_id=user_id,
        session_type="testing",
        planned_duration=data.get("plannedDuration"),
        status="in_progress",
        started_at=datetime.now(timezone.utc),
        number_of_connected_channels=data.get("channels", 64),
    )
    db.session.add(sess)
    db.session.commit()
    return jsonify({"sessionId": sess.id})


@app.route("/api/testing/trial", methods=["POST"])
def record_test_trial():
    """Record a single gesture trial result."""
    data = request.get_json(silent=True) or {}
    user_id = data.get("userId")
    session_id = data.get("sessionId")
    gesture_id = data.get("gestureId")
    prediction = data.get("prediction")
    confidence = data.get("confidence")
    ground_truth = data.get("groundTruth")
    was_correct = data.get("wasCorrect")
    was_skipped = data.get("wasSkipped", False)
    retry_count = data.get("retryCount", 0)
    trial_number = data.get("trialNumber", 1)

    # Create or find session_gesture
    sg = SessionGesture.query.filter_by(session_id=session_id, gesture_id=gesture_id).first()
    if not sg:
        order = SessionGesture.query.filter_by(session_id=session_id).count() + 1
        sg = SessionGesture(
            session_id=session_id,
            gesture_id=gesture_id,
            display_order=order,
            target_repetitions=1,
            completed_repetitions=0,
            was_skipped=False,
        )
        db.session.add(sg)
        db.session.flush()

    sg.completed_repetitions += 1

    trial = GestureTrial(
        user_id=user_id,
        session_id=session_id,
        session_gesture_id=sg.id,
        gesture_id=gesture_id,
        trial_number=trial_number,
        attempt_type="testing",
        ground_truth=ground_truth,
        prediction=prediction,
        confidence=confidence,
        retry_count=retry_count,
        was_correct=was_correct,
        was_skipped=was_skipped,
    )
    db.session.add(trial)

    # Update user_gesture stats
    ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gesture_id).first()
    if ug:
        ug.total_times_tested += 1
        if was_correct:
            ug.correct_predictions += 1
        elif not was_skipped:
            ug.incorrect_predictions += 1
        total = ug.correct_predictions + ug.incorrect_predictions
        ug.accuracy = round(ug.correct_predictions / total * 100, 1) if total > 0 else 0.0
        if confidence is not None:
            # Rolling average of confidence
            n = ug.total_times_tested
            ug.average_confidence = round(((ug.average_confidence * (n - 1)) + confidence) / n, 3)
        if ug.accuracy < 50 and total >= 5:
            ug.needs_retraining = True

    db.session.commit()
    return jsonify({"trialId": trial.id, "accuracy": ug.accuracy if ug else None})


@app.route("/api/testing/session/<int:session_id>/end", methods=["POST"])
def end_test_session(session_id):
    """Mark a test session as completed or aborted."""
    data = request.get_json(silent=True) or {}
    sess = db.session.get(Session, session_id)
    if not sess:
        return jsonify({"error": "Session not found"}), 404

    sess.status = data.get("status", "completed")
    sess.ended_at = datetime.now(timezone.utc)
    if sess.started_at:
        sess.actual_duration = (sess.ended_at - sess.started_at).total_seconds()
    db.session.commit()
    return jsonify({"ok": True})


# ── Auth routes ─────────────────────────────────────────────────────────────

@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    first_name = (data.get("firstName") or "").strip()
    last_name = (data.get("lastName") or "").strip()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not all([first_name, last_name, username, password]):
        return jsonify({"error": "All fields are required"}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Username already taken"}), 409

    user = User(
        first_name=first_name,
        last_name=last_name,
        username=username,
        password_hash=generate_password_hash(password),
        last_login=datetime.now(timezone.utc),
    )
    db.session.add(user)
    db.session.commit()

    # create user_gesture rows for every gesture
    for g in Gesture.query.all():
        db.session.add(UserGesture(user_id=user.id, gesture_id=g.id))
    db.session.commit()

    return jsonify({"id": user.id, "username": user.username, "firstName": user.first_name, "lastName": user.last_name}), 201


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    user = User.query.filter_by(username=username).first()
    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid username or password"}), 401

    user.last_login = datetime.now(timezone.utc)
    db.session.commit()

    return jsonify({"id": user.id, "username": user.username, "firstName": user.first_name, "lastName": user.last_name})


# ── Dashboard API ───────────────────────────────────────────────────────────

@app.route("/api/dashboard/<int:user_id>")
def dashboard(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    # per-gesture stats
    gesture_stats = []
    for ug in user.user_gestures:
        g = db.session.get(Gesture, ug.gesture_id)
        gesture_stats.append({
            "gestureId": g.id,
            "name": g.gesture_name,
            "image": g.gesture_image,
            "accuracy": round(ug.accuracy, 1),
            "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested,
            "correct": ug.correct_predictions,
            "incorrect": ug.incorrect_predictions,
            "avgConfidence": round(ug.average_confidence, 1),
            "needsRetraining": ug.needs_retraining,
            "isUnlocked": ug.is_unlocked,
            "isEnabled": ug.is_enabled,
        })

    unlocked = [g for g in gesture_stats if g["isUnlocked"]]
    total_correct = sum(g["correct"] for g in unlocked)
    total_incorrect = sum(g["incorrect"] for g in unlocked)
    total_preds = total_correct + total_incorrect
    overall_accuracy = round(total_correct / total_preds * 100, 1) if total_preds > 0 else 0.0
    gestures_trained = sum(1 for g in unlocked if g["totalTrained"] > 0)

    # recent sessions
    recent = Session.query.filter_by(user_id=user_id).order_by(Session.started_at.desc()).limit(5).all()
    recent_sessions = []
    for s in recent:
        recent_sessions.append({
            "id": s.id,
            "type": s.session_type,
            "status": s.status,
            "startedAt": s.started_at.isoformat() if s.started_at else None,
            "duration": s.actual_duration,
        })

    # suggestions
    suggestions = []
    weak = [g for g in unlocked if g["totalTested"] >= 5 and g["accuracy"] < 60]
    if weak:
        worst = min(weak, key=lambda g: g["accuracy"])
        suggestions.append(f"{worst['name']} has {worst['accuracy']}% accuracy — consider retraining it.")
    untrained = [g for g in unlocked if g["totalTrained"] == 0]
    if untrained:
        suggestions.append(f"You have {len(untrained)} unlocked gesture(s) that haven't been trained yet.")
    if user.training_streak == 0:
        suggestions.append("Start a training session to begin your streak!")
    elif user.training_streak >= 3:
        suggestions.append(f"Nice {user.training_streak}-day streak! Keep it up.")

    return jsonify({
        "streak": user.training_streak,
        "overallAccuracy": overall_accuracy,
        "gesturesTrained": gestures_trained,
        "totalGestures": len(gesture_stats),
        "gestures": gesture_stats,
        "recentSessions": recent_sessions,
        "suggestions": suggestions,
    })


# ── Training API ─────────────────────────────────────────────────────────────

@app.route("/api/training/gestures/<int:user_id>")
def training_gestures(user_id):
    """Return the list of unlocked+enabled gestures for this user's training."""
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    result = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled:
            continue
        g = db.session.get(Gesture, ug.gesture_id)
        result.append({
            "gestureId": g.id,
            "name": g.gesture_name,
            "image": g.gesture_image,
            "totalTrained": ug.total_times_trained,
            "needsRetraining": ug.needs_retraining,
        })
    return jsonify({"gestures": result})


# ── Training data collection ────────────────────────────────────────────────

GESTURE_S = 3.0          # seconds to hold each gesture
REST_S    = 3.0          # seconds of rest between gestures
INITIAL_REST_S = 6.0     # initial rest / calibration period
REPS_PER_GESTURE = 5     # repetitions of each gesture


def run_training_collector(mode="live", live_opts=None, user_id=None, session_minutes=5, gesture_ids=None):
    """
    Guide the user through a randomised gesture sequence and record
    the raw EMG samples for each gesture.  Saves a .npz file and
    logs everything to the database.
    """
    global training_running, training_source
    training_running = True
    live_opts = live_opts or {}
    started_at = datetime.now(timezone.utc)

    # ── Resolve gestures from DB ─────────────────────────────────────────
    with app.app_context():
        if gesture_ids:
            db_gestures = Gesture.query.filter(Gesture.id.in_(gesture_ids)).all()
        elif user_id:
            ugs = UserGesture.query.filter_by(user_id=user_id, is_unlocked=True, is_enabled=True).all()
            db_gestures = [db.session.get(Gesture, ug.gesture_id) for ug in ugs]
        else:
            db_gestures = Gesture.query.all()

    gesture_names = [g.gesture_name for g in db_gestures]
    if not gesture_names:
        gesture_names = list(GESTURE_CLASSES.values())

    # ── Compute reps from session length ─────────────────────────────────
    time_per_gesture = GESTURE_S + REST_S  # 6s per gesture cycle
    available_time = session_minutes * 60 - INITIAL_REST_S
    total_reps = max(int(available_time / time_per_gesture), len(gesture_names))
    reps_per = max(1, total_reps // len(gesture_names))

    sequence = gesture_names * reps_per
    random.shuffle(sequence)
    total = len(sequence)

    socketio.emit("train_log", {"text": f"Collecting {total} gestures ({REPS_PER_GESTURE} reps × {len(gesture_names)} classes)"})
    socketio.emit("train_sequence", {"gestures": sequence})

    # ── Create EMG data source ───────────────────────────────────────────
    if mode == "live":
        source = LiveSource(
            host=live_opts.get("host", "0.0.0.0"),
            port=int(live_opts.get("port", 45454)),
            fsamp=int(live_opts.get("fsamp", 2)),
            nch=int(live_opts.get("nch", 3)),
            emg_channels=int(live_opts.get("emg_channels", 64)),
            calibration_s=float(live_opts.get("calibration_s", 2.0)),
            on_log=lambda msg: socketio.emit("train_log", {"text": msg}),
        )
        Fs = source.Fs
        socketio.emit("train_log", {"text": f"Live mode — {source.n_channels}ch @ {Fs} Hz"})
    else:
        try:
            source = SimulatedSource(MAT_PATH, PLAYBACK_SPEED)
        except Exception as e:
            socketio.emit("train_log", {"text": f"ERROR loading .mat: {e}"})
            training_running = False
            return
        Fs = source.Fs
        socketio.emit("train_log", {"text": f"Simulated — {source.sig.shape[0]} samples @ {Fs} Hz"})

    training_source = source

    # ── Build phase timeline (sample-based) ──────────────────────────────
    # Each phase: (start_sample, end_sample, type, gesture_name, index)
    phases = []
    s = 0
    # Initial rest
    n_init = int(INITIAL_REST_S * Fs)
    phases.append((s, s + n_init, "rest", None, 0))
    s += n_init

    for gi, gname in enumerate(sequence):
        # Gesture phase
        n_gest = int(GESTURE_S * Fs)
        phases.append((s, s + n_gest, "gesture", gname, gi + 1))
        s += n_gest
        # Rest phase (after every gesture, including the last)
        n_rest = int(REST_S * Fs)
        phases.append((s, s + n_rest, "rest", None, gi + 1))
        s += n_rest

    # ── Collect data ─────────────────────────────────────────────────────
    collected = []          # list of dicts: {label, data (n_samples × n_ch)}
    current_samples = []
    phase_idx = 0
    last_countdown = -1

    # Emit the first phase
    p = phases[0]
    next_gesture = sequence[0] if sequence else None
    socketio.emit("train_phase", {
        "phase": "rest", "gesture": "Relax",
        "countdown": int(INITIAL_REST_S),
        "index": 0, "total": total,
        "nextGesture": next_gesture,
    })

    for sample_i, raw in enumerate(source.stream()):
        if not training_running:
            break

        # ── Check for phase transition ───────────────────────────────────
        while phase_idx < len(phases) and sample_i >= phases[phase_idx][1]:
            # Finish outgoing phase
            old = phases[phase_idx]
            if old[2] == "gesture" and current_samples:
                collected.append({
                    "label": old[3],
                    "data": np.array(current_samples),
                })
                socketio.emit("train_log", {
                    "text": f"  ✓ Recorded {old[3]} ({len(current_samples)} samples)"
                })
                current_samples = []

            phase_idx += 1
            last_countdown = -1

            if phase_idx >= len(phases):
                break

            # Emit new phase info
            new = phases[phase_idx]
            if new[2] == "gesture":
                socketio.emit("train_phase", {
                    "phase": "gesture",
                    "gesture": new[3],
                    "countdown": int(GESTURE_S),
                    "index": new[4], "total": total,
                    "nextGesture": None,
                })
                socketio.emit("train_log", {
                    "text": f"▶  [{new[4]}/{total}] {new[3]}"
                })
            else:
                # Rest phase — figure out next gesture
                next_g = None
                for fp in phases[phase_idx + 1:]:
                    if fp[2] == "gesture":
                        next_g = fp[3]
                        break
                socketio.emit("train_phase", {
                    "phase": "rest",
                    "gesture": "Relax",
                    "countdown": int(REST_S),
                    "index": new[4], "total": total,
                    "nextGesture": next_g,
                })

        if phase_idx >= len(phases):
            break

        # ── Collect samples during gesture phases ────────────────────────
        p = phases[phase_idx]
        if p[2] == "gesture":
            current_samples.append(raw.copy())

        # ── Emit countdown once per second ───────────────────────────────
        elapsed_in_phase = (sample_i - p[0]) / Fs
        phase_duration = (p[1] - p[0]) / Fs
        remaining = phase_duration - elapsed_in_phase
        countdown_int = max(int(remaining) + 1, 0)
        if countdown_int != last_countdown:
            last_countdown = countdown_int
            socketio.emit("train_countdown", {"countdown": countdown_int})

    # ── Save collected data ──────────────────────────────────────────────
    ended_at = datetime.now(timezone.utc)
    n_ch = source.n_channels if hasattr(source, 'n_channels') else 64

    if collected:
        os.makedirs(TRAINING_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"training_{ts}.npz"
        filepath = os.path.join(TRAINING_DIR, filename)

        labels = [c["label"] for c in collected]
        data_arrays = [c["data"] for c in collected]

        np.savez(
            filepath,
            labels=np.array(labels),
            Fs=np.array(Fs),
            gesture_classes=json.dumps(GESTURE_CLASSES),
            **{f"gesture_{i}": d for i, d in enumerate(data_arrays)},
        )

        socketio.emit("train_log", {
            "text": f"★  Saved {len(collected)} recordings → {filename}"
        })

        # ── Write to database ────────────────────────────────────────────
        if user_id:
            try:
                with app.app_context():
                    actual_dur = (ended_at - started_at).total_seconds()
                    sess = Session(
                        user_id=user_id,
                        session_type="training",
                        planned_duration=session_minutes * 60,
                        actual_duration=actual_dur,
                        status="completed" if training_running else "aborted",
                        started_at=started_at,
                        ended_at=ended_at,
                        number_of_connected_channels=n_ch,
                    )
                    db.session.add(sess)
                    db.session.flush()

                    # Build gesture name → Gesture.id map
                    gesture_map = {g.gesture_name: g.id for g in Gesture.query.all()}

                    # Group collected by gesture name
                    from collections import Counter
                    rep_counter = Counter()
                    for c in collected:
                        gname = c["label"]
                        gid = gesture_map.get(gname)
                        if not gid:
                            continue
                        rep_counter[gname] += 1
                        order = rep_counter[gname]

                        sg = SessionGesture(
                            session_id=sess.id,
                            gesture_id=gid,
                            display_order=order,
                            target_repetitions=1,
                            completed_repetitions=1,
                            was_skipped=False,
                        )
                        db.session.add(sg)
                        db.session.flush()

                        trial = GestureTrial(
                            user_id=user_id,
                            session_id=sess.id,
                            session_gesture_id=sg.id,
                            gesture_id=gid,
                            trial_number=order,
                            attempt_type="training",
                            ground_truth=gname,
                            prediction=None,
                            confidence=None,
                            retry_count=0,
                            was_correct=None,
                            was_skipped=False,
                        )
                        db.session.add(trial)

                        # Update user_gesture stats
                        ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gid).first()
                        if ug:
                            ug.total_times_trained += 1
                            ug.times_trained = max(ug.times_trained, 1)

                    db.session.commit()
                    socketio.emit("train_log", {"text": f"✓ Session saved to database (id={sess.id})"})
            except Exception as e:
                socketio.emit("train_log", {"text": f"⚠ DB save error: {e}"})

        socketio.emit("train_done", {"filename": filename, "count": len(collected)})
    else:
        socketio.emit("train_log", {"text": "No data collected."})
        socketio.emit("train_done", {"filename": None, "count": 0})

    training_source = None
    training_running = False


@socketio.on("train_start")
def on_train_start(data=None):
    global training_thread, training_running
    if training_running or worker_running:
        socketio.emit("train_log", {"text": "Already running!"})
        return
    data = data or {}
    mode = data.get("mode", "simulated")
    live_opts = data.get("liveOpts", {})
    user_id = data.get("userId")
    session_minutes = int(data.get("sessionMinutes", 5))
    gesture_ids = data.get("gestureIds")  # optional list of specific gesture IDs
    training_thread = threading.Thread(
        target=run_training_collector,
        args=(mode, live_opts),
        kwargs={"user_id": user_id, "session_minutes": session_minutes, "gesture_ids": gesture_ids},
        daemon=True,
    )
    training_thread.start()


@socketio.on("train_stop")
def on_train_stop(_=None):
    global training_running, training_source
    training_running = False
    if training_source:
        training_source.stop()
        training_source = None
    socketio.emit("train_log", {"text": "Training collection stopped."})
    socketio.emit("train_done", {"filename": None, "count": 0})


if __name__ == "__main__":
    with app.app_context():
        db.create_all()

        # Seed gesture table if empty
        if Gesture.query.count() == 0:
            for name, img in [
                ("Open", "/gestures/open.jpg"),
                ("Close", "/gestures/close.jpg"),
                ("Thumbs Up", "/gestures/thumbs_up.jpg"),
                ("Peace", "/gestures/peace.jpg"),
                ("Index Point", "/gestures/index_point.jpg"),
                ("Four", "/gestures/four.jpg"),
                ("Okay", "/gestures/okay.jpg"),
                ("Spiderman", "/gestures/spiderman.jpg"),
            ]:
                db.session.add(Gesture(gesture_name=name, gesture_image=img))
            db.session.commit()
            print("[db] seeded 8 gestures")

    print("[server] starting on http://localhost:5050")
    socketio.run(app, host="0.0.0.0", port=5050, debug=False)
