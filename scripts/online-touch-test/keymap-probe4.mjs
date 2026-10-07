// keymap-probe4.mjs — VERIFIES the canonical keymap fix on a simulated
// user's device: seeds the STALE layout (old pak: P1=WASD+890/IOP,
// P2=ARROWS+1234567), boots, and expects:
//   1. '[vfs] canonical keymap v3 enforced' in the logs
//   2. persisted config first-set = canonical (arrows+zxc/asd for P1)
//   3. ArrowRight -> LEFT character (P1) walks right   (was: P2 moved!)
//   4. KeyD      -> NO-MOTION                          (was: P1 walked!)
//   5. KeyL      -> RIGHT character (P2) walks right
//   6. KeyI      -> RIGHT character (P2) jumps (P2 Up=i)
//   7. TOUCH dpad-R -> LEFT character (P1) moves       (was: dead/P2!)
//   8. TOUCH btn-X/Y/Z -> LEFT character (P1) attacks  (was: walked!)
//
// One key/touch per fresh context => spawn positions are trustworthy.
//
// Usage: node scripts/online-touch-test/keymap-probe4.mjs [--base ...]
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

// The user's device: stored config from the OLD pak era.
const STALE_CFG = `[Common]
Air     = data/common.air
Cmd     = data/common.cmd
Const   = data/common.const

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
Up     = w
Down   = s
Left   = a
Right  = d
A      = 8
B      = 9
C      = 0
X      = i
Y      = o
Z      = p
Start  = u
D      = q
W      = e
Menu   = ESCAPE

[Keys_P2]
Joystick = -1
GUID   =
Up     = UP
Down   = DOWN
Left   = LEFT
Right  = RIGHT
A      = 1
B      = 2
C      = 3
X      = 4
Y      = 5
Z      = 6
Start  = 7
Menu   = ESCAPE
`;

const KEY_OF = {
  ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
};
const keyOf = (code) => KEY_OF[code]
  || (code.startsWith('Key') ? code.slice(3).toLowerCase() : undefined)
  || (code.startsWith('Digit') ? code.slice(5) : undefined);

async function grabGrid(page) {
  const box = await page.locator('canvas#ikemen-canvas').boundingBox();
  if (!box || box.width < 10) throw new Error('no canvas box');
  const buf = await page.screenshot({ clip: box, type: 'png', timeout: 20000, scale: 'css' });
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
  return { grid: out, gw, gh };
}

// Wait until the scene is STATIC: consecutive grabs differ by < 0.45 mean
// channel delta. Skips round intros / transitions so baselines are clean.
async function waitIdle(page, maxMs = 30000) {
  const t0 = Date.now();
  let prev = (await grabGrid(page)).grid;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(500);
    const cur = (await grabGrid(page)).grid;
    let sum = 0;
    for (let i = 0; i < prev.length; i += 4) {
      sum += Math.abs(prev[i] - cur[i]) + Math.abs(prev[i + 1] - cur[i + 1]) + Math.abs(prev[i + 2] - cur[i + 2]);
    }
    const mag = sum / (prev.length / 4 * 3);
    prev = cur;
    if (mag < 0.45) return;
  }
}

// Wait until the ROUND IS ACTIVE: the HUD timer (top strip) must tick at
// least twice, then the scene must go static (both fighters idling).
// Round intros/VS cards are static too, so timer ticks are the only
// reliable 'fight has started' signal.
async function waitRoundActive(page, maxMs = 90000) {
  const t0 = Date.now();
  const topDiff = (a, b) => {
    let sum = 0;
    for (let r = 0; r < 10; r++) {
      for (let c = 30; c < 66; c++) {
        const p = (r * 96 + c) * 4;
        sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
      }
    }
    return sum / (10 * 36 * 3);
  };
  let ticks = 0;
  let prevTop = (await grabGrid(page)).grid;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(700);
    const curTop = (await grabGrid(page)).grid;
    if (topDiff(prevTop, curTop) > 0.8) ticks++;
    prevTop = curTop;
    if (ticks >= 2) break;
  }
  if (ticks < 2) throw new Error('round never became active (no timer ticks)');
  // Now wait for the fighters to settle into idle.
  await page.waitForTimeout(1500);
  await waitIdle(page, 15000);
}

function analyze(base, cur, gw, gh) {
  let Lw = 0, Lx = 0, Rw = 0, Rx = 0, mag = 0, n = 0;
  for (let r = 20; r < 54; r++) {
    for (let c = 0; c < gw; c++) {
      const p = (r * gw + c) * 4;
      const d = Math.abs(base[p] - cur[p]) + Math.abs(base[p + 1] - cur[p + 1]) + Math.abs(base[p + 2] - cur[p + 2]);
      mag += d; n += 3;
      if (d > 4) {
        if (c < gw / 2) { Lw += d; Lx += c * d; }
        else { Rw += d; Rx += c * d; }
      }
    }
  }
  return { mag: mag / n, L: Lw / n, R: Rw / n, Lc: Lw ? Lx / Lw : -1, Rc: Rw ? Rx / Rw : -1 };
}

