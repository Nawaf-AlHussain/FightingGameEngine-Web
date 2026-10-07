// Debug: capture boot console + overlay text when canvas fails to appear.
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
page.on('console', (m) => console.log('CONSOLE: ' + m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message.slice(0, 300)));
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP ' + r.status() + ': ' + r.url()); });
await page.goto('http://127.0.0.1:3210/play?p1=kfm&p2=kfm&p2ai=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 90000 });
  console.log('CANVAS UP');
  await page.waitForTimeout(6000);
} catch {
  console.log('CANVAS TIMEOUT — dumping boot overlay:');
  const t = await page.evaluate(() => {
    const el = document.querySelector('pre, [class*=boot], #boot');
    return el ? el.textContent.slice(-3000) : document.body.innerText.slice(-2000);
  }).catch((e) => 'evaluate failed: ' + e.message);
  console.log(t);
}
await browser.close();
