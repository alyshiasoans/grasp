/**
 * LivePredictionPage.jsx — Free-form gesture prediction viewer
 *
 * Shows the real-time predicted gesture without any game / prompt mechanics.
 * Uses the same backend socket events (`state`, `signal`) as TestingPage.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

const API = 'http://localhost:5050';
const CHANNEL_COUNT = 64;
const GOOD_THRESHOLD = 50;
const FAIR_THRESHOLD = 30;
const T_ON_DEFAULT = 2.4;
const T_OFF_DEFAULT = 1.8;

const GESTURE_COLORS = {
  'Open': '#00e5ff', 'Close': '#ff4081', 'Thumbs Up': '#69ff47',
  'Peace': '#ffd740', 'Index Point': '#e040fb', 'Four': '#ff6d00',
  'Okay': '#00e676', 'Spiderman': '#ff1744',
};

const GESTURE_IMAGES = {
  'Open': '/gestures/open.jpg', 'Close': '/gestures/close.jpg',
  'Thumbs Up': '/gestures/thumbs_up.jpg', 'Peace': '/gestures/peace.jpg',
  'Index Point': '/gestures/index_point.jpg', 'Four': '/gestures/four.jpg',
  'Okay': '/gestures/okay.jpg', 'Spiderman': '/gestures/spiderman.jpg',
};

const SUCCESS_GREEN = '#35d06e';

// ── Sensor status bar ─────────────────────────────────────────────────────────
function SensorStatusBar({ channels }) {
  const activeCount = useMemo(() => channels.filter(v => v > 0.15).length, [channels]);
  const quality = activeCount >= GOOD_THRESHOLD ? 'good'
    : activeCount >= FAIR_THRESHOLD ? 'fair' : 'poor';
  const col = { good: SUCCESS_GREEN, fair: '#ffd740', poor: '#ff4081' }[quality];
  const label = { good: 'Good', fair: 'Fair', poor: 'Poor' }[quality];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6,
      fontSize: '0.78rem', fontFamily: 'monospace', color: '#666' }}>
      <span>Sensor quality:</span>
      <span style={{ color: col, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

// ── EMG activation strip ──────────────────────────────────────────────────────
function EMGStrip({ actHistory, tOn, tOff }) {
  const ref = useRef(null);
  const tOnVal = tOn || T_ON_DEFAULT;
  const tOffVal = tOff || T_OFF_DEFAULT;

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.fillStyle = '#090910'; ctx.fillRect(0, 0, W, H);

    const maxAct = tOnVal * 2.5;
    const yOn = H - (tOnVal / maxAct) * H;
    const yOff = H - (tOffVal / maxAct) * H;

    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.strokeStyle = '#ff408133';
    ctx.beginPath(); ctx.moveTo(0, yOn); ctx.lineTo(W, yOn); ctx.stroke();
    ctx.strokeStyle = '#ffd74033';
    ctx.beginPath(); ctx.moveTo(0, yOff); ctx.lineTo(W, yOff); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '9px monospace';
    ctx.fillStyle = '#ff408177';
    ctx.fillText(`T_ON ${tOnVal}`, 5, yOn - 2);
    ctx.fillStyle = '#ffd74077';
    ctx.fillText(`T_OFF ${tOffVal}`, 5, yOff - 2);

    if (actHistory.length < 2) return;
    ctx.beginPath(); ctx.lineWidth = 2;
    actHistory.forEach((v, i) => {
      const x = (i / (actHistory.length - 1)) * W;
      const y = H - Math.min(1, v / maxAct) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    const gr = ctx.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, '#5c5cff44'); gr.addColorStop(1, '#00e5ff');
    ctx.strokeStyle = gr; ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const fg = ctx.createLinearGradient(0, 0, 0, H);
    fg.addColorStop(0, '#00e5ff14'); fg.addColorStop(1, '#00e5ff00');
    ctx.fillStyle = fg; ctx.fill();
  }, [actHistory, tOnVal, tOffVal]);

  return (
    <div>
      <div style={{ fontSize: '0.68rem', color: '#555', fontFamily: 'monospace',
        marginBottom: 3, letterSpacing: 1 }}>EMG ACTIVATION</div>
      <canvas ref={ref} width={700} height={80}
        style={{ width: '100%', height: 80, borderRadius: 6,
          border: '1px solid #1a1a2e', display: 'block' }} />
    </div>
  );
}

// ── History log entry ─────────────────────────────────────────────────────────
function HistoryEntry({ gesture, timestamp }) {
  const col = GESTURE_COLORS[gesture] || '#888';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
      borderBottom: '1px solid #eee' }}>
      <span style={{ color: col, fontWeight: 600, minWidth: 110 }}>{gesture}</span>
      <span style={{ color: '#999', fontSize: '0.75rem', fontFamily: 'monospace' }}>{timestamp}</span>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Main component ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
function LivePredictionPage({ socket, connected, user, mode, liveOpts }) {
  const [running, setRunning] = useState(false);
  const [stateLabel, setStateLabel] = useState('REST');
  const [gesture, setGesture] = useState('');
  const [activation, setActivation] = useState(0);
  const [actHistory, setActHistory] = useState([]);
  const [channels, setChannels] = useState(() => new Array(CHANNEL_COUNT).fill(0));
  const [tOn, setTOn] = useState(T_ON_DEFAULT);
  const [tOff, setTOff] = useState(T_OFF_DEFAULT);
  const [history, setHistory] = useState([]);
  const tOnRef = useRef(T_ON_DEFAULT);

  // Config panel state
  const [cfgTOn, setCfgTOn] = useState('');
  const [cfgTOff, setCfgTOff] = useState('');
  const [cfgMinVotes, setCfgMinVotes] = useState('');
  const [cfgModel, setCfgModel] = useState('');
  const [modelList, setModelList] = useState([]);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Simulated mode state
  const simRef = useRef(null);
  const simRunning = useRef(false);

  const ALL_GESTURES = useMemo(() => Object.keys(GESTURE_COLORS), []);

  // ── Fetch model list + current config on mount ──────────────────────────
  useEffect(() => {
    const uid = user?.id;
    const url = uid ? `${API}/api/models/list?userId=${uid}` : `${API}/api/models/list`;
    fetch(url)
      .then(r => r.json())
      .then(models => setModelList(models || []))
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (!socket) return;
    const onConfig = (data) => {
      if (!configLoaded) {
        setCfgTOn(String(data.t_on));
        setCfgTOff(String(data.t_off));
        setCfgMinVotes(String(data.min_votes));
        setCfgModel(data.model_path || '');
        setConfigLoaded(true);
      }
    };
    socket.on('config_state', onConfig);
    socket.emit('get_config');
    return () => socket.off('config_state', onConfig);
  }, [socket, configLoaded]);

  const applyConfig = useCallback(() => {
    if (!socket) return;
    const update = {};
    const tOnN = parseFloat(cfgTOn);
    const tOffN = parseFloat(cfgTOff);
    const mvN = parseInt(cfgMinVotes, 10);
    if (!isNaN(tOnN) && tOnN > 0) update.t_on = tOnN;
    if (!isNaN(tOffN) && tOffN > 0) update.t_off = tOffN;
    if (!isNaN(mvN) && mvN > 0) update.min_votes = mvN;
    update.model_path = cfgModel || '';
    socket.emit('update_config', update);
  }, [socket, cfgTOn, cfgTOff, cfgMinVotes, cfgModel]);

  // ── Socket listeners (live mode) ────────────────────────────────────────
  useEffect(() => {
    if (!socket || !running || mode !== 'live') return;

    const onState = (data) => {
      const act = typeof data.act === 'number' ? data.act : 0;
      const label = data.label || '';
      setStateLabel(label || 'REST');
      setActivation(act);
      setActHistory(prev => {
        const n = [...prev, act];
        return n.length > 120 ? n.slice(-120) : n;
      });

      const g = data.gesture || '';
      if (g && g !== 'REST' && g !== '—' && g !== '') {
        setGesture(g);
        setHistory(prev => {
          const ts = new Date().toLocaleTimeString();
          const next = [{ gesture: g, timestamp: ts }, ...prev];
          return next.length > 30 ? next.slice(0, 30) : next;
        });
      } else if (label === 'REST') {
        setGesture('');
      }
    };

    const onSignal = (data) => {
      try {
        if (typeof data.t_on === 'number') { setTOn(data.t_on); tOnRef.current = data.t_on; }
        if (typeof data.t_off === 'number') setTOff(data.t_off);

        const flex = data.flexors || [];
        const ext = data.extensors || [];
        const flexVal = flex.length ? flex[flex.length - 1].y : 0;
        const extVal = ext.length ? ext[ext.length - 1].y : 0;
        const tOn_ = tOnRef.current || T_ON_DEFAULT;
        const ch = Array.from({ length: 64 }, (_, i) => {
          const base = i < 32 ? flexVal : extVal;
          return (base / tOn_) * (0.7 + Math.random() * 0.6);
        });
        setChannels(ch);
      } catch (_) {}
    };

    socket.on('state', onState);
    socket.on('signal', onSignal);
    return () => {
      socket.off('state', onState);
      socket.off('signal', onSignal);
    };
  }, [socket, running, mode]);

  // ── Simulated mode ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!running || mode !== 'simulated') return;
    simRunning.current = true;

    // Cycle: REST 1.5s → ramp-up 0.5s → ACTIVE ~2s → REST …
    let phase = 'rest';
    let timer = 0;
    const TICK = 80; // ms

    const tick = () => {
      if (!simRunning.current) return;
      timer += TICK;

      if (phase === 'rest' && timer > 1500) {
        phase = 'active'; timer = 0;
        const g = ALL_GESTURES[Math.floor(Math.random() * ALL_GESTURES.length)];
        setStateLabel('ACTIVE');
        setGesture(g);
        setHistory(prev => {
          const ts = new Date().toLocaleTimeString();
          const next = [{ gesture: g, timestamp: ts }, ...prev];
          return next.length > 30 ? next.slice(0, 30) : next;
        });
      } else if (phase === 'active' && timer > 2000) {
        phase = 'rest'; timer = 0;
        setStateLabel('REST');
        setGesture('');
      }

      // Simulated activation
      const act = phase === 'active'
        ? T_ON_DEFAULT * (1.0 + Math.random() * 0.8)
        : T_OFF_DEFAULT * Math.random() * 0.5;
      setActivation(act);
      setActHistory(prev => {
        const n = [...prev, act];
        return n.length > 120 ? n.slice(-120) : n;
      });

      // Simulated channels
      setChannels(Array.from({ length: 64 }, () =>
        phase === 'active' ? 0.4 + Math.random() * 0.8 : Math.random() * 0.15
      ));
    };

    simRef.current = setInterval(tick, TICK);
    return () => {
      simRunning.current = false;
      if (simRef.current) { clearInterval(simRef.current); simRef.current = null; }
    };
  }, [running, mode, ALL_GESTURES]);

  // ── Start / Stop ────────────────────────────────────────────────────────
  const handleStart = useCallback(() => {
    setRunning(true);
    setHistory([]);
    setGesture('');
    setStateLabel('REST');
    setActivation(0);
    setActHistory([]);
    if (socket && mode === 'live') {
      socket.emit('start', { mode: 'live', liveOpts, userId: user?.id });
    }
  }, [socket, mode, liveOpts, user]);

  const handleStop = useCallback(() => {
    setRunning(false);
    simRunning.current = false;
    if (simRef.current) { clearInterval(simRef.current); simRef.current = null; }
    if (socket) socket.emit('stop');
  }, [socket]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const gestureColor = GESTURE_COLORS[gesture] || '#888';
  const gestureImage = GESTURE_IMAGES[gesture] || null;
  const stateColor = stateLabel === 'ACTIVE' ? '#5b6abf' : '#999';

  // ── Render ──────────────────────────────────────────────────────────────
  const inputStyle = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #d0d0d8',
    fontFamily: 'monospace', fontSize: '0.85rem', width: '100%',
    background: '#fafafa',
  };
  const labelStyle = { fontSize: '0.75rem', color: '#666', marginBottom: 3, fontWeight: 600 };

  const configPanel = (
    <div className="card" style={{ padding: 20, marginBottom: 18 }}>
      <h4 className="dashboard-card-title" style={{ marginBottom: 12, fontSize: '0.88rem' }}>
        Configuration
      </h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
        <div>
          <div style={labelStyle}>T_ON (activation start)</div>
          <input style={inputStyle} type="number" step="0.1" min="0.1"
            value={cfgTOn} onChange={e => setCfgTOn(e.target.value)} />
        </div>
        <div>
          <div style={labelStyle}>T_OFF (activation end)</div>
          <input style={inputStyle} type="number" step="0.1" min="0.1"
            value={cfgTOff} onChange={e => setCfgTOff(e.target.value)} />
        </div>
        <div>
          <div style={labelStyle}>Min Votes</div>
          <input style={inputStyle} type="number" step="1" min="1"
            value={cfgMinVotes} onChange={e => setCfgMinVotes(e.target.value)} />
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Model</div>
        <select style={{ ...inputStyle, cursor: 'pointer' }}
          value={cfgModel} onChange={e => setCfgModel(e.target.value)}>
          <option value="">Default (active model)</option>
          {modelList.map((m, i) => (
            <option key={i} value={m.filePath}>
              {m.name}{m.accuracy != null ? ` (${Math.round(m.accuracy)}%)` : ''}{m.isActive ? ' ★' : ''}
            </option>
          ))}
        </select>
      </div>
      <div style={{ textAlign: 'center' }}>
        <button className="btn" onClick={applyConfig}
          style={{ background: '#5b6abf', color: '#fff', padding: '8px 28px', borderRadius: 6, fontSize: '0.85rem' }}>
          Apply
        </button>
      </div>
    </div>
  );

  if (!running) {
    return (
      <div className="testing-page" style={{ maxWidth: 700, margin: '0 auto', padding: '0 0 40px' }}>
        {configPanel}
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <h3 className="dashboard-card-title" style={{ marginBottom: 8 }}>Live Prediction</h3>
          <p style={{ color: '#888', marginBottom: 24, fontSize: '0.92rem' }}>
            See what gesture the model predicts in real time.
          </p>
          <button className="btn btn-primary" onClick={handleStart}
            style={{ padding: '12px 48px', fontSize: '1.05rem', background: '#5b6abf', color: '#fff' }}>
            Start
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="testing-page" style={{ maxWidth: 920, margin: '0 auto', padding: '0 0 40px' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SensorStatusBar channels={channels} />
        <button className="btn" onClick={handleStop}
          style={{ background: '#ff4081', color: '#fff', padding: '6px 20px', borderRadius: 6, fontSize: '0.85rem' }}>
          Stop
        </button>
      </div>

      {/* Config panel (always visible) */}
      {configPanel}

      {/* Main prediction card */}
      <div className="card" style={{ padding: 32, textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: '0.82rem', fontFamily: 'monospace', color: stateColor, marginBottom: 6, fontWeight: 600 }}>
          {stateLabel}
        </div>

        <div style={{
          fontSize: '2.4rem', fontWeight: 700, color: gesture ? gestureColor : '#ccc',
          transition: 'color 0.2s', minHeight: '3.2rem', lineHeight: '3.2rem',
        }}>
          {gesture || '—'}
        </div>

        {gestureImage && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
            <img src={gestureImage} alt={gesture}
              style={{ width: 180, height: 180, objectFit: 'cover', borderRadius: 12,
                border: `3px solid ${gestureColor}`, boxShadow: `0 0 20px ${gestureColor}33` }} />
          </div>
        )}

        {/* Activation bar */}
        <div style={{ marginTop: 20, maxWidth: 400, margin: '20px auto 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#888', marginBottom: 4 }}>
            <span>Activation</span>
            <span style={{ fontFamily: 'monospace' }}>{activation.toFixed(2)}</span>
          </div>
          <div style={{ height: 8, background: '#e8e8ec', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 4, transition: 'width 0.15s',
              width: `${Math.min((activation / (tOn * 2.5)) * 100, 100)}%`,
              background: activation > tOn ? '#ff4081' : activation > tOff ? '#ffd740' : '#5b6abf',
            }} />
          </div>
        </div>
      </div>

      {/* EMG strip */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <EMGStrip actHistory={actHistory} tOn={tOn} tOff={tOff} />
      </div>

      {/* Recent predictions log */}
      {history.length > 0 && (
        <div className="card" style={{ padding: 20 }}>
          <h4 className="dashboard-card-title" style={{ marginBottom: 10, fontSize: '0.88rem' }}>
            Recent Predictions
          </h4>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {history.map((h, i) => (
              <HistoryEntry key={i} gesture={h.gesture} timestamp={h.timestamp} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default LivePredictionPage;
