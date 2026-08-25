'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  downloadStageToCache,
  getCachedStageIds,
  getStages,
  isStageCached,
  type StageInfo,
} from '@/lib/character-downloader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocalStage {
  id: string;
  displayName: string;
  description: string;
  sizeMB: number;
  bundled: boolean;
}

interface StageSelectProps {
  onSelect: (stageId: string) => void;
  onCancel: () => void;
}

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUNDLED_STAGES: LocalStage[] = [
  {
    id: 'stages/stage0-720.def',
    displayName: 'Training Stage',
    description: 'Bundled · No download required',
    sizeMB: 0,
    bundled: true,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StageSelect({ onSelect, onCancel }: StageSelectProps) {
  const [stages, setStages] = useState<LocalStage[]>(BUNDLED_STAGES);
  // Full StageInfo objects keyed by id (needed for downloadStageToCache,
  // which requires the manifest entry with `files`, `cdnBase`, etc.).
  const [stageInfos, setStageInfos] = useState<Record<string, StageInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // ---- Download cache state ----
  // cachedIds: stages already in IndexedDB (populated on mount + updated
  // when a download completes). Used for the isReady check.
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  // downloadStates: per-stage download progress / status for the UI.
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});

  // Refs that mirror state for use inside stable callbacks / async closures
  // (avoids stale closures without re-creating the triggerDownload callback).
  const stageInfosRef = useRef<Record<string, StageInfo>>({});
  const cachedIdsRef = useRef<Set<string>>(new Set());
  const downloadStatesRef = useRef<Record<string, DownloadState>>({});
  // Tracks which stage downloads are currently in-flight (prevents
  // double-triggering when state updates fire effects repeatedly).
  const inflightRef = useRef<Set<string>>(new Set());

  useEffect(() => { stageInfosRef.current = stageInfos; }, [stageInfos]);
  useEffect(() => { cachedIdsRef.current = cachedIds; }, [cachedIds]);
  useEffect(() => { downloadStatesRef.current = downloadStates; }, [downloadStates]);

  // ---- Fetch stage list from CDN ----
  useEffect(() => {
    let cancelled = false;
    getStages()
      .then((cdnStages: StageInfo[]) => {
        if (cancelled) return;
        const infoMap: Record<string, StageInfo> = {};
        for (const s of cdnStages) infoMap[s.id] = s;
        setStageInfos(infoMap);
        const merged: LocalStage[] = [
          ...BUNDLED_STAGES,
          ...cdnStages.map(s => ({
            id: s.id,
            displayName: s.displayName,
            description: s.description || `By ${s.author}`,
            sizeMB: s.sizeMB,
            bundled: false,
          })),
        ];
        setStages(merged);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- On mount, check which stages are already cached in IndexedDB ----
  useEffect(() => {
    let cancelled = false;
    getCachedStageIds()
      .then((ids: Set<string>) => {
        if (cancelled) return;
        setCachedIds(ids);
      })
      .catch(() => {
        // IndexedDB might be unavailable (private mode, etc.) — just ignore.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Trigger a background download for a stage (non-blocking) ----
  // Idempotent: skips if already cached, already downloading, or in-flight.
  const triggerDownload = useCallback((stageId: string) => {
    const info = stageInfosRef.current[stageId];
    if (!info) return; // bundled or unknown — nothing to download
    if (cachedIdsRef.current.has(stageId)) return; // already cached
    const cur = downloadStatesRef.current[stageId];
    if (cur?.status === 'downloading' || cur?.status === 'cached') return;
    if (inflightRef.current.has(stageId)) return; // already started
    inflightRef.current.add(stageId);

    // Optimistically mark as downloading so the UI shows immediate feedback.
    setDownloadStates(prev => ({
      ...prev,
      [stageId]: { status: 'downloading', progress: 0 },
    }));

    // Defensive: verify against IndexedDB in case our cachedIds state is stale
    // (e.g., the stage was cached in another browser tab). If it's already
    // there, mark as cached and skip the actual download.
    isStageCached(stageId)
      .then((alreadyCached) => {
        if (alreadyCached) {
          setDownloadStates(prev => ({
            ...prev,
            [stageId]: { status: 'cached', progress: 100 },
          }));
          setCachedIds(prev => {
            if (prev.has(stageId)) return prev;
            const next = new Set(prev);
            next.add(stageId);
            return next;
          });
          return;
        }
        return downloadStageToCache(info, (pct) => {
          setDownloadStates(prev => {
            const c = prev[stageId];
            if (c?.status !== 'downloading') return prev; // stale update
            return { ...prev, [stageId]: { status: 'downloading', progress: pct } };
          });
        });
      })
      .then(() => {
        // downloadStageToCache completed (or was already cached).
        // Only transition to 'cached' if we're still in 'downloading' — don't
        // clobber an 'error' state set elsewhere.
        setDownloadStates(prev => {
          const c = prev[stageId];
          if (c?.status !== 'downloading') return prev;
          return { ...prev, [stageId]: { status: 'cached', progress: 100 } };
        });
        setCachedIds(prev => {
          if (prev.has(stageId)) return prev;
          const next = new Set(prev);
          next.add(stageId);
          return next;
        });
      })
      .catch((err: unknown) => {
        console.warn(`[select] Failed to download stage ${stageId}:`, err);
        setDownloadStates(prev => ({
          ...prev,
          [stageId]: { status: 'error', progress: 0 },
        }));
      })
      .finally(() => {
        inflightRef.current.delete(stageId);
      });
  }, []);

  // ---- When the cursor lands on a stage, start its background download ----
  // Fires for both keyboard navigation and click (both update selectedIndex).
  // Non-blocking: download happens in the background, selection is not gated.
  useEffect(() => {
    if (loading) return;
    const stage = stages[selectedIndex];
    if (stage && !stage.bundled) {
      triggerDownload(stage.id);
    }
  }, [selectedIndex, stages, loading, triggerDownload]);

  // ---- "Ready" check: a stage is ready if bundled or cached ----
  const isReady = useCallback((s?: LocalStage): boolean => {
    if (!s) return false;
    if (s.bundled) return true;
    return cachedIds.has(s.id);
  }, [cachedIds]);

  const selectedStage = useMemo(() => stages[selectedIndex], [stages, selectedIndex]);
  const selectedReady = isReady(selectedStage);

  // ---- Confirm current selection ----
  // Don't fire onSelect until the selected stage is actually ready
  // (bundled or fully downloaded to IndexedDB). The download itself never
  // blocks selection — the user can move the cursor freely — but confirming
  // before a download completes would enter the game with missing files.
  const handleConfirm = useCallback(() => {
    if (!selectedStage || !selectedReady) return;
    onSelect(selectedStage.id);
  }, [selectedStage, selectedReady, onSelect]);

  // ---- Keyboard controls ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (loading) return;
      const code = e.code;
      if (code === 'ArrowRight' || code === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % stages.length);
      } else if (code === 'ArrowLeft' || code === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + stages.length) % stages.length);
      } else if (code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        handleConfirm();
      } else if (code === 'Escape' || code === 'Backspace') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, stages.length, handleConfirm, onCancel]);

  // ---- Render the download status block for a card ----
  const renderDownloadStatus = (stage: LocalStage) => {
    // Bundled stage — always ready, no download needed.
    if (stage.bundled) {
      return (
        <div className="ss__card-download" style={{ color: 'var(--green)' }}>
          BUNDLED
        </div>
      );
    }

    // Already cached (in IndexedDB before mount or via a completed download).
    if (cachedIds.has(stage.id)) {
      return (
        <div className="ss__card-download" style={{ color: 'var(--green)' }}>
          ✓ READY
        </div>
      );
    }

    const ds = downloadStates[stage.id];

    // Download in progress — show percent.
    if (ds?.status === 'downloading') {
      return (
        <div className="ss__card-download" style={{ color: 'var(--gold)' }}>
          DOWNLOADING · {ds.progress}%
        </div>
      );
    }

    // Download failed.
    if (ds?.status === 'error') {
      return (
        <div className="ss__card-download" style={{ color: 'var(--red)' }}>
          DOWNLOAD FAILED
        </div>
      );
    }

    // Not yet downloaded — show size hint.
    return (
      <div className="ss__card-download" style={{ color: 'var(--gray)' }}>
        DOWNLOAD · {stage.sizeMB.toFixed(1)} MB
      </div>
    );
  };

  // ---- Status line shown next to FIGHT when the selected stage isn't ready ----
  const selectionStatus = !selectedStage
    ? null
    : selectedStage.bundled
    ? null
    : selectedReady
    ? null
    : downloadStates[selectedStage.id]?.status === 'downloading'
    ? `DOWNLOADING · ${downloadStates[selectedStage.id].progress}%`
    : downloadStates[selectedStage.id]?.status === 'error'
    ? 'DOWNLOAD FAILED — RETRY BY RESELECTING'
    : 'PREPARING DOWNLOAD…';

  return (
    <main className="ss bg-grid" tabIndex={0}>
      {/* Title */}
      <div className="ss__title">
        <h1 className="ss__title-main">SELECT STAGE</h1>
        <div className="ss__title-sub">
          {loading
            ? 'LOADING STAGES…'
            : error
            ? `CDN ERROR: ${error.toUpperCase()}`
            : `${stages.length} STAGES AVAILABLE`}
        </div>
      </div>

      {/* Stage grid */}
      <div className="ss__grid" role="grid" aria-label="Stage list">
        {loading && (
          <div
            style={{
              gridColumn: '1 / -1',
              textAlign: 'center',
              padding: '2rem',
              color: 'var(--gray)',
              fontSize: '0.85rem',
              letterSpacing: '0.2em',
            }}
          >
            LOADING…
          </div>
        )}
        {!loading &&
          stages.map((stage, index) => {
            const isSelected = index === selectedIndex;
            return (
              <div
                key={stage.id}
                className={`ss__card${isSelected ? ' ss__card--selected' : ''}`}
                onClick={() => setSelectedIndex(index)}
                onDoubleClick={() => handleConfirm()}
                role="gridcell"
                tabIndex={-1}
              >
                <div className="ss__card-portrait">
                  <span>{stage.displayName.charAt(0).toUpperCase()}</span>
                </div>
                <div className="ss__card-name">{stage.displayName}</div>
                <div className="ss__card-desc">{stage.description}</div>
                {renderDownloadStatus(stage)}
              </div>
            );
          })}
      </div>

      {/* Footer */}
      <div className="ss__footer">
        <div className="cs__controls-help" style={{ marginBottom: '0.75rem' }}>
          <span>ARROWS</span> select · <span>ENTER</span> confirm · <span>ESC</span> back
          {selectedStage && (
            <div style={{ marginTop: '0.25rem' }}>
              Current: <span style={{ color: 'var(--cyan)' }}>
                {selectedStage.displayName}
              </span>
              {!selectedReady && (
                <span style={{ color: 'var(--gold)', marginLeft: '0.5rem' }}>
                  · {selectionStatus}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="cs__footer-btns">
          <button type="button" className="cs__btn-back" onClick={onCancel}>
            ← BACK
          </button>
          <button
            type="button"
            className="cs__btn-fight"
            onClick={handleConfirm}
            disabled={loading || !selectedStage || !selectedReady}
            aria-disabled={loading || !selectedStage || !selectedReady}
            title={
              !selectedStage
                ? 'Select a stage'
                : !selectedReady
                ? 'Stage is still downloading — wait for it to finish'
                : 'Lock in and fight!'
            }
          >
            FIGHT!
          </button>
        </div>
      </div>
    </main>
  );
}
