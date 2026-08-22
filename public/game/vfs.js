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
  const PERSIST_PREFIX = 'ikemen-vfs12:';
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
          try { window.dispatchEvent(new CustomEvent('ikemen-config-persisted')); } catch (e2) { /* non-DOM host */ }
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
    return contents.has(vpath) || manifest.has(vpath) || dirs.has(vpath);
  }
  function isDir(vpath) { return dirs.has(vpath); }
  function sizeOf(vpath) {
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
      const res = await fetch('./ikemen-fs/file/' + encodeURIComponent(vpath).replace(/%2F/gi, '/')
        + (globalThis.ikemenAssetStamp ? '?v=' + encodeURIComponent(globalThis.ikemenAssetStamp) : ''), { cache: 'no-cache' });
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
  function writeStd(fd, chunk) {
    if (fd === 1) {
      stdoutBuf += chunk;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) { console.log(stdoutBuf.slice(0, i)); stdoutBuf = stdoutBuf.slice(i + 1); }
    } else {
      stderrBuf += chunk;
      let i;
      while ((i = stderrBuf.indexOf('\n')) >= 0) { console.warn(stderrBuf.slice(0, i)); stderrBuf = stderrBuf.slice(i + 1); }
    }
  }

  const vfs = {
    constants: {
      O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL, O_DIRECTORY: 0o200000,
    },

    open(path, flags, mode, callback) {
      const vpath = norm(path);
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
  globalThis.ikemenMods = {
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
  globalThis.ikemenVfsInit = async function (manifestUrl, preloadList = [], onProgress) {
    // The manifest is fetched with no-store (never reuse ANY cached copy -
    // 'no-cache' revalidation proved insufficient in the field: one player
    // needed incognito mode to see a new build), and the big assets carry
    // the manifest's per-export stamp as ?v=, so their URLs change with
    // every export and no cache layer can serve yesterday's pak.
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    const data = await res.json();
    const stamp = data.stamp ? '?v=' + encodeURIComponent(data.stamp) : '';
    globalThis.ikemenAssetStamp = data.stamp || '';

    if (data.pack) {
      const packUrl = manifestUrl.replace(/manifest\.json$/, data.pack) + stamp;
      const packRes = await fetch(packUrl, { cache: 'no-cache' });
      const total = +packRes.headers.get('Content-Length') || 0;
      const reader = packRes.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(received, total);
      }
      const pak = new Uint8Array(received);
      { let o = 0; for (const c of chunks) { pak.set(c, o); o += c.length; } }
      for (const [vpath, [offset, length]] of Object.entries(data.files)) {
        if (length > 0) {
          contents.set(vpath, pak.subarray(offset, offset + length));
        }
        packedIndex.set(vpath, length);
        registerDirsFor(vpath);
      }
      // NOTE: Do NOT register lazy files (data.lazy) in the manifest.
      // If we did, exists() would return true for system.sff (9.2 MB),
      // system.snd (3.7 MB), etc., and the engine would try to fetch them
      // synchronously during gameplay, causing massive freezes.
      // By leaving them unregistered, exists() returns false, and the
      // engine skips them (which is correct — we don't use menus).
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
        const r = await fetch('./ikemen-fs/file/save/config.ini', { cache: 'no-cache' });
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

    // Put the shipped theme back, the same way the netcode choice is applied
    // below: config.ini is persisted whole, so a player's saved copy carries
    // whichever Motif they first booted and would pin them to it forever - the
    // site could change theme and nobody who had played before would see it.
    // Their key bindings live in the same file, so the file has to be kept and
    // only this line overridden.
    try {
      const cfg = contents.get('save/config.ini');
      if (shippedMotif && cfg) {
        const text = new TextDecoder().decode(cfg);
        const patched = /^\s*Motif\s*=/mi.test(text)
          ? text.replace(/^(\s*Motif\s*=\s*).+$/mi, '$1' + shippedMotif)
          : '[Config]\nMotif = ' + shippedMotif + '\n' + text;
        if (patched !== text) contents.set('save/config.ini', new TextEncoder().encode(patched));
      }
    } catch (e) { /* leave config as restored */ }

    // Apply the boot-page picture choice the same way. 720p is THREE TIMES the
    // pixels of 4:3 (921k vs 307k) and on this single-threaded build every one
    // of them comes out of the same budget as the game itself. The canvas takes its aspect
    // from its own backing store, which the engine sizes from these, so the
    // letterboxing follows without a second setting to keep in step.
    try {
      // Support either a preset ('16:9'/'4:3') or explicit {w,h} from JS.
      // Custom resolutions let users balance quality vs performance.
      let w = 1280, h = 720; // default 16:9
      const a = globalThis.ikemenAspect;
      if (a === '4:3') { w = 640; h = 480; }
      else if (a && typeof a === 'object') { w = a.w | 0; h = a.h | 0; }
      const cfg = contents.get('save/config.ini');
      if (cfg) {
        const text = new TextDecoder().decode(cfg);
        let patched = text.replace(/^(\s*GameWidth\s*=\s*)[0-9]+/mi, '$1' + w);
        patched = patched.replace(/^(\s*GameHeight\s*=\s*)[0-9]+/mi, '$1' + h);
        if (patched !== text) contents.set('save/config.ini', new TextEncoder().encode(patched));
      }
    } catch (e) { /* leave the shipped size */ }

    // Apply the boot-page netcode choice by patching RollbackNetcode in
    // config.ini in place, AFTER restorePersisted so it beats any persisted
    // config. Delay (=0) is the shipped default; Rollback (=1) is the opt-in
    // experimental mode. webrtc.js separately refuses a match if the two
    // players picked different modes.
    try {
      const nc = (globalThis.ikemenNetcode === 'rollback') ? 1 : 0;
      const cfg = contents.get('save/config.ini');
      if (cfg) {
        const text = new TextDecoder().decode(cfg);
        const patched = text.replace(/^(\s*RollbackNetcode\s*=\s*)[0-9]+/mi, '$1' + nc);
        if (patched !== text) contents.set('save/config.ini', new TextEncoder().encode(patched));
      }
    } catch (e) { /* leave config as shipped */ }

    // Re-stamp the debug font over any persisted config, same reasoning as the
    // theme above. Ctrl+D is the only view that shows invalid-ANIMATION errors
    // (they never reach the browser console), so it has to stay legible even
    // for players carrying a config.ini from an older build.
    try {
      const cfg = contents.get('save/config.ini');
      if (cfg && (shippedDebugFont || shippedDebugFontScale)) {
        const text = new TextDecoder().decode(cfg);
        let patched = text;
        if (shippedDebugFont) {
          patched = patched.replace(/^(\s*Font\s*=\s*).+$/mi, '$1' + shippedDebugFont);
        }
        if (shippedDebugFontScale) {
          patched = /^\s*FontScale\s*=/mi.test(patched)
            ? patched.replace(/^(\s*FontScale\s*=\s*).+$/mi, '$1' + shippedDebugFontScale)
            : patched.replace(/^(\s*Font\s*=\s*.+)$/mi, '$1\nFontScale = ' + shippedDebugFontScale);
        }
        if (patched !== text) contents.set('save/config.ini', new TextEncoder().encode(patched));
      }
    } catch (e) { /* leave config as restored */ }

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
      const pick = localStorage.getItem('ikemen-lite:motif');
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
      const tPick = localStorage.getItem('ikemen-lite:title-bgm');
      const sPick = localStorage.getItem('ikemen-lite:select-bgm');
      if (tPick || sPick) {
        const litePick = localStorage.getItem('ikemen-lite:motif');
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

    // Warm the cache in the background: without this, the first use of any
    // file mid-fight (a sound effect, a hit spark sheet) blocks the game
    // loop on a network fetch - felt as a random tiny freeze. Limited
    // concurrency so boot-critical fetches still win the bandwidth race.
    if (!data.pack) {
      const pending = [...manifest.keys()];
      const totalBytes = pending.reduce((n, p) => n + (manifest.get(p) || 0), 0);
      let doneBytes = 0;
      const workers = Array.from({ length: 4 }, async () => {
        while (pending.length) {
          const vpath = pending.shift();
          const size = manifest.get(vpath) || 0;
          if (!contents.has(vpath)) {
            await fetchFile(vpath).catch(() => {});
          }
          doneBytes += size;
          if (onProgress) onProgress(doneBytes, totalBytes);
        }
      });
      Promise.all(workers).then(() => console.log('[vfs] background prefetch complete'));
    }

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
      globalThis.ikemenBuildHash = out;
      globalThis.ikemenBuildHex =
        ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
    }

    // The online name the player set in NETWORK > PLAYER NAME. It lives in
    // save/config.ini (the engine's own settings file), which this module
    // already mirrors into localStorage - so it is browser-stored and survives
    // reloads without a second storage path. Read live from the VFS rather
    // than from localStorage, so a name set THIS session is visible before the
    // config is flushed. Exposed as a function because the player can change
    // it mid-session and callers must not cache it.
    globalThis.ikemenPlayerName = function () {
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
})();
