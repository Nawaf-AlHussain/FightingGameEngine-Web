'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';
import {
  getCurrentModeState,
  MODE_LABELS,
  MODE_RULES,
  type ModeState,
} from '@/lib/game-modes';
import {
  getCharacters,
  getStages,
  downloadCharacterToCache,
  downloadStageToCache,
  isCharacterCached,
  isStageCached,
  charRef,
  portraitUrl,
  type CharacterInfo,
  type StageInfo,
} from '@/lib/character-downloader';
import { prewarmEngineAssets } from '@/lib/engine-prewarm';

/**
 * Match Preparation Screen (Frontend 2.1 spec Sections 17-18, 48).
 *
 * Confirms mode, P1, P2/opponent, stage, mode rules, and — critically —
 * the REAL asset readiness state before entering the fight:
 *
 * - Readiness comes from the existing IndexedDB cache layer
 *   (isCharacterCached / isStageCached with the manifest file list),
 *   NOT from timers or optimistic booleans (spec Section 48).
 * - Characters/stages that are not cached yet are downloaded right here
 *   using the existing downloader implementation (single download/cache
 *   architecture — no second pipeline; spec Section 16).
 * - The countdown only starts once every required asset is actually
 *   ready; the FIGHT button stays gated until then (spec Section 34:
 *   loading indicators correspond to real work).
 *
 * URL params are the same as /play — this screen forwards them.
 */

type SlotStatus = 'checking' | 'ready' | 'downloading' | 'error';

interface SlotState {
  status: SlotStatus;
  progress: number;
  displayName: string;
  /** Browser URL of the big-portrait PNG @ 256px (undefined = no image). */
  portrait?: string;
}

/** Portrait image with fade-in on load. */
function MatchPrepPortrait({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={`match-prep__portrait${loaded ? ' loaded' : ''}`}
      onLoad={() => setLoaded(true)}
    />
  );
}

type SlotSetter = Dispatch<SetStateAction<SlotState>>;

