/* Fighting Game Engine — service worker
 *
 * Why it exists: Chrome only offers the address-bar "Install" button when the
 * app is a real PWA — a valid manifest (icons 192+512) AND a registered
 * service worker with a fetch handler. This SW is intentionally minimal and
 * NON-INVASIVE:
 *
 *   - It never intercepts /game/* or /api/* (the engine's wasm/pak streams and
 *     the CDN proxy already have their own immutable-HTTP + IndexedDB caching
 *     layers; a second cache would double-store ~33 MB binaries and risk
 *     interfering with streaming boot).
 *   - Cache-first ONLY for content-hashed build output (/_next/static/*) and
 *     versioned app icons — files whose URLs change when content changes.
 *   - Network-first for page navigations, falling back to the last-seen copy
 *     so visited screens still open offline.
 *   - Everything else (cross-origin, non-GET, Range, dev chunks) passes
 *     straight through untouched.
 *
 * Bump VERSION when shipping changes that SW-cached files depend on.
 */
const VERSION = 'fge-sw-v1';
const ASSET_CACHE = `${VERSION}-assets`;
const PAGE_CACHE = `${VERSION}-pages`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGE_CACHE);
      // Warm the hub page so an installed app can boot to the title screen
      // even on its first offline launch. Failures are non-fatal.
      await cache.add(new Request('/lobby', { cache: 'no-cache' })).catch(() => {});
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (!name.startsWith(VERSION)) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The engine's own pipeline: pass through, zero interference.
  if (url.pathname.startsWith('/game/') || url.pathname.startsWith('/api/')) return;
  if (req.headers.has('range')) return;

  // Content-hashed / versioned files: cache-first is safe.
  const isImmutableAsset =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json';

  if (isImmutableAsset) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req, PAGE_CACHE));
  }
  // Everything else: default network (no respondWith = plain passthrough).
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirstPage(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Offline: any cached copy of this route beats nothing. ignoreSearch so
    // /play?p=...&s=... can fall back to the bare route shell.
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}
