'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';

/**
 * Lobby / Title Screen — "SQUADRON COMIC" poster v2.
 *
 * Full-fidelity pass on the reference (rocket-squadron Rive demo):
 * - Full-viewport poster split by a diagonal: cream paper left, royal panel
 *   right. The panel is a duotone comic-print fighter illustration
 *   (public/comic/hero-uppercut.png, slowly crossfading with a second pose).
 * - Giant two-line Anton headline, left-aligned: royal fill + crimson
 *   misregistration on the paper side, cream KNOCKOUT where the letters
 *   cross the diagonal (two stacked copies clipped by the same polygon).
 * - A striped contrail ribbon (SVG) sweeps across the headline.
 * - Numbered print-bar menu (01-04) rides on the panel: skewed cream bars,
 *   red caret outside the selected row, tick marks on the right edge.
 * - Winged-emblem wordmark block, mission line, corner registration marks.
 * - Full-width arcade deck at the bottom: ARROWS SELECT / PRESS ENTER TO
 *   START (pulsing) / ENTER CONFIRM, with key chips.
 *
 * Menu items:
 * - LOCAL PLAY → /mode-select (pick the game mode + difficulty, then the
 *   universe, then the roster: mode select → group select → character
 *   select → stage select → fight)
 * - ONLINE PLAY → /play?net=1 (website flow: host/join room codes, then the
 *   HOST picks the universe and BOTH players pick fighters + stage on the
 *   site's own select screens — synced over the WebRTC bridge — and the
 *   engine boots straight into the fight. Zero engine-side menus.)
 * - SETTINGS → /settings (engine config, key remapping)
 * - ABOUT → /about (project info)
 *
 * Keyboard: Enter / Space → selected item · Arrows move · L/O/S/A shortcuts
 * · I → INSTALL APP (only while the browser offers installation).
 * Motion: bars slide in staggered, caret nudges, ribbon + halftone + art
 * crossfade run on transform/opacity loops — all disabled under
 * prefers-reduced-motion. No per-frame JS on this screen.
 */

