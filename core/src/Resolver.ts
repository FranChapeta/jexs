import { Context, Node, childContext } from "./nodes/Node.js";
import { isHttpError } from "./errors.js";

export type ResolverFn = (value: unknown, context: Context) => unknown;
export type TranslateFn = (text: string, context: Context) => Promise<string>;

/**
 * A live view of every key a resolver can dispatch. Reads the maps on access
 * rather than copying, because the set moves: `registerLazy` seeds lazy keys at
 * boot and the lazy path migrates them into the key map as modules load, while
 * `registerNode` can add more at any point. Anything that caches it is wrong by
 * construction.
 */
export interface ResolverKeys {
  has(key: string): boolean;
  readonly size: number;
  toArray(): string[];
  [Symbol.iterator](): IterableIterator<string>;
}

/** What `createResolver` hands back: the resolve function plus its own state. */
export interface Resolver extends ResolverFn {
  readonly keys: ResolverKeys;
  /** Subscribe to key additions. Returns an unsubscribe. */
  onKeysChange(cb: (added: readonly string[]) => void): () => void;
  /** Add a node. Keys already claimed are left alone (first registration wins). */
  registerNode(node: Node): void;
  /** Register keys that load a module the first time one is encountered. */
  registerLazy(keys: string[], loader: () => Promise<void>): void;
  /** Whether this is still the resolver module-scope `resolve()` dispatches to. */
  readonly isCurrent: boolean;
  /** Tear down, if still current. */
  destroy(): void;
}

/**
 * Everything one resolver owns, created fresh by `createResolver` rather than
 * living as module-level maps that merely get cleared between runs.
 *
 * There is still a single CURRENT instance, and that is a deliberate constraint
 * rather than an oversight: node handlers receive only `(def, context)` and call
 * the module-scope `resolve()` with no handle to reach for, so the running
 * resolver has to be findable without one. Concurrent instances would mean
 * threading a resolver through every handler signature, or an async-context
 * mechanism browsers do not have. Instances are therefore isolated but not
 * simultaneous — creating one supersedes the last.
 */
interface ResolverState {
  keyMap: Map<string, Node>;
  /** Lazy module loading: key → loader, loaded once then removed. */
  lazyMap: Map<string, () => Promise<void>>;
  pendingLoads: Map<() => Promise<void>, Promise<void>>;
  keyListeners: Set<(added: readonly string[]) => void>;
  translateFn: TranslateFn | null;
  impl: ResolverFn;
}

/** The resolver that module-scope `resolve()` and friends operate on. */
let current: ResolverState | null = null;

/**
 * Global step keys handled by the resolver machinery, not by nodes: `as`
 * (storeAs), `return` (runSteps), `catch` (handleErr), `bubble` (a modifier
 * read by storeAs alongside `as`), `then` (a fire-and-forget continuation,
 * applied in `resolve`). They must never be eagerly resolved as node inputs.
 *
 * Exported because ProxyNode strips them before forwarding a call — the remote
 * side is only a value producer, and these are applied in the calling thread —
 * and because a host filtering IPC calls must not mistake `as` or `catch` for an
 * op. `GLOBAL_KEY_DOCS` in schema-gen describes the same five for autocomplete;
 * a test asserts the two cannot drift apart.
 */
export const GLOBAL_KEYS = new Set(["as", "return", "catch", "bubble", "then"]);

// Node keys that OWN `then` as their own sibling, shadowing the global `then`
// continuation. Grandfathered: LogicNode's `if/then/else` predates `then` as a
// global key and is too idiomatic to change, so when one of these is present
// `then` is that node's branch, not a continuation. `if` is the only runtime
// consumer of a `then` sibling.
const THEN_OWNERS = new Set(["if"]);

function ownsThen(obj: Record<string, unknown>): boolean {
  for (const k of THEN_OWNERS) if (k in obj) return true;
  return false;
}

/**
 * Cleanup hooks. Module-scope on purpose, unlike everything else here: node
 * modules register these at IMPORT time (MathNode's seed, TimerNode's timers),
 * long before any resolver exists, and what they reset is module state belonging
 * to the node rather than to a resolver.
 */
const _cleanupHooks: (() => void)[] = [];

/** Register a cleanup function called when a resolver is destroyed or replaced. */
export function onResolverDestroy(hook: () => void): void {
  _cleanupHooks.push(hook);
}

/**
 * Tear down the current resolver: dispose its nodes, run cleanup hooks, drop
 * its state.
 *
 * `current` is cleared FIRST so nothing disposal triggers can dispatch back into
 * a half-torn-down resolver.
 */
