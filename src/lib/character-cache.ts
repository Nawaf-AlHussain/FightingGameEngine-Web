// IndexedDB caching layer for character/stage files.
// Stores downloaded files in IndexedDB so they persist across sessions —
// no re-downloading on repeat visits.
//
// Values are stored as Blob whenever possible (new writes — see
// cacheCharacter): a Blob's payload lives off the JS heap (browser-managed,
// disk-backed), so accumulating a whole character as a map of Blobs costs
// almost no renderer memory, and the IDB put serializes Blob handles by
// reference instead of copying megabytes through the structured-clone
// buffer. Legacy records written before this change hold Uint8Array values
// — readers accept both (see CachedFileData) and a one-time background
// migration (migrateAfterRead) converts them to Blobs after their first read.
//
// Database structure:
//   DB: "ikemen-cache" (version 2)
//   Store: "chars"     — key: cacheKey ("Wolverine" | "charsDC/Batman"),
//                        value: { files: Record<filename, Blob|Uint8Array>, timestamp }
//   Store: "stages"    — key: stageId, value: same shape
//   Store: "charMeta"  — v2: key: same as chars, value: { files: string[], timestamp }
//   Store: "stageMeta" — v2: key: same as stages, value: { files: string[], timestamp }
//
// WHY META STORES (Batch 3): isCharacterCached used to answer by reading
// the FULL record — an IDB get() structured-clones every value, so even a
// mere "is X cached?" check materialized an entire character on the JS
// heap (the 102 MB EX_janemba legacy record literally copied ~102 MB of
// bytes; Blob-backed records still clone the handle map). The meta record
// holds only the FILE NAME list (a few KB), which is everything a presence
// check needs: name membership validates required files without touching
// the payload store.
//
// CONNECTION REUSE (Batch 3): every call used to open() and close() the
// database. A shared singleton connection removes that per-call setup cost;
// versionchange/onclose handlers drop it so another tab's upgrade or an
// eviction can never wedge the module (the next call reopens).

const DB_NAME = 'ikemen-cache';
const DB_VERSION = 2;
const CHAR_STORE = 'chars';
const STAGE_STORE = 'stages';
const CHAR_META_STORE = 'charMeta';
const STAGE_META_STORE = 'stageMeta';

// --- Persistent storage -----------------------------------------------------
// Without navigator.storage.persist() the browser treats this cache as
// "best effort" and may EVICT it wholesale under disk pressure — the cache
// then silently empties and every character/stage re-downloads on the next
// visit (reported as "downloaded multiple times, not stored in IndexedDB").
// persist() marks the cache as durable; Chrome grants it for sites the user
// actively engages with. Fire-and-forget once per session — never blocks a
// download and failure here is harmless (cache just stays evictable).
let persistRequested = false;
function requestPersistentStorage(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist()
        .then(granted => {
          if (granted) console.log('[cache] persistent storage granted — cache is eviction-protected');
          else console.warn('[cache] persistent storage NOT granted — browser may evict the cache under disk pressure');
        })
        .catch(() => { /* not fatal */ });
    }
  } catch { /* not fatal */ }
}

// Approximate on-disk size of a file record, for the success log line.
function fileRecordBytes(files: Record<string, CachedFileData>): number {
  let n = 0;
  for (const f of Object.values(files)) n += f instanceof Blob ? f.size : f.byteLength;
  return n;
}

// --- IndexedDB helpers ---

