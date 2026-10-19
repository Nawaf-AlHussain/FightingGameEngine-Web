'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  downloadCharacterToCache,
  getCachedCharacterIds,
  getCharacters,
  getRosterSources,
  charRef,
  splitCharRef,
  portraitUrl,
  DEFAULT_SOURCE,
  isCharacterCached,
  type CharacterInfo,
  type RosterSource,
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
  /** Browser URL of the big-portrait PNG @ 256px (undefined = letter tile). */
  portrait?: string;
}

interface CharacterSelectProps {
  /** Local (offline) flow: fires when both fighters are locked and ready.
   *  Optional — the ONLINE flow never uses it (the parent drives via
   *  online.onPick instead). */
  onLockIn?: (
    p1Id: string,
    p2Id: string,
    mode: GameMode,
    difficulty: Difficulty,
    p1Difficulty?: Difficulty
  ) => void;
  onCancel: () => void;
  /**
   * When true, the UI is optimized for touch devices:
   *   - Tap a card to lock-in immediately (first tap = P1, second = P2)
   *   - Tap a locked card to unlock it (toggle)
   *   - Hide keyboard hints, show touch hint instead
   *   - Larger touch targets via CSS
   */
  isTouch?: boolean;
  /**
   * Online (netplay) mode: this machine controls exactly ONE side and the
   * other side is the remote opponent, rendered from live bridge state.
   * When set, the mode/difficulty bars are hidden and onLockIn is never
   * fired — the parent drives the flow via onPick.
   */
  online?: {
    role: 'host' | 'guest';
    /** Opponent's locked character id (null until they lock in). */
    opponentId: string | null;
    /** Opponent's live cursor index while browsing (null = nothing seen). */
    opponentIndex: number | null;
    /** Opponent has locked their fighter. */
    opponentLocked: boolean;
    /** Local player locked in (id + grid index) / unlocked (null id). */
    onPick: (charId: string | null, index: number) => void;
    /** Stream local cursor moves so the opponent sees the browsing. */
    onCursor?: (index: number) => void;
  } | null;
}

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODES: { id: GameMode; label: string; description: string; p2Label: string; progression: boolean }[] = [
  { id: 'vs-ai',      label: 'VS CPU',       description: 'Fight a single match against the CPU.',                  p2Label: 'CPU',              progression: false },
  { id: 'vs-player',  label: 'VS PLAYER',    description: 'Fight a single match against another player.',           p2Label: 'P2',               progression: false },
  { id: 'training',   label: 'TRAINING',     description: 'Practice with infinite time and no AI.',                 p2Label: 'DUMMY',            progression: false },
  { id: 'arcade',     label: 'ARCADE',       description: 'Fight through a five-opponent ladder.',                  p2Label: 'RANDOM OPPONENTS', progression: true },
  { id: 'survival',   label: 'SURVIVAL',     description: 'Defeat as many opponents as possible. Endless.',         p2Label: 'RANDOM OPPONENTS', progression: true },
  { id: 'time-attack',label: 'TIME ATTACK',  description: 'Complete three fights as quickly as possible. 60s rounds.', p2Label: 'RANDOM OPPONENTS', progression: true },
  { id: 'watch',      label: 'WATCH',        description: 'Watch two CPU-controlled fighters battle.',              p2Label: 'CPU',              progression: true },
];

const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Hard' },
];

// Fallback column count for keypresses before the grid has rendered (rare).
// The CSS grid densifies per breakpoint, so the LIVE count is read from the
// DOM at runtime — a hardcoded constant breaks up/down steps on every
// breakpoint but one.
const GRID_COLS = 10;

// localStorage key persisting the chosen roster source across visits.
const ROSTER_SOURCE_KEY = 'fg-roster-source';
const ROSTER_SOURCE_KEY_LEGACY = 'ikemen-roster-source';
// localStorage keys persisting the last mode/difficulty across visits
// (repeat sessions skip re-tapping VS CPU + Normal every time).
const SELECT_MODE_KEY = 'fg-select-mode';
const SELECT_DIFF_KEY = 'fg-select-diff';

