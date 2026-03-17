import React, { useEffect, useRef } from 'react';

function LogPanel({ logs }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  return (
    <div className="card log-card">
      <h3>Event Log</h3>
      <div className="log-entries">
        {logs.map((entry, i) => (
          <div key={i} className="log-entry">
            {entry}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default LogPanel;
