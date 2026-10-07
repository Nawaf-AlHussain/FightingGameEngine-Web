// keymap-probe6.mjs — UNAMBIGUOUS behavioral verification via JUMPS.
// A jump is a 25+ cell vertical launch — immune to camera pan/zoom.
//
// Canonical expectations on a simulated stale (user) device:
//   ArrowUp -> a fighter LEAPS (P1 Up=UP)      [pre-fix: nothing happened]
//   KeyI    -> a fighter LEAPS (P2 Up=i)       [pre-fix: P1 X-attack]
//   KeyW    -> NO leap (unbound now)           [pre-fix: P1 jumped!]
//
// Also reports WHICH SIDE leapt (left/right spawner) via changed-cell
// columns in the high rows.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:3210';
const GW = 96, GH = 54;
const STALE_CFG = fs.readFileSync(path.join(__dirname, 'stale-user-config.ini'), 'utf8');

const keyOf = (code) => code.startsWith('Key') ? code.slice(3).toLowerCase()
  : code.startsWith('Digit') ? code.slice(5) : code;

async function grab(page) {
  const box = await page.locator('canvas#ikemen-canvas').boundingBox();
  const buf = await page.screenshot({ clip: box, type: 'png', timeout: 20000, scale: 'css' });
  const png = PNG.sync.read(buf);
  const out = new Array(GW * GH * 4);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const sx = Math.min(png.width - 1, Math.floor((gx + 0.5) * png.width / GW));
      const sy = Math.min(png.height - 1, Math.floor((gy + 0.5) * png.height / GH));
      const si = (sy * png.width + sx) * 4, di = (gy * GW + gx) * 4;
      out[di] = png.data[si]; out[di + 1] = png.data[si + 1]; out[di + 2] = png.data[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

async function waitRoundActive(page, maxMs = 90000) {
  const t0 = Date.now();
  const topDiff = (a, b) => {
    let s = 0;
    for (let r = 0; r < 10; r++) for (let c = 30; c < 66; c++) {
      const p = (r * GW + c) * 4;
      s += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    }
    return s / (10 * 36 * 3);
  };
  let ticks = 0, prev = await grab(page);
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(700);
    const cur = await grab(page);
    if (topDiff(prev, cur) > 0.8) ticks++;
    prev = cur;
    if (ticks >= 2) break;
  }
  if (ticks < 2) throw new Error('round never active');
  await page.waitForTimeout(1500);
}

// Sample the scene while the key is held; return the highest changed-row
// (excluding HUD rows 0-9) per side + overall change magnitude.
// Transition-proof: if a frame pair differs GLOBALLY (fade/flash, mag>40),
// re-baseline instead of judging.
async function leapTest(page, code) {
  let before = await grab(page);
  await page.evaluate(([c, k]) => {
    const mk = (t) => new KeyboardEvent(t, { code: c, key: k, bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__up = () => document.dispatchEvent(mk('keyup'));
  }, [code, keyOf(code)]);
  let best = { topL: 99, topR: 99, mag: 0 };
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(150);
    const cur = await grab(page);
    let mag = 0, n = 0, topL = 99, topR = 99;
    for (let r = 10; r < 54; r++) {
      for (let c = 0; c < GW; c++) {
        const p = (r * GW + c) * 4;
        const d = Math.abs(before[p] - cur[p]) + Math.abs(before[p + 1] - cur[p + 1]) + Math.abs(before[p + 2] - cur[p + 2]);
        mag += d; n++;
        if (d > 25) {
          if (c < 48) { if (r < topL) topL = r; }
          else { if (r < topR) topR = r; }
        }
      }
    }
    mag /= n;
    if (mag > 40) { // global transition (fade/flash) — re-baseline
      before = cur;
      continue;
    }
    if (mag > best.mag) best = { topL, topR, mag };
    if (i >= 6 && best.mag > 3) break; // enough evidence
  }
  await page.evaluate(() => globalThis.__up && globalThis.__up());
  return best;
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
console.log(`========== PROBE6 (jump-based verification) ${STAMP} ==========`);

for (const code of ['ArrowUp', 'KeyI', 'KeyW']) {
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  await ctx.addInitScript((seed) => {
    localStorage.setItem('ikemen-vfs12:save/config.ini', seed);
  }, Buffer.from(STALE_CFG, 'utf8').toString('base64'));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/play?p1=kfm&p2=kfm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 });
  await page.waitForTimeout(8000);
  await waitRoundActive(page);
  await page.waitForTimeout(800);

  const r = await leapTest(page, code);
  const leaptL = r.topL < 30, leaptR = r.topR < 30; // change reached well above ground
  let verdict;
  if (!leaptL && !leaptR) verdict = 'NO LEAP';
  else verdict = (leaptL ? 'LEFT-char leapt(row ' + r.topL + ') ' : '') + (leaptR ? 'RIGHT-char leapt(row ' + r.topR + ')' : '');
  console.log(`  ${code.padEnd(10)} mag=${r.mag.toFixed(2)}  topL=${r.topL === 99 ? '--' : r.topL} topR=${r.topR === 99 ? '--' : r.topR}  -> ${verdict}`);
  await ctx.close();
}
await browser.close();
console.log('\n  EXPECT: ArrowUp -> one side leaps (P1). KeyI -> one side leaps (P2). KeyW -> NO LEAP.');
console.log('probe6 done');
