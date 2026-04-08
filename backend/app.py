"""
Flask + Flask-SocketIO backend for the EMG Gesture Classifier.
Streams real-time classification results to a React frontend via WebSocket.

THRESHOLD SYSTEM (matches RealTimeGestureClassifierUSETHIS.py)
──────────────────────────────────────────────────────────────
act = median(RMS_per_channel / rest_mean_per_channel)  ← ratio
REST calibration: first REST_CALIB_S seconds compute rest_mean.
T_ON / T_OFF are relative thresholds (2.4 / 1.8).
"""

import os, sys, threading, time, random, json, sqlite3, socket, struct
import numpy as np
from scipy.signal import butter, lfilter, lfilter_zi, iirnotch
from scipy.io import loadmat
from collections import deque
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

from models import db, User, Gesture, UserGesture, Session, TrainingGesture, TestingTrial, ModelVersion, TrainingFile

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAT_PATH   = os.path.join(BASE_DIR, "KateGesturesRound2Jan20.mat")
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kate_model_jan20_1.pkl")
PLAYBACK_SPEED = 1.0

# ── Gesture catalogue ────────────────────────────────────────────────────────
GESTURE_CLASSES = {
    0: "Open", 1: "Close", 2: "Thumbs Up", 3: "Peace",
    4: "Index Point", 5: "Four", 6: "Okay", 7: "Spiderman",
}

# Progression order for unlocking gestures (first two start unlocked)
UNLOCK_ORDER = ["Open", "Close", "Thumbs Up", "Peace",
                "Index Point", "Four", "Okay", "Spiderman"]
AUTO_UNLOCK_ACCURACY = 70   # avg accuracy on unlocked gestures to unlock next
AUTO_UNLOCK_MIN_TESTS = 5   # minimum test trials per unlocked gesture
GESTURE_COLORS = {
    "Open": "#00e5ff", "Close": "#ff4081", "Thumbs Up": "#69ff47",
    "Peace": "#ffd740", "Index Point": "#e040fb", "Four": "#ff6d00",
    "Okay": "#00e676", "Spiderman": "#ff1744",
}

# ── Signal processing parameters (matches RealTimeGestureClassifierUSETHIS.py) ─
F_LOWER, F_UPPER = 20, 450
F_NOTCH, BW_NOTCH = 60, 2

# ── Detection thresholds (relative to rest baseline) ───────────────────
T_ON   = 2.0    # activation ratio to start gesture
T_OFF  = 1.3    # activation ratio to end gesture
REST_CALIB_S = 2.0   # seconds of rest for baseline calibration

N_ON            = 1
N_OFF           = 1
DET_WIN_MS      = 200
DET_STEP_MS     = 100
WIN_MS          = 200
MAX_GESTURE_S   = 3.5
MIN_VOTES       = 3

# Sessantaquattro+ command parameters
S64_FSAMP = 2   # → 2000 Hz
S64_NCH   = 3   # → 72 total channels
S64_MODE  = 0
S64_HRES  = 0
S64_HPF   = 1
S64_EXTEN = 0
S64_TRIG  = 0
S64_REC   = 0
S64_GO    = 1

# ── Flask / SocketIO ─────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins="*")

DB_PATH = os.path.join(BASE_DIR, "emg.db")
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", os.urandom(32).hex())

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

TRAINING_DIR = os.path.join(BASE_DIR, "training_data")

worker_thread   = None
worker_running  = False
active_source   = None

training_thread  = None
training_running = False
training_paused  = False
training_source  = None

# ── Testing signal buffer (saves raw EMG during live test sessions) ───────────
test_sample_buffer     = []     # raw samples appended by run_worker
test_gesture_intervals = []     # [(start_sample, end_sample, label|None), ...]
test_session_user_id   = None
test_session_id        = None
test_sample_counter    = 0      # current sample index in the worker loop

# ── Runtime-tunable config (updated via socket from Predict page) ─────────────
runtime_config = {
    "t_on":       T_ON,
    "t_off":      T_OFF,
    "min_votes":  MIN_VOTES,
    "model_path": None,   # None = use default resolution; string = override path
}
MODELS_DIR = os.path.join(BASE_DIR, "models")


# ── Database init ─────────────────────────────────────────────────────────────
def ensure_sqlite_schema():
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(users)")
        user_columns = {row[1] for row in cursor.fetchall()}
        if "is_admin" not in user_columns:
            cursor.execute(
                "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"
            )
        cursor.execute("PRAGMA table_info(model_versions)")
        mv_columns = {row[1] for row in cursor.fetchall()}
        if mv_columns and "training_file_ids" not in mv_columns:
            cursor.execute(
                "ALTER TABLE model_versions ADD COLUMN training_file_ids TEXT"
            )
        if mv_columns and "name" not in mv_columns:
            cursor.execute(
                "ALTER TABLE model_versions ADD COLUMN name VARCHAR(100)"
            )
        conn.commit()


def initialize_database():
    ensure_sqlite_schema()
    db.create_all()
    if Gesture.query.count() == 0:
        for name, img in [
            ("Open", "/gestures/open.jpg"), ("Close", "/gestures/close.jpg"),
            ("Thumbs Up", "/gestures/thumbs_up.jpg"), ("Peace", "/gestures/peace.jpg"),
            ("Index Point", "/gestures/index_point.jpg"), ("Four", "/gestures/four.jpg"),
            ("Okay", "/gestures/okay.jpg"), ("Spiderman", "/gestures/spiderman.jpg"),
        ]:
            db.session.add(Gesture(gesture_name=name, gesture_image=img))
        db.session.commit()
        print("[db] seeded 8 gestures")
    starter_gestures = Gesture.query.filter(Gesture.gesture_name.in_(["Open", "Close"])).all()
    for g in starter_gestures:
        for ug in UserGesture.query.filter_by(gesture_id=g.id, is_unlocked=False).all():
            ug.is_unlocked = True
    db.session.commit()

with app.app_context():
    initialize_database()


