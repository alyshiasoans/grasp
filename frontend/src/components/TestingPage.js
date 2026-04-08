/**
 * TestingPage.jsx — EMG Rehabilitation Platform
 *
 * ABSOLUTE THRESHOLD SYSTEM
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. T_ON_ABS / T_OFF_ABS are raw ADC RMS values (no calibration needed).
 *    They are broadcast by the backend on every `signal` event so the EMG
 *    strip always draws threshold lines at the correct position.
 *
 * 2. `act` in every `state` event is the absolute median RMS.
 *
 * 3. The `state` event carries a `votes` array forwarded to VotesPie.
 *
 * 4. EMG strip y-axis is scaled to T_ON * 2.5 so threshold lines are visible.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
const API            = 'http://localhost:5050';
const MAX_RETRIES    = 3;
const CHANNEL_COUNT  = 64;
const GOOD_THRESHOLD = 50;
const FAIR_THRESHOLD = 30;
const SUCCESS_GREEN  = '#35d06e';
const GAME_VIEW_MAX  = 1120;

// Relative threshold defaults — overridden live from backend signal events
const T_ON_DEFAULT  = 2.4;
const T_OFF_DEFAULT = 1.8;

const GESTURE_COLORS = {
  'Open':'#00e5ff',  'Close':'#ff4081',   'Thumbs Up':'#69ff47',
  'Peace':'#ffd740', 'Index Point':'#e040fb', 'Four':'#ff6d00',
  'Okay':'#00e676',  'Spiderman':'#ff1744',
};
const ALL_GESTURES = Object.keys(GESTURE_COLORS);

const GESTURE_IMAGES = {
  'Open':'/gestures/open.png',            'Close':'/gestures/close.png',
  'Thumbs Up':'/gestures/thumbs_up.png',  'Peace':'/gestures/peace.png',
  'Index Point':'/gestures/index_point.png', 'Four':'/gestures/four.png',
  'Okay':'/gestures/okay.png',            'Spiderman':'/gestures/spiderman.png',
};

const SIM_GESTURE_ORDER = [
  'Okay','Open','Peace','Peace','Thumbs Up','Spiderman','Spiderman','Thumbs Up',
  'Open','Thumbs Up','Open','Open','Close','Index Point','Four','Thumbs Up',
  'Four','Index Point','Okay','Open','Index Point','Index Point','Four','Okay',
  'Close','Spiderman','Okay','Four','Thumbs Up','Peace','Four','Spiderman',
  'Peace','Close','Close','Peace','Index Point','Okay','Spiderman','Close',
];

// ── Canvas constants ──────────────────────────────────────────────────────────
const GW                     = 700;
const GH                     = 320;
const BX                     = 120;
const BR                     = 12;
const PW                     = 68;
const GAP_H                  = 110;
const BASE_SPEED             = 1.5;
const NORMAL_PIPE_INTERVAL_S = 6;
const PIPE_SPACING           = BASE_SPEED * 60 * NORMAL_PIPE_INTERVAL_S;
const EVAL_X                 = BX + BR + 4;
const MARGIN                 = 18;
const BALL_GROUND_Y          = GH - MARGIN - BR - 10;
const BALL_HOVER_Y           = GH * 0.56;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function gapCenterY(gapTop) { return gapTop + GAP_H / 2; }
function missYForPipe(pipe) {
  const aboveY = clamp(pipe.gapTop / 2, MARGIN + BR, GH - MARGIN - BR);
  const belowY = clamp(
    pipe.gapTop + GAP_H + (GH - (pipe.gapTop + GAP_H)) / 2,
    MARGIN + BR, GH - MARGIN - BR,
  );
  const roomAbove = pipe.gapTop - (MARGIN + BR);
  const roomBelow = (GH - MARGIN - BR) - (pipe.gapTop + GAP_H);
  return roomBelow >= roomAbove ? belowY : aboveY;
}

// ── Sensor status ─────────────────────────────────────────────────────────────
function SensorStatusBar({ channels }) {
  const activeCount = useMemo(() => channels.filter(v => v > 0.15).length, [channels]);
  const quality = activeCount >= GOOD_THRESHOLD ? 'good'
    : activeCount >= FAIR_THRESHOLD ? 'fair' : 'poor';
  const col   = { good:SUCCESS_GREEN, fair:'#ffd740', poor:'#ff4081' }[quality];
  const label = { good:'Good',    fair:'Fair',    poor:'Poor'    }[quality];
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6,
      fontSize:'0.78rem', fontFamily:'monospace', color:'#666' }}>
      <span>Sensor quality:</span>
      <span style={{ color:col, fontWeight:700 }}>{label}</span>
    </div>
  );
}

// ── EMG activation strip ──────────────────────────────────────────────────────
// actHistory: array of absolute RMS values
// tOn / tOff: absolute RMS thresholds from backend
function EMGStrip({ actHistory, tOn, tOff }) {
  const ref = useRef(null);
  const tOnVal  = tOn  || T_ON_DEFAULT;
  const tOffVal = tOff || T_OFF_DEFAULT;

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.fillStyle = '#090910'; ctx.fillRect(0, 0, W, H);

    // Scale: show 0 → T_ON * 2.5 so both threshold lines are comfortably visible
    const maxAct = tOnVal * 2.5;
    const yOn  = H - (tOnVal  / maxAct) * H;
    const yOff = H - (tOffVal / maxAct) * H;

    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.strokeStyle = '#ff408133';
    ctx.beginPath(); ctx.moveTo(0, yOn);  ctx.lineTo(W, yOn);  ctx.stroke();
    ctx.strokeStyle = '#ffd74033';
    ctx.beginPath(); ctx.moveTo(0, yOff); ctx.lineTo(W, yOff); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '9px monospace';
    ctx.fillStyle = '#ff408177';
    ctx.fillText(`T_ON ${tOnVal}`,  5, yOn  - 2);
    ctx.fillStyle = '#ffd74077';
    ctx.fillText(`T_OFF ${tOffVal}`, 5, yOff - 2);

    if (actHistory.length < 2) return;
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
  }, [actHistory, tOnVal, tOffVal]);

  return (
    <div>
      <div style={{ fontSize:'0.68rem', color:'#555', fontFamily:'monospace',
        marginBottom:3, letterSpacing:1 }}>EMG ACTIVATION</div>
      <canvas ref={ref} width={700} height={80}
        style={{ width:'100%', height:80, borderRadius:6,
          border:'1px solid #1a1a2e', display:'block' }} />
    </div>
  );
}

// ── Pipe draw helper ──────────────────────────────────────────────────────────
function drawPipeSimple(ctx, x, y, w, h, fillCol, strokeCol) {
  if (h <= 0) return;
  ctx.fillStyle = fillCol;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill();
  ctx.strokeStyle = strokeCol; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.stroke();
}

function drawPipeWood(ctx, x, y, w, h) {
  if (h <= 0) return;
  ctx.fillStyle = '#6b4226';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill();
  ctx.strokeStyle = '#5a371f'; ctx.lineWidth = 1;
  for (let sy = y + 14; sy < y + h; sy += 14) {
    ctx.beginPath(); ctx.moveTo(x + 2, sy); ctx.lineTo(x + w - 2, sy); ctx.stroke();
  }
  ctx.strokeStyle = '#8b6340'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.stroke();
  const capH = 8, capY = (y === 0) ? y + h - capH : y;
  ctx.fillStyle = '#7a5030';
  ctx.fillRect(x - 4, capY, w + 8, capH);
  ctx.strokeStyle = '#5a371f';
  ctx.strokeRect(x - 4, capY, w + 8, capH);
}

// for the original theme
function drawPipeLegacy(ctx, x, y, w, h, col = '#5c5cff') {
  if (h <= 0) return;
  const gr = ctx.createLinearGradient(x, 0, x + w, 0);
  gr.addColorStop(0,   col + '1a');
  gr.addColorStop(0.4, col + 'aa');
  gr.addColorStop(1,   col + '1a');
  ctx.fillStyle   = gr;
  ctx.strokeStyle = col + 'cc';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.fill();
  ctx.stroke();
}


function drawPipeDimensional(ctx, x, y, w, h, baseCol, edgeCol, highlightCol, shadowCol, capCol) {
  if (h <= 0) return;

  const bodyGrad = ctx.createLinearGradient(x, 0, x + w, 0);
  bodyGrad.addColorStop(0, shadowCol);
  bodyGrad.addColorStop(0.18, highlightCol);
  bodyGrad.addColorStop(0.55, baseCol);
  bodyGrad.addColorStop(0.82, edgeCol);
  bodyGrad.addColorStop(1, shadowCol);

  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();

  ctx.strokeStyle = edgeCol;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 3, Math.max(4, w * 0.14), Math.max(0, h - 6), 3);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.beginPath();
  ctx.roundRect(x + w - 10, y + 2, 6, Math.max(0, h - 4), 3);
  ctx.fill();

  const capH = 8;
  const capY = (y === 0) ? y + h - capH : y;
  const capGrad = ctx.createLinearGradient(x - 4, 0, x + w + 4, 0);
  capGrad.addColorStop(0, shadowCol);
  capGrad.addColorStop(0.2, highlightCol);
  capGrad.addColorStop(0.5, capCol);
  capGrad.addColorStop(1, edgeCol);

  ctx.fillStyle = capGrad;
  ctx.beginPath();
  ctx.roundRect(x - 4, capY, w + 8, capH, 3);
  ctx.fill();

  ctx.strokeStyle = edgeCol;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - 4, capY, w + 8, capH, 3);
  ctx.stroke();
}

function drawPipeWoodEnhanced(ctx, x, y, w, h) {
  if (h <= 0) return;

  const woodGrad = ctx.createLinearGradient(x, 0, x + w, 0);
  woodGrad.addColorStop(0, '#4f2f1b');
  woodGrad.addColorStop(0.18, '#8a5a34');
  woodGrad.addColorStop(0.55, '#6b4226');
  woodGrad.addColorStop(0.82, '#7b4d2c');
  woodGrad.addColorStop(1, '#4a2d1b');

  ctx.fillStyle = woodGrad;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.fill();

  ctx.strokeStyle = 'rgba(70,40,20,0.35)';
  ctx.lineWidth = 1;
  for (let sy = y + 14; sy < y + h; sy += 14) {
    ctx.beginPath();
    ctx.moveTo(x + 2, sy);
    ctx.lineTo(x + w - 2, sy);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 3, 5, Math.max(0, h - 6), 2);
  ctx.fill();

  ctx.strokeStyle = '#8b6340';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.stroke();

  const capH = 8;
  const capY = (y === 0) ? y + h - capH : y;
  const capGrad = ctx.createLinearGradient(x - 4, 0, x + w + 4, 0);
  capGrad.addColorStop(0, '#5a371f');
  capGrad.addColorStop(0.2, '#8f6038');
  capGrad.addColorStop(0.5, '#7a5030');
  capGrad.addColorStop(1, '#5a371f');

  ctx.fillStyle = capGrad;
  ctx.beginPath();
  ctx.roundRect(x - 4, capY, w + 8, capH, 3);
  ctx.fill();

  ctx.strokeStyle = '#5a371f';
  ctx.strokeRect(x - 4, capY, w + 8, capH);
}

// ── THEME DEFINITIONS ─────────────────────────────────────────────────────────
const GAME_THEMES = {
    default: {
    name: 'Default',
    border: '#1e1e35',

    drawBg(ctx) {
      ctx.fillStyle = '#06060f';
      ctx.fillRect(0, 0, GW, GH);

      ctx.strokeStyle = '#ffffff07';
      ctx.lineWidth = 1;

      for (let x = 0; x < GW; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, GH);
        ctx.stroke();
      }

      for (let y = 0; y < GH; y += 50) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(GW, y);
        ctx.stroke();
      }
    },

    drawPipe(ctx, x, y, w, h, pipeColor) {
      drawPipeLegacy(ctx, x, y, w, h, pipeColor || '#5c5cff');
    },

    drawLabel(ctx, pipe) {
      const col = pipe.color || '#5c5cff';
      ctx.save();
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = col;
      ctx.shadowBlur = 12;
      ctx.fillStyle = col;
      ctx.fillText(pipe.label, pipe.x + PW / 2, gapCenterY(pipe.gapTop));
      ctx.restore();
    },

    drawChar(ctx, x, y, flash, flashType) {
      const bc =
        flash > 0 && flashType === 'pass'
          ? '#69ff47'
          : flash > 0 && flashType === 'hit'
          ? '#ff4081'
          : '#00e5ff';

      ctx.save();
      ctx.shadowColor = bc;
      ctx.shadowBlur = 20;

      const bg = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, BR);
      bg.addColorStop(0, '#ffffff');
      bg.addColorStop(0.45, bc);
      bg.addColorStop(1, '#00000055');

      ctx.beginPath();
      ctx.arc(x, y, BR, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.restore();
    },

    drawBar(ctx, activation, tOnVal) {
      const barH = GH - 30;
      const fillH = Math.min(1, activation / (tOnVal * 2.5)) * barH;

      ctx.fillStyle = '#ffffff08';
      ctx.beginPath();
      ctx.roundRect(8, 15, 10, barH, 5);
      ctx.fill();

      if (fillH > 0) {
        const bg2 = ctx.createLinearGradient(0, 15 + barH, 0, 15 + barH - fillH);
        bg2.addColorStop(0, '#00e5ff');
        bg2.addColorStop(1, '#ff4081');
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.roundRect(8, 15 + barH - fillH, 10, fillH, 4);
        ctx.fill();
      }

      ctx.fillStyle = '#ffffff55';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(activation.toFixed(1), 13, GH - 4);
    },

    flashPass: 'rgba(105,255,71,',
    flashFail: 'rgba(255,64,129,',
  },
  outdoor: {
    name: 'Outdoor',
    border: '#8aaa7a',
    drawBg(ctx, g) {
      const sky = ctx.createLinearGradient(0, 0, 0, GH);
      sky.addColorStop(0, '#87CEEB'); sky.addColorStop(0.55, '#b4ddf0');
      sky.addColorStop(0.75, '#d4e8c2'); sky.addColorStop(1, '#5a8f3c');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, GW, GH);
      // Clouds
      g.clouds.forEach(c => {
        c.x -= c.speed;
        if (c.x + c.w < -20) { c.x = GW + 20; c.y = 15 + Math.random() * 80; }
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y, c.w / 2, 14, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(c.x - c.w * 0.22, c.y + 4, c.w * 0.3, 10, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(c.x + c.w * 0.25, c.y + 3, c.w * 0.25, 11, 0, 0, Math.PI * 2); ctx.fill();
      });
      // Grass
      const gt = GH - 40;
      ctx.fillStyle = '#4a8c2a'; ctx.fillRect(0, gt, GW, 40);
      ctx.fillStyle = '#3d7522'; ctx.fillRect(0, gt, GW, 3);
      ctx.strokeStyle = '#5ea03a'; ctx.lineWidth = 1.5;
      for (let gx = 0; gx < GW; gx += 8) {
        ctx.beginPath(); ctx.moveTo(gx, gt); ctx.lineTo(gx + 2, gt - 5 - Math.sin(gx * 0.7) * 3); ctx.stroke();
      }
    },
    drawPipe(ctx, x, y, w, h) { drawPipeWoodEnhanced(ctx, x, y, w, h); },
    pipeLabel: '#5a371f',
    drawChar(ctx, x, y, flash, flashType) {
      // Bird
      const col = flash > 0 && flashType === 'pass' ? '#7cc440'
        : flash > 0 && flashType === 'hit' ? '#d45050' : '#f0a030';
      const darker = flash > 0 && flashType === 'pass' ? '#5a9a30'
        : flash > 0 && flashType === 'hit' ? '#a03030' : '#c08020';
      // Body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(x, y, BR + 2, BR - 1, 0, 0, Math.PI * 2); ctx.fill();
      // Belly
      ctx.fillStyle = '#ffe8a0';
      ctx.beginPath(); ctx.ellipse(x + 2, y + 3, BR - 4, BR - 5, 0, 0, Math.PI * 2); ctx.fill();
      // Wing
      ctx.fillStyle = darker;
      ctx.beginPath(); ctx.ellipse(x - 4, y - 2, 7, 4, -0.3, 0, Math.PI * 2); ctx.fill();
      // Eye
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x + 6, y - 3, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(x + 7, y - 3, 1.8, 0, Math.PI * 2); ctx.fill();
      // Beak
      ctx.fillStyle = '#e06020';
      ctx.beginPath(); ctx.moveTo(x + 12, y - 1); ctx.lineTo(x + 18, y + 1); ctx.lineTo(x + 12, y + 3); ctx.closePath(); ctx.fill();
    },
    barFill: '#5a9e30', barTrack: 'rgba(0,0,0,0.15)', barText: 'rgba(0,0,0,0.4)',
    flashPass: 'rgba(100,180,60,', flashFail: 'rgba(180,60,60,',
  },

  space: {
    name: 'Space',
    border: '#2a2a55',
    drawBg(ctx, g) {
      ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0, 0, GW, GH);
      // Stars
      if (!g._stars) {
        g._stars = Array.from({ length: 80 }, () => ({
          x: Math.random() * GW, y: Math.random() * GH,
          r: 0.5 + Math.random() * 1.2, b: 0.3 + Math.random() * 0.7,
        }));
      }
      g._stars.forEach(s => {
        ctx.fillStyle = `rgba(255,255,255,${s.b})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      });
      // Distant planet
      ctx.fillStyle = '#2a1a3a';
      ctx.beginPath(); ctx.arc(GW - 80, 70, 35, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3a2a4a';
      ctx.beginPath(); ctx.arc(GW - 72, 60, 35, 0, Math.PI * 2); ctx.fill();
    },
    drawPipe(ctx, x, y, w, h) {
      drawPipeDimensional(
        ctx, x, y, w, h,
        '#31315c',
        '#56569a',
        '#6d6db8',
        '#20203f',
        '#45457e'
      );
    },
    pipeLabel: '#8888cc',
    drawChar(ctx, x, y, flash, flashType) {
      // Rocket
      const col = flash > 0 && flashType === 'pass' ? '#60ee60'
        : flash > 0 && flashType === 'hit' ? '#ff6060' : '#c0d0e8';
      // Flame
      ctx.fillStyle = '#ff8030';
      ctx.beginPath(); ctx.moveTo(x - 10, y + 5); ctx.lineTo(x - 18, y); ctx.lineTo(x - 10, y - 5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffcc40';
      ctx.beginPath(); ctx.moveTo(x - 10, y + 3); ctx.lineTo(x - 14, y); ctx.lineTo(x - 10, y - 3); ctx.closePath(); ctx.fill();
      // Body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(x, y, BR + 3, BR - 2, 0, 0, Math.PI * 2); ctx.fill();
      // Nose cone
      ctx.fillStyle = '#e04050';
      ctx.beginPath(); ctx.moveTo(x + BR + 1, y - 4); ctx.lineTo(x + BR + 8, y); ctx.lineTo(x + BR + 1, y + 4); ctx.closePath(); ctx.fill();
      // Window
      ctx.fillStyle = '#4080cc';
      ctx.beginPath(); ctx.arc(x + 3, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#80c0ff';
      ctx.beginPath(); ctx.arc(x + 2, y - 1, 1.5, 0, Math.PI * 2); ctx.fill();
      // Fins
      ctx.fillStyle = '#aabbcc';
      ctx.beginPath(); ctx.moveTo(x - 6, y - BR + 1); ctx.lineTo(x - 10, y - BR - 5); ctx.lineTo(x - 2, y - BR + 1); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - 6, y + BR - 1); ctx.lineTo(x - 10, y + BR + 5); ctx.lineTo(x - 2, y + BR - 1); ctx.closePath(); ctx.fill();
    },
    barFill: '#4060aa', barTrack: 'rgba(255,255,255,0.06)', barText: 'rgba(255,255,255,0.3)',
    flashPass: 'rgba(80,200,80,', flashFail: 'rgba(200,80,80,',
  },

  underwater: {
    name: 'Underwater',
    border: '#2a6a7a',
    drawBg(ctx, g) {
      const water = ctx.createLinearGradient(0, 0, 0, GH);
      water.addColorStop(0, '#1a5070'); water.addColorStop(0.5, '#0e3a50');
      water.addColorStop(1, '#0a2a3a');
      ctx.fillStyle = water; ctx.fillRect(0, 0, GW, GH);
      // Light rays
      ctx.save(); ctx.globalAlpha = 0.04;
      for (let i = 0; i < 5; i++) {
        const rx = 80 + i * 140;
        ctx.fillStyle = '#88ccff';
        ctx.beginPath(); ctx.moveTo(rx, 0); ctx.lineTo(rx - 30, GH); ctx.lineTo(rx + 30, GH); ctx.fill();
      }
      ctx.restore();
      // Bubbles
      if (!g._bubbles) {
        g._bubbles = Array.from({ length: 12 }, () => ({
          x: Math.random() * GW, y: Math.random() * GH,
          r: 2 + Math.random() * 4, speed: 0.2 + Math.random() * 0.4,
        }));
      }
      g._bubbles.forEach(b => {
        b.y -= b.speed;
        if (b.y < -10) { b.y = GH + 10; b.x = Math.random() * GW; }
        ctx.strokeStyle = 'rgba(150,220,255,0.3)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(150,220,255,0.08)';
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      });
      // Sandy floor
      ctx.fillStyle = '#3a5540'; ctx.fillRect(0, GH - 25, GW, 25);
      ctx.fillStyle = '#4a6a50'; ctx.fillRect(0, GH - 25, GW, 3);
    },
    drawPipe(ctx, x, y, w, h) {
      drawPipeDimensional(
        ctx, x, y, w, h,
        '#1f6d69',
        '#39a39c',
        '#5fd0c6',
        '#124b49',
        '#2f8d86'
      );
    },
    pipeLabel: '#5ac0b0',
    drawChar(ctx, x, y, flash, flashType) {
      // Fish
      const col = flash > 0 && flashType === 'pass' ? '#40d890'
        : flash > 0 && flashType === 'hit' ? '#e06060' : '#f0c040';
      const darker = flash > 0 && flashType === 'pass' ? '#30a870'
        : flash > 0 && flashType === 'hit' ? '#b04040' : '#d0a020';
      // Tail
      ctx.fillStyle = darker;
      ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x - 20, y - 7); ctx.lineTo(x - 20, y + 7); ctx.closePath(); ctx.fill();
      // Body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(x, y, BR + 3, BR, 0, 0, Math.PI * 2); ctx.fill();
      // Belly stripe
      ctx.fillStyle = '#fff8d0';
      ctx.beginPath(); ctx.ellipse(x + 1, y + 3, BR, 4, 0, 0, Math.PI * 2); ctx.fill();
      // Dorsal fin
      ctx.fillStyle = darker;
      ctx.beginPath(); ctx.moveTo(x - 2, y - BR + 1); ctx.lineTo(x + 2, y - BR - 6); ctx.lineTo(x + 8, y - BR + 1); ctx.closePath(); ctx.fill();
      // Eye
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x + 8, y - 2, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(x + 9, y - 2, 1.5, 0, Math.PI * 2); ctx.fill();
      // Mouth
      ctx.strokeStyle = darker; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x + 14, y + 1, 2, 0.2, Math.PI * 0.8); ctx.stroke();
    },
    barFill: '#2a9080', barTrack: 'rgba(0,0,0,0.2)', barText: 'rgba(180,230,220,0.5)',
    flashPass: 'rgba(60,180,140,', flashFail: 'rgba(180,60,60,',
  },

  sunset: {
    name: 'Sunset',
    border: '#8a5a4a',
    drawBg(ctx, g) {
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, '#2a1a3a'); grad.addColorStop(0.25, '#6a2a4a');
      grad.addColorStop(0.5, '#d06030'); grad.addColorStop(0.7, '#e8a040');
      grad.addColorStop(0.85, '#c07838'); grad.addColorStop(1, '#2a2018');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, GW, GH);
      // Sun
      ctx.fillStyle = '#ffe080';
      ctx.beginPath(); ctx.arc(GW * 0.65, GH * 0.48, 30, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff0b0';
      ctx.beginPath(); ctx.arc(GW * 0.65, GH * 0.48, 22, 0, Math.PI * 2); ctx.fill();
      // Clouds
      g.clouds.forEach(c => {
        c.x -= c.speed * 0.6;
        if (c.x + c.w < -20) { c.x = GW + 20; c.y = 20 + Math.random() * 60; }
        ctx.fillStyle = 'rgba(200,120,80,0.3)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y, c.w / 2, 10, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(c.x + c.w * 0.2, c.y + 3, c.w * 0.3, 8, 0, 0, Math.PI * 2); ctx.fill();
      });
      // Ground silhouette
      ctx.fillStyle = '#1a1510'; ctx.fillRect(0, GH - 35, GW, 35);
      // Hills
      ctx.fillStyle = '#2a2018';
      ctx.beginPath(); ctx.moveTo(0, GH - 35);
      for (let hx = 0; hx <= GW; hx += 5) {
        ctx.lineTo(hx, GH - 35 - Math.sin(hx * 0.012) * 15 - Math.sin(hx * 0.03) * 6);
      }
      ctx.lineTo(GW, GH - 35); ctx.fill();
    },
    drawPipe(ctx, x, y, w, h) {
      drawPipeDimensional(
        ctx, x, y, w, h,
        '#4a2a20',
        '#77503d',
        '#9f7658',
        '#2e1a14',
        '#5b3627'
      );
    },
    pipeLabel: '#c08050',
    drawChar(ctx, x, y, flash, flashType) {
      // Butterfly
      const col = flash > 0 && flashType === 'pass' ? '#90d050'
        : flash > 0 && flashType === 'hit' ? '#e05040' : '#e8a0d0';
      const col2 = flash > 0 && flashType === 'pass' ? '#c0e880'
        : flash > 0 && flashType === 'hit' ? '#ff8060' : '#f0d060';
      // Upper wings
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(x - 4, y - 6, 9, 7, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + 4, y - 6, 9, 7, 0.3, 0, Math.PI * 2); ctx.fill();
      // Lower wings
      ctx.fillStyle = col2;
      ctx.beginPath(); ctx.ellipse(x - 5, y + 3, 7, 5, -0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + 5, y + 3, 7, 5, 0.2, 0, Math.PI * 2); ctx.fill();
      // Wing dots
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.arc(x - 4, y - 7, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 4, y - 7, 2.5, 0, Math.PI * 2); ctx.fill();
      // Body
      ctx.fillStyle = '#4a3030';
      ctx.beginPath(); ctx.ellipse(x, y, 2.5, 8, 0, 0, Math.PI * 2); ctx.fill();
      // Antennae
      ctx.strokeStyle = '#4a3030'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 1, y - 8); ctx.quadraticCurveTo(x - 6, y - 16, x - 8, y - 14); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 1, y - 8); ctx.quadraticCurveTo(x + 6, y - 16, x + 8, y - 14); ctx.stroke();
      ctx.fillStyle = '#4a3030';
      ctx.beginPath(); ctx.arc(x - 8, y - 14, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 8, y - 14, 1.2, 0, Math.PI * 2); ctx.fill();
    },
    barFill: '#c07030', barTrack: 'rgba(0,0,0,0.2)', barText: 'rgba(255,220,180,0.4)',
    flashPass: 'rgba(140,180,50,', flashFail: 'rgba(180,50,40,',
  },

  winter: {
    name: 'Winter',
    border: '#8aaccc',
    drawBg(ctx, g) {
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, '#c0d8e8'); grad.addColorStop(0.6, '#e0e8f0');
      grad.addColorStop(0.8, '#f0f4f8'); grad.addColorStop(1, '#e8eef4');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, GW, GH);
      // Snowflakes
      if (!g._snow) {
        g._snow = Array.from({ length: 30 }, () => ({
          x: Math.random() * GW, y: Math.random() * GH,
          r: 1 + Math.random() * 2, speed: 0.3 + Math.random() * 0.5,
          drift: (Math.random() - 0.5) * 0.3,
        }));
      }
      g._snow.forEach(s => {
        s.y += s.speed; s.x += s.drift;
        if (s.y > GH + 5) { s.y = -5; s.x = Math.random() * GW; }
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      });
      // Snow ground
      ctx.fillStyle = '#e8eef4'; ctx.fillRect(0, GH - 35, GW, 35);
      // Snow mounds
      ctx.fillStyle = '#f0f4f8';
      ctx.beginPath(); ctx.moveTo(0, GH - 35);
      for (let sx = 0; sx <= GW; sx += 5) {
        ctx.lineTo(sx, GH - 35 - Math.sin(sx * 0.02) * 8 - Math.cos(sx * 0.05) * 4);
      }
      ctx.lineTo(GW, GH - 35); ctx.fill();
      // Pine trees silhouette
      [60, 200, 400, 550, 650].forEach(tx => {
        const th = 30 + Math.sin(tx) * 10;
        ctx.fillStyle = '#5a7a6a';
        ctx.beginPath();
        ctx.moveTo(tx, GH - 35 - th);
        ctx.lineTo(tx - 12, GH - 35);
        ctx.lineTo(tx + 12, GH - 35);
        ctx.fill();
      });
    },
    drawPipe(ctx, x, y, w, h) {
      drawPipeDimensional(
        ctx, x, y, w, h,
        '#8fbfd7',
        '#b8d8e8',
        '#dff2fb',
        '#6f9bb0',
        '#c7e4f1'
      );

      if (y === 0) {
        ctx.fillStyle = '#d7edf8';
        for (let ix = x + 5; ix < x + w - 5; ix += 10) {
          ctx.beginPath();
          ctx.moveTo(ix - 2, y + h);
          ctx.lineTo(ix, y + h + 8);
          ctx.lineTo(ix + 2, y + h);
          ctx.fill();
        }
      }
    },
    pipeLabel: '#4a7a90',
    drawChar(ctx, x, y, flash, flashType) {
      // Penguin
      const bodyCol = flash > 0 && flashType === 'pass' ? '#50b060'
        : flash > 0 && flashType === 'hit' ? '#c04040' : '#2a2a3a';
      // Body
      ctx.fillStyle = bodyCol;
      ctx.beginPath(); ctx.ellipse(x, y, BR, BR + 2, 0, 0, Math.PI * 2); ctx.fill();
      // Belly
      ctx.fillStyle = '#e8e8f0';
      ctx.beginPath(); ctx.ellipse(x + 1, y + 2, BR - 4, BR - 2, 0, 0, Math.PI * 2); ctx.fill();
      // Wings
      ctx.fillStyle = bodyCol;
      ctx.beginPath(); ctx.ellipse(x - BR + 1, y + 1, 4, 7, 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + BR - 1, y + 1, 4, 7, -0.2, 0, Math.PI * 2); ctx.fill();
      // Eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x - 4, y - 5, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 4, y - 5, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(x - 3, y - 5, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 5, y - 5, 1.5, 0, Math.PI * 2); ctx.fill();
      // Beak
      ctx.fillStyle = '#e0a030';
      ctx.beginPath(); ctx.moveTo(x - 3, y - 1); ctx.lineTo(x, y + 3); ctx.lineTo(x + 3, y - 1); ctx.closePath(); ctx.fill();
      // Feet
      ctx.fillStyle = '#e0a030';
      ctx.beginPath(); ctx.ellipse(x - 4, y + BR + 1, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + 4, y + BR + 1, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
    },
    barFill: '#5090b0', barTrack: 'rgba(0,0,0,0.08)', barText: 'rgba(0,0,0,0.35)',
    flashPass: 'rgba(80,180,80,', flashFail: 'rgba(180,60,60,',
  },
};

// ── Game ──────────────────────────────────────────────────────────────────────
function FlappyBallGame({
  activation, tOn, activeNow, decision, targetGesture, gestureColor,
  onPipeResolve, speedMultiplier, paused, theme,
}) {
  const canvasRef = useRef(null);
  const lastDecisionTokenRef = useRef(null);
  const tOnVal = tOn || T_ON_DEFAULT;

  const G = useRef({
    ballY: BALL_GROUND_Y,
    pipes: [],
    flash: 0,
    flashType: 'none',
    ready: false,
    clouds: Array.from({ length: 5 }, () => ({
      x: Math.random() * GW,
      y: 15 + Math.random() * 80,
      w: 50 + Math.random() * 70,
      speed: 0.15 + Math.random() * 0.25,
    })),
  });

  const L = useRef({
    activation, tOn: tOnVal, activeNow, decision, speedMultiplier, paused,
    onPipeResolve, targetGesture, gestureColor, theme: null,
  });

  useEffect(() => {
    L.current.activation      = activation;
    L.current.tOn             = tOnVal;
    L.current.activeNow       = activeNow;
    L.current.decision        = decision;
    L.current.speedMultiplier = speedMultiplier;
    L.current.paused          = paused;
    L.current.onPipeResolve   = onPipeResolve;
    L.current.targetGesture   = targetGesture;
    L.current.gestureColor    = gestureColor;
    L.current.theme           = theme;
  });

  function spawnPipe(x) {
    const minGapTop = MARGIN + BR + 6;
    const maxGapTop = GH - MARGIN - BR - GAP_H - 6;
    const gapTop    = minGapTop + Math.random() * (maxGapTop - minGapTop);
    return {
      x, gapTop,
      label: L.current.targetGesture || '?',
      color: L.current.gestureColor || '#5c5cff',
      evaluated: false, outcome: null,
      decisionToken: null, predicted: null, votes: null,
    };
  }

  useEffect(() => {
    const g = G.current;
    g.ballY = BALL_GROUND_Y;
    g.pipes = [
      spawnPipe(BX + PIPE_SPACING),
      spawnPipe(BX + PIPE_SPACING * 2),
      spawnPipe(BX + PIPE_SPACING * 3),
    ];
    g.ready = true;
  }, []);

  useEffect(() => {
    G.current.pipes.forEach(p => {
      if (!p.evaluated && p.outcome) {
        // Clear stale outcomes from classifications that arrived during overlay
        p.outcome = null; p.predicted = null;
        p.votes = null; p.decisionToken = null;
      }
      if (!p.outcome) {
        p.label = targetGesture || '?';
        p.color = gestureColor || '#5c5cff';
      }
    });
  }, [targetGesture, gestureColor]);

  useEffect(() => {
    if (!decision || !decision.token) {
      // Decision cleared (retry / advance) — purge stale outcomes on unevaluated pipes
      G.current.pipes.forEach(p => {
        if (!p.evaluated && p.outcome) {
          p.outcome = null; p.predicted = null;
          p.votes = null; p.decisionToken = null;
        }
      });
      return;
    }
    if (lastDecisionTokenRef.current === decision.token) return;
    lastDecisionTokenRef.current = decision.token;
    const pipe = G.current.pipes.find(p => !p.evaluated && !p.outcome);
    if (!pipe) return;
    pipe.outcome       = decision.isCorrect ? 'pass' : 'fail';
    pipe.predicted     = decision.predicted || null;
    pipe.votes         = decision.votes || [];
    pipe.decisionToken = decision.token;
  }, [decision]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx    = canvas.getContext('2d');
    const g      = G.current;
    let rafId;

    function loop() {
      if (!g.ready) { rafId = requestAnimationFrame(loop); return; }

      const l    = L.current;
      const spd  = BASE_SPEED * (l.speedMultiplier || 1);
      const tOn_ = l.tOn || T_ON_DEFAULT;
      const nextPipe = g.pipes.find(p => !p.evaluated);

      // Find the last evaluated pipe whose right edge the ball hasn't fully cleared yet
      // Use generous padding so the ball visually exits the pipe before changing course
      const CLEAR_PAD = BR + 12;
      const clearingPipe = [...g.pipes].reverse().find(
        p => p.evaluated && (p.x + PW) > (BX - CLEAR_PAD)
      );

      let targetY = BALL_GROUND_Y;
      if (clearingPipe?.outcome === 'pass') {
        // Keep the ball at gap center until it fully clears the pipe
        targetY = gapCenterY(clearingPipe.gapTop);
      } else if (clearingPipe?.outcome === 'fail') {
        targetY = missYForPipe(clearingPipe);
      } else if (nextPipe?.outcome === 'pass') {
        targetY = gapCenterY(nextPipe.gapTop);
      } else if (nextPipe?.outcome === 'fail') {
        targetY = missYForPipe(nextPipe);
      } else if (l.activeNow || l.activation >= tOn_) {
        targetY = BALL_HOVER_Y;
      }

      targetY = clamp(targetY, MARGIN + BR, GH - MARGIN - BR);
      // Faster easing when the ball is near/inside a pipe so it reaches the gap in time
      const nearPipe = nextPipe && (nextPipe.x - BX) < PIPE_SPACING * 0.35;
      const ease = (clearingPipe || nearPipe) ? 0.22 : 0.11;
      g.ballY += ease * (targetY - g.ballY);
      g.ballY = clamp(g.ballY, MARGIN + BR, GH - MARGIN - BR);

      if (!l.paused) {
        g.pipes.forEach(p => { p.x -= spd; });
        const last = g.pipes[g.pipes.length - 1];
        if (!last || last.x <= BX + PIPE_SPACING * 2) {
          g.pipes.push(spawnPipe((last?.x || BX) + PIPE_SPACING));
        }
        g.pipes = g.pipes.filter(p => p.x > -PW - 20);

        g.pipes.forEach(p => {
          if (!p.evaluated && p.x <= EVAL_X) {
            p.evaluated = true;
            const passed = p.outcome === 'pass';
            g.flash = 30;
            g.flashType = passed ? 'pass' : 'hit';
            l.onPipeResolve && l.onPipeResolve({
              passed,
              predicted: p.predicted,
              votes: p.votes || [],
              decisionToken: p.decisionToken,
            });
          }
        });
      }

      if (g.flash > 0) g.flash--;

      const T = l.theme || GAME_THEMES.outdoor;

      // ── Background ──
      T.drawBg(ctx, g);

      // ── Subtle pass/fail tint ──
      if (g.flash > 0) {
        const alpha = (g.flash / 30) * 0.08;
        ctx.fillStyle = (g.flashType === 'pass' ? T.flashPass : T.flashFail) + alpha + ')';
        ctx.fillRect(0, 0, GW, GH);
      }

      // ── Pipes ──
      g.pipes.forEach(p => {
        const gapBot = p.gapTop + GAP_H;
        T.drawPipe(ctx, p.x, 0, PW, p.gapTop, p.color);
        T.drawPipe(ctx, p.x, gapBot, PW, GH - gapBot, p.color);

        if (T.drawLabel) {
          T.drawLabel(ctx, p);
        } else {
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = T.pipeLabel;
          ctx.fillText(p.label, p.x + PW / 2, gapCenterY(p.gapTop));
        }
      });
      // added

      // ── Character ──
      T.drawChar(ctx, BX, g.ballY, g.flash, g.flashType);

      // ── Activation bar ──
      if (T.drawBar) {
        T.drawBar(ctx, l.activation, tOn_);
      } else {
        const barH  = GH - 30;
        const fillH = Math.min(1, l.activation / (tOn_ * 2.5)) * barH;
        ctx.fillStyle = T.barTrack;
        ctx.beginPath();
        ctx.roundRect(8, 15, 10, barH, 5);
        ctx.fill();

        if (fillH > 0) {
          ctx.fillStyle = T.barFill;
          ctx.beginPath();
          ctx.roundRect(8, 15 + barH - fillH, 10, fillH, 4);
          ctx.fill();
        }

        ctx.fillStyle = T.barText;
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(l.activation.toFixed(1), 13, GH - 4);
      }

      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={GW}
      height={GH}
      style={{
        width:'100%',
        height:'auto',
        display:'block',
        borderRadius:10,
        border:`1px solid ${(theme || GAME_THEMES.outdoor).border}`,
        background:'#05050a',
        boxShadow:'0 10px 28px rgba(0,0,0,0.22)',
      }}
    />
  );
}

// ── Votes bar ─────────────────────────────────────────────────────────────────
function VotesPie({ votes }) {
  if (!votes || !votes.length) return null;
  const counts = {};
  votes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total  = votes.length;
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4, padding:'10px 14px',
      background:'#0d0d1a', border:'1px solid #1e1e35', borderRadius:8 }}>
      <div style={{ fontSize:'0.7rem', color:'#555', fontFamily:'monospace', marginBottom:2 }}>
        VOTES ({total})
      </div>
      {sorted.map(([name, n]) => {
        const pct = Math.round((n / total) * 100);
        const col = GESTURE_COLORS[name] || '#555';
        return (
          <div key={name} style={{ display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:col, flexShrink:0 }} />
            <div style={{ flex:1, height:4, background:'#151525', borderRadius:2, overflow:'hidden' }}>
              <div style={{ width:`${pct}%`, height:'100%', background:col, transition:'width 0.3s' }} />
            </div>
            <span style={{ fontSize:'0.68rem', color:'#888', fontFamily:'monospace', minWidth:65 }}>
              {name.slice(0, 10)} {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function TestingPage({ socket, connected, user, onSessionEnd, mode = 'simulated', liveOpts = { host:'0.0.0.0', port:'45454' } }) {

  const [gestures,      setGestures]      = useState([]);
  const [focusGestures, setFocusGestures] = useState([]);
  const [speedMult,     setSpeedMult]     = useState(1.0);
  const [gameTheme,     setGameTheme]     = useState('default');

  const [sessionId,      setSessionId]      = useState(null);
  const [gesturePool,    setGesturePool]    = useState([]);
  const [currentGesture, setCurrentGesture] = useState(null);
  const [phase,          setPhase]          = useState('setup');
  const [countdown,      setCountdown]      = useState(null);
  const [retryCount,     setRetryCount]     = useState(0);
  const [gamePaused,     setGamePaused]     = useState(false);

  const [simIdx,   setSimIdx]   = useState(0);
  const simIdxRef  = useRef(0);

  const [prediction,    setPrediction]    = useState(null);
  const [votes,         setVotes]         = useState([]);
  const [pendingResult, setPendingResult] = useState(null);
  const [liveStateLabel, setLiveStateLabel] = useState('REST');

  const [activation,  setActivation]  = useState(0);
  const [tOnLive,     setTOnLive]     = useState(T_ON_DEFAULT);
  const [tOffLive,    setTOffLive]    = useState(T_OFF_DEFAULT);
  const [channels,    setChannels]    = useState(
    () => Array.from({ length:64 }, (_, i) => i < 57 ? 0.4 + Math.random() * 0.3 : 0.05)
  );
  const [actHistory,  setActHistory]  = useState([]);
  const [stats,       setStats]       = useState({ correct:0, incorrect:0, skipped:0, total:0 });

  const simRef      = useRef(null);
  const simRunning  = useRef(false);
  const simResetRef = useRef(false);
  const curRef      = useRef(null);
  const poolRef     = useRef([]);
  const classifyRef = useRef(null);
  const tOnRef      = useRef(T_ON_DEFAULT);
  const gameShellRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current  = phase;          }, [phase]);
  useEffect(() => { curRef.current    = currentGesture; }, [currentGesture]);
  useEffect(() => { poolRef.current   = gesturePool;    }, [gesturePool]);
  useEffect(() => { simIdxRef.current = simIdx;         }, [simIdx]);
  useEffect(() => { tOnRef.current    = tOnLive;        }, [tOnLive]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === gameShellRef.current);
    };

    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Fetch eligible gestures ───────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    fetch(`${API}/api/testing/gestures/${user.id}`)
      .then(r => r.json())
      .then(d => setGestures(d.gestures || []))
      .catch(() => {});
  }, [user?.id]);

  // ── Pool helpers ──────────────────────────────────────────────────────────
  const buildPool = useCallback((gs, focus) => {
    const pool = [];
    gs.forEach(g => {
      const pw = Math.max(1, Math.round((100 - (g.accuracy || 100)) / 10) + 1);
      const fb = focus.includes(g.name) ? 3 : 1;
      for (let i = 0; i < pw * fb; i++) pool.push(g);
    });
    return pool;
  }, []);

  const pickFromPool = useCallback((pool) => {
    const p = pool || poolRef.current;
    return p.length ? p[Math.floor(Math.random() * p.length)] : null;
  }, []);

  // ── Advance to next gesture ───────────────────────────────────────────────
  const advanceToNext = useCallback(() => {
    setPrediction(null); setVotes([]); setPendingResult(null);
    setRetryCount(0); setGamePaused(false);
    simResetRef.current = true;
    if (mode === 'simulated') {
      const next = (simIdxRef.current + 1) % SIM_GESTURE_ORDER.length;
      setSimIdx(next); simIdxRef.current = next;
      setCurrentGesture({ name: SIM_GESTURE_ORDER[next], gestureId: next });
    } else {
      setCurrentGesture(pickFromPool(poolRef.current));
    }
    setPhase('prompting');
  }, [mode, pickFromPool]);

  // ── Record trial ──────────────────────────────────────────────────────────
  const recordTrial = useCallback(async (gesture, pred, isCorrect, isSkipped = false) => {
    if (!gesture || !sessionId) return;
    try {
      await fetch(`${API}/api/testing/trial`, {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          userId:      user?.id, sessionId,
          gestureId:   gesture.gestureId,
          prediction:  pred || 'skipped',
          groundTruth: gesture.name,
          wasCorrect:  isCorrect, wasSkipped: isSkipped, retryCount,
        }),
      });
    } catch (_) {}
  }, [sessionId, user, retryCount]);

  // ── Classification handler ────────────────────────────────────────────────
  const decisionSeqRef = useRef(0);
  const pendingResultRef = useRef(null);
  useEffect(() => { pendingResultRef.current = pendingResult; }, [pendingResult]);

  const handleClassification = useCallback((predicted, voteList) => {
    const gesture = curRef.current;
    if (!gesture || pendingResultRef.current) return;
    // Only accept classifications while actively prompting
    if (phaseRef.current !== 'prompting') return;
    decisionSeqRef.current += 1;
    setPendingResult({
      token: decisionSeqRef.current,
      predicted,
      votes: voteList || [],
      isCorrect: predicted === gesture.name,
    });
  }, []);
  classifyRef.current = handleClassification;

  // ── Mismatch overlay actions ──────────────────────────────────────────────
  const handleCorrect = useCallback(async () => {
    const g = curRef.current;
    setStats(prev => ({ ...prev, correct: prev.correct + 1, total: prev.total + 1 }));
    await recordTrial(g, prediction, true, false);
    advanceToNext();
  }, [prediction, recordTrial, advanceToNext]);

  const handleIncorrect = useCallback(async () => {
    const g = curRef.current;
    setStats(prev => ({ ...prev, incorrect: prev.incorrect + 1, total: prev.total + 1 }));
    await recordTrial(g, prediction, false, false);
    if (retryCount < MAX_RETRIES - 1) {
      setRetryCount(p => p + 1);
      setPrediction(null); setVotes([]); setPendingResult(null);
      setGamePaused(false); setPhase('prompting');
    } else {
      advanceToNext();
    }
  }, [prediction, recordTrial, retryCount, advanceToNext]);

  const handleSkip = useCallback(async () => {
    const g = curRef.current;
    setStats(prev => ({ ...prev, skipped: prev.skipped + 1, total: prev.total + 1 }));
    await recordTrial(g, null, false, true);
    advanceToNext();
  }, [recordTrial, advanceToNext]);

  const onPipeResolve = useCallback(async ({ passed, predicted, votes: pipeVotes }) => {
    const g = curRef.current;
    const result = pendingResultRef.current;

    if (result?.isCorrect && passed) {
      setStats(prev => ({ ...prev, correct: prev.correct + 1, total: prev.total + 1 }));
      await recordTrial(g, result.predicted, true, false);
      advanceToNext();
      return;
    }

    setPrediction(result?.predicted || predicted || 'No gesture detected');
    setVotes(result?.votes?.length ? result.votes : (pipeVotes || []));
    setPendingResult(null);
    setGamePaused(true);
    setPhase('result');
  }, [recordTrial, advanceToNext]);

  // ═════════════════════════════════════════════════════════════════════════
  // ── SIMULATION TICKER ─────────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (mode !== 'simulated') return;

    const TICK       = 50;
    const FPS        = 1000 / TICK;
    const TICKS_REST = Math.round(1.2 * FPS);
    const TICKS_HOLD = Math.round(2.0 * FPS);
    // Sim uses scaled values — rise to T_ON_DEFAULT * 3 so the bar looks full
    const SIM_T_ON   = T_ON_DEFAULT;

    let simPhase = 'rest';
    let timer    = 0;
    let act      = 0;
    let fired    = false;

    const iv = setInterval(() => {
      if (!simRunning.current) return;

      // Reset sim internal state when a new gesture starts
      if (simResetRef.current) {
        simResetRef.current = false;
        simPhase = 'rest';
        timer = 0;
        act = 0;
        fired = false;
      }

      timer++;
      const noise = () => (Math.random() - 0.5) * (SIM_T_ON * 0.04);

      if (simPhase === 'rest') {
        act = Math.max(0, act * 0.88 + noise());
        if (timer > TICKS_REST) { simPhase = 'rising'; timer = 0; fired = false; }

      } else if (simPhase === 'rising') {
        act = Math.min(SIM_T_ON * 3.8, act + SIM_T_ON * 0.14 + noise());
        if (act >= SIM_T_ON && !fired) {
          fired = true;
          const idx       = simIdxRef.current;
          const target    = SIM_GESTURE_ORDER[idx];
          const correct   = Math.random() < 0.70;
          const predicted = correct
            ? target
            : ALL_GESTURES[Math.floor(Math.random() * ALL_GESTURES.length)];
          const fv = Array.from({ length:30 }, () =>
            Math.random() < 0.75
              ? predicted
              : ALL_GESTURES[Math.floor(Math.random() * ALL_GESTURES.length)]
          );
          setVotes(fv);
          classifyRef.current(predicted, fv);
        }
        if (act >= SIM_T_ON * 3.6) { simPhase = 'hold'; timer = 0; }

      } else if (simPhase === 'hold') {
        act = Math.max(SIM_T_ON * 3.2, Math.min(SIM_T_ON * 3.9, act + noise() * 0.25));
        if (timer > TICKS_HOLD) { simPhase = 'falling'; timer = 0; }

      } else {
        act = Math.max(0, act - SIM_T_ON * 0.11 + noise());
        if (act < SIM_T_ON * 0.15) { simPhase = 'rest'; timer = 0; act = 0; }
      }

      setActivation(act);
      setActHistory(prev => {
        const n = [...prev, act];
        return n.length > 120 ? n.slice(-120) : n;
      });
    }, TICK);

    simRef.current = iv;
    return () => { clearInterval(iv); simRef.current = null; };
  }, [mode]);

  useEffect(() => {
    simRunning.current = (phase === 'prompting');
  }, [phase]);

  // ═════════════════════════════════════════════════════════════════════════
  // ── LIVE EMG SOCKET HANDLER ────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!socket || mode !== 'live') return;

    let lastLabel = '';

    const onState = (data) => {
      const act   = typeof data.act === 'number' ? data.act : 0;
      const label = data.label || '';
      setLiveStateLabel(label || 'REST');
      setActivation(act);
      setActHistory(prev => {
        const n = [...prev, act];
        return n.length > 120 ? n.slice(-120) : n;
      });

      // Classify as soon as prediction is available (during ACTIVE),
      // not just on ACTIVE→REST — so the ball moves early.
      const gesture  = data.gesture || '';
      const voteList = Array.isArray(data.votes) ? data.votes : [];
      const isReal   = gesture && gesture !== 'REST' && gesture !== '—' && gesture !== '';

      if (label === 'ACTIVE' && isReal) {
        classifyRef.current(gesture, voteList);
      }
      // Fallback: also trigger on ACTIVE→REST in case the early one was missed
      if (lastLabel === 'ACTIVE' && label === 'REST' && isReal) {
        classifyRef.current(gesture, voteList);
      }
      lastLabel = label;
    };

    // signal event carries t_on / t_off so the strip always draws correct lines
    const onSignal = (data) => {
      try {
        // Update threshold refs if backend sends them
        if (typeof data.t_on  === 'number') { setTOnLive(data.t_on);   tOnRef.current = data.t_on; }
        if (typeof data.t_off === 'number')   setTOffLive(data.t_off);

        const flex = data.flexors  || [];
        const ext  = data.extensors || [];
        const flexVal = flex.length  ? flex[flex.length - 1].y  : 0;
        const extVal  = ext.length   ? ext[ext.length  - 1].y   : 0;
        // Scale channel activity for SensorStatusBar:
        // divide by T_ON so values > 1 mean "active"
        const tOn_ = tOnRef.current || T_ON_DEFAULT;
        const ch = Array.from({ length: 64 }, (_, i) => {
          const base = i < 32 ? flexVal : extVal;
          return (base / tOn_) * (0.7 + Math.random() * 0.6);
        });
        setChannels(ch);
      } catch (_) {}
    };

    socket.on('state',  onState);
    socket.on('signal', onSignal);
    return () => {
      socket.off('state',  onState);
      socket.off('signal', onSignal);
    };
  }, [socket, mode]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await gameShellRef.current?.requestFullscreen?.();
      } else if (document.fullscreenElement === gameShellRef.current) {
        await document.exitFullscreen?.();
      }
    } catch (_) {}
  }, []);

  // ── Start session ─────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    const eligibleGs = gestures.filter(g => g.eligible);
    const firstGesture = mode === 'simulated'
      ? { name: SIM_GESTURE_ORDER[0], gestureId: 0 }
      : pickFromPool(buildPool(eligibleGs, focusGestures));
    if (!firstGesture) return;

    try {
      let sid = null;
      try {
        const r = await fetch(`${API}/api/testing/session`, {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ userId: user?.id }),
        });
        sid = (await r.json()).sessionId;
      } catch (_) {}

      if (mode !== 'simulated') {
        const pool = buildPool(eligibleGs, focusGestures);
        setGesturePool(pool); poolRef.current = pool;
      }

      setSessionId(sid);
      setSimIdx(0); simIdxRef.current = 0;
      setCurrentGesture(firstGesture);
      setRetryCount(0);
      setStats({ correct:0, incorrect:0, skipped:0, total:0 });
      setPrediction(null); setVotes([]); setPendingResult(null);
      setActHistory([]); setActivation(0);
      setGamePaused(false);

      // Countdown 3 → 2 → 1 → go
      setPhase('countdown');
      setCountdown(3);
      let count = 3;
      const cdInterval = setInterval(() => {
        count--;
        if (count > 0) {
          setCountdown(count);
        } else {
          clearInterval(cdInterval);
          setCountdown(null);
          setPhase('prompting');
        }
      }, 1000);

      if (socket && mode === 'live') socket.emit('start', { mode:'live', liveOpts, userId: user?.id }); //CHANGE???
    } catch (e) {
      console.error('Failed to start testing session:', e);
    }
  }, [user, mode, liveOpts, gestures, focusGestures, buildPool, pickFromPool, socket]);

  // ── End session ───────────────────────────────────────────────────────────
  const endSession = useCallback(async (status = 'completed') => {
    simRunning.current = false;
    setPhase('done');
    if (socket) socket.emit('stop');
    if (simRef.current) { clearInterval(simRef.current); simRef.current = null; }
    if (sessionId) {
      try {
        await fetch(`${API}/api/testing/session/${sessionId}/end`, {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ status }),
        });
      } catch (_) {}
    }
  }, [socket, sessionId]);

  const toggleFocus = (name) =>
    setFocusGestures(p => p.includes(name) ? p.filter(n => n !== name) : [...p, name]);

  const gColor       = GESTURE_COLORS[currentGesture?.name] || '#5c5cff';
  const eligibleGs   = gestures.filter(g => g.eligible);
  const ineligibleGs = gestures.filter(g => !g.eligible);
  const accLive      = stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : null;

  // ═════════════════════════════════════════════════════════════════════════
  // ── SETUP ─────────────────────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════
  if (phase === 'setup') return (
    <div className="testing-page" style={{ maxWidth:920, margin:'0 auto', padding:'0 0 40px' }}>
      <div className="card test-setup-card">
        <h3 className="dashboard-card-title">Practice Session Setup</h3>
        <div className="train-setup-grid">

          <div className="train-setup-section" style={{ gridColumn:'1 / -1' }}>
            <label className="train-setup-label">
              {mode === 'simulated'
                ? `Simulation gesture order (${SIM_GESTURE_ORDER.length} gestures, fixed)`
                : 'Eligible Gestures — click to focus (★ = 3× more frequent)'}
            </label>
            {mode === 'simulated' ? (
              <div style={{ marginTop: 6, fontSize: '0.78rem', color: '#888' }}>
                Simulation uses a fixed internal gesture order.
              </div>
            ) : (
              <>
                <div className="train-gesture-chips">
                  {eligibleGs.length === 0 && (
                    <span className="train-no-gestures">No eligible gestures (need ≥15 reps)</span>
                  )}
                  {eligibleGs.map(g => {
                    const focused = focusGestures.includes(g.name);
                    const col = GESTURE_COLORS[g.name] || '#5c5cff';
                    return (
                      <div key={g.gestureId} className="train-gesture-chip"
                        onClick={() => toggleFocus(g.name)}
                        style={{ cursor:'pointer',
                          border: focused ? `2px solid ${col}` : '2px solid transparent',
                          boxShadow: focused ? `0 0 8px ${col}44` : 'none',
                          transition:'all 0.15s' }}>
                        {focused && <span style={{ color:col, marginRight:4 }}>★</span>}
                        <span>{g.name}</span>
                        <span className="test-chip-acc">{g.accuracy}%</span>
                      </div>
                    );
                  })}
                </div>
                {ineligibleGs.length > 0 && (
                  <div className="test-ineligible" style={{ marginTop:10 }}>
                    <label className="train-setup-label"
                      style={{ fontSize:'0.72rem', color:'#999' }}>Not yet eligible</label>
                    <div className="train-gesture-chips">
                      {ineligibleGs.map(g => (
                        <div key={g.gestureId} className="train-gesture-chip test-chip-disabled">
                          <span>{g.name}</span>
                          <span className="test-chip-reps">{g.totalTrained}/15</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="train-setup-section">
            <label className="train-setup-label">Game Speed</label>
            <div className="train-length-options">
              {[['Slow',0.6],['Normal',1.0],['Fast',1.4]].map(([l, v]) => (
                <button key={l} className={`btn btn-mode ${speedMult===v?'active':''}`}
                  onClick={() => setSpeedMult(v)}>{l}</button>
              ))}
            </div>
          </div>

          <div className="train-setup-section">
            <label className="train-setup-label">Theme</label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:4 }}>
              {Object.entries(GAME_THEMES).map(([key, t]) => (
                <button key={key}
                  className={`btn btn-mode ${gameTheme===key?'active':''}`}
                  onClick={() => setGameTheme(key)}
                  style={{ display:'flex', alignItems:'center', gap:5, fontSize:'0.78rem' }}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>


        </div>

        <div className="train-instructions">
          <p>
            {mode === 'simulated'
              ? 'Simulation cycles through the gesture order automatically. The activation bar shows signal level, while the ball only lifts on activation and then locks to a pass or miss lane.'
              : 'Hold each prompted gesture — the activation bar shows EMG level, the ball lifts when you activate, and it aligns with the gap only when the classified gesture is correct. Session runs until you click End Session.'}
          </p>
        </div>

        <button className="btn btn-start train-start-btn" onClick={handleStart}
          disabled={mode==='live' && (!connected || eligibleGs.length===0)}>
          ▶ Start
        </button>
      </div>
    </div>
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ── COUNTDOWN ─────────────────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════
  if (phase === 'countdown') return (
    <div className="testing-page" style={{ maxWidth:820, margin:'0 auto', padding:'0 0 40px',
      display:'flex', alignItems:'center', justifyContent:'center', minHeight:400 }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:'1rem', color:'#888', fontFamily:'monospace',
          letterSpacing:3, marginBottom:24 }}>GAME STARTING IN</div>
        <div style={{
          fontSize:'6rem', fontWeight:900, fontFamily:'monospace',
          color:'#5b6abf', textShadow:'0 0 40px #5b6abf66, 0 0 80px #5b6abf22',
          animation:'pulse 1s ease-in-out infinite',
          lineHeight:1,
        }}>{countdown}</div>
      </div>
    </div>
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ── DONE ──────────────────────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════
  if (phase === 'done') {
    const acc = stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : 0;
    return (
      <div className="testing-page" style={{ maxWidth:760, margin:'0 auto' }}>
        <div className="card test-done-card">
          <h3 className="test-done-title">Session Complete</h3>
          <div className="test-done-stats">
            {[
              ['Correct',   stats.correct,   'test-done-correct'],
              ['Incorrect', stats.incorrect, 'test-done-incorrect'],
              ['Skipped',   stats.skipped,   'test-done-skipped'],
              ['Accuracy',  `${acc}%`,        ''],
            ].map(([l, v, c]) => (
              <div key={l} className="test-done-stat">
                <span className={`test-done-value ${c}`}>{v}</span>
                <span className="test-done-label">{l}</span>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:10, justifyContent:'center', marginTop:18 }}>
            <button className="btn btn-start test-new-btn" onClick={() => {
              setPhase('setup'); setSessionId(null); setCurrentGesture(null);
              setStats({ correct:0, incorrect:0, skipped:0, total:0 });
            }}>New Session</button>
            {onSessionEnd &&
              <button className="btn btn-stop" onClick={onSessionEnd}>Log Out</button>}
          </div>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ── ACTIVE SESSION ────────────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div
      className="testing-page"
      style={{
        position:'relative',
        maxWidth:1120,
        margin:'0 auto',
        paddingBottom:20,
      }}
    >

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:10, gap:12, flexWrap:'wrap' }}>
        <div style={{ display:'flex', gap:14, alignItems:'center',
          fontFamily:'monospace', fontSize:'0.8rem' }}>
          <span style={{ color:'#35d06e' }}>✓ {stats.correct}</span>
          <span style={{ color:'#ff4081' }}>✗ {stats.incorrect}</span>
          <span style={{ color:'#888' }}>⟶ {stats.skipped}</span>
          {accLive !== null && <span style={{ color:'#aaa' }}>acc {accLive}%</span>}
          {mode === 'simulated' && (
            <span style={{ color:'#555', fontSize:'0.7rem' }}>
              #{simIdx + 1}/{SIM_GESTURE_ORDER.length}
            </span>
          )}
          {/* {mode === 'live' && (
            <span style={{ color:'#555', fontSize:'0.7rem', fontFamily:'monospace' }}>
              T_ON={tOnLive} T_OFF={tOffLive}
            </span>
          )} */}
        </div>
        <SensorStatusBar channels={channels} />
        <div style={{ display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
          <button className="btn btn-stop" style={{ flexShrink:0 }}
            onClick={() => endSession('aborted')}>■ End Session</button>
        </div>
      </div>

      {/* Gesture prompt */}
      {currentGesture && (
        <div style={{ display:'flex', alignItems:'center', gap:16,
          background:'#0d0d1a', border:`1px solid ${gColor}44`,
          borderRadius:10, padding:'12px 18px', marginBottom:6,
          boxShadow:`0 0 20px ${gColor}12`, maxWidth:GAME_VIEW_MAX, marginInline:'auto', width:'100%', boxSizing:'border-box' }}>
          {GESTURE_IMAGES[currentGesture.name] && (
            <img src={GESTURE_IMAGES[currentGesture.name]} alt={currentGesture.name}
              style={{ width:70, height:70, objectFit:'cover', borderRadius:10,
                border:'none', flexShrink:0 }} />
          )}
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:'0.72rem', color:'#888', fontFamily:'monospace', letterSpacing:1.2 }}>
              {mode === 'simulated' ? 'PROMPT' : 'PERFORM THIS GESTURE'}
            </div>
            <div style={{ fontSize:'1.72rem', fontWeight:800, color:gColor,
              fontFamily:'monospace', letterSpacing:2, textShadow:`0 0 14px ${gColor}`, lineHeight:1.05 }}>
              {currentGesture.name.toUpperCase()}
            </div>
          </div>
          {retryCount > 0 && (
            <div style={{ marginLeft:'auto', background:'#1a1020',
              border:'1px solid #ffd74055', borderRadius:6,
              padding:'4px 10px', fontSize:'0.76rem', color:'#ffd740', fontFamily:'monospace' }}>
              Retry {retryCount}/{MAX_RETRIES}
            </div>
          )}

          {/* Live detected gesture indicator */}
          {pendingResult?.predicted && (() => {
            const isMatch = pendingResult.predicted === currentGesture?.name;
            const predGestureCol = GESTURE_COLORS[pendingResult.predicted] || '#00e5ff';
            const detCol = isMatch ? SUCCESS_GREEN : '#ff4081';
            return (
              <div style={{ marginLeft: retryCount > 0 ? 0 : 'auto',
                display:'flex', alignItems:'center', gap:10,
                background:'#0a0a16', border:`1px solid ${detCol}44`,
                borderRadius:8, padding:'6px 14px' }}>
                {GESTURE_IMAGES[pendingResult.predicted] && (
                  <img src={GESTURE_IMAGES[pendingResult.predicted]} alt={pendingResult.predicted}
                    style={{ width:36, height:36, objectFit:'cover', borderRadius:6,
                      border:'none' }} />
                )}
                <div>
                  <div style={{ fontSize:'0.6rem', color:'#666', fontFamily:'monospace', letterSpacing:1 }}>
                    DETECTED
                  </div>
                  <div style={{ fontSize:'1rem', fontWeight:800, color:predGestureCol,
                    fontFamily:'monospace', letterSpacing:1,
                    textShadow:`0 0 10px ${predGestureCol}` }}>
                    {pendingResult.predicted.toUpperCase()}
                  </div>
                </div>
                <span style={{ fontSize:'1.2rem', color:detCol, fontWeight:800 }}>{isMatch ? '✓' : '✗'}</span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Game */}
      <div
        ref={gameShellRef}
        style={{
          position:'relative',
          marginTop:4,
          maxWidth:isFullscreen ? 'none' : GAME_VIEW_MAX,
          marginInline:'auto',
          background:isFullscreen ? '#05050a' : 'transparent',
          width:'100%',
          height:isFullscreen ? '100vh' : 'auto',
          display:'flex',
          flexDirection:'column',
          justifyContent:'center',
          padding:isFullscreen ? '24px' : 0,
          boxSizing:'border-box',
        }}
      >
        <div
          style={{
            position:'relative',
            width:'100%',
            maxWidth:isFullscreen ? 'min(1400px, 96vw)' : '100%',
            margin:'0 auto',
            padding:isFullscreen ? 20 : 0,
            borderRadius:isFullscreen ? 16 : 0,
            background:isFullscreen ? '#0b0b14' : 'transparent',
            boxShadow:isFullscreen ? '0 0 0 1px #1e1e35, 0 20px 60px rgba(0,0,0,0.45)' : 'none',
          }}
        >
          <FlappyBallGame
            activation={activation}
            tOn={tOnLive}
            activeNow={mode === 'live' ? liveStateLabel === 'ACTIVE' : activation >= T_ON_DEFAULT}
            decision={pendingResult}
            targetGesture={currentGesture?.name}
            gestureColor={gColor}
            onPipeResolve={onPipeResolve}
            speedMultiplier={speedMult}
            paused={gamePaused}
            theme={GAME_THEMES[gameTheme] || GAME_THEMES.outdoor}
          />

          <button
            type="button"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            onClick={toggleFullscreen}
            style={{
              position:'absolute',
              top:isFullscreen ? 32 : 10,
              right:isFullscreen ? 32 : 10,
              width:38,
              height:38,
              borderRadius:10,
              border:'1px solid #ffffff22',
              background:'rgba(8,10,18,0.72)',
              color:'#d8deff',
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              cursor:'pointer',
              backdropFilter:'blur(6px)',
              boxShadow:'0 4px 16px rgba(0,0,0,0.28)',
              zIndex:5,
            }}
          >
            <span style={{ fontSize:'1rem', lineHeight:1 }}>{isFullscreen ? '🗗' : '⛶'}</span>
          </button>

          {/* Mismatch overlay */}
          {phase === 'result' && (
            <div style={{ position:'absolute', inset:isFullscreen ? 24 : 16, background:'#000000cc',
              borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <div style={{ background:'#0f0f1e', border:'1px solid #1e1e35',
                borderRadius:14, padding:'28px 36px', textAlign:'center',
                maxWidth:420, width:'90%', boxShadow:'0 0 60px #000' }}>
                <div style={{ fontSize:'0.7rem', color:'#555', fontFamily:'monospace',
                  letterSpacing:2, marginBottom:12 }}>CLASSIFICATION RESULT</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
                  gap:16, marginBottom:16 }}>
                  <div>
                    <div style={{ fontSize:'0.68rem', color:'#555', fontFamily:'monospace' }}>EXPECTED</div>
                    <div style={{ fontSize:'1.3rem', fontWeight:800, color:'#aaa', fontFamily:'monospace' }}>
                      {currentGesture?.name}
                    </div>
                  </div>
                  <div style={{ fontSize:'1.5rem', color:'#555' }}>→</div>
                  <div>
                    <div style={{ fontSize:'0.68rem', color:'#555', fontFamily:'monospace' }}>PREDICTED</div>
                    <div style={{ fontSize:'1.3rem', fontWeight:800, fontFamily:'monospace',
                      color:'#ff4081', textShadow:'0 0 10px #ff4081' }}>
                      {prediction || '?'}
                    </div>
                  </div>
                </div>
                {votes.length > 0 && <div style={{ marginBottom:16 }}><VotesPie votes={votes} /></div>}
                <div style={{ fontSize:'0.8rem', color:'#888', marginBottom:14 }}>
                  Is this what you did?
                </div>
                <div style={{ display:'flex', gap:8, justifyContent:'center' }}>
                  <button className="btn test-correct-btn" onClick={handleCorrect}>✓ Yes</button>
                  <button className="btn test-incorrect-btn" onClick={handleIncorrect}>✗ No</button>
                  <button className="btn test-skip-btn" onClick={handleSkip}>Skip</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* EMG strip — passes live absolute thresholds */}
        <div style={{ marginTop:12, width:'100%', maxWidth:GAME_VIEW_MAX, marginInline:'auto' }}>
          <EMGStrip actHistory={actHistory} tOn={tOnLive} tOff={tOffLive} />
        </div>
      </div>

      {/* Skip */}
      {phase !== 'result' && (
        <button className="btn test-skip-btn" onClick={handleSkip}
          style={{ position:'fixed', bottom:28, right:28,
            boxShadow:'0 4px 20px #0008', zIndex:100, opacity:0.85 }}>
          Skip →
        </button>
      )}
    </div>
  );
}