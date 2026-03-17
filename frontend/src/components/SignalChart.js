import React, { useRef, useEffect } from 'react';

const WINDOW = 100;
const YMAX_LERP = 0.05;

const SERIES = [
  { key: 'flexor',   color: '#5b6abf', label: 'Flexors (1–32)' },
  { key: 'extensor', color: '#e05555', label: 'Extensors (33–64)' },
];

function readValues(ref) {
  const raw = ref.current || [];
  const n = Math.min(raw.length, WINDOW);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = raw[raw.length - n + i];
    out[i] = typeof v === 'number' ? v : (v?.y ?? 0);
  }
  return out;
}

function SignalChart({ flexorRef, extensorRef, tOn, tOff }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const dimsRef = useRef({ w: 600, h: 220 });
  const smoothYMaxRef = useRef(2.0);
  const rafRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0) dimsRef.current = { w: rect.width, h: 220 };
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) { rafRef.current = requestAnimationFrame(draw); return; }

      const { w: W, h: H } = dimsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(W * dpr);
      const targetH = Math.round(H * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
      }

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const PAD_L = 45;
      const PAD_R = 100;
      const PAD_T = 10;
      const PAD_B = 10;
      const plotW = W - PAD_L - PAD_R;
      const plotH = H - PAD_T - PAD_B;

      const flexVals = readValues(flexorRef);
      const extVals  = readValues(extensorRef);

      // Compute shared Y range
      let instantYMax = 2.0;
      for (let i = 0; i < flexVals.length; i++)
        if (flexVals[i] > instantYMax) instantYMax = flexVals[i];
      for (let i = 0; i < extVals.length; i++)
        if (extVals[i] > instantYMax) instantYMax = extVals[i];
      instantYMax = Math.max(instantYMax * 1.2, tOn * 1.5, 2.0);
      const prev = smoothYMaxRef.current;
      smoothYMaxRef.current = instantYMax > prev
        ? prev + (instantYMax - prev) * 0.3
        : prev + (instantYMax - prev) * YMAX_LERP;
      const yMax = smoothYMaxRef.current;

      const toX = (i) => PAD_L + (i / (WINDOW - 1)) * plotW;
      const toY = (v) => PAD_T + plotH - (Math.min(v, yMax) / yMax) * plotH;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(PAD_L, PAD_T, plotW, plotH);

      // Grid
      ctx.strokeStyle = '#e8e8ec';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];
      for (const v of yTicks) {
        const y = toY(v);
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      }
      ctx.fillStyle = '#999';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of yTicks) ctx.fillText(v.toFixed(1), PAD_L - 6, toY(v));

      // T_ON line
      if (tOn <= yMax) {
        const y = toY(tOn);
        ctx.strokeStyle = '#888'; ctx.lineWidth = 1.2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#888'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`T_ON=${tOn}`, PAD_L + plotW + 4, y);
      }

      // T_OFF line
      if (tOff <= yMax) {
        const y = toY(tOff);
        ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1;
        ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#bbb'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`T_OFF=${tOff}`, PAD_L + plotW + 4, y);
      }

      // Draw both signal lines
      const allSeries = [
        { vals: flexVals,  color: SERIES[0].color },
        { vals: extVals,   color: SERIES[1].color },
      ];
      for (const { vals, color } of allSeries) {
        const n = vals.length;
        if (n < 2) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        ctx.beginPath();
        const off = WINDOW - n;
        for (let i = 0; i < n; i++) {
          const x = toX(off + i), y = toY(vals[i]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Border
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeRect(PAD_L, PAD_T, plotW, plotH);

      // Legend
      const legX = PAD_L + plotW + 8;
      let legY = PAD_T + 14;
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const s of SERIES) {
        ctx.fillStyle = s.color;
        ctx.fillRect(legX, legY - 4, 12, 8);
        ctx.fillStyle = '#555';
        ctx.fillText(s.label, legX + 16, legY);
        legY += 16;
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [flexorRef, extensorRef, tOn, tOff]);

  return (
    <div className="card signal-card">
      <h3>Activation Signal</h3>
      <div ref={containerRef} style={{ width: '100%' }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      </div>
    </div>
  );
}

export default SignalChart;
