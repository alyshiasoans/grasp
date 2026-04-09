"""
Signal processing helpers for real-time EMG classification.
"""

import numpy as np


def feats(w, thr=0.01):
    """Extract Hudgins features (MAV, WL, ZC, SSC) from a (channels × samples) window."""
    ch, _ = w.shape
    MAV = np.mean(np.abs(w), axis=1)
    WL  = np.sum(np.abs(np.diff(w, axis=1)), axis=1)
    ZC  = np.zeros(ch)
    SSC = np.zeros(ch)
    for i in range(ch):
        x = w[i]
        s = np.diff(x)
        ZC[i]  = np.sum(((x[:-1] * x[1:]) < 0) & (np.abs(x[:-1] - x[1:]) >= thr))
        SSC[i] = np.sum(((s[:-1] * s[1:]) < 0) & (np.abs(s[:-1]) >= thr) & (np.abs(s[1:]) >= thr))
    return np.concatenate([MAV, WL, ZC, SSC])
