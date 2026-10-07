// Online touch gate — two real browser contexts over the website online flow.
// Rebuilt (original was lost with the old sandbox) and EXTENDED:
//   * guest D-pad LEFT + RIGHT (pixel-diff on the guest's own screen)
//   * guest action button A (attack animation diff)
//   * multi-touch: hold D-pad RIGHT + tap A simultaneously (state assertion)
//   * [touch] build/bindings console marker assertion (cache-bust guard)
//   * host keyboard liveness gate before any guest probe
//   * local-mode quick-match touch regression (mode=full)
//
// Usage:
//   node run.mjs --base http://localhost:3210 [--mode full|smoke|mismatch] [--tag name]
//   BASE=https://... node run.mjs --mode smoke   (live-site verification)
//
// mode=mismatch reproduces the cross-device display-mode bug: the host
// context is seeded with the 4:3 display mode (FightAspect=4,3 -> engine
// "custom:4:3"), the guest with the 16:9 default (FA=-1,-1 -> "stage").
// The engine's netplay handshake refuses mismatched fight aspects, which
// used to kill the fight before it started. The gate asserts the website
// display-mode sync (host 'go' frame -> guest in-memory config patch)
// rescues the pairing, then proves the fight is actually live.
//
// Touch synthesis: real TouchEvents (Touch + TouchEvent constructors) aimed
// at the touch.js overlay elements. touch.js only cares about the events, so
// this drives the exact same code paths as a real finger.

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

// ---- args ----
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = arg('--base', process.env.BASE || 'http://localhost:3210');
const MODE = arg('--mode', 'full'); // full | smoke | mismatch
const TAG = arg('--tag', MODE);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

// ---- contexts ----
// Guest = real-phone emulation (iPhone 13 landscape).
const guestCtx = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });

// Display-mode seeds for the mismatch variant (before ANY navigation so
// vfs.js boot migration sees them — the marker alone drives the config).
if (MODE === 'mismatch') {
  await hostCtx.addInitScript(() => {
    try { localStorage.setItem('ikemen-display-mode', '4:3'); } catch {}
  });
  await guestCtx.addInitScript(() => {
    try { localStorage.setItem('ikemen-display-mode', '16:9'); } catch {}
  });
}

const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();

// console collectors
const hostLogs = [], guestLogs = [];
host.on('console', (m) => hostLogs.push(m.text()));
guest.on('console', (m) => guestLogs.push(m.text()));
guest.on('pageerror', (e) => guestLogs.push('PAGEERROR: ' + e.message));
host.on('pageerror', (e) => hostLogs.push('PAGEERROR: ' + e.message));

const dump = (page, name) =>
  fs.writeFileSync(path.join(ART, `${TAG}-${STAMP}-${name}.log`), page.join('\n'));

console.log(`[gate] base=${BASE} mode=${MODE} tag=${TAG}`);

// ================= helpers =================

async function waitLog(page, logs, needle, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (logs.some((l) => l.includes(needle))) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await page.waitForTimeout(300);
  }
}

async function clickButton(page, text, timeout = 20000) {
  const btn = page.locator(`button:has-text("${text}")`).first();
  await btn.waitFor({ state: 'visible', timeout });
  await btn.click();
}

// Canvas frame grab via ELEMENT SCREENSHOT (compositor output — always what
// is on screen). The rAF/drawImage approach is unreliable: the WebGL drawing
// buffer may already be cleared when the callback runs (observed on the
// local-mode page: engine renders fine, but drawImage reads zeros).
async function grabGrid(page) {
  let buf = null, lastErr = 'unknown';
  for (let t = 0; t < 3 && !buf; t++) {
    try {
      // page-level clip screenshot: no element-stability wait (the engine's
      // 60fps loop can starve Playwright's stability check on busy pages).
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
    const sy = Math.min(png.height - 1, Math.floor((gy + 0.5) * png.height / gh));
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(png.width - 1, Math.floor((gx + 0.5) * png.width / gw));
      const si = (sy * png.width + sx) * 4, di = (gy * gw + gx) * 4;
      out[di] = png.data[si]; out[di + 1] = png.data[si + 1]; out[di + 2] = png.data[si + 2]; out[di + 3] = 255;
    }
  }
  // blank guard
  let nz = 0;
  for (let i = 0; i < out.length; i += 40) if (out[i] || out[i + 1] || out[i + 2]) nz++;
  if (nz < 20) throw new Error('canvas grab blank frame');
  return out;
}

