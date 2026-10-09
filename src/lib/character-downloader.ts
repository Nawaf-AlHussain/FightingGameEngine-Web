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

// Fetch manifest through our own API proxy to avoid CORS issues with
// raw.githubusercontent.com and jsDelivr CDN caching delays.
// The proxy fetches from GitHub raw (always up-to-date) and serves with CORS.
const ASSETS_MANIFEST_URL = '/api/assets-manifest';
const CDN_PROXY_BASE = '/api/cdn/';

// The classic roster folder. Characters in any other chars* folder
// (charsMARVEL, charsDC, ...) get a source-qualified selection reference
// ("charsMARVEL/Wolverine") so CDN fetches, cache keys and lookups can
// never collide across universes.
//
// ENGINE CONSTRAINT: the engine (main.lua f_quickMatch -> addChar) always
// builds the VFS path as chars/<id>/<id>.def. So no matter which source
// folder files are DOWNLOADED from, they are always INJECTED into the VFS
// at chars/<id>/ and the engine is handed the plain id.

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
  type CachedFileData,
} from './character-cache';

export { isCharacterCached, isStageCached, getCachedCharacterIds, getCachedStageIds };

export interface CharacterInfo {
  id: string;
  /** Which chars* folder this character comes from ("chars", "charsMARVEL", ...).
   *  Missing/undefined on legacy manifests = default "chars". */
  source?: string;
  displayName: string;
  author: string;
  description: string;
  sizeMB: number;
  bundled: boolean;
  cdnBase: string;
  files: string[];
  /** Repo-root-relative path of the pre-extracted big-portrait PNG @ 256px
   *  ("portraits/charsMARVEL/Beast.png"). Optional — chars without an
   *  extracted portrait fall back to a letter tile in the UI. */
  portrait?: string;
}

export interface RosterSource {
  /** Folder name in the Assets repo ("chars", "charsMARVEL", ...). */
  id: string;
  /** Human label ("Default", "MARVEL", "DC", ...). */
  label: string;
}

export const DEFAULT_SOURCE = 'chars';

/** Derive a display label for a source folder. */
export function rosterSourceLabel(source: string): string {
  if (source === DEFAULT_SOURCE) return 'Default';
  const suffix = source.toLowerCase().startsWith(DEFAULT_SOURCE)
    ? source.slice(DEFAULT_SOURCE.length)
    : source;
  return (suffix || source).toUpperCase();
}

/**
 * Selection reference for a character: the plain folder id for the default
 * source ("Wolverine"), or "<source>/<id>" for any other source
 * ("charsMARVEL/Wolverine"). Plain ids keep refs identical to pre-multi-source
 * URLs/session state, so existing bookmarks and IndexedDB caches keep working.
 */
export function charRef(c: { id: string; source?: string }): string {
  const source = c.source || DEFAULT_SOURCE;
  return source === DEFAULT_SOURCE ? c.id : `${source}/${c.id}`;
}

/** Split a selection reference back into { source, id }. */
export function splitCharRef(ref: string): { source: string; id: string } {
  const i = ref.indexOf('/');
  if (i <= 0) return { source: DEFAULT_SOURCE, id: ref };
  return { source: ref.slice(0, i), id: ref.slice(i + 1) };
}

/**
 * Browser URL for a character's big-portrait PNG, served through the same
 * CDN proxy as game files (the manifest stores an Assets-repo-relative
 * path). Undefined when the character has no extracted portrait.
 */
export function portraitUrl(char: { portrait?: string } | undefined | null): string | undefined {
  if (!char?.portrait) return undefined;
  return `${CDN_PROXY_BASE}${char.portrait}`;
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
  sources?: RosterSource[];
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

  const res = await fetch(ASSETS_MANIFEST_URL, { cache: 'no-cache' });
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
 * Get the distinct roster sources (character folders) in the manifest.
 * Prefers the manifest's own "sources" array (written by update-manifest.py
 * v3); falls back to deriving from the characters themselves (legacy
 * manifests therefore yield exactly one source: "chars").
 */
export async function getRosterSources(): Promise<RosterSource[]> {
  const manifest = await fetchAssetsManifest();
  if (manifest.sources && manifest.sources.length > 0) {
    return manifest.sources;
  }
  const seen: RosterSource[] = [];
  for (const c of manifest.characters) {
    const id = c.source || DEFAULT_SOURCE;
    if (!seen.some(s => s.id === id)) {
      seen.push({ id, label: rosterSourceLabel(id) });
    }
  }
  return seen;
}

