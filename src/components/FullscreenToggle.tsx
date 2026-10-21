'use client';

import { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Fullscreen toggle — fixed top-right icon button on /local.
//
// Replaces the old RES 4:3/16:9 quick-set: resolution is a Settings-UI
// choice now (Settings → Display Mode → config.ini → vfs.js on boot), so
// the top-right slot no longer duplicates it over the roster. This button
// drives the browser Fullscreen API on the document root — the same
// presentation /game/fullscreen.js requests automatically on touch
// devices, but user-controlled and available on desktop too.
//
// Frontend 2.1 spec Section 26: never ship a control that appears
// functional but has no runtime effect. iPhone Safari does not implement
// element fullscreen at all, so when the API (or fullscreenEnabled)
// is missing the button hides itself instead of dead-clicking.
// ---------------------------------------------------------------------------

/** HTMLElement plus the webkit-prefixed fullscreen entry Safari needs. */
interface FSHTMLElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** Document plus the webkit-prefixed fullscreen accessors. */
interface FSDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

export default function FullscreenToggle() {
  // SSR renders nothing (document is unavailable); after mount the API
  // probe decides. Capable browsers pop the button in one frame later —
  // imperceptible next to the page's own wipe-in.
  const [supported, setSupported] = useState(false);
  // Mirrors document.fullscreenElement so the icon/label stay truthful
  // no matter HOW fullscreen ends (button, Esc, browser chrome).
  const [active, setActive] = useState(false);

  useEffect(() => {
    const root = document.documentElement as FSHTMLElement;
    const doc = document as FSDocument;
    const canRequest =
      !!root.requestFullscreen ||
      typeof root.webkitRequestFullscreen === 'function';
    if (!canRequest || !(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
      return; // no Fullscreen API (iPhone Safari) — stay hidden
    }
    setSupported(true);

    const sync = () => {
      setActive(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const toggle = useCallback(async () => {
    const root = document.documentElement as FSHTMLElement;
    const doc = document as FSDocument;
    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      } else if (root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: 'hide' });
      } else if (typeof root.webkitRequestFullscreen === 'function') {
        root.webkitRequestFullscreen();
      }
      // NO orientation lock here — portrait is a supported way to play
      // (Game Boy layout: screen pinned to the top, touch controls below;
      // see fitCanvasToViewport in app/play/page.tsx). The old
      // orientation.lock('landscape') companion call was removed with the
      // rest of the landscape locks on 2026-10-22.
    } catch {
      // Request refused (permission policy / lost gesture) — the
      // fullscreenchange listeners simply never fire, so the icon
      // stays truthful about the state we are actually in.
    }
  }, []);

  if (!supported) return null;

  return (
    <button
      type="button"
      className={`fs-toggle${active ? ' fs-toggle--on' : ''}`}
      onClick={toggle}
      aria-label={active ? 'Exit fullscreen' : 'Enter fullscreen'}
      aria-pressed={active}
      title={active ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="square"
        aria-hidden="true"
      >
        {active ? (
          // Compress — corners fold back in.
          <>
            <path d="M9 3v6H3" />
            <path d="M15 21v-6h6" />
            <path d="M21 9h-6V3" />
            <path d="M3 15h6v6" />
          </>
        ) : (
          // Expand — corners reach for the viewport edges.
          <>
            <path d="M3 9V3h6" />
            <path d="M15 3h6v6" />
            <path d="M21 15v6h-6" />
            <path d="M9 21H3v-6" />
          </>
        )}
      </svg>
    </button>
  );
}
