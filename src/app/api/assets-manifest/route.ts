import { NextResponse } from 'next/server';

// Proxy the Assets manifest from GitHub raw to avoid:
// 1. jsDelivr CDN caching delays (new characters don't appear for hours)
// 2. raw.githubusercontent.com CORS restrictions (no CORS headers for browser fetch)
//
// EDGE-CACHED (Batch 4): this used to be no-cache end-to-end, so EVERY
// select-screen/stage-select mount executed this function and fetched the
// manifest from GitHub raw. The manifest only changes when the Assets repo
// roster changes, so responses now carry s-maxage=60 + stale-while-revalidate:
// repeat loads within a minute (the common case — select → match-prep → play)
// are served by the Vercel edge without touching this function or GitHub, and
// a new character appears at most 60s + one revalidation later instead of
// immediately. The browser side still revalidates every load (client uses
// cache: 'no-cache'), so freshness is bounded by the 60s window, not the
// session.

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/FightingGameEngine/Assets/main/manifest.json';

export async function GET() {
  try {
    const res = await fetch(GITHUB_RAW_URL, { cache: 'no-store' });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch Assets manifest: ${res.status}` },
        { status: res.status }
      );
    }

    const manifest = await res.text();

    return new NextResponse(manifest, {
      headers: {
        'Content-Type': 'application/json',
        // Edge caches for 60s, serves stale up to 5 more minutes while one
        // background revalidation runs. Failures are NOT cached.
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Assets manifest proxy error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
