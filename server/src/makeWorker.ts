import { Worker, type TransferListItem } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { TaskWorkerLike } from "@jexs/core";

/**
 * The one env-specific seam for spawning a leaf worker on the server: a
 * `worker_threads` worker running the bundle at `entryUrl`. Node's worker uses
 * `on("message")` rather than `onmessage`, so we adapt it to the `TaskWorkerLike`
 * shape the `thread` node expects. The call site supplies the entry URL and, when
 * the worker entry needs boot config (e.g. the file-nodes `root`), a structured-
 * cloneable `workerData` payload the entry reads from `node:worker_threads`.
 */
export function makeThreadWorker(entryUrl: URL | string, workerData?: unknown): () => TaskWorkerLike {
  return () => {
    const w = new Worker(fileURLToPath(entryUrl), { workerData });
    const like: TaskWorkerLike = {
      postMessage: (msg, transfer) => w.postMessage(msg, (transfer ?? []) as unknown as readonly TransferListItem[]),
      onmessage: null,
      onmessageerror: null,
      onerror: null,
      terminate: () => w.terminate(),
    };
    w.on("message", (data) => like.onmessage?.({ data }));
    w.on("messageerror", (err) => like.onmessageerror?.(err));
    w.on("error", (err) => like.onerror?.(err));
    return like;
  };
}
