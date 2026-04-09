import React, { useState, useEffect, useCallback } from 'react';
import { API } from '../constants';

const LABEL = { fontSize: '0.85rem', color: '#555', display: 'block', marginBottom: 14 };
const INPUT_BLOCK = { display: 'block', marginTop: 4, width: '100%' };
const SECTION_GAP = { marginTop: 32 };

function SettingsPage({ user, setUser, activePage }) {

  /* ── Signal thresholds ─────────────────────────────── */
  const [tOn, setTOn] = useState(2.0);
  const [tOff, setTOff] = useState(1.3);
  const [minVotes, setMinVotes] = useState(3);
  const [savedThresholds, setSavedThresholds] = useState({ tOn: 2.0, tOff: 1.3, minVotes: 3 });

  /* ── Training config (read-only display) ───────────── */

  /* ── Data files ────────────────────────────────────── */
  const [files, setFiles] = useState([]);
  const [filePage, setFilePage] = useState(0);
  const FILES_PER_PAGE = 10;

  /* ── Models ────────────────────────────────────────── */
  const [models, setModels] = useState([]);

  /* ── Load config + files + models on mount ─────────── */
  const loadAll = useCallback(() => {
    if (!user?.id) return;
    fetch(`${API}/api/settings/config/${user.id}`).then(r => r.json()).then(d => {
      setTOn(d.tOn); setTOff(d.tOff); setMinVotes(d.minVotes);
      setSavedThresholds({ tOn: d.tOn, tOff: d.tOff, minVotes: d.minVotes });
    }).catch(() => {});
    fetch(`${API}/api/settings/files/${user.id}`).then(r => r.json()).then(setFiles).catch(() => {});
    fetch(`${API}/api/settings/models/${user.id}`).then(r => r.json()).then(setModels).catch(() => {});
  }, [user?.id]);

  useEffect(() => { if (!activePage || activePage === 'settings') loadAll(); }, [loadAll, activePage]);

  /* ── Handlers ──────────────────────────────────────── */
  const saveThresholds = () => {
    fetch(`${API}/api/settings/config/${user.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tOn, tOff, minVotes }),
    }).then(() => setSavedThresholds({ tOn, tOff, minVotes })).catch(() => {});
  };
  const thresholdsDirty = tOn !== savedThresholds.tOn || tOff !== savedThresholds.tOff || minVotes !== savedThresholds.minVotes;

  const deleteFile = (fileId) => {
    if (!window.confirm('Delete this training file? This cannot be undone.')) return;
    fetch(`${API}/api/settings/files/${fileId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(d => { if (d.ok) setFiles(prev => prev.filter(f => f.id !== fileId)); })
      .catch(() => {});
  };

  const setActiveModel = (modelId) => {
    fetch(`${API}/api/settings/models/${user.id}/set-active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    }).then(r => r.json()).then(d => {
      if (d.ok) setModels(prev => prev.map(m => ({ ...m, isActive: m.id === modelId })));
    }).catch(() => {});
  };

  const pagedFiles = files.slice(filePage * FILES_PER_PAGE, (filePage + 1) * FILES_PER_PAGE);
  const totalFilePages = Math.ceil(files.length / FILES_PER_PAGE);

  return (
    <div className="dashboard-page">

      {/* ── Signal Thresholds ──────────────────────────── */}
      <div className="card admin-table-card" style={SECTION_GAP}>
        <h3 className="admin-table-title">Signal Thresholds</h3>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', maxWidth: 500 }}>
          <label style={{ ...LABEL, flex: 1, minWidth: 120 }}>
            T_ON (activation)
            <input type="number" step="0.1" min="0.1" className="live-popup-input"
              value={tOn} onChange={e => setTOn(parseFloat(e.target.value) || 0)} style={INPUT_BLOCK} />
          </label>
          <label style={{ ...LABEL, flex: 1, minWidth: 120 }}>
            T_OFF (deactivation)
            <input type="number" step="0.1" min="0.1" className="live-popup-input"
              value={tOff} onChange={e => setTOff(parseFloat(e.target.value) || 0)} style={INPUT_BLOCK} />
          </label>
          <label style={{ ...LABEL, flex: 1, minWidth: 120 }}>
            Min Votes
            <input type="number" step="1" min="1" className="live-popup-input"
              value={minVotes} onChange={e => setMinVotes(parseInt(e.target.value) || 1)} style={INPUT_BLOCK} />
          </label>
        </div>
        {thresholdsDirty && (
          <button className="btn live-popup-btn-confirm" onClick={saveThresholds} style={{ marginTop: 8 }}>
            Save Thresholds
          </button>
        )}
      </div>

      {/* ── Data Files ─────────────────────────────────── */}
      <div className="card admin-table-card" style={SECTION_GAP}>
        <h3 className="admin-table-title">Data Files</h3>
        {files.length === 0 ? (
          <p style={{ color: '#999', fontSize: '0.9rem' }}>No training files.</p>
        ) : (
          <>
            <table className="admin-gesture-table">
              <thead>
                <tr>
                  <th>File Name</th>
                  <th>Source</th>
                  <th>Date</th>
                  <th style={{ width: 70, textAlign: 'center' }}></th>
                </tr>
              </thead>
              <tbody>
                {pagedFiles.map(f => (
                  <tr key={f.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{f.fileName}</td>
                    <td>{f.fileName.startsWith('testing_') ? 'Testing' : 'Training'}</td>
                    <td>{f.createdAt ? new Date(f.createdAt + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      <button className="admin-status-inactive" style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                        onClick={() => deleteFile(f.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalFilePages > 1 && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: '0.85rem' }}>
                <button className="admin-set-active-btn" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                  disabled={filePage === 0} onClick={() => setFilePage(p => p - 1)}>← Prev</button>
                <span style={{ color: '#666' }}>{filePage + 1} / {totalFilePages}</span>
                <button className="admin-set-active-btn" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                  disabled={filePage + 1 >= totalFilePages} onClick={() => setFilePage(p => p + 1)}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Active Model ───────────────────────────────── */}
      <div className="card admin-table-card" style={SECTION_GAP}>
        <h3 className="admin-table-title">Models</h3>
        {models.length === 0 ? (
          <p style={{ color: '#999', fontSize: '0.9rem' }}>No models available.</p>
        ) : (
          <table className="admin-gesture-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Accuracy</th>
                <th>Trained</th>
                <th style={{ textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.id}>
                  <td>{m.name || `v${m.versionNumber}`}</td>
                  <td>{m.accuracy != null ? `${m.accuracy}%` : '—'}</td>
                  <td>{m.trainingDate ? new Date(m.trainingDate + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                  <td style={{ textAlign: 'center' }}>
                    {m.isActive ? (
                      <span className="admin-status-active">Active</span>
                    ) : (
                      <button className="admin-status-inactive" onClick={() => setActiveModel(m.id)}>Inactive</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default SettingsPage;
