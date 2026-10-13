#!/usr/bin/env node
// Bundle ESSENTIAL VFS files into a single .pak for fast boot.
//
// Only fight-essential files go into the .pak (loaded in one HTTP request).
// Menu-only assets (system.sff, system.snd, icons, fonts) are kept as
// individual files in the manifest for lazy loading by vfs.js's background
// prefetch. This gives us:
//   - Fast boot: one HTTP request for ~10 MB of essential files
//   - No waste: 19 MB of menu assets only fetched if needed (they're not)
//
// The manifest uses the PACKED format for essential files:
//   { pack: 'game.pak',
//     stamp: '<timestamp>',
//     files: { vpath: [offset, length] }  // essential files from .pak
//     lazy: { vpath: size }               // menu assets, lazy-loaded
//   }
//
// vfs.js loads the .pak up front, then background-prefetches the lazy files.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const dataRoot = path.join(__dirname, '..', 'public', 'game', 'ikemen-fs', 'file');
const pakPath = path.join(__dirname, '..', 'public', 'game', 'ikemen-fs', 'game.pak');
const manifestPath = path.join(__dirname, '..', 'public', 'game', 'ikemen-fs', 'manifest.json');

// Walk a directory recursively
function walkDir(dir, base = '') {
  const files = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, walkDir(full, rel));
    } else {
      files[rel.replace(/\\/g, '/')] = full;
    }
  }
  return files;
}

// Essential files — needed to start a fight
function isEssential(f) {
  if (f === 'save/config.ini') return true;
  if (f.startsWith('external/script/')) return true;
  // NOTE: no bundled characters/stages anymore (kfm + the training stage were
  // removed) — fighters and stages are injected/downloaded from the CDN.
  if (f.startsWith('stages/')) return true;
  // data/fight.snd alone is ~6.4 MB (63% of the whole pak) — pure fight
  // sounds. As a registered lazy file the engine open()s it on demand
  // (deduped with the background warmup), which cuts the boot-critical
  // download by more than half. Every other data/fight* file stays
  // essential (fight.sff/fight.def draw the lifebar from frame one).
  if (f === 'data/fight.snd') return false;
  if (f.startsWith('data/fight')) return true;
  if (f.startsWith('data/common')) return true;
  if (f.startsWith('data/fightfx')) return true;
  if (f.startsWith('data/gofx/')) return true;
  if (f.startsWith('data/glyphs')) return true;
  if (f.endsWith('.zss')) return true;
  if (f === 'data/ikemen1/system.def') return true;
  if (f === 'data/ikemen1/fight.def') return true;
  if (f === 'data/select.def') return true;
  if (f === 'data/system.zss') return true;
  if (f === 'font/debug.def') return true;
  if (f === 'external/mods/.keep') return true;
  // Icons — engine panics without them (WindowIcon in config.ini)
  if (f.startsWith('external/icons/')) return true;
  return false;
}

console.log('Scanning VFS files...');
const allFiles = walkDir(dataRoot);
const filePaths = Object.keys(allFiles);
console.log(`Found ${filePaths.length} files total`);

// Byte-identical duplicates that must NOT ship in the lazy set. The loose
// data/system.snd is an exact copy (md5 4125a458...) of the motif's
// data/ikemen1/system.snd, and nothing references it: the motif resolves
// `snd = system.snd` relative to its own directory. Listing it cost 3.51MB
// of download + retained heap on EVERY boot for nothing. vfs.js
// (resolveDataAlias) aliases any bare data/system.snd request to the motif
// copy, so excluding it here is fully transparent.
const LAZY_EXCLUDE = new Set(['data/system.snd']);

// Split into essential (go into .pak) and lazy (individual files)
const essentialPaths = filePaths.filter(isEssential).sort();
const lazyPaths = filePaths.filter(f => !isEssential(f) && !LAZY_EXCLUDE.has(f)).sort();

console.log(`Essential (in .pak): ${essentialPaths.length} files`);
console.log(`Lazy (individual): ${lazyPaths.length} files`);

// Build the .pak file with essential files
const manifest = {
  pack: 'game.pak',
  files: {},  // essential files: [offset, length]
  lazy: {},   // lazy files: size (for manifest.has() checks)
};

const chunks = [];
let offset = 0;
let essentialBytes = 0;

for (const vpath of essentialPaths) {
  const data = fs.readFileSync(allFiles[vpath]);
  chunks.push(data);
  manifest.files[vpath] = [offset, data.length];
  offset += data.length;
  essentialBytes += data.length;
}

// Add lazy files to manifest with their sizes
let lazyBytes = 0;
for (const vpath of lazyPaths) {
  const size = fs.statSync(allFiles[vpath]).size;
  manifest.lazy[vpath] = size;
  lazyBytes += size;
}

// Add virtual entries for save/ (engine creates these at runtime)
if (!manifest.files['save/config.ini']) manifest.files['save/config.ini'] = [0, 0];
if (!manifest.files['save/config.json']) manifest.files['save/config.json'] = [0, 0];
if (!manifest.files['save/stats.json']) manifest.files['save/stats.json'] = [0, 0];

// Write .pak file (essential files only)
const pak = Buffer.concat(chunks);
fs.writeFileSync(pakPath, pak);
console.log(`\nWrote game.pak: ${pak.length.toLocaleString()} bytes (${(pak.length / 1e6).toFixed(1)} MB)`);

// Pre-gzipped pak: the wire format (vfs.js streams it through
// DecompressionStream into the same final buffer). ~35% smaller than raw;
// served immutable because the stamp below is CONTENT-derived.
const pakGz = zlib.gzipSync(pak, { level: 9 });
fs.writeFileSync(pakPath + '.gz', pakGz);
console.log(`Wrote game.pak.gz: ${pakGz.length.toLocaleString()} bytes (${(pakGz.length / 1e6).toFixed(1)} MB, -${Math.round((1 - pakGz.length / pak.length) * 100)}%)`);

// Content-derived stamp: identical pak bytes -> identical stamp, so a
// rebuild that changed nothing keeps every asset URL stable and the
// immutable cache entries valid. Date.now() busting all URLs on every
// rebuild was pure cache waste.
manifest.stamp = crypto.createHash('sha256').update(pak).digest('hex').slice(0, 12);
console.log(`  Essential: ${essentialPaths.length} files, ${(essentialBytes / 1e6).toFixed(1)} MB`);
console.log(`  Lazy:      ${lazyPaths.length} files, ${(lazyBytes / 1e6).toFixed(1)} MB`);
console.log(`  Total:     ${essentialPaths.length + lazyPaths.length} files, ${((essentialBytes + lazyBytes) / 1e6).toFixed(1)} MB`);

// Write manifest
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`\nManifest written with stamp: ${manifest.stamp}`);
