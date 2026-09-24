'use client';

import { useEffect, useState, useRef } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';
import {
  getCurrentModeState,
  buildNextFightUrl,
  clearModeState,
  MODE_LABELS,
  MODE_RULES,
  type ModeState,
} from '@/lib/game-modes';
import { getCharacters, getStages } from '@/lib/character-downloader';

/**
 * /progress — between-fights screen for Arcade, Survival, and Time Attack.
 *
 * Shows the current standings (fight #/total, wins, next opponent) and
 * auto-navigates to /play with the next opponent after a few seconds.
 * The user can also click "NEXT FIGHT" to advance immediately, or "QUIT"
 * to abandon the run and return to character select.
 *
 * Progress indicators (Section 23):
 * - Arcade: dot ladder (●──●──○──○──○) showing completed fights
 * - Survival: endless dots (no finite bar — spec: "Do not fabricate a
 *   finite progress bar for Survival")
 * - Time Attack: fight X of 3 + elapsed time
 */
export default function ProgressPage() {
  const { navigate } = useWipeNavigation();
  const [state, setState] = useState<ModeState | null>(null);
  const [countdown, setCountdown] = useState(3);
  const navigatedRef = useRef(false);
  // Display names resolved from the real Assets manifest (spec Section 22:
  // show names, not raw IDs). Falls back to raw IDs if the fetch fails.
  const [charNames, setCharNames] = useState<Record<string, string>>({});
  const [stageName, setStageName] = useState<string | null>(null);

  useEffect(() => {
    const s = getCurrentModeState();
    if (!s) {
      navigate('/local');
      return;
    }
    setState(s);
  }, [navigate]);

  // Resolve display names for P1, the next opponent, and the stage.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    (async () => {
      try {
        const [chars, stages] = await Promise.all([getCharacters(), getStages()]);
        if (cancelled) return;
        const names: Record<string, string> = {};
        for (const c of chars) names[c.id] = c.displayName;
        setCharNames(names);
        const stg = stages.find(x => x.id === state.stageId);
        setStageName(stg?.displayName ?? null);
      } catch {
        // Keep raw IDs — honest fallback, no fabricated data.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (countdown <= 0) {
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        const url = buildNextFightUrl(state, state.stageId || 'stages/stage0-720.def');
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
    const url = buildNextFightUrl(state, state.stageId || 'stages/stage0-720.def');
    navigate(url);
  };

  if (!state) {
    return (
      <main className="progress">
        <div className="progress__loading">LOADING…</div>
      </main>
    );
  }

  const modeLabel = MODE_LABELS[state.mode] || state.mode.toUpperCase();
  const rules = MODE_RULES[state.mode];

  const displayName = (id: string) => charNames[id] ?? id;
  const nextOpponentId = state.opponents[(state.fightNumber - 1) % state.opponents.length];

  const isSurvival = state.mode === 'survival';
  const isArcade = state.mode === 'arcade';
  const isTimeAttack = state.mode === 'time-attack';
  const fightLabel = isSurvival
    ? `FIGHT ${state.fightNumber}`
    : `FIGHT ${state.fightNumber} OF ${state.totalFights}`;

  // Progress indicator dots
  const renderProgressDots = () => {
    if (isArcade) {
      // Finite ladder: ●──●──○──○──○
      return (
        <div className="progress__dots">
          {Array.from({ length: state.totalFights }, (_, i) => (
            <span key={i} className={`progress__dot${i < state.wins ? ' progress__dot--done' : ''}${i === state.fightNumber - 1 ? ' progress__dot--current' : ''}`}>
              {i < state.wins ? '●' : i === state.fightNumber - 1 ? '◉' : '○'}
            </span>
          )).map((dot, i, arr) => (
            <span key={i} className="progress__dot-group">
              {dot}
              {i < arr.length - 1 && <span className="progress__dot-line">─</span>}
            </span>
          ))}
        </div>
      );
    }
    if (isSurvival) {
      // Endless: show last 8 wins as dots, no finite bar
      const recentWins = Math.min(state.wins, 8);
      return (
        <div className="progress__dots">
          {Array.from({ length: recentWins }, (_, i) => (
            <span key={i} className="progress__dot-group">
              <span className="progress__dot progress__dot--done">●</span>
              {i < recentWins - 1 && <span className="progress__dot-line">─</span>}
            </span>
          ))}
          <span className="progress__dot-group">
            <span className="progress__dot progress__dot--current">◉</span>
          </span>
        </div>
      );
    }
    if (isTimeAttack) {
      // 3-fight ladder
      return (
        <div className="progress__dots">
          {Array.from({ length: state.totalFights }, (_, i) => (
            <span key={i} className="progress__dot-group">
              <span className={`progress__dot${i < state.wins ? ' progress__dot--done' : ''}${i === state.fightNumber - 1 ? ' progress__dot--current' : ''}`}>
                {i < state.wins ? '●' : i === state.fightNumber - 1 ? '◉' : '○'}
              </span>
              {i < state.totalFights - 1 && <span className="progress__dot-line">─</span>}
            </span>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <main className="progress bg-grid">
      <div className="progress__bg-grid bg-grid" aria-hidden="true" />

      <div className="progress__content">
        <div className="progress__mode">{modeLabel}</div>

        <h1 className="progress__title">VICTORY!</h1>
        <div className="progress__subtitle">{fightLabel}</div>

        {/* Progress indicator */}
        {renderProgressDots()}

        <div className="progress__stats">
          <div className="progress__stat">
            <span className="progress__stat-label">YOUR FIGHTER</span>
            <span className="progress__stat-value progress__stat-value--p1">{displayName(state.playerChar)}</span>
          </div>
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
          {isTimeAttack && (
            <div className="progress__stat">
              <span className="progress__stat-label">TIME</span>
              <span className="progress__stat-value">{state.totalTime.toFixed(1)}s</span>
            </div>
          )}
        </div>

        <div className="progress__next">
          <div className="progress__next-label">NEXT OPPONENT</div>
          <div className="progress__next-name">{displayName(nextOpponentId)}</div>
        </div>

        {stageName && (
          <div className="progress__stage">
            <span className="progress__stat-label">STAGE</span>
            <span className="progress__stage-name">{stageName}</span>
          </div>
        )}

        {/* Mode rules (Frontend 2.1 spec Section 21: relevant rules) */}
        {rules && <div className="progress__rules">{rules}</div>}

        <div className="progress__countdown">
          Next fight in {countdown}…
        </div>

        <div className="progress__buttons">
          <GameButton variant="danger" onClick={handleQuit}>
            QUIT
          </GameButton>
          <GameButton variant="primary" onClick={handleNext}>
            NEXT FIGHT ►
          </GameButton>
        </div>
      </div>
    </main>
  );
}
