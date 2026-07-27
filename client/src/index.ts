import { registerNode, WorkerNode } from "@jexs/core";
import { Client } from "./Client.js";
import { registerComputeLazy, registerDomLazy } from "./registerNodes.js";
import { makeModuleWorker } from "./makeWorker.js";

export { Client, clientNodes } from "./Client.js";

// Re-export every node class so tools that want the full set of schemas
// (docs sites, validators, MCP introspection) can pull them without depending
// on internal paths. `clientNodes` stays as the eager subset the runtime
// registers immediately; the rest are lazy-loaded in the browser branch below.
export { DomNode } from "./nodes/DomNode.js";
export { AudioNode } from "./nodes/AudioNode.js";
export { TreeNode } from "./nodes/TreeNode.js";
export { ListNode } from "./nodes/ListNode.js";
export { WsNode } from "./nodes/WsNode.js";
export { PushNode } from "./nodes/PushNode.js";
export { WebRTCNode } from "./nodes/WebRTCNode.js";
export { ServiceWorkerNode } from "./nodes/ServiceWorkerNode.js";
export { StorageNode } from "./nodes/StorageNode.js";

// Browser: expose globally and auto-init on DOMContentLoaded
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).Jexs = Client;
  const client = new Client();
  (window as unknown as Record<string, unknown>).jexs = client;

  // Lazy node groups (loaded on first use). Compute groups are worker-safe; DOM
  // groups need the main thread. The resolver worker reuses registerComputeLazy
  // (the same blocks), so there are no duplicated node lists.
  registerComputeLazy();
  registerDomLazy(client);

  // `thread` node — runs `do` steps on a resolver Web Worker. The leaf bundle is
  // only FETCHED when the first `thread` step runs (URL resolved, not loaded).
  registerNode(new WorkerNode(makeModuleWorker(new URL("./resolverWorker.js", import.meta.url))));

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => client.initEvents());
  } else {
    client.initEvents();
  }
}
