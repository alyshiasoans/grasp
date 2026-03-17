import React, { useState, useEffect } from 'react';

const STATE_COLORS = {
  REST: '#999',
  ACTIVE: '#5b6abf',
  'LOADING...': '#aaa',
  'DONE ✓': '#34c759',
  STOPPED: '#c44',
};

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

function GestureDisplay({ label, gesture, color, activation }) {
  const labelColor = STATE_COLORS[label] || '#888888';
  const clampedAct = Math.min(activation, 5.0);
  const barPercent = Math.min((clampedAct / 3.0) * 100, 100);

  let barColor = '#ccc';
  if (activation > 1.0) barColor = '#e05555';
  else if (activation > 0.6) barColor = '#e0a030';
  else barColor = '#5b6abf';

  const imageSrc = GESTURE_IMAGES[gesture] || null;
  const [displayedImage, setDisplayedImage] = useState(null);
  const [displayedGesture, setDisplayedGesture] = useState('—');
  const [displayedColor, setDisplayedColor] = useState('#999');
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (imageSrc && imageSrc !== displayedImage) {
      // New valid gesture — update text and image with animation
      setDisplayedImage(imageSrc);
      setDisplayedGesture(gesture);
      setDisplayedColor(color);
      setAnimating(true);
      const timer = setTimeout(() => setAnimating(false), 300);
      return () => clearTimeout(timer);
    } else if (imageSrc && gesture !== displayedGesture) {
      // Same image path but gesture name changed
      setDisplayedGesture(gesture);
      setDisplayedColor(color);
    } else if (!imageSrc && label === 'REST' && gesture === 'REST') {
      // Fully back to rest — clear everything
      setDisplayedImage(null);
      setDisplayedGesture('REST');
      setDisplayedColor('#999');
    }
    // If no valid gesture but ACTIVE, keep showing the last one
  }, [imageSrc, label, gesture, color, displayedImage, displayedGesture]);

  // Show the stable gesture name: use displayedGesture during ACTIVE if gesture is empty
  const shownGesture = (gesture && GESTURE_IMAGES[gesture]) ? gesture
    : (label === 'ACTIVE' && displayedGesture && displayedGesture !== 'REST' && displayedGesture !== '—') ? displayedGesture
    : gesture || '—';
  const shownColor = (shownGesture === displayedGesture && displayedColor !== '#999') ? displayedColor : color;

  return (
    <div className="card gesture-card">
      <div className="state-label" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="gesture-name" style={{ color: shownColor }}>
        {shownGesture}
      </div>

      {displayedImage && (
        <div className={`gesture-image-wrapper${animating ? ' gesture-animate' : ''}`}>
          <img
            src={displayedImage}
            alt={gesture}
            className="gesture-image"
            style={{}}
          />
        </div>
      )}

      <div className="activation-section">
        <div className="activation-label">
          <span>Activation</span>
          <span>{activation.toFixed(2)}</span>
        </div>
        <div className="activation-bar-bg">
          <div
            className="activation-bar-fill"
            style={{
              width: `${barPercent}%`,
              background: barColor,

            }}
          />
        </div>
      </div>
    </div>
  );
}

export default GestureDisplay;
