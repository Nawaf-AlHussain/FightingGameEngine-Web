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
import { setConfigValue } from '@/lib/ikemen-config';

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
  const [fillMode, setFillMode] = useState<'fill' | 'fixed'>('fill');

  // ---- When the RES toggle changes, write it to the authoritative config ----
  // This makes the /local RES toggle a "quick set" shortcut that writes to
  // the same localStorage config the Settings UI writes to. No separate
  // URL param — Settings UI is the single source of truth.
  const handleAspectChange = useCallback((newAspect: Aspect) => {
    setAspect(newAspect);
    const { w, h } = ASPECT_TO_RESOLUTION[newAspect];
    // Fire and forget — if localStorage is unavailable, the engine falls
    // back to shipped defaults (1280×720), which is acceptable.
    setConfigValue('Video', 'GameWidth', String(w));
    setConfigValue('Video', 'GameHeight', String(h));
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

  // ---- Stage selected: build URL params and navigate to /play ----
  // NOTE: 'aspect' is NOT passed as a URL param anymore — the RES toggle
  // wrote it to localStorage config, which vfs.js reads on boot. Only
  // 'fill' (CSS-only display mode) is passed as a URL param.
  const handleStageSelect = useCallback(
    (stageId: string) => {
      if (!lockIn) return;

      const params = new URLSearchParams();
      params.set('p1', lockIn.p1Id);
      params.set('p2', lockIn.p2Id);
      params.set('stage', stageId);
      params.set('fill', fillMode);

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
        case 'arcade':
          params.set('p2ai', '5');
          break;
        case 'survival':
          params.set('p2ai', '5');
          break;
        case 'time-attack':
          params.set('p2ai', '5');
          params.set('time', '60');
          break;
        case 'watch':
          params.set('p1ai', '8');
          params.set('p2ai', '8');
          break;
      }

      navigate(`/play?${params.toString()}`);
    },
    [lockIn, fillMode, navigate]
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
      <span style={{ width: 1, height: 16, background: 'var(--gray-dark)', margin: '0 2px' }} />
      <button
        type="button"
        onClick={() => setFillMode('fill')}
        title="Stretch canvas to fill screen"
        className={`cs__diff-btn${fillMode === 'fill' ? ' cs__diff-btn--active' : ''}`}
        style={{ cursor: 'pointer' }}
      >
        FILL
      </button>
      <button
        type="button"
        onClick={() => setFillMode('fixed')}
        title="Lock to 16:9 aspect ratio, centered (no stretching on ultrawide)"
        className={`cs__diff-btn${fillMode === 'fixed' ? ' cs__diff-btn--active' : ''}`}
        style={{ cursor: 'pointer' }}
      >
        16:9
      </button>
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
