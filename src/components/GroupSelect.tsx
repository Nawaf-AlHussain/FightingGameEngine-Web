'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  getCharacters,
  getRosterSources,
  loadSavedRosterSource,
  saveRosterSourceChoice,
  clearSavedRosterSource,
  DEFAULT_SOURCE,
  type CharacterInfo,
  type RosterSource,
} from '@/lib/character-downloader';
import { useIsTouchDevice } from '@/lib/use-touch-device';

// ---------------------------------------------------------------------------
// GroupSelect — the dedicated "SELECT YOUR UNIVERSE" screen.
//
// Second stop of the separated, normal-fighting-game chain:
//
//   /lobby → /mode-select → /group-select (here) → /local (fighters) → stage
//
// A "group" (roster source) is one chars* folder in the Assets repo —
// MARVEL, DC, GUILTY GEAR, DRAGON BALL and the original mixed ALL-STARS
// roster — surfaced by the assets manifest. Picking one hands the fighter
// screen a pre-filtered roster: the character screen keeps its search and
// ON DEVICE filters, but the universe itself is chosen HERE (the source
// chip row that used to sit on the fighter grid is gone).
//
// The choice persists under the same localStorage key the old chips used
// (fg-roster-source), so repeat visitors and deep links keep their group.
//
// ONLINE (net=1): this screen also runs on the /play page as the phase
// between room-connect and character select. The HOST picks and the choice
// syncs to the guest over the bridge ('group' control frame); the guest
// sees this screen in spectate mode (cards greyed, no input) until the
// frame lands — both sides then enter the SAME universe, so the shared
// grid-index cursor sync stays meaningful.
//
// Keyboard: ↑↓ / W S — universe · ENTER / SPACE — confirm · ESC — back.
// Touch: tap a card, then CONTINUE.
// ---------------------------------------------------------------------------

/** Flavor copy per known group; unknown folders get the generic line. */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  [DEFAULT_SOURCE]: 'The original crossover mixing pot — legends from every universe.',
  charsMARVEL: 'Mutants, Avengers and street-level vigilantes from Earth-616.',
  charsDC: 'The World\u2019s Finest — Gotham, Metropolis and the wider DC cosmos.',
  charsGuiltyGear: 'Arc System Works\u2019 heavy-metal haze of blades and rock.',
  charsDBZExtremeBotuden: 'Ki-blasters and saiyans in the Extreme Butōden sprite style.',
};
const GENERIC_GROUP_DESCRIPTION = 'A roster of fighters from this universe.';

interface GroupSelectProps {
  /** Confirmed group (manifest source folder id). */
  onConfirm: (sourceId: string) => void;
  /** Back out one screen. */
  onCancel: () => void;
  /**
   * Spectate mode (online guest): the host is choosing the universe.
   * Cards render greyed with no input; the note explains who is picking.
   */
  spectate?: boolean;
  spectateNote?: string;
  /**
   * Preselect a group without touching localStorage (online host re-entry).
   * Undefined = restore the persisted choice, falling back to All-Stars.
   */
  initialSource?: string | null;
  /**
   * Online cursor sync: publish the index of the universe being browsed
   * (keyboard cycles AND taps land here) so the spectating guest sees the
   * choice form live. Same sync family as the character grid's cursor.
   */
  onCursor?: (index: number) => void;
  /** The opponent's live browsing index (spectate side highlight). */
  opponentIndex?: number | null;
}

