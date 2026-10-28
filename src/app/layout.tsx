import type { Metadata, Viewport } from 'next';
import { Anton, Oswald } from 'next/font/google';
import './globals.css';
import '@/styles/game.css';
import { WipeTransitionProvider } from '@/components/WipeTransition';
import SWRegister from '@/components/SWRegister';

/**
 * Captured before React hydrates: `beforeinstallprompt` fires at most once per
 * page and can beat hydration, in which case a React-only listener would miss
 * it and Chrome would show its own mini-infobar instead. Stash the event
 * globally (the lobby reads it to offer an in-app INSTALL APP item) and
 * re-announce it via a plain custom event.
 */
const captureInstallPrompt =
  "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__fgeInstallEvent=e;window.dispatchEvent(new CustomEvent('fge:install-available'));});";

// Self-hosted at build time via next/font (Batch 4): the render-blocking
// fonts.googleapis.com stylesheet is gone — no external CSS request in the
// critical path (it used to delay first paint of EVERY route, worst on
// phones with a cold connection), no third-party connection, and the font
// is preloaded + size-adjusted by the framework automatically. The family
// is exposed as --font-oswald for game.css (--font-display).
const oswald = Oswald({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  display: 'swap',
  variable: '--font-oswald',
});

// COMIC OVERHAUL: Anton is the giant condensed poster headline face — the
// "ROCKET SQUADRON"-style title voice. Single 400 weight (it IS the weight),
// used only for display headlines via --font-anton; all UI labels stay on
// Oswald so body hierarchy and letter-spaced small-caps are untouched.
const anton = Anton({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-anton',
});

export const metadata: Metadata = {
  title: 'OpenFighter',
  description: 'A comic-book fighting game platform — community rosters in your browser. Zero install, 60 FPS, WASM.',
};

// Viewport: prevent pinch-zoom (annoying during gameplay), support
// notches/safe areas on modern phones, and lock to device width.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* PHONE LANDSCAPE zoom-out — must run pre-paint (no layout flash).
            Screens report device dimensions that follow orientation but are
            immune to CSS zoom, so the toggle is stable (no oscillation loop).
            Landscape phones (short edge <= 520 CSS px) get html.zoom 0.7 —
            the desktop layout scaled to fit; see game.css PHONE LANDSCAPE
            block for the vh/dvh/innerWidth compensation notes. Tablets and
            desktops never zoom. 'zoom-override' ('on'/'off') in localStorage
            is the manual escape hatch, mirroring input-mode-override. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function () {
  var KEY = 'zoom-override';
  function phoneLandscape() {
    try {
      var o = localStorage.getItem(KEY);
      if (o === 'on') return true;
      if (o === 'off') return false;
    } catch (e) {}
    var w = screen.width, h = screen.height;
    return w > h && Math.min(w, h) > 0 && Math.min(w, h) <= 520;
  }
  function apply() {
    document.documentElement.classList.toggle('phone-landscape', phoneLandscape());
  }
  apply();
  window.addEventListener('orientationchange', apply);
  window.addEventListener('resize', apply);
})();`,
          }}
        />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />
        <meta name="apple-mobile-web-app-title" content="OpenFighter" />
        <script dangerouslySetInnerHTML={{ __html: captureInstallPrompt }} />
        <script src="/game/fullscreen.js" defer />
      </head>
      <body className={`${oswald.variable} ${anton.variable} bg-black text-white antialiased`}>
        <WipeTransitionProvider>{children}</WipeTransitionProvider>
        <SWRegister />
      </body>
    </html>
  );
}
