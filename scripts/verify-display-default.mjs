/**
 * verify-display-default.mjs — proves the vfs.js boot display-mode
 * normalization defaults to 16:9 and respects ONLY the v2 marker.
 *
 * Runs the EXACT shipped statement block from public/game/vfs.js
 * (sliced at runtime, so drift = test failure) inside a stub scope.
 *
 * Scenarios:
 *   1. fresh / no marker + shipped 16:9 config  -> stays 16:9 (1280x720, FA -1,-1)
 *   2. contaminated device: OLD marker '4:3' + 960x720 FA4,3  -> healed to 16:9, no v2 marker written
 *   3. explicit v2 marker '4:3' + 960x720 FA4,3 -> respected (native 4:3 stays, v2 marker kept)
 *   4. no marker + stretch-era 640x480          -> bumped to 1280x720, FA -1,-1
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/game/vfs.js', import.meta.url), 'utf8');

// Slice the display-mode statement chunk: from `let text = ...` (just after
// `if (cfg) {`) up to the keymap-enforcement comment. Statements in that
// range are self-contained (brace-balanced) and reference only localStorage,
// TextDecoder and the vars they declare.
const anchor = src.indexOf('// Normalize display-mode configurations');
if (anchor < 0) throw new Error('normalization block not found in vfs.js');
const start = src.indexOf('let text = new TextDecoder().decode(cfg);', anchor);
const end = src.indexOf('// CANONICAL KEYMAP ENFORCEMENT', start);
if (start < 0 || end < 0) throw new Error('slice bounds not found');
const chunk = src.slice(start, end);

const fn = new Function(
  'localStorage',
  'TextDecoder',
  'TextEncoder',
  'cfg',
  `${chunk}\nreturn { text, changed };`
);

function run(name, seedCfg, store) {
  const ls = {
    _m: { ...store },
    getItem(k) { return k in this._m ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };
  const { text, changed } = fn(ls, TextDecoder, TextEncoder, new TextEncoder().encode(seedCfg));
  const get = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*(-?\\d+)`, 'mi'));
    return m ? m[1] : '?';
  };
  const out = {
    GW: get('GameWidth'), GH: get('GameHeight'),
    FAW: get('FightAspectWidth'), FAH: get('FightAspectHeight'),
    KA: get('KeepAspect'), FSAZ: get('ForceStageAutoZoom'),
    v2: ls._m['engine-display-mode-v2'] ?? null, changed,
  };
  console.log(`--- ${name}\n    ${JSON.stringify(out)}`);
  return out;
}

const SHIPPED_16x9 = `[Video]
GameWidth            = 1280
GameHeight           = 720
FightAspectWidth     = -1
FightAspectHeight    = -1
KeepAspect          = 0
[Config]
ZoomActive          = 1
[Debug]
ForceStageAutoZoom  = 0`;

const NATIVE_43 = `[Video]
GameWidth            = 960
GameHeight           = 720
FightAspectWidth     = 4
FightAspectHeight    = 3
KeepAspect          = 1
[Config]
ZoomActive          = 1
[Debug]
ForceStageAutoZoom  = 0`;

const STRETCH_640 = `[Video]
GameWidth            = 640
GameHeight           = 480
FightAspectWidth     = -1
FightAspectHeight    = -1
KeepAspect          = 0
[Config]
ZoomActive          = 1
[Debug]
ForceStageAutoZoom  = 0`;

let fails = 0;
const expect = (cond, msg) => { if (!cond) { fails++; console.log(`    FAIL: ${msg}`); } };

// 1. Fresh device, shipped 16:9 config, no markers.
let r = run('1 fresh + shipped 16:9', SHIPPED_16x9, {});
expect(r.GW === '1280' && r.FAW === '-1', 'fresh must stay 16:9');
expect(r.v2 === null, 'fresh must NOT get a marker written');
expect(r.FSAZ === '1', 'stage zoom ensured');

// 2. Contaminated device: OLD auto-written marker + native-4:3 config.
r = run('2 old-marker 4:3 + 960x720', NATIVE_43, { 'engine-display-mode': '4:3' });
expect(r.GW === '1280' && r.FAW === '-1', 'old marker must be ignored -> healed to 16:9');
expect(r.v2 === null, 'healing must NOT write a v2 marker');

// 3. Explicit v2 choice: native 4:3 stays.
r = run('3 v2-marker 4:3 + 960x720', NATIVE_43, { 'engine-display-mode-v2': '4:3' });
expect(r.GW === '960' && r.FAW === '4' && r.KA === '1', 'explicit v2 4:3 must stay native 4:3');
expect(r.v2 === '4:3', 'v2 marker kept');

// 4. Stretch-era 640x480, no marker -> bumped to 16:9 canvas.
r = run('4 no-marker 640x480 stretch', STRETCH_640, {});
expect(r.GW === '1280' && r.GH === '720' && r.FAW === '-1', 'orphaned 4:3 canvas must bump to 1280x720');

console.log(fails === 0 ? '\nALL DISPLAY-DEFAULT CHECKS PASS' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
