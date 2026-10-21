// Unit harness for the STAGE-fit view in public/game/vfs.js
// (patchStageDefFit — mode-parameterized: 'expanded' = the 16:9 full-bleed
// max view, historical '4:3' key; 'tall' = the restored classic fitted-4:3
// stage view; '3:2' = the WIDE STAGE VIEW, the fitted ladder's middle rung).
//
// Runs the SHIPPED patch function (sliced verbatim out of vfs.js) against
// the real roster defs (scripts/fixtures/stage-defs) plus synthetic edge
// cases. Verifies per mode: fit math, pan-bound rewrites, overdrawlow=0,
// pan ceiling, idempotency, cp1252 byte survival, the mode gate (16:9
// stays byte-identical), the stage-path gate, the art-cap fallback for
// art-less stages, and the tall legacy gate.
//
// Run: node scripts/verify-expanded-fit.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vfsSrc = readFileSync(join(ROOT, 'public/game/vfs.js'), 'utf8');

// Slice the shipped code: byte helpers + expanded consts + patch function.
const start = vfsSrc.indexOf('  function bytesToLatin1(buf)');
const end = vfsSrc.indexOf('  const vfs = {');
assert.ok(start > 0 && end > start, 'vfs.js slice markers not found');
const chunk = vfsSrc.slice(start, end);
assert.ok(chunk.includes('function patchStageDefFit'), 'patch function not in slice');
assert.ok(chunk.includes("'expanded'") && chunk.includes("'tall'") && chunk.includes("'3:2'"), 'all three fit modes not in slice');
assert.ok(!chunk.includes('patchStageDef43'), 'stale 4:3 function still present in vfs.js');

let passedCount = 0;
function ok(name, fn) {
  fn();
  passedCount++;
  console.log('  ok - ' + name);
}
// TRUE latin1 byte->string passthrough (String.fromCharCode), mirroring the
// shipped bytesToLatin1 round-trip — TextDecoder('latin1') is actually
// windows-1252 per the WHATWG standard and would remap 0x80-0x9F.
function decodeLatin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
}
function key(text, k) {
  const m = new RegExp('^\\s*' + k + '\\s*=\\s*(-?\\d+(?:\\.\\d+)?)', 'im').exec(text);
  return m ? parseFloat(m[1]) : null;
}
function localcoord(text) {
  const m = /^\s*localcoord\s*=\s*(\d+)\s*,\s*(\d+)/im.exec(text);
  return m ? [+m[1], +m[2]] : null;
}

// Build a patcher over a fresh in-memory contents map.
// mode: null (no fit), 'expanded', 'tall', or '3:2'.
function makePatcher(mode) {
  const contents = new Map();
  const factory = new Function('contents', 'stageFitMode', `
    ${chunk}
    return patchStageDefFit;
  `);
  const patch = factory(contents, mode);
  return {
    contents,
    add(vpath, text) { contents.set(vpath, new TextEncoder().encode(text)); },
    run(vpath) { patch(vpath); },
    text(vpath) { return decodeLatin1(contents.get(vpath)); },
  };
}

const FIXTURES = join(ROOT, 'scripts/fixtures/stage-defs');
const rosterDefs = readdirSync(FIXTURES).filter((f) => f.endsWith('.def')).sort();

