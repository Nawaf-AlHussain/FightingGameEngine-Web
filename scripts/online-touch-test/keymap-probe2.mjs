// keymap-probe2.mjs — corrected keymap probe.
// Fixes the fatal flaw in keymap-probe.mjs: synthetic KeyboardEvents must
// carry a REAL .key value ('d'), not the .code string ('KeyD'). If the engine
// reads e.key, the old probe's keyboard presses were garbage -> it wrongly
// concluded "the engine ignores config.ini key sections".
//
// Probes (VS local, human P2 default so nobody idles):
//   ArrowRight -> shipped config says P2 Right   -> expect P2-side motion
//   KeyD       -> shipped config says P1 Right   -> expect P1-side motion
//   KeyA       -> shipped P1 Left                -> expect P1-side motion
//   KeyW       -> shipped P1 Up (jump)           -> expect P1-side motion
//   KeyS       -> shipped P1 Down (crouch)       -> expect P1-side motion
//   KeyI       -> shipped P1 X-button (attack)   -> expect P1-side in place
//   Digit8     -> shipped P1 A-button (attack)   -> expect P1-side in place
//   KeyZ       -> shipped: unbound               -> expect NO-MOTION
//
// Then real CDP touches on the CURRENT overlay (91c4ab0 hardcode):
//   dpad-R (dispatches ArrowRight)  -> expect P2-side motion (the bug!)
//   btn-X  (dispatches KeyA)        -> expect P1 walks LEFT (the bug!)
//   btn-Y  (dispatches KeyS)        -> expect P1 crouches (the bug!)
//   btn-Z  (dispatches KeyD)        -> expect P1 walks RIGHT (the bug!)
//
// Usage: node scripts/online-touch-test/keymap-probe2.mjs [--base http://127.0.0.1:3210]
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

const KEY_OF = {
  ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  Enter: 'Enter', Escape: 'Escape', Space: ' ',
};
const keyOf = (code) => KEY_OF[code]
  || (code.startsWith('Key') ? code.slice(3).toLowerCase() : undefined)
  || (code.startsWith('Digit') ? code.slice(5) : undefined);

