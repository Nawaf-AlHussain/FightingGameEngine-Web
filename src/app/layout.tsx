import type { Metadata, Viewport } from 'next';
import { Oswald } from 'next/font/google';
import './globals.css';
import '@/styles/game.css';
import { WipeTransitionProvider } from '@/components/WipeTransition';

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

export const metadata: Metadata = {
  title: 'Fighting Game Engine — Web',
  description: 'Browser-based fighting game platform running a custom WebAssembly engine',
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
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />
        <meta name="apple-mobile-web-app-title" content="Fighting Game Engine" />
        <script src="/game/fullscreen.js" defer />
      </head>
      <body className={`${oswald.variable} bg-black text-white antialiased`}>
        <WipeTransitionProvider>{children}</WipeTransitionProvider>
      </body>
    </html>
  );
}