// ---------------------------------------------------------------------------
console.log('\n[1] roster defs: fit math, clamps, idempotency');
// Expected outcomes per stage family, derived in the design:
//   view height = fitW * 9/16 must equal design height + declared sky
//   pan edge at max pan (|bound| + fitW/2) must stay inside the art
//   art half = designW/2 + |original bound| (generator matches art to bounds)
for (const f of rosterDefs) {
  const defText = readFileSync(join(FIXTURES, f), 'utf8');
  const [dW, dH] = localcoord(defText);
  const odh = key(defText, 'overdrawhigh') || 0;
  const bl0 = key(defText, 'boundleft');
  const br0 = key(defText, 'boundright');
  const bh0 = key(defText, 'boundhigh');

  const p = makePatcher('expanded');
  p.add('stages/' + f, defText);
  p.run('stages/' + f);
  const out = p.text('stages/' + f);
  const [fitW] = localcoord(out);

  ok(`${f}: localcoord ${dW} -> ${fitW} (design ${dH}u + sky ${odh}u)`, () => {
    const targetW = Math.round((dH + odh) * 16 / 9);
    const artCap = Math.floor(2 * Math.min(dW / 2 + Math.max(0, -bl0), dW / 2 + Math.max(0, br0)));
    assert.strictEqual(fitW, Math.min(targetW, artCap));
    // the fitted view must cover design+sky height, never exceed the art
    const viewH = fitW * 9 / 16;
    assert.ok(viewH >= dH + odh - 1 && viewH <= dH + odh + 1, `viewH ${viewH} != ${dH + odh} +/-1`);
  });
  ok(`${f}: pan bounds tightened to the art edge`, () => {
    const artL = dW / 2 + Math.max(0, -bl0);
    const artR = dW / 2 + Math.max(0, br0);
    const newBL = key(out, 'boundleft');
    const newBR = key(out, 'boundright');
    assert.strictEqual(newBL, -Math.floor(artL - fitW / 2));
    assert.strictEqual(newBR, Math.floor(artR - fitW / 2));
    // tighter than before, and the max-pan view edge stays inside the art
    assert.ok(Math.abs(newBL) < Math.abs(bl0) && newBR < br0, 'bounds not tightened');
    assert.ok(Math.abs(newBL) + fitW / 2 <= artL + 0.001, 'left pan edge leaves the art');
    assert.ok(newBR + fitW / 2 <= artR + 0.001, 'right pan edge leaves the art');
  });
  ok(`${f}: overdrawlow 0, boundhigh ceiling 0`, () => {
    assert.strictEqual(key(out, 'overdrawlow'), 0);
    const missingU2 = fitW * 9 / 16 - dH;
    const budget = Math.max(0, Math.round(odh - missingU2));
    assert.strictEqual(key(out, 'boundhigh'), budget ? -budget : 0);
    assert.ok(-Math.min(bh0, 0) > budget || key(out, 'boundhigh') === bh0, 'boundhigh loosened');
  });
  ok(`${f}: idempotent (second run rewrites nothing)`, () => {
    p.run('stages/' + f);
    assert.strictEqual(p.text('stages/' + f), out);
  });
}

// ---------------------------------------------------------------------------
console.log('\n[1b] TALL mode: roster defs (the restored classic fitted-4:3 geometry)');
for (const f of rosterDefs) {
  const defText = readFileSync(join(FIXTURES, f), 'utf8');
  const [dW, dH] = localcoord(defText);
  const odh = key(defText, 'overdrawhigh') || 0;
  const bl0 = key(defText, 'boundleft');
  const br0 = key(defText, 'boundright');

  const p = makePatcher('tall');
  p.add('stages/' + f, defText);
  p.run('stages/' + f);
  const out = p.text('stages/' + f);
  const [fitW] = localcoord(out);

  ok(`TALL ${f}: localcoord ${dW} -> ${fitW} (design ${dH}u + sky ${odh}u, 4:3 window)`, () => {
    const targetW = Math.round((dH + odh) * 4 / 3);
    const artCap = Math.floor(2 * Math.min(dW / 2 + Math.max(0, -bl0), dW / 2 + Math.max(0, br0)));
    assert.strictEqual(fitW, Math.min(targetW, artCap));
    // the fitted 4:3 view must cover design+sky height, never exceed the art
    const viewH = fitW * 3 / 4;
    assert.ok(viewH >= dH + odh - 1 && viewH <= dH + odh + 1, `viewH ${viewH} != ${dH + odh} +/-1`);
  });
  ok(`TALL ${f}: horizontal pan bounds UNCHANGED (4:3 view pans within art)`, () => {
    assert.strictEqual(key(out, 'boundleft'), bl0);
    assert.strictEqual(key(out, 'boundright'), br0);
  });
  ok(`TALL ${f}: overdrawlow 0, boundhigh ceiling 0, idempotent`, () => {
    assert.strictEqual(key(out, 'overdrawlow'), 0);
    const missingU2 = fitW * 3 / 4 - dH;
    const budget = Math.max(0, Math.round(odh - missingU2));
    assert.strictEqual(key(out, 'boundhigh'), budget ? -budget : 0);
    p.run('stages/' + f);
    assert.strictEqual(p.text('stages/' + f), out);
  });
}

