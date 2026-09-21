/**
 * Game mode state machine for Arcade, Survival, Time Attack, and Watch modes.
 *
 * These modes require progression across multiple fights. The engine itself
 * only runs ONE fight per boot (then os.exit()). So the React layer handles
 * progression: after each fight, we read the result, decide the next opponent,
 * and navigate back to /play.
 *
 * State is stored in sessionStorage (survives page reloads within a tab,
 * cleared when tab closes — perfect for a play session).
 *
 * Flow:
 *   /local (select mode + character)
 *     ↓
 *   /play (fight 1)
 *     ↓ engine exits, __ikemenMatchResult set
 *   /play reads result → redirects to /progress
 *     ↓
 *   /progress (shows "Fight 2 of 5" or "Survival: 3 wins")
 *     ↓ auto-navigates after 3s
 *   /play (fight 2)
 *     ↓
 *   ... loop until done ...
 *     ↓
 *   /results (victory or defeat screen)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressionMode = 'arcade' | 'survival' | 'time-attack' | 'watch';

export interface ModeState {
  /** Which progression mode. */
  mode: ProgressionMode;
  /** The player's chosen character ID. */
  playerChar: string;
  /** Fight number (1-indexed). */
  fightNumber: number;
  /** Total fights planned (arcade/time-attack have a fixed count; survival is endless). */
  totalFights: number;
  /** Wins so far. */
  wins: number;
  /** Losses so far. */
  losses: number;
  /** Total elapsed time in seconds (for time-attack). */
  totalTime: number;
  /** List of opponent character IDs for the ladder (pre-generated). */
  opponents: string[];
  /** AI difficulty for opponents. */
  difficulty: number;
  /** Timestamp when the current fight started (ms). */
  fightStartTime: number;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ikemen-game-mode-state';

function loadState(): ModeState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ModeState;
  } catch {
    return null;
  }
}

function saveState(state: ModeState | null): void {
  try {
    if (state) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // sessionStorage unavailable — progression won't work
  }
}

export function clearModeState(): void {
  saveState(null);
}

export function getCurrentModeState(): ModeState | null {
  return loadState();
}

// ---------------------------------------------------------------------------
// Mode configuration
// ---------------------------------------------------------------------------

const ARCADE_FIGHTS = 5;
const TIME_ATTACK_FIGHTS = 3;

/**
 * Start a new progression mode session.
 * Called from /local when the user selects Arcade/Survival/Time Attack/Watch
 * and locks in their character.
 *
 * Generates the opponent ladder (random characters from the roster).
 */
export function startMode(
  mode: ProgressionMode,
  playerChar: string,
  rosterCharIds: string[],
  difficulty: number = 5,
): ModeState {
  // Filter out the player's character from possible opponents
  const possibleOpponents = rosterCharIds.filter(id => id !== playerChar);
  // Shuffle for random order
  const shuffled = [...possibleOpponents].sort(() => Math.random() - 0.5);

  let totalFights: number;
  let opponents: string[];

  switch (mode) {
    case 'arcade':
      totalFights = ARCADE_FIGHTS;
      opponents = shuffled.slice(0, totalFights);
      break;
    case 'time-attack':
      totalFights = TIME_ATTACK_FIGHTS;
      opponents = shuffled.slice(0, totalFights);
      break;
    case 'survival':
      // Endless — generate a pool of opponents that cycles
      totalFights = 999;
      opponents = shuffled; // will cycle/repeat
      break;
    case 'watch':
      // Single fight, AI vs AI
      totalFights = 1;
      opponents = shuffled.slice(0, 1);
      break;
  }

  // Ensure we have at least 1 opponent (fallback to kfm if roster is empty)
  if (opponents.length === 0) {
    opponents = ['kfm'];
  }

  const state: ModeState = {
    mode,
    playerChar,
    fightNumber: 1,
    totalFights,
    wins: 0,
    losses: 0,
    totalTime: 0,
    opponents,
    difficulty,
    fightStartTime: Date.now(),
  };
  saveState(state);
  return state;
}

/**
 * Get the opponent for the current fight.
 */
export function getCurrentOpponent(state: ModeState): string {
  const idx = (state.fightNumber - 1) % state.opponents.length;
  return state.opponents[idx];
}

/**
 * Get the AI difficulty for the current fight.
 * Arcade mode ramps up difficulty; others are fixed.
 */
export function getCurrentDifficulty(state: ModeState): number {
  if (state.mode === 'arcade') {
    // Ramp from base difficulty to base+3 over the ladder
    const progress = (state.fightNumber - 1) / Math.max(1, state.totalFights - 1);
    return Math.min(8, Math.round(state.difficulty + progress * 3));
  }
  return state.difficulty;
}