async function grabGrid(page) {
  let buf = null, lastErr = 'unknown';
  for (let t = 0; t < 3 && !buf; t++) {
    try {
      const box = await page.locator('canvas#ikemen-canvas').boundingBox();
      if (!box || box.width < 10) throw new Error('no canvas box');
      buf = await page.screenshot({ clip: box, type: 'png', timeout: 20000, scale: 'css' });
    } catch (e) {
      lastErr = e.message.split('\n')[0];
      await page.waitForTimeout(800);
    }
  }
  if (!buf) throw new Error('canvas screenshot failed: ' + lastErr);
  const png = PNG.sync.read(buf);
  const gw = 96, gh = 54;
  const out = new Array(gw * gh * 4);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(png.width - 1, Math.floor((gx + 0.5) * png.width / gw));
      
      const sy2 = Math.min(png.height - 1, Math.floor((gy + 0.5) * png.height / gh));
      const si = (sy2 * png.width + sx) * 4, di = (gy * gw + gx) * 4;
      out[di] = png.data[si]; out[di + 1] = png.data[si + 1]; out[di + 2] = png.data[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

// Diff two grids; also report per-half magnitudes and horizontal shift of
// changed cells on each half. Rows 20..53 = below HUD, above ground line noise.
function whoMoved(a, b) {
  let sum = 0, n = 0;
  let L = 0, R = 0, Lw = 0, Lx = 0, Rw = 0, Rx = 0;
  for (let r = 20; r < 54; r++) {
    for (let c = 0; c < 96; c++) {
      const p = (r * 96 + c) * 4;
      const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
      sum += d; n += 3;
      if (d > 4) {
        if (c < 48) { L += d; Lw += d; Lx += c * d; }
        else { R += d; Rw += d; Rx += c * d; }
      }
    }
  }
  return {
    mag: sum / n, L: L / n, R: R / n,
    Lc: Lw ? Lx / Lw : -1, Rc: Rw ? Rx / Rw : -1,
  };
}

function interpret(res) {
  if (res.mag <= 1.2) return 'NO-MOTION';
  const side = res.L > res.R * 1.5 ? 'P1' : res.R > res.L * 1.5 ? 'P2' : 'both/ambig';
  return `${side}  L=${res.L.toFixed(2)}(c=${res.Lc.toFixed(1)}) R=${res.R.toFixed(2)}(c=${res.Rc.toFixed(1)})`;
}

async function probeKey(page, code) {
  const before = await grabGrid(page);
  await page.evaluate(([c, k]) => {
    const mk = (t) => new KeyboardEvent(t, { code: c, key: k, bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__kmUp = () => document.dispatchEvent(mk('keyup'));
  }, [code, keyOf(code)]);
  await page.waitForTimeout(420);
  const after = await grabGrid(page);
  await page.evaluate(() => globalThis.__kmUp && globalThis.__kmUp());
  const res = whoMoved(before, after);
  console.log(`  KEY   ${code.padEnd(11)} mag=${res.mag.toFixed(2)}  -> ${interpret(res)}`);
  await page.waitForTimeout(700);
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

async function probeTouch(page, cdp, label, point) {
  if (!point) { console.log(`  TOUCH ${label}: (element missing)`); return; }
  const before = await grabGrid(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y, id: 7, radiusX: 6, radiusY: 6, force: 0.6 }],
  });
  await page.waitForTimeout(420);
  const after = await grabGrid(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const res = whoMoved(before, after);
  console.log(`  TOUCH ${label.padEnd(11)} mag=${res.mag.toFixed(2)}  -> ${interpret(res)}`);
  await page.waitForTimeout(700);
}

async function dumpState(page) {
  const out = await page.evaluate(() => {
    const raw = localStorage.getItem('ikemen-vfs12:save/config.ini');
    const held = globalThis.__ikemenTouch ? globalThis.__ikemenTouch.state() : null;
    if (!raw) return { keys: null, held };
    const text = atob(raw).split('').map((c) => c.charCodeAt(0) < 128 ? c : '?').join('');
    const sec = (name) => {
      const m = text.match(new RegExp('\\[' + name + '\\]([\\s\\S]*?)(?:\\n\\[|$)', 'i'));
      return m ? m[1].trim() : '(absent)';
    };
    return { keys: { p1: sec('Keys_P1'), p2: sec('Keys_P2') }, held };
  });
  console.log('  ---- state after boot ----');
  console.log('  touch held keys:', JSON.stringify(out.held));
  if (!out.keys) { console.log('  (NO v12 config persisted)'); return; }
  console.log('  [Keys_P1] ' + out.keys.p1.replace(/\n\s*/g, ' | '));
  console.log('  [Keys_P2] ' + out.keys.p2.replace(/\n\s*/g, ' | '));
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = m.text(); if (!t.includes('[PAK]') && !t.includes('[P1]') && !t.includes('[P2]') && !t.includes('[STAGE]')) logs.push(t); });
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

await page.goto(`${BASE}/play?p1=kfm&p2=kfm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 });
await page.waitForTimeout(15000); // boot + round intro

console.log(`========== LIVE KEYMAP PROBE (fresh profile) ${STAMP} ==========`);
const touchLine = logs.find((l) => l.includes('[touch]'));
console.log('  touch.js: ' + (touchLine ? touchLine.trim() : '(NOT BUILT)'));
await dumpState(page);

const cdp = await ctx.newCDPSession(page);

console.log('  ---- physical keyboard probes (proper key chars) ----');
for (const code of ['ArrowRight', 'KeyD', 'KeyA', 'KeyW', 'KeyS', 'KeyI', 'Digit8', 'KeyZ']) {
  await probeKey(page, code);
}

console.log('  ---- real CDP touches on current overlay ----');
const dp = await overlayPoint(page, '.itc-dpad');
if (dp) {
  await probeTouch(page, cdp, 'dpad-R', { x: dp.x + dp.w * 0.36, y: dp.y, w: dp.w, h: dp.h });
  await probeTouch(page, cdp, 'dpad-D', { x: dp.x, y: dp.y + dp.h * 0.36, w: dp.w, h: dp.h });
}
for (const lbl of ['X', 'Y', 'Z', 'A']) {
  const p = await overlayPoint(page, '.itc-btns .itc-btn', lbl);
  await probeTouch(page, cdp, `btn-${lbl}`, p);
}

fs.writeFileSync(path.join(ART, `keymap2-${STAMP}.log`), logs.join('\n'));
await ctx.close();
await browser.close();
console.log('\nprobe2 done');
