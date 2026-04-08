"""
EMG data-source abstraction.

Two sources:
  • SimulatedSource  – replays a .mat file in real time (existing behaviour)
  • LiveSource       – streams from Quattrocento via direct TCP (OTB protocol)

Both expose an iterator that yields one sample (1×n_channels numpy array) at a
time, at the correct sampling rate.
"""

import socket
import time
import numpy as np
from scipy.io import loadmat


# ─────────────────────────────────────────────────────────────────────────────
# Simulated (mat-file playback)
# ─────────────────────────────────────────────────────────────────────────────
class SimulatedSource:
    """Replay a .mat file sample-by-sample at real-time speed."""

    def __init__(self, mat_path, playback_speed=1.0):
        m = loadmat(mat_path)
        self.sig = np.array(m["Data"], dtype=float)[:, :64]
        self.Fs = float(np.squeeze(m["SamplingFrequency"]))
        self.n_channels = self.sig.shape[1]
        self.playback_speed = playback_speed
        self._stop = False
        self._paused = False

    def stop(self):
        self._stop = True

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def stream(self):
        """Yield (sample_array,) one at a time at real-time pace.

        Uses batched sleep + spin-wait to beat Windows ~15 ms timer
        resolution while keeping CPU usage low.
        """
        speed = self.playback_speed
        BATCH = max(1, int(self.Fs * 0.016))  # ~16 ms of samples per batch
        t_start = time.perf_counter()

        for i, row in enumerate(self.sig):
            if self._stop:
                break
            while self._paused and not self._stop:
                time.sleep(0.05)
                t_start = time.perf_counter() - i / (self.Fs * speed)
            if self._stop:
                break
            yield row

            # Pace at batch boundaries
            if (i + 1) % BATCH == 0:
                target = t_start + (i + 1) / (self.Fs * speed)
                rem = target - time.perf_counter()
                if rem > 0.002:
                    time.sleep(rem - 0.001)   # coarse sleep, leave 1ms margin
                # Spin-wait the remainder for precise timing
                while time.perf_counter() < target:
                    pass

    @property
    def rest_data(self):
        """First 2 seconds of data for rest-level calibration."""
        n = int(self.Fs * 2)
        return self.sig[:n, :]


# ─────────────────────────────────────────────────────────────────────────────
# Live – Sessantaquattro+ via WiFi TCP
# ─────────────────────────────────────────────────────────────────────────────
# The Sessantaquattro+ connects to YOUR computer (your app is the server).
# 1. Connect your PC to the Sessantaquattro+ WiFi network
# 2. Start the app — it listens on 0.0.0.0:45454
# 3. The device connects and you send a 2-byte config command
# 4. Device streams big-endian int16 data

DEFAULT_SQ_HOST = "0.0.0.0"          # Listen on all interfaces
DEFAULT_SQ_PORT = 45454              # Sessantaquattro+ default port
DEFAULT_CALIBRATION_S = 2.0          # seconds of rest for baseline

CONVERSION_FACTOR = 0.000286         # raw int16 → mV

# Sessantaquattro+ channel/frequency lookup tables
_NCH_MAP_STANDARD = {0: 16, 1: 24, 2: 40, 3: 72}
_NCH_MAP_MODE1    = {0: 12, 1: 16, 2: 24, 3: 40}
_FSAMP_STANDARD   = {0: 500, 1: 1000, 2: 2000, 3: 4000}
_FSAMP_MODE3      = {0: 2000, 1: 4000, 2: 8000, 3: 16000}


def _sq_num_channels(nch, mode):
    if mode == 1:
        return _NCH_MAP_MODE1.get(nch, 72)
    return _NCH_MAP_STANDARD.get(nch, 72)


def _sq_sample_freq(fsamp, mode):
    if mode == 3:
        return _FSAMP_MODE3.get(fsamp, 2000)
    return _FSAMP_STANDARD.get(fsamp, 2000)


def _sq_build_command(fsamp=2, nch=3, mode=0, hres=0, hpf=0,
                      exten=0, trig=0, rec=0, go=1):
    """Build the 2-byte big-endian command for Sessantaquattro+."""
    cmd = (go
           + (rec   << 1)
           + (trig  << 2)
           + (exten << 4)
           + (hpf   << 6)
           + (hres  << 7)
           + (mode  << 8)
           + (nch   << 11)
           + (fsamp << 13))
    return cmd.to_bytes(2, byteorder='big', signed=True)


