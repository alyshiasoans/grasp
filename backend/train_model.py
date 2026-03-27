"""
LDA model training module.

Pulls gesture orders from the database and trains an LDA model
from selected .mat training files.

The signal processing logic is adapted from LDA_RealTime_PreProcessing.
"""

import os
import json
import numpy as np
from scipy.signal import butter, filtfilt, iirnotch
from scipy.io import loadmat
from sklearn.preprocessing import StandardScaler
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
import joblib
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Gesture class mapping ────────────────────────────────────────────────────
# The LDA model uses integer labels; these are the canonical class indices.
GESTURE_CLASSES = {
    "Open": 0, "Close": 1, "Thumbs Up": 2, "Peace": 3,
    "Index Point": 4, "Four": 5, "Okay": 6, "Spiderman": 7,
}


def process_mat(mat_path, gesture_order):
    """
    Process a .mat file: filter, detect gestures, extract Hudgins features.

    Parameters
    ----------
    mat_path : str
        Absolute path to the .mat file.
    gesture_order : list[str]
        Ordered list of gesture names (DB canonical names) for this session.

    Returns
    -------
    X_feat : ndarray (n_windows, 256)
        Hudgins features (MAV, WL, ZC, SSC × 64 channels).
    y : ndarray (n_windows,)
        Integer labels.
    gesture_interval_ids : ndarray (n_windows,)
        Which gesture interval each window belongs to.
    """
    m = loadmat(mat_path)
    Data = np.array(m["Data"], dtype=float)
    Fs = float(np.squeeze(m["SamplingFrequency"]))

    # Filtering
    f_lower, f_upper, f_notch, BW_notch = 20, 450, 60, 2

    sig = Data[:, :64].T  # channels × samples
    sig_dm = sig - np.mean(sig, axis=1, keepdims=True)

    b_bp, a_bp = butter(2, [f_lower / (Fs / 2), f_upper / (Fs / 2)], btype="band")
    sig_bp = filtfilt(b_bp, a_bp, sig_dm, axis=1)

    wo = f_notch / (Fs / 2)
    Q = f_notch / BW_notch
    b_n, a_n = iirnotch(wo, Q)
    sig_filt = filtfilt(b_n, a_n, sig_bp, axis=1)

    # Gesture detection
    det_win_ms, det_step_ms = 200, 100
    det_win = int(det_win_ms / 1000 * Fs)
    det_step = int(det_step_ms / 1000 * Fs)

    n_samples = sig_filt.shape[1]
    det_starts = np.arange(0, n_samples - det_win + 1, det_step)

    rms_windows = np.zeros((len(det_starts), sig_filt.shape[0]))
    for i, st in enumerate(det_starts):
        w = sig_filt[:, st : st + det_win]
        rms_windows[i] = np.sqrt(np.mean(w**2, axis=1))

    global_rms = np.median(rms_windows, axis=1)
    rest_idx = global_rms < np.percentile(global_rms, 20)
    rest_mean = np.mean(rms_windows[rest_idx], axis=0) + 1e-8
    rms_norm = rms_windows / rest_mean
    activation = np.median(rms_norm, axis=1)

    T_on, T_off = 2.4, 1.6
    N_on = int(0.10 / (det_step_ms / 1000))
    N_off = int(0.10 / (det_step_ms / 1000))

    state = cnt_on = cnt_off = 0
    gesture_mask = np.zeros(len(activation), dtype=int)
    detected_intervals = []
    start_idx = None

    for i, a in enumerate(activation):
        if state == 0:
            if a > T_on:
                cnt_on += 1
                if cnt_on >= N_on:
                    state = 1
                    start_idx = i
                    cnt_on = 0
            else:
                cnt_on = 0
        elif state == 1:
            gesture_mask[i] = 1
            if a < T_off:
                cnt_off += 1
                if cnt_off >= N_off:
                    detected_intervals.append((start_idx, i))
                    state = 0
                    cnt_off = 0
            else:
                cnt_off = 0

    # Filter short rests
    min_rest_time_s = 0.5
    gesture_mask_with_rest = np.copy(gesture_mask)
    i = 0
    while i < len(gesture_mask_with_rest):
        if gesture_mask_with_rest[i] == 0:
            start_rest = i
            while i < len(gesture_mask_with_rest) and gesture_mask_with_rest[i] == 0:
                i += 1
            rest_duration = (i - start_rest) * (det_step_ms / 1000)
            if rest_duration < min_rest_time_s:
                gesture_mask_with_rest[start_rest:i] = 1
        else:
            i += 1

    # Recalculate intervals
    detected_intervals = []
    state = 0
    start_idx = None
    for i, a in enumerate(gesture_mask_with_rest):
        if state == 0:
            if a == 1:
                state = 1
                start_idx = i
        else:
            if a == 0:
                detected_intervals.append((start_idx, i))
                state = 0
                start_idx = None
    if state == 1:
        detected_intervals.append((start_idx, len(gesture_mask_with_rest) - 1))

    detected_intervals_samples = [
        (det_starts[s], det_starts[e] + det_win) for (s, e) in detected_intervals
    ]

    min_gesture_time_s = 2.0
    detected_intervals_samples = [
        (s, e) for s, e in detected_intervals_samples if (e - s) / Fs >= min_gesture_time_s
    ]

    labels = np.array([GESTURE_CLASSES[g] for g in gesture_order])

    from collections import defaultdict

    counter = defaultdict(int)
    repetitions = []
    for g in gesture_order:
        counter[g] += 1
        repetitions.append(counter[g])
    repetitions = np.array(repetitions)

    # Sliding windows + Hudgins features
    win_ms, step_ms = 200, 100
    win_samples = int(round(win_ms / 1000 * Fs))
    step_samples = int(round(step_ms / 1000 * Fs))

    X_windows, y_windows, rep_windows, gesture_interval_ids = [], [], [], []

    for gi, (s, e) in enumerate(detected_intervals_samples):
        if gi >= len(labels):
            break
        lbl = labels[gi]
        repnum = repetitions[gi]
        seg = sig_filt[:, s:e]
        if seg.shape[1] < win_samples:
            continue
        starts = np.arange(0, seg.shape[1] - win_samples + 1, step_samples)
        for st in starts:
            w = seg[:, st : st + win_samples]
            X_windows.append(w)
            y_windows.append(lbl)
            rep_windows.append(repnum)
            gesture_interval_ids.append(gi)

    X_windows = np.array(X_windows)
    y_windows = np.array(y_windows)
    gesture_interval_ids = np.array(gesture_interval_ids)

    def hudgins_features(window, threshold=0.01):
        ch, N = window.shape
        MAV = np.mean(np.abs(window), axis=1)
        WL = np.sum(np.abs(np.diff(window, axis=1)), axis=1)
        ZC = np.zeros(ch)
        SSC = np.zeros(ch)
        for i in range(ch):
            x = window[i]
            ZC[i] = np.sum(
                ((x[:-1] * x[1:]) < 0) & (np.abs(x[:-1] - x[1:]) >= threshold)
            )
            s1 = np.diff(x)
            SSC[i] = np.sum(
                ((s1[:-1] * s1[1:]) < 0)
                & (np.abs(s1[:-1]) >= threshold)
                & (np.abs(s1[1:]) >= threshold)
            )
        return np.concatenate([MAV, WL, ZC, SSC], axis=0)

    X_feat = np.array([hudgins_features(w) for w in X_windows])
    return X_feat, y_windows, gesture_interval_ids


