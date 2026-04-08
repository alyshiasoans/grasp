import React, { useState } from 'react';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: '⊞' },
  { key: 'training', label: 'Training', icon: '⏱' },
  { key: 'testing',  label: 'Practice',  icon: '▶' },
  { key: 'predict',  label: 'Predict',   icon: '🔮' },
  { key: 'progress', label: 'Progress',  icon: '📊' },
];

const ADMIN_NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: '⊞' },
];

function Sidebar({ activePage, onNavigate, user, onLogout, deviceStatus, batteryLevel, onRefreshBattery }) {
  const items = user?.isAdmin ? ADMIN_NAV_ITEMS : NAV_ITEMS;
  const [spinning, setSpinning] = useState(false);

  const handleRefresh = () => {
    setSpinning(true);
    onRefreshBattery();
    setTimeout(() => setSpinning(false), 2000);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">GRASP</div>
      <nav className="sidebar-nav">
        {items.map((item) => (
          <button
            key={item.key}
            className={`sidebar-link ${activePage === item.key ? 'active' : ''}`}
            onClick={() => onNavigate(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-device-status">
          <span className={`sidebar-device-dot ${deviceStatus === 'connected' ? 'connected' : ''}`} />
          <span className="sidebar-device-label">
            {deviceStatus === 'connected' ? 'EMG Connected' : 'EMG Disconnected'}
          </span>
        </div>
        {deviceStatus === 'connected' && batteryLevel !== null && (
          <div className="sidebar-battery">
            <span className="sidebar-battery-text">Battery: {batteryLevel}%</span>
            <div className="sidebar-battery-bar">
              <div
                className={`sidebar-battery-fill ${batteryLevel <= 20 ? 'low' : batteryLevel <= 50 ? 'mid' : ''}`}
                style={{ width: `${batteryLevel}%` }}
              />
            </div>
            <button className={`sidebar-battery-refresh ${spinning ? 'spinning' : ''}`} onClick={handleRefresh} title="Refresh battery" disabled={spinning}>
              ↻
            </button>
          </div>
        )}
        <button className="sidebar-logout" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
  );
}

export default Sidebar;
