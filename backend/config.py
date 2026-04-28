"""
Shared constants and configuration for the EMG Gesture Classifier backend.
"""

import os

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAT_PATH     = os.path.join(BASE_DIR, "KateGesturesRound2Jan20.mat")
MODEL_PATH   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kate_model_jan20_1.pkl")
TRAINING_DIR = os.path.join(BASE_DIR, "training_data")
MODELS_DIR   = os.path.join(BASE_DIR, "models")
DB_PATH      = os.path.join(BASE_DIR, "emg.db")

PLAYBACK_SPEED = 1.0

# ── Gesture catalogue ────────────────────────────────────────────────────────
GESTURE_CLASSES = {
    0: "Open", 1: "Close", 2: "Thumbs Up", 3: "Peace",
    4: "Index Point", 5: "Four", 6: "Okay", 7: "Spiderman",
}

GESTURE_COLORS = {
    "Open": "#00e5ff", "Close": "#ff4081", "Thumbs Up": "#69ff47",
    "Peace": "#ffd740", "Index Point": "#e040fb", "Four": "#ff6d00",
    "Okay": "#00e676", "Spiderman": "#ff1744",
}

# Progression order for unlocking gestures (first two start unlocked)
UNLOCK_ORDER = [
    "Open", "Close", "Thumbs Up", "Peace",
    "Index Point", "Four", "Okay", "Spiderman",
]
AUTO_UNLOCK_ACCURACY  = 70   # avg accuracy on unlocked gestures to unlock next
AUTO_UNLOCK_MIN_TESTS = 5    # minimum test trials per unlocked gesture

# ── Signal processing parameters ─────────────────────────────────────────────
F_LOWER, F_UPPER = 20, 450
F_NOTCH, BW_NOTCH = 60, 2

# ── Detection thresholds (relative to rest baseline) ─────────────────────────
T_ON   = 40
T_OFF  = 25
REST_CALIB_S = 2.0

N_ON            = 1
N_OFF           = 1
DET_WIN_MS      = 200
DET_STEP_MS     = 100
WIN_MS          = 200
MAX_GESTURE_S   = 3.5
MIN_VOTES       = 12

# ── Training collector timing ────────────────────────────────────────────────
GESTURE_S        = 3.0
REST_S           = 3.0
INITIAL_REST_S   = 6.0
REPS_PER_GESTURE = 5

# ── Sessantaquattro+ command parameters ──────────────────────────────────────
S64_FSAMP = 2   # → 2000 Hz
S64_NCH   = 3   # → 72 total channels
S64_MODE  = 0
S64_HRES  = 0
S64_HPF   = 1
S64_EXTEN = 0
S64_TRIG  = 0
S64_REC   = 0
S64_GO    = 1

DEVICE_WEB_UI = "http://192.168.1.1"
