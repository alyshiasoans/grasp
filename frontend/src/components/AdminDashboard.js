import React, { useState, useEffect, useMemo } from 'react';
import ProgressPage from './ProgressPage';
import TestingPage from './TestingPage';

const API = 'http://localhost:5050';

function AdminDashboard({ user, activePage = 'dashboard', socket, connected, liveOpts }) {
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedMode, setSelectedMode] = useState('simulated');
  const [progress, setProgress] = useState(null);
  const [models, setModels] = useState([]);
  const [trainingFiles, setTrainingFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshingAssets, setRefreshingAssets] = useState(false);
  const [gestureUnlocks, setGestureUnlocks] = useState([]);
  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const [trainLogs, setTrainLogs] = useState([]);
  const [trainingModel, setTrainingModel] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [assetMessage, setAssetMessage] = useState('');
  const [selectedUploadFile, setSelectedUploadFile] = useState(null);
  const [uploadGestureOrder, setUploadGestureOrder] = useState('');
  const [modelName, setModelName] = useState('');
  const [editingNames, setEditingNames] = useState({});
  const [editingFileOrders, setEditingFileOrders] = useState({});
  const [editingFileNames, setEditingFileNames] = useState({});
  const [showFileOrders, setShowFileOrders] = useState({});
  const [progressRefreshToken, setProgressRefreshToken] = useState(0);

  const selectedUser = users.find((u) => u.id === Number(selectedUserId));

  const syncAssetEditors = (filesData, modelsData, gesturesData) => {
    setTrainingFiles(filesData);
    setModels(modelsData);
    setGestureUnlocks(gesturesData);
    setEditingNames(
      modelsData.reduce((acc, item) => {
        acc[item.id] = item.modelName || '';
        return acc;
      }, {})
    );
    setEditingFileOrders(
      filesData.reduce((acc, item) => {
        acc[item.id] = Array.isArray(item.gestures) ? item.gestures.join(', ') : '';
        return acc;
      }, {})
    );
    setEditingFileNames(
      filesData.reduce((acc, item) => {
        acc[item.id] = item.fileName || '';
        return acc;
      }, {})
    );
    if (!uploadGestureOrder.trim()) {
      setUploadGestureOrder((gesturesData || []).map((g) => g.name).join(', '));
    }
  };

  const loadAdminData = async ({ showLoading = false, refreshAssetsOnly = false } = {}) => {
    if (!selectedUserId) return;
    if (showLoading && !refreshAssetsOnly) setLoading(true);
    if (showLoading && refreshAssetsOnly) setRefreshingAssets(true);
    try {
      const requests = [
        fetch(`${API}/api/admin/models/${selectedUserId}`).then((r) => r.json()),
        fetch(`${API}/api/admin/training-files/${selectedUserId}`).then((r) => r.json()),
        fetch(`${API}/api/admin/gestures/${selectedUserId}`).then((r) => r.json()),
      ];
      if (!refreshAssetsOnly) {
        requests.unshift(fetch(`${API}/api/dashboard/${selectedUserId}`).then((r) => r.json()));
      }
      const data = await Promise.all(requests);
      if (refreshAssetsOnly) {
        const [modelsData, filesData, gesturesData] = data;
        syncAssetEditors(
          Array.isArray(filesData) ? filesData : [],
          Array.isArray(modelsData) ? modelsData : [],
          Array.isArray(gesturesData) ? gesturesData : []
        );
      } else {
        const [dashData, modelsData, filesData, gesturesData] = data;
        setProgress(dashData);
        syncAssetEditors(
          Array.isArray(filesData) ? filesData : [],
          Array.isArray(modelsData) ? modelsData : [],
          Array.isArray(gesturesData) ? gesturesData : []
        );
      }
    } catch (err) {
      if (refreshAssetsOnly) {
        setAssetMessage(err?.message || 'Unable to refresh simulation assets right now.');
      }
    } finally {
      setLoading(false);
      setRefreshingAssets(false);
    }
  };

  useEffect(() => {
    fetch(`${API}/api/admin/users`)
      .then((r) => r.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedUserId) {
      setProgress(null);
      setModels([]);
      setTrainingFiles([]);
      setGestureUnlocks([]);
      setSelectedFileIds([]);
      setTrainLogs([]);
      setAssetMessage('');
      setModelName('');
      setShowFileOrders({});
      setUploadGestureOrder('');
      return;
    }
    setSelectedFileIds([]);
    setTrainLogs([]);
    setAssetMessage('');
    setModelName('');
    setShowFileOrders({});
    setUploadGestureOrder('');
    loadAdminData({ showLoading: true });
  }, [selectedUserId]);

  useEffect(() => {
    setSelectedFileIds((prev) => prev.filter((id) => trainingFiles.some((file) => file.id === id && file.canTrain)));
  }, [trainingFiles]);

  const handleSetActiveModel = (modelId) => {
    fetch(`${API}/api/admin/models/${selectedUserId}/set-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    })
      .then((r) => r.json())
      .then(() => {
        setModels((prev) => prev.map((m) => ({ ...m, isActive: m.id === modelId })));
        setAssetMessage('Active model updated.');
      })
      .catch(() => {});
  };

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
            prev.map((g) => (g.gestureId === gestureId ? { ...g, isUnlocked: data.isUnlocked } : g))
          );
          setProgress((prev) => prev ? ({
            ...prev,
            gestures: (prev.gestures || []).map((g) =>
              g.gestureId === gestureId ? { ...g, isUnlocked: data.isUnlocked } : g
            ),
          }) : prev);
        }
      })
      .catch(() => {});
  };

  const handleUpload = async () => {
    if (!selectedUploadFile || !selectedUserId) return;
    setUploading(true);
    setAssetMessage('');
    const formData = new FormData();
    formData.append('userId', selectedUserId);
    formData.append('file', selectedUploadFile);
    formData.append('gestureOrder', uploadGestureOrder);

    try {
      const res = await fetch(`${API}/api/training/files/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setSelectedUploadFile(null);
      setAssetMessage(`${data.file.fileName} uploaded to simulation assets.`);
      await loadAdminData({ showLoading: true, refreshAssetsOnly: true });
    } catch (err) {
      setAssetMessage(err.message);
    } finally {
      setUploading(false);
      const input = document.getElementById('admin-simulation-upload');
      if (input) input.value = '';
    }
  };

  const handleDeleteFile = async (fileId, fileName) => {
    if (!selectedUserId) return;
    if (!window.confirm(`Delete dataset "${fileName}"?`)) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/files/${fileId}?userId=${selectedUserId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setSelectedFileIds((prev) => prev.filter((id) => id !== fileId));
      setTrainingFiles((prev) => prev.filter((file) => file.id !== fileId));
      setAssetMessage(`${fileName} deleted.`);
    } catch (err) {
      setAssetMessage(err.message);
    }
  };

  const handleSaveGestureOrder = async (fileId) => {
    if (!selectedUserId) return;
    const nextOrder = (editingFileOrders[fileId] || '').trim();
    if (!nextOrder) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Number(selectedUserId), gestureOrder: nextOrder }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setTrainingFiles((prev) => prev.map((file) => (file.id === fileId ? data.file : file)));
      setEditingFileOrders((prev) => ({
        ...prev,
        [fileId]: Array.isArray(data.file.gestures) ? data.file.gestures.join(', ') : nextOrder,
      }));
      setAssetMessage(`Updated gesture order for ${data.file.fileName}.`);
    } catch (err) {
      setAssetMessage(err.message);
    }
  };

  const handleRenameFile = async (fileId) => {
    if (!selectedUserId) return;
    const nextName = (editingFileNames[fileId] || '').trim();
    if (!nextName) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Number(selectedUserId), fileName: nextName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setTrainingFiles((prev) => prev.map((file) => (file.id === fileId ? data.file : file)));
      setEditingFileNames((prev) => ({ ...prev, [fileId]: data.file.fileName || nextName }));
      setAssetMessage(`Renamed dataset to ${data.file.fileName}.`);
    } catch (err) {
      setAssetMessage(err.message);
    }
  };

  const handleTrainModel = async () => {
    if (!selectedUserId || selectedFileIds.length === 0) return;
    setTrainingModel(true);
    setTrainLogs([]);
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/admin/train-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: Number(selectedUserId),
          trainingFileIds: selectedFileIds,
          modelName,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Training failed');
      setTrainLogs(data.logs || []);
      setModelName('');
      setAssetMessage(data.modelName ? `${data.modelName} trained successfully.` : 'Model trained successfully.');
      await loadAdminData({ showLoading: true, refreshAssetsOnly: true });
    } catch (err) {
      setTrainLogs((prev) => [...prev, `Error: ${err.message}`]);
    } finally {
      setTrainingModel(false);
    }
  };

  const handleRenameModel = async (modelId) => {
    if (!selectedUserId) return;
    const nextName = (editingNames[modelId] || '').trim();
    if (!nextName) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/models/${modelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Number(selectedUserId), modelName: nextName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setModels((prev) => prev.map((m) => (m.id === modelId ? data.model : m)));
      setAssetMessage(`Renamed to ${nextName}.`);
    } catch (err) {
      setAssetMessage(err.message);
    }
  };

  const handleDeleteModel = async (modelId, name) => {
    if (!selectedUserId) return;
    if (!window.confirm(`Delete model "${name}"?`)) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/models/${modelId}?userId=${selectedUserId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setModels((prev) => prev.filter((m) => m.id !== modelId));
      setAssetMessage(`${name} deleted.`);
    } catch (err) {
      setAssetMessage(err.message);
    }
  };

  const toggleFileSelection = (fileId) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  const toggleShowFileOrder = (fileId) => {
    setShowFileOrders((prev) => ({ ...prev, [fileId]: !prev[fileId] }));
  };

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

  const trainableFiles = useMemo(
    () => trainingFiles.filter((file) => file.canTrain),
    [trainingFiles]
  );
  const activeModel = models.find((model) => model.isActive);
  const handleTestingSaved = () => {
    setProgressRefreshToken((prev) => prev + 1);
    loadAdminData({ showLoading: false });
  };

  return (
    <div className="dashboard-page">
      <div className="card dash-welcome-card">
        <h2 className="dash-welcome-title">Welcome, {user?.firstName}!</h2>
        <p className="dash-welcome-subtitle">Select a user and manage their admin, progress, and simulation updates here.</p>

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

        {selectedUserId && activePage === 'dashboard' && (
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

      {progress && selectedUser && activePage === 'dashboard' && (
        <>
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

          <ProgressPage
            key={`${selectedUser.id}-${progressRefreshToken}`}
            user={selectedUser}
            isActive={activePage === 'dashboard'}
          />
        </>
      )}

      {selectedUser && activePage === 'simulation' && (
        <>
          <div className="admin-summary-row">
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{progress?.simulatedAccuracy ?? 0}%</div>
              <div className="admin-stat-label">Simulation Accuracy</div>
            </div>
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{progress?.simulatedTested ?? 0}</div>
              <div className="admin-stat-label">Simulation Attempts</div>
            </div>
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{trainingFiles.length}</div>
              <div className="admin-stat-label">Simulation Datasets</div>
            </div>
            <div className="card admin-stat-card">
              <div className="admin-stat-value">{models.length}</div>
              <div className="admin-stat-label">Saved Models</div>
            </div>
          </div>

          <div className="admin-simulation-header">
            <div>
              <h3 className="admin-table-title">Simulation Assets</h3>
              <p className="admin-simulation-subtitle">
                This section contains the dataset upload, model training, and saved simulation assets from your recent updates.
              </p>
            </div>
            <button className="training-refresh-btn" onClick={() => loadAdminData({ showLoading: true, refreshAssetsOnly: true })} disabled={refreshingAssets}>
              {refreshingAssets ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {assetMessage && <div className="training-inline-message">{assetMessage}</div>}

          <div className="admin-simulation-grid">
            <div className="card training-assets-card">
              <div className="training-card-header">
                <div>
                  <h3 className="training-card-title">Datasets</h3>
                  <p className="training-card-subtitle">Upload `.mat` files, edit gesture order, and choose which datasets to train into a model.</p>
                </div>
              </div>

              <div className="training-upload-panel">
                <input
                  id="admin-simulation-upload"
                  type="file"
                  accept=".mat"
                  onChange={(e) => setSelectedUploadFile(e.target.files?.[0] || null)}
                />
                <textarea
                  className="training-textarea"
                  value={uploadGestureOrder}
                  onChange={(e) => setUploadGestureOrder(e.target.value)}
                  rows={3}
                  placeholder="Gesture order, comma-separated"
                />
                <button
                  className="btn admin-set-active-btn"
                  onClick={handleUpload}
                  disabled={!selectedUploadFile || uploading}
                >
                  {uploading ? 'Uploading...' : 'Upload Dataset'}
                </button>
              </div>

              {trainingFiles.length === 0 ? (
                <p className="training-empty-text">No simulation datasets yet.</p>
              ) : (
                <div className="training-list training-dataset-list">
                  {trainingFiles.map((file) => {
                    const selected = selectedFileIds.includes(file.id);
                    const showingOrder = Boolean(showFileOrders[file.id]);
                    return (
                      <div key={file.id} className={`training-list-item ${selected ? 'selected' : ''}`}>
                        <label className={`training-dataset-main ${file.canTrain ? '' : 'disabled'}`}>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={!file.canTrain}
                            onChange={() => toggleFileSelection(file.id)}
                          />
                          <div>
                            <div className="training-file-header">
                              <div className="training-file-name-row">
                                <input
                                  className="training-text-input training-file-name-input"
                                  type="text"
                                  value={editingFileNames[file.id] || ''}
                                  onChange={(e) => setEditingFileNames((prev) => ({ ...prev, [file.id]: e.target.value }))}
                                />
                                <button
                                  type="button"
                                  className="btn admin-status-inactive training-file-save-btn"
                                  onClick={() => handleRenameFile(file.id)}
                                >
                                  Save
                                </button>
                              </div>
                              <div className="training-file-actions">
                                <button
                                  type="button"
                                  className="btn admin-status-inactive training-show-order-btn"
                                  onClick={() => toggleShowFileOrder(file.id)}
                                >
                                  {showingOrder ? 'Hide Order' : 'Show Order'}
                                </button>
                                <button
                                  type="button"
                                  className="training-danger-btn training-file-delete-btn"
                                  onClick={() => handleDeleteFile(file.id, file.fileName)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                            <div className="training-item-meta">
                              {file.fileType?.toUpperCase() || 'FILE'} · {file.createdAt ? new Date(file.createdAt).toLocaleString() : 'Unknown date'}
                            </div>
                            {showingOrder && (
                              <>
                                <div className="training-item-meta">Edit gesture order:</div>
                                <div className="training-model-row">
                                  <textarea
                                    className="training-textarea training-order-textarea"
                                    value={editingFileOrders[file.id] || ''}
                                    onChange={(e) => setEditingFileOrders((prev) => ({ ...prev, [file.id]: e.target.value }))}
                                    rows={3}
                                    placeholder="Gesture order, comma-separated"
                                  />
                                  <button
                                    type="button"
                                    className="btn admin-status-inactive"
                                    onClick={() => handleSaveGestureOrder(file.id)}
                                  >
                                    Save Order
                                  </button>
                                </div>
                              </>
                            )}
                            {!file.canTrain && (
                              <div className="training-item-meta">
                                This dataset needs a valid gesture order before it can be used for model training.
                              </div>
                            )}
                          </div>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="training-model-builder">
                <input
                  className="training-text-input"
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="New model name"
                />
                <button
                  className="btn admin-set-active-btn"
                  disabled={selectedFileIds.length === 0 || trainingModel}
                  onClick={handleTrainModel}
                >
                  {trainingModel ? 'Training...' : `Train Model (${selectedFileIds.length})`}
                </button>
              </div>
              {trainableFiles.length === 0 && (
                <div className="training-empty-text">Upload at least one `.mat` dataset with gesture order to train a model.</div>
              )}
              {trainLogs.length > 0 && (
                <div className="admin-train-logs">
                  {trainLogs.map((line, index) => (
                    <div key={index}>{line}</div>
                  ))}
                </div>
              )}
            </div>

            <div className="card training-assets-card">
              <div className="training-card-header">
                <div>
                  <h3 className="training-card-title">Models</h3>
                  <p className="training-card-subtitle">Rename, activate, or delete the saved models for this user's simulation and testing flow.</p>
                </div>
              </div>

              {activeModel && (
                <div className="admin-inline-callout">
                  Active model: <strong>{activeModel.modelName}</strong>
                </div>
              )}

              {models.length === 0 ? (
                <p className="training-empty-text">No models trained yet.</p>
              ) : (
                <div className="training-list">
                  {models.map((model) => (
                    <div key={model.id} className="training-model-item">
                      <div className="training-model-row">
                        <input
                          className="training-text-input"
                          type="text"
                          value={editingNames[model.id] || ''}
                          onChange={(e) => setEditingNames((prev) => ({ ...prev, [model.id]: e.target.value }))}
                        />
                        <button
                          className="btn admin-status-inactive"
                          onClick={() => handleRenameModel(model.id)}
                        >
                          Save Name
                        </button>
                      </div>
                      <div className="training-item-meta">
                        v{model.versionNumber} · {model.accuracy != null ? `${model.accuracy}%` : 'No accuracy'} · {model.trainingDate ? new Date(model.trainingDate).toLocaleString() : 'Unknown date'}
                      </div>
                      <div className="training-model-footer">
                        {model.isActive ? (
                          <span className="admin-status-active">Active</span>
                        ) : (
                          <button
                            className="btn admin-status-inactive"
                            onClick={() => handleSetActiveModel(model.id)}
                          >
                            Set Active
                          </button>
                        )}
                        <button
                          className="training-danger-btn"
                          onClick={() => handleDeleteModel(model.id, model.modelName)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card admin-table-card">
            <h3 className="admin-table-title">Run Simulation Test</h3>
            <p className="admin-simulation-subtitle">
              Start a simulated testing session for {selectedUser.firstName} {selectedUser.lastName}. Results save directly into Overview and the user&apos;s simulated progress history.
            </p>
          </div>

          <TestingPage
            socket={socket}
            connected={connected}
            user={selectedUser}
            mode="simulated"
            liveOpts={liveOpts}
            onResultsSaved={handleTestingSaved}
          />
        </>
      )}
    </div>
  );
}

export default AdminDashboard;
