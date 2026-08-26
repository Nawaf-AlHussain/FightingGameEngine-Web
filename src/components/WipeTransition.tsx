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
 * that covers the screen instantly on navigation, then sweeps away
 * to reveal the new page.
 *
 * For navigation: screen covers INSTANTLY (no animate-in), router.push()
 * fires while covered, then the wipe sweeps out after 100ms.
 * This prevents seeing the old page during the transition.
 *
 * For callbacks (triggerWipe): standard animate-in → midpoint → animate-out.
 */

type WipePhase = 'idle' | 'in' | 'covered' | 'out';

interface PendingAction {
  path?: string;
  onMid?: () => void;
}

interface WipeContextValue {
  triggerWipe: (onMid?: () => void) => void;
  navigate: (path: string) => void;
  isWiping: boolean;
}

const WipeContext = createContext<WipeContextValue | null>(null);

export function useWipeNavigation(): WipeContextValue {
  const ctx = useContext(WipeContext);
  if (!ctx) {
    throw new Error('useWipeNavigation must be used inside <WipeTransitionProvider>');
  }
  return ctx;
}

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
    if (phase !== 'idle') return;
    pendingRef.current = { onMid };
    setPhase('in');
  }, [phase]);

  const navigate = useCallback((path: string) => {
    if (phase !== 'idle') return;
    // Cover screen INSTANTLY (no animate-in), then navigate, then sweep out.
    // This prevents seeing the old page during the transition.
    pendingRef.current = { path };
    setPhase('covered');
  }, [phase]);

  useEffect(() => {
    if (phase === 'covered') {
      // Screen is fully covered. Navigate now (new page renders behind the wipe).
      const p = pendingRef.current;
      if (p?.path) {
        router.push(p.path);
      }
      // Brief delay to let React start rendering the new page, then sweep out.
      const t = window.setTimeout(() => {
        setPhase('out');
      }, 150);
      return () => window.clearTimeout(t);
    }

    if (phase === 'in') {
      // For triggerWipe (non-navigation) — animate in, fire callback, animate out
      const t = window.setTimeout(() => {
        const p = pendingRef.current;
        if (p?.onMid) {
          try { p.onMid(); } catch (err) { console.error('[wipe] onMid threw:', err); }
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
  }, [phase, router]);

  // 'covered' = screen fully covered instantly (no animation)
  // 'in' = animate-in (for triggerWipe only)
  // 'out' = animate-out (sweep away)
  const className = phase === 'covered' ? 'covered' : phase === 'in' ? 'active' : phase === 'out' ? 'exiting' : '';

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
