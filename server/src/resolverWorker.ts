/**
 * Server resolver worker entry (Node `worker_threads`) for the `thread` node.
 * When loaded as a worker (`!isMainThread`), it builds a resolver from
 * `coreNodes` + `serverNodes` and runs each request's `do` steps against its
 * `params` as context, posting the result back (transferring any `ArrayBuffer`).
 *
 * Importing this file on the main thread is a no-op (the guard skips the entry),
 * so `serverNodes` can construct `new WorkerNode(makeThreadWorker(thisUrl))` and
 * the worker re-enters this same file without spawning a second worker.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createResolver, coreNodes, runSteps, collectTransferables } from "@jexs/core";
import { serverNodes } from "./index.js";

interface ThreadRequest { rid: number; steps: unknown; params: Record<string, unknown> }

if (!isMainThread && parentPort) {
  const port = parentPort;
  // The spawning serverNodes() set passes its `root` via workerData, so file ops
  // in `thread` steps resolve against the same base as the main thread.
  const root = workerData && typeof workerData === "object" && "root" in workerData
    ? String((workerData as { root: unknown }).root)
    : "app";
  createResolver([...coreNodes(), ...serverNodes({ root })]);
  port.on("message", (req: ThreadRequest) => {
    const { rid, steps, params } = req;
    // `.then(() => runSteps(...))` so a SYNC throw from runSteps is caught too.
    Promise.resolve()
      .then(() => runSteps(steps as unknown[], params))
      .then((result) => port.postMessage({ rid, result }, collectTransferables(result) as readonly import("node:worker_threads").TransferListItem[]))
      .catch((err: unknown) => port.postMessage({ rid, error: err instanceof Error ? err.message : String(err) }));
  });
}
