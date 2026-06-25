import type { WorkerLike, TaskWorkerLike } from "@jexs/core";

/**
 * The one env-specific seam for spawning a leaf worker bundle in the browser: a
 * module Web Worker at `url`. The browser `Worker` already satisfies both worker
 * shapes core needs — `WorkerLike` (SAB physics, `runOnWorker`) and
 * `TaskWorkerLike` (the `thread` node) — so one factory serves both; the call
 * site supplies the bundle URL. The bundle is only FETCHED when the worker is
 * first spawned (the URL is resolved, not loaded, until then).
 */
export function makeModuleWorker(url: URL | string): () => WorkerLike & TaskWorkerLike {
  return () => {
    const worker = new Worker(url, { type: "module" });
    worker.addEventListener("error", (e) => console.error("[Jexs worker]", e.message));
    return worker as unknown as WorkerLike & TaskWorkerLike;
  };
}