/**
 * Find a character in the manifest by selection reference
 * (see charRef / splitCharRef).
 */
export async function findCharacterByRef(ref: string): Promise<CharacterInfo | undefined> {
  const manifest = await fetchAssetsManifest();
  return manifest.characters.find(c => charRef(c) === ref);
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
  const failed: string[] = [];

  // Fetch from the character's OWN source folder (chars, charsMARVEL, ...),
  // but inject into the engine's fixed chars/ namespace (see note above).
  const source = char.source || DEFAULT_SOURCE;

  onProgress?.(0, `Downloading ${char.displayName}...`);

  // Download in batches of 6 to avoid overwhelming the browser
  const BATCH_SIZE = 6;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (filename) => {
      const url = CDN_PROXY_BASE + source + '/' + char.id + '/' + filename;
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
          failed.push(filename);
          return;
        }
        const buf = new Uint8Array(await res.arrayBuffer());

        // Inject into VFS
        if (g.ikemenInjectFile) {
          g.ikemenInjectFile(vpath, buf);
        } else {
          console.error('ikemenInjectFile not available — vfs.js not loaded?');
          failed.push(filename);
          return;
        }

        completed++;
        onProgress?.(Math.round((completed / total) * 100), `Downloaded ${filename}`);
      } catch (e) {
        console.warn(`Error downloading ${filename}:`, e);
        failed.push(filename);
      }
    }));
  }

  // TRANSACTIONAL: if any files failed, throw so the caller knows the
  // character is incomplete. Previously this function returned normally
  // with a "ready" message even if files were missing.
  if (failed.length > 0) {
    throw new Error(
      `Failed to download ${failed.length}/${total} file(s) for ${char.id}: ${failed.join(', ')}`
    );
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
  const failed: string[] = [];

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
        failed.push(filename);
        return;
      }
      const buf = new Uint8Array(await res.arrayBuffer());

      if (g.ikemenInjectFile) {
        g.ikemenInjectFile(vpath, buf);
      } else {
        failed.push(filename);
        return;
      }

      completed++;
      onProgress?.(Math.round((completed / total) * 100), `Downloaded ${filename}`);
    } catch (e) {
      console.warn(`Error downloading ${filename}:`, e);
      failed.push(filename);
    }
  }));

  // TRANSACTIONAL: throw if any files failed.
  if (failed.length > 0) {
    throw new Error(
      `Failed to download ${failed.length}/${total} file(s) for stage ${stage.id}: ${failed.join(', ')}`
    );
  }

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

// --- Cross-component in-flight download registry ---------------------------
//
// PHONE MEMORY ROOT CAUSE ("first match start always refreshes once"): the
// first-use flow used to run the SAME whole-character download TWICE —
// CharacterSelect.triggerDownload starts it on lock-in, then the user taps
// FIGHT and match-prep's readiness pass calls downloadCharacterToCache again
// while the IndexedDB record does not exist yet (its per-component in-flight
// guard cannot see the select screen's download). Each run accumulated the
// ENTIRE character as live Uint8Arrays on the JS heap before a single IDB
// put, so the renderer transiently held ~2x the character plus fetch
// transients — on top of the /play boot spike. On phones that crosses the
// renderer memory budget: the browser kills the tab and auto-reloads it
// (the user sees one deterministic refresh; the retry finds the char
// cached and fits).
//
// Fix (three parts, all in this file):
//   1. THIS registry — a module-level Map<cacheKey, InflightDownload> shared
//      by every caller. Late callers piggyback on the running download
//      (awaiting the same promise and receiving forwarded progress) instead
//      of re-fetching: no double download, ever.
//   2. Files are stored as Blobs, not Uint8Arrays (see downloadCharacter-
//      ToCache): Blob payloads are off-heap/disk-backed, so the download no
//      longer accumulates the whole character on the JS heap.
//   3. Injection (Phase 2 below) materializes ONE file at a time.

type ProgressCb = (pct: number, msg: string) => void;

interface InflightDownload {
  promise: Promise<void>;
  /** Progress subscribers: the original caller + every piggybacker. */
  subs: Set<ProgressCb>;
}

