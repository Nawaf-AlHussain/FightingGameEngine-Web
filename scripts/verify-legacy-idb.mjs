// verify-legacy-idb.mjs — backward-compat check: a record written by the OLD
// build (files: Record<name, Uint8Array>) must still boot a fight with the
// NEW code (injectCachedCharacter passes non-Blob values through unchanged).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const CHAR = 'charsMARVEL/Cyclops';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

let injected = '';
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[cache]')) injected += t + '\n';
});

// 1. Seed a LEGACY-format record: fetch real bytes in page context, store as
//    Uint8Array values (exactly what the pre-fix build wrote).
await page.goto(`${BASE}/play?p1=kfm&p2=kfm`, { waitUntil: 'domcontentloaded' });
const seeded = await page.evaluate(async (charRef) => {
  const [, id] = charRef.split('/');
  const manifest = await fetch('/api/assets-manifest', { cache: 'no-cache' }).then(r => r.json());
  const info = manifest.characters.find(c => c.id === id && c.source === 'charsMARVEL');
  if (!info) return 'char not in manifest';
  const files = {};
  for (const f of info.files) {
    const buf = await fetch(`/api/cdn/charsMARVEL/${id}/${f}`).then(r => r.arrayBuffer());
    files[f] = new Uint8Array(buf); // LEGACY value type
  }
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('ikemen-cache', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('chars'); r.result.createObjectStore('stages'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction('chars', 'readwrite');
  tx.objectStore('chars').put({ files, timestamp: Date.now() }, charRef);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return `seeded ${Object.keys(files).length} legacy Uint8Array files`;
}, CHAR);
console.log('seed: ' + seeded);

// 2. Boot /play with that char — must inject from the legacy record and fight.
await page.goto(`${BASE}/play?p1=${encodeURIComponent(CHAR)}&p2=kfm&stage=stages/stage0-720.def&p2ai=4`, { waitUntil: 'domcontentloaded' });
let ok = false;
for (let i = 0; i < 480; i++) {
  ok = await page.evaluate(() => {
    const c = document.querySelector('canvas#ikemen-canvas');
    return !!c && c.width > 0;
  }).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(12000); // let the fight reach in-fight state
console.log('canvas: ' + ok);
console.log('inject log: ' + (injected.trim().split('\n').filter(l => l.includes('Injected')).join(' | ') || 'NONE'));

// 3. Screenshot for the record
await page.screenshot({ path: '/tmp/legacy-idb-fight.png' });
await browser.close();
console.log(ok && injected.includes('Injected 10 files') ? 'LEGACY-COMPAT: PASS' : 'LEGACY-COMPAT: FAIL');