// True when a keystroke originated inside a text field. The global grid
// hotkeys (WASD / arrows / Enter / …) must never fire while the player is
// typing in the SEARCH box — before this guard, typing "w" moved the P1
// cursor and pressing Enter locked P2's fighter mid-search.
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

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
  isTouch = false,
  online = null,
}: CharacterSelectProps) {
  // Roster state
  // The roster is the CDN manifest only — the engine ships no bundled
  // characters anymore (kfm was removed).
  const [roster, setRoster] = useState<LocalCharacter[]>([]);
  // Full CharacterInfo objects keyed by selection reference (needed for
  // downloadCharacterToCache, which requires the manifest entry with
  // `files`, `cdnBase`, etc.).
  const [characterInfos, setCharacterInfos] = useState<Record<string, CharacterInfo>>({});
  // Roster sources (chars* folders in the Assets repo) + the active one.
  const [sources, setSources] = useState<RosterSource[]>([]);
  const [activeSource, setActiveSource] = useState<string>(DEFAULT_SOURCE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the RETRY button to re-run the roster fetch (spec Section 33:
  // errors must answer "can the user retry?").
  const [retryTick, setRetryTick] = useState(0);

  // Mode + difficulty
  const [mode, setMode] = useState<GameMode>('vs-ai');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');
  // View filter: show only characters already cached on this device
  // (zero-wait picking — no download stalls after lock-in).
  const [readyOnly, setReadyOnly] = useState(false);

  // Cursors
  const [p1, setP1] = useState<CursorState>({ index: 0, locked: false });
  const [p2, setP2] = useState<CursorState>({ index: 0, locked: false });

  // ---- Online (netplay) mode: this machine drives exactly ONE side; the
  // other side is the remote opponent, rendered from live bridge state. ----
  const ownPlayer: 1 | 2 = online?.role === 'guest' ? 2 : 1;
  const oppPlayer: 1 | 2 = ownPlayer === 1 ? 2 : 1;

  // ---- Download cache state ----
  // cachedIds: characters already in IndexedDB (populated on mount + updated
  // when a download completes). Used for the bothReady check.
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  // downloadStates: per-character download progress / status for the UI.
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});
  // Online: the player attempted to lock while their fighter was still
  // downloading. Remember the intent and complete the lock the moment the
  // download lands - before this, the LOCK IN button silently disabled
  // itself and the match could never start unless the player happened to
  // press it again after the download finished.
  const [pendingLock, setPendingLock] = useState(false);

  // Track if onLockIn has been fired for this lock-in cycle (prevents double fire
  // in StrictMode dev).
  const lockInFiredRef = useRef(false);
  // Search field — focused by the global "/" hotkey.
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    setLoading(true);
    setError(null);
    Promise.all([getCharacters(), getRosterSources()])
      .then(([chars, rosterSources]: [CharacterInfo[], RosterSource[]]) => {
        if (cancelled) return;
        // LocalCharacter.id IS the selection reference: plain folder id for
        // the default source ("Wolverine"), "<source>/<id>" otherwise
        // ("charsMARVEL/Wolverine"). Bundled chars keep their plain ids.
        const cdnChars: LocalCharacter[] = chars.map(c => ({
          id: charRef(c),
          displayName: c.displayName,
          shortName: c.displayName.slice(0, 12),
          sizeMB: c.sizeMB,
          bundled: false,
          portrait: portraitUrl(c),
        }));
        const infoMap: Record<string, CharacterInfo> = {};
        for (const c of chars) infoMap[charRef(c)] = c;
        setCharacterInfos(infoMap);
        setRoster(cdnChars);
        setSources(rosterSources);
        // Restore the persisted source choice; fall back to the default if
        // it no longer exists (folder renamed/removed upstream).
        const saved = typeof window !== 'undefined' ? (localStorage.getItem(ROSTER_SOURCE_KEY) ?? localStorage.getItem(ROSTER_SOURCE_KEY_LEGACY)) : null;
        if (saved && rosterSources.some(s => s.id === saved)) {
          setActiveSource(saved);
        } else {
          setActiveSource(DEFAULT_SOURCE);
          if (saved) { localStorage.removeItem(ROSTER_SOURCE_KEY); try { localStorage.removeItem(ROSTER_SOURCE_KEY_LEGACY); } catch { /* ignore */ } }
        }
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
  }, [retryTick]);

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
    // Pass the required file list so partial downloads (from a previous bug)
    // are NOT marked as cached — isCharacterCached validates all files present.
    isCharacterCached(charId, info.files)
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
  const p1IsAI = !online && mode === 'watch';
  const p2IsAI = !online && mode !== 'vs-player';

  // For progression modes (arcade/survival/time-attack/watch), the user
  // only picks P1 — P2 is auto-generated by the mode's opponent ladder.
  // So P2 doesn't need to be locked. The FIGHT button enables as soon
  // as P1 is locked and ready.
  const isProgressionMode = ['arcade', 'survival', 'time-attack', 'watch'].includes(mode);
  const p1Locked = p1.locked;
  const p2Locked = p2.locked || isProgressionMode; // auto-locked for progression modes

  // The side that still has to lock in — drives the step strip, the RANDOM
  // action and the page-scroll keys. Online: this machine's side until it
  // locks (the opponent's side is never ours to pick).
  const nextPicker: 1 | 2 | null = online
    ? ((ownPlayer === 1 ? p1 : p2).locked ? null : ownPlayer)
    : p1Locked
    ? (!isProgressionMode && !p2Locked ? 2 : null)
    : 1;
  const nextPickerRef = useRef<1 | 2 | null>(1);
  nextPickerRef.current = nextPicker;

  // ---- Movement helpers ----
  // Cursor movement operates on the FILTERED view (see filteredIndices): the
  // cursor hops between cards that are actually rendered, so a search or a
  // roster-source switch can never move it onto an invisible character.
  // Page keys jump two rows at a time for 100+ rosters.
  const filteredIndicesRef = useRef<number[]>([]);
  // Grid element — read for the live column count (cursor row steps).
  const gridRef = useRef<HTMLDivElement>(null);
  const moveCursor = useCallback(
    (player: 1 | 2, dir: 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown') => {
      const setter = player === 1 ? setP1 : setP2;
      setter(prev => {
        if (prev.locked) return prev; // can't move while locked
        const list = filteredIndicesRef.current;
        if (list.length === 0) return prev;
        // Live column count — the CSS grid densifies per breakpoint, so the
        // up/down step must match what is actually rendered. Reading the
        // used 'gridTemplateColumns' track list beats duplicating every CSS
        // breakpoint here in JS.
        const g = gridRef.current;
        const cols = g
          ? Math.max(1, getComputedStyle(g).gridTemplateColumns.trim().split(/\s+/).length)
          : GRID_COLS;
        let pos = list.indexOf(prev.index);
        if (pos === -1) return { ...prev, index: list[0] }; // filtered out — snap
        switch (dir) {
          case 'up':       pos -= cols; break;
          case 'down':     pos += cols; break;
          case 'left':     pos -= 1; break;
          case 'right':    pos += 1; break;
          case 'pageup':   pos -= cols * 2; break;
          case 'pagedown': pos += cols * 2; break;
          case 'home':     pos = 0; break;
          case 'end':      pos = list.length - 1; break;
        }
        // Wrap with modulo (handles negative indices).
        pos = ((pos % list.length) + list.length) % list.length;
        return { ...prev, index: list[pos] };
      });
    },
    []
  );

  // ---- Keyboard controls ----
  // Disabled on touch devices — no keyboard available, and we don't want
  // to interfere with any native browser shortcuts. Also disabled in
  // online mode, which has its own unified handler below (one player per
  // device: every key drives THIS machine's cursor).
  useEffect(() => {
    if (isTouch) return; // no keyboard on phones
    if (online) return; // online: unified handler below
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while the player types in the search field.
      if (isTypingTarget(e)) {
        if (e.code === 'Escape') {
          e.preventDefault();
          setSearchQuery('');
          (e.target as HTMLElement).blur();
        }
        return;
      }
      const code = e.code;

      // "/" focuses the search field from anywhere on the screen.
      if (code === 'Slash') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      // Escape / Backspace back out (matches stage select).
      if (code === 'Escape' || code === 'Backspace') {
        e.preventDefault();
        onCancel();
        return;
      }
      // R random-locks the side that is still choosing (ready fighters only).
      if (code === 'KeyR') {
        e.preventDefault();
        if (nextPickerRef.current) randomLockRef.current(nextPickerRef.current);
        return;
      }
      // Page keys drive whichever side is still choosing (big rosters).
      if (code === 'Home' || code === 'End' || code === 'PageUp' || code === 'PageDown') {
        e.preventDefault();
        const dir = code === 'Home' ? 'home' : code === 'End' ? 'end' : code === 'PageUp' ? 'pageup' : 'pagedown';
        moveCursor(nextPickerRef.current ?? 1, dir);
        return;
      }

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
  }, [moveCursor, toggleLock, isTouch, onCancel]);

  // ---- When mode changes, reset lock states ----
  useEffect(() => {
    setP1(prev => ({ ...prev, locked: false }));
    setP2(prev => ({ ...prev, locked: false }));
    lockInFiredRef.current = false;
  }, [mode]);

  // ---- Persist + restore mode & difficulty across visits ----
  // Restored AFTER mount (not in the useState initializer) so SSR HTML and
  // the first client render agree — no hydration mismatch.
  useEffect(() => {
    try {
      const m = localStorage.getItem(SELECT_MODE_KEY);
      if (m && MODES.some(x => x.id === m)) setMode(m as GameMode);
      const d = localStorage.getItem(SELECT_DIFF_KEY);
      if (d && DIFFICULTIES.some(x => x.id === d)) setDifficulty(d as Difficulty);
    } catch {
      // storage unavailable (private mode) — defaults are fine
    }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SELECT_MODE_KEY, mode); } catch { /* ignore */ }
  }, [mode]);
  useEffect(() => {
    try { localStorage.setItem(SELECT_DIFF_KEY, difficulty); } catch { /* ignore */ }
  }, [difficulty]);

  // ---- Roster source switch: reset cursors/locks (grid contents change) ----
  const handleSourceChange = useCallback((sourceId: string) => {
    setActiveSource(sourceId);
    try {
      localStorage.setItem(ROSTER_SOURCE_KEY, sourceId);
    } catch {
      // localStorage unavailable (private mode) — selection still works,
      // it just won't persist across visits.
    }
    setP1({ index: 0, locked: false });
    setP2({ index: 0, locked: false });
    lockInFiredRef.current = false;
  }, []);

  // ---- "Ready" check: a character is ready if bundled or cached ----
  const isReady = useCallback((c?: LocalCharacter): boolean => {
    if (!c) return false;
    if (c.bundled) return true;
    return cachedIds.has(c.id);
  }, [cachedIds]);

  const p1Char = roster[p1.index];
  const p2Char = roster[p2.index];

  // ---- Filtered view (source + search + on-device filters) ----
  // filteredIndices holds the FULL-roster indices of the characters that are
  // actually rendered, in display order. All cursor movement and the RANDOM
  // pick operate in this space (see moveCursor / randomLock), so the
  // keyboard cursor can never land on a card that isn't on screen. Bundled
  // chars live in game.pak, not in any source folder — they show in every
  // universe.
  const filteredIndices = useMemo(
    () =>
      roster
        .map((_, index) => index)
        .filter(i => {
          const char = roster[i];
          if (!char.bundled && splitCharRef(char.id).source !== activeSource) return false;
          if (readyOnly && !isReady(char)) return false;
          if (
            searchQuery &&
            !char.displayName.toLowerCase().includes(searchQuery.toLowerCase())
          ) {
            return false;
          }
          return true;
        }),
    [roster, activeSource, searchQuery, readyOnly, isReady]
  );
  filteredIndicesRef.current = filteredIndices;

  const filteredRoster = useMemo(
    () => filteredIndices.map(index => ({ char: roster[index], index })),
    [filteredIndices, roster]
  );

  // ---- Keep unlocked cursors inside the filtered view ----
  // When a filter hides the card a cursor sits on, snap it to the first
  // (P2: second) visible card instead of leaving a phantom selection on an
  // invisible fighter. Locked picks are never touched — a lock is a
  // commitment, and search must not silently undo it.
  useEffect(() => {
    if (loading) return;
    const list = filteredIndices;
    if (list.length === 0) return;
    setP1(prev =>
      prev.locked || list.includes(prev.index) ? prev : { ...prev, index: list[0] }
    );
    setP2(prev => {
      if (prev.locked || list.includes(prev.index)) return prev;
      return { ...prev, index: list[Math.min(1, list.length - 1)] };
    });
    // Also re-snap when a lock is RELEASED: unlocking while the cursor sits
    // on a filtered-out card (e.g. picked, then switched to ON DEVICE)
    // should immediately offer a visible card again.
  }, [filteredIndices, loading, p1.locked, p2.locked]);

  // ---- Random pick (R key / RANDOM button) ----
  // Locks a random READY (cached/bundled) character from the filtered view —
  // random never stalls the match behind a download. It routes through the
  // same state transition as a manual lock, so downloads trigger and online
  // reporting behave identically.
  const randomLock = useCallback(
    (player: 1 | 2) => {
      const ready = filteredIndicesRef.current.filter(i => {
        const c = roster[i];
        return !!c && isReady(c);
      });
      if (ready.length === 0) return;
      const pick = ready[Math.floor(Math.random() * ready.length)];
      const setter = player === 1 ? setP1 : setP2;
      setter({ index: pick, locked: true });
    },
    [roster, isReady]
  );
  const randomLockRef = useRef(randomLock);
  randomLockRef.current = randomLock;

  // ---- Online display cursors: the non-own side is derived from the ----
  // opponent's live bridge state (browsing cursor, or their locked pick
  // resolved back to a roster index). Offline these are p1/p2 unchanged.
  const oppIndexResolved = online
    ? (online.opponentLocked && online.opponentId
        ? roster.findIndex(c => c.id === online.opponentId)
        : (online.opponentIndex ?? -1))
    : -1;
  const dP1: CursorState = online
    ? (ownPlayer === 1 ? p1 : { index: oppIndexResolved, locked: !!online.opponentLocked })
    : p1;
  const dP2: CursorState = online
    ? (ownPlayer === 2 ? p2 : { index: oppIndexResolved, locked: !!online.opponentLocked })
    : p2;
  const ownChar = ownPlayer === 1 ? p1Char : p2Char;
  const oppName: string = roster[oppIndexResolved]?.displayName ?? '—';
  const p1Label = online
    ? (ownPlayer === 1 ? 'YOU · P1' : 'OPPONENT · P1')
    : (p1IsAI ? 'P1 · CPU' : 'P1');
  const p2Label = online
    ? (ownPlayer === 2 ? 'YOU · P2' : 'OPPONENT · P2')
    : (isProgressionMode ? 'OPPONENTS' : (p2IsAI ? 'P2 · CPU' : 'P2'));
  const p1Name = online && ownPlayer !== 1
    ? oppName
    : (p1Char?.displayName ?? '—');
  const p2Name = online && ownPlayer !== 2
    ? oppName
    : (isProgressionMode ? 'AUTO-GENERATED' : (p2Char?.displayName ?? '—'));
  // VS bar portraits — mirror the name derivation (opponent's live pick in
  // online mode; no portrait for auto-generated progression opponents).
  const p1Portrait = online && ownPlayer !== 1
    ? roster[oppIndexResolved]?.portrait
    : p1Char?.portrait;
  const p2Portrait = online && ownPlayer !== 2
    ? roster[oppIndexResolved]?.portrait
    : (isProgressionMode ? undefined : p2Char?.portrait);
  // For progression modes, only P1 needs to be ready (P2 is auto-generated).
  const bothReady = isProgressionMode
    ? isReady(p1Char)
    : isReady(p1Char) && isReady(p2Char);

  // ---- Online keyboard: WASD AND arrows both move YOUR cursor, ----
  // U / Enter / Space all lock in (one player per device).
  useEffect(() => {
    if (isTouch || !online) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) {
        if (e.code === 'Escape') {
          e.preventDefault();
          setSearchQuery('');
          (e.target as HTMLElement).blur();
        }
        return;
      }
      const code = e.code;
      if (code === 'Slash') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (code === 'Escape' || code === 'Backspace') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (code === 'KeyR') {
        e.preventDefault();
        if (nextPickerRef.current) randomLockRef.current(nextPickerRef.current);
        return;
      }
      let dir: 'up' | 'down' | 'left' | 'right' | null = null;
      if (code === 'KeyW' || code === 'ArrowUp') dir = 'up';
      else if (code === 'KeyS' || code === 'ArrowDown') dir = 'down';
      else if (code === 'KeyA' || code === 'ArrowLeft') dir = 'left';
      else if (code === 'KeyD' || code === 'ArrowRight') dir = 'right';
      if (dir) {
        e.preventDefault();
        moveCursor(ownPlayer, dir);
        return;
      }
      if (code === 'KeyU' || code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
        e.preventDefault();
        toggleLock(ownPlayer);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [online, ownPlayer, moveCursor, toggleLock, isTouch, onCancel]);

  // ---- Online reporting: forward lock/unlock transitions and cursor ----
  // moves to the parent (which relays them over the bridge). Driven by
  // STATE transitions — not event handlers — so keyboard, touch taps and
  // the LOCK IN button all report identically.
  const ownState = ownPlayer === 1 ? p1 : p2;
  const prevOwnSigRef = useRef('');
  useEffect(() => {
    if (!online) return;
    const sig = (ownState.locked ? 'L' : 'u') + ':' + ownState.index;
    if (prevOwnSigRef.current === sig) return;
    const wasLocked = prevOwnSigRef.current.startsWith('L');
    prevOwnSigRef.current = sig;
    if (ownState.locked) {
      const char = roster[ownState.index];
      online.onPick(char ? char.id : null, ownState.index);
    } else if (wasLocked) {
      online.onPick(null, ownState.index);
    }
  }, [online, ownState.locked, ownState.index, roster]);

  useEffect(() => {
    if (!online?.onCursor) return;
    online.onCursor(ownState.index);
  }, [online, ownState.index]);

  // ---- Online pending lock: complete it when the download lands ----
  // The player pressed LOCK IN while their fighter was still downloading.
  // Re-evaluated on every download progress update, so the lock fires
  // immediately when the character becomes ready.
  useEffect(() => {
    if (!online || !pendingLock) return;
    const own = ownPlayer === 1 ? p1 : p2;
    const char = roster[own.index];
    if (!char) { setPendingLock(false); return; }
    if (isReady(char)) {
      const setOwn = ownPlayer === 1 ? setP1 : setP2;
      setOwn(prev => ({ ...prev, locked: true }));
      setPendingLock(false);
    }
  }, [online, pendingLock, ownPlayer, p1.index, p2.index, roster, isReady, downloadStates]);

  // ---- Fire onLockIn when both are locked AND both are ready ----
  // (Skipped in online mode — the parent drives the flow via onPick.)
  // Downloads are non-blocking — the user can lock in via keyboard before
  // downloads finish; onLockIn waits until bothReady becomes true.
  useEffect(() => {
    if (loading) return;
    if (online) return;
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
    onLockIn?.(c1.id, c2.id, mode, difficulty, p1Diff);
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

  // ---- Click/tap handler ----
  // Behavior depends on isTouch:
  //
  // TOUCH (isTouch=true):
  //   - Tap unlocked card → lock it (first tap = P1, second = P2)
  //   - Tap locked card for the active player → unlock (toggle)
  //   - Tap a non-ready card → trigger download (no lock)
  //   This is the only way to select on mobile — there's no keyboard.
  //
  // DESKTOP (isTouch=false):
  //   - Click moves the cursor (no lock). User presses U / Enter or
  //     clicks FIGHT to lock. Allows previewing cards without committing.
  const handleCardClick = useCallback(
    (index: number) => {
      const char = roster[index];
      if (!char) return;

      // If character isn't ready (not bundled + not cached), tap/click
      // triggers a download. Online it ALSO moves this machine's cursor
      // onto the card so the player SEES their pick registered - before
      // this, the pick silently stayed on the old character and LOCK IN
      // locked the wrong fighter (or nothing at all).
      if (!isReady(char)) {
        if (!char.bundled) {
          triggerDownload(char.id);
          if (online) {
            const own = ownPlayer === 1 ? p1 : p2;
            const setOwn = ownPlayer === 1 ? setP1 : setP2;
            if (own.locked || own.index !== index) setOwn({ index, locked: false });
          }
        }
        return;
      }

      if (online) {
        // Online: this machine's side only — the opponent's cursor is
        // remote state and must not be movable from here.
        const own = ownPlayer === 1 ? p1 : p2;
        const setOwn = ownPlayer === 1 ? setP1 : setP2;
        if (!own.locked) {
          setOwn({ index, locked: true });
          setPendingLock(false); // direct lock supersedes any pending intent
        } else if (own.index === index) {
          // Tap the locked card again to unlock and re-pick.
          setOwn(prev => ({ ...prev, locked: false }));
        } else {
          setOwn({ index, locked: true }); // re-pick: move the lock
        }
        return;
      }

      if (isTouch) {
        // Touch: tap-to-lock semantics
        if (!p1Locked) {
          // P1 isn't locked → assign + lock P1
          setP1({ index, locked: true });
        } else if (!p2Locked) {
          // P1 is locked, P2 isn't → assign + lock P2
          // (Special case: if user taps P1's locked card, unlock P1)
          if (p1.index === index) {
            setP1(prev => ({ ...prev, locked: false }));
          } else {
            setP2({ index, locked: true });
          }
        } else {
          // Both locked — tap a locked card to unlock it (for re-pick)
          if (p1.index === index) {
            setP1(prev => ({ ...prev, locked: false }));
          } else if (p2.index === index) {
            setP2(prev => ({ ...prev, locked: false }));
          }
        }
      } else {
        // Desktop: click moves cursor only (no lock)
        if (!p1Locked) {
          setP1({ index, locked: false });
        } else if (!p2Locked) {
          setP2({ index, locked: false });
        }
      }
    },
    [roster, isReady, isTouch, online, ownPlayer, p1, p2, p1Locked, p2Locked, triggerDownload]
  );

  // ---- FIGHT button: lock both players at once (triggers onLockIn) ----
  // On touch, both are usually already locked via tap-to-lock, so this
  // just confirms and fires onLockIn. On desktop, this is the primary
  // way to lock both at once.
  // Online: toggles THIS machine's lock only (the parent relays it over
  // the bridge and starts the match once both sides + the stage lock in).
  const handleFightClick = useCallback(() => {
    if (online) {
      const own = ownPlayer === 1 ? p1 : p2;
      const char = roster[own.index];
      if (!char) return;
      const setOwn = ownPlayer === 1 ? setP1 : setP2;
      if (!isReady(char)) {
        // Still downloading: trigger the download, remember the intent -
        // the pending-lock effect completes the lock when it lands.
        if (!char.bundled) triggerDownload(char.id);
        setPendingLock(true);
        return;
      }
      setPendingLock(false);
      setOwn(prev => ({ ...prev, locked: !prev.locked }));
      return;
    }
    if (!bothReady) return;
    setP1(prev => ({ ...prev, locked: true }));
    setP2(prev => ({ ...prev, locked: true }));
  }, [bothReady, online, ownPlayer, p1, p2, roster, isReady, triggerDownload]);

  // ---- Render helpers ----
  const cardClasses = useCallback(
    (index: number) => {
      const classes = ['cs__card', 'cs__card--enter'];
      const char = roster[index];
      if (char && isReady(char)) classes.push('cs__card--ready');
      const isP1 = dP1.index === index;
      const isP2 = dP2.index === index;
      if (isP1 && isP2) classes.push('cs__card--both');
      else if (isP1) classes.push('cs__card--p1');
      else if (isP2) classes.push('cs__card--p2');
      if ((isP1 && dP1.locked) || (isP2 && dP2.locked)) classes.push('cs__card--locked');
      return classes.join(' ');
    },
    [roster, dP1, dP2, isReady]
  );
  // (the per-card download status block moved into CharacterCard below —
  // it is derived inside the memoized card from primitive props)

  const showDifficulty = p2IsAI || p1IsAI;

  // ---- Memoized card grid (Batch 4) ----
  // The roster renders 100+ cards, and EVERY parent state change — a
  // download progress tick, a cursor move, a search keystroke — used to
  // reconcile all of them. Cards are now memoized on primitive props:
  // a progress tick re-renders exactly ONE card (unchanged downloadStates
  // entries keep their object identity through the spread update) and a
  // cursor move touches only the cards it left/entered. handleCardClick is
  // cursor-dependent (its identity changes on every move), so the card gets
  // a stable latest-ref wrapper instead — identical behavior, one identity.
  const handleCardClickRef = useRef(handleCardClick);
  handleCardClickRef.current = handleCardClick;
  const onCardClick = useCallback(
    (index: number) => handleCardClickRef.current(index),
    []
  );

  // ---- Status line for the FIGHT button area ----
  const fightStatus = online
    ? !isReady(ownChar)
      ? 'PREPARING DOWNLOAD…'
      : ownState.locked && !online.opponentLocked
      ? 'WAITING FOR OPPONENT…'
      : !ownState.locked && online.opponentLocked
      ? 'OPPONENT READY — LOCK IN'
      : null
    : bothReady
    ? null
    : p1Locked && p2Locked
    ? 'PREPARING DOWNLOADS…'
    : 'SELECT FIGHTERS';

  // ---- Ready count for the masthead subtitle ----
  const readyCount = filteredRoster.reduce((n, { char }) => n + (isReady(char) ? 1 : 0), 0);

  // ---- Step strip: whose pick is it / are we ready to fight ----
  // One glanceable line above the grid (aria-live: the pick state is
  // announced to screen readers too). Touch gets TAP wording.
  const confirmWord = isTouch ? 'TAP FIGHT!' : 'PRESS FIGHT!';
  let stepText: string;
  let stepMod: string;
  if (!online) {
    if (!p1Locked) {
      stepText = 'P1 — CHOOSE YOUR FIGHTER';
      stepMod = 'cs__step--p1';
    } else if (!isProgressionMode && !p2Locked) {
      stepText = 'P2 — CHOOSE YOUR FIGHTER';
      stepMod = 'cs__step--p2';
    } else {
      stepText = `LOCKED — ${confirmWord}`;
      stepMod = 'cs__step--ready';
    }
  } else if (!ownState.locked) {
    stepText = 'YOUR PICK — CHOOSE YOUR FIGHTER';
    stepMod = ownPlayer === 1 ? 'cs__step--p1' : 'cs__step--p2';
  } else if (!online.opponentLocked) {
    stepText = 'LOCKED — WAITING FOR OPPONENT';
    stepMod = 'cs__step--ready';
  } else {
    stepText = 'BOTH LOCKED — STARTING…';
    stepMod = 'cs__step--ready';
  }

  // (Filtered view lives in filteredIndices / filteredRoster above —
  // movement, RANDOM and the grid below all read from it.)

  return (
    <main className="cs bg-grid" tabIndex={0}>
      {/* Print dressing: diagonal ink wedges + drifting halftone + reg marks */}
      <div className="cs__bg-wedges" aria-hidden="true" />
      <div className="cs__bg-dots" aria-hidden="true" />
      <span className="cs__reg cs__reg--tl" aria-hidden="true" />
      <span className="cs__reg cs__reg--tr" aria-hidden="true" />

      {/* Masthead — comic cover */}
      <header className="cs__title">
        <div className="cs__kicker">
          <span className="cs__kicker-rule" aria-hidden="true" />
          <span>ISSUE No. 02 — THE ROSTER</span>
          <span className="cs__kicker-rule" aria-hidden="true" />
        </div>
        <h1 className="cs__title-main">
          <span className="cs__title-pre">SELECT YOUR</span>
          <span className="cs__title-hero">FIGHTER</span>
        </h1>
        <div className="cs__title-sub">
          {loading
            ? 'LOADING ROSTER…'
            : error
            ? 'COULD NOT LOAD CHARACTER LIST'
            : `${readyCount} READY · ${filteredRoster.length} TOTAL`}
        </div>
        {error && (
          <div className="cs__roster-error">
            <span className="cs__roster-error-msg">CDN error: {error}</span>
            <button
              type="button"
              className="cs__diff-btn cs__diff-btn--active"
              onClick={() => setRetryTick(t => t + 1)}
            >
              RETRY
            </button>
          </div>
        )}
      </header>

      {/* Toolbar — mode, difficulty, roster source and search share ONE
          wrapping row. They used to stack as four rows (~130px of chrome
          before the grid); the mode blurb moved into button tooltips. */}
      <div className="cs__toolbar">
        {/* Mode bar (online: fixed versus — no mode/difficulty pickers) */}
        {!online && (
          <div className="cs__mode-bar" role="tablist" aria-label="Game mode">
            {MODES.map(m => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode === m.id}
                title={m.description}
                className={`cs__mode-btn${mode === m.id ? ' cs__mode-btn--active' : ''}`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* Difficulty (only for AI modes) */}
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

        {/* Roster source picker — which chars* folder the grid shows.
            Hidden when the manifest only has the default source. */}
        {!loading && !error && sources.length > 1 && (
          <div className="cs__difficulty-bar" aria-label="Roster source">
            <span>ROSTER</span>
            {sources.map(s => (
              <button
                key={s.id}
                type="button"
                className={`cs__diff-btn${activeSource === s.id ? ' cs__diff-btn--active' : ''}`}
                onClick={() => handleSourceChange(s.id)}
                title={`Characters from the ${s.id}/ folder`}
              >
                {s.label.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        {/* Search + view filter — "/" focuses the field from anywhere.
            ON DEVICE narrows the grid to cached characters so you can pick
            with zero download wait. */}
        {!loading && !error && roster.length > 10 && (
          <div className="cs__search">
            <input
              ref={searchInputRef}
              type="text"
              className="cs__search-input"
              placeholder="SEARCH…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                // Enter leaves the field (grid keys resume); Esc clears it.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setSearchQuery('');
                  e.currentTarget.blur();
                }
              }}
              title="Press / to focus — Esc clears"
              aria-label="Search characters"
            />
            {searchQuery && (
              <button
                type="button"
                className="cs__search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
            <span className="cs__search-sep" aria-hidden="true" />
            <button
              type="button"
              className={`cs__diff-btn${!readyOnly ? ' cs__diff-btn--active' : ''}`}
              onClick={() => setReadyOnly(false)}
            >
              ALL
            </button>
            <button
              type="button"
              className={`cs__diff-btn${readyOnly ? ' cs__diff-btn--active' : ''}`}
              onClick={() => setReadyOnly(true)}
              title="Only characters already cached on this device"
            >
              ON DEVICE
            </button>
          </div>
        )}
      </div>

      {/* VS bar: shows each player's current pick + lock status */}
      <div className="cs__vs-bar">
        <PlayerTag
          side="p1"
          label={p1Label}
          name={p1Name}
          locked={dP1.locked}
          portrait={p1Portrait}
        />
        <span className="cs__vs">{isProgressionMode ? '→' : 'VS'}</span>
        <PlayerTag
          side="p2"
          label={p2Label}
          name={p2Name}
          locked={dP2.locked}
          portrait={p2Portrait}
        />
      </div>

      {/* Search + view filter — moved into the toolbar above */}

      {/* Pick-step strip — whose turn it is (screen-reader announced) */}
      {!loading && !error && (
        <div className={`cs__step ${stepMod}`} aria-live="polite">{stepText}</div>
      )}

      {/* Character grid */}
      <div className="cs__grid" ref={gridRef} role="grid" aria-label="Character roster">
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
        {!loading && filteredRoster.length === 0 && (
          <div
            style={{
              gridColumn: '1 / -1',
              textAlign: 'center',
              padding: '2rem',
              color: 'var(--gray)',
              fontSize: '0.85rem',
              letterSpacing: '0.2em',
            }}
          >
            {searchQuery
              ? `NO CHARACTERS MATCH "${searchQuery.toUpperCase()}"`
              : 'NO CHARACTERS ON DEVICE YET — SWITCH TO "ALL" AND DOWNLOAD ONE'}
          </div>
        )}
        {!loading &&
          filteredRoster.map(({ char, index }) => (
            <CharacterCard
              key={char.id}
              char={char}
              index={index}
              className={cardClasses(index)}
              cached={cachedIds.has(char.id)}
              ds={downloadStates[char.id]}
              p1Here={dP1.index === index}
              p1Locked={dP1.index === index && dP1.locked}
              p1Cursor={online ? (ownPlayer === 1 ? 'YOU' : 'P1') : 'P1'}
              p2Here={dP2.index === index}
              p2Locked={dP2.index === index && dP2.locked}
              p2Cursor={online ? (ownPlayer === 2 ? 'YOU' : 'P2') : (p2IsAI ? 'CPU' : 'P2')}
              onCardClick={onCardClick}
            />
          ))}
      </div>

      {/* Footer */}
      <div className="cs__footer">
        <div className="cs__controls-help">
          {isTouch ? (
            <>
              <div>
                {online
                  ? (!ownState.locked
                    ? <><span>TAP</span> a character to lock in YOUR fighter</>
                    : <><span>TAP</span> your locked fighter to re-pick</>)
                  : !p1Locked
                  ? <><span>TAP</span> a character to lock in P1</>
                  : !p2Locked
                  ? <><span>TAP</span> a character to lock in {p2IsAI ? 'CPU' : 'P2'}
                    {' · '}<span>TAP P1</span> to re-pick</>
                  : <><span>TAP</span> a locked character to re-pick · <span>FIGHT!</span> to begin</>}
              </div>
            </>
          ) : online ? (
            <>
              <div>
                <span>WASD / ARROWS</span> move · <span>U / ENTER</span> lock in
              </div>
              <div>
                Pick YOUR fighter — your opponent picks theirs live
              </div>
            </>
          ) : isProgressionMode ? (
            <>
              <div>
                P1: <span>WASD</span> move · <span>U</span> lock-in
              </div>
              <div>
                Select your fighter — opponents are auto-generated
              </div>
            </>
          ) : (
            <>
              <div>
                P1: <span>WASD</span> move · <span>U</span> lock-in
              </div>
              <div>
                P2{p2IsAI ? ' (CPU)' : ''}: <span>ARROWS</span> move · <span>ENTER</span> lock-in
              </div>
              <div>
                Click a card to set the next player&apos;s character
              </div>
            </>
          )}
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
          <button
            type="button"
            className="cs__diff-btn"
            onClick={() => nextPicker && randomLock(nextPicker)}
            disabled={!nextPicker}
            title="Lock a random ready fighter (R)"
          >
            RANDOM
          </button>
          <button type="button" className="cs__btn-back" onClick={onCancel}>
            ← BACK
          </button>
          <button
            type="button"
            className="cs__btn-fight"
            onClick={handleFightClick}
            disabled={online ? false : !bothReady}
            aria-disabled={online ? false : !bothReady}
            title={online
              ? (ownState.locked
                  ? 'Unlock to re-pick'
                  : (ownChar && !isReady(ownChar)
                      ? 'Fighter is downloading — the lock completes automatically when it lands'
                      : 'Lock in your fighter'))
              : (bothReady ? 'Lock in and fight!' : 'Both fighters must be downloaded first')}
          >
            {online
              ? (ownState.locked
                  ? 'LOCKED ✓'
                  : (ownChar && !isReady(ownChar)
                      ? (downloadStates[ownChar.id]?.status === 'downloading'
                          ? 'DOWNLOADING ' + Math.round(downloadStates[ownChar.id].progress) + '%…'
                          : (pendingLock ? 'WAITING FOR DOWNLOAD…' : 'DOWNLOAD & LOCK'))
                      : 'LOCK IN'))
              : 'FIGHT!'}
          </button>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// CharacterCard subcomponent (memoized)
// ---------------------------------------------------------------------------

/** One roster card. Memoized on all-primitive props (char/ds identity comes
 *  from state, so unchanged entries keep referential equality across parent
 *  renders) — during a download only the downloading card re-renders, during
 *  a cursor move only the cards the cursor left/entered. The download status
 *  block mirrors the original renderDownloadStatus precedence: bundled →
 *  cached → downloading (percent + bar) → failed (retry affordance) → size
 *  hint. */
const CharacterCard = memo(function CharacterCard({
  char,
  index,
  className,
  cached,
  ds,
  p1Here,
  p1Locked,
  p1Cursor,
  p2Here,
  p2Locked,
  p2Cursor,
  onCardClick,
}: {
  char: LocalCharacter;
  index: number;
  className: string;
  cached: boolean;
  ds?: DownloadState;
  p1Here: boolean;
  p1Locked: boolean;
  p1Cursor: string;
  p2Here: boolean;
  p2Locked: boolean;
  p2Cursor: string;
  onCardClick: (index: number) => void;
}) {
  return (
    <div
      className={className}
      style={{
        animationDelay: `${Math.min(index * 25, 600)}ms`,
      }}
      onClick={() => onCardClick(index)}
      role="gridcell"
      tabIndex={-1}
    >
      <div className="cs__card-portrait">
        <div className="cs__card-fallback">
          {char.displayName.charAt(0).toUpperCase()}
        </div>
        {char.portrait && (
          <PortraitImg src={char.portrait} className="cs__card-img" />
        )}
        {p1Here && (
          <div
            className={`cs__card-cursor cs__cursor--p1${p1Locked ? ' cs__cursor--locked' : ''}`}
          >
            {p1Cursor}{p1Locked ? ' ✓' : ''}
          </div>
        )}
        {p2Here && (
          <div
            className={`cs__card-cursor cs__cursor--p2${p2Locked ? ' cs__cursor--locked' : ''}`}
          >
            {p2Cursor}{p2Locked ? ' ✓' : ''}
          </div>
        )}
        {(p1Locked || p2Locked) && (
          <span
            className={`cs__card-stamp cs__card-stamp--${p1Locked ? 'p1' : 'p2'}`}
            aria-hidden="true"
          >
            LOCKED
          </span>
        )}
        {/* Download/cached status overlays ON the portrait (was a dedicated
            strip under the info row — one wasted row per card, and progress
            cards grew 4px taller than the rest). */}
        {char.bundled ? (
          <div className="cs__card-download cs__card-download--ok">BUNDLED</div>
        ) : cached ? (
          <div className="cs__card-download cs__card-download--ok">✓ CACHED</div>
        ) : ds?.status === 'downloading' ? (
          <>
            <div className="cs__card-download cs__card-download--warn">
              {ds.progress}%
            </div>
            <div className="cs__card-progress" aria-hidden="true">
              <div
                className="cs__card-progress-fill"
                style={{ width: `${ds.progress}%` }}
              />
            </div>
          </>
        ) : ds?.status === 'error' ? (
          <div className="cs__card-download cs__card-download--err">
            ⚠ FAILED — TAP TO RETRY
          </div>
        ) : (
          <div className="cs__card-download cs__card-download--idle">
            {char.sizeMB.toFixed(1)} MB
          </div>
        )}
      </div>
      <div className="cs__card-info">{char.displayName}</div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// PlayerTag subcomponent
// ---------------------------------------------------------------------------

/** Portrait image with fade-in on load (CSS shows it once .loaded is set;
 *  the letter fallback underneath stays visible until then).
 *  ONE silent retry on error: burst-opening a roster tab fires dozens of
 *  /api/cdn requests at once, and while the edge cache is still cold a few
 *  could come back 429/503 (upstream throttling). A single delayed
 *  re-request heals those; remounting via key forces the re-fetch since an
 *  <img> with an unchanged src will not retry on its own. A genuinely
 *  missing portrait just keeps the letter tile. */
function PortraitImg({ src, className }: { src: string; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <img
      key={attempt}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className ?? ''}${loaded ? ' loaded' : ''}`}
      onLoad={() => setLoaded(true)}
      onError={() => {
        if (attempt < 1) {
          setTimeout(() => setAttempt(a => a + 1), 1500);
        }
      }}
    />
  );
}

function PlayerTag({
  side,
  label,
  name,
  locked,
  portrait,
}: {
  side: 'p1' | 'p2';
  label: string;
  name: string;
  locked: boolean;
  portrait?: string;
}) {
  const classes = [
    'cs__plate',
    `cs__plate--${side}`,
    locked ? 'cs__plate--locked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      <div className="cs__plate-art">
        <span className="cs__plate-letter" aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
        {portrait && <PortraitImg src={portrait} className="cs__plate-img" />}
        <span className="cs__plate-dots" aria-hidden="true" />
        {locked && (
          <span className="cs__plate-stamp">LOCKED ✓</span>
        )}
      </div>
      <div className="cs__plate-meta">
        <div className="cs__player-tag-label">{label}</div>
        <div className="cs__player-tag-name">{name}</div>
        <div className="cs__player-tag-status">
          {locked ? 'LOCKED IN' : 'SELECTING…'}
        </div>
      </div>
    </div>
  );
}
