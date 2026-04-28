import React, { useRef, useEffect } from 'react';

function EMGStrip({ actHistory }) {
  const ref = useRef(null);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.fillStyle = '#090910'; ctx.fillRect(0, 0, W, H);

    if (actHistory.length < 2) return;

    // Auto-scale: use the max value in the visible history (with a floor)
    const peak = Math.max(...actHistory);
    const maxAct = Math.max(peak * 1.3, 1);

    ctx.beginPath(); ctx.lineWidth = 2;
    actHistory.forEach((v, i) => {
      const x = (i / (actHistory.length - 1)) * W;
      const y = H - Math.min(1, v / maxAct) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    const gr = ctx.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, '#5c5cff44'); gr.addColorStop(1, '#00e5ff');
    ctx.strokeStyle = gr; ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const fg = ctx.createLinearGradient(0, 0, 0, H);
    fg.addColorStop(0, '#00e5ff14'); fg.addColorStop(1, '#00e5ff00');
    ctx.fillStyle = fg; ctx.fill();

    // Show current scale label
    ctx.font = '9px monospace';
    ctx.fillStyle = '#555';
    ctx.fillText(`peak: ${peak.toFixed(1)}`, W - 80, 12);
  }, [actHistory]);

  return (
    <div>
      <div style={{ fontSize: '0.68rem', color: '#555', fontFamily: 'monospace',
        marginBottom: 3, letterSpacing: 1 }}>EMG ACTIVATION</div>
      <canvas ref={ref} width={700} height={80}
        style={{ width: '100%', height: 80, borderRadius: 6,
          border: '1px solid #1a1a2e', display: 'block' }} />
    </div>
  );
}

export default EMGStrip;