// ---------------------------------------------------------------------------
console.log('\n[1c] TALL mode: concrete roster numbers (must equal the fitted-4:3 era)');
{
  const uiu = readFileSync(join(FIXTURES, 'UIU_Fountain.def'), 'utf8');
  const p = makePatcher('tall');
  p.add('stages/UIU_Fountain.def', uiu);
  p.run('stages/UIU_Fountain.def');
  const out = p.text('stages/UIU_Fountain.def');
  ok('TALL UIU_Fountain: 1088 -> 976, bounds kept ±292, boundhigh -> 0 (view 976x732u)', () => {
    const [w] = localcoord(out);
    assert.strictEqual(w, 976);
    assert.strictEqual(key(out, 'boundleft'), -292);
    assert.strictEqual(key(out, 'boundright'), 292);
    assert.strictEqual(key(out, 'boundhigh'), 0);
    // view 976*3/4 = 732u tall: design 612 + sky 120 — the approved fit
    assert.ok(Math.abs(w * 3 / 4 - 732) < 1e-9);
  });
  const book = readFileSync(join(FIXTURES, 'Bookshop.def'), 'utf8');
  const p2 = makePatcher('tall');
  p2.add('stages/Bookshop.def', book);
  p2.run('stages/Bookshop.def');
  const out2 = p2.text('stages/Bookshop.def');
  ok('TALL Bookshop (1280x720): 1280 -> 1120, bounds kept ±196', () => {
    const [w] = localcoord(out2);
    assert.strictEqual(w, 1120);
    assert.strictEqual(key(out2, 'boundleft'), -196);
    assert.strictEqual(key(out2, 'boundright'), 196);
  });
  const badda = readFileSync(join(FIXTURES, 'Badda_Large_Stage.def'), 'utf8');
  const p3 = makePatcher('tall');
  p3.add('stages/Badda_Large_Stage.def', badda);
  p3.run('stages/Badda_Large_Stage.def');
  const out3 = p3.text('stages/Badda_Large_Stage.def');
  ok('TALL Badda (896x504): 896 -> 832, bounds kept ±388', () => {
    const [w] = localcoord(out3);
    assert.strictEqual(w, 832);
    assert.strictEqual(key(out3, 'boundleft'), -388);
    assert.strictEqual(key(out3, 'boundright'), 388);
  });
}

// ---------------------------------------------------------------------------
console.log('\n[1d] TALL legacy gate: 4:3-family stages fit natively, stay untouched');
{
  // A legacy 320x240 stage WITH declared sky headroom: the old fitted-4:3
  // era left these untouched (their 4:3 view does not exceed the design
  // height) — the restored tall mode must do the same. Expanded still
  // fits them (its view is 16:9 and DOES exceed the design height).
  const legacy = [
    '[StageInfo]', 'zoffset = 220', 'localcoord = 320, 240', '',
    '[Camera]', 'boundleft = -250', 'boundright = 250', 'boundhigh = -140',
    'overdrawhigh = 40', 'overdrawlow = 0', '',
  ].join('\n');
  const pt = makePatcher('tall');
  pt.add('stages/kfm2.def', legacy);
  pt.run('stages/kfm2.def');
  assert.strictEqual(pt.text('stages/kfm2.def'), legacy, 'tall must not touch a 4:3-family stage');
  ok('TALL legacy 320x240 (+sky, +pan art): untouched (historical look kept)', () => {});
  const pe = makePatcher('expanded');
  pe.add('stages/kfm2.def', legacy);
  pe.run('stages/kfm2.def');
  const [w] = localcoord(pe.text('stages/kfm2.def'));
  assert.strictEqual(w, Math.round(280 * 16 / 9), 'expanded should still fit it');
  ok('EXPANDED same stage: still fitted (498 = round(280*16/9))', () => {});
  const p32 = makePatcher('3:2');
  p32.add('stages/kfm2.def', legacy);
  p32.run('stages/kfm2.def');
  const [w32] = localcoord(p32.text('stages/kfm2.def'));
  assert.strictEqual(w32, Math.round(280 * 3 / 2), '3:2 should still fit it');
  ok('3:2 same stage: still fitted (420 = round(280*3/2))', () => {});
}

