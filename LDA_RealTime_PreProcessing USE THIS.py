import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import butter, filtfilt, iirnotch
from scipy.io import loadmat
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.preprocessing import StandardScaler
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
import time

gesture_classes = {
    "Open":0, "Close":1, "Thumbs up":2, "Peace":3,
    "Index point":4, "A four":5, "An ok":6, "Spiderman":7
}

def process(mat_path, gesture_order):
    m = loadmat(mat_path)
    Data = np.array(m['Data'], dtype=float)
    Fs = float(np.squeeze(m['SamplingFrequency']))
    #  Filtering
    f_lower = 20
    f_upper = 450
    f_notch = 60
    BW_notch = 2

    sig = Data[:, :64].T  # channels x samples

    # De-mean
    sig_dm = sig - np.mean(sig, axis=1, keepdims=True)

    # Bandpass
    b_bp, a_bp = butter(2, [f_lower/(Fs/2), f_upper/(Fs/2)], btype='band')
    sig_bp = filtfilt(b_bp, a_bp, sig_dm, axis=1)

    # Notch
    wo = f_notch/(Fs/2)
    Q = f_notch/BW_notch
    b_n, a_n = iirnotch(wo, Q)
    sig_filt = filtfilt(b_n, a_n, sig_bp, axis=1)

    ## Gesture Detection
    det_win_ms  = 200
    det_step_ms = 100

    det_win = int(det_win_ms/1000 * Fs)
    det_step = int(det_step_ms/1000 * Fs)

    n_samples = sig_filt.shape[1]
    det_starts = np.arange(0, n_samples-det_win+1, det_step)

    # RMS per channel per detection window
    rms_windows = np.zeros((len(det_starts), sig_filt.shape[0]))

    for i, st in enumerate(det_starts):
        w = sig_filt[:, st:st+det_win]
        rms_windows[i] = np.sqrt(np.mean(w**2, axis=1))

    # Estimate rest baseline from lowest-energy windows
    global_rms = np.median(rms_windows, axis=1)

    rest_idx = global_rms < np.percentile(global_rms, 20)
    rest_mean = np.mean(rms_windows[rest_idx], axis=0) + 1e-8

    rms_norm = rms_windows / rest_mean

    activation = np.median(rms_norm, axis=1)
    time_det = det_starts / Fs

    # thresholds. these will be adjusted depending on participant signal strength
    T_on  = 2.4
    T_off = 1.6

    N_on  = int(0.10 / (det_step_ms/1000))   # 100 ms
    N_off = int(0.10 / (det_step_ms/1000))   # 100 ms used to be 0.25 (250ms) instead

    state = 0  # 0 = IDLE, 1 = ACTIVE
    cnt_on = 0
    cnt_off = 0

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
                    end_idx = i
                    detected_intervals.append((start_idx, end_idx))
                    state = 0
                    cnt_off = 0
            else:
                cnt_off = 0

    # setting minimum duration in seconds for a gesture so random spikes don't count as gesture, same for rest period so random dips don't count as a rest
    min_gesture_time_s = 2.0 #can also use 2
    filtered_intervals_samples = []
    min_rest_time_s = 0.5  
    gesture_mask_with_rest = np.copy(gesture_mask)  # 1=gesture, 0=rest

    # Loop through the activation mask to remove rest periods that are "too short" between gestures
    i = 0
    while i < len(gesture_mask_with_rest):
        if gesture_mask_with_rest[i] == 0:
            # start of a rest segment
            start_rest = i
            while i < len(gesture_mask_with_rest) and gesture_mask_with_rest[i] == 0:
                i += 1
            end_rest = i
            rest_duration = (end_rest - start_rest) * (det_step_ms / 1000)
            if rest_duration < min_rest_time_s:
                # too short → merge into gesture (set to 1)
                gesture_mask_with_rest[start_rest:end_rest] = 1
        else:
            i += 1

    # Recalculate detected intervals after filtering short rests
    detected_intervals = []
    state = 0
    start_idx = None
    for i, a in enumerate(gesture_mask_with_rest):
        if state == 0:
            if a == 1:
                state = 1
                start_idx = i
        else:  # state == 1
            if a == 0:
                end_idx = i
                detected_intervals.append((start_idx, end_idx))
                state = 0
                start_idx = None
    if state == 1:
        detected_intervals.append((start_idx, len(gesture_mask_with_rest)-1))

    # Convert back to sample indices
    detected_intervals_samples = [
        (det_starts[s], det_starts[e] + det_win)
        for (s, e) in detected_intervals
    ]

    for s, e in detected_intervals_samples:
        duration = (e - s) / Fs
        if duration >= min_gesture_time_s:
            filtered_intervals_samples.append((s, e))

    detected_intervals_samples = filtered_intervals_samples

    labels = np.array([gesture_classes[g] for g in gesture_order])

    # repetition numbers 1–5 for each gesture occurrence
    from collections import defaultdict
    counter = defaultdict(int)
    repetitions = []
    for g in gesture_order:
        counter[g] += 1
        repetitions.append(counter[g])
    repetitions = np.array(repetitions)

    # Sliding windows
    win_ms = 200
    step_ms = 100
    win_samples = int(round(win_ms/1000 * Fs))
    step_samples = int(round(step_ms/1000 * Fs))

    X_windows = []
    y_windows = []
    rep_windows = []

    gesture_interval_ids = [] #new

    for gi, (s,e) in enumerate(detected_intervals_samples):
        lbl = labels[gi]
        repnum = repetitions[gi]
        seg = sig_filt[:, s:e]

        if seg.shape[1] < win_samples:
            continue

        starts = np.arange(0, seg.shape[1] - win_samples + 1, step_samples)
        for st in starts:
            w = seg[:, st:st+win_samples]  # (64, win_samples)
            X_windows.append(w)
            y_windows.append(lbl)
            rep_windows.append(repnum)
            gesture_interval_ids.append(gi) #new 

    gesture_interval_ids = np.array(gesture_interval_ids) #new

    X_windows = np.array(X_windows)
    y_windows = np.array(y_windows)
    rep_windows = np.array(rep_windows)

    # Hudgins feature extraction
    # MAV, WL, ZC, SSC
    def hudgins_features(window, threshold=0.01):
        ch, N = window.shape

        MAV = np.mean(np.abs(window), axis=1)
        WL = np.sum(np.abs(np.diff(window, axis=1)), axis=1)

        ZC = np.zeros(ch)
        SSC = np.zeros(ch)

        for i in range(ch):
            x = window[i]
            # Zero Crossings
            ZC[i] = np.sum(((x[:-1] * x[1:]) < 0) &
                        (np.abs(x[:-1]-x[1:]) >= threshold))

            # Slope Sign Changes
            s1 = np.diff(x)
            SSC[i] = np.sum(((s1[:-1] * s1[1:]) < 0) &
                            (np.abs(s1[:-1]) >= threshold) &
                            (np.abs(s1[1:]) >= threshold))

        return np.concatenate([MAV, WL, ZC, SSC], axis=0)

    X_feat = np.array([hudgins_features(w) for w in X_windows])
    y = y_windows

    return X_feat, y, gesture_interval_ids