function verdict(res) {
  if (res.mag <= 1.0) return { who: 'NO-MOTION', detail: '' };
  const who = res.L > res.R * 1.6 ? 'P1(left)' : res.R > res.L * 1.6 ? 'P2(right)' : 'BOTH/ambig';
  return { who, detail: `L=${res.L.toFixed(2)}(c=${res.Lc.toFixed(1)}) R=${res.R.toFixed(2)}(c=${res.Rc.toFixed(1)})` };
}

async function bootStaleContext(browser) {
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

async function dumpPersisted(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('ikemen-vfs12:save/config.ini');
    if (!raw) return null;
    const text = atob(raw).split('').map((c) => c.charCodeAt(0) < 128 ? c : '?').join('');
    const sec = (name) => {
      const m = text.match(new RegExp('\\[' + name + '\\]([\\s\\S]*?)(?:\\n\\[|$)', 'i'));
      return m ? m[1].trim() : '(absent)';
    };
    return { p1: sec('Keys_P1'), p2: sec('Keys_P2'), marker: localStorage.getItem('ikemen-keymap-v3') };
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

const results = [];
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
console.log(`========== PROBE4 (verify canonical fix on stale-profile) ${STAMP} ==========`);

// --- keyboard probes: one key per context ---
for (const code of ['ArrowRight', 'KeyD', 'KeyL', 'KeyI']) {
  const { ctx, page, logs } = await bootStaleContext(browser);
  const heal = logs.find((l) => l.includes('canonical keymap v3'));
  const persisted = await dumpPersisted(page);
  const firstP1Up = persisted ? (persisted.p1.match(/up\s*=\s*(\S+)/i) || [])[1] : '?';
  const g1 = await grabGrid(page);
  await page.waitForTimeout(350);
  const g2 = await grabGrid(page);
  const base = g1.grid.map((v, i) => Math.round((g1.grid[i] + g2.grid[i]) / 2));
  await page.evaluate(([c, k]) => {
    const mk = (t) => new KeyboardEvent(t, { code: c, key: k, bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__up = () => document.dispatchEvent(mk('keyup'));
  }, [code, keyOf(code)]);
  await page.waitForTimeout(850);
  const cur = await grabGrid(page);
  await page.evaluate(() => globalThis.__up && globalThis.__up());
  const v = verdict(analyze(base, cur.grid, g1.gw, g1.gh));
  console.log(`  KEY   ${code.padEnd(11)} -> ${v.who.padEnd(10)} ${v.detail}  [healed=${!!heal} firstUp=${firstP1Up}]`);
  results.push({ kind: 'key', code, who: v.who, healed: !!heal });
  await ctx.close();
}

// --- touch probes: one control per context ---
for (const [label, sel, point] of [
  ['dpad-R', '.itc-dpad', { xf: 0.36, yf: 0.0 }],
  ['btn-X', '.itc-btns .itc-btn', 'X'],
  ['btn-Y', '.itc-btns .itc-btn', 'Y'],
  ['btn-Z', '.itc-btns .itc-btn', 'Z'],
  ['btn-A', '.itc-btns .itc-btn', 'A'],
]) {
  const { ctx, page, logs } = await bootStaleContext(browser);
  const heal = logs.find((l) => l.includes('canonical keymap v3'));
  const cdp = await ctx.newCDPSession(page);
  const p = await overlayPoint(page, sel, typeof point === 'string' ? point : null);
  const target = p
    ? (typeof point === 'string'
        ? { x: p.x, y: p.y }
        : { x: p.x + p.w * (point.xf - 0.5), y: p.y + p.h * (point.yf - 0.5) })
    : null;
  if (!target) { console.log(`  TOUCH ${label}: (element missing)`); await ctx.close(); continue; }
  const g1 = await grabGrid(page);
  await page.waitForTimeout(350);
  const g2 = await grabGrid(page);
  const baseAvg = g1.grid.map((v, i) => Math.round((g1.grid[i] + g2.grid[i]) / 2));
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: target.x, y: target.y, id: 7, radiusX: 6, radiusY: 6, force: 0.6 }],
  });
  await page.waitForTimeout(850);
  const cur = await grabGrid(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const v = verdict(analyze(baseAvg, cur.grid, g1.gw, g1.gh));
  console.log(`  TOUCH ${label.padEnd(11)} -> ${v.who.padEnd(10)} ${v.detail}  [healed=${!!heal}]`);
  results.push({ kind: 'touch', code: label, who: v.who, healed: !!heal });
  await ctx.close();
}

await browser.close();
console.log('\n---- EXPECTATIONS ----');
console.log('  ArrowRight -> P1(left)   KeyD -> NO-MOTION   KeyL -> P2(right)   KeyI -> P2(right)');
console.log('  dpad-R -> P1(left)   btn-X/Y/Z/A -> P1(left) in-place attacks');
console.log('\nprobe4 done');
