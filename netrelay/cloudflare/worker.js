// =============================================================================
// FightingGameEngine-Web — Netplay signaling relay (Cloudflare Workers)
// =============================================================================
// Cloudflare Workers + Durable Objects port of netrelay/relay.ts (Deno), so the
// lobby can live on a FREE tier that does not burn wall-clock per open socket
// (that is what suspended the Deno Deploy app with 503 USAGE_EXCEEDED).
//
// Wire protocol — implemented EXACTLY as public/game/webrtc.js speaks it:
//
//   WS connect ?create=1&pass=SECRET   -> {t:'room', code}
//   WS connect ?join=CODE&pass=SECRET  -> {t:'joined'} to joiner
//                                         {t:'peer'}  to host
//                                         {t:'sdp', sdp} relayed verbatim
//                                         {t:'bye'} when the peer disconnects
//   WS connect ?queue=1&build=HEX&nc=N&name=NAME&code=SECRET
//                                      -> {t:'qcount', n} while waiting
//                                      -> {t:'match', role, at, opponent}
//                                         then {t:'sdp'} relayed like rooms
//   {t:'deny', reason:'badcode'|'badpass'|'full'|'busy'|'badident'|'unsupported'}
//
// The relay only swaps SDP blobs during the handshake — it never sees game
// data, and it is never involved after the data channels open.
//
// Architecture on Workers:
//   - RoomDO  (one Durable Object per room code) holds the host+guest
//     WebSockets with the HIBERNATION API — idle rooms cost ~nothing on the
//     free plan, and the room survives isolate eviction.
//   - QueueDO (one per build+netcode bucket) pairs ranked players from an
//     in-memory waiting list; queues live seconds and use plain (non-
//     hibernated) sockets so pairing state stays simple.
//
// Deploy: see netrelay/cloudflare/README.md (one wrangler command), then put
// wss://<name>.<subdomain>.workers.dev/ws into public/game/netrelay-url.txt.
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Tunables (mirrors netrelay/relay.ts)
// ---------------------------------------------------------------------------

// Room codes: lowercase, no 0/1/o/i/l to survive being read out loud.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 6;

const ROOM_TTL_MS = 30 * 60 * 1000; // matches the hint in webrtc.js's UI copy
const MAX_MESSAGE_BYTES = 64 * 1024; // SDP blobs are a few KB; cap abuse hard
const MAX_QUEUE_PER_BUCKET = 100; // absurd queue length guard -> deny 'busy'
const MAX_NAME_LEN = 32; // queue display name cap

function newCode() {
  for (;;) {
    let code = '';
    const rnd = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[rnd[i] % CODE_ALPHABET.length];
    }
    return code; // collisions land on the same DO and get denied; 1-in-a-billion
  }
}

function sanitizeName(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (s.length ? s : 'player').slice(0, MAX_NAME_LEN);
}

// JSON sender that never throws on a dying socket.
function sendTo(ws, msg) {
  if (!ws) return;
  try { ws.send(JSON.stringify(msg)); } catch (e) { /* close handler cleans up */ }
}