// ---------------------------------------------------------------------------
console.log('\n[1e] 3:2 WIDE mode: roster defs (the fitted ladder\'s middle rung)');
for (const f of rosterDefs) {
  const defText = readFileSync(join(FIXTURES, f), 'utf8');
  const [dW, dH] = localcoord(defText);
  const odh = key(defText, 'overdrawhigh') || 0;
  const bl0 = key(defText, 'boundleft');
  const br0 = key(defText, 'boundright');
  const bh0 = key(defText, 'boundhigh');

  const p = makePatcher('3:2');
  p.add('stages/' + f, defText);
  p.run('stages/' + f);
  const out = p.text('stages/' + f);
  const [fitW] = localcoord(out);

  ok(`3:2 ${f}: localcoord ${dW} -> ${fitW} (design ${dH}u + sky ${odh}u, 3:2 window)`, () => {
    const targetW = Math.round((dH + odh) * 3 / 2);
    const artCap = Math.floor(2 * Math.min(dW / 2 + Math.max(0, -bl0), dW / 2 + Math.max(0, br0)));
    assert.strictEqual(fitW, Math.min(targetW, artCap));
    // the fitted 3:2 view must cover design+sky height, never exceed the art
    const viewH = fitW * 2 / 3;
    assert.ok(viewH >= dH + odh - 1 && viewH <= dH + odh + 1, `viewH ${viewH} != ${dH + odh} +/-1`);
  });
  ok(`3:2 ${f}: pan bounds only ever tighten, edges stay inside the art`, () => {
    const artL = dW / 2 + Math.max(0, -bl0);
    const artR = dW / 2 + Math.max(0, br0);
    const newBL = key(out, 'boundleft');
    const newBR = key(out, 'boundright');
    assert.ok(newBL >= bl0 && newBR <= br0, 'bounds loosened');
    assert.ok(Math.abs(newBL) + fitW / 2 <= artL + 0.001, 'left pan edge leaves the art');
    assert.ok(newBR + fitW / 2 <= artR + 0.001, 'right pan edge leaves the art');
  });
  ok(`3:2 ${f}: overdrawlow 0, boundhigh ceiling, idempotent`, () => {
    assert.strictEqual(key(out, 'overdrawlow'), 0);
    const missingU2 = fitW * 2 / 3 - dH;
    const budget = Math.max(0, Math.round(odh - missingU2));
    assert.strictEqual(key(out, 'boundhigh'), budget ? -budget : 0);
    assert.ok(-Math.min(bh0, 0) > budget || key(out, 'boundhigh') === bh0, 'boundhigh loosened');
    p.run('stages/' + f);
    assert.strictEqual(p.text('stages/' + f), out);
  });
}

// ---------------------------------------------------------------------------
console.log('\n[1f] 3:2 WIDE mode: concrete roster numbers');
{
  const uiu = readFileSync(join(FIXTURES, 'UIU_Fountain.def'), 'utf8');
  const p = makePatcher('3:2');
  p.add('stages/UIU_Fountain.def', uiu);
  p.run('stages/UIU_Fountain.def');
  const out = p.text('stages/UIU_Fountain.def');
  ok('3:2 UIU_Fountain: 1088 -> 1098, bounds ±292 -> ±287, boundhigh -> 0 (view 1098x732u)', () => {
    const [w] = localcoord(out);
    assert.strictEqual(w, 1098);
    assert.strictEqual(key(out, 'boundleft'), -287);
    assert.strictEqual(key(out, 'boundright'), 287);
    assert.strictEqual(key(out, 'boundhigh'), 0);
    // view 1098*2/3 = 732u tall: design 612 + sky 120 — the same vertical
    // art as Tall/Expanded, in the middle window
    assert.ok(Math.abs(w * 2 / 3 - 732) < 1e-9);
  });
  const book = readFileSync(join(FIXTURES, 'Bookshop.def'), 'utf8');
  const p2 = makePatcher('3:2');
  p2.add('stages/Bookshop.def', book);
  p2.run('stages/Bookshop.def');
  const out2 = p2.text('stages/Bookshop.def');
  ok('3:2 Bookshop (1280x720): 1280 -> 1260, bounds kept ±196 (view already inside art)', () => {
    const [w] = localcoord(out2);
    assert.strictEqual(w, 1260);
    assert.strictEqual(key(out2, 'boundleft'), -196);
    assert.strictEqual(key(out2, 'boundright'), 196);
  });
  const badda = readFileSync(join(FIXTURES, 'Badda_Large_Stage.def'), 'utf8');
  const p3 = makePatcher('3:2');
  p3.add('stages/Badda_Large_Stage.def', badda);
  p3.run('stages/Badda_Large_Stage.def');
  const out3 = p3.text('stages/Badda_Large_Stage.def');
  ok('3:2 Badda (896x504): 896 -> 936, bounds ±388 -> ±368', () => {
    const [w] = localcoord(out3);
    assert.strictEqual(w, 936);
    assert.strictEqual(key(out3, 'boundleft'), -368);
    assert.strictEqual(key(out3, 'boundright'), 368);
  });
}

