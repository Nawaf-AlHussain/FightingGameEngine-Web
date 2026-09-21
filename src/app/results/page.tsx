'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { clearModeState } from '@/lib/game-modes';

/**
 * /results — final victory/defeat screen shown after completing (or failing)
 * an Arcade/Survival/Time Attack run.
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

  // Clear the mode state so the user starts fresh next time
  useEffect(() => {
    clearModeState();
  }, []);

  const isVictory = result === 'win';
  const modeLabel = {
    'arcade': 'ARCADE',
    'survival': 'SURVIVAL',
    'time-attack': 'TIME ATTACK',
    'watch': 'WATCH',
  }[mode] || mode.toUpperCase();

  return (
    <main className="results bg-grid">
      <div className="results__bg-grid bg-grid" aria-hidden="true" />

      <div className="results__content">
        <div className="results__mode">{modeLabel}</div>

        <h1 className={`results__title ${isVictory ? 'results__title--win' : 'results__title--lose'}`}>
          {isVictory ? 'VICTORY!' : 'GAME OVER'}
        </h1>

        <div className="results__stats">
          <div className="results__stat">
            <span className="results__stat-label">WINS</span>
            <span className="results__stat-value">{wins}</span>
          </div>
          <div className="results__stat">
            <span className="results__stat-label">LOSSES</span>
            <span className="results__stat-value">{losses}</span>
          </div>
          {mode === 'time-attack' && (
            <div className="results__stat">
              <span className="results__stat-label">TOTAL TIME</span>
              <span className="results__stat-value">{time.toFixed(1)}s</span>
            </div>
          )}
        </div>

        <div className="results__buttons">
          <button
            type="button"
            className="results__btn results__btn--again"
            onClick={() => navigate('/local')}
          >
            PLAY AGAIN
          </button>
          <button
            type="button"
            className="results__btn results__btn--lobby"
            onClick={() => navigate('/lobby')}
          >
            MAIN MENU
          </button>
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
