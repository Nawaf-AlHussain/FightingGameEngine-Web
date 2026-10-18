// Off-main-thread gzip client for the boot pipeline.
//
// WHY: the /play cold boot runs wasm compile + pak decompress + character
// materialization + engine start against ONE main thread (the "cold-boot
// pile-up" stress finding). The two .gz streams (engine.wasm.gz ~5.4 MB,
// game.pak.gz ~2 MB compressed) decompress through DecompressionStream,
// whose inflate work lands on whatever thread pumps the stream — the main
// thread today. This module relocates that to a worker and hands the
// result back as a TRANSFERRED ReadableStream: no byte is ever copied
// between threads, so the JS heap never holds two copies of anything
// (that is the phone-memory guard — there is nothing extra to gate on
// detectMemoryConstrained()).
//
// FALLBACK CONTRACT (kill-switch + graceful degradation):
//  - localStorage 'fg-boot-worker' = 'off'  -> engineGzipDecode returns null
//  - Worker / transferable-stream support missing -> null
//  - Worker crashed, ping timeout, or worker-side DecompressionStream
//    missing -> null (and the worker is marked dead for the session)
// The stream-consuming caller only transfers its response body when this
// returns a stream — a null means "use the old inline path untouched".
// A failure AFTER a successful transfer bubbles to the caller's existing
// catch (raw wasm / raw pak re-fetch — rare, correct).

const WORKER_URL = '/game/decompress-worker.js';
const KILL_SWITCH_KEY = 'fg-boot-worker';
const PING_TIMEOUT_MS = 5000;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let workerDead = false;
let seq = 0;
const pending = new Map<number, Pending>();
let transferSupported: boolean | null = null; // null = not probed yet
// Session counters for the boot-stats HUD (real-phone verification): a null
// return here is the caller's signal to use its inline DecompressionStream
// path, so counting at the return sites is an honest worker-vs-inline tally.
let workerSuccesses = 0;
let inlineFallbacks = 0;

/** How many .gz streams went through the worker vs the inline fallback this
 *  session. Rendered in the boot-stats HUD so a phone screenshot proves
 *  which path actually ran (the kill-switch flag alone can lie if the
 *  worker silently fell back). */
export function bootGzStats(): { worker: number; inline: number } {
  return { worker: workerSuccesses, inline: inlineFallbacks };
}

function killSwitched(): boolean {
  try {
    return localStorage.getItem(KILL_SWITCH_KEY) === 'off';
  } catch {
    return false; // private mode — no switch, use the worker
  }
}

/** Transferable-stream probe: postMessage throws synchronously when the
 *  environment cannot transfer a ReadableStream (old Safari/Firefox). */
function probeTransferSupport(): boolean {
  if (transferSupported !== null) return transferSupported;
  try {
    const ch = new MessageChannel();
    const probe = new ReadableStream({
      start(c) { try { c.close(); } catch { /* ignore */ } },
    });
    ch.port1.onmessage = () => { /* probe reply ignored */ };
    ch.port2.postMessage(probe, [probe]);
    transferSupported = true;
  } catch {
    transferSupported = false;
  }
  return transferSupported;
}

function dropWorker(): void {
  workerDead = true;
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  for (const [, p] of pending) p.reject(new Error('decompress worker terminated'));
  pending.clear();
}

async function ensureWorker(): Promise<Worker> {
  if (workerDead) throw new Error('decompress worker unavailable');
  if (worker) return worker;
  const w = new Worker(WORKER_URL);
  w.onmessage = (e: MessageEvent) => {
    const msg = e.data || {};
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.err || 'worker gunzip failed'));
  };
  w.onerror = () => dropWorker();
  // Handshake: never transfer a body into a worker that cannot gunzip.
  const pingId = ++seq;
  const pong = new Promise<{ gzip?: boolean }>((resolve, reject) => {
    pending.set(pingId, { resolve: resolve as (v: unknown) => void, reject });
    setTimeout(() => {
      if (pending.delete(pingId)) reject(new Error('decompress worker ping timeout'));
    }, PING_TIMEOUT_MS);
  });
  w.postMessage({ id: pingId, op: 'ping' });
  const reply = await pong;
  if (!reply.gzip) throw new Error('DecompressionStream missing in worker');
  worker = w;
  return w;
}

/**
 * Decompress a gzip ReadableStream in the worker. Returns the decompressed
 * stream (transferred, unlocked), or null when the off-thread path is
 * unavailable/kill-switched — the caller then uses its existing inline
 * DecompressionStream path. `label` names the asset in error logs only.
 *
 * NOTE: on the success path the INPUT stream is consumed (transferred
 * away). Callers must only pass a body they are prepared to lose.
 */
export async function engineGzipDecode(
  stream: ReadableStream<Uint8Array>,
  label: string,
): Promise<ReadableStream<Uint8Array> | null> {
  if (killSwitched()) { inlineFallbacks++; return null; }
  if (typeof Worker !== 'function') { inlineFallbacks++; return null; }
  if (!probeTransferSupport()) { inlineFallbacks++; return null; }

  let w: Worker;
  try {
    w = await ensureWorker();
  } catch {
    dropWorker();
    inlineFallbacks++;
    return null;
  }

  const id = ++seq;
  try {
    const reply = await new Promise<{ stream?: ReadableStream<Uint8Array> }>(
      (resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        w.postMessage({ id, op: 'gunzip', stream }, [stream]);
      },
    );
    if (reply.stream) workerSuccesses++;
    return reply.stream ?? null;
  } catch (e) {
    pending.delete(id);
    // Worker-side gunzip failed after the transfer — surface the error so
    // the caller's catch falls back to the raw (uncompressed) fetch.
    console.warn('[boot] worker gunzip failed for ' + label + ':', e instanceof Error ? e.message : e);
    throw e;
  }
}
