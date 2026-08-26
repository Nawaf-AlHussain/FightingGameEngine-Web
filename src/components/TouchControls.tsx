'use client';

import { useCallback, useRef } from 'react';

/**
 * TouchControls — on-screen controls for mobile devices.
 *
 * Layout:
 *   - Left side: Cross D-pad (up/down/left/right)
 *   - Right side: 6 action buttons in 2 rows of 3 (A B C / X Y Z)
 *   - Top center: Start button
 *
 * Feeds into the existing keyboard bridge (window.__ikemenKeyDown/Up)
 * by mapping touch events to the same key codes the engine expects
 * from config.ini:
 *   P1 movement: W (up), S (down), A (left), D (right)
 *   P1 actions: 8 (A), 9 (B), 0 (C), I (X), O (Y), P (Z)
 *   Start: U
 *
 * Multi-touch: Each touch is tracked by identifier so multiple buttons
 * can be pressed simultaneously (e.g., hold D to walk + press A to punch).
 */

// Key code mapping (matches config.ini P1 bindings)
const KEY_MAP = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  A: 'Digit8',
  B: 'Digit9',
  C: 'Digit0',
  X: 'KeyI',
  Y: 'KeyO',
  Z: 'KeyP',
  Start: 'KeyU',
} as const;

type ButtonId = keyof typeof KEY_MAP;

export default function TouchControls() {
  const pressedRef = useRef<Set<string>>(new Set());

  const pressKey = useCallback((btnId: ButtonId) => {
    const code = KEY_MAP[btnId];
    if (pressedRef.current.has(code)) return; // already pressed
    pressedRef.current.add(code);
    const g = globalThis as any;
    if (g.__ikemenKeyDown) g.__ikemenKeyDown.push(code);
  }, []);

  const releaseKey = useCallback((btnId: ButtonId) => {
    const code = KEY_MAP[btnId];
    if (!pressedRef.current.has(code)) return; // not pressed
    pressedRef.current.delete(code);
    const g = globalThis as any;
    if (g.__ikemenKeyUp) g.__ikemenKeyUp.push(code);
  }, []);

  // Touch handlers — use onTouchStart/End to avoid 300ms click delay
  const handleTouchStart = useCallback((e: React.TouchEvent, btnId: ButtonId) => {
    e.preventDefault();
    pressKey(btnId);
  }, [pressKey]);

  const handleTouchEnd = useCallback((e: React.TouchEvent, btnId: ButtonId) => {
    e.preventDefault();
    releaseKey(btnId);
  }, [releaseKey]);

  // D-pad button component
  const DPadButton = ({ dir, className }: { dir: ButtonId; className: string }) => (
    <button
      className={`tc-dpad-btn ${className}`}
      onTouchStart={(e) => handleTouchStart(e, dir)}
      onTouchEnd={(e) => handleTouchEnd(e, dir)}
      onTouchCancel={(e) => handleTouchEnd(e, dir)}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={dir}
    />
  );

  // Action button component
  const ActionButton = ({ btn, label, color }: { btn: ButtonId; label: string; color: string }) => (
    <button
      className="tc-action-btn"
      style={{ borderColor: color, color: color }}
      onTouchStart={(e) => handleTouchStart(e, btn)}
      onTouchEnd={(e) => handleTouchEnd(e, btn)}
      onTouchCancel={(e) => handleTouchEnd(e, btn)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <div className="touch-controls" aria-hidden="false">
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

      {/* D-pad — left side */}
      <div className="tc-dpad">
        <div className="tc-dpad-row">
          <div className="tc-dpad-spacer" />
          <DPadButton dir="up" className="tc-dpad-up" />
          <div className="tc-dpad-spacer" />
        </div>
        <div className="tc-dpad-row">
          <DPadButton dir="left" className="tc-dpad-left" />
          <div className="tc-dpad-center" />
          <DPadButton dir="right" className="tc-dpad-right" />
        </div>
        <div className="tc-dpad-row">
          <div className="tc-dpad-spacer" />
          <DPadButton dir="down" className="tc-dpad-down" />
          <div className="tc-dpad-spacer" />
        </div>
      </div>

      {/* Action buttons — right side, 2 rows of 3 */}
      <div className="tc-actions">
        <div className="tc-action-row">
          <ActionButton btn="A" label="A" color="#0dd9ff" />
          <ActionButton btn="B" label="B" color="#0dd9ff" />
          <ActionButton btn="C" label="C" color="#0dd9ff" />
        </div>
        <div className="tc-action-row">
          <ActionButton btn="X" label="X" color="#d92323" />
          <ActionButton btn="Y" label="Y" color="#d92323" />
          <ActionButton btn="Z" label="Z" color="#d92323" />
        </div>
      </div>
    </div>
  );
}
