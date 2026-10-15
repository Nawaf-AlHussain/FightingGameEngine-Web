'use client';

import { useWipeNavigation } from '@/components/WipeTransition';
import { GameButton } from '@/components/ui';

/**
 * About page — project information, staged as an issue of the arcade serial.
 *
 * Same print language as the lobby poster: masthead kicker row, giant Anton
 * headline with crimson misregistration, a striped contrail divider, and
 * sections presented as numbered print bars (01/02/03) with the red caret.
 * All info is factual — engine, stack, credits.
 */
export default function AboutPage() {
  const { navigate } = useWipeNavigation();

  return (
    <main className="about bg-grid">
      <span className="about__reg about__reg--tl" aria-hidden="true" />
      <span className="about__reg about__reg--tr" aria-hidden="true" />

      <div className="about__content">
        <header className="about__masthead" aria-hidden="true">
          <span>Fighting Game Engine · An Arcade Serial</span>
          <span>Issue <em>01</em> — The Story</span>
        </header>

        <h1 className="about__title">FIGHTING<br />GAME ENGINE</h1>

        <div className="about__ribbon" aria-hidden="true">
          <span className="about__ribbon-stripe" />
        </div>
        <div className="about__subtitle">WEB · WASM · 60 FPS</div>

        <div className="about__section">
          <div className="about__section-title">
            <span className="about__section-caret" aria-hidden="true" />
            <span className="about__section-num">01</span> What is this?
          </div>
          <div className="about__section-body">
            A browser-based fighting game platform running a custom
            open-source engine compiled to WebAssembly. Play with 85+
            characters from the community roster, directly in your browser,
            at 60 FPS.
          </div>
        </div>

        <div className="about__section">
          <div className="about__section-title">
            <span className="about__section-caret" aria-hidden="true" />
            <span className="about__section-num">02</span> Powered by
          </div>
          <div className="about__section-body">
            <div>• Custom WASM engine — Go-based fighting-game engine</div>
            <div>• WebAssembly — compiled via GOOS=js GOARCH=wasm</div>
            <div>• Next.js 16 — React frontend</div>
            <div>• IndexedDB — character/stage caching</div>
          </div>
        </div>

        <div className="about__section">
          <div className="about__section-title">
            <span className="about__section-caret" aria-hidden="true" />
            <span className="about__section-num">03</span> Credits
          </div>
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
