import React, { useEffect, useRef, useState } from 'react';

const API = 'http://localhost:5050';
const VANCOUVER_TZ = 'America/Vancouver';
const RENAME_DELAY_MS = 450;
const DEFAULT_EXPORT_OPTIONS = {
  callout: true,
  summary: true,
  gestures: true,
  sessions: true,
  sessionSummary: false,
  graph: true,
};
const GESTURE_TIPS = {
  Close: 'Fully curl all fingers at the same time and hold tightly for 1–2 seconds.',
  Open: 'Spread your fingers wide and keep them fully extended before holding steady.',
  Peace: 'Keep index and middle fingers straight, and fully fold the other fingers.',
  'Thumbs Up': 'Extend your thumb upward while keeping all other fingers tightly closed.',
  Spiderman: 'Extend thumb, index, and pinky while keeping middle and ring fingers fully bent.',
  'Index Point': 'Point your index finger straight and keep all other fingers tightly curled.',
  Okay: 'Form a clear circle with thumb and index, and keep the other fingers relaxed but extended.',
  Four: 'Extend four fingers together and keep your thumb firmly tucked in.',
};

function parseApiDate(value) {
  if (!value) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value);
  return new Date(`${value}Z`);
}

function formatSessionDateTime(value) {
  if (!value) return 'Unknown time';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: VANCOUVER_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parseApiDate(value));
}

function formatSessionDateKey(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VANCOUVER_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parseApiDate(value));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (!mins) return `${secs}s`;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

function GestureCard({ g }) {
  const acc = Number(g.accuracy || 0);
  const displayAcc = acc.toFixed(1);
  const accentColor = acc >= 80 ? '#34c759' : acc >= 50 ? '#ffd740' : '#ff4081';
  const radius = 52;
  const stroke = 6;
  const normalizedRadius = radius - stroke / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (acc / 100) * circumference;

  return (
    <div className="card progress-gesture-card">
      <h4 className="progress-gesture-name">{g.name}</h4>
      <div className="progress-ring-wrap">
        <svg height={radius * 2} width={radius * 2} className="progress-ring-svg">
          <circle
            stroke="#eef0f4"
            fill="transparent"
            strokeWidth={stroke}
            r={normalizedRadius}
            cx={radius}
            cy={radius}
          />
          <circle
            stroke={accentColor}
            fill="transparent"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            style={{ strokeDashoffset, transition: 'stroke-dashoffset 0.5s ease' }}
            r={normalizedRadius}
            cx={radius}
            cy={radius}
          />
        </svg>
        <div className="progress-ring-text">{displayAcc}%</div>
      </div>
      <div className="progress-gesture-details">
        <div className="progress-gesture-stat">
          <span className="progress-stat-value">{g.totalTested}</span>
          <span className="progress-stat-label">Practiced</span>
        </div>
        <div className="progress-gesture-stat">
          <span className="progress-stat-value">{g.correct}</span>
          <span className="progress-stat-label">Correct</span>
        </div>
      </div>
    </div>
  );
}

function AccuracyRing({ accuracy }) {
  const acc = Number(accuracy || 0);
  const displayAcc = acc.toFixed(1);
  const radius = 38;
  const stroke = 7;
  const normalizedRadius = radius - stroke / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (acc / 100) * circumference;
  const accentColor = acc >= 80 ? '#17a34a' : acc >= 50 ? '#d97706' : '#dc2626';

  return (
    <div className="progress-session-ring">
      <svg height={radius * 2} width={radius * 2}>
        <circle
          stroke="#edf1f6"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
        <circle
          stroke={accentColor}
          fill="transparent"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          style={{ strokeDashoffset, transition: 'stroke-dashoffset 0.35s ease' }}
          r={normalizedRadius}
          cx={radius}
          cy={radius}
          transform={`rotate(-90 ${radius} ${radius})`}
        />
      </svg>
      <div className="progress-session-ring-text">{displayAcc}%</div>
    </div>
  );
}