// Upgrade-then-deny: the browser WebSocket only surfaces messages after the
// 101 handshake, so a deny must complete the upgrade, deliver the JSON, THEN
// close (webrtc.js keys its "server unreachable" fallback off a close WITHOUT
// a deny — order matters).
function denyResponse(reason) {
  const pair = new WebSocketPair();
  pair[1].accept();
  sendTo(pair[1], { t: 'deny', reason });
  try { pair[1].close(1008, reason); } catch (e) { /* already gone */ }
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function closeAll(state, tags, closeInfo) {
  for (const tag of tags) {
    for (const ws of state.getWebSockets(tag)) {
      try { sendTo(ws, { t: 'bye' }); } catch (e) { /* ignore */ }
      try { ws.close(1000, closeInfo); } catch (e) { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// RoomDO — one instance per room code (idFromName('room:<code>'))
// ---------------------------------------------------------------------------

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pass = '';
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('room ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    const create = url.searchParams.get('create') === '1';
    const pass = url.searchParams.get('pass') ?? '';

    if (create) {
      // A room already live under this code means the two-in-a-billion code
      // collision (or an extremely stale host socket the runtime has not yet
      // noticed). Replace the old host — self-healing beats a dead code.
      for (const old of this.state.getWebSockets('host')) {
        try { old.close(4000, 'replaced'); } catch (e) { /* fine */ }
      }
      for (const old of this.state.getWebSockets('guest')) {
        try { old.close(4000, 'replaced'); } catch (e) { /* fine */ }
      }
      const code = url.searchParams.get('code') || newCode();
      this.pass = pass;
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], ['host']);
      this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      sendTo(pair[1], { t: 'room', code });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Join path (the worker already lowercased/validated the code).
    const hosts = this.state.getWebSockets('host');
    if (!hosts.length) return denyResponse('badcode');
    if ((this.pass || '') !== pass) return denyResponse('badpass');
    if (this.state.getWebSockets('guest').length) return denyResponse('full');

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], ['guest']);
    sendTo(pair[1], { t: 'joined' });
    sendTo(hosts[0], { t: 'peer' });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Relay verbatim: only {t:'sdp'} moves; everything else is dropped (same
  // allow-list as the Deno relay).
  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (!m || m.t !== 'sdp') return;
    const peer = this.peerOf(ws);
    if (!peer) return;
    try { peer.send(message); } catch (e) { /* close handler cleans up */ }
  }

  webSocketClose(ws) { this.teardown(ws); }
  webSocketError(ws) { this.teardown(ws); }

  peerOf(ws) {
    // Identity comparison against the tracked sockets (the ws param handed to
    // the hibernation handlers is the same object getWebSockets() returns).
    const hosts = this.state.getWebSockets('host');
    if (hosts.includes(ws)) return this.state.getWebSockets('guest')[0] || null;
    const guests = this.state.getWebSockets('guest');
    if (guests.includes(ws)) return hosts[0] || null;
    // Fallback: tags (in case of runtime identity quirks).
    try {
      const isHost = (ws.getTags ? ws.getTags() : []).includes('host');
      const others = this.state.getWebSockets(isHost ? 'guest' : 'host');
      return others[0] || null;
    } catch (e) { return null; }
  }

  // ANY socket leaving kills the room (exact Deno relay semantics): the UI on
  // the other side already says "left the room", and a hostless room is dead.
  teardown(ws) {
    const peer = this.peerOf(ws);
    if (peer) sendTo(peer, { t: 'bye' });
    closeAll(this.state, ['host', 'guest'], 'room closed');
  }

  // TTL sweep: room sat unused past its TTL — a live handshake completes in
  // seconds, so age is a safe proxy for deadness (same policy as the Deno
  // relay's 60s sweep, expressed as one DO alarm).
  async alarm() {
    closeAll(this.state, ['host', 'guest'], 'room expired');
    try { this.state.storage.deleteAlarm(); } catch (e) { /* fine */ }
  }
}

// ---------------------------------------------------------------------------
// QueueDO — ranked matchmaking, one instance per build+netcode bucket
// (idFromName('queue:<build>:<nc>')) so only byte-identical clients meet.
//
// Plain (non-hibernated) sockets + in-memory state: a queue wait lasts
// seconds and the pair relays SDP for a few more, so nothing needs to
// survive eviction — if the DO restarts, players re-enter the queue.
//
// Identity verification is optional: set IDENTITY_VERIFY_URL (wrangler vars)
// to a POST endpoint taking {name, code} and replying {ok:true} to enforce
// claimed names. Unset = any display name is accepted (the client build
// without an identity service cannot report results anyway).
// ---------------------------------------------------------------------------

export class QueueDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.waiting = []; // { ws, name }
    this.pairs = new Set(); // { a: {ws, name}, b: {ws, name} }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('queue ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    // Optional identity gate (ranked anti-impersonation).
    if (this.env && this.env.IDENTITY_VERIFY_URL) {
      const ok = await this.verifyIdentity(url.searchParams.get('name') || '', url.searchParams.get('code') || '');
      if (!ok) return denyResponse('badident');
    }
    if (this.waiting.length >= MAX_QUEUE_PER_BUCKET) return denyResponse('busy');

    const name = sanitizeName(url.searchParams.get('name'));
    const pair = new WebSocketPair();
    pair[1].accept();

    const entry = { ws: pair[1], name };
    this.waiting.push(entry);

    const self = this;
    pair[1].addEventListener('message', (ev) => self.onMessage(entry, ev));
    pair[1].addEventListener('close', () => self.onClose(entry));
    pair[1].addEventListener('error', () => self.onClose(entry));

    this.maybePair();
    this.broadcastCount();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async verifyIdentity(name, code) {
    try {
      const u = this.env.IDENTITY_VERIFY_URL;
      const endpoint = /^https?:\/\//i.test(u) ? u : 'https://' + u;
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, code }),
      });
      const j = await r.json();
      return !!(j && (j.ok === true || j.success === true));
    } catch (e) {
      return false; // fail CLOSED for ranked: unverifiable -> cannot queue
    }
  }

  onMessage(entry, ev) {
    if (typeof ev.data !== 'string' || ev.data.length > MAX_MESSAGE_BYTES) return;
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || m.t !== 'sdp') return;
    const pair = this.pairOf(entry);
    if (!pair) return;
    const peer = pair.a === entry ? pair.b : pair.a;
    try { peer.ws.send(ev.data); } catch (e) { /* close handler cleans up */ }
  }

  maybePair() {
    while (this.waiting.length >= 2) {
      const a = this.waiting.shift();
      const b = this.waiting.shift();
      const pair = { a, b };
      this.pairs.add(pair);
      // Server pairing time keys the result report on both peers — MUST be
      // one shared clock value, not a per-peer Date.now() (see webrtc.js).
      const at = Date.now();
      sendTo(a.ws, { t: 'match', role: 'host', at, opponent: b.name });
      sendTo(b.ws, { t: 'match', role: 'guest', at, opponent: a.name });
    }
  }

  broadcastCount() {
    const n = this.waiting.length;
    for (const w of this.waiting) sendTo(w.ws, { t: 'qcount', n });
  }

  pairOf(entry) {
    for (const p of this.pairs) { if (p.a === entry || p.b === entry) return p; }
    return null;
  }

  onClose(entry) {
    const wi = this.waiting.indexOf(entry);
    if (wi >= 0) {
      this.waiting.splice(wi, 1);
      this.broadcastCount();
      return; // never matched: nothing else holds a reference
    }
    const pair = this.pairOf(entry);
    if (pair) {
      const other = pair.a === entry ? pair.b : pair.a;
      sendTo(other.ws, { t: 'bye' });
      try { other.ws.close(1000, 'opponent left'); } catch (e) { /* fine */ }
      this.pairs.delete(pair);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint — routes an upgrade to the right Durable Object
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/' && url.pathname !== '/ws') {
      return new Response('not found', { status: 404 });
    }

    if (request.headers.get('upgrade') !== 'websocket') {
      // Health check (uptime monitors / deploy smoke tests).
      return new Response('fge netplay relay (cloudflare) — ok\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const create = url.searchParams.get('create') === '1';
    const joinCode = (url.searchParams.get('join') ?? '').trim().toLowerCase();
    const queue = url.searchParams.get('queue') === '1';

    if (create) {
      const code = newCode();
      url.searchParams.set('code', code);
      const stub = env.ROOM.get(env.ROOM.idFromName('room:' + code));
      return stub.fetch(new Request('https://room.do/ws?' + url.searchParams.toString(), request));
    }

    if (joinCode) {
      if (!/^[a-z0-9]{4,16}$/.test(joinCode)) return denyResponse('badcode');
      const stub = env.ROOM.get(env.ROOM.idFromName('room:' + joinCode));
      return stub.fetch(request);
    }

    if (queue) {
      const build = (url.searchParams.get('build') || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
      const nc = url.searchParams.get('nc') === '1' ? '1' : '0';
      if (!build) return denyResponse('busy');
      const stub = env.QUEUE.get(env.QUEUE.idFromName('queue:' + build + ':' + nc));
      return stub.fetch(request);
    }

    // Neither creating, joining, nor queueing (stray probe).
    return denyResponse('unsupported');
  },
};