# ── Feature extraction ────────────────────────────────────────────────────────
def feats(w, thr=0.01):
    ch, _ = w.shape
    MAV = np.mean(np.abs(w), axis=1)
    WL  = np.sum(np.abs(np.diff(w, axis=1)), axis=1)
    ZC  = np.zeros(ch); SSC = np.zeros(ch)
    for i in range(ch):
        x = w[i]; s = np.diff(x)
        ZC[i]  = np.sum(((x[:-1]*x[1:]) < 0) & (np.abs(x[:-1]-x[1:]) >= thr))
        SSC[i] = np.sum(((s[:-1]*s[1:]) < 0) & (np.abs(s[:-1]) >= thr) & (np.abs(s[1:]) >= thr))
    return np.concatenate([MAV, WL, ZC, SSC])


# ── Sessantaquattro+ TCP helpers ──────────────────────────────────────────────
def s64_make_command(fsamp=S64_FSAMP, nch=S64_NCH, mode=S64_MODE,
                     hres=S64_HRES, hpf=S64_HPF, exten=S64_EXTEN,
                     trig=S64_TRIG, rec=S64_REC, go=S64_GO):
    return (go | (rec<<1) | (trig<<2) | (exten<<4) |
            (hpf<<6) | (hres<<7) | (mode<<8) | (nch<<11) | (fsamp<<13))


def s64_num_channels(nch=S64_NCH, mode=S64_MODE):
    tbl = {0: (16, 12), 1: (24, 16), 2: (40, 24), 3: (72, 40)}
    standard, hp = tbl.get(nch, (72, 40))
    return hp if mode == 1 else standard


def s64_sampling_freq(fsamp=S64_FSAMP, mode=S64_MODE):
    if mode == 3:
        return {0:2000, 1:4000, 2:8000, 3:16000}.get(fsamp, 2000)
    return {0:500, 1:1000, 2:2000, 3:4000}.get(fsamp, 2000)


