import React, { useState, useEffect } from 'react';

const API = 'http://localhost:5050';

function AdminDashboard({ user }) {
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedMode, setSelectedMode] = useState('simulated');
  const [progress, setProgress] = useState(null);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [gestureUnlocks, setGestureUnlocks] = useState([]);

  // Load all users on mount
  useEffect(() => {
    fetch(`${API}/api/admin/users`)
      .then((r) => r.json())
      .then((data) => setUsers(data))
      .catch(() => {});
  }, []);

  // Load selected user's progress + models
  useEffect(() => {
    if (!selectedUserId) { setProgress(null); setModels([]); setGestureUnlocks([]); return; }
    setLoading(true);
    Promise.all([
      fetch(`${API}/api/dashboard/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/models/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/gestures/${selectedUserId}`).then((r) => r.json()),
    ])
      .then(([dashData, modelsData, gesturesData]) => {
        setProgress(dashData);
        setModels(modelsData);
        setGestureUnlocks(gesturesData);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [selectedUserId]);

  const handleSetActiveModel = (modelId) => {
    fetch(`${API}/api/admin/models/${selectedUserId}/set-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    })
      .then((r) => r.json())
      .then(() => {
        setModels((prev) =>
          prev.map((m) => ({ ...m, isActive: m.id === modelId }))
        );
      })
      .catch(() => {});
  };

  const selectedUser = users.find((u) => u.id === Number(selectedUserId));
  const modeLabel = selectedMode === 'live' ? 'Live EMG' : 'Simulated';
  const modeAccuracy = selectedMode === 'live' ? (progress?.liveAccuracy ?? 0) : (progress?.simulatedAccuracy ?? 0);
  const modeTested = (progress?.gestures || []).reduce(
    (sum, g) => sum + (selectedMode === 'live' ? (g.liveTested || 0) : (g.simulatedTested || 0)),
    0
  );
  const modeGestures = (progress?.gestures || [])
    .filter((g) => selectedMode === 'simulated' || g.isUnlocked)
    .map((g) => ({
    ...g,
    modeAccuracy: selectedMode === 'live' ? (g.liveAccuracy || 0) : (g.simulatedAccuracy || 0),
    modeTested: selectedMode === 'live' ? (g.liveTested || 0) : (g.simulatedTested || 0),
  }));

  const handleToggleUnlock = (gestureId, currentlyUnlocked) => {
    fetch(`${API}/api/admin/gestures/${selectedUserId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gestureId, unlock: !currentlyUnlocked }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setGestureUnlocks((prev) =>
            prev.map((g) => g.gestureId === gestureId ? { ...g, isUnlocked: data.isUnlocked } : g)
          );
        }
      })
      .catch(() => {});
  };

  return (
    <div className="dashboard-page">
      <div className="card dash-welcome-card">
        <h2 className="dash-welcome-title">Welcome, {user?.firstName}!</h2>
        <p className="dash-welcome-subtitle">Select a user to view their progress.</p>

        <select
          className="admin-user-select"
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
        >
          <option value="">— Select a user —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.firstName} {u.lastName}
            </option>
          ))}
        </select>

        {selectedUserId && (
          <div className="mode-toggle admin-mode-toggle">
            <button
              className={`btn btn-mode ${selectedMode === 'simulated' ? 'active' : ''}`}
              onClick={() => setSelectedMode('simulated')}
            >
              Simulated
            </button>
            <button
              className={`btn btn-mode ${selectedMode === 'live' ? 'active' : ''}`}
              onClick={() => setSelectedMode('live')}
            >
              Live EMG
            </button>
          </div>
        )}
      </div>

      {loading && <p style={{ textAlign: 'center', color: '#999' }}>Loading…</p>}

      {progress && selectedUser && (
        <>
          {/* Summary row */}
          <div className="admin-summary-row">
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{modeAccuracy}%</div>
              <div className="admin-stat-label">{modeLabel} Accuracy</div>
            </div>
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{modeTested}</div>
              <div className="admin-stat-label">{modeLabel} Attempts</div>
            </div>
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{progress.gesturesTrained} / {progress.totalGestures}</div>
              <div className="admin-stat-label">Gestures Trained</div>
            </div>
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{progress.streak}</div>
              <div className="admin-stat-label">Training Streak</div>
            </div>
          </div>

          {/* Gesture table */}
          <div className="card admin-table-card">
            <h3 className="admin-table-title">Gesture Progress for {selectedUser.firstName} {selectedUser.lastName} ({modeLabel})</h3>
            <table className="admin-gesture-table">
              <thead>
                <tr>
                  <th>Gesture</th>
                  <th>Times Trained</th>
                  <th>{modeLabel} Tested</th>
                  <th>{modeLabel} Accuracy</th>
                  <th>Avg Confidence</th>
                </tr>
              </thead>
              <tbody>
                {modeGestures.map((g) => (
                  <tr key={g.gestureId}>
                    <td>{g.name}</td>
                    <td>{g.totalTrained}</td>
                    <td>{g.modeTested}</td>
                    <td>{g.modeAccuracy}%</td>
                    <td>{g.avgConfidence}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Gesture unlock management */}
          <div className="card admin-table-card">
            <h3 className="admin-table-title">Gesture Access</h3>
            <p style={{ color: '#999', fontSize: '0.82rem', marginBottom: '12px' }}>
              Gestures auto-unlock when all unlocked gestures reach {'>'}70% accuracy with {'>'}5 test trials each. You can also toggle manually.
            </p>
            <table className="admin-gesture-table">
              <thead>
                <tr>
                  <th>Gesture</th>
                  <th>Accuracy</th>
                  <th>Trained</th>
                  <th>Tested</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {gestureUnlocks.map((g) => (
                  <tr key={g.gestureId}>
                    <td>{g.name}</td>
                    <td>{g.accuracy}%</td>
                    <td>{g.totalTrained}</td>
                    <td>{g.totalTested}</td>
                    <td style={{ textAlign: 'center' }}>
                      {selectedMode === 'simulated' ? (
                        <span className="admin-status-active">Unlocked</span>
                      ) : g.isUnlocked ? (
                        <button
                          className="admin-status-active"
                          style={{ cursor: 'pointer', border: 'none', background: 'none' }}
                          onClick={() => handleToggleUnlock(g.gestureId, true)}
                          title="Click to lock"
                        >
                          Unlocked
                        </button>
                      ) : (
                        <button
                          className="admin-status-inactive"
                          onClick={() => handleToggleUnlock(g.gestureId, false)}
                          title="Click to unlock"
                        >
                          Locked
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Available models */}
          <div className="card admin-table-card">
            <h3 className="admin-table-title">Available Models</h3>
            {models.length === 0 ? (
              <p style={{ color: '#999', fontSize: '0.9rem' }}>No models found.</p>
            ) : (
              <table className="admin-gesture-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Accuracy</th>
                    <th>File</th>
                    <th>Trained</th>
                    <th style={{ textAlign: 'center' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id}>
                      <td>v{m.versionNumber}</td>
                      <td>{m.accuracy != null ? `${m.accuracy}%` : '—'}</td>
                      <td>{m.filePath || '—'}</td>
                      <td>{m.trainingDate ? new Date(m.trainingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {m.isActive ? (
                          <span className="admin-status-active">Active</span>
                        ) : (
                          <button
                            className="admin-status-inactive"
                            onClick={() => handleSetActiveModel(m.id)}
                          >
                            Inactive
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default AdminDashboard;
