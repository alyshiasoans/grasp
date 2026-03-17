import React, { useState, useEffect, useRef, useCallback } from 'react';

const API = 'http://localhost:5050';

const GESTURE_IMAGES = {
  'Open': '/gestures/open.jpg',
  'Close': '/gestures/close.jpg',
  'Thumbs Up': '/gestures/thumbs_up.jpg',
  'Peace': '/gestures/peace.jpg',
  'Index Point': '/gestures/index_point.jpg',
  'Four': '/gestures/four.jpg',
  'Okay': '/gestures/okay.jpg',
  'Spiderman': '/gestures/spiderman.jpg',
};

const MAX_RETRIES = 3;

function TestingPage({ socket, connected, user }) {
  // Setup
  const [gestures, setGestures] = useState([]);
  const [sessionLength, setSessionLength] = useState(15);
  const [mode, setMode] = useState('simulated');
  const [liveOpts, setLiveOpts] = useState({ host: '0.0.0.0', port: '45454' });

  // Session state
  const [sessionId, setSessionId] = useState(null);
  const [sequence, setSequence] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [phase, setPhase] = useState('setup'); // setup | prompting | classifying | result | done
  const [retryCount, setRetryCount] = useState(0);

  // Classification result
  const [prediction, setPrediction] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [wasCorrect, setWasCorrect] = useState(null);

  // Signal display
  const flexorRef = useRef([]);
  const extensorRef = useRef([]);

  // Session stats
  const [stats, setStats] = useState({ correct: 0, incorrect: 0, skipped: 0 });
  const [logs, setLogs] = useState([]);
  const logBottomRef = useRef(null);

  // Retrain popup
  const [retrainGesture, setRetrainGesture] = useState(null);

  // Fetch eligible gestures
  useEffect(() => {
    if (!user?.id) return;
    fetch(`${API}/api/testing/gestures/${user.id}`)
      .then(r => r.json())
      .then(data => setGestures(data.gestures || []))
      .catch(() => {});
  }, [user?.id]);

  // Socket listeners for classification
  useEffect(() => {
    if (!socket) return;

    const onState = (data) => {
      if (data.gesture && data.gesture !== 'REST' && data.gesture !== '—' && data.gesture !== 'DONE' && data.label !== 'STOPPED') {
        // Final classification received
        if (data.label === 'REST' && data.gesture !== 'REST') {
          // Gesture ended — this is the final vote
          setPrediction(data.gesture);
          setConfidence(data.act);
          setPhase('result');
        }
      }
    };

    const onLog = (data) => {
      setLogs(prev => [...prev, data.text].slice(-80));
      // Detect final classification from log
      if (data.text && data.text.startsWith('★  final:')) {
        const match = data.text.match(/★\s+final:\s+(.+?)\s+\(/);
        if (match) {
          setPrediction(match[1]);
          setPhase('result');
        }
      }
    };

    const onSignal = (data) => {
      flexorRef.current = data.flexors || [];
      extensorRef.current = data.extensors || [];
    };

    socket.on('state', onState);
    socket.on('log', onLog);
    socket.on('signal', onSignal);

    return () => {
      socket.off('state', onState);
      socket.off('log', onLog);
      socket.off('signal', onSignal);
    };
  }, [socket]);

  // Auto-scroll log
  useEffect(() => {
    if (logBottomRef.current) {
      logBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const currentGesture = sequence[currentIdx] || null;
  const eligibleGestures = gestures.filter(g => g.eligible);
  const progressPct = sequence.length > 0 ? Math.round((currentIdx / sequence.length) * 100) : 0;

  // Start session
  const handleStart = useCallback(async () => {
    try {
      // Create session
      const sessRes = await fetch(`${API}/api/testing/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, plannedDuration: sessionLength * 60 }),
      });
      const sessData = await sessRes.json();
      setSessionId(sessData.sessionId);

      // Get weighted sequence
      const seqRes = await fetch(`${API}/api/testing/sequence/${user.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: sessionLength }),
      });
      const seqData = await seqRes.json();
      if (seqData.error) {
        setLogs(prev => [...prev, `Error: ${seqData.error}`]);
        return;
      }

      setSequence(seqData.sequence);
      setCurrentIdx(0);
      setRetryCount(0);
      setStats({ correct: 0, incorrect: 0, skipped: 0 });
      setLogs([]);
      setPrediction(null);
      setConfidence(null);
      setWasCorrect(null);
      setRetrainGesture(null);
      setPhase('prompting');

      // Start the classification worker
      if (socket) {
        socket.emit('start', { mode, liveOpts: mode === 'live' ? liveOpts : {} });
      }
    } catch (err) {
      setLogs(prev => [...prev, `Error starting session: ${err.message}`]);
    }
  }, [user, sessionLength, mode, liveOpts, socket]);

  // Record a trial result
  const recordTrial = useCallback(async (isCorrect, isSkipped = false) => {
    if (!currentGesture || !sessionId) return;

    try {
      const res = await fetch(`${API}/api/testing/trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          sessionId,
          gestureId: currentGesture.gestureId,
          prediction: prediction || 'skipped',
          confidence: confidence || 0,
          groundTruth: currentGesture.name,
          wasCorrect: isCorrect,
          wasSkipped: isSkipped,
          retryCount,
          trialNumber: currentIdx + 1,
        }),
      });
      const data = await res.json();

      // Check if gesture needs retraining
      if (data.accuracy !== null && data.accuracy < 50) {
        setRetrainGesture(currentGesture.name);
      }

      return data;
    } catch (err) {
      setLogs(prev => [...prev, `Error recording trial: ${err.message}`]);
    }
  }, [currentGesture, sessionId, user, prediction, confidence, retryCount, currentIdx]);

  // User confirms correct
  const handleCorrect = useCallback(async () => {
    setWasCorrect(true);
    setStats(prev => ({ ...prev, correct: prev.correct + 1 }));
    setLogs(prev => [...prev, `✓ ${currentGesture.name} classified correctly as ${prediction}`]);
    await recordTrial(true, false);
    advanceToNext();
  }, [currentGesture, prediction, recordTrial]);

  // User says incorrect
  const handleIncorrect = useCallback(async () => {
    setWasCorrect(false);
    setStats(prev => ({ ...prev, incorrect: prev.incorrect + 1 }));
    setLogs(prev => [...prev, `✗ ${currentGesture.name} misclassified as ${prediction}`]);
    await recordTrial(false, false);

    if (retryCount < MAX_RETRIES - 1) {
      // Retry
      setRetryCount(prev => prev + 1);
      setPrediction(null);
      setConfidence(null);
      setWasCorrect(null);
      setPhase('prompting');
      setLogs(prev => [...prev, `Retry ${retryCount + 2}/${MAX_RETRIES}...`]);
    } else {
      // Max retries reached
      setLogs(prev => [...prev, `Max retries reached for ${currentGesture.name}`]);
      advanceToNext();
    }
  }, [currentGesture, prediction, recordTrial, retryCount]);

  // Skip gesture
  const handleSkip = useCallback(async () => {
    setStats(prev => ({ ...prev, skipped: prev.skipped + 1 }));
    setLogs(prev => [...prev, `⟶ Skipped ${currentGesture?.name}`]);
    await recordTrial(false, true);
    advanceToNext();
  }, [currentGesture, recordTrial]);

  // Advance to next gesture
  const advanceToNext = useCallback(() => {
    setRetrainGesture(null);
    setPrediction(null);
    setConfidence(null);
    setWasCorrect(null);
    setRetryCount(0);

    if (currentIdx + 1 >= sequence.length) {
      // Session complete
      endSession('completed');
    } else {
      setCurrentIdx(prev => prev + 1);
      setPhase('prompting');
    }
  }, [currentIdx, sequence.length]);

  // End session
  const endSession = useCallback(async (status = 'completed') => {
    setPhase('done');
    if (socket) {
      socket.emit('stop');
    }
    if (sessionId) {
      try {
        await fetch(`${API}/api/testing/session/${sessionId}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      } catch (err) {
        // ignore
      }
    }
  }, [socket, sessionId]);

  // Stop early
  const handleStop = useCallback(() => {
    setLogs(prev => [...prev, 'Session stopped by user']);
    endSession('aborted');
  }, [endSession]);

  // Dismiss retrain popup
  const dismissRetrain = () => setRetrainGesture(null);

  // ─── Render ─────────────────────────────────────────────────────────────

  // Setup screen
  if (phase === 'setup') {
    return (
      <div className="testing-page">
        <div className="card test-setup-card">
          <h3 className="dashboard-card-title">Test Session Setup</h3>

          <div className="train-setup-grid">
            {/* Eligible gestures */}
            <div className="train-setup-section">
              <label className="train-setup-label">Eligible Gestures (≥15 training reps)</label>
              <div className="train-gesture-chips">
                {eligibleGestures.length === 0 && (
                  <span className="train-no-gestures">
                    No eligible gestures — train at least 15 reps per gesture first
                  </span>
                )}
                {eligibleGestures.map(g => (
                  <div key={g.gestureId} className="train-gesture-chip">
                    <span>{g.name}</span>
                    <span className="test-chip-acc">{g.accuracy}%</span>
                  </div>
                ))}
              </div>
              {gestures.filter(g => !g.eligible).length > 0 && (
                <div className="test-ineligible">
                  <span className="train-setup-label" style={{ fontSize: '0.72rem', color: '#999' }}>
                    Not yet eligible
                  </span>
                  <div className="train-gesture-chips">
                    {gestures.filter(g => !g.eligible).map(g => (
                      <div key={g.gestureId} className="train-gesture-chip test-chip-disabled">
                        <span>{g.name}</span>
                        <span className="test-chip-reps">{g.totalTrained}/15 reps</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Number of prompts */}
            <div className="train-setup-section">
              <label className="train-setup-label">Number of Prompts</label>
              <div className="train-length-options">
                {[10, 15, 20, 30].map(n => (
                  <button
                    key={n}
                    className={`btn btn-mode ${sessionLength === n ? 'active' : ''}`}
                    onClick={() => setSessionLength(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Data source */}
            <div className="train-setup-section">
              <label className="train-setup-label">Data Source</label>
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
              {mode === 'live' && (
                <div className="live-opts" style={{ marginTop: 10 }}>
                  <label>
                    IP
                    <input type="text" value={liveOpts.host} onChange={e => setLiveOpts(o => ({ ...o, host: e.target.value }))} />
                  </label>
                  <label>
                    Port
                    <input type="number" value={liveOpts.port} onChange={e => setLiveOpts(o => ({ ...o, port: e.target.value }))} />
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="train-instructions">
            <p>
              You'll be prompted with gestures one at a time. Perform the gesture when shown,
              and the classifier will try to identify it. You can <strong>retry</strong> (up to {MAX_RETRIES}x),
              <strong> skip</strong>, or confirm the result. Weak gestures appear more often.
            </p>
          </div>

          <button
            className="btn btn-start train-start-btn"
            onClick={handleStart}
            disabled={!connected || eligibleGestures.length === 0}
          >
            ▶ Start Testing ({sessionLength} prompts)
          </button>
        </div>
      </div>
    );
  }

  // Done screen
  if (phase === 'done') {
    const total = stats.correct + stats.incorrect + stats.skipped;
    const accPct = total > 0 ? Math.round((stats.correct / total) * 100) : 0;

    return (
      <div className="testing-page">
        <div className="card test-done-card">
          <h3 className="test-done-title">Session Complete</h3>

          <div className="test-done-stats">
            <div className="test-done-stat">
              <span className="test-done-value test-done-correct">{stats.correct}</span>
              <span className="test-done-label">Correct</span>
            </div>
            <div className="test-done-stat">
              <span className="test-done-value test-done-incorrect">{stats.incorrect}</span>
              <span className="test-done-label">Incorrect</span>
            </div>
            <div className="test-done-stat">
              <span className="test-done-value test-done-skipped">{stats.skipped}</span>
              <span className="test-done-label">Skipped</span>
            </div>
            <div className="test-done-stat">
              <span className="test-done-value">{accPct}%</span>
              <span className="test-done-label">Accuracy</span>
            </div>
          </div>

          <button
            className="btn btn-start test-new-btn"
            onClick={() => {
              setPhase('setup');
              setSessionId(null);
              setSequence([]);
              setCurrentIdx(0);
              setStats({ correct: 0, incorrect: 0, skipped: 0 });
              setLogs([]);
            }}
          >
            New Session
          </button>
        </div>

        {/* Session log */}
        <div className="card log-card">
          <h3>Session Log</h3>
          <div className="log-entries">
            {logs.map((entry, i) => (
              <div key={i} className="log-entry">{entry}</div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Active session: prompting / classifying / result
  return (
    <div className="testing-page">
      {/* Progress bar */}
      <div className="train-progress-bar-wrap">
        <div className="train-progress-bar">
          <div className="train-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="train-progress-text">{currentIdx} / {sequence.length} prompts</span>
      </div>

      {/* Stats row */}
      <div className="test-stats-row">
        <span className="test-stat test-stat-correct">✓ {stats.correct}</span>
        <span className="test-stat test-stat-incorrect">✗ {stats.incorrect}</span>
        <span className="test-stat test-stat-skipped">⟶ {stats.skipped}</span>
        {retryCount > 0 && (
          <span className="test-stat test-stat-retry">Retry {retryCount}/{MAX_RETRIES}</span>
        )}
      </div>

      <div className="testing-grid">
        {/* Left: Prompt / Result card */}
        <div className="card test-prompt-card">
          <div className="training-progress">{currentIdx + 1} / {sequence.length}</div>

          {/* Prompting phase */}
          {phase === 'prompting' && currentGesture && (
            <>
              <div className="test-phase-label">PERFORM THIS GESTURE</div>
              <div className="training-gesture-name">{currentGesture.name}</div>
              {GESTURE_IMAGES[currentGesture.name] && (
                <div className="gesture-image-wrapper gesture-animate">
                  <img
                    src={GESTURE_IMAGES[currentGesture.name]}
                    alt={currentGesture.name}
                    className="gesture-image"
                  />
                </div>
              )}
              <div className="test-waiting">Waiting for gesture...</div>
              <button className="btn test-skip-btn" onClick={handleSkip}>
                Skip →
              </button>
            </>
          )}

          {/* Result phase */}
          {phase === 'result' && currentGesture && (
            <>
              <div className="test-phase-label">CLASSIFICATION RESULT</div>
              <div className="test-result-row">
                <div className="test-result-expected">
                  <span className="test-result-small-label">Expected</span>
                  <span className="test-result-gesture">{currentGesture.name}</span>
                </div>
                <span className="test-result-arrow">→</span>
                <div className="test-result-predicted">
                  <span className="test-result-small-label">Predicted</span>
                  <span className={`test-result-gesture ${prediction === currentGesture.name ? 'test-match' : 'test-mismatch'}`}>
                    {prediction || '?'}
                  </span>
                </div>
              </div>

              <div className="test-confirm-label">Is this what you did?</div>

              <div className="test-confirm-buttons">
                <button className="btn test-correct-btn" onClick={handleCorrect}>
                  ✓ Correct
                </button>
                <button className="btn test-incorrect-btn" onClick={handleIncorrect}>
                  ✗ Incorrect
                </button>
                <button className="btn test-skip-btn" onClick={handleSkip}>
                  Skip
                </button>
              </div>

              {retryCount > 0 && (
                <div className="test-retry-info">
                  Attempt {retryCount + 1} of {MAX_RETRIES}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: Log */}
        <div className="card log-card">
          <h3>Testing Log</h3>
          <div className="log-entries">
            {logs.map((entry, i) => (
              <div key={i} className="log-entry">{entry}</div>
            ))}
            <div ref={logBottomRef} />
          </div>
        </div>
      </div>

      {/* Retrain popup */}
      {retrainGesture && (
        <div className="test-retrain-overlay">
          <div className="card test-retrain-popup">
            <h3 className="test-retrain-title">Gesture Needs Retraining</h3>
            <p className="test-retrain-text">
              <strong>{retrainGesture}</strong> accuracy has dropped below 50%.
              Consider doing more training reps to improve classification.
            </p>
            <div className="test-retrain-actions">
              <button className="btn test-retrain-dismiss" onClick={dismissRetrain}>
                Continue Testing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stop button */}
      <button className="btn btn-stop train-stop-btn" onClick={handleStop}>
        ■ Stop Session
      </button>
    </div>
  );
}

export default TestingPage;
