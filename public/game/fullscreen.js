// Mobile fullscreen + landscape lock.
// Android browsers use the Fullscreen API on the first user gesture.
// iOS Safari does not expose element fullscreen; installed Home Screen
// launches are already chrome-less and are handled by the manifest/meta tags.
"use strict";
(() => {
  const coarse = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  if (!coarse) return;

  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches) ||
    window.navigator.standalone === true;

  function lockLandscape() {
    try {
      const orientation = screen.orientation;
      if (orientation && orientation.lock) orientation.lock("landscape").catch(() => {});
    } catch {}
  }

  async function goFullscreen() {
    try {
      const root = document.documentElement;
      if (!document.fullscreenElement && root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {}
    lockLandscape();
  }

  window.addEventListener("orientationchange", lockLandscape);

  if (standalone) {
    lockLandscape();
    return;
  }

  const once = () => {
    window.removeEventListener("touchend", once);
    window.removeEventListener("pointerdown", once);
    void goFullscreen();
  };
  window.addEventListener("touchend", once, { passive: true });
  window.addEventListener("pointerdown", once);
})();
