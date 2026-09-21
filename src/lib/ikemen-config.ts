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
 * Set a single config value in the persisted localStorage config.
 *
 * This is a convenience helper that loads the current config (from
 * localStorage or shipped default), modifies one key, and saves it
 * back. Used by the /local RES toggle to write GameWidth/GameHeight
 * to the same authoritative config that the Settings UI writes to.
 *
 * If the config can't be loaded (network error + no localStorage),
 * this is a no-op.
 */
export async function setConfigValue(
  section: string,
  key: string,
  value: string | number | boolean,
): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) return;
  set(cfg, section, key, value);
  saveConfig(cfg);
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
  type: 'toggle' | 'slider' | 'select' | 'number' | 'text' | 'keybind';
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
  /** For keybind: which player this binding is for (1 or 2). Used for conflict checking. */
  player?: 1 | 2;
  /** For keybind: which action this binding is for (Up/Down/Left/Right/A/B/C/X/Y/Z/Start). */
  action?: string;
}

/**
 * Group of related settings, shown as a tab in the UI.
 */
export interface SettingGroup {
  id: string;
  label: string;
  /** Category for visual grouping in the tab bar (Section 26, 53-54). */
  category: 'basic' | 'controls' | 'advanced' | 'debug';
  settings: SettingDef[];
}

// ---------------------------------------------------------------------------
// Keyboard remapping support
// ---------------------------------------------------------------------------
//
// The IKEMEN GO engine stores key bindings in config.ini [Keys_P1] and
// [Keys_P2] sections. Each value is a string from KeyToStringLUT
// (e.g., 'w' for the W key, '8' for the digit 8, 'UP' for Arrow Up,
// 'COMMA' for the comma key).
//
// The browser fires KeyboardEvents with `code` property (e.g., 'KeyW',
// 'Digit8', 'ArrowUp', 'Comma'). To bind a key via the UI, we capture
// the next keydown event and convert event.code → the engine's INI
// string format.
//
// The maps below are derived from input_js.go's jsCodeToKey and
// KeyToStringLUT (cross-referenced with the actual engine source at
// /tmp/ikemen-go-web/src/input_js.go).

/**
 * Map: KeyboardEvent.code → engine INI string (the format used in config.ini).
 *
 * Example: 'KeyW' → 'w' (so when user presses W, we save 'w' to config,
 *          and the engine's StringToKeyLUT['w'] = keyW matches the key).
 *
 * Keys not in this map are not bindable via the UI (modifier keys like
 * Shift/Ctrl/Alt, F-keys beyond F12, etc.).
 */
export const CODE_TO_INI_KEY: Record<string, string> = {
  // Letters (KeyA → 'a', ..., KeyZ → 'z')
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f',
  KeyG: 'g', KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
  KeyM: 'm', KeyN: 'n', KeyO: 'o', KeyP: 'p', KeyQ: 'q', KeyR: 'r',
  KeyS: 's', KeyT: 't', KeyU: 'u', KeyV: 'v', KeyW: 'w', KeyX: 'x',
  KeyY: 'y', KeyZ: 'z',
  // Digits (Digit0 → '0', ..., Digit9 → '9')
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  // Arrows (ArrowUp → 'UP', etc.)
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  // Punctuation (uses the engine's uppercase names)
  Comma: 'COMMA', Period: 'PERIOD', Slash: 'SLASH', Semicolon: 'SEMICOLON',
  Equal: 'EQUALS', Minus: 'MINUS', BracketLeft: 'LBRACKET',
  BracketRight: 'RBRACKET', Backslash: 'BACKSLASH', Backquote: 'BACKQUOTE',
  Quote: 'QUOTE',
  // Special keys
  Enter: 'RETURN', Escape: 'ESCAPE', Backspace: 'BACKSPACE',
  Tab: 'TAB', Space: 'SPACE',
  // Numpad
  Numpad0: 'KP_0', Numpad1: 'KP_1', Numpad2: 'KP_2', Numpad3: 'KP_3',
  Numpad4: 'KP_4', Numpad5: 'KP_5', Numpad6: 'KP_6', Numpad7: 'KP_7',
  Numpad8: 'KP_8', Numpad9: 'KP_9',
  NumpadDivide: 'KP_DIVIDE', NumpadMultiply: 'KP_MULTIPLY',
  NumpadSubtract: 'KP_MINUS', NumpadAdd: 'KP_PLUS',
  NumpadEnter: 'KP_ENTER', NumpadDecimal: 'KP_PERIOD',
  NumpadEqual: 'KP_EQUALS',
  // Function keys (F1-F12 — same name in both formats)
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  // Misc
  PrintScreen: 'PRINTSCREEN', ScrollLock: 'SCROLLLOCK', Pause: 'PAUSE',
  Insert: 'INSERT', Home: 'HOME', PageUp: 'PAGEUP',
  Delete: 'DELETE', End: 'END', PageDown: 'PAGEDOWN',
};

