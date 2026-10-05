// =============================================================================
// FightingGameEngine-Web — Netplay signaling relay (Deno)
// =============================================================================
// Tiny WebSocket relay that lets two browsers trade WebRTC offer/answer blobs
// through a short room code, so they can connect DIRECTLY (P2P data channels)
// for netplay. The relay only swaps SDP blobs during the handshake — it never
// sees game data, and it is never involved after the data channels open.
//
// This implements EXACTLY the lobby protocol that public/game/webrtc.js
// speaks (see its header comment):
//
//   WS connect ?create=1&pass=SECRET   -> {t:'room', code}
//   WS connect ?join=CODE&pass=SECRET  -> {t:'joined'} to joiner
//                                         {t:'peer'}  to host
//                                         {t:'sdp', sdp} relayed verbatim
//                                         {t:'bye'} when the peer disconnects
//   {t:'deny', reason:'badcode'|'badpass'|'full'} on failure
//
// Deploy: see netrelay/README.md (Deno Deploy, free tier, zero config).
// Run locally: deno run --allow-net relay.ts   (defaults to port 8940, the
// port public/game/webrtc.js already expects for localhost dev testing.)
// =============================================================================

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const PORT = Number(Deno.env.get("PORT") ?? 8940);

// Room codes: lowercase, no 0/1/o/i/l to survive being read out loud.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 6;

const MAX_ROOMS = 500;
const ROOM_TTL_MS = 30 * 60 * 1000; // matches the hint in webrtc.js's UI copy
const MAX_MESSAGE_BYTES = 64 * 1024; // SDP blobs are a few KB; cap abuse hard

function newCode(): string {
  // Reject codes that spell anything too rude by construction is overkill for
  // a 6-char random code with no vowels-run guarantee; collisions are retried.
  for (;;) {
    let code = "";
    const rnd = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[rnd[i] % CODE_ALPHABET.length];
    }
    if (!rooms.has(code)) return code;
  }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

interface SocketLike {
  send(data: string): void;
  close(): void;
  readyState: number; // Deno WebSocket.readyState: 0 connecting, 1 open
}

interface Room {
  code: string;
  pass: string;
  host: SocketLike | null;
  guest: SocketLike | null;
  createdAt: number;
}

const rooms = new Map<string, Room>();

// A freshly upgraded Deno WebSocket may still be CONNECTING when our request
// handler runs, and send() on a connecting socket throws. Queue until open.
const outbox = new WeakMap<SocketLike, string[]>();

function sendTo(ws: SocketLike | null, msg: unknown): void {
  if (!ws) return;
  const data = JSON.stringify(msg);
  if (ws.readyState === 1) {
    try {
      ws.send(data);
    } catch {
      // socket is dying; the close handler cleans the room up
    }
    return;
  }
  const box = outbox.get(ws);
  if (box) box.push(data);
}

function flushOutbox(ws: SocketLike): void {
  const box = outbox.get(ws);
  if (!box) return;
  outbox.delete(ws);
  for (const data of box) {
    try {
      ws.send(data);
    } catch {
      break;
    }
  }
}

function peerOf(room: Room, ws: SocketLike): SocketLike | null {
  if (room.host === ws) return room.guest;
  if (room.guest === ws) return room.host;
  return null;
}

function detach(ws: SocketLike): void {
  for (const room of rooms.values()) {
    let other: SocketLike | null = null;
    if (room.host === ws) {
      other = room.guest;
      room.host = null;
    } else if (room.guest === ws) {
      other = room.host;
      room.guest = null;
    } else {
      continue;
    }
    if (other) sendTo(other, { t: "bye" });
    // A room with no host is dead even if a guest lingers: the guest's UI
    // already showed "host left", and nobody can join a hostless room, so
    // keeping it would only block the code. Free it either way.
    rooms.delete(room.code);
    return;
  }
}

function sweep(): void {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      // Room sat unused past its TTL. If someone IS mid-handshake, the SDP
      // relay still worked — TTL only counts from creation, and a live
      // handshake completes in seconds, so age is a safe proxy for deadness.
      if (room.host) sendTo(room.host, { t: "bye" });
      if (room.guest) sendTo(room.guest, { t: "bye" });
      rooms.delete(room.code);
    }
  }
}

setInterval(sweep, 60 * 1000);

// ---------------------------------------------------------------------------
// HTTP + WebSocket upgrade
// ---------------------------------------------------------------------------

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);

  if (url.pathname !== "/" && url.pathname !== "/ws") {
    return new Response("not found", { status: 404 });
  }

  // Plain GET = health check (handy for uptime monitors and deploy smoke tests).
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response(
      `fge netplay relay — ${rooms.size} room(s) open\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  outbox.set(socket, []); // sends before 'open' are queued and flushed on open
  const create = url.searchParams.get("create") === "1";
  const joinCode = (url.searchParams.get("join") ?? "").trim().toLowerCase();
  const pass = url.searchParams.get("pass") ?? "";

  if (create) {
    if (rooms.size >= MAX_ROOMS) {
      sendTo(socket, { t: "deny", reason: "busy" });
      socket.close(1013, "server full");
      return response;
    }
    const room: Room = {
      code: newCode(),
      pass,
      host: socket,
      guest: null,
      createdAt: Date.now(),
    };
    rooms.set(room.code, room);
    sendTo(socket, { t: "room", code: room.code });
  } else if (joinCode) {
    const room = rooms.get(joinCode);
    if (!room) {
      sendTo(socket, { t: "deny", reason: "badcode" });
      socket.close(1008, "bad code");
      return response;
    }
    if ((room.pass || "") !== pass) {
      sendTo(socket, { t: "deny", reason: "badpass" });
      socket.close(1008, "bad pass");
      return response;
    }
    if (room.guest) {
      sendTo(socket, { t: "deny", reason: "full" });
      socket.close(1008, "room full");
      return response;
    }
    room.guest = socket;
    sendTo(socket, { t: "joined" });
    sendTo(room.host, { t: "peer" });
  } else {
    // Neither creating nor joining (e.g. a stray queue=1 probe — ranked
    // matchmaking is not part of this relay).
    sendTo(socket, { t: "deny", reason: "unsupported" });
    socket.close(1008, "unsupported");
    return response;
  }

  socket.onopen = () => flushOutbox(socket);

  socket.onmessage = (ev) => {
    if (typeof ev.data !== "string") return; // signaling is JSON text only
    if (ev.data.length > MAX_MESSAGE_BYTES) return;
    let msg: unknown;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // Only sdp is relayed; everything else a client might send is dropped.
    const m = msg as { t?: string };
    if (m?.t !== "sdp") return;
    // Resolve the sender's room by scanning (rooms are tiny; N <= 500).
    for (const r of rooms.values()) {
      if (r.host === socket || r.guest === socket) {
        sendTo(peerOf(r, socket), msg);
        return;
      }
    }
  };

  socket.onclose = () => detach(socket);
  socket.onerror = () => detach(socket);

  return response;
});
