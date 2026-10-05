import { NextResponse } from 'next/server';

// Proxy the Assets manifest from GitHub raw to avoid:
// 1. jsDelivr CDN caching delays (new characters don't appear for hours)
// 2. raw.githubusercontent.com CORS restrictions (no CORS headers for browser fetch)
//
// This route always fetches the latest manifest from GitHub and serves it
// with CORS headers + no-cache so new characters appear immediately.

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
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Assets manifest proxy error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
