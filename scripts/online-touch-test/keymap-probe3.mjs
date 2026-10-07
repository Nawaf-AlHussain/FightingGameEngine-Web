// keymap-probe3.mjs — DEFINITIVE config-honoring test.
//
// Seeds localStorage with a DISTINGUISHING layout (what the user's stale
// device plausibly holds): P1 movement = IJKL, buttons zxc/asd-ish;
// P2 movement = ARROWS, buttons 890/IOP.
// Then boots the engine and fires ONE key per fresh context:
//
//   If the engine HONORS config.ini (first-match):
//     KeyL -> P1 walks right      KeyJ -> P1 walks left
//     KeyI -> P1 attack (X=i)
//     ArrowRight -> P2 walks right (the user's exact VS symptom!)
//     KeyD -> nothing
//   If the engine IGNORES config (built-ins: P1=arrows+zxc/asd, P2=ijkl+...):
//     KeyL -> P2 walks right      KeyJ -> P2 walks left
//     KeyI -> P2 jumps (built-in P2 up=i)
//     ArrowRight -> P1 walks right
//     KeyD -> P1 Z-button attack (z=d)
//
// One key per context => no position pollution; characters start at spawn.
// Output per key: which character (left/right spawner) moved, how far.

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
const KEYS = (arg('--keys', 'KeyL,KeyJ,ArrowRight,KeyI,KeyD')).split(',');

const SEED_CFG = `[Common]
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
Up     = i
Down   = k
Left   = j
Right  = l
A      = f
B      = g
C      = h
X      = r
Y      = t
Z      = y
Start  = RSHIFT
Menu   = ESCAPE

[Keys_P2]
Joystick = -1
GUID   =
Up     = UP
Down   = DOWN
Left   = LEFT
Right  = RIGHT
A      = 8
B      = 9
C      = 0
X      = i
Y      = o
Z      = p
Start  = u
Menu   = ESCAPE
`;

const KEY_OF = {
  ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  Enter: 'Enter', Escape: 'Escape',
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

// Changed cells (vs baseline) grouped into left/right half; centroid + spread.
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
  return {
    mag: mag / n,
    L: Lw / n, R: Rw / n,
    Lc: Lw ? Lx / Lw : -1, Rc: Rw ? Rx / Rw : -1,
  };
}

async function runKey(browser, code) {
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  await ctx.addInitScript((seed) => {
    localStorage.setItem('ikemen-vfs12:save/config.ini', seed);
  }, Buffer.from(SEED_CFG, 'utf8').toString('base64'));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/play?p1=kfm&p2=kfm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 180000 });
  await page.waitForTimeout(15000);

  // Baseline = average of 3 grabs 250ms apart (both idling).
  const g1 = await grabGrid(page); await page.waitForTimeout(250);
  const g2 = await grabGrid(page); await page.waitForTimeout(250);
  const g3 = await grabGrid(page);
  const base = g1.grid.map((v, i) => Math.round((v + g2.grid[i] + g3.grid[i]) / 3));

  await page.evaluate(([c, k]) => {
    const mk = (t) => new KeyboardEvent(t, { code: c, key: k, bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__up = () => document.dispatchEvent(mk('keyup'));
  }, [code, keyOf(code)]);
  await page.waitForTimeout(850);
  const cur = await grabGrid(page);
  await page.evaluate(() => globalThis.__up && globalThis.__up());

  const res = analyze(base, cur.grid, g1.gw, g1.gh);
  const side = res.mag <= 1.0 ? 'NO-MOTION'
    : res.L > res.R * 1.6 ? `LEFT-char (L=${res.L.toFixed(2)} c=${res.Lc.toFixed(1)})`
    : res.R > res.L * 1.6 ? `RIGHT-char (R=${res.R.toFixed(2)} c=${res.Rc.toFixed(1)})`
    : `both (L=${res.L.toFixed(2)} R=${res.R.toFixed(2)})`;
  console.log(`  ${code.padEnd(11)} mag=${res.mag.toFixed(2)}  -> ${side}`);

  fs.writeFileSync(path.join(ART, `probe3-${STAMP}-${code}.png`), Buffer.from([]));
  await ctx.close();
  return res;
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
console.log(`========== PROBE3 (seeded distinguishing map) ${STAMP} ==========`);
console.log('  seed: P1=i/j/k/l+f/g/h/r/t/y  P2=ARROWS+8/9/0/i/o/p');
for (const code of KEYS) {
  await runKey(browser, code);
}
await browser.close();
console.log('\nprobe3 done');
