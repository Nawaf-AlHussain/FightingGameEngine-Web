'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';
import { getCurrentModeState, type ModeState } from '@/lib/game-modes';
import { getCharacters, type CharacterInfo } from '@/lib/character-downloader';

/**
 * Match Preparation Screen (Section 18-19 of FRONTEND_2.1_REDESIGN_SPEC)
 *
 * Shows a brief confirmation of the selected fighters, stage, and mode
 * before transitioning to /play. The user can click FIGHT to start
 * immediately, or the screen auto-advances after 3 seconds.
 *
 * For progression modes, reads the existing game-modes.ts state to show
 * the current fight number and opponent.
 *
 * URL params are the same as /play — this screen forwards them.
 */
function MatchPrepInner() {
  const { navigate } = useWipeNavigation();
  const searchParams = useSearchParams();

  const p1 = searchParams.get('p1') || 'kfm';
  const p2 = searchParams.get('p2') || 'kfm';
  const stage = searchParams.get('stage') || 'stages/stage0-720.def';
  const qmode = searchParams.get('qmode') || 'quickvs';
  const fillMode = searchParams.get('fill') || 'fill';

  const [modeState, setModeState] = useState<ModeState | null>(null);
  const [charNames, setCharNames] = useState<{ p1: string; p2: string; stage: string }>({
    p1: p1, p2: p2, stage: stage.split('/').pop() || stage,
  });
  const navigatedRef = useState({ done: false })[0];

  // Load mode state (for progression modes) and character display names
  useEffect(() => {
    const s = getCurrentModeState();
    setModeState(s);

    // Fetch character display names for nicer display
    getCharacters().then((chars: CharacterInfo[]) => {
      const findName = (id: string) => {
        const c = chars.find(c => c.id === id);
        return c?.displayName ?? id;
      };
      setCharNames({
        p1: findName(p1),
        p2: findName(p2),
        stage: stage.split('/').pop() || stage,
      });
    }).catch(() => {
      // Keep raw IDs if fetch fails
    });
  }, [p1, p2, stage]);

  // Build the /play URL with the same params
  const playUrl = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    return `/play?${params.toString()}`;
  }, [searchParams]);

  const handleFight = useCallback(() => {
    if (navigatedRef.done) return;
    navigatedRef.done = true;
    navigate(playUrl());
  }, [navigate, playUrl, navigatedRef]);

  // Auto-advance after 3 seconds (spec: "If the transition is fast, the
  // screen can automatically continue. Do not force an unnecessary delay.")
  useEffect(() => {
    const timer = setTimeout(handleFight, 3000);
    return () => clearTimeout(timer);
  }, [handleFight]);

  const isProgression = qmode !== 'quickvs' && qmode !== 'training';
  const isWatch = qmode === 'watch';

  // Mode display label
  const modeLabel: Record<string, string> = {
    'quickvs': 'VERSUS',
    'vs-ai': 'VS CPU',
    'vs-player': 'VS PLAYER',
    'training': 'TRAINING',
    'arcade': 'ARCADE',
    'survival': 'SURVIVAL',
    'time-attack': 'TIME ATTACK',
    'watch': 'WATCH',
  };
  const label = modeLabel[qmode] || qmode.toUpperCase();

  // Fight number for progression modes
  const fightLabel = modeState
    ? modeState.mode === 'survival'
      ? `FIGHT ${modeState.fightNumber}`
      : `FIGHT ${modeState.fightNumber} OF ${modeState.totalFights}`
    : null;

  return (
    <main className="match-prep bg-grid">
      <div className="match-prep__bg-grid bg-grid" aria-hidden="true" />

      <div className="match-prep__content">
        {/* Mode + fight number */}
        <div className="match-prep__mode">{label}</div>
        {fightLabel && <div className="match-prep__fight-num">{fightLabel}</div>}

        {/* VS section */}
        <div className="match-prep__vs">
          <div className="match-prep__player match-prep__player--p1">
            <div className="match-prep__player-label">
              {isWatch ? 'CPU 1' : 'PLAYER 1'}
            </div>
            <div className="match-prep__player-name">{charNames.p1}</div>
          </div>

          <div className="match-prep__vs-text">VS</div>

          <div className="match-prep__player match-prep__player--p2">
            <div className="match-prep__player-label">
              {isProgression ? 'NEXT OPPONENT' : isWatch ? 'CPU 2' : 'PLAYER 2'}
            </div>
            <div className="match-prep__player-name">{charNames.p2}</div>
          </div>
        </div>

        {/* Stage */}
        <div className="match-prep__stage">
          <div className="match-prep__stage-label">STAGE</div>
          <div className="match-prep__stage-name">{charNames.stage}</div>
        </div>

        {/* FIGHT button */}
        <div className="match-prep__buttons">
          <GameButton variant="secondary" onClick={() => navigate('/local')}>
            ← BACK
          </GameButton>
          <GameButton variant="primary" onClick={handleFight}>
            FIGHT ►
          </GameButton>
        </div>

        {/* Auto-advance hint */}
        <div className="match-prep__auto-hint">
          Starting in 3s… click FIGHT to start now
        </div>
      </div>
    </main>
  );
}

export default function MatchPrepPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black flex items-center justify-center">
        <span className="text-gray-500 font-mono text-sm">Loading...</span>
      </div>
    }>
      <MatchPrepInner />
    </Suspense>
  );
}
