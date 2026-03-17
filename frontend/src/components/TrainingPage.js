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

function TrainingPage({ socket, connected, user }) {
  // Setup state
  const [gestures, setGestures] = useState([]);       // available gestures from DB
  const [sessionMinutes, setSessionMinutes] = useState(5);
  const [mode, setMode] = useState('simulated');
  const [liveOpts, setLiveOpts] = useState({ host: '0.0.0.0', port: '45454' });

  // Session state
  const [collecting, setCollecting] = useState(false);
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
    const onDone = () => setCollecting(false);
    const onSensor = (data) => setSensorStatus(data);

    socket.on('train_phase', onPhase);
    socket.on('train_countdown', onCountdown);
    socket.on('train_log', onLog);
    socket.on('train_done', onDone);
    socket.on('train_sensor', onSensor);

    return () => {
      socket.off('train_phase', onPhase);
      socket.off('train_countdown', onCountdown);
      socket.off('train_log', onLog);
      socket.off('train_done', onDone);
      socket.off('train_sensor', onSensor);
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
    setLogs([]);
    setPhase(null);
    setSensorStatus(null);
  };

  const handleStop = () => {
    if (!socket) return;
    socket.emit('train_stop');
    setCollecting(false);
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
        <div className="card train-setup-card">
          <h3 className="dashboard-card-title">Session Setup</h3>

          <div className="train-setup-grid">
            {/* Gesture info */}
            <div className="train-setup-section">
              <label className="train-setup-label">Available Gestures</label>
              <div className="train-gesture-chips">
                {gestures.length === 0 && <span className="train-no-gestures">No gestures unlocked yet</span>}
                {gestures.map((g) => (
                  <div key={g.gestureId} className="train-gesture-chip">
                    <span>{g.name}</span>
                    {g.needsRetraining && <span className="dash-retrain-badge">!</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Session length */}
            <div className="train-setup-section">
              <label className="train-setup-label">Session Length</label>
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

            {/* Mode + connection */}
            <div className="train-setup-section">
              <label className="train-setup-label">Data Source</label>
              <div className="mode-toggle">
                <button
                  className={`btn btn-mode ${mode === 'simulated' ? 'active' : ''}`}
                  onClick={() => setMode('simulated')}
                >
                  Simulated
                </button>
                <button
                  className={`btn btn-mode ${mode === 'live' ? 'active' : ''}`}
                  onClick={() => setMode('live')}
                >
                  Live EMG
                </button>
              </div>
              {mode === 'live' && (
                <div className="live-opts" style={{ marginTop: 10 }}>
                  <label>
                    IP
                    <input type="text" value={liveOpts.host} onChange={(e) => setLiveOpts((o) => ({ ...o, host: e.target.value }))} />
                  </label>
                  <label>
                    Port
                    <input type="number" value={liveOpts.port} onChange={(e) => setLiveOpts((o) => ({ ...o, port: e.target.value }))} />
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Instructions */}
          <div className="train-instructions">
            <p>You'll be guided through each gesture one at a time. Hold the gesture for <strong>3 seconds</strong> when prompted, then relax during rest periods.</p>
          </div>

          <button
            className="btn btn-start train-start-btn"
            onClick={handleStart}
            disabled={!connected || gestures.length === 0}
          >
            ▶ Start Training ({sessionMinutes} min · ~{Math.max(1, Math.floor(((sessionMinutes * 60 - 6) / 6)))} gestures)
          </button>
        </div>
      )}

      {/* ── Active session: prompt + log grid ── */}
      {(collecting || phase) && (
        <div className="training-grid">
          {/* Left: Gesture prompt */}
          <div className="card training-prompt-card">
            <div className="training-progress">{progressIndex} / {progressTotal}</div>

            <div
              className="training-phase-label"
              style={{ color: isGesture ? '#5b6abf' : '#999' }}
            >
              {isGesture ? 'PERFORM GESTURE' : 'REST'}
            </div>

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
          </div>

          {/* Right: Log */}
          <div className="card log-card">
            <h3>Training Log</h3>
            <div className="log-entries">
              {logs.map((entry, i) => (
                <div key={i} className="log-entry">{entry}</div>
              ))}
              <div ref={logBottomRef} />
            </div>
          </div>
        </div>
      )}

      {/* Stop button (during session) */}
      {collecting && (
        <button
          className="btn btn-stop train-stop-btn"
          onClick={handleStop}
        >
          ■ Stop Session
        </button>
      )}
    </div>
  );
}

export default TrainingPage;
