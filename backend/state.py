"""
Mutable shared state for the EMG backend.

Centralises all global variables that are read/written by multiple modules
(socket handlers, workers, routes) so there is one authoritative location.
"""

from config import T_ON, T_OFF, MIN_VOTES

# ── Worker (predict) state ────────────────────────────────────────────────────
worker_thread   = None
worker_running  = False
active_source   = None

# ── Training collector state ──────────────────────────────────────────────────
training_thread  = None
training_running = False
training_paused  = False
training_source  = None

# ── Testing signal buffer (saves raw EMG during live test sessions) ───────────
test_sample_buffer     = []
test_gesture_intervals = []
test_session_user_id   = None
test_session_id        = None
test_sample_counter    = 0

# ── Runtime-tunable config (updated via socket from Predict page) ─────────────
runtime_config = {
    "t_on":       T_ON,
    "t_off":      T_OFF,
    "min_votes":  MIN_VOTES,
    "model_path": None,   # None = use default resolution; string = override path
}
