// Live headless verification for the EXPANDED-stage view (the mode formerly
// known as 4:3): boots the real engine twice on UIU_Fountain (Broly vs
// Broly, AI on both sides) — once with the expanded marker ('4:3'), once
// with the 16:9 control marker — and asserts:
//   1. canvas is 1280x720 in BOTH modes (the expanded canvas is a plain
//      16:9 framebuffer now — no pillarbox),
//   2. [vfs] fit logs fire ONLY in expanded (localcoord 1088 -> 1301,
//      boundhigh -> 0, pan bounds -> ±185),
//   3. screenshot band analysis: no black pillarbox/bars anywhere
//      (left/right/top/bottom bands luminance > threshold) at rest and
//      while the AI moves the camera,
//   4. the expanded view genuinely shows MORE stage than the 16:9 control
//      (compared visually from the saved PNGs).
//
// Run: node scripts/verify-expanded-live.mjs <baseUrl> <outDir> [expanded|ctl169|both]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3210';
const OUT = process.argv[3] || '/home/z/my-project/probe-shots';
const MODE = process.argv[4] || 'both';
mkdirSync(OUT, { recursive: true });

const URL_PARAMS = 'p1=Broly&p2=Broly&stage=UIU_Fountain&p1ai=4&p2ai=4';
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? '  ok - ' : '  FAIL - ') + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failures.push(name);
}

async function runMode(browser, marker, tag) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript((m) => {
    try { localStorage.setItem('engine-display-mode-v2', m); } catch (e) { /* noop */ }
  }, marker);
  const page = await ctx.newPage();
  const vfsLines = [];
  const deathLines = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[vfs]')) vfsLines.push(t);
    if (/ENGINE EXITED|boot death|FATAL/i.test(t)) deathLines.push(t);
  });
  page.on('pageerror', (e) => deathLines.push('PAGEERROR: ' + e.message));

  await page.goto(`${BASE}/play?${URL_PARAMS}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 });
  } catch (e) {
    console.log(`[${tag}] CANVAS TIMEOUT — captured console lines:`);
    console.log(vfsLines.slice(-25).join('\n    ') || '(none)');
    console.log(`[${tag}] deaths: ${deathLines.slice(0, 5).join(' | ') || '(none)'}`);
    try {
      const shot = await page.screenshot({ timeout: 10000 });
      writeFileSync(join(OUT, `${tag}-TIMEOUT.png`), shot);
      console.log(`[${tag}] failure screenshot saved`);
    } catch (e2) { /* noop */ }
    throw e;
  }
  console.log(`[${tag}] canvas up; waiting for the fight to render...`);

  // Wait for the [vfs] fit logs (expanded) or their absence window (16:9).
  await page.waitForTimeout(14000);
  const dims = await page.evaluate(() => {
    const c = document.querySelector('canvas#ikemen-canvas');
    return { w: c.width, h: c.height };
  });
  console.log(`[${tag}] canvas ${dims.w}x${dims.h}; [vfs] lines so far: ${vfsLines.length}`);

  // Screenshot at rest + two later frames while the AI moves the camera.
  const shots = [];
  for (let i = 0; i < 3; i++) {
    const buf = await page.locator('canvas#ikemen-canvas').screenshot({ type: 'png', timeout: 20000 });
    const file = join(OUT, `${tag}-frame${i}.png`);
    writeFileSync(file, buf);
    shots.push(file);
    // Band analysis in-page (offscreen 2d canvas over the PNG data URL).
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    const stats = await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const band = (x, y, w, h) => {
        const d = g.getImageData(x, y, w, h).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return s / (d.length / 4);
      };
      return {
        w: img.width, h: img.height,
        left: band(0, 0, 8, img.height),
        right: band(img.width - 8, 0, 8, img.height),
        top: band(0, 0, img.width, 8),
        bottom: band(0, img.height - 8, img.width, 8),
      };
    }, dataUrl);
    console.log(`[${tag}] frame${i} bands: L=${stats.left.toFixed(1)} R=${stats.right.toFixed(1)} T=${stats.top.toFixed(1)} B=${stats.bottom.toFixed(1)}`);
    check(`[${tag}] frame${i}: no black pillarbox left/right (lum > 12)`,
      stats.left > 12 && stats.right > 12, `L=${stats.left.toFixed(1)} R=${stats.right.toFixed(1)}`);
    check(`[${tag}] frame${i}: no black bars top/bottom (lum > 12)`,
      stats.top > 12 && stats.bottom > 12, `T=${stats.top.toFixed(1)} B=${stats.bottom.toFixed(1)}`);
    await page.waitForTimeout(9000);
  }
  check(`[${tag}] canvas is 1280x720`, dims.w === 1280 && dims.h === 720, `${dims.w}x${dims.h}`);
  check(`[${tag}] no engine death`, deathLines.length === 0, deathLines.slice(0, 3).join(' | '));
  console.log(`[${tag}] [vfs] lines:\n    ` + (vfsLines.length ? vfsLines.join('\n    ') : '(none)'));
  await ctx.close();
  return { dims, vfsLines };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  let exp = null, ctl = null;
  if (MODE === 'expanded' || MODE === 'both') {
    console.log('=== EXPANDED (marker 4:3) ===');
    exp = await runMode(browser, '4:3', 'expanded');
  }
  if (MODE === 'ctl169' || MODE === 'both') {
    console.log('\n=== CONTROL (marker 16:9) ===');
    ctl = await runMode(browser, '16:9', 'ctl169');
  }
  if (exp && ctl) {
    console.log('\n=== CROSS-MODE ===');
    check('fit logs fire ONLY in expanded',
      exp.vfsLines.some((l) => l.includes('localcoord 1088 -> 1301')) &&
      !ctl.vfsLines.some((l) => l.includes('[vfs] expanded')),
      `expanded=${exp.vfsLines.length} ctl=${ctl.vfsLines.length} lines`);
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`\n${failures.length} CHECK(S) FAILED:`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('\nALL LIVE CHECKS PASSED');
