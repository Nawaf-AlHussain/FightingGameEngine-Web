// verify-engine-dialog.mjs — verifies F-050: the engine's Go panic handler
// can no longer open a NATIVE browser dialog, and no brand text escapes.
//
// The wasm binary surfaces fatal errors via js alert("I.K.E.M.E.N Error\n\n…").
// The play page replaces window.alert at MODULE scope (engine-dialog-shim):
//   A) A simulated engine alert opens NO dialog; the scrubbed message lands
//      in the console ("[engine] Engine error: …") and in __engineLog — the
//      buffer the death triage scans for 'Panic:' / 'fatal error:'.
//   B) A non-brand alert passes through structurally intact (prefix added,
//      message preserved).
//   C) window.confirm is NOT shimmed — the settings reset relies on it; a
//      native confirm dialog must still fire and resolve.
//   D) Served asset chain: manifest stamp is the F-050 stamp, and the live
//      motif (data/motif1/system.def?v=<stamp>) carries the neutral welcome
//      text with zero brand strings.

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const F050_STAMP = '3a74088d9a0f';

const results = [];
const record = (name, pass, info = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
};

let dialogsFired = 0;
let expectingConfirm = false;
let confirmDialogSeen = false;

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('dialog', async (d) => {
  if (expectingConfirm && d.type() === 'confirm') {
    confirmDialogSeen = true;
    try { await d.accept(); } catch { /* already handled */ }
    return;
  }
  dialogsFired++;
  try { await d.dismiss(); } catch { /* already gone */ }
});

const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));

await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
// The shim installs at route-chunk evaluation — hydration is plenty.
await page.waitForSelector('body', { timeout: 15000 });
await page.waitForTimeout(1500);

// --- A: brand-bearing engine alert → no dialog, scrubbed, triage-visible ---
const beforeLog = await page.evaluate(() => ((globalThis).__engineLog || []).length);
await page.evaluate(() => window.alert('I.K.E.M.E.N Error\n\nPanic: shim probe 123'));
await page.waitForTimeout(300);
const logTail = await page.evaluate(() => ((globalThis).__engineLog || []).slice(-3).join(' | '));
record('A1: no native dialog opened', dialogsFired === 0, `${dialogsFired} dialogs`);
record('A2: console got scrubbed line',
  consoleLines.some((l) => l.includes('[engine] Engine error: Panic: shim probe 123')));
record('A3: __engineLog got triage-visible line',
  logTail.includes('[alert] Engine error: Panic: shim probe 123'), logTail.slice(0, 120));

// --- B: non-brand alert preserved (prefix only) ---
const consoleBefore = consoleLines.length;
await page.evaluate(() => window.alert('Roster manifest HTTP 404'));
await page.waitForTimeout(300);
record('B: non-brand alert intact',
  consoleLines.slice(consoleBefore).some((l) => l.includes('[engine] Roster manifest HTTP 404')));

// --- C: native confirm() untouched ---
expectingConfirm = true;
const confirmResult = await page.evaluate(() => window.confirm('Reset all settings?'));
await page.waitForTimeout(300);
expectingConfirm = false;
record('C1: native confirm still fires', confirmDialogSeen);
record('C2: native confirm resolves true on accept', confirmResult === true);

// --- D: served asset chain (stamp + scrubbed motif over HTTP) ---
const manifest = await (await fetch(`${BASE}/game/engine-fs/manifest.json`, { cache: 'no-store' })).json();
record('D1: manifest stamp is F-050', manifest.stamp === F050_STAMP, manifest.stamp);
const def = await (await fetch(`${BASE}/game/engine-fs/file/data/motif1/system.def?v=${manifest.stamp}`)).text();
record('D2: live motif welcome is neutral', def.includes('Welcome to OpenFighter!'));
record('D3: live motif has zero brand strings',
  !/I\.K\.E\.M\.E\.N|Ikemen|Mugen|MUGEN/i.test(def.replace(/ikemenversion|ikemenVersion/g, '')));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