def train_model(training_file_rows, user, on_log=None):
    """
    Train an LDA model from a list of training file DB rows.

    Parameters
    ----------
    training_file_rows : list[dict]
        Each dict has: id, file_path, gestures (JSON ordered list), session_id
    user : dict
        Dict with: id, username
    on_log : callable, optional
        Called with (str) log messages.

    Returns
    -------
    dict with keys: model_path, version_number, accuracy, n_samples
    """
    log = on_log or (lambda msg: None)

    X_all, y_all = [], []

    for tf in training_file_rows:
        file_path = os.path.join(BASE_DIR, tf["file_path"])
        if not os.path.exists(file_path):
            log(f"⚠ File not found: {tf['file_path']}")
            continue

        gesture_order = tf["gestures"]
        if not gesture_order:
            log(f"⚠ No gesture order for {tf['file_name']}, skipping")
            continue

        log(f"Processing {tf['file_name']} ({len(gesture_order)} gestures)...")

        if file_path.endswith(".mat"):
            X, y, _ = process_mat(file_path, gesture_order)
        else:
            log(f"⚠ Unsupported file type: {tf['file_name']}, skipping")
            continue

        X_all.append(X)
        y_all.append(y)
        log(f"  → {X.shape[0]} feature windows extracted")

    if not X_all:
        raise ValueError("No data could be processed from the selected files")

    X_all = np.vstack(X_all)
    y_all = np.concatenate(y_all)
    log(f"Total: {X_all.shape[0]} windows, {len(np.unique(y_all))} classes")

    scaler = StandardScaler()
    X_all = scaler.fit_transform(X_all)

    lda = LinearDiscriminantAnalysis(solver="svd")
    lda.fit(X_all, y_all)

    # Compute training accuracy
    train_acc = round(lda.score(X_all, y_all) * 100, 1)
    log(f"Training accuracy: {train_acc}%")

    # Save model
    models_dir = os.path.join(BASE_DIR, "models")
    os.makedirs(models_dir, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    model_filename = f"{user['username']}_{ts}.pkl"
    model_path = os.path.join(models_dir, model_filename)
    joblib.dump((scaler, lda), model_path)
    log(f"Saved model → {model_filename}")

    return {
        "model_path": os.path.relpath(model_path, BASE_DIR),
        "model_filename": model_filename,
        "accuracy": train_acc,
        "n_samples": int(X_all.shape[0]),
    }
