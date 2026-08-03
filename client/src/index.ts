import { registerNode, WorkerNode, ProxyNode, createResolver, coreNodes, Node } from "@jexs/core";
import { DomNode } from "./nodes/DomNode.js";
import { AudioNode } from "./nodes/AudioNode.js";
import { StorageNode } from "./nodes/StorageNode.js";
import { registerComputeLazy, registerDomLazy } from "./registerNodes.js";
import { makeModuleWorker } from "./makeWorker.js";
import { hydrate, pageContext } from "./events.js";

/** Eager client node set, combined with coreNodes to build the browser resolver. */
export const clientNodes: Node[] = [
  new DomNode(),
  new AudioNode(),
  new StorageNode(),
];

export { hydrate, pageContext };

// Re-export every node class so tools that want the full set of schemas
// (docs sites, validators, MCP introspection) can pull them without depending
// on internal paths. `clientNodes` above is the eager subset the runtime
// registers immediately; the rest are lazy-loaded in the browser branch below.
export { DomNode, AudioNode, StorageNode };
export { TreeNode } from "./nodes/TreeNode.js";
export { ListNode } from "./nodes/ListNode.js";
export { WsNode } from "./nodes/WsNode.js";
export { PushNode } from "./nodes/PushNode.js";
export { WebRTCNode } from "./nodes/WebRTCNode.js";
export { ServiceWorkerNode } from "./nodes/ServiceWorkerNode.js";

// Browser: build the resolver, expose a debug/hydration handle, and auto-hydrate.
if (typeof window !== "undefined") {
  createResolver([...coreNodes, ...clientNodes]);
  // `window.jexs` is a small handle: `context` for inspecting/seeding shared state,
  // `hydrate` for (re)binding events on server-injected content (see Server SSR).
  (window as unknown as Record<string, unknown>).jexs = { context: pageContext, hydrate };

  // Lazy node groups (loaded on first use). Compute groups are worker-safe; DOM
  // groups need the main thread. The resolver worker reuses registerComputeLazy
  // (the same blocks), so there are no duplicated node lists.
  registerComputeLazy();
  registerDomLazy();

  // `thread` node — runs `do` steps on a resolver Web Worker. The leaf bundle is
  // only FETCHED when the first `thread` step runs (URL resolved, not loaded).
  registerNode(new WorkerNode(makeModuleWorker(new URL("./resolverWorker.js", import.meta.url))));

  // Auto-forward main-process node calls (query, file, dialog, window, …) to a
  // native host over its IPC bridge, so they can be authored directly in renderer
  // JSON. First-wins registration means only the keys the renderer LACKS are
  // proxied; local nodes (dom, var, storage, …) stay local. Inert in a plain
  // browser with no host bridge.
  const host = (window as unknown as {
    jexsHost?: { keys?: string[]; invoke?: (call: unknown) => Promise<unknown> };
  }).jexsHost;
  if (host?.keys && host.invoke) {
    const invoke = host.invoke.bind(host);
    registerNode(new ProxyNode(host.keys, (call) => invoke(call)));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => hydrate());
  } else {
    hydrate();
  }
}
