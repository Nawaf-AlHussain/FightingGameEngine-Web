'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadP1KeyBindings } from '@/lib/ikemen-config';

/**
 * TouchControls — on-screen controls for mobile devices.
 *
 * Layout:
 *   - Left side: 8-direction D-pad (3x3 grid: UL U UR / L C R / DL D DR)
 *   - Right side: 6 action buttons in 2 rows of 3 (A B C / X Y Z)
 *   - Top center: Start button
 *
 * INPUT PATH (CRITICAL):
 * The IKEMEN GO WASM engine listens for NATIVE 'keydown'/'keyup' DOM events
 * on `document` (see system_js.go: addEventListener("keydown", ...)). It looks
 * up `ev.code` in `jsCodeToKey` and calls OnKeyPressed/OnKeyReleased.
 *
 * We dispatch SYNTHETIC KeyboardEvents on document. The engine's own listener
 * picks them up exactly as if a physical key was pressed.
 *
 * KEY MAP IS NOT HARDCODED — it's loaded from the same localStorage
 * config.ini that the Settings UI and the /local RES toggle write to.
 * This means if the user rebinds P1 A=F in Settings, the touch "A"
 * button dispatches KeyF (not the old Digit8). Single source of truth.
 *
 * Diagonal directions (UL/UR/DL/DR) press TWO cardinal keys at once
 * (e.g. UR = Up + Right). The engine natively interprets this as the
 * diagonal direction (forward-jump, back-jump, crouch-forward, etc.).
 *
 * Reference counting: a key code is only released when ALL buttons
 * referencing it have been released. This handles the diagonal overlap
 * case — e.g. pressing UR then UL (both share Up) then releasing UR
 * keeps Up held until UL is also released.
 *
 * Multi-touch: Each touch is tracked by identifier so multiple buttons
 * can be pressed simultaneously (e.g., hold DR to crouch-block + press
 * A to punch).
 */

/**
 * Build the KEY_MAP from the P1 bindings loaded from config.ini.
 *
 * Returns a map: buttonId → array of KeyboardEvent.code strings.
 * Diagonals are built by combining the two adjacent cardinals.
 *
 * While loading (async), returns the default KEY_MAP so the controls
 * are immediately usable (no flash of broken buttons).
 */
function buildKeyMap(bindings: Record<string, string>): Record<string, readonly string[]> {
  const up = bindings.Up ?? 'KeyW';
  const down = bindings.Down ?? 'KeyS';
  const left = bindings.Left ?? 'KeyA';
  const right = bindings.Right ?? 'KeyD';
  return {
    // Cardinals
    up:    [up],
    down:  [down],
    left:  [left],
    right: [right],
    // Diagonals — press both adjacent cardinals
    upLeft:    [up, left],
    upRight:   [up, right],
    downLeft:  [down, left],
    downRight: [down, right],
    // Actions
    A: [bindings.A ?? 'Digit8'],
    B: [bindings.B ?? 'Digit9'],
    C: [bindings.C ?? 'Digit0'],
    X: [bindings.X ?? 'KeyI'],
    Y: [bindings.Y ?? 'KeyO'],
    Z: [bindings.Z ?? 'KeyP'],
    Start: [bindings.Start ?? 'KeyU'],
  };
}

// Default bindings used while the config is loading (matches shipped config.ini).
const DEFAULT_BINDINGS: Record<string, string> = {
  Up: 'KeyW', Down: 'KeyS', Left: 'KeyA', Right: 'KeyD',
  A: 'Digit8', B: 'Digit9', C: 'Digit0',
  X: 'KeyI', Y: 'KeyO', Z: 'KeyP',
  Start: 'KeyU',
};

type ButtonId = 'upLeft' | 'up' | 'upRight' | 'left' | 'right' | 'downLeft' | 'down' | 'downRight' | 'A' | 'B' | 'C' | 'X' | 'Y' | 'Z' | 'Start';

/**
 * Dispatch a synthetic KeyboardEvent on document.
 *
 * The IKEMEN GO engine's listener (installed in system_js.go's newWindow)
 * does:
 *   ev.Get("code").String() → lookup in jsCodeToKey → OnKeyPressed/Released
 *
 * So we need to construct a real KeyboardEvent with the correct `code`
 * property. We use bubbles:true so it propagates to document (the engine
 * attaches its listener on document).
 *
 * IMPORTANT: Some mobile browsers (notably older Chrome on Android) have
 * a quirk where the KeyboardEvent constructor accepts a `code` option but
 * the resulting event's `code` property reads as an empty string. This
 * breaks the engine's lookup. To work around this, we:
 *   1. Construct the event with the `code` option (works on most browsers).
 *   2. Defensive: if the resulting event's code is empty, override it
 *      via Object.defineProperty (forces the property to be the value we
 *      want, bypassing any browser quirk).
 *
 * We do NOT call preventDefault on the synthetic event — there's no
 * default action to cancel for a synthetic keydown.
 */
