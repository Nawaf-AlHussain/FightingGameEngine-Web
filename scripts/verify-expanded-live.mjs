// Live headless verification for the stage-fit modes: boots the real engine
// on UIU_Fountain (Broly vs Broly, AI on both sides) per mode —
//   expanded (marker '4:3'): 1280x720 canvas, fit 1088 -> 1301, bounds ±185,
//   tall (marker 'tall'):    960x720 canvas, fit 1088 -> 976 (the restored
//                            classic fitted-4:3 view),
//   wide149 (marker '14:9'): 1120x720 canvas, fit 1088 -> 1139, bounds ±266,
//   wide53 (marker '5:3'):   1200x720 canvas, fit 1088 -> 1220, bounds ±226,
//   ctl169 (marker '16:9'):  1280x720 canvas, no fit logs (byte-identical
//                            path)
// and asserts per mode:
//   1. canvas is the mode's expected framebuffer size,
//   2. [vfs] fit logs fire ONLY in the fitted modes (expected values),
//   3. screenshot band analysis: no black pillarbox/bars anywhere
//      (left/right/top/bottom bands luminance > threshold) at rest and
//      while the AI moves the camera,
//   4. cross-mode: fit logs fire only in the fitted modes.
// Stage-zoom package (fitted modes get an explicit autozoom=1 + zoomin=1.2
// def patch so the camera leans in on close action instead of being pinned
// at the fitted view): the [vfs] '<mode> stage zoom' log must fire in every
// fitted mode and NEVER in 16:9, and the band analysis keeps holding while
// the camera is zoomed in (a zoomed-in view is a subset of the fitted view).
//
// Run: node scripts/verify-expanded-live.mjs <baseUrl> <outDir> [expanded|tall|wide149|wide53|ctl169|both|all]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3210';
const OUT = process.argv[3] || '/home/z/my-project/probe-shots';
const MODE = process.argv[4] || 'both';
const MODES = {
  expanded: { marker: '4:3',  tag: 'expanded', w: 1280, h: 720, fitNeedle: 'localcoord 1088 -> 1301' },
  tall:     { marker: 'tall', tag: 'tall',     w: 960,  h: 720, fitNeedle: 'localcoord 1088 -> 976' },
  wide149:  { marker: '14:9', tag: 'wide149',  w: 1120, h: 720, fitNeedle: 'localcoord 1088 -> 1139' },
  wide53:   { marker: '5:3',  tag: 'wide53',   w: 1200, h: 720, fitNeedle: 'localcoord 1088 -> 1220' },
  ctl169:   { marker: '16:9', tag: 'ctl169',   w: 1280, h: 720, fitNeedle: null },
};
mkdirSync(OUT, { recursive: true });

const URL_PARAMS = 'p1=Broly&p2=Broly&stage=UIU_Fountain&p1ai=4&p2ai=4';
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? '  ok - ' : '  FAIL - ') + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failures.push(name);
}

