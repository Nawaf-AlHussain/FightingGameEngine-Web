'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  DIFFICULTIES,
  MODES,
  loadSavedModeChoice,
  modeShowsDifficulty,
  saveModeChoice,
  type Difficulty,
  type GameMode,
} from '@/lib/mode-catalog';
import { useIsTouchDevice } from '@/lib/use-touch-device';

// ---------------------------------------------------------------------------
// ModeSelect — the dedicated "SELECT YOUR MODE" screen.
//
// The local flow used to cram the mode chips, difficulty chips, roster
// groups and the fighter grid into one page; this screen starts the
// separated, normal-fighting-game chain:
//
//   /lobby → MODE SELECT (here) → /local (fighter select) → stage select
//
// Owns the mode + difficulty pick (the character screen receives them as
// fixed props). Also owns their persistence: the choice is saved under
// the same localStorage keys the old select-screen toolbar used, so
// repeat visitors land with their usual defaults preselected.
//
// Keyboard: ↑↓ / W S — mode · ←→ / A D — difficulty · ENTER / SPACE —
// confirm · ESC — back. Touch: tap a card, then CONTINUE.
// ---------------------------------------------------------------------------

interface ModeSelectProps {
  /** Confirmed selection — the page navigates to /local with it. */
  onConfirm: (mode: GameMode, difficulty: Difficulty) => void;
  /** Back out to the lobby. */
  onCancel: () => void;
}

export default function ModeSelect({ onConfirm, onCancel }: ModeSelectProps) {
  const isTouch = useIsTouchDevice();

  // Defaults agree with the SSR render ('vs-ai' + 'normal'); the persisted
  // choice is restored AFTER mount (localStorage isn't readable during
  // SSR — reading it in render would hydrate-mismatch).
  const [mode, setMode] = useState<GameMode>('vs-ai');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');

  // ---- Restore the persisted choice once (same keys as the old toolbar) --
  useEffect(() => {
    const saved = loadSavedModeChoice();
    if (saved.mode) setMode(saved.mode);
    if (saved.difficulty) setDifficulty(saved.difficulty);
  }, []);

  // ---- Persist on every change (repeat sessions skip re-tapping) --------
  useEffect(() => {
    saveModeChoice(mode, difficulty);
  }, [mode, difficulty]);

  const showDifficulty = modeShowsDifficulty(mode);

  // ---- Confirm / cancel --------------------------------------------------
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const confirm = useCallback(() => {
    confirmRef.current(mode, difficulty);
  }, [mode, difficulty]);

  // ---- Cycling helpers (wrap-around) -------------------------------------
  const cycleMode = useCallback((dir: 1 | -1) => {
    setMode(prev => {
      const i = MODES.findIndex(m => m.id === prev);
      const next = (i + dir + MODES.length) % MODES.length;
      return MODES[next].id;
    });
  }, []);

  const cycleDifficulty = useCallback((dir: 1 | -1) => {
    setDifficulty(prev => {
      const i = DIFFICULTIES.findIndex(d => d.id === prev);
      const next = (i + dir + DIFFICULTIES.length) % DIFFICULTIES.length;
      return DIFFICULTIES[next].id;
    });
  }, []);

  // ---- Keyboard (skipped on touch — no keyboard, no hijacked shortcuts) --
  useEffect(() => {
    if (isTouch) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const code = e.code;
      // Vertical / WASD — walk the mode cards
      if (code === 'ArrowUp' || code === 'KeyW') { e.preventDefault(); cycleMode(-1); return; }
      if (code === 'ArrowDown' || code === 'KeyS') { e.preventDefault(); cycleMode(1); return; }
      // Horizontal / AD — walk the difficulty chips (when the row is shown)
      if (code === 'ArrowLeft' || code === 'KeyA') { e.preventDefault(); if (showDifficulty) cycleDifficulty(-1); return; }
      if (code === 'ArrowRight' || code === 'KeyD') { e.preventDefault(); if (showDifficulty) cycleDifficulty(1); return; }
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
        e.preventDefault();
        confirm();
        return;
      }
      if (code === 'Escape' || code === 'Backspace') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTouch, cycleMode, cycleDifficulty, showDifficulty, confirm, onCancel]);

  const selectedDef = MODES.find(m => m.id === mode) ?? MODES[0];

  // ---- Render --------------------------------------------------------------
  return (
    <main className="ms bg-grid" tabIndex={0} aria-label="Mode select">
      {/* Print dressing: diagonal ink wedges + drifting halftone + reg marks */}
      <div className="ms__bg-wedges" aria-hidden="true" />
      <div className="ms__bg-dots" aria-hidden="true" />
      <span className="cs__reg cs__reg--tl" aria-hidden="true" />
      <span className="cs__reg cs__reg--tr" aria-hidden="true" />

      {/* Masthead — comic cover */}
      <header className="ms__title">
        <div className="ms__kicker">
          <span className="ms__kicker-rule" aria-hidden="true" />
          <span>ISSUE No. 01 — THE MODES</span>
          <span className="ms__kicker-rule" aria-hidden="true" />
        </div>
        <h1 className="ms__title-main">SELECT YOUR MODE</h1>
        <div className="ms__title-sub" aria-live="polite">
          {selectedDef.description.toUpperCase()}
        </div>
      </header>

      {/* Mode cards — one per game mode, selected card in crimson ink */}
      <div
        className="ms__grid"
        role="radiogroup"
        aria-label="Game mode"
      >
        {MODES.map((m, i) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`ms__card${mode === m.id ? ' ms__card--active' : ''}`}
            onClick={() => setMode(m.id)}
          >
            <span className="ms__card-top">
              <span className="ms__card-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <span className="ms__card-tag">{m.tag}</span>
            </span>
            <span className="ms__card-label">{m.label}</span>
            <span className="ms__card-desc">{m.description}</span>
          </button>
        ))}
      </div>

      {/* Difficulty — AI modes only (local VS PLAYER has no CPU to tune) */}
      {showDifficulty && (
        <div className="cs__difficulty-bar ms__difficulty" role="radiogroup" aria-label="AI difficulty">
          <span>DIFFICULTY</span>
          {DIFFICULTIES.map(d => (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={difficulty === d.id}
              className={`cs__diff-btn${difficulty === d.id ? ' cs__diff-btn--active' : ''}`}
              onClick={() => setDifficulty(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      {/* Footer — back + continue */}
      <div className="ms__footer">
        <button type="button" className="cs__btn-back" onClick={onCancel}>
          ← BACK
        </button>
        <button type="button" className="cs__btn-fight" onClick={confirm}>
          CONTINUE ▶
        </button>
      </div>

      {/* Controls hint — keyboard wording on desktop, tap wording on touch */}
      <div className="ms__hint">
        {isTouch ? (
          <div>
            <span>TAP</span> a mode
            {showDifficulty && <> · <span>PICK</span> a difficulty</>}
            {' '}· <span>CONTINUE</span> to the roster
          </div>
        ) : (
          <>
            <div>
              <span>↑↓ / W S</span> mode{showDifficulty ? <> · <span>←→ / A D</span> difficulty</> : null} · <span>ENTER</span> confirm
            </div>
            <div><span>ESC</span> back</div>
          </>
        )}
      </div>
    </main>
  );
}