/** Chromium's BeforeInstallPromptEvent — the prompt behind the address-bar install icon. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface Window {
    __fgeInstallEvent?: InstallPromptEvent | null;
  }
}

export default function LobbyPage() {
  const { navigate } = useWipeNavigation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** Set when Chromium offers install (same prompt as the address-bar icon). */
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);

  // The head capture script (layout.tsx) preventDefaults beforeinstallprompt
  // and stashes it on window — possibly BEFORE this component hydrates. So on
  // mount, read the stash; afterwards, follow the re-announce event.
  useEffect(() => {
    if (window.__fgeInstallEvent) setInstallEvent(window.__fgeInstallEvent);
    const onAvailable = () => {
      if (window.__fgeInstallEvent) setInstallEvent(window.__fgeInstallEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('fge:install-available', onAvailable);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('fge:install-available', onAvailable);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const ev = installEvent;
    if (!ev) return;
    try {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      if (outcome === 'accepted') setInstallEvent(null);
    } catch {
      /* prompt can reject if the context died; the item stays for a retry */
    }
  }, [installEvent]);

  const menuItems = [
    { label: 'LOCAL PLAY', action: () => navigate('/mode-select'), key: 'L' },
    { label: 'ONLINE PLAY', action: () => navigate('/play?net=1'), key: 'O' },
    { label: 'SETTINGS', action: () => navigate('/settings'), key: 'S' },
    { label: 'ABOUT', action: () => navigate('/about'), key: 'A' },
    // Only offered when the browser can actually install the app —
    // a menu item with no runtime effect must never render. Prints as 05.
    ...(installEvent
      ? [{ label: 'INSTALL APP', action: () => void promptInstall(), key: 'I' }]
      : []),
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
      navigate('/mode-select');
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      navigate('/play?net=1');
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      navigate('/settings');
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      navigate('/about');
    } else if ((e.key === 'i' || e.key === 'I') && installEvent) {
      e.preventDefault();
      void promptInstall();
    }
  }, [selectedIndex, navigate, installEvent, promptInstall]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main
      className="lobby"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label="Title screen"
    >
      {/* ── Right diagonal panel: duotone hero art + halftone ─────────── */}
      <div className="lobby__panel" aria-hidden="true">
        <img
          className="lobby__panel-art lobby__panel-art--a"
          src="/comic/hero-uppercut.png"
          alt=""
          draggable={false}
        />
        <img
          className="lobby__panel-art lobby__panel-art--b"
          src="/comic/hero-punch.png"
          alt=""
          draggable={false}
        />
        <div className="lobby__panel-shade" />
        <div className="lobby__panel-dots" />
      </div>

      {/* ── Corner registration marks ─────────────────────────────────── */}
      <span className="lobby__reg lobby__reg--tl" aria-hidden="true" />
      <span className="lobby__reg lobby__reg--tr" aria-hidden="true" />
      <span className="lobby__reg lobby__reg--bl" aria-hidden="true" />
      <span className="lobby__reg lobby__reg--br" aria-hidden="true" />

      {/* ── Masthead kicker row ───────────────────────────────────────── */}
      <header className="lobby__masthead" aria-hidden="true">
        <span className="lobby__masthead-left">Fighting Game Engine · An Arcade Serial</span>
        <span className="lobby__masthead-right">Build 1.0 — <em>No Ceiling</em></span>
      </header>

      {/* ── Striped contrail ribbon (SVG, sweeps through the headline) ── */}
      <svg
        className="lobby__ribbon"
        viewBox="0 0 1440 900"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          className="lobby__ribbon-edge"
          d="M -40 330 C 240 258, 420 424, 700 336 C 940 258, 1160 286, 1480 330"
        />
        <path
          className="lobby__ribbon-body"
          d="M -40 330 C 240 258, 420 424, 700 336 C 940 258, 1160 286, 1480 330"
        />
        <path
          className="lobby__ribbon-core"
          d="M -40 330 C 240 258, 420 424, 700 336 C 940 258, 1160 286, 1480 330"
        />
      </svg>

      {/* ── Title block: kicker + headline spacer + mission line ──────── */}
      <div className="lobby__title">
        <div className="lobby__kicker">Browser · WASM · 60 FPS</div>
        <div className="lobby__headline-slot" aria-hidden="true" />
        <div className="lobby__mission">
          85 FIGHTERS <em>—</em> ZERO INSTALL <span className="lobby__mission-rule" />
        </div>
      </div>

      {/* ── Headline: knockout across the diagonal ──────────────────────
          Two stacked copies of the same type share the panel's exact
          geometry; opposite clip-path polygons split them along the
          diagonal — royal + crimson misregistration on paper, cream
          knockout on the panel. */}
      <h1 className="sr-only">Fighting Game</h1>
      <div className="lobby__headline lobby__headline--paper" aria-hidden="true">
        <span>FIGHTING<br />GAME</span>
      </div>
      <div className="lobby__headline lobby__headline--panel" aria-hidden="true">
        <span>FIGHTING<br />GAME</span>
      </div>

      {/* ── Winged emblem + wordmark ──────────────────────────────────── */}
      <div className="lobby__brand" aria-hidden="true">
        <svg className="lobby__brand-wing" viewBox="0 0 120 64">
          <polygon points="60,4 74,30 60,24 46,30" fill="currentColor" />
          <polygon points="54,34 60,60 66,34 60,38" fill="currentColor" />
          <polygon points="52,30 10,20 44,40" fill="currentColor" />
          <polygon points="50,38 20,38 48,48" fill="currentColor" />
          <polygon points="52,45 32,52 52,54" fill="currentColor" />
          <polygon points="68,30 110,20 76,40" fill="currentColor" />
          <polygon points="70,38 100,38 72,48" fill="currentColor" />
          <polygon points="68,45 88,52 68,54" fill="currentColor" />
        </svg>
        <div className="lobby__brand-text">
          <div className="lobby__brand-name">Fighting Game Engine</div>
          <div className="lobby__brand-tag">One Engine · Two Warriors · No Ceiling</div>
          <div className="lobby__brand-stamp">v1.0 WEB — Made by Nawaf Al Hussain</div>
        </div>
      </div>

      {/* ── Numbered print-bar menu (rides the panel) ─────────────────── */}
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
            <span className="lobby__menu-item-caret" aria-hidden="true" />
            <span className="lobby__menu-item-num" aria-hidden="true">0{i + 1}</span>
            <span className="lobby__menu-item-label">{item.label}</span>
            <span className="lobby__menu-item-ticks" aria-hidden="true" />
          </button>
        ))}
      </nav>

      {/* ── Arcade deck (bottom strip) ────────────────────────────────── */}
      <footer className="lobby__deck" aria-hidden="true">
        <div className="lobby__deck-side lobby__deck-side--left">
          <span className="lobby__deck-key">◀</span>
          <span className="lobby__deck-key">▶</span>
          <span className="lobby__deck-word">Select</span>
        </div>
        <div className="lobby__deck-center">
          Press <span className="lobby__deck-chip">Enter</span> to start
        </div>
        <div className="lobby__deck-side lobby__deck-side--right">
          <span className="lobby__deck-chip lobby__deck-chip--quiet">Enter</span>
          <span className="lobby__deck-word">Confirm</span>
        </div>
      </footer>
    </main>
  );
}