function MatchPrepInner() {
  const { navigate } = useWipeNavigation();
  const searchParams = useSearchParams();

  // Nothing is bundled anymore — every slot must be named by the URL.
  // Missing params resolve to empty ids whose slots land in 'error'
  // (FIGHT stays gated) instead of silently fighting Kung Fu Man.
  const p1 = searchParams.get('p1') || '';
  const p2 = searchParams.get('p2') || '';
  const stage = searchParams.get('stage') || '';
  const qmode = searchParams.get('qmode') || 'quickvs';

  const [modeState, setModeState] = useState<ModeState | null>(null);
  const [p1Slot, setP1Slot] = useState<SlotState>({ status: 'checking', progress: 0, displayName: p1 });
  const [p2Slot, setP2Slot] = useState<SlotState>({ status: 'checking', progress: 0, displayName: p2 });
  const [stageSlot, setStageSlot] = useState<SlotState>({ status: 'checking', progress: 0, displayName: stage });

  // Real countdown — starts only when all required assets are ready.
  const [countdown, setCountdown] = useState<number | null>(null);
  // Auto-start delay for the countdown: 3s when this visit actually
  // downloaded something (a beat to see the screen), 1s when everything was
  // already cached (repeat play — the old fixed 3s was pure dead delay).
  const countdownSecondsRef = useRef(3);
  // Bumped by the RETRY button to re-run the readiness pass.
  const [retryTick, setRetryTick] = useState(0);

  const navigatedRef = useRef(false);

  const allReady =
    p1Slot.status === 'ready' &&
    p2Slot.status === 'ready' &&
    stageSlot.status === 'ready';

  // ---- Build the /play URL with the same params ----
  const playUrl = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    return `/play?${params.toString()}`;
  }, [searchParams]);

  const handleFight = useCallback(() => {
    if (navigatedRef.current) return;
    if (!allReady) return; // spec Section 48: match may start only when assets are ready
    navigatedRef.current = true;
    navigate(playUrl());
  }, [navigate, playUrl, allReady]);

  // ---- Readiness pass: resolve names, check cache, download what's missing ----
  // Runs on mount, when match params change, and when RETRY is clicked.
  // Uses ONLY the existing download/cache implementation (spec Section 16).
  useEffect(() => {
    let cancelled = false;
    const inflight = new Set<string>();
    // True once ANY slot needed a real download this pass — decides the
    // countdown length below (3s after downloads, 1s on pure cache hits).
    let downloadedAny = false;

    const ensureCharacter = async (id: string, info: CharacterInfo, setSlot: SlotSetter) => {
      // Real cache state first — validates ALL required files are present.
      const cached = await isCharacterCached(id, info.files);
      if (cancelled) return;
      if (cached) {
        setSlot(s => ({ ...s, status: 'ready', progress: 100 }));
        return;
      }
      if (inflight.has(id)) {
        setSlot(s => ({ ...s, status: 'downloading', progress: s.progress }));
        return;
      }
      inflight.add(id);
      downloadedAny = true;
      setSlot(s => ({ ...s, status: 'downloading', progress: 0 }));
      try {
        await downloadCharacterToCache(info, pct => {
          if (!cancelled) setSlot(s => ({ ...s, status: 'downloading', progress: pct }));
        });
        if (cancelled) return;
        setSlot(s => ({ ...s, status: 'ready', progress: 100 }));
      } catch {
        if (!cancelled) setSlot(s => ({ ...s, status: 'error', progress: 0 }));
      } finally {
        inflight.delete(id);
      }
    };

    const ensureStage = async (id: string, info: StageInfo, setSlot: SlotSetter) => {
      const cached = await isStageCached(id, info.files);
      if (cancelled) return;
      if (cached) {
        setSlot(s => ({ ...s, status: 'ready', progress: 100 }));
        return;
      }
      if (inflight.has(id)) {
        setSlot(s => ({ ...s, status: 'downloading', progress: s.progress }));
        return;
      }
      inflight.add(id);
      downloadedAny = true;
      setSlot(s => ({ ...s, status: 'downloading', progress: 0 }));
      try {
        await downloadStageToCache(info, pct => {
          if (!cancelled) setSlot(s => ({ ...s, status: 'downloading', progress: pct }));
        });
        if (cancelled) return;
        setSlot(s => ({ ...s, status: 'ready', progress: 100 }));
      } catch {
        if (!cancelled) setSlot(s => ({ ...s, status: 'error', progress: 0 }));
      } finally {
        inflight.delete(id);
      }
    };

    async function resolve() {
      setModeState(getCurrentModeState());

      let chars: CharacterInfo[] = [];
      let stages: StageInfo[] = [];
      try {
        [chars, stages] = await Promise.all([getCharacters(), getStages()]);
      } catch {
        // Manifest fetch failed — cannot verify or download anything.
        // The slots below fall into 'error' with a retry path.
      }
      if (cancelled) return;

      // Keyed by selection reference ("Wolverine" / "charsMARVEL/Wolverine")
      const charById = new Map(chars.map(c => [charRef(c), c]));
      const stageById = new Map(stages.map(s => [s.id, s]));

      // Display names (fall back to raw IDs when the manifest is unavailable)
      const charName = (id: string) => charById.get(id)?.displayName ?? id;
      const stageName = (id: string) => stageById.get(id)?.displayName ?? id;
      const charPortrait = (id: string) => portraitUrl(charById.get(id));

      setP1Slot({ status: 'checking', progress: 0, displayName: charName(p1), portrait: charPortrait(p1) });
      setP2Slot({ status: 'checking', progress: 0, displayName: charName(p2), portrait: charPortrait(p2) });
      setStageSlot({ status: 'checking', progress: 0, displayName: stageName(stage) });

      const jobs: Promise<void>[] = [];

      {
        const info = charById.get(p1);
        if (info) jobs.push(ensureCharacter(p1, info, setP1Slot));
        else setP1Slot(s => ({ ...s, status: 'error' })); // not in manifest — /play will report details
      }

      {
        const info = charById.get(p2);
        if (info) jobs.push(ensureCharacter(p2, info, setP2Slot));
        else setP2Slot(s => ({ ...s, status: 'error' }));
      }

      {
        const info = stageById.get(stage);
        if (info) jobs.push(ensureStage(stage, info, setStageSlot));
        else setStageSlot(s => ({ ...s, status: 'error' }));
      }

      await Promise.all(jobs);
      countdownSecondsRef.current = downloadedAny ? 3 : 1;
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [p1, p2, stage, retryTick]);

  // ---- Countdown: only runs when everything is REALLY ready ----
  useEffect(() => {
    if (!allReady || navigatedRef.current) {
      setCountdown(null);
      return;
    }
    // Use this window to pull engine.wasm.gz + game.pak.gz into the HTTP
    // cache — /play's boot then starts from disk instead of the network.
    prewarmEngineAssets();
    setCountdown(countdownSecondsRef.current);
  }, [allReady]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      handleFight();
      return;
    }
    const t = setTimeout(() => setCountdown(c => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, handleFight]);

  const handleRetry = useCallback(() => {
    setRetryTick(t => t + 1); // re-runs the readiness pass (cache checks are cheap; only missing files download)
  }, []);

  const isProgression = qmode !== 'quickvs' && qmode !== 'training';
  const isWatch = qmode === 'watch';
  const label = MODE_LABELS[qmode] || qmode.toUpperCase();
  const rules = MODE_RULES[qmode];

  // Fight number for progression modes
  const fightLabel = modeState
    ? modeState.mode === 'survival'
      ? `FIGHT ${modeState.fightNumber}`
      : `FIGHT ${modeState.fightNumber} OF ${modeState.totalFights}`
    : null;

  // ---- Readiness badge per slot ----
  const renderSlotStatus = (slot: SlotState) => {
    switch (slot.status) {
      case 'ready':
        return <span style={{ color: 'var(--green)' }}>✓ READY</span>;
      case 'checking':
        return <span style={{ color: 'var(--gray)' }}>CHECKING…</span>;
      case 'downloading':
        return <span style={{ color: 'var(--royal)' }}>DOWNLOADING · {slot.progress}%</span>;
      case 'error':
        return <span style={{ color: 'var(--red)' }}>⚠ FAILED</span>;
    }
  };

  const hasError =
    p1Slot.status === 'error' || p2Slot.status === 'error' || stageSlot.status === 'error';

  return (
    <main className="match-prep bg-grid">
      <div className="match-prep__bg-grid bg-grid" aria-hidden="true" />

      <div className="match-prep__content">
        {/* Mode + fight number */}
        <div className="match-prep__mode">{label}</div>
        {fightLabel && <div className="match-prep__fight-num">{fightLabel}</div>}

        {/* VS section */}
        <div className="match-prep__vs">
          <div className="match-prep__player match-prep__player--p1">
            <div className="match-prep__player-label">
              {isWatch ? 'CPU 1' : 'PLAYER 1'}
            </div>
            <div className="match-prep__portrait-box">
              {p1Slot.portrait ? (
                <MatchPrepPortrait src={p1Slot.portrait} />
              ) : (
                <span className="match-prep__portrait-fallback">
                  {p1Slot.displayName.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <div className="match-prep__player-name">{p1Slot.displayName}</div>
            <div className="match-prep__player-status">{renderSlotStatus(p1Slot)}</div>
          </div>

          <div className="match-prep__vs-text">VS</div>

          <div className="match-prep__player match-prep__player--p2">
            <div className="match-prep__player-label">
              {isProgression ? 'NEXT OPPONENT' : isWatch ? 'CPU 2' : 'PLAYER 2'}
            </div>
            <div className="match-prep__portrait-box">
              {p2Slot.portrait ? (
                <MatchPrepPortrait src={p2Slot.portrait} />
              ) : (
                <span className="match-prep__portrait-fallback">
                  {p2Slot.displayName.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <div className="match-prep__player-name">{p2Slot.displayName}</div>
            <div className="match-prep__player-status">{renderSlotStatus(p2Slot)}</div>
          </div>
        </div>

        {/* Stage */}
        <div className="match-prep__stage">
          <div className="match-prep__stage-label">STAGE</div>
          <div className="match-prep__stage-name">{stageSlot.displayName}</div>
          <div className="match-prep__player-status">{renderSlotStatus(stageSlot)}</div>
        </div>

        {/* Mode rules (Frontend 2.1 spec Section 17: relevant mode rules) */}
        {rules && <div className="match-prep__rules">{rules}</div>}

        {/* FIGHT button — gated on REAL readiness (spec Section 48) */}
        <div className="match-prep__buttons">
          <GameButton variant="secondary" onClick={() => navigate('/local')}>
            ← BACK
          </GameButton>
          {hasError ? (
            <GameButton variant="primary" onClick={handleRetry}>
              RETRY DOWNLOAD
            </GameButton>
          ) : (
            <GameButton
              variant="primary"
              onClick={handleFight}
              loading={!allReady}
              disabled={!allReady}
              title={allReady ? 'Start the fight' : 'Waiting for assets to finish downloading'}
            >
              FIGHT ►
            </GameButton>
          )}
        </div>

        {/* Honest status line — real countdown when ready, real reason when not */}
        <div className="match-prep__auto-hint">
          {!allReady
            ? hasError
              ? 'A download failed — click RETRY DOWNLOAD to try again'
              : 'Preparing assets…'
            : countdown !== null && countdown > 0
            ? `Starting in ${countdown}s… click FIGHT to start now`
            : 'Ready!'}
        </div>
      </div>
    </main>
  );
}

export default function MatchPrepPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black flex items-center justify-center">
        <span
          className="font-mono text-sm"
          style={{ color: 'rgba(242,236,218,0.6)', letterSpacing: '0.2em' }}
        >
          Loading...
        </span>
      </div>
    }>
      <MatchPrepInner />
    </Suspense>
  );
}
