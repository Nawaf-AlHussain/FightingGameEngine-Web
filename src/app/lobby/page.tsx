'use client';

import { useEffect, useState, useCallback } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';

/**
 * Lobby / Title Screen
 *
 * The main entry point for the game. Shows the title, a menu of real
 * destinations, and contextual hints.
 *
 * Menu items:
 * - LOCAL PLAY → /local (character select → stage select → fight)
 * - SETTINGS → /settings (engine config, key remapping)
 * - ABOUT → /about (project info)
 *
 * Keyboard:
 * - Enter / Space → LOCAL PLAY
 * - S → SETTINGS
 * - A → ABOUT
 */

export default function LobbyPage() {
  const { navigate } = useWipeNavigation();
  const [glow, setGlow] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const menuItems = [
    { label: 'LOCAL PLAY', action: () => navigate('/local'), key: 'Enter' },
    { label: 'SETTINGS', action: () => navigate('/settings'), key: 'S' },
    { label: 'ABOUT', action: () => navigate('/about'), key: 'A' },
  ];

  useEffect(() => {
    const interval = setInterval(() => setGlow(g => !g), 2000);
    return () => clearInterval(interval);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      menuItems[selectedIndex].action();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % menuItems.length);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + menuItems.length) % menuItems.length);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      navigate('/settings');
    }
  }, [selectedIndex, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* Menu */}
      <div className="lobby__menu" style={{ zIndex: 1 }}>
        {menuItems.map((item, i) => (
          <button
            key={item.label}
            type="button"
            className={`lobby__menu-item${selectedIndex === i ? ' lobby__menu-item--selected' : ''}`}
            onClick={item.action}
            onMouseEnter={() => setSelectedIndex(i)}
            aria-label={item.label}
          >
            <span className="lobby__menu-item-arrow">
              {selectedIndex === i ? '▶' : ' '}
            </span>
            <span className="lobby__menu-item-label">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Controls hint */}
      <div
        className="cs__controls-help"
        style={{
          marginTop: '2rem',
          textAlign: 'center',
          zIndex: 1,
        }}
      >
        <div>
          <span>↑↓</span> navigate · <span>ENTER</span> select · <span>S</span> settings
        </div>
      </div>

      {/* Version */}
      <div className="lobby__version">v1.0 WEB</div>

      {/* Footer credit */}
      <div className="footer-credit">Made by Nawaf Al Hussain</div>
    </main>
  );
}
