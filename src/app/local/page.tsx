'use client';

import { useState, useCallback, useEffect } from 'react';
import CharacterSelect, {
  type GameMode,
  type Difficulty,
} from '@/components/CharacterSelect';
import StageSelect from '@/components/StageSelect';
import RotateOverlay from '@/components/RotateOverlay';
import { useWipeNavigation } from '@/components/WipeTransition';
import { useIsTouchDevice } from '@/lib/use-touch-device';
import { loadConfig, applyDisplayModePreset, saveConfig } from '@/lib/ikemen-config';
import { startMode, type ProgressionMode } from '@/lib/game-modes';
import { getCharacters } from '@/lib/character-downloader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Screen = 'select' | 'stage-select';

type Aspect = 'low' | '4:3' | '16:9';

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
// Resolution toggle: maps the 3-preset toggle to GameWidth/GameHeight.
// These are written to localStorage config.ini (the authoritative source)
// via setConfigValue, NOT passed as URL params. vfs.js picks them up via
// restorePersisted() on next boot.
// ---------------------------------------------------------------------------

const ASPECT_TO_RESOLUTION: Record<Aspect, { w: number; h: number }> = {
  'low':  { w: 320, h: 240 },  // 480p low — fastest
  '4:3':  { w: 640, h: 480 },  // 4:3 standard
  '16:9': { w: 1280, h: 720 }, // 16:9 HD
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LocalPlayPage() {
  const { navigate } = useWipeNavigation();
  const isTouch = useIsTouchDevice();

  const [screen, setScreen] = useState<Screen>('select');
  const [lockIn, setLockIn] = useState<LockInResult | null>(null);
  const [aspect, setAspect] = useState<Aspect>('4:3');
  // NOTE: the old FILL/16:9 display toggle was removed (Frontend 2.1 spec
  // Section 26: "Do not expose controls that appear functional but have no
  // runtime effect"). The /play canvas fitter always displays the canvas at
  // its intrinsic aspect ratio, fitted to the largest size that fits the
  // viewport — there is no separate fill mode at runtime.

  // ---- When the RES toggle changes, write it to the authoritative config ----
  // This makes the /local RES toggle a "quick set" shortcut that writes to
  // the same localStorage config the Settings UI writes to. No separate
  // URL param — Settings UI is the single source of truth.
  //
  // applyDisplayModePreset writes GameWidth/GameHeight AND the matching
  // fight-aspect keys in one call. A bare resolution write is not enough:
  // the engine derives fight content aspect from FightAspectWidth/Height
  // (-1 = stage localcoord, and shipped stages are 16:9), so a 4:3
  // resolution without the aspect keys renders 16:9 content letterboxed or
  // stretched inside a 4:3 canvas.
  //
  // IMPORTANT: we load the config ONCE, apply the preset, then save ONCE.
  // Calling setConfigValue twice would race (two independent load→modify→
  // save cycles where the second save overwrites the first).
  const handleAspectChange = useCallback(async (newAspect: Aspect) => {
    setAspect(newAspect);
    const { w, h } = ASPECT_TO_RESOLUTION[newAspect];
    const cfg = await loadConfig();
    if (!cfg) return;
    applyDisplayModePreset(cfg, String(w), String(h));
    saveConfig(cfg);
  }, []);

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
        // Fetch roster to generate opponent ladder
        let rosterCharIds: string[] = ['kfm'];
        try {
          const chars = await getCharacters();
          rosterCharIds = chars.map(c => c.id);
        } catch {
          // Fallback to kfm only
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

  // ---- Aspect ratio toggle (writes to localStorage, NOT URL) ----
  const aspectButtons: { id: Aspect; label: string; hint: string }[] = [
    { id: 'low', label: '480p', hint: '320×240 · fastest' },
    { id: '4:3', label: '4:3', hint: '640×480 · balanced' },
    { id: '16:9', label: '16:9', hint: '1280×720 · highest' },
  ];

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const aspectToggle = (
    <div
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        zIndex: 50,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        background: 'rgba(13,13,13,0.85)',
        padding: '6px 10px',
        clipPath: 'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',
      }}
    >
      <span
        style={{
          fontSize: '0.65rem',
          letterSpacing: '0.15em',
          color: 'var(--gray)',
          fontWeight: 600,
        }}
      >
        RES
      </span>
      {aspectButtons.map(r => (
        <button
          key={r.id}
          type="button"
          onClick={() => handleAspectChange(r.id)}
          title={r.hint}
          className={`cs__diff-btn${aspect === r.id ? ' cs__diff-btn--active' : ''}`}
          style={{ cursor: 'pointer' }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  if (screen === 'stage-select' && lockIn) {
    return (
      <div>
        {isTouch && <RotateOverlay />}
        {aspectToggle}
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
      {aspectToggle}
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
