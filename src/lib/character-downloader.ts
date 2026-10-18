// Character/stage downloader — fetches files from our CDN proxy (which
// fetches from GitHub raw) and caches them in IndexedDB.
//
// INVARIANT (since the "characters download every time" bug): EVERY download
// path must persist to IndexedDB. Nothing is session-only unless the cache
// layer itself is unavailable — a session-only download is thrown away when
// the page unloads and re-downloads on the next boot.
//
// Two-phase approach:
// Phase 1 (on select page): Download to IndexedDB cache (no VFS needed)
// Phase 2 (on play page): Inject cached files into VFS (instant, no network)
// Combined (play-page cache-miss fallback): downloadCharacterToCache ->
// inject from the in-hand record — see downloadAndInjectCharacter below.
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
  purgeCharacter,
  purgeStage,
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

/**
 * Browser URL for a stage's thumbnail, served through the same CDN proxy
 * as game files. Convention: the thumbnail is a 512x288 JPEG at
 * "stages/thumbs/<stage>.jpg" in the Assets repo (regeneratable from the
 * full-res renders via scripts/gen-stage-thumbs.py). The full-res
 * "<stage>.png" renders that used to sit next to the .def are 2-3 MB each
 * — never fetch them for the grid (9 stages ≈ 23 MB for images displayed
 * at ~200x96 CSS px). When the manifest carries an explicit `thumb` field
 * it wins; stages without a thumbs/<base>.jpg keep the letter tile.
 */
export function stageThumbUrl(stage: StageInfo | undefined | null): string | undefined {
  if (!stage) return undefined;
  if (stage.thumb) return `${CDN_PROXY_BASE}${stage.thumb}`;
  const def = stage.files.find(f => f.toLowerCase().endsWith('.def'));
  if (!def) return undefined;
  const base = def.slice(def.lastIndexOf('/') + 1).replace(/\.def$/i, '');
  const m = stage.cdnBase.match(/Assets@main\/(.+)$/);
  const dir = m ? m[1] : 'stages/';
  return `${CDN_PROXY_BASE}${dir}thumbs/${base}.jpg`;
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
  /** Repo-root-relative path of a hand-made thumbnail
   *  ("stages/thumbs/DU_Campus.jpg"). Optional — the UI falls back to a
   *  derived thumbs/<def-basename>.jpg URL, then to a letter tile. */
  thumb?: string;
}

/**
 * Definitive existence check for one stage .def on the CDN (stress-test
 * find). Returns false ONLY when the upstream answered 404 — the file is
 * really gone; network failures / throttling / any other status return true
 * so a flaky connection can never blank out stages that actually exist.
 *
 * Used by StageSelect to prune manifest entries whose files no longer exist
 * upstream (the Assets manifest has drifted from the stages/ folder before —
 * 7 of its 10 entries once 404'd at fight boot). Only the .def is probed:
 * it is the stage's keystone file (~1.5 KB, so the plain GET is negligible —
 * the proxy route does not forward Range, by design) and it always
 * disappears together with the rest of the stage.
 */
export async function isStageAvailable(info: StageInfo): Promise<boolean> {
  const def = info.files.find(f => f.toLowerCase().endsWith('.def')) || info.files[0];
  if (!def) return true;
  try {
    const res = await fetch(`${CDN_PROXY_BASE}stages/${encodeURIComponent(def)}`);
    try { await res.body?.cancel(); } catch { /* already consumed/closed */ }
    if (res.status === 404) return false;
    return true;
  } catch {
    return true; // network error ≠ missing file — fail open
  }
}

interface AssetsManifest {
  version: number;
  sources?: RosterSource[];
  characters: CharacterInfo[];
  stages: StageInfo[];
}

let cachedManifest: AssetsManifest | null = null;

