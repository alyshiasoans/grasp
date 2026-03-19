import React from 'react';

function Dashboard({ user }) {
  return (
    <div className="dashboard-page">
      <div className="card dash-welcome-card">
        <h2 className="dash-welcome-title">Welcome, {user?.firstName}!</h2>
        <p className="dash-welcome-subtitle">Here's how to get started with GRASP:</p>
        <ol className="dash-instructions">
          <li><strong>Training</strong> — Record EMG signals for each gesture to build your classifier.</li>
          <li><strong>Testing</strong> — Test how well the classifier recognises your gestures in real time.</li>
          <li><strong>Progress</strong> — Track your accuracy for each gesture and see where to improve.</li>
        </ol>
      </div>
    </div>
  );
}

export default Dashboard;
