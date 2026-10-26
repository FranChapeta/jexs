import {
  WorkerNode, ProxyNode, createResolver, childContext, stepFields,
  coreNodes, Node, type Context, type Resolver, type StepFields,
} from "@jexs/core";
import { DomNode } from "./nodes/Dom.js";
import { AudioNode } from "./nodes/Audio.js";
import { StorageNode } from "./nodes/Storage.js";
import { registerComputeLazy, registerDomLazy } from "./registerNodes.js";
import { makeModuleWorker } from "./makeWorker.js";
import { hydrate } from "./events.js";
import { addCsrfField } from "./csrf.js";
import { serializable } from "./serializable.js";

/** A single node call to resolve here — one proxied op. */
export interface HostCall {
  id: number;
  call: unknown;
}

/** A step array to run here, with `params` scoped into it. */
export interface HostSteps {
  id: number;
  steps: unknown[];
  params?: Record<string, unknown>;
}

/** Exactly one of the two, discriminated by the presence of `steps`. */
export type HostMessage = HostCall | HostSteps;

/**
 * The bridge a native host (Electron main) injects as `window.jexsHost`, which
 * the page's app (`boot()` with `global`) takes. Every member is optional so an
 * older host, or a plain browser, simply gets fewer capabilities rather than an
 * error.
 */
export interface JexsHost {
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

export { hydrate };
// Every node class, for wiring a resolver by hand rather than through `boot()`,
// which registers the eager three itself and loads the rest on first use. A
// bundle drops the ones it does not import, so the page pays nothing for these.
export { DomNode, AudioNode, StorageNode };
export { WsNode } from "./nodes/Ws.js";
export { PushNode } from "./nodes/Push.js";
export { WebRTCNode } from "./nodes/WebRTC.js";
export { ServiceWorkerNode } from "./nodes/ServiceWorker.js";

/** A booted app: its resolver, the context its handlers share, and the
 *  `hydrate` that binds the handlers in markup added to its part of the page. */
export interface App {
  resolver: Resolver;
  context: Context;
  hydrate: (root?: Element | Document) => void;
}

export interface BootOptions {
  /** The app's own nodes, or a third-party package's, beside core's and the client's. */
  nodes?: Node[];
  /** The part of the page the app hydrates (default the whole document). */
  root?: Element | Document;
  /**
   * Whether this is the page's app: it is `window.jexs`, and takes the native
   * host bridge if there is one. A second app on the page sets `false`.
   */
  global?: boolean;
  /** Whether to register the service worker the server named (default `true`). */
  serviceWorker?: boolean;
}

/**
 * Start a Jexs app on this page: build its resolver with the core and client
 * nodes and any `nodes` given, wire the lazy node groups, the worker and any
 * native host bridge, then hydrate its `root` and register the service worker
 * the server named. The nodes are registered before hydrating, so a `mount`
 * handler can use them. The entry `jexs bundle` writes calls it once, with the
 * project's browser node packages; a page with two apps boots each, one of them
 * with `global: false`.
 */
export function boot({ nodes = [], root = document, global = true, serviceWorker = true }: BootOptions = {}): App {
  if (typeof window === "undefined") throw new Error("boot() runs in a browser window.");
  const page = window as unknown as Record<string, unknown>;
  if (global && page.jexs !== undefined) {
    throw new Error("This page already has a global app (window.jexs): boot a second one with `global: false`.");
  }

  // The app's root scope: DOM event handlers run steps against it long after
  // any resolve returned, so it is attached up front rather than by the first
  // call. Every scope derived from it inherits.
  const context: Context = {};
  const resolver = createResolver([...coreNodes(), ...clientNodes(), ...nodes], { context });
  const app: App = { resolver, context, hydrate: (at = root) => hydrate(at, context) };
  // `window.jexs` is the page's app, for inspecting or seeding its state and for
  // markup the server streams in later (a `$defer` part) to bind its handlers.
  if (global) page.jexs = app;

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
  const host = global ? (window as unknown as { jexsHost?: JexsHost }).jexsHost : undefined;
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

    // Run work pushed from the host against the SAME context DOM event handlers
    // use, so host-driven state is visible to the page and vice versa. `steps`
    // gets a child scope for its params, which also gives `$as` + `$bubble`
    // write-through to the app's context, matching FileNode's params semantics.
    if (host.onCall && host.reply) {
      const reply = host.reply.bind(host);
      host.onCall((message) => {
        Promise.resolve()
          .then(() => {
            if (!("steps" in message)) return resolver(message.call, context);
            const scope = message.params
              ? childContext(context, message.params)
              : context;
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
    document.addEventListener("DOMContentLoaded", () => app.hydrate());
  } else {
    app.hydrate();
  }

  // The server names its service worker on this script's tag (`data-sw`).
  // Registered after load so its install does not compete with the page.
  const swScript = serviceWorker ? document.querySelector<HTMLScriptElement>("script[data-sw]")?.dataset.sw : undefined;
  if (swScript && "serviceWorker" in navigator) {
    const register = () => {
      navigator.serviceWorker.register(swScript, { scope: "/", type: "module" })
        .catch(err => console.error("[Jexs] service worker registration failed:", err));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }

  return app;
}