// ---------------------------------------------------------------------------
console.log('\n[2] concrete roster numbers (the design\'s headline figures)');
{
  const uiu = readFileSync(join(FIXTURES, 'UIU_Fountain.def'), 'utf8');
  const p = makePatcher('expanded');
  p.add('stages/UIU_Fountain.def', uiu);
  p.run('stages/UIU_Fountain.def');
  const out = p.text('stages/UIU_Fountain.def');
  ok('UIU_Fountain: 1088 -> 1301, bounds ±292 -> ±185, boundhigh -328 -> 0', () => {
    const [w] = localcoord(out);
    assert.strictEqual(w, 1301);
    assert.strictEqual(key(out, 'boundleft'), -185);
    assert.strictEqual(key(out, 'boundright'), 185);
    assert.strictEqual(key(out, 'boundhigh'), 0);
    // view 1301*9/16 = 731.8u tall: the same vertical fit as the old 4:3 mode
    assert.ok(Math.abs(w * 9 / 16 - 731.8125) < 1e-9);
  });
  const book = readFileSync(join(FIXTURES, 'Bookshop.def'), 'utf8');
  const p2 = makePatcher('expanded');
  p2.add('stages/Bookshop.def', book);
  p2.run('stages/Bookshop.def');
  const out2 = p2.text('stages/Bookshop.def');
  ok('Bookshop (1280x720): 1280 -> 1493, bounds ±196 -> ±89', () => {
    const [w] = localcoord(out2);
    assert.strictEqual(w, 1493);
    assert.strictEqual(key(out2, 'boundleft'), -89);
    assert.strictEqual(key(out2, 'boundright'), 89);
  });
  const badda = readFileSync(join(FIXTURES, 'Badda_Large_Stage.def'), 'utf8');
  const p3 = makePatcher('expanded');
  p3.add('stages/Badda_Large_Stage.def', badda);
  p3.run('stages/Badda_Large_Stage.def');
  const out3 = p3.text('stages/Badda_Large_Stage.def');
  ok('Badda (896x504): 896 -> 1109, bounds ±388 -> ±281', () => {
    const [w] = localcoord(out3);
    assert.strictEqual(w, 1109);
    assert.strictEqual(key(out3, 'boundleft'), -281);
    assert.strictEqual(key(out3, 'boundright'), 281);
  });
}