/**
 * Map: engine INI string → friendly display label for the UI.
 *
 * Example: 'w' → 'W' (display the uppercase letter),
 *          'UP' → '↑' (Unicode arrow),
 *          'COMMA' → ',' (the actual character),
 *          'RETURN' → 'Enter' (friendly name).
 *
 * Falls back to the raw string if no entry exists.
 */
export const INI_KEY_TO_LABEL: Record<string, string> = {
  // Letters
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', h: 'H',
  i: 'I', j: 'J', k: 'K', l: 'L', m: 'M', n: 'N', o: 'O', p: 'P',
  q: 'Q', r: 'R', s: 'S', t: 'T', u: 'U', v: 'V', w: 'W', x: 'X',
  y: 'Y', z: 'Z',
  // Digits
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
  '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  // Arrows
  UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→',
  // Punctuation — show the actual character
  COMMA: ',', PERIOD: '.', SLASH: '/', SEMICOLON: ';', EQUALS: '=',
  MINUS: '-', LBRACKET: '[', RBRACKET: ']', BACKSLASH: '\\',
  BACKQUOTE: '`', QUOTE: "'",
  // Special
  RETURN: 'Enter', ESCAPE: 'Esc', BACKSPACE: '⌫', TAB: 'Tab', SPACE: 'Space',
  // Numpad
  KP_0: 'Num 0', KP_1: 'Num 1', KP_2: 'Num 2', KP_3: 'Num 3',
  KP_4: 'Num 4', KP_5: 'Num 5', KP_6: 'Num 6', KP_7: 'Num 7',
  KP_8: 'Num 8', KP_9: 'Num 9',
  KP_DIVIDE: 'Num /', KP_MULTIPLY: 'Num *', KP_MINUS: 'Num -',
  KP_PLUS: 'Num +', KP_ENTER: 'Num Enter', KP_PERIOD: 'Num .',
  KP_EQUALS: 'Num =',
  // Function keys
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  // Misc
  PRINTSCREEN: 'PrtSc', SCROLLLOCK: 'ScrLk', PAUSE: 'Pause',
  INSERT: 'Insert', HOME: 'Home', PAGEUP: 'PgUp',
  DELETE: 'Delete', END: 'End', PAGEDOWN: 'PgDn',
};

/**
 * Get a friendly display label for an engine INI key string.
 * Falls back to the raw string if no mapping exists.
 */
export function iniKeyToLabel(iniKey: string): string {
  return INI_KEY_TO_LABEL[iniKey] ?? iniKey;
}

/**
 * Convert a KeyboardEvent.code to the engine's INI string format.
 * Returns null if the code is not bindable (e.g., modifier keys).
 */
export function codeToIniKey(code: string): string | null {
  return CODE_TO_INI_KEY[code] ?? null;
}

/**
 * Check if a key binding value is valid (i.e., the engine will recognize it).
 * Used to detect stale/broken bindings in config.ini (e.g., 'Y = ,' which
 * is the literal comma character that the engine doesn't recognize).
 */
export function isValidIniKey(iniKey: string): boolean {
  return iniKey in INI_KEY_TO_LABEL;
}

/**
 * Reverse map: engine INI string → KeyboardEvent.code.
 * Built from CODE_TO_INI_KEY by inverting it.
 *
 * Example: 'w' → 'KeyW', '8' → 'Digit8', 'UP' → 'ArrowUp'.
 *
 * Used by TouchControls to look up which KeyboardEvent.code to dispatch
 * for a given configured key binding.
 */
export const INI_KEY_TO_CODE: Record<string, string> = (() => {
  const result: Record<string, string> = {};
  for (const [code, iniKey] of Object.entries(CODE_TO_INI_KEY)) {
    result[iniKey] = code;
  }
  return result;
})();

/**
 * Load P1 key bindings from the persisted config.
 *
 * Returns a map: action name ('Up', 'Down', 'Left', 'Right', 'A', 'B',
 * 'C', 'X', 'Y', 'Z', 'Start') → KeyboardEvent.code (e.g., 'KeyW').
 *
 * If a binding is missing or invalid (stale), falls back to the default
 * P1 layout (WASD + 8/9/0 for punches + I/O/P for kicks + U for Start).
 *
 * This is the single source of truth that both the physical keyboard
 * (via the engine's own document.addEventListener) and TouchControls
 * consume. No separate hardcoded KEY_MAP anywhere.
 */
