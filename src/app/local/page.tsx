'use client';

import { useState, useCallback } from 'react';
import CharacterSelect, {
  type GameMode,
  type Difficulty,
} from '@/components/CharacterSelect';
import StageSelect from '@/components/StageSelect';
import RotateOverlay from '@/components/RotateOverlay';
import { useWipeNavigation } from '@/components/WipeTransition';
import { useIsTouchDevice } from '@/lib/use-touch-device';

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
// Component
// ---------------------------------------------------------------------------

export default function LocalPlayPage() {
  const { navigate } = useWipeNavigation();
  const isTouch = useIsTouchDevice();

  const [screen, setScreen] = useState<Screen>('select');
  const [lockIn, setLockIn] = useState<LockInResult | null>(null);
  const [aspect, setAspect] = useState<Aspect>('4:3');
  const [fillMode, setFillMode] = useState<'fill' | 'fixed'>('fill');

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
  const handleStageSelect = useCallback(
    (stageId: string) => {
      if (!lockIn) return;

      const params = new URLSearchParams();
      params.set('p1', lockIn.p1Id);
      params.set('p2', lockIn.p2Id);
      params.set('stage', stageId);
      params.set('aspect', aspect);
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
    [lockIn, aspect, fillMode, navigate]
  );

  // ---- Cancel handlers ----
  const handleCancelSelect = useCallback(() => {
    navigate('/lobby');
  }, [navigate]);

  const handleCancelStage = useCallback(() => {
    setScreen('select');
  }, []);

  // ---- Aspect ratio toggle (preserved from previous design) ----
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
          onClick={() => setAspect(r.id)}
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
