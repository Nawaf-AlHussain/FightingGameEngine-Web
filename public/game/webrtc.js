// WebRTC netplay bridge for the Ikemen GO wasm build.
//
// The engine's lockstep netplay speaks a byte stream (TCP on desktop).
// Here the same stream rides an ordered+reliable RTCDataChannel, so the
// two players connect DIRECTLY to each other - no game server involved.
// Signaling is manual copy-paste (v1): the host sends an offer code to
// their friend over any chat, the friend pastes it, sends back an answer
// code, done. STUN by Google's free public server.
//
// Go side: src/netconn_js.go calls globalThis.ikemenNet.
(function () {
  'use strict';

  // metered.ca TURN relay (for router pairings that can't connect
  // directly). Fresh short-lived credentials are fetched per session from
  // their API. Set METERED_APP to the account's app subdomain (the
  // "xxxx.metered.live" name from the dashboard). Note: the API key is
  // public in this file by design (client-side fetch) - fine for a
  // friends-only site, but it does mean strangers could burn the quota.
  const METERED_APP = ''; // STUN-only by default. For a TURN relay fallback, put your own metered.live app subdomain here.
  const METERED_KEY = ''; // Your own metered.live API key, paired with METERED_APP above.

  // Lobby signaling server: swaps the WebRTC offer/answer blobs so players
  // trade a short room code instead of the giant copy-paste strings. Set this
  // to your own deployed endpoint, e.g. wss://<host>/ws — it is any WebSocket
  // relay speaking:
  //   ?create=1[&pass=...]  -> {t:'room', code}
  //   ?join=CODE[&pass=...] -> {t:'joined'} | {t:'peer'}
  //                            {t:'deny', reason:'badcode'|'badpass'|'full'}
  // then {t:'sdp',...} relayed verbatim both ways, {t:'bye'} on disconnect.
  // Empty = no lobby; the manual copy-paste flow still works and is always
  // available as a fallback. ?signal=<url> on the page URL overrides (dev).
  const SIGNAL_URL = ''; // Empty = manual copy-paste connect, which needs no server. To enable short room codes instead, point this at a lobby WebSocket you run (see the protocol notes in the block comment above).
  function signalUrl() {
    const q = new URLSearchParams(location.search).get('signal');
    if (q) return q;
    if (SIGNAL_URL) return SIGNAL_URL;
    // Local dev convenience: the reference server's default port.
    if (/^(localhost|127\.)/.test(location.hostname)) return 'ws://localhost:8940/ws';
    return '';
  }

  async function fetchIceServers() {
    const base = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    ];
    if (!METERED_APP) return base;
    try {
      const res = await fetch(`https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${METERED_KEY}`);
      const servers = await res.json();
      if (Array.isArray(servers) && servers.length) {
        console.log('[netplay] TURN relay credentials loaded (' + servers.length + ' servers)');
        return base.concat(servers);
      }
    } catch (e) {
      console.warn('[netplay] TURN credential fetch failed, direct-only:', e.message);
    }
    return base;
  }

  let pc = null, dc = null;
  // Rollback datagram channel (V2 engine): unordered/unreliable, UDP
  // semantics for GGPO. Whole datagrams are queued; boundaries preserved.
  let gdc = null, gQueue = [];
  let isConnected = false, isFailed = false, isClosed = false;
  // Incoming bytes: queue of Uint8Array chunks + read offset into first.
  let chunks = [], chunkOff = 0;
  let panel = null;

  // Live counters so a freeze is diagnosable on-screen (F12 is unreliable
  // when a tab locks up). bytesRecv advancing but bytesReadByEngine stuck
  // = engine wedged; both stuck = peer went silent.
  let bytesRecv = 0, bytesReadByEngine = 0, bytesSent = 0;
  let pingMs = -1; // rollback round-trip, fed by the engine via setPing

  // Always-visible on-screen diagnostic log - the game canvas can freeze
  // with F12 unavailable, but this DOM overlay keeps updating and can be
  // screenshotted. Ring-buffered to the last lines.
  let diag = null, diagLines = [], diagOpen = false;
  function netLog(msg) {
    console.log('[netplay]', msg);
    diagLines.push('[' + (performance.now() / 1000).toFixed(1) + 's] ' + msg);
    if (diagLines.length > 12) diagLines.shift();
    renderDiag();
  }
  function renderDiag() {
    if (!diag) {
      // Sits in the PAGE FLOW directly under the game, collapsed to its
      // summary line. It used to be position:fixed at the viewport bottom
      // with the canvas shrunk above it (ikemenReserveBottom) - fine on a
      // tall window, but inside itch's short iframe the bar was permanently
      // glued over the bottom of the play area and the reserved strip ate
      // the picture. In flow it can never cover the match; click the header
      // to expand the log when a connection actually needs debugging.
      diag = document.createElement('div');
      diag.style.cssText =
        'display:block;margin:6px auto 0;max-width:1280px;background:#000d;color:#6f6;' +
        'border:1px solid #363;border-radius:4px;padding:4px 8px;box-sizing:border-box;' +
        'font:11px monospace;white-space:pre;line-height:1.3;cursor:pointer;' +
        'overflow:hidden;max-height:1.9em';
      diag.title = 'Netplay diagnostics - click to expand/collapse';
      diag.addEventListener('click', function () {
        diagOpen = !diagOpen;
        diag.style.maxHeight = diagOpen ? '38vh' : '1.9em';
        diag.style.overflowY = diagOpen ? 'auto' : 'hidden';
      });
      // Keep clicks/keys off the engine, which listens document-wide.
      for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'wheel']) {
        diag.addEventListener(t, function (e) { e.stopPropagation(); });
      }
      const canvas = document.querySelector('body > canvas');
      if (canvas) canvas.insertAdjacentElement('afterend', diag);
      else document.body.appendChild(diag);
    }
    diag.textContent = (diagOpen ? '▼ ' : '▶ ') +
      'NETPLAY' + (pingMs >= 0 ? ' [ping ' + pingMs + 'ms]' : '') +
      ' (recv ' + bytesRecv + 'B / engine-read ' + bytesReadByEngine + 'B / sent ' + bytesSent + 'B)\n' +
      diagLines.join('\n');
  }
  function hideDiag() {
    if (diag) { diag.remove(); diag = null; }
    diagLines = [];
    diagOpen = false;
  }

  function resetState() {
    isConnected = false; isFailed = false; isClosed = false;
    chunks = []; chunkOff = 0;
    bytesRecv = 0; bytesReadByEngine = 0; bytesSent = 0;
    peerHash = null; hashVerdict = null;
    peerNetcode = null; ncVerdict = null;
    gdc = null; gQueue = []; pingMs = -1;
    queueRole = ''; queueP1 = ''; queueP2 = ''; queueStartedAt = 0; queueMatchSeq = 0;
    if (!localHash) computeBuildHash();
  }

  function maybeJudgeNetcode() {
    if (ncVerdict !== null || peerNetcode === null) return;
    const same = peerNetcode === localNetcode();
    ncVerdict = same;
    if (same) {
      netLog('netcode check OK - both on ' + ncName(localNetcode()));
    } else {
      netLog('NETCODE MISMATCH - local ' + ncName(localNetcode()) + ' vs peer ' + ncName(peerNetcode));
      setStatus('Netcode mismatch: you picked ' + ncName(localNetcode()) + ', your opponent picked '
        + ncName(peerNetcode) + '. Both must choose the same "Online netcode" on the start screen.');
      ikemenNet.close();
    }
  }

  // Bridge-level handshake ping: sent by each side the moment the channel
  // opens, filtered out before the engine sees it. Proves the transport
  // carries data in BOTH directions independent of the engines - the
  // field-observed failure is a channel that reports OPEN but silently
  // black-holes data one way.
  const PING = new Uint8Array([0x49, 0x4b, 0x4d, 0x4e, 0x50, 0x49, 0x4e, 0x47]); // "IKMNPING"
  let pingSeen = false, pingFilterArmed = false;

  // Build-content check: right after the ping, each side sends a hash
  // of the game manifest ("IKMH" + 8 bytes, filtered from the engine).
  // Lockstep netplay DESYNCS if the two players have different characters
  // or stages, so a mismatch (stale cache, old upload) refuses the match
  // with a clear message instead of corrupting it mid-game.
  const HASH_MAGIC = [0x49, 0x4b, 0x4d, 0x48]; // "IKMH"
  let localHash = null, peerHash = null, hashVerdict = null;

  // Netcode check: each side also sends its chosen netcode ("IKNC" + 1 byte,
  // 0=delay 1=rollback, filtered from the engine). Delay and rollback are
  // incompatible on the wire, so a mismatch refuses the match with a clear
  // message instead of a broken/instant-desync session. The choice comes from
  // the boot-page selector (globalThis.ikemenNetcode).
  const NC_MAGIC = [0x49, 0x4b, 0x4e, 0x43]; // "IKNC"
  let peerNetcode = null, ncVerdict = null;
  function localNetcode() { return globalThis.ikemenNetcode === 'rollback' ? 1 : 0; }
  function ncName(v) { return v ? 'Rollback' : 'Delay'; }

  // Deterministic content hash (cyrb64), 8 bytes. Deliberately NOT
  // crypto.subtle: that Web Crypto API is undefined over plain http://
  // (non-secure context) and its absence silently DISABLED the desync check
  // by degrading every hash to zeros ("always match"). Pure JS works in any
  // context and both players run identical code, so the result stays
  // consistent between them.
  function contentHash64(bytes) {
    let h1 = 0xdeadbeef ^ bytes.length, h2 = 0x41c6ce57 ^ bytes.length;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 2654435761);
      h2 = Math.imul(h2 ^ bytes[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const out = new Uint8Array(8), dv = new DataView(out.buffer);
    dv.setUint32(0, h2 >>> 0); dv.setUint32(4, h1 >>> 0);
    return out;
  }

  async function computeBuildHash() {
    try {
      // Preferred: the combined Build ID computed by vfs.js during boot -
      // covers the shipped pack, every browser-side mod's bytes, and the
      // theme pick, so mismatched mods or themes are refused up front
      // instead of desyncing mid-match.
      if (globalThis.ikemenBuildHash instanceof Uint8Array && globalThis.ikemenBuildHash.length === 8) {
        localHash = globalThis.ikemenBuildHash;
      } else {
        // Fallback (page without the VFS, e.g. the dev harness): manifest only.
        const res = await fetch('./ikemen-fs/manifest.json', { cache: 'no-cache' });
        const buf = new Uint8Array(await res.arrayBuffer());
        localHash = contentHash64(buf);
      }
    } catch (e) {
      netLog('build hash unavailable: ' + e.message);
      localHash = new Uint8Array(8); // degrade to "always match" rather than block play
    }
    maybeJudgeHashes();
  }

  function maybeJudgeHashes() {
    if (hashVerdict !== null || !localHash || !peerHash) return;
    const same = localHash.every((b, i) => b === peerHash[i]);
    hashVerdict = same;
    if (same) {
      netLog('build check OK - same characters/stages on both sides');
    } else {
      netLog('BUILD MISMATCH - refusing match to prevent desync');
      setStatus('Game contents differ between players! Both players: hard-refresh the page (Ctrl+F5) and retry.');
      ikemenNet.close();
    }
  }

  function wireChannel(channel) {
    dc = channel;
    dc.binaryType = 'arraybuffer';
    pingSeen = false; pingFilterArmed = true;
    dc.onopen = () => {
      isConnected = true;
      netLog('data channel OPEN');
      try { dc.send(PING); netLog('handshake ping sent'); } catch (e) { netLog('ping send FAILED: ' + e.message); }
      // send our build hash once computed (may still be in flight)
      const sendHash = () => {
        if (!localHash) { setTimeout(sendHash, 100); return; }
        try {
          const msg = new Uint8Array(4 + localHash.length);
          msg.set(HASH_MAGIC, 0); msg.set(localHash, 4);
          dc.send(msg);
        } catch (e) { netLog('hash send failed: ' + e.message); }
      };
      sendHash();
      // send our chosen netcode ("IKNC" + 1 byte)
      try {
        const nc = new Uint8Array(5);
        nc.set(NC_MAGIC, 0); nc[4] = localNetcode();
        dc.send(nc);
      } catch (e) { netLog('netcode send failed: ' + e.message); }
      setStatus('Connected! Return to the game window.');
      setTimeout(hidePanel, 2500);
      watchTransport();
    };
    dc.onmessage = (e) => {
      const u = new Uint8Array(e.data);
      if (pingFilterArmed && !pingSeen && u.length === PING.length && u.every((b, i) => b === PING[i])) {
        pingSeen = true;
        netLog('peer handshake ping RECEIVED - transport alive both ways');
        return; // never expose the ping to the engine
      }
      if (!peerHash && u.length === 12 && HASH_MAGIC.every((b, i) => u[i] === b)) {
        peerHash = u.subarray(4);
        maybeJudgeHashes();
        return; // bridge-level message, not for the engine
      }
      if (peerNetcode === null && u.length === 5 && NC_MAGIC.every((b, i) => u[i] === b)) {
        peerNetcode = u[4];
        maybeJudgeNetcode();
        return; // bridge-level message, not for the engine
      }
      bytesRecv += u.length; chunks.push(u); renderDiag();
    };
    dc.onclose = () => { isClosed = true; isConnected = false; netLog('data channel CLOSED by peer'); };
    dc.onerror = (e) => { isFailed = true; netLog('data channel ERROR: ' + (e && e.error && e.error.message || 'unknown')); };
  }

  function wireGGPO(channel) {
    gdc = channel;
    gdc.binaryType = 'arraybuffer';
    gdc.onmessage = (e) => { gQueue.push(new Uint8Array(e.data)); };
    gdc.onopen = () => netLog('ggpo datagram channel OPEN');
    gdc.onclose = () => { gdc = null; };
  }

  // Periodically report the send-buffer depth and which network path ICE
  // chose (direct vs TURN relay). bufferedAmount growing = our data is NOT
  // leaving this machine.
  let watchTimer = null;
  function watchTransport() {
    clearInterval(watchTimer);
    let lastLine = '';
    watchTimer = setInterval(async () => {
      if (!pc || !dc || dc.readyState !== 'open') { clearInterval(watchTimer); return; }
      let path = '?';
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
        if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded') pair = pair || s; });
        if (pair) {
          const loc = stats.get(pair.localCandidateId), rem = stats.get(pair.remoteCandidateId);
          path = (loc ? loc.candidateType : '?') + '->' + (rem ? rem.candidateType : '?');
        }
      } catch { /* stats unavailable */ }
      const line = 'path ' + path + ', send-buffer ' + dc.bufferedAmount + 'B' + (pingSeen ? '' : ', NO peer ping yet');
      if (line !== lastLine) { lastLine = line; netLog(line); }
    }, 3000);
  }

  async function makePeer() {
    pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });
    let discTimer = null;
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      netLog('connectionState: ' + st);
      if (st === 'failed') {
        // Do NOT hard-latch isClosed here. Chromium reports a transient
        // 'failed' MID-NEGOTIATION over the real internet and then recovers
        // to 'connected' - but latching isClosed=true poisoned the recovered
        // channel so read() returned null ("connection closed") even though
        // the transport was demonstrably alive (channel open, pings crossing).
        // Give 'failed' the same recovery grace as 'disconnected'.
        setStatus('Connection trouble - waiting for it to recover...');
        clearTimeout(discTimer);
        discTimer = setTimeout(() => {
          if (pc && pc.connectionState === 'failed') {
            isFailed = true; isClosed = true;
            setStatus('Connection failed. Both players should retry (a VPN or hotspot can help stubborn routers).');
          }
        }, 12000);
      } else if (st === 'disconnected') {
        // Transient dips are normal (NAT remapping); give it time to
        // recover before declaring death. Killing instantly here is what
        // ended sessions that would have self-healed.
        setStatus('Connection unstable - waiting for it to recover...');
        clearTimeout(discTimer);
        discTimer = setTimeout(() => {
          if (pc && pc.connectionState === 'disconnected') {
            isFailed = true; isClosed = true;
            setStatus('Connection lost and did not recover. Both players should retry.');
          }
        }, 12000);
      } else if (st === 'connected') {
        clearTimeout(discTimer);
        // Reaching 'connected' means the transport is genuinely alive (a
        // closed peer connection goes to 'closed', never back to 'connected'),
        // so clear any transient failure flags a mid-negotiation blip set.
        isFailed = false; isClosed = false;
        if (isConnected) setStatus('Connected! Return to the game window.');
      }
    };
    pc.oniceconnectionstatechange = () => netLog('iceConnectionState: ' + pc.iceConnectionState);
  }

  // Wait for ICE gathering so the offer/answer strings are complete
  // (avoids needing trickle-ICE signaling).
  function gatherComplete() {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 4000); // fallback: use whatever gathered
    });
  }

  const enc = (o) => btoa(JSON.stringify(o));
  const dec = (s) => JSON.parse(atob(s.trim()));

  // ---------- signaling panel UI ----------
  function el(tag, style, text) {
    const e = document.createElement(tag);
    e.style.cssText = style || '';
    if (text) e.textContent = text;
    return e;
  }

  function showPanel(mode) {
    hidePanel();
    panel = el('div',
      'position:fixed;top:8px;right:8px;z-index:1000;background:#1c1c22;color:#eee;' +
      'border:1px solid #555;border-radius:8px;padding:12px;width:340px;' +
      'font:13px monospace;box-shadow:0 4px 16px #000a');
    // The engine listens for mouse/keyboard on the whole document; without
    // this, clicks can't focus the textareas and typing feeds the game.
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu']) {
      panel.addEventListener(t, (e) => e.stopPropagation());
    }
    panel.appendChild(el('div', 'font-weight:bold;margin-bottom:6px',
      mode === 'host' ? 'NETPLAY - You are hosting'
        : mode === 'queue' ? 'NETPLAY - Ranked match'
          : 'NETPLAY - Joining a host'));
    // pre-line so a status can carry a second paragraph (the queue's
    // build-mismatch hint) without needing markup.
    const status = el('div', 'color:#9fd;margin-bottom:8px;min-height:16px;white-space:pre-line', 'Preparing connection...');
    panel.appendChild(status);
    panel.__status = status;

    const mkArea = (label, readonly) => {
      panel.appendChild(el('div', 'margin-top:6px;color:#aaa', label));
      const ta = el('textarea',
        'width:100%;height:64px;background:#111;color:#cfc;border:1px solid #444;' +
        'font:11px monospace;resize:none;box-sizing:border-box');
      ta.readOnly = !!readonly;
      panel.appendChild(ta);
      return ta;
    };

    const mkBtn = (label, fn) => {
      const b = el('button',
        'margin-top:6px;margin-right:6px;background:#333;color:#eee;border:1px solid #666;' +
        'border-radius:4px;padding:4px 10px;cursor:pointer;font:12px monospace', label);
      b.onclick = fn;
      panel.appendChild(b);
      return b;
    };

    const mkInput = (label, placeholder) => {
      panel.appendChild(el('div', 'margin-top:6px;color:#aaa', label));
      const inp = el('input',
        'width:100%;background:#111;color:#cfc;border:1px solid #444;' +
        'font:13px monospace;padding:4px 6px;box-sizing:border-box');
      inp.type = 'text';
      inp.placeholder = placeholder || '';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      panel.appendChild(inp);
      return inp;
    };

    // Wipe everything below the title+status (used when a flow switches to
    // the manual fallback in place).
    const clearBody = () => {
      while (panel.lastChild && panel.lastChild !== status) panel.removeChild(panel.lastChild);
    };

    document.body.appendChild(panel);
    return { mkArea, mkBtn, mkInput, clearBody, status };
  }

  function setStatus(msg) { if (panel && panel.__status) panel.__status.textContent = msg; }

  // One-click paste (clipboard permission prompt on first use). Falls back
  // to manual: the panel swallows its own events, so click + Ctrl+V works.
  function pasteInto(area) {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText()
        .then((t) => { area.value = t.trim(); setStatus('Pasted from clipboard.'); })
        .catch(() => { area.focus(); setStatus('Clipboard blocked - click the box and press Ctrl+V.'); });
    } else {
      area.focus();
      setStatus('Click the box and press Ctrl+V.');
    }
  }
  function hidePanel() { if (panel) { panel.remove(); panel = null; } }

  // ---------- manual copy-paste flow (the original v1 path, kept as the
  // always-available fallback: works with zero infrastructure) ----------

  async function manualHostUI(ui) {
    const outArea = ui.mkArea('1. Send this OFFER code to your friend:', true);
    ui.mkBtn('Copy offer', () => { outArea.select(); document.execCommand('copy'); });
    const inArea = ui.mkArea("2. Paste your friend's ANSWER code:");
    ui.mkBtn('Paste answer', () => pasteInto(inArea));
    ui.mkBtn('Connect', async () => {
      try {
        await pc.setRemoteDescription(dec(inArea.value));
        setStatus('Answer accepted - connecting...');
      } catch (e) { setStatus('Bad answer code: ' + e.message); }
    });
    await makePeer();
    wireChannel(pc.createDataChannel('ikemen', { ordered: true }));
    wireGGPO(pc.createDataChannel('ggpo', { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    await gatherComplete();
    outArea.value = enc(pc.localDescription);
    setStatus('Waiting for answer code...');
  }

  async function manualJoinUI(ui) {
    const inArea = ui.mkArea("1. Paste the host's OFFER code:");
    ui.mkBtn('Paste offer', () => pasteInto(inArea));
    const outArea = ui.mkArea('2. Send this ANSWER code back to the host:', true);
    ui.mkBtn('Copy answer', () => { outArea.select(); document.execCommand('copy'); });
    await makePeer();
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'ggpo') wireGGPO(e.channel);
      else wireChannel(e.channel);
    };
    ui.mkBtn('Generate answer', async () => {
      try {
        await pc.setRemoteDescription(dec(inArea.value));
        await pc.setLocalDescription(await pc.createAnswer());
        await gatherComplete();
        outArea.value = enc(pc.localDescription);
        setStatus('Send the answer to the host, then wait...');
      } catch (e) { setStatus('Bad offer code: ' + e.message); }
    });
    setStatus("Waiting for the host's offer code...");
  }

  // ---------- room-code flow (lobby signaling server) ----------
  // The server only swaps the SDP blobs; everything after the data channel
  // opens (ping, build hash, netcode check, the match) is identical to the
  // manual path.

  function friendlyDeny(reason) {
    return reason === 'badcode' ? 'No room with that code. Check the spelling - codes also expire about 30 minutes after being created.'
      : reason === 'badpass' ? 'Wrong password.'
        : reason === 'full' ? 'That room already has two players.'
          : reason === 'busy' ? 'The lobby hiccuped - press the button again.'
            : 'Denied: ' + reason;
  }

  // After the SDP exchange the signaling socket has done its job: close it
  // once the peer connection resolves either way, so the room frees up.
  function releaseSignal(ws) {
    const t = setInterval(() => {
      if (isConnected || isClosed || isFailed) {
        clearInterval(t);
        ws.__done = true;
        try { ws.close(); } catch { /* already gone */ }
      }
    }, 1000);
  }

  function switchToManual(ui, mode, note) {
    try { if (pc) pc.close(); } catch { /* fresh one below */ }
    pc = null;
    ui.clearBody();
    if (mode === 'host') manualHostUI(ui); else manualJoinUI(ui);
    if (note) setStatus(note);
  }

  function roomHost(ui, url) {
    const passInp = ui.mkInput('Optional room password:', 'leave blank for none');
    let ws = null;
    const createBtn = ui.mkBtn('Create room', () => {
      createBtn.disabled = true;
      setStatus('Creating room...');
      let gotRoom = false;
      ws = new WebSocket(url + (url.includes('?') ? '&' : '?') +
        'create=1&pass=' + encodeURIComponent(passInp.value.trim()));
      ws.onmessage = async (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        try {
          if (m.t === 'room') {
            gotRoom = true;
            netLog('room created: ' + m.code);
            ui.clearBody();
            panel.appendChild(el('div', 'margin-top:8px;color:#aaa', 'Give this room code to your friend:'));
            const codeEl = el('div',
              'margin-top:4px;padding:8px;background:#111;border:1px solid #464;border-radius:6px;' +
              'font:bold 20px monospace;color:#8f8;text-align:center;user-select:all', m.code);
            panel.appendChild(codeEl);
            ui.mkBtn('Copy code', () => {
              const r = document.createRange(); r.selectNodeContents(codeEl);
              const s = getSelection(); s.removeAllRanges(); s.addRange(r);
              document.execCommand('copy'); s.removeAllRanges();
              setStatus('Code copied.');
            });
            if (passInp.value.trim()) panel.appendChild(el('div', 'margin-top:6px;color:#886', "Don't forget to tell them the password too."));
            setStatus('Waiting for your friend to join...');
          } else if (m.t === 'peer') {
            setStatus('Friend joined! Connecting...');
            netLog('guest joined the room - sending offer');
            await makePeer();
            wireChannel(pc.createDataChannel('ikemen', { ordered: true }));
            wireGGPO(pc.createDataChannel('ggpo', { ordered: false, maxRetransmits: 0 }));
            await pc.setLocalDescription(await pc.createOffer());
            await gatherComplete();
            ws.send(JSON.stringify({ t: 'sdp', sdp: pc.localDescription }));
          } else if (m.t === 'sdp') {
            await pc.setRemoteDescription(m.sdp);
            setStatus('Connecting...');
            releaseSignal(ws);
          } else if (m.t === 'deny') {
            ws.__done = true;
            createBtn.disabled = false;
            setStatus(friendlyDeny(m.reason));
          } else if (m.t === 'bye') {
            if (!isConnected) setStatus('Your friend left the room. Waiting...');
          }
        } catch (err) {
          netLog('room host error: ' + err.message);
          setStatus('Connection setup failed: ' + err.message);
        }
      };
      ws.onclose = () => {
        if (!ws.__done && !gotRoom) {
          switchToManual(ui, 'host', 'Lobby server unreachable - using manual connect instead.');
        }
      };
    });
    ui.mkBtn('Manual connect instead', () => {
      if (ws) { ws.__done = true; try { ws.close(); } catch { /* fine */ } }
      switchToManual(ui, 'host');
    });
    setStatus('Create a room and read the short code to your friend.');
  }

  function roomJoin(ui, url) {
    const codeInp = ui.mkInput("Your friend's room code:", 'e.g. spicy-tiger-42');
    const passInp = ui.mkInput('Room password (if they set one):', '');
    let ws = null;
    const joinBtn = ui.mkBtn('Join room', () => {
      const code = codeInp.value.trim().toLowerCase();
      if (!code) { setStatus('Enter the room code first.'); return; }
      joinBtn.disabled = true;
      setStatus('Joining ' + code + '...');
      let joined = false;
      ws = new WebSocket(url + (url.includes('?') ? '&' : '?') +
        'join=' + encodeURIComponent(code) + '&pass=' + encodeURIComponent(passInp.value.trim()));
      ws.onmessage = async (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        try {
          if (m.t === 'joined') {
            joined = true;
            netLog('joined room ' + code);
            setStatus('In the room - waiting for the host to connect...');
            await makePeer();
            pc.ondatachannel = (ev) => {
              if (ev.channel.label === 'ggpo') wireGGPO(ev.channel);
              else wireChannel(ev.channel);
            };
          } else if (m.t === 'sdp') {
            await pc.setRemoteDescription(m.sdp);
            await pc.setLocalDescription(await pc.createAnswer());
            await gatherComplete();
            ws.send(JSON.stringify({ t: 'sdp', sdp: pc.localDescription }));
            setStatus('Connecting...');
            releaseSignal(ws);
          } else if (m.t === 'deny') {
            ws.__done = true;
            joinBtn.disabled = false;
            setStatus(friendlyDeny(m.reason));
          } else if (m.t === 'bye') {
            if (!isConnected) { joinBtn.disabled = false; setStatus('The host left the room.'); }
          }
        } catch (err) {
          netLog('room join error: ' + err.message);
          setStatus('Connection setup failed: ' + err.message);
        }
      };
      ws.onclose = () => {
        if (!ws.__done && !joined) {
          joinBtn.disabled = false;
          switchToManual(ui, 'join', 'Lobby server unreachable - using manual connect instead.');
        }
      };
    });
    ui.mkBtn('Manual connect instead', () => {
      if (ws) { ws.__done = true; try { ws.close(); } catch { /* fine */ } }
      switchToManual(ui, 'join');
    });
    setStatus('Type the room code your friend gave you.');
  }

  function startHost() {
    const ui = showPanel('host');
    const url = signalUrl();
    if (url) roomHost(ui, url); else manualHostUI(ui);
  }

  function startJoin() {
    const ui = showPanel('join');
    const url = signalUrl();
    if (url) roomJoin(ui, url); else manualJoinUI(ui);
  }

  // ---------- ranked match queue ----------
  // Strangers auto-paired by the signaling server, bucketed by build+netcode
  // so only byte-identical clients meet. Queueing requires a claimed online
  // name (identity.js): the server verifies name+recovery-code before
  // admitting, and each side receives the OPPONENT'S VERIFIED name - that is
  // what the in-match name plates show, never the raw config field. The
  // engine drives this via ikemenNet.start('queue') and polls queueRole()
  // to learn which side it is once the server pairs us.

  // queueMatchSeq counts MATCHES within one pairing. queueStartedAt is fixed
  // for the whole session, so on its own it keyed every match of a session to
  // the same id and the server discarded matches 2..N as duplicates - a pair
  // who played five games had one counted (field-hit 2026-08-11).
  let queueRole = '', queueP1 = '', queueP2 = '', queueStartedAt = 0, queueMatchSeq = 0;

  // Where the leaderboard/identity service lives. Same origin the identity
  // module uses, so a build with identity disabled reports nowhere.
  const IDENTITY_URL = ((globalThis.IKEMEN_BRAND && globalThis.IKEMEN_BRAND.identityUrl) || '').replace(/\/+$/, '');

  function startQueue() {
    const ui = showPanel('queue');
    const url = signalUrl();
    if (!url) {
      setStatus('No matchmaking server configured for this build. Use Host/Join with a friend instead.');
      return;
    }
    let identity = null;
    try { identity = JSON.parse(localStorage.getItem('ikemen-identity')) || null; } catch (e) { /* fall through */ }
    if (!identity || !identity.name || !identity.code) {
      setStatus('Ranked match needs a claimed online name. Set NETWORK > PLAYER NAME first, save the recovery code, then try again.');
      return;
    }
    // Fail CLOSED on a missing build hash: with strangers, "can't check"
    // must mean "can't queue", or mismatched builds meet and desync.
    // (Friend matches keep the lenient fallback - they can coordinate.)
    if (!(globalThis.ikemenBuildHash instanceof Uint8Array) || typeof globalThis.ikemenBuildHex !== 'string') {
      setStatus('Build ID unavailable - hard-refresh the page (Ctrl+F5) and try again.');
      return;
    }
    setStatus('Joining the queue as ' + identity.name + '...');
    const ws = new WebSocket(url + (url.includes('?') ? '&' : '?') +
      'queue=1&build=' + encodeURIComponent(globalThis.ikemenBuildHex) +
      '&nc=' + localNetcode() +
      '&name=' + encodeURIComponent(identity.name) +
      '&code=' + encodeURIComponent(identity.code));
    let matched = false;
    // The queue is bucketed by Build ID (only byte-identical clients may be
    // paired, or lockstep desyncs instantly). That means a roster update
    // silently SPLITS the pool: someone on yesterday's cached build and
    // someone on today's each sit alone seeing "1 player waiting" with no
    // clue why. After a long wait alone, say so.
    let lonely = false;
    const lonelyTimer = setTimeout(() => { if (!matched) { lonely = true; renderQueueStatus(); } }, 20000);
    let lastCount = 1;
    function renderQueueStatus() {
      if (matched) return;
      let s = 'In queue as ' + identity.name + ' - ' + lastCount +
        (lastCount === 1 ? ' player waiting (that\'s you). Leave this open.' : ' players waiting...');
      if (lonely && lastCount === 1) {
        s += '\n\nNobody else is on your version of the build. If someone should be online, BOTH of you refresh the page (Ctrl+F5): updating the roster changes the Build ID, and only identical builds can be matched.';
      }
      setStatus(s);
    }

    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      try {
        if (m.t === 'qcount') {
          lastCount = m.n;
          renderQueueStatus();
        } else if (m.t === 'match') {
          clearTimeout(lonelyTimer);
          matched = true;
          queueRole = m.role === 'host' ? 'host' : 'guest';
          // Server-supplied pairing time: both peers must key their result
          // report identically, so this must NOT come from a local clock.
          // NO local-clock fallback: the two peers must key their reports
          // identically, and Date.now() at millisecond precision would differ
          // per peer, silently filing the two halves of every match under
          // different ids so nothing ever agreed. Absent server time = don't
          // report (guarded in reportResult).
          queueStartedAt = Number(m.at) || 0;
          queueMatchSeq = 0;
          const opp = String(m.opponent || 'opponent');
          // Host is always engine side 1.
          queueP1 = queueRole === 'host' ? identity.name : opp;
          queueP2 = queueRole === 'host' ? opp : identity.name;
          netLog('queue matched: ' + queueP1 + ' (P1) vs ' + queueP2 + ' (P2) - we are ' + queueRole);
          setStatus('Matched against ' + opp + '! Connecting...');
          if (queueRole === 'host') {
            await makePeer();
            wireChannel(pc.createDataChannel('ikemen', { ordered: true }));
            wireGGPO(pc.createDataChannel('ggpo', { ordered: false, maxRetransmits: 0 }));
            await pc.setLocalDescription(await pc.createOffer());
            await gatherComplete();
            ws.send(JSON.stringify({ t: 'sdp', sdp: pc.localDescription }));
          } else {
            await makePeer();
            pc.ondatachannel = (ev) => {
              if (ev.channel.label === 'ggpo') wireGGPO(ev.channel);
              else wireChannel(ev.channel);
            };
          }
        } else if (m.t === 'sdp') {
          if (queueRole === 'host') {
            await pc.setRemoteDescription(m.sdp);
          } else {
            await pc.setRemoteDescription(m.sdp);
            await pc.setLocalDescription(await pc.createAnswer());
            await gatherComplete();
            ws.send(JSON.stringify({ t: 'sdp', sdp: pc.localDescription }));
          }
          setStatus('Connecting...');
          releaseSignal(ws);
        } else if (m.t === 'deny') {
          ws.__done = true;
          clearTimeout(lonelyTimer);
          setStatus(m.reason === 'badident'
            ? 'Your online name could not be verified. Re-set NETWORK > PLAYER NAME (or recover it), then try again.'
            : friendlyDeny(m.reason));
        } else if (m.t === 'bye') {
          if (!isConnected) setStatus('Your opponent disconnected during setup. Re-enter the queue to search again.');
        }
      } catch (err) {
        netLog('queue error: ' + err.message);
        setStatus('Connection setup failed: ' + err.message);
      }
    };
    ws.onclose = () => {
      clearTimeout(lonelyTimer);
      if (!ws.__done && !matched && !isConnected) {
        setStatus('Matchmaking server unreachable. Try again in a minute, or use Host/Join with a friend.');
      }
    };
    // Leaving netplay (Esc in-game) closes the session; take the queue
    // socket down with it so the server frees the slot.
    const leaveWatch = setInterval(() => {
      if (isClosed) {
        clearInterval(leaveWatch); clearTimeout(lonelyTimer);
        ws.__done = true; try { ws.close(); } catch { /* gone */ }
      }
      if (ws.readyState > 1) clearInterval(leaveWatch);
    }, 1000);
  }

  globalThis.ikemenNet = {
    start(mode) {
      resetState();
      netLog(mode === 'host' ? 'hosting - generating offer'
        : mode === 'queue' ? 'entering ranked match queue'
          : 'joining - awaiting offer');
      if (mode === 'host') startHost();
      else if (mode === 'queue') startQueue();
      else startJoin();
    },
    // Ranked-queue state for the engine (netplay_js.go): which side the
    // server assigned us ('' until matched), and the verified display
    // names as "p1\np2" for the in-match plates.
    queueRole() { return queueRole; },
    // "p1\np2\n<pairingToken>". The third line is the server-assigned pairing
    // time, which is unique per pairing and identical on both peers.
    //
    // It exists because the Lua that draws the plates and reports results runs
    // on the engine's per-frame 'loop' hook, which fires ONLY during a fight.
    // Between matches - at the queue screen, where a NEW opponent is assigned -
    // it does not run at all, so it can never observe the transition and clear
    // its caches. Result in the field (2026-08-11): after one set, the plates
    // kept showing the PREVIOUS opponent's names on the previous sides, and the
    // report latch stayed armed so only the first pairing was ever counted.
    // Keying those caches on this token makes them invalidate on their own,
    // without needing to witness the gap.
    queueNames() {
      if (!queueP1) return '';
      return queueP1 + '\n' + queueP2 + '\n' + String(queueStartedAt || 0);
    },

    // Post a finished matchmade result to the leaderboard, signed with this
    // player's identity. Only queue matches report: a friend match has no
    // verified opponent, so counting it would let anyone inflate a record.
    // The opponent posts the mirror image of this independently, and the
    // server counts the match only when the two agree.
    // p1Char/p2Char are the characters on ENGINE SIDES 1 and 2 - not "mine"
    // and "theirs". The Lua reads them with player(1)/player(2), which is the
    // same pair of values on both peers; each side then has to pick its own
    // out of them by role.
    reportResult(winSide, p1Char, p2Char) {
      try {
        if (!queueRole || !queueP1 || !queueP2) return;      // not a queue match
        if (winSide !== 1 && winSide !== 2) return;          // draw: nothing to record
        var id = null;
        try { id = JSON.parse(localStorage.getItem('ikemen-identity')); } catch (e) { return; }
        if (!id || !id.name || !id.code) return;
        if (!queueStartedAt) { netLog('no pairing time - result not reported'); return; }
        var iAmP1 = queueRole === 'host';                    // host is always side 1
        // Advance only AFTER every guard: a peer that bails out early must not
        // leave its counter one ahead of the other side's for the rest of the
        // session. Both peers report every match, so both counters step together.
        var seq = ++queueMatchSeq;
        var body = {
          name: id.name,
          code: id.code,
          opponent: iAmP1 ? queueP2 : queueP1,
          won: iAmP1 ? winSide === 1 : winSide === 2,
          // OUR OWN character: the host is side 1, the guest side 2. The
          // first version reported p1Char from both peers, so a guest filed
          // the host's character as their own and both rows on the board
          // showed the same fighter (field-hit on the first real match).
          character: iAmP1 ? p1Char : p2Char,
          // Both peers must derive the SAME match key without talking: the
          // queue pairing time, quantised server-side into a minute bucket.
          startedAt: queueStartedAt,
          seq: seq,
          buildId: globalThis.ikemenBuildHex || ''
        };
        netLog('reporting result: ' + (body.won ? 'WIN' : 'LOSS') + ' vs ' + body.opponent);
        fetch(IDENTITY_URL + '/mugen/leaderboard/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true   // survive the page being closed right after
        }).then(function (r) { return r.json(); })
          .then(function (r) { netLog('leaderboard: ' + (r && r.state || 'no reply')); })
          .catch(function (e) { netLog('leaderboard report failed: ' + e.message); });
      } catch (e) {
        netLog('report error: ' + e.message);   // never disturb the match
      }
    },
    connected() { return isConnected; },
    failed() { return isFailed; },
    read(max) {
      if (chunks.length === 0) return isClosed ? null : new Uint8Array(0);
      const head = chunks[0];
      const avail = head.length - chunkOff;
      const n = Math.min(avail, max);
      const out = head.subarray(chunkOff, chunkOff + n);
      if (n === avail) { chunks.shift(); chunkOff = 0; }
      else chunkOff += n;
      bytesReadByEngine += n; renderDiag();
      return out;
    },
    send(u8) {
      if (!dc || dc.readyState !== 'open') return false;
      try { dc.send(u8); bytesSent += u8.length; renderDiag(); return true; } catch { return false; }
    },
    // GGPO datagram channel (V2 rollback). readGGPO returns ONE whole
    // datagram (Uint8Array), an empty array when none pending, or null
    // when the channel is closed.
    sendGGPO(u8) {
      if (!gdc || gdc.readyState !== 'open') return false;
      try { gdc.send(u8); return true; } catch { return false; }
    },
    readGGPO() {
      if (gQueue.length > 0) return gQueue.shift();
      return (gdc || !isClosed) ? new Uint8Array(0) : null;
    },
    // Rollback round-trip time from the engine (shown in the overlay
    // header like any fighting game's ping counter).
    setPing(ms) {
      pingMs = ms;
      renderDiag();
    },
    // Engine-side diagnostic line onto the on-screen overlay (so handshake
    // progress is visible without opening the browser console).
    olog(msg) {
      netLog(msg);
    },
    close() {
      try { if (dc) dc.close(); } catch {}
      try { if (pc) pc.close(); } catch {}
      isClosed = true; isConnected = false;
      netLog('session closed');
      hidePanel();
      setTimeout(hideDiag, 8000); // leave the log up briefly after teardown
    },
  };
})();
