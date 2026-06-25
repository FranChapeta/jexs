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
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { runWorkerRuntime, type WorkerLike } from "@jexs/core";
import { physicsSetup } from "@jexs/physics";

/** Env worker constructor passed to `new PhysicsNode(...)`. */
export function makePhysicsWorker(): WorkerLike {
  const worker = new Worker(fileURLToPath(import.meta.url));
  worker.on("error", (e) => console.error("[Physics worker]", e));
  return worker;
}

// Worker-thread entry: wire parentPort messages straight to the core runtime.
if (!isMainThread && parentPort) {
  const port = parentPort;
  runWorkerRuntime(physicsSetup, (h) => port.on("message", h));
}
