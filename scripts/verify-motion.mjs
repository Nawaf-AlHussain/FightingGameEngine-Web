// verify-motion.mjs — F-049 motion polish verification
// Three browser contexts (desktop / reduced-motion / touch) probe the
// computed animation state of every rule this pass touched, prove the
// hover-gating differential, and screenshot the chrome screens.
// Usage: BASE=http://localhost:3100 node verify-motion.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3100';
const SHOTS = '/home/z/my-project/download/motion-verify';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleAll = [];
const consoleHits = [];

function record(name, got, want) {
  const pass = got === want;
  results.push({ name, got, want, pass });
  return pass;
}

// Inject synthetic probes + read computed animation-name for each.
// Selectors that need structural context get it (.ms__grid > .ms__card etc.)
const PROBES = `
  <div id="probe-root" style="position:fixed;left:-9999px;top:0">
    <div id="wipe" class="active"><div class="flash"></div></div>
    <div id="probe-wipe-exit" class="wipe-probe exiting"></div>
    <div class="loading-state__spinner"></div>
    <button class="game-btn game-btn--loading">…</button>
    <div class="cs__card cs__card--enter"></div>
    <div class="settings__title"></div>
    <div class="results__title"></div>
    <div class="progress__dot progress__dot--current"></div>
    <div class="ms__bg-dots"></div>
    <div class="ms__grid"><div class="ms__card"></div></div>
    <div class="error-state"></div>
    <div class="ss__chips"><div class="ss__chip"></div></div>
  </div>`;

// NOTE: #wipe.exiting needs the real id (#wipe.exiting selector) but there
// can only be one #wipe — so the exit probe reuses the same element by
// toggling classes in a second evaluate below.
const ANIM_QUERIES = [
  ['wipe.active', '#wipe.active', 'wipeIn'],
  ['wipe .flash', '#wipe.active .flash', 'flashBlast'],
  ['loading spinner', '.loading-state__spinner', 'SPINNER'],
  ['game-btn loading', '.game-btn--loading', 'waitPulse'],
  ['roster card enter', '.cs__card--enter', 'csCardEnter'],
  ['settings title', '.settings__title', 'pressIn'],
  ['results title', '.results__title', 'resultsTitleIn'],
  ['progress dot current', '.progress__dot--current', 'dotPulse'],
  ['ms bg dots', '.ms__bg-dots', 'halftonePan'],
  ['ms card', '.ms__grid .ms__card', 'pressInCard'],
  ['error state', '.error-state', 'pressIn'],
  ['ss chip', '.ss__chips .ss__chip', 'popIn'],
];

async function probeAnimations(page) {
  await page.evaluate((html) => {
    document.body.insertAdjacentHTML('beforeend', html);
  }, PROBES);
  const out = {};
  for (const [name, sel] of ANIM_QUERIES) {
    out[name] = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).animationName : '(el missing)';
    }, sel);
  }
  // wipe exiting — swap class on the same #wipe element
  out['wipe.exiting'] = await page.evaluate(() => {
    const el = document.querySelector('#wipe');
    el.className = 'exiting';
    const v = getComputedStyle(el).animationName;
    el.className = 'active';
    return v;
  });
  // remove probe root to not pollute screenshots
  await page.evaluate(() => document.querySelector('#probe-root')?.remove());
  return out;
}

const browser = await chromium.launch();

// ---------- Context 1: desktop (motion active) ----------
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const dpage = await desktop.newPage();
dpage.on('console', (m) => {
  consoleAll.push(`[${m.type()}] ${m.text()}`);
  if (/ikemen|mugen|golang|GOOS/i.test(m.text())) consoleHits.push(m.text());
});
dpage.on('pageerror', (e) => {
  consoleAll.push(`[pageerror] ${e.message}`);
  if (/ikemen|mugen|golang/i.test(e.message)) consoleHits.push(e.message());
});

await dpage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
const dAnim = await probeAnimations(dpage);
const dWants = {
  'wipe.active': 'wipeIn',
  'wipe .flash': 'flashBlast',
  'wipe.exiting': 'wipeOut',
  'loading spinner': 'spin',
  'game-btn loading': 'waitPulse',
  'roster card enter': 'csCardEnter',
  'settings title': 'pressIn',
  'results title': 'resultsTitleIn',
  'progress dot current': 'dotPulse',
  'ms bg dots': 'halftonePan',
  'ms card': 'pressInCard',
  'error state': 'pressIn',
  'ss chip': 'popIn',
};
for (const [name, want] of Object.entries(dWants)) {
  record(`desktop: ${name}`, dAnim[name], want);
}

// Desktop hover differential: ms card lifts, roster card lifts
// (settle wait: synthetic cards run their 0.42s entrance first)
await dpage.evaluate(() => {
  document.body.insertAdjacentHTML('beforeend',
    '<div id="hover-probe" style="position:fixed;left:10px;top:10px;width:300px"><div class="ms__grid"><div class="ms__card" id="hp-ms" style="width:140px;height:80px;animation:none;transition:none"></div></div><div class="cs__card" id="hp-cs" style="width:80px;height:110px;animation:none;transition:none"></div></div>');
});
// Probes carry inline animation:none: a RUNNING entrance animation owns the
// transform property and would mask the hover cascade (and headless animation
// clocks are unreliable). Inline style removes that variable entirely.
await dpage.hover('#hp-ms');
const dMsHover = await dpage.evaluate(() => getComputedStyle(document.querySelector('#hp-ms')).transform);
record('desktop: ms card hover lifts', /matrix\(.+, -2(?:px)?, -2(?:px)?\)/.test(dMsHover) || dMsHover.includes('-2'), true);
await dpage.hover('#hp-cs');
const dCsHover = await dpage.evaluate(() => getComputedStyle(document.querySelector('#hp-cs')).transform);
record('desktop: roster card hover lifts', dCsHover !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(dCsHover), true);
await dpage.evaluate(() => document.querySelector('#hover-probe')?.remove());

