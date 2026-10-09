// verify-boot-death-reporting.mjs — verifies the "Huawei Chrome bounce" fix:
// an engine that dies inside the /play boot window must be REPORTED on the
// /play page (ErrorState + engine output + exit code), never silently bounce
// the player back to character select (/local).
//
//   A) Regression: normal local quick match (kfm vs kfm AI) still boots and
//      runs; no ErrorState; no navigation away.
//   B) Engine death (missing character): /play?p1=doesnotexist — the engine
//      exits silently before the fight (proven pre-existing behavior, see
//      the 'Booting the engine with a path that does not exist makes it exit
//      silently' note) → ErrorState must appear, URL must STAY on /play.
//      Old behavior: fall-through to "Fight complete" → silent /local bounce.
//   C) WebGL2 absent (--disable-webgl2): ErrorState appears with the WebGL2
//      guidance; URL stays /play. Old behavior: engine died mid-boot with
//      only a warning line, then the same silent bounce.

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const results = [];
const record = (name, pass, info = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
};

async function poll(page, fn, timeoutS, everyMs = 500) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    try { if (await page.evaluate(fn)) return true; } catch { /* navigation */ }
    await new Promise(r => setTimeout(r, everyMs));
  }
  return false;
}

const bootTail = (page) => page.evaluate(
  () => (document.querySelector('#boot')?.textContent || '').split('\n').slice(-8).join('\n')
);

// --- Test A: regression, normal local fight ---------------------------------
{
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, userAgent: UA,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('A PAGEERROR: ' + e.message.slice(0, 160)));
  await page.goto(`${BASE}/play?p1=kfm&p2=kfm&p2ai=8&stage=stages/stage0-720.def&qmode=quickvs`);
  const canvas = await poll(page, () => {
    const c = document.querySelector('canvas#ikemen-canvas');
    return !!c && c.width > 0;
  }, 150);
  record('A: canvas appears (normal local fight)', canvas);
  if (canvas) {
    await new Promise(r => setTimeout(r, 4000));
    const err = await page.$('.error-state');
    const url = page.url();
    record('A: no ErrorState while fight runs', !err, err ? 'error-state visible' : '');
    record('A: still on /play (no silent bounce)', url.includes('/play'), url);
  }
  await browser.close();
}

// --- Test B: engine death reported (missing character) ----------------------
{
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, userAgent: UA,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/play?p1=doesnotexistxyz&p2=kfm&p2ai=4&stage=stages/stage0-720.def&qmode=quickvs`);
  const err = await poll(page, () => !!document.querySelector('.error-state'), 150);
  const url = page.url();
  record('B: ErrorState appears for engine boot death', err);
  record('B: URL stays on /play (no bounce to /local)', url.includes('/play'), url);
  if (err) {
    const msg = await page.evaluate(() => document.querySelector('.error-state__message')?.textContent || '');
    const tail = await bootTail(page);
    console.log('B error message: ' + msg.slice(0, 300));
    console.log('B boot log tail:\n' + tail);
  }
  await browser.close();
}

// --- Test C: WebGL2 absent → clear guidance ---------------------------------
{
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-webgl2'] });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, userAgent: UA,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/play?p1=kfm&p2=kfm&p2ai=4&stage=stages/stage0-720.def&qmode=quickvs`);
  const err = await poll(page, () => !!document.querySelector('.error-state'), 60);
  const url = page.url();
  record('C: ErrorState appears when WebGL2 is absent', err);
  record('C: URL stays on /play', url.includes('/play'), url);
  if (err) {
    const boot = await bootTail(page);
    record('C: boot log names WebGL2', boot.includes('WebGL2'), boot.slice(-160));
    const toggle = await page.$('.error-state__details-toggle');
    if (toggle) {
      await page.click('.error-state__details-toggle');
      const txt = await page.evaluate(() => document.querySelector('.error-state__details-content')?.textContent || '');
      record('C: technical details name WebGL2', txt.includes('WebGL2'), txt.slice(0, 160));
    } else {
      record('C: technical details name WebGL2', false, 'no details toggle');
    }
  }
  await browser.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
