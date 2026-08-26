// Character/stage downloader — fetches files from our CDN proxy (which
// fetches from GitHub raw) and caches them in IndexedDB.
//
// Two-phase approach:
// Phase 1 (on select page): Download to IndexedDB cache (no VFS needed)
// Phase 2 (on play page): Inject cached files into VFS (instant, no network)
//
// We use a Vercel serverless proxy (/api/cdn/) instead of jsDelivr directly
// because jsDelivr returns 403 for some files (especially with '!' in names),
// and raw.githubusercontent.com doesn't set CORS headers for browser fetch.

const ASSETS_MANIFEST_URL = 'https://cdn.jsdelivr.net/gh/FightingGameEngine/Assets@main/manifest.json';
const CDN_PROXY_BASE = '/api/cdn/';

import {
  cacheCharacter,
  cacheStage,
  getCachedCharacter,
  getCachedStage,
  isCharacterCached,
  isStageCached,
  getCachedCharacterIds,
  getCachedStageIds,
  type CachedAsset,
} from './character-cache';

export { isCharacterCached, isStageCached, getCachedCharacterIds, getCachedStageIds };

export interface CharacterInfo {
  id: string;
  displayName: string;
  author: string;
  description: string;
  sizeMB: number;
  bundled: boolean;
  cdnBase: string;
  files: string[];
}

export interface StageInfo {
  id: string;
  displayName: string;
  author: string;
  description: string;
  sizeMB: number;
  bundled: boolean;
  cdnBase: string;
  files: string[];
}

interface AssetsManifest {
  version: number;
  characters: CharacterInfo[];
  stages: StageInfo[];
}

let cachedManifest: AssetsManifest | null = null;

/**
 * Fetch the Assets manifest (character/stage list) from jsDelivr CDN.
 * Cached in memory after first fetch.
 */
export async function fetchAssetsManifest(): Promise<AssetsManifest> {
  if (cachedManifest) return cachedManifest;

  const res = await fetch(ASSETS_MANIFEST_URL, { cache: 'force-cache' });
  if (!res.ok) {
    throw new Error(`Failed to fetch Assets manifest: ${res.status}`);
  }
  const manifest: AssetsManifest = await res.json();
  cachedManifest = manifest;
  return manifest;
}

/**
 * Get the list of available characters.
 */
export async function getCharacters(): Promise<CharacterInfo[]> {
  const manifest = await fetchAssetsManifest();
  return manifest.characters;
}

/**
 * Get the list of available stages.
 */
export async function getStages(): Promise<StageInfo[]> {
  const manifest = await fetchAssetsManifest();
  return manifest.stages;
}

/**
 * Download a character from CDN and inject its files into the VFS.
 * @param char Character info from the manifest
 * @param onProgress Optional progress callback (0-100)
 */
export async function downloadCharacter(
  char: CharacterInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  const g = globalThis as any;

  // Download all files in parallel for speed
  const files = char.files;
  let completed = 0;
  const total = files.length;

  onProgress?.(0, `Downloading ${char.displayName}...`);

  // Download in batches of 6 to avoid overwhelming the browser
  const BATCH_SIZE = 6;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (filename) => {
      const url = CDN_PROXY_BASE + 'chars/' + char.id + '/' + filename;
      // Character files go into chars/<id>/ in the VFS
      const vpath = `chars/${char.id}/${filename}`;

      // Skip if already in VFS (e.g., from a previous download)
      if (g.ikemenHasFile && g.ikemenHasFile(vpath)) {
        completed++;
        return;
      }

      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) {
          console.warn(`Failed to download ${filename}: ${res.status}`);
          return;
        }
        const buf = new Uint8Array(await res.arrayBuffer());

        // Inject into VFS
        if (g.ikemenInjectFile) {
          g.ikemenInjectFile(vpath, buf);
        } else {
          console.error('ikemenInjectFile not available — vfs.js not loaded?');
        }

        completed++;
        onProgress?.(Math.round((completed / total) * 100), `Downloaded ${filename}`);
      } catch (e) {
        console.warn(`Error downloading ${filename}:`, e);
      }
    }));
  }

  onProgress?.(100, `${char.displayName} ready`);
}

/**
 * Download a stage from CDN and inject its files into the VFS.
 * @param stage Stage info from the manifest
 * @param onProgress Optional progress callback (0-100)
 */
export async function downloadStage(
  stage: StageInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  const g = globalThis as any;
  const files = stage.files;
  let completed = 0;
  const total = files.length;

  onProgress?.(0, `Downloading ${stage.displayName}...`);

  await Promise.all(files.map(async (filename) => {
    const url = CDN_PROXY_BASE + 'stages/' + filename;
    // Stage files go into stages/ in the VFS
    const vpath = `stages/${filename}`;

    if (g.ikemenHasFile && g.ikemenHasFile(vpath)) {
      completed++;
      return;
    }

    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) {
        console.warn(`Failed to download ${filename}: ${res.status}`);
        return;
      }
      const buf = new Uint8Array(await res.arrayBuffer());

      if (g.ikemenInjectFile) {
        g.ikemenInjectFile(vpath, buf);
      }

      completed++;
      onProgress?.(Math.round((completed / total) * 100), `Downloaded ${filename}`);
    } catch (e) {
      console.warn(`Error downloading ${filename}:`, e);
    }
  }));

  onProgress?.(100, `${stage.displayName} ready`);
}

