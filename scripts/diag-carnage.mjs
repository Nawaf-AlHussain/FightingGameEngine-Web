// diag-carnage.mjs — reproduce "Carnage does not appear in the fight".
//
// Boots two direct-URL quick matches against the local server and captures
// the engine's own output (__engineLog), the injected VFS contents
// (__vfsDebug.list('chars/')), console lines and screenshots:
//   A) control: !Nightwing-o (subdir char, known-good default)
//   B) subject: charsMARVEL/Carnage_MMV in BOTH slots (as the user did)
//
// Usage: node scripts/diag-carnage.mjs [BASE]   (default http://localhost:3783)

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3783';

async function boot(page, url, label, waitS = 150) {
  console.log(`\n===== ${label} =====\n  ${url}`);
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.goto(url, { timeout: 60_000 });

  // Wait for either the fight canvas or the error state.
  const deadline = Date.now() + waitS * 1000;
  let state = 'timeout';
  while (Date.now() < deadline) {
    state = await page.evaluate(() => {
      const c = document.querySelector('canvas#ikemen-canvas');
      if (c && c.width > 0) return 'canvas';
      if (document.querySelector('.error-state, [class*="error"]')) return 'error';
      return 'booting';
    }).catch(() => 'nav');
    if (state === 'canvas' || state === 'error') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, state === 'canvas' ? 15000 : 1500));

  const info = await page.evaluate(() => {
    const log = (globalThis.__engineLog || []).slice(-40).join('\n');
    let chars = [];
    try { chars = globalThis.__vfsDebug ? globalThis.__vfsDebug.list('chars/') : []; } catch {}
    return {
      state: (document.querySelector('canvas#ikemen-canvas')?.width || 0) > 0
        ? 'canvas' : (document.querySelector('.error-state, [class*="error"]') ? 'error' : 'none'),
      boot: (document.querySelector('#boot')?.textContent || '').split('\n').slice(-10).join('\n'),
      errText: (document.querySelector('.error-state, [class*="error"]')?.textContent || '').slice(0, 600),
      engineLog: log,
      injectedChars: chars,
    };
  }).catch((e) => ({ evalError: String(e) }));

  console.log(`  state: ${info.state || '?'}`);
  console.log(`  injected char files: ${(info.injectedChars || []).join(', ') || '(none)'}`);
  if (info.errText) console.log(`  ERROR STATE: ${info.errText}`);
  if (info.boot) console.log(`  boot tail:\n${info.boot}`);
  if (info.engineLog) console.log(`  engine log (last 40):\n${info.engineLog}`);
  if (info.evalError) console.log(`  eval failed: ${info.evalError}`);

  const rel = consoleLines.filter((l) =>
    /carnage|Carnage|addChar|Failed|failed|error|Error|inject|cache|sff|def|Loading char|round|Round/i.test(l)
  ).slice(-40);
  console.log(`  relevant console:\n${rel.join('\n') || '(none)'}`);

  // Second, later capture — the fight may still be on NOW LOADING earlier.
  await new Promise((r) => setTimeout(r, 10000));
  const lateLog = await page.evaluate(() => ({
    log: (globalThis.__engineLog || []).slice(-25).join('\n'),
    match: JSON.stringify(globalThis.__engineMatchResult || null).slice(0, 200),
  })).catch(() => null);
  if (lateLog) {
    console.log(`  LATE engine log (last 25):\n${lateLog.log}\n  matchResult: ${lateLog.match}`);
  }
  await page.screenshot({ path: `/home/z/my-project/audit/diag-${label}-late.png` })
    .catch(() => console.log('  (late screenshot failed)'));

  await page.screenshot({ path: `/home/z/my-project/audit/diag-${label}.png` })
    .catch(() => console.log('  (screenshot failed)'));
  // close page so the next case starts clean (console listeners die with it)
  await page.close().catch(() => {});
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true,
});

// Case filter: CASES=D node scripts/diag-carnage.mjs  (default: all)
const CASES = (process.env.CASES || 'ABCD').toUpperCase();

// A) Control — known-good subdir character, both slots.
if (CASES.includes('A')) {
  const page = await ctx.newPage();
  await boot(page,
    `${BASE}/play?p1=${encodeURIComponent('!Nightwing-o')}&p2=${encodeURIComponent('!Nightwing-o')}&p2ai=8&stage=DU_Campus&qmode=quickvs`,
    'control-nightwing');
}

// B) Subject — Carnage in both slots, exactly like the user.
if (CASES.includes('B')) {
  const page = await ctx.newPage();
  await boot(page,
    `${BASE}/play?p1=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2ai=8&stage=DU_Campus&qmode=quickvs`,
    'carnage-both');
}

// C) Mixed — known-good P1 vs Carnage CPU (the user also tried each slot).
if (CASES.includes('C')) {
  const page = await ctx.newPage();
  await boot(page,
    `${BASE}/play?p1=${encodeURIComponent('!Nightwing-o')}&p2=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2ai=8&stage=DU_Campus&qmode=quickvs`,
    'nightwing-vs-carnage');
}

// D) Poisoned cache — simulate a TRUNCATED download (flaky mobile network /
//    serverless mid-stream cut): the fetch resolves ok, the body is short.
//    The transactional rule never sees a failure (res.ok is true) so the
//    truncated sff gets CACHED as a valid record — this is the hypothesized
//    state of the user's device. Expect: char missing from the fight.
//    NOTE: fresh context — B/C already cached a valid record in ctx.
if (CASES.includes('D')) {
  const ctx2 = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  const page = await ctx2.newPage();
  await page.route('**/api/cdn/charsMARVEL/Carnage_MMV/resource/carnage_sff.sff*', (route) => {
    const orig = route.fetch().then((r) => r.body());
    return orig.then((body) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: body.slice(0, 60_000), // truncated at 60 KB of ~7.8 MB
    })).catch(() => route.continue());
  });
  await boot(page,
    `${BASE}/play?p1=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2ai=8&stage=DU_Campus&qmode=quickvs`,
    'carnage-truncated-sff');

  // E) HEAL CHECK — same context (still poisoned by D), no interception.
  // Expect: the death-triggered purge already removed the poisoned record in
  // D's crash path; this retry re-downloads cleanly and CARNAGE APPEARS.
  {
    const page2 = await ctx2.newPage();
    await boot(page2,
      `${BASE}/play?p1=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2=${encodeURIComponent('charsMARVEL/Carnage_MMV')}&p2ai=8&stage=DU_Campus&qmode=quickvs`,
      'carnage-healed-retry');
    await page2.close();
  }
  await ctx2.close();
}

await browser.close();
