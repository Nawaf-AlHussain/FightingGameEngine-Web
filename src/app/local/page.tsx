'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback } from 'react';

// Available characters from the VFS
const CHARACTERS = [
  { id: 'kfm', name: 'KUNG FU MAN', shortName: 'KFM' },
] as const;

// Available stages from the VFS
const STAGES = [
  { id: 'stages/stage0-720.def', name: 'STAGE 0' },
] as const;

type GameMode = 'vs-ai' | 'vs-player' | 'training';

export default function LocalPlayPage() {
  const router = useRouter();

  const [mode, setMode] = useState<GameMode>('vs-ai');
  const [p1Char, setP1Char] = useState<string>(CHARACTERS[0].id);
  const [p2Char, setP2Char] = useState<string>(CHARACTERS[0].id);
  const [stage, setStage] = useState(STAGES[0].id);
  const [p1Ready, setP1Ready] = useState(false);
  const [p2Ready, setP2Ready] = useState(false);
  const [aiLevel, setAiLevel] = useState(5);
  const [aspect, setAspect] = useState<'16:9' | '4:3'>('16:9');

  const isP2Ai = mode === 'vs-ai' || mode === 'training';

  const handleP1Confirm = useCallback(() => {
    setP1Ready(r => !r);
  }, []);

  const handleP2Confirm = useCallback(() => {
    if (isP2Ai) return;
    setP2Ready(r => !r);
  }, [isP2Ai]);

  const handleStartFight = () => {
    const params = new URLSearchParams();
    params.set('p1', p1Char);
    params.set('p2', p2Char);
    params.set('stage', stage);
    params.set('aspect', aspect);
    if (isP2Ai) {
      params.set('p2ai', String(aiLevel));
    }
    if (mode === 'training') {
      params.set('training', '1');
    }
    router.push(`/play?${params.toString()}`);
  };

  const canStart = p1Ready && (isP2Ai || p2Ready);

  return (
    <main
      className="min-h-screen bg-black flex flex-col items-center justify-center relative overflow-hidden select-none"
      tabIndex={0}
    >
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight">SELECT YOUR FIGHTERS</h1>
          <div className="h-0.5 w-32 bg-red-500 mx-auto mt-3" />
        </div>

        {/* Mode Selection */}
        <div className="flex justify-center gap-2 mb-10">
          {([
            { id: 'vs-ai' as GameMode, label: 'VS CPU' },
            { id: 'vs-player' as GameMode, label: 'VS PLAYER' },
            { id: 'training' as GameMode, label: 'TRAINING' },
          ]).map(m => (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); setP2Ready(false); }}
              className={`px-5 py-2 text-sm font-bold tracking-wider border transition-all duration-200 cursor-pointer ${
                mode === m.id
                  ? 'border-red-500 bg-red-500/20 text-red-400'
                  : 'border-white/10 text-gray-500 hover:border-white/30 hover:text-gray-300'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Character Select Area */}
        <div className="flex items-stretch justify-center gap-6 md:gap-12 mb-10">
          {/* P1 Side */}
          <PlayerSlot
            label="P1"
            charId={p1Char}
            onCharChange={setP1Char}
            characters={CHARACTERS}
            ready={p1Ready}
            onToggleReady={handleP1Confirm}
            accentColor="text-blue-400"
            borderColor={p1Ready ? 'border-blue-500' : 'border-white/10'}
            bgGlow={p1Ready ? 'rgba(59,130,246,0.1)' : 'transparent'}
          />

          {/* VS Badge */}
          <div className="flex items-center">
            <span className="text-3xl md:text-4xl font-black text-red-500/60">VS</span>
          </div>

          {/* P2 Side */}
          <PlayerSlot
            label="P2"
            charId={p2Char}
            onCharChange={setP2Char}
            characters={CHARACTERS}
            ready={isP2Ai || p2Ready}
            onToggleReady={handleP2Confirm}
            accentColor={isP2Ai ? 'text-yellow-400' : 'text-green-400'}
            borderColor={isP2Ai ? 'border-yellow-500/30' : p2Ready ? 'border-green-500' : 'border-white/10'}
            bgGlow={isP2Ai ? 'rgba(234,179,8,0.05)' : p2Ready ? 'rgba(34,197,94,0.1)' : 'transparent'}
            subtitle={isP2Ai ? 'CPU' : undefined}
          />
        </div>

        {/* AI Level (only for vs-ai / training) */}
        {isP2Ai && (
          <div className="flex justify-center items-center gap-4 mb-10">
            <span className="text-gray-400 text-sm tracking-wider font-bold">CPU LEVEL</span>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5, 6, 7, 8].map(lvl => (
                <button
                  key={lvl}
                  onClick={() => setAiLevel(lvl)}
                  className={`w-8 h-8 text-xs font-bold border transition-all duration-150 cursor-pointer ${
                    aiLevel >= lvl
                      ? 'border-yellow-500 bg-yellow-500/20 text-yellow-400'
                      : 'border-white/10 text-gray-600 hover:border-white/20'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Stage Selection */}
        <div className="flex justify-center items-center gap-4 mb-8">
          <span className="text-gray-400 text-sm tracking-wider font-bold">STAGE</span>
          <div className="flex gap-2">
            {STAGES.map(s => (
              <button
                key={s.id}
                onClick={() => setStage(s.id)}
                className={`px-4 py-2 text-sm font-bold border transition-all duration-200 cursor-pointer ${
                  stage === s.id
                    ? 'border-white/40 bg-white/10 text-white'
                    : 'border-white/10 text-gray-500 hover:border-white/20 hover:text-gray-300'
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        {/* Aspect Ratio Toggle */}
        <div className="flex justify-center items-center gap-4 mb-12">
          <span className="text-gray-400 text-sm tracking-wider font-bold">ASPECT</span>
          <div className="flex gap-2">
            {(['16:9', '4:3'] as const).map(a => (
              <button
                key={a}
                onClick={() => setAspect(a)}
                className={`px-4 py-2 text-sm font-bold border transition-all duration-200 cursor-pointer ${
                  aspect === a
                    ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400'
                    : 'border-white/10 text-gray-500 hover:border-white/20 hover:text-gray-300'
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          <span className="text-gray-700 text-xs font-mono ml-2">
            {aspect === '4:3' ? '(faster)' : '(higher res)'}
          </span>
        </div>

        {/* FIGHT Button */}
        <div className="text-center">
          <button
            onClick={handleStartFight}
            disabled={!canStart}
            className={`relative px-16 py-4 text-2xl font-black tracking-widest border-2 transition-all duration-300 cursor-pointer ${
              canStart
                ? 'border-red-500 text-red-500 hover:bg-red-500 hover:text-white hover:scale-105 active:scale-95'
                : 'border-white/10 text-gray-600 cursor-not-allowed'
            }`}
          >
            FIGHT
          </button>
          {!canStart && (
            <p className="text-gray-600 text-xs mt-3 tracking-wider">
              {isP2Ai
                ? 'Lock in your character to continue'
                : 'Both players must lock in'}
            </p>
          )}
        </div>

        {/* Controls hint */}
        <div className="text-center text-gray-700 text-xs font-mono mt-10 space-y-1">
          <p>P1: <span className="text-gray-500">WASD</span> move · <span className="text-gray-500">U I O</span> punches · <span className="text-gray-500">J K L</span> kicks</p>
          {!isP2Ai && (
            <p>P2: <span className="text-gray-500">ARROWS</span> move · <span className="text-gray-500">8 9 0</span> punches · <span className="text-gray-500">M , .</span> kicks</p>
          )}
        </div>
      </div>

      {/* Back button */}
      <button
        onClick={() => router.push('/lobby')}
        className="absolute top-6 left-6 text-gray-600 hover:text-gray-300 text-sm font-mono tracking-wider transition-colors cursor-pointer z-20"
      >
        ← BACK
      </button>

      {/* Footer */}
      <footer className="absolute bottom-4 text-gray-700 text-xs font-mono">
        Made by Nawaf Al Hussain
      </footer>
    </main>
  );
}

// --- Player Slot Component ---
function PlayerSlot({
  label,
  charId,
  onCharChange,
  characters,
  ready,
  onToggleReady,
  accentColor,
  borderColor,
  bgGlow,
  subtitle,
}: {
  label: string;
  charId: string;
  onCharChange: (id: string) => void;
  characters: readonly { id: string; name: string; shortName: string }[];
  ready: boolean;
  onToggleReady: () => void;
  accentColor: string;
  borderColor: string;
  bgGlow: string;
  subtitle?: string;
}) {
  const char = characters.find(c => c.id === charId) || characters[0];

  return (
    <div className="flex flex-col items-center gap-3">
      <span className={`text-xs font-bold tracking-widest ${accentColor}`}>{label}</span>
      <div
        className={`w-40 h-52 md:w-48 md:h-60 border-2 ${borderColor} flex flex-col items-center justify-center gap-2 transition-all duration-300 relative`}
        style={{ background: bgGlow }}
      >
        {/* Character silhouette placeholder */}
        <div className={`text-4xl md:text-5xl font-black ${ready ? 'text-white' : 'text-gray-600'} transition-colors`}>
          {char.shortName}
        </div>
        <div className={`text-xs tracking-wider ${ready ? 'text-gray-300' : 'text-gray-700'} font-mono`}>
          {char.name}
        </div>
        {subtitle && (
          <div className="text-xs text-yellow-500/60 font-bold tracking-wider mt-1">{subtitle}</div>
        )}
        {ready && (
          <div className={`absolute top-2 right-2 text-xs font-bold ${accentColor}`}>
            LOCKED IN
          </div>
        )}
      </div>
      {/* Character switcher (arrows when multiple chars) */}
      {characters.length > 1 && (
        <div className="flex gap-2">
          <button
            onClick={() => {
              const idx = characters.findIndex(c => c.id === charId);
              const prev = (idx - 1 + characters.length) % characters.length;
              onCharChange(characters[prev].id);
            }}
            className="w-8 h-8 border border-white/10 text-gray-500 hover:text-white hover:border-white/30 flex items-center justify-center text-sm cursor-pointer transition-colors"
          >
            ◀
          </button>
          <button
            onClick={() => {
              const idx = characters.findIndex(c => c.id === charId);
              const next = (idx + 1) % characters.length;
              onCharChange(characters[next].id);
            }}
            className="w-8 h-8 border border-white/10 text-gray-500 hover:text-white hover:border-white/30 flex items-center justify-center text-sm cursor-pointer transition-colors"
          >
            ▶
          </button>
        </div>
      )}
      {/* Confirm button */}
      <button
        onClick={onToggleReady}
        className={`px-6 py-2 text-xs font-bold tracking-widest border transition-all duration-200 cursor-pointer ${
          ready
            ? 'border-white/20 text-gray-400 hover:border-red-500/40 hover:text-red-400'
            : `border-blue-500/40 text-blue-400 hover:opacity-80`
        }`}
      >
        {ready ? 'UNLOCK' : 'CONFIRM'}
      </button>
    </div>
  );
}
