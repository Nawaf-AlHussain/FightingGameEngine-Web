'use client';

import { useEffect, useState } from 'react';

/**
 * useIsTouchDevice — robust mobile/tablet detection.
 *
 * Detection strategy (in order):
 *   1. User override in localStorage ('input-mode-override')
 *      - 'desktop' → always false
 *      - 'touch'   → always true
 *      This is the escape hatch for touchscreen laptops where the
 *      browser misreports pointer capabilities.
 *   2. Touch + no fine pointer → touch device.
 *      - maxTouchPoints > 0 AND no mouse/trackpad (any-pointer: fine)
 *      - This is the most reliable signal. Pure phones/tablets return true.
 *      - Touchscreen laptops with a trackpad return false (have fine pointer).
 *
 * We intentionally do NOT use screen-width as a signal. Reasons:
 *   - iPhones in landscape can be 932px+ wide (Pro Max) — wider than some
 *     laptop windows. A width check would misdetect landscape phones as
 *     desktops, hiding touch controls exactly when the user needs them.
 *   - A user might shrink their desktop browser window below 900px — that
 *     doesn't turn their laptop into a touch device.
 *
 * The value is computed ONCE on mount and then frozen. Re-evaluating on
 * resize would cause the boot useEffect in play/page.tsx to re-fire,
 * reloading the WASM engine (race conditions, duplicate scripts).
 *
 * Returns false during SSR (initial state) so the server-rendered HTML
 * matches the desktop layout. The hook flips to true after mount if a
 * touch device is detected.
 */
export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const compute = (): boolean => {
      // 1. User override — highest priority
      try {
        const override = localStorage.getItem('input-mode-override');
        if (override === 'desktop') return false;
        if (override === 'touch') return true;
      } catch {
        // localStorage might be unavailable (private mode) — ignore
      }

      // 2. Touch capability without fine pointer = phone/tablet
      const maxTouchPoints = navigator.maxTouchPoints || 0;
      if (maxTouchPoints === 0) return false; // no touch at all → desktop

      // 3. If the device ALSO has a fine pointer (mouse/trackpad), it's
      //    likely a touchscreen laptop. Default to desktop in that case
      //    (the user has a real mouse and won't want on-screen buttons).
      //    They can override with localStorage 'touch' if they want.
      const anyFine = window.matchMedia('(any-pointer: fine)').matches;
      if (anyFine) return false;

      // 4. Has touch AND no fine pointer → genuine phone/tablet
      return true;
    };
    setIsTouch(compute());
    // Deliberately do NOT re-evaluate on resize. See comment above.
  }, []);

  return isTouch;
}

/**
 * Set the input-mode override. Stored in localStorage so it persists.
 * Pass null to clear the override and revert to auto-detection.
 *
 * After setting, the page should reload to apply the change cleanly.
 */
export function setInputModeOverride(mode: 'desktop' | 'touch' | null) {
  try {
    if (mode === null) {
      localStorage.removeItem('input-mode-override');
    } else {
      localStorage.setItem('input-mode-override', mode);
    }
  } catch {
    // ignore
  }
}

export function getInputModeOverride(): 'desktop' | 'touch' | null {
  try {
    const v = localStorage.getItem('input-mode-override');
    if (v === 'desktop' || v === 'touch') return v;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Return the raw detection values for debugging. Useful for showing a
 * diagnostic badge on the page so users can see what the browser reports.
 */
export function getTouchDebugInfo(): string {
  if (typeof window === 'undefined') return 'ssr';
  const anyFine = window.matchMedia('(any-pointer: fine)').matches;
  const anyCoarse = window.matchMedia('(any-pointer: coarse)').matches;
  const pointerFine = window.matchMedia('(pointer: fine)').matches;
  const pointerCoarse = window.matchMedia('(pointer: coarse)').matches;
  const hoverHover = window.matchMedia('(hover: hover)').matches;
  const ontouchstart = 'ontouchstart' in window;
  const maxTouch = navigator.maxTouchPoints || 0;
  const w = window.innerWidth;
  const h = window.innerHeight;
  return (
    `any-fine:${anyFine} any-coarse:${anyCoarse} ` +
    `ptr-fine:${pointerFine} ptr-coarse:${pointerCoarse} ` +
    `hover:${hoverHover} ontouchstart:${ontouchstart} ` +
    `maxTouch:${maxTouch} w:${w} h:${h}`
  );
}
