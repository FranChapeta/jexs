import {
  registerNode, WorkerNode, ProxyNode, createResolver, resolve, runSteps, childContext,
  coreNodes, Node,
} from "@jexs/core";
import { DomNode } from "./nodes/DomNode.js";
import { AudioNode } from "./nodes/AudioNode.js";
import { StorageNode } from "./nodes/StorageNode.js";
import { registerComputeLazy, registerDomLazy } from "./registerNodes.js";
import { makeModuleWorker } from "./makeWorker.js";
import { hydrate, pageContext } from "./events.js";
import { serializable } from "./serializable.js";

/**
 * The bridge a native host (Electron main) injects. Every member is optional so
 * an older host, or a plain browser, simply gets fewer capabilities rather than
 * an error.
 */
/** A single node call to resolve here — one proxied op. */
interface HostCall {
  id: number;
  call: unknown;
}

/** A step array to run here, with `params` scoped into it. */
interface HostSteps {
  id: number;
  steps: unknown[];
  params?: Record<string, unknown>;
}

/** Exactly one of the two, discriminated by the presence of `steps`. */
type HostMessage = HostCall | HostSteps;

interface JexsHost {
  /** Handler keys the host owns, read synchronously before any step runs. */
  keys?: string[];
  /** Forward a locally-resolved call to the host. */
  invoke?: (call: unknown) => Promise<unknown>;
  /** Report which keys live here, so the host can proxy them back. */
  announce?: (keys: string[]) => void;
  /** Keys the host registered after this page loaded. */
  onKeys?: (cb: (added: string[]) => void) => void;
  /**
   * Receive work pushed from the host. Either a single node call, or a step
   * array with optional scoped params — never both.
   */
  onCall?: (cb: (message: HostMessage) => void) => void;
  /** Answer a pushed call on its correlation id. */
  reply?: (id: number, value: unknown, error?: string) => void;
}

/** Eager client node set, combined with coreNodes to build the browser resolver.
 *  A factory for the same reason coreNodes is one: a resolver owns its instances. */
export function clientNodes(): Node[] {
  return [
    new DomNode(),
    new AudioNode(),
    new StorageNode(),
  ];
}

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
  const resolver = createResolver([...coreNodes(), ...clientNodes()]);
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
  const host = (window as unknown as { jexsHost?: JexsHost }).jexsHost;
  if (host?.keys && host.invoke) {
    const invoke = host.invoke.bind(host);
    const toHost = new ProxyNode(host.keys, (call) => invoke(call));
    registerNode(toHost);

    // The host can register nodes after this page loaded, so its key set is not
    // frozen at preload time. Re-registering installs the new keys; only ones
    // the resolver lacks are added, so local handlers still win.
    host.onKeys?.((added) => {
      if (toHost.addKeys(added).length > 0) registerNode(toHost);
    });

    // The mirror direction: tell the host which keys live here, so it can proxy
    // DOM ops back. Keys this renderer only holds VIA the host are excluded --
    // announcing those would send a key back where it came from, and with more
    // than one window that becomes an infinite forwarding loop.
    if (host.announce) {
      const announce = host.announce.bind(host);
      const own = (ks: Iterable<string>) => [...ks].filter((k) => !toHost.claims(k));
      announce(own(resolver.keys));
      // registerNode can run at any time (a lazy module loading, a plugin), so
      // the host is kept current rather than handed a boot-time snapshot.
      resolver.onKeysChange((added) => {
        const fresh = own(added);
        if (fresh.length > 0) announce(fresh);
      });
    }

    // Run work pushed from the host against the SAME pageContext DOM event
    // handlers use, so host-driven state is visible to the page and vice versa.
    // `steps` gets a child scope for its params, which also gives `as` + `bubble`
    // write-through to pageContext, matching FileNode's params semantics.
    if (host.onCall && host.reply) {
      const reply = host.reply.bind(host);
      host.onCall((message) => {
        Promise.resolve()
          .then(() => {
            if (!("steps" in message)) return resolve(message.call, pageContext);
            const scope = message.params
              ? childContext(pageContext, message.params)
              : pageContext;
            return runSteps(message.steps, scope);
          })
          .then(
            (value) => reply(message.id, serializable(value)),
            (err) => reply(message.id, null, String((err as Error)?.message ?? err)),
          );
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => hydrate());
  } else {
    hydrate();
  }
}
