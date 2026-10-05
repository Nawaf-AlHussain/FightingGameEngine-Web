'use client';

import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';

/**
 * About page — project information.
 *
 * Shows what the project is, what it runs on, and credits.
 * Not a fake page — all info here is factual.
 */
export default function AboutPage() {
  const { navigate } = useWipeNavigation();

  return (
    <main className="about bg-grid">
      <div className="about__content">
        <h1 className="about__title">FIGHTING GAME ENGINE</h1>
        <div className="about__subtitle">WEB · WASM · IKEMEN GO</div>

        <div className="about__section">
          <div className="about__section-title">WHAT IS THIS?</div>
          <div className="about__section-body">
            A browser-based MUGEN-compatible fighting game platform running
            IKEMEN GO compiled to WebAssembly. Play with 85+ characters from
            the community roster, directly in your browser, at 60 FPS.
          </div>
        </div>

        <div className="about__section">
          <div className="about__section-title">POWERED BY</div>
          <div className="about__section-body">
            <div>• IKEMEN GO v2 — Go-based MUGEN engine</div>
            <div>• WebAssembly — compiled via GOOS=js GOARCH=wasm</div>
            <div>• Next.js 16 — React frontend</div>
            <div>• IndexedDB — character/stage caching</div>
          </div>
        </div>

        <div className="about__section">
          <div className="about__section-title">CREDITS</div>
          <div className="about__section-body">
            <div>Engine: IKEMEN GO by Suehiro / ikemen-engine</div>
            <div>WASM port: energyjp/ikemen-go-web fork</div>
            <div>Characters: Community roster (FightingGameEngine/Assets)</div>
            <div>Built by: Nawaf Al Hussain</div>
          </div>
        </div>

        <div className="about__buttons">
          <GameButton variant="secondary" onClick={() => navigate('/lobby')}>
            ← BACK
          </GameButton>
        </div>
      </div>
    </main>
  );
}