// Hide the touch overlay VISUALLY during pixel probes (synthetic dispatch
// bypasses hit-testing, so handlers still fire; held keys are unaffected).
// Prevents the overlay's own press-highlight from polluting game diffs.
async function hideOverlay(page) {
  await page.evaluate(() => {
    if (document.getElementById('gate-hide-touch')) return;
    const s = document.createElement('style');
    s.id = 'gate-hide-touch';
    s.textContent = '#ikemen-touch{visibility:hidden !important}';
    document.head.appendChild(s);
  });
}

// mean-abs diff over a region: cols [c0,c1), rows [r0,r1) of the 96x54 grid
function regionDiff(a, b, c0 = 0, c1 = 96, r0 = 8, r1 = 54) {
  let sum = 0, n = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const p = (r * 96 + c) * 4;
      sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
      n += 3;
    }
  }
  return sum / n;
}

// movement probe: compare idle pair (noise) vs before/after hold (move)
// Two during-hold samples; move = max diff (attacks can recover fast).
// Noise is capped at 8 so a KO/round-transition burst can't erase evidence.
async function movementProbe(page, { holdMs, action, region, sampleDuring }) {
  const idle1 = await grabGrid(page);
  await page.waitForTimeout(700);
  const idle2 = await grabGrid(page);
  const noise = regionDiff(idle1, idle2, ...region);
  const before = await grabGrid(page);
  await action(); // starts holding
  await page.waitForTimeout(Math.floor(holdMs / 2));
  const mid = await grabGrid(page);
  await page.waitForTimeout(holdMs - Math.floor(holdMs / 2));
  const end = await grabGrid(page);
  const during = sampleDuring ? await sampleDuring() : undefined;
  await action(true); // release
  await page.waitForTimeout(350);
  const move = Math.max(regionDiff(before, mid, ...region), regionDiff(before, end, ...region));
  const ratio = move / Math.min(Math.max(noise, 0.35), 8);
  return { move, noise, ratio, during };
}

// Probe with round-lifecycle retries: ensure the sim is animating, probe,
// pass on ANY attempt. Round boundaries (KO freeze / transitions) make a
// single attempt inherently flaky — retries make the gate deterministic.
async function probeRetry(page, { tries = 3, minMove, minRatio, ...probe }) {
  let last = null;
  for (let t = 1; t <= tries; t++) {
    if (!(await ensureLive(page))) console.log(`  [warn] sim looks frozen (attempt ${t})`);
    last = await movementProbe(page, probe);
    console.log(`  [${probe.tag || 'probe'} #${t}] move=${last.move.toFixed(2)} noise=${last.noise.toFixed(2)} ratio=${last.ratio.toFixed(2)}`);
    if (last.move > minMove && last.ratio > minRatio) return { ...last, pass: true };
    await page.waitForTimeout(2500);
  }
  return { ...last, pass: false };
}

// Wait until the sim is actually animating (round intro / post-KO freezes
// render identical frames). Returns true when frames change.
async function ensureLive(page) {
  for (let i = 0; i < 15; i++) {
    const g1 = await grabGrid(page);
    await page.waitForTimeout(400);
    const g2 = await grabGrid(page);
    if (regionDiff(g1, g2, 0, 96, 8, 54) > 0.15) return true;
    await page.waitForTimeout(1600);
  }
  return false;
}

// ---- touch.js synthesis ----
async function touchStart(page, target) {
  return page.evaluate((target) => {
    let el, xf = 0.5;
    if (target === 'dpad-right') { el = document.querySelector('.itc-dpad'); xf = 0.85; }
    else if (target === 'dpad-left') { el = document.querySelector('.itc-dpad'); xf = 0.15; }
    else {
      el = [...document.querySelectorAll('.itc-btn')].find((b) => b.textContent === target);
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * xf, y = r.top + r.height * 0.5;
    const touch = new Touch({ identifier: Math.floor(Math.random() * 1e6), target: el, clientX: x, clientY: y });
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch], targetTouches: [touch], changedTouches: [touch],
        bubbles: true, cancelable: true,
      })
    );
    return touch.identifier;
  }, target);
}

