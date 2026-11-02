// stress-deployment.mjs — stale-state matrix + error paths + concurrency
// against the LIVE deployment (BASE, default https://open-fighter.vercel.app).
//
// Where F-051 hid: fresh-context suites can never see stale persisted state.
// This suite runs the boot matrix a returning player can be in:
//   1 fresh          — control boot to canvas
//   2 stale-config   — localStorage config naming scrubbed icons (F-051)
//   3 legacy-idb     — pre-rename `ikemen-mods` IndexedDB must migrate to
//                      `engine-mods` and keep its files
//   4 mid-boot-reload— reload mid-boot; the abrupt-boot watchdog must recover
//   5 bad-char       — /play with a roster-missing p1 must fail GRACEFULLY
//   6 no-params      — /play without match params must fail gracefully
// plus a 6-way concurrent boot, an HTTP asset sweep and API guard checks.
// Boot success = canvas#ikemen-canvas. Panics/native dialogs = hard fail.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE || 'https://open-fighter.vercel.app';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// Char refs are source-qualified (charRef: "<source>/<id>" for non-default
// sources) — bare ids never match the roster manifest.
const MATCH = '/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade';
const STALE_B64 = Buffer.from(
  readFileSync(join(REPO, 'public/game/engine-fs/file/save/config.ini'), 'utf8')
    .replace(/icon_(256|96|48)\.png/g, 'IkemenCylia_$1.png')
).toString('base64');

const PANIC_RE = /Panic:|ENGINE CRASHED|Icon file can not be found|fatal error:/i;

async function bootCase(name, { seedStale = false, seedLegacyIdb = false, url = MATCH, reloadAtMarker = false } = {}) {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  if (seedStale) {
    await ctx.addInitScript((b64) => {
      localStorage.setItem('engine-vfs12:save/config.ini', b64);
    }, STALE_B64);
  }
  if (seedLegacyIdb) {
    await ctx.addInitScript(() => {
      const open = (name) => new Promise((res) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore('files'); } catch (e) {} };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      (async () => {
        const db = await open('ikemen-mods'); // legacy name, pre-rename install
        if (!db) return;
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(
          new TextEncoder().encode('legacy-mod-stub-for-migration'), 'mods/migrated.txt'
        );
      })();
    });
  }
  const page = await ctx.newPage();
  const lines = [];
  let dialogs = 0;
  page.on('console', (m) => lines.push(m.text()));
  page.on('pageerror', (e) => lines.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { dialogs++; lines.push('[native dialog] ' + d.message()); d.dismiss().catch(() => {}); });

  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });

  if (reloadAtMarker) {
    try {
      await page.waitForFunction(
        () => (window.__bootLog || []).some?.((l) => /game\.pak \+ engine\.wasm/i.test(l)),
        { timeout: 60000 }
      );
    } catch {
      // __bootLog not exposed — fall back to a timed reload mid-boot
      await page.waitForTimeout(6000);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Measure only the POST-reload boot: the dying context's teardown race
    // (reload mid-VFS-syscall -> syscall.mapJSError panic, exit 2) is noise
    // from the abandoned boot, auto-recovered by this fresh one.
    lines.length = 0;
  }

  let booted = false;
  try {
    await page.waitForSelector('canvas#ikemen-canvas', { timeout: 150000 });
    booted = true;
  } catch { /* canvas never appeared */ }

  let migrated = null;
  if (seedLegacyIdb && booted) {
    migrated = await page.evaluate(async () => {
      const out = {};
      for (const name of ['engine-mods', 'ikemen-mods']) {
        out[name] = await new Promise((res) => {
          const r = indexedDB.open(name, 1);
          r.onupgradeneeded = () => { try { r.result.createObjectStore('files'); } catch (e) {} };
          r.onsuccess = async () => {
            try {
              const cur = r.result.transaction('files', 'readonly').objectStore('files').openCursor();
              cur.onsuccess = () => res(!!cur.result);
              cur.onerror = () => res(false);
            } catch (e) { res(false); }
          };
          r.onerror = () => res(false);
        });
      }
      return out;
    }).catch(() => null);
  }

  const panicked = lines.some((t) => PANIC_RE.test(t));
  const bootErr = lines.some((t) => /BOOT ERROR/i.test(t));
  const fight = lines.some((t) => /P1 ready|Engine starting/i.test(t));
  const errLines = lines.filter((t) => /\berror\b|warn|fail|panic|crash|404|403|500/i.test(t) && !/react-devtools|hmr/i.test(t));
  const ms = Date.now() - t0;
  console.log(`[${name}] booted=${booted} panicked=${panicked} dialogs=${dialogs} bootErr=${bootErr} fight=${fight}` +
    (migrated ? ` engine-mods=${migrated['engine-mods']} legacy-still=${migrated['ikemen-mods']}` : '') +
    ` ${ms}ms`);
  for (const t of errLines.slice(0, 6)) console.log('   |', t.slice(0, 150));
  await browser.close();
  return { name, booted, panicked, dialogs, bootErr, errLines, ms };
}

