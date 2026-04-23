import { Context, Node } from "./nodes/Node.js";

export type ResolverFn = (value: unknown, context: Context) => unknown;
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

/**
 * Resolve a value in the given context.
 * Returns the resolved value synchronously, or a Promise if any part of the
 * expression tree is async (e.g. an I/O node).
 *
 * Optional continuation `then`: if provided, called with the resolved value.
 * On the sync path `then` is called immediately — no Promise created.
 * On the async path `then` is chained via .then() on the Promise.
 */
export function resolve(value: unknown, context: Context, then?: (v: unknown) => unknown): unknown {
  const r = _resolve ? _resolve(value, context) : value;
  if (!then) return r;
  return r instanceof Promise ? r.then(then) : then(r);
}

/**
 * Resolve all values of a plain object in parallel, sync-first.
 * Builds and passes a new Record with resolved values to `then`.
 * On the sync path: no Promises created, callback fires immediately.
 */
export function resolveObj(obj: Record<string, unknown>, context: Context, then: (r: Record<string, unknown>) => unknown): unknown {
  const result: Record<string, unknown> = {};
  const pending: Promise<unknown>[] = [];
  const pendingKeys: string[] = [];
  for (const key of Object.keys(obj)) {
    const r = _resolve ? _resolve(obj[key], context) : obj[key];
    if (r instanceof Promise) { pending.push(r); pendingKeys.push(key); }
    else result[key] = r;
  }
  if (!pending.length) return then(result);
  return Promise.all(pending).then(resolved => {
    pendingKeys.forEach((k, i) => { result[k] = resolved[i]; });
    return then(result);
  });
}

/**
 * Resolve multiple values in parallel, sync-first.
 * Mutates the input array in-place (callers must pass a fresh array literal).
 * On the sync path: no allocations — writes resolved values in-place, calls then(values) directly.
 * On the async path: waits for all async values via Promise.all, then calls then(values).
 */
export function resolveAll(values: unknown[], context: Context, then: (args: unknown[]) => unknown): unknown {
  const pendingPromises: Promise<unknown>[] = [];
  const pendingIndices: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const r = _resolve ? _resolve(values[i], context) : values[i];
    if (r instanceof Promise) { pendingPromises.push(r); pendingIndices.push(i); }
    else values[i] = r;
  }
  if (!pendingPromises.length) return then(values);
  return Promise.all(pendingPromises).then(resolved => {
    pendingIndices.forEach((idx, j) => { values[idx] = resolved[j]; });
    return then(values);
  });
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

  _resolve = function resolveImpl(value: unknown, context: Context): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;

    if (Array.isArray(value)) {
      const arr = value as unknown[];
      let results: unknown[] = arr; // reuse original if nothing changes (copy-on-write)
      const pendingPromises: Promise<unknown>[] = [];
      const pendingIndices: number[] = [];
      for (let i = 0; i < arr.length; i++) {
        const r = resolveImpl(arr[i], context);
        if (r instanceof Promise) {
          if (results === arr) results = arr.slice();
          pendingPromises.push(r as Promise<unknown>);
          pendingIndices.push(i);
        } else if (r !== arr[i]) {
          if (results === arr) results = arr.slice();
          results[i] = r;
        }
      }
      if (!pendingPromises.length) return results;
      return Promise.all(pendingPromises).then(resolved => {
        pendingIndices.forEach((idx, j) => { results[idx] = resolved[j]; });
        return results;
      });
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const objKeys = Object.keys(obj);

      // Key-based dispatch — pure routing, no pre-resolution
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
          return pending.then(() => {
            for (const [key, fn] of _lazyMap) { if (fn === loader) _lazyMap.delete(key); }
            for (let j = 0; j < objKeys.length; j++) {
              const node = keyMap.get(objKeys[j]);
              if (node) return node.resolve(obj, context, objKeys[j]);
            }
          });
        }
      }

      // Plain object: resolve values in parallel, copy-on-write
      let result: Record<string, unknown> = obj;
      const pendingPromises: Promise<unknown>[] = [];
      const pendingKeys: string[] = [];
      for (const key of objKeys) {
        const r = resolveImpl(obj[key], context);
        if (r instanceof Promise) {
          if (result === obj) result = { ...obj };
          pendingPromises.push(r as Promise<unknown>);
          pendingKeys.push(key);
        } else if (r !== obj[key]) {
          if (result === obj) result = { ...obj };
          result[key] = r;
        }
      }
      if (!pendingPromises.length) return result;
      return Promise.all(pendingPromises).then(resolved => {
        pendingKeys.forEach((k, i) => { result[k] = resolved[i]; });
        return result;
      });
    }

    return value;
  };

  if (options?.translate) translateFn = options.translate;

  return _resolve;
}
