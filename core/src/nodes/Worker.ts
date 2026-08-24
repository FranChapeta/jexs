import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveSteps } from "../Resolver.js";
import { collectTransferables } from "../helpers.js";
import { acquireWorker, releaseWorker, type TaskWorkerLike } from "../workerPool.js";
import type { JexsNodeSchema } from "../schema.js";

/** One request/response over a thread, matched by `rid`. The worker entry posts
 *  back `{ rid, result }` or `{ rid, error }`. */
interface ThreadResponse { rid: number; result?: unknown; error?: string }

/** Per-thread bucket state held by the pool: in-flight promises + next id. */
interface ThreadState {
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextRid: number;
}

/** Default warm-keep window (ms) a thread stays alive after its last in-flight
 *  step before the pool reaps it. A burst keeps it warm; a lull past this reaps
 *  it. Override per-step with `idle` (0 = reap now; large = long-lived). */
const DEFAULT_IDLE_MS = 10_000;

/**
 * `thread` — run resolver `do` steps on another thread, off the main one.
 *
 * The node is self-contained: it does its own request/response rid-matching over
 * the core worker pool (no separate task layer). The `thread` value names the
 * thread (the pool key) — same name shares one warm worker, different names run
 * on different threads. `params` is the explicit payload (the ONLY thing that
 * crosses, and the worker's context); `ArrayBuffer`s inside it transfer
 * zero-copy. The node returns the worker's result as a Promise, so it can be
 * awaited, collected (e.g. under `map`/`foreach parallel`), or made
 * fire-and-forget with the universal `then` continuation (which runs on the
 * calling — main — thread with `$result` bound).
 *
 * `makeWorker` is the env seam (browser `Worker` / Node `worker_threads`); null
 * means no worker is available and the steps run inline on the main thread, so
 * the same JSON works everywhere (mirroring how physics degrades).
 */
export class WorkerNode extends Node {
  static schema: JexsNodeSchema = {
    thread: {
      output: "any",
      markdownDescription: "Runs the `do` steps on another thread (off the main thread), keeping the main thread responsive. The value names the thread: the SAME name shares one warm worker (work time-shares that one CPU), DIFFERENT names run on parallel threads. `params` is the only data that crosses and becomes the worker's context (`$x`); `ArrayBuffer`s in `params` transfer zero-copy (and detach on the sender). The node resolves to the worker's result, so collect N at once with `{ map, parallel: true, do: { thread } }`, or add the universal `then` to make the call FIRE-AND-FORGET (returns immediately; `then` runs on the main thread with `$result`). Note: a worker has no DOM/`window`/`localStorage`/WebGL, so it is for compute, `fetch`, and crypto. `thread` is a MAIN-thread node: don't nest it inside another `thread`'s `do` (it isn't available there). For parallelism use sibling threads from the main thread, e.g. `{ map, parallel: true, do: { thread } }`.",
      outputDescription: "The worker's result (a Promise the resolver awaits). Errors run the `catch` array with `$error` bound, like any node.",
      examples: [
        "{ \"thread\": \"hash\", \"params\": { \"bytes\": { \"var\": \"$bytes\" } }, \"do\": [ { \"hash\": { \"var\": \"$bytes\" } } ] }",
      ],
      siblings: {
        params: {
          description: "Object passed to the thread: the ONLY data that crosses, and the worker's context (its keys become `$key`). `ArrayBuffer` values transfer zero-copy (detaching the source). Must be structured-cloneable (no DOM nodes, functions, class instances).",
        },
        do: {
          description: "Steps to run on the thread, resolved against `params` as context.",
        },
        idle: {
          type: "number",
          description: "Milliseconds to keep the thread warm after its last step before reaping it (default 10000). `0` reaps immediately; a large value keeps a long-lived thread.",
        },
      },
    },
  };

  private readonly makeWorker: (() => TaskWorkerLike) | null;

  constructor(makeWorker: (() => TaskWorkerLike) | null) {
    super();
    this.makeWorker = makeWorker;
  }

  thread(def: Record<string, unknown>, context: Context): NodeValue {
    const threadVal = def.thread;
    const name = typeof threadVal === "string" ? threadVal : "default";
    const steps = Array.isArray(threadVal) ? threadVal : def.do;
    const idleMs = def.idle != null ? Number(def.idle) : DEFAULT_IDLE_MS;

    // Resolve `params` on the main thread so `{var:$x}` etc. become concrete
    // before they cross. The resolved object is the payload AND the worker's
    // context. Bare shorthand (no params) → empty context.
    return resolve(def.params ?? {}, context, (paramsRaw) => {
      const params = this.isObject(paramsRaw) ? paramsRaw : {};

      // Fallback: no worker available → run inline on the main thread so the same
      // JSON works everywhere. Otherwise return the worker's Promise — the caller
      // may await it, collect it, or make it fire-and-forget via the universal
      // `then` (which the resolver applies to this result).
      if (!this.makeWorker) return resolveSteps(steps, params as Context);
      return this.dispatch(name, steps, params, idleMs);
    });
  }

  /** Post one request to the named thread and return a Promise for its result.
   *  Owns the rid-matching directly over the pool (no separate task layer). */
  private dispatch(
    name: string,
    steps: unknown,
    params: Record<string, unknown>,
    idleMs: number,
  ): Promise<unknown> {
    const { worker, state } = acquireWorker<TaskWorkerLike, ThreadState>(name, this.makeWorker!, (w) => {
      const st: ThreadState = { pending: new Map(), nextRid: 1 };
      w.onmessage = (ev) => {
        const { rid, result, error } = ev.data as ThreadResponse;
        const p = st.pending.get(rid);
        if (!p) return;
        st.pending.delete(rid);
        if (error !== undefined) p.reject(new Error(error));
        else p.resolve(result);
      };
      // A clone failure (onmessageerror) or a top-level worker fault (onerror)
      // can't be matched to one rid — reject ALL in-flight so no Promise hangs.
      const failAll = (msg: string) => {
        for (const p of st.pending.values()) p.reject(new Error(msg));
        st.pending.clear();
      };
      w.onmessageerror = () => failAll("worker message could not be deserialized");
      w.onerror = () => failAll("worker error");
      return st;
    });

    const rid = state.nextRid++;
    return new Promise<unknown>((resolve, reject) => {
      state.pending.set(rid, { resolve, reject });
      worker.postMessage({ rid, steps, params }, collectTransferables(params));
    }).finally(() => releaseWorker(name, idleMs));
  }
}