export default function GroupSelect({
  onConfirm,
  onCancel,
  spectate = false,
  spectateNote = '',
  initialSource = null,
  onCursor,
  opponentIndex = null,
}: GroupSelectProps) {
  const isTouch = useIsTouchDevice();

  // Groups + per-group fighter counts (both come off the same manifest).
  const [groups, setGroups] = useState<RosterSource[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // Defaults agree with the SSR render (All-Stars); the persisted choice is
  // restored AFTER the manifest validates it (no hydration mismatch).
  const [selected, setSelected] = useState<string>(DEFAULT_SOURCE);

  // ---- Fetch groups + counts -------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getRosterSources(), getCharacters()])
      .then(([sources, chars]: [RosterSource[], CharacterInfo[]]) => {
        if (cancelled) return;
        const tally: Record<string, number> = {};
        for (const c of chars) {
          const id = c.source || DEFAULT_SOURCE;
          tally[id] = (tally[id] ?? 0) + 1;
        }
        setGroups(sources);
        setCounts(tally);
        if (initialSource && sources.some(s => s.id === initialSource)) {
          setSelected(initialSource);
        } else if (!initialSource) {
          const saved = loadSavedRosterSource();
          if (saved && sources.some(s => s.id === saved)) {
            setSelected(saved);
          } else {
            setSelected(sources.some(s => s.id === DEFAULT_SOURCE) ? DEFAULT_SOURCE : (sources[0]?.id ?? DEFAULT_SOURCE));
            if (saved) clearSavedRosterSource();
          }
        } else {
          // initialSource named a group the manifest no longer has —
          // fall back to the first one without persisting anything.
          setSelected(sources[0]?.id ?? DEFAULT_SOURCE);
        }
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
  }, [retryTick, initialSource]);

  // ---- Persist on every change (spectate never writes) ------------------
  useEffect(() => {
    if (spectate || loading || error) return;
    saveRosterSourceChoice(selected);
  }, [selected, spectate, loading, error]);

  // ---- Confirm / cancel --------------------------------------------------
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const confirm = useCallback(() => {
    if (spectate || loading || error || !groups.length) return;
    confirmRef.current(selected);
  }, [selected, spectate, loading, error, groups.length]);

  // ---- Cycling helper (wrap-around) --------------------------------------
  const cycle = useCallback((dir: 1 | -1) => {
    setSelected(prev => {
      if (!groups.length) return prev;
      const i = groups.findIndex(g => g.id === prev);
      const next = (i + dir + groups.length) % groups.length;
      return groups[next].id;
    });
  }, [groups]);

  // ---- Online cursor sync: publish the browsed universe ------------------
  // Fires on keyboard cycles AND taps (both go through `selected`). The
  // spectating guest's only live view of this screen — without it they
  // stare at a receding grid until the pick lands. Suppressed while
  // spectating (the guest never browses) and until the list is real.
  useEffect(() => {
    if (!onCursor || spectate || loading || error) return;
    const i = groups.findIndex(g => g.id === selected);
    if (i >= 0) onCursor(i);
  }, [selected, groups, spectate, loading, error, onCursor]);

  // ---- Keyboard (skipped on touch and while spectating) ------------------
  useEffect(() => {
    if (isTouch || spectate) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const code = e.code;
      if (code === 'ArrowUp' || code === 'ArrowLeft' || code === 'KeyW' || code === 'KeyA') {
        e.preventDefault();
        cycle(-1);
        return;
      }
      if (code === 'ArrowDown' || code === 'ArrowRight' || code === 'KeyS' || code === 'KeyD') {
        e.preventDefault();
        cycle(1);
        return;
      }
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
        e.preventDefault();
        confirm();
        return;
      }
      if (code === 'Escape' || code === 'Backspace') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTouch, spectate, cycle, confirm, onCancel]);

  const selectedGroup = groups.find(g => g.id === selected);
  const oppGroup = opponentIndex != null ? groups[opponentIndex] : undefined;
  const subLine = spectate
    ? (spectateNote || 'YOUR OPPONENT IS CHOOSING THE UNIVERSE…') +
      (oppGroup ? ` — ${oppGroup.label.toUpperCase()}` : '')
    : loading
    ? 'LOADING UNIVERSES…'
    : error
    ? 'COULD NOT LOAD THE GROUP LIST'
    : (selectedGroup ? selectedGroup.label.toUpperCase() : '') +
      ` · ${counts[selected] ?? 0} FIGHTERS`;

  // ---- Render --------------------------------------------------------------
  return (
    <main className="gs bg-grid" tabIndex={0} aria-label="Group select">
      {/* Print dressing: diagonal ink wedges + drifting halftone + reg marks */}
      <div className="gs__bg-wedges" aria-hidden="true" />
      <div className="gs__bg-dots" aria-hidden="true" />
      <span className="cs__reg cs__reg--tl" aria-hidden="true" />
      <span className="cs__reg cs__reg--tr" aria-hidden="true" />

      {/* Masthead — comic cover */}
      <header className="gs__title">
        <div className="gs__kicker">
          <span className="gs__kicker-rule" aria-hidden="true" />
          <span>ISSUE No. 02 — THE UNIVERSES</span>
          <span className="gs__kicker-rule" aria-hidden="true" />
        </div>
        <h1 className="gs__title-main">SELECT YOUR UNIVERSE</h1>
        <div className="gs__title-sub" aria-live="polite">
          {subLine}
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

      {/* Group cards — one per chars* folder in the Assets repo, selected
          card in crimson ink; greyed out while spectating */}
      <div
        className={`gs__grid${spectate ? ' gs__grid--spectate' : ''}`}
        role="radiogroup"
        aria-label="Character group"
        aria-disabled={spectate || undefined}
      >
        {loading && groups.length === 0 && (
          <div className="gs__placeholder">LOADING…</div>
        )}
        {!loading && !error && groups.map((g, i) => (
          <button
            key={g.id}
            type="button"
            role="radio"
            aria-checked={selected === g.id}
            className={`gs__card${selected === g.id ? ' gs__card--active' : ''}${
              spectate && opponentIndex === i ? ' gs__card--opp' : ''
            }`}
            onClick={() => { if (!spectate) setSelected(g.id); }}
            title={`Characters from the ${g.id}/ folder`}
          >
            {spectate && opponentIndex === i && (
              <span className="gs__card-opp" aria-hidden="true">P1</span>
            )}
            <span className="gs__card-top">
              <span className="gs__card-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
              <span className="gs__card-tag">{counts[g.id] ?? 0} FIGHTERS</span>
            </span>
            <span className="gs__card-label">{g.label}</span>
            <span className="gs__card-desc">{GROUP_DESCRIPTIONS[g.id] ?? GENERIC_GROUP_DESCRIPTION}</span>
          </button>
        ))}
      </div>

      {/* Footer — back + continue */}
      <div className="gs__footer">
        <button type="button" className="cs__btn-back" onClick={onCancel} disabled={spectate}>
          ← BACK
        </button>
        <button
          type="button"
          className="cs__btn-fight"
          onClick={confirm}
          disabled={spectate || loading || !!error || !groups.length}
        >
          {spectate ? 'WAITING…' : 'CONTINUE ▶'}
        </button>
      </div>

      {/* Controls hint — keyboard wording on desktop, tap wording on touch */}
      {!spectate && (
        <div className="gs__hint">
          {isTouch ? (
            <div>
              <span>TAP</span> a universe · <span>CONTINUE</span> to the fighters
            </div>
          ) : (
            <>
              <div>
                <span>↑↓ / W S</span> universe · <span>ENTER</span> confirm
              </div>
              <div><span>ESC</span> back</div>
            </>
          )}
        </div>
      )}
    </main>
  );
}
