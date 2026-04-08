import React, { useState, useEffect, useRef, useCallback } from 'react';

const API = 'http://localhost:5050';

const GESTURE_IMAGES = {
  'Open': '/gestures/open.png',
  'Close': '/gestures/close.png',
  'Thumbs Up': '/gestures/thumbs_up.png',
  'Peace': '/gestures/peace.png',
  'Index Point': '/gestures/index_point.png',
  'Four': '/gestures/four.png',
  'Okay': '/gestures/okay.png',
  'Spiderman': '/gestures/spiderman.png',
};

const SESSION_LENGTHS = [
  { label: '2 min', value: 2 },
  { label: '4 min', value: 4 },
  { label: '6 min', value: 6 },
  { label: '8 min', value: 8 },
];

function TrainEMGStrip({ history }) {
  const ref = useRef(null);
  const PIXELS_PER_POINT = 6; // fixed spacing — controls scroll speed

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.fillStyle = '#090910'; ctx.fillRect(0, 0, W, H);

    if (history.length < 2) return;

    // Only show the points that fit on screen
    const maxPoints = Math.floor(W / PIXELS_PER_POINT) + 1;
    const visible = history.slice(-maxPoints);
    const maxVal = Math.max(...visible.map(h => Math.max(h.flex, h.ext)), 1e-6) * 1.3;

    // Draw from right edge; new data always enters on the right
    const startX = W - (visible.length - 1) * PIXELS_PER_POINT;

    // Helper: draw a smooth curve through points using quadratic bezier midpoints
    const drawSmooth = (getY) => {
      const pts = visible.map((h, i) => ({
        x: startX + i * PIXELS_PER_POINT,
        y: H - Math.min(1, getY(h) / maxVal) * H,
      }));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      // Final segment to the last point
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
    };

    // Flexors line
    ctx.lineWidth = 2;
    drawSmooth(h => h.flex);
    const gr = ctx.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, '#5c5cff44'); gr.addColorStop(1, '#00e5ff');
    ctx.strokeStyle = gr; ctx.stroke();

    // Extensors line
    ctx.lineWidth = 2;
    drawSmooth(h => h.ext);
    const gr2 = ctx.createLinearGradient(0, 0, W, 0);
    gr2.addColorStop(0, '#ff408144'); gr2.addColorStop(1, '#ff4081');
    ctx.strokeStyle = gr2; ctx.stroke();

    // Legend
    ctx.font = '9px monospace';
    ctx.fillStyle = '#00e5ff'; ctx.fillText('Flexors', 5, 12);
    ctx.fillStyle = '#ff4081'; ctx.fillText('Extensors', 60, 12);
  }, [history]);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: '0.68rem', color: '#555', fontFamily: 'monospace',
        marginBottom: 3, letterSpacing: 1 }}>EMG SIGNAL</div>
      <canvas ref={ref} width={700} height={80}
        style={{ width: '100%', height: 80, borderRadius: 6,
          border: '1px solid #1a1a2e', display: 'block' }} />
    </div>
  );
}

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
  const [signalHistory, setSignalHistory] = useState([]);

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
      setCountdown(data.countdown);  // seed initial value; local timer takes over
    };
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
    const onSignal = (data) => {
      setSignalHistory(prev => {
        const next = [...prev, { flex: data.rms_flex || 0, ext: data.rms_ext || 0 }];
        return next.length > 120 ? next.slice(-120) : next;
      });
    };

    socket.on('train_phase', onPhase);
    socket.on('train_log', onLog);
    socket.on('train_done', onDone);
    socket.on('train_sensor', onSensor);
    socket.on('train_paused', onPaused);
    socket.on('train_signal', onSignal);

    return () => {
      socket.off('train_phase', onPhase);
      socket.off('train_log', onLog);
      socket.off('train_done', onDone);
      socket.off('train_sensor', onSensor);
      socket.off('train_paused', onPaused);
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
    setSignalHistory([]);
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

      {/* ── EMG signal strip ── */}
      {(collecting || phase) && signalHistory.length > 1 && (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <TrainEMGStrip history={signalHistory} />
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
