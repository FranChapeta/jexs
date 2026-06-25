import { Worker, type TransferListItem } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { TaskWorkerLike } from "@jexs/core";

/**
 * The one env-specific seam for spawning a leaf worker on the server: a
 * `worker_threads` worker running the bundle at `entryUrl`. Node's worker uses
 * `on("message")` rather than `onmessage`, so we adapt it to the `TaskWorkerLike`
 * shape the `thread` node expects. The call site supplies the entry URL.
 */
export function makeThreadWorker(entryUrl: URL | string): () => TaskWorkerLike {
  return () => {
    const w = new Worker(fileURLToPath(entryUrl));
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
