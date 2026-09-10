/**
 * IKEMEN GO config.ini parser, serializer, and storage helpers.
 *
 * The engine reads save/config.ini at boot. vfs.js persists it to
 * localStorage under 'ikemen-vfs12:save/config.ini' so it survives reloads.
 *
 * This module lets the React settings UI read the current config, modify
 * values, and persist them back to localStorage — so the next engine boot
 * picks up the changes.
 *
 * Some settings (resolution, MSAA) require a page reload because the
 * engine's FBO is allocated once at boot. Others (sound volumes, key
 * bindings, gameplay options) can be applied at runtime via the engine's
 * Lua `modifyGameOption` binding, but that's only available while the
 * engine is running — for the settings page (which lives outside the
 * engine), we just persist and let the next boot pick them up.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single config.ini section, e.g. [Video]. Values are strings (raw). */
export type ConfigSection = Record<string, string>;

/** Parsed config.ini: section name → section. Preserves order. */
export interface ConfigData {
  sections: Map<string, ConfigSection>;
  /** Original section order (for deterministic serialization). */
  order: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an INI text into a ConfigData structure.
 *
 * - Lines starting with ';' or '#' are comments (preserved as `_comment_N`).
 * - Section headers [Section] start a new section.
 * - `key = value` lines (with optional whitespace around `=`).
 * - Values are kept as strings (the engine casts as needed).
 * - Empty lines are dropped.
 *
 * We preserve comments by storing them as pseudo-keys with a `_comment_`
 * prefix; on serialization, they're written back as comment lines in their
 * original position.
 */
export function parseConfigIni(text: string): ConfigData {
  const sections = new Map<string, ConfigSection>();
  const order: string[] = [];
  let currentSection = '';
  let commentIdx = 0;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    // Comment
    if (line.startsWith(';') || line.startsWith('#')) {
      // Attach to current section (or a __pre__ pseudo-section if before any)
      const target = currentSection || '__pre__';
      if (!sections.has(target)) {
        sections.set(target, {});
        order.push(target);
      }
      sections.get(target)![`_comment_${commentIdx++}`] = line;
      continue;
    }

    // Section header
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections.has(currentSection)) {
        sections.set(currentSection, {});
        order.push(currentSection);
      }
      continue;
    }

    // Key = Value
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;

    if (!sections.has(currentSection)) {
      sections.set(currentSection, {});
      order.push(currentSection);
    }
    sections.get(currentSection)![key] = value;
  }

  return { sections, order };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a ConfigData back to INI text.
 *
 * Comments (keys starting with `_comment_`) are written as their original
 * text (with the leading `;` or `#`). Other keys are written as `key = value`.
 * Sections are written in their original order (from `order`).
 */
export function serializeConfigIni(data: ConfigData): string {
  const lines: string[] = [];
  for (const sectionName of data.order) {
    const section = data.sections.get(sectionName);
    if (!section) continue;

    // Section header (skip for __pre__ pseudo-section)
    if (sectionName !== '__pre__') {
      lines.push(`[${sectionName}]`);
    }

    // Entries — preserve insertion order of the object
    for (const [key, value] of Object.entries(section)) {
      if (key.startsWith('_comment_')) {
        lines.push(value);
      } else {
        // Pad the key to align values (matches the shipped config.ini style).
        // Use a fixed 20-char width, but only for keys shorter than that.
        const paddedKey = key.padEnd(20, ' ');
        lines.push(`${paddedKey} = ${value}`);
      }
    }
    lines.push(''); // blank line between sections
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** localStorage key the engine's vfs.js uses for persisted save/config.ini. */
export const CONFIG_STORAGE_KEY = 'ikemen-vfs12:save/config.ini';

/** URL of the shipped config.ini (used to fetch defaults if nothing is persisted). */
export const SHIPPED_CONFIG_URL = '/game/ikemen-fs/file/save/config.ini';

/**
 * Load the current config from localStorage, falling back to the shipped
 * default if nothing is persisted.
 *
 * Returns null if neither is available (e.g., SSR / private mode).
 */
export async function loadConfig(): Promise<ConfigData | null> {
  // Try persisted first
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const text = atob(raw);
      return parseConfigIni(text);
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through to fetch
  }

  // Fall back to shipped default
  try {
    const res = await fetch(SHIPPED_CONFIG_URL, { cache: 'no-cache' });
    if (res.ok) {
      const text = await res.text();
      return parseConfigIni(text);
    }
  } catch {
    // Network error — give up
  }
  return null;
}

/**
 * Save a ConfigData to localStorage so the engine picks it up on next boot.
 *
 * The value is base64-encoded to match vfs.js's persistence format.
 */
export function saveConfig(data: ConfigData): void {
  const text = serializeConfigIni(data);
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, btoa(text));
  } catch {
    // Quota exceeded / private mode — settings just won't persist
  }
}