async function touchEnd(page, id) {
  return page.evaluate((id) => {
    const touch = new Touch({ identifier: id, target: document.body, clientX: 0, clientY: 0 });
    window.dispatchEvent(
      new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [touch], bubbles: true, cancelable: true })
    );
  }, id);
}

const heldState = (page) => page.evaluate(() => (window.__ikemenTouch ? window.__ikemenTouch.state() : null));

// ================= online flow =================

console.log('[gate] opening online flow (host + guest)...');
await host.goto(BASE + '/play?net=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickButton(host, 'HOST GAME');

// host: create room, capture code from netlog (fallback: code div)
await clickButton(host, 'Create room');
let code = null;
{
  const t0 = Date.now();
  while (!code && Date.now() - t0 < 30000) {
    const m = hostLogs.find((l) => l.includes('room created:'));
    if (m) code = m.split('room created:')[1].trim().split(/\s/)[0];
    else
      code = await host.evaluate(() => {
        const el = document.querySelector('div[style*="user-select:all"]');
        return el ? el.textContent.trim() : null;
      });
    if (!code) await host.waitForTimeout(300);
  }
}
if (!code) {
  dump(hostLogs, 'host'); dump(guestLogs, 'guest');
  console.error('[gate] FATAL: no room code');
  process.exit(2);
}
console.log('[gate] room code = ' + code);

await guest.goto(BASE + '/play?net=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickButton(guest, 'JOIN GAME');
const codeInput = guest.locator('input[placeholder*="spicy-tiger"]');
await codeInput.waitFor({ state: 'visible', timeout: 30000 });
await codeInput.fill(code);
await clickButton(guest, 'Join room');

// handshake -> charselect on both
await host.waitForSelector('text=SELECT FIGHTER', { timeout: 60000 });
await guest.waitForSelector('text=SELECT FIGHTER', { timeout: 60000 });
console.log('[gate] charselect reached on both sides');

// pick kfm both + lock (online LOCK IN button locks own side)
await guest.getByText('Kung Fu Man').first().click();
await clickButton(guest, 'LOCK IN', 15000).catch(async () => {
  // label may already read LOCKED if the tap double-fired; retry click
  await clickButton(guest, 'LOCK', 10000).catch(() => {});
});
await host.getByText('Kung Fu Man').first().click();
await clickButton(host, 'LOCK IN', 15000).catch(async () => {
  await clickButton(host, 'LOCK', 10000).catch(() => {});
});
console.log('[gate] both locked, waiting for stage select (host)...');
await host.waitForSelector('text=SELECT STAGE', { timeout: 60000 });
await host.locator('.ss__card').first().click();
await clickButton(host, 'FIGHT!', 15000);

// both sides boot the fight
const okH = await waitLog(host, hostLogs, 'Online match:', 60000);
const okG = await waitLog(guest, guestLogs, 'Online match:', 60000);
if (!okH || !okG) {
  dump(hostLogs, 'host'); dump(guestLogs, 'guest');
  console.error('[gate] FATAL: engine boot log missing');
  process.exit(2);
}
await host.waitForSelector('canvas#ikemen-canvas', { timeout: 90000 });
await guest.waitForSelector('canvas#ikemen-canvas', { timeout: 90000 });
console.log('[gate] fight canvas up on both sides; letting round intro pass...');

// [touch] marker must show the NEW build + shipped bindings (cache-bust guard)
if (MODE !== 'mismatch') {
  const line = guestLogs.find((l) => l.startsWith('[touch] '));
  const pass = !!line && line.includes('touch-2026-10-07.1') &&
    line.includes('"Right":"ArrowRight"') && line.includes('"A":"KeyZ"');
  if (!pass && MODE === 'smoke' && !line) {
    // Live deploy may still lag the repo — report, don't fail the smoke run.
    console.log('  INFO  [touch] marker missing on live (deploy lag?) — bindings asserted via state probes instead');
  } else {
    ok('guest [touch] build+bindings marker', pass, line ? line.slice(0, 160) : 'NO [touch] LOG');
  }
}

// ---- mismatch variant: prove the display-mode sync rescued the pairing ----
if (MODE === 'mismatch') {
  const okAdoptH = await waitLog(host, hostLogs, 'Display mode: 4:3 (host', 30000);
  const okAdoptG = await waitLog(guest, guestLogs, 'Display mode: 4:3 (adopted', 30000);
  ok('host reports synced display mode (4:3, host)', okAdoptH);
  ok('guest adopted host display mode (4:3)', okAdoptG);
  // Give the engine handshake a moment, then fail fast on the exact
  // refusal that used to kill cross-aspect pairings.
  await host.waitForTimeout(5000);
  const aspectRefused = [...hostLogs, ...guestLogs].some(
    (l) => l.includes('fight aspect differs') || l.includes('ENGINE EXITED BEFORE THE FIGHT STARTED')
  );
  ok('engine did not refuse the pairing on fight aspect', !aspectRefused);
  if (!okAdoptH || !okAdoptG || aspectRefused) {
    dump(hostLogs, 'host'); dump(guestLogs, 'guest');
    console.error('[gate] FATAL: display-mode sync did not rescue the pairing');
    process.exit(2);
  }
}

// let the intro/round-start settle, then liveness gate on the host keyboard
await guest.waitForTimeout(12000);
let live = false;
for (let attempt = 1; attempt <= 3 && !live; attempt++) {
  try {
    const r = await movementProbe(host, {
      holdMs: 1100,
      region: [4, 36, 8, 54], // P1 area, left third, HUD rows excluded
      action: async (release) => {
        if (release) await host.keyboard.up('d');
        else await host.keyboard.down('d');
      },
    });
    console.log(`  [liveness host kbd #${attempt}] move=${r.move.toFixed(2)} noise=${r.noise.toFixed(2)} ratio=${r.ratio.toFixed(2)}`);
    live = r.move > 1.2 && r.ratio > 3;
  } catch (e) {
    console.log(`  [liveness host kbd #${attempt}] error: ${e.message}`);
  }
  if (!live && attempt < 3) await guest.waitForTimeout(6000);
}
ok('fight liveness (host keyboard reaches engine, KeyD = P1 attack)', live);
if (!live) {
  dump(hostLogs, 'host'); dump(guestLogs, 'guest');
  await host.screenshot({ path: path.join(ART, `${TAG}-${STAMP}-host-dead.png`) });
  await guest.screenshot({ path: path.join(ART, `${TAG}-${STAMP}-guest-dead.png`) });
  console.error('[gate] FATAL: fight never went live');
  process.exit(2);
}

// ---- guest touch probes (full/smoke only — mismatch stays lean) ----
if (MODE !== 'mismatch') {
await hideOverlay(guest);
// Guest's own character is P2 (right side of its screen).
const RIGHT = [64, 96, 8, 54];
const LEFT = [0, 32, 8, 54];
const CENTER = [20, 76, 8, 54];

// 1) D-pad RIGHT (press starts INSIDE the probe, after the idle baseline)
{
  let id = null;
  const r = await probeRetry(guest, {
    tag: 'dpad RIGHT', holdMs: 1500, region: RIGHT, minMove: 2.5, minRatio: 1.3,
    action: async (release) => {
      if (release) { if (id !== null) await touchEnd(guest, id); return; }
      id = await touchStart(guest, 'dpad-right');
    },
    sampleDuring: () => heldState(guest),
  });
  ok('guest touch D-pad RIGHT moves P2', r.pass);
  ok('guest D-pad RIGHT dispatches ArrowRight while held', Array.isArray(r.during) && r.during.includes('ArrowRight') && !r.during.includes('KeyD'),
    'held=' + JSON.stringify(r.during));
}

// 2) D-pad LEFT
{
  let id = null;
  const r = await probeRetry(guest, {
    tag: 'dpad LEFT', holdMs: 1500, region: LEFT, minMove: 2.5, minRatio: 1.3,
    action: async (release) => {
      if (release) { if (id !== null) await touchEnd(guest, id); return; }
      id = await touchStart(guest, 'dpad-left');
    },
  });
  ok('guest touch D-pad LEFT moves P2', r.pass);
}

// 3) Button A attack — mid+end sampling inside movementProbe now covers
//    fast attack recovery; dispatch proof via state assertion.
{
  let idA = null;
  const r = await probeRetry(guest, {
    tag: 'button A', holdMs: 620, region: CENTER, minMove: 0.9, minRatio: 2,
    action: async (release) => {
      if (release) { if (idA !== null) await touchEnd(guest, idA); return; }
      idA = await touchStart(guest, 'A');
    },
    sampleDuring: () => heldState(guest),
  });
  ok('guest touch A button animates attack', r.pass);
  ok('guest A button dispatches KeyZ while held', Array.isArray(r.during) && r.during.includes('KeyZ'),
    'held=' + JSON.stringify(r.during));
  const held = await heldState(guest);
  ok('guest held-state clean after A release', Array.isArray(held) && held.length === 0, 'held=' + JSON.stringify(held));
}

// 4) Multi-touch: hold RIGHT + press A simultaneously
{
  const idD = await touchStart(guest, 'dpad-right');
  await guest.waitForTimeout(150);
  const idA = await touchStart(guest, 'A');
  await guest.waitForTimeout(450);
  const held = await heldState(guest);
  const pass = Array.isArray(held) && held.includes('ArrowRight') && held.includes('KeyZ');
  ok('guest multi-touch: D-pad RIGHT + A held together', pass, 'held=' + JSON.stringify(held));
  if (idD !== null) await touchEnd(guest, idD).catch(() => {});
  if (idA !== null) await touchEnd(guest, idA).catch(() => {});
  await guest.waitForTimeout(250);
}
} // end MODE !== 'mismatch'

// ================= local regression (full mode) =================
if (MODE === 'full') {
  // Free memory FIRST — three simultaneous engine contexts crash Chromium.
  await hostCtx.close();
  await guestCtx.close();
  console.log('[gate] local quick-match touch regression...');
  const locCtx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const loc = await locCtx.newPage();
  const locLogs = [];
  loc.on('console', (m) => locLogs.push(m.text()));
  await loc.goto(BASE + '/play?p1=kfm&p2=kfm&p2ai=4', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await loc.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
  // Local boots the WASM engine from scratch (no preboot) — first render
  // lags the canvas element by a while; wait until frames actually animate.
  await loc.waitForTimeout(8000);
  let lalive = false;
  for (let attempt = 1; attempt <= 4 && !lalive; attempt++) {
    try {
      const r = await probeRetry(loc, {
        tag: 'local kbd', tries: 2, holdMs: 1100, region: [4, 36, 8, 54], minMove: 1.2, minRatio: 3,
        action: async (release) => { if (release) await loc.keyboard.up('d'); else await loc.keyboard.down('d'); },
      });
      lalive = r.pass;
    } catch (e) { console.log(`  [local liveness #${attempt}] error: ${e.message}`); }
    if (!lalive && attempt < 4) await loc.waitForTimeout(6000);
  }
  ok('local: fight live (keyboard sanity)', lalive);
  if (lalive) {
    await hideOverlay(loc);
    let id = null;
    const r = await probeRetry(loc, {
      tag: 'local dpad RIGHT', holdMs: 1200, region: [4, 36, 8, 54], minMove: 1.2, minRatio: 3,
      action: async (release) => {
        if (release) { if (id !== null) await touchEnd(loc, id); return; }
        id = await touchStart(loc, 'dpad-right');
      },
    });
    ok('local: touch D-pad RIGHT moves P1', r.pass);
  }
  const netLeak = locLogs.some((l) => l.includes('room created') || l.includes('[netplay]'));
  ok('local: no netplay leak', !netLeak);
  await locCtx.close();
}

// ---- summary ----
dump(hostLogs, 'host'); dump(guestLogs, 'guest');
const fails = results.filter((r) => !r.pass);
console.log('\n================ GATE SUMMARY ================');
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`=============================================`);
console.log(`[gate] ${results.length - fails.length}/${results.length} checks passed (${TAG})`);

await browser.close();
process.exit(fails.length ? 1 : 0);