// ---------------------------------------------------------------------------
// Result processing
// ---------------------------------------------------------------------------

export interface FightResult {
  /** 1 = P1 won, 2 = P2 won, 0 = draw, -1 = unavailable. */
  winner: number;
  /** The mode that was active. */
  mode: string;
  /** P1 character ID. */
  p1: string;
  /** P2 character ID. */
  p2: string;
}

/**
 * Read the match result from the JS global that main.lua sets before os.exit().
 * Returns null if the global isn't set (e.g., engine crashed before writing it).
 */
export function readFightResult(): FightResult | null {
  try {
    const g = globalThis as any;
    const result = g.__ikemenMatchResult;
    if (!result) return null;
    return {
      winner: result.winner ?? -1,
      mode: result.mode ?? 'quickvs',
      p1: result.p1 ?? 'kfm',
      p2: result.p2 ?? 'kfm',
    };
  } catch {
    return null;
  }
}

/**
 * Clear the match result global so it doesn't leak into the next fight.
 */
export function clearFightResult(): void {
  try {
    delete (globalThis as any).__ikemenMatchResult;
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Progression logic
// ---------------------------------------------------------------------------

export type NextAction =
  | { type: 'next-fight'; opponent: string; difficulty: number }
  | { type: 'finished'; result: 'victory' | 'defeat'; wins: number; losses: number; totalTime: number }
  | { type: 'retry' }
  | { type: 'exit' };

/**
 * Process the fight result and determine what to do next.
 *
 * Called from /play after the engine exits. Reads the result, updates the
 * mode state, and returns the next action:
 *  - next-fight: navigate to /play with the next opponent
 *  - finished: navigate to /results (victory or defeat)
 *  - retry: stay on /play (re-fight the same opponent, e.g., after a draw)
 *  - exit: go back to /local (no mode state)
 */
export function processFightResult(result: FightResult): NextAction {
  const state = loadState();
  if (!state) {
    // No mode state — single fight (vs-ai, vs-player, training). Go back to select.
    return { type: 'exit' };
  }

  // Calculate fight duration (for time-attack)
  const fightDuration = (Date.now() - state.fightStartTime) / 1000;
  state.totalTime += fightDuration;

  // Update wins/losses
  if (result.winner === 1) {
    state.wins++;
  } else if (result.winner === 2) {
    state.losses++;
  }
  // Draw (winner === 0): don't count as win or loss — retry

  // Survival: any loss ends the run
  if (state.mode === 'survival') {
    if (result.winner === 2) {
      saveState(state);
      return { type: 'finished', result: 'defeat', wins: state.wins, losses: state.losses, totalTime: state.totalTime };
    }
    // Won (or draw) — advance to next opponent
    state.fightNumber++;
    saveState(state);
    return {
      type: 'next-fight',
      opponent: getCurrentOpponent(state),
      difficulty: getCurrentDifficulty(state),
    };
  }

  // Arcade / Time Attack: fixed number of fights
  // A loss doesn't end the run immediately (player can continue), but
  // we track wins/losses for the results screen. Actually, for a proper
  // arcade feel, a loss SHOULD end the run (game over → continue?).
  // Let's go with: loss = game over (arcade-style).
  if (result.winner === 2) {
    saveState(state);
    return { type: 'finished', result: 'defeat', wins: state.wins, losses: state.losses, totalTime: state.totalTime };
  }

  // Draw — retry the same fight
  if (result.winner === 0) {
    saveState(state);
    return { type: 'retry' };
  }

  // Won — advance to next fight
  state.fightNumber++;
  if (state.fightNumber > state.totalFights) {
    // Completed all fights — victory!
    saveState(state);
    return { type: 'finished', result: 'victory', wins: state.wins, losses: state.losses, totalTime: state.totalTime };
  }

  saveState(state);
  return {
    type: 'next-fight',
    opponent: getCurrentOpponent(state),
    difficulty: getCurrentDifficulty(state),
  };
}

/**
 * Build the URL params for the next fight in a progression mode.
 * Called from /progress page.
 */
export function buildNextFightUrl(state: ModeState, stageId: string): string {
  const opponent = getCurrentOpponent(state);
  const difficulty = getCurrentDifficulty(state);

  const params = new URLSearchParams();
  params.set('p1', state.playerChar);
  params.set('p2', opponent);
  params.set('stage', stageId);
  params.set('p2ai', String(difficulty));
  params.set('qmode', state.mode);

  // Time attack: set round time to 60
  if (state.mode === 'time-attack') {
    params.set('time', '60');
  }

  // Watch mode: both AI
  if (state.mode === 'watch') {
    params.set('p1ai', '8');
    params.set('p2ai', '8');
  }

  return `/play?${params.toString()}`;
}
