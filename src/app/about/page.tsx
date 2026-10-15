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
        <div className="about__subtitle">WEB · WASM · 60 FPS</div>

        <div className="about__section">
          <div className="about__section-title">WHAT IS THIS?</div>
          <div className="about__section-body">
            A browser-based fighting game platform running a custom
            open-source engine compiled to WebAssembly. Play with 85+
            characters from the community roster, directly in your browser,
            at 60 FPS.
          </div>
        </div>

        <div className="about__section">
          <div className="about__section-title">POWERED BY</div>
          <div className="about__section-body">
            <div>• Custom WASM engine — Go-based fighting-game engine</div>
            <div>• WebAssembly — compiled via GOOS=js GOARCH=wasm</div>
            <div>• Next.js 16 — React frontend</div>
            <div>• IndexedDB — character/stage caching</div>
          </div>
        </div>

        <div className="about__section">
          <div className="about__section-title">CREDITS</div>
          <div className="about__section-body">
            <div>Engine: open-source Go fighting-game engine (WebAssembly port)</div>
            <div>Browser layer: custom VFS + WebRTC netplay</div>
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
