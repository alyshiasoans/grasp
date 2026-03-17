import React from 'react';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: '⊞' },
  { key: 'training', label: 'Training', icon: '⏱' },
  { key: 'testing',  label: 'Testing',  icon: '▶' },
  { key: 'progress', label: 'Progress',  icon: '📊' },
];

function Sidebar({ activePage, onNavigate, user, onLogout }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">GRASP</div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`sidebar-link ${activePage === item.key ? 'active' : ''}`}
            onClick={() => onNavigate(item.key)}
          >
            <span className="sidebar-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="sidebar-user">{user?.firstName} {user?.lastName}</span>
        <button className="sidebar-logout" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
  );
}

export default Sidebar;
