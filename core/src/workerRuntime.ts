/**
 * Generic worker offload — run registered job functions on a worker thread over
 * SharedArrayBuffers. The ONE primitive any node uses to move a hot per-batch
 * loop off the main thread; it knows nothing about physics (or any job).
 *
 * One worker can host MANY jobs (e.g. many physics worlds): a worker is created
 * lazily per `workerKey` and reused, with each job addressed by name through its
 * own control block. A single `Atomics.waitAsync` poll loop on the worker scans
 * all its jobs and steps the ones with a pending batch — so jobs stay
 * independent and one worker thread serves them all, keeping the host thread
 * free.
 *
 * Main thread:
 *   `runOnWorker(makeWorker, workerKey, job, bufs)` → `{ step, stop }`. Reuses
 *   the worker bucketed under `workerKey` (spawning it via `makeWorker` on first
 *   use), registers `job` on it (one message, shares the SABs), and returns a
 *   non-blocking pipelined `step(count)`.
 *
 * Worker side:
 *   `runWorkerRuntime(setup, messages)`. The worker does ONE kind of work, so it
 *   passes its single `setup(bufs) -> step(count)` fn; the runtime applies it per
 *   registered id (e.g. one physics world per id) and owns the poll loop. The id
 *   is purely the control-block map key — no job-name registry.
 *
 * `makeWorker` is the only env-specific seam (worker_threads vs Web Worker).
 */
import { acquireWorker, releaseWorker } from "./workerPool.js";

// `Atomics.waitAsync` is ES2024; declare the one signature we use rather than
// raise the lib. Available in Node 16+ and modern browsers (where the loop runs).
declare global {
  interface Atomics {
    waitAsync(
      typedArray: Int32Array, index: number, value: number, timeout?: number,
    ): { async: false; value: "not-equal" | "timed-out" } | { async: true; value: Promise<"ok" | "timed-out"> };
  }
}

// ── Control block (private SAB handshake primitive) ────────────────────────────
// Per-unit Int32Array in its own SAB. The host bumps GO to request a batch; the
// worker sets DONE to the GO it finished. COUNT carries the batch size; QUIT ends
// the unit. (Was the separate `workerLoop` module — folded in as its only
// consumer.)
const CTRL_LEN = 4;
const IDX_GO = 0, IDX_DONE = 1, IDX_COUNT = 2, IDX_QUIT = 3;

/** Allocate a control block (host side). */
function makeControl(): { sab: SharedArrayBuffer; ctrl: Int32Array } {
  const sab = new SharedArrayBuffer(CTRL_LEN * 4);
  return { sab, ctrl: new Int32Array(sab) };
}

/** Host: request a batch of `count`. Returns the GO token for `isDone`. Non-blocking. */
function requestBatch(ctrl: Int32Array, count: number): number {
  Atomics.store(ctrl, IDX_COUNT, count);
  const go = Atomics.add(ctrl, IDX_GO, 1) + 1; // value after increment
  Atomics.notify(ctrl, IDX_GO);
  return go;
}

/** Host: non-blocking check whether the batch `go` has completed. */
function isDone(ctrl: Int32Array, go: number): boolean {
  return Atomics.load(ctrl, IDX_DONE) === go;
}

// ── Messages (host → worker) ───────────────────────────────────────────────────

/** Sent once when a worker is first created under a key. */
interface InitMsg { type: "init"; wakeSab: SharedArrayBuffer }
/** Register a unit of work on the worker, keyed by `id`: its control block +
 *  opaque buffers the worker's `setup` interprets. */
interface RegisterMsg { type: "register"; id: string; ctrlSab: SharedArrayBuffer; bufs: unknown }
/** Drop a unit of work (its control block is also QUIT by the host). */
interface UnregisterMsg { type: "unregister"; id: string }
export type WorkerMsg = InitMsg | RegisterMsg | UnregisterMsg;

/** Minimal worker surface core needs. Node `worker_threads` and browser `Worker`
 *  both satisfy it. */
export interface WorkerLike {
  postMessage(msg: WorkerMsg): void;
  terminate(): unknown; // worker_threads returns Promise<number>; Web Worker void
}

// ── Main thread: one worker per key, many jobs (over the shared pool) ──────────

/** Per-batch handle for one job; returned to the caller (the node drives it). */
export interface WorkerStepper {
  /** Request up to `count` units; non-blocking. `committed` is `count` when the
   *  batch launched, 0 when the worker is still busy (caller keeps the work). */
  step(count: number): { committed: number };
  /** Unregister this job; tears the worker down when its last job stops. */
  stop(): void;
}

/**
 * Register a unit of work `id` (with its `bufs`) on the worker bucketed under
 * `workerKey` (created lazily via `makeWorker`), and return a non-blocking
 * pipelined stepper. Reusing a key multiplexes ids onto one worker. `idleMs`
 * keeps the worker warm that long after its LAST unit stops (so a
 * destroy-then-recreate reuses it); default 0 = terminate immediately.
 */
