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
 *   3. explicit v2 marker '4:3' + 960x720 FA4,3 -> migrated to the EXPANDED
 *      STAGE VIEW preset (1280x720, FA=16,9, KA=1) — the shipped '4:3'
 *      marker has meant Expanded since the expanded-era migration; v2 kept
 *   4. no marker + stretch-era 640x480          -> bumped to 1280x720, FA -1,-1
 *   5. explicit v2 marker '14:9'                -> 1120x720, FA=14,9, KA=1
 *   6. explicit v2 marker '5:3'                 -> 1200x720, FA=5,3, KA=1
 *   7. no marker + orphaned fitted-mode canvases (1080x720 / 1120x720 /
 *      1200x720 from wiped '3:2'/'14:9'/'5:3' markers) -> bumped to 1280x720
 *   8. no marker + 1920x1080 (16:9-1080p canvas) -> KEPT (not an orphan;
 *      near-ratio false-positive guard for the 14/9 and 5/3 arms)
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
  // The shipped block also calls setStageFitMode(...) — the stage-fit gate
  // that lives function-scoped around the slice in vfs.js. This harness
  // tests CONFIG normalization only, so the gate is stubbed to a no-op
  // (the chunk itself stays verbatim, so drift still fails the harness).
  `const setStageFitMode = () => {};
${chunk}\nreturn { text, changed };`
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

// Orphaned fitted-mode canvases: what the boot finds after a user wipes
// the v2 marker while a '3:2' / '14:9' / '5:3' canvas remains.
const ORPHAN_32 = STRETCH_640
  .replace('GameWidth            = 640', 'GameWidth            = 1080')
  .replace('GameHeight           = 480', 'GameHeight           = 720');
const ORPHAN_149 = STRETCH_640
  .replace('GameWidth            = 640', 'GameWidth            = 1120')
  .replace('GameHeight           = 480', 'GameHeight           = 720');
const ORPHAN_53 = STRETCH_640
  .replace('GameWidth            = 640', 'GameWidth            = 1200')
  .replace('GameHeight           = 480', 'GameHeight           = 720');
// A legitimate 16:9-1080p canvas must NEVER be bumped (ratio 1.778 is
// outside every orphan arm: 4/3, 3/2, 14/9, 5/3 ±0.01).
const CANVAS_1080P = STRETCH_640
  .replace('GameWidth            = 640', 'GameWidth            = 1920')
  .replace('GameHeight           = 480', 'GameHeight           = 1080');

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

// 3. Explicit v2 choice '4:3' — the marker has meant the EXPANDED STAGE
// VIEW since the expanded-era migration: every '4:3'-marker config is
// rewritten to the Expanded preset (1280x720 + FightAspect=16,9 +
// KeepAspect + the vfs stage fit). The historical native-4:3 geometry
// lives under the separate 'tall' marker now.
r = run('3 v2-marker 4:3 + 960x720', NATIVE_43, { 'engine-display-mode-v2': '4:3' });
expect(r.GW === '1280' && r.FAW === '16' && r.FAH === '9' && r.KA === '1',
  'explicit v2 4:3 must migrate to the Expanded preset (1280x720, FA=16,9, KA=1)');
expect(r.v2 === '4:3', 'v2 marker kept');

// 4. Stretch-era 640x480, no marker -> bumped to 16:9 canvas.
r = run('4 no-marker 640x480 stretch', STRETCH_640, {});
expect(r.GW === '1280' && r.GH === '720' && r.FAW === '-1', 'orphaned 4:3 canvas must bump to 1280x720');

// 5. Explicit v2 choice '14:9' (the WIDER STAGE VIEW).
r = run('5 v2-marker 14:9', SHIPPED_16x9, { 'engine-display-mode-v2': '14:9' });
expect(r.GW === '1120' && r.GH === '720' && r.FAW === '14' && r.FAH === '9' && r.KA === '1',
  'explicit v2 14:9 must write the 1120x720 canvas + FightAspect=14,9 + KeepAspect');
expect(r.v2 === '14:9', 'v2 marker kept');

// 6. Explicit v2 choice '5:3' (the WIDEST FITTED STAGE VIEW).
r = run('6 v2-marker 5:3', SHIPPED_16x9, { 'engine-display-mode-v2': '5:3' });
expect(r.GW === '1200' && r.GH === '720' && r.FAW === '5' && r.FAH === '3' && r.KA === '1',
  'explicit v2 5:3 must write the 1200x720 canvas + FightAspect=5,3 + KeepAspect');
expect(r.v2 === '5:3', 'v2 marker kept');

// 7. Orphaned fitted-mode canvases (marker wiped) heal to the 16:9 canvas.
r = run('7a no-marker 1080x720 (wiped 3:2)', ORPHAN_32, {});
expect(r.GW === '1280' && r.FAW === '-1', 'orphaned 3:2 canvas must bump to 1280x720');
r = run('7b no-marker 1120x720 (wiped 14:9)', ORPHAN_149, {});
expect(r.GW === '1280' && r.FAW === '-1', 'orphaned 14:9 canvas must bump to 1280x720');
r = run('7c no-marker 1200x720 (wiped 5:3)', ORPHAN_53, {});
expect(r.GW === '1280' && r.FAW === '-1', 'orphaned 5:3 canvas must bump to 1280x720');

// 8. A legitimate 1080p canvas is not an orphan — no bump (the 14/9 and
// 5/3 arms must not false-positive on 16:9 ratios).
r = run('8 no-marker 1920x1080 kept', CANVAS_1080P, {});
expect(r.GW === '1920' && r.GH === '1080' && r.FAW === '-1', '1080p canvas must be kept');

console.log(fails === 0 ? '\nALL DISPLAY-DEFAULT CHECKS PASS' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
