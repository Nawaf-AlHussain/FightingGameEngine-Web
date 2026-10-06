// Minimal screenshot-mechanics probe on the LOCAL page (single context).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3210';
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,
  isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));
await page.goto(BASE + '/play?p1=kfm&p2=kfm&p2ai=4', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
console.log('canvas up; waiting 15s for render...');
await page.waitForTimeout(15000);

for (const opts of [
  { type: 'png', timeout: 15000 },
  { type: 'png', timeout: 15000, animations: 'disabled' },
  { type: 'png', timeout: 15000, caret: 'hide', animations: 'disabled', scale: 'css' },
]) {
  try {
    const buf = await page.locator('canvas#ikemen-canvas').screenshot(opts);
    console.log('OK opts=' + JSON.stringify(opts) + ' bytes=' + buf.length);
  } catch (e) {
    console.log('FAIL opts=' + JSON.stringify(opts) + ' :: ' + e.message.split('\n').slice(0, 2).join(' | '));
  }
}
// also try page.screenshot clip based on bounding box
try {
  const box = await page.locator('canvas#ikemen-canvas').boundingBox();
  console.log('bbox=' + JSON.stringify(box));
  const buf = await page.screenshot({ clip: box, type: 'png', timeout: 15000 });
  console.log('OK clip-screenshot bytes=' + buf.length);
} catch (e) {
  console.log('FAIL clip :: ' + e.message.split('\n').slice(0, 2).join(' | '));
}
await browser.close();