export function runOnWorker(
  makeWorker: () => WorkerLike,
  workerKey: string,
  id: string,
  bufs: unknown,
  idleMs = 0,
): WorkerStepper {
  // Per-bucket state for this transport: the shared wake signal. Created once,
  // when the worker is first spawned for this key (the `init` message hands the
  // wake SAB to the worker's poll loop).
  const { worker, state: wakeView } = acquireWorker(workerKey, makeWorker, (w) => {
    const wakeSab = new SharedArrayBuffer(4);
    w.postMessage({ type: "init", wakeSab });
    return new Int32Array(wakeSab);
  });

  const { sab: ctrlSab, ctrl } = makeControl();
  worker.postMessage({ type: "register", id, ctrlSab, bufs });

  let pendingGo = 0; // GO token of the in-flight batch; 0 = none in flight

  return {
    step(count: number): { committed: number } {
      if (pendingGo === 0 || isDone(ctrl, pendingGo)) {
        pendingGo = requestBatch(ctrl, count);
        wake(wakeView); // bump the shared signal so the worker's poll loop scans
        return { committed: count };
      }
      return { committed: 0 }; // worker still busy — caller keeps the work
    },
    stop(): void {
      Atomics.store(ctrl, IDX_QUIT, 1);
      wake(wakeView); // wake the loop so it observes QUIT and drops the unit
      worker.postMessage({ type: "unregister", id });
      releaseWorker(workerKey, idleMs); // reap when last unit stops (after idleMs)
    },
  };
}

/** Bump a shared wake counter and notify the worker's poll loop. */
function wake(w: Int32Array): void {
  Atomics.add(w, 0, 1);
  Atomics.notify(w, 0);
}

// ── Worker side: one setup fn + one poll loop ──────────────────────────────────

/** A worker's setup: given a registered unit's shared buffers, return its
 *  per-batch step fn. Called once per `register`; `step(count)` runs each batch. */
export type WorkerSetup = (bufs: unknown) => (count: number) => void;

/** One registered unit's worker-side state. `seen` is the last GO it handled. */
interface LiveUnit { ctrl: Int32Array; step: (count: number) => void; seen: number }

/** Wires the worker transport's message event to a handler. The env worker entry
 *  supplies this — `h => parentPort.on("message", h)` (Node) or
 *  `h => { self.onmessage = e => h(e.data); }` (browser). Core owns the rest. */
export type Subscribe = (handler: (msg: WorkerMsg) => void) => void;

/**
 * Worker-side runtime. The worker does ONE kind of work, so it passes its single
 * `setup`; the runtime applies it per registered id. `subscribe` wires the
 * transport's message event to core's handler — no queue/iterator boilerplate in
 * the env entry. `init` captures the shared wake signal and starts the poll loop;
 * `register` builds a unit's `step` via `setup(bufs)`; `unregister` drops it.
 */
export function runWorkerRuntime(setup: WorkerSetup, subscribe: Subscribe): void {
  const live = new Map<string, LiveUnit>();
  let wakeView: Int32Array | null = null;

  subscribe((msg) => {
    if (msg.type === "init") {
      wakeView = new Int32Array(msg.wakeSab);
      void pollLoop(live, wakeView);
    } else if (msg.type === "register") {
      live.set(msg.id, { ctrl: new Int32Array(msg.ctrlSab), step: setup(msg.bufs), seen: 0 });
      if (wakeView) wake(wakeView); // ensure the loop scans the new unit
    } else {
      live.delete(msg.id);
    }
  });
}

/**
 * The single poll loop servicing all jobs. Uses `Atomics.waitAsync` (NOT the
 * blocking `wait`) so the worker thread stays free to process register/
 * unregister messages between batches — a blocking wait would starve the message
 * pump and deadlock multi-job registration.
 */
async function pollLoop(live: Map<string, LiveUnit>, wakeView: Int32Array): Promise<void> {
  let seen = 0;
  for (;;) {
    const r = Atomics.waitAsync(wakeView, 0, seen);
    if (r.async) await r.value; // resolves on notify; sync return when already changed
    seen = Atomics.load(wakeView, 0);
    for (const [name, j] of live) {
      if (Atomics.load(j.ctrl, IDX_QUIT) !== 0) { live.delete(name); continue; }
      const go = Atomics.load(j.ctrl, IDX_GO);
      if (go === j.seen) continue; // no new batch
      j.step(Atomics.load(j.ctrl, IDX_COUNT));
      j.seen = go;
      Atomics.store(j.ctrl, IDX_DONE, go);
      Atomics.notify(j.ctrl, IDX_DONE);
    }
  }
}
