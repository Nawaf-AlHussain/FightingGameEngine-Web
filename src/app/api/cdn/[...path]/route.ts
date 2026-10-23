import { NextRequest, NextResponse } from 'next/server';

// CDN proxy: fetches character/stage files and serves them to the browser
// with CORS headers. jsDelivr returns 403 for some files (especially those
// with special characters like '!' in the name), and raw.githubusercontent.com
// doesn't set CORS headers, so the browser can't fetch directly. This
// server-side proxy solves both problems.
//
// URL format: /api/cdn/chars/Bardock/Bardock.sff
//
// ── THE CONTENT-LENGTH RULE (Oct-2025 black-screen incident) ──────────────
// The engine parses a character's .def, then opens every file it lists. A
// def truncated mid-line ("st = a" out of "st = android16.cns") makes it try
// to open a state file literally named "a", panic at fight load
// ("open a: No such file or directory"), and black-screen — in every mode.
//
// HOW A DEF GETS TRUNCATED: this route's upstream fetch runs through
// Next/undici, which transparently COMPRESSES the transfer (Accept-Encoding)
// and DECOMPRESSES res.body — while res.headers['content-length'] still
// carries the COMPRESSED wire size (e.g. 259 for a 444-byte def). The old
// handler passed that header through untouched next to the DECOMPRESSED
// body. Downstream caches (Vercel edge, browser) trust content-length and
// cut/serve exactly that many bytes — so every asset whose gzip size is
// smaller than its real size was silently truncated to its gzip size, then
// pinned by s-maxage. The ?v= versioned URLs (netplay byte-consistency fix)
// repopulated the entire edge namespace afterwards, so effectively every
// character downloaded since then was a truncated-bytes lottery — local and
// online alike. jsDelivr-vs-GitHub-raw was never the problem: BOTH upstreams
// delivered correct 444-byte bodies with lying (compressed) headers.
//
// THEREFORE, in this handler:
//  1. `content-length` is NEVER relayed from upstream. In the buffered path
//     it is re-set from the verified local body; in the streaming path it is
//     omitted entirely (chunked transfer-encoding) because the true
//     decompressed size is unknowable without buffering.
//  2. Files ≤ VERIFY_BUFFER_LIMIT are buffered once (bounded serverless
//     memory — never a whole 100 MB character per request) and served from
//     the buffer, so the length we declare is the length we served.
//  3. Larger files stream. They are cacheable ONLY via jsDelivr (its edge
//     handles integrity); if the streaming source is GitHub raw the response
//     is no-store so a suspect body can never outlive the request.
//  4. Range requests are not forwarded: a 206 partial body cached under a
//     full URL is another way to pin incomplete bytes. No consumer needs
//     Range today (the downloader fetches whole files).
//  5. Cache-buster interplay: character-downloader.ts appends
//     ?v=<manifestVersion>.rN (CACHE_BUSTER_BUMP) to every asset URL. Bump
//     that constant to make every entry poisoned under an old namespace
//     unreachable AND to force IndexedDB meta staleness (device-side
//     re-download) in one deploy. r2 = this incident.

// Upstream Assets repo. Production uses FightingGameEngine/Assets; the demo
// deployment (FightingGameEngine-Demo on Vercel) points ASSETS_GH_REPO at its
// own mirror repo (FightingGameEngine/DemoAssets) so the two rosters can
// diverge. Read per-request (not at module scope) so a Vercel env change
// applies on the next invocation without a rebuild.
const DEFAULT_ASSETS_REPO = 'FightingGameEngine/Assets';

function upstreamBases(): { jsdelivrBase: string; githubRawBase: string } {
  const repo = process.env.ASSETS_GH_REPO || DEFAULT_ASSETS_REPO;
  return {
    jsdelivrBase: `https://cdn.jsdelivr.net/gh/${repo}@main/`,
    githubRawBase: `https://raw.githubusercontent.com/${repo}/main/`,
  };
}

// Files at or below this size are buffered and served with an exact
// Content-Length (portraits, .def/.cns/.cmd/.air, most .sff/.snd). Larger
// files stream without a declared length. Bounds serverless memory: worst
// case is one 12 MB buffer per in-flight request, never a 100 MB character.
const VERIFY_BUFFER_LIMIT = 12 * 1024 * 1024;

// Content type by extension (fallback — both upstreams already serve an
// accurate content-type for portraits and text files).
const contentTypes: Record<string, string> = {
  cns: 'text/plain', cmd: 'text/plain', air: 'text/plain',
  def: 'text/plain', lua: 'text/plain', ini: 'text/plain',
  json: 'application/json', sff: 'application/octet-stream',
  snd: 'application/octet-stream', act: 'application/octet-stream',
  ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
  ttf: 'font/ttf', otf: 'font/otf', st: 'text/plain',
  dat: 'application/octet-stream', txt: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};