// Shared connection. A rejected/lost connection resets the singleton so the
// next call retries a fresh open() instead of awaiting a dead promise.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHAR_STORE)) {
        db.createObjectStore(CHAR_STORE);
      }
      if (!db.objectStoreNames.contains(STAGE_STORE)) {
        db.createObjectStore(STAGE_STORE);
      }
      // v2: metadata stores — file-name lists for cheap presence checks
      // (see "WHY META STORES" above). Created alongside the payload
      // stores so a fresh install is complete in one upgrade.
      if (!db.objectStoreNames.contains(CHAR_META_STORE)) {
        db.createObjectStore(CHAR_META_STORE);
      }
      if (!db.objectStoreNames.contains(STAGE_META_STORE)) {
        db.createObjectStore(STAGE_META_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opened a newer version — release the connection so the
      // upgrade can proceed there; the singleton reopens on next use.
      db.onversionchange = () => {
        try { db.close(); } catch { /* already closed */ }
        dbPromise = null;
      };
      // Safari/iOS can force-close connections under storage pressure.
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  // A failed open must not poison the singleton: drop the cached rejection.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/** Await a transaction's completion, surfacing aborts (quota, private mode). */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

// --- Cache entry types ---

/** A cached file's payload: Blob for records written by current code,
 *  Uint8Array for records written before the Blob switch. */
export type CachedFileData = Blob | Uint8Array;

export interface CachedAsset {
  files: Record<string, CachedFileData>; // filename → file data
  timestamp: number;
}

/** Metadata record: name list only — never carries payload bytes. */
interface CachedMeta {
  files: string[];
  timestamp: number;
}

/** Presence check against a name list (meta store) or a files record. */
function namesSatisfy(present: string[], requiredFiles?: string[]): boolean {
  if (requiredFiles && requiredFiles.length > 0) {
    // ALL required files must be present — partial downloads (from a
    // previous bug) must never be marked as cached.
    for (const f of requiredFiles) {
      if (!present.includes(f)) return false;
    }
    return true;
  }
  return present.length > 0;
}

// --- Character caching ---

export async function cacheCharacter(id: string, files: Record<string, CachedFileData>): Promise<void> {
  requestPersistentStorage();
  try {
    const db = await openDB();
    // Record + meta written in ONE transaction: a presence check can never
    // see a payload without its metadata (or vice versa).
    const timestamp = Date.now();
    const tx = db.transaction([CHAR_STORE, CHAR_META_STORE], 'readwrite');
    tx.objectStore(CHAR_STORE).put({ files, timestamp }, id);
    tx.objectStore(CHAR_META_STORE).put(
      { files: Object.keys(files), timestamp } satisfies CachedMeta,
      id
    );
    await txDone(tx);
    console.log(`[cache] stored character ${id}: ${Object.keys(files).length} file(s), ~${(fileRecordBytes(files) / 1e6).toFixed(1)} MB`);
  } catch (e) {
    // LOUD on purpose: a silent cache failure looked exactly like "downloads
    // repeat every visit" with no trace to diagnose. The download still
    // succeeds (session-only), so this must never break the fight itself.
    console.error('[cache] FAILED to cache character (session-only fallback):', id, e);
  }
}

export async function getCachedCharacter(id: string): Promise<CachedAsset | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(CHAR_STORE, 'readonly');
    const req = tx.objectStore(CHAR_STORE).get(id);
    const result = await new Promise<CachedAsset | null>((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (result) migrateAfterRead(CHAR_STORE, CHAR_META_STORE, id, result);
    return result;
  } catch (e) {
    return null;
  }
}

export async function isCharacterCached(id: string, requiredFiles?: string[]): Promise<boolean> {
  // Fast path: the meta store answers from a KB-sized name list — the full
  // payload record is never read, so a "is this 102 MB character cached?"
  // check costs nothing on the heap.
  const meta = await getMeta(CHAR_META_STORE, id);
  if (meta) return namesSatisfy(meta.files, requiredFiles);
  // No meta entry: either not cached at all, or a legacy pre-v2 record.
  // getKey() distinguishes the two without deserializing any values; a real
  // legacy record falls back to the full read (which also schedules its
  // migration — so this cost is paid at most once per record).
  try {
    const db = await openDB();
    const tx = db.transaction(CHAR_STORE, 'readonly');
    const key = await new Promise<IDBValidKey | undefined>((resolve) => {
      const r = tx.objectStore(CHAR_STORE).getKey(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
    if (key === undefined) return false;
  } catch (e) {
    return false;
  }
  const record = await getCachedCharacter(id);
  if (!record) return false;
  return namesSatisfy(Object.keys(record.files), requiredFiles);
}

// --- Stage caching ---

export async function cacheStage(id: string, files: Record<string, CachedFileData>): Promise<void> {
  requestPersistentStorage();
  try {
    const db = await openDB();
    const timestamp = Date.now();
    const tx = db.transaction([STAGE_STORE, STAGE_META_STORE], 'readwrite');
    tx.objectStore(STAGE_STORE).put({ files, timestamp }, id);
    tx.objectStore(STAGE_META_STORE).put(
      { files: Object.keys(files), timestamp } satisfies CachedMeta,
      id
    );
    await txDone(tx);
    console.log(`[cache] stored stage ${id}: ${Object.keys(files).length} file(s), ~${(fileRecordBytes(files) / 1e6).toFixed(1)} MB`);
  } catch (e) {
    console.error('[cache] FAILED to cache stage (session-only fallback):', id, e);
  }
}

export async function getCachedStage(id: string): Promise<CachedAsset | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STAGE_STORE, 'readonly');
    const req = tx.objectStore(STAGE_STORE).get(id);
    const result = await new Promise<CachedAsset | null>((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (result) migrateAfterRead(STAGE_STORE, STAGE_META_STORE, id, result);
    return result;
  } catch (e) {
    return null;
  }
}

export async function isStageCached(id: string, requiredFiles?: string[]): Promise<boolean> {
  const meta = await getMeta(STAGE_META_STORE, id);
  if (meta) return namesSatisfy(meta.files, requiredFiles);
  try {
    const db = await openDB();
    const tx = db.transaction(STAGE_STORE, 'readonly');
    const key = await new Promise<IDBValidKey | undefined>((resolve) => {
      const r = tx.objectStore(STAGE_STORE).getKey(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
    if (key === undefined) return false;
  } catch (e) {
    return false;
  }
  const record = await getCachedStage(id);
  if (!record) return false;
  return namesSatisfy(Object.keys(record.files), requiredFiles);
}

// --- Bulk status check (for UI) ---

export async function getCachedCharacterIds(): Promise<Set<string>> {
  try {
    const db = await openDB();
    const tx = db.transaction(CHAR_STORE, 'readonly');
    const req = tx.objectStore(CHAR_STORE).getAllKeys();
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });
    return new Set(keys.map(k => String(k)));
  } catch (e) {
    return new Set();
  }
}

export async function getCachedStageIds(): Promise<Set<string>> {
  try {
    const db = await openDB();
    const tx = db.transaction(STAGE_STORE, 'readonly');
    const req = tx.objectStore(STAGE_STORE).getAllKeys();
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });
    return new Set(keys.map(k => String(k)));
  } catch (e) {
    return new Set();
  }
}

// --- Clear cache (for debugging/reset) ---

export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([CHAR_STORE, STAGE_STORE, CHAR_META_STORE, STAGE_META_STORE], 'readwrite');
    tx.objectStore(CHAR_STORE).clear();
    tx.objectStore(STAGE_STORE).clear();
    tx.objectStore(CHAR_META_STORE).clear();
    tx.objectStore(STAGE_META_STORE).clear();
    await txDone(tx);
  } catch (e) {
    console.warn('[cache] Failed to clear cache:', e);
  }
}

// --- Metadata reads (internal) ----------------------------------------------

async function getMeta(store: string, id: string): Promise<CachedMeta | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    const result = await new Promise<CachedMeta | null>((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    return result;
  } catch (e) {
    return null;
  }
}

// --- Legacy record migration (fire-and-forget) ------------------------------
//
// Records written before (a) the Blob switch and/or (b) the v2 meta stores
// are upgraded the first time a full read touches them: the payload is
// re-stored with Blob values (off the JS heap from then on) and the meta
// name list is backfilled (future presence checks never read the payload
// again). One transient copy of the payload is unavoidable for the Blob
// conversion — but the read above had ALREADY materialized the legacy bytes
// in the heap, and every subsequent read of this record becomes
// handle-only. Never runs twice concurrently for the same record.

const migrating = new Set<string>();

function migrateAfterRead(
  store: string,
  metaStore: string,
  id: string,
  record: CachedAsset
): void {
  const key = `${store}:${id}`;
  if (migrating.has(key)) return;
  migrating.add(key);
  (async () => {
    const existingMeta = await getMeta(metaStore, id);
    const files = record.files || {};
    let needsPayloadRewrite = false;
    const blobFiles: Record<string, Blob> = {};
    for (const [name, v] of Object.entries(files)) {
      if (v instanceof Blob) {
        blobFiles[name] = v;
      } else {
        // BlobPart typing vs the ArrayBufferLike generic: a plain
        // Uint8Array from a structured clone always has an ArrayBuffer
        // backing store, so the cast is runtime-safe.
        blobFiles[name] = new Blob([v as unknown as BlobPart]);
        needsPayloadRewrite = true;
      }
    }
    if (!needsPayloadRewrite && existingMeta) return;

    const db = await openDB();
    const timestamp = record.timestamp || Date.now();
    const tx = db.transaction([store, metaStore], 'readwrite');
    if (needsPayloadRewrite) {
      tx.objectStore(store).put({ files: blobFiles, timestamp }, id);
    }
    if (!existingMeta) {
      tx.objectStore(metaStore).put(
        { files: Object.keys(files), timestamp } satisfies CachedMeta,
        id
      );
    }
    await txDone(tx);
    console.log(`[cache] migrated legacy record (${needsPayloadRewrite ? 'Uint8Array→Blob' : 'meta backfill'}): ${store}/${id}`);
  })()
    .catch(e => {
      // Harmless: the read above already served this call; the migration
      // simply retries on the next full read.
      console.warn('[cache] background migration failed (will retry on next read):', store, id, e);
    })
    .finally(() => migrating.delete(key));
}
