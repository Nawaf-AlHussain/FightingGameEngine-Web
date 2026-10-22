'use client';

import { useCallback } from 'react';
import GroupSelect from '@/components/GroupSelect';
import { useWipeNavigation } from '@/components/WipeTransition';
import { prewarmEngineAssets } from '@/lib/engine-prewarm';

// Pull engine.wasm.gz + game.pak.gz deeper into the HTTP cache while the
// player browses the universe cards — the middle stop of the local flow
// (lobby → mode select → group select → roster). /mode-select started the
// warmup; this call is a cheap idempotent no-op when that already ran.
if (typeof window !== 'undefined') {
  prewarmEngineAssets();
}

/**
 * /group-select — "SELECT YOUR UNIVERSE" screen (ISSUE No. 02 — THE
 * UNIVERSES).
 *
 * Middle stop of the separated local flow:
 *   /lobby → /mode-select → /group-select (here) → /local?mode=&diff=
 *   → stage select → fight
 *
 * The chosen group persists to localStorage (inside GroupSelect, the same
 * key the old roster chips used) — /local's character screen restores it,
 * so deep links straight to /local keep landing on the player's usual
 * universe. The mode + difficulty merely PASS THROUGH this page to /local
 * as the same ?mode=&diff= query params /mode-select handed over (read
 * straight off window.location at confirm time — SSR-prerender friendly,
 * no Suspense boundary needed).
 */
export default function GroupSelectPage() {
  const { navigate } = useWipeNavigation();

  const handleConfirm = useCallback(() => {
    // The group itself travels via localStorage (owned by GroupSelect);
    // mode/diff just ride along unchanged.
    const params = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).toString()
      : '';
    navigate(`/local?${params}`);
  }, [navigate]);

  const handleCancel = useCallback(() => {
    navigate('/mode-select');
  }, [navigate]);

  return (
    <div>
      <GroupSelect onConfirm={handleConfirm} onCancel={handleCancel} />
      {/* Footer credit */}
      <div className="footer-credit">Made by Nawaf Al Hussain</div>
    </div>
  );
}