const CACHEABLE = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';
const UNCACHEABLE = 'no-store';

function baseHeaders(contentType: string, cacheControl: string): Headers {
  const h = new Headers();
  h.set('Content-Type', contentType);
  h.set('Cache-Control', cacheControl);
  h.set('Access-Control-Allow-Origin', '*');
  return h;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;
  const vpath = pathSegments.join('/');

  // Prevent path traversal
  if (vpath.includes('..')) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const ext = vpath.split('.').pop()?.toLowerCase() || '';
  const contentType = contentTypes[ext] || 'application/octet-stream';

  // jsDelivr first (its edge owns integrity; cacheable); GitHub raw as the
  // uncacheable fallback (403-prone '!' names, outages). NOTE: no explicit
  // `cache` option on these fetches — this handler is inherently dynamic
  // (per-request path) so Next's data cache does not engage, and passing
  // cache options through Next 16's patched fetch misbehaved in testing.
  const { jsdelivrBase, githubRawBase } = upstreamBases();
  const upstreams: Array<{ url: string; cacheable: boolean }> = [
    { url: jsdelivrBase + vpath, cacheable: true },
    { url: githubRawBase + vpath, cacheable: false },
  ];

  for (const upstream of upstreams) {
    let res: Response;
    try {
      // 15s cap: a stalled upstream (throttling, edge hang) must fail over
      // fast — a character download waits on this before the fight can start.
      //
      // Accept-Encoding: identity (stress-test find) — undici's default
      // "accept-encoding: gzip" made the declared Content-Length LIE SMALL
      // (compressed wire size) while res.body arrived decompressed, so the
      // size pre-check below misrouted big files into the buffered path
      // (a 20 MB .sff gzips under the 12 MB limit and eats a full 20 MB
      // buffer) and every honesty assumption here degraded. Identity keeps
      // the declared length equal to the true body size.
      res = await fetch(upstream.url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'Accept-Encoding': 'identity' },
      });
    } catch {
      continue; // network error / timeout — try the next upstream
    }
    if (res.status !== 200) {
      // 404 on jsDelivr for special-char names is expected — fall through.
      // Any non-200 is served no-store so a throttled 429 / transient 503
      // can never be pinned into any cache.
      if (upstream.cacheable) continue;
      return NextResponse.json(
        { error: `CDN file not found: ${vpath} (${res.status})` },
        { status: res.status, headers: { 'Cache-Control': UNCACHEABLE } }
      );
    }

    const cacheable = upstream.cacheable;

    // Size pre-check from the upstream's declared Content-Length. The header
    // may LIE SMALL (undici transfer-compression reports the compressed wire
    // size) but it can never LIE BIG, so a declared length above the buffer
    // limit means the real body is also above it — stream the body untouched
    // and never pay the buffer. No Content-Length is declared downstream (we
    // cannot know the true decompressed size) — see the content-length rule.
    const declaredLen = Number(res.headers.get('content-length') || 0);
    if (declaredLen > VERIFY_BUFFER_LIMIT && res.body) {
      const headers = baseHeaders(contentType, cacheable ? CACHEABLE : UNCACHEABLE);
      const etag = res.headers.get('etag');
      if (etag) headers.set('ETag', etag);
      const lm = res.headers.get('last-modified');
      if (lm) headers.set('Last-Modified', lm);
      return new NextResponse(res.body, { status: 200, headers });
    }

    // Buffered path: buffer once and serve the buffer, at any size. The
    // declared length is the actual served length — never the upstream's
    // (compressed) header. If the buffer still exceeds the limit (a small
    // lying header over a big real body, or a chunked upstream with no
    // length at all), serve it anyway: the memory is already spent and the
    // byte count is exact. Falling through to a "streaming" path here would
    // return res.body AFTER arrayBuffer() consumed it — a dead stream that
    // 500s every download (the >12 MB bug this block replaces).
    if (res.body) {
      try {
        const buf = await res.arrayBuffer();
        const headers = baseHeaders(contentType, cacheable ? CACHEABLE : UNCACHEABLE);
        headers.set('Content-Length', String(buf.byteLength));
        const etag = res.headers.get('etag');
        if (etag) headers.set('ETag', etag);
        const lm = res.headers.get('last-modified');
        if (lm) headers.set('Last-Modified', lm);
        return new NextResponse(buf, { status: 200, headers });
      } catch {
        continue; // body read failed mid-transfer — try the next upstream
      }
    }

    // res.body was null (upstream produced no stream) — try the next upstream.
  }

  return NextResponse.json(
    { error: `CDN proxy error: all upstreams failed for ${vpath}` },
    { status: 502, headers: { 'Cache-Control': UNCACHEABLE } }
  );
}
