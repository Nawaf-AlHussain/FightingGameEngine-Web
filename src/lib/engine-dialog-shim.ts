// F-050 — engine error dialogs must never open a browser popup.
//
// Root cause: the wasm binary's Go panic handler surfaces fatal errors by
// calling js.Global().Call("alert", "I.K.E.M.E.N Error\n\n" + msg) — a
// NATIVE Chrome dialog that (a) brands the site with the upstream engine's
// name (brand policy: zero third-party naming on user-visible surfaces) and
// (b) blocks the tab behind an unstyled modal. The F-047/F-048 sweeps
// scrubbed every console/text surface but missed this one: the alert is a
// separate channel that only fires on crashes, so the live-capture
// verification (no crash during capture) never saw it.
//
// Why suppression is safe: the engine ALSO prints every crash to
// stdout/stderr, which the vfs log bridge (window.__engineLog) captures;
// the /play death triage scans that buffer for 'Panic:' / 'fatal error:'
// lines and already reports the crash through the app's own branded error
// overlay. The native dialog is pure redundancy — a warning-only alert
// matches neither scanner pattern and stays console-visible.
//
// Scope: window.alert ONLY. The engine never calls confirm()/prompt() (no
// such call strings in the wasm); the settings menu uses native confirm()
// deliberately for the settings reset — that is a user-initiated dialog,
// not an error popup, and stays.
//
// Placement: installed at play-page MODULE scope, before wasm_exec.js
// evaluates and long before any Go code can run — covering BOTH runtime
// constructions (first boot + the net rematch's second WasmRuntime).
//
// Structural residual (needs an engine recompile, out of scope): the
// wasm-embedded default motif template still carries the branded welcome
// text; it renders only if the live motif fails to load.

let installed = false;

export function installEngineDialogShim(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // "I.K.E.M.E.N Error\n\nX" → "Engine error: X"; any other embedded brand
  // mention (module paths in panic traces, the GO variant name) → neutral.
  const brand = /I\.K\.E\.M\.E\.N(?:[ -]?Go)?|ikemen-engine|IkemenGO/gi;
  const logError = console.error.bind(console);

  window.alert = (message?: unknown): void => {
    const raw = typeof message === 'string' ? message : message == null ? '' : String(message);
    const text = raw
      .replace(brand, 'OpenFighter')
      .replace(/^OpenFighter ?Error[ :\n\r]+/i, 'Engine error: ')
      .trim() || '(empty engine alert)';
    logError('[engine] ' + text);
    // Feed the in-app triage buffer. A panic alert duplicates the stderr
    // line already captured — harmless (the scanner takes the first match).
    // ??= : if the alert fires before the vfs bridge created the buffer
    // (test harnesses, early warnings), create it so nothing is dropped;
    // if vfs reassigns its own array later, the console copy above remains.
    try {
      const g = globalThis as { __engineLog?: string[] };
      (g.__engineLog ??= []).push('[alert] ' + text);
    } catch { /* diagnostics must never throw */ }
  };
}
