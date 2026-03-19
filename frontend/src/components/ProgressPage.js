import React, { useState, useEffect } from 'react';

const API = 'http://localhost:5050';

function GestureCard({ g }) {
  const [expanded, setExpanded] = useState(false);
  const acc = Math.round(g.accuracy);
  const accentColor = acc >= 80 ? '#34c759' : acc >= 50 ? '#ffd740' : '#ff4081';

  // SVG circular progress ring
  const radius = 52;
  const stroke = 6;
  const normalizedRadius = radius - stroke / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (acc / 100) * circumference;

  return (
    <div
      className="card progress-gesture-card"
      onClick={() => setExpanded(!expanded)}
    >
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
        <div className="progress-ring-text">{acc}%</div>
      </div>
      {expanded && (
        <div className="progress-gesture-details">
          <div className="progress-gesture-stat">
            <span className="progress-stat-value">{g.totalTrained}</span>
            <span className="progress-stat-label">Trained</span>
          </div>
          <div className="progress-gesture-stat">
            <span className="progress-stat-value">{g.totalTested}</span>
            <span className="progress-stat-label">Tested</span>
          </div>
          <div className="progress-gesture-stat">
            <span className="progress-stat-value">{g.correct}</span>
            <span className="progress-stat-label">Correct</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressPage({ user }) {
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
        <p className="dash-loading">Loading…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="dashboard-page">
        <p className="dash-loading">Could not load progress data.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      {/* Individual gesture cards */}
      {data.gestures.filter((g) => g.isUnlocked).length > 0 && (
        <div className="progress-cards-grid">
          {data.gestures
            .filter((g) => g.isUnlocked)
            .map((g) => (
              <GestureCard key={g.gestureId} g={g} />
            ))}
        </div>
      )}
    </div>
  );
}

export default ProgressPage;