export function destroyResolver(): void {
  const state = current;
  current = null;

  // Per-resolver teardown: each node this resolver dispatched to gets a chance
  // to release what it owns. A node appears under many keys, so dispose once.
  if (state) {
    const seen = new Set<Node>();
    for (const node of state.keyMap.values()) {
      if (seen.has(node) || !node.dispose) continue;
      seen.add(node);
      try { node.dispose(); } catch { /* best-effort */ }
    }
  }

  // Process-level hooks. Deliberately NOT cleared: node modules register these
  // once at import time, so clearing meant only the first teardown in a process
  // ever ran them — a second resolver's timers would then run forever.
  for (const hook of _cleanupHooks) {
    try { hook(); } catch { /* best-effort */ }
  }
}

/**
 * A key view bound to one resolver's state, so a superseded resolver reports its
 * own (now frozen) keys rather than silently mirroring whoever is current. Lazy
 * keys only count while current, since an unloaded module belongs to the live
 * resolver's dispatch, not to a torn-down one.
 */
function makeKeysView(state: ResolverState): ResolverKeys {
  const union = (): Set<string> => {
    const out = new Set<string>(state.keyMap.keys());
    if (current === state) for (const key of state.lazyMap.keys()) out.add(key);
    return out;
  };
  return {
    has: (key) => state.keyMap.has(key) || (current === state && state.lazyMap.has(key)),
    get size() { return union().size; },
    toArray: () => [...union()],
    [Symbol.iterator]: () => union().values(),
  };
}

/** A listener must never break a registration, so failures are swallowed. */
function announceKeys(state: ResolverState, added: string[]): void {
  if (added.length === 0) return;
  for (const cb of state.keyListeners) {
    try { cb(added); } catch { /* best-effort */ }
  }
}

function addNode(state: ResolverState, node: Node): void {
  const added: string[] = [];
  for (const key of node.handlerKeys ?? []) {
    if (!state.keyMap.has(key)) {
      state.keyMap.set(key, node);
      added.push(key);
    }
  }
  announceKeys(state, added);
}

function addLazy(state: ResolverState, keys: string[], loader: () => Promise<void>): void {
  const added: string[] = [];
  for (const key of keys) {
    if (!state.lazyMap.has(key) && !state.keyMap.has(key)) added.push(key);
    state.lazyMap.set(key, loader);
  }
  announceKeys(state, added);
}

/**
 * Register keys that trigger a lazy module load when first encountered.
 * Operates on the current resolver; a no-op before one exists.
 */
export function registerLazy(keys: string[], loader: () => Promise<void>): void {
  if (current) addLazy(current, keys, loader);
}

/**
 * Register a node into the current resolver's key map.
 * Used for lazy-loaded modules that self-register after the resolver is created,
 * and to re-apply a node whose key set has grown (see ProxyNode.addKeys).
 */
export function registerNode(node: Node): void {
  if (current) addNode(current, node);
}

