'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';
import { clearModeState, MODE_LABELS } from '@/lib/game-modes';

/**
 * /results — final victory/defeat screen (Section 24-25 of spec).
 *
 * Mode-specific layouts:
 * - Arcade victory: "ARCADE CLEAR" + "X / 5 FIGHTS" + W/L
 * - Arcade defeat: "GAME OVER" + "FIGHT N" + W/L
 * - Survival: Always "GAME OVER" (endless — no victory) + "N WINS"
 * - Time Attack: "3 / 3 FIGHTS" + "TOTAL TIME MM:SS.S"
 * - Watch: "WATCH COMPLETE" + winner
 *
 * URL params:
 *   result=win|lose
 *   mode=arcade|survival|time-attack|watch
 *   wins=N
 *   losses=N
 *   time=N.N (seconds, for time-attack)
 */
function ResultsPageInner() {
  const { navigate } = useWipeNavigation();
  const searchParams = useSearchParams();

  const result = searchParams.get('result') || 'win';
  const mode = searchParams.get('mode') || 'arcade';
  const wins = parseInt(searchParams.get('wins') || '0', 10);
  const losses = parseInt(searchParams.get('losses') || '0', 10);
  const time = parseFloat(searchParams.get('time') || '0');

  useEffect(() => {
    clearModeState();
  }, []);

  const isVictory = result === 'win';
  const modeLabel = MODE_LABELS[mode] || mode.toUpperCase();

  // Format time as MM:SS.S for time-attack
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${String(mins).padStart(2, '0')}:${secs.padStart(4, '0')}`;
  };

  // Mode-specific title and subtitle
  let title: string;
  let subtitle: string;

  if (mode === 'survival') {
    // Survival is endless — always "GAME OVER", never "VICTORY"
    title = 'GAME OVER';
    subtitle = `${wins} WINS`;
  } else if (mode === 'watch') {
    // Watch: show winner, not victory/defeat
    title = 'WATCH COMPLETE';
    subtitle = isVictory ? 'P1 WINS' : 'P2 WINS';
  } else if (mode === 'time-attack') {
    title = isVictory ? 'VICTORY!' : 'GAME OVER';
    subtitle = isVictory ? `${wins} / ${wins + losses} FIGHTS` : `FIGHT ${wins + losses}`;
  } else {
    // Arcade
    title = isVictory ? 'VICTORY!' : 'GAME OVER';
    subtitle = isVictory
      ? `${modeLabel} CLEAR · ${wins} / ${wins + losses} FIGHTS`
      : `FIGHT ${wins + losses}`;
  }

  const titleClass = mode === 'survival' || (!isVictory && mode !== 'watch')
    ? 'results__title--lose'
    : 'results__title--win';

  // Button labels (Section 24)
  const againLabel = mode === 'survival' ? 'TRY AGAIN' : 'PLAY AGAIN';

  return (
    <main className="results bg-grid">
      <div className="results__bg-grid bg-grid" aria-hidden="true" />

      <div className="results__content">
        <div className="results__mode">{modeLabel}</div>

        <h1 className={`results__title ${titleClass}`}>{title}</h1>
        <div className="results__subtitle">{subtitle}</div>

        <div className="results__stats">
          {mode === 'survival' ? (
            <div className="results__stat">
              <span className="results__stat-label">WINS</span>
              <span className="results__stat-value">{wins}</span>
            </div>
          ) : (
            <>
              <div className="results__stat">
                <span className="results__stat-label">WINS</span>
                <span className="results__stat-value">{wins}</span>
              </div>
              <div className="results__stat">
                <span className="results__stat-label">LOSSES</span>
                <span className="results__stat-value">{losses}</span>
              </div>
            </>
          )}
          {mode === 'time-attack' && (
            <div className="results__stat">
              <span className="results__stat-label">TOTAL TIME</span>
              <span className="results__stat-value">{formatTime(time)}</span>
            </div>
          )}
        </div>

        <div className="results__buttons">
          <GameButton variant="primary" onClick={() => navigate('/local')}>
            {againLabel}
          </GameButton>
          <GameButton variant="secondary" onClick={() => navigate('/lobby')}>
            MAIN MENU
          </GameButton>
        </div>
      </div>
    </main>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black flex items-center justify-center">
        <span className="text-gray-500 font-mono text-sm">Loading...</span>
      </div>
    }>
      <ResultsPageInner />
    </Suspense>
  );
}
