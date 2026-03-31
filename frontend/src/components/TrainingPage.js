import React, { useState, useEffect, useRef } from 'react';

const API = 'http://localhost:5050';

const GESTURE_IMAGES = {
  Open: '/gestures/open.jpg',
  Close: '/gestures/close.jpg',
  'Thumbs Up': '/gestures/thumbs_up.jpg',
  Peace: '/gestures/peace.jpg',
  'Index Point': '/gestures/index_point.jpg',
  Four: '/gestures/four.jpg',
  Okay: '/gestures/okay.jpg',
  Spiderman: '/gestures/spiderman.jpg',
};

const SESSION_LENGTHS = [
  { label: '2 min', value: 2 },
  { label: '5 min', value: 5 },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
];

function TrainingPage({ socket, connected, user, mode, liveOpts }) {
  const [gestures, setGestures] = useState([]);
  const [sessionMinutes, setSessionMinutes] = useState(null);
  const [collecting, setCollecting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [sensorStatus, setSensorStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const logBottomRef = useRef(null);

  const [trainingFiles, setTrainingFiles] = useState([]);
  const [models, setModels] = useState([]);
  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const [trainLogs, setTrainLogs] = useState([]);
  const [trainingModel, setTrainingModel] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshingAssets, setRefreshingAssets] = useState(false);
  const [assetMessage, setAssetMessage] = useState('');
  const [selectedUploadFile, setSelectedUploadFile] = useState(null);
  const [uploadGestureOrder, setUploadGestureOrder] = useState('');
  const [modelName, setModelName] = useState('');
  const [editingNames, setEditingNames] = useState({});
  const [editingFileOrders, setEditingFileOrders] = useState({});
  const [editingFileNames, setEditingFileNames] = useState({});
  const [showFileOrders, setShowFileOrders] = useState({});

  const loadTrainingAssets = async (showLoading = false) => {
    if (!user?.id) return;
    if (showLoading) setRefreshingAssets(true);
    try {
      const [filesRes, modelsRes] = await Promise.all([
        fetch(`${API}/api/training/files/${user.id}`),
        fetch(`${API}/api/training/models/${user.id}`),
      ]);
      const [filesData, modelsData] = await Promise.all([filesRes.json(), modelsRes.json()]);
      setTrainingFiles(Array.isArray(filesData) ? filesData : []);
      setModels(Array.isArray(modelsData) ? modelsData : []);
      setEditingNames(
        (Array.isArray(modelsData) ? modelsData : []).reduce((acc, item) => {
          acc[item.id] = item.modelName || '';
          return acc;
        }, {})
      );
      setEditingFileOrders(
        (Array.isArray(filesData) ? filesData : []).reduce((acc, item) => {
          acc[item.id] = Array.isArray(item.gestures) ? item.gestures.join(', ') : '';
          return acc;
        }, {})
      );
      setEditingFileNames(
        (Array.isArray(filesData) ? filesData : []).reduce((acc, item) => {
          acc[item.id] = item.fileName || '';
          return acc;
        }, {})
      );
    } catch {
      setAssetMessage('Unable to load datasets or models right now.');
    } finally {
      if (showLoading) setRefreshingAssets(false);
    }
  };

  useEffect(() => {
    if (!user?.id) return;
    fetch(`${API}/api/training/gestures/${user.id}`)
      .then((r) => r.json())
      .then((data) => {
        setGestures(data.gestures || []);
        const defaultOrder = (data.gestures || []).map((g) => g.name).join(', ');
        setUploadGestureOrder(defaultOrder);
      })
      .catch(() => {});
    loadTrainingAssets(true);
  }, [user?.id]);

  useEffect(() => {
    setSelectedFileIds((prev) => prev.filter((id) => trainingFiles.some((file) => file.id === id && file.canTrain)));
  }, [trainingFiles]);

  useEffect(() => {
    if (!socket) return;

    const onPhase = (data) => {
      setPhase(data);
      setCountdown(data.countdown);
    };
    const onCountdown = (data) => setCountdown(data.countdown);
    const onLog = (data) => setLogs((prev) => [...prev, data.text].slice(-80));
    const onDone = () => {
      setCollecting(false);
      setPaused(false);
      setPhase(null);
      loadTrainingAssets();
    };
    const onSensor = (data) => setSensorStatus(data);
    const onPaused = (data) => setPaused(data.paused);

    socket.on('train_phase', onPhase);
    socket.on('train_countdown', onCountdown);
    socket.on('train_log', onLog);
    socket.on('train_done', onDone);
    socket.on('train_sensor', onSensor);
    socket.on('train_paused', onPaused);

    return () => {
      socket.off('train_phase', onPhase);
      socket.off('train_countdown', onCountdown);
      socket.off('train_log', onLog);
      socket.off('train_done', onDone);
      socket.off('train_sensor', onSensor);
      socket.off('train_paused', onPaused);
      socket.emit('train_stop');
    };
  }, [socket, user?.id]);

  useEffect(() => {
    if (logBottomRef.current) {
      logBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleStart = () => {
    if (!socket) return;
    socket.emit('train_start', {
      mode,
      liveOpts: mode === 'live' ? liveOpts : {},
      userId: user?.id,
      sessionMinutes,
    });
    setCollecting(true);
    setPaused(false);
    setLogs([]);
    setPhase(null);
    setCountdown(0);
    setSensorStatus(null);
  };

  const handleStop = () => {
    if (!socket) return;
    socket.emit('train_pause');
    setPaused(true);
    setTimeout(() => {
      if (window.confirm('Are you sure you want to stop this session? Any unsaved progress will be lost.')) {
        socket.emit('train_stop');
        setCollecting(false);
        setPaused(false);
        setPhase(null);
      }
    }, 150);
  };

  const handlePause = () => {
    if (!socket) return;
    if (paused) socket.emit('train_resume');
    else socket.emit('train_pause');
  };

  const toggleFileSelection = (fileId) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  const handleUpload = async () => {
    if (!selectedUploadFile || !user?.id) return;
    setUploading(true);
    setAssetMessage('');
    const formData = new FormData();
    formData.append('userId', String(user.id));
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
      setUploadGestureOrder((prev) => prev.trim());
      setAssetMessage(`${data.file.fileName} uploaded.`);
      await loadTrainingAssets();
    } catch (err) {
      setAssetMessage(err.message);
    } finally {
      setUploading(false);
      const input = document.getElementById('training-mat-upload');
      if (input) input.value = '';
    }
  };

  const handleDeleteFile = async (fileId, fileName) => {
    if (!user?.id) return;
    if (!window.confirm(`Delete dataset "${fileName}"?`)) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/files/${fileId}?userId=${user.id}`, {
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
    if (!user?.id) return;
    const nextOrder = (editingFileOrders[fileId] || '').trim();
    if (!nextOrder) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, gestureOrder: nextOrder }),
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
    if (!user?.id) return;
    const nextName = (editingFileNames[fileId] || '').trim();
    if (!nextName) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, fileName: nextName }),
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

  const toggleShowFileOrder = (fileId) => {
    setShowFileOrders((prev) => ({ ...prev, [fileId]: !prev[fileId] }));
  };

  const handleTrainModel = async () => {
    if (!user?.id || selectedFileIds.length === 0) return;
    setTrainingModel(true);
    setTrainLogs([]);
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/admin/train-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          trainingFileIds: selectedFileIds,
          modelName,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Training failed');
      setTrainLogs(data.logs || []);
      if (data.modelName) {
        setAssetMessage(`${data.modelName} trained successfully.`);
      }
      setModelName('');
      await loadTrainingAssets();
    } catch (err) {
      setTrainLogs((prev) => [...prev, `Error: ${err.message}`]);
    } finally {
      setTrainingModel(false);
    }
  };

  const handleRenameModel = async (modelId) => {
    if (!user?.id) return;
    const nextName = (editingNames[modelId] || '').trim();
    if (!nextName) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/models/${modelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, modelName: nextName }),
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
    if (!user?.id) return;
    if (!window.confirm(`Delete model "${name}"?`)) return;
    setAssetMessage('');
    try {
      const res = await fetch(`${API}/api/training/models/${modelId}?userId=${user.id}`, {
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

  const isGesture = phase?.phase === 'gesture';
  const gestureName = phase?.gesture || '—';
  const imageSrc = isGesture ? GESTURE_IMAGES[gestureName] : null;
  const progressIndex = phase?.index || 0;
  const progressTotal = phase?.total || 0;
  const progressPct = progressTotal > 0 ? Math.round((progressIndex / progressTotal) * 100) : 0;
  const trainableFiles = trainingFiles.filter((file) => file.canTrain);

  return (
    <div className="training-page">
      {collecting && (
        <div className="train-progress-bar-wrap">
          <div className="train-progress-bar">
            <div className="train-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="train-progress-text">{progressIndex} / {progressTotal} gestures</span>
        </div>
      )}

      {collecting && sensorStatus && (
        <div className={`train-sensor-pill ${sensorStatus.quality}`}>
          <span className="train-sensor-dot" />
          {sensorStatus.channels} channels · {sensorStatus.quality === 'good' ? 'Good signal' : 'Weak signal'}
        </div>
      )}

      {!collecting && !phase && (
        <>
          <div className="card test-setup-card">
            <div className="train-setup-grid">
              <div className="train-setup-section">
                <label className="train-setup-label">Please choose a training length:</label>
                <div className="train-length-options">
                  {SESSION_LENGTHS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`btn btn-mode ${sessionMinutes === opt.value ? 'active' : ''}`}
                      onClick={() => setSessionMinutes(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              className="btn btn-start train-start-btn"
              onClick={handleStart}
              disabled={!connected || gestures.length === 0 || !sessionMinutes}
            >
              ▶ Start
            </button>
          </div>

          <div className="training-management-grid">
            <div className="card training-assets-card">
              <div className="training-card-header">
                <div>
                  <h3 className="training-card-title">Datasets</h3>
                  <p className="training-card-subtitle">Upload `.mat` files, choose which ones to train on, or remove old datasets.</p>
                </div>
                <button className="training-refresh-btn" onClick={() => loadTrainingAssets(true)} disabled={refreshingAssets}>
                  {refreshingAssets ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>

              <div className="training-upload-panel">
                <input
                  id="training-mat-upload"
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

              {assetMessage && <div className="training-inline-message">{assetMessage}</div>}

              {trainingFiles.length === 0 ? (
                <p className="training-empty-text">No datasets yet.</p>
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
                                This dataset cannot be used for model training yet.
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
                  <p className="training-card-subtitle">Rename or delete saved models for this user.</p>
                </div>
              </div>

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
                        <span className={model.isActive ? 'admin-status-active' : 'admin-status-inactive'}>
                          {model.isActive ? 'Active' : 'Saved'}
                        </span>
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
        </>
      )}

      {(collecting || phase) && (
        <div className="card training-prompt-card">
          {phase && (
            <>
              <div
                className="training-gesture-name"
                style={{ color: isGesture ? '#1a1a2e' : '#aaa' }}
              >
                {gestureName}
              </div>

              {imageSrc && (
                <div className="gesture-image-wrapper gesture-animate">
                  <img src={imageSrc} alt={gestureName} className="gesture-image" />
                </div>
              )}

              <div className="training-countdown">{countdown}</div>

              {!isGesture && phase?.nextGesture && (
                <div className="training-next">
                  Next: <strong>{phase.nextGesture}</strong>
                </div>
              )}
            </>
          )}

          {paused && <div className="training-paused-label">PAUSED</div>}
        </div>
      )}

      {(collecting || phase) && (
        <div className="train-session-controls">
          <button
            className={`btn btn-pause train-pause-btn ${paused ? 'paused' : ''}`}
            onClick={handlePause}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="btn btn-stop train-stop-btn" onClick={handleStop}>
            ■ Stop Session
          </button>
        </div>
      )}

      {logs.length > 0 && (
        <div className="card training-session-log-card">
          <h3 className="training-card-title">Session Log</h3>
          <div className="training-session-log">
            {logs.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
            <div ref={logBottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

export default TrainingPage;
