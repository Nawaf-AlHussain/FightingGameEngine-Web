# Fighting Game Engine — Web

Browser-based 2D fighting game platform using **IKEMEN GO v2** compiled to WebAssembly, with a Next.js frontend.

This is the **successor** to [FightingGameEngine](https://github.com/Nawaf-AlHussain/FightingGameEngine), which used the Dolmexica Infinite C++ engine. Dolmexica's MUGEN compatibility proved too limited despite 63+ engine fixes — localcoord crashes, incomplete trigger/state-controller coverage, and SFF v2 edge cases made many characters unplayable. IKEMEN GO provides far broader MUGEN 1.0/1.1 compatibility out of the box.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   Vercel (Hosting)                │
│                                                   │
│  ┌─────────────┐     ┌─────────────────────────┐ │
│  │  Next.js    │     │  IKEMEN GO v2 (WASM)   │ │
│  │  Frontend   │────▶│  24MB .wasm + WebGL2   │ │
│  │  (UI/UX)    │     │  VFS → HTTP lazy-load  │ │
│  └─────────────┘     └─────────────────────────┘ │
│         │                       │                  │
│         │              ┌────────▼────────┐        │
│         │              │  Browser VFS    │        │
│         │              │  (vfs.js)       │        │
│         │              └────────┬────────┘        │
└─────────┼───────────────────────┼─────────────────┘
          │                       │
          │              ┌────────▼────────┐
          └─────────────▶│  Assets Repo    │
                         │  (jsDelivr CDN)  │
                         │  85+ characters  │
                         │  5+ stages       │
                         └─────────────────┘
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Game Engine | IKEMEN GO v2 → WASM (Go) | MUGEN 1.0/1.1 compatible |
| Frontend | Next.js 14 + React 18 | Persona 5-inspired UI from Demo repo |
| Browser VFS | Custom vfs.js | HTTP-backed virtual filesystem, lazy file loading |
| Graphics | WebGL2 | Hardware GPU required |
| Audio | Web Audio API | Via IKEMEN GO engine |
| Online Play | WebRTC P2P | Rollback netcode, STUN/TURN |
| Asset CDN | jsDelivr + GitHub raw | Characters/stages from separate Assets repo |
| Hosting | Vercel | HTTPS required for WASM + WebRTC |

## Why IKEMEN GO over Dolmexica Infinite

| Area | Dolmexica Infinite (old) | IKEMEN GO v2 (new) |
|------|-------------------------|----------------------|
| MUGEN compat | Partial, many crashes | Near-complete 1.0/1.1 support |
| localcoord | Crashes on most characters | Fully supported |
| Triggers | ~165 (manually added) | 200+ (built-in) |
| State controllers | ~100 (manually added) | All MUGEN 1.1 + Ikemen extensions |
| SFF format | v1 + partial v2 | v1.01 + v2.00 + v2.01 |
| Audio | Broken in WASM | Working (Web Audio API) |
| Fonts | Crashed, disabled | Working (TrueType + bitmap) |
| Netcode | Custom lockstep (incomplete) | Rollback netcode built-in |
| WASM size | ~20MB | ~24MB |
| 60 FPS | Yes (C++/Emscripten) | Yes (Go WASM, GC-tuned) |

## Repositories

| Repo | Purpose |
|------|---------|
| **FightingGameEngine-Web** (this repo) | Engine + frontend, deployed to Vercel |
| [FightingGameEngine/Assets](https://github.com/FightingGameEngine/Assets) | Characters (85+) & stages (5+) via jsDelivr CDN |
| [FightingGameEngine](https://github.com/Nawaf-AlHussain/FightingGameEngine) | Old engine (Dolmexica), archived reference |
| [FightingGameEngine-Demo](https://github.com/Nawaf-AlHussain/FightingGameEngine-Demo) | Old demo with better UI (design reference) |

## Project Goals

1. **Drop-in replacement** for FightingGameEngine with dramatically better character compatibility
2. **Smooth 60 FPS** gameplay in the browser on mid-range hardware
3. **All 85+ characters** from the existing Assets repo working without crashes
4. **Clean, modern web UI** (Persona 5-inspired design from Demo repo)
5. **Online multiplayer** via WebRTC P2P with rollback netcode
6. **Mobile-friendly** with touch controls
7. **Fast initial load** — small base bundle, characters/stages streamed on demand

## Key Reference: WebMUGEN Modding Kit v1.7

The browser-side infrastructure (VFS, WASM loading, WebGL2 rendering, netcode) comes from the **energyjp WebMUGEN modding kit v1.7**. This is a heavily optimized production-quality browser port of IKEMEN GO, NOT a naive WASM dump. Key engineering:

- **vfs.js** (800+ lines): Custom JS virtual filesystem replacing Go's fs_js.go. Manifest-based lazy HTTP loading, localStorage persistence for saves.
- **GC tuning**: `GOGC=100`, `GOMEMLIMIT=800MiB` — measured to maintain 60fps (higher values cause noticeable freezes).
- **WebGL2 hardware check**: Detects software rendering at boot, warns user.
- **WASM streaming**: `instantiateStreaming` for faster load, content-addressed cache busting.
- **WebRTC netcode**: P2P with STUN servers, optional TURN relay.

## License

IKEMEN GO engine: MIT License (code), CC-BY 3.0 (non-code assets).  
WebMUGEN browser layer by energyjp: see kit license.  
Character/stage assets: belong to their respective creators — only distribute content you have the right to.
