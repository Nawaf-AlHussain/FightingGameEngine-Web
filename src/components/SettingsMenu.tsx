'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadConfig,
  saveConfig,
  clearPersistedConfig,
  parseConfigIni,
  serializeConfigIni,
  getString,
  set,
  SETTINGS_SCHEMA,
  iniKeyToLabel,
  codeToIniKey,
  isValidIniKey,
  type ConfigData,
  type SettingDef,
  type SettingGroup,
} from '@/lib/ikemen-config';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SettingsMenuProps {
  /** Called when user cancels / presses BACK. */
  onCancel: () => void;
}

export default function SettingsMenu({ onCancel }: SettingsMenuProps) {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState<string>('video');
  const [dirty, setDirty] = useState(false);
  /** Track which settings need reload — shown as a badge in the footer. */
  const [needsReload, setNeedsReload] = useState(false);
  /** Saved snapshot for diff/discard — null until first load completes. */
  const [snapshot, setSnapshot] = useState<string>('');

  // ---- Load config on mount ----
  useEffect(() => {
    let cancelled = false;
    loadConfig().then(cfg => {
      if (cancelled || !cfg) return;
      setConfig(cfg);
      setSnapshot(serializeForCompare(cfg));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // ---- Update a single setting ----
  const updateSetting = useCallback(
    (def: SettingDef, value: string) => {
      setConfig(prev => {
        if (!prev) return prev;
        // Clone to keep React state updates pure
        const next: ConfigData = {
          sections: new Map(prev.sections),
          order: [...prev.order],
        };
        // Shallow-clone the section we're about to mutate
        const sectionName = def.section;
        const oldSection = next.sections.get(sectionName) ?? {};
        next.sections.set(sectionName, { ...oldSection });
        set(next, sectionName, def.key, value);
        return next;
      });
      setDirty(true);
      if (def.requiresReload) setNeedsReload(true);
    },
    [],
  );

  // ---- Save: persist to localStorage, then return (caller decides reload) ----
  const handleSave = useCallback(() => {
    if (!config) return;
    saveConfig(config);
    if (needsReload) {
      // Force a reload so the engine re-reads the new config at boot.
      // The user was warned in the footer before pressing SAVE.
      window.location.reload();
    } else {
      // No reload needed — just go back.
      onCancel();
    }
  }, [config, needsReload, onCancel]);

  // ---- Reset to shipped defaults ----
  const handleReset = useCallback(async () => {
    if (!confirm('Reset all settings to shipped defaults? This will reload the page.')) {
      return;
    }
    clearPersistedConfig();
    window.location.reload();
  }, []);

  // ---- Discard changes since last load ----
  const handleDiscard = useCallback(() => {
    if (!snapshot) return;
    const restored = parseConfigIni(atob(snapshot));
    setConfig(restored);
    setDirty(false);
    setNeedsReload(false);
  }, [snapshot]);

  // ---- Render ----
  if (loading) {
    return (
      <main className="settings">
        <div className="settings__loading">LOADING SETTINGS…</div>
      </main>
    );
  }

  if (!config) {
    return (
      <main className="settings">
        <div className="settings__error">
          <div>COULD NOT LOAD CONFIG</div>
          <div className="settings__error-hint">
            The shipped config.ini could not be fetched, and no persisted
            config exists in localStorage. Check your network connection.
          </div>
        </div>
      </main>
    );
  }

  const group: SettingGroup | undefined = SETTINGS_SCHEMA.find(g => g.id === activeGroup);

  return (
    <main className="settings">
      <div className="settings__bg-grid bg-grid" aria-hidden="true" />

      {/* Title */}
      <div className="settings__title">
        <h1 className="settings__title-main">SETTINGS</h1>
        <div className="settings__title-sub">
          {dirty ? 'UNSAVED CHANGES' : 'CONFIG.INI · PERSISTED IN BROWSER STORAGE'}
        </div>
      </div>

      {/* Tab bar — vertical on desktop, horizontal scroll on mobile */}
      <div className="settings__tabs" role="tablist" aria-label="Settings categories">
        {SETTINGS_SCHEMA.map(g => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={activeGroup === g.id}
            className={`settings__tab${activeGroup === g.id ? ' settings__tab--active' : ''}`}
            onClick={() => setActiveGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Setting rows */}
      <div className="settings__body" role="tabpanel">
        {group && group.settings.map(def => (
          <SettingRow
            key={`${def.section}.${def.key}`}
            def={def}
            value={readValue(config, def)}
            onChange={v => updateSetting(def, v)}
            config={config}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="settings__footer">
        <div className="settings__footer-status">
          {needsReload && (
            <span className="settings__badge settings__badge--warn">
              ⚠ RELOAD REQUIRED
            </span>
          )}
          {dirty && !needsReload && (
            <span className="settings__badge settings__badge--info">
              ● UNSAVED
            </span>
          )}
          {!dirty && (
            <span className="settings__badge settings__badge--ok">
              ✓ IN SYNC
            </span>
          )}
        </div>
        <div className="settings__footer-btns">
          <button
            type="button"
            className="settings__btn settings__btn--reset"
            onClick={handleReset}
            title="Reset to shipped defaults"
          >
            RESET DEFAULTS
          </button>
          {dirty && (
            <button
              type="button"
              className="settings__btn settings__btn--discard"
              onClick={handleDiscard}
            >
              DISCARD
            </button>
          )}
          <button
            type="button"
            className="settings__btn settings__btn--back"
            onClick={onCancel}
          >
            ← BACK
          </button>
          <button
            type="button"
            className="settings__btn settings__btn--save"
            onClick={handleSave}
            disabled={!dirty}
            aria-disabled={!dirty}
            title={
              needsReload
                ? 'Save and reload the page to apply changes'
                : 'Save settings (applied on next engine boot)'
            }
          >
            {needsReload ? 'SAVE & RELOAD' : 'SAVE'}
          </button>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// SettingRow — renders the right control per setting type
// ---------------------------------------------------------------------------

function SettingRow({
  def,
  value,
  onChange,
  config,
}: {
  def: SettingDef;
  value: string;
  onChange: (v: string) => void;
  config: ConfigData;
}) {
  // Greyed-out for non-web-applicable settings
  if (def.webApplicable === false) {
    return (
      <div className="settings__row settings__row--disabled">
        <div className="settings__row-label">
          <div className="settings__row-name">{def.label}</div>
          {def.hint && <div className="settings__row-hint">{def.hint}</div>}
        </div>
        <div className="settings__row-control settings__row-control--na">
          N/A IN BROWSER
        </div>
      </div>
    );
  }

  const reloadBadge = def.requiresReload && (
    <span className="settings__reload-badge" title="Requires page reload">
      ⟳
    </span>
  );

  return (
    <div className="settings__row">
      <div className="settings__row-label">
        <div className="settings__row-name">
          {def.label} {reloadBadge}
        </div>
        {def.hint && <div className="settings__row-hint">{def.hint}</div>}
      </div>
      <div className="settings__row-control">
        {def.type === 'toggle' && (
          <Toggle value={value === '1' || value === 'true'} onChange={v => onChange(v ? '1' : '0')} />
        )}
        {def.type === 'slider' && (
          <Slider
            value={parseFloat(value) || 0}
            min={def.min ?? 0}
            max={def.max ?? 100}
            step={def.step ?? 1}
            onChange={v => onChange(String(v))}
          />
        )}
        {def.type === 'select' && (
          <Select
            options={def.options ?? []}
            value={value}
            onChange={onChange}
          />
        )}
        {def.type === 'number' && (
          <NumberInput
            value={parseInt(value, 10) || 0}
            onChange={v => onChange(String(v))}
          />
        )}
        {def.type === 'text' && (
          <TextInput value={value} onChange={onChange} />
        )}
        {def.type === 'keybind' && (
          <KeyBind
            value={value}
            onChange={onChange}
            config={config}
            def={def}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual controls
// ---------------------------------------------------------------------------

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`settings__toggle${value ? ' settings__toggle--on' : ''}`}
      onClick={() => onChange(!value)}
      aria-pressed={value}
    >
      <span className="settings__toggle-knob" />
      <span className="settings__toggle-label">{value ? 'ON' : 'OFF'}</span>
    </button>
  );
}

function Slider({
  value, min, max, step, onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="settings__slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="settings__slider-input"
      />
      <span className="settings__slider-value">{formatNumber(value, step)}</span>
    </div>
  );
}

function Select({
  options, value, onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="settings__select"
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      {options.map(o => (
        <option key={o.value + o.label} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function NumberInput({
  value, onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      className="settings__number"
      value={value}
      onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
    />
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      className="settings__text"
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// KeyBind — keyboard key capture for remapping
// ---------------------------------------------------------------------------
//
// When the user clicks the binding button, we enter "capture mode": the
// button text changes to "PRESS A KEY…" and we attach a one-time keydown
// listener on window. The next keypress is converted to the engine's INI
// string format via codeToIniKey(). If the key is bindable, the binding
// is updated. If the user presses Escape, capture is cancelled.
//
// Conflict detection: before saving, we check if the same INI key is
// already used by another action for the SAME player. If yes, we show
// an error and refuse the binding (you can't have P1 Up = w AND P1
// Down = w — the engine would fire both at once).
//
// Cross-player conflicts are allowed (P1 Up = w and P2 Up = UP is fine).

function KeyBind({
  value,
  onChange,
  config,
  def,
}: {
  value: string;
  onChange: (v: string) => void;
  config: ConfigData;
  def: SettingDef;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refs so the keydown handler can read latest state without re-binding.
  const onChangeRef = useRef(onChange);
  const configRef = useRef(config);
  const defRef = useRef(def);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { defRef.current = def; }, [def]);

  // Enter capture mode
  const startCapture = useCallback(() => {
    setError(null);
    setCapturing(true);
  }, []);

  // Cancel capture (Escape or click elsewhere)
  const cancelCapture = useCallback(() => {
    setCapturing(false);
    setError(null);
  }, []);

  // Attach a one-time keydown listener while capturing.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // ESC cancels the capture (doesn't bind Escape to the action)
      if (e.code === 'Escape') {
        setCapturing(false);
        setError(null);
        return;
      }

      // Convert the browser KeyboardEvent.code to the engine's INI string.
      const iniKey = codeToIniKey(e.code);
      if (!iniKey) {
        setError(`Key "${e.code}" is not bindable. Try a letter, digit, arrow, or numpad key.`);
        setCapturing(false);
        return;
      }

      // Conflict check: scan the same player's [Keys_P*] section for any
      // OTHER action (not the one we're editing) that already uses this key.
      const d = defRef.current;
      if (d.player && d.action) {
        const sectionName = d.section; // e.g. 'Keys_P1'
        const section = configRef.current.sections.get(sectionName);
        if (section) {
          for (const [k, v] of Object.entries(section)) {
            if (k.startsWith('_comment_')) continue;
            if (k === d.key) continue; // same action — OK
            if (v === iniKey) {
              setError(`Already bound to ${k}. Pick a different key.`);
              setCapturing(false);
              return;
            }
          }
        }
      }

      // All clear — save the binding.
      onChangeRef.current(iniKey);
      setCapturing(false);
      setError(null);
    };
    // Use capture phase so we intercept the key before any other handler
    // (including the engine's own keydown listener).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  // Render the binding button. When not capturing, show the current key
  // label. When capturing, show "PRESS A KEY…" and highlight.
  const isStale = !isValidIniKey(value);
  const displayLabel = value ? iniKeyToLabel(value) : '—';

  return (
    <div className="settings__keybind">
      <button
        type="button"
        className={`settings__keybind-btn${capturing ? ' settings__keybind-btn--capturing' : ''}${isStale ? ' settings__keybind-btn--stale' : ''}`}
        onClick={capturing ? cancelCapture : startCapture}
        aria-label={capturing ? 'Press a key, or Escape to cancel' : `Rebind ${def.label}`}
      >
        {capturing ? 'PRESS A KEY…' : displayLabel}
      </button>
      {isStale && value && (
        <div className="settings__keybind-stale">
          ⚠ Invalid binding "{value}". Click to rebind.
        </div>
      )}
      {error && (
        <div className="settings__keybind-error">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readValue(data: ConfigData, def: SettingDef): string {
  // Try int first (for slider/number), fall back to string.
  const s = getString(data, def.section, def.key);
  return s ?? '';
}

function serializeForCompare(data: ConfigData): string {
  // Re-serialize and base64 so we can compare snapshots cheaply.
  // We use the same serializer the saver uses, so equal text = equal config.
  // (Comments are preserved, so editing values produces a different snapshot.)
  const text = serializeConfigIni(data);
  try {
    return btoa(text);
  } catch {
    return text;
  }
}

function formatNumber(n: number, step: number): string {
  if (step >= 1) return String(Math.round(n));
  // For fractional steps, show as many decimals as the step implies.
  const decimals = step < 0.1 ? 2 : 1;
  return n.toFixed(decimals);
}
