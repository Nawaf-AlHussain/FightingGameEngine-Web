import { NextRequest, NextResponse } from 'next/server';

// CDN proxy: fetches character/stage files from GitHub raw and serves them
// to the browser with CORS headers. jsDelivr returns 403 for some files
// (especially those with special characters like '!' in the name), and
// raw.githubusercontent.com doesn't set CORS headers, so the browser can't
// fetch directly. This server-side proxy solves both problems.
//
// URL format: /api/cdn/chars/Bardock/Bardock.sff
// Fetches from: https://raw.githubusercontent.com/FightingGameEngine/Assets/main/chars/Bardock/Bardock.sff

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/FightingGameEngine/Assets/main/';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;
  const vpath = pathSegments.join('/');

  // Prevent path traversal
  if (vpath.includes('..')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const url = GITHUB_RAW_BASE + vpath;

  try {
    const res = await fetch(url, { cache: 'force-cache' });

    if (!res.ok) {
      return NextResponse.json(
        { error: `CDN file not found: ${vpath} (${res.status})` },
        { status: res.status }
      );
    }

    const buffer = new Uint8Array(await res.arrayBuffer());

    // Determine content type from extension
    const ext = vpath.split('.').pop()?.toLowerCase() || '';
    const contentTypes: Record<string, string> = {
      cns: 'text/plain', cmd: 'text/plain', air: 'text/plain',
      def: 'text/plain', lua: 'text/plain', ini: 'text/plain',
      json: 'application/json', sff: 'application/octet-stream',
      snd: 'application/octet-stream', act: 'application/octet-stream',
      ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
      ttf: 'font/ttf', otf: 'font/otf', st: 'text/plain',
      dat: 'application/octet-stream', txt: 'text/plain',
    };

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentTypes[ext] || 'application/octet-stream',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `CDN proxy error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
