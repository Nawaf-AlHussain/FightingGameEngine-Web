'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';

/**
 * WipeTransition
 * ---------------
 * A 3-pane diagonal wipe (red / black / white panes, skewX(-14deg))
 * that sweeps across the screen for ~700ms. While the screen is fully
 * covered (mid-wipe), a navigation or arbitrary callback fires.
 *
 * The CSS lives in game.css (#wipe element). This component just
 * toggles the `active` / `exiting` classes and times the midpoint.
 *
 * Usage:
 *   <WipeTransitionProvider> ...app... </WipeTransitionProvider>
 *
 *   const { navigate, triggerWipe } = useWipeNavigation();
 *   navigate('/local');           // wipe + route change
 *   triggerWipe(() => doStuff()); // wipe + callback at midpoint
 */

type WipePhase = 'idle' | 'in' | 'out';

interface PendingAction {
  path?: string;
  onMid?: () => void;
}

interface WipeContextValue {
  /** Trigger a wipe, running `onMid` at the midpoint (screen fully covered). */
  triggerWipe: (onMid?: () => void) => void;
  /** Trigger a wipe and navigate to `path` at the midpoint. */
  navigate: (path: string) => void;
  /** Whether a wipe is currently animating. */
  isWiping: boolean;
}

const WipeContext = createContext<WipeContextValue | null>(null);

export function useWipeNavigation(): WipeContextValue {
  const ctx = useContext(WipeContext);
  if (!ctx) {
    throw new Error(
      'useWipeNavigation must be used inside <WipeTransitionProvider>'
    );
  }
  return ctx;
}

// Timings (must match game.css):
//   wipeIn  = 0.40s  (pane sweeps in, screen covered at end)
//   wipeOut = 0.30s  (pane sweeps out, new screen revealed)
// Midpoint fire happens at end of wipeIn (screen fully covered).
const WIPE_IN_MS = 400;
const WIPE_OUT_MS = 300;

export function WipeTransitionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<WipePhase>('idle');
  const pendingRef = useRef<PendingAction | null>(null);

  const triggerWipe = useCallback((onMid?: () => void) => {
    // If a wipe is already in flight, ignore (avoids stacking).
    if (phase !== 'idle') return;
    pendingRef.current = { onMid };
    setPhase('in');
  }, [phase]);

  const navigate = useCallback((path: string) => {
    if (phase !== 'idle') return;
    // Navigate IMMEDIATELY — Next.js client-side navigation is async, so
    // we kick it off now and let the wipe animation cover the transition.
    // By the time the wipe sweeps away (~700ms later) the new page should
    // be rendered, avoiding a flash of the old page.
    router.push(path);
    // No midpoint action needed — the wipe is purely visual now.
    pendingRef.current = null;
    setPhase('in');
  }, [phase, router]);

  useEffect(() => {
    if (phase === 'in') {
      // After wipeIn completes (screen fully covered), sweep out. Any
      // pending onMid callback (from triggerWipe, not navigate) still
      // fires here. Navigation already happened at the start of the wipe.
      const t = window.setTimeout(() => {
        const p = pendingRef.current;
        if (p?.onMid) {
          try {
            p.onMid();
          } catch (err) {
            console.error('[wipe] onMid callback threw:', err);
          }
        }
        setPhase('out');
      }, WIPE_IN_MS);
      return () => window.clearTimeout(t);
    }

    if (phase === 'out') {
      const t = window.setTimeout(() => {
        setPhase('idle');
        pendingRef.current = null;
      }, WIPE_OUT_MS);
      return () => window.clearTimeout(t);
    }
  }, [phase]);

  const className = phase === 'in' ? 'active' : phase === 'out' ? 'exiting' : '';

  return (
    <WipeContext.Provider
      value={{
        triggerWipe,
        navigate,
        isWiping: phase !== 'idle',
      }}
    >
      {children}
      <div id="wipe" className={className} aria-hidden="true">
        <div className="pane" />
        <div className="pane" />
        <div className="pane" />
        <div className="flash" />
      </div>
    </WipeContext.Provider>
  );
}
