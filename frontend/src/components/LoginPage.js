import React, { useState } from 'react';

const API = 'http://localhost:5050';

function LoginPage({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const url = isRegister ? `${API}/api/register` : `${API}/api/login`;
    const body = isRegister
      ? { firstName, lastName, username, password }
      : { username, password };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
      } else {
        onLogin(data);
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = isRegister
    ? firstName.trim() && lastName.trim() && username.trim() && password
    : username.trim() && password;

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">GRASP</h1>
        {isRegister && (
          <p className="login-subtitle">Create an account</p>
        )}

        {error && <div className="login-error">{error}</div>}

        <form className="login-form" onSubmit={handleSubmit}>
          {isRegister && (
            <>
              <label className="login-label" htmlFor="login-first">First Name</label>
              <input
                id="login-first"
                className="login-input"
                type="text"
                placeholder="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoFocus
              />
              <label className="login-label" htmlFor="login-last">Last Name</label>
              <input
                id="login-last"
                className="login-input"
                type="text"
                placeholder="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </>
          )}
          <label className="login-label" htmlFor="login-user">Username</label>
          <input
            id="login-user"
            className="login-input"
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus={!isRegister}
          />
          <label className="login-label" htmlFor="login-pass">Password</label>
          <input
            id="login-pass"
            className="login-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            className="btn btn-start login-btn"
            type="submit"
            disabled={!canSubmit || loading}
          >
            {loading ? '…' : isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <button
          className="login-toggle"
          onClick={() => { setIsRegister(!isRegister); setError(''); }}
        >
          {isRegister ? 'Already have an account? Sign in' : "Don't have an account? Register"}
        </button>
      </div>
    </div>
  );
}

export default LoginPage;
