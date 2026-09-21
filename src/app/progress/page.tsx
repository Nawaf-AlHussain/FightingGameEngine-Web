'use client';

import { useEffect, useState, useRef } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { getCurrentModeState, buildNextFightUrl, clearModeState, type ModeState } from '@/lib/game-modes';

/**
 * /progress — between-fights screen for Arcade, Survival, and Time Attack.
 *
 * Shows the current standings (fight #/total, wins, next opponent) and
 * auto-navigates to /play with the next opponent after a few seconds.
 * The user can also click "NEXT FIGHT" to advance immediately, or "QUIT"
 * to abandon the run and return to character select.
 */
export default function ProgressPage() {
  const { navigate } = useWipeNavigation();
  const [state, setState] = useState<ModeState | null>(null);
  const [countdown, setCountdown] = useState(3);
  const navigatedRef = useRef(false);

  useEffect(() => {
    const s = getCurrentModeState();
    if (!s) {
      // No mode state — go back to select
      navigate('/local');
      return;
    }
    setState(s);
  }, [navigate]);

  // Auto-advance countdown
  useEffect(() => {
    if (!state) return;
    if (countdown <= 0) {
      // Navigate to next fight
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        const url = buildNextFightUrl(state, 'stages/stage0-720.def');
        navigate(url);
      }
      return;
    }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, state, navigate]);

  const handleQuit = () => {
    clearModeState();
    navigate('/local');
  };

  const handleNext = () => {
    if (!state || navigatedRef.current) return;
    navigatedRef.current = true;
    const url = buildNextFightUrl(state, 'stages/stage0-720.def');
    navigate(url);
  };

  if (!state) {
    return (
      <main className="progress">
        <div className="progress__loading">LOADING…</div>
      </main>
    );
  }

  const modeLabel = {
    'arcade': 'ARCADE',
    'survival': 'SURVIVAL',
    'time-attack': 'TIME ATTACK',
    'watch': 'WATCH',
  }[state.mode] || state.mode.toUpperCase();

  const isSurvival = state.mode === 'survival';
  const fightLabel = isSurvival
    ? `FIGHT ${state.fightNumber}`
    : `FIGHT ${state.fightNumber} OF ${state.totalFights}`;

  return (
    <main className="progress bg-grid">
      <div className="progress__bg-grid bg-grid" aria-hidden="true" />

      <div className="progress__content">
        <div className="progress__mode">{modeLabel}</div>

        <h1 className="progress__title">VICTORY!</h1>
        <div className="progress__subtitle">{fightLabel}</div>

        <div className="progress__stats">
          <div className="progress__stat">
            <span className="progress__stat-label">WINS</span>
            <span className="progress__stat-value">{state.wins}</span>
          </div>
          {!isSurvival && (
            <div className="progress__stat">
              <span className="progress__stat-label">LOSSES</span>
              <span className="progress__stat-value">{state.losses}</span>
            </div>
          )}
          {state.mode === 'time-attack' && (
            <div className="progress__stat">
              <span className="progress__stat-label">TIME</span>
              <span className="progress__stat-value">{state.totalTime.toFixed(1)}s</span>
            </div>
          )}
        </div>

        <div className="progress__next">
          <div className="progress__next-label">NEXT OPPONENT</div>
          <div className="progress__next-name">
            {state.opponents[(state.fightNumber - 1) % state.opponents.length]}
          </div>
        </div>

        <div className="progress__countdown">
          Next fight in {countdown}…
        </div>

        <div className="progress__buttons">
          <button type="button" className="progress__btn progress__btn--quit" onClick={handleQuit}>
            QUIT
          </button>
          <button type="button" className="progress__btn progress__btn--next" onClick={handleNext}>
            NEXT FIGHT ►
          </button>
        </div>
      </div>
    </main>
  );
}
