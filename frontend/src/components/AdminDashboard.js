import React, { useState, useEffect } from 'react';
import { API } from '../constants';

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
  const [namePopup, setNamePopup] = useState(null);
  const [popupName, setPopupName] = useState('');
  const [gestureUnlocks, setGestureUnlocks] = useState([]);
  const [expandedModelId, setExpandedModelId] = useState(null);
  const [selectedModelIds, setSelectedModelIds] = useState([]);
  const [filePage, setFilePage] = useState(0);
  const FILES_PER_PAGE = 10;

  // Load all users on mount
  useEffect(() => {
    fetch(`${API}/api/admin/users`)
      .then((r) => r.json())
      .then((data) => setUsers(data))
      .catch(() => {});
  }, []);

  // Load selected user's progress + training files + models
  useEffect(() => {
    if (!selectedUserId) { setProgress(null); setTrainingFiles([]); setModels([]); setSelectedFileIds([]); setTrainLogs([]); setGestureUnlocks([]); setFilePage(0); return; }
    setLoading(true);
    Promise.all([
      fetch(`${API}/api/dashboard/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/training-files/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/models/${selectedUserId}`).then((r) => r.json()),
      fetch(`${API}/api/admin/gestures/${selectedUserId}`).then((r) => r.json()),
    ])
      .then(([dashData, filesData, modelsData, gesturesData]) => {
        setProgress(dashData);
        setTrainingFiles(filesData);
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

  const toggleModelSelection = (modelId) => {
    setSelectedModelIds((prev) =>
      prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]
    );
  };

  const handleDeleteModels = () => {
    if (selectedModelIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedModelIds.length} model(s)? This cannot be undone.`)) return;
    Promise.all(
      selectedModelIds.map((id) =>
        fetch(`${API}/api/admin/models/${id}`, { method: 'DELETE' }).then((r) => r.json())
      )
    ).then(() => {
      setModels((prev) => prev.filter((m) => !selectedModelIds.includes(m.id)));
      if (selectedModelIds.includes(expandedModelId)) setExpandedModelId(null);
      setSelectedModelIds([]);
    }).catch(() => {});
  };

  const toggleFileSelection = (fileId) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  const selectAllFiles = () => {
    const trainableFiles = trainingFiles.filter((f) => f.fileName.endsWith('.mat') || f.fileName.endsWith('.npz'));
    if (selectedFileIds.length === trainableFiles.length) {
      setSelectedFileIds([]);
    } else {
      setSelectedFileIds(trainableFiles.map((f) => f.id));
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
          setNamePopup({ modelId: data.modelId, versionNumber: data.versionNumber });
          setPopupName('');
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

  const handleSaveModelName = () => {
    if (!namePopup) return;
    const trimmed = popupName.trim();
    if (trimmed) {
      fetch(`${API}/api/admin/models/${namePopup.modelId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
        .then((r) => r.json())
        .then(() => {
          setModels((prev) => prev.map((m) => m.id === namePopup.modelId ? { ...m, name: trimmed } : m));
        })
        .catch(() => {});
    }
    setNamePopup(null);
  };

  const selectedUser = users.find((u) => u.id === Number(selectedUserId));

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
            <h3 className="admin-table-title">Gesture Progress</h3>
            <table className="admin-gesture-table">
              <thead>
                <tr>
                  <th>Gesture</th>
                  <th>Times Trained</th>
                  <th>Times Tested</th>
                  <th>Accuracy</th>
                  <th>Avg Confidence</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {gestureUnlocks.map((g) => (
                  <tr key={g.gestureId}>
                    <td>{g.name}</td>
                    <td>{g.totalTrained}</td>
                    <td>{g.totalTested}</td>
                    <td>{g.accuracy}%</td>
                    <td>{g.avgConfidence ?? '—'}%</td>
                    <td style={{ textAlign: 'center' }}>
                      {g.isUnlocked ? (
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

          {/* Training files */}
          <div className="card admin-table-card">
            <h3 className="admin-table-title">Data Files</h3>
            {trainingFiles.length === 0 ? (
              <p style={{ color: '#999', fontSize: '0.9rem' }}>No training files found.</p>
            ) : (
              <>
                <table className="admin-gesture-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}></th>
                      <th>File Name</th>
                      <th>Source</th>
                      <th>Date</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trainingFiles.slice(filePage * FILES_PER_PAGE, (filePage + 1) * FILES_PER_PAGE).map((f) => {
                      const isMat = f.fileName.endsWith('.mat') || f.fileName.endsWith('.npz');
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
                          <td>{f.fileName.startsWith('testing_') ? 'Testing' : 'Training'}</td>
                          <td>{f.createdAt ? new Date(f.createdAt + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                          <td>{f.createdAt ? new Date(f.createdAt + 'Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {trainingFiles.length > FILES_PER_PAGE && (
                  <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', fontSize: '0.85rem' }}>
                    <button
                      className="admin-set-active-btn"
                      style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                      disabled={filePage === 0}
                      onClick={() => setFilePage((p) => p - 1)}
                    >
                      ← Prev
                    </button>
                    <span style={{ color: '#666' }}>
                      {filePage + 1} / {Math.ceil(trainingFiles.length / FILES_PER_PAGE)}
                    </span>
                    <button
                      className="admin-set-active-btn"
                      style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                      disabled={(filePage + 1) * FILES_PER_PAGE >= trainingFiles.length}
                      onClick={() => setFilePage((p) => p + 1)}
                    >
                      Next →
                    </button>
                  </div>
                )}
                <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    className="admin-set-active-btn"
                    disabled={selectedFileIds.length === 0 || training}
                    onClick={handleTrainModel}
                  >
                    {training ? 'Training…' : 'Train'}
                  </button>
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
            <h3 className="admin-table-title">Models</h3>
            {models.length === 0 ? (
              <p style={{ color: '#999', fontSize: '0.9rem' }}>No models found.</p>
            ) : (
              <table className="admin-gesture-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Version</th>
                    <th>Accuracy</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th style={{ textAlign: 'center' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <React.Fragment key={m.id}>
                      <tr
                        className={`${selectedModelIds.includes(m.id) ? 'admin-row-active' : ''} admin-row-clickable`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedModelId(expandedModelId === m.id ? null : m.id)}
                      >
                        <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="admin-checkbox"
                            checked={selectedModelIds.includes(m.id)}
                            onChange={() => toggleModelSelection(m.id)}
                          />
                        </td>
                        <td>
                          {m.name || `v${m.versionNumber}`}
                        </td>
                        <td>{m.accuracy != null ? `${m.accuracy}%` : '—'}</td>
                        <td>{m.trainingDate ? new Date(m.trainingDate + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                        <td>{m.trainingDate ? new Date(m.trainingDate + 'Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'}</td>
                        <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
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
                      {expandedModelId === m.id && (
                        <tr>
                          <td colSpan={6} style={{ padding: '10px 20px 14px', background: 'transparent', borderTop: 'none' }}>
                            <div style={{ fontSize: '0.72rem', color: '#666', fontFamily: 'monospace', letterSpacing: 0.5, marginBottom: 6 }}>
                              TRAINED ON ({m.trainingFiles?.length || 0} files)
                            </div>
                            {m.trainingFiles && m.trainingFiles.length > 0
                              ? <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                  {m.trainingFiles.map((name, i) => (
                                    <div key={i} style={{ fontSize: '0.8rem', color: '#2d2d4e', fontFamily: 'monospace', padding: '3px 8px', background: 'rgba(91,106,191,0.08)', borderRadius: 4, border: '1px solid rgba(91,106,191,0.18)' }}>
                                      {name}
                                    </div>
                                  ))}
                                </div>
                              : <div style={{ fontSize: '0.8rem', color: '#555', fontStyle: 'italic' }}>No file info available</div>
                            }
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
            {selectedModelIds.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <button
                  className="admin-set-active-btn"
                  style={{ background: '#c0392b' }}
                  onClick={handleDeleteModels}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Name model popup */}
      {namePopup && (
        <div className="live-popup-overlay" onClick={() => setNamePopup(null)}>
          <div className="card live-popup" onClick={(e) => e.stopPropagation()}>
            <h3 className="live-popup-title" style={{ fontSize: '1.4rem' }}>Training Complete!</h3>
            <p className="live-popup-subtitle" style={{ fontSize: '1.05rem' }}>
              What would you like to name this model?
            </p>
            <div className="live-popup-fields" style={{ display: 'flex', justifyContent: 'center' }}>
              <input
                type="text"
                className="live-popup-input"
                placeholder={`v${namePopup.versionNumber}`}
                value={popupName}
                onChange={(e) => setPopupName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveModelName()}
                autoFocus
                style={{ fontSize: '1rem', textAlign: 'center', width: '70%' }}
              />
            </div>
            <div className="live-popup-actions">
              <button className="btn live-popup-btn-cancel" onClick={() => setNamePopup(null)}>
                Skip
              </button>
              <button className="btn live-popup-btn-confirm" onClick={handleSaveModelName}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminDashboard;
