import { Context, Node } from "./nodes/Node.js";

export type ResolverFn = (value: unknown, context: Context) => Promise<unknown>;
export type TranslateFn = (text: string, context: Context) => Promise<string>;

let translateFn: TranslateFn | null = null;
let _resolve: ResolverFn | null = null;
let _keyMap: Map<string, Node> | null = null;

// Lazy module loading: key → loader function, loaded once then removed
const _lazyMap = new Map<string, () => Promise<void>>();
const _pendingLoads = new Map<() => Promise<void>, Promise<void>>();

// Cleanup hooks called on destroyResolver() or when a new resolver replaces the old one
const _cleanupHooks: (() => void)[] = [];

/** Register a cleanup function called when the resolver is destroyed or replaced. */
export function onResolverDestroy(hook: () => void): void {
  _cleanupHooks.push(hook);
}

/** Tear down the current resolver: run cleanup hooks, clear state. */
export function destroyResolver(): void {
  for (const hook of _cleanupHooks) {
    try { hook(); } catch { /* best-effort */ }
  }
  _cleanupHooks.length = 0;
  _resolve = null;
  _keyMap = null;
  _lazyMap.clear();
  _pendingLoads.clear();
  translateFn = null;
}

/** Register keys that trigger a lazy module load when first encountered by the resolver. */
export function registerLazy(keys: string[], loader: () => Promise<void>): void {
  for (const key of keys) _lazyMap.set(key, loader);
}

/**
 * Register a node into the live resolver key map.
 * Used for lazy-loaded modules that self-register after the resolver is created.
 */
export function registerNode(node: Node): void {
  if (!_keyMap) return;
  for (const key of node.handlerKeys ?? []) {
    if (!_keyMap.has(key)) _keyMap.set(key, node);
  }
}

export async function translate(text: string, context: Context): Promise<string> {
  if (translateFn && /[a-zA-Z]/.test(text)) {
    return translateFn(text, context);
  }
  return text;
}

export function resolve(value: unknown, context: Context): Promise<unknown> {
  return _resolve ? _resolve(value, context) : Promise.resolve(value);
}

/**
 * Creates a resolver function from a list of nodes.
 * The resolver interprets JSON expressions at runtime.
 */
export interface ResolverOptions {
  translate?: TranslateFn;
}

export function createResolver(nodes: Node[], options?: ResolverOptions): ResolverFn {
  // Clean up previous resolver if one exists
  if (_resolve) destroyResolver();

  // Build key-to-node dispatch map (first registration wins per key)
  const keyMap = new Map<string, Node>();
  _keyMap = keyMap;
  for (const node of nodes) {
    const nodeKeys = node.handlerKeys;
    if (nodeKeys) {
      for (let i = 0; i < nodeKeys.length; i++) {
        if (!keyMap.has(nodeKeys[i])) {
          keyMap.set(nodeKeys[i], node);
        }
      }
    }
  }

  _resolve = async function resolveImpl(value: unknown, context: Context): Promise<unknown> {
    if (value === null || value === undefined) return value;
    if (value instanceof Promise) return resolveImpl(await value, context);
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return value;

    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        items.push(await resolveImpl(item, context));
      }
      return items;
    }

    if (typeof value === "object") {
      // Key-based dispatch: iterate the object's own keys, first map hit wins
      const obj = value as Record<string, unknown>;
      const objKeys = Object.keys(obj);
      for (let i = 0; i < objKeys.length; i++) {
        const node = keyMap.get(objKeys[i]);
        if (node) return node.resolve(obj, context, objKeys[i]);
      }

      // Lazy load: if any key matches a lazy module, load it and retry dispatch
      for (let i = 0; i < objKeys.length; i++) {
        const loader = _lazyMap.get(objKeys[i]);
        if (loader) {
          let pending = _pendingLoads.get(loader);
          if (!pending) {
            pending = loader().catch((err) => {
              _pendingLoads.delete(loader);
              throw err;
            });
            _pendingLoads.set(loader, pending);
          }
          await pending;
          // Remove lazy entries now that the module is loaded
          for (const [key, fn] of _lazyMap) {
            if (fn === loader) _lazyMap.delete(key);
          }
          // Retry key dispatch after module loaded
          for (let j = 0; j < objKeys.length; j++) {
            const node = keyMap.get(objKeys[j]);
            if (node) return node.resolve(obj, context, objKeys[j]);
          }
          break;
        }
      }

      // Plain object: resolve values recursively
      const result: Record<string, unknown> = {};
      for (let i = 0; i < objKeys.length; i++) {
        result[objKeys[i]] = await resolveImpl(obj[objKeys[i]], context);
      }
      return result;
    }

    return value;
  };

  if (options?.translate) translateFn = options.translate;

  return _resolve;
}