// ---- Roster fingerprint (netplay desync guard) ------------------------------
// The bridge build-check hash (vfs.js) covers the shipped pack + browser mods
// + theme, but characters/stages are DOWNLOADED from this manifest at match
// time and the engine's own content fingerprint is still a no-op TODO. Hash
// the exact manifest bytes this client was served and expose the digest to
// the netplay bridge (webrtc.js mixes it into its build check): two players
// whose rosters differ are refused at the handshake instead of desyncing
// mid-fight with an invisible/broken player.
function setRosterFingerprint(text: string, version: number): void {
  const g = globalThis as any;
  if (g.engineRosterHash) return; // first manifest this session wins — stays consistent for the session
  // cyrb64 — pure JS (crypto.subtle is unavailable on plain http); the same
  // algorithm every client runs, so equal bytes always yield equal digests.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const mix = (b: number) => {
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    mix(c & 0xff);
    mix((c >> 8) & 0xff);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, h2 >>> 0);
  dv.setUint32(4, h1 >>> 0);
  g.engineRosterHash = out;
  g.engineRosterHex =
    ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
  g.engineRosterVersion = String(version);
}

/** Cache-buster bump: change when a cache tier (Vercel edge / Next data
 *  cache / browser) is found serving POISONED bytes for the current ?v=
 *  namespace. The Oct-2025 incident: a Range request against /api/cdn had
 *  its 206 PARTIAL response edge-cached under the full ?v=3 URL, so every
 *  later fetch of e.g. android16.def received a 259-byte truncation and the
 *  engine panicked at fight load ("open a: No such file or directory" →
 *  black screen, local AND online). Re-namespacing the query made every
 *  poisoned entry unreachable in one deploy. The suffix also flows into the
 *  IndexedDB meta records (CachedMeta.mv), so devices that had already
 *  cached truncated bytes re-download automatically. Bump .r2 → .r3 on any
 *  future poisoning — the cost is one roster-wide re-download. */
const CACHE_BUSTER_BUMP = '.r2';

/** Cache-busting query pinning the manifest version that listed these files.
 *  /api/cdn serves MUTABLE main-branch GitHub content; without this, a
 *  browser's pinned HTTP copy (and the IndexedDB cache) could keep serving
 *  pre-update bytes to one player while the other downloads fresh ones —
 *  identical build hashes, divergent character data, netplay desync. */
