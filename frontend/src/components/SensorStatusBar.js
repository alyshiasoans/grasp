import React, { useMemo } from 'react';
import { GOOD_THRESHOLD, FAIR_THRESHOLD, SUCCESS_GREEN } from '../constants';

function SensorStatusBar({ channels }) {
  const activeCount = useMemo(() => channels.filter(v => v > 0.15).length, [channels]);
  const quality = activeCount >= GOOD_THRESHOLD ? 'good'
    : activeCount >= FAIR_THRESHOLD ? 'fair' : 'poor';
  const col = { good: SUCCESS_GREEN, fair: '#ffd740', poor: '#ff4081' }[quality];
  const label = { good: 'Good', fair: 'Fair', poor: 'Poor' }[quality];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6,
      fontSize: '0.78rem', fontFamily: 'monospace', color: '#666' }}>
      <span>Sensor quality:</span>
      <span style={{ color: col, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

export default SensorStatusBar;
