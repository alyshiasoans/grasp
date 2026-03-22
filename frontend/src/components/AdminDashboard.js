import React, { useState, useEffect } from 'react';

const API = 'http://localhost:5050';

function AdminDashboard({ user }) {
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [progress, setProgress] = useState(null);
  const [trainingFiles, setTrainingFiles] = useState([]);
  const [loading, setLoading] = useState(false);

  // Load all users on mount
  useEffect(() => {
    fetch(`${API}/api/admin/users`)
      .then((r) => r.json())
      .then((data) => setUsers(data))
      .catch(() => {});
  }, []);

  // Load selected user's progress + training files
  useEffect(() => {
    if (!selectedUserId) { setProgress(null); setTrainingFiles([]); return; }
    setLoading(true);
    Promise.all([
      fetch(`${API}/api/dashboard/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/training-files/${selectedUserId}`).then((r) => r.json()),
    ])
      .then(([dashData, filesData]) => {
        setProgress(dashData);
        setTrainingFiles(filesData);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [selectedUserId]);

  const selectedUser = users.find((u) => u.id === Number(selectedUserId));

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
      </div>

      {loading && <p style={{ textAlign: 'center', color: '#999' }}>Loading…</p>}

      {progress && selectedUser && (
        <>
          {/* Summary row */}
          <div className="admin-summary-row">
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{progress.overallAccuracy}%</div>
              <div className="admin-stat-label">Overall Accuracy</div>
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
            <h3 className="admin-table-title">Gesture Progress for {selectedUser.firstName} {selectedUser.lastName}</h3>
            <table className="admin-gesture-table">
              <thead>
                <tr>
                  <th>Gesture</th>
                  <th>Unlocked</th>
                  <th>Times Trained</th>
                  <th>Times Tested</th>
                  <th>Correct</th>
                  <th>Incorrect</th>
                  <th>Accuracy</th>
                  <th>Avg Confidence</th>
                </tr>
              </thead>
              <tbody>
                {progress.gestures.map((g) => (
                  <tr key={g.gestureId} className={g.isUnlocked ? '' : 'admin-row-locked'}>
                    <td>{g.name}</td>
                    <td>{g.isUnlocked ? '✓' : '✗'}</td>
                    <td>{g.totalTrained}</td>
                    <td>{g.totalTested}</td>
                    <td>{g.correct}</td>
                    <td>{g.incorrect}</td>
                    <td>{g.accuracy}%</td>
                    <td>{g.avgConfidence}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Training files */}
          <div className="card admin-table-card">
            <h3 className="admin-table-title">Training Files ({trainingFiles.length})</h3>
            {trainingFiles.length === 0 ? (
              <p style={{ color: '#999', fontSize: '0.9rem' }}>No training files found.</p>
            ) : (
              <table className="admin-gesture-table">
                <thead>
                  <tr>
                    <th>File Name</th>
                    <th>Samples</th>
                    <th>Gestures</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {trainingFiles.map((f) => (
                    <tr key={f.id}>
                      <td>{f.fileName}</td>
                      <td>{f.numSamples || '—'}</td>
                      <td>{f.gestures.length > 0 ? f.gestures.join(', ') : '—'}</td>
                      <td>{f.createdAt ? new Date(f.createdAt).toLocaleDateString() : '—'}</td>
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
