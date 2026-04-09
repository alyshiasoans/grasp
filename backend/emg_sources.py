"""
EMG data-source abstraction.

Two sources:
  • SimulatedSource  – replays a .mat file in real time
  • LiveSource       – streams from Sessantaquattro+ via WiFi TCP

Both expose a stream() iterator that yields one sample (1-D numpy array)
at a time at the correct sampling rate, plus stop()/pause()/resume().
"""

import os
import socket
import struct
import time
import glob
import random
import numpy as np
from scipy.io import loadmat

from config import (
    S64_FSAMP, S64_NCH, S64_MODE, S64_HRES, S64_HPF, S64_EXTEN,
    S64_TRIG, S64_REC, S64_GO, TRAINING_DIR,
)


# ── Sessantaquattro+ helpers ──────────────────────────────────────────────────

def s64_make_command(fsamp=S64_FSAMP, nch=S64_NCH, mode=S64_MODE,
                     hres=S64_HRES, hpf=S64_HPF, exten=S64_EXTEN,
                     trig=S64_TRIG, rec=S64_REC, go=S64_GO):
    return (go | (rec << 1) | (trig << 2) | (exten << 4) |
            (hpf << 6) | (hres << 7) | (mode << 8) | (nch << 11) | (fsamp << 13))


def s64_num_channels(nch=S64_NCH, mode=S64_MODE):
    tbl = {0: (16, 12), 1: (24, 16), 2: (40, 24), 3: (72, 40)}
    standard, hp = tbl.get(nch, (72, 40))
    return hp if mode == 1 else standard


def s64_sampling_freq(fsamp=S64_FSAMP, mode=S64_MODE):
    if mode == 3:
        return {0: 2000, 1: 4000, 2: 8000, 3: 16000}.get(fsamp, 2000)
    return {0: 500, 1: 1000, 2: 2000, 3: 4000}.get(fsamp, 2000)


def recvall(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


# ── Simulated source ──────────────────────────────────────────────────────────

def _find_training_npz(user=None):
    """Return list of continuous-format .npz training files.

    Prefers the given user's folder; falls back to all training data.
    """
    def _scan(pattern):
        results = []
        for path in glob.glob(pattern, recursive=True):
            try:
                d = np.load(path, allow_pickle=True)
                if "Data" in d and "SamplingFrequency" in d:
                    # Skip files with tiny values (saved from filtered/normalized data)
                    sig = np.array(d["Data"], dtype=float)
                    if np.mean(np.abs(sig[:min(2000, len(sig))])) < 1.0:
                        continue
                    results.append(path)
            except Exception:
                pass
        return results

    # Try user-specific folder first
    if user:
        user_files = _scan(os.path.join(TRAINING_DIR, user, "training_*.npz"))
        if user_files:
            return user_files

    # Fallback: all training data everywhere
    all_files = _scan(os.path.join(TRAINING_DIR, "**", "training_*.npz"))
    return all_files


def _load_npz_data(path):
    """Load a continuous .npz file → (sig, Fs)."""
    d = np.load(path, allow_pickle=True)
    sig = np.array(d["Data"], dtype=float)
    if sig.shape[1] > 64:
        sig = sig[:, :64]
    Fs = float(np.squeeze(d["SamplingFrequency"]))
    return sig, Fs


class SimulatedSource:
    """
    Replays EMG data for simulation.

    Scans training_data/ for continuous .npz files and plays them in random
    order, looping indefinitely.  Falls back to a .mat file if no .npz are
    available.
    """

    def __init__(self, mat_path, speed=1.0, user=None):
        self.speed = speed
        self.n_channels = 64
        self._stop = False
        self._user = user

        # Discover .npz training files
        self._npz_files = _find_training_npz(user)

        if self._npz_files:
            # Peek at first file for Fs
            _, self.Fs = _load_npz_data(self._npz_files[0])
            self.sig = None  # loaded lazily per-file
            self._source_label = f"{len(self._npz_files)} training files"
        else:
            # Fallback: original .mat
            m = loadmat(mat_path)
            self.sig = np.array(m['Data'], dtype=float)[:, :64]
            self.Fs = float(np.squeeze(m['SamplingFrequency']))
            self._npz_files = []
            self._source_label = os.path.basename(mat_path)

    def stream(self):
        dt = 1.0 / (self.Fs * self.speed)

        if not self._npz_files:
            # Fallback: replay .mat once
            for row in self.sig:
                if self._stop:
                    return
                t0 = time.perf_counter()
                yield row
                rem = dt - (time.perf_counter() - t0)
                if rem > 0:
                    time.sleep(rem)
            return

        # Shuffle and loop .npz files indefinitely
        files = list(self._npz_files)
        while not self._stop:
            random.shuffle(files)
            for path in files:
                if self._stop:
                    return
                try:
                    sig, Fs = _load_npz_data(path)
                except Exception:
                    continue
                dt = 1.0 / (Fs * self.speed)
                for row in sig:
                    if self._stop:
                        return
                    t0 = time.perf_counter()
                    yield row
                    rem = dt - (time.perf_counter() - t0)
                    if rem > 0:
                        time.sleep(rem)

    def stop(self):
        self._stop = True

    def pause(self):
        pass

    def resume(self):
        pass


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
        self.on_log(f"[live] {self.n_channels} ch @ {self.Fs:.0f} Hz  cmd={format(cmd, '016b')}")

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
                unpacked = struct.unpack(f'>{len(data) // 2}h', data)
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
            if self._client_sock:
                self._client_sock.close()
        except Exception:
            pass
        try:
            if self._server_sock:
                self._server_sock.close()
        except Exception:
            pass

    def pause(self):
        pass

    def resume(self):
        pass
