import {
  WorkerNode, ProxyNode, createResolver, childContext, stepFields,
  coreNodes, Node, type Resolver, type StepFields,
} from "@jexs/core";
import { DomNode } from "./nodes/Dom.js";
import { AudioNode } from "./nodes/Audio.js";
import { StorageNode } from "./nodes/Storage.js";
import { registerComputeLazy, registerDomLazy } from "./registerNodes.js";
import { makeModuleWorker } from "./makeWorker.js";
import { hydrate, pageContext } from "./events.js";
import { addCsrfField } from "./csrf.js";
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
  /** The fields of the host's ops that hold steps, forwarded unresolved. */
  steps?: StepFields;
  /** Forward a locally-resolved call to the host. */
  invoke?: (call: unknown) => Promise<unknown>;
  /** Report which keys live here, and their step fields, so the host can proxy them back. */
  announce?: (keys: string[], steps: StepFields) => void;
  /** Keys the host registered after this page loaded, with their step fields. */
  onKeys?: (cb: (added: string[], steps?: StepFields) => void) => void;
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
// Every node class, for wiring a resolver by hand rather than through `boot()`,
// which registers the eager three itself and loads the rest on first use. A
// bundle drops the ones it does not import, so the page pays nothing for these.
export { DomNode, AudioNode, StorageNode };
export { WsNode } from "./nodes/Ws.js";
export { PushNode } from "./nodes/Push.js";
export { WebRTCNode } from "./nodes/WebRTC.js";
export { ServiceWorkerNode } from "./nodes/ServiceWorker.js";

let booted = false;

/**
 * Start Jexs on this page: build its resolver with the core and client nodes and
 * any `nodes` given (an app's own, or a third-party package's), wire the lazy
 * node groups, the worker and any native host bridge, then hydrate the page and
 * register the service worker the server named. The nodes are registered before
 * hydrating, so a `load` handler can use them. Once per page; the entry
 * `jexs bundle` writes calls it with the project's browser node packages.
 */
export function boot({ nodes = [] }: { nodes?: Node[] } = {}): Resolver {
  if (typeof window === "undefined") throw new Error("boot() runs in a browser window.");
  if (booted) throw new Error("This page is already booted: boot() runs once, with every node the page needs.");
  booted = true;

  // `pageContext` is the resolver's root scope: DOM event handlers run steps
  // against it long after any resolve returned, so it has to be attached up
  // front rather than by the first call. Every scope derived from it inherits.
  const resolver = createResolver([...coreNodes(), ...clientNodes(), ...nodes], { context: pageContext });
  // `window.jexs` is a small handle: `context` for inspecting/seeding shared state,
  // `hydrate` for (re)binding events on server-injected content (see Server SSR).
  (window as unknown as Record<string, unknown>).jexs = { context: pageContext, hydrate, resolver };

  // Lazy node groups (loaded on first use). Compute groups are worker-safe; DOM
  // groups need the main thread. The resolver worker reuses registerComputeLazy
  // (the same blocks), so there are no duplicated node lists.
  registerComputeLazy(resolver);
  registerDomLazy(resolver);

  // Captured on the document, so every form's submission gets the token.
  document.addEventListener("formdata", addCsrfField, true);

  // `thread` node — runs `do` steps on a resolver Web Worker. The leaf bundle is
  // only FETCHED when the first `thread` step runs (URL resolved, not loaded).
  resolver.registerNode(new WorkerNode(makeModuleWorker(new URL("./resolverWorker.js", import.meta.url))));

  // Auto-forward main-process node calls (query, file, dialog, window, …) to a
  // native host over its IPC bridge, so they can be authored directly in renderer
  // JSON. First-wins registration means only the keys the renderer LACKS are
  // proxied; local nodes (dom, var, storage, …) stay local. Inert in a plain
  // browser with no host bridge.
  const host = (window as unknown as { jexsHost?: JexsHost }).jexsHost;
  if (host?.keys && host.invoke) {
    const invoke = host.invoke.bind(host);
    const toHost = new ProxyNode(host.keys, (call) => invoke(call), host.steps);
    resolver.registerNode(toHost);

    // The host can register nodes after this page loaded, so its key set is not
    // frozen at preload time. Re-registering installs the new keys; only ones
    // the resolver lacks are added, so local handlers still win.
    host.onKeys?.((added, steps) => {
      if (toHost.addKeys(added, steps).length > 0) resolver.registerNode(toHost);
    });

    // The mirror direction: tell the host which keys live here, so it can proxy
    // DOM ops back. Keys this renderer only holds VIA the host are excluded --
    // announcing those would send a key back where it came from, and with more
    // than one window that becomes an infinite forwarding loop.
    if (host.announce) {
      const announce = host.announce.bind(host);
      const own = (ks: Iterable<string>) => [...ks].filter((k) => !toHost.claims(k));
      const steps = (ks: string[]) =>
        stepFields(ks.map((k) => resolver.nodeFor(k)).filter((n): n is Node => n !== undefined));
      const ownKeys = own(resolver.keys);
      announce(ownKeys, steps(ownKeys));
      // registerNode can run at any time (a lazy module loading, a plugin), so
      // the host is kept current rather than handed a boot-time snapshot.
      resolver.onKeysChange((added) => {
        const fresh = own(added);
        if (fresh.length > 0) announce(fresh, steps(fresh));
      });
    }

    // Run work pushed from the host against the SAME pageContext DOM event
    // handlers use, so host-driven state is visible to the page and vice versa.
    // `steps` gets a child scope for its params, which also gives `$as` + `$bubble`
    // write-through to pageContext, matching FileNode's params semantics.
    if (host.onCall && host.reply) {
      const reply = host.reply.bind(host);
      host.onCall((message) => {
        Promise.resolve()
          .then(() => {
            if (!("steps" in message)) return resolver(message.call, pageContext);
            const scope = message.params
              ? childContext(pageContext, message.params)
              : pageContext;
            return resolver(message.steps, scope);
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

  // The server names its service worker on this script's tag (`data-sw`).
  // Registered after load so its install does not compete with the page.
  const swScript = document.querySelector<HTMLScriptElement>("script[data-sw]")?.dataset.sw;
  if (swScript && "serviceWorker" in navigator) {
    const register = () => {
      navigator.serviceWorker.register(swScript, { scope: "/", type: "module" })
        .catch(err => console.error("[Jexs] service worker registration failed:", err));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }

  return resolver;
}
