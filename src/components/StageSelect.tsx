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
  isStageAvailable,
  isStageCached,
  stageThumbUrl,
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
  /** CDN-proxy URL of the stage thumbnail PNG (<stage>.png next to the
   *  .def in the Assets repo), or undefined when it can't be derived —
   *  the card then keeps its letter tile. */
  thumb?: string;
}

interface StageSelectProps {
  onSelect: (stageId: string) => void;
  onCancel: () => void;
  /** When true, hints use touch wording instead of keyboard wording. */
  isTouch?: boolean;
  /**
   * Online guest view: the HOST picks the stage — this side is a
   * spectator. Interactions are disabled and a note overlay explains
   * what is happening (onCancel stays reachable via the overlay button).
   */
  spectate?: boolean;
  spectateNote?: string;
}

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// localStorage key persisting the last confirmed stage — repeat sessions
// start the cursor on their usual battleground.
const LAST_STAGE_KEY = 'fg-last-stage';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StageSelect({
  onSelect,
  onCancel,
  isTouch = false,
  spectate = false,
  spectateNote = '',
}: StageSelectProps) {
  // The stage list is the CDN manifest only — the engine ships no bundled
  // stages anymore (the training stage was removed).
  const [stages, setStages] = useState<LocalStage[]>([]);
  // Full StageInfo objects keyed by id (needed for downloadStageToCache,
  // which requires the manifest entry with `files`, `cdnBase`, etc.).
  const [stageInfos, setStageInfos] = useState<Record<string, StageInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // View filter: show only stages already cached on this device.
  const [readyOnly, setReadyOnly] = useState(false);
  // Bumped by the RETRY button to re-run the stage list fetch (spec Section 33).
  const [retryTick, setRetryTick] = useState(0);

  // ---- Download cache state ----
  // cachedIds: stages already in IndexedDB (populated on mount + updated
  // when a download completes). Used for the isReady check.
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  // downloadStates: per-stage download progress / status for the UI.
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});
  // The player pressed FIGHT while the stage was still downloading. Fire
  // the moment the download lands instead of silently ignoring the press
  // (before, the player had to know to press FIGHT a second time).
  const [pendingConfirm, setPendingConfirm] = useState(false);

  // Refs that mirror state for use inside stable callbacks / async closures
  // (avoids stale closures without re-creating the triggerDownload callback).
  const stageInfosRef = useRef<Record<string, StageInfo>>({});
  const cachedIdsRef = useRef<Set<string>>(new Set());
  const downloadStatesRef = useRef<Record<string, DownloadState>>({});
  // Tracks which stage downloads are currently in-flight (prevents
  // double-triggering when state updates fire effects repeatedly).
  const inflightRef = useRef<Set<string>>(new Set());
  // Stage grid element — read at keypress time to walk the grid by real rows.
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => { stageInfosRef.current = stageInfos; }, [stageInfos]);
  useEffect(() => { cachedIdsRef.current = cachedIds; }, [cachedIds]);
  useEffect(() => { downloadStatesRef.current = downloadStates; }, [downloadStates]);

  // ---- Fetch stage list from CDN ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStages()
      .then(async (cdnStages: StageInfo[]) => {
        if (cancelled) return;
        // ---- CDN availability probe (stress-test find) ----
        // The upstream Assets manifest has drifted from the repo's stages/
        // folder before (7 of its 10 entries pointed at files that no longer
        // exist) and picking such a stage hard-failed at fight boot with
        // "Failed to download 2/2 file(s)". Probe each stage's files with
        // 1-byte ranged requests and drop the entries the CDN definitively
        // 404s. Probe FAILURES (network flake, throttle) keep the stage —
        // only an unambiguous 404 removes it. Re-probed on every RETRY so
        // the button can recover after upstream heals.
        const available = await Promise.all(cdnStages.map(s => isStageAvailable(s)));
        if (cancelled) return;
        const kept = cdnStages.filter((_, i) => available[i]);
        if (kept.length !== cdnStages.length) {
          const dropped = cdnStages
            .filter((_, i) => !available[i])
            .map(s => s.id)
            .join(', ');
          console.warn(`[select] manifest stages missing on the CDN (hidden from the list): ${dropped}`);
        }
        const infoMap: Record<string, StageInfo> = {};
        for (const s of kept) infoMap[s.id] = s;
        setStageInfos(infoMap);
        const merged: LocalStage[] = [
          ...kept.map(s => ({
            id: s.id,
            displayName: s.displayName,
            description: s.description || `By ${s.author}`,
            sizeMB: s.sizeMB,
            bundled: false,
            thumb: stageThumbUrl(s),
          })),
        ];
        setStages(merged);
        // Restore the last stage this player confirmed (repeat sessions
        // start on their usual battleground).
        try {
          const saved = localStorage.getItem(LAST_STAGE_KEY);
          const idx = saved ? merged.findIndex(s => s.id === saved) : -1;
          if (idx >= 0) setSelectedIndex(idx);
        } catch {
          // storage unavailable — default to the first stage
        }
        // The cursor may have been moved while probes were in flight —
        // clamp it into the (possibly shrunken) list.
        setSelectedIndex(i => (merged.length ? Math.min(i, merged.length - 1) : 0));
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
  }, [retryTick]);

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
    // Pass the required file list so partial downloads are NOT marked as cached.
    isStageCached(stageId, info.files)
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

  // ---- "Ready" check: a stage is ready if bundled or cached ----
  const isReady = useCallback((s?: LocalStage): boolean => {
    if (!s) return false;
    if (s.bundled) return true;
    return cachedIds.has(s.id);
  }, [cachedIds]);

  const selectedStage = useMemo(() => stages[selectedIndex], [stages, selectedIndex]);
  const selectedReady = isReady(selectedStage);

  // ---- Filtered view (on-device filter) ----
  // filteredIndices holds FULL-list indices of the rendered cards; cursor
  // movement stays inside this space so the selection never lands on an
  // invisible card.
  const filteredIndices = useMemo(
    () => stages.map((_, i) => i).filter(i => (readyOnly ? isReady(stages[i]) : true)),
    [stages, readyOnly, isReady]
  );
  const filteredIndicesRef = useRef<number[]>([]);
  filteredIndicesRef.current = filteredIndices;

  // Snap the selection into view when the filter hides it.
  useEffect(() => {
    if (loading) return;
    if (filteredIndices.length === 0) return;
    setSelectedIndex(prev =>
      filteredIndices.includes(prev) ? prev : filteredIndices[0]
    );
  }, [filteredIndices, loading]);

  // Move the selection within the filtered view with wrap-around.
  // Vertical steps (delta ±rowJump) jump a FULL row: the grid is auto-fill,
  // so the row width is measured from the rendered cards at keypress time.
  const gridRowJump = useCallback((): number => {
    const grid = gridRef.current;
    if (!grid) return 1;
    const cards = grid.querySelectorAll<HTMLElement>('.ss__card');
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let cols = 1;
    while (cols < cards.length && cards[cols].offsetTop === top) cols++;
    return cols;
  }, []);
  const moveSelection = useCallback((delta: number) => {
    setSelectedIndex(prev => {
      const list = filteredIndicesRef.current;
      if (list.length === 0) return prev;
      let pos = list.indexOf(prev);
      if (pos === -1) return list[0];
      pos = ((pos + delta) % list.length + list.length) % list.length;
      return list[pos];
    });
  }, []);

  // ---- Confirm pipeline (shared by Enter / FIGHT / pending-download / RANDOM) ----
  // Every confirmed stage is remembered (localStorage) so the next session
  // starts the cursor on this player's usual battleground.
  const confirmStage = useCallback(
    (stage: LocalStage) => {
      try { localStorage.setItem(LAST_STAGE_KEY, stage.id); } catch { /* ignore */ }
      onSelect(stage.id);
    },
    [onSelect]
  );

  // ---- RANDOM: pick a random READY stage and confirm immediately ----
  // Classic arcade behavior — random commits on the spot. Never picks a
  // stage that would stall the match behind a download.
  const handleRandom = useCallback(() => {
    const ready = filteredIndicesRef.current
      .map(i => stages[i])
      .filter(s => !!s && isReady(s));
    if (ready.length === 0) return;
    const pick = ready[Math.floor(Math.random() * ready.length)];
    confirmStage(pick);
  }, [stages, isReady, confirmStage]);

  // ---- Confirm current selection (Enter / double-click / FIGHT button) ----
  // Downloads only fire HERE — on confirm — not when the cursor merely
  // lands on a stage. If the stage is already cached the triggerDownload
  // call is a no-op; otherwise the download runs in the background and the
  // confirm intent is remembered - the match starts automatically the
  // moment the download lands (no second press needed).
  const handleConfirm = useCallback(() => {
    if (!selectedStage) return;
    if (!selectedStage.bundled) {
      triggerDownload(selectedStage.id);
    }
    if (!selectedReady) {
      // Still downloading: remember the intent and fire automatically
      // when the download completes (pending-confirm effect).
      setPendingConfirm(true);
      return;
    }
    setPendingConfirm(false);
    confirmStage(selectedStage);
  }, [selectedStage, selectedReady, confirmStage, triggerDownload]);

  // Auto-confirm once the pending stage download lands. Guarded against
  // spectate (the guest has no input here) and cursor moves (confirming
  // follows the CURRENTLY SELECTED stage only).
  useEffect(() => {
    if (spectate || loading || !pendingConfirm) return;
    if (!selectedStage) { setPendingConfirm(false); return; }
    if (isReady(selectedStage)) {
      setPendingConfirm(false);
      confirmStage(selectedStage);
    }
  }, [spectate, loading, pendingConfirm, selectedStage, isReady, confirmStage, downloadStates]);

  // ---- Keyboard controls ----
  useEffect(() => {
    if (spectate) return; // online guest: the host is picking — no input
    const onKey = (e: KeyboardEvent) => {
      if (loading) return;
      const code = e.code;
      if (code === 'ArrowRight') {
        e.preventDefault();
        moveSelection(1);
      } else if (code === 'ArrowDown') {
        e.preventDefault();
        moveSelection(gridRowJump());
      } else if (code === 'ArrowLeft') {
        e.preventDefault();
        moveSelection(-1);
      } else if (code === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-gridRowJump());
      } else if (code === 'PageDown') {
        e.preventDefault();
        moveSelection(gridRowJump() * 2);
      } else if (code === 'PageUp') {
        e.preventDefault();
        moveSelection(-gridRowJump() * 2);
      } else if (code === 'Home') {
        e.preventDefault();
        setSelectedIndex(filteredIndicesRef.current[0] ?? 0);
      } else if (code === 'End') {
        e.preventDefault();
        const list = filteredIndicesRef.current;
        setSelectedIndex(list.length ? list[list.length - 1] : 0);
      } else if (code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        handleConfirm();
      } else if (code === 'KeyR') {
        e.preventDefault();
        handleRandom();
      } else if (code === 'Escape' || code === 'Backspace') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, moveSelection, gridRowJump, handleConfirm, handleRandom, onCancel, spectate]);

  // ---- Render the download status block for a card ----
  const renderDownloadStatus = (stage: LocalStage) => {
    // Bundled stage — always ready, no download needed.
    if (stage.bundled) {
      return (
        <div className="ss__card-download ss__card-download--ready">BUNDLED</div>
      );
    }

    // Already cached (in IndexedDB before mount or via a completed download).
    if (cachedIds.has(stage.id)) {
      return (
        <div className="ss__card-download ss__card-download--ready">✓ READY</div>
      );
    }

    const ds = downloadStates[stage.id];

    // Download in progress — show percent.
    if (ds?.status === 'downloading') {
      return (
        <>
          <div className="ss__card-download ss__card-download--downloading">
            DOWNLOADING · {ds.progress}%
          </div>
          <div className="ss__card-progress" aria-hidden="true">
            <div
              className="ss__card-progress-fill"
              style={{ width: `${ds.progress}%` }}
            />
          </div>
        </>
      );
    }

    // Download failed — selecting the stage + confirming re-triggers the
    // download (spec Section 16: failure must be visible and retryable).
    if (ds?.status === 'error') {
      return (
        <div className="ss__card-download ss__card-download--error">
          ⚠ FAILED — RETRY
        </div>
      );
    }

    // Not yet downloaded — show size hint.
    return (
      <div className="ss__card-download ss__card-download--idle">
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
    ? 'DOWNLOAD FAILED — PRESS ENTER / TAP FIGHT TO RETRY'
    : 'PREPARING DOWNLOAD…';

  return (
    <main className="ss" tabIndex={0}>
      {/* Print dressing: paper field + diagonal wedges + drifting halftone + reg marks */}
      <div className="ss__bg-wedges" aria-hidden="true" />
      <div className="ss__bg-dots" aria-hidden="true" />
      <span className="cs__reg ss__reg-tl" aria-hidden="true" />
      <span className="cs__reg ss__reg-tr" aria-hidden="true" />

      {/* Masthead — paper poster */}
      <header className="ss__title">
        <div className="ss__kicker">
          <span className="cs__kicker-rule" aria-hidden="true" />
          <span>ISSUE No. 03 — THE BATTLEGROUND</span>
          <span className="cs__kicker-rule" aria-hidden="true" />
        </div>
        <h1 className="ss__title-main">SELECT STAGE</h1>
        <div className="ss__title-sub">
          {loading
            ? 'LOADING STAGES…'
            : error
            ? 'COULD NOT LOAD STAGE LIST'
            : `${stages.length} STAGES AVAILABLE`}
        </div>
        {error && (
          <div className="cs__roster-error">
            <span className="cs__roster-error-msg">CDN error: {error}</span>
            <button
              type="button"
              className="cs__diff-btn cs__diff-btn--active"
              onClick={() => setRetryTick(t => t + 1)}
            >
              RETRY
            </button>
          </div>
        )}
      </header>

      {/* Selected stage preview panel — ink comic panel */}
      {selectedStage && !loading && (
        <div className="ss__preview">
          <div className="ss__preview-portrait">
            <span>{selectedStage.displayName.charAt(0).toUpperCase()}</span>
            {selectedStage.thumb && (
              <StageImg src={selectedStage.thumb} className="ss__preview-img" />
            )}
            <i className="ss__preview-dots" aria-hidden="true" />
          </div>
          <div className="ss__preview-info" aria-live="polite">
            <div className="ss__preview-kicker">NOW SCOUTING</div>
            <div className="ss__preview-name">{selectedStage.displayName}</div>
            {selectedStage.description && (
              <div className="ss__preview-desc">{selectedStage.description}</div>
            )}
            <div className="ss__preview-status">
              {selectedStage.bundled ? (
                <span className="ss__status ss__status--ok">✓ READY · BUNDLED</span>
              ) : selectedReady ? (
                <span className="ss__status ss__status--ok">✓ READY</span>
              ) : selectionStatus ? (
                <span className="ss__status ss__status--warn">{selectionStatus}</span>
              ) : (
                <span className="ss__status ss__status--idle">—</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* View filter chips + random — paper print chips */}
      {!loading && !error && (
        <div className="ss__chips">
          <span className="ss__chips-label">SHOW</span>
          <button
            type="button"
            className={`ss__chip${!readyOnly ? ' ss__chip--active' : ''}`}
            onClick={() => setReadyOnly(false)}
          >
            ALL
          </button>
          <button
            type="button"
            className={`ss__chip${readyOnly ? ' ss__chip--active' : ''}`}
            onClick={() => setReadyOnly(true)}
            title="Only stages already cached on this device"
          >
            ON DEVICE
          </button>
          <button
            type="button"
            className="ss__chip ss__chip--random"
            onClick={handleRandom}
            disabled={!stages.some(s => isReady(s))}
            title="Fight on a random ready stage (R)"
          >
            ? RANDOM
          </button>
        </div>
      )}

      {/* Stage grid */}
      <div className="ss__grid" role="grid" aria-label="Stage list" ref={gridRef}>
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
        {!loading && filteredIndices.length === 0 && (
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
            {readyOnly
              ? 'NO STAGES ON DEVICE YET — SWITCH TO "ALL" AND DOWNLOAD ONE'
              : 'NO STAGES AVAILABLE'}
          </div>
        )}
        {!loading &&
          filteredIndices.map(index => {
            const stage = stages[index];
            if (!stage) return null;
            const isSelected = index === selectedIndex;
            return (
              <div
                key={stage.id}
                className={`ss__card${isSelected ? ' ss__card--selected' : ''}`}
                style={{ animationDelay: `${Math.min(index * 45, 450)}ms` }}
                onClick={() => setSelectedIndex(index)}
                onDoubleClick={() => handleConfirm()}
                role="gridcell"
                tabIndex={-1}
              >
                <span className="ss__card-caret" aria-hidden="true" />
                <div className="ss__card-head">
                  <span className="ss__card-num">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="ss__card-portrait">
                    <span>{stage.displayName.charAt(0).toUpperCase()}</span>
                    {stage.thumb && <StageImg src={stage.thumb} className="ss__card-img" />}
                  </div>
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
          {isTouch ? (
            <>
              <span>TAP</span> select · <span>FIGHT!</span> or <span>? RANDOM</span> confirm
            </>
          ) : (
            <>
              <span>ARROWS</span> select · <span>ENTER</span> confirm · <span>R</span> random · <span>ESC</span> back
            </>
          )}
          {selectedStage && (
            <div style={{ marginTop: '0.25rem' }}>
              Current: <span style={{ color: 'var(--royal)' }}>
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
          <button type="button" className="cs__btn-back" onClick={onCancel} disabled={spectate}>
            ← BACK
          </button>
          <button
            type="button"
            className="cs__btn-fight"
            onClick={handleConfirm}
            disabled={spectate || loading || !selectedStage}
            aria-disabled={spectate || loading || !selectedStage}
            title={
              spectate
                ? 'The host is choosing the stage'
                : !selectedStage
                ? 'Select a stage'
                : !selectedReady
                ? 'Stage is downloading — the fight starts automatically when it lands'
                : 'Lock in and fight!'
            }
          >
            {spectate
              ? 'WAITING…'
              : (selectedStage && !selectedReady
                  ? (downloadStates[selectedStage.id]?.status === 'downloading'
                      ? 'DOWNLOADING ' + Math.round(downloadStates[selectedStage.id].progress) + '%…'
                      : (pendingConfirm ? 'WAITING FOR DOWNLOAD…' : 'DOWNLOAD & FIGHT'))
                  : 'FIGHT!')}
          </button>
        </div>
      </div>

      {/* Online guest overlay: the host is picking the stage */}
      {spectate && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(16,16,24,0.82)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            textAlign: 'center',
            padding: '1.5rem',
          }}
          onClick={e => e.stopPropagation()}
        >
          <div
            style={{
              fontSize: '0.8rem',
              letterSpacing: '0.25em',
              color: 'var(--gold)',
              fontWeight: 700,
            }}
          >
            {spectateNote || 'WAITING FOR THE HOST…'}
          </div>
          <button
            type="button"
            className="cs__btn-back"
            onClick={onCancel}
          >
            ← LEAVE ONLINE MODE
          </button>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// StageImg subcomponent
// ---------------------------------------------------------------------------

/** Stage thumbnail with fade-in on load (CSS shows it once .loaded is set;
 *  the letter tile underneath stays visible until then — and forever when
 *  no <stage>.png exists in the Assets repo yet).
 *  ONE silent retry on error: opening the grid fires one /api/cdn request
 *  per stage at once, and while the edge cache is still cold a few could
 *  come back 429/503 (upstream throttling). A single delayed re-request
 *  heals those; remounting via key forces the re-fetch since an <img> with
 *  an unchanged src will not retry on its own. A genuinely missing
 *  thumbnail (404) just keeps the letter tile. Same contract as the
 *  character roster's PortraitImg. */
function StageImg({ src, className }: { src: string; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <img
      key={attempt}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className ?? ''}${loaded ? ' loaded' : ''}`}
      onLoad={() => setLoaded(true)}
      onError={() => {
        if (attempt < 1) {
          setTimeout(() => setAttempt(a => a + 1), 1500);
        }
      }}
    />
  );
}