// ---------------------------------------------------------------------------
console.log('\n[3] gates and edge cases');
ok('16:9 gate: stageFitMode=null leaves defs byte-identical', () => {
  for (const f of rosterDefs) {
    const defText = readFileSync(join(FIXTURES, f), 'utf8');
    const p = makePatcher(null);
    p.add('stages/' + f, defText);
    p.run('stages/' + f);
    assert.strictEqual(p.text('stages/' + f), defText, f);
  }
});
ok('stage-path gate: non-stage defs untouched even when expanded', () => {
  const defText = readFileSync(join(FIXTURES, 'UIU_Fountain.def'), 'utf8');
  for (const vp of ['data/system.def', 'chars/Broly/broly.def', 'stages/sub/x.def', 'stages/readme.txt']) {
    const p = makePatcher('expanded');
    p.add(vp, defText);
    p.run(vp);
    assert.strictEqual(p.text(vp), defText, vp);
  }
});
ok('data/stages/ alias path IS patched', () => {
  const defText = readFileSync(join(FIXTURES, 'UIU_Fountain.def'), 'utf8');
  const p = makePatcher('expanded');
  p.add('data/stages/UIU_Fountain.def', defText);
  p.run('data/stages/UIU_Fountain.def');
  const [w] = localcoord(p.text('data/stages/UIU_Fountain.def'));
  assert.strictEqual(w, 1301);
});
ok('legacy 320x240 WITH pan art gets the full fit (no vertical crop)', () => {
  const legacy = [
    '[StageInfo]', 'zoffset = 220', 'localcoord = 320, 240', '',
    '[Camera]', 'boundleft = -250', 'boundright = 250', 'boundhigh = -140',
    'overdrawhigh = 0', 'overdrawlow = 0', '',
  ].join('\n');
  const p = makePatcher('expanded');
  p.add('stages/kfm.def', legacy);
  p.run('stages/kfm.def');
  const out = p.text('stages/kfm.def');
  const [w] = localcoord(out);
  assert.strictEqual(w, 427); // round(240 * 16/9): full design height kept
  assert.strictEqual(key(out, 'boundleft'), -196); // -(410 - 213.5) floored
  assert.strictEqual(key(out, 'boundright'), 196);
  assert.strictEqual(key(out, 'boundhigh'), 0);
});
ok('legacy 320x240 with NO pan art is untouched (art cap binds at design)', () => {
  const legacy = [
    '[StageInfo]', 'zoffset = 220', 'localcoord = 320, 240', '',
    '[Camera]', 'boundleft = 0', 'boundright = 0', 'boundhigh = 0',
    'overdrawhigh = 0', 'overdrawlow = 0', '',
  ].join('\n');
  const p = makePatcher('expanded');
  p.add('stages/tight.def', legacy);
  p.run('stages/tight.def');
  assert.strictEqual(p.text('stages/tight.def'), legacy);
});
ok('missing [Camera] section: capped at the design width, untouched', () => {
  const bare = ['[StageInfo]', 'zoffset = 500', 'localcoord = 1088, 612', ''].join('\n');
  const p = makePatcher('expanded');
  p.add('stages/bare.def', bare);
  p.run('stages/bare.def');
  assert.strictEqual(p.text('stages/bare.def'), bare);
});
ok('missing localcoord: untouched', () => {
  const bare = ['[StageInfo]', 'zoffset = 500', '', '[Camera]', 'boundleft = -292', ''].join('\n');
  const p = makePatcher('expanded');
  p.add('stages/nolc.def', bare);
  p.run('stages/nolc.def');
  assert.strictEqual(p.text('stages/nolc.def'), bare);
});
ok('cp1252 bytes in comments/displayname survive the round-trip', () => {
  const defText = readFileSync(join(FIXTURES, 'UIU_Fountain.def'), 'utf8')
    .replace('displayname \t= "UIU Fountain"', 'displayname \t= "UIU Fount\xe4in \x97 ok"');
  // Store as RAW latin1 bytes (like the real CDN/pak pipeline does) —
  // TextEncoder would silently re-encode to UTF-8 before the patch runs.
  const rawBytes = new Uint8Array([...defText].map((c) => c.charCodeAt(0) & 0xff));
  const p = makePatcher('expanded');
  p.contents.set('stages/UIU_Fountain.def', rawBytes);
  p.run('stages/UIU_Fountain.def');
  const outBytes = p.contents.get('stages/UIU_Fountain.def');
  assert.ok(outBytes.includes(0xe4) && outBytes.includes(0x97), 'high bytes mangled');
  const out = p.text('stages/UIU_Fountain.def');
  assert.ok(out.includes('displayname \t= "UIU Fount\xe4in \x97 ok"'));
  const [w] = localcoord(out);
  assert.strictEqual(w, 1301);
});
ok('unmaterialized path: no crash, retried on the next open', () => {
  const p = makePatcher('expanded');
  p.run('stages/not-there.def'); // must not throw
});

// ---------------------------------------------------------------------------
console.log(`\nALL ${passedCount} ASSERTION GROUPS PASSED`);