# personalized model

#maline dataset 1
# gesture_order1 = ["Thumbs up", "Close", "Close", "Peace", "An ok", "Thumbs up", "A four", "Peace", 
#                  "Close", "Spiderman", "Peace", "Index point", "Spiderman", "Thumbs up", "Spiderman", 
#                  "Spiderman", "Thumbs up", "Close", "A four", "Index point", "Peace", "Thumbs up", "A four", 
#                  "Index point", "An ok", "Index point", "Close", "Peace", "A four", "An ok", "Open", "Open", 
#                  "An ok", "Open", "A four", "Spiderman", "Open", "Open", "An ok", "Index point"]

# maline dataset 2
# gesture_order2 = ["A four", "Spiderman", "Open", "Index point", "Peace", "Index point", 
#                  "Spiderman", "A four", "A four", "An ok", "Thumbs up", "Spiderman", "Peace", "Spiderman", 
#                  "Close", "Close", "Thumbs up", "An ok", "Close", "Thumbs up", "A four", "A four", "An ok", "Thumbs up", 
#                  "Index point", "Peace", "Peace", "Open", "Index point", "Thumbs up", "Open", "Close", "Spiderman", 
#                  "Open", "Open", "Peace", "Index point", "An ok", "Close", "An ok"]

#maline dataset 3
# gesture_order3 = ["A four", "Spiderman", "A four", "Thumbs up", "Close", "Close", "Thumbs up", "Peace", 
#                  "A four", "Thumbs up", "Index point", "Index point", "Thumbs up", "Open", "A four", "An ok", 
#                  "Spiderman", "Open", "Open", "Close", "Spiderman", "Index point", "Spiderman", "Open", "Thumbs up", 
#                  "Peace", "An ok", "Spiderman", "Close", "Index point", "An ok", "Index point", "Close", "An ok", "An ok", 
#                  "Peace", "Peace", "Peace", "A four", "Open"]

