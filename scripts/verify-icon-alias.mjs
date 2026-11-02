// verify-icon-alias.mjs — verifies F-051: a returning player whose browser
// still holds a PRE-SCRUB save/config.ini (localStorage `engine-vfs12:`) must
// not crash at engine boot.
//
// The engine's system.go loads every file named in [Config] WindowIcon and
// PANICS on failure ("Icon file can not be found."). F-048 deleted the branded
// mascot icons (external/icons/IkemenCylia_*.png) from the VFS, so any client
// whose persisted config still names them — or any boot that falls back to the
// engine's embedded defaultConfig.ini, which names them too — died at boot.
// Fresh browser contexts (all Playwright suites) always fetched the scrubbed
// server config, which is why every existing verification missed this.
//
// This script seeds localStorage with the branded config (faithful to a
// returning player's state) and boots /play:
//   stale case  — seeded branded WindowIcon: must boot (alias heals it)
//   fresh case  — no seed, control: must boot as before
// Boot success = canvas#ikemen-canvas appears; failure = the panic lines land
// in the console and the canvas never shows.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
// Faithful stale state: the FULL engine-written config a pre-F-048 player has
// persisted (the engine rewrites config.ini wholesale), with the branded icon
// paths the scrub deleted. Built from the shipped config by restoring the
// legacy names on the WindowIcon line.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const B64 = Buffer.from(
  readFileSync(join(REPO, 'public/game/engine-fs/file/save/config.ini'), 'utf8')
    .replace(/icon_(256|96|48)\.png/g, 'IkemenCylia_$1.png')
).toString('base64');

async function bootCase(name, { seed }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  if (seed) {
    await ctx.addInitScript((b64) => {
      localStorage.setItem('engine-vfs12:save/config.ini', b64);
    }, B64);
  }
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  page.on('pageerror', (e) => lines.push('pageerror: ' + e.message));
  page.on('dialog', (d) => {
    lines.push('[native dialog] ' + d.message());
    d.dismiss().catch(() => {});
  });
  await page.goto(
    `${BASE}/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade`,
    { waitUntil: 'domcontentloaded' }
  );

  let booted = false;
  try {
    await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
    booted = true;
  } catch {
    /* canvas never appeared */
  }
  const panicked = lines.some((t) =>
    /Icon file can not be found|Panic:|ENGINE CRASHED/i.test(t)
  );
  console.log(`[${name}] booted=${booted} panicked=${panicked}`);
  if (process.env.DEBUG) {
    for (const t of lines.slice(-40)) console.log('   *', t.slice(0, 160));
  }
  for (const t of lines.filter((t) => /panic|crash|icon file|alert/i.test(t))) {
    console.log('   |', t.slice(0, 160));
  }
  await browser.close();
  return { booted, panicked };
}

const stale = await bootCase('stale-config (seeded branded WindowIcon)', { seed: true });
const fresh = await bootCase('fresh-config (control)', { seed: false });

let ok = true;
if (stale.booted && !stale.panicked) {
  console.log('PASS stale: branded icon path aliased to neutral icons, engine booted');
} else {
  ok = false;
  console.log('FAIL stale: seeded config still crashes boot');
}
if (fresh.booted && !fresh.panicked) {
  console.log('PASS fresh: control boot unaffected by the alias change');
} else {
  ok = false;
  console.log('FAIL fresh: control boot regressed');
}
process.exit(ok ? 0 : 1);
