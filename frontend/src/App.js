import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import TrainingPage from './components/TrainingPage';
import TestingPage from './components/TestingPage';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import LoginPage from './components/LoginPage';

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
      <Sidebar activePage={activePage} onNavigate={setActivePage} user={user} onLogout={() => setUser(null)} />

      <div className="app-main">
        {/* Header */}
        <header className="header">
          <h1 className="title">
            {activePage === 'training' ? 'EMG Gesture Training' : activePage === 'testing' ? 'EMG Gesture Testing' : 'EMG Gesture Classifier'}
          </h1>
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
            <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
            <span className="status-text">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </header>

        {activePage === 'dashboard' && (
          <Dashboard connected={connected} user={user} onNavigate={setActivePage} />
        )}

        {activePage === 'training' && (
          <TrainingPage socket={socketRef.current} connected={connected} user={user} mode={mode} liveOpts={liveOpts} />
        )}

        {activePage === 'testing' && (
          <TestingPage socket={socketRef.current} connected={connected} user={user} mode={mode} liveOpts={liveOpts} />
        )}
      </div>
    </div>
  );
}

export default App;
