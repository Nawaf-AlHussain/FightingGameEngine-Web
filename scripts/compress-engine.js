#!/usr/bin/env node
// Precompress the engine WASM for the wire.
//
// engine.wasm is a ~23 MB raw binary; gzip -9 brings it to ~5.3 MB (-77%).
// The boot page fetches engine.wasm.gz?v=<stamp> (served immutable) and
// streams it through DecompressionStream('gzip') into
// WebAssembly.instantiateStreaming, so decompression overlaps the download
// and compilation overlaps decompression. Raw engine.wasm remains as the
// fallback for browsers without DecompressionStream.
//
// Re-run whenever engine.wasm changes:  node scripts/compress-engine.js
// (idempotent: skips when the .gz is newer than the .wasm)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const wasmPath = path.join(__dirname, '..', 'public', 'game', 'engine.wasm');
const gzPath = wasmPath + '.gz';

const wasmStat = fs.statSync(wasmPath);
if (fs.existsSync(gzPath) && fs.statSync(gzPath).mtimeMs >= wasmStat.mtimeMs) {
  console.log('engine.wasm.gz is up to date — skipping.');
  process.exit(0);
}

const raw = fs.readFileSync(wasmPath);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(gzPath, gz);
console.log(`Wrote engine.wasm.gz: ${(gz.length / 1e6).toFixed(2)} MB (raw ${(raw.length / 1e6).toFixed(2)} MB, -${Math.round((1 - gz.length / raw.length) * 100)}%)`);
