"""
SocketIO event handlers for the EMG Gesture Classifier.
"""

import os
import re
import time
import socket
import threading
from urllib.request import urlopen, Request
from urllib.error import URLError

from config import BASE_DIR, S64_FSAMP, S64_NCH, S64_MODE, DEVICE_WEB_UI
import state
from worker import run_worker, run_training_collector


def register_socket_handlers(socketio, app):
    """Register all SocketIO event handlers on the given socketio instance."""

    @socketio.on("connect")
    def on_connect():
        print("[server] client connected")

    @socketio.on("disconnect")
    def on_disconnect():
        print("[server] client disconnected")

    # ── Prediction start/stop ─────────────────────────────────────────────

    @socketio.on("start")
    def on_start(data=None):
        print(f"[server] 'start' event received, worker_running={state.worker_running}, data={data}")
        if state.training_running:
            # Stop training first so prediction can start
            state.training_running = False
            if state.training_source:
                state.training_source.stop()
                state.training_source = None
        if state.worker_running:
            print("[server] worker already running, ignoring start")
            socketio.emit("log", {"text": "Already running!"})
            return
        data      = data or {}
        mode      = data.get("mode", "simulated")
        live_opts = data.get("liveOpts", {})
        user_id   = data.get("userId")
        print(f"[server] starting worker in mode={mode}, user_id={user_id}")
        state.worker_thread = threading.Thread(
            target=run_worker,
            args=(app, socketio, mode, live_opts, user_id),
            daemon=True,
        )
        state.worker_thread.start()

    @socketio.on("stop")
    def on_stop(_=None):
        state.worker_running = False
        if state.active_source:
            state.active_source.stop()
            state.active_source = None
        socketio.emit("log",   {"text": "Stopped by user."})
        socketio.emit("state", {"label": "STOPPED", "gesture": "—", "color": "#888888", "act": 0.0})

    # ── Runtime config ────────────────────────────────────────────────────

    @socketio.on("update_config")
    def on_update_config(data=None):
        data = data or {}
        changed = []
        if "t_on" in data:
            state.runtime_config["t_on"] = float(data["t_on"])
            changed.append(f"T_ON={state.runtime_config['t_on']}")
        if "t_off" in data:
            state.runtime_config["t_off"] = float(data["t_off"])
            changed.append(f"T_OFF={state.runtime_config['t_off']}")
        if "min_votes" in data:
            state.runtime_config["min_votes"] = int(data["min_votes"])
            changed.append(f"MIN_VOTES={state.runtime_config['min_votes']}")
        if "model_path" in data:
            mp = data["model_path"]
            if mp:
                full = os.path.join(BASE_DIR, mp) if not os.path.isabs(mp) else mp
                if os.path.isfile(full):
                    state.runtime_config["model_path"] = full
                    changed.append(f"model={os.path.basename(full)}")
                else:
                    socketio.emit("config_error", {"error": f"Model file not found: {mp}"})
                    return
            else:
                state.runtime_config["model_path"] = None
                changed.append("model=default")
        if changed:
            socketio.emit("log", {"text": f"⚙  Config updated: {', '.join(changed)}"})
        _emit_config_state()

    @socketio.on("get_config")
    def on_get_config(_=None):
        _emit_config_state()

    def _emit_config_state():
        mp = state.runtime_config["model_path"]
        rel = os.path.relpath(mp, BASE_DIR) if mp else None
        socketio.emit("config_state", {
            "t_on":       state.runtime_config["t_on"],
            "t_off":      state.runtime_config["t_off"],
            "min_votes":  state.runtime_config["min_votes"],
            "model_path": rel,
        })

    # ── Device check / battery ────────────────────────────────────────────

    @socketio.on("check_device")
    def on_check_device(data=None):
        """Check device reachability via its web UI instead of opening
        a TCP listener on the streaming port (which would consume the
        device's connection attempt and leave the real start() with
        nothing to accept)."""
        def _probe():
            try:
                socketio.emit("device_status", {"status": "connecting"})
                level = _scrape_battery()
                if level is not None:
                    socketio.emit("device_status", {"status": "connected"})
                    socketio.emit("battery_level", {"level": level})
                else:
                    socketio.emit("device_status", {
                        "status": "error",
                        "error": "Device not found. Check WiFi connection and try again.",
                    })
            except Exception as e:
                socketio.emit("device_status", {"status": "error", "error": str(e)})

        threading.Thread(target=_probe, daemon=True).start()

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

    def _scrape_battery(url=DEVICE_WEB_UI):
        try:
            bust_url = f"{url}?_t={int(time.time())}"
            req = Request(bust_url, headers={"Cache-Control": "no-cache", "Pragma": "no-cache"})
            resp = urlopen(req, timeout=4)
            html = resp.read().decode("utf-8", errors="ignore")
            m = re.search(r'Battery Level:\s*</td>\s*<td[^>]*>\s*(\d+)%', html)
            if m:
                return int(m.group(1))
        except (URLError, OSError):
            pass
        return None

    # ── Training collection ───────────────────────────────────────────────

    @socketio.on("train_start")
    def on_train_start(data=None):
        print(f"[server] train_start: training_running={state.training_running}, worker_running={state.worker_running}")
        if state.worker_running:
            # Stop prediction worker first so training can start
            state.worker_running = False
            if state.active_source:
                state.active_source.stop()
                state.active_source = None
        if state.training_running:
            socketio.emit("train_log", {"text": "Already running!"})
            return
        data = data or {}
        state.training_thread = threading.Thread(
            target=run_training_collector,
            args=(app, socketio, data.get("mode", "simulated"), data.get("liveOpts", {})),
            kwargs={
                "user_id": data.get("userId"),
                "session_minutes": int(data.get("sessionMinutes", 5)),
                "gesture_ids": data.get("gestureIds"),
            },
            daemon=True,
        )
        state.training_thread.start()

    @socketio.on("train_pause")
    def on_train_pause(_=None):
        state.training_paused = True
        if state.training_source:
            state.training_source.pause()
        socketio.emit("train_log",    {"text": "⏸ Paused."})
        socketio.emit("train_paused", {"paused": True})

    @socketio.on("train_resume")
    def on_train_resume(_=None):
        state.training_paused = False
        if state.training_source:
            state.training_source.resume()
        socketio.emit("train_log",    {"text": "▶ Resumed."})
        socketio.emit("train_paused", {"paused": False})

    @socketio.on("train_stop")
    def on_train_stop(_=None):
        state.training_running = False
        state.training_paused  = False
        if state.training_source:
            state.training_source.stop()
            state.training_source = None
        socketio.emit("train_log",  {"text": "Training stopped."})
        socketio.emit("train_done", {"filename": None, "count": 0})
