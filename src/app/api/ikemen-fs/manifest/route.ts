import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Serve the VFS manifest. The engine's vfs.js fetches this at boot.
// For now, serve from the pre-generated static manifest.
// In Phase 2, this will dynamically merge engine data + CDN assets.
export async function GET() {
  const manifestPath = path.join(
    process.cwd(), 'public', 'game', 'ikemen-fs', 'manifest.json'
  );

  if (!fs.existsSync(manifestPath)) {
    return NextResponse.json(
      { error: 'Manifest not found. Run: node scripts/generate-manifest.js' },
      { status: 500 }
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
