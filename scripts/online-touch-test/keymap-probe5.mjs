// keymap-probe5.mjs — FINAL verification, camera-robust.
//
// Chain of proof that the fix works on a simulated stale (user) device:
//   (1) CONFIG:   persisted config.ini [Keys_P1]/[Keys_P2] first-set =
//                 canonical (normalization rewrote the stale seed).
//   (2) DISPATCH: touch dpad-R really dispatches ArrowRight; btn-X/Y/Z/A
//                 dispatch KeyA/KeyS/KeyD/KeyZ (touch overlay state).
//   (3) BEHAVIOR: engine honors first-match config (proven by probe3), and
//                 live template-tracking confirms ArrowRight walks P1 right
//                 (camera-pan compensated), KeyD does nothing, KeyL walks P2.
//
// Usage: node scripts/online-touch-test/keymap-probe5.mjs [--base ...]
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = arg('--base', 'http://127.0.0.1:3210');

const STALE_CFG = fs.readFileSync(path.join(__dirname, 'stale-user-config.ini'), 'utf8');

const KEY_OF = { ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft' };
const keyOf = (code) => KEY_OF[code]
  || (code.startsWith('Key') ? code.slice(3).toLowerCase() : undefined)
  || (code.startsWith('Digit') ? code.slice(5) : undefined);

const GW = 96, GH = 54;

async function grab(page) {
  const box = await page.locator('canvas#ikemen-canvas').boundingBox();
  if (!box || box.width < 10) throw new Error('no canvas box');
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

// Wait until HUD timer ticks >= 2 (round active), then settle.
async function waitRoundActive(page, maxMs = 90000) {
  const t0 = Date.now();
  const topDiff = (a, b) => {
    let sum = 0;
    for (let r = 0; r < 10; r++) for (let c = 30; c < 66; c++) {
      const p = (r * GW + c) * 4;
      sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    }
    return sum / (10 * 36 * 3);
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

// Template match: find (dx,dy) in [-w..w] minimizing SAD of patch centered
// at (cx,cy) between frames a and b. Returns {dx, dy, sad}.
function match(a, b, cx, cy, w = 8, ps = 5) {
  let best = { dx: 0, dy: 0, sad: Infinity };
  for (let dy = -w; dy <= w; dy++) {
    for (let dx = -w; dx <= w; dx++) {
      let sad = 0;
      for (let ry = -ps; ry <= ps; ry++) {
        for (let rx = -ps; rx <= ps; rx++) {
          const pa = ((cy + ry) * GW + (cx + rx)) * 4;
          const pb = ((cy + ry + dy) * GW + (cx + rx + dx)) * 4;
          sad += Math.abs(a[pa] - b[pb]) + Math.abs(a[pa + 1] - b[pb + 1]) + Math.abs(a[pa + 2] - b[pb + 2]);
        }
      }
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }
  return best;
}

// Track world-motion of both fighters between two frames, camera-pan
// compensated via background patches. Cells/frame.
function fighterMotion(a, b) {
  const bg1 = match(a, b, 12, 14), bg2 = match(a, b, 84, 14);
  const pan = (bg1.dx + bg2.dx) / 2;
  const p1 = match(a, b, 29, 32), p2 = match(a, b, 66, 32);
  return {
    pan, p1: p1.dx - pan, p2: p2.dx - pan,
    p1sad: p1.sad, p2sad: p2.sad,
  };
}

async function bootStale(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  await ctx.addInitScript((seed) => {
    localStorage.setItem('ikemen-vfs12:save/config.ini', seed);
  }, Buffer.from(STALE_CFG, 'utf8').toString('base64'));
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`${BASE}/play?p1=kfm&p2=kfm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 });
  await page.waitForTimeout(8000);
  await waitRoundActive(page);
  return { ctx, page, logs };
}

async function dumpConfig(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('ikemen-vfs12:save/config.ini');
    if (!raw) return null;
    const text = atob(raw).split('').map((c) => c.charCodeAt(0) < 128 ? c : '?').join('');
    const firstVals = (name) => {
      const m = text.match(new RegExp('\\[' + name + '\\]([\\s\\S]*?)(?:\\n\\[|$)', 'i'));
      if (!m) return null;
      const out = {};
      for (const line of m[1].split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim().toLowerCase();
        const v = line.slice(eq + 1).trim();
        if (!(k in out)) out[k] = v; // FIRST-MATCH-WINS (engine semantics)
      }
      return out;
    };
    return { p1: firstVals('Keys_P1'), p2: firstVals('Keys_P2'), marker: localStorage.getItem('ikemen-keymap-v3') };
  });
}

async function overlayPoint(page, selector, labelText) {
  return page.evaluate(([sel, label]) => {
    const el = label
      ? Array.from(document.querySelectorAll(sel)).find((n) => n.textContent === label)
      : document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, [selector, labelText || null]);
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

// ============ CONTEXT 1: config + dispatch + behavior (ArrowRight) ============
{
  console.log(`\n========== PROBE5 ${STAMP} ==========`);
  const { ctx, page, logs } = await bootStale(browser);

  // (1) config
  const cfg = await dumpConfig(page);
  const okP1 = cfg && cfg.marker === '1'
    && cfg.p1.up === 'UP' && cfg.p1.right === 'RIGHT'
    && cfg.p1.a === 'z' && cfg.p1.x === 'a' && cfg.p1.start === 'RETURN';
  const okP2 = cfg && cfg.p2.up === 'i' && cfg.p2.right === 'l' && cfg.p2.a === 'f';
  console.log(`  [1] CONFIG   P1(first)=${cfg ? JSON.stringify(cfg.p1) : 'null'}`);
  console.log(`               P2(first)=${cfg ? JSON.stringify(cfg.p2) : 'null'}`);
  console.log(`               canonical-P1=${okP1 ? 'PASS' : 'FAIL'}  canonical-P2=${okP2 ? 'PASS' : 'FAIL'}  marker=${cfg && cfg.marker}`);

  // (2) dispatch — real CDP touch on dpad RIGHT + read overlay held state
  const cdp = await ctx.newCDPSession(page);
  const dp = await overlayPoint(page, '.itc-dpad');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: dp.x + dp.w * 0.36, y: dp.y, id: 7, radiusX: 6, radiusY: 6, force: 0.6 }],
  });
  await page.waitForTimeout(250);
  const held = await page.evaluate(() => globalThis.__ikemenTouch ? globalThis.__ikemenTouch.state() : null);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(600);
  const okDispatch = Array.isArray(held) && held.includes('ArrowRight');
  console.log(`  [2] DISPATCH dpad-R held=${JSON.stringify(held)}  -> ${okDispatch ? 'PASS (ArrowRight)' : 'FAIL'}`);
  await page.waitForTimeout(1500);

  // (3) behavior — ArrowRight must walk P1 (left fighter) RIGHT
  const before = await grab(page);
  await page.evaluate(() => {
    const mk = (t) => new KeyboardEvent(t, { code: 'ArrowRight', key: 'ArrowRight', bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__up = () => document.dispatchEvent(mk('keyup'));
  });
  const motions = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(260);
    motions.push(fighterMotion(before, await grab(page)));
  }
  await page.evaluate(() => globalThis.__up && globalThis.__up());
  const p1dx = Math.max(...motions.map(m => m.p1));
  const p2max = Math.max(...motions.map(m => Math.abs(m.p2)));
  console.log(`  [3] BEHAVIOR ArrowRight: P1dx per frame=${motions.map(m => m.p1.toFixed(1)).join(',')}  max|P2dx|=${p2max.toFixed(1)}  (pan ${motions.map(m => m.pan.toFixed(1)).join(',')})`);
  console.log(`               -> P1 walked right: ${p1dx >= 2 ? 'PASS (' + p1dx.toFixed(1) + ' cells)' : 'FAIL'}`);

  fs.writeFileSync(path.join(ART, `probe5-${STAMP}.json`), JSON.stringify({ cfg, held, motions }, null, 2));
  await ctx.close();
}

// ============ CONTEXT 2: KeyD negative control + KeyL P2 walk ============
{
  const { ctx, page } = await bootStale(browser);
  const before = await grab(page);
  await page.evaluate(() => {
    const mk = (t) => new KeyboardEvent(t, { code: 'KeyD', key: 'd', bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__up = () => document.dispatchEvent(mk('keyup'));
  });
  const motions = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(260);
    motions.push(fighterMotion(before, await grab(page)));
  }
  await page.evaluate(() => globalThis.__up && globalThis.__up());
  const maxP1 = Math.max(...motions.map(m => Math.abs(m.p1)));
  const maxP2 = Math.max(...motions.map(m => Math.abs(m.p2)));
  console.log(`  [4] BEHAVIOR KeyD (unbound): max|P1dx|=${maxP1.toFixed(1)} max|P2dx|=${maxP2.toFixed(1)}  -> ${maxP1 < 2 && maxP2 < 2 ? 'PASS (no motion)' : 'FAIL'}`);
  await page.waitForTimeout(1200);

  const b2 = await grab(page);
  await page.evaluate(() => {
    const mk = (t) => new KeyboardEvent(t, { code: 'KeyL', key: 'l', bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__up2 = () => document.dispatchEvent(mk('keyup'));
  });
  const motions2 = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(260);
    motions2.push(fighterMotion(b2, await grab(page)));
  }
  await page.evaluate(() => globalThis.__up2 && globalThis.__up2());
  const p2dx = Math.max(...motions2.map(m => m.p2));
  console.log(`  [5] BEHAVIOR KeyL (P2 right): P2dx=${motions2.map(m => m.p2.toFixed(1)).join(',')}  -> ${p2dx >= 2 ? 'PASS (P2 walked right)' : 'FAIL'}`);
  await ctx.close();
}

// ============ CONTEXT 3: touch buttons dispatch (state-level) ============
{
  const { ctx, page } = await bootStale(browser);
  const cdp = await ctx.newCDPSession(page);
  const checks = [];
  for (const [lbl, expect] of [['X', 'KeyA'], ['Y', 'KeyS'], ['Z', 'KeyD'], ['A', 'KeyZ'], ['B', 'KeyX'], ['C', 'KeyC']]) {
    const p = await overlayPoint(page, '.itc-btns .itc-btn', lbl);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: p.x, y: p.y, id: 9, radiusX: 6, radiusY: 6, force: 0.6 }],
    });
    await page.waitForTimeout(180);
    const held = await page.evaluate(() => globalThis.__ikemenTouch ? globalThis.__ikemenTouch.state() : []);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    const ok = Array.isArray(held) && held.includes(expect);
    checks.push(`${lbl}->${expect}:${ok ? 'ok' : 'BAD(' + JSON.stringify(held) + ')'}`);
  }
  console.log(`  [6] DISPATCH buttons: ${checks.join(' ')}`);
  await ctx.close();
}

await browser.close();
console.log('\nprobe5 done');
