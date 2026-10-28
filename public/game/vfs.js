// Browser filesystem shim for Go's js/wasm runtime (syscall/fs_js.go).
//
// Go compiled to WASM expects a Node-style callback API on globalThis.fs.
// This implements that API over an HTTP-backed virtual filesystem:
// a manifest (path -> size) is fetched up front, file contents are lazily
// fetched the first time a file is opened, and writes (save/config.json,
// logs, replays) live in memory for the session.
//
// Must be loaded BEFORE wasm_exec.js so our fs/process win over its stubs.

(function () {
  'use strict';

  const S_IFDIR = 0o040000;
  const S_IFREG = 0o100000;

  const O_CREAT = 0o100;
  const O_TRUNC = 0o1000;
  const O_APPEND = 0o2000;
  const O_EXCL = 0o200;
  const O_WRONLY = 1;
  const O_RDWR = 2;

  function enoent(path) { const e = new Error('ENOENT: ' + path); e.code = 'ENOENT'; return e; }
  function ebadf() { const e = new Error('EBADF'); e.code = 'EBADF'; return e; }
  function einval(msg) { const e = new Error('EINVAL: ' + (msg || '')); e.code = 'EINVAL'; return e; }
  function enosysErr() { const e = new Error('ENOSYS'); e.code = 'ENOSYS'; return e; }

  // vpath ("data/system.snd") keyed stores
  const manifest = new Map();   // vpath -> size (remote, not yet fetched)
  // vpath -> size for files that came out of a .pak. Kept SEPARATE from
  // manifest because manifest means "not fetched yet" and drives the lazy
  // fetch path - packed files are already in contents and must never be
  // fetched. This exists purely so the Build ID can hash packed content:
  // without it the hash loop below iterates an empty map on every packed
  // build, and two builds with completely different rosters report the same
  // Build ID and desync in netplay.
  const packedIndex = new Map();
  const contents = new Map();   // vpath -> Uint8Array (fetched or written)
  const dirs = new Set(['']);   // known directory vpaths ('' = root)
  const fetching = new Map();   // vpath -> Promise<Uint8Array>

  // --- Save persistence -----------------------------------------------
  // Files the engine writes under save/ (key remaps, options, stats) are
  // mirrored into localStorage so they survive page reloads. Writes are
  // debounced per path; oversized files (replays) are skipped to respect
  // localStorage quotas.
  // Bumped when shipped defaults change in a way that should override
  // previously persisted saves (v2 -> v3: new default key layout;
  // v3 -> v4: gamepad JoystickConfig with C/Z on RT/RB;
  // v4 -> v5: readable DebugFont f-6x9;
  // v5 -> v6: V2 engine config.ini + 16:9 render resolution;
  // v10 -> v11: the theme is chosen in the Studio and lands in config.ini, so a
  // returning player's saved copy would pin them to the old screenpack. Bump
  // this whenever the shipped theme changes, or nobody who has played before
  // will see it - at the cost of resetting their key bindings).
  const PERSIST_PREFIX = 'engine-vfs12:';
  const PERSIST_MAX = 512 * 1024;
  const persistTimers = new Map();

  function persistable(vpath) {
    return vpath.startsWith('save/') && !vpath.startsWith('save/logs/');
  }

  function schedulePersist(vpath) {
    if (!persistable(vpath)) return;
    clearTimeout(persistTimers.get(vpath));
    persistTimers.set(vpath, setTimeout(() => {
      persistTimers.delete(vpath);
      try {
        const data = contents.get(vpath);
        if (!data) { localStorage.removeItem(PERSIST_PREFIX + vpath); return; }
        if (data.length > PERSIST_MAX) return;
        let bin = '';
        for (let i = 0; i < data.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
        }
        localStorage.setItem(PERSIST_PREFIX + vpath, btoa(bin));
        // The online-identity layer (identity.js) watches for PLAYER NAME
        // changes; config.ini persisting is the one reliable "the player
        // saved something in the options" signal available outside Lua.
        if (vpath === 'save/config.ini') {
          try { window.dispatchEvent(new CustomEvent('engine-config-persisted')); } catch (e2) { /* non-DOM host */ }
        }
      } catch (e) { /* quota exceeded etc. - saves just won't persist */ }
    }, 400));
  }

  function restorePersisted() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(PERSIST_PREFIX)) continue;
        const vpath = key.slice(PERSIST_PREFIX.length);
        const bin = atob(localStorage.getItem(key));
        const buf = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) buf[j] = bin.charCodeAt(j);
        contents.set(vpath, buf);
        manifest.delete(vpath);
        registerDirsFor(vpath);
      }
    } catch (e) { /* private browsing etc. */ }
  }

  function registerDirsFor(vpath) {
    const parts = vpath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  // Normalize an incoming absolute-ish path to a vpath.
  function norm(p) {
    p = String(p).replace(/\\/g, '/');
    // resolve . and .. segments
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return out.join('/');
  }

  function exists(vpath) {
    vpath = resolveDataAlias(vpath);
    return contents.has(vpath) || manifest.has(vpath) || dirs.has(vpath);
  }

  // Some engine paths arrive WITHOUT the data/ root: the lifebar [Files]
  // font paths are spelled "motif1/fonts/Timer.def" and the WASM build hands
  // them to the VFS verbatim, while the files actually live at
  // "data/motif1/fonts/..." (the sff/snd in the same section resolve against
  // the motif's own directory and never hit this). Unknown vpath + known
  // data/<vpath> => serve the aliased file instead of failing ENOENT, which
  // blanked every lifebar/menu font on the engine's own screens.
  function resolveDataAlias(vpath) {
    if (contents.has(vpath) || manifest.has(vpath) || dirs.has(vpath)) return vpath;
    // The packed build used to ship a byte-identical copy of the motif's
    // system.snd loose under data/ (md5 4125a458..., 3.51MB): nothing
    // references it - the motif resolves `snd = system.snd` relative to its
    // own directory - yet the lazy manifest fetched + retained it on EVERY
    // boot. It is no longer in the manifest (generate-pak.js excludes it);
    // alias any bare data/system.snd request to the motif copy that IS
    // shipped, so even a legacy/hypothetical open keeps working.
    if (vpath === 'data/system.snd' &&
        (manifest.has('data/motif1/system.snd') || contents.has('data/motif1/system.snd'))) {
      return 'data/motif1/system.snd';
    }
    if (vpath.startsWith('data/')) return vpath;
    const aliased = 'data/' + vpath;
    if (contents.has(aliased) || manifest.has(aliased) || dirs.has(aliased)) return aliased;
    return vpath;
  }
  function isDir(vpath) { return dirs.has(resolveDataAlias(vpath)); }
  function sizeOf(vpath) {
    vpath = resolveDataAlias(vpath);
    if (contents.has(vpath)) return contents.get(vpath).length;
    if (manifest.has(vpath)) return manifest.get(vpath);
    return 0;
  }

  function statFor(vpath) {
    const dir = isDir(vpath);
    const mode = dir ? (S_IFDIR | 0o755) : (S_IFREG | 0o644);
    const now = Date.now();
    return {
      dev: 1, ino: 1, mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size: sizeOf(vpath), blksize: 4096,
      blocks: Math.ceil(sizeOf(vpath) / 512),
      atimeMs: now, mtimeMs: now, ctimeMs: now,
      isDirectory() { return dir; },
      isFile() { return !dir; },
    };
  }

  async function fetchFile(vpath) {
    if (contents.has(vpath)) return contents.get(vpath);
    if (fetching.has(vpath)) return fetching.get(vpath);
    const p = (async () => {
      // Relative URL so the game works from any subfolder on a static host.
      // cache:'default' (NOT 'no-cache'): lazy URLs carry the per-export
      // ?v= stamp, so the immutable/long max-age cache headers can do their
      // job — 'no-cache' here used to force a revalidation round-trip for
      // every one of the ~70 warmup files on every single boot.
      const res = await fetch('./engine-fs/file/' + encodeURIComponent(vpath).replace(/%2F/gi, '/')
        + (globalThis.engineAssetStamp ? '?v=' + encodeURIComponent(globalThis.engineAssetStamp) : ''), { cache: 'default' });
      if (!res.ok) {
        // CRITICAL: on 404, remove from manifest so exists() returns false on
        // subsequent calls. Otherwise Go retries open() forever in a tight
        // microtask loop (each rejected Promise schedules another microtask),
        // blocking the main thread for seconds ("broken record" freeze).
        manifest.delete(vpath);
        throw enoent(vpath);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      contents.set(vpath, buf);
      return buf;
    })();
    fetching.set(vpath, p);
    // CRITICAL: clear the fetching entry even on failure. Without this, the
    // rejected promise stays cached, and every retry returns the same rejected
    // promise, creating an infinite microtask storm.
    p.catch(() => fetching.delete(vpath));
    return p;
  }

  // ---- fd table ----
  // fds 0/1/2 = stdin/stdout/stderr
  let nextFd = 3;
  const fds = new Map(); // fd -> { vpath, flags }

  const decoder = new TextDecoder();
  let stdoutBuf = '', stderrBuf = '';

  // ---- Engine output ring buffer + web-result marker ----
  // The web layer (play page) shows the engine's OWN last lines when the
  // engine dies, so a phone-side crash reports its reason ("Panic: ...")
  // instead of silently bouncing back to character select. Bounded: the
  // engine is chatty in debug mode.
  const engineLog = [];
  globalThis.__engineLog = engineLog; // string[], oldest first
  function emitEngineLine(line, isErr) {
    if (line.length) {
      // Match-result marker from main.lua (f_quickMatch): this engine build
      // has no js lua bridge, so the result rides stdout. Protocol-only:
      // parse it and keep it OUT of the console and the crash-report ring
      // buffer — it is machine output, never diagnostics.
      if (line.indexOf('__MATCH_RESULT ') === 0) {
        try {
          const kv = {};
          for (const p of line.slice('__MATCH_RESULT '.length).trim().split(/\s+/)) {
            const eq = p.indexOf('=');
            if (eq > 0) kv[p.slice(0, eq)] = p.slice(eq + 1);
          }
          const w = Number(kv.winner);
          globalThis.__engineMatchResult = {
            winner: (Number.isFinite(w) ? w : -1),
            mode: kv.mode || 'quickvs',
            p1: kv.p1 || 'kfm',
            p2: kv.p2 || 'kfm',
            stage: kv.stage || 'stages/stage0-720.def',
          };
        } catch (e) { /* diagnostics must never break the bridge */ }
        return;
      }
      engineLog.push(line);
      if (engineLog.length > 80) engineLog.splice(0, engineLog.length - 80);
    }
    (isErr ? console.warn : console.log)(line);
  }

  function writeStd(fd, chunk) {
    if (fd === 1) {
      stdoutBuf += chunk;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) { emitEngineLine(stdoutBuf.slice(0, i), false); stdoutBuf = stdoutBuf.slice(i + 1); }
    } else {
      stderrBuf += chunk;
      let i;
      while ((i = stderrBuf.indexOf('\n')) >= 0) { emitEngineLine(stderrBuf.slice(0, i), true); stderrBuf = stderrBuf.slice(i + 1); }
    }
  }

  // --- Expanded-stage view fit (the "black bars" fixes, generalized) -----
  // In the expanded display mode (marker '4:3' — the mode FORMERLY known as
  // 4:3; the user asked for "more stage can be seen", not 4:3) the engine
  // renders the fight at a 1280x720 framebuffer with FightAspect=16,9.
  // applyFightAspect makes the world 240*(16/9) x 240 units and width-fits
  // the stage's localcoord into it, so the view spans localcoordW stage
  // units wide and localcoordW*9/16 tall — for an unpatched 16:9-designed
  // stage that is exactly the design area (the plain 16:9 picture). The fit
  // rewrite WIDENS the design box so the view covers the stage's full
  // PAINTED art — the user's ask: "expand horizontally, see more of the
  // stage, without seeing out of bounds black bars". Done at the VFS
  // serving layer (no WASM rebuild), exactly like a stage author porting
  // their stage:
  //
  //   scl      = GameWidth / localcoordW            (1280 / localcoordW)
  //   viewH    = GameHeight / scl = localcoordW * 9/16
  //   targetW  = (localcoordH + overdrawhigh) * 16/9
  //            -> the fitted view is design height + declared sky headroom
  //               tall (the SAME vertical fit the fitted-4:3 era shipped)
  //   artHalf  = localcoordW/2 + |boundleft|, per side — the roster
  //             generator matches the pan bounds to the painted art, so
  //             the art extends to ±(designW/2 + |boundleft|): 836u on
  //             EVERY roster stage (544+292, 640+196, 448+388), vs a 544u
  //             design half-width. A missing side is assumed to end at the
  //             design edge (conservative).
  //   fitW     = min(targetW, 2*min(artLeft, artRight))
  //            -> never widen the view past the painted art
  //   overdrawlow = 0 -> the fitted extra height lands entirely ABOVE the
  //                      design, never below its bottom edge
  //   boundhigh = -max(0, round(overdrawhigh - (fitW*9/16 - localcoordH)))
  //            -> 0 by construction on roster stages: the fitted view
  //               already tops out at the declared sky, so any up-pan
  //               would expose black
  //   boundleft/right -> ±floor(artHalf - fitW/2): the wider view pans
  //               LESS, and its edges stay inside the painted art at every
  //               pan position (at max pan the edge sits 0.5u inside the
  //               art boundary). Only ever tightens.
  //
  // Roster numbers (1088x612 + overdrawhigh 120 stages): localcoord
  // 1088 -> 1301, view 1301 x ~732u (design 612u + sky 120u tall — the
  // SAME vertical fit the user approved in the fitted 4:3 mode — and 213u
  // more horizontal stage than the 16:9 design, ~107u more painted world
  // per side than the old fitted 4:3 window's 976u), pan bounds
  // ±292 -> ±185, boundhigh -328 -> 0. The canvas is a plain 16:9 1280x720:
  // it fills a 16:9 screen edge-to-edge with NO pillarbox (the fitted 4:3
  // mode pillarboxed).
  //
  // Effects, all deterministic from the def text (online-safe: both peers
  // patch identically): zero black at rest, while panning, and at zoom-out
  // (the engine's MinZoomScale floors the zoom-out at exactly 1.0 — the
  // fitted rest view IS the maximal paintable view). Because that floor
  // pins the camera, the fit ALSO installs an explicit autozoom package
  // with a zoom-IN ceiling (autozoom=1, zoomin=1.2 — see Step 4): the
  // camera leans in on close action and pulls back to the full fitted view
  // as the players separate, so stage zoom is alive in every fitted mode
  // instead of only 16:9. The stage renders at the same ~0.98 px/stage-unit
  // scale the fitted 4:3 mode had; characters keep their exact on-screen
  // size (their scale follows the 240-unit world height — identical across
  // every mode). Never applied in 16:9 — that path stays byte-identical.
  //
  // Constraints honored: a stage is only ever widened up to its painted
  // art — a stage whose art ends at its design (no pan bounds, or bounds
  // so tight the cap binds at the design width) falls through UNTOUCHED
  // (legacy 320x240-family stages without pan art keep their historical
  // behavior), while legacy stages WITH generous pan art get the full fit
  // (their view keeps the full design height instead of cropping);
  // integer outputs only (the engine parses these keys with ReadI32);
  // idempotent by construction (a fitted def re-parses to the same
  // fitW/odl/pan budget/art-half and rewrites nothing).
  // null = no fit (the 16:9 default path stays byte-identical), 'expanded'
  // = the EXPANDED STAGE VIEW (16:9 full-bleed max view), 'tall' = the TALL
  // STAGE VIEW (the restored classic fitted-4:3 window), '3:2' = the WIDE
  // STAGE VIEW (the fitted ladder's middle rung), '14:9' / '5:3' = the two
  // WIDER ladder rungs between 3:2 and Expanded. All fitted modes share
  // the exact same fit math — only the canvas aspect differs. Flips
  // mid-session via online display-mode adoption.
  let stageFitMode = null;
  function setStageFitMode(v) {
    stageFitMode = v;
  }
  // Byte-faithful latin1 round-trip: stage defs are ASCII keys but often
  // carry cp1252 bytes in comments/names, and TextDecoder('utf-8') would
  // silently replace those (displayname mangling). charCodeAt/ff keeps
  // every original byte exactly.
  function bytesToLatin1(buf) {
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return s;
  }
  function latin1ToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  // Stage-fit render geometry per mode — MUST match the presets in
  // src/lib/engine-config.ts (DISPLAY_MODE_PRESETS). 'expanded' is the
  // historical '4:3' key/marker/mode-string (a 1280x720 canvas,
  // FightAspect=16,9); 'tall' is the restored classic 4:3 stage view (a
  // 960x720 canvas, FightAspect=4,3 — the geometry the fitted-4:3 era
  // shipped and the user approved); '3:2' is the WIDE STAGE VIEW (a
  // 1080x720 canvas, FightAspect=3,2 — the ladder's middle rung, verified
  // against upstream applyFightAspect which accepts any integer pair);
  // '14:9' is the WIDER STAGE VIEW (a 1120x720 canvas, FightAspect=14,9)
  // and '5:3' the WIDEST FITTED STAGE VIEW (a 1200x720 canvas,
  // FightAspect=5,3) — the rungs between 3:2 and Expanded (both canvas
  // widths are exact integers at the uniform 3.0 render scale:
  // 1120 = 720*14/9, 1200 = 720*5/3).
  // All modes fit the view to the stage's painted art with the SAME
  // math — only the canvas aspect differs.
  const STAGE_FIT_MODES = {
    expanded: { gamew: 1280, gameh: 720, legacyGate: false,
      fitLabel: 'expanded view fit', clampLabel: 'expanded camera clamp', panLabel: 'expanded pan clamp', zoomLabel: 'expanded stage zoom' },
    tall:     { gamew: 960,  gameh: 720, legacyGate: true,
      fitLabel: 'tall view fit',     clampLabel: 'tall camera clamp',     panLabel: 'tall pan clamp',     zoomLabel: 'tall stage zoom' },
    '3:2':    { gamew: 1080, gameh: 720, legacyGate: false,
      fitLabel: '3:2 view fit',      clampLabel: '3:2 camera clamp',      panLabel: '3:2 pan clamp',      zoomLabel: '3:2 stage zoom' },
    '14:9':   { gamew: 1120, gameh: 720, legacyGate: false,
      fitLabel: '14:9 view fit',     clampLabel: '14:9 camera clamp',     panLabel: '14:9 pan clamp',     zoomLabel: '14:9 stage zoom' },
    '5:3':    { gamew: 1200, gameh: 720, legacyGate: false,
      fitLabel: '5:3 view fit',      clampLabel: '5:3 camera clamp',      panLabel: '5:3 pan clamp',      zoomLabel: '5:3 stage zoom' },
  };
  const STAGE_FIT_DEF_RE = /^(?:data\/)?stages\/[^/]*\.def$/i;
  // Re-runs on every open (no memo): the rewrites are idempotent (a fitted
  // def re-parses to the same fitW / overdrawlow=0 / pan budget / art-half
  // and changes nothing), and a background prefetch may legitimately
  // re-materialize the ORIGINAL bytes into `contents` after the first
  // patch - a later open must re-patch them. The scan cost is a ~10-40KB
  // text regex, once per stage per open.
  function patchStageDefFit(vpath) {
    const fit = stageFitMode ? STAGE_FIT_MODES[stageFitMode] : null;
    if (!fit || !STAGE_FIT_DEF_RE.test(vpath)) return;
    const buf = contents.get(vpath);
    if (!buf) return; // not materialized yet - retried on the next open
    try {
      const text = bytesToLatin1(buf);
      const sectionBody = (name) => {
        const m = new RegExp('\\[' + name + '\\]([^\\[]*)', 'i').exec(text);
        return m ? m[1] : '';
      };
      const num = (src, key) => {
        const m = new RegExp('^\\s*' + key + '\\s*=\\s*(-?\\d+(?:\\.\\d+)?)', 'im').exec(src);
        return m ? parseFloat(m[1]) : null;
      };
      const cam = sectionBody('Camera');
      const lc = /^\s*localcoord\s*=\s*(\d+)\s*,\s*(\d+)/im.exec(sectionBody('StageInfo'));
      if (!lc) return; // unknown geometry
      const localW = +lc[1], localH = +lc[2];
      // Tall-mode legacy gate (the fitted-4:3 era rule): stages whose 4:3
      // view does not exceed the design height fit natively and are left
      // untouched (legacy 320x240-family stages keep their historical look).
      if (fit.legacyGate && !(localW * fit.gameh / fit.gamew > localH)) return;
      const odh = Math.max(0, num(cam, 'overdrawhigh') || 0);
      // Painted-art half-width per side, derived from the pan bounds (the
      // roster generator matches bounds to art). A missing side assumes
      // that side's art ends at the design edge (conservative).
      const bl = num(cam, 'boundleft');
      const br = num(cam, 'boundright');
      const artLeft = localW / 2 + (bl !== null ? Math.max(0, -bl) : 0);
      const artRight = localW / 2 + (br !== null ? Math.max(0, br) : 0);
      // The view is localcoordW*GameH/GameW stage-units tall at zoom 1;
      // widen the design box so it becomes design height + declared sky,
      // capped at the painted art width.
      const heightToWidth = fit.gamew / fit.gameh; // 16/9 expanded, 4/3 tall
      const targetW = Math.round((localH + odh) * heightToWidth);
      const artCap = Math.floor(2 * Math.min(artLeft, artRight));
      const fitW = Math.min(targetW, artCap);
      if (fitW === localW) return; // nothing to fit (incl. already-fitted defs)
      let patchedText = text;

      // Step 1 - fit the view to the stage's painted art: widen the design
      // box to design height + declared sky headroom (capped at the art)
      // and zero overdrawlow so the whole extra height lands above the
      // design, never below its bottom edge.
      const next1 = patchedText.replace(
        /^(\s*localcoord\s*=\s*)(\d+)(\s*,\s*\d+)/im,
        (m, p1, p2, p3) => p1 + String(fitW) + p3
      );
      if (next1 !== patchedText) {
        patchedText = next1;
        console.log('[vfs] ' + fit.fitLabel + ': ' + vpath + ' localcoord ' + localW + ' -> ' + fitW
          + ' (view ' + Math.round(fitW * fit.gameh / fit.gamew) + 'u tall = design ' + localH
          + 'u + declared sky ' + Math.round(odh) + 'u; the 16:9 design was ' + localW + 'u wide)');
      }
      if (/^\s*overdrawlow\s*=\s*/im.test(patchedText)) {
        const next = patchedText.replace(
          /^(\s*overdrawlow\s*=\s*)-?\d+(?:\.\d+)?/im,
          (m, p1) => p1 + '0'
        );
        if (next !== patchedText) patchedText = next;
      }

      // Step 2 - pan ceiling, recomputed for the fitted view: the window now
      // tops out exactly at the declared sky headroom, so the remaining
      // up-pan budget collapses to zero on roster stages. Only ever
      // tightens the effective pan.
      const bh = num(cam, 'boundhigh');
      if (bh !== null) {
        const missingU2 = fitW * fit.gameh / fit.gamew - localH;
        const panBudget = Math.max(0, Math.round(odh - missingU2));
        if (-Math.min(bh, 0) > panBudget + 0.01) {
          const next = patchedText.replace(
            /^(\s*boundhigh\s*=\s*)(-?\d+(?:\.\d+)?)/im,
            (m, p1) => p1 + String(-panBudget)
          );
          if (next !== patchedText) {
            patchedText = next;
            console.log('[vfs] ' + fit.clampLabel + ': ' + vpath + ' boundhigh ' + bh + ' -> ' + (-panBudget)
              + ' (fitted view tops out at the declared sky headroom)');
          }
        }
      }

      // Step 3 - horizontal pan limits, recomputed for the wider view: the
      // camera may only pan until the view edge reaches the painted art
      // boundary (the view is fitW wide; the art spans ±artHalf). Only
      // ever tightens — the wider view needs less pan for the same world.
      if (bl !== null) {
        const newBL = -Math.max(0, Math.floor(artLeft - fitW / 2));
        if (newBL > bl) {
          const next = patchedText.replace(
            /^(\s*boundleft\s*=\s*)(-?\d+(?:\.\d+)?)/im,
            (m, p1) => p1 + String(newBL)
          );
          if (next !== patchedText) {
            patchedText = next;
            console.log('[vfs] ' + fit.panLabel + ': ' + vpath + ' boundleft ' + bl + ' -> ' + newBL
              + ' (the wider view must stay inside the painted art)');
          }
        }
      }
      if (br !== null) {
        const newBR = Math.max(0, Math.floor(artRight - fitW / 2));
        if (newBR < br) {
          const next = patchedText.replace(
            /^(\s*boundright\s*=\s*)(-?\d+(?:\.\d+)?)/im,
            (m, p1) => p1 + String(newBR)
          );
          if (next !== patchedText) {
            patchedText = next;
            console.log('[vfs] ' + fit.panLabel + ': ' + vpath + ' boundright ' + br + ' -> ' + newBR
              + ' (the wider view must stay inside the painted art)');
          }
        }
      }

      // Step 4 - stage zoom. The fitted rest view IS the maximal paintable
      // view, so the engine's MinZoomScale floors the zoom-out at exactly
      // 1.0 AND the autozoom package's zoom-in ceiling is 1.0 — the camera
      // range collapses to [1.0, 1.0] and stage zoom looked dead in every
      // fitted mode (16:9 keeps its native zoom-out reveal because its
      // bounds leave sky headroom under the art ceiling). Fix: install an
      // explicit autozoom package with a zoom-IN ceiling (zoomin 1.2) —
      // the camera leans in while the fighters are close and pulls all the
      // way back to the full fitted view as they separate. zoomout stays
      // absent so the engine's autozoom branch fills LegacyZoomMin, whose
      // target is floored at the fit by MinZoomScale (zero black-bar risk:
      // a zoomed-in view is a strict SUBSET of the fitted view). Respects
      // authors: a def that already carries an autozoom key or a zoomin
      // value is left untouched. Idempotent — the inserted autozoom key
      // makes this gate false on re-runs.
      if (!/^\s*autozoom\s*=/im.test(cam) && num(cam, 'zoomin') === null) {
        const head = /(\[Camera\][ \t]*\r?\n)/i.exec(patchedText);
        if (head) {
          const eol = head[1].endsWith('\r\n') ? '\r\n' : '\n';
          patchedText = patchedText.replace(
            /(\[Camera\][ \t]*\r?\n)/i,
            (m) => m + 'autozoom = 1' + eol + 'zoomin = 1.2' + eol
          );
          console.log('[vfs] ' + fit.zoomLabel + ': ' + vpath
            + ' autozoom = 1, zoomin = 1.2 (camera leans in on close action;'
            + ' pulls back to the full fitted view as the players separate)');
        }
      }

      if (patchedText !== text) contents.set(vpath, latin1ToBytes(patchedText));
    } catch (e) { /* an unparseable def must never break the fight */ }
  }

  const vfs = {
    constants: {
      O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL, O_DIRECTORY: 0o200000,
    },

    open(path, flags, mode, callback) {
      let vpath = resolveDataAlias(norm(path));
      const creating = (flags & O_CREAT) !== 0;
      if (!exists(vpath) && !creating) { callback(enoent(vpath)); return; }
      if (isDir(vpath)) {
        const fd = nextFd++;
        fds.set(fd, { vpath, flags, dir: true });
        callback(null, fd);
        return;
      }
      const finish = () => {
        if (creating && (!exists(vpath) || (flags & O_TRUNC))) {
          contents.set(vpath, new Uint8Array(0));
          manifest.delete(vpath);
          registerDirsFor(vpath);
        }
        // Stage fit (see patchStageDefFit): runs here because every serving
        // path - pak materialization, CDN fetch, direct injection - has
        // populated `contents` by the time the engine opens the file.
        patchStageDefFit(vpath);
        const fd = nextFd++;
        fds.set(fd, { vpath, flags });
        callback(null, fd);
      };
      if (!contents.has(vpath) && manifest.has(vpath) && !(flags & O_TRUNC)) {
        fetchFile(vpath).then(finish, err => callback(err));
      } else {
        finish();
      }
    },

    close(fd, callback) {
      if (!fds.has(fd)) { callback(ebadf()); return; }
      fds.delete(fd);
      callback(null);
    },

    read(fd, buffer, offset, length, position, callback) {
      const f = fds.get(fd);
      if (!f) { callback(ebadf()); return; }
      const data = contents.get(f.vpath);
      if (!data) { callback(enoent(f.vpath)); return; }
      const pos = (position === null || position === undefined) ? (f.pos || 0) : position;
      const n = Math.max(0, Math.min(length, data.length - pos));
      if (n > 0) buffer.set(data.subarray(pos, pos + n), offset);
      if (position === null || position === undefined) f.pos = pos + n;
      callback(null, n);
    },

    write(fd, buf, offset, length, position, callback) {
      if (fd === 1 || fd === 2) {
        writeStd(fd, decoder.decode(buf.subarray(offset, offset + length)));
        callback(null, length);
        return;
      }
      const f = fds.get(fd);
      if (!f) { callback(ebadf()); return; }
      let data = contents.get(f.vpath) || new Uint8Array(0);
      let pos;
      if (f.flags & O_APPEND) pos = data.length;
      else pos = (position === null || position === undefined) ? (f.pos || 0) : position;
      if (pos + length > data.length) {
        const grown = new Uint8Array(pos + length);
        grown.set(data);
        data = grown;
      }
      data.set(buf.subarray(offset, offset + length), pos);
      contents.set(f.vpath, data);
      manifest.delete(f.vpath);
      schedulePersist(f.vpath);
      if (position === null || position === undefined) f.pos = pos + length;
      callback(null, length);
    },

    fstat(fd, callback) {
      const f = fds.get(fd);
      if (!f) { callback(ebadf()); return; }
      callback(null, statFor(f.vpath));
    },
    stat(path, callback) {
      const vpath = norm(path);
      if (!exists(vpath)) { callback(enoent(vpath)); return; }
      callback(null, statFor(vpath));
    },
    lstat(path, callback) { vfs.stat(path, callback); },

    readdir(path, callback) {
      const vpath = norm(path);
      if (!isDir(vpath)) { callback(enoent(vpath)); return; }
      const prefix = vpath === '' ? '' : vpath + '/';
      const names = new Set();
      const collect = (p) => {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (rest) names.add(rest.split('/')[0]);
        }
      };
      for (const p of manifest.keys()) collect(p);
      for (const p of contents.keys()) collect(p);
      for (const d of dirs) collect(d);
      callback(null, Array.from(names));
    },

    mkdir(path, perm, callback) {
      const vpath = norm(path);
      dirs.add(vpath);
      registerDirsFor(vpath + '/x');
      callback(null);
    },
    rmdir(path, callback) { dirs.delete(norm(path)); callback(null); },
    unlink(path, callback) {
      const vpath = norm(path);
      if (!exists(vpath)) { callback(enoent(vpath)); return; }
      contents.delete(vpath); manifest.delete(vpath);
      schedulePersist(vpath);
      callback(null);
    },
    rename(from, to, callback) {
      const vf = norm(from), vt = norm(to);
      if (contents.has(vf)) {
        contents.set(vt, contents.get(vf)); contents.delete(vf); registerDirsFor(vt);
        schedulePersist(vf); schedulePersist(vt);
        callback(null); return;
      }
      if (manifest.has(vf)) {
        fetchFile(vf).then(buf => {
          contents.set(vt, buf); contents.delete(vf); manifest.delete(vf);
          registerDirsFor(vt);
          schedulePersist(vf); schedulePersist(vt);
          callback(null);
        }, callback);
        return;
      }
      callback(enoent(vf));
    },
    truncate(path, length, callback) {
      const vpath = norm(path);
      const doTrunc = (buf) => {
        const out = new Uint8Array(length);
        out.set(buf.subarray(0, Math.min(length, buf.length)));
        contents.set(vpath, out); manifest.delete(vpath);
        schedulePersist(vpath);
        callback(null);
      };
      if (contents.has(vpath)) doTrunc(contents.get(vpath));
      else if (manifest.has(vpath)) fetchFile(vpath).then(doTrunc, callback);
      else callback(enoent(vpath));
    },
    ftruncate(fd, length, callback) {
      const f = fds.get(fd);
      if (!f) { callback(ebadf()); return; }
      vfs.truncate(f.vpath, length, callback);
    },
    fsync(fd, callback) { callback(null); },
    utimes(path, atime, mtime, callback) { callback(null); },
    chmod(path, mode, callback) { callback(null); },
    fchmod(fd, mode, callback) { callback(null); },
    chown(path, uid, gid, callback) { callback(null); },
    fchown(fd, uid, gid, callback) { callback(null); },
    lchown(path, uid, gid, callback) { callback(null); },
    link(path, link, callback) { callback(enosysErr()); },
    symlink(path, link, callback) { callback(enosysErr()); },
    readlink(path, callback) { callback(enosysErr()); },
    // Non-callback sync write used by wasm_exec.js for stdout/stderr fallback
    writeSync(fd, buf) {
      writeStd(fd, decoder.decode(buf));
      return buf.length;
    },
  };

  globalThis.fs = vfs;

  let cwd = '/';
  globalThis.process = {
    getuid() { return 0; },
    getgid() { return 0; },
    geteuid() { return 0; },
    getegid() { return 0; },
    getgroups() { return [0]; },
    pid: 1,
    ppid: 0,
    umask() { return 0o22; },
    cwd() { return cwd; },
    chdir(dir) { cwd = dir; },
  };

  globalThis.path = {
    resolve(...parts) {
      let joined = parts.filter(Boolean).join('/');
      if (!joined.startsWith('/')) joined = cwd.replace(/\/$/, '') + '/' + joined;
      return '/' + norm(joined);
    },
  };

  // Debug access to the in-memory filesystem (e.g. reading the engine's
  // debug dumps, which are "written" only to browser memory).
  globalThis.__vfsDebug = {
    list(prefix = '') {
      return [...contents.keys()].filter(p => p.startsWith(prefix));
    },
    read(vpath) {
      const buf = contents.get(vpath);
      return buf ? new TextDecoder().decode(buf) : null;
    },
  };

  // --- CDN asset injection (Phase 2) ---------------------------------
  // Injects files downloaded from jsDelivr CDN directly into the in-memory
  // VFS before the engine boots. Used for characters/stages that aren't
  // bundled in game.pak. Must be called AFTER engineVfsInit completes.
  globalThis.engineInjectFile = function (vpath, u8) {
    const buf = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    contents.set(vpath, buf);
    manifest.set(vpath, buf.length);
    packedIndex.set(vpath, buf.length);
    registerDirsFor(vpath);
  };

  // Check if a file is already in the VFS (from .pak or injected)
  globalThis.engineHasFile = function (vpath) {
    return contents.has(vpath) || manifest.has(vpath) || packedIndex.has(vpath);
  };

  // --- Online display-mode sync (host-authoritative) ------------------
  // The engine's netplay handshake refuses peers whose EFFECTIVE FIGHT
  // ASPECT differs ("effective fight aspect differs (local=... remote=...)",
  // engine validateStrictCompatibility): render-resolution differences are
  // normalized away, but a preset FightAspect (the expanded display mode's
  // FightAspect=16,9 -> the "custom:..." flavor of the aspect string)
  // genuinely differs from the stage-default path (FightAspect=-1,-1 ->
  // "stage"). An expanded-mode host paired with a 16:9 guest — e.g. PC in
  // expanded vs phone on the default — would exit the engine before the
  // fight started ("ENGINE EXITED BEFORE THE FIGHT STARTED").
  //
  // The website online flow carries the HOST's display mode in the 'go'
  // control frame; the GUEST applies it to the in-memory save/config.ini
  // here, before the engine boots. Host-authoritative, mirroring the
  // engine's own sync:"host" settings convention.
  //
  // This applies the SAME rule as the boot migration above, but post-init
  // and in-memory only: the device's own display-mode marker and persisted
  // config are untouched. The next local boot migrates from the device's
  // own marker again, so an adopted mode never leaks into local play.
  // Returns the applied mode, or null when there was nothing to apply
  // (no config file / unknown mode).
  globalThis.engineApplyDisplayMode = function (mode) {
    try {
      if (mode !== '4:3' && mode !== '16:9' && mode !== 'tall' && mode !== '3:2' && mode !== '14:9' && mode !== '5:3') return null;
      const cfg = contents.get('save/config.ini');
      if (!cfg) return null;
      let text = new TextDecoder().decode(cfg);
      let changed = false;
      // Same align-or-insert primitive the boot migration uses.
      const ensureKey = (key, val, section) => {
        const re = new RegExp('^\\s*' + key + '\\s*=.*$', 'mi');
        if (re.test(text)) {
          const cur = new RegExp('^\\s*' + key + '\\s*=\\s*(-?\\d+)\\s*$', 'mi').exec(text);
          if (!cur || cur[1] !== String(val)) {
            text = text.replace(re, key.padEnd(20) + '= ' + val);
            changed = true;
          }
          return;
        }
        const secRe = new RegExp('^\\[' + section + '\\]\\s*$', 'mi');
        if (secRe.test(text)) {
          text = text.replace(secRe, (m) => m + '\n' + key.padEnd(20) + '= ' + val);
        } else {
          text += '\n[' + section + ']\n' + key.padEnd(20) + '= ' + val + '\n';
        }
        changed = true;
      };
      if (mode === '4:3') {
        // The EXPANDED STAGE VIEW — exactly what the boot migration writes
        // for the '4:3' marker (same preset as the Settings UI): a 1280x720
        // canvas + FightAspect=16,9 + the vfs stage fit.
        ensureKey('GameWidth', 1280, 'Video');
        ensureKey('GameHeight', 720, 'Video');
        ensureKey('FightAspectWidth', 16, 'Video');
        ensureKey('FightAspectHeight', 9, 'Video');
        ensureKey('KeepAspect', 1, 'Video');
      } else if (mode === 'tall') {
        // The TALL STAGE VIEW — exactly what the boot migration writes for
        // the 'tall' marker: a 960x720 canvas + FightAspect=4,3 + KeepAspect
        // + the vfs stage fit (the classic fitted-4:3 geometry).
        ensureKey('GameWidth', 960, 'Video');
        ensureKey('GameHeight', 720, 'Video');
        ensureKey('FightAspectWidth', 4, 'Video');
        ensureKey('FightAspectHeight', 3, 'Video');
        ensureKey('KeepAspect', 1, 'Video');
      } else if (mode === '3:2') {
        // The WIDE STAGE VIEW — exactly what the boot migration writes for
        // the '3:2' marker: a 1080x720 canvas + FightAspect=3,2 +
        // KeepAspect + the vfs stage fit (the fitted ladder's middle
        // rung: same vertical art as Tall/Expanded, window between them).
        ensureKey('GameWidth', 1080, 'Video');
        ensureKey('GameHeight', 720, 'Video');
        ensureKey('FightAspectWidth', 3, 'Video');
        ensureKey('FightAspectHeight', 2, 'Video');
        ensureKey('KeepAspect', 1, 'Video');
      } else if (mode === '14:9') {
        // The WIDER STAGE VIEW — exactly what the boot migration writes
        // for the '14:9' marker: a 1120x720 canvas + FightAspect=14,9 +
        // KeepAspect + the vfs stage fit (a fitted-ladder rung between
        // 3:2 and 5:3: same vertical art as every fitted mode, wider
        // window).
        ensureKey('GameWidth', 1120, 'Video');
        ensureKey('GameHeight', 720, 'Video');
        ensureKey('FightAspectWidth', 14, 'Video');
        ensureKey('FightAspectHeight', 9, 'Video');
        ensureKey('KeepAspect', 1, 'Video');
      } else if (mode === '5:3') {
        // The WIDEST FITTED STAGE VIEW — exactly what the boot migration
        // writes for the '5:3' marker: a 1200x720 canvas +
        // FightAspect=5,3 + KeepAspect + the vfs stage fit (the ladder
        // rung just below Expanded).
        ensureKey('GameWidth', 1200, 'Video');
        ensureKey('GameHeight', 720, 'Video');
        ensureKey('FightAspectWidth', 5, 'Video');
        ensureKey('FightAspectHeight', 3, 'Video');
        ensureKey('KeepAspect', 1, 'Video');
      } else {
        // 16:9 = stage-default fight aspect.
        ensureKey('FightAspectWidth', -1, 'Video');
        ensureKey('FightAspectHeight', -1, 'Video');
        // A 4:3 / 3:2 / 14:9 / 5:3 canvas letterboxes a 16:9 fight inside
        // itself (KeepAspect=1) — bump such orphaned canvases to 1280x720
        // so the adopted 16:9 fills it edge-to-edge. Any other resolution
        // is kept.
        const gw = /^\s*GameWidth\s*=\s*(\d+)\s*$/mi.exec(text);
        const gh = /^\s*GameHeight\s*=\s*(\d+)\s*$/mi.exec(text);
        const ratio = gw && gh ? +gw[1] / +gh[1] : 0;
        if (gw && gh && (Math.abs(ratio - 4 / 3) < 0.01 || Math.abs(ratio - 3 / 2) < 0.01
          || Math.abs(ratio - 14 / 9) < 0.01 || Math.abs(ratio - 5 / 3) < 0.01)) {
          ensureKey('GameWidth', 1280, 'Video');
          ensureKey('GameHeight', 720, 'Video');
        }
      }
      if (changed) {
        globalThis.engineInjectFile('save/config.ini', new TextEncoder().encode(text));
      }
      // The adopted host mode also gates the stage fit, so host and guest
      // patch the same stage defs identically.
      setStageFitMode(mode === '4:3' ? 'expanded' : (mode === 'tall' ? 'tall' : (mode === '3:2' ? '3:2' : (mode === '14:9' ? '14:9' : (mode === '5:3' ? '5:3' : null)))));
      return mode;
    } catch (e) {
      return null;
    }
  };

  // --- Mods overlay (in-browser modding) ------------------------------
  // User-added files live in IndexedDB and are layered ON TOP of game.pak at
  // load, so a browser-only build (e.g. on itch.io, no server) can gain
  // characters/stages/music/select.def edits with nothing but browser storage.
  // An empty overlay is a no-op - the shipped game boots identically.
  const MODS_DB = 'engine-mods', MODS_DB_LEGACY = 'ikemen-mods', MODS_STORE = 'files';
  let modsMigrated = false;
  function openModsDB() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(MODS_DB, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => { req.result.createObjectStore(MODS_STORE); };
      req.onsuccess = async () => {
        const db = req.result;
        // One-time carry-over from the pre-rename database so returning
        // players keep their Mod Studio files. Never blocks the boot path.
        if (!modsMigrated) {
          modsMigrated = true;
          try {
            const old = await new Promise((res) => {
              let r;
              try { r = indexedDB.open(MODS_DB_LEGACY, 1); } catch (e2) { return res(null); }
              r.onupgradeneeded = () => { r.result.createObjectStore(MODS_STORE); };
              r.onsuccess = () => res(r.result);
              r.onerror = () => res(null);
            });
            if (old) {
              const rows = await new Promise((res) => {
                const out = [];
                let cur;
                try { cur = old.transaction(MODS_STORE, 'readonly').objectStore(MODS_STORE).openCursor(); }
                catch (e2) { return res(out); }
                cur.onsuccess = () => {
                  const c = cur.result;
                  if (!c) return res(out);
                  out.push([c.key, c.value]);
                  c.continue();
                };
                cur.onerror = () => res(out);
              });
              if (rows.length) {
                await new Promise((res) => {
                  const tx = db.transaction(MODS_STORE, 'readwrite');
                  const st = tx.objectStore(MODS_STORE);
                  for (const [k, v] of rows) st.put(v instanceof Uint8Array ? v : new Uint8Array(v), k);
                  tx.oncomplete = res;
                  tx.onerror = res;
                });
                console.log('[vfs] carried over ' + rows.length + ' mod file(s) from previous storage');
              }
              try { old.close(); indexedDB.deleteDatabase(MODS_DB_LEGACY); } catch (e2) { /* sweep next boot */ }
            }
          } catch (e) { /* storage best-effort */ }
        }
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }
  // Load every overlay file into the live filesystem, overriding pak entries.
  // Overlay vpaths loaded this boot - folded into the Build ID so browser
  // mods change it (and mismatched mods refuse a netplay match up front).
  const overlayPaths = [];
  async function loadModsOverlay() {
    let db;
    try { db = await openModsDB(); } catch (e) { return 0; }
    return await new Promise((resolve) => {
      let n = 0;
      let cursor;
      try { cursor = db.transaction(MODS_STORE, 'readonly').objectStore(MODS_STORE).openCursor(); }
      catch (e) { return resolve(0); }
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (!cur) { resolve(n); return; }
        const data = cur.value;
        if (data) {
          contents.set(cur.key, data instanceof Uint8Array ? data : new Uint8Array(data));
          manifest.delete(cur.key);
          registerDirsFor(cur.key);
          overlayPaths.push(cur.key);
          n++;
        }
        cur.continue();
      };
      cursor.onerror = () => resolve(n);
    });
  }
  // Async API for a client-side Mod Studio to manage the overlay.
  globalThis.engineMods = {
    async add(vpath, u8) {
      const db = await openModsDB();
      return new Promise((res, rej) => {
        const tx = db.transaction(MODS_STORE, 'readwrite');
        tx.objectStore(MODS_STORE).put(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8), vpath);
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
    },
    async get(vpath) {
      const db = await openModsDB();
      return new Promise((res) => {
        const req = db.transaction(MODS_STORE, 'readonly').objectStore(MODS_STORE).get(vpath);
        req.onsuccess = () => res(req.result ? new Uint8Array(req.result) : null);
        req.onerror = () => res(null);
      });
    },
    async remove(vpath) {
      const db = await openModsDB();
      return new Promise((res, rej) => {
        const tx = db.transaction(MODS_STORE, 'readwrite');
        tx.objectStore(MODS_STORE).delete(vpath);
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
    },
    async list() {
      const db = await openModsDB();
      return new Promise((res) => {
        const req = db.transaction(MODS_STORE, 'readonly').objectStore(MODS_STORE).getAllKeys();
        req.onsuccess = () => res(req.result || []); req.onerror = () => res([]);
      });
    },
    async clear() {
      const db = await openModsDB();
      return new Promise((res, rej) => {
        const tx = db.transaction(MODS_STORE, 'readwrite');
        tx.objectStore(MODS_STORE).clear();
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
    },
  };

  // Called by the boot page before starting the wasm module.
  // Two manifest formats:
  //   { files: { vpath: size } }               - per-file lazy HTTP fetch
  //   { pack: 'game.pak',
  //     files: { vpath: [offset, length] } }   - single pack file, fetched
  //                                              once up front (itch.io mode)
  globalThis.engineVfsInit = async function (manifestUrl, preloadList = [], onProgress, prefetched) {
    // The manifest is fetched with no-store (never reuse ANY cached copy -
    // 'no-cache' revalidation proved insufficient in the field: one player
    // needed incognito mode to see a new build), and the big assets carry
    // the manifest's per-export stamp as ?v=, so their URLs change with
    // every export and no cache layer can serve yesterday's pak.
    // The boot page may pass `prefetched` (the same JSON it also uses to
    // stamp the wasm URL) so one manifest fetch serves both.
    const data = prefetched || await (await fetch(manifestUrl, { cache: 'no-store' })).json();
    const stamp = data.stamp ? '?v=' + encodeURIComponent(data.stamp) : '';
    globalThis.engineAssetStamp = data.stamp || '';

    if (data.pack) {
      // Expected pak size straight from the manifest (max end offset). This
      // is the DECOMPRESSED size: it doubles as an accurate progress total
      // and lets us decompress straight into ONE preallocated buffer — the
      // old chunk-list + concat pass transiently held the whole pak twice.
      let pakSize = 0;
      for (const [, [off, len]] of Object.entries(data.files)) {
        const end = off + len;
        if (end > pakSize) pakSize = end;
      }
      const pakBase = manifestUrl.replace(/manifest\.json$/, '');
      // Preferred wire format: the pre-gzipped pak (~35% smaller, served
      // immutable via the ?v= stamp). DecompressionStream streams it
      // straight into the final buffer so decompression overlaps the
      // download. Raw pak stays as the fallback (old browsers, missing
      // artifact); both are stamped so no cache layer can mix builds.
      let bodyStream = null;
      try { performance.mark('boot:pak:start'); } catch (e) { /* marks are advisory */ }
      if (typeof DecompressionStream === 'function' && pakSize > 0) {
        try {
          const gzRes = await fetch(pakBase + data.pack + '.gz' + stamp, { cache: 'default' });
          if (!gzRes.ok) throw new Error('HTTP ' + gzRes.status);
          if (!gzRes.body) throw new Error('no body');
          // Off-main-thread gunzip first (boot-decompress.ts via the page):
          // the inflate work lands in a worker instead of competing with the
          // wasm compile during the cold-boot pile-up. null = declined
          // (kill-switch / unsupported, body untouched) -> exact old inline
          // path. A throw AFTER the transfer means the body is consumed;
          // the catch below re-fetches the raw pak (same contract as the
          // corrupt-.gz fallback).
          const hook = globalThis.engineGzipDecode;
          if (hook) {
            const s = await hook(gzRes.body, 'pak');
            bodyStream = s || gzRes.body.pipeThrough(new DecompressionStream('gzip'));
          } else {
            bodyStream = gzRes.body.pipeThrough(new DecompressionStream('gzip'));
          }
        } catch (e) {
          console.warn('[vfs] compressed pak unavailable (' + (e && e.message || e) + '), using raw pak');
          bodyStream = null;
        }
      }
      if (!bodyStream) {
        const packRes = await fetch(pakBase + data.pack + stamp, { cache: 'default' });
        bodyStream = packRes.body;
      }
      const pak = new Uint8Array(pakSize);
      const reader = bodyStream.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > pakSize) {
          reader.cancel();
          throw new Error('[vfs] pak larger than manifest: ' + (received + value.length) + ' > ' + pakSize);
        }
        pak.set(value, received);
        received += value.length;
        if (onProgress) onProgress(received, pakSize);
      }
      if (received !== pakSize) {
        throw new Error('[vfs] pak size mismatch: got ' + received + ', manifest says ' + pakSize);
      }
      try { performance.mark('boot:pak:ready'); } catch (e) { /* advisory */ }
      for (const [vpath, [offset, length]] of Object.entries(data.files)) {
        if (length > 0) {
          contents.set(vpath, pak.subarray(offset, offset + length));
        }
        packedIndex.set(vpath, length);
        registerDirsFor(vpath);
      }
      // Lazy files (menu fonts, theme menu assets, fight-HUD fonts, UI sounds)
      // ARE registered — the engine's own screens need them. They were skipped
      // in the quick-match-only era ("we don't use menus"), which left the
      // fight lifebar fonts AND every engine-menu font dead. Registration only
      // records vpath→size: bytes stay unfetched until something open()s them,
      // and the background prefetch below warms the cache during boot.
      for (const [vpath, size] of Object.entries(data.lazy || {})) {
        manifest.set(vpath, size);
        registerDirsFor(vpath);
      }
    } else {
      for (const [vpath, size] of Object.entries(data.files)) {
        manifest.set(vpath, size);
        registerDirsFor(vpath);
      }
    }

    dirs.add('save'); dirs.add('save/replays'); dirs.add('save/logs');
    // Presence of a debug/ dir switches the engine's Lua debug dumps on.
    dirs.add('debug');

    // The theme is the site's choice, not the player's, so remember the shipped
    // one before their saved config is layered on top. A packed build already
    // has it in memory; unpacked (the dev server) it's a manifest entry that
    // nothing has fetched yet, so go and get it - otherwise this silently does
    // nothing there, which is exactly where the theme gets changed.
    let shippedMotif = null;
    // The debug font settings need the same treatment as the theme: they are
    // the SITE's choice, not the player's, and a config.ini persisted from an
    // earlier visit would otherwise pin every returning player to whatever
    // values they first booted. That is exactly how a fix to the unreadable
    // Ctrl+D overlay reached nobody who had already played.
    let shippedDebugFont = null, shippedDebugFontScale = null;
    try {
      let cfg = contents.get('save/config.ini');
      if (!cfg && manifest.has('save/config.ini')) {
        const r = await fetch('./engine-fs/file/save/config.ini', { cache: 'no-cache' });
        if (r.ok) cfg = new Uint8Array(await r.arrayBuffer());
      }
      if (cfg) {
        const text = new TextDecoder().decode(cfg);
        const m = /^\s*Motif\s*=\s*(.+)$/mi.exec(text);
        if (m) shippedMotif = m[1].trim();
        const f = /^\s*Font\s*=\s*(.+)$/mi.exec(text);
        if (f) shippedDebugFont = f[1].trim();
        const fs2 = /^\s*FontScale\s*=\s*(.+)$/mi.exec(text);
        if (fs2) shippedDebugFontScale = fs2[1].trim();
      }
    } catch (e) { /* no shipped config to read */ }

    // Player saves (key remaps, options, stats) persisted from earlier
    // visits override the shipped defaults.
    restorePersisted();

    // --- Settings UI is authoritative for config.ini ---
    //
    // Previously, vfs.js overwrote GameWidth/GameHeight/KeepAspect/
    // RollbackNetcode/Motif/debug-font AFTER restorePersisted(), which
    // meant the Settings UI's values for those keys were silently
    // discarded at boot. This created a coherence bug where changing
    // resolution in Settings had no effect (the /local RES toggle's
    // URL param won via a global override; today the marker alone decides).
    //
    // Now: Settings UI writes to localStorage, restorePersisted() loads
    // it, and vfs.js does NOT overwrite. The /local RES toggle also
    // writes to the same localStorage key (it's a quick-set shortcut,
    // not a separate authority). One config source, one path.

    // Guarantee [Netplay] PlayerName EXISTS, without touching a name already
    // saved. gameOption() raises "Invalid argument" on a key the config never
    // declared - and a returning player's persisted config predates this key,
    // so the restore above hands the engine a config missing it and the menu
    // that reads it takes the whole engine down. Declaring it in the generated
    // config only helps brand-new players; this covers everyone else.
    try {
      const cfg = contents.get('save/config.ini');
      if (cfg) {
        const text = new TextDecoder().decode(cfg);
        if (!/^\s*PlayerName\s*=/mi.test(text)) {
          const patched = /^\s*\[Netplay\]\s*$/mi.test(text)
            ? text.replace(/^(\s*\[Netplay\]\s*)$/mi, '$1\nPlayerName = ')
            : text + '\n[Netplay]\nPlayerName = \n';
          contents.set('save/config.ini', new TextEncoder().encode(patched));
        }
      }
    } catch (e) { /* leave config as restored */ }

    // Normalize display-mode configurations left behind by older builds:
    // the crop-era presets ('4:3' marker + 1280x720 16:9 render + web fitter
    // cover-crop), the interim letterbox presets, the stretch presets, the
    // first-generation 4:3 render resolutions (640x480), and the
    // genuine-4:3 era (960x720 + FightAspect=4,3).
    //
    // The '4:3'-marked mode is now the EXPANDED STAGE VIEW (the mode the
    // Settings UI calls "Expanded"; the marker/key name is historical): a
    // 1280x720 canvas + FightAspect=16,9, with vfs.js's stage fit
    // (patchStageDefExpanded) rewriting each stage's view to its painted
    // art — more stage visible vertically AND horizontally than 16:9, zero
    // black bars, zero distortion, and a plain 16:9 canvas that fills a
    // 16:9 screen edge-to-edge (no pillarbox). Verified in the shipped
    // WASM with headless screenshots.
    //
    // Stage zoom ([Config] ZoomActive + [Debug] ForceStageAutoZoom) is also
    // ensured here at EVERY boot: the camera then dynamically zooms out while
    // players are far apart (clamped by the stage's own camera bounds/art),
    // revealing the stage's top. Stages that author their own [Camera] zoom
    // settings are unaffected — ForceStageAutoZoom only fills in zoom-less
    // stages (e.g. UIU_Fountain). In the FITTED modes the fit itself
    // installs an explicit autozoom package with a zoom-in ceiling
    // (patchStageDefFit Step 4) — the fitted view leaves no headroom for
    // zoom-out, so the camera instead leans in on close action.
    //
    // Rule:
    //   marker '4:3' (v2 key ONLY — pre-v2 markers are invalidated because
    //     an earlier build auto-wrote them on the first /local visit) or an
    //     explicit 4:3 choice
    //     -> EXPANDED STAGE VIEW: GameWidth/GameHeight = 1280/720,
    //        FA = 16,9, KeepAspect = 1, marker '4:3' (config values from
    //        the genuine-4:3 era migrate here automatically)
    //   anything else — INCLUDING no marker, the 16:9 default
    //     -> FA healed to -1,-1 (broken half-configs from the old standalone
    //        settings UI); orphaned non-16:9 canvases (960x720 left by the
    //        genuine-4:3 era, 640x480 from the stretch era) are
    //        bumped back to 1280x720 so the 16:9 fight fills the canvas
    //        edge-to-edge; other resolutions are kept
    //   always -> Config.ZoomActive = 1, Debug.ForceStageAutoZoom = 1
    // WindowTitle: the engine sets document.title from this config value at
    // boot. Pin it to the site brand for EVERY user (the engine's compiled
    // default is a third-party engine name, and configs persisted before the
    // rename carry the old site title) — the engine re-persists the
    // normalized value on its next save.
    try {
      const cfgT = contents.get('save/config.ini');
      if (cfgT) {
        const textT = new TextDecoder().decode(cfgT);
        if (!/^\s*WindowTitle\s*=\s*OpenFighter\s*$/mi.test(textT)) {
          const patchedT = /^\s*WindowTitle\s*=/mi.test(textT)
            ? textT.replace(/^(\s*WindowTitle\s*=\s*).*$/mi, '$1OpenFighter')
            : '[Config]\nWindowTitle = OpenFighter\n' + textT;
          contents.set('save/config.ini', new TextEncoder().encode(patchedT));
          console.log('[vfs] window title pinned to site brand');
        }
      }
    } catch (e) { /* cosmetic only — leave config as restored */ }

    // The engine re-persists its (normalized) config on its next save, so
    // localStorage heals itself after the first boot.
    try {
      const cfg = contents.get('save/config.ini');
      if (cfg) {
        let text = new TextDecoder().decode(cfg);
        let changed = false;
        const gw = /^\s*GameWidth\s*=\s*(\d+)\s*$/mi.exec(text);
        const gh = /^\s*GameHeight\s*=\s*(\d+)\s*$/mi.exec(text);
        let marker = null;
        // v2 key ONLY: pre-v2 markers ('engine-display-mode',
        // 'engine-display-mode') are invalidated — an earlier build
        // auto-wrote '4:3' on the first /local visit, so they do not
        // represent user choices. No marker = the 16:9 default.
        try { marker = localStorage.getItem('engine-display-mode-v2'); } catch (e) { /* best-effort */ }
        // An explicit v2 marker wins (the user's choice). Resolution
        // heuristics deliberately do NOT infer a mode anymore — a stale
        // 4:3 resolution without a marker is an orphan to heal to 16:9.
        const is43 = marker === '4:3';
        const isTall = marker === 'tall';
        const isWide32 = marker === '3:2';
        const isWide149 = marker === '14:9';
        const isWide53 = marker === '5:3';
        // Gate for the stage fit (patchStageDefFit): stage defs are
        // rewritten as the engine opens them, which happens after this.
        setStageFitMode(is43 ? 'expanded' : (isTall ? 'tall' : (isWide32 ? '3:2' : (isWide149 ? '14:9' : (isWide53 ? '5:3' : null)))));

        // Align a key if present; insert it under its section header if the
        // key is missing (creating the whole section at the end if needed).
        const ensureKey = (key, val, section) => {
          const re = new RegExp('^\\s*' + key + '\\s*=.*$', 'mi');
          if (re.test(text)) {
            const cur = new RegExp('^\\s*' + key + '\\s*=\\s*(-?\\d+)\\s*$', 'mi').exec(text);
            if (!cur || cur[1] !== String(val)) {
              text = text.replace(re, key.padEnd(20) + '= ' + val);
              changed = true;
            }
            return;
          }
          const secRe = new RegExp('^\\[' + section + '\\]\\s*$', 'mi');
          if (secRe.test(text)) {
            text = text.replace(secRe, (m) => m + '\n' + key.padEnd(20) + '= ' + val);
          } else {
            text += '\n[' + section + ']\n' + key.padEnd(20) + '= ' + val + '\n';
          }
          changed = true;
        };

        if (is43) {
          // Migrate every historical '4:3'-marker config (crop-era, the
          // genuine-4:3 960x720 render, etc.) to the EXPANDED STAGE VIEW:
          // 1280x720 canvas + FightAspect=16,9 + the vfs stage fit. The
          // marker keeps its historical name; the values define the mode.
          ensureKey('GameWidth', 1280, 'Video');
          ensureKey('GameHeight', 720, 'Video');
          ensureKey('FightAspectWidth', 16, 'Video');
          ensureKey('FightAspectHeight', 9, 'Video');
          ensureKey('KeepAspect', 1, 'Video');
          try {
            const cur = localStorage.getItem('engine-display-mode-v2');
            if (cur !== '4:3') {
              localStorage.setItem('engine-display-mode-v2', '4:3');
            }
          } catch (e) { /* marker best-effort */ }
        } else if (isTall) {
          // TALL STAGE VIEW (the restored classic fitted-4:3 mode): a
          // 960x720 canvas + FightAspect=4,3 + KeepAspect, with the vfs
          // stage fit (patchStageDefFit, mode 'tall') fitting the view to
          // the stage's painted art — the same geometry the fitted-4:3 era
          // shipped and the user approved.
          ensureKey('GameWidth', 960, 'Video');
          ensureKey('GameHeight', 720, 'Video');
          ensureKey('FightAspectWidth', 4, 'Video');
          ensureKey('FightAspectHeight', 3, 'Video');
          ensureKey('KeepAspect', 1, 'Video');
        } else if (isWide32) {
          // WIDE STAGE VIEW (the fitted ladder's middle rung): a 1080x720
          // canvas + FightAspect=3,2 + KeepAspect, with the vfs stage fit
          // (patchStageDefFit, mode '3:2') fitting the view to the
          // stage's painted art — the same vertical art as Tall/Expanded,
          // in a window between them.
          ensureKey('GameWidth', 1080, 'Video');
          ensureKey('GameHeight', 720, 'Video');
          ensureKey('FightAspectWidth', 3, 'Video');
          ensureKey('FightAspectHeight', 2, 'Video');
          ensureKey('KeepAspect', 1, 'Video');
        } else if (isWide149) {
          // WIDER STAGE VIEW (a fitted-ladder rung between 3:2 and 5:3):
          // a 1120x720 canvas + FightAspect=14,9 + KeepAspect, with the
          // vfs stage fit (patchStageDefFit, mode '14:9') fitting the
          // view to the stage's painted art — the same vertical art as
          // every other fitted mode, in a wider window.
          ensureKey('GameWidth', 1120, 'Video');
          ensureKey('GameHeight', 720, 'Video');
          ensureKey('FightAspectWidth', 14, 'Video');
          ensureKey('FightAspectHeight', 9, 'Video');
          ensureKey('KeepAspect', 1, 'Video');
        } else if (isWide53) {
          // WIDEST FITTED STAGE VIEW (the fitted-ladder rung just below
          // Expanded): a 1200x720 canvas + FightAspect=5,3 + KeepAspect,
          // with the vfs stage fit (patchStageDefFit, mode '5:3') fitting
          // the view to the stage's painted art — the same vertical art
          // as every other fitted mode, in the widest fitted window.
          ensureKey('GameWidth', 1200, 'Video');
          ensureKey('GameHeight', 720, 'Video');
          ensureKey('FightAspectWidth', 5, 'Video');
          ensureKey('FightAspectHeight', 3, 'Video');
          ensureKey('KeepAspect', 1, 'Video');
        } else {
          // 16:9 path (also the no-marker default) — heal broken
          // half-configs (FA must be -1,-1), and bump orphaned non-16:9
          // canvases (960x720 left by the genuine-4:3 era, 640x480 from
          // the stretch era, 1080x720 / 1120x720 / 1200x720 left by wiped
          // '3:2' / '14:9' / '5:3' markers) back to the shipped 1280x720
          // so the 16:9 fight fills the canvas edge-to-edge instead of
          // letterboxing inside a fitted-mode frame. Any other resolution
          // is kept (e.g. a chosen 1080p canvas).
          ensureKey('FightAspectWidth', -1, 'Video');
          ensureKey('FightAspectHeight', -1, 'Video');
          const orphanRatio = gw && gh ? +gw[1] / +gh[1] : 0;
          if (gw && gh && (Math.abs(orphanRatio - 4 / 3) < 0.01 || Math.abs(orphanRatio - 3 / 2) < 0.01
            || Math.abs(orphanRatio - 14 / 9) < 0.01 || Math.abs(orphanRatio - 5 / 3) < 0.01)) {
            ensureKey('GameWidth', 1280, 'Video');
            ensureKey('GameHeight', 720, 'Video');
          }
        }
        // Stage zoom — enabled for every display mode (see comment above).
        ensureKey('ZoomActive', 1, 'Config');
        ensureKey('ForceStageAutoZoom', 1, 'Debug');

        // CANONICAL KEYMAP ENFORCEMENT (v3, one-time per device).
        //
        // The engine parses [Keys_P1]/[Keys_P2] FIRST-MATCH-WINS and honors
        // those values for fight input (PROVEN live: keymap-probe3.mjs seeded
        // a distinguishing P1=i/j/k/l map and the engine followed it — KeyJ
        // moved P1, ArrowRight moved P2; keymap-probe2.mjs confirmed the
        // write-back echoes the effective map). The OLD shipped/stored
        // sections carry P1=WASD+8/9/0+I/O/P and P2=ARROWS+1..7, which is the
        // whole 'dpad dead + XYZ buttons move my character + arrows move the
        // opponent' bug family: the touch overlay dispatches the canonical
        // Classic arcade layout (dpad=arrows, A/B/C/X/Y/Z=z/x/c/a/s/d), so with the
        // stale sections first-match the dpad lands on P2's keys and the XYZ
        // buttons land on P1's WASD movement keys.
        //
        // Canonical layout (matches the touch overlay's hardcoded dispatch
        // and the regenerated game.pak):
        //   P1: arrows move, A=z B=x C=c X=a Y=s Z=d, Start=RETURN
        //   P2: i/j/k/l move, A=f B=g C=h X=r Y=t Z=y, Start=RSHIFT
        // (P2 uses the engine's own built-in cluster — no key collisions
        // with P1, so two humans on one keyboard still work.)
        //
        // ONE-TIME: marker 'engine-keymap-v3' guards the rewrite so a user's
        // later in-engine remaps survive; the marker is only absent on
        // devices not yet healed (and after storage wipes, where the pak's
        // canonical copy applies anyway). The rewrite REPLACES the whole
        // section (and strips duplicates), because the old sections can hold
        // shadowed duplicate keys whose first-match values are the stale
        // layout.
        let keymapMarker = null;
        try { keymapMarker = localStorage.getItem('engine-keymap-v3'); } catch (e) { /* best-effort */ }
        if (!keymapMarker) {
          const CANON = {
            Keys_P1: [
              'Joystick = -1',   // REQUIRED: missing/0 makes the engine treat P1 as gamepad 0
              'GUID   = ',
              'Up     = UP',
              'Down   = DOWN',
              'Left   = LEFT',
              'Right  = RIGHT',
              'A      = z',
              'B      = x',
              'C      = c',
              'X      = a',
              'Y      = s',
              'Z      = d',
              'Start  = RETURN',
              'D      = q',
              'W      = w',
              'Menu   = ESCAPE',
            ],
            Keys_P2: [
              'Joystick = -1',
              'GUID   = ',
              'Up     = i',
              'Down   = k',
              'Left   = j',
              'Right  = l',
              'A      = f',
              'B      = g',
              'C      = h',
              'X      = r',
              'Y      = t',
              'Z      = y',
              'Start  = RSHIFT',
              'D      = b',
              'W      = n',
              'Menu   = ESCAPE',
            ],
          };
          // Values use the engine's own key names ("z", "UP", ...)
          // — NOT KeyboardEvent.code strings, which the engine's StringToKey
          // does not understand.
          const rewriteSection = (src, name, bodyLines) => {
            const body = '[' + name + ']\n' + bodyLines.join('\n') + '\n';
            const re = new RegExp('\\[' + name + '\\][\\s\\S]*?(?=\\n\\[|\\s*$)', 'gi');
            let first = true;
            const out = src.replace(re, () => {
              if (!first) return ''; // strip shadowed duplicate sections
              first = false;
              return body;
            });
            return first ? out.replace(/\s*$/, '') + '\n\n' + body : out;
          };
          text = rewriteSection(text, 'Keys_P1', CANON.Keys_P1);
          text = rewriteSection(text, 'Keys_P2', CANON.Keys_P2);
          changed = true;
          try { localStorage.setItem('engine-keymap-v3', '1'); } catch (e) { /* best-effort */ }
          console.log('[vfs] canonical keymap v3 enforced (P1 arrows+zxc/asd, P2 ijkl+fgh/rty)');
        }

        if (changed) {
          contents.set('save/config.ini', new TextEncoder().encode(text));
          console.log('[vfs] normalized display-mode config to '
            + (is43 ? 'expanded stage view (1280x720, FightAspect=16,9)'
              : (isTall ? 'tall stage view (960x720, FightAspect=4,3)'
                : (isWide32 ? 'wide 3:2 stage view (1080x720, FightAspect=3,2)'
                  : (isWide149 ? 'wider 14:9 stage view (1120x720, FightAspect=14,9)'
                    : (isWide53 ? 'widest fitted 5:3 stage view (1200x720, FightAspect=5,3)'
                      : '16:9 stage-default aspect')))))
            + ' + stage zoom');
        }
      }
    } catch (e) { /* leave config as restored */ }

    // Layer any in-browser mods on top of the shipped content (no-op if none).
    try {
      const nMods = await loadModsOverlay();
      if (nMods) console.log('[vfs] loaded ' + nMods + ' modded file(s) from browser storage');
    } catch (e) { /* overlay unavailable - ship as-is */ }

    // The player's own theme pick (studio-lite) beats the shipped one. This has
    // to run AFTER the mods overlay: a theme the player dropped into the studio
    // lives only in browser storage, so its system.def isn't in the VFS until
    // the overlay lands. It's a localStorage setting like the netcode and
    // picture choices - NOT a mod file - because a save/config.ini in browser
    // storage would clobber those patches too. A stale pick (theme since
    // removed) is ignored rather than booted into: a missing motif is a boot
    // failure, not a cosmetic problem.
    let effectiveMotif = shippedMotif;
    try {
      const pick = localStorage.getItem('engine-lite:motif');
      const cfg = contents.get('save/config.ini');
      if (pick && cfg && exists(pick)) {
        effectiveMotif = pick;
        const text = new TextDecoder().decode(cfg);
        const patched = /^\s*Motif\s*=/mi.test(text)
          ? text.replace(/^(\s*Motif\s*=\s*).+$/mi, '$1' + pick)
          : '[Config]\nMotif = ' + pick + '\n' + text;
        if (patched !== text) {
          contents.set('save/config.ini', new TextEncoder().encode(patched));
          console.log('[vfs] theme: ' + pick);
        }
      }
    } catch (e) { /* keep the shipped theme */ }

    // Menu music (studio-lite): the player's title/select track picks patch
    // the ACTIVE motif's [Music] lines in memory - the same family as the
    // theme and netcode overrides above. Deliberately NOT stored as a mod
    // file: a stored copy of the motif def would shadow the site's future
    // updates to it forever. An unset pick leaves the motif untouched, so
    // "(screenpack default)" is simply whatever the pack ships. The def is
    // round-tripped byte-for-byte (motif defs carry Shift-JIS comments that
    // a UTF-8 decode/encode would corrupt); [Music] keys are standardized
    // (title.bgm / select.bgm), so this works on any screenpack.
    try {
      const tPick = localStorage.getItem('engine-lite:title-bgm');
      const sPick = localStorage.getItem('engine-lite:select-bgm');
      if (tPick || sPick) {
        const litePick = localStorage.getItem('engine-lite:motif');
        const motif = (litePick && exists(litePick)) ? litePick : shippedMotif;
        if (motif && exists(motif)) {
          if (!contents.get(motif)) await fetchFile(motif);
          const bytes = contents.get(motif);
          if (bytes) {
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000)
              s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            const before = s;
            const set = (key, pick) => {
              if (!pick || !exists(pick)) return; // stale pick: keep pack music
              const re = new RegExp('^(\\s*' + key + '\\s*=)[^\\r\\n]*', 'mi');
              if (re.test(s)) s = s.replace(re, '$1 ' + pick);
            };
            set('title\\.bgm', tPick);
            set('select\\.bgm', sPick);
            if (s !== before) {
              const out = new Uint8Array(s.length);
              for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
              contents.set(motif, out);
              console.log('[vfs] menu music: title=' + (tPick || '(default)') + ' select=' + (sPick || '(default)'));
            }
          }
        }
      }
    } catch (e) { /* keep the pack's own music */ }

    await Promise.all(preloadList.map(p => fetchFile(p).catch(() => {})));

    // NOTE: the lazy-set prefetch used to start right here, inside
    // engineVfsInit - which put ~18MB of menu/UI downloads (system.sff,
    // system.snd, fonts) into the same window as the .pak download, WASM
    // compile and character injection. On phones that stacked a network +
    // heap spike on top of the boot spike (the first-start refresh family,
    // fixed in 13b1fad). The prefetch now lives in
    // globalThis.engineVfsPrefetch below; the boot page starts it once the
    // engine is actually up. Anything the engine needs earlier is still
    // fetched on demand by open() -> fetchFile.

    // Combined Build ID: shipped manifest + every browser-side mod's bytes +
    // the effective theme. The boot page displays it and the netplay
    // build-check exchanges it, so two players match exactly when their
    // shipped build AND their browser mods AND their theme agree - and a
    // mismatch is refused up front instead of desyncing mid-match. Streaming
    // cyrb64 (pure JS: crypto.subtle is undefined on plain http). Menu-music
    // picks are deliberately NOT hashed - music is render-side and cannot
    // desync lockstep.
    {
      let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      const mix = (b) => {
        h1 = Math.imul(h1 ^ b, 2654435761);
        h2 = Math.imul(h2 ^ b, 1597334677);
      };
      const mixStr = (s) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i) & 0xff); };
      // Unpacked builds list their files in manifest, packed builds in
      // packedIndex. Hash whichever is populated - iterating only manifest
      // meant every packed build hashed nothing but its motif string.
      const shipped = new Map([...manifest, ...packedIndex]);
      for (const p of [...shipped.keys()].sort()) mixStr(p + '\0' + String(shipped.get(p)) + '\n');
      for (const p of overlayPaths.sort()) {
        mixStr('\0mod\0' + p + '\0');
        const b = contents.get(p);
        if (b) for (let i = 0; i < b.length; i++) mix(b[i]);
      }
      mixStr('\0motif\0' + (effectiveMotif || ''));
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      const out = new Uint8Array(8), dv = new DataView(out.buffer);
      dv.setUint32(0, h2 >>> 0); dv.setUint32(4, h1 >>> 0);
      globalThis.engineBuildHash = out;
      globalThis.engineBuildHex =
        ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
    }

    // The online name the player set in NETWORK > PLAYER NAME. It lives in
    // save/config.ini (the engine's own settings file), which this module
    // already mirrors into localStorage - so it is browser-stored and survives
    // reloads without a second storage path. Read live from the VFS rather
    // than from localStorage, so a name set THIS session is visible before the
    // config is flushed. Exposed as a function because the player can change
    // it mid-session and callers must not cache it.
    globalThis.enginePlayerName = function () {
      try {
        const b = contents.get('save/config.ini');
        if (!b) return '';
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        // Horizontal whitespace only. \s* after the '=' would swallow the
        // newline on an EMPTY value and capture the next line instead - which
        // returned a comment line as the player's name.
        const m = /^[ \t]*PlayerName[ \t]*=[ \t]*([^\r\n]*)/mi.exec(s);
        return m ? m[1].trim().replace(/^"|"$/g, '') : '';
      } catch (e) { return ''; }
    };

    return Object.keys(data.files).length;
  };

  // Background warmup of the remaining (lazy) manifest set: without it, the
  // first use of any unfetched file mid-fight (a sound effect, a hit spark
  // sheet) or in the engine's own menus (system.sff, menu fonts) blocks the
  // game loop on a network fetch - felt as a random tiny freeze. Limited
  // concurrency so fight-critical fetches still win the bandwidth race.
  // Runs for BOTH packed and unpacked builds (packed builds ship their lazy
  // set as individual files). Deliberately NOT started by engineVfsInit -
  // the boot page calls this once the engine is up, keeping the megabytes
  // out of the boot memory/bandwidth window. Safe to call more than once:
  // already-fetched files are skipped and concurrent fetches dedupe
  // through the `fetching` map.
  //
  // opts.maxFileBytes (Batch 3, memory-constrained devices): when set,
  // files larger than the cap are SKIPPED - system.sff (~9.2 MB) +
  // system.snd (~3.7 MB) are 88% of the lazy set, and holding them
  // permanently resident in `contents` (a JS-heap map) helped push phone
  // tabs over the memory cliff. On constrained devices the boot page caps
  // the warmup at small files; the big ones stay on-demand (fetched the
  // first time the engine actually opens them, then retained as usual).
  globalThis.engineVfsPrefetch = function (onProgress, opts) {
    const maxFileBytes = (opts && opts.maxFileBytes) || 0;
    const pending = [...manifest.keys()];
    const totalBytes = pending.reduce((n, p) => n + (manifest.get(p) || 0), 0);
    let doneBytes = 0;
    let skipped = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (pending.length) {
        const vpath = pending.shift();
        const size = manifest.get(vpath) || 0;
        if (maxFileBytes && size > maxFileBytes) {
          skipped++;
          doneBytes += size; // still accounted, so progress completes
          if (onProgress) onProgress(doneBytes, totalBytes);
          continue;
        }
        if (!contents.has(vpath)) {
          await fetchFile(vpath).catch(() => {});
        }
        doneBytes += size;
        if (onProgress) onProgress(doneBytes, totalBytes);
      }
    });
    return Promise.all(workers).then(() => console.log(
      '[vfs] background prefetch complete' +
      (skipped ? ' (' + skipped + ' large file(s) skipped - on-demand)' : '')
    ));
  };
})();