# # kate dataset 1
# gesture_order1 = ["Close", "Close", "Spiderman", "Index point", "A four", "Index point", 
#                  "Thumbs up", "Close", "An ok", "Index point", "Open", "A four", "An ok", "A four", 
#                  "Index point", "Spiderman", "Peace", "Thumbs up", "A four", "Close", "Peace", "Thumbs up", 
#                  "Close", "Peace", "Spiderman", "Thumbs up", "An ok", "Open", "Peace", "Index point", "An ok", 
#                  "Spiderman", "Open", "Peace", "Spiderman", "An ok", "Open", "Open", "Thumbs up", "A four"]

#kate mar 10 round 1
# gesture_order1 = ["Spiderman", "Open", "Peace", "Thumbs up", "Spiderman", "Open", "Close", "Thumbs up", "Spiderman", "Open", "An ok", "Index point", "Thumbs up", 
#                  "Open", "Close", "Spiderman", "An ok", "Index point", "An ok", "A four", "Thumbs up", "Close", "Index point", "A four", "An ok", "Peace", 
#                  "Index point", "Spiderman", "Close", "Peace", "Open", "Index point", "Thumbs up", "Peace", "An ok", "A four", "A four", "A four", "Close", 
#                  "Peace"]

# kate mar 10 round 2
# gesture_order2 = ["Open", "An ok", "Open", "A four", "Close", "Peace", "Thumbs up", "A four", "A four", "Spiderman", "Open", "Peace", "Index point", "An ok", 
#                  "Open", "Thumbs up", "Open", "Close", "Peace", "An ok", "Spiderman", "Peace", "Index point", "Peace", "Close", "Close", "Index point", 
#                  "Thumbs up", "Thumbs up", "Index point", "Close", "Spiderman", "Thumbs up", "Index point", "Spiderman", "A four", "An ok", "Spiderman", 
#                  "A four", "An ok"]

#kate mar 12 round 1
# gesture_order1 = ["Thumbs up", "Index point", "Peace", "Thumbs up", "Peace", "Spiderman", "Peace", "An ok", "Spiderman", "Index point", "Close", "A four", 
#                   "Peace", "Index point", "A four", "Close", "An ok", "Close", "Peace", "An ok", "A four", "Thumbs up", "An ok", "Open", "Close", "Spiderman", 
#                   "A four", "Open", "Close", "A four", "Open", "Thumbs up", "Thumbs up", "Index point", "Open", "Index point", "Spiderman", "Spiderman", "An ok", 
#                   "Open"]

# # kate mar 12 round 2
# gesture_order2 = ["Thumbs up", "Index point", "Spiderman", "Peace", "Spiderman", "Open", "Index point", "Close", "Index point", "Peace", "Thumbs up", "A four", 
#                   "Close", "A four", "An ok", "Spiderman", "Open", "An ok", "An ok", "Close", "Index point", "Open", "Spiderman", "A four", "Open", "Spiderman", 
#                   "Open", "Close", "An ok", "Peace", "A four", "Index point", "Thumbs up", "Thumbs up", "Close", "Peace", "A four", "Peace", "An ok", "Thumbs up"]

# #kate dataset 2
# gesture_order2 = ["An ok", "Open", "Peace", "Peace", "Thumbs up", "Spiderman", "Spiderman", "Thumbs up", "Open", 
#                  "Thumbs up", "Open", "Open", "Close", "Index point", "A four", "Thumbs up", "A four", "Index point",
#                  "An ok", "Open", "Index point", "Index point", "A four", "An ok", "Close", "Spiderman", "An ok", "A four", 
#                  "Thumbs up", "Peace", "A four", "Spiderman", "Peace", "Close", "Close", "Peace", "Index point", "An ok", "Spiderman", "Close"]

