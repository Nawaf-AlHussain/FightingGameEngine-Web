'use client';

import { useState, useCallback } from 'react';
import CharacterSelect, {
  type GameMode,
  type Difficulty,
} from '@/components/CharacterSelect';
import StageSelect from '@/components/StageSelect';
import RotateOverlay from '@/components/RotateOverlay';
import FullscreenToggle from '@/components/FullscreenToggle';
import { useWipeNavigation } from '@/components/WipeTransition';
import { useIsTouchDevice } from '@/lib/use-touch-device';
import { startMode, type ProgressionMode } from '@/lib/game-modes';
import { getCharacters, charRef, splitCharRef, DEFAULT_SOURCE } from '@/lib/character-downloader';
import { prewarmEngineAssets } from '@/lib/engine-prewarm';

// Pull engine.wasm.gz + game.pak.gz into the HTTP cache while the player
// browses the roster (usually many seconds before any fight) — /play then
// boots from disk instead of the network. Module scope = starts at chunk
// evaluation, before CharacterSelect even mounts; idempotent + best-effort.
if (typeof window !== 'undefined') {
  prewarmEngineAssets();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Screen = 'select' | 'stage-select';

interface LockInResult {
  p1Id: string;
  p2Id: string;
  mode: GameMode;
  difficulty: Difficulty;
  p1Difficulty?: Difficulty;
}

// ---------------------------------------------------------------------------
// Difficulty → AI level mapping (per task spec)
//   easy   = 1
//   normal = 5
//   hard   = 8
// ---------------------------------------------------------------------------

const DIFFICULTY_TO_AI: Record<Difficulty, number> = {
  easy: 1,
  normal: 5,
  hard: 8,
};

// ---------------------------------------------------------------------------
// NOTE: no resolution quick-set here anymore. The old RES 4:3/16:9 chips
// (a Settings-UI duplicate pinned over the roster) are gone — display mode
// is chosen in Settings → Display Mode, persisted to config.ini, and
// vfs.js applies it on engine boot. The top-right slot now holds the
// fullscreen toggle (components/FullscreenToggle.tsx).
//
// History: an earlier build defaulted the chips to 4:3 and auto-persisted
// that preset on first visit, silently making 4:3 the default for every
// fresh visitor (4:3 is a broken mode pending a redo). The pre-v2 markers
// that effect wrote were invalidated by the marker key bump to
// 'engine-display-mode-v2' — see engine-config.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LocalPlayPage() {
  const { navigate } = useWipeNavigation();
  const isTouch = useIsTouchDevice();

  const [screen, setScreen] = useState<Screen>('select');
  const [lockIn, setLockIn] = useState<LockInResult | null>(null);

  // ---- Character lock-in: save state, advance to stage select ----
  const handleLockIn = useCallback(
    (
      p1Id: string,
      p2Id: string,
      mode: GameMode,
      difficulty: Difficulty,
      p1Difficulty?: Difficulty
    ) => {
      setLockIn({ p1Id, p2Id, mode, difficulty, p1Difficulty });
      setScreen('stage-select');
    },
    []
  );

  // ---- Stage selected: start the fight (or mode session) ----
  // For progression modes (arcade/survival/time-attack/watch), we:
  //   1. Fetch the roster to generate opponents
  //   2. Call startMode() to initialize the sessionStorage state
  //   3. Navigate to /play with the first opponent
  // For single-fight modes (vs-ai/vs-player/training), we just navigate
  // to /play with the selected P2 character.
  const handleStageSelect = useCallback(
    async (stageId: string) => {
      if (!lockIn) return;

      const isProgressionMode = ['arcade', 'survival', 'time-attack', 'watch'].includes(lockIn.mode);

      if (isProgressionMode) {
        // Fetch roster to generate opponent ladder.
        // Opponents come from the SAME roster source the player picked in
        // (e.g. picking from charsMARVEL generates MARVEL opponents).
        // There is no bundled fallback character anymore — if the CDN fetch
        // fails the roster stays empty and startMode() throws a clear error.
        let rosterCharIds: string[] = [];
        try {
          const chars = await getCharacters();
          const p1Source = splitCharRef(lockIn.p1Id).source;
          let pool = chars.filter(c => (c.source || DEFAULT_SOURCE) === p1Source);
          // Too few fighters in this universe to build a ladder — widen to
          // the full roster (player + every other character).
          if (pool.length < 2) pool = chars;
          rosterCharIds = pool.map(charRef);
        } catch {
          // Empty roster — startMode() below fails loudly (no kfm fallback).
        }

        const progressionMode = lockIn.mode as ProgressionMode;
        const aiLevel = lockIn.mode === 'watch' ? 8 : DIFFICULTY_TO_AI[lockIn.difficulty];
        const state = startMode(progressionMode, lockIn.p1Id, rosterCharIds, aiLevel, stageId);

        // Build URL for the first fight
        const params = new URLSearchParams();
        params.set('p1', state.playerChar);
        params.set('p2', state.opponents[0]);
        params.set('stage', stageId);
        params.set('p2ai', String(state.difficulty));
        params.set('qmode', progressionMode);
        if (progressionMode === 'time-attack') {
          params.set('time', '60');
        }
        if (progressionMode === 'watch') {
          params.set('p1ai', '8');
        }

        navigate(`/match-prep?${params.toString()}`);
        return;
      }

      // Single-fight modes: vs-ai, vs-player, training
      const params = new URLSearchParams();
      params.set('p1', lockIn.p1Id);
      params.set('p2', lockIn.p2Id);
      params.set('stage', stageId);

      switch (lockIn.mode) {
        case 'vs-ai':
          params.set('p2ai', String(DIFFICULTY_TO_AI[lockIn.difficulty]));
          break;
        case 'vs-player':
          // No AI params — both players are human.
          break;
        case 'training':
          params.set('training', '1');
          params.set('p2ai', '0');
          break;
      }

      navigate(`/match-prep?${params.toString()}`);
    },
    [lockIn, navigate]
  );

  // ---- Cancel handlers ----
  const handleCancelSelect = useCallback(() => {
    navigate('/lobby');
  }, [navigate]);

  const handleCancelStage = useCallback(() => {
    setScreen('select');
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (screen === 'stage-select' && lockIn) {
    return (
      <div>
        {isTouch && <RotateOverlay />}
        <FullscreenToggle />
        <StageSelect
          onSelect={handleStageSelect}
          onCancel={handleCancelStage}
          isTouch={isTouch}
        />
      </div>
    );
  }

  return (
    <div>
      {isTouch && <RotateOverlay />}
      <FullscreenToggle />
      <CharacterSelect
        onLockIn={handleLockIn}
        onCancel={handleCancelSelect}
        isTouch={isTouch}
      />
      {/* Footer credit */}
      <div className="footer-credit">Made by Nawaf Al Hussain</div>
    </div>
  );
}
