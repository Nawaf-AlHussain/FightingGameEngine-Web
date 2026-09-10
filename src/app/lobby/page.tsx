'use client';

import { useEffect, useState } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';

export default function LobbyPage() {
  const { navigate } = useWipeNavigation();
  const [glow, setGlow] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setGlow(g => !g), 2000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = () => {
    navigate('/local');
  };

  const handleSettings = () => {
    navigate('/settings');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleStart();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      handleSettings();
    }
  };

  return (
    <main
      className="lobby bg-grid"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label="Title screen"
    >
      {/* Animated red glow behind the title */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          filter: 'blur(150px)',
          background: glow
            ? 'radial-gradient(circle, rgba(217,35,35,0.30), transparent 70%)'
            : 'radial-gradient(circle, rgba(217,35,35,0.15), transparent 70%)',
          opacity: glow ? 1 : 0.5,
          transition: 'opacity 1s ease, background 1s ease',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {/* Title */}
      <div className="lobby__title" style={{ zIndex: 1 }}>
        <h1 className="lobby__title-main text-stroke text-shadow-red">
          <span>FIGHTING </span>
          <span>GAME</span>
        </h1>
        <div className="lobby__title-sub">ENGINE · WASM · 60FPS</div>
      </div>

      {/* PRESS START button (angular clip-path from CSS) */}
      <button
        type="button"
        className="lobby__start-btn"
        onClick={handleStart}
        style={{ zIndex: 1 }}
      >
        PRESS START
      </button>

      {/* SETTINGS button — sits below PRESS START, smaller secondary style */}
      <button
        type="button"
        className="lobby__settings-btn"
        onClick={handleSettings}
        style={{ zIndex: 1 }}
        aria-label="Open settings"
      >
        ⚙ SETTINGS
      </button>

      {/* Controls hint */}
      <div
        className="cs__controls-help"
        style={{
          marginTop: '2rem',
          textAlign: 'center',
          zIndex: 1,
        }}
      >
        <div>P1: <span>WASD</span> move · <span>U I O</span> punches · <span>J K L</span> kicks</div>
        <div style={{ marginTop: '0.25rem' }}>
          Press <span>ENTER</span> or click START to begin · <span>S</span> for settings
        </div>
      </div>

      {/* Footer credit */}
      <div className="footer-credit">Made by Nawaf Al Hussain</div>
    </main>
  );
}
