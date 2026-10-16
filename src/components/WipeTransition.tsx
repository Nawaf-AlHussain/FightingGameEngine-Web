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
 * A comic-print 3-ink diagonal sweep (crimson lead edge / royal halftone
 * plate / paper tail, skewX(-14deg), ink panel gutters) with a rotated
 * NEXT ISSUE stamp that pops on the paper plate while the sheet is up.
 * It covers the screen instantly on navigation, then sweeps away
 * to reveal the new page.
 *
 * For navigation: screen covers INSTANTLY (no animate-in), router.push()
 * fires while covered, then the wipe sweeps out after 200ms.
 * This prevents seeing the old page during the transition.
 *
 * For callbacks (triggerWipe): standard animate-in → midpoint → animate-out.
 *
 * The stamp text is contextual: /match-prep → "VS!", /play → "K.O.!",
 * everything else → "NEXT ISSUE".
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

/** Stamp copy for the page we are heading to. */
function stampFor(path: string | undefined): string {
  if (!path) return 'NEXT ISSUE';
  if (path.startsWith('/play')) return 'K.O.!';
  if (path.startsWith('/match-prep')) return 'VS!';
  return 'NEXT ISSUE';
}

export function WipeTransitionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<WipePhase>('idle');
  const [stampText, setStampText] = useState('NEXT ISSUE');
  const pendingRef = useRef<PendingAction | null>(null);

  const triggerWipe = useCallback((onMid?: () => void) => {
    if (phase !== 'idle') return;
    pendingRef.current = { onMid };
    setStampText('NEXT ISSUE');
    setPhase('in');
  }, [phase]);

  const navigate = useCallback((path: string) => {
    if (phase !== 'idle') return;
    // Cover screen INSTANTLY (no animate-in), then navigate, then sweep out.
    // This prevents seeing the old page during the transition.
    pendingRef.current = { path };
    setStampText(stampFor(path));
    setPhase('covered');
  }, [phase]);

  useEffect(() => {
    if (phase === 'covered') {
      // Screen is fully covered. Navigate now (new page renders behind the wipe).
      const p = pendingRef.current;
      if (p?.path) {
        router.push(p.path);
      }
      // Brief delay to let React start rendering the new page (and let the
      // stamp land), then sweep out.
      const t = window.setTimeout(() => {
        setPhase('out');
      }, 200);
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
        <div className="stamp">{stampText}</div>
        <div className="flash" />
      </div>
    </WipeContext.Provider>
  );
}
