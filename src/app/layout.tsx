import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fighting Game Engine — Web',
  description: 'Browser-based MUGEN fighting game powered by IKEMEN GO v2 WASM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}
