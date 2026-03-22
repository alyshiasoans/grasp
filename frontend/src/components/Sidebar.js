import React from 'react';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: '⊞' },
  { key: 'training', label: 'Training', icon: '⏱' },
  { key: 'testing',  label: 'Testing',  icon: '▶' },
  { key: 'progress', label: 'Progress',  icon: '📊' },
];

const ADMIN_NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: '⊞' },
];

function Sidebar({ activePage, onNavigate, user, onLogout }) {
  const items = user?.isAdmin ? ADMIN_NAV_ITEMS : NAV_ITEMS;

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
        <button className="sidebar-logout" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
  );
}

export default Sidebar;
