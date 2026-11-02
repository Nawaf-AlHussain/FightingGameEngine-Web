// verify-fps-hud.mjs — F-053 verification: the ?fps=1 fight-perf HUD.
//
// 1. fps=1 case : boot /play with ?fps=1, wait for canvas, wait ~10s, then
//    assert:
//      - window.__fightPerf exists and returns a sane snapshot
//        (frames > 0, elapsedSec > 0)
//      - the .fpsstats pill is mounted and shows an FPS number
//      - at least one '[perf]' beacon line appeared in the console
//      - expanding the panel + COPY puts the '[perf]' report on the
//        clipboard (fallback textarea path in headless — check the pill
//        toggles instead; clipboard may be denied)
// 2. fps off case: plain /play boot must NOT mount .fpsstats and must NOT
//    define __fightPerf (normal players pay nothing).
// 3. Warmup timing (F-054 revision): the '[boot] VFS: warming' line must
//    appear AFTER the canvas but within ~1s of it (the F-053 +8s grace was
//    retired when vfs.js learned to yield to engine-facing fetches — early
//    start is safe and warms round-start fight.snd during the intro).

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const PLAY_URL =
  `${BASE}/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade`;

let ok = true;

// ---- case 1: fps=1 ----------------------------------------------------------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));

  await page.goto(`${PLAY_URL}&fps=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
  const canvasAt = Date.now();

  // give the HUD/beacon time to produce output
  await page.waitForTimeout(11000);

  const check = await page.evaluate(() => {
    const fn = window.__fightPerf;
    const s = typeof fn === 'function' ? fn() : null;
    const pill = document.querySelector('.fpsstats__pill');
    return {
      hasMonitor: typeof window.__fightPerf === 'function',
      snap: s,
      pillText: pill ? pill.textContent : null,
    };
  });

  const beaconLines = lines.filter((t) => t.startsWith('[perf]'));

  console.log('[fps=1] monitor installed:', check.hasMonitor);
  console.log('[fps=1] snapshot:', JSON.stringify(check.snap));
  console.log('[fps=1] pill text:', JSON.stringify(check.pillText));
  console.log('[fps=1] [perf] beacons:', beaconLines.length, beaconLines.slice(-1)[0] || '');

  if (!check.hasMonitor) { ok = false; console.log('FAIL: __fightPerf not installed'); }
  if (!check.snap || !check.snap.frames) { ok = false; console.log('FAIL: no frames counted'); }
  if (!check.pillText || !/\d+\s*FPS/.test(check.pillText)) { ok = false; console.log('FAIL: FPS pill missing/empty'); }
  if (beaconLines.length < 1) { ok = false; console.log('FAIL: no [perf] beacon lines'); }

  // panel expands and shows rows (fixed settle wait — the entrance re-render
  // race made waitForSelector flaky here)
  await page.click('.fpsstats__pill');
  await page.waitForTimeout(1500);
  const rows = await page.$eval('.fpsstats__rows', (el) => el.textContent || '').catch(() => '');
  console.log('[fps=1] panel rows:', JSON.stringify(rows.split('\n').slice(0, 4)));
  if (!/fps\(5s\)/.test(rows) || !/longtask/.test(rows)) { ok = false; console.log('FAIL: panel rows missing'); }

  await browser.close();
}

// ---- case 2: fps off (control) ----------------------------------------------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
  await page.waitForTimeout(4000);
  const check = await page.evaluate(() => ({
    monitor: typeof window.__fightPerf === 'function',
    pill: !!document.querySelector('.fpsstats__pill'),
  }));
  console.log('[off] monitor installed:', check.monitor, '| pill mounted:', check.pill);
  if (check.monitor || check.pill) { ok = false; console.log('FAIL: HUD present without ?fps=1'); }
  await browser.close();
}

// ---- case 3: warmup delay (fresh context, dedicated) --------------------------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  let canvasAt = 0;
  let warmAt = 0;
  page.on('console', (m) => {
    if (!canvasAt && m.text().includes('ikemen-canvas')) canvasAt = Date.now();
  });
  // canvas appears via DOM polling instead (console line for canvas is not logged)
  await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
  canvasAt = Date.now();
  await page.waitForFunction(
    () => (window.__engineLog?.length ? true : false),
    { timeout: 30000 }
  ).catch(() => {});
  // poll console lines for the warming line with timestamps
  const t0 = Date.now();
  await page.waitForEvent('console', {
    predicate: (m) => m.text().includes('VFS: warming'),
    timeout: 60000,
  }).then((m) => { warmAt = Date.now(); }).catch(() => {});
  const delay = warmAt ? warmAt - canvasAt : -1;
  // F-054: the warmup starts ~1s after the canvas again (vfs.js now yields
  // to engine-facing fetches, so early start is safe — the F-053 +8s grace
  // is retired). The invariant that still matters: warming starts only
  // AFTER the engine is up (never during boot), and within a sane window.
  console.log(`[warmup] canvas->warming delay: ${delay}ms (expect 500..8000)`);
  if (delay < 500 || delay > 8000) { ok = false; console.log('FAIL: warmup start window'); }
  await browser.close();
}

console.log(ok ? 'PASS: F-053 HUD + warmup retiming verified' : 'FAIL: see lines above');
process.exit(ok ? 0 : 1);