export async function loadP1KeyBindings(): Promise<Record<string, string>> {
  const DEFAULTS: Record<string, string> = {
    Up: 'KeyW', Down: 'KeyS', Left: 'KeyA', Right: 'KeyD',
    A: 'Digit8', B: 'Digit9', C: 'Digit0',
    X: 'KeyI', Y: 'KeyO', Z: 'KeyP',
    Start: 'KeyU',
  };

  const cfg = await loadConfig();
  if (!cfg) return DEFAULTS;

  const section = cfg.sections.get('Keys_P1');
  if (!section) return DEFAULTS;

  const result: Record<string, string> = {};
  for (const action of Object.keys(DEFAULTS)) {
    const iniKey = section[action];
    if (iniKey && isValidIniKey(iniKey)) {
      const code = INI_KEY_TO_CODE[iniKey];
      if (code) {
        result[action] = code;
      } else {
        // Valid INI key but no code mapping — shouldn't happen, but
        // fall back to default for safety.
        result[action] = DEFAULTS[action];
      }
    } else {
      // Missing or stale binding — use default.
      result[action] = DEFAULTS[action];
    }
  }
  return result;
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'advanced',
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
    category: 'controls',
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
    category: 'advanced',
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
    category: 'advanced',
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
    category: 'debug',
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

  // --- Keys (keyboard remapping) -----------------------------------------
  //
  // Each entry maps one IKEMEN action (Up/Down/Left/Right/A/B/C/X/Y/Z/Start)
  // for one player (1 or 2) to a KeyboardEvent.code. The UI captures the
  // next keydown event when the user clicks the binding button.
  //
  // Bindings are stored in config.ini under [Keys_P1] / [Keys_P2] using
  // the engine's INI string format (see CODE_TO_INI_KEY above).
  {
    id: 'keys',
    category: 'controls',
    label: 'KEYS',
    settings: [
      // P1 directions
      { section: 'Keys_P1', key: 'Up',    label: 'P1 Up',    type: 'keybind', player: 1, action: 'Up',    hint: 'Jump / move up.' },
      { section: 'Keys_P1', key: 'Down',  label: 'P1 Down',  type: 'keybind', player: 1, action: 'Down',  hint: 'Crouch / block low.' },
      { section: 'Keys_P1', key: 'Left',  label: 'P1 Left',  type: 'keybind', player: 1, action: 'Left',  hint: 'Walk back / block.' },
      { section: 'Keys_P1', key: 'Right', label: 'P1 Right', type: 'keybind', player: 1, action: 'Right', hint: 'Walk forward.' },
      // P1 attacks
      { section: 'Keys_P1', key: 'A', label: 'P1 A', type: 'keybind', player: 1, action: 'A', hint: 'Light punch.' },
      { section: 'Keys_P1', key: 'B', label: 'P1 B', type: 'keybind', player: 1, action: 'B', hint: 'Medium punch.' },
      { section: 'Keys_P1', key: 'C', label: 'P1 C', type: 'keybind', player: 1, action: 'C', hint: 'Heavy punch.' },
      { section: 'Keys_P1', key: 'X', label: 'P1 X', type: 'keybind', player: 1, action: 'X', hint: 'Light kick.' },
      { section: 'Keys_P1', key: 'Y', label: 'P1 Y', type: 'keybind', player: 1, action: 'Y', hint: 'Medium kick.' },
      { section: 'Keys_P1', key: 'Z', label: 'P1 Z', type: 'keybind', player: 1, action: 'Z', hint: 'Heavy kick.' },
      { section: 'Keys_P1', key: 'Start', label: 'P1 Start', type: 'keybind', player: 1, action: 'Start', hint: 'Start / pause / confirm.' },
      // P2 directions
      { section: 'Keys_P2', key: 'Up',    label: 'P2 Up',    type: 'keybind', player: 2, action: 'Up',    hint: 'Jump / move up.' },
      { section: 'Keys_P2', key: 'Down',  label: 'P2 Down',  type: 'keybind', player: 2, action: 'Down',  hint: 'Crouch / block low.' },
      { section: 'Keys_P2', key: 'Left',  label: 'P2 Left',  type: 'keybind', player: 2, action: 'Left',  hint: 'Walk back / block.' },
      { section: 'Keys_P2', key: 'Right', label: 'P2 Right', type: 'keybind', player: 2, action: 'Right', hint: 'Walk forward.' },
      // P2 attacks
      { section: 'Keys_P2', key: 'A', label: 'P2 A', type: 'keybind', player: 2, action: 'A', hint: 'Light punch.' },
      { section: 'Keys_P2', key: 'B', label: 'P2 B', type: 'keybind', player: 2, action: 'B', hint: 'Medium punch.' },
      { section: 'Keys_P2', key: 'C', label: 'P2 C', type: 'keybind', player: 2, action: 'C', hint: 'Heavy punch.' },
      { section: 'Keys_P2', key: 'X', label: 'P2 X', type: 'keybind', player: 2, action: 'X', hint: 'Light kick.' },
      { section: 'Keys_P2', key: 'Y', label: 'P2 Y', type: 'keybind', player: 2, action: 'Y', hint: 'Medium kick.' },
      { section: 'Keys_P2', key: 'Z', label: 'P2 Z', type: 'keybind', player: 2, action: 'Z', hint: 'Heavy kick.' },
      { section: 'Keys_P2', key: 'Start', label: 'P2 Start', type: 'keybind', player: 2, action: 'Start', hint: 'Start / pause / confirm.' },
    ],
  },
];
