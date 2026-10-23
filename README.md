# OpenFighter

**OpenFighter** (repos: `FightingGameEngine-Demo` / `FightingGameEngine-Web`) is a browser-based 2D fighting game platform using the **IKEMEN GO fighting-game engine** compiled to WebAssembly, with a Next.js frontend that renders every menu, and online play over WebRTC P2P.

This is the **successor** to [FightingGameEngine](https://github.com/Nawaf-AlHussain/FightingGameEngine), which used the Dolmexica Infinite C++ engine. Dolmexica's character-format compatibility proved too limited despite 63+ engine fixes — localcoord crashes, incomplete trigger/state-controller coverage, and SFF v2 edge cases made many characters unplayable. The Go engine provides far broader classic-format (1.0/1.1) compatibility out of the box.

## Architecture

```
┌────────────────────────────────────────────────────┐
│                  Vercel (Hosting)                   │
│                                                     │
│  ┌─────────────┐     ┌───────────────────────────┐ │
│  │  Next.js    │     │  Engine (WASM)            │ │
│  │  Frontend   │────▶│  22MB .wasm (5.1MB .gz)   │ │
│  │  (ALL UI)   │     │  WebGL2 · Web Audio       │ │
│  └─────────────┘     └────────────┬──────────────┘ │
│         │                          │                │
│         │                 ┌────────▼─────────┐      │
│         │                 │  Browser VFS     │      │
│         │                 │  (vfs.js + .pak) │      │
│         │                 └────────┬─────────┘      │
│  ┌──────▼──────┐                   │                │
│  │ /api/cdn +  │                   │                │
│  │ assets-     │                   │                │
│  │ manifest    │                   │                │
│  └──────┬──────┘                   │                │
└─────────┼──────────────────────────┼────────────────┘
          │                          │
 ┌────────▼─────────────┐   ┌────────▼──────────────┐
 │  Assets repo (GH)    │   │  netrelay (Cloudflare │
 │  Assets (production) │   │  Worker): WebRTC SDP  │
 │  DemoAssets (demo)   │   │  signaling + ranked   │
 │  via GitHub raw      │   │  queue. Game data is  │
 │                      │   │  P2P, never relayed.  │
 └──────────────────────┘   └───────────────────────┘
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Game Engine | IKEMEN GO → WASM | Classic 2D fighting format compatible (1.0/1.1) |
| Frontend | Next.js 16 + React 19 | Squadron Comic UI; the site renders ALL menus |
| Browser VFS | Custom vfs.js | HTTP-backed virtual filesystem, .pak bundle, localStorage saves |
| Graphics | WebGL2 | Hardware GPU required (software rendering detected + warned) |
| Audio | Web Audio API | Via the engine |
| Online Play | WebRTC P2P lockstep | Room codes + QR + ranked queue; STUN, optional TURN |
| Signaling | Cloudflare Worker | `netrelay/cloudflare/` — handshake only, never game data |
| Asset CDN | GitHub raw via /api/cdn proxy | Characters/stages from the Assets repos |
| Hosting | Vercel | HTTPS required for WASM + WebRTC |

## Repositories

| Repo | Purpose |
|------|---------|
| **FightingGameEngine-Demo** (this repo) | Active development — engine + frontend, deployed to Vercel |
| [FightingGameEngine-Web](https://github.com/Nawaf-AlHussain/FightingGameEngine-Web) | Byte-identical mirror of this repo (kept in lockstep) |
| [FightingGameEngine/Assets](https://github.com/FightingGameEngine/Assets) | Production roster: 87 characters + stages (default CDN source) |
| [FightingGameEngine/DemoAssets](https://github.com/FightingGameEngine/DemoAssets) | Curated demo roster mirror (`ASSETS_GH_REPO` switch; sync via `scripts/sync-demo-assets.py`) |
| [FightingGameEngine](https://github.com/Nawaf-AlHussain/FightingGameEngine) | Old engine (Dolmexica), archived reference |

## Project Goals

1. **Drop-in replacement** for FightingGameEngine with dramatically better character compatibility — ACHIEVED
2. **Smooth 60 FPS** gameplay in the browser on mid-range hardware — ACHIEVED (100% 60fps incl. heavy characters, F-038)
3. **All roster characters** working without crashes — in progress (compat testing needs hardware)
4. **Clean, distinctive web UI** — ACHIEVED (Squadron Comic skin, wipe transitions)
5. **Online multiplayer** via WebRTC P2P — ACHIEVED (rooms, ranked queue, rematch, spectate cursors)
6. **Mobile-friendly** with touch controls + portrait mode — ACHIEVED
7. **Fast initial load** — small base bundle, characters/stages streamed on demand — ACHIEVED (.pak + gz engine + IndexedDB)

## Screens & Flow

```
/lobby → /mode-select (ISSUE 01) → /group-select (ISSUE 02)
       → /local roster (ISSUE 03) → stage select (ISSUE 04)
       → /match-prep → /play → /results

/lobby → /play?net=1 (ISSUE 05 NETWORK): host / join / ranked queue,
         shared select screens with live spectate cursors, fight,
         rematch in place
```

7 modes: VS CPU · VS Player · Training · Arcade · Survival · Time Attack · Watch.

Display ladder: TALL 4:3 · FITTED · 3:2 WIDE · 14:9 · 5:3 · EXPANDED (classic 4:3), stage zoom on close action, portrait "Game Boy" mode. Installable PWA.

## Key Reference: Browser Modding Kit v1.7

The browser-side infrastructure (VFS, WASM loading, WebGL2 rendering, netcode base) comes from the **energyjp browser modding kit v1.7**, extended heavily since. Key engineering:

- **vfs.js**: Custom JS virtual filesystem replacing Go's fs_js.go. Manifest-based lazy HTTP loading, localStorage persistence for saves, display-ladder stage fits.
- **webrtc.js** (~1.5k lines): P2P lockstep netplay bridge — room codes, ranked queue bucketed by Build ID, build+roster fingerprint handshake (mismatched clients are REFUSED, not desynced), IKWS control frames, RTT probes, disconnect self-heal.
- **GC tuning**: `GOGC=off` + safety-net GC — measured to eliminate mid-round pauses (F-033).
- **Spatial grid broad-phase** in the engine (F-038): 164ms frame spikes eliminated.
- **WASM streaming** + gz boot decompression worker: fast, cache-first engine load.
- **IndexedDB asset cache**: characters/stages download once, instant on repeat (F-037).

## License

Engine: MIT License (code), CC-BY 3.0 (non-code assets).
Browser layer by energyjp: see kit license.
Character/stage assets: belong to their respective creators — only distribute content you have the right to.
