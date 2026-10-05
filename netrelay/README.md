# netrelay — WebRTC signaling relay for netplay

A single-file Deno server that lets two players connect **directly** to each
other (P2P WebRTC data channels) for online matches, using a short room code
instead of copying giant base64 blobs between browsers.

The relay is ONLY involved during the handshake: it swaps the two SDP offer/
answer blobs, then steps out of the way. All game traffic (lockstep input
stream, handshake ping, build-hash check) flows peer-to-peer over
`RTCDataChannel`s created by `public/game/webrtc.js`. Game data never touches
this server.

## Protocol (implemented exactly as `public/game/webrtc.js` expects)

| Event | Message |
|---|---|
| Host opens WS with `?create=1&pass=SECRET` | server → host: `{t:'room', code}` |
| Guest opens WS with `?join=CODE&pass=SECRET` | server → guest: `{t:'joined'}`, server → host: `{t:'peer'}` |
| Host sends `{t:'sdp', sdp:{type,sdp}}` | relayed verbatim to guest |
| Guest sends `{t:'sdp', sdp:{type,sdp}}` | relayed verbatim to host |
| Either side disconnects | server → other side: `{t:'bye'}` |
| Failures | `{t:'deny', reason:'badcode'\|'badpass'\|'full'\|'busy'}` |

Rooms are in-memory, max 500, and expire 30 minutes after creation.

## Run locally (dev)

```bash
deno run --allow-net --allow-env netrelay/relay.ts          # listens on :8940
PORT=9000 deno run --allow-net --allow-env netrelay/relay.ts
```

Port 8940 is what `webrtc.js` already expects on localhost, so with the relay
running, `HOST GAME` / `JOIN GAME` in the engine's NETWORK menu get room codes
automatically during local development — no config needed.

## Deploy to production (Deno Deploy, free tier)

The site itself is static on Vercel and cannot host WebSockets, so the relay
lives separately. Deno Deploy is a good free home (the same platform the
engine repo's Dolmexica relay already uses).

1. Push this repo (or just paste `relay.ts` into a new Deno Deploy editor
   playground).
2. On <https://dash.deno.com> → **New Playground** (or GitHub deploy) → paste
   `relay.ts` → deploy. Note the URL, e.g. `https://fge-netplay.deno.dev`.
3. Put the URL (with `/ws` path if you kept the default entrypoint route) into
   `public/game/netrelay-url.txt`:

   ```
   wss://fge-netplay.deno.dev/ws
   ```

4. Commit + push that one-line change. Clients pick it up on next load
   (the file is fetched with `no-store`, so it propagates immediately).

Until step 3 is done, everything still works: clients fall back to the
**manual copy-paste flow** (host generates an offer code, friend pastes it and
returns an answer code), which needs no server at all.

## How players use it

1. Site → **Play Online** (`/play?net=1`) → the engine boots to its own menu.
2. **NETWORK → HOST GAME** → a room code appears; send it to your friend
   (plus the password, if one was set).
3. Friend: **NETWORK → JOIN GAME** → enter the code → connection negotiates.
4. Both sides: pick **VERSUS 2P**, choose characters, fight. Lockstep
   (input-delay) netcode over an ordered/reliable channel; rollback (GGPO)
   stays off until the engine's arena memory issue is revisited (see
   `FINDINGS.md` F-019).

## Scaling notes

- Two players = two WebSocket connections that close after the handshake
  (~10 s of signaling traffic each). The free tier handles this trivially.
- Deno Deploy routes WebSocket connections to one isolate for their lifetime,
  so both peers must connect to the same deployment URL — which they do,
  because both load the same `netrelay-url.txt`.
- If matchmaking ("ranked queue") is ever wanted, this file is the place to
  extend: `webrtc.js` already speaks a queue protocol (`?queue=1&build=...`),
  but it additionally needs an identity/leaderboard service, which is why
  this relay deliberately ships without it.