class LiveSource:
    """
    Stream EMG from the Sessantaquattro+ via WiFi TCP.

    The Sessantaquattro+ expects YOUR computer to be a TCP server.
    Connection flow:
      1. Connect your PC to the Sessantaquattro+ WiFi network
      2. This code opens a TCP server on 0.0.0.0:45454
      3. The device connects (appears as an incoming connection)
      4. We send a 2-byte config/start command
      5. The device streams big-endian int16 data in chunks of
         (frequency // 16) samples × n_total_channels
    """

    def __init__(
        self,
        host=DEFAULT_SQ_HOST,
        port=DEFAULT_SQ_PORT,
        fsamp=2,                    # 0=500, 1=1000, 2=2000, 3=4000
        nch=3,                      # 0→16ch, 1→24ch, 2→40ch, 3→72ch (standard)
        mode=0,                     # 0=standard, 1=..., 3=accel
        hres=0,                     # 0=16-bit, 1=24-bit
        emg_channels=64,            # how many EMG channels to extract
        calibration_s=DEFAULT_CALIBRATION_S,
        on_log=None,
    ):
        self.host = host
        self.port = int(port)
        self.fsamp = fsamp
        self.nch = nch
        self.mode = mode
        self.hres = hres
        self.Fs = _sq_sample_freq(fsamp, mode)
        self.n_total_channels = _sq_num_channels(nch, mode)
        self.n_channels = emg_channels
        self.bytes_per_sample = 3 if hres == 1 else 2
        self.calibration_s = calibration_s
        self._stop = False
        self._paused = False
        self._server_sock = None
        self._client_sock = None
        self._on_log = on_log or (lambda msg: None)

        # Rest calibration data
        self._rest_samples = []
        self._rest_data = None

    def stop(self):
        self._stop = True
        self._paused = False
        # Send stop command
        if self._client_sock:
            try:
                stop_cmd = _sq_build_command(
                    fsamp=self.fsamp, nch=self.nch, mode=self.mode,
                    hres=self.hres, go=0,
                )
                self._client_sock.send(stop_cmd)
            except Exception:
                pass
            try:
                self._client_sock.close()
            except Exception:
                pass
            self._client_sock = None
        if self._server_sock:
            try:
                self._server_sock.close()
            except Exception:
                pass
            self._server_sock = None

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def _recv_exact(self, n):
        """Receive exactly n bytes from the client socket."""
        buf = bytearray()
        while len(buf) < n and not self._stop:
            chunk = self._client_sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Sessantaquattro+ connection closed")
            buf.extend(chunk)
        return bytes(buf)

    def stream(self):
        """
        Start a TCP server, wait for the Sessantaquattro+ to connect,
        send the start command, and yield one sample at a time.

        Each yielded sample is a 1-D float64 array of length `emg_channels`
        (in mV after conversion).
        """
        self._stop = False
        self._rest_samples = []
        self._rest_data = None
        cal_n = int(self.calibration_s * self.Fs)

        # ── Start TCP server ────────────────────────────────────────────────
        self._on_log(f"Starting TCP server on {self.host}:{self.port}…")
        self._on_log("Waiting for Sessantaquattro+ to connect…")

        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind((self.host, self.port))
        self._server_sock.listen(1)

        # Poll accept() with short timeouts so we can honour _stop quickly
        self._client_sock = None
        deadline = time.time() + 60.0
        while not self._stop:
            remaining = deadline - time.time()
            if remaining <= 0:
                self._on_log("ERROR: Sessantaquattro+ did not connect within 60s")
                self._server_sock.close()
                self._server_sock = None
                return
            self._server_sock.settimeout(min(remaining, 1.0))
            try:
                self._client_sock, addr = self._server_sock.accept()
                break
            except socket.timeout:
                continue
            except OSError:
                # Socket was closed by stop() from another thread
                self._server_sock = None
                return

        if self._stop or self._client_sock is None:
            if self._server_sock:
                self._server_sock.close()
                self._server_sock = None
            return

        self._on_log(f"Sessantaquattro+ connected from {addr}")

        # ── Send start command ──────────────────────────────────────────────
        start_cmd = _sq_build_command(
            fsamp=self.fsamp, nch=self.nch, mode=self.mode,
            hres=self.hres, go=1,
        )
        self._client_sock.send(start_cmd)
        self._on_log(
            f"Acquisition started — {self.n_total_channels}ch "
            f"@ {self.Fs} Hz ({self.bytes_per_sample * 8}-bit)"
        )

        # ── Receive loop ────────────────────────────────────────────────────
        samples_per_chunk = self.Fs // 16
        bytes_per_chunk = self.n_total_channels * self.bytes_per_sample * samples_per_chunk
        sample_idx = 0
        dtype_str = '>h'  # big-endian int16

        try:
            while not self._stop:
                raw_bytes = self._recv_exact(bytes_per_chunk)
                if self._stop:
                    break

                if self.bytes_per_sample == 2:
                    # Big-endian int16
                    chunk = np.frombuffer(raw_bytes, dtype='>i2').reshape(
                        samples_per_chunk, self.n_total_channels
                    )
                else:
                    # 24-bit: manual conversion (3 bytes per sample)
                    n_values = samples_per_chunk * self.n_total_channels
                    raw = np.frombuffer(raw_bytes, dtype=np.uint8).reshape(n_values, 3)
                    chunk = (raw[:, 0].astype(np.int32) * 65536
                             + raw[:, 1].astype(np.int32) * 256
                             + raw[:, 2].astype(np.int32))
                    chunk[chunk >= 8388608] -= 16777216
                    chunk = chunk.reshape(samples_per_chunk, self.n_total_channels)

                # Yield one sample at a time, first emg_channels only, in mV
                for row_idx in range(samples_per_chunk):
                    if self._stop:
                        break

                    # Block while paused — discard live data so buffer doesn't overflow
                    while self._paused and not self._stop:
                        time.sleep(0.05)
                    if self._stop:
                        break

                    sample = chunk[row_idx, :self.n_channels].astype(np.float64) * CONVERSION_FACTOR

                    # Collect rest calibration
                    if sample_idx < cal_n:
                        self._rest_samples.append(sample)
                        if sample_idx == cal_n - 1:
                            self._rest_data = np.array(self._rest_samples)
                            self._on_log(
                                f"Rest calibration complete "
                                f"({self.calibration_s}s, {cal_n} samples)"
                            )

                    sample_idx += 1
                    yield sample

        except (ConnectionError, OSError) as e:
            if not self._stop:
                self._on_log(f"Connection lost: {e}")
        finally:
            self.stop()

    @property
    def rest_data(self):
        """Return rest calibration data collected during the first seconds."""
        if self._rest_data is not None:
            return self._rest_data
        if self._rest_samples:
            return np.array(self._rest_samples)
        return None