/**
 * Clear the persisted config so the engine reverts to shipped defaults on
 * next boot. Useful for a "Reset to defaults" button.
 */
export function clearPersistedConfig(): void {
  try {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/**
 * Get a config value as a string. Returns null if the section/key doesn't exist.
 */
export function getString(data: ConfigData, section: string, key: string): string | null {
  const s = data.sections.get(section);
  if (!s) return null;
  const v = s[key];
  return v === undefined ? null : v;
}

/**
 * Get a config value as an integer. Returns null if missing or not a number.
 */
export function getInt(data: ConfigData, section: string, key: string): number | null {
  const v = getString(data, section, key);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Get a config value as a float. Returns null if missing or not a number.
 */
export function getFloat(data: ConfigData, section: string, key: string): number | null {
  const v = getString(data, section, key);
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Set a config value. The value is converted to string. Creates the section
 * if it doesn't exist (appends to the order list).
 */
export function set(data: ConfigData, section: string, key: string, value: string | number | boolean): void {
  if (!data.sections.has(section)) {
    data.sections.set(section, {});
    data.order.push(section);
  }
  data.sections.get(section)![key] = String(value);
}

// ---------------------------------------------------------------------------
// Section schemas (for the UI)
// ---------------------------------------------------------------------------

/**
 * A setting definition — describes one configurable value for the UI.
 * The UI uses this to render the right control type and persist changes.
 */
export interface SettingDef {
  /** Section name (e.g., 'Video'). */
  section: string;
  /** Key name (e.g., 'GameWidth'). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Control type. */
  type: 'toggle' | 'slider' | 'select' | 'number' | 'text';
  /** For sliders: { min, max, step }. */
  min?: number;
  max?: number;
  step?: number;
  /** For selects: list of { value, label } options. */
  options?: { value: string; label: string }[];
  /** Whether changing this setting requires a page reload to take effect. */
  requiresReload?: boolean;
  /** Help text shown under the label. */
  hint?: string;
  /** Whether this setting is applicable to the web build (some aren't). */
  webApplicable?: boolean;
}

/**
 * Group of related settings, shown as a tab in the UI.
 */
export interface SettingGroup {
  id: string;
  label: string;
  settings: SettingDef[];
}

/**
 * The full settings schema — used by the UI to render all controls.
 *
 * Settings marked `requiresReload: true` need a page reload after change
 * (because the engine allocates FBOs, audio contexts, etc. once at boot).
 * Settings marked `webApplicable: false` are shown greyed out with a note
 * that they don't apply to the web build (RenderMode, WindowCentered, etc.).
 */
export const SETTINGS_SCHEMA: SettingGroup[] = [
  // --- Video -------------------------------------------------------------
  {
    id: 'video',
    label: 'VIDEO',
    settings: [
      {
        section: 'Video', key: 'GameWidth', label: 'Render Width',
        type: 'select',
        options: [
          { value: '320',  label: '320 · 480p Low (4:3)' },
          { value: '640',  label: '640 · 480p (4:3)' },
          { value: '1280', label: '1280 · 720p (16:9)' },
          { value: '1920', label: '1920 · 1080p (16:9)' },
        ],
        requiresReload: true,
        hint: 'Internal render resolution. Lower = faster. Higher = sharper.',
      },
      {
        section: 'Video', key: 'GameHeight', label: 'Render Height',
        type: 'select',
        options: [
          { value: '240',  label: '240 · Low' },
          { value: '480',  label: '480 · Standard' },
          { value: '720',  label: '720 · HD' },
          { value: '1080', label: '1080 · Full HD' },
        ],
        requiresReload: true,
        hint: 'Paired with Render Width. 320×240 = 4:3, 1280×720 = 16:9.',
      },
      {
        section: 'Video', key: 'Fullscreen', label: 'Fullscreen',
        type: 'toggle',
        hint: 'Browser fullscreen on the canvas element.',
      },
      {
        section: 'Video', key: 'KeepAspect', label: 'Keep Aspect Ratio',
        type: 'toggle',
        requiresReload: true,
        hint: 'When on, engine letterboxes the FBO to match the fight aspect ratio. Recommended ON.',
      },
      {
        section: 'Video', key: 'FightAspectWidth', label: 'Fight Aspect Width',
        type: 'select',
        options: [
          { value: '-1', label: 'Stage Default' },
          { value: '4',  label: '4 (4:3 aspect)' },
          { value: '16', label: '16 (16:9 aspect)' },
          { value: '16', label: '16 (16:10 aspect)' },
        ],
        requiresReload: true,
        hint: 'Aspect ratio used during fights. -1 = use stage localcoord.',
      },
      {
        section: 'Video', key: 'FightAspectHeight', label: 'Fight Aspect Height',
        type: 'select',
        options: [
          { value: '-1', label: 'Stage Default' },
          { value: '3',  label: '3 (4:3 aspect)' },
          { value: '9',  label: '9 (16:9 aspect)' },
          { value: '10', label: '10 (16:10 aspect)' },
        ],
        requiresReload: true,
        hint: 'Pairs with width. 4:3 = (4,3), 16:9 = (16,9).',
      },
      {
        section: 'Video', key: 'VSync', label: 'VSync',
        type: 'toggle',
        webApplicable: false,
        hint: 'Not applicable in browser (rAF is always synced to display).',
      },
      {
        section: 'Video', key: 'MSAA', label: 'MSAA (Anti-Aliasing)',
        type: 'select',
        options: [
          { value: '0', label: 'Off' },
          { value: '2', label: '2x' },
          { value: '4', label: '4x' },
          { value: '8', label: '8x' },
        ],
        requiresReload: true,
        hint: 'Smooths polygon edges. Cost: GPU time.',
      },
      {
        section: 'Video', key: 'Framerate', label: 'Framerate Cap',
        type: 'select',
        options: [
          { value: '60',  label: '60 FPS' },
          { value: '120', label: '120 FPS' },
          { value: '144', label: '144 FPS' },
          { value: '240', label: '240 FPS (uncapped)' },
        ],
        hint: 'Engine frame cap. Higher = smoother but heavier. 60 is standard for fighting games.',
      },
      {
        section: 'Video', key: 'RGBSpriteBilinearFilter', label: 'Sprite Bilinear Filter',
        type: 'toggle',
        hint: 'Smooths scaled sprites. Off = pixel-perfect (retro look).',
      },
      {
        section: 'Video', key: 'ZoomActive', label: 'Stage Zoom',
        type: 'toggle',
        hint: 'Camera zoom on stage-specific zoom points (Ikemen feature).',
      },
      {
        section: 'Config', key: 'EscOpensMenu', label: 'ESC Opens Pause Menu',
        type: 'toggle',
        hint: 'In-engine pause menu. On web, ESC also triggers page-level shortcuts.',
      },
    ],
  },

  // --- Audio -------------------------------------------------------------
  {
    id: 'audio',
    label: 'AUDIO',
    settings: [
      {
        section: 'Sound', key: 'MasterVolume', label: 'Master Volume',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'Overall volume. 100 = no attenuation.',
      },
      {
        section: 'Sound', key: 'WavVolume', label: 'Sound Effects Volume',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'Hits, voices, menu sounds.',
      },
      {
        section: 'Sound', key: 'BGMVolume', label: 'Music Volume',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'Stage and menu background music.',
      },
      {
        section: 'Sound', key: 'MaxBGMVolume', label: 'Max Music Volume',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'Cap for music volume (some tracks are mastered loud).',
      },
      {
        section: 'Sound', key: 'PauseMasterVolume', label: 'Pause Master Volume',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'Master volume while paused (ducking).',
      },
      {
        section: 'Sound', key: 'AudioDucking', label: 'Audio Ducking',
        type: 'toggle',
        hint: 'Lower audio when game is paused or in menus.',
      },
      {
        section: 'Sound', key: 'StereoEffects', label: 'Stereo Effects',
        type: 'toggle',
        hint: 'Pan sound effects based on character position.',
      },
      {
        section: 'Sound', key: 'PanningRange', label: 'Panning Range',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'How far sounds pan left/right as characters move.',
      },
      {
        section: 'Sound', key: 'WavChannels', label: 'WAV Channels',
        type: 'select',
        options: [
          { value: '8',  label: '8' },
          { value: '16', label: '16' },
          { value: '32', label: '32' },
          { value: '64', label: '64' },
        ],
        requiresReload: true,
        hint: 'Concurrent sound effect voices. More = denser audio.',
      },
      {
        section: 'Sound', key: 'AudioResampleQuality', label: 'Audio Resample Quality',
        type: 'select',
        options: [
          { value: '0', label: 'Fast' },
          { value: '1', label: 'Medium' },
          { value: '2', label: 'High' },
        ],
        requiresReload: true,
        hint: 'Sample-rate conversion quality. Higher = better pitch at low cost.',
      },
    ],
  },

  // --- Gameplay ----------------------------------------------------------
  {
    id: 'gameplay',
    label: 'GAMEPLAY',
    settings: [
      {
        section: 'Options', key: 'Difficulty', label: 'AI Difficulty',
        type: 'slider', min: 1, max: 8, step: 1,
        hint: '1 = Easy, 8 = Hardest. Default 5.',
      },
      {
        section: 'Options', key: 'Life', label: 'Life',
        type: 'slider', min: 1, max: 300, step: 1,
        hint: 'Starting HP. 100 = standard.',
      },
      {
        section: 'Options', key: 'Time', label: 'Round Time (seconds)',
        type: 'slider', min: -1, max: 999, step: 1,
        hint: '-1 = no time limit. 99 = standard.',
      },
      {
        section: 'Options', key: 'GameSpeed', label: 'Game Speed',
        type: 'slider', min: -9, max: 9, step: 1,
        hint: '0 = normal. Negative = slower, positive = faster.',
      },
      {
        section: 'Options', key: 'Match.Wins', label: 'Rounds to Win',
        type: 'select',
        options: [
          { value: '1', label: '1 (single round)' },
          { value: '2', label: '2 (best of 3)' },
          { value: '3', label: '3 (best of 5)' },
          { value: '4', label: '4 (best of 7)' },
        ],
        hint: 'Rounds needed to win a match.',
      },
      {
        section: 'Options', key: 'Match.MaxDrawGames', label: 'Max Draw Games',
        type: 'slider', min: 0, max: 6, step: 1,
        hint: 'Max simultaneous-draw rounds before match ends in a draw.',
      },
      {
        section: 'Options', key: 'Credits', label: 'Continue Credits',
        type: 'slider', min: 0, max: 99, step: 1,
        hint: 'Continues in arcade mode. 0 = no continues.',
      },
      {
        section: 'Options', key: 'QuickContinue', label: 'Quick Continue',
        type: 'toggle',
        hint: 'Skip "Continue?" prompt and auto-continue.',
      },
      {
        section: 'Options', key: 'AutoGuard', label: 'Auto Guard',
        type: 'toggle',
        hint: 'Hold back to block instead of needing a dedicated guard button.',
      },
      {
        section: 'Options', key: 'GuardBreak', label: 'Guard Break',
        type: 'toggle',
        hint: 'Block too long and your guard shatters, leaving you stunned.',
      },
      {
        section: 'Options', key: 'Dizzy', label: 'Dizzy',
        type: 'toggle',
        hint: 'Take enough hits and you get dizzy (stunned) temporarily.',
      },
      {
        section: 'Options', key: 'RedLife', label: 'Red Life',
        type: 'toggle',
        hint: 'Show recoverable life as a red portion of the bar.',
      },
    ],
  },

  // --- Team Modes --------------------------------------------------------
  {
    id: 'team',
    label: 'TEAM',
    settings: [
      {
        section: 'Options', key: 'Team.Duplicates', label: 'Team Duplicates',
        type: 'toggle',
        hint: 'Allow same character multiple times in team modes.',
      },
      {
        section: 'Options', key: 'Team.LifeShare', label: 'Team Life Share',
        type: 'toggle',
        hint: 'All team members share one life bar.',
      },
      {
        section: 'Options', key: 'Team.PowerShare', label: 'Team Power Share',
        type: 'toggle',
        hint: 'All team members share one power bar.',
      },
      {
        section: 'Options', key: 'Team.SingleVsTeamLife', label: 'Single vs Team Life',
        type: 'slider', min: 100, max: 500, step: 10,
        hint: 'Life multiplier for a single character vs a team. 300 = standard.',
      },
      {
        section: 'Options', key: 'Simul.Min', label: 'Simul Min Players',
        type: 'slider', min: 2, max: 4, step: 1,
        hint: 'Min players per side in Simul mode.',
      },
      {
        section: 'Options', key: 'Simul.Max', label: 'Simul Max Players',
        type: 'slider', min: 2, max: 4, step: 1,
        hint: 'Max players per side in Simul mode.',
      },
      {
        section: 'Options', key: 'Simul.Match.Wins', label: 'Simul Rounds to Win',
        type: 'slider', min: 1, max: 4, step: 1,
      },
      {
        section: 'Options', key: 'Simul.LoseOnKO', label: 'Simul Lose on KO',
        type: 'toggle',
        hint: 'If any team member is KO\'d, the whole team loses.',
      },
      {
        section: 'Options', key: 'Tag.Min', label: 'Tag Min Players',
        type: 'slider', min: 2, max: 4, step: 1,
      },
      {
        section: 'Options', key: 'Tag.Max', label: 'Tag Max Players',
        type: 'slider', min: 2, max: 4, step: 1,
      },
      {
        section: 'Options', key: 'Tag.Match.Wins', label: 'Tag Rounds to Win',
        type: 'slider', min: 1, max: 4, step: 1,
      },
      {
        section: 'Options', key: 'Tag.LoseOnKO', label: 'Tag Lose on KO',
        type: 'toggle',
      },
      {
        section: 'Options', key: 'Turns.Min', label: 'Turns Min Players',
        type: 'slider', min: 2, max: 4, step: 1,
      },
      {
        section: 'Options', key: 'Turns.Max', label: 'Turns Max Players',
        type: 'slider', min: 2, max: 4, step: 1,
      },
      {
        section: 'Options', key: 'Turns.Recovery.Base', label: 'Turns Recovery Base',
        type: 'slider', min: 0, max: 100, step: 1,
        hint: 'HP recovered between turns.',
      },
      {
        section: 'Options', key: 'Turns.Recovery.Bonus', label: 'Turns Recovery Bonus',
        type: 'slider', min: 0, max: 100, step: 0.5,
        hint: 'Additional recovery per remaining team member.',
      },
    ],
  },

  // --- Input -------------------------------------------------------------
  {
    id: 'input',
    label: 'INPUT',
    settings: [
      {
        section: 'Input', key: 'ButtonAssist', label: 'Button Assist',
        type: 'toggle',
        hint: 'Show input buffer indicators (helps with timing).',
      },
      {
        section: 'Input', key: 'SOCDResolution', label: 'SOCD Resolution',
        type: 'select',
        options: [
          { value: '1', label: 'Neutral (L+R = no input)' },
          { value: '2', label: 'Last Input Wins' },
          { value: '3', label: 'First Input Wins' },
          { value: '4', label: 'Absolute Priority (L+R = Left)' },
        ],
        hint: 'How to resolve Simultaneous Opposing Cardinal Directions (left+right, up+down).',
      },
      {
        section: 'Input', key: 'ControllerStickSensitivity', label: 'Stick Sensitivity',
        type: 'slider', min: 0, max: 1, step: 0.05,
        hint: 'Dead zone for analog sticks on gamepads.',
      },
      {
        section: 'Input', key: 'XinputTriggerSensitivity', label: 'Trigger Sensitivity',
        type: 'slider', min: 0, max: 1, step: 0.05,
        hint: 'Dead zone for XInput triggers (LT/RT).',
      },
      {
        section: 'Input', key: 'UiRepeatDelay', label: 'UI Repeat Delay',
        type: 'slider', min: 0, max: 60, step: 1,
        hint: 'Frames before held key starts repeating in menus.',
      },
      {
        section: 'Input', key: 'UiRepeatRate', label: 'UI Repeat Rate',
        type: 'slider', min: 1, max: 30, step: 1,
        hint: 'Frames between repeats after the delay.',
      },
      {
        section: 'Input', key: 'PauseExitDelay', label: 'Pause-Exit Delay',
        type: 'slider', min: 0, max: 60, step: 1,
        hint: 'Frames to hold pause before exiting the pause menu.',
      },
    ],
  },

  // --- Arcade (AI) -------------------------------------------------------
  {
    id: 'arcade',
    label: 'ARCADE',
    settings: [
      {
        section: 'Arcade', key: 'AI.RandomColor', label: 'AI Random Color',
        type: 'toggle',
        hint: 'AI uses a random palette per fight.',
      },
      {
        section: 'Arcade', key: 'AI.SurvivalColor', label: 'Survival Random Color',
        type: 'toggle',
        hint: 'AI uses random palettes in survival mode.',
      },
      {
        section: 'Arcade', key: 'AI.Ramping', label: 'AI Ramping',
        type: 'toggle',
        hint: 'AI difficulty increases as you progress through arcade mode.',
      },
    ],
  },

  // --- Netplay -----------------------------------------------------------
  {
    id: 'netplay',
    label: 'NETPLAY',
    settings: [
      {
        section: 'Netplay', key: 'ListenPort', label: 'Listen Port',
        type: 'number',
        hint: 'Port for P2P netplay signaling. Default 7500.',
      },
      {
        section: 'Netplay', key: 'RollbackNetcode', label: 'Rollback Netcode',
        type: 'toggle',
        requiresReload: true,
        hint: 'Use rollback (GGPO-style) netcode instead of delay-based. Experimental.',
      },
      {
        section: 'Netplay', key: 'Rollback.FrameDelay', label: 'Rollback Frame Delay',
        type: 'slider', min: 0, max: 10, step: 1,
        hint: 'Input delay frames for rollback. Higher = stable, less responsive.',
      },
      {
        section: 'Netplay', key: 'Rollback.DisconnectNotifyStart', label: 'Disconnect Notify (ms)',
        type: 'number',
        hint: 'When to start showing "opponent may have disconnected" warning.',
      },
      {
        section: 'Netplay', key: 'Rollback.DisconnectTimeout', label: 'Disconnect Timeout (ms)',
        type: 'number',
        hint: 'When to drop a stalled connection.',
      },
      {
        section: 'Netplay', key: 'Rollback.LogsEnabled', label: 'Rollback Logs',
        type: 'toggle',
        hint: 'Write rollback debug logs to save/logs/.',
      },
      {
        section: 'Netplay', key: 'Rollback.SaveStageData', label: 'Save Stage Data',
        type: 'toggle',
        hint: 'Include stage state in rollback snapshots (slower, more correct).',
      },
      {
        section: 'Netplay', key: 'Rollback.DesyncTest', label: 'Desync Test Mode',
        type: 'toggle',
        hint: 'Insert artificial desyncs for testing. Not for normal play.',
      },
      {
        section: 'Netplay', key: 'Rollback.DesyncTestFrames', label: 'Desync Test Frames',
        type: 'slider', min: 0, max: 600, step: 1,
      },
      {
        section: 'Netplay', key: 'Rollback.DesyncTestAI', label: 'Desync Test AI Count',
        type: 'slider', min: 0, max: 8, step: 1,
      },
    ],
  },

  // --- Debug -------------------------------------------------------------
  {
    id: 'debug',
    label: 'DEBUG',
    settings: [
      {
        section: 'Debug', key: 'AllowDebugMode', label: 'Allow Debug Mode',
        type: 'toggle',
        hint: 'Toggle debug overlay with Ctrl+D in-game.',
      },
      {
        section: 'Debug', key: 'AllowDebugKeys', label: 'Allow Debug Keys',
        type: 'toggle',
        hint: 'F1-F12 debug shortcuts (slowdown, frame step, etc.).',
      },
      {
        section: 'Debug', key: 'ClipboardRows', label: 'Clipboard Rows',
        type: 'slider', min: 0, max: 10, step: 1,
        hint: 'Rows of debug clipboard displayed in overlay.',
      },
      {
        section: 'Debug', key: 'ConsoleRows', label: 'Console Rows',
        type: 'slider', min: 0, max: 30, step: 1,
        hint: 'Rows of debug console (toggle with tilde).',
      },
      {
        section: 'Debug', key: 'ClsnDarken', label: 'Clsn Darken',
        type: 'toggle',
        hint: 'Darken sprite when showing collision boxes (Ctrl+C).',
      },
      {
        section: 'Debug', key: 'DumpLuaTables', label: 'Dump Lua Tables',
        type: 'toggle',
        hint: 'Debug only — dumps Lua tables to console.',
      },
      {
        section: 'Debug', key: 'ForceStageZoomout', label: 'Force Stage Zoom Out',
        type: 'toggle',
        hint: 'Force camera zoomed out for debugging.',
      },
      {
        section: 'Debug', key: 'ForceStageZoomin', label: 'Force Stage Zoom In',
        type: 'toggle',
      },
      {
        section: 'Debug', key: 'ForceStageAutoZoom', label: 'Force Stage Auto Zoom',
        type: 'toggle',
      },
      {
        section: 'Debug', key: 'SpeedTest', label: 'Speed Test',
        type: 'slider', min: 1, max: 1000, step: 1,
        hint: 'Run the game N times faster for testing.',
      },
    ],
  },
];
