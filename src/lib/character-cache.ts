// IndexedDB caching layer for character/stage files.
// Stores downloaded files as Uint8Array in IndexedDB so they persist
// across sessions — no re-downloading on repeat visits.
//
// Database structure:
//   DB: "ikemen-cache"
//   Store: "chars" — key: characterId, value: { files: Map<filename, Uint8Array>, timestamp }
//   Store: "stages" — key: stageId, value: { files: Map<filename, Uint8Array>, timestamp }

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

export interface CachedAsset {
  files: Record<string, Uint8Array>; // filename → file data
  timestamp: number;
}

// --- Character caching ---

export async function cacheCharacter(id: string, files: Record<string, Uint8Array>): Promise<void> {
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

export async function isCharacterCached(id: string): Promise<boolean> {
  const cached = await getCachedCharacter(id);
  return cached !== null && Object.keys(cached.files).length > 0;
}

// --- Stage caching ---

export async function cacheStage(id: string, files: Record<string, Uint8Array>): Promise<void> {
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

export async function isStageCached(id: string): Promise<boolean> {
  const cached = await getCachedStage(id);
  return cached !== null && Object.keys(cached.files).length > 0;
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