def recvall(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


# ── Simulated source ──────────────────────────────────────────────────────────
class SimulatedSource:
    def __init__(self, mat_path, speed=1.0):
        m = loadmat(mat_path)
        self.sig  = np.array(m['Data'], dtype=float)[:, :64]
        self.Fs   = float(np.squeeze(m['SamplingFrequency']))
        self.speed = speed
        self.n_channels = 64
        self._stop = False

    def stream(self):
        dt = 1.0 / (self.Fs * self.speed)
        for row in self.sig:
            if self._stop:
                break
            t0 = time.perf_counter()
            yield row
            rem = dt - (time.perf_counter() - t0)
            if rem > 0:
                time.sleep(rem)

    def stop(self):
        self._stop = True

    def pause(self): pass
    def resume(self): pass


# ── Live source ───────────────────────────────────────────────────────────────
class LiveSource:
    def __init__(self, host="0.0.0.0", port=45454,
                 fsamp=S64_FSAMP, nch=S64_NCH, mode=S64_MODE,
                 emg_channels=64, on_log=None):
        self.host          = host
        self.port          = port
        self.fsamp_bits    = fsamp
        self.nch_bits      = nch
        self.mode_bits     = mode
        self.emg_channels  = emg_channels
        self.on_log        = on_log or (lambda msg: None)

        self.n_channels    = s64_num_channels(nch, mode)
        self.Fs            = float(s64_sampling_freq(fsamp, mode))

        self._server_sock  = None
        self._client_sock  = None
        self._stop         = False

    def _connect(self):
        cmd = s64_make_command(self.fsamp_bits, self.nch_bits, self.mode_bits)
        self.on_log(f"[live] listening on {self.host}:{self.port} …")
        self.on_log(f"[live] {self.n_channels} ch @ {self.Fs:.0f} Hz  cmd={format(cmd,'016b')}")

        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind((self.host, self.port))
        self._server_sock.listen(1)

        self.on_log("[live] waiting for amplifier to connect …")
        self._client_sock, addr = self._server_sock.accept()
        self.on_log(f"[live] amplifier connected from {addr}")

        self._client_sock.send(cmd.to_bytes(2, byteorder='big', signed=True))
        self.on_log("[live] command sent — streaming started")

    def stream(self):
        self._connect()
        samples_per_packet = int(self.Fs) // 16
        packet_bytes = self.n_channels * 2 * samples_per_packet
        self.on_log(f"[live] packet size = {packet_bytes} bytes "
                    f"({self.n_channels} ch × 2 B × {samples_per_packet} samp)")

        while not self._stop:
            try:
                data = recvall(self._client_sock, packet_bytes)
                if data is None:
                    self.on_log("[live] connection closed by amplifier")
                    break
                unpacked = struct.unpack(f'>{len(data)//2}h', data)
                block    = np.array(unpacked).reshape((-1, self.n_channels)).T
                emg      = block[:self.emg_channels, :].astype(float)
                for i in range(emg.shape[1]):
                    yield emg[:, i]
            except Exception as e:
                self.on_log(f"[live] recv error: {e}")
                break

    def stop(self):
        self._stop = True
        try:
            if self._client_sock: self._client_sock.close()
        except: pass
        try:
            if self._server_sock: self._server_sock.close()
        except: pass

    def pause(self): pass
    def resume(self): pass


# ── Core worker ───────────────────────────────────────────────────────────────
def run_worker(mode="simulated", live_opts=None, user_id=None):
    """
    Process EMG data and emit SocketIO updates.
    Uses absolute RMS thresholds — matches NEWREALCLASSIFIER.py exactly.
    """
    global worker_running, active_source, test_sample_counter
    worker_running = True
    live_opts = live_opts or {}
    test_sample_counter = 0
    test_gesture_start  = 0
    print(f"[worker] run_worker started, mode={mode}, user_id={user_id}")

    try:
        import joblib
    except ImportError:
        print("[worker] ERROR: joblib not installed")
        socketio.emit("log", {"text": "ERROR: joblib not installed"})
        worker_running = False
        return

    socketio.emit("state", {"label": "LOADING...", "gesture": "—", "color": "#ffffff", "act": 0.0})

    # ── Resolve model path: runtime override → user's active model → fallback ──
    model_path = MODEL_PATH  # default fallback
    if runtime_config["model_path"] and os.path.isfile(runtime_config["model_path"]):
        model_path = runtime_config["model_path"]
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
        worker_running = False
        return

    try:
        scaler, model = joblib.load(model_path)
        print(f"[worker] model loaded from {model_path}")
        socketio.emit("log", {"text": f"✓  model loaded ({os.path.basename(model_path)})"})
    except Exception as e:
        print(f"[worker] ERROR loading model: {e}")
        socketio.emit("log", {"text": f"ERROR loading model: {e}"})
        worker_running = False
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
        try:
            source = SimulatedSource(MAT_PATH, PLAYBACK_SPEED)
        except Exception as e:
            socketio.emit("log", {"text": f"ERROR loading .mat: {e}"})
            worker_running = False
            return
        Fs   = source.Fs
        n_ch = source.n_channels
        socketio.emit("log", {"text": f"Loaded {source.sig.shape[0]} samples @ {Fs:.0f} Hz"})

    active_source = source

    # ── Filters ───────────────────────────────────────────────────────────
    nyq = Fs / 2
    b_bp, a_bp = butter(2, [F_LOWER/nyq, F_UPPER/nyq], btype='band')
    b_n,  a_n  = iirnotch(F_NOTCH/nyq, F_NOTCH/BW_NOTCH)
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

    # ── Thresholds (absolute — no calibration) ─────────────────────────
    # Read from runtime_config so they can be changed live from the Predict page
    t_on  = runtime_config["t_on"]
    t_off = runtime_config["t_off"]

    # ── No calibration — rest_mean=1 so activation = raw median RMS ──
    rest_mean    = np.ones(n_ch)
    calib_done   = True

    # ── Detection state ───────────────────────────────────────────────────
    det_buf     = deque(maxlen=det_win)
    gest_buf    = []
    det_ctr     = 0
    state_      = 0
    cnt_on      = 0
    cnt_off     = 0
    votes       = []
    last_printed= ""

    # Signal strip buffers
    sig_flex = []
    sig_ext  = []

    # ── Throttle timers for non-critical emits ────────────────────────
    last_signal_emit = 0.0    # time.perf_counter() of last signal emit
    last_state_emit  = 0.0    # time.perf_counter() of last periodic state emit
    SIGNAL_EMIT_INTERVAL = 0.25   # seconds — signal strip update rate
    STATE_EMIT_INTERVAL  = 0.20   # seconds — periodic REST/ACTIVE status rate

    print(f"[worker] skipping calibration — using absolute thresholds")
    socketio.emit("log", {"text": "✓  No calibration — using absolute thresholds"})
    socketio.emit("log", {"text": f"✓  T_ON={t_on}  T_OFF={t_off}  MIN_VOTES={runtime_config['min_votes']}"})
    socketio.emit("state", {"label": "REST", "gesture": "REST", "color": "#444444", "act": 0.0})

    # ── Main sample loop ──────────────────────────────────────────────────
    for raw in source.stream():
        if not worker_running:
            break

        # ── Buffer raw samples for testing .npz ──────────────────────
        if test_session_id is not None:
            test_sample_buffer.append(raw.copy())
            test_sample_counter += 1

        filtered = filt(raw - np.mean(raw))

        # ── Accumulate buffers ────────────────────────────────────────────
        if state_ == 1:
            gest_buf.append(filtered)
        det_buf.append(filtered)

        if len(det_buf) < det_win:
            continue
        det_ctr += 1
        if det_ctr < det_step:
            continue
        det_ctr = 0

        # ── Activation: relative to rest (matches RealTimeGestureClassifierUSETHIS) ──
        w   = np.stack(det_buf, axis=1)
        act = float(np.median(np.sqrt(np.mean(w ** 2, axis=1)) / rest_mean))

        # Signal strip (ratio values) — throttled to avoid blocking classifier
        act_flex = float(np.median(np.sqrt(np.mean(w[:32] ** 2, axis=1)) / rest_mean[:32]))
        act_ext  = float(np.median(np.sqrt(np.mean(w[32:n_ch] ** 2, axis=1)) / rest_mean[32:n_ch]))
        sig_flex.append(act_flex)
        sig_ext.append(act_ext)

        now = time.perf_counter()
        if now - last_signal_emit >= SIGNAL_EMIT_INTERVAL:
            last_signal_emit = now
            wf = sig_flex[-100:]; we = sig_ext[-100:]
            sf = len(sig_flex) - len(wf); se = len(sig_ext) - len(we)
            socketio.emit("signal", {
                "flexors":   [{"x": sf+j, "y": round(v, 6)} for j, v in enumerate(wf)],
                "extensors": [{"x": se+j, "y": round(v, 6)} for j, v in enumerate(we)],
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

        # ── State machine ─────────────────────────────────────────────────
        # Re-read thresholds each step so live changes from Predict page apply
        t_on  = runtime_config["t_on"]
        t_off = runtime_config["t_off"]

        if state_ == 0:
            if act > t_on:
                cnt_on += 1
                if cnt_on >= N_ON:
                    socketio.emit("state", {"label": "ACTIVE", "gesture": "", "color": "#ffffff", "act": round(act, 6)})
                    socketio.emit("log",   {"text": "▶  gesture start"})
                    state_ = 1; gest_buf = []; votes = []; last_printed = ""; cnt_on = 0
                    # Record gesture start sample index for testing
                    if test_session_id is not None:
                        test_gesture_start = test_sample_counter
            else:
                cnt_on = 0
        else:
            gest_buf.append(filtered)
            cnt_off = cnt_off + 1 if act < t_off else 0
            gesture_end = (cnt_off >= N_OFF) or (len(gest_buf) >= max_g)

            if len(gest_buf) >= win_s:
                window = np.stack(gest_buf[-win_s:], axis=1)
                f = feats(window)
                v = model.predict(scaler.transform(f.reshape(1, -1)))[0]
                votes.append(v)

            min_v = runtime_config["min_votes"]
            if len(votes) >= min_v:
                vc = np.zeros(len(GESTURE_CLASSES))
                for v in votes:
                    if v < len(GESTURE_CLASSES): vc[v] += 1
                gname = GESTURE_CLASSES.get(int(np.argmax(vc)), "?")
                col   = GESTURE_COLORS.get(gname, "#ffffff")
                # Build vote breakdown for frontend
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
                # Record gesture interval for testing (label=None, tagged later by trial endpoint)
                if test_session_id is not None:
                    test_gesture_intervals.append([test_gesture_start, test_sample_counter, None])
                if len(votes) >= min_v:
                    vc = np.zeros(len(GESTURE_CLASSES))
                    for v in votes:
                        if v < len(GESTURE_CLASSES): vc[v] += 1
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
        socketio.emit("state", {"label": "DONE ✓", "gesture": "DONE", "color": "#69ff47", "act": 0.0})
        socketio.emit("log",   {"text": "— finished —"})

    # ── Save testing signal if this was a live test session ─────────
    _save_test_signal(Fs, n_ch)

    active_source  = None
    worker_running = False


def _save_test_signal(Fs, n_ch):
    """Save buffered raw EMG from a live testing session as .npz for retraining.

    Each detected gesture interval is a [start_sample, end_sample, label]
    triple.  label is a gesture name (confirmed), False (excluded), or
    None (unresolved — session ended mid-trial).  Only confirmed
    intervals are saved for training.
    """
    global test_sample_buffer, test_gesture_intervals
    global test_session_user_id, test_session_id

    sid       = test_session_id
    uid       = test_session_user_id
    samples   = test_sample_buffer
    intervals = list(test_gesture_intervals)

    # Clear globals regardless
    test_sample_buffer     = []
    test_gesture_intervals = []
    test_session_user_id   = None
    test_session_id        = None

    if not sid or not samples:
        return

    # Keep only confirmed intervals (label is a string, not False/None)
    confirmed = [(s, e, lbl) for s, e, lbl in intervals
                 if isinstance(lbl, str)]
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

            # Save the full continuous signal, the confirmed gesture order,
            # AND the exact sample intervals so process_npz can use them
            # directly instead of re-running activation detection.
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


# ── SocketIO handlers ─────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    print("[server] client connected")

@socketio.on("disconnect")
def on_disconnect():
    print("[server] client disconnected")

@socketio.on("start")
def on_start(data=None):
    global worker_thread, worker_running
    print(f"[server] 'start' event received, worker_running={worker_running}, data={data}")
    if worker_running:
        print("[server] worker already running, ignoring start")
        socketio.emit("log", {"text": "Already running!"})
        return
    data      = data or {}
    mode      = data.get("mode", "simulated")
    live_opts = data.get("liveOpts", {})
    user_id   = data.get("userId")
    print(f"[server] starting worker in mode={mode}, user_id={user_id}")
    worker_thread = threading.Thread(target=run_worker, args=(mode, live_opts, user_id), daemon=True)
    worker_thread.start()

@socketio.on("stop")
def on_stop(_=None):
    global worker_running, active_source
    worker_running = False
    if active_source:
        active_source.stop()
        active_source = None
    socketio.emit("log",  {"text": "Stopped by user."})
    socketio.emit("state", {"label": "STOPPED", "gesture": "—", "color": "#888888", "act": 0.0})

# ── Runtime config updates from Predict page ──────────────────────────────────
@socketio.on("update_config")
def on_update_config(data=None):
    data = data or {}
    changed = []
    if "t_on" in data:
        runtime_config["t_on"] = float(data["t_on"])
        changed.append(f"T_ON={runtime_config['t_on']}")
    if "t_off" in data:
        runtime_config["t_off"] = float(data["t_off"])
        changed.append(f"T_OFF={runtime_config['t_off']}")
    if "min_votes" in data:
        runtime_config["min_votes"] = int(data["min_votes"])
        changed.append(f"MIN_VOTES={runtime_config['min_votes']}")
    if "model_path" in data:
        mp = data["model_path"]
        if mp:
            full = os.path.join(BASE_DIR, mp) if not os.path.isabs(mp) else mp
            if os.path.isfile(full):
                runtime_config["model_path"] = full
                changed.append(f"model={os.path.basename(full)}")
            else:
                socketio.emit("config_error", {"error": f"Model file not found: {mp}"})
                return
        else:
            runtime_config["model_path"] = None
            changed.append("model=default")
    if changed:
        socketio.emit("log", {"text": f"⚙  Config updated: {', '.join(changed)}"})
    socketio.emit("config_state", {
        "t_on": runtime_config["t_on"],
        "t_off": runtime_config["t_off"],
        "min_votes": runtime_config["min_votes"],
        "model_path": os.path.basename(runtime_config["model_path"]) if runtime_config["model_path"] else None,
    })

@socketio.on("get_config")
def on_get_config(_=None):
    socketio.emit("config_state", {
        "t_on": runtime_config["t_on"],
        "t_off": runtime_config["t_off"],
        "min_votes": runtime_config["min_votes"],
        "model_path": os.path.basename(runtime_config["model_path"]) if runtime_config["model_path"] else None,
    })

@app.route("/api/models/list")
def list_models():
    """List .pkl model files. If ?userId is provided, return that user's DB models."""
    user_id = request.args.get("userId", type=int)
    if user_id:
        models = ModelVersion.query.filter_by(user_id=user_id).order_by(ModelVersion.version_number.desc()).all()
        return jsonify([{
            "name": m.name or f"Model v{m.version_number}",
            "filePath": m.file_path,
            "accuracy": m.accuracy,
            "isActive": m.is_active,
        } for m in models])
    # Fallback: list all .pkl files from disk
    if not os.path.isdir(MODELS_DIR):
        return jsonify([])
    files = sorted([f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")])
    return jsonify([{"name": f, "filePath": f"models/{f}", "accuracy": None, "isActive": False} for f in files])

@socketio.on("check_device")
def on_check_device(data=None):
    data = data or {}
    host = data.get("host", "0.0.0.0")
    port = int(data.get("port", 45454))
    timeout = 6

    def _probe():
        srv = None; cli = None
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind((host, port)); srv.listen(1); srv.settimeout(timeout)
            socketio.emit("device_status", {"status": "connecting"})
            cli, addr = srv.accept(); cli.close(); srv.close()
            socketio.emit("device_status", {"status": "connected"})
        except socket.timeout:
            socketio.emit("device_status", {"status": "error",
                "error": "Device not found. Check WiFi connection and try again."})
        except OSError as e:
            socketio.emit("device_status", {"status": "error", "error": str(e)})
        finally:
            if cli:
                try: cli.close()
                except: pass
            if srv:
                try: srv.close()
                except: pass
    threading.Thread(target=_probe, daemon=True).start()

DEVICE_WEB_UI = "http://192.168.1.1"

def _scrape_battery(url=DEVICE_WEB_UI):
    import re
    from urllib.request import urlopen, Request
    from urllib.error import URLError
    try:
        bust_url = f"{url}?_t={int(time.time())}"
        req = Request(bust_url, headers={"Cache-Control": "no-cache", "Pragma": "no-cache"})
        resp = urlopen(req, timeout=4)
        html = resp.read().decode("utf-8", errors="ignore")
        m = re.search(r'Battery Level:\s*</td>\s*<td[^>]*>\s*(\d+)%', html)
        if m: return int(m.group(1))
    except (URLError, OSError): pass
    return None

@socketio.on("get_battery")
def on_get_battery(_=None):
    def _query():
        level = _scrape_battery()
        if level is not None:
            socketio.emit("battery_level", {"level": level})
        else:
            socketio.emit("battery_level", {"level": None, "error": "Could not read battery"})
            socketio.emit("device_status", {"status": "disconnected"})
    threading.Thread(target=_query, daemon=True).start()

@app.route("/")
def index():
    return {"status": "EMG Gesture Classifier backend running"}


# ═════════════════════════════════════════════════════════════════════════════
# ── API ROUTES ────────────────────────────────────────────────────────────────
# ═════════════════════════════════════════════════════════════════════════════

@app.route("/api/testing/gestures/<int:user_id>")
def testing_gestures(user_id):
    user = db.session.get(User, user_id)
    if not user: return jsonify({"error": "User not found"}), 404
    result = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled: continue
        g = db.session.get(Gesture, ug.gesture_id)
        eligible = ug.total_times_trained >= 0
        result.append({
            "gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image,
            "accuracy": round(ug.accuracy, 1), "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested, "eligible": eligible,
            "weight": max(1, 100 - int(ug.accuracy)) if eligible else 0,
        })
    return jsonify({"gestures": result})

@app.route("/api/testing/sequence/<int:user_id>", methods=["POST"])
def testing_sequence(user_id):
    data  = request.get_json(silent=True) or {}
    count = int(data.get("count", 15))
    user  = db.session.get(User, user_id)
    if not user: return jsonify({"error": "User not found"}), 404
    eligible = []; weights = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled or ug.total_times_trained < 15: continue
        g = db.session.get(Gesture, ug.gesture_id)
        eligible.append({"gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image})
        weights.append(max(1, 100 - int(ug.accuracy)))
    if not eligible:
        return jsonify({"error": "No eligible gestures (need ≥15 training reps each)"}), 400
    return jsonify({"sequence": random.choices(eligible, weights=weights, k=count)})

# ── Auto-unlock helper ────────────────────────────────────────────────────────
def _check_auto_unlock(user_id):
    """Unlock the next gesture if all currently-unlocked gestures have
    avg accuracy >= AUTO_UNLOCK_ACCURACY and each has >= AUTO_UNLOCK_MIN_TESTS trials."""
    ugs = UserGesture.query.filter_by(user_id=user_id).all()
    ug_by_name = {}
    for ug in ugs:
        g = db.session.get(Gesture, ug.gesture_id)
        if g: ug_by_name[g.gesture_name] = ug

    unlocked = [ug_by_name[n] for n in UNLOCK_ORDER if n in ug_by_name and ug_by_name[n].is_unlocked]
    if not unlocked:
        return None

    # Check all unlocked gestures meet thresholds
    for ug in unlocked:
        total = ug.correct_predictions + ug.incorrect_predictions
        if total < AUTO_UNLOCK_MIN_TESTS:
            return None
        if ug.accuracy < AUTO_UNLOCK_ACCURACY:
            return None

    # Find next locked gesture in order
    for name in UNLOCK_ORDER:
        ug = ug_by_name.get(name)
        if ug and not ug.is_unlocked:
            ug.is_unlocked = True
            db.session.commit()
            return name
    return None

@app.route("/api/testing/session", methods=["POST"])
def create_test_session():
    data    = request.get_json(silent=True) or {}
    user_id = data.get("userId")
    if not user_id: return jsonify({"error": "userId required"}), 400
    sess = Session(
        user_id=user_id, session_type="testing",
        planned_duration=data.get("plannedDuration"),
        status="in_progress", started_at=datetime.now(timezone.utc),
        number_of_connected_channels=data.get("channels", 64),
    )
    db.session.add(sess); db.session.commit()

    # Prepare testing signal buffer for this session
    global test_sample_buffer, test_gesture_intervals
    global test_session_user_id, test_session_id, test_sample_counter
    test_sample_buffer     = []
    test_gesture_intervals = []
    test_session_user_id   = user_id
    test_session_id        = sess.id
    test_sample_counter    = 0

    return jsonify({"sessionId": sess.id})

@app.route("/api/testing/trial", methods=["POST"])
def record_test_trial():
    data        = request.get_json(silent=True) or {}
    user_id     = data.get("userId");      session_id  = data.get("sessionId")
    gesture_id  = data.get("gestureId");   prediction  = data.get("prediction")
    confidence  = data.get("confidence");  ground_truth= data.get("groundTruth")
    was_correct = data.get("wasCorrect");  was_skipped = data.get("wasSkipped", False)
    retry_count = data.get("retryCount", 0); trial_number = data.get("trialNumber", 1)

    # Record ground truth in test signal sequence:
    #   "Yes" (was_correct=True)  → user DID perform the gesture → tag interval with label
    #   "No"  (was_correct=False) → user did NOT perform it      → tag interval as excluded
    #   "Skip"                    → may or may not have activation → tag if interval exists
    # Tag the most recent untagged gesture interval from the worker's state machine.
    if test_session_id is not None and test_gesture_intervals:
        # Find the last untagged interval (label is still None)
        for iv in reversed(test_gesture_intervals):
            if iv[2] is None:
                if was_correct and not was_skipped and ground_truth:
                    iv[2] = ground_truth  # confirmed gesture
                else:
                    iv[2] = False  # mark as excluded (No / Skip)
                break

    display_order = TestingTrial.query.filter_by(session_id=session_id).count() + 1

    trial = TestingTrial(
        user_id=user_id, session_id=session_id, gesture_id=gesture_id,
        display_order=display_order, trial_number=trial_number,
        ground_truth=ground_truth, prediction=prediction, confidence=confidence,
        retry_count=retry_count, was_correct=was_correct, was_skipped=was_skipped,
    )
    db.session.add(trial)

    ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gesture_id).first()
    if ug:
        ug.total_times_tested += 1
        if was_correct:   ug.correct_predictions += 1
        elif not was_skipped: ug.incorrect_predictions += 1
        total = ug.correct_predictions + ug.incorrect_predictions
        ug.accuracy = round(ug.correct_predictions / total * 100, 1) if total > 0 else 0.0
        if confidence is not None:
            n = ug.total_times_tested
            ug.average_confidence = round(((ug.average_confidence*(n-1))+confidence)/n, 3)
        if ug.accuracy < 50 and total >= 5: ug.needs_retraining = True

    db.session.commit()

    # ── Auto-unlock check ────────────────────────────────────────────────
    newly_unlocked = None
    if user_id:
        newly_unlocked = _check_auto_unlock(user_id)

    return jsonify({"trialId": trial.id, "accuracy": ug.accuracy if ug else None,
                    "newlyUnlocked": newly_unlocked})

@app.route("/api/testing/session/<int:session_id>/end", methods=["POST"])
def end_test_session(session_id):
    data = request.get_json(silent=True) or {}
    sess = db.session.get(Session, session_id)
    if not sess: return jsonify({"error": "Session not found"}), 404
    sess.status    = data.get("status", "completed")
    sess.ended_at  = datetime.now(timezone.utc)
    if sess.started_at:
        # Ensure both datetimes are offset-aware for subtraction
        sa = sess.started_at if sess.started_at.tzinfo else sess.started_at.replace(tzinfo=timezone.utc)
        sess.actual_duration = (sess.ended_at - sa).total_seconds()
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    first_name = (data.get("firstName") or "").strip()
    last_name  = (data.get("lastName")  or "").strip()
    username   = (data.get("username")  or "").strip().lower()
    password   = data.get("password") or ""
    if not all([first_name, last_name, username, password]):
        return jsonify({"error": "All fields are required"}), 400
    if User.query.filter(User.username.ilike(username)).first():
        return jsonify({"error": "Username already taken"}), 409
    user = User(first_name=first_name, last_name=last_name, username=username,
                password_hash=generate_password_hash(password),
                last_login=datetime.now(timezone.utc))
    db.session.add(user); db.session.commit()
    default_unlocked = {"Open", "Close"}
    for g in Gesture.query.all():
        db.session.add(UserGesture(user_id=user.id, gesture_id=g.id,
                                   is_unlocked=(g.gesture_name in default_unlocked)))
    db.session.commit()
    return jsonify({"id": user.id, "username": user.username, "firstName": user.first_name,
                    "lastName": user.last_name, "isAdmin": user.is_admin}), 201

@app.route("/api/login", methods=["POST"])
def login():
    data     = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400
    user = User.query.filter(User.username.ilike(username)).first()
    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid username or password"}), 401
    user.last_login = datetime.now(timezone.utc); db.session.commit()
    return jsonify({"id": user.id, "username": user.username, "firstName": user.first_name,
                    "lastName": user.last_name, "isAdmin": user.is_admin})

@app.route("/api/admin/users")
def admin_users():
    users = User.query.filter_by(is_admin=False).order_by(User.first_name, User.last_name).all()
    return jsonify([{"id": u.id, "firstName": u.first_name, "lastName": u.last_name,
                     "username": u.username} for u in users])

@app.route("/api/admin/gestures/<int:user_id>")
def admin_gestures(user_id):
    user = db.session.get(User, user_id)
    if not user: return jsonify({"error": "User not found"}), 404
    result = []
    for ug in user.user_gestures:
        g = db.session.get(Gesture, ug.gesture_id)
        result.append({
            "gestureId": g.id, "name": g.gesture_name,
            "isUnlocked": ug.is_unlocked, "isEnabled": ug.is_enabled,
            "accuracy": round(ug.accuracy, 1),
            "avgConfidence": round(ug.average_confidence * 100, 1) if ug.average_confidence else 0,
            "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested,
        })
    return jsonify(result)

@app.route("/api/admin/gestures/<int:user_id>/unlock", methods=["POST"])
def admin_toggle_unlock(user_id):
    data = request.get_json(silent=True) or {}
    gesture_id = data.get("gestureId")
    unlock = data.get("unlock", True)
    if gesture_id is None: return jsonify({"error": "gestureId required"}), 400
    ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gesture_id).first()
    if not ug: return jsonify({"error": "UserGesture not found"}), 404
    ug.is_unlocked = bool(unlock)
    db.session.commit()
    return jsonify({"ok": True, "gestureId": gesture_id, "isUnlocked": ug.is_unlocked})

@app.route("/api/admin/training-files/<int:user_id>")
def admin_training_files(user_id):
    files = TrainingFile.query.filter_by(user_id=user_id).order_by(TrainingFile.created_at.desc()).all()
    return jsonify([{
        "id": f.id, "fileName": f.file_name, "numSamples": f.num_samples,
        "gestures": json.loads(f.gestures) if f.gestures else [],
        "createdAt": f.created_at.isoformat() if f.created_at else None,
        "sessionId": f.session_id,
    } for f in files])

@app.route("/api/admin/models/<int:user_id>")
def admin_models(user_id):
    models = ModelVersion.query.filter_by(user_id=user_id).order_by(ModelVersion.version_number.desc()).all()
    result = []
    for m in models:
        file_ids = json.loads(m.training_file_ids) if m.training_file_ids else []
        file_names = []
        if file_ids:
            tfs = TrainingFile.query.filter(TrainingFile.id.in_(file_ids)).all()
            file_names = [tf.file_name for tf in tfs]
        result.append({
            "id": m.id, "versionNumber": m.version_number,
            "name": m.name,
            "accuracy": m.accuracy, "filePath": m.file_path,
            "trainingDate": m.training_date.isoformat() if m.training_date else None,
            "isActive": m.is_active,
            "trainingFiles": file_names,
        })
    return jsonify(result)

@app.route("/api/admin/models/<int:user_id>/set-active", methods=["POST"])
def admin_set_active_model(user_id):
    data = request.get_json(silent=True) or {}
    model_id = data.get("modelId")
    if not model_id: return jsonify({"error": "modelId required"}), 400
    ModelVersion.query.filter_by(user_id=user_id).update({"is_active": False})
    mv = ModelVersion.query.filter_by(id=model_id, user_id=user_id).first()
    if not mv: return jsonify({"error": "Model not found"}), 404
    mv.is_active = True
    db.session.commit()
    return jsonify({"ok": True, "activeModelId": mv.id})

@app.route("/api/admin/models/<int:model_id>", methods=["DELETE"])
def admin_delete_model(model_id):
    mv = ModelVersion.query.get(model_id)
    if not mv:
        return jsonify({"error": "Model not found"}), 404
    # delete the .pkl file from disk
    if mv.file_path:
        full_path = os.path.join(BASE_DIR, mv.file_path)
        if os.path.isfile(full_path):
            os.remove(full_path)
    db.session.delete(mv)
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/models/<int:model_id>/rename", methods=["POST"])
def admin_rename_model(model_id):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip() or None
    mv = ModelVersion.query.get(model_id)
    if not mv:
        return jsonify({"error": "Model not found"}), 404
    mv.name = name
    db.session.commit()
    return jsonify({"ok": True, "name": mv.name})

@app.route("/api/admin/train-model", methods=["POST"])
def admin_train_model():
    data = request.get_json(silent=True) or {}
    user_id = data.get("userId")
    file_ids = data.get("trainingFileIds", [])
    if not user_id or not file_ids:
        return jsonify({"error": "userId and trainingFileIds required"}), 400
    user = db.session.get(User, user_id)
    if not user: return jsonify({"error": "User not found"}), 404
    files = TrainingFile.query.filter(
        TrainingFile.id.in_(file_ids), TrainingFile.user_id == user_id).all()
    if not files: return jsonify({"error": "No matching training files found"}), 404
    tf_rows = []
    for f in files:
        gesture_order = json.loads(f.gestures) if f.gestures else []
        tf_rows.append({"id": f.id, "file_name": f.file_name,
                        "file_path": f.file_path, "gestures": gesture_order,
                        "session_id": f.session_id})
    logs = []
    try:
        from train_model import train_model
        result = train_model(tf_rows, {"id": user.id, "username": user.username},
                             on_log=lambda msg: logs.append(msg))
    except Exception as e:
        return jsonify({"error": str(e), "logs": logs}), 500
    max_ver = db.session.query(db.func.max(ModelVersion.version_number)).filter_by(user_id=user_id).scalar() or 0
    ModelVersion.query.filter_by(user_id=user_id, is_active=True).update({"is_active": False})
    mv = ModelVersion(user_id=user_id, version_number=max_ver + 1,
                      training_date=datetime.now(timezone.utc),
                      accuracy=result["accuracy"], file_path=result["model_path"],
                      training_file_ids=json.dumps(file_ids), is_active=True)
    db.session.add(mv); db.session.commit()
    logs.append(f"✓ Model v{mv.version_number} saved (id={mv.id})")
    return jsonify({"modelId": mv.id, "versionNumber": mv.version_number,
                    "accuracy": result["accuracy"], "filePath": result["model_path"],
                    "nSamples": result["n_samples"], "logs": logs})

@app.route("/api/dashboard/<int:user_id>")
def dashboard(user_id):
    user = db.session.get(User, user_id)
    if not user: return jsonify({"error": "User not found"}), 404
    gesture_stats = []
    for ug in user.user_gestures:
        g = db.session.get(Gesture, ug.gesture_id)
        gesture_stats.append({
            "gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image,
            "accuracy": round(ug.accuracy, 1), "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested, "correct": ug.correct_predictions,
            "incorrect": ug.incorrect_predictions, "avgConfidence": round(ug.average_confidence, 1),
            "needsRetraining": ug.needs_retraining, "isUnlocked": ug.is_unlocked,
            "isEnabled": ug.is_enabled,
        })
    unlocked        = [g for g in gesture_stats if g["isUnlocked"]]
    total_correct   = sum(g["correct"]    for g in unlocked)
    total_incorrect = sum(g["incorrect"]  for g in unlocked)
    total_preds     = total_correct + total_incorrect
    overall_acc     = round(total_correct / total_preds * 100, 1) if total_preds > 0 else 0.0
    gestures_trained = sum(1 for g in unlocked if g["totalTrained"] > 0)
    recent = Session.query.filter_by(user_id=user_id).order_by(Session.started_at.desc()).limit(5).all()
    recent_sessions = [{"id": s.id, "type": s.session_type, "status": s.status,
                        "startedAt": s.started_at.isoformat() if s.started_at else None,
                        "duration": s.actual_duration} for s in recent]
    suggestions = []
    weak = [g for g in unlocked if g["totalTested"] >= 5 and g["accuracy"] < 60]
    if weak:
        worst = min(weak, key=lambda g: g["accuracy"])
        suggestions.append(f"{worst['name']} has {worst['accuracy']}% accuracy — consider retraining it.")
    untrained = [g for g in unlocked if g["totalTrained"] == 0]
    if untrained:
        suggestions.append(f"You have {len(untrained)} unlocked gesture(s) that haven't been trained yet.")
    if user.training_streak == 0: suggestions.append("Start a training session to begin your streak!")
    elif user.training_streak >= 3: suggestions.append(f"Nice {user.training_streak}-day streak! Keep it up.")
    return jsonify({"streak": user.training_streak, "overallAccuracy": overall_acc,
                    "gesturesTrained": gestures_trained, "totalGestures": len(gesture_stats),
                    "gestures": gesture_stats, "recentSessions": recent_sessions,
                    "suggestions": suggestions})

@app.route("/api/training/gestures/<int:user_id>")
def training_gestures(user_id):
    user = db.session.get(User, user_id)
    if not user: return jsonify({"error": "User not found"}), 404
    result = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled: continue
        g = db.session.get(Gesture, ug.gesture_id)
        result.append({"gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image,
                        "totalTrained": ug.total_times_trained, "needsRetraining": ug.needs_retraining})
    return jsonify({"gestures": result})


# ── Training data collection ──────────────────────────────────────────────────
GESTURE_S       = 3.0
REST_S          = 3.0
INITIAL_REST_S  = 6.0
REPS_PER_GESTURE= 5

def run_training_collector(mode="live", live_opts=None, user_id=None,
                           session_minutes=5, gesture_ids=None):
    global training_running, training_source
    training_running = True
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
        try:
            source = SimulatedSource(MAT_PATH, PLAYBACK_SPEED)
        except Exception as e:
            socketio.emit("train_log", {"text": f"ERROR: {e}"}); training_running = False; return

    training_source = source
    Fs = source.Fs

    # ── Build phase schedule (wall-clock durations) ───────────────────
    phase_schedule = []   # (duration_s, type, gesture_name, index)
    phase_schedule.append((INITIAL_REST_S, "rest", None, 0))
    for gi, gname in enumerate(sequence):
        phase_schedule.append((GESTURE_S, "gesture", gname, gi+1))
        phase_schedule.append((REST_S, "rest", None, gi+1))

    # ── Shared state between collector thread and timer thread ────────
    lock = threading.Lock()
    all_samples = []
    collected = []
    current_label = [None]       # mutable slot for current gesture label
    current_samples = []         # samples for current gesture phase
    phase_i = [0]

    # ── Timer thread: drives UI phases/countdown independently ────────
    SIG_EMIT_INTERVAL = 0.25

    def _phase_timer():
        for pi, (dur, ptype, gname, idx) in enumerate(phase_schedule):
            if not training_running: break
            phase_i[0] = pi

            # Tell sample loop what to label
            with lock:
                if ptype == "gesture":
                    current_label[0] = gname
                else:
                    current_label[0] = None

            # Emit phase to frontend
            if ptype == "gesture":
                socketio.emit("train_phase", {"phase":"gesture","gesture":gname,
                                              "countdown":int(dur),"index":idx,
                                              "total":total,"nextGesture":None})
                socketio.emit("train_log", {"text": f"▶  [{idx}/{total}] {gname}"})
            else:
                next_g = None
                for fp in phase_schedule[pi+1:]:
                    if fp[1] == "gesture":
                        next_g = fp[2]; break
                socketio.emit("train_phase", {"phase":"rest","gesture":"Relax",
                                              "countdown":int(dur),"index":idx,
                                              "total":total,"nextGesture":next_g})

            # Wait for phase duration, emitting signal strip periodically
            phase_start = time.perf_counter()
            last_sig = phase_start
            while time.perf_counter() - phase_start < dur:
                if not training_running: return
                # Signal strip emit
                now = time.perf_counter()
                if now - last_sig >= SIG_EMIT_INTERVAL:
                    last_sig = now
                    with lock:
                        n = len(all_samples)
                    if n > 0:
                        win = max(1, int(Fs * 0.05))
                        with lock:
                            snap = all_samples[-win:]
                        if snap:
                            w = np.column_stack(snap)
                            half = w.shape[0] // 2
                            rms_flex = float(np.median(np.sqrt(np.mean(w[:half]**2, axis=1))))
                            rms_ext  = float(np.median(np.sqrt(np.mean(w[half:]**2, axis=1))))
                            socketio.emit("train_signal", {
                                "rms_flex": round(rms_flex, 6),
                                "rms_ext":  round(rms_ext, 6),
                            })
                time.sleep(0.05)

            # Phase ended — finalize gesture data
            if ptype == "gesture":
                with lock:
                    current_label[0] = None
                    if current_samples:
                        collected.append({"label": gname, "data": np.array(current_samples)})
                        socketio.emit("train_log", {"text": f"  ✓ Recorded {gname} ({len(current_samples)} samples)"})
                        current_samples.clear()

    timer_thread = threading.Thread(target=_phase_timer, daemon=True)
    timer_thread.start()

    # ── Sample loop: just store data, nothing else ────────────────────
    for raw in source.stream():
        if not training_running: break
        s = raw.copy()
        with lock:
            all_samples.append(s)
            if current_label[0] is not None:
                current_samples.append(s)

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
                    from collections import Counter
                    actual_dur = (ended_at - started_at).total_seconds()
                    sess = Session(user_id=user_id, session_type="training",
                                   planned_duration=session_minutes*60,
                                   actual_duration=actual_dur,
                                   status="completed" if training_running else "aborted",
                                   started_at=started_at, ended_at=ended_at,
                                   number_of_connected_channels=n_ch)
                    db.session.add(sess); db.session.flush()
                    gesture_map = {g.gesture_name: g.id for g in Gesture.query.all()}
                    rep_counter = Counter()
                    for c in collected:
                        gname = c["label"]; gid = gesture_map.get(gname)
                        if not gid: continue
                        rep_counter[gname] += 1; order = rep_counter[gname]
                        tg = TrainingGesture(session_id=sess.id, gesture_id=gid,
                                             display_order=order, completed=True)
                        db.session.add(tg)
                        ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gid).first()
                        if ug: ug.total_times_trained += 1; ug.times_trained = max(ug.times_trained, 1)
                    db.session.add(TrainingFile(
                        user_id=user_id, session_id=sess.id, file_name=filename,
                        file_path=os.path.relpath(filepath, BASE_DIR),
                        num_samples=len(collected), gestures=json.dumps(sequence),
                        created_at=ended_at))
                    db.session.commit()
                    socketio.emit("train_log", {"text": f"✓ Session saved (id={sess.id})"})
            except Exception as e:
                socketio.emit("train_log", {"text": f"⚠ DB error: {e}"})
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
        socketio.emit("train_log", {"text": "Already running!"}); return
    data = data or {}
    training_thread = threading.Thread(
        target=run_training_collector,
        args=(data.get("mode","simulated"), data.get("liveOpts",{})),
        kwargs={"user_id": data.get("userId"),
                "session_minutes": int(data.get("sessionMinutes", 5)),
                "gesture_ids": data.get("gestureIds")},
        daemon=True)
    training_thread.start()

@socketio.on("train_pause")
def on_train_pause(_=None):
    global training_paused
    training_paused = True
    if training_source: training_source.pause()
    socketio.emit("train_log",   {"text": "⏸ Paused."})
    socketio.emit("train_paused", {"paused": True})

@socketio.on("train_resume")
def on_train_resume(_=None):
    global training_paused
    training_paused = False
    if training_source: training_source.resume()
    socketio.emit("train_log",   {"text": "▶ Resumed."})
    socketio.emit("train_paused", {"paused": False})

@socketio.on("train_stop")
def on_train_stop(_=None):
    global training_running, training_paused, training_source
    training_running = False; training_paused = False
    if training_source:
        training_source.stop(); training_source = None
    socketio.emit("train_log",  {"text": "Training stopped."})
    socketio.emit("train_done", {"filename": None, "count": 0})


if __name__ == "__main__":
    print("[server] starting on http://localhost:5050")
    socketio.run(app, host="0.0.0.0", port=5050, debug=False, allow_unsafe_werkzeug=True)