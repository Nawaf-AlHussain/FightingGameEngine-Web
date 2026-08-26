import type { Metadata, Viewport } from 'next';
import './globals.css';
import '@/styles/game.css';
import { WipeTransitionProvider } from '@/components/WipeTransition';

export const metadata: Metadata = {
  title: 'Fighting Game Engine — Web',
  description: 'Browser-based MUGEN fighting game powered by IKEMEN GO v2 WASM',
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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-black text-white antialiased">
        <WipeTransitionProvider>{children}</WipeTransitionProvider>
      </body>
    </html>
  );
}