const inflightCharCaches = new Map<string, InflightDownload>();
const inflightStageCaches = new Map<string, InflightDownload>();

function emitProgress(inflight: InflightDownload, pct: number, msg: string): void {
  for (const cb of inflight.subs) {
    try {
      cb(pct, msg);
    } catch {
      // A broken UI listener must never kill the download itself.
    }
  }
}

/**
 * Download a character's files from CDN and store in IndexedDB.
 * Does NOT inject into VFS — that happens later in injectCachedCharacter().
 * Called when the user selects a character on the select screen (and again
 * by match-prep's readiness pass — those concurrent calls SHARE one download
 * via the in-flight registry instead of double-fetching).
 */
export async function downloadCharacterToCache(
  char: CharacterInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  // Cache key includes the source so chars/Wolverine and
  // charsMARVEL/Wolverine can never shadow each other.
  const cacheKey = charRef(char);

  // Piggyback check FIRST (synchronous — no await before this, so two
  // concurrent callers can never both miss the registry).
  const existing = inflightCharCaches.get(cacheKey);
  if (existing) {
    if (onProgress) {
      existing.subs.add(onProgress);
      try {
        await existing.promise;
      } finally {
        existing.subs.delete(onProgress);
      }
    } else {
      await existing.promise;
    }
    // The shared download either completed (char is cached now) or threw —
    // propagate the same outcome to this caller.
    onProgress?.(100, `${char.displayName} ready`);
    return;
  }

  const entry: InflightDownload = { promise: Promise.resolve(), subs: new Set() };
  if (onProgress) entry.subs.add(onProgress);

  const promise = (async () => {
    // Check if already cached
    if (await isCharacterCached(cacheKey, char.files)) {
      emitProgress(entry, 100, `${char.displayName} cached`);
      return;
    }

    const files = char.files;
    const total = files.length;
    let completed = 0;
    const failed: string[] = [];
    // Blob values: the payload is disk-backed by the browser and never
    // enters the JS heap as a live byte array. Legacy readers accept
    // Uint8Array too (CachedFileData), so old records stay readable.
    const downloadedFiles: Record<string, Blob> = {};

    const source = char.source || DEFAULT_SOURCE;

    emitProgress(entry, 0, `Downloading ${char.displayName}...`);

    const BATCH_SIZE = 6;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (filename) => {
        const url = CDN_PROXY_BASE + source + '/' + char.id + '/' + filename;
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) {
            console.warn(`Failed to download ${filename}: ${res.status}`);
            failed.push(filename);
            return;
          }
          downloadedFiles[filename] = await res.blob();
          completed++;
          emitProgress(entry, Math.round((completed / total) * 100), `Downloaded ${filename}`);
        } catch (e) {
          console.warn(`Error downloading ${filename}:`, e);
          failed.push(filename);
        }
      }));
    }

    // TRANSACTIONAL: if any files failed, do NOT cache the partial download.
    // Previously, partial downloads were cached and isCharacterCached returned
    // true, causing the UI to mark broken characters as READY.
    if (failed.length > 0) {
      throw new Error(
        `Failed to download ${failed.length}/${total} file(s) for ${char.id}: ${failed.join(', ')}`
      );
    }

    // All files downloaded — safe to cache.
    await cacheCharacter(cacheKey, downloadedFiles);
    emitProgress(entry, 100, `${char.displayName} ready`);
  })();

  entry.promise = promise;
  inflightCharCaches.set(cacheKey, entry);
  try {
    await promise;
  } finally {
    if (inflightCharCaches.get(cacheKey) === entry) {
      inflightCharCaches.delete(cacheKey);
    }
  }
}

/**
 * Download a stage's files from CDN and store in IndexedDB.
 * Shares one in-flight download per stage id (see the registry above).
 */