// Real-element spot checks on live screens + screenshots
const routes = ['/', '/mode-select', '/group-select', '/match-prep', '/results', '/progress', '/about', '/settings'];
for (const r of routes) {
  await dpage.goto(`${BASE}${r}`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await dpage.waitForTimeout(900); // entrances complete (max delay 0.7s + 0.5s dur)
  const real = await dpage.evaluate(() => {
    const am = document.querySelector('.about__masthead');
    const rt = document.querySelector('.results__title');
    return {
      aboutMasthead: am ? getComputedStyle(am).animationName : null,
      resultsTitle: rt ? getComputedStyle(rt).animationName : null,
      bodyChildren: document.body.children.length,
    };
  });
  if (r === '/about' && real.aboutMasthead) record('real /about masthead animates', real.aboutMasthead, 'pressIn');
  if (r === '/results' && real.resultsTitle) record('real /results title animates', real.resultsTitle, 'resultsTitleIn');
  await dpage.screenshot({ path: `${SHOTS}/desktop${r.replace(/\//g, '_') || '_home'}.png` });
}

// Chrome serializes transform:none as an identity matrix when a transition
// property exists — so "no lift" = tx/ty of the matrix are ~0 (or 'none').
const isLifted = (t) => {
  if (!t || t === 'none') return false;
  const m = t.match(/matrix\(([^)]+)\)/);
  if (!m) return true; // unknown serialization, assume lifted
  const [a, b, c, d, tx, ty] = m[1].split(',').map(Number);
  return Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5;
};

// ---------- Context 2: reduced motion ----------
const reduce = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
const rpage = await reduce.newPage();
await rpage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
const rAnim = await probeAnimations(rpage);
const rWants = {
  'wipe.active': 'none',
  'wipe .flash': 'none',
  'wipe.exiting': 'none',
  'loading spinner': 'waitPulse',
  'game-btn loading': 'none',
  'roster card enter': 'none',
  'settings title': 'none',
  'results title': 'none',
  'progress dot current': 'none',
  'ms bg dots': 'none',
  'ms card': 'none',
  'error state': 'none',
  'ss chip': 'none',
};
for (const [name, want] of Object.entries(rWants)) {
  record(`reduce: ${name}`, rAnim[name], want);
}
// reduce + hover: ms card must NOT lift
await rpage.evaluate(() => {
  document.body.insertAdjacentHTML('beforeend',
    '<div style="position:fixed;left:10px;top:10px"><div class="ms__grid"><div class="ms__card" id="rp-ms" style="width:140px;height:80px;animation:none;transition:none"></div></div></div>');
});
await rpage.hover('#rp-ms');
const rMsHover = await rpage.evaluate(() => getComputedStyle(document.querySelector('#rp-ms')).transform);
// Reduced motion is NOT no-hover: a desktop reduce user still gets hover
// feedback (reduce disables animations, not interaction states)
record('reduce: hover feedback preserved on desktop', isLifted(rMsHover), true);

// ---------- Context 3: touch (hover:none, pointer:coarse) ----------
const touch = await browser.newContext({
  viewport: { width: 844, height: 390 },
  isMobile: true,
  hasTouch: true,
});
const tpage = await touch.newPage();
await tpage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
await tpage.evaluate(() => {
  document.body.insertAdjacentHTML('beforeend',
    '<div style="position:fixed;left:10px;top:10px"><div class="ms__grid"><div class="ms__card" id="tp-ms" style="width:140px;height:80px;animation:none;transition:none"></div></div><div class="cs__card" id="tp-cs" style="width:80px;height:110px;animation:none;transition:none"></div></div>');
});
await tpage.hover('#tp-ms');
const tMsHover = await tpage.evaluate(() => getComputedStyle(document.querySelector('#tp-ms')).transform);
record('touch: ms card hover does not stick', isLifted(tMsHover), false);
await tpage.hover('#tp-cs');
const tCsHover = await tpage.evaluate(() => getComputedStyle(document.querySelector('#tp-cs')).transform);
record('touch: roster card hover does not stick', isLifted(tCsHover), false);
// press feedback (:active) still available in CSS on touch — rule presence check
const tActiveRule = await tpage.evaluate(() => {
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText && rule.selectorText.includes('.ms__card:not(.ms__card--active):active')) return true;
      }
    } catch { /* cross-origin */ }
  }
  return false;
});
record('touch: :active press rule present', tActiveRule, true);
// touch screenshot of mode-select for mobile sanity
await tpage.goto(`${BASE}/mode-select`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await tpage.waitForTimeout(900);
await tpage.screenshot({ path: `${SHOTS}/touch_mode-select.png` });

await browser.close();

// ---------- report ----------
const failed = results.filter((r) => !r.pass);
console.log(`checks: ${results.length}  pass: ${results.length - failed.length}  FAIL: ${failed.length}`);
for (const f of failed) console.log(`  FAIL ${f.name}: got "${f.got}" want "${f.want}"`);
console.log(`\nconsole lines: ${consoleAll.length}, brand hits: ${consoleHits.length}`);
if (consoleHits.length) console.log(consoleHits.join('\n'));
const errs = consoleAll.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
console.log(`console errors: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 10).join('\n'));
process.exit(failed.length ? 1 : 0);
