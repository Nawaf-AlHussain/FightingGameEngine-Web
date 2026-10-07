// Keymap probe — answers WHICH config copy wins at fight time and WHAT the
// engine's active P1/P2 key layout actually is, per seeding scenario, using
// a MOBILE-TOUCH context so the touch overlay builds exactly like on a phone.
//
//   A fresh    : no localStorage. What does the engine persist after boot?
//   B shipped  : v12 key seeded with the SHIPPED config (P1=WASD+iop/890,
//                P2=arrows+1234567). Does the engine honor it?
//   C classic  : v12 key seeded with an engine-defaults-style copy (P1 =
//                arrows + zxc/ASD) — the layout a returning device has after
//                an engine rewrite. Does the engine honor it?
//   D oldprefix: only an OLD-prefix key (ikemen-vfs11:) exists. Restores
//                nothing -> engine = shipped; touch snapshot = MISSING.
//
// Each scenario: [touch] bindings line, persisted [Keys_P1]/[Keys_P2] after
// boot, synthetic key probes (who moved), and REAL CDP touches on the
// overlay (D-pad right, X, Y, Z buttons) — the user's exact experience.
//
// Usage: node scripts/online-touch-test/keymap-probe.mjs [--base http://127.0.0.1:3210]

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TAG = 'keymap-probe';

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = arg('--base', 'http://127.0.0.1:3210');
const ONLY = arg('--only', ''); // run one scenario by name

// ---------- seed configs ----------
const SHIPPED_CFG = fs.readFileSync(
  path.join(__dirname, '../../public/game/ikemen-fs/file/save/config.ini'), 'utf8');

