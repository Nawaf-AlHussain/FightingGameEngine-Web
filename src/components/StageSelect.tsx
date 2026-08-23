'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getStages,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // ---- Fetch stage list from CDN ----
  useEffect(() => {
    let cancelled = false;
    getStages()
      .then((cdnStages: StageInfo[]) => {
        if (cancelled) return;
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

  // ---- Confirm current selection ----
  const handleConfirm = useCallback(() => {
    const stage = stages[selectedIndex];
    if (stage) onSelect(stage.id);
  }, [stages, selectedIndex, onSelect]);

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

  const selectedStage = useMemo(() => stages[selectedIndex], [stages, selectedIndex]);

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
                onDoubleClick={() => onSelect(stage.id)}
                role="gridcell"
                tabIndex={-1}
              >
                <div className="ss__card-portrait">
                  <span>{stage.displayName.charAt(0).toUpperCase()}</span>
                </div>
                <div className="ss__card-name">{stage.displayName}</div>
                <div className="ss__card-desc">{stage.description}</div>
                <div
                  className={`ss__card-download ss__card-download--${
                    stage.bundled ? 'ready' : 'idle'
                  }`}
                >
                  {stage.bundled
                    ? 'BUNDLED'
                    : `DOWNLOAD · ${stage.sizeMB.toFixed(1)} MB`}
                </div>
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
            disabled={loading || !selectedStage}
          >
            FIGHT!
          </button>
        </div>
      </div>
    </main>
  );
}
