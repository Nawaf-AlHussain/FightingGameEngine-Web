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
  // Renamed from 'ikemen-vfs12:' — restorePersisted() still reads the old
  // prefix once and copies it over, so existing players' saves migrate
  // in place (config.ini, key bindings, logs).
  const PERSIST_PREFIX = 'engine-vfs12:';
  const PERSIST_PREFIX_LEGACY = 'ikemen-vfs12:';
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
        if (!key) continue;
        const isNew = key.startsWith(PERSIST_PREFIX);
        // Accept BOTH prefixes on the read path: the legacy prefix migrates
        // forward (copied to the new key) so a player's saves survive the
        // rename even if they never re-save.
        const isLegacy = !isNew && key.startsWith(PERSIST_PREFIX_LEGACY);
        if (!isNew && !isLegacy) continue;
        const vpath = key.slice((isNew ? PERSIST_PREFIX : PERSIST_PREFIX_LEGACY).length);
        const bin = atob(localStorage.getItem(key));
        const buf = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) buf[j] = bin.charCodeAt(j);
        contents.set(vpath, buf);
        manifest.delete(vpath);
        registerDirsFor(vpath);
        if (isLegacy) {
          try { if (!localStorage.getItem(PERSIST_PREFIX + vpath)) localStorage.setItem(PERSIST_PREFIX + vpath, localStorage.getItem(key)); } catch (e2) { /* quota — legacy copy stays authoritative */ }
        }
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
  // font paths are spelled "ikemen1/fonts/Timer.def" and the WASM build hands
  // them to the VFS verbatim, while the files actually live at
  // "data/ikemen1/fonts/..." (the sff/snd in the same section resolve against
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
        (manifest.has('data/ikemen1/system.snd') || contents.has('data/ikemen1/system.snd'))) {
      return 'data/ikemen1/system.snd';
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
      engineLog.push(line);
      if (engineLog.length > 80) engineLog.splice(0, engineLog.length - 80);
      // Match-result marker from main.lua (f_quickMatch): this engine build
      // has no js lua bridge, so the result rides stdout instead of the old
      // js.global write (which panicked the engine at every match end).
      if (line.indexOf('__IKEMEN_RESULT ') === 0) {
        try {
          const kv = {};
          for (const p of line.slice('__IKEMEN_RESULT '.length).trim().split(/\s+/)) {
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
      }
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

  // --- 4:3 stage camera clamp (the "black sky above the stage" fix) ---
  // In the 4:3 display mode the engine renders the fight at a 960x720
  // framebuffer with FightAspect=4,3. For a 16:9-designed stage the view is
  // TALLER than the stage's design area; the engine camera's aspectcorrection
  // places that extra height above the ground line (whatever the stage's
  // overdrawlow cannot cover below). The vertical pan ceiling ([Camera]
  // boundhigh) is stage-author geometry from the 16:9 era: following a
  // jumping character, the camera can now look above the painted
  // background - black sky. 16:9 never sees this because its view top sits
  // (missingU - belowU) stage units lower.
  //
  // The engine's own pan clamp (camera.go boundY) works in stage
  // coordinates and does NOT account for the aspectcorrection framing, so
  // the fix is to hand the engine a tighter ceiling, exactly like a stage
  // author porting their stage to 4:3 would declare:
  //
  //   scl       = 960 / localcoordW            (4:3 preset GameWidth)
  //   missingU  = 720/scl - localcoordH        (extra stage units the view adds)
  //   belowU    = min(missingU/2, overdrawlow) (part placed below ground)
  //   aboveU    = missingU - belowU            (part placed ABOVE the design top)
  //   boundhigh = -max(0, overdrawhigh - aboveU)
  //
  // i.e. the camera may still pan, but only into the headroom the stage
  // actually declares (overdrawhigh) beyond the already-raised framing.
  // Jumping characters stay visible because the 4:3 view at rest already
  // shows far more vertical than any normal jump reaches - that taller
  // view is the entire point of the mode. Only ever TIGHTENS: a stage
  // whose declared headroom already covers the taller view is untouched,
  // stages without an explicit boundhigh are untouched (boundhigh default
  // 0 means the engine never pans up anyway), and legacy 320x240-family
  // stages (missingU <= 0) fit natively and are untouched. Never applied
  // in 16:9 - that path stays byte-identical.
  let effective43 = false;
  function setEffective43(v) {
    effective43 = v; // flips mid-session via online display-mode adoption
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
  const STAGE43_DEF_RE = /^(?:data\/)?stages\/[^/]*\.def$/i;
  // Re-runs on every open (no memo): the rewrite is idempotent by the
  // `target <= bh` guard, and a background prefetch may legitimately
  // re-materialize the ORIGINAL bytes into `contents` after the first
  // patch - a later open must re-patch them. The scan cost is a ~10-40KB
  // text regex, once per stage per open. 
  function patchStageDef43(vpath) {
    if (!effective43 || !STAGE43_DEF_RE.test(vpath)) return;
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
      const bh = num(cam, 'boundhigh');
      if (!lc || bh === null) return; // unknown geometry, or no up-pan (default 0) to fix
      const scl = 960 / +lc[1];
      const missingU = 720 / scl - +lc[2];
      if (!(missingU > 0)) return; // legacy 4:3-family stage: fits natively
      const odh = Math.max(0, num(cam, 'overdrawhigh') || 0);
      const odl = Math.max(0, num(cam, 'overdrawlow') || 0);
      const aboveU = missingU - Math.min(missingU / 2, odl);
      const target = -Math.max(0, odh - aboveU);
      if (target <= bh) return; // declared headroom already covers the taller view
      const patchedText = text.replace(
        /^(\s*boundhigh\s*=\s*)(-?\d+(?:\.\d+)?)/im,
        (m, p1) => p1 + String(target)
      );
      if (patchedText === text) return;
      contents.set(vpath, latin1ToBytes(patchedText));
      console.log('[vfs] 4:3 camera clamp: ' + vpath + ' boundhigh ' + bh + ' -> ' + target
        + ' (taller view +' + Math.round(aboveU) + 'u above design, declared headroom '
        + Math.round(odh) + 'u)');
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
        // 4:3 camera clamp (see patchStageDef43): runs here because every
        // serving path - pak materialization, CDN fetch, direct injection -
        // has populated `contents` by the time the engine opens the file.
        patchStageDef43(vpath);
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
  // normalized away, but the 4:3 display mode (FightAspect=4,3 ->
  // "custom:4:3") genuinely differs from the stage-default 16:9 path
  // (FightAspect=-1,-1 -> "stage"). A 4:3 host paired with a 16:9 guest —
  // e.g. PC with 4:3 vs phone on the default — exited the engine before
  // the fight started ("ENGINE EXITED BEFORE THE FIGHT STARTED").
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
      if (mode !== '4:3' && mode !== '16:9') return null;
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
        // The engine's native 4:3 — exactly what the boot migration writes
        // for the '4:3' marker (same preset as the Settings UI).
        ensureKey('GameWidth', 960, 'Video');
        ensureKey('GameHeight', 720, 'Video');
        ensureKey('FightAspectWidth', 4, 'Video');
        ensureKey('FightAspectHeight', 3, 'Video');
        ensureKey('KeepAspect', 1, 'Video');
      } else {
        // 16:9 = stage-default fight aspect.
        ensureKey('FightAspectWidth', -1, 'Video');
        ensureKey('FightAspectHeight', -1, 'Video');
        // A 4:3 canvas letterboxes a 16:9 fight inside itself
        // (KeepAspect=1) — bump a 4:3 canvas to 1280x720 so the adopted
        // 16:9 fills it edge-to-edge. Any other resolution is kept.
        const gw = /^\s*GameWidth\s*=\s*(\d+)\s*$/mi.exec(text);
        const gh = /^\s*GameHeight\s*=\s*(\d+)\s*$/mi.exec(text);
        if (gw && gh && Math.abs(+gw[1] / +gh[1] - 4 / 3) < 0.01) {
          ensureKey('GameWidth', 1280, 'Video');
          ensureKey('GameHeight', 720, 'Video');
        }
      }
      if (changed) {
        globalThis.engineInjectFile('save/config.ini', new TextEncoder().encode(text));
      }
      // The adopted host mode also gates the 4:3 stage camera clamp, so
      // host and guest patch the same stage defs identically.
      setEffective43(mode === '4:3');
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
  const MODS_DB = 'ikemen-mods', MODS_STORE = 'files';
  function openModsDB() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(MODS_DB, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => { req.result.createObjectStore(MODS_STORE); };
      req.onsuccess = () => resolve(req.result);
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
    // cover-crop), the interim letterbox presets, the stretch presets, and
    // the first-generation 4:3 render resolutions (640x480).
    //
    // The 4:3 display mode is now the ENGINE'S NATIVE 4:3: FightAspect=4,3
    // re-frames the fight into a genuine 4:3 world (verified in the shipped
    // WASM with headless screenshots: full-bleed 4:3, zero bars, zero
    // distortion, and MORE vertical stage content than 16:9 — the extra
    // height lands in the stage's overdraw regions, placed by the engine
    // camera's aspectcorrection per the stage's overdrawhigh/overdrawlow).
    // The canvas is 960x720 (4:3), so the /play fitter needs no mode-specific
    // presentation anymore — plain contain-fit is correct at both aspects.
    //
    // Stage zoom ([Config] ZoomActive + [Debug] ForceStageAutoZoom) is also
    // ensured here at EVERY boot: the camera then dynamically zooms out while
    // players are far apart (clamped by the stage's own camera bounds),
    // revealing the stage's top. Stages that author their own [Camera] zoom
    // settings are unaffected — ForceStageAutoZoom only fills in zoom-less
    // stages (e.g. UIU_Fountain).
    //
    // Rule:
    //   marker '4:3' (v2 key ONLY — pre-v2 markers are invalidated because
    //     an earlier build auto-wrote them on the first /local visit) or an
    //     explicit 4:3 choice
    //     -> GameWidth/GameHeight = 960/720, FA = 4,3, KeepAspect = 1,
    //        marker '4:3'
    //   anything else — INCLUDING no marker, the 16:9 default
    //     -> FA healed to -1,-1 (broken half-configs from the old standalone
    //        settings UI); orphaned 4:3 canvases (960x720 left by the
    //        previous normalization, 640x480 from the stretch era) are
    //        bumped back to 1280x720 so the 16:9 fight fills the canvas
    //        edge-to-edge; other resolutions are kept
    //   always -> Config.ZoomActive = 1, Debug.ForceStageAutoZoom = 1
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
        // 'ikemen-display-mode') are invalidated — an earlier build
        // auto-wrote '4:3' on the first /local visit, so they do not
        // represent user choices. No marker = the 16:9 default.
        try { marker = localStorage.getItem('engine-display-mode-v2'); } catch (e) { /* best-effort */ }
        // An explicit v2 marker wins (the user's choice). Resolution
        // heuristics deliberately do NOT infer a mode anymore — a stale
        // 4:3 resolution without a marker is an orphan to heal to 16:9.
        const is43 = marker === '4:3';
        // Gate for the 4:3 stage camera clamp (patchStageDef43): stage defs
        // are rewritten as the engine opens them, which happens after this.
        setEffective43(is43);

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
          // Migrate crop-era / legacy 4:3 configs to the native 4:3 render.
          ensureKey('GameWidth', 960, 'Video');
          ensureKey('GameHeight', 720, 'Video');
          ensureKey('FightAspectWidth', 4, 'Video');
          ensureKey('FightAspectHeight', 3, 'Video');
          ensureKey('KeepAspect', 1, 'Video');
          try {
            const cur = localStorage.getItem('engine-display-mode-v2');
            if (cur !== '4:3') {
              localStorage.setItem('engine-display-mode-v2', '4:3');
            }
          } catch (e) { /* marker best-effort */ }
        } else {
          // 16:9 path (also the no-marker default) — heal broken
          // half-configs (FA must be -1,-1), and bump orphaned 4:3
          // canvases (960x720 left by the previous native-4:3
          // normalization, 640x480 from the stretch era) back to the
          // shipped 1280x720 so the 16:9 fight fills the canvas
          // edge-to-edge instead of letterboxing inside a 4:3 frame.
          // Any other resolution is kept (e.g. a chosen 1080p canvas).
          ensureKey('FightAspectWidth', -1, 'Video');
          ensureKey('FightAspectHeight', -1, 'Video');
          if (gw && gh && Math.abs(+gw[1] / +gh[1] - 4 / 3) < 0.01) {
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
        try { keymapMarker = localStorage.getItem('engine-keymap-v3') || localStorage.getItem('ikemen-keymap-v3'); } catch (e) { /* best-effort */ }
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
            + (is43 ? 'native 4:3 (960x720, FightAspect=4,3)' : '16:9 stage-default aspect')
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
      const pick = localStorage.getItem('engine-lite:motif') || localStorage.getItem('ikemen-lite:motif');
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
      const tPick = localStorage.getItem('engine-lite:title-bgm') || localStorage.getItem('ikemen-lite:title-bgm');
      const sPick = localStorage.getItem('engine-lite:select-bgm') || localStorage.getItem('ikemen-lite:select-bgm');
      if (tPick || sPick) {
        const litePick = localStorage.getItem('engine-lite:motif') || localStorage.getItem('ikemen-lite:motif');
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
