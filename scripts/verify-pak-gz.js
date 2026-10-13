#!/usr/bin/env node
// Sanity-check the generated pak/manifest/gz artifacts:
//  1. manifest.files offsets exactly tile the pak (max end == pak.length)
//  2. every essential file's bytes in the pak match the loose file on disk
//  3. game.pak.gz gunzips to exactly the pak bytes
//  4. ikemen.wasm.gz gunzips to exactly ikemen.wasm
//  5. fight.snd is lazy + present in manifest.lazy and NOT in files
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const root = path.join(__dirname, '..', 'public', 'game', 'ikemen-fs');
const fileRoot = path.join(root, 'file');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pak = fs.readFileSync(path.join(root, 'game.pak'));
const pakGz = fs.readFileSync(path.join(root, 'game.pak.gz'));
const ok = [];

// 1. tiling
let pakSize = 0;
for (const [vpath, [off, len]] of Object.entries(manifest.files)) {
  const end = off + len;
  if (end > pakSize) pakSize = end;
}
if (pakSize !== pak.length) throw new Error(`manifest max-end ${pakSize} != pak length ${pak.length}`);
ok.push(`pak tiling OK (${pakSize} bytes)`);

// 2. byte-identity of packed files vs loose files
let checked = 0;
for (const [vpath, [off, len]] of Object.entries(manifest.files)) {
  if (len === 0) continue; // virtual entries
  const loose = fs.readFileSync(path.join(fileRoot, vpath));
  if (loose.length !== len) throw new Error(`${vpath}: loose ${loose.length} != packed ${len}`);
  if (!pak.subarray(off, off + len).equals(loose)) throw new Error(`${vpath}: bytes differ between pak and loose file`);
  checked++;
}
ok.push(`${checked} packed files byte-identical to loose files`);

// 3. pak.gz roundtrip
const un = zlib.gunzipSync(pakGz);
if (!un.equals(pak)) throw new Error('game.pak.gz does not round-trip to game.pak');
ok.push(`game.pak.gz round-trips (${(pakGz.length / 1e6).toFixed(2)} MB gz)`);

// 4. wasm.gz roundtrip
const wasm = fs.readFileSync(path.join(__dirname, '..', 'public', 'game', 'ikemen.wasm'));
const wasmGz = fs.readFileSync(path.join(__dirname, '..', 'public', 'game', 'ikemen.wasm.gz'));
if (!zlib.gunzipSync(wasmGz).equals(wasm)) throw new Error('ikemen.wasm.gz does not round-trip');
ok.push(`ikemen.wasm.gz round-trips (${(wasmGz.length / 1e6).toFixed(2)} MB gz)`);

// 5. fight.snd placement
if (manifest.files['data/fight.snd']) throw new Error('fight.snd still packed');
if (!manifest.lazy['data/fight.snd']) throw new Error('fight.snd not in lazy set');
if (!fs.existsSync(path.join(fileRoot, 'data/fight.snd'))) throw new Error('fight.snd loose file missing');
ok.push(`fight.snd lazy (loose file present, ${(manifest.lazy['data/fight.snd'] / 1e6).toFixed(1)} MB)`);

// 6. stamp is content-derived (sha256(pak)[:12])
const expect = crypto.createHash('sha256').update(pak).digest('hex').slice(0, 12);
if (manifest.stamp !== expect) throw new Error(`stamp ${manifest.stamp} != content hash ${expect}`);
ok.push(`stamp is content-derived: ${manifest.stamp}`);

console.log(ok.map(s => 'PASS ' + s).join('\n'));
console.log(`\nBoot-critical wire: wasm.gz ${(wasmGz.length / 1e6).toFixed(2)} MB + pak.gz ${(pakGz.length / 1e6).toFixed(2)} MB = ${((wasmGz.length + pakGz.length) / 1e6).toFixed(2)} MB (was ~33 MB raw)`);
