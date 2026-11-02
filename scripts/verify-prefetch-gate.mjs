// verify-prefetch-gate.mjs — F-054 verification: the vfs.js background
// prefetch must never delay an engine-facing lazy open, and must warm the
// fight-critical files before the engine asks for them.
//
// Observable invariants on a cold-context production-server boot:
//  1. warmup starts shortly AFTER the canvas (0.5s..8s window — F-054
//     retimed the F-053 +8s grace back down to ~1s, now safe because
//     background fetches yield to engine-facing ones).
//  2. data/fight.snd — the engine's round-start announcer/sfx bank and the
//     one BIG lazy file the engine itself opens mid-fight — is warmed by
//     the background warmup during the round intro (fetch starts within 5s
//     of the canvas), so the engine's own open at round start resolves
//     from `contents` instead of blocking the game loop on a multi-MB
//     download. (F-054 exempts fight-critical files from the memory cap,
//     which previously skipped fight.snd on constrained devices — incl.
//     headless — and forced a cold round-start open EVERY session.)
//  3. engine-facing small opens during the fight (fight.def, lifebar font
//     defs) complete in milliseconds (<250ms each on localhost).
//  4. the warmup makes real progress inside the fight window (>=25 unique
//     lazy files warmed in 40s). NOTE: on a saturated headless main thread
//     the engine hogs nearly every gap, so bg fetch completions trickle
//     (~1-2s apart) — asserting FULL completion here would measure the
//     sandbox CPU, not the gate; the complete line is reported info-only.

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const PLAY_URL =
  `${BASE}/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade`;

let ok = true;
const fail = (msg) => { ok = false; console.log('FAIL: ' + msg); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(() => {
  window.__diag = { t0: performance.now(), canvasAt: 0, fetches: [] };
  const D = window.__diag;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const t = performance.now();
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const res = await origFetch(input, init);
    D.fetches.push({
      t: t - D.t0, ms: Math.round(performance.now() - t), status: res.status,
      url: url.replace(/^https?:\/\/[^/]+/, ''),
    });
    return res;
  };
});

const page = await ctx.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push({ t: Date.now(), text: m.text() }));
page.on('pageerror', (e) => fail('pageerror: ' + String(e.message).slice(0, 160)));

await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded' });
const canvasWall = Date.now();
await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
await page.evaluate(() => { window.__diag.canvasAt = performance.now(); });
await page.waitForTimeout(40000);

const d = await page.evaluate(() => {
  const D = window.__diag;
  return {
    canvasAt: D.canvasAt,
    allFetches: D.fetches.slice(),
    fetches: D.fetches.filter((f) => f.t >= D.canvasAt),
  };
});

// 1. warmup start window (console wall clock vs canvas wall clock)
const warm = consoleLines.find((l) => l.text.includes('VFS: warming'));
if (!warm) fail('no "VFS: warming" console line');
else {
  const delay = warm.t - canvasWall;
  console.log(`[1] canvas->warming: ${delay}ms (expect 500..8000)`);
  if (delay < 500 || delay > 8000) fail(`warmup start window off: ${delay}ms`);
}

// 2. fight.snd warmed at vfs-init time (F-054): the fetch must START during
//    boot — before the canvas +1s (the boot window's network-idle wasm
//    compile phase) — so the engine's round-start open dedupes against it.
const fightSnd = d.allFetches.filter((f) => f.url.includes('data/fight.snd'));
if (!fightSnd.length) fail('data/fight.snd never fetched');
else {
  const f = fightSnd[0];
  console.log(`[2] fight.snd: starts t=${Math.round(f.t)}ms (canvas at ${Math.round(d.canvasAt)}ms), ${f.ms}ms, ${fightSnd.length} fetch(es)`);
  if (f.t > d.canvasAt + 1000) fail(`fight.snd not warmed at init: starts t=${Math.round(f.t)}ms`);
  if (f.ms > 1000) fail(`fight.snd slow on localhost: ${f.ms}ms`);
}

// 3. engine-facing small opens are fast
const smallOpens = d.fetches.filter((f) =>
  /fight\.def|fonts\/(Timer|Round|PowerbarNum|HitNum|Menu2)\.def/.test(f.url) && f.status === 200);
if (smallOpens.length < 3) fail(`too few engine small opens observed: ${smallOpens.length}`);
else {
  const worst = Math.max(...smallOpens.map((f) => f.ms));
  console.log(`[3] engine small opens: ${smallOpens.length}, worst ${worst}ms (expect < 250)`);
  if (worst >= 250) fail(`engine small open too slow: ${worst}ms`);
}

// 4. warmup progress in the fight window (unique lazy files warmed)
const lazyWarmed = new Set(
  d.fetches.filter((f) => f.url.includes('engine-fs/file/') && f.status === 200)
    .map((f) => f.url.split('?')[0])
);
const done = consoleLines.find((l) => l.text.includes('background prefetch complete'));
console.log(`[4] unique lazy files warmed: ${lazyWarmed.size} (expect >= 25) | complete line: ${done ? 'yes' : 'no (info: headless main thread saturates bg completions)'}`);
if (lazyWarmed.size < 25) fail(`warmup progressed too little: ${lazyWarmed.size} files in 40s`);

// boot sanity: engine produced some output
const engineLogLen = await page.evaluate(() => (globalThis.__engineLog || []).length);
console.log(`[5] engine log lines: ${engineLogLen}`);
if (engineLogLen < 5) fail('engine produced almost no log output — boot may have failed');

await browser.close();
console.log(ok ? 'PASS: F-054 prefetch gate verified' : 'FAIL: see lines above');
process.exit(ok ? 0 : 1);