function assetVersionQuery(entry: unknown): string {
  const mv = (entry as { __mv?: string }).__mv;
  return mv ? `?v=${encodeURIComponent(mv)}` : '';
}

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
  // Hash the TEXT this client was actually served (not a re-serialization):
  // byte-identical manifests must hash identically across peers.
  const text = await res.text();
  const manifest: AssetsManifest = JSON.parse(text);
  // Stamp the manifest version onto every entry: the download paths turn it
  // into a ?v= cache-buster and the IndexedDB meta records store it, so a
  // future roster/content update re-downloads instead of serving stale bytes.
  // CACHE_BUSTER_BUMP rides along so a bump re-downloads every cached entry
  // (heals poisoned IDB bytes) and moves every asset URL to a fresh,
  // never-before-cached edge namespace in the same deploy.
  // NOTE: setRosterFingerprint below keeps using the RAW manifest version —
  // the netplay handshake must stay a pure function of the manifest bytes.
  const mv = String(manifest.version ?? '') + CACHE_BUSTER_BUMP;
  for (const c of manifest.characters) (c as { __mv?: string }).__mv = mv;
  for (const s of manifest.stages) (s as { __mv?: string }).__mv = mv;
  setRosterFingerprint(text, manifest.version ?? 0);
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
      const url = CDN_PROXY_BASE + source + '/' + char.id + '/' + filename + assetVersionQuery(char);
      // Character files go into chars/<id>/ in the VFS
      const vpath = `chars/${char.id}/${filename}`;

      // Skip if already in VFS (e.g., from a previous download)
      if (g.engineHasFile && g.engineHasFile(vpath)) {
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
        if (g.engineInjectFile) {
          g.engineInjectFile(vpath, buf);
        } else {
          console.error('engineInjectFile not available — vfs.js not loaded?');
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

    if (g.engineHasFile && g.engineHasFile(vpath)) {
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

      if (g.engineInjectFile) {
        g.engineInjectFile(vpath, buf);
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
  promise: Promise<unknown>;
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
 * Does NOT inject into VFS — that happens later in injectCachedCharacter()
 * or straight from the returned record (see downloadAndInjectCharacter).
 * Called when the user selects a character on the select screen (and again
 * by match-prep's readiness pass — those concurrent calls SHARE one download
 * via the in-flight registry instead of double-fetching).
 *
 * @returns the downloaded files record when THIS call performed the download
 *          (so the caller can inject without another round-trip), or null when
 *          the character was already cached / a concurrent call downloaded it.
 */
// ===========================================================================
// Download integrity (the "character does not appear in the fight" bug)
// ===========================================================================
//
// A 200 response is NOT proof the bytes are complete. A truncated body
// (flaky mobile network, serverless mid-stream cut) used to be cached as a
// valid record: res.ok was true, so the transactional partial-download rule
// never fired. The engine then panicked at sff parse time ("...carnage_sff.sff
// EOF" in f_quickMatch) and the character never appeared in the fight — with
// the poisoned record replaying on EVERY attempt, because a record that
// satisfies the file-name list looks cached forever.
//
// Two defenses live here:
//   1. fetchFileVerified — compares the body against Content-Length (our
//      /api/cdn route relays it; binaries are served uncompressed, and when
//      content-encoding is present the check is skipped because the wire
//      length no longer describes the decoded blob) with one retry, then a
//      hard failure so the transactional rule keeps it out of the cache.
//   2. filesRecordLooksValid — magic-byte sniff at the CACHE-READ boundary
//      (sff: "ElecbyteSpr"/"AFAICF", snd: "ElecbyteSnd", plus no-empty-file
//      for everything). A damaged record is purged once and reported as a
//      cache miss, so the existing download fallback re-downloads it. A ref
//      is only healed once per session: if a FRESH record still fails the
//      sniff (an exotic magic this build does not know), it is injected
//      anyway and the engine decides — never a purge loop.

async function fetchFileVerified(url: string, filename: string): Promise<Blob> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    // Skip the check when the payload was transfer-compressed: content-length
    // then describes the compressed wire size, not blob.size.
    if (res.headers.get('content-encoding')) return blob;
    const cl = Number(res.headers.get('content-length'));
    if (!Number.isFinite(cl) || cl <= 0 || blob.size === cl) return blob;
    console.warn(`[cache] ${filename}: body ${blob.size}B != content-length ${cl}B (attempt ${attempt})`);
  }
  throw new Error('truncated body (content-length mismatch after retry)');
}

const SFF_MAGICS = ['ElecbyteSpr', 'AFAICF'];
const SND_MAGIC = 'ElecbyteSnd';

async function blobHead(data: CachedFileData, n: number): Promise<string> {
  const bytes = data instanceof Blob
    ? new Uint8Array(await data.slice(0, n).arrayBuffer())
    : data.slice(0, n);
  return String.fromCharCode(...bytes);
}

async function filesRecordLooksValid(files: Record<string, CachedFileData>): Promise<boolean> {
  for (const [name, data] of Object.entries(files)) {
    const size = data instanceof Blob ? data.size : data?.byteLength ?? 0;
    if (!data || size === 0) return false;
    const lower = name.toLowerCase();
    if (lower.endsWith('.sff')) {
      const head = await blobHead(data, 11);
      if (!SFF_MAGICS.some((m) => head.startsWith(m))) return false;
    } else if (lower.endsWith('.snd')) {
      const head = await blobHead(data, 11);
      if (!head.startsWith(SND_MAGIC)) return false;
    }
  }
  return true;
}

// Refs already healed this session — see the filesRecordLooksValid comment.
const healedOnce = new Set<string>();

function rememberHealed(kind: 'char' | 'stage', key: string): boolean {
  const k = kind + ':' + key;
  if (healedOnce.has(k)) return false;
  healedOnce.add(k);
  return true;
}

export async function downloadCharacterToCache(
  char: CharacterInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<Record<string, Blob> | null> {
  // Cache key includes the source so chars/Wolverine and
  // charsMARVEL/Wolverine can never shadow each other.
  const cacheKey = charRef(char);
  // Manifest version stamp for the cache record + ?v= cache-buster (declared
  // here because the async closure below reads it before any await returns).
  const charMv = (char as { __mv?: string }).__mv;

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
    return null;
  }

  const entry: InflightDownload = { promise: Promise.resolve(), subs: new Set() };
  if (onProgress) entry.subs.add(onProgress);

  const promise = (async () => {
    // Check if already cached (a manifest-version mismatch counts as NOT
    // cached — see CachedMeta.mv in character-cache.ts).
    if (await isCharacterCached(cacheKey, char.files, charMv)) {
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
        const url = CDN_PROXY_BASE + source + '/' + char.id + '/' + filename + assetVersionQuery(char);
        try {
          downloadedFiles[filename] = await fetchFileVerified(url, filename);
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
    await cacheCharacter(cacheKey, downloadedFiles, charMv);
    emitProgress(entry, 100, `${char.displayName} ready`);
    return downloadedFiles;
  })();

  entry.promise = promise;
  inflightCharCaches.set(cacheKey, entry);
  try {
    const record = await promise;
    return (record as Record<string, Blob> | undefined) || null;
  } finally {
    if (inflightCharCaches.get(cacheKey) === entry) {
      inflightCharCaches.delete(cacheKey);
    }
  }
}

/**
 * Download a stage's files from CDN and store in IndexedDB.
 * Shares one in-flight download per stage id (see the registry above).
 *
 * @returns the downloaded files record when THIS call performed the download
 *          (see downloadCharacterToCache), or null otherwise.
 */
export async function downloadStageToCache(
  stage: StageInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<Record<string, Blob> | null> {
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
    return null;
  }

  const entry: InflightDownload = { promise: Promise.resolve(), subs: new Set() };
  if (onProgress) entry.subs.add(onProgress);

  const promise = (async () => {
    if (await isStageCached(stage.id, stage.files, (stage as { __mv?: string }).__mv)) {
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
      const url = CDN_PROXY_BASE + 'stages/' + filename + assetVersionQuery(stage);
      try {
        downloadedFiles[filename] = await fetchFileVerified(url, filename);
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

    await cacheStage(stage.id, downloadedFiles, (stage as { __mv?: string }).__mv);
    emitProgress(entry, 100, `${stage.displayName} ready`);
    return downloadedFiles;
  })();

  entry.promise = promise;
  inflightStageCaches.set(stage.id, entry);
  try {
    const record = await promise;
    return (record as Record<string, Blob> | undefined) || null;
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
 * Read a character's cached files WITHOUT injecting — the read half of
 * injectCachedCharacter, split out so the boot page can fetch P1, P2 and
 * stage records from IndexedDB in ONE parallel round-trip (each record is
 * Blob-backed and off-heap, so holding all three is free) and then run the
 * phone-memory-safe serial injection afterwards.
 * Returns the files map, or null when the character is not cached.
 */
export async function getCachedCharacterFiles(
  ref: string
): Promise<Record<string, CachedFileData> | null> {
  const cached = await getCachedCharacter(ref);
  if (!cached) return null;
  // POISONED-CACHE SELF-HEAL at the read boundary: a record with an empty
  // file or a garbage-magic sff/snd is purged ONCE and reported as a cache
  // miss, so the caller's download fallback re-downloads it. Truncated
  // (but well-formed-header) records are caught by the engine-death purge
  // in play/page.tsx — the sff header survives truncation, so no sniff can
  // see those.
  if (!(await filesRecordLooksValid(cached.files))) {
    if (rememberHealed('char', ref)) {
      await purgeCharacter(ref);
      return null;
    }
    console.warn(`[cache] ${ref}: record still fails validation after a heal — injecting anyway (engine decides)`);
  }
  return cached.files;
}

/** Read half of injectCachedStage — see getCachedCharacterFiles. */
export async function getCachedStageFiles(
  stageId: string
): Promise<Record<string, CachedFileData> | null> {
  const cached = await getCachedStage(stageId);
  if (!cached) return null;
  if (!(await filesRecordLooksValid(cached.files))) {
    if (rememberHealed('stage', stageId)) {
      await purgeStage(stageId);
      return null;
    }
    console.warn(`[cache] stage ${stageId}: record still fails validation after a heal — injecting anyway`);
  }
  return cached.files;
}

/**
 * Inject a character's cached files into the engine VFS.
 * `ref` is a selection reference (see charRef / splitCharRef) — also used
 * as the IndexedDB cache key. Files are ALWAYS injected at chars/<id>/
 * because the engine builds that path itself.
 * Files are materialized ONE AT A TIME: engineInjectFile retains the passed
 * array in the VFS, so each decoded file becomes the VFS copy directly and
 * the full record never sits decoded in the JS heap (phone memory budget).
 * Returns true if successful, false if not cached.
 */
export async function injectCachedCharacter(ref: string): Promise<boolean> {
  const cached = await getCachedCharacterFiles(ref);
  if (!cached) return false;
  return injectCharacterFiles(ref, cached);
}

/**
 * Inject an already-read character files map (from getCachedCharacterFiles)
 * into the VFS. One file materialized at a time (phone-memory rule).
 * Returns false when vfs.js is not loaded (or the map is empty/unreadable).
 */
export async function injectCharacterFiles(
  ref: string,
  files: Record<string, CachedFileData>
): Promise<boolean> {
  const g = globalThis as any;
  if (!g.engineInjectFile) {
    console.error('engineInjectFile not available — vfs.js not loaded?');
    return false;
  }

  const { id } = splitCharRef(ref);
  let count = 0;
  for (const [filename, data] of Object.entries(files)) {
    const vpath = `chars/${id}/${filename}`;
    g.engineInjectFile(vpath, await fileBytes(data));
    count++;
  }
  console.log(`[cache] Injected ${count} files for character: ${ref} -> chars/${id}/`);
  return true;
}

/**
 * Inject an already-read stage files map (from getCachedStageFiles).
 * One file materialized at a time (see injectCharacterFiles).
 */
export async function injectStageFiles(
  stageId: string,
  files: Record<string, CachedFileData>
): Promise<boolean> {
  const g = globalThis as any;
  if (!g.engineInjectFile) {
    console.error('engineInjectFile not available — vfs.js not loaded?');
    return false;
  }

  let count = 0;
  for (const [filename, data] of Object.entries(files)) {
    const vpath = `stages/${filename}`;
    g.engineInjectFile(vpath, await fileBytes(data));
    count++;
  }
  console.log(`[cache] Injected ${count} files for stage: ${stageId}`);
  return true;
}

/**
 * Inject a stage's cached files into the engine VFS.
 * One file materialized at a time (see injectCachedCharacter).
 * Returns true if successful, false if not cached.
 */
export async function injectCachedStage(stageId: string): Promise<boolean> {
  const cached = await getCachedStageFiles(stageId);
  if (!cached) return false;
  return injectStageFiles(stageId, cached);
}

// ===========================================================================
// Combined download+inject (play-page cache-miss fallback)
// ===========================================================================
//
// WHY THIS EXISTS ("characters/stages download every time" bug): flows that
// reach /play WITHOUT match-prep — arcade/survival/time-attack opponents via
// /progress, online net=1 fights, hand-typed deep links — used to hit a
// fallback that downloaded straight into the in-memory VFS and never touched
// IndexedDB. The bytes were discarded at fight end, so every boot of the
// same character/stage re-downloaded from the CDN. These helpers make the
// fallback cache-first: persist to IndexedDB, then inject — the session-only
// path only runs when the cache layer itself is unavailable/broken, so the
// fight can still start this boot.

/** Inject a files record into the VFS, one file at a time (phone-memory rule). */
async function injectRecord(
  files: Record<string, Blob>,
  vpathFor: (filename: string) => string,
  label: string
): Promise<boolean> {
  const g = globalThis as any;
  if (!g.engineInjectFile) {
    console.error('engineInjectFile not available — vfs.js not loaded?');
    return false;
  }
  let count = 0;
  for (const [filename, data] of Object.entries(files)) {
    g.engineInjectFile(vpathFor(filename), await fileBytes(data));
    count++;
  }
  console.log(`[cache] Injected ${count} files for ${label}`);
  return true;
}

/**
 * Download a character AND persist it to IndexedDB AND inject it into the
 * VFS — the only sanctioned play-time fallback for a cache miss.
 * Never re-downloads when the cache layer works; falls back to the legacy
 * session-only download only when the cache layer is unavailable or the
 * record still is not injectable afterwards (so the fight starts this boot).
 */
export async function downloadAndInjectCharacter(
  char: CharacterInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  // Persist FIRST (throws on network failure — transactional, partial
  // downloads are never cached — propagate that to the boot error screen).
  // The IDB layer itself never throws: if the write fails it logs LOUDLY and
  // the record still comes back, so the in-hand injection below keeps this
  // boot working even when persistence is unavailable.
  // Returns the record only when THIS call performed the download.
  const record = await downloadCharacterToCache(char, onProgress);

  if (record) {
    // Inject straight from the in-hand record — no cache read, no re-fetch.
    if (await injectRecord(record, f => `chars/${char.id}/${f}`, `character: ${char.id}`)) {
      return;
    }
  } else if (await injectCachedCharacter(charRef(char))) {
    // Already cached (this boot or a concurrent download cached it).
    return;
  }

  // Last resort: cache layer wrote nothing injectable (private mode, quota,
  // silent IDB failure) — session-only so the fight can still start.
  console.warn(`[cache] ${char.id} still not injectable — session-only download (will re-download next boot)`);
  await downloadCharacter(char, onProgress);
}

/**
 * Download a stage AND persist it to IndexedDB AND inject it into the VFS.
 * Mirror of downloadAndInjectCharacter — see that comment for the why.
 */
export async function downloadAndInjectStage(
  stage: StageInfo,
  onProgress?: (pct: number, msg: string) => void
): Promise<void> {
  const record = await downloadStageToCache(stage, onProgress);

  if (record) {
    if (await injectRecord(record, f => `stages/${f}`, `stage: ${stage.id}`)) {
      return;
    }
  } else if (await injectCachedStage(stage.id)) {
    return;
  }

  console.warn(`[cache] stage ${stage.id} still not injectable — session-only download (will re-download next boot)`);
  await downloadStage(stage, onProgress);
}

/**
 * POISONED-CACHE SELF-HEAL (engine-death trigger).
 *
 * A truncated/corrupt cached asset makes the engine panic at parse time and
 * the panic text names the VFS path, e.g.:
 *   Panic: ...f_quickMatch: chars/Carnage_MMV/Carnage_MMV.def:
 *   chars/Carnage_MMV/resource/carnage_sff.sff
 *   EOF
 * Purge the implicated match records so RETRY re-downloads them instead of
 * replaying the same poisoned bytes on every attempt ("character does not
 * appear in the fight"). Only refs whose VFS id is actually named in the
 * panic text are purged — unrelated deaths never cost a re-download.
 * Returns the purged ids for the error-screen wording.
 */
export async function purgeAssetsMentionedByPanic(
  panicText: string,
  p1Ref: string,
  p2Ref: string,
  stageRef?: string
): Promise<string[]> {
  const purged: string[] = [];
  try {
    for (const ref of [p1Ref, p2Ref]) {
      if (!ref) continue;
      const id = splitCharRef(ref).id;
      if (!id || purged.includes(id)) continue;
      if (panicText.includes(`chars/${id}/`)) {
        await purgeCharacter(ref);
        healedOnce.delete('char:' + ref);
        purged.push(id);
      }
    }
    if (stageRef && panicText.includes(`stages/${stageRef}`)) {
      await purgeStage(stageRef);
      healedOnce.delete('stage:' + stageRef);
      purged.push(stageRef);
    }
  } catch (e) {
    console.warn('[cache] panic-triggered purge failed (best-effort):', e);
  }
  return purged;
}
