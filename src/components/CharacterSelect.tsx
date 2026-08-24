'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  getCharacters,
  type CharacterInfo,
} from '@/lib/character-downloader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GameMode =
  | 'vs-ai'
  | 'vs-player'
  | 'training'
  | 'arcade'
  | 'survival'
  | 'time-attack'
  | 'watch';

export type Difficulty = 'easy' | 'normal' | 'hard';

interface LocalCharacter {
  id: string;
  displayName: string;
  shortName: string;
  sizeMB: number;
  bundled: boolean;
}

interface CharacterSelectProps {
  onLockIn: (
    p1Id: string,
    p2Id: string,
    mode: GameMode,
    difficulty: Difficulty,
    p1Difficulty?: Difficulty
  ) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUNDLED_CHARS: LocalCharacter[] = [
  {
    id: 'kfm',
    displayName: 'Kung Fu Man',
    shortName: 'KFM',
    sizeMB: 0,
    bundled: true,
  },
];

const MODES: { id: GameMode; label: string }[] = [
  { id: 'vs-ai', label: 'VS CPU' },
  { id: 'vs-player', label: 'VS PLAYER' },
  { id: 'training', label: 'TRAINING' },
  { id: 'arcade', label: 'ARCADE' },
  { id: 'survival', label: 'SURVIVAL' },
  { id: 'time-attack', label: 'TIME ATTACK' },
  { id: 'watch', label: 'WATCH' },
];

const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Hard' },
];

// Number of columns in the character grid (must match .cs__grid in game.css).
const GRID_COLS = 6;

