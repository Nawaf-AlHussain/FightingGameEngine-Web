'use client';

import { useCallback, useRef } from 'react';

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
 * The engine does NOT read window.__ikemenKeyDown (that was an older bridge
 * that's no longer used). So to feed touch input, we dispatch SYNTHETIC
 * KeyboardEvents on document. The engine's own listener picks them up
 * exactly as if a physical key was pressed.
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

// Key code mapping (matches config.ini P1 bindings + jsCodeToKey in input_js.go).
// Values are ARRAYS because diagonal buttons press 2 keys simultaneously.
const KEY_MAP: Record<string, readonly string[]> = {
  // Cardinals
  up:    ['KeyW'],
  down:  ['KeyS'],
  left:  ['KeyA'],
  right: ['KeyD'],
  // Diagonals — press both adjacent cardinals
  upLeft:    ['KeyW', 'KeyA'],
  upRight:   ['KeyW', 'KeyD'],
  downLeft:  ['KeyS', 'KeyA'],
  downRight: ['KeyS', 'KeyD'],
  // Actions
  A: ['Digit8'],
  B: ['Digit9'],
  C: ['Digit0'],
  X: ['KeyI'],
  Y: ['KeyO'],
  Z: ['KeyP'],
  Start: ['KeyU'],
} as const;

type ButtonId = keyof typeof KEY_MAP;

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
 * We do NOT call preventDefault on the synthetic event — there's no
 * default action to cancel for a synthetic keydown.
 */
function dispatchKeyEvent(type: 'keydown' | 'keyup', code: string) {
  if (typeof document === 'undefined') return;
  try {
    const ev = new KeyboardEvent(type, {
      code: code,
      key: code, // some engine code paths read ev.key for text input
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    document.dispatchEvent(ev);
  } catch {
    // Fallback: very old browsers might not support KeyboardEvent constructor
    // with options. Try the deprecated initKeyboardEvent path.
    try {
      const ev = document.createEvent('KeyboardEvent');
      ev.initKeyboardEvent(type, true, true, window, code, 0, false, false, false, false);
      // initKeyboardEvent doesn't set `code` reliably — set it manually.
      Object.defineProperty(ev, 'code', { value: code, writable: false });
      document.dispatchEvent(ev);
    } catch {
      // Last resort — give up silently. Touch input won't work on this browser.
    }
  }
}

export default function TouchControls() {
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
    pressKeys(KEY_MAP[btnId]);
  }, [pressKeys]);

  const handleTouchEnd = useCallback((e: React.TouchEvent, btnId: ButtonId) => {
    e.preventDefault();
    releaseKeys(KEY_MAP[btnId]);
  }, [releaseKeys]);

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
