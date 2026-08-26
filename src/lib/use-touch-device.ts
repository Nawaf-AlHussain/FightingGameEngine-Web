'use client';

import { useEffect, useState } from 'react';

/**
 * useIsTouchDevice — robust mobile/tablet detection.
 *
 * Detection strategy (most-reliable signals first):
 *   1. User override in localStorage ('input-mode-override')
 *      - 'desktop' → always false
 *      - 'touch'   → always true
 *      This is the escape hatch for touchscreen laptops where the
 *      browser misreports pointer capabilities.
 *   2. Screen width — phones are narrow (< 900px). Laptops/desktops
 *      are wider. This is the most reliable signal when pointer
 *      queries lie (touchscreen Chromebooks, etc.).
 *   3. any-pointer: fine — has a mouse/trackpad → desktop.
 *   4. ontouchstart + no fine pointer → touch device.
 *
 * Returns false during SSR (initial state) so the server-rendered HTML
 * matches the desktop layout. The hook flips to true after mount if a
 * touch device is detected.
 *
 * Usage:
 *   const isTouch = useIsTouchDevice();
 *   // Pass isTouch to CharacterSelect / StageSelect / FightScreen
 */
export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const compute = () => {
      // 1. User override — highest priority
      try {
        const override = localStorage.getItem('input-mode-override');
        if (override === 'desktop') return false;
        if (override === 'touch') return true;
      } catch {
        // localStorage might be unavailable (private mode) — ignore
      }

      // 2. Screen size — laptops/desktops are wide, phones aren't
      if (window.innerWidth >= 900) return false;

      // 3. Pointer queries — for actual phones/tablets
      const anyFine = window.matchMedia('(any-pointer: fine)').matches;
      if (anyFine) return false; // has a mouse/trackpad

      // 4. Touch capability without fine pointer = phone/tablet
      const maxTouchPoints = navigator.maxTouchPoints || 0;
      return maxTouchPoints > 0;
    };
    setIsTouch(compute());

    // Re-evaluate on resize (e.g., user rotates phone or resizes browser)
    const onResize = () => setIsTouch(compute());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
