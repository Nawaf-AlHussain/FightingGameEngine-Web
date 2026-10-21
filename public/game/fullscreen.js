// Mobile fullscreen (NO orientation lock).
// Android browsers use the Fullscreen API on the first user gesture.
// iOS Safari does not expose element fullscreen; installed Home Screen
// launches are already chrome-less and are handled by the manifest/meta tags.
//
// PORTRAIT IS SUPPORTED on purpose: touch devices get a Game Boy style
// presentation in portrait (game screen pinned to the top, touch controls
// docked below — see fitCanvasToViewport in src/app/play/page.tsx and the
// --ikemen-screen-bottom consumers in touch.js / game.css). Do NOT add
// screen.orientation.lock("landscape") back — that was removed 2026-10-22
// along with the old RotateOverlay wall.
"use strict";
(() => {
  const coarse = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  if (!coarse) return;

  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches) ||
    window.navigator.standalone === true;

  async function goFullscreen() {
    try {
      const root = document.documentElement;
      if (!document.fullscreenElement && root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {}
  }

  if (standalone) return; // already chrome-less; nothing to lock or request

  const once = () => {
    window.removeEventListener("touchend", once);
    window.removeEventListener("pointerdown", once);
    void goFullscreen();
  };
  window.addEventListener("touchend", once, { passive: true });
  window.addEventListener("pointerdown", once);
})();
