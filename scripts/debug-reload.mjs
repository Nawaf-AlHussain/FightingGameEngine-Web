// debug-reload.mjs — solo mid-boot-reload with FULL console dump to capture
// the panic text the matrix run saw (case 4).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://open-fighter.vercel.app';
const MATCH = '/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const lines = [];
page.on('console', (m) => lines.push(m.text()));
page.on('response', (r) => { if (r.status() >= 400) lines.push(`[http ${r.status()}] ${r.url()}`); });
page.on('pageerror', (e) => lines.push('pageerror: ' + e.message));
page.on('dialog', (d) => { lines.push('[native dialog] ' + d.message()); d.dismiss().catch(() => {}); });

await page.goto(`${BASE}${MATCH}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000); // mid-boot (wasm/pak in flight)
await page.reload({ waitUntil: 'domcontentloaded' });

let booted = false;
try { await page.waitForSelector('canvas#ikemen-canvas', { timeout: 150000 }); booted = true; } catch {}
console.log(`booted=${booted}`);
console.log('--- FULL CONSOLE ---');
for (const t of lines) console.log(t.slice(0, 200));
await browser.close();