export async function translate(text: string, context: Context): Promise<string> {
  const fn = current?.translateFn;
  if (fn && /[a-zA-Z]/.test(text)) {
    return fn(text, context);
  }
  return text;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Dispatch through the current resolver, or pass the value through if none. */
function dispatch(value: unknown, context: Context): unknown {
  return current ? current.impl(value, context) : value;
}

function storeAs(step: unknown, value: unknown, context: Context): unknown {
  if (!isObject(step) || !("as" in step)) return undefined;
  const s = step as Record<string, unknown>;
  const name = String(s.as);
  // `bubble` alongside `as` also writes the value up the parent-context chain,
  // so it survives the current file/loop/branch scope. It may be a literal or an
  // expression, so resolve it first — a dynamic `{ "bubble": { "var": "$x" } }`
  // is honored. Returns the resolve result so `runSteps` can await an async flag.
  if (!("bubble" in s)) { Node.setContextValue(context, name, value); return undefined; }
  return resolve(s.bubble, context, b =>
    Node.setContextValue(context, name, value, Node.toBooleanValue(b)),
  );
}

/**
 * Run a step's `catch` array (if present) with `$error` bound, else rethrow.
 * Exported so async nodes that handle their own rejection off the normal
 * `resolve` flow (e.g. the fire-and-forget `thread` node) reuse the same
 * `catch`/`$error` semantics.
 */
export function handleErr(err: unknown, value: unknown, context: Context): unknown {
  if (isObject(value) && Array.isArray((value as Record<string, unknown>).catch)) {
    const catchSteps = (value as Record<string, unknown>).catch as unknown[];
    // Bind under the bare key `error` (not `$error`): `var` strips a leading
    // `$`, so `{ "var": "$error.message" }` looks up `error.message` in context.
    // HTTP errors carry a status; any other thrown/rejected error (e.g. a worker
    // task failure) binds just its message.
    const error = isHttpError(err)
      ? { status: err.status, message: err.message }
      : { message: err instanceof Error ? err.message : String(err) };
    const catchCtx = childContext(context, { error });
    return runSteps(catchSteps, catchCtx);
  }
  throw err;
}

/**
 * Resolve a value in the given context.
 * Returns the resolved value synchronously, or a Promise if any part of the
 * expression tree is async (e.g. an I/O node).
 *
 * Optional continuation `cont`: if provided, called with the resolved value.
 * On the sync path `cont` is called immediately — no Promise created.
 * On the async path `cont` is chained via .then() on the Promise.
 *
 * A `"then"` array (except where a node owns `then` as its own sibling —
 * LogicNode's `if/then/else`) makes the step FIRE-AND-FORGET: the work is kicked
 * off, the sequence is handed `undefined` right away so it never blocks, and when
 * the work settles the `then` steps run with the result bound as `$result`.
 *
 * If the step def has a `"catch"` array and an HTTP error is thrown,
 * the catch steps are run with `$error: { status, message }` in context.
 */
export function resolve(value: unknown, context: Context): unknown;
export function resolve<T>(value: unknown, context: Context, cont: (v: unknown) => T): T | Promise<T>;
export function resolve(value: unknown, context: Context, cont?: (v: unknown) => unknown): unknown {
  const obj = isObject(value) ? value : null;

  // Fire-and-forget: dispatch off the caller's stack (so even synchronous setup
  // doesn't block), run `then` with `$result` when it settles, and route errors
  // through `catch` (unhandled if none, like any background task). Hand the
  // sequence `undefined` immediately via `cont` so later steps run right away.
  if (obj !== null && Array.isArray(obj.then) && !ownsThen(obj)) {
    void Promise.resolve()
      .then(() => dispatch(value, context))
      .then(result => runSteps(obj.then as unknown[], childContext(context, { result })))
      .catch(err => handleErr(err, obj, context));
    return cont ? cont(undefined) : undefined;
  }

  const hasCatch = obj !== null && Array.isArray(obj.catch);

  let r: unknown;
  try {
    r = dispatch(value, context);
  } catch (err) {
    if (hasCatch) return handleErr(err, value, context);
    throw err;
  }

  if (r instanceof Promise && hasCatch) r = r.catch(err => handleErr(err, value, context));
  if (!cont) return r;
  return r instanceof Promise ? r.then(cont) : cont(r);
}

/**
 * Resolve all values of a plain object in parallel, sync-first.
 * Builds and passes a new Record with resolved values to `then`.
 * On the sync path: no Promises created, callback fires immediately.
 */
export function resolveObj<T>(obj: Record<string, unknown>, context: Context, then: (r: Record<string, unknown>) => T): T | Promise<T> {
  const result: Record<string, unknown> = {};
  const pending: Promise<unknown>[] = [];
  const pendingKeys: string[] = [];
  for (const key of Object.keys(obj)) {
    // Never eagerly resolve the global step keys — they belong to the resolver's
    // step machinery (`as`/`return` via runSteps, `catch` via handleErr). Resolving
    // a `catch: [...]` array here would execute the error handler on success. Kept
    // raw so the object shape is preserved for callers that pass `r` through.
    if (GLOBAL_KEYS.has(key)) { result[key] = obj[key]; continue; }
    const r = dispatch(obj[key], context);
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
export function resolveAll<T>(values: unknown[], context: Context, then: (args: unknown[]) => T): T | Promise<T> {
  const pendingPromises: Promise<unknown>[] = [];
  const pendingIndices: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const r = dispatch(values[i], context);
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
 * Run an array of steps sequentially, sync-first. Returns the last step's value.
 * Handles the `"as"` global property on each step (stores result in context).
 * A step that resolves to `{ return: X }` stops the sequence and yields `X`.
 * The wrapper does not propagate to enclosing sequences — to escape multiple
 * levels, nest the wrapper (e.g. `{ return: { return: X } }`).
 */
export function runSteps(steps: unknown[], context: Context): unknown {
  let i = 0;
  function next(): unknown {
    if (i >= steps.length) return;
    const step = steps[i++];
    const isLast = i >= steps.length;
    return resolve(step, context, v => {
      const after = (): unknown => {
        if (isObject(v) && "return" in v) return v.return;
        if (isLast) return v;
        return next();
      };
      // storeAs is sync unless a `bubble` expression resolves async; in that case
      // wait for the write before the next step so it observes the bubbled value.
      const stored = storeAs(step, v, context);
      return stored instanceof Promise ? stored.then(after) : after();
    });
  }
  return next();
}

/** Resolve a single step or an array of steps. */
export function resolveSteps(value: unknown, context: Context): unknown {
  return Array.isArray(value) ? runSteps(value, context) : resolve(value, context);
}

/**
 * Run steps from a deferred callback — a timer tick, a socket message, a menu
 * click, an OS event — where `resolve` has long since returned and the resolver
 * is no longer wrapped around the call.
 * `def` is the step object whose `catch` should be honored. The returned promise
 * rejects when nothing handled the error, so callers can log with their own
 * context.
 */
export async function runStepsDetached(
  steps: unknown[],
  context: Context,
  def: unknown = null,
): Promise<unknown> {
  try {
    return await runSteps(steps, context);
  } catch (err) {
    return handleErr(err, def, context);
  }
}

/**
 * Creates a resolver from a list of nodes.
 * The resolver interprets JSON expressions at runtime.
 */
export interface ResolverOptions {
  translate?: TranslateFn;
}

export function createResolver(nodes: Node[], options?: ResolverOptions): Resolver {
  // Only one resolver is current at a time; creating one tears down the last.
  if (current) destroyResolver();

  const state: ResolverState = {
    keyMap: new Map<string, Node>(),
    lazyMap: new Map<string, () => Promise<void>>(),
    pendingLoads: new Map<() => Promise<void>, Promise<void>>(),
    keyListeners: new Set(),
    translateFn: options?.translate ?? null,
    // Replaced below; the state object has to exist first so `impl` can close
    // over it rather than over module-level maps.
    impl: (value: unknown) => value,
  };

  // Build key-to-node dispatch map (first registration wins per key)
  const { keyMap, lazyMap, pendingLoads } = state;
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

  state.impl = function resolveImpl(value: unknown, context: Context): unknown {
    // Hottest case first: anything that isn't a non-null object resolves to
    // itself. Covers null/undefined/boolean/number/string and also
    // function/symbol/bigint (all previously fell through to `return value`).
    if (value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      const arr = value as unknown[];
      let results: unknown[] = arr;
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

      // Lazy load: if any key matches a lazy module, load it and retry dispatch.
      // Skip the scan entirely when nothing is registered (the common case) so
      // plain data objects don't pay N map misses on every resolution.
      if (lazyMap.size !== 0) {
        for (let i = 0; i < objKeys.length; i++) {
          const loader = lazyMap.get(objKeys[i]);
          if (loader) {
            let pending = pendingLoads.get(loader);
            if (!pending) {
              pending = loader().catch((err: unknown) => {
                pendingLoads.delete(loader);
                throw err;
              });
              pendingLoads.set(loader, pending);
            }
            return pending.then(() => {
              for (const [key, fn] of lazyMap) { if (fn === loader) lazyMap.delete(key); }
              for (let j = 0; j < objKeys.length; j++) {
                const node = keyMap.get(objKeys[j]);
                if (node) return node.resolve(obj, context, objKeys[j]);
              }
            });
          }
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

  current = state;

  // Delegate to the catch-aware `resolve` wrapper, not straight to `state.impl`,
  // so a top-level `catch` on the entry expression is honored too — matching how
  // `runSteps` (and every nested node) already resolves through `resolve()`.
  // A wrapper rather than `resolve` itself, so this API hangs off what
  // createResolver returns without also appearing on the exported `resolve`.
  const resolver = ((value: unknown, context: Context) =>
    resolve(value, context)) as Resolver;

  Object.defineProperties(resolver, {
    keys: { value: makeKeysView(state) },
    isCurrent: { get: () => current === state },
  });
  resolver.onKeysChange = (cb) => {
    state.keyListeners.add(cb);
    return () => { state.keyListeners.delete(cb); };
  };
  resolver.registerNode = (node) => addNode(state, node);
  resolver.registerLazy = (keys, loader) => addLazy(state, keys, loader);
  resolver.destroy = () => { if (current === state) destroyResolver(); };
  return resolver;
}
