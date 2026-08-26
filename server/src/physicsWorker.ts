/**
 * Server-side physics worker glue (Node worker_threads). Two tiny halves:
 *
 *  - `makePhysicsWorker`: the env worker constructor the Server hands to
 *    `new PhysicsNode(makePhysicsWorker)`. Spawns a worker_threads worker that
 *    re-enters this file. Core's `runOnWorker` lazily creates ONE such worker and
 *    multiplexes all physics worlds onto it.
 *
 *  - The worker-thread entry (`!isMainThread`): wires `parentPort` messages
 *    straight into core's `runWorkerRuntime`. All the SAB/handshake/poll/queue
 *    machinery lives in @jexs/core.
 *
 * `@jexs/physics` is an OPTIONAL peer, so it is imported DYNAMICALLY and only on
 * the worker thread — a server that routes requests and queries a database
 * should not have to install a physics engine. The main-thread half never
 * touches it: `makePhysicsWorker` only spawns the worker. A static import would
 * load the package for anyone who so much as imports the barrel, since
 * `index.ts` re-exports this module.
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { runWorkerRuntime, type WorkerLike } from "@jexs/core";

/** Env worker constructor passed to `new PhysicsNode(...)`. */
export function makePhysicsWorker(): WorkerLike {
  const worker = new Worker(fileURLToPath(import.meta.url));
  worker.on("error", (e) => console.error("[Physics worker]", e));
  return worker;
}

// Worker-thread entry: wire parentPort messages straight to the core runtime.
// Failing loudly here is right — the worker is spawned lazily, on the first
// physics op, so reaching this point means the package is genuinely needed.
if (!isMainThread && parentPort) {
  const port = parentPort;
  void import("@jexs/physics")
    .catch((err: unknown) => {
      throw new Error(
        "physics ops require \"@jexs/physics\", which is not installed. Run: npm i @jexs/physics",
        { cause: err },
      );
    })
    .then(({ physicsSetup }) => {
      runWorkerRuntime(physicsSetup, (h) => port.on("message", h));
    });
}
