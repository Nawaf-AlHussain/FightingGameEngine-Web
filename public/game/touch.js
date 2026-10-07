// touch.js -- virtual gamepad overlay for touch devices.
//
// Based on FightingGameEngine-Fiiight's web/touch.js, adapted for
// FightingGameEngine-Web.
//
// BINDINGS ARE HARDCODED TO THE ENGINE'S BUILT-IN P1 LAYOUT — DELIBERATELY.
//
// The wasm engine does NOT read [Keys_P1]/[Keys_P2] from save/config.ini for
// fight input. Proven empirically (scripts/online-touch-test/keymap-probe.mjs,
// scenarios A-fresh + B-shipped-seeded): even when config.ini is seeded with a
// different layout, the engine fights with its built-in defaults and its config
// write-back PREPENDS those defaults as first-match-wins entries, demoting any
// seeded values to dead shadows. The engine's built-in P1 layout is:
//
//   movement : UP / DOWN / LEFT / RIGHT (arrow keys)
//   buttons  : A=z  B=x  C=c  X=a  Y=s  Z=d
//   start    : RETURN
//
// which is exactly the classic layout players expect (arrows move P1, the six
// letter keys are kicks/punches). In NETPLAY the engine drives the local player
// from the [Keys_P1] section of the in-memory config, and the shipped
// public/game/ikemen-fs/file/save/config.ini now carries the SAME values — so
// every input path (local fight, netplay host, netplay guest) agrees with this
// overlay by construction.
//
// Deriving touch bindings by parsing config.ini was the ROOT CAUSE of the
// "touch controls broken / control the wrong player" bug family: the overlay
// and the engine resolved [Keys_P1] from different config copies (shipped
// defaults vs engine write-back vs stale persisted saves), so the overlay
// dispatched keys the engine had not bound — e.g. touch X dispatched KeyI,
// which is the engine's built-in P2 UP key, making the OPPONENT jump.
//
// If the engine ever starts honoring config key remaps, revisit this mapping.
//
// The engine glue registers "keydown"/"keyup" listeners on document and reads
// KeyboardEvent.code. This module dispatches synthetic KeyboardEvents with the
// codes above.
//
// Layout:
//   - Circular 8-way D-pad bottom-left (radial hit zones, slide to
//     change direction, dead zone in center)
//   - Six action buttons bottom-right in two arcs (XYZ over ABC)
//   - START pill top-center
//   - ESC pill top-center (dispatches Escape)
//
// Multi-touch: every touch identifier is tracked independently, so
// D-pad + several buttons can be held at once. Reference counting
// ensures overlapping keys (e.g. diagonal Up+Right and cardinal Up)
// are not released prematurely.
//
// Cleanup: all held keys are released on window blur, document
// visibilitychange, and touchcancel.
"use strict";

