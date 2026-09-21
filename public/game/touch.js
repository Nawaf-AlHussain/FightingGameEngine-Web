// touch.js -- virtual gamepad overlay for touch devices.
//
// Based on FightingGameEngine-Fiiight's web/touch.js, adapted for
// FightingGameEngine-Web's config-driven key mapping.
//
// KEY MAPPING IS CONFIG-DRIVEN, NOT HARDCODED.
// This module reads the P1 key bindings from localStorage
// ('ikemen-vfs12:save/config.ini' → [Keys_P1] section), the same source
// the Settings UI and the engine use. If the user rebinds P1 A=F in
// Settings, the touch "A" button dispatches KeyF.
//
// The engine (engine/src/system_js.go) registers "keydown"/"keyup"
// listeners on document and reads KeyboardEvent.code. This module
// dispatches synthetic KeyboardEvents with the configured codes.
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
  // ---- Default P1 bindings (shipped config.ini) ----
  // Used as fallback while the config is loading or if parsing fails.
  const DEFAULT_BINDINGS = {
    Up: "KeyW", Down: "KeyS", Left: "KeyA", Right: "KeyD",
    A: "Digit8", B: "Digit9", C: "Digit0",
    X: "KeyI", Y: "KeyO", Z: "KeyP",
    Start: "KeyU",
  };

  // ---- INI key → KeyboardEvent.code reverse map ----
  // Matches INI_KEY_TO_CODE in ikemen-config.ts
  const INI_KEY_TO_CODE = {
    a: "KeyA", b: "KeyB", c: "KeyC", d: "KeyD", e: "KeyE", f: "KeyF",
    g: "KeyG", h: "KeyH", i: "KeyI", j: "KeyJ", k: "KeyK", l: "KeyL",
    m: "KeyM", n: "KeyN", o: "KeyO", p: "KeyP", q: "KeyQ", r: "KeyR",
    s: "KeyS", t: "KeyT", u: "KeyU", v: "KeyV", w: "KeyW", x: "KeyX",
    y: "KeyY", z: "KeyZ",
    "0": "Digit0", "1": "Digit1", "2": "Digit2", "3": "Digit3", "4": "Digit4",
    "5": "Digit5", "6": "Digit6", "7": "Digit7", "8": "Digit8", "9": "Digit9",
    UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight",
    COMMA: "Comma", PERIOD: "Period", SLASH: "Slash", SEMICOLON: "Semicolon",
    EQUALS: "Equal", MINUS: "Minus", LBRACKET: "BracketLeft",
    RBRACKET: "BracketRight", BACKSLASH: "Backslash", BACKQUOTE: "Backquote",
    QUOTE: "Quote",
    RETURN: "Enter", ESCAPE: "Escape", BACKSPACE: "Backspace",
    TAB: "Tab", SPACE: "Space",
    KP_0: "Numpad0", KP_1: "Numpad1", KP_2: "Numpad2", KP_3: "Numpad3",
    KP_4: "Numpad4", KP_5: "Numpad5", KP_6: "Numpad6", KP_7: "Numpad7",
    KP_8: "Numpad8", KP_9: "Numpad9",
    KP_DIVIDE: "NumpadDivide", KP_MULTIPLY: "NumpadMultiply",
    KP_MINUS: "NumpadSubtract", KP_PLUS: "NumpadAdd",
    KP_ENTER: "NumpadEnter", KP_PERIOD: "NumpadDecimal",
    KP_EQUALS: "NumpadEqual",
    F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
    F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
    PRINTSCREEN: "PrintScreen", SCROLLLOCK: "ScrollLock", PAUSE: "Pause",
    INSERT: "Insert", HOME: "Home", PAGEUP: "PageUp",
    DELETE: "Delete", END: "End", PAGEDOWN: "PageDown",
  };

  // ---- Load P1 key bindings from localStorage config.ini ----
  function loadBindings() {
    const bindings = Object.assign({}, DEFAULT_BINDINGS);
    try {
      const raw = localStorage.getItem("ikemen-vfs12:save/config.ini");
      if (!raw) return bindings;
      const text = atob(raw);
      // Extract [Keys_P1] section
      const m = text.match(/\[Keys_P1\]([\s\S]*?)(?:\n\[|$)/);
      if (!m) return bindings;
      const lines = m[1].trim().split("\n");
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (bindings.hasOwnProperty(key) && INI_KEY_TO_CODE[val]) {
          bindings[key] = INI_KEY_TO_CODE[val];
        }
      }
    } catch { /* localStorage unavailable or parse error — use defaults */ }
    return bindings;
  }

  // ---- Current bindings (loaded once at init) ----
  let BINDINGS = DEFAULT_BINDINGS;

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
      // Mobile Chrome quirk: constructor may not set `code` properly
      if (ev.code !== code) {
        try {
          Object.defineProperty(ev, "code", { value: code, writable: false, configurable: true });
        } catch { return; }
      }
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

    // Load bindings from config before building
    BINDINGS = loadBindings();
    updateDirCodes();

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
