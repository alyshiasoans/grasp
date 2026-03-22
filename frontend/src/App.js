import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import TrainingPage from './components/TrainingPage';
import TestingPage from './components/TestingPage';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import AdminDashboard from './components/AdminDashboard';
import LoginPage from './components/LoginPage';
import ProgressPage from './components/ProgressPage';

const BACKEND_URL = 'http://localhost:5050';

function App() {
  const [user, setUser] = useState(null);
  const [activePage, setActivePage] = useState('dashboard');
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState('simulated');
  const [liveOpts, setLiveOpts] = useState({ host: '0.0.0.0', port: '45454' });
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    return () => {
      socket.disconnect();
    };
  }, []);

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <div className="app-layout">
      <Sidebar activePage={activePage} onNavigate={setActivePage} user={user} onLogout={() => { setUser(null); setActivePage('dashboard'); }} />

      <div className="app-main">
        {/* Header */}
        <header className="header">
          <h1 className="title">
            {user?.isAdmin
              ? 'Admin Dashboard'
              : activePage === 'training' ? 'Gesture Training' : activePage === 'testing' ? 'Gesture Testing' : activePage === 'progress' ? 'Progress' : 'Dashboard'}
          </h1>
          {!user?.isAdmin && (
            <div className="header-right">
              <div className="header-mode-toggle">
                <div className="mode-toggle">
                  <button
                    className={`btn btn-mode ${mode === 'simulated' ? 'active' : ''}`}
                    onClick={() => setMode('simulated')}
                  >
                    Simulated
                  </button>
                  <button
                    className={`btn btn-mode ${mode === 'live' ? 'active' : ''}`}
                    onClick={() => setMode('live')}
                  >
                    Live EMG
                  </button>
                </div>
              </div>
            </div>
          )}
        </header>

        {user?.isAdmin ? (
          <AdminDashboard user={user} />
        ) : (
          <>
            <div style={{ display: activePage === 'dashboard' ? 'block' : 'none' }}>
              <Dashboard user={user} />
            </div>

            <div style={{ display: activePage === 'training' ? 'block' : 'none' }}>
              <TrainingPage socket={socketRef.current} connected={connected} user={user} mode={mode} liveOpts={liveOpts} />
            </div>

            <div style={{ display: activePage === 'testing' ? 'block' : 'none' }}>
              <TestingPage socket={socketRef.current} connected={connected} user={user} mode={mode} liveOpts={liveOpts} />
            </div>

            <div style={{ display: activePage === 'progress' ? 'block' : 'none' }}>
              <ProgressPage user={user} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