(() => {
  // ---- Build marker ----
  // Bump when touch.js changes and mirror it in the ?v= cache-buster on the
  // script tag in src/app/play/page.tsx. Logged on build() so a stale
  // cached copy of this file is instantly diagnosable from the console.
  const BUILD = "touch-2026-10-07.1";

  // ---- P1 bindings = the engine's built-in layout (see header) ----
  const BINDINGS = Object.freeze({
    Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
    A: "KeyZ", B: "KeyX", C: "KeyC",
    X: "KeyA", Y: "KeyS", Z: "KeyD",
    Start: "Enter",
  });

  // ---- KeyboardEvent.code → .key character for text input ----
  function codeToKeyChar(code) {
    if (code.length === 4 && code.startsWith("Key")) return code[3].toLowerCase();
    if (code.length === 6 && code.startsWith("Digit")) return code[5];
    return code; // ArrowUp, Enter, etc.
  }

  // ---- Synthetic key dispatch (reference-counted) ----
  const held = new Map(); // code → refcount

  function fire(type, code) {
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
          Object.defineProperty(ev, "code", { value: code, writable: false, configurable: true });
        } catch { /* if defineProperty fails, dispatch anyway */ }
      }
      // Dispatch on document ONLY. The engine registers its keyboard
      // listener on document (verified via F-key preventDefault test:
      // F1 dispatched on document is preventDefaulted by the engine;
      // F2 dispatched on window is NOT).
      // window.dispatchEvent does NOT reach document listeners (window
      // is above document in the DOM tree, events don't propagate downward).
      document.dispatchEvent(ev);
    } catch {
      // Fallback for very old browsers
      try {
        const ev = document.createEvent("KeyboardEvent");
        ev.initKeyboardEvent(type, true, true, window, keyChar, 0, false, false, false, false);
        Object.defineProperty(ev, "code", { value: code, writable: false, configurable: true });
        document.dispatchEvent(ev);
      } catch { /* give up */ }
    }
  }

  function keyDown(code) {
    const n = (held.get(code) || 0) + 1;
    held.set(code, n);
    if (n === 1) fire("keydown", code);
  }

  function keyUp(code) {
    const n = (held.get(code) || 0) - 1;
    if (n <= 0) {
      if (held.delete(code)) fire("keyup", code);
    } else {
      held.set(code, n);
    }
  }

  function releaseAll() {
    for (const code of [...held.keys()]) {
      held.delete(code);
      fire("keyup", code);
    }
  }

  // ---- Direction sectors for circular D-pad ----
  const DIR_U = 1, DIR_D = 2, DIR_L = 4, DIR_R = 8;
  const SECTORS = [
    DIR_R, DIR_R | DIR_U, DIR_U, DIR_U | DIR_L,
    DIR_L, DIR_L | DIR_D, DIR_D, DIR_D | DIR_R,
  ];
  const DIR_CODE = {};

  function updateDirCodes() {
    DIR_CODE[DIR_U] = BINDINGS.Up;
    DIR_CODE[DIR_D] = BINDINGS.Down;
    DIR_CODE[DIR_L] = BINDINGS.Left;
    DIR_CODE[DIR_R] = BINDINGS.Right;
  }

  // ---- Action buttons: label → code, positioned in two arcs ----
  // cx/cy are button-center offsets from the bottom-right anchor in
  // units of --tu (button diameter). Matches Fiiight's layout.
  function getButtons() {
    return [
      { label: "A", code: BINDINGS.A, cx: 2.75, cy: 0.55 },
      { label: "B", code: BINDINGS.B, cx: 1.70, cy: 0.80 },
      { label: "C", code: BINDINGS.C, cx: 0.65, cy: 1.05 },
      { label: "X", code: BINDINGS.X, cx: 2.90, cy: 1.60 },
      { label: "Y", code: BINDINGS.Y, cx: 1.85, cy: 1.85 },
      { label: "Z", code: BINDINGS.Z, cx: 0.80, cy: 2.10 },
    ];
  }

  // ---- DOM ----
  let root = null, dpadEl = null, arrowEls = null;

  const CSS = `
#ikemen-touch {
  position: fixed; inset: 0; z-index: 40;
  pointer-events: none;
  user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  font-family: system-ui, sans-serif;
  --tu: clamp(44px, 12vmin, 62px);
  --dp: clamp(118px, 36vmin, 180px);
  --sal: env(safe-area-inset-left, 0px);
  --sar: env(safe-area-inset-right, 0px);
  --sat: env(safe-area-inset-top, 0px);
  --sab: env(safe-area-inset-bottom, 0px);
}
#ikemen-touch * { touch-action: none; box-sizing: border-box; }

.itc-dpad {
  position: absolute;
  left: calc(var(--sal) + 14px); bottom: calc(var(--sab) + 16px);
  width: var(--dp); height: var(--dp);
  border-radius: 50%;
  background: radial-gradient(circle at 50% 45%, rgba(40, 40, 52, 0.40), rgba(14, 14, 20, 0.42));
  border: 1px solid rgba(255, 255, 255, 0.16);
  pointer-events: auto;
}
.itc-dpad::after {
  content: ""; position: absolute; inset: 35%;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.itc-ar {
  position: absolute;
  font-size: calc(var(--dp) * 0.15);
  color: rgba(255, 255, 255, 0.42);
  pointer-events: none;
  transition: color 60ms linear;
}
.itc-ar.itc-on { color: #fff; text-shadow: 0 0 10px rgba(255, 90, 90, 0.95); }

.itc-btns {
  position: absolute;
  right: calc(var(--sar) + 12px); bottom: calc(var(--sab) + 14px);
  width: calc(var(--tu) * 3.45); height: calc(var(--tu) * 2.65);
  pointer-events: none;
}
.itc-btn {
  position: absolute;
  width: var(--tu); height: var(--tu);
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: rgba(16, 16, 24, 0.44);
  border: 1px solid rgba(255, 255, 255, 0.22);
  color: rgba(255, 255, 255, 0.88);
  font-size: calc(var(--tu) * 0.34); font-weight: 600;
  pointer-events: auto;
  transition: transform 50ms linear, background-color 50ms linear;
}
.itc-btn.itc-on {
  background: rgba(226, 51, 51, 0.55);
  border-color: rgba(255, 255, 255, 0.65);
  transform: scale(0.92);
}

.itc-meta {
  position: absolute;
  top: calc(var(--sat) + 8px); left: 50%;
  transform: translateX(-50%);
  display: flex; gap: 14px;
  pointer-events: none;
}
.itc-pill {
  padding: 6px 16px;
  border-radius: 999px;
  background: rgba(16, 16, 24, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.8);
  font-size: 11px; font-weight: 600; letter-spacing: 0.12em;
  pointer-events: auto;
}
.itc-pill.itc-on {
  background: rgba(226, 51, 51, 0.55);
  border-color: rgba(255, 255, 255, 0.65);
}

html.itc-touch-active, html.itc-touch-active body,
html.itc-touch-active #ikemen-canvas {
  touch-action: none;
  user-select: none; -webkit-user-select: none;
  overscroll-behavior: none;
}
`;

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- Multi-touch routing ----
  // touch identifier → { move(touch)?, end() }
  const activeTouches = new Map();

  function onRootTouchMove(e) {
    let handled = false;
    for (const t of e.changedTouches) {
      const h = activeTouches.get(t.identifier);
      if (h) { handled = true; if (h.move) h.move(t); }
    }
    if (handled && e.cancelable) e.preventDefault();
  }

  function onRootTouchEnd(e) {
    for (const t of e.changedTouches) {
      const h = activeTouches.get(t.identifier);
      if (h) { activeTouches.delete(t.identifier); h.end(); }
    }
  }

  // Simple press-and-hold element (action buttons + pills)
  function bindPressable(elem, code) {
    elem.addEventListener("touchstart", (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (activeTouches.has(t.identifier)) continue;
        elem.classList.add("itc-on");
        keyDown(code);
        activeTouches.set(t.identifier, {
          end: () => { elem.classList.remove("itc-on"); keyUp(code); },
        });
      }
    }, { passive: false });
  }

  // D-pad: one owning touch; radial 8-way hit zones; sliding retargets
  function bindDpad(elem) {
    let ownerId = null;
    let mask = 0;
    let rect = null;

    function applyMask(next) {
      const changed = mask ^ next;
      if (!changed) return;
      for (const bit of [DIR_U, DIR_D, DIR_L, DIR_R]) {
        if (!(changed & bit)) continue;
        const code = DIR_CODE[bit];
        if (next & bit) { keyDown(code); arrowEls[bit].classList.add("itc-on"); }
        else { keyUp(code); arrowEls[bit].classList.remove("itc-on"); }
      }
      mask = next;
    }

    function maskFromPoint(x, y) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r < rect.width * 0.14) return 0; // dead zone in the hub
      const ang = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
      return SECTORS[Math.round(ang / 45) % 8];
    }

    elem.addEventListener("touchstart", (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (ownerId !== null || activeTouches.has(t.identifier)) continue;
        ownerId = t.identifier;
        rect = elem.getBoundingClientRect();
        applyMask(maskFromPoint(t.clientX, t.clientY));
        activeTouches.set(t.identifier, {
          move: (tt) => applyMask(maskFromPoint(tt.clientX, tt.clientY)),
          end: () => { ownerId = null; applyMask(0); },
        });
      }
    }, { passive: false });
  }

  function build() {
    if (root) return;

    updateDirCodes();

    // Diagnostic: one console line that proves which build is running and
    // which key codes each overlay control will dispatch. If a device ever
    // serves a stale cached touch.js, its missing/outdated BUILD log makes
    // that immediately visible instead of looking like a mystery bug.
    try {
      console.log("[touch] " + BUILD + " bindings=" + JSON.stringify(BINDINGS));
    } catch { /* diagnostics must never break the overlay */ }

    const style = document.createElement("style");
    style.id = "ikemen-touch-style";
    style.textContent = CSS;
    document.head.appendChild(style);
    document.documentElement.classList.add("itc-touch-active");

    root = el("div");
    root.id = "ikemen-touch";

    // D-pad
    dpadEl = el("div", "itc-dpad");
    arrowEls = {};
    for (const [bit, left, top, rot] of [
      [DIR_U, "50%", "16%", 0], [DIR_R, "84%", "50%", 90],
      [DIR_D, "50%", "84%", 180], [DIR_L, "16%", "50%", 270],
    ]) {
      const a = el("span", "itc-ar", "\u25B2"); // ▲
      a.style.left = left;
      a.style.top = top;
      a.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
      dpadEl.appendChild(a);
      arrowEls[bit] = a;
    }
    bindDpad(dpadEl);
    root.appendChild(dpadEl);

    // Action buttons — two arcs
    const btns = el("div", "itc-btns");
    for (const b of getButtons()) {
      const btn = el("div", "itc-btn", b.label);
      btn.dataset.code = b.code;
      btn.style.right = `calc(var(--tu) * ${(b.cx - 0.5).toFixed(2)})`;
      btn.style.bottom = `calc(var(--tu) * ${(b.cy - 0.5).toFixed(2)})`;
      bindPressable(btn, b.code);
      btns.appendChild(btn);
    }
    root.appendChild(btns);

    // START + ESC pills, top-center
    const meta = el("div", "itc-meta");
    const esc = el("div", "itc-pill", "ESC");
    bindPressable(esc, "Escape");
    const start = el("div", "itc-pill", "START");
    bindPressable(start, BINDINGS.Start);
    meta.appendChild(esc);
    meta.appendChild(start);
    root.appendChild(meta);

    document.body.appendChild(root);

    // Shared move/end routing for every tracked touch
    window.addEventListener("touchmove", onRootTouchMove, { passive: false });
    window.addEventListener("touchend", onRootTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onRootTouchEnd, { passive: true });

    // Release all held keys when the tab loses focus
    const panic = () => {
      activeTouches.clear();
      releaseAll();
      clearVisualPressed();
    };
    window.addEventListener("blur", panic);
    document.addEventListener("visibilitychange", () => { if (document.hidden) panic(); });
  }

  function clearVisualPressed() {
    if (!root) return;
    for (const n of root.querySelectorAll(".itc-on")) n.classList.remove("itc-on");
  }

  function destroy() {
    releaseAll();
    activeTouches.clear();
    if (root) {
      root.remove();
      root = null;
    }
    const style = document.getElementById("ikemen-touch-style");
    if (style) style.remove();
    document.documentElement.classList.remove("itc-touch-active");
    window.removeEventListener("touchmove", onRootTouchMove);
    window.removeEventListener("touchend", onRootTouchEnd);
    window.removeEventListener("touchcancel", onRootTouchEnd);
  }

  // ---- Public API ----
  window.__ikemenTouch = {
    build,
    destroy,
    state: () => [...held.keys()],
  };
})();
