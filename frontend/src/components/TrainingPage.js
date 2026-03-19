import React, { useState, useEffect, useRef } from 'react';

const API = 'http://localhost:5050';

const GESTURE_IMAGES = {
  'Open': '/gestures/open.jpg',
  'Close': '/gestures/close.jpg',
  'Thumbs Up': '/gestures/thumbs_up.jpg',
  'Peace': '/gestures/peace.jpg',
  'Index Point': '/gestures/index_point.jpg',
  'Four': '/gestures/four.jpg',
  'Okay': '/gestures/okay.jpg',
  'Spiderman': '/gestures/spiderman.jpg',
};

const SESSION_LENGTHS = [
  { label: '2 min', value: 2 },
  { label: '5 min', value: 5 },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
];

function TrainingPage({ socket, connected, user, mode, liveOpts }) {
  // Setup state
  const [gestures, setGestures] = useState([]);       // available gestures from DB
  const [sessionMinutes, setSessionMinutes] = useState(null);

  // Session state
  const [collecting, setCollecting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [sensorStatus, setSensorStatus] = useState(null); // { channels, quality }
  const [logs, setLogs] = useState([]);
  const logBottomRef = useRef(null);

  // Fetch available gestures on mount
  useEffect(() => {
    if (!user?.id) return;
    fetch(`${API}/api/training/gestures/${user.id}`)
      .then((r) => r.json())
      .then((data) => setGestures(data.gestures || []))
      .catch(() => {});
  }, [user?.id]);

  // Socket listeners
  useEffect(() => {
    if (!socket) return;

    const onPhase = (data) => {
      setPhase(data);
      setCountdown(data.countdown);
    };
    const onCountdown = (data) => setCountdown(data.countdown);
    const onLog = (data) => {
      setLogs((prev) => [...prev, data.text].slice(-80));
    };
    const onDone = () => {
      setCollecting(false);
      setPaused(false);
      setPhase(null);
    };
    const onSensor = (data) => setSensorStatus(data);
    const onPaused = (data) => setPaused(data.paused);

    socket.on('train_phase', onPhase);
    socket.on('train_countdown', onCountdown);
    socket.on('train_log', onLog);
    socket.on('train_done', onDone);
    socket.on('train_sensor', onSensor);
    socket.on('train_paused', onPaused);

    return () => {
      socket.off('train_phase', onPhase);
      socket.off('train_countdown', onCountdown);
      socket.off('train_log', onLog);
      socket.off('train_done', onDone);
      socket.off('train_sensor', onSensor);
      socket.off('train_paused', onPaused);
      // Stop backend training if user navigates away mid-session
      socket.emit('train_stop');
    };
  }, [socket]);

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
  };

  const handleStop = () => {
    if (!socket) return;
    // Pause first, then show confirm popup after a tick
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
      {/* ── Session progress bar (visible during collection) ── */}
      {collecting && (
        <div className="train-progress-bar-wrap">
          <div className="train-progress-bar">
            <div className="train-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="train-progress-text">{progressIndex} / {progressTotal} gestures</span>
        </div>
      )}

      {/* ── Sensor status pill ── */}
      {collecting && sensorStatus && (
        <div className={`train-sensor-pill ${sensorStatus.quality}`}>
          <span className="train-sensor-dot" />
          {sensorStatus.channels} channels · {sensorStatus.quality === 'good' ? 'Good signal' : 'Weak signal'}
        </div>
      )}

      {/* ── Pre-session setup (only before collecting) ── */}
      {!collecting && !phase && (
        <div className="card test-setup-card">
          <div className="train-setup-grid">
            {/* Session length */}
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

      {/* ── Active session: gesture prompt ── */}
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

              <div className="training-countdown">{countdown}</div>

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