export async function downloadStageToCache(
  stage: StageInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  // Piggyback check FIRST (synchronous — see downloadCharacterToCache).
  const existing = inflightStageCaches.get(stage.id);
  if (existing) {
    if (onProgress) {
      existing.subs.add(onProgress);
      try {
        await existing.promise;
      } finally {
        existing.subs.delete(onProgress);
      }
    } else {
      await existing.promise;
    }
    onProgress?.(100, `${stage.displayName} ready`);
    return;
  }

  const entry: InflightDownload = { promise: Promise.resolve(), subs: new Set() };
  if (onProgress) entry.subs.add(onProgress);

  const promise = (async () => {
    if (await isStageCached(stage.id, stage.files)) {
      emitProgress(entry, 100, `${stage.displayName} cached`);
      return;
    }

    const files = stage.files;
    const total = files.length;
    let completed = 0;
    const failed: string[] = [];
    const downloadedFiles: Record<string, Blob> = {};

    emitProgress(entry, 0, `Downloading ${stage.displayName}...`);

    await Promise.all(files.map(async (filename) => {
      const url = CDN_PROXY_BASE + 'stages/' + filename;
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) {
          console.warn(`Failed to download ${filename}: ${res.status}`);
          failed.push(filename);
          return;
        }
        downloadedFiles[filename] = await res.blob();
        completed++;
        emitProgress(entry, Math.round((completed / total) * 100), `Downloaded ${filename}`);
      } catch (e) {
        console.warn(`Error downloading ${filename}:`, e);
        failed.push(filename);
      }
    }));

    // TRANSACTIONAL: if any files failed, do NOT cache the partial download.
    if (failed.length > 0) {
      throw new Error(
        `Failed to download ${failed.length}/${total} file(s) for stage ${stage.id}: ${failed.join(', ')}`
      );
    }

    await cacheStage(stage.id, downloadedFiles);
    emitProgress(entry, 100, `${stage.displayName} ready`);
  })();

  entry.promise = promise;
  inflightStageCaches.set(stage.id, entry);
  try {
    await promise;
  } finally {
    if (inflightStageCaches.get(stage.id) === entry) {
      inflightStageCaches.delete(stage.id);
    }
  }
}

// ===========================================================================
// Phase 2: Inject from IndexedDB cache into VFS (called from play page)
// ===========================================================================

/**
 * Materialize one cached file's payload as bytes for VFS injection.
 * Blobs (current records) are decoded one file at a time by the caller so
 * the renderer heap only ever holds a single file beyond the VFS's own
 * retention; Uint8Array (legacy records) pass through unchanged.
 */
async function fileBytes(data: CachedFileData): Promise<Uint8Array> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return data;
}

/**
 * Inject a character's cached files into the IKEMEN VFS.
 * `ref` is a selection reference (see charRef / splitCharRef) — also used
 * as the IndexedDB cache key. Files are ALWAYS injected at chars/<id>/
 * because the engine builds that path itself.
 * Files are materialized ONE AT A TIME: ikemenInjectFile retains the passed
 * array in the VFS, so each decoded file becomes the VFS copy directly and
 * the full record never sits decoded in the JS heap (phone memory budget).
 * Returns true if successful, false if not cached.
 */
export async function injectCachedCharacter(ref: string): Promise<boolean> {
  const g = globalThis as any;
  const cached = await getCachedCharacter(ref);
  if (!cached) return false;

  if (!g.ikemenInjectFile) {
    console.error('ikemenInjectFile not available — vfs.js not loaded?');
    return false;
  }

  const { id } = splitCharRef(ref);
  let count = 0;
  for (const [filename, data] of Object.entries(cached.files)) {
    const vpath = `chars/${id}/${filename}`;
    g.ikemenInjectFile(vpath, await fileBytes(data));
    count++;
  }
  console.log(`[cache] Injected ${count} files for character: ${ref} -> chars/${id}/`);
  return true;
}

/**
 * Inject a stage's cached files into the IKEMEN VFS.
 * One file materialized at a time (see injectCachedCharacter).
 * Returns true if successful, false if not cached.
 */
export async function injectCachedStage(stageId: string): Promise<boolean> {
  const g = globalThis as any;
  const cached = await getCachedStage(stageId);
  if (!cached) return false;

  if (!g.ikemenInjectFile) {
    console.error('ikemenInjectFile not available — vfs.js not loaded?');
    return false;
  }

  let count = 0;
  for (const [filename, data] of Object.entries(cached.files)) {
    const vpath = `stages/${filename}`;
    g.ikemenInjectFile(vpath, await fileBytes(data));
    count++;
  }
  console.log(`[cache] Injected ${count} files for stage: ${stageId}`);
  return true;
}
