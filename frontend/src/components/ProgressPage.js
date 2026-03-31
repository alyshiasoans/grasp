import React, { useEffect, useMemo, useState } from 'react';

const API = 'http://localhost:5050';

function AccuracyRing({ accuracy, size = 54, stroke = 5 }) {
  const acc = Math.round(accuracy || 0);
  const accentColor = acc >= 80 ? '#34c759' : acc >= 50 ? '#ffd740' : '#ff4081';
  const radius = size / 2;
  const normalizedRadius = radius - stroke / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (acc / 100) * circumference;

  return (
    <div className="progress-ring-wrap">
      <svg height={size} width={size} className="progress-ring-svg">
        <circle stroke="#eef0f4" fill="transparent" strokeWidth={stroke} r={normalizedRadius} cx={radius} cy={radius} />
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
      <div className="progress-ring-text">{acc}%</div>
    </div>
  );
}

function GestureCard({ g }) {
  const [expanded, setExpanded] = useState(false);
  const acc = Math.round(g.averageAccuracy ?? g.accuracy ?? 0);

  return (
    <div className="card progress-gesture-card" onClick={() => setExpanded((prev) => !prev)}>
      <h4 className="progress-gesture-name">{g.name}</h4>
      <AccuracyRing accuracy={acc} size={104} stroke={6} />
      {expanded && (
        <div className="progress-gesture-details">
          <div className="progress-gesture-stat">
            <span className="progress-stat-value">{g.totalTested}</span>
            <span className="progress-stat-label">Tested</span>
          </div>
          <div className="progress-gesture-stat">
            <span className="progress-stat-value">{g.correct}</span>
            <span className="progress-stat-label">Correct</span>
          </div>
          <div className="progress-gesture-stat">
            <span className="progress-stat-value">{g.incorrect}</span>
            <span className="progress-stat-label">Incorrect</span>
          </div>
          {g.misclassifiedAs?.length > 0 && (
            <div className="progress-misclass-list">
              {g.misclassifiedAs.map((item) => (
                <div key={`${g.name}-${item.name}`} className="progress-misclass-item">
                  Misclassified as {item.name}: {item.count}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionCard({ session, userId, onRename, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [draftName, setDraftName] = useState(session.name || '');

  useEffect(() => {
    setDraftName(session.name || '');
  }, [session.name]);

  return (
    <div className="card progress-session-card">
      <div className="progress-session-top">
        <div className="progress-session-name-wrap">
          <input
            className="training-text-input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
          />
          <div className="progress-session-meta">
            {session.startedAt ? new Date(session.startedAt).toLocaleString() : 'Unknown date'} · {session.overallAccuracy}% accuracy
          </div>
        </div>
        <div className="progress-session-overall">
          <div className="progress-session-overall-label">Overall</div>
          <AccuracyRing accuracy={session.overallAccuracy} size={88} stroke={6} />
        </div>
        <div className="progress-session-actions">
          <button className="btn admin-status-inactive" onClick={() => onRename(session.id, draftName)}>
            Save Name
          </button>
          <button className="training-danger-btn" onClick={() => onDelete(session.id, session.name)}>
            Delete
          </button>
          <button className="btn admin-status-inactive" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? 'Hide' : 'Details'}
          </button>
        </div>
      </div>

        <div className="progress-session-summary">
          <span>Correct {session.correct}</span>
          <span>Incorrect {session.incorrect}</span>
          <span>Skipped {session.skipped}</span>
        </div>

      {expanded && (
        <div className="progress-session-details">
          {session.gestures.map((gesture) => (
            <div key={`${session.id}-${gesture.name}`} className="progress-session-gesture">
              <div className="progress-session-gesture-head progress-session-gesture-row">
                <div>
                  <strong>{gesture.name}</strong>
                  <div className="progress-session-gesture-meta">
                    Correct {gesture.correct} · Incorrect {gesture.incorrect} · Skipped {gesture.skipped}
                  </div>
                </div>
                <AccuracyRing accuracy={gesture.accuracy} />
              </div>
              {gesture.misclassifiedAs?.length > 0 && (
                <div className="progress-misclass-list">
                  {gesture.misclassifiedAs.map((item) => (
                    <div key={`${session.id}-${gesture.name}-${item.name}`} className="progress-misclass-item">
                      Misclassified as {item.name}: {item.count}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressPage({ user }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadData = async (searchValue = search) => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/progress/${user.id}?search=${encodeURIComponent(searchValue)}`);
      const next = await res.json();
      setData(next);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData('');
  }, [user?.id]);

  const visibleGestures = useMemo(
    () => (data?.gestures || []).filter((g) => g.isUnlocked || g.totalTested > 0 || g.correct > 0 || g.incorrect > 0 || g.skipped > 0),
    [data]
  );

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

  if (!data) {
    return <div className="dashboard-page"><p className="dash-loading">Could not load progress data.</p></div>;
  }

  return (
    <div className="dashboard-page">
      <div className="dash-stats-row">
        <div className="card dash-stat-card">
          <div className="dash-stat-value">{data.overallAccuracy}%</div>
          <div className="dash-stat-label">Overall Accuracy</div>
        </div>
        <div className="card dash-stat-card">
          <div className="dash-stat-value">{data.totalSessions}</div>
          <div className="dash-stat-label">Testing Sessions</div>
        </div>
      </div>

      {visibleGestures.length > 0 && (
        <div className="progress-cards-grid">
          {visibleGestures.map((g) => (
            <GestureCard key={g.gestureId} g={g} />
          ))}
        </div>
      )}

      <div className="card progress-history-card">
        <div className="training-card-header">
          <div>
            <h3 className="training-card-title">Testing Sessions</h3>
            <p className="training-card-subtitle">Search by session name or by date text, rename sessions, inspect misclassifications, or delete sessions.</p>
          </div>
        </div>

        <div className="progress-search-row">
          <input
            className="training-text-input"
            placeholder="Search by session name or date"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn admin-set-active-btn" onClick={() => loadData(search)}>
            Search
          </button>
        </div>

        <div className="progress-session-list">
          {data.sessions.length === 0 ? (
            <p className="training-empty-text">No matching sessions found.</p>
          ) : (
            data.sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                userId={user.id}
                onRename={handleRenameSession}
                onDelete={handleDeleteSession}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default ProgressPage;
