import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Serve individual VFS files. The engine's vfs.js fetches these lazily.
// Virtual path example: /api/ikemen-fs/file/data/common1.cns
// Phase 2 will proxy character/stage requests to jsDelivr CDN.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;
  const vpath = pathSegments.join('/');

  // Prevent path traversal
  const safePath = path.normalize(vpath).replace(/^\.\./, '');
  if (safePath.startsWith('..')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const filePath = path.join(
    process.cwd(), 'public', 'game', 'ikemen-fs', 'file', safePath
  );

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return NextResponse.json(
      { error: `VFS file not found: ${vpath}` },
      { status: 404 }
    );
  }

  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  const contentTypes: Record<string, string> = {
    '.cns': 'text/plain', '.cmd': 'text/plain', '.air': 'text/plain',
    '.def': 'text/plain', '.lua': 'text/plain', '.ini': 'text/plain',
    '.json': 'application/json', '.sff': 'application/octet-stream',
    '.snd': 'application/octet-stream', '.act': 'application/octet-stream',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
  };

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