/**
 * Get the .def file path for a character (what we pass to the engine).
 * Characters are at chars/<id>/<id>.def
 */
export function getCharacterDefPath(char: CharacterInfo): string {
  // The .def file is usually <id>.def, but some chars have different names
  const defFile = char.files.find(f => f.endsWith('.def')) || `${char.id}.def`;
  return `chars/${char.id}/${defFile}`;
}

/**
 * Get the .def file path for a stage.
 */
export function getStageDefPath(stage: StageInfo): string {
  const defFile = stage.files.find(f => f.endsWith('.def')) || `${stage.id}.def`;
  return `stages/${defFile}`;
}

// ===========================================================================
// Phase 1: Download to IndexedDB cache (called from select page)
// ===========================================================================

/**
 * Download a character's files from CDN and store in IndexedDB.
 * Does NOT inject into VFS — that happens later in injectCachedCharacter().
 * Called when the user selects a character on the select screen.
 */
export async function downloadCharacterToCache(
  char: CharacterInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  // Check if already cached
  if (await isCharacterCached(char.id)) {
    onProgress?.(100, `${char.displayName} cached`);
    return;
  }

  const files = char.files;
  const total = files.length;
  let completed = 0;
  const downloadedFiles: Record<string, Uint8Array> = {};

  onProgress?.(0, `Downloading ${char.displayName}...`);

  const BATCH_SIZE = 6;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (filename) => {
      const url = CDN_PROXY_BASE + 'chars/' + char.id + '/' + filename;
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) {
          console.warn(`Failed to download ${filename}: ${res.status}`);
          return;
        }
        downloadedFiles[filename] = new Uint8Array(await res.arrayBuffer());
        completed++;
        onProgress?.(Math.round((completed / total) * 100), `Downloaded ${filename}`);
      } catch (e) {
        console.warn(`Error downloading ${filename}:`, e);
      }
    }));
  }

  // Store in IndexedDB
  await cacheCharacter(char.id, downloadedFiles);
  onProgress?.(100, `${char.displayName} ready`);
}

/**
 * Download a stage's files from CDN and store in IndexedDB.
 */
export async function downloadStageToCache(
  stage: StageInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  if (await isStageCached(stage.id)) {
    onProgress?.(100, `${stage.displayName} cached`);
    return;
  }

  const files = stage.files;
  const total = files.length;
  let completed = 0;
  const downloadedFiles: Record<string, Uint8Array> = {};

  onProgress?.(0, `Downloading ${stage.displayName}...`);

  await Promise.all(files.map(async (filename) => {
    const url = CDN_PROXY_BASE + 'stages/' + filename;
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) {
        console.warn(`Failed to download ${filename}: ${res.status}`);
        return;
      }
      downloadedFiles[filename] = new Uint8Array(await res.arrayBuffer());
      completed++;
      onProgress?.(Math.round((completed / total) * 100), `Downloaded ${filename}`);
    } catch (e) {
      console.warn(`Error downloading ${filename}:`, e);
    }
  }));

  await cacheStage(stage.id, downloadedFiles);
  onProgress?.(100, `${stage.displayName} ready`);
}

// ===========================================================================
// Phase 2: Inject from IndexedDB cache into VFS (called from play page)
// ===========================================================================

/**
 * Inject a character's cached files into the IKEMEN VFS.
 * Returns true if successful, false if not cached.
 */
export async function injectCachedCharacter(charId: string): Promise<boolean> {
  const g = globalThis as any;
  const cached = await getCachedCharacter(charId);
  if (!cached) return false;

  for (const [filename, data] of Object.entries(cached.files)) {
    const vpath = `chars/${charId}/${filename}`;
    if (g.ikemenInjectFile) {
      g.ikemenInjectFile(vpath, data);
    }
  }
  console.log(`[cache] Injected ${Object.keys(cached.files).length} files for character: ${charId}`);
  return true;
}

/**
 * Inject a stage's cached files into the IKEMEN VFS.
 * Returns true if successful, false if not cached.
 */
export async function injectCachedStage(stageId: string): Promise<boolean> {
  const g = globalThis as any;
  const cached = await getCachedStage(stageId);
  if (!cached) return false;

  for (const [filename, data] of Object.entries(cached.files)) {
    const vpath = `stages/${filename}`;
    if (g.ikemenInjectFile) {
      g.ikemenInjectFile(vpath, data);
    }
  }
  console.log(`[cache] Injected ${Object.keys(cached.files).length} files for stage: ${stageId}`);
  return true;
}
