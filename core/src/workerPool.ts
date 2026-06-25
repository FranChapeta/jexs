/**
 * Shared worker-bucket layer — lazily create ONE worker per key and reuse it,
 * with a refcount so it's torn down when its last consumer leaves. Both worker
 * users build on this:
 *   - `runOnWorker` (SAB continuous loop) attaches a wake signal + job count.
 *   - `WorkerNode` (one-shot postMessage) attaches a pending-promise map.
 * The transport choice stays explicit (their return contracts differ — a stepper
 * vs a promise); only the keyed worker lifecycle is shared here.
 *
 * `T` is the per-bucket state a consumer attaches (built once via `init`).
 */

/** Minimal worker surface: post a message, tear it down. Node `worker_threads`
 *  and the browser `Worker` both satisfy it (the transport-specific message/
 *  transfer typing lives in each consumer). */
export interface PooledWorker {
  postMessage(msg: unknown, transfer?: unknown[]): void;
  terminate(): unknown;
}

/** A worker that talks one-shot request/response over `postMessage`. The host
 *  posts a message (optionally transferring buffers) and listens via `onmessage`;
 *  `onmessageerror` fires on a structured-clone failure, `onerror` on a top-level
 *  worker fault. Node `worker_threads` and the browser `Worker` both fit (the env
 *  worker constructor adapts Node's `on("message")` to `onmessage`). The
 *  `WorkerNode` rid-matches over this; the worker lifecycle is the pool's. */
export interface TaskWorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onmessageerror?: ((ev: unknown) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
  terminate(): unknown;
}

interface Bucket<T> {
  worker: PooledWorker;
  state: T;
  refs: number;
  /** Pending idle-reap timer when refs hit 0 with a grace period; cancelled if
   *  the worker is re-acquired within the window (warm reuse). */
  reapTimer: ReturnType<typeof setTimeout> | null;
}

const pools = new Map<string, Bucket<unknown>>();

/**
 * Get (or lazily create) the worker bucketed under `key`. On first use,
 * `makeWorker()` spawns it and `init(worker)` builds the consumer's per-bucket
 * state (e.g. the wake SAB, or the pending map + onmessage handler). Increments
 * the refcount; pair every `acquire` with one `release`. `W` is the consumer's
 * concrete worker type (its transport-specific postMessage typing). */
export function acquireWorker<W extends PooledWorker, T>(
  key: string,
  makeWorker: () => W,
  init: (worker: W) => T,
): { worker: W; state: T } {
  let b = pools.get(key) as Bucket<T> & { worker: W } | undefined;
  if (!b) {
    const worker = makeWorker();
    b = { worker, state: init(worker), refs: 0, reapTimer: null };
    pools.set(key, b as unknown as Bucket<unknown>);
  } else if (b.reapTimer !== null) {
    clearTimeout(b.reapTimer); // re-acquired within the idle window → stay warm
    b.reapTimer = null;
  }
  b.refs++;
  return { worker: b.worker, state: b.state };
}

/**
 * Release one reference to the worker under `key`. At zero refs it is terminated
 * — immediately, or after an `idleMs` grace period during which a re-`acquire`
 * cancels the reap and reuses the warm worker (avoids spawn thrash for bursty
 * use). `idleMs` 0/undefined = terminate now; Infinity = never auto-reap.
 */
export function releaseWorker(key: string, idleMs = 0): void {
  const b = pools.get(key);
  if (!b || b.refs <= 0) return;
  if (--b.refs > 0) return;
  if (idleMs <= 0 || !isFinite(idleMs)) {
    if (idleMs <= 0) { reap(key, b); }       // immediate
    return;                                  // Infinity → keep until next release
  }
  if (b.reapTimer !== null) clearTimeout(b.reapTimer);
  b.reapTimer = setTimeout(() => { if (b.refs <= 0) reap(key, b); }, idleMs);
}

function reap(key: string, b: Bucket<unknown>): void {
  if (b.reapTimer !== null) { clearTimeout(b.reapTimer); b.reapTimer = null; }
  void b.worker.terminate();
  pools.delete(key);
}

/** The live worker + state under `key`, or null. Lets a consumer reach its
 *  attached state (e.g. to reject pending promises) without changing refcounts. */
export function peekWorker<W extends PooledWorker, T>(key: string): { worker: W; state: T } | null {
  const b = pools.get(key) as (Bucket<T> & { worker: W }) | undefined;
  return b ? { worker: b.worker, state: b.state } : null;
}

/** Force-terminate the worker under `key` now, regardless of refs/idle timer.
 *  For explicit teardown. */
export function terminateWorker(key: string): void {
  const b = pools.get(key);
  if (b) reap(key, b);
}
