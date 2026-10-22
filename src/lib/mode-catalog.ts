/**
 * Mode catalog — the single source of truth for the game modes and AI
 * difficulties offered by the local play flow.
 *
 * The UI flow mirrors a normal fighting game's screen chain:
 *   /lobby (title)
 *     → /mode-select  (pick the mode + AI difficulty — THIS catalog)
 *     → /local        (character select — mode arrives via ?mode=&diff=)
 *     → stage select  → /match-prep → /play
 *
 * MODES was previously inlined in components/CharacterSelect.tsx and
 * DIFFICULTY_TO_AI in app/local/page.tsx; both screens now read from here
 * so labels, descriptions and the AI-level mapping can never drift.
 */

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

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ModeDef {
  id: GameMode;
  label: string;
  description: string;
  /** Factual shape of the mode, printed as a chip on the mode card. */
  tag: string;
  /** Human label for the second fighter slot (kept for parity with the
   *  old select-screen copy; the character screen shows the same text). */
  p2Label: string;
  /** True when the mode generates its own opponent ladder (P2 is not picked). */
  progression: boolean;
}

export const MODES: ModeDef[] = [
  { id: 'vs-ai',       label: 'VS CPU',      description: 'Fight a single match against the CPU.',                    tag: 'SINGLE FIGHT',  p2Label: 'CPU',              progression: false },
  { id: 'vs-player',   label: 'VS PLAYER',   description: 'Fight a single match against another player.',             tag: 'LOCAL 2P',      p2Label: 'P2',               progression: false },
  { id: 'training',    label: 'TRAINING',    description: 'Practice with infinite time and no AI.',                   tag: 'FREE PRACTICE', p2Label: 'DUMMY',            progression: false },
  { id: 'arcade',      label: 'ARCADE',      description: 'Fight through a five-opponent ladder.',                    tag: '5 FIGHTS',      p2Label: 'RANDOM OPPONENTS', progression: true },
  { id: 'survival',    label: 'SURVIVAL',    description: 'Defeat as many opponents as possible. Endless.',           tag: 'ENDLESS',       p2Label: 'RANDOM OPPONENTS', progression: true },
  { id: 'time-attack', label: 'TIME ATTACK', description: 'Complete three fights as quickly as possible. 60s rounds.', tag: '3 FIGHTS · 60S', p2Label: 'RANDOM OPPONENTS', progression: true },
  { id: 'watch',       label: 'WATCH',       description: 'Watch two CPU-controlled fighters battle.',                tag: 'AI VS AI',      p2Label: 'CPU',              progression: true },
];

export const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Hard' },
];

// ---------------------------------------------------------------------------
// Difficulty → AI level mapping (engine p2ai values)
//   easy   = 1
//   normal = 5
//   hard   = 8
// ---------------------------------------------------------------------------

export const DIFFICULTY_TO_AI: Record<Difficulty, number> = {
  easy: 1,
  normal: 5,
  hard: 8,
};

/** Difficulty is offered for every mode where an AI stands on either side
 *  (everything except local-human VS PLAYER) — matches the old
 *  showDifficulty = p2IsAI || p1IsAI rule on the select screen. */
export function modeShowsDifficulty(mode: GameMode): boolean {
  return mode !== 'vs-player';
}

// ---------------------------------------------------------------------------
// Persistence — the last chosen mode/difficulty seeds the next visit
// (repeat sessions skip re-tapping VS CPU + Normal every time). Same
// localStorage keys the old select-screen toolbar used, so existing
// players keep their defaults.
// ---------------------------------------------------------------------------

const SELECT_MODE_KEY = 'fg-select-mode';
const SELECT_DIFF_KEY = 'fg-select-diff';

export function saveModeChoice(mode: GameMode, difficulty: Difficulty): void {
  try {
    localStorage.setItem(SELECT_MODE_KEY, mode);
    localStorage.setItem(SELECT_DIFF_KEY, difficulty);
  } catch {
    // storage unavailable (private mode) — the choice still applies in-session
  }
}

/** Last persisted choice, or nulls when nothing (valid) is stored. */
export function loadSavedModeChoice(): { mode: GameMode | null; difficulty: Difficulty | null } {
  try {
    const m = localStorage.getItem(SELECT_MODE_KEY);
    const d = localStorage.getItem(SELECT_DIFF_KEY);
    return {
      mode: m && MODES.some(x => x.id === m) ? (m as GameMode) : null,
      difficulty: d && DIFFICULTIES.some(x => x.id === d) ? (d as Difficulty) : null,
    };
  } catch {
    return { mode: null, difficulty: null };
  }
}