async function runMode(browser, spec) {
  const { marker, tag, w: expW, h: expH, fitNeedle } = spec;
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

  // Screenshot at rest + three later frames while the AI moves the camera
  // (and zooms it — the fitted modes lean in on close action).
  // NOTE: page-clip screenshot (bounding box), NOT locator.screenshot() —
  // the element form waits for layout "stability" which a constantly
  // animating canvas never satisfies (flaky 6s timeouts).
  const shots = [];
  for (let i = 0; i < 4; i++) {
    const box = await page.locator('canvas#ikemen-canvas').boundingBox();
    const buf = await page.screenshot({ type: 'png', timeout: 20000, clip: box });
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
  check(`[${tag}] canvas is ${expW}x${expH}`, dims.w === expW && dims.h === expH, `${dims.w}x${dims.h}`);
  check(`[${tag}] no engine death`, deathLines.length === 0, deathLines.slice(0, 3).join(' | '));
  console.log(`[${tag}] [vfs] lines:\n    ` + (vfsLines.length ? vfsLines.join('\n    ') : '(none)'));
  if (fitNeedle) {
    check(`[${tag}] fit log fired (${fitNeedle})`,
      vfsLines.some((l) => l.includes(fitNeedle)), vfsLines.slice(0, 4).join(' | '));
    check(`[${tag}] stage zoom package installed (autozoom = 1, zoomin = 1.2)`,
      vfsLines.some((l) => l.includes('stage zoom: stages/') && l.includes('zoomin = 1.2')),
      vfsLines.filter((l) => l.includes('stage zoom: stages/')).slice(0, 2).join(' | ') || '(no stage zoom log)');
  } else {
    check(`[${tag}] no fit logs fire in 16:9`,
      !vfsLines.some((l) => l.includes('view fit:')), vfsLines.slice(0, 4).join(' | '));
    check(`[${tag}] no stage zoom DEF-patch logs in 16:9`,
      !vfsLines.some((l) => l.includes('stage zoom: stages/')), vfsLines.slice(0, 4).join(' | '));
  }
  await ctx.close();
  return { dims, vfsLines };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  let exp = null, ctl = null, tall = null, w149 = null, w53 = null;
  if (MODE === 'expanded' || MODE === 'both' || MODE === 'all') {
    console.log('=== EXPANDED (marker 4:3) ===');
    exp = await runMode(browser, MODES.expanded);
  }
  if (MODE === 'tall' || MODE === 'all') {
    console.log('\n=== TALL (marker tall — restored classic fitted-4:3) ===');
    tall = await runMode(browser, MODES.tall);
  }
  if (MODE === 'wide149' || MODE === 'all') {
    console.log('\n=== WIDE 14:9 (marker 14:9 — ladder rung between 3:2 and 5:3) ===');
    w149 = await runMode(browser, MODES.wide149);
  }
  if (MODE === 'wide53' || MODE === 'all') {
    console.log('\n=== WIDE 5:3 (marker 5:3 — ladder rung below Expanded) ===');
    w53 = await runMode(browser, MODES.wide53);
  }
  if (MODE === 'ctl169' || MODE === 'both' || MODE === 'all') {
    console.log('\n=== CONTROL (marker 16:9) ===');
    ctl = await runMode(browser, MODES.ctl169);
  }
  if (exp && ctl) {
    console.log('\n=== CROSS-MODE ===');
    check('fit logs fire ONLY in expanded',
      exp.vfsLines.some((l) => l.includes('localcoord 1088 -> 1301')) &&
      !ctl.vfsLines.some((l) => l.includes('[vfs] expanded')),
      `expanded=${exp.vfsLines.length} ctl=${ctl.vfsLines.length} lines`);
  }
  if (tall) {
    console.log('\n=== TALL CROSS-CHECK ===');
    check('tall fit log fired (1088 -> 976, bounds kept, boundhigh -> 0)',
      tall.vfsLines.some((l) => l.includes('tall view fit') && l.includes('localcoord 1088 -> 976')) &&
      tall.vfsLines.some((l) => l.includes('tall camera clamp')),
      tall.vfsLines.slice(0, 4).join(' | '));
  }
  if (w149) {
    console.log('\n=== 14:9 CROSS-CHECK ===');
    check('14:9 fit log fired (1088 -> 1139, bounds ±292 -> ±266, boundhigh -> 0)',
      w149.vfsLines.some((l) => l.includes('14:9 view fit') && l.includes('localcoord 1088 -> 1139')) &&
      w149.vfsLines.some((l) => l.includes('14:9 pan clamp') && l.includes('-292 -> -266')) &&
      w149.vfsLines.some((l) => l.includes('14:9 camera clamp')),
      w149.vfsLines.slice(0, 4).join(' | '));
  }
  if (w53) {
    console.log('\n=== 5:3 CROSS-CHECK ===');
    check('5:3 fit log fired (1088 -> 1220, bounds ±292 -> ±226, boundhigh -> 0)',
      w53.vfsLines.some((l) => l.includes('5:3 view fit') && l.includes('localcoord 1088 -> 1220')) &&
      w53.vfsLines.some((l) => l.includes('5:3 pan clamp') && l.includes('-292 -> -226')) &&
      w53.vfsLines.some((l) => l.includes('5:3 camera clamp')),
      w53.vfsLines.slice(0, 4).join(' | '));
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
