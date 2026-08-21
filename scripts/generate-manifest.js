const fs = require('fs');
const path = require('path');

// Walk a directory recursively, returning { vpath: size } entries.
// vpath is relative to the root (e.g. "data/common1.cns").
function walkDir(dir, base = '') {
  const files = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, walkDir(full, rel));
    } else {
      files[rel.replace(/\\/g, '/')] = fs.statSync(full).size;
    }
  }
  return files;
}

const dataRoot = path.join(__dirname, '..', 'public', 'game', 'ikemen-fs', 'file');
const manifest = walkDir(dataRoot);

// Ensure save directory exists as a virtual entry. The engine creates these
// at runtime if missing, but listing them in the manifest lets the VFS
// resolve stat() calls without a network fetch.
// NOTE: only add entries for files that DON'T already exist on disk —
// walkDir already picked up real files with their actual sizes.
// Previously this overwrote save/config.ini (4982 bytes) with 0, causing
// the engine to think config.ini was empty and ignore all our settings.
if (!manifest['save/config.ini']) manifest['save/config.ini'] = 0;
if (!manifest['save/config.json']) manifest['save/config.json'] = 0;
if (!manifest['save/stats.json']) manifest['save/stats.json'] = 0;

const outPath = path.join(__dirname, '..', 'public', 'game', 'ikemen-fs', 'manifest.json');
fs.writeFileSync(outPath, JSON.stringify({ files: manifest }, null, 0)); // compact JSON
const count = Object.keys(manifest).length;
const totalBytes = Object.values(manifest).reduce((a, b) => a + b, 0);
console.log(`Manifest: ${count} files, ${(totalBytes / 1e6).toFixed(1)} MB`);
