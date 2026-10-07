// Netplay keymap probe — pins down WHICH keys drive the LOCAL player on each
// side of a net=1 fight (host=P1 slot, guest=P2 slot), and whether input syncs.
//
// Probes (synthetic KeyboardEvents, like the physical keyboard):
//   HOST : ArrowRight (built-in P1 right?) / KeyD (Z-attack? old walk?) / KeyL ([Keys_P2] right?)
//   GUEST: ArrowRight / KeyL ([Keys_P2] right? built-in P2 right=l) / KeyI ([Keys_P2] up? jump) / KeyD
//
// Usage: node scripts/online-touch-test/netkey-probe.mjs --base http://127.0.0.1:3210

import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3210');

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
const hostLogs = [], guestLogs = [];
host.on('console', (m) => hostLogs.push(m.text()));
guest.on('console', (m) => guestLogs.push(m.text()));
host.on('pageerror', (e) => hostLogs.push('PAGEERROR: ' + e.message));
guest.on('pageerror', (e) => guestLogs.push('PAGEERROR: ' + e.message));

const clickButton = async (page, text, timeout = 20000) => {
  const btn = page.locator(`button:has-text("${text}")`).first();
  await btn.waitFor({ state: 'visible', timeout });
  await btn.click();
};

// ---- canvas grid (96x54) ----
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
  const gw = 96, gh = 54, out = new Array(gw * gh * 4);
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
function regionDiff(a, b, c0, c1, r0 = 8, r1 = 54) {
  let sum = 0, n = 0;
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
    const p = (r * 96 + c) * 4;
    sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    n += 3;
  }
  return sum / n;
}
async function ensureLive(page) {
  for (let i = 0; i < 10; i++) {
    const g1 = await grabGrid(page);
    await page.waitForTimeout(400);
    const g2 = await grabGrid(page);
    if (regionDiff(g1, g2, 0, 96, 8, 54) > 0.15) return true;
    await page.waitForTimeout(1400);
  }
  return false;
}

// key probe: motion of a region on TWO canvases (local page + peer page)
async function keyProbe(code, localPage, peerPage, localRegion, peerRegion, label) {
  const idle1 = await grabGrid(localPage);
  const idleP1 = await grabGrid(peerPage);
  await localPage.waitForTimeout(700);
  const noise = regionDiff(idle1, await grabGrid(localPage), ...localRegion);
  const before = await grabGrid(localPage);
  const beforeP = await grabGrid(peerPage);
  await localPage.evaluate((c) => {
    const mk = (t) => new KeyboardEvent(t, { code: c, key: c, bubbles: true, cancelable: true });
    document.dispatchEvent(mk('keydown'));
    globalThis.__nkUp = () => document.dispatchEvent(mk('keyup'));
  }, code);
  await localPage.waitForTimeout(1100);
  const mid = await grabGrid(localPage);
  const midP = await grabGrid(peerPage);
  await localPage.evaluate(() => globalThis.__nkUp && globalThis.__nkUp());
  const move = Math.max(regionDiff(before, mid, ...localRegion), regionDiff(idle1, mid, ...localRegion) - noise);
  const peerMove = Math.max(regionDiff(beforeP, midP, ...peerRegion), regionDiff(idleP1, midP, ...peerRegion));
  console.log(`  ${label.padEnd(22)} local=${move.toFixed(2)}  peer=${peerMove.toFixed(2)}  (noise~${noise.toFixed(2)})`);
  await localPage.waitForTimeout(1800);
  return { move, peerMove };
}

// ================= online flow (same as the gate) =================
console.log('[netkey] opening online flow...');
await host.goto(BASE + '/play?net=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickButton(host, 'HOST GAME');
await clickButton(host, 'Create room');
let code = null;
{
  const t0 = Date.now();
  while (!code && Date.now() - t0 < 30000) {
    const m = hostLogs.find((l) => l.includes('room created:'));
    if (m) code = m.split('room created:')[1].trim().split(/\s/)[0];
    else code = await host.evaluate(() => {
      const el = document.querySelector('div[style*="user-select:all"]');
      return el ? el.textContent.trim() : null;
    }).catch(() => null);
    if (!code) await host.waitForTimeout(300);
  }
}
if (!code) { console.error('[netkey] FATAL: no room code'); process.exit(2); }
console.log('[netkey] room code = ' + code);

await guest.goto(BASE + '/play?net=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickButton(guest, 'JOIN GAME');
const codeInput = guest.locator('input[placeholder*="spicy-tiger"]');
await codeInput.waitFor({ state: 'visible', timeout: 30000 });
await codeInput.fill(code);
await clickButton(guest, 'Join room');

await host.waitForSelector('text=SELECT FIGHTER', { timeout: 60000 });
await guest.waitForSelector('text=SELECT FIGHTER', { timeout: 60000 });
console.log('[netkey] charselect reached on both sides');

await guest.getByText('Kung Fu Man').first().click();
await clickButton(guest, 'LOCK IN', 15000).catch(async () => { await clickButton(guest, 'LOCK', 10000).catch(() => {}); });
await host.getByText('Kung Fu Man').first().click();
await clickButton(host, 'LOCK IN', 15000).catch(async () => { await clickButton(host, 'LOCK', 10000).catch(() => {}); });
await host.waitForSelector('text=SELECT STAGE', { timeout: 60000 });
await host.locator('.ss__card').first().click();
await clickButton(host, 'FIGHT!', 15000);

await Promise.all([
  host.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 }),
  guest.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 }),
]);
console.log('[netkey] fight canvas up; letting intro pass...');
await host.waitForTimeout(13000);

const liveH = await ensureLive(host);
const liveG = await ensureLive(guest);
console.log(`[netkey] liveness host=${liveH} guest=${liveG}`);

// regions: HOST canvas: P1 left [4,36); GUEST canvas: local char (P2) right [64,96), remote P1 left [4,36)
console.log('\n---- HOST side (local player = P1, left region of host canvas) ----');
await keyProbe('ArrowRight', host, guest, [4, 36, 8, 54], [4, 36, 8, 54], 'host ArrowRight');
await keyProbe('KeyD', host, guest, [4, 36, 8, 54], [4, 36, 8, 54], 'host KeyD');
await keyProbe('KeyL', host, guest, [4, 36, 8, 54], [4, 36, 8, 54], 'host KeyL');

console.log('\n---- GUEST side (local player = P2, right region of guest canvas) ----');
await keyProbe('ArrowRight', guest, host, [64, 96, 8, 54], [64, 96, 8, 54], 'guest ArrowRight');
await keyProbe('KeyL', guest, host, [64, 96, 8, 54], [64, 96, 8, 54], 'guest KeyL');
await keyProbe('KeyI', guest, host, [64, 96, 8, 54], [64, 96, 8, 54], 'guest KeyI');
await keyProbe('KeyD', guest, host, [64, 96, 8, 54], [64, 96, 8, 54], 'guest KeyD');

console.log('\n[touch-side note] guest touch probes would dispatch the overlay bindings');
await browser.close();
console.log('netkey probe done');