function sessionBarColor(accuracy) {
  if (accuracy >= 80) return '#17a34a';
  if (accuracy >= 50) return '#d97706';
  return '#dc2626';
}

function formatShortDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: VANCOUVER_TZ,
    month: 'short',
    day: 'numeric',
  }).format(parseApiDate(value));
}

function ProgressTrendGraph({ sessions }) {
  const width = 860;
  const height = 280;
  const margin = { top: 24, right: 28, bottom: 56, left: 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const yTicks = [0, 25, 50, 75, 100];

  const buckets = sessions.reduce((acc, session) => {
    const dateKey = formatSessionDateKey(session.startedAt);
    if (!dateKey) return acc;
    if (!acc[dateKey]) {
      acc[dateKey] = {
        dateKey,
        label: formatShortDate(session.startedAt),
        totalAccuracy: 0,
        count: 0,
      };
    }
    acc[dateKey].totalAccuracy += Number(session.overallAccuracy || 0);
    acc[dateKey].count += 1;
    return acc;
  }, {});

  const points = Object.values(buckets)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .map((bucket, index, arr) => {
      const accuracy = bucket.count ? bucket.totalAccuracy / bucket.count : 0;
      const x = margin.left + (arr.length === 1 ? plotWidth / 2 : (index / (arr.length - 1)) * plotWidth);
      const y = margin.top + (1 - (accuracy / 100)) * plotHeight;
      return {
        ...bucket,
        accuracy,
        x,
        y,
      };
    });

  if (points.length === 0) {
    return (
      <div className="card progress-trend-card">
        <div className="progress-trend-title">PROGRESSING...</div>
        <p className="dash-empty">No session trend data yet.</p>
      </div>
    );
  }

  const pathD = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

  return (
    <div className="card progress-trend-card">
      <div className="progress-trend-title">PROGRESSING...</div>
      <div className="progress-trend-graph">
        <svg viewBox={`0 0 ${width} ${height}`} className="progress-line-graph-svg" role="img" aria-label="Average accuracy by date line graph">
          {yTicks.map((tick) => {
            const y = margin.top + ((100 - tick) / 100) * plotHeight;
            return (
              <g key={tick}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={width - margin.right}
                  y2={y}
                  className="progress-line-grid"
                />
                <text x={margin.left - 10} y={y + 4} textAnchor="end" className="progress-line-y-label">
                  {tick}
                </text>
              </g>
            );
          })}

          <line
            x1={margin.left}
            y1={margin.top}
            x2={margin.left}
            y2={height - margin.bottom}
            className="progress-line-axis"
          />
          <line
            x1={margin.left}
            y1={height - margin.bottom}
            x2={width - margin.right}
            y2={height - margin.bottom}
            className="progress-line-axis"
          />

          <path d={pathD} className="progress-trend-line" />

          {points.map((point) => (
            <g key={point.dateKey}>
              <circle cx={point.x} cy={point.y} r="5.5" className="progress-trend-point" />
              <text x={point.x} y={point.y - 12} textAnchor="middle" className="progress-line-point-label">
                {point.accuracy.toFixed(1)}%
              </text>
              <text x={point.x} y={height - margin.bottom + 22} textAnchor="middle" className="progress-line-x-label">
                {point.label}
              </text>
            </g>
          ))}
        </svg>
        <div className="progress-line-axis-title">Avg Accuracy</div>
      </div>
    </div>
  );
}

function SessionAccuracyBarGraph({ gestures }) {
  const sortedGestures = [...gestures].sort((a, b) => a.accuracy - b.accuracy);
  const width = 720;
  const height = 260;
  const margin = { top: 24, right: 24, bottom: 88, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const yTicks = [0, 25, 50, 75, 100];
  const slotWidth = sortedGestures.length > 0 ? plotWidth / sortedGestures.length : plotWidth;
  const barWidth = Math.min(56, Math.max(20, slotWidth * 0.58));
  const bars = sortedGestures.map((gesture, index) => {
    const x = margin.left + slotWidth * index + (slotWidth - barWidth) / 2;
    const barHeight = (gesture.accuracy / 100) * plotHeight;
    const y = margin.top + (plotHeight - barHeight);
    const centerX = x + barWidth / 2;
    return { ...gesture, x, y, centerX, barHeight };
  });

  return (
    <div className="progress-line-graph">
      <svg viewBox={`0 0 ${width} ${height}`} className="progress-line-graph-svg" role="img" aria-label="Session gesture accuracy bar graph">
        {yTicks.map((tick) => {
          const y = margin.top + ((100 - tick) / 100) * plotHeight;
          return (
            <g key={tick}>
              <line
                x1={margin.left}
                y1={y}
                x2={width - margin.right}
                y2={y}
                className="progress-line-grid"
              />
              <text x={margin.left - 10} y={y + 4} textAnchor="end" className="progress-line-y-label">
                {tick}
              </text>
            </g>
          );
        })}

        <line
          x1={margin.left}
          y1={margin.top}
          x2={margin.left}
          y2={height - margin.bottom}
          className="progress-line-axis"
        />
        <line
          x1={margin.left}
          y1={height - margin.bottom}
          x2={width - margin.right}
          y2={height - margin.bottom}
          className="progress-line-axis"
        />

        {bars.map((bar) => (
          <g key={bar.name}>
            <rect
              x={bar.x}
              y={bar.y}
              width={barWidth}
              height={bar.barHeight}
              rx="8"
              className="progress-bar-rect"
              style={{ fill: sessionBarColor(bar.accuracy) }}
            />
            <text x={bar.centerX} y={height - margin.bottom + 18} textAnchor="end" className="progress-line-x-label" transform={`rotate(-35 ${bar.centerX} ${height - margin.bottom + 18})`}>
              {bar.name}
            </text>
            <text x={bar.centerX} y={bar.y - 10} textAnchor="middle" className="progress-line-point-label">
              {Number(bar.accuracy || 0).toFixed(1)}%
            </text>
          </g>
        ))}
      </svg>
      <div className="progress-line-axis-title">Accuracy</div>
    </div>
  );
}

function SessionCard({
  session,
  selected,
  isEditing,
  draftName,
  saving,
  menuOpen,
  onSelect,
  onTitleClick,
  onDraftNameChange,
  onRenameSubmit,
  onRenameCancel,
  onToggleMenu,
  onDelete,
}) {
  return (
    <div
      className={`card progress-session-card${selected ? ' selected' : ''}`}
      onClick={() => onSelect(session)}
    >
      <button
        type="button"
        className="progress-session-menu-trigger"
        aria-label={`Open actions for ${session.name}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMenu(session.id);
        }}
      >
        ...
      </button>
      {menuOpen ? (
        <div
          className="progress-session-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="progress-session-menu-item danger"
            onClick={() => onDelete(session.id)}
          >
            Delete session
          </button>
        </div>
      ) : null}
      <div className="progress-session-header">
        <div className="progress-session-title-block">
          {isEditing ? (
            <input
              className="progress-session-rename"
              value={draftName}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onDraftNameChange(e.target.value)}
              onBlur={onRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameSubmit();
                if (e.key === 'Escape') onRenameCancel();
              }}
            />
          ) : (
            <button
              type="button"
              className="progress-session-title"
              onClick={(e) => {
                e.stopPropagation();
                onTitleClick(session);
              }}
            >
              {session.name}
            </button>
          )}
          <div className="progress-session-meta">
            <span>{formatSessionDateTime(session.startedAt)}</span>
            <span>{formatDuration(session.actualDuration)}</span>
            <span>{session.totalScored} trials</span>
            {saving ? <span>Saving…</span> : null}
          </div>
        </div>
        <AccuracyRing accuracy={session.overallAccuracy} />
      </div>
    </div>
  );
}

function SessionDetailContent({ session }) {
  return (
    <>
      <div className="progress-session-detail-header">
        <div>
          <div className="dashboard-card-title">Per-Session Accuracy</div>
          <h3 className="progress-session-detail-title">{session.name}</h3>
          <div className="progress-session-detail-meta">
            <span>{formatSessionDateTime(session.startedAt)}</span>
            <span>{formatDuration(session.actualDuration)}</span>
          </div>
        </div>
        <AccuracyRing accuracy={session.overallAccuracy} />
      </div>

      <div className="progress-session-table">
        <div className="progress-session-summary">
          <div className="progress-session-stat">
            <span className="progress-session-stat-value">{session.correct}</span>
            <span className="progress-session-stat-label">Correct</span>
          </div>
          <div className="progress-session-stat">
            <span className="progress-session-stat-value">{session.incorrect}</span>
            <span className="progress-session-stat-label">Incorrect</span>
          </div>
          <div className="progress-session-stat">
            <span className="progress-session-stat-value">{session.skipped}</span>
            <span className="progress-session-stat-label">Skipped</span>
          </div>
        </div>
        {session.gestures.length > 0 ? (
          <>
            <SessionAccuracyBarGraph gestures={session.gestures} />
            <div className="progress-session-legend">
              {[...session.gestures]
                .sort((a, b) => a.accuracy - b.accuracy)
                .map((gesture) => (
                  <div key={gesture.name} className="progress-session-legend-row">
                    <span className="progress-session-legend-name">{gesture.name}</span>
                    <span className="progress-session-legend-value" style={{ color: sessionBarColor(gesture.accuracy) }}>
                      {Number(gesture.accuracy || 0).toFixed(1)}%
                    </span>
                    <span>{gesture.correct} correct</span>
                    <span>{gesture.incorrect} incorrect</span>
                    <span>{gesture.skipped} skipped</span>
                  </div>
                ))}
            </div>
          </>
        ) : (
          <div className="dash-empty">No gesture-level practice data was recorded for this session.</div>
        )}
      </div>
    </>
  );
}

function ProgressPage({ user, isActive = false }) {
  const SESSIONS_PER_PAGE = 5;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [savingSessionId, setSavingSessionId] = useState(null);
  const [error, setError] = useState('');
  const [menuSessionId, setMenuSessionId] = useState(null);
  const [sessionPage, setSessionPage] = useState(1);
  const [showGestures, setShowGestures] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [printMode, setPrintMode] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportOptions, setExportOptions] = useState(DEFAULT_EXPORT_OPTIONS);
  const clickStateRef = useRef({ sessionId: null, timestamp: 0 });
  const printRestoreRef = useRef(null);

  useEffect(() => {
    if (!user?.id || !isActive) return;
    setLoading(true);
    setError('');
    fetch(`${API}/api/progress/${user.id}`)
      .then(async (r) => {
        const payload = await r.json();
        if (!r.ok) throw new Error(payload.error || 'Failed to load progress');
        return payload;
      })
      .then((payload) => {
        setData(payload);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [user?.id, isActive]);

  const visibleSessions = (data?.sessions || []).filter((session) => {
    const searchLower = search.trim().toLowerCase();
    const sessionDateKey = formatSessionDateKey(session.startedAt);
    const matchesText = !searchLower
      || session.name.toLowerCase().includes(searchLower)
      || formatSessionDateTime(session.startedAt).toLowerCase().includes(searchLower);
    const matchesDate = !selectedDate || sessionDateKey === selectedDate;
    return matchesText && matchesDate;
  });

  const totalSessionPages = Math.max(1, Math.ceil(visibleSessions.length / SESSIONS_PER_PAGE));
  const paginatedSessions = printMode
    ? visibleSessions
    : visibleSessions.slice(
        (sessionPage - 1) * SESSIONS_PER_PAGE,
        sessionPage * SESSIONS_PER_PAGE,
      );
  const lowestAccuracyGesture = [...(data?.gestures || [])]
    .filter((gesture) => gesture.isUnlocked)
    .sort((a, b) => a.accuracy - b.accuracy)[0] || null;
  const visibleExportOptions = printMode ? (printRestoreRef.current?.exportOptions || exportOptions) : DEFAULT_EXPORT_OPTIONS;

  const selectedSession = (data?.sessions || []).find((session) => session.id === selectedSessionId) || null;

  useEffect(() => {
    setSessionPage(1);
  }, [search, selectedDate, user?.id, isActive]);

  useEffect(() => {
    if (sessionPage > totalSessionPages) {
      setSessionPage(totalSessionPages);
    }
  }, [sessionPage, totalSessionPages]);

  useEffect(() => {
    const handleAfterPrint = () => {
      const restore = printRestoreRef.current;
      if (!restore) return;
      setShowGestures(restore.showGestures);
      setShowSessions(restore.showSessions);
      setSelectedSessionId(restore.selectedSessionId);
      setPrintMode(false);
      setShowExportModal(false);
      printRestoreRef.current = null;
    };

    window.addEventListener('afterprint', handleAfterPrint);
    return () => window.removeEventListener('afterprint', handleAfterPrint);
  }, []);

  const startRename = (session) => {
    setEditingSessionId(session.id);
    setDraftName(session.name);
    setMenuSessionId(null);
  };

  const handleSelectSession = (session) => {
    setMenuSessionId(null);
    setSelectedSessionId(session.id);
  };

  const handleTitleClick = (session) => {
    if (editingSessionId === session.id) return;
    const now = Date.now();
    const prior = clickStateRef.current;
    if (prior.sessionId === session.id && now - prior.timestamp >= RENAME_DELAY_MS) {
      startRename(session);
      clickStateRef.current = { sessionId: null, timestamp: 0 };
      return;
    }
    clickStateRef.current = { sessionId: session.id, timestamp: now };
  };

  const handleRenameSubmit = async () => {
    if (!editingSessionId || !user?.id) return;
    const trimmed = draftName.trim();
    const current = (data?.sessions || []).find((session) => session.id === editingSessionId);
    if (!trimmed || !current) {
      setEditingSessionId(null);
      setDraftName('');
      return;
    }
    if (trimmed === current.name) {
      setEditingSessionId(null);
      setDraftName('');
      return;
    }

    setSavingSessionId(editingSessionId);
    setError('');
    try {
      const res = await fetch(`${API}/api/progress/sessions/${editingSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, sessionName: trimmed }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Rename failed');
      setData((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) => (
          session.id === editingSessionId ? { ...session, name: payload.sessionName } : session
        )),
      }));
      setEditingSessionId(null);
      setDraftName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSessionId(null);
    }
  };

  const handleRenameCancel = () => {
    setEditingSessionId(null);
    setDraftName('');
  };

  const handleToggleMenu = (sessionId) => {
    setMenuSessionId((prev) => (prev === sessionId ? null : sessionId));
  };

  const handleDeleteSession = async (sessionId) => {
    if (!user?.id) return;
    setMenuSessionId(null);
    setError('');
    try {
      const res = await fetch(`${API}/api/progress/sessions/${sessionId}?userId=${user.id}`, {
        method: 'DELETE',
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Delete failed');
      setData((prev) => ({
        ...prev,
        totalSessions: Math.max(0, prev.totalSessions - 1),
        sessions: prev.sessions.filter((session) => session.id !== sessionId),
      }));
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const openExportModal = () => {
    setShowExportModal(true);
  };

  const handleExportOptionChange = (key) => {
    setExportOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleDownloadPdf = () => {
    printRestoreRef.current = {
      showGestures,
      showSessions,
      exportOptions,
      selectedSessionId,
    };
    setShowGestures(Boolean(exportOptions.gestures));
    setShowSessions(Boolean(exportOptions.sessions));
    if (!exportOptions.sessionSummary) {
      setSelectedSessionId(null);
    }
    setPrintMode(true);
    setShowExportModal(false);
    window.setTimeout(() => window.print(), 100);
  };

  useEffect(() => {
    if (!isActive || !user?.id) return;
    loadData();
  }, [isActive, user?.id]);

  const visibleGestures = useMemo(
    () => (data?.gestures || []).filter((g) => g.isUnlocked || g.totalTested > 0 || g.correct > 0 || g.incorrect > 0 || g.skipped > 0),
    [data]
  );

  const visibleSessions = useMemo(() => {
    const text = search.trim().toLowerCase();
    return (data?.sessions || []).filter((session) => {
      const matchesText = !text
        || (session.name || '').toLowerCase().includes(text)
        || formatSessionDateTime(session.startedAt).toLowerCase().includes(text);
      const matchesDate = !selectedDate || formatSessionDateKey(session.startedAt) === selectedDate;
      return matchesText && matchesDate;
    });
  }, [data?.sessions, search, selectedDate]);

  const handleRenameSession = async (sessionId, sessionName) => {
    if (!user?.id || !sessionName.trim()) return;
    await fetch(`${API}/api/progress/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, sessionName }),
    });
    loadData();
  };

  const handleDeleteSession = async (sessionId, sessionName) => {
    if (!user?.id) return;
    if (!window.confirm(`Delete session "${sessionName}"?`)) return;
    await fetch(`${API}/api/progress/sessions/${sessionId}?userId=${user.id}`, {
      method: 'DELETE',
    });
    loadData();
  };

  if (loading) {
    return <div className="dashboard-page"><p className="dash-loading">Loading…</p></div>;
  }

  if (error && !data) {
    return (
      <div className="dashboard-page">
        <p className="dash-loading">{error}</p>
      </div>
    );
  }

  if (!data) {
    return <div className="dashboard-page"><p className="dash-loading">Could not load progress data.</p></div>;
  }

  return (
    <div className="dashboard-page">
      <div className="progress-page-actions">
        <button
          type="button"
          className="btn progress-download-btn"
          onClick={openExportModal}
        >
          Download PDF
        </button>
      </div>

      {(visibleExportOptions.callout && lowestAccuracyGesture) ? (
        <div className="card progress-callout-card">
          <div className="progress-callout-title">
            Almost there! Improvement can be made to {lowestAccuracyGesture.name.toUpperCase()}.
          </div>
          <div className="progress-callout-subtitle progress-callout-gesture-line">
            {lowestAccuracyGesture.name.toUpperCase()} gesture:
          </div>
          <div className="progress-callout-subtitle">
            • Issue: always misclassified as {(lowestAccuracyGesture.mostMisclassifiedAs || 'Unknown').toUpperCase()}
          </div>
          <div className="progress-callout-subtitle">
            • Tip: {GESTURE_TIPS[lowestAccuracyGesture.name] || 'Hold the gesture clearly and steadily for 1–2 seconds.'}
          </div>
        </div>
      ) : null}

      {visibleExportOptions.summary && (
        <div className="dash-stats-row">
          <button
            type="button"
            className={`card dash-stat-card progress-toggle-card${showGestures ? ' progress-toggle-card-active' : ''}`}
            onClick={() => setShowGestures((prev) => !prev)}
          >
            <div className="dash-stat-label">Avg Gesture Accuracy</div>
            <div className="dash-stat-value">{(data.averageGestureAccuracy || 0).toFixed(1)}%</div>
          </button>
          <button
            type="button"
            className={`card dash-stat-card progress-toggle-card${showSessions ? ' progress-toggle-card-active' : ''}`}
            onClick={() => setShowSessions((prev) => !prev)}
          >
            <div className="dash-stat-label">Practice Sessions</div>
            <div className="dash-stat-value">{data.totalSessions}</div>
          </button>
        </div>
      )}

      {(visibleExportOptions.gestures && showGestures) && data.gestures.filter((g) => g.isUnlocked).length > 0 && (
        <div className="progress-cards-grid">
          {visibleGestures.map((g) => (
            <GestureCard key={g.gestureId} g={g} />
          ))}
        </div>
      )}

      {(visibleExportOptions.sessions && showSessions) && (
        <div className="card progress-sessions-shell">
          <div className="dashboard-card-title">Practice Sessions</div>
          <div className="progress-toolbar">
            <input
              className="progress-filter-input"
              type="search"
              placeholder="Filter by session name or time"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <input
              className="progress-filter-input"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </div>
          <div className="progress-filter-hint">
            Times are shown in Vancouver time. To rename, double click on the name.
          </div>
          {error ? <div className="progress-inline-error">{error}</div> : null}

          {visibleSessions.length === 0 ? (
            <p className="dash-empty">No practice sessions match those filters.</p>
          ) : (
            <>
              <div className="progress-session-list">
                {paginatedSessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSession?.id}
                    isEditing={session.id === editingSessionId}
                    draftName={draftName}
                    saving={session.id === savingSessionId}
                    menuOpen={session.id === menuSessionId}
                    onSelect={handleSelectSession}
                    onTitleClick={handleTitleClick}
                    onDraftNameChange={setDraftName}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    onToggleMenu={handleToggleMenu}
                    onDelete={handleDeleteSession}
                  />
                ))}
              </div>
              {totalSessionPages > 1 ? (
                <div className="admin-pagination">
                  <button
                    className="admin-pagination-arrow"
                    type="button"
                    onClick={() => setSessionPage((prev) => Math.max(1, prev - 1))}
                    disabled={sessionPage === 1}
                    aria-label="Previous sessions page"
                  >
                    ←
                  </button>
                  <div className="admin-pagination-pages">
                    {Array.from({ length: totalSessionPages }, (_, index) => {
                      const page = index + 1;
                      return (
                        <button
                          key={page}
                          type="button"
                          className={`admin-pagination-page${sessionPage === page ? ' admin-pagination-page-active' : ''}`}
                          onClick={() => setSessionPage(page)}
                        >
                          {page}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="admin-pagination-arrow"
                    type="button"
                    onClick={() => setSessionPage((prev) => Math.min(totalSessionPages, prev + 1))}
                    disabled={sessionPage === totalSessionPages}
                    aria-label="Next sessions page"
                  >
                    →
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      {visibleExportOptions.graph && <ProgressTrendGraph sessions={data.sessions || []} />}

      {(printMode && visibleExportOptions.sessionSummary) && (
        <div className="progress-print-session-list">
          {visibleSessions.map((session) => (
            <div key={session.id} className="card progress-print-session-card">
              <SessionDetailContent session={session} />
            </div>
          ))}
        </div>
      )}

      {showExportModal && (
        <div className="live-popup-overlay" onClick={() => setShowExportModal(false)}>
          <div className="card live-popup progress-export-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="live-popup-title">Choose PDF Sections</h3>
            <p className="live-popup-subtitle">Select what you want to include in the PDF export.</p>
            <div className="progress-export-options">
              {[
                ['callout', 'Improvement Callout'],
                ['summary', 'Top Summary Cards'],
                ['gestures', 'Per Gesture Accuracy'],
                ['sessions', 'Practice Sessions'],
                ['sessionSummary', 'Per Session Summary'],
                ['graph', 'Progressing Graph'],
              ].map(([key, label]) => (
                <label key={key} className="progress-export-option">
                  <input
                    type="checkbox"
                    checked={Boolean(exportOptions[key])}
                    onChange={() => handleExportOptionChange(key)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="live-popup-actions">
              <button className="btn live-popup-btn-cancel" onClick={() => setShowExportModal(false)}>
                Cancel
              </button>
              <button className="btn live-popup-btn-confirm" onClick={handleDownloadPdf}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedSession ? (
        <div
          className="progress-session-modal-backdrop"
          onClick={() => setSelectedSessionId(null)}
        >
          <div
            className="card progress-session-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="progress-session-modal-close"
              aria-label="Close session details"
              onClick={() => setSelectedSessionId(null)}
            >
              <span aria-hidden="true" className="progress-session-modal-close-icon">×</span>
            </button>
            <SessionDetailContent session={selectedSession} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default ProgressPage;
