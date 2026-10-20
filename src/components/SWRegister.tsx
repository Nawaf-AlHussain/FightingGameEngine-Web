'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js in production builds.
 *
 * The service worker is what makes Chrome offer the address-bar "Install"
 * button (a valid manifest alone is not enough — Chrome requires an active
 * service worker with a fetch handler).
 *
 * - Skipped in `next dev`: dev chunks are mutable and unhashed, so a
 *   cache-first SW would poison HMR during development.
 * - Skipped outside secure contexts (SW itself won't register there anyway).
 * - Registers after the window `load` event so it never competes with the
 *   game's boot bandwidth on first visit.
 */
export default function SWRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* installability is best-effort; never block the app on it */
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register);
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