#kate mar 26 dataset 1
# gesture_order1 = ["Peace", "Thumbs up", "A four", "A four", "Spiderman", "Thumbs up", "Index point", "Peace", "Index point",
#              "Open", "An ok", "Peace", "Index point", "A four", "Index point", "Peace", "Close", "Spiderman", "Close",
#                "Close", "An ok", "An ok", "Open", "An ok", "Thumbs up", "Spiderman", "Open", "Thumbs up", "A four",
#                  "Close", "Thumbs up", "Open", "Open", "Spiderman", "Spiderman", "Close", "A four", "Peace", "An ok",
#                    "Index point"]

# #kate mar 26 round 2
# gesture_order2 = ["Close", "Open", "Spiderman", "A four", "An ok", "Thumbs up", "Open", "A four", "Index point", 
#                  "A four", "Peace", "Index point", "Open", "An ok", "Close", "Peace", "Spiderman", "Thumbs up", 
#                  "Open", "Spiderman", "Close", "Spiderman", "Open", "Index point", "An ok", "Thumbs up", "Peace", 
#                  "Peace", "A four", "Thumbs up", "Index point", "Peace", "An ok", "Close", "Close", "A four", 
#                  "Thumbs up", "Spiderman", "Index point", "An ok"]

# maline mar 26 round 1
gesture_order1 = ["An ok", "A four", "Close", "Open", "Spiderman", "Thumbs up", "Index point", "Open", "Spiderman", 
                 "Thumbs up", "Open", "Peace", "Thumbs up", "Thumbs up", "Thumbs up", "An ok", "An ok", "Spiderman", 
                 "Peace", "Index point", "Open", "Close", "Close", "Index point", "Close", "Index point", "Peace", "A four", 
                 "Index point", "Open", "Peace", "An ok", "A four", "Spiderman", "Spiderman", "A four", "Close", "Peace", "A four", 
                 "An ok"]

# maline mar 26 round 2
gesture_order2 = ["Spiderman", "Spiderman", "Thumbs up", "Thumbs up", "Close", "Spiderman", "Thumbs up", "Index point", 
                 "Index point", "A four", "A four", "An ok", "A four", "A four", "Peace", "An ok", "Peace", "A four", "Peace", 
                 "Index point", "An ok", "Thumbs up", "Thumbs up", "Peace", "Index point", "Close", "An ok", "Open", "Open", "Close", 
                 "Peace", "Open", "Open", "Spiderman", "Spiderman", "Close", "Close", "Index point", "Open", "An ok"]

#maline mar 26 round 3
gesture_order3 = ["Thumbs up", "Peace", "An ok", "An ok", "An ok", "Peace", "A four", "Peace", "An ok", "An ok", "Spiderman", 
                 "Thumbs up", "A four", "Spiderman", "Open", "Open", "Open", "Close", "A four", "Spiderman", "Close", "Peace", 
                 "Open", "Peace", "A four", "Spiderman", "Index point", "Thumbs up", "Close", "Spiderman", "Close", "Close", "Index point", 
                 "Index point", "Index point", "Index point", "Thumbs up", "Open", "Thumbs up", "A four"]

import joblib

def train_user_model(mat_paths, gesture_orders, model_name):
    X_all, y_all = [], []

    for path, order in zip(mat_paths, gesture_orders):
        X, y, _ = process(path, order)
        X_all.append(X)
        y_all.append(y)

    X_all = np.vstack(X_all)
    y_all = np.concatenate(y_all)

    scaler = StandardScaler()
    X_all = scaler.fit_transform(X_all)

    lda = LinearDiscriminantAnalysis(solver='svd')
    lda.fit(X_all, y_all)

    joblib.dump((scaler, lda), model_name)
    print(f"Saved model → {model_name}")

train_user_model(
    mat_paths=[
        "MalineMar26Round1.mat",
        "MalineMar26Round2.mat",
        "MalineMar26Round3.mat"
    ],
    gesture_orders=[
        gesture_order1,
        gesture_order2,
        gesture_order3
    ],
    model_name="maline_mar26_multi.pkl"
)

# train_user_model(
#     mat_paths=[
#         "KateMar26Round1.mat",
#         "KateMar26Round2.mat",
#     ],
#     gesture_orders=[
#         gesture_order1,
#         gesture_order2,
#     ],
#     model_name="kate_model_mar26_multi.pkl"
# )

# train_user_model(
#     mat_paths=[
#         "KateMar26Round1.mat"
#     ],
#     gesture_orders=[
#         gesture_order1,
#     ],
#     model_name="kate_model_mar26_1.pkl"
# )


