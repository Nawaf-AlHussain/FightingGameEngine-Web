// Character/stage downloader — fetches files from jsDelivr CDN (FightingGameEngine/Assets repo)
// and injects them into the IKEMEN VFS before the engine boots.
//
// Flow:
// 1. User selects character on /local page
// 2. React fetches the Assets manifest from GitHub raw
// 3. When user clicks FIGHT, we download all character files from CDN
// 4. Inject each file into the VFS via globalThis.ikemenInjectFile()
// 5. Engine boots and reads the character from VFS as if it were local

const ASSETS_MANIFEST_URL = 'https://cdn.jsdelivr.net/gh/FightingGameEngine/Assets@main/manifest.json';

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
  cachedManifest = await res.json();
  return cachedManifest;
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
      const url = char.cdnBase + filename;
      // Character files go into chars/<id>/ in the VFS
      // The engine expects: chars/<charname>/<filename>
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
    const url = stage.cdnBase + filename;
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
