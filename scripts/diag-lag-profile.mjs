// diag-lag-profile.mjs — F-053: CPU-profile the fight window.
//
// Boots a fight on the production server, starts the V8 sampling profiler at
// canvas#ikemen-canvas, samples ~30s of gameplay, then summarizes self time
// by function and by file category (wasm engine vs site JS vs GC vs GL).
// Reveals whether fight-time stutter is engine GC (runtime.* / mallocgc),
// our glue JS, wasm game logic, or GL/render.

import { chromium } from 'playwright';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = argOf('--url', process.env.BASE || 'http://localhost:3000');
const FIGHT_MS = Number(argOf('--fight-ms', 30000));
const PLAY_URL =
  `${BASE}/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });

const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); // 0.5ms
await cdp.send('Profiler.start');

await page.waitForTimeout(FIGHT_MS);

const { profile } = await cdp.send('Profiler.stop');
await browser.close();

// ---- summarize self time --------------------------------------------------
const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); // node -> samples
for (const [i, id] of (profile.samples || []).entries()) {
  // weight each sample by timeDelta (usually uniform); fall back to 1
  const w = profile.timeDeltas?.[i] > 0 ? profile.timeDeltas[i] : 1;
  self.set(id, (self.get(id) || 0) + w);
}

const cat = (n) => {
  const url = n.callFrame.url || '';
  const fn = n.callFrame.functionName || '(anonymous)';
  if (/wasm-function|WASM|\.wasm/.test(fn + url)) return 'wasm-engine';
  if (fn.startsWith('runtime.') || /mallocgc|gcBgMark|mheap|scanobject|memclr|greyobject|sweepone|gcDrain/.test(fn)) return 'go-gc-runtime';
  if (url.includes('vfs.js')) return 'site-vfs.js';
  if (url.includes('wasm_exec')) return 'site-wasm_exec.js';
  if (url.includes('next/') || url.includes('/_next/') || url.includes('page.tsx') || url.includes('chunk')) return 'site-next-js';
  if (url.includes('webrtc.js') || url.includes('sffpal') || url.includes('touch.js') || url.includes('fullscreen')) return 'site-glue';
  if (/SwiftShader|swiftshader|WebGL|ANGLE|V8\.Default|v8|blink|Blink/.test(fn + url)) return 'browser-render/gl';
  if (url === '' && fn === '') return 'native/unknown';
  return 'other-js';
};

const bySelf = new Map();
const byCatSelf = new Map();
const samplesTotal = (profile.samples || []).reduce((a, _s, i) => a + (profile.timeDeltas?.[i] > 0 ? profile.timeDeltas[i] : 1), 0);
for (const [id, w] of self) {
  const n = nodesById.get(id);
  if (!n) continue;
  const key = `${cat(n)} :: ${n.callFrame.functionName || '(anon)'}${n.callFrame.url ? ' @ ' + n.callFrame.url.split('/').pop().slice(0, 40) : ''}`;
  bySelf.set(key, (bySelf.get(key) || 0) + w);
  const c = cat(n);
  byCatSelf.set(c, (byCatSelf.get(c) || 0) + w);
}

const ms = (w) => Math.round(w / 1000);
const fmt = (m, topN) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  .map(([k, v]) => `   ${String(ms(v)).padStart(6)}ms ${String(Math.round((v / samplesTotal) * 100)).padStart(3)}%  ${k.slice(0, 120)}`)
  .join('\n');

console.log('==== CPU profile during fight ====');
console.log('url:', PLAY_URL);
console.log('samples total ~', ms(samplesTotal), 'ms');
console.log('\n-- by category --\n' + fmt(byCatSelf, 12));
console.log('\n-- top self-time frames --\n' + fmt(bySelf, 25));