// ── 1..6: the stale-state matrix (sequential — each is a full boot) ──────
const results = [];
results.push(await bootCase('1 fresh', {}));
results.push(await bootCase('2 stale-config (F-051)', { seedStale: true }));
results.push(await bootCase('3 legacy-idb migration', { seedLegacyIdb: true }));
results.push(await bootCase('4 mid-boot-reload', { reloadAtMarker: true }));
results.push(await bootCase('5 bad-char (loud fail?)', { url: '/play?p1=DoesNotExist&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade' }));
results.push(await bootCase('6 no-params (graceful?)', { url: '/play' }));

// ── 7: concurrency — 6 parallel fresh boots against the live deployment ──
async function parallelBoot(i) {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const lines = [];
  let dialogs = 0;
  page.on('console', (m) => lines.push(m.text()));
  page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });
  await page.goto(`${BASE}${MATCH}`, { waitUntil: 'domcontentloaded' });
  let booted = false;
  try { await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 }); booted = true; } catch {}
  const panicked = lines.some((t) => PANIC_RE.test(t));
  await browser.close();
  console.log(`   boot#${i} booted=${booted} panicked=${panicked} dialogs=${dialogs} ${Date.now() - t0}ms`);
  return { booted, panicked, dialogs };
}
console.log('7 concurrent boots (6 parallel):');
const par = (await Promise.all([1, 2, 3, 4, 5, 6].map(parallelBoot)));

// ── 8: HTTP asset sweep + API guards ─────────────────────────────────────
console.log('8 asset sweep:');
const assets = [
  '/', '/play', '/local', '/lobby', '/about',
  '/game/vfs.js', '/game/wasm_exec.js', '/game/webrtc.js', '/game/touch.js',
  '/game/engine.wasm', '/game/engine-fs/manifest.json', '/game/engine-fs/game.pak',
  '/game/engine-fs/file/data/motif1/system.def',
];
for (const a of assets) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${a}`, { method: a.endsWith('.wasm') || a.endsWith('.pak') ? 'HEAD' : 'GET' });
    console.log(`   ${r.status} ${String(Date.now() - t0).padStart(5)}ms ${a}`);
  } catch (e) {
    console.log(`   ERR ${a}: ${e.message}`);
  }
}
console.log('9 api guards:');
for (const [label, u] of [
  ['assets-manifest', '/api/assets-manifest'],
  ['traversal guard', '/api/cdn/..%2f..%2fetc%2fpasswd'],
  ['missing char file', '/api/cdn/chars/__nope__/nope.def'],
]) {
  try {
    const r = await fetch(`${BASE}${u}`, { redirect: 'manual' });
    console.log(`   ${r.status} ${label}`);
  } catch (e) {
    console.log(`   ERR ${label}: ${e.message}`);
  }
}

// ── verdict ──────────────────────────────────────────────────────────────
console.log('\n=== VERDICT ===');
let ok = true;
const wantBoot = results.slice(0, 4);
for (const r of wantBoot) if (!r.booted || r.panicked || r.dialogs) { ok = false; console.log(`FAIL ${r.name}`); }
for (const r of results.slice(4, 6)) if (r.panicked || r.dialogs || !r.bootErr) { ok = false; console.log(`FAIL ${r.name} (must fail LOUDLY with the BOOT ERROR overlay, no panic/dialogs)`); }
if (par.some((p) => !p.booted || p.panicked || p.dialogs)) { ok = false; console.log('FAIL concurrent boots'); }
console.log(ok ? 'ALL GREEN' : 'ISSUES FOUND');
process.exit(ok ? 0 : 1);
