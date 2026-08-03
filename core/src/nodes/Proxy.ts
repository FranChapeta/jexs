import { Node, Context, NodeValue } from "./Node.js";
import { resolveObj } from "../Resolver.js";

/** Step keys owned by the resolver machinery, never part of a node call. */
const GLOBAL_KEYS = new Set(["as", "return", "catch", "bubble", "then"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A dynamic forwarder: claims a set of handler keys and hands each matching step
 * to a `forward` callback instead of resolving it locally. The renderer uses it to
 * proxy main-process node calls (`query`, `file`, `dialog`, …) to the Electron main
 * process over the IPC bridge — but it's host-agnostic (the callback is injected),
 * so it works for any remote resolver (a worker, a socket).
 */
export class ProxyNode extends Node {
  constructor(
    private readonly keys: readonly string[],
    private readonly forward: (call: Record<string, unknown>) => unknown,
  ) {
    super();
  }

  get handlerKeys(): readonly string[] {
    return this.keys;
  }

  resolve(def: unknown, context: Context): NodeValue {
    if (!isObject(def)) return this.forward(def as never) as NodeValue;

    return resolveObj(def, context, (resolved) => {
      const call: Record<string, unknown> = {};
      for (const k in resolved) if (!GLOBAL_KEYS.has(k)) call[k] = resolved[k];
      // Return the promise; the resolver applies the global step keys (`as`,
      // `catch`, `then`) to it in THIS thread.
      return Promise.resolve(this.forward(call));
    }) as NodeValue;
  }
}
