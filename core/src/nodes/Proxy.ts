import { Node, Context, NodeValue } from "./Node.js";
import { resolveObj, GLOBAL_STEP_KEYS } from "../Resolver.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A dynamic forwarder: claims a set of handler keys and hands each matching step
 * to a `forward` callback instead of resolving it locally. The renderer uses it to
 * proxy main-process node calls (`query`, `file`, `dialog`, …) to the Electron main
 * process over the IPC bridge, and the main process uses one in the other
 * direction for DOM keys — but it's host-agnostic (the callback is injected), so
 * it works for any remote resolver (a worker, a socket).
 *
 * The key set is mutable: `registerNode` can run at any point in a process's
 * life, so a remote peer's key set grows over time. Call `addKeys` with the new
 * keys and then `registerNode(proxy)` again to install them — that call only
 * adds keys not already present, so first-wins still protects local handlers.
 */
export class ProxyNode extends Node {
  private readonly keys: Set<string>;

  constructor(
    keys: Iterable<string>,
    private readonly forward: (call: Record<string, unknown>, context: Context) => unknown,
  ) {
    super();
    this.keys = new Set(keys);
  }

  /** `handlerKeys` is a getter, so growing this set is immediately visible. */
  get handlerKeys(): readonly string[] {
    return [...this.keys];
  }

  /** Adopt more remote keys. Returns the ones that were not already claimed. */
  addKeys(keys: Iterable<string>): string[] {
    const added: string[] = [];
    for (const key of keys) {
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      added.push(key);
    }
    return added;
  }

  /** Whether this proxy claims a key — used to keep proxied keys out of the set
   *  a peer announces, which would otherwise send a key back where it came from. */
  claims(key: string): boolean {
    return this.keys.has(key);
  }

  resolve(def: unknown, context: Context): NodeValue {
    // The resolver only ever dispatches a non-null, non-array object — it
    // returns early for everything else before reaching the key map — so this
    // guards direct callers rather than a real dispatch path. There is nothing
    // meaningful to forward, since a call is by definition a keyed object.
    if (!isObject(def)) return undefined;

    return resolveObj(def, context, (resolved) => {
      const call: Record<string, unknown> = {};
      for (const k in resolved) if (!GLOBAL_STEP_KEYS.has(k)) call[k] = resolved[k];
      // Return the promise; the resolver applies the global step keys (`as`,
      // `catch`, `then`) to it in THIS thread. That is what makes a remote call
      // behave exactly like a local one: the remote is only a value producer.
      return Promise.resolve(this.forward(call, context));
    });
  }
}
