'use client';

import { useCallback } from 'react';
import ModeSelect from '@/components/ModeSelect';
import { useWipeNavigation } from '@/components/WipeTransition';
import { prewarmEngineAssets } from '@/lib/engine-prewarm';
import type { Difficulty, GameMode } from '@/lib/mode-catalog';

// Pull engine.wasm.gz + game.pak.gz into the HTTP cache while the player
// reads the mode cards — the mode screen is now the FIRST stop of the local
// flow (lobby → mode select → roster), so the warmup starts here. /local
// calls it too; the helper is idempotent (module flag + sessionStorage
// marker), so the second call is a no-op.
if (typeof window !== 'undefined') {
  prewarmEngineAssets();
}

/**
 * /mode-select — "SELECT YOUR MODE" screen (ISSUE No. 01 — THE MODES).
 *
 * First stop of the separated local flow:
 *   /lobby → /mode-select (here) → /group-select?mode=&diff=
 *   → /local?mode=&diff= → stage select → fight
 *
 * The chosen mode + difficulty travel onward as query params (the same
 * URL-param pattern /match-prep and /play use) AND persist to localStorage
 * (inside ModeSelect) so deep links straight to /local keep working.
 */
export default function ModeSelectPage() {
  const { navigate } = useWipeNavigation();

  const handleConfirm = useCallback(
    (mode: GameMode, difficulty: Difficulty) => {
      const params = new URLSearchParams();
      params.set('mode', mode);
      params.set('diff', difficulty);
      navigate(`/group-select?${params.toString()}`);
    },
    [navigate]
  );

  const handleCancel = useCallback(() => {
    navigate('/lobby');
  }, [navigate]);

  return (
    <div>
      <ModeSelect onConfirm={handleConfirm} onCancel={handleCancel} />
      {/* Footer credit */}
      <div className="footer-credit">Made by Nawaf Al Hussain</div>
    </div>
  );
}