const CLASSIC_CFG = `[Common]
Air     = data/common.air
Cmd     = data/common.cmd
Const   = data/common.const
States  = data/functions.zss, data/action.zss, data/demo.zss, data/dizzy.zss, data/guardbreak.zss, data/score.zss, data/system.zss, data/tag.zss, data/training.zss
Fx      = data/gofx/gofx.def

[Config]
Motif               = data/ikemen1/system.def
ZoomActive          = 1

[Video]
GameWidth           = 1280
GameHeight          = 720
FightAspectWidth    = -1
FightAspectHeight   = -1
KeepAspect          = 0

[Keys_P1]
Joystick = -1
GUID   =
Up     = UP
Down   = DOWN
Left   = LEFT
Right  = RIGHT
A      = z
B      = x
C      = c
X      = a
Y      = s
Z      = d
Start  = RETURN
Menu   = ESCAPE

[Keys_P2]
Joystick = -1
GUID   =
Up     = w
Down   = s
Left   = a
Right  = d
A      = 1
B      = 2
C      = 3
X      = 4
Y      = 5
Z      = 6
Start  = 7
Menu   = ESCAPE
`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------- canvas grid ----------
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
      const sy = Math.min(png.height - 1, Math.floor((gy + 0.5) * png.height / gh));
      const si = (sy * png.width + sx) * 4, di = (gy * gw + gx) * 4;
      out[di] = png.data[si]; out[di + 1] = png.data[si + 1]; out[di + 2] = png.data[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

// Diff two grids: mag = mean channel delta (rows below HUD);
// center = horizontal center of mass of changed cells (0..96, <40 = P1 side).
function whoMoved(a, b) {
  let sum = 0, n = 0, wsum = 0, wn = 0;
  for (let r = 20; r < 54; r++) {
    for (let c = 0; c < 96; c++) {
      const p = (r * 96 + c) * 4;
      const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
      sum += d; n += 3;
      if (d > 4) { wsum += c * d; wn += d; }
    }
  }
  return { mag: sum / n, center: wn ? wsum / wn : -1 };
}

const interpret = ({ mag, center }) =>
  mag <= 1.2 ? 'NO-MOTION'
    : center < 40 ? `P1(left) c=${center.toFixed(1)}`
    : center > 56 ? `P2(right) c=${center.toFixed(1)}`
    : `center/ambiguous c=${center.toFixed(1)}`;

async function probeKey(page, code) {
  const before = await grabGrid(page);
  await page.evaluate((c) => {
    const mk = (t) => new KeyboardEvent(t, { code: c, key: c, bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__kmKeyUp = () => document.dispatchEvent(mk('keyup'));
  }, code);
  await page.waitForTimeout(320);
  const after = await grabGrid(page);
  await page.evaluate(() => globalThis.__kmKeyUp && globalThis.__kmKeyUp());
  const res = whoMoved(before, after);
  console.log(`  KEY  ${code.padEnd(9)} mag=${res.mag.toFixed(2)}  -> ${interpret(res)}`);
  await page.waitForTimeout(600);
}

// ---------- real CDP touch on overlay controls ----------
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

async function probeTouch(page, cdp, label, point, opts = {}) {
  if (!point) { console.log(`  TOUCH ${label}: (element missing)`); return; }
  const before = await grabGrid(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y, id: 7, radiusX: 6, radiusY: 6, force: 0.6 }],
  });
  await page.waitForTimeout(340);
  const after = await grabGrid(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const res = whoMoved(before, after);
  console.log(`  TOUCH ${label.padEnd(9)} mag=${res.mag.toFixed(2)}  -> ${interpret(res)}`);
  await page.waitForTimeout(600);
}

async function dumpPersistedKeys(page) {
  const out = await page.evaluate(() => {
    const raw = localStorage.getItem('ikemen-vfs12:save/config.ini');
    if (!raw) return null;
    const text = atob(raw).split('').map((c) => c.charCodeAt(0) < 128 ? c : '?').join('');
    const sec = (name) => {
      const m = text.match(new RegExp('\\[' + name + '\\]([\\s\\S]*?)(?:\\n\\[|$)', 'i'));
      return m ? m[1].trim() : '(absent)';
    };
    return { keys_p1: sec('Keys_P1'), keys_p2: sec('Keys_P2') };
  });
  console.log('  ---- persisted v12 config after boot ----');
  if (!out) { console.log('  (NO v12 config persisted)'); return; }
  console.log('  [Keys_P1] ' + out.keys_p1.replace(/\n\s*/g, ' | '));
  console.log('  [Keys_P2] ' + out.keys_p2.replace(/\n\s*/g, ' | '));
}

// ---------- scenario runner ----------
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function scenario(name, seedFn, seedArg) {
  console.log(`\n========== SCENARIO ${name} ==========`);
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  if (seedFn) await ctx.addInitScript(seedFn, seedArg);
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

  await page.goto(`${BASE}/play?p1=kfm&p2=kfm&p2ai=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 });
  await page.waitForTimeout(15000); // engine boot + round intro

  const touchLine = logs.find((l) => l.includes('[touch]'));
  console.log('  touch.js: ' + (touchLine ? touchLine.trim() : '(NOT BUILT)'));
  await dumpPersistedKeys(page);

  const cdp = await ctx.newCDPSession(page);

  // synthetic keyboard probes
  for (const code of ['ArrowRight', 'KeyD', 'KeyA', 'KeyS', 'KeyZ', 'KeyP']) {
    await probeKey(page, code);
  }

  // real touch probes on the overlay
  const dp = await overlayPoint(page, '.itc-dpad');
  if (dp) {
    await probeTouch(page, cdp, 'dpad-R', { x: dp.x + dp.w * 0.36, y: dp.y, w: dp.w, h: dp.h });
    await probeTouch(page, cdp, 'dpad-D', { x: dp.x, y: dp.y + dp.h * 0.36, w: dp.w, h: dp.h });
  }
  for (const lbl of ['X', 'Y', 'Z', 'A']) {
    const p = await overlayPoint(page, '.itc-btns .itc-btn', lbl);
    await probeTouch(page, cdp, `btn-${lbl}`, p);
  }

  fs.writeFileSync(path.join(ART, `${TAG}-${STAMP}-${name}.log`), logs.join('\n'));
  await ctx.close();
}

const seedV12 = ([data]) => { localStorage.setItem('ikemen-vfs12:save/config.ini', data); };
const seedV11 = ([data]) => { localStorage.setItem('ikemen-vfs11:save/config.ini', data); };

const ALL = {
  'A-fresh': [null, null],
  'B-shipped-seeded': [seedV12, [b64(SHIPPED_CFG)]],
  'C-classic-seeded': [seedV12, [b64(CLASSIC_CFG)]],
  'D-oldprefix': [seedV11, [b64(CLASSIC_CFG)]],
};

for (const [name, [fn, argd]] of Object.entries(ALL)) {
  if (ONLY && name !== ONLY) continue;
  await scenario(name, fn, argd);
}

await browser.close();
console.log('\nprobe done');
