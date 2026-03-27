import React, { useState, useEffect } from 'react';

const API = 'http://localhost:5050';

function AdminDashboard({ user }) {
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [progress, setProgress] = useState(null);
  const [trainingFiles, setTrainingFiles] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const [training, setTraining] = useState(false);
  const [trainLogs, setTrainLogs] = useState([]);

  // Load all users on mount
  useEffect(() => {
    fetch(`${API}/api/admin/users`)
      .then((r) => r.json())
      .then((data) => setUsers(data))
      .catch(() => {});
  }, []);

  // Load selected user's progress + training files + models
  useEffect(() => {
    if (!selectedUserId) { setProgress(null); setTrainingFiles([]); setModels([]); setSelectedFileIds([]); setTrainLogs([]); return; }
    setLoading(true);
    Promise.all([
      fetch(`${API}/api/dashboard/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/training-files/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/models/${selectedUserId}`).then((r) => r.json()),
    ])
      .then(([dashData, filesData, modelsData]) => {
        setProgress(dashData);
        setTrainingFiles(filesData);
        setModels(modelsData);
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

  const toggleFileSelection = (fileId) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  const selectAllFiles = () => {
    const matFiles = trainingFiles.filter((f) => f.fileName.endsWith('.mat'));
    if (selectedFileIds.length === matFiles.length) {
      setSelectedFileIds([]);
    } else {
      setSelectedFileIds(matFiles.map((f) => f.id));
    }
  };

  const handleTrainModel = () => {
    if (selectedFileIds.length === 0) return;
    setTraining(true);
    setTrainLogs([]);
    fetch(`${API}/api/admin/train-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: Number(selectedUserId), trainingFileIds: selectedFileIds }),
    })
      .then((r) => r.json())
      .then((data) => {
        setTrainLogs(data.logs || []);
        setTraining(false);
        if (data.modelId) {
          // Refresh models list
          fetch(`${API}/api/admin/models/${selectedUserId}`)
            .then((r) => r.json())
            .then((modelsData) => setModels(modelsData))
            .catch(() => {});
        }
      })
      .catch((err) => {
        setTrainLogs([`Error: ${err.message}`]);
        setTraining(false);
      });
  };

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
                  <th>Times Trained</th>
                  <th>Times Tested</th>
                  <th>Accuracy</th>
                  <th>Avg Confidence</th>
                </tr>
              </thead>
              <tbody>
                {progress.gestures.filter((g) => g.isUnlocked).map((g) => (
                  <tr key={g.gestureId}>
                    <td>{g.name}</td>
                    <td>{g.totalTrained}</td>
                    <td>{g.totalTested}</td>
                    <td>{g.accuracy}%</td>
                    <td>{g.avgConfidence}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Training files */}
          <div className="card admin-table-card">
            <h3 className="admin-table-title">Training Files</h3>
            {trainingFiles.length === 0 ? (
              <p style={{ color: '#999', fontSize: '0.9rem' }}>No training files found.</p>
            ) : (
              <>
                <table className="admin-gesture-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}></th>
                      <th>File Name</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trainingFiles.map((f) => {
                      const isMat = f.fileName.endsWith('.mat');
                      return (
                        <tr
                          key={f.id}
                          className={`${selectedFileIds.includes(f.id) ? 'admin-row-active' : ''}${isMat ? ' admin-row-clickable' : ''}`}
                          onClick={() => isMat && toggleFileSelection(f.id)}
                        >
                          <td style={{ textAlign: 'center' }}>
                            {isMat ? (
                              <input
                                type="checkbox"
                                className="admin-checkbox"
                                checked={selectedFileIds.includes(f.id)}
                                onChange={() => toggleFileSelection(f.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : null}
                          </td>
                          <td>{f.fileName}</td>
                          <td>{f.createdAt ? new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    className="admin-set-active-btn"
                    disabled={selectedFileIds.length === 0 || training}
                    onClick={handleTrainModel}
                  >
                    {training ? 'Training…' : 'Train'}
                  </button>
                  {selectedFileIds.length === 0 && (
                    <span style={{ color: '#999', fontSize: '0.85rem' }}>Select .mat files to train on</span>
                  )}
                </div>
                {trainLogs.length > 0 && (
                  <div className="admin-train-logs">
                    {trainLogs.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                )}
              </>
            )}
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
