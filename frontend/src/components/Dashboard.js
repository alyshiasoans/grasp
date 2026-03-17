import React, { useState, useEffect } from 'react';

const API = 'http://localhost:5050';

function Dashboard({ connected, user, onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    setLoading(true);
    fetch(`${API}/api/dashboard/${user.id}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user?.id]);

  if (loading) {
    return (
      <div className="dashboard-page">
        <h2 className="page-title">Dashboard</h2>
        <p className="dash-loading">Loading…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="dashboard-page">
        <h2 className="page-title">Dashboard</h2>
        <p className="dash-loading">Could not load dashboard data.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <h2 className="page-title">Welcome back, {user?.firstName}!</h2>

      {/* Stat cards row */}
      <div className="dash-stats-row">
        <div className="card dash-stat-card">
          <div className="dash-stat-value">{data.streak}</div>
          <div className="dash-stat-label">Day Streak 🔥</div>
        </div>
        <div className="card dash-stat-card">
          <div className="dash-stat-value">{data.overallAccuracy}%</div>
          <div className="dash-stat-label">Overall Accuracy</div>
        </div>
        <div className="card dash-stat-card">
          <div className="dash-stat-value">{data.gesturesTrained}</div>
          <div className="dash-stat-label">Gestures Trained</div>
        </div>
        <div className="card dash-stat-card">
          <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          <div className="dash-stat-label">{connected ? 'Device Connected' : 'Disconnected'}</div>
        </div>
      </div>

      {/* Suggestions */}
      {data.suggestions.length > 0 && (
        <div className="card dash-suggestions-card">
          <h3 className="dashboard-card-title">Suggestions</h3>
          <ul className="dash-suggestion-list">
            {data.suggestions.map((s, i) => (
              <li key={i} className="dash-suggestion-item">{s}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-gesture accuracy */}
      <div className="card dash-gestures-card">
        <h3 className="dashboard-card-title">Per-Gesture Accuracy KATE</h3>
        {data.gestures.filter((g) => g.isUnlocked).length === 0 ? (
          <p className="dash-empty">No gestures unlocked yet. Start training to unlock gestures!</p>
        ) : (
          <div className="dash-gesture-grid">
            {data.gestures
              .filter((g) => g.isUnlocked)
              .map((g) => (
                <div key={g.gestureId} className="dash-gesture-row">
                  <div className="dash-gesture-info">
                    <span className="dash-gesture-name">{g.name}</span>
                    <span className="dash-gesture-meta">
                      {g.totalTested > 0
                        ? `${g.correct}/${g.correct + g.incorrect} correct`
                        : 'Not tested yet'}
                    </span>
                  </div>
                  <div className="dash-gesture-bar-wrap">
                    <div className="dash-gesture-bar">
                      <div
                        className="dash-gesture-bar-fill"
                        style={{
                          width: `${g.accuracy}%`,
                          background:
                            g.accuracy >= 80 ? '#34c759' : g.accuracy >= 50 ? '#ffd740' : '#ff4081',
                        }}
                      />
                    </div>
                    <span className="dash-gesture-pct">{g.accuracy}%</span>
                  </div>
                  {g.needsRetraining && (
                    <span className="dash-retrain-badge">Needs Retrain</span>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Recent sessions */}
      {data.recentSessions.length > 0 && (
        <div className="card dash-recent-card">
          <h3 className="dashboard-card-title">Recent Sessions</h3>
          <div className="dash-session-list">
            {data.recentSessions.map((s) => (
              <div key={s.id} className="dash-session-row">
                <span className={`dash-session-type ${s.type}`}>{s.type}</span>
                <span className="dash-session-status">{s.status}</span>
                <span className="dash-session-date">
                  {s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '—'}
                </span>
                {s.duration != null && (
                  <span className="dash-session-dur">{Math.round(s.duration)}s</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Practice button */}
      <button className="btn btn-start dash-practice-btn" onClick={() => onNavigate('testing')}>
        ▶ Start Practice Session
      </button>
    </div>
  );
}

export default Dashboard;
