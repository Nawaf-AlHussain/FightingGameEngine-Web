// measure-first-boot.mjs — quantify the phone "first match start refreshes the page" report.
//
// Drives the REAL first-time flow for a not-yet-cached character in ONE page realm
// (exactly what a phone does):
//   1. /match-prep?p1=<char>  → readiness pass runs downloadCharacterToCache()
//      (whole-character accumulation + one-shot IDB write)
//   2. auto-countdown (or FIGHT) → SPA-navigates to /play → vfs init + WASM compile
//      + IDB full read + VFS inject + engine boot   ← the "first attempt"
//   3. page.reload() → /play boots again with the char in IDB and HTTP caches warm
//      ← the "second attempt" (what the browser's auto-reload lands on)
//
// JS heap (performance.memory) is sampled every 300ms; peaks are reported per phase.
// Desktop RAM is plentiful, so nothing gets killed here — the point is the MAGNITUDE
// of each phase vs a phone renderer's budget (~400-700MB).

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const CHAR = process.env.CHAR || 'charsMARVEL/Cyclops'; // 29MB, 10 files
const OUT = process.env.OUT || '/home/z/my-project/scripts/first-boot-heap.csv';

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

page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message.slice(0, 200)));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('error') || t.includes('Error') || t.includes('BOOT')) console.log('CONSOLE: ' + t.slice(0, 200));
});

let phase = 'match-prep';
const t0 = Date.now();
const rows = [];
let peak = { used: 0, phase: '', t: 0 };
let stop = false;

async function sampler() {
  while (!stop) {
    try {
      const h = await page.evaluate(() => {
        const m = performance.memory;
        const c = document.querySelector('canvas#ikemen-canvas');
        return {
          used: m ? m.usedJSHeapSize : 0,
          total: m ? m.totalJSHeapSize : 0,
          canvas: !!c && c.width > 0,
          url: location.pathname + location.search.slice(0, 40),
        };
      });
      const t = Math.round((Date.now() - t0) / 1000);
      // Phase tracking by URL
      if (phase === 'match-prep' && h.url.startsWith('/play')) phase = 'play-cold';
      rows.push({ t, phase, ...h });
      if (h.used > peak.used) peak = { used: h.used, phase, t };
      if (t % 5 === 0) console.log(`t=${String(t).padStart(3)}s [${phase}] heap=${(h.used / 1048576).toFixed(0)}MB canvas=${h.canvas}`);
    } catch { /* page busy */ }
    await new Promise(r => setTimeout(r, 300));
  }
}

console.log('== PHASE 1: match-prep (cold, char NOT cached) ==');
console.log('URL: ' + matchPrepUrl);
const s = sampler();
await page.goto(matchPrepUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the FIGHT button to become enabled (allReady) — or auto-countdown navigation.
const fightReady = page.locator('.match-prep__buttons button:not([disabled])', { hasText: 'FIGHT' });
try {
  await fightReady.waitFor({ state: 'visible', timeout: 240000 });
  console.log('>> FIGHT button enabled (assets ready). Heap peak so far: ' + (peak.used / 1048576).toFixed(0) + 'MB');
  // Click to go immediately (don't wait the countdown).
  await fightReady.click({ timeout: 5000 }).catch(() => {});
} catch {
  console.log('>> FIGHT never became ready in 240s — continuing (may have auto-navigated)');
}

// Wait for SPA arrival at /play
for (let i = 0; i < 60 && !page.url().includes('/play'); i++) await page.waitForTimeout(500);
console.log('== PHASE 2: /play first boot (cold caches + download residue in realm) ==');

// Wait for engine canvas, then 12s more (SFF decode into WASM heap)
const coldCanvasAt = await (async () => {
  for (let i = 0; i < 480; i++) {
    const ok = await page.evaluate(() => {
      const c = document.querySelector('canvas#ikemen-canvas');
      return !!c && c.width > 0;
    }).catch(() => false);
    if (ok) return Math.round((Date.now() - t0) / 1000);
    await page.waitForTimeout(500);
  }
  return -1;
})();
console.log(`>> canvas appeared at t=${coldCanvasAt}s`);
await page.waitForTimeout(12000);

const coldPeak = peak.used;
const coldPeakPhase = peak.phase;
console.log(`>> FIRST-ATTEMPT PEAK: ${(coldPeak / 1048576).toFixed(0)}MB (phase=${coldPeakPhase})`);

console.log('== PHASE 3: page.reload() — the "second attempt" the browser lands on ==');
await page.reload({ waitUntil: 'domcontentloaded' });
phase = 'play-warm';
peak = { used: 0, phase: '', t: 0 };
for (let i = 0; i < 480; i++) {
  const ok = await page.evaluate(() => {
    const c = document.querySelector('canvas#ikemen-canvas');
    return !!c && c.width > 0;
  }).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(12000);
console.log(`>> SECOND-ATTEMPT PEAK: ${(peak.used / 1048576).toFixed(0)}MB (phase=${peak.phase})`);

stop = true;
await s;

// CSV dump
const fs = await import('fs');
fs.writeFileSync(OUT, 't_sec,phase,usedMB,totalMB,canvas\n' +
  rows.map(r => `${r.t},${r.phase},${(r.used / 1048576).toFixed(1)},${(r.total / 1048576).toFixed(1)},${r.canvas}`).join('\n'));
console.log('CSV written: ' + OUT);

await browser.close();