function dispatchKeyEvent(type: 'keydown' | 'keyup', code: string) {
  if (typeof document === 'undefined') return;
  // The physical character each `code` produces, for the engine's text
  // input path (OnTextEntered). The engine only uses it when len(k) == 1
  // (single char) — e.g., for menu navigation / IP entry. We set it to
  // the actual character so menus work via touch, but it doesn't affect
  // gameplay (which uses `code`, not `key`).
  const keyChar = codeToKeyChar(code);
  try {
    const ev = new KeyboardEvent(type, {
      code: code,
      key: keyChar,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    // Mobile Chrome quirk: constructor may not set `code` properly.
    // Verify and force-set if needed.
    if (ev.code !== code) {
      try {
        Object.defineProperty(ev, 'code', {
          value: code,
          writable: false,
          configurable: true,
        });
      } catch {
        // If defineProperty fails too, the event is broken — skip dispatch.
        return;
      }
    }
    if (ev.key !== keyChar) {
      try {
        Object.defineProperty(ev, 'key', {
          value: keyChar,
          writable: false,
          configurable: true,
        });
      } catch {
        // Non-fatal — gameplay uses `code`, not `key`.
      }
    }
    document.dispatchEvent(ev);
  } catch {
    // Fallback: very old browsers might not support KeyboardEvent constructor
    // with options. Try the deprecated initKeyboardEvent path.
    try {
      const ev = document.createEvent('KeyboardEvent');
      ev.initKeyboardEvent(type, true, true, window, keyChar, 0, false, false, false, false);
      // initKeyboardEvent doesn't set `code` reliably — set it manually.
      Object.defineProperty(ev, 'code', { value: code, writable: false, configurable: true });
      document.dispatchEvent(ev);
    } catch {
      // Last resort — give up silently. Touch input won't work on this browser.
    }
  }
}

/**
 * Map a KeyboardEvent.code to the character it produces (for the engine's
 * OnTextEntered path — single-char text input for menus).
 *
 * - KeyA..KeyZ → 'a'..'z'
 * - Digit0..Digit9 → '0'..'9'
 * - Everything else → the code itself (length > 1, so OnTextEntered is skipped)
 */
function codeToKeyChar(code: string): string {
  if (code.length === 4 && code.startsWith('Key')) {
    return code[3].toLowerCase(); // KeyW → 'w'
  }
  if (code.length === 6 && code.startsWith('Digit')) {
    return code[5]; // Digit8 → '8'
  }
  return code; // ArrowUp, Enter, etc. — length > 1, OnTextEntered skipped
}

export default function TouchControls() {
  // KEY_MAP is loaded from localStorage config.ini (the same source the
  // Settings UI writes to). Starts with defaults so the controls are
  // immediately usable; updates once the async load completes.
  const [keyMap, setKeyMap] = useState<Record<string, readonly string[]>>(() =>
    buildKeyMap(DEFAULT_BINDINGS),
  );

  useEffect(() => {
    let cancelled = false;
    loadP1KeyBindings().then(bindings => {
      if (cancelled) return;
      setKeyMap(buildKeyMap(bindings));
    });
    return () => { cancelled = true; };
  }, []);

  // Reference count per key code. A key is "held" while count > 0.
  // This prevents premature release when two buttons share a cardinal
  // (e.g. UR and UL both reference Up).
  const keyRefCount = useRef<Map<string, number>>(new Map());

  const pressKeys = useCallback((keys: readonly string[]) => {
    for (const code of keys) {
      const count = keyRefCount.current.get(code) ?? 0;
      keyRefCount.current.set(code, count + 1);
      if (count === 0) {
        // First holder — dispatch keydown
        dispatchKeyEvent('keydown', code);
      }
    }
  }, []);

  const releaseKeys = useCallback((keys: readonly string[]) => {
    for (const code of keys) {
      const count = keyRefCount.current.get(code) ?? 0;
      if (count === 0) continue; // not held — ignore
      const next = count - 1;
      if (next === 0) {
        // Last holder released — dispatch keyup
        keyRefCount.current.delete(code);
        dispatchKeyEvent('keyup', code);
      } else {
        keyRefCount.current.set(code, next);
      }
    }
  }, []);

  // Touch handlers — use onTouchStart/End to avoid 300ms click delay
  const handleTouchStart = useCallback((e: React.TouchEvent, btnId: ButtonId) => {
    e.preventDefault();
    pressKeys(keyMap[btnId] ?? []);
  }, [pressKeys, keyMap]);

  const handleTouchEnd = useCallback((e: React.TouchEvent, btnId: ButtonId) => {
    e.preventDefault();
    releaseKeys(keyMap[btnId] ?? []);
  }, [releaseKeys, keyMap]);

  // Generic touch button factory
  const TouchBtn = ({
    btnId,
    className,
    children,
    ariaLabel,
  }: {
    btnId: ButtonId;
    className: string;
    children?: React.ReactNode;
    ariaLabel: string;
  }) => (
    <button
      className={className}
      onTouchStart={(e) => handleTouchStart(e, btnId)}
      onTouchEnd={(e) => handleTouchEnd(e, btnId)}
      onTouchCancel={(e) => handleTouchEnd(e, btnId)}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );

  return (
    <div className="touch-controls active" aria-hidden="false">
      {/* Start button — top center */}
      <button
        className="tc-start-btn"
        onTouchStart={(e) => handleTouchStart(e, 'Start')}
        onTouchEnd={(e) => handleTouchEnd(e, 'Start')}
        onTouchCancel={(e) => handleTouchEnd(e, 'Start')}
        onContextMenu={(e) => e.preventDefault()}
      >
        START
      </button>

      {/* 8-direction D-pad — 3x3 grid */}
      <div className="tc-dpad">
        <div className="tc-dpad-row">
          <TouchBtn btnId="upLeft" className="tc-dpad-btn tc-dpad-diag tc-dpad-ul" ariaLabel="Up-Left (back jump)">
            <span className="tc-dpad-arrow">↖</span>
          </TouchBtn>
          <TouchBtn btnId="up" className="tc-dpad-btn tc-dpad-up" ariaLabel="Up (neutral jump)">
            <span className="tc-dpad-arrow">↑</span>
          </TouchBtn>
          <TouchBtn btnId="upRight" className="tc-dpad-btn tc-dpad-diag tc-dpad-ur" ariaLabel="Up-Right (forward jump)">
            <span className="tc-dpad-arrow">↗</span>
          </TouchBtn>
        </div>
        <div className="tc-dpad-row">
          <TouchBtn btnId="left" className="tc-dpad-btn tc-dpad-left" ariaLabel="Left (walk back / block)">
            <span className="tc-dpad-arrow">←</span>
          </TouchBtn>
          <div className="tc-dpad-center" aria-hidden="true" />
          <TouchBtn btnId="right" className="tc-dpad-btn tc-dpad-right" ariaLabel="Right (walk forward)">
            <span className="tc-dpad-arrow">→</span>
          </TouchBtn>
        </div>
        <div className="tc-dpad-row">
          <TouchBtn btnId="downLeft" className="tc-dpad-btn tc-dpad-diag tc-dpad-dl" ariaLabel="Down-Left (crouch block)">
            <span className="tc-dpad-arrow">↙</span>
          </TouchBtn>
          <TouchBtn btnId="down" className="tc-dpad-btn tc-dpad-down" ariaLabel="Down (crouch)">
            <span className="tc-dpad-arrow">↓</span>
          </TouchBtn>
          <TouchBtn btnId="downRight" className="tc-dpad-btn tc-dpad-diag tc-dpad-dr" ariaLabel="Down-Right (crouch forward)">
            <span className="tc-dpad-arrow">↘</span>
          </TouchBtn>
        </div>
      </div>

      {/* Action buttons — right side, 2 rows of 3 */}
      <div className="tc-actions">
        <div className="tc-action-row">
          <TouchBtn btnId="A" className="tc-action-btn tc-action-a" ariaLabel="A (light punch)">
            A
          </TouchBtn>
          <TouchBtn btnId="B" className="tc-action-btn tc-action-b" ariaLabel="B (medium punch)">
            B
          </TouchBtn>
          <TouchBtn btnId="C" className="tc-action-btn tc-action-c" ariaLabel="C (heavy punch)">
            C
          </TouchBtn>
        </div>
        <div className="tc-action-row">
          <TouchBtn btnId="X" className="tc-action-btn tc-action-x" ariaLabel="X (light kick)">
            X
          </TouchBtn>
          <TouchBtn btnId="Y" className="tc-action-btn tc-action-y" ariaLabel="Y (medium kick)">
            Y
          </TouchBtn>
          <TouchBtn btnId="Z" className="tc-action-btn tc-action-z" ariaLabel="Z (heavy kick)">
            Z
          </TouchBtn>
        </div>
      </div>
    </div>
  );
}
