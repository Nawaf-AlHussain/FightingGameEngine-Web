// verify-blob-cache.mjs — end-to-end verification of the phone first-start
// memory fixes (inflight piggyback + Blob cache writes + one-file injection).
//
// Drives the cold first-time flow in mobile emulation (iPhone viewport/UA,
// touch) for a NOT-yet-cached CDN character:
//   Phase 1  /match-prep  → downloadCharacterToCache (now Blob-based)
//   Phase 2  /play        → injectCachedCharacter (now one file at a time)
//   Phase 3  reload       → the "second attempt" (must still boot + fight)
//
// Checks:
//   A. /api/cdn/.../<char>/* network requests == exactly one per file
//      (a duplicate count would mean a double download happened).
//   B. IndexedDB record values are Blob (not Uint8Array).
//   C. /play boots from cache: "[cache] Injected N files" console line,
//      engine canvas appears, fight reaches in-fight state.
//   D. JS heap peaks per phase (vs the pre-fix baseline: prep ~34MB,
//      first boot ~207MB for Cyclops 29MB).
//   E. Reload (2nd attempt) still reaches canvas.

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const CHAR = process.env.CHAR || 'charsMARVEL/Cyclops'; // 29MB, 10 files
const charId = CHAR.split('/')[1];

const matchPrepUrl = `${BASE}/match-prep?p1=${encodeURIComponent(CHAR)}&p2=kfm&stage=stages/stage0-720.def&p2ai=4&qmode=quickvs`;

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
});
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();

// --- Instrumentation -------------------------------------------------------
const cdnRequests = new Map();   // url -> count (char file requests only)
let injectedLog = '';
page.on('request', (req) => {
  const u = req.url();
  if (u.includes(`/api/cdn/${CHAR}/`)) {
    const f = u.split(`/api/cdn/${CHAR}/`)[1];
    cdnRequests.set(f, (cdnRequests.get(f) || 0) + 1);
  }
});
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[cache]')) injectedLog += t + '\n';
  if (t.includes('error') || t.includes('Error')) console.log('CONSOLE: ' + t.slice(0, 160));
});
page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message.slice(0, 160)));

let phase = 'match-prep';
const t0 = Date.now();
const peaks = {};
const heapPeak = () => { peaks[phase] = Math.max(peaks[phase] || 0, heapNow); };
let heapNow = 0;
let stop = false;
async function sampler() {
  while (!stop) {
    try {
      const h = await page.evaluate(() => {
        const m = performance.memory;
        const c = document.querySelector('canvas#ikemen-canvas');
        return { used: m ? m.usedJSHeapSize : 0, canvas: !!c && c.width > 0 };
      });
      heapNow = h.used / 1048576;
      heapPeak();
    } catch { /* page busy */ }
    await new Promise(r => setTimeout(r, 300));
  }
}

const s = sampler();
const canvasWait = async (timeoutS = 240) => {
  for (let i = 0; i < timeoutS * 2; i++) {
    const ok = await page.evaluate(() => {
      const c = document.querySelector('canvas#ikemen-canvas');
      return !!c && c.width > 0;
    }).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

// --- Phase 1: match-prep cold download -------------------------------------
console.log('== PHASE 1: match-prep cold download (mobile emulation) ==');
await page.goto(matchPrepUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
const fightReady = page.locator('.match-prep__buttons button:not([disabled])', { hasText: 'FIGHT' });
await fightReady.waitFor({ state: 'visible', timeout: 240000 });
console.log(`>> FIGHT enabled. peak=${(peaks['match-prep'] || 0).toFixed(0)}MB, cdn files fetched=${cdnRequests.size}`);
await fightReady.click({ timeout: 5000 }).catch(() => {});
for (let i = 0; i < 60 && !page.url().includes('/play'); i++) await page.waitForTimeout(500);
phase = 'play-cold';

// --- Phase 2: /play first boot (inject from cache) --------------------------
console.log('== PHASE 2: /play first boot ==');
const okCold = await canvasWait();
heapPeak();
await page.waitForTimeout(12000); // let SFF decode + fight render
console.log(`>> canvas=${okCold} peak=${(peaks['play-cold'] || 0).toFixed(0)}MB`);
console.log('>> cache console: ' + (injectedLog.trim().split('\n').filter(l => l.includes('Injected')).join(' | ') || 'NONE'));

// B. IDB record value types
const idbCheck = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('ikemen-cache', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction('chars', 'readonly');
  const req = tx.objectStore('chars').get('charsMARVEL/Cyclops');
  const rec = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(null); });
  db.close();
  if (!rec) return { found: false };
  const vals = Object.values(rec.files);
  return {
    found: true,
    files: vals.length,
    blobs: vals.filter(v => v instanceof Blob).length,
    u8s: vals.filter(v => v instanceof Uint8Array).length,
    totalBytes: vals.reduce((a, v) => a + (v.size ?? v.byteLength ?? 0), 0),
  };
});
console.log('>> IDB record: ' + JSON.stringify(idbCheck));

// --- Phase 3: reload = the "second attempt" ---------------------------------
console.log('== PHASE 3: reload (second attempt) ==');
await page.reload({ waitUntil: 'domcontentloaded' });
phase = 'play-warm';
const okWarm = await canvasWait();
heapPeak();
await page.waitForTimeout(12000);
console.log(`>> canvas=${okWarm} peak=${(peaks['play-warm'] || 0).toFixed(0)}MB`);

stop = true; await s;

// --- Report ------------------------------------------------------------------
const dupFiles = [...cdnRequests.entries()].filter(([, n]) => n > 1);
console.log('\n===== VERDICT =====');
console.log(`A. char file requests: ${cdnRequests.size} unique, ${[...cdnRequests.values()].reduce((a, b) => a + b, 0)} total; duplicates: ${dupFiles.length ? JSON.stringify(dupFiles) : 'NONE'}`);
console.log(`B. IDB values: ${idbCheck.blobs} Blob / ${idbCheck.u8s} Uint8Array of ${idbCheck.files} (${((idbCheck.totalBytes || 0) / 1048576).toFixed(1)}MB)`);
console.log(`C. cache-inject log seen: ${injectedLog.includes('Injected') ? 'YES' : 'NO'}; cold canvas: ${okCold}`);
console.log(`D. heap peaks MB: ${JSON.stringify(Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, Math.round(v)])))} (pre-fix baseline: match-prep 34, play-cold 207)`);
console.log(`E. warm canvas: ${okWarm}`);

await browser.close();