interface CursorState {
  index: number;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CharacterSelect({
  onLockIn,
  onCancel,
}: CharacterSelectProps) {
  // Roster state
  const [roster, setRoster] = useState<LocalCharacter[]>(BUNDLED_CHARS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mode + difficulty
  const [mode, setMode] = useState<GameMode>('vs-ai');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');

  // Cursors
  const [p1, setP1] = useState<CursorState>({ index: 0, locked: false });
  const [p2, setP2] = useState<CursorState>({ index: 0, locked: false });

  // Track if onLockIn has been fired for this lock-in cycle (prevents double fire
  // in StrictMode dev).
  const lockInFiredRef = useRef(false);

  // ---- Fetch roster from CDN ----
  useEffect(() => {
    let cancelled = false;
    getCharacters()
      .then((chars: CharacterInfo[]) => {
        if (cancelled) return;
        const cdnChars: LocalCharacter[] = chars.map(c => ({
          id: c.id,
          displayName: c.displayName,
          shortName: c.displayName.slice(0, 12),
          sizeMB: c.sizeMB,
          bundled: false,
        }));
        setRoster([...BUNDLED_CHARS, ...cdnChars]);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Determine if each side is AI in the actual fight ----
  // (Affects label only — selection UX is the same for all modes:
  //  the user picks both characters and locks them in with U / Enter.)
  // vs-player : both human
  // watch     : both AI
  // all others: P1 human, P2 is CPU
  const p1IsAI = mode === 'watch';
  const p2IsAI = mode !== 'vs-player';

  // Both players must explicitly lock in (even for AI sides, the user
  // picks the character and confirms the selection).
  const p1Locked = p1.locked;
  const p2Locked = p2.locked;

  // ---- Movement helpers ----
  const moveCursor = useCallback(
    (player: 1 | 2, dir: 'up' | 'down' | 'left' | 'right') => {
      const setter = player === 1 ? setP1 : setP2;
      setter(prev => {
        if (prev.locked) return prev; // can't move while locked
        const total = roster.length;
        if (total === 0) return prev;
        const cols = GRID_COLS;
        let idx = prev.index;
        switch (dir) {
          case 'up':    idx = idx - cols; break;
          case 'down':  idx = idx + cols; break;
          case 'left':  idx = idx - 1; break;
          case 'right': idx = idx + 1; break;
        }
        // Wrap with modulo (handles negative indices).
        idx = ((idx % total) + total) % total;
        return { ...prev, index: idx };
      });
    },
    [roster.length]
  );

  const toggleLock = useCallback((player: 1 | 2) => {
    const setter = player === 1 ? setP1 : setP2;
    setter(prev => ({ ...prev, locked: !prev.locked }));
  }, []);

  // ---- Keyboard controls ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = e.code;

      // P1: WASD + U (lock)
      if (code === 'KeyW') { e.preventDefault(); moveCursor(1, 'up'); return; }
      if (code === 'KeyS') { e.preventDefault(); moveCursor(1, 'down'); return; }
      if (code === 'KeyA') { e.preventDefault(); moveCursor(1, 'left'); return; }
      if (code === 'KeyD') { e.preventDefault(); moveCursor(1, 'right'); return; }
      if (code === 'KeyU') {
        e.preventDefault();
        toggleLock(1);
        return;
      }

      // P2: Arrows + Enter (lock)
      if (code === 'ArrowUp')    { e.preventDefault(); moveCursor(2, 'up'); return; }
      if (code === 'ArrowDown')  { e.preventDefault(); moveCursor(2, 'down'); return; }
      if (code === 'ArrowLeft')  { e.preventDefault(); moveCursor(2, 'left'); return; }
      if (code === 'ArrowRight') { e.preventDefault(); moveCursor(2, 'right'); return; }
      if (code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        toggleLock(2);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveCursor, toggleLock]);

  // ---- When mode changes, reset lock states ----
  useEffect(() => {
    setP1(prev => ({ ...prev, locked: false }));
    setP2(prev => ({ ...prev, locked: false }));
    lockInFiredRef.current = false;
  }, [mode]);

  // ---- Fire onLockIn when both are locked ----
  useEffect(() => {
    if (loading) return;
    if (!p1Locked || !p2Locked) {
      lockInFiredRef.current = false;
      return;
    }
    if (lockInFiredRef.current) return;
    lockInFiredRef.current = true;

    const p1Char = roster[p1.index] ?? roster[0];
    const p2Char = roster[p2.index] ?? roster[0];
    if (!p1Char || !p2Char) return;

    // For watch mode, both AIs use the max difficulty.
    const p1Diff = p1IsAI ? 'hard' : undefined;
    onLockIn(p1Char.id, p2Char.id, mode, difficulty, p1Diff);
  }, [
    p1Locked,
    p2Locked,
    loading,
    roster,
    p1.index,
    p2.index,
    mode,
    difficulty,
    p1IsAI,
    onLockIn,
  ]);

  // ---- Click handler: assigns char to first unlocked player ----
  // P1 gets priority; if P1 is locked, click sets P2.
  const handleCardClick = useCallback(
    (index: number) => {
      if (!p1Locked) {
        setP1({ index, locked: false });
      } else if (!p2Locked) {
        setP2({ index, locked: false });
      }
    },
    [p1Locked, p2Locked]
  );

  // ---- Render helpers ----
  const p1Char = roster[p1.index];
  const p2Char = roster[p2.index];

  const cardClasses = useCallback(
    (index: number) => {
      const classes = ['cs__card', 'cs__card--enter'];
      const isP1 = p1.index === index;
      const isP2 = p2.index === index;
      if (isP1 && isP2) classes.push('cs__card--both');
      else if (isP1) classes.push('cs__card--p1');
      else if (isP2) classes.push('cs__card--p2');
      if ((isP1 && p1Locked) || (isP2 && p2Locked)) classes.push('cs__card--locked');
      return classes.join(' ');
    },
    [p1.index, p2.index, p1Locked, p2Locked]
  );

  const showDifficulty = p2IsAI || p1IsAI;

  return (
    <main className="cs bg-grid" tabIndex={0}>
      <div className="cs__bg-grid bg-grid" aria-hidden="true" />

      {/* Title */}
      <div className="cs__title">
        <h1 className="cs__title-main">SELECT FIGHTER</h1>
        <div className="cs__title-sub">
          {loading
            ? 'LOADING ROSTER…'
            : error
            ? `CDN ERROR: ${error.toUpperCase()}`
            : `${roster.length} CHARACTERS AVAILABLE`}
        </div>
      </div>

      {/* Mode bar */}
      <div className="cs__mode-bar" role="tablist" aria-label="Game mode">
        {MODES.map(m => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className={`cs__mode-btn${mode === m.id ? ' cs__mode-btn--active' : ''}`}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Difficulty bar (only for AI modes) */}
      {showDifficulty && (
        <div className="cs__difficulty-bar" aria-label="AI difficulty">
          <span>DIFFICULTY</span>
          {DIFFICULTIES.map(d => (
            <button
              key={d.id}
              type="button"
              className={`cs__diff-btn${difficulty === d.id ? ' cs__diff-btn--active' : ''}`}
              onClick={() => setDifficulty(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      {/* VS bar: shows each player's current pick + lock status */}
      <div className="cs__vs-bar">
        <PlayerTag
          side="p1"
          label={p1IsAI ? 'P1 · CPU' : 'P1'}
          name={p1Char?.displayName ?? '—'}
          locked={p1Locked}
        />
        <span className="cs__vs">VS</span>
        <PlayerTag
          side="p2"
          label={p2IsAI ? 'P2 · CPU' : 'P2'}
          name={p2Char?.displayName ?? '—'}
          locked={p2Locked}
        />
      </div>

      {/* Character grid */}
      <div className="cs__grid" role="grid" aria-label="Character roster">
        {loading && (
          <div
            style={{
              gridColumn: `1 / -1`,
              textAlign: 'center',
              padding: '2rem',
              color: 'var(--gray)',
              fontSize: '0.85rem',
              letterSpacing: '0.2em',
            }}
          >
            LOADING…
          </div>
        )}
        {!loading &&
          roster.map((char, index) => {
            const isP1Here = p1.index === index;
            const isP2Here = p2.index === index;
            const p1LockedHere = isP1Here && p1Locked;
            const p2LockedHere = isP2Here && p2Locked;
            return (
              <div
                key={char.id}
                className={cardClasses(index)}
                style={{
                  animationDelay: `${Math.min(index * 25, 600)}ms`,
                }}
                onClick={() => handleCardClick(index)}
                role="gridcell"
                tabIndex={-1}
              >
                <div className="cs__card-portrait">
                  <div className="cs__card-fallback">
                    {char.displayName.charAt(0).toUpperCase()}
                  </div>
                  {isP1Here && (
                    <div
                      className={`cs__card-cursor cs__cursor--p1${p1LockedHere ? ' cs__cursor--locked' : ''}`}
                    >
                      P1{p1LockedHere ? ' ✓' : ''}
                    </div>
                  )}
                  {isP2Here && (
                    <div
                      className={`cs__card-cursor cs__cursor--p2${p2LockedHere ? ' cs__cursor--locked' : ''}`}
                    >
                      {p2IsAI ? 'CPU' : 'P2'}{p2LockedHere ? ' ✓' : ''}
                    </div>
                  )}
                </div>
                <div className="cs__card-info">{char.displayName}</div>
                {char.bundled ? (
                  <div className="cs__card-download" style={{ color: 'var(--green)' }}>
                    BUNDLED
                  </div>
                ) : (
                  <div className="cs__card-download">
                    DOWNLOAD · {char.sizeMB.toFixed(1)} MB
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {/* Footer */}
      <div className="cs__footer">
        <div className="cs__controls-help">
          <div>
            P1: <span>WASD</span> move · <span>U</span> lock-in
          </div>
          <div>
            P2{p2IsAI ? ' (CPU)' : ''}: <span>ARROWS</span> move · <span>ENTER</span> lock-in
          </div>
          <div>
            Click a card to set the next player's character
          </div>
        </div>
        <div className="cs__footer-btns">
          <button type="button" className="cs__btn-back" onClick={onCancel}>
            ← BACK
          </button>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// PlayerTag subcomponent
// ---------------------------------------------------------------------------

function PlayerTag({
  side,
  label,
  name,
  locked,
}: {
  side: 'p1' | 'p2';
  label: string;
  name: string;
  locked: boolean;
}) {
  const classes = [
    'cs__player-tag',
    `cs__player-tag--${side}`,
    locked ? `cs__player-tag--locked--${side}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      <div className="cs__player-tag-label">{label}</div>
      <div className="cs__player-tag-name">{name}</div>
      <div className="cs__player-tag-status">
        {locked ? 'LOCKED IN' : 'SELECTING…'}
      </div>
    </div>
  );
}
