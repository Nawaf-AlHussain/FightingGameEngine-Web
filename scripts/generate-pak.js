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
  if (f.startsWith('chars/kfm/')) return true;
  if (f.startsWith('stages/')) return true;
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
  return false;
}

console.log('Scanning VFS files...');
const allFiles = walkDir(dataRoot);
const filePaths = Object.keys(allFiles);
console.log(`Found ${filePaths.length} files total`);

// Split into essential (go into .pak) and lazy (individual files)
const essentialPaths = filePaths.filter(isEssential).sort();
const lazyPaths = filePaths.filter(f => !isEssential(f)).sort();

console.log(`Essential (in .pak): ${essentialPaths.length} files`);
console.log(`Lazy (individual): ${lazyPaths.length} files`);

// Build the .pak file with essential files
const manifest = {
  stamp: String(Math.floor(Date.now() / 1000)),
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
console.log(`  Essential: ${essentialPaths.length} files, ${(essentialBytes / 1e6).toFixed(1)} MB`);
console.log(`  Lazy:      ${lazyPaths.length} files, ${(lazyBytes / 1e6).toFixed(1)} MB`);
console.log(`  Total:     ${essentialPaths.length + lazyPaths.length} files, ${((essentialBytes + lazyBytes) / 1e6).toFixed(1)} MB`);

// Write manifest
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`\nManifest written with stamp: ${manifest.stamp}`);
