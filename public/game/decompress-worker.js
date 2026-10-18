// Boot decompression worker — gunzip boot-critical assets OFF the main
// thread. The /play cold boot piles wasm compile + pak decompress +
// character materialization + engine start onto one main thread; the two
// big .gz streams were the easiest chunk to relocate. Streams arrive
// TRANSFERRED (zero-copy handoff, no doubled heap) and a decompressed
// ReadableStream is transferred straight back — the main thread never
// touches a single inflated byte.
//
// Protocol:
//   main -> { id, op: 'ping' }                capability handshake
//   main -> { id, op: 'gunzip', stream }      stream is TRANSFERRED in
//   worker -> { id, ok: true, stream }        decompressed, TRANSFERRED out
//   worker -> { id, ok: false, err: string }  main falls back to inline
//
// The ping exists so the main thread never transfers a response body into
// a worker that turns out to lack DecompressionStream — that body would be
// unrecoverable and the boot would need a full re-download.

let gzipOk = typeof DecompressionStream === 'function';

self.onmessage = (e) => {
  const msg = e.data || {};
  const id = msg.id;

  if (msg.op === 'ping') {
    self.postMessage({ id, ok: true, gzip: gzipOk });
    return;
  }

  if (msg.op === 'gunzip') {
    if (!gzipOk || !msg.stream) {
      self.postMessage({ id, ok: false, err: 'gunzip unsupported in worker' });
      return;
    }
    try {
      const out = msg.stream.pipeThrough(new DecompressionStream('gzip'));
      self.postMessage({ id, ok: true, stream: out }, [out]);
    } catch (err) {
      self.postMessage({ id, ok: false, err: String((err && err.message) || err) });
    }
  }
};
