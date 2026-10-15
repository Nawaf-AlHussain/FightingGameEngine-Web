'use client';

import { useCallback, useState } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';

/**
 * Lobby / Title Screen — "SQUADRON COMIC" poster.
 *
 * The main entry point for the game, styled as a retro comic-print
 * aviation poster: cream paper, giant Anton headline with crimson
 * misregistration, a skewed ink panel with drifting halftone, a striped
 * contrail ribbon, and numbered print-bar menu items (01–04) with a red
 * caret on the active row.
 *
 * Menu items:
 * - LOCAL PLAY → /local (character select → stage select → fight)
 * - ONLINE PLAY → /play?net=1 (website flow: host/join room codes, then BOTH
 *   players pick fighters + stage on the site's own select screens — synced
 *   over the WebRTC bridge — and the engine boots straight into the fight.
 *   Zero engine-side menus.)
 * - SETTINGS → /settings (engine config, key remapping)
 * - ABOUT → /about (project info)
 *
 * Keyboard:
 * - Enter / Space → selected item
 * - Arrows move · L/O/S/A are direct shortcuts
 *
 * Motion: menu bars slide in staggered (CSS only), the caret nudges, the
 * ribbon + halftone drift on transform-only loops. All disabled under
 * prefers-reduced-motion. No per-frame JS runs on this screen (the old
 * 2s glow-toggle interval is gone — the poster is static after entrance).
 */

export default function LobbyPage() {
  const { navigate } = useWipeNavigation();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const menuItems = [
    { label: 'LOCAL PLAY', action: () => navigate('/local'), key: 'L' },
    { label: 'ONLINE PLAY', action: () => navigate('/play?net=1'), key: 'O' },
    { label: 'SETTINGS', action: () => navigate('/settings'), key: 'S' },
    { label: 'ABOUT', action: () => navigate('/about'), key: 'A' },
  ];

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
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      navigate('/local');
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      navigate('/play?net=1');
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      navigate('/settings');
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      navigate('/about');
    }
  }, [selectedIndex, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main
      className="lobby"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label="Title screen"
    >
      {/* Masthead kicker line across the top of the poster */}
      <header className="lobby__masthead" aria-hidden="true">
        <span className="lobby__masthead-left">Fighting Game Engine · An Arcade Serial</span>
        <span className="lobby__masthead-right">One Engine — <em>No Ceiling</em></span>
      </header>

      {/* Striped contrail ribbon crossing the poster (pure CSS loop).
          Placed BEFORE the title so the headline paints over it. */}
      <div className="lobby__ribbon" aria-hidden="true">
        <div className="lobby__ribbon-strip" />
      </div>

      {/* Title block */}
      <div className="lobby__title">
        <span className="lobby__kicker">Browser · WASM · 60 FPS</span>
        <h1 className="lobby__title-main">
          <span>FIGHTING</span>
          <span>GAME</span>
        </h1>
        <div className="lobby__title-sub">ENGINE</div>
      </div>

      {/* Numbered print-bar menu */}
      <nav className="lobby__menu" aria-label="Main menu">
        {menuItems.map((item, i) => (
          <button
            key={item.label}
            type="button"
            className={`lobby__menu-item${selectedIndex === i ? ' lobby__menu-item--selected' : ''}`}
            onClick={item.action}
            onMouseEnter={() => setSelectedIndex(i)}
            aria-label={item.label}
          >
            <span className="lobby__menu-item-num" aria-hidden="true">0{i + 1}</span>
            <span className="lobby__menu-item-arrow" aria-hidden="true" />
            <span className="lobby__menu-item-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Controls hint */}
      <div className="cs__controls-help lobby__help">
        <div>
          <span>↑↓</span> navigate · <span>ENTER</span> select · <span>L</span> local · <span>O</span> online · <span>S</span> settings
        </div>
      </div>

      {/* Version */}
      <div className="lobby__version">v1.0 WEB</div>

      {/* Footer credit */}
      <div className="footer-credit">Made by Nawaf Al Hussain</div>
    </main>
  );
}
