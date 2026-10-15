import { NextRequest, NextResponse } from 'next/server';

// CDN proxy: fetches character/stage files from GitHub raw and serves them
// to the browser with CORS headers. jsDelivr returns 403 for some files
// (especially those with special characters like '!' in the name), and
// raw.githubusercontent.com doesn't set CORS headers, so the browser can't
// fetch directly. This server-side proxy solves both problems.
//
// URL format: /api/cdn/chars/Bardock/Bardock.sff
// Fetches from: https://raw.githubusercontent.com/FightingGameEngine/Assets/main/chars/Bardock/Bardock.sff
//
// STREAMING + EDGE CACHE (Batch 3) — the "DC / Guilty Gear / DBZ portraits
// don't load" fix:
// The old handler awaited res.arrayBuffer() (whole file buffered in the
// serverless function's memory — a 100 MB character .sff held a 100 MB
// buffer per concurrent request) and advertised no s-maxage, so the Vercel
// edge cache never engaged. EVERY request — including the ~85 portrait PNGs
// a select-screen view renders at once — executed the function and hit
// GitHub raw, whose throttling of shared datacenter egress IPs returns
// 429/503 storms to exactly those bursts (broken images on whichever roster
// tab was browsed). Now the upstream body streams straight through, success
// responses carry s-maxage=31536000 (+SWR) so the edge serves repeat
// fetches, and error responses are no-store so a throttled 429 can never be
// pinned into any cache. Range headers pass through (GitHub raw supports
// them) so future resumable downloads / media consumers work unchanged.

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/FightingGameEngine/Assets/main/';

// Upstream response headers worth relaying when present: content-length
// lets the browser show real download progress; content-range/accept-ranges
// keep Range responses coherent; etag/last-modified enable revalidation.
const PASSTHROUGH_HEADERS = ['content-length', 'content-range', 'etag', 'last-modified', 'accept-ranges'] as const;

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

  const url = GITHUB_RAW_BASE + vpath;

  try {
    // Forward Range requests so partial fetches stay partial end-to-end.
    const range = request.headers.get('range');
    const res = await fetch(url, {
      cache: 'force-cache',
      ...(range ? { headers: { Range: range } } : {}),
    });

    if (!res.ok) {
      // Never cache failures: a throttled 429 / transient 503 cached with
      // immutable would break that file until the next deploy.
      return NextResponse.json(
        { error: `CDN file not found: ${vpath} (${res.status})` },
        { status: res.status, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Determine content type from extension (fallback — GitHub raw already
    // serves an accurate content-type for portraits and text files).
    const ext = vpath.split('.').pop()?.toLowerCase() || '';
    const contentTypes: Record<string, string> = {
      cns: 'text/plain', cmd: 'text/plain', air: 'text/plain',
      def: 'text/plain', lua: 'text/plain', ini: 'text/plain',
      json: 'application/json', sff: 'application/octet-stream',
      snd: 'application/octet-stream', act: 'application/octet-stream',
      ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
      ttf: 'font/ttf', otf: 'font/otf', st: 'text/plain',
      dat: 'application/octet-stream', txt: 'text/plain',
      png: 'image/png',
    };

    const headers = new Headers();
    headers.set('Content-Type', res.headers.get('content-type') || contentTypes[ext] || 'application/octet-stream');
    headers.set(
      'Cache-Control',
      // BOUNDED freshness (netplay correctness — see the ?v= buster in
      // character-downloader.ts): these URLs serve MUTABLE main-branch
      // GitHub content, and lockstep netplay requires every player to hold
      // byte-identical character data. The previous max-age=31536000 +
      // immutable let one player's browser pin pre-update bytes for a year
      // while another downloaded fresh ones — same build hash, divergent
      // data, desync. Browsers now revalidate daily; the edge keeps serving
      // repeat fetches (s-maxage + SWR) so the portrait-burst economics of
      // the Batch 3 fix are preserved, and the manifest-version query (?v=)
      // bypasses every cache tier the moment the roster bumps a version.
      'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'
    );
    headers.set('Access-Control-Allow-Origin', '*');
    for (const h of PASSTHROUGH_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }

    // Stream the upstream body through — no whole-file buffering.
    return new NextResponse(res.body, { status: res.status, headers });
  } catch (e) {
    return NextResponse.json(
      { error: `CDN proxy error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
