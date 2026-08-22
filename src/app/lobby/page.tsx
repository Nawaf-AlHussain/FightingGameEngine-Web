'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function LobbyPage() {
  const router = useRouter();
  const [glow, setGlow] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setGlow(g => !g), 2000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = () => {
    router.push('/local');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <main
      className="min-h-screen bg-black flex flex-col items-center justify-center relative overflow-hidden"
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Animated background grid */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
        aria-hidden="true"
      />

      {/* Glow effect */}
      <div
        className="absolute w-[600px] h-[600px] rounded-full blur-[150px] transition-opacity duration-1000"
        style={{
          background: glow ? 'radial-gradient(circle, rgba(239,68,68,0.15), transparent 70%)' : 'radial-gradient(circle, rgba(239,68,68,0.08), transparent 70%)',
          opacity: glow ? 1 : 0.5,
        }}
        aria-hidden="true"
      />

      {/* Main card */}
      <div className="relative z-10 flex flex-col items-center gap-8 px-4">
        {/* Title */}
        <div className="text-center select-none">
          <div className="text-5xl md:text-7xl font-black tracking-tighter text-white leading-none">
            <span>FIGHTING</span>
          </div>
          <div className="text-5xl md:text-7xl font-black tracking-tighter text-red-500 leading-none mt-1">
            <span>GAME</span>
          </div>
          <div className="text-5xl md:text-7xl font-black tracking-tighter text-white leading-none mt-1">
            <span>ENGINE</span>
          </div>
        </div>

        {/* Subtitle */}
        <div className="text-gray-400 text-sm tracking-[0.3em] font-mono select-none">
          <span className="text-gray-600">[</span>
          {'BROWSER · WASM · 60FPS'}
          <span className="text-gray-600">]</span>
        </div>

        {/* Start button */}
        <div className="mt-4">
          <button
            onClick={handleStart}
            className="group relative px-12 py-4 border-2 border-white/20 hover:border-red-500/60 text-white text-xl font-bold tracking-widest transition-all duration-300 hover:bg-red-500/10 hover:scale-105 active:scale-95 cursor-pointer"
          >
            <span className="relative z-10">PRESS START</span>
          </button>
          <p className="text-gray-500 text-xs text-center mt-3 tracking-wider select-none">
            VS AI · 1P KEYBOARD
          </p>
        </div>

        {/* Roster preview */}
        <div className="mt-8 text-center select-none">
          <div className="text-gray-600 text-xs tracking-[0.2em] mb-3">ROSTER</div>
          <div className="flex items-center gap-4">
            <span className="text-2xl font-black text-white/80">KFM</span>
            <span className="text-red-500 text-lg font-bold">VS</span>
            <span className="text-2xl font-black text-white/80">KFM</span>
          </div>
        </div>

        {/* Controls hint */}
        <div className="mt-8 text-center text-gray-600 text-xs font-mono select-none space-y-1">
          <p>P1: <span className="text-gray-400">WASD</span> move · <span className="text-gray-400">U I O</span> punches · <span className="text-gray-400">J K L</span> kicks · <span className="text-gray-400">1</span> start</p>
        </div>
      </div>

      {/* Footer */}
      <footer className="absolute bottom-4 text-gray-700 text-xs font-mono select-none">
        Made by Nawaf Al Hussain
      </footer>
    </main>
  );
}
