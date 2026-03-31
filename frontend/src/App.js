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
  const [showLivePopup, setShowLivePopup] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState('disconnected'); // disconnected | connecting | connected | error
  const [deviceError, setDeviceError] = useState('');
  const [batteryLevel, setBatteryLevel] = useState(null);
  const socketRef = useRef(null);
  const pageOrder = ['dashboard', 'training', 'testing', 'progress'];

  useEffect(() => {
    const socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => {
      setConnected(false);
      setDeviceStatus('disconnected');
    });

    socket.on('device_status', (data) => {
      setDeviceStatus(data.status);
      if (data.error) setDeviceError(data.error);
      if (data.status === 'connected') {
        setMode('live');
        socket.emit('get_battery');
        setTimeout(() => setShowLivePopup(false), 800);
      }
    });

    socket.on('battery_level', (data) => {
      setBatteryLevel(data.level);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Poll battery every 30s while device is connected
  useEffect(() => {
    if (deviceStatus !== 'connected' || !socketRef.current) return;
    const interval = setInterval(() => {
      socketRef.current.emit('get_battery');
    }, 30000);
    return () => clearInterval(interval);
  }, [deviceStatus]);

  const handleLiveClick = () => {
    if (deviceStatus === 'connected') {
      // Already verified — switch directly
      setMode('live');
    } else {
      setShowLivePopup(true);
    }
  };

  const handleConnectDevice = () => {
    setDeviceStatus('connecting');
    setDeviceError('');
    socketRef.current.emit('check_device', {
      host: liveOpts.host,
      port: liveOpts.port,
    });
  };

  const handleCancelLive = () => {
    setShowLivePopup(false);
  };

  const handleNextPage = () => {
    const currentIndex = pageOrder.indexOf(activePage);
    if (currentIndex === -1 || currentIndex >= pageOrder.length - 1) return;
    setActivePage(pageOrder[currentIndex + 1]);
  };

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <div className="app-layout">
      <Sidebar activePage={activePage} onNavigate={setActivePage} user={user} onLogout={() => { setUser(null); setActivePage('dashboard'); }} deviceStatus={deviceStatus} batteryLevel={batteryLevel} onRefreshBattery={() => socketRef.current?.emit('get_battery')} />

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
                    onClick={() => { setMode('simulated'); }}
                  >
                    Simulated
                  </button>
                  <button
                    className={`btn btn-mode ${mode === 'live' ? 'active' : ''}`}
                    onClick={handleLiveClick}
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

            {activePage !== 'progress' && (
              <button className="btn app-next-page-btn" onClick={handleNextPage}>
                Next
              </button>
            )}
          </>
        )}
      </div>

      {/* Live EMG Connection Popup */}
      {showLivePopup && (
        <div className="live-popup-overlay" onClick={handleCancelLive}>
          <div className="card live-popup" onClick={(e) => e.stopPropagation()}>
            <h3 className="live-popup-title">Connect to EMG Device</h3>
            <p className="live-popup-subtitle">
              Join the Sessantaquattro+ WiFi and connect below.
            </p>

            <div className="live-popup-fields">
              <label className="live-popup-label">
                Host
                <span className="live-popup-value">{liveOpts.host}</span>
              </label>
              <label className="live-popup-label">
                Port
                <span className="live-popup-value">{liveOpts.port}</span>
              </label>
            </div>

            <div className="live-popup-status-row">
              <span className={`live-popup-dot live-popup-dot-${deviceStatus}`} />
              <span className="live-popup-status-text">
                {deviceStatus === 'disconnected' && 'Not connected'}
                {deviceStatus === 'connecting' && 'Checking connection…'}
                {deviceStatus === 'connected' && (
                  batteryLevel !== null
                    ? `Device connected — Battery: ${batteryLevel}%`
                    : 'Device connected'
                )}
                {deviceStatus === 'error' && (deviceError || 'Connection failed')}
              </span>
            </div>

            <div className="live-popup-actions">
              <button className="btn live-popup-btn-cancel" onClick={handleCancelLive}>
                Cancel
              </button>
              <button
                className="btn live-popup-btn-confirm"
                onClick={handleConnectDevice}
                disabled={deviceStatus === 'connecting'}
              >
                {deviceStatus === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
