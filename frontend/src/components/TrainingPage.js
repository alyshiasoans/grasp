import React, { useState, useEffect, useRef, useCallback } from 'react';
import { API, GESTURE_IMAGES_PNG, T_ON_DEFAULT, T_OFF_DEFAULT } from '../constants';
import EMGStrip from './EMGStrip';

const GESTURE_IMAGES = GESTURE_IMAGES_PNG;

const SESSION_LENGTHS = [
  { label: '2 min', value: 2 },
  { label: '4 min', value: 4 },
  { label: '6 min', value: 6 },
  { label: '8 min', value: 8 },
];

function TrainingPage({ socket, connected, user, mode, liveOpts }) {
  const [gestures, setGestures] = useState([]);
  const [sessionMinutes, setSessionMinutes] = useState(null);
  const [collecting, setCollecting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [sensorStatus, setSensorStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const logBottomRef = useRef(null);
  const [actHistory, setActHistory] = useState([]);
  const [tOnLive, setTOnLive] = useState(T_ON_DEFAULT);
  const [tOffLive, setTOffLive] = useState(T_OFF_DEFAULT);

  useEffect(() => {
    if (!user?.id) return;
    fetch(`${API}/api/training/gestures/${user.id}`)
      .then((r) => r.json())
      .then((data) => setGestures(data.gestures || []))
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (!socket) return;

    const onPhase = (data) => {
      setPhase(data);
      setCountdown(data.countdown);  // seed initial value; local timer takes over
    };
    const onLog = (data) => {
      setLogs((prev) => [...prev, data.text].slice(-80));
    };
    const onDone = () => {
      setPhase({ phase: 'done', gesture: 'Training Complete!', countdown: 0, index: 0, total: 0 });
      setCountdown(0);
      setPaused(false);
      setTimeout(() => {
        setCollecting(false);
        setPhase(null);
      }, 3000);
    };
    const onSensor = (data) => setSensorStatus(data);
    const onPaused = (data) => setPaused(data.paused);
    const onState = (data) => {
      const act = typeof data.act === 'number' ? data.act : 0;
      setActHistory(prev => {
        const n = [...prev, act];
        return n.length > 120 ? n.slice(-120) : n;
      });
    };
    const onSignal = (data) => {
      if (typeof data.t_on  === 'number') setTOnLive(data.t_on);
      if (typeof data.t_off === 'number') setTOffLive(data.t_off);
    };

    socket.on('train_phase', onPhase);
    socket.on('train_log', onLog);
    socket.on('train_done', onDone);
    socket.on('train_sensor', onSensor);
    socket.on('train_paused', onPaused);
    socket.on('train_state', onState);
    socket.on('train_signal', onSignal);

    return () => {
      socket.off('train_phase', onPhase);
      socket.off('train_log', onLog);
      socket.off('train_done', onDone);
      socket.off('train_sensor', onSensor);
      socket.off('train_paused', onPaused);
      socket.off('train_state', onState);
      socket.off('train_signal', onSignal);
      // Stop backend training if user navigates away mid-session
      socket.emit('train_stop');
    };
  }, [socket]);

  // Local 1-second countdown timer — independent of backend sample rate
  useEffect(() => {
    if (!collecting || paused || countdown <= 1) return;
    const id = setInterval(() => {
      setCountdown(prev => Math.max(1, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [collecting, paused, countdown]);

  // Auto-scroll log
  useEffect(() => {
    if (logBottomRef.current) {
      logBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleStart = () => {
    if (!socket) return;
    socket.emit('train_start', {
      mode,
      liveOpts: mode === 'live' ? liveOpts : {},
      userId: user?.id,
      sessionMinutes,
    });
    setCollecting(true);
    setPaused(false);
    setLogs([]);
    setPhase(null);
    setCountdown(0);
    setSensorStatus(null);
    setActHistory([]);
  };

  const handleStop = () => {
    if (!socket) return;
    socket.emit('train_pause');
    setPaused(true);
    setTimeout(() => {
      if (window.confirm('Are you sure you want to stop this session? Any unsaved progress will be lost.')) {
        socket.emit('train_stop');
        setCollecting(false);
        setPaused(false);
        setPhase(null);
      }
    }, 150);
  };

  const handlePause = () => {
    if (!socket) return;
    if (paused) {
      socket.emit('train_resume');
    } else {
      socket.emit('train_pause');
    }
  };

  const isGesture = phase?.phase === 'gesture';
  const gestureName = phase?.gesture || '—';
  const imageSrc = isGesture ? GESTURE_IMAGES[gestureName] : null;
  const progressIndex = phase?.index || 0;
  const progressTotal = phase?.total || 0;
  const progressPct = progressTotal > 0 ? Math.round((progressIndex / progressTotal) * 100) : 0;

  return (
    <div className="training-page">
      {collecting && (
        <div className="train-progress-bar-wrap">
          <div className="train-progress-bar">
            <div className="train-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="train-progress-text">{progressIndex} / {progressTotal} gestures</span>
        </div>
      )}

      {collecting && sensorStatus && (
        <div className={`train-sensor-pill ${sensorStatus.quality}`}>
          <span className="train-sensor-dot" />
          {sensorStatus.channels} channels · {sensorStatus.quality === 'good' ? 'Good signal' : 'Weak signal'}
        </div>
      )}

      {!collecting && !phase && (
        <div className="card test-setup-card">
          <div className="train-setup-grid">
            <div className="train-setup-section">
              <label className="train-setup-label">Please choose a training length:</label>
              <div className="train-length-options">
                {SESSION_LENGTHS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`btn btn-mode ${sessionMinutes === opt.value ? 'active' : ''}`}
                    onClick={() => setSessionMinutes(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            className="btn btn-start train-start-btn"
            onClick={handleStart}
            disabled={!connected || gestures.length === 0 || !sessionMinutes}
          >
            ▶ Start
          </button>
        </div>
      )}

      {(collecting || phase) && (
        <div className="card training-prompt-card">
          {phase && (
            <>
              <div
                className="training-gesture-name"
                style={{ color: isGesture ? '#1a1a2e' : '#aaa' }}
              >
                {gestureName}
              </div>

              {imageSrc && (
                <div className="gesture-image-wrapper gesture-animate">
                  <img src={imageSrc} alt={gestureName} className="gesture-image" />
                </div>
              )}

              {countdown > 0 && (
                <div className="training-countdown">{countdown}</div>
              )}

              {!isGesture && phase?.nextGesture && (
                <div className="training-next">
                  Next: <strong>{phase.nextGesture}</strong>
                </div>
              )}
            </>
          )}

          {paused && (
            <div className="training-paused-label">PAUSED</div>
          )}
        </div>
      )}

      {/* ── EMG signal strip ── */}
      {(collecting || phase) && (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <EMGStrip actHistory={actHistory} />
        </div>
      )}

      {/* Session controls (during session) */}
      {(collecting || phase) && (
        <div className="train-session-controls">
          <button
            className={`btn btn-pause train-pause-btn ${paused ? 'paused' : ''}`}
            onClick={handlePause}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button
            className="btn btn-stop train-stop-btn"
            onClick={handleStop}
          >
            ■ Stop Session
          </button>
        </div>
      )}
    </div>
  );
}

export default TrainingPage;
