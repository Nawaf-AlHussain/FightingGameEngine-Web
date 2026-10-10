# netrelay on Cloudflare Workers (free tier) — the production lobby

The live signaling lobby. The Deno Deploy free tier suspends apps that
exceed their wall-clock allowance (WebSockets burn it continuously), which
is what took the previous lobby down with `503 USAGE_EXCEEDED`. Cloudflare
Workers + Durable Objects has no wall-clock billing for idle sockets
(hibernation), so the same relay runs free without that failure mode.

- Live URL: `wss://fge-netplay.nawaf-alhussain.workers.dev/ws`
- Wired into the game via `public/game/netrelay-url.txt` (fetched `no-store`
  at page load — repointing that file updates every client with no WASM
  rebuild).
- Protocol: identical to `netrelay/relay.ts` (rooms) plus the ranked queue
  (`?queue=1`) that `webrtc.js` already speaks.

## Redeploy / update

```bash
cd netrelay/cloudflare
npm install
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
```

The account needs one-time setup (already done): a workers.dev subdomain
(`nawaf-alhussain.workers.dev`).

## Logs / debugging

```bash
CLOUDFLARE_API_TOKEN=<token> npx wrangler tail
```

## Notes

- `RoomDO` uses the WebSocket **hibernation API**: idle rooms cost no
  duration, and the room survives isolate eviction. Free-tier Durable
  Objects are SQLite-backed (`new_sqlite_classes` in `wrangler.toml`).
- `QueueDO` buckets matchmaking by Build ID + netcode, so only byte-identical
  clients get paired. Queues live seconds; plain (non-hibernated) sockets.
- Identity verification for ranked is optional: set `IDENTITY_VERIFY_URL`
  in `wrangler.toml` `[vars]` to a POST endpoint accepting `{name, code}`
  and returning `{ok:true}`. Unset, any display name can queue (results
  reporting stays inert without an identity service anyway).
- Room codes: 6 chars, no 0/1/o/i/l; rooms expire after 30 minutes (DO
  alarm); SDP messages capped at 64 KB.
- Health check: `GET https://fge-netplay.nawaf-alhussain.workers.dev/ws`
  (plain GET, no upgrade) replies `fge netplay relay (cloudflare) — ok`.
- End-to-end protocol test: `/home/z/my-project/scripts/test-fge-lobby.mjs`
  (Node ≥ 22, native WebSocket) — run it after any worker change.
