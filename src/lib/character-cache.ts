// IndexedDB caching layer for character/stage files.
// Stores downloaded files in IndexedDB so they persist across sessions —
// no re-downloading on repeat visits.
//
// Values are stored as Blob whenever possible (new writes — see
// downloadCharacterToCache): a Blob's payload lives off the JS heap
// (browser-managed, disk-backed), so accumulating a whole character as a
// map of Blobs costs almost no renderer memory, and the IDB put serializes
// Blob handles by reference instead of copying megabytes through the
// structured-clone buffer. Legacy records written before this change hold
// Uint8Array values — readers accept both (see CachedFileData).
//
// Database structure:
//   DB: "ikemen-cache"
//   Store: "chars" — key: characterId, value: { files: Map<filename, Blob|Uint8Array>, timestamp }
//   Store: "stages" — key: stageId, value: { files: Map<filename, Blob|Uint8Array>, timestamp }

const DB_NAME = 'ikemen-cache';
const DB_VERSION = 1;
const CHAR_STORE = 'chars';
const STAGE_STORE = 'stages';

// --- IndexedDB helpers ---

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHAR_STORE)) {
        db.createObjectStore(CHAR_STORE);
      }
      if (!db.objectStoreNames.contains(STAGE_STORE)) {
        db.createObjectStore(STAGE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

// --- Character caching ---

export async function cacheCharacter(id: string, files: Record<string, CachedFileData>): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(CHAR_STORE, 'readwrite');
    const entry: CachedAsset = { files, timestamp: Date.now() };
    tx.objectStore(CHAR_STORE).put(entry, id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[cache] Failed to cache character:', id, e);
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
    db.close();
    return result;
  } catch (e) {
    return null;
  }
}

export async function isCharacterCached(id: string, requiredFiles?: string[]): Promise<boolean> {
  const cached = await getCachedCharacter(id);
  if (!cached) return false;
  // If we know which files are required, validate ALL are present.
  // This prevents partial downloads (from a previous bug) from being
  // marked as cached. Without requiredFiles, fall back to checking
  // that at least some files exist (backwards-compatible).
  if (requiredFiles && requiredFiles.length > 0) {
    for (const f of requiredFiles) {
      if (!cached.files[f]) return false;
    }
    return true;
  }
  return Object.keys(cached.files).length > 0;
}

// --- Stage caching ---

export async function cacheStage(id: string, files: Record<string, CachedFileData>): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STAGE_STORE, 'readwrite');
    const entry: CachedAsset = { files, timestamp: Date.now() };
    tx.objectStore(STAGE_STORE).put(entry, id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[cache] Failed to cache stage:', id, e);
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
    db.close();
    return result;
  } catch (e) {
    return null;
  }
}

export async function isStageCached(id: string, requiredFiles?: string[]): Promise<boolean> {
  const cached = await getCachedStage(id);
  if (!cached) return false;
  if (requiredFiles && requiredFiles.length > 0) {
    for (const f of requiredFiles) {
      if (!cached.files[f]) return false;
    }
    return true;
  }
  return Object.keys(cached.files).length > 0;
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
    db.close();
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
    db.close();
    return new Set(keys.map(k => String(k)));
  } catch (e) {
    return new Set();
  }
}

// --- Clear cache (for debugging/reset) ---

export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([CHAR_STORE, STAGE_STORE], 'readwrite');
    tx.objectStore(CHAR_STORE).clear();
    tx.objectStore(STAGE_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[cache] Failed to clear cache:', e);
  }
}
