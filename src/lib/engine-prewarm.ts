// Engine-asset prewarm — pull engine.wasm.gz + game.pak.gz into the browser's
// immutable HTTP cache BEFORE the /play boot needs them.
//
// WHY: /play downloads the 5.3 MB compressed engine + 2 MB compressed pak
// inside its boot window. The select screens (roster browsing, match-prep
// countdown) have idle network time — fetching the stamped URLs there (and
// dropping the bodies) warms the HTTP cache, so /play's real fetches are
// disk-cache hits and the engine boot starts compiling immediately.
// Both URLs are stamped with the manifest's content hash and served
// `max-age=31536000, immutable` (vercel.json), so a warmed copy is always
// exactly the build /play wants — there is no staleness risk.
//
// This is the local-mode mirror of the net=1 preboot (which starts the wasm
// compile + pak load while players are still in the select screens).

const PREWARM_FLAG = 'fg-engine-prewarm';

let started = false;

export function prewarmEngineAssets(): void {
  if (typeof window === 'undefined' || started) return;
  // Browsers without DecompressionStream never fetch the .gz URLs on /play
  // (the boot path falls back to the raw, no-cache wasm) — nothing to warm.
  if (typeof DecompressionStream !== 'function') return;
  started = true;
  try {
    if (sessionStorage.getItem(PREWARM_FLAG)) return;
  } catch { /* private mode — just warm again */ }

  (async () => {
    try {
      const r = await fetch('/game/engine-fs/manifest.json', { cache: 'no-store' });
      if (!r.ok) return;
      const stamp = ((await r.json()) as { stamp?: string }).stamp || '';
      const qs = stamp ? '?v=' + encodeURIComponent(stamp) : '';
      // Bodies are read and dropped: a fully-read response is the only kind
      // the HTTP cache reliably stores, and the dropped Blob is disk-backed
      // so the JS heap never carries the payload.
      await Promise.allSettled([
        fetch('/game/engine.wasm.gz' + qs, { cache: 'default' })
          .then(x => (x.ok ? x.blob() : null)),
        fetch('/game/engine-fs/game.pak.gz' + qs, { cache: 'default' })
          .then(x => (x.ok ? x.blob() : null)),
      ]);
      try { sessionStorage.setItem(PREWARM_FLAG, '1'); } catch { /* ignore */ }
    } catch {
      // Best-effort warmup — /play's boot path downloads whatever is missing.
    }
  })();
}
