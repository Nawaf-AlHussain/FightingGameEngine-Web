'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  downloadCharacterToCache,
  getCachedCharacterIds,
  getCharacters,
  isCharacterCached,
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

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
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
const GRID_COLS = 10;

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
  // Full CharacterInfo objects keyed by id (needed for downloadCharacterToCache,
  // which requires the manifest entry with `files`, `cdnBase`, etc.).
  const [characterInfos, setCharacterInfos] = useState<Record<string, CharacterInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mode + difficulty
  const [mode, setMode] = useState<GameMode>('vs-ai');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');

  // Cursors
  const [p1, setP1] = useState<CursorState>({ index: 0, locked: false });
  const [p2, setP2] = useState<CursorState>({ index: 0, locked: false });

  // ---- Download cache state ----
  // cachedIds: characters already in IndexedDB (populated on mount + updated
  // when a download completes). Used for the bothReady check.
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  // downloadStates: per-character download progress / status for the UI.
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});

  // Track if onLockIn has been fired for this lock-in cycle (prevents double fire
  // in StrictMode dev).
  const lockInFiredRef = useRef(false);

  // Refs that mirror state for use inside stable callbacks / async closures
  // (avoids stale closures without re-creating the triggerDownload callback).
  const characterInfosRef = useRef<Record<string, CharacterInfo>>({});
  const cachedIdsRef = useRef<Set<string>>(new Set());
  const downloadStatesRef = useRef<Record<string, DownloadState>>({});
  // Tracks which character downloads are currently in-flight (prevents
  // double-triggering when state updates fire effects repeatedly).
  const inflightRef = useRef<Set<string>>(new Set());

  useEffect(() => { characterInfosRef.current = characterInfos; }, [characterInfos]);
  useEffect(() => { cachedIdsRef.current = cachedIds; }, [cachedIds]);
  useEffect(() => { downloadStatesRef.current = downloadStates; }, [downloadStates]);

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
        const infoMap: Record<string, CharacterInfo> = {};
        for (const c of chars) infoMap[c.id] = c;
        setCharacterInfos(infoMap);
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

  // ---- On mount, check which characters are already cached in IndexedDB ----
  useEffect(() => {
    let cancelled = false;
    getCachedCharacterIds()
      .then((ids: Set<string>) => {
        if (cancelled) return;
        setCachedIds(ids);
      })
      .catch(() => {
        // IndexedDB might be unavailable (private mode, etc.) — just ignore.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Trigger a background download for a character (non-blocking) ----
  // Idempotent: skips if already cached, already downloading, or in-flight.
  const triggerDownload = useCallback((charId: string) => {
    const info = characterInfosRef.current[charId];
    if (!info) return; // bundled or unknown — nothing to download
    if (cachedIdsRef.current.has(charId)) return; // already cached
    const cur = downloadStatesRef.current[charId];
    if (cur?.status === 'downloading' || cur?.status === 'cached') return;
    if (inflightRef.current.has(charId)) return; // already started
    inflightRef.current.add(charId);

    // Optimistically mark as downloading so the UI shows immediate feedback.
    setDownloadStates(prev => ({
      ...prev,
      [charId]: { status: 'downloading', progress: 0 },
    }));

    // Defensive: verify against IndexedDB in case our cachedIds state is stale
    // (e.g., the character was cached in another browser tab). If it's already
    // there, mark as cached and skip the actual download.
    isCharacterCached(charId)
      .then((alreadyCached) => {
        if (alreadyCached) {
          setDownloadStates(prev => ({
            ...prev,
            [charId]: { status: 'cached', progress: 100 },
          }));
          setCachedIds(prev => {
            if (prev.has(charId)) return prev;
            const next = new Set(prev);
            next.add(charId);
            return next;
          });
          return;
        }
        return downloadCharacterToCache(info, (pct) => {
          setDownloadStates(prev => {
            const c = prev[charId];
            if (c?.status !== 'downloading') return prev; // stale update
            return { ...prev, [charId]: { status: 'downloading', progress: pct } };
          });
        });
      })
      .then(() => {
        // downloadCharacterToCache completed (or was already cached).
        // Only transition to 'cached' if we're still in 'downloading' — don't
        // clobber an 'error' state set elsewhere.
        setDownloadStates(prev => {
          const c = prev[charId];
          if (c?.status !== 'downloading') return prev;
          return { ...prev, [charId]: { status: 'cached', progress: 100 } };
        });
        setCachedIds(prev => {
          if (prev.has(charId)) return prev;
          const next = new Set(prev);
          next.add(charId);
          return next;
        });
      })
      .catch((err: unknown) => {
        console.warn(`[select] Failed to download character ${charId}:`, err);
        setDownloadStates(prev => ({
          ...prev,
          [charId]: { status: 'error', progress: 0 },
        }));
      })
      .finally(() => {
        inflightRef.current.delete(charId);
      });
  }, []);

  // ---- Toggle lock for a player (keyboard: U / Enter; click uses FIGHT) ----
  // Downloads only fire HERE — on lock-in — not when the cursor merely
  // passes over a character. If the character is already cached the call
  // is a no-op; otherwise the download runs in the background and the
  // FIGHT button stays gated on `bothReady` until both are cached.
  const toggleLock = useCallback((player: 1 | 2) => {
    const setter = player === 1 ? setP1 : setP2;
    setter(prev => {
      if (!prev.locked) {
        const char = roster[prev.index];
        if (char && !char.bundled) {
          triggerDownload(char.id);
        }
      }
      return { ...prev, locked: !prev.locked };
    });
  }, [roster, triggerDownload]);

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

  // ---- "Ready" check: a character is ready if bundled or cached ----
  const isReady = useCallback((c?: LocalCharacter): boolean => {
    if (!c) return false;
    if (c.bundled) return true;
    return cachedIds.has(c.id);
  }, [cachedIds]);

  const p1Char = roster[p1.index];
  const p2Char = roster[p2.index];
  const bothReady = isReady(p1Char) && isReady(p2Char);

  // ---- Fire onLockIn when both are locked AND both are ready ----
  // Downloads are non-blocking — the user can lock in via keyboard before
  // downloads finish; onLockIn waits until bothReady becomes true.
  useEffect(() => {
    if (loading) return;
    if (!bothReady) {
      // Don't reset lockInFiredRef here — we want it to fire once bothReady
      // becomes true while both are locked (downloads just completed).
      return;
    }
    if (!p1Locked || !p2Locked) {
      lockInFiredRef.current = false;
      return;
    }
    if (lockInFiredRef.current) return;
    lockInFiredRef.current = true;

    const c1 = roster[p1.index] ?? roster[0];
    const c2 = roster[p2.index] ?? roster[0];
    if (!c1 || !c2) return;

    // For watch mode, both AIs use the max difficulty.
    const p1Diff = p1IsAI ? 'hard' : undefined;
    onLockIn(c1.id, c2.id, mode, difficulty, p1Diff);
  }, [
    p1Locked,
    p2Locked,
    bothReady,
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

  // ---- FIGHT button: lock both players at once (triggers onLockIn) ----
  const handleFightClick = useCallback(() => {
    if (!bothReady) return;
    setP1(prev => ({ ...prev, locked: true }));
    setP2(prev => ({ ...prev, locked: true }));
  }, [bothReady]);

  // ---- Render helpers ----
  const cardClasses = useCallback(
    (index: number) => {
      const classes = ['cs__card', 'cs__card--enter'];
      const char = roster[index];
      if (char && isReady(char)) classes.push('cs__card--ready');
      const isP1 = p1.index === index;
      const isP2 = p2.index === index;
      if (isP1 && isP2) classes.push('cs__card--both');
      else if (isP1) classes.push('cs__card--p1');
      else if (isP2) classes.push('cs__card--p2');
      if ((isP1 && p1Locked) || (isP2 && p2Locked)) classes.push('cs__card--locked');
      return classes.join(' ');
    },
    [roster, p1.index, p2.index, p1Locked, p2Locked, isReady]
  );

  // ---- Render the download status block for a card ----
  const renderDownloadStatus = (char: LocalCharacter) => {
    // Bundled characters (KFM) — always ready, no download needed.
    if (char.bundled) {
      return (
        <div className="cs__card-download" style={{ color: 'var(--green)' }}>
          BUNDLED
        </div>
      );
    }

    // Already cached (in IndexedDB before mount or via a completed download).
    if (cachedIds.has(char.id)) {
      return (
        <div className="cs__card-download" style={{ color: 'var(--green)' }}>
          ✓ CACHED
        </div>
      );
    }

    const ds = downloadStates[char.id];

    // Download in progress — show percent + progress bar.
    if (ds?.status === 'downloading') {
      return (
        <>
          <div className="cs__card-download">
            DOWNLOADING · {ds.progress}%
          </div>
          <div className="cs__card-progress" aria-hidden="true">
            <div
              className="cs__card-progress-fill"
              style={{ width: `${ds.progress}%` }}
            />
          </div>
        </>
      );
    }

    // Download failed.
    if (ds?.status === 'error') {
      return (
        <div className="cs__card-download" style={{ color: 'var(--red)' }}>
          ⚠ DOWNLOAD FAILED
        </div>
      );
    }

    // Not yet downloaded — show size hint.
    return (
      <div className="cs__card-download">
        DOWNLOAD · {char.sizeMB.toFixed(1)} MB
      </div>
    );
  };

  const showDifficulty = p2IsAI || p1IsAI;

  // ---- Status line for the FIGHT button area ----
  const fightStatus = bothReady
    ? null
    : p1Locked && p2Locked
    ? 'PREPARING DOWNLOADS…'
    : 'SELECT FIGHTERS';

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
                {renderDownloadStatus(char)}
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
            Click a card to set the next player&apos;s character
          </div>
        </div>
        <div className="cs__footer-btns">
          {fightStatus && (
            <span
              className="cs__fight-status"
              style={{
                fontSize: '0.65rem',
                color: 'var(--gold)',
                letterSpacing: '0.15em',
                alignSelf: 'center',
                marginRight: '0.5rem',
              }}
            >
              {fightStatus}
            </span>
          )}
          <button type="button" className="cs__btn-back" onClick={onCancel}>
            ← BACK
          </button>
          <button
            type="button"
            className="cs__btn-fight"
            onClick={handleFightClick}
            disabled={!bothReady}
            aria-disabled={!bothReady}
            title={bothReady ? 'Lock in and fight!' : 'Both fighters must be downloaded first'}
          >
            FIGHT!
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
