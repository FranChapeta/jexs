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

/** What `createResolver` hands back: the resolve function, plus the API for the
 *  dispatch table it carries. */
export interface Resolver extends ResolverFn {
  readonly keys: ResolverKeys;
  /** Subscribe to key additions. Returns an unsubscribe. */
  onKeysChange(cb: (added: readonly string[]) => void): () => void;
  /** Add a node. Keys already claimed are left alone (first registration wins). */
  registerNode(node: Node): void;
  /** Register keys that load a module the first time one is encountered. The
   *  loader is handed this resolver, so it registers into the right one. */
  registerLazy(keys: string[], loader: (resolver: Resolver) => void | Promise<void>): void;
  /** The node registered for a key, if any. */
  nodeFor(key: string): Node | undefined;
  /** Whether this resolver has been torn down. */
  readonly destroyed: boolean;
  /** Tear down: dispose every node registered here. */
  destroy(): void;

  resolve(value: unknown, context: Context): unknown;
  resolve<T>(value: unknown, context: Context, cont: (v: unknown) => T): T | Promise<T>;
  resolveObj<T>(obj: Record<string, unknown>, context: Context, then: (r: Record<string, unknown>) => T): T | Promise<T>;
  resolveAll<T>(values: unknown[], context: Context, then: (args: unknown[]) => T): T | Promise<T>;
  runSteps(steps: unknown[], context: Context): unknown;
  resolveSteps(value: unknown, context: Context): unknown;
  runStepsDetached(steps: unknown[], context: Context, def?: unknown): Promise<unknown>;
}

/**
 * The same object as {@link Resolver}, with the dispatch state it carries.
 *
 * Resolvers are ordinary objects and any number of them can run at once, even in
 * one realm. A node handler receives only `(def, context)` and calls the
 * module-scope `resolve()` with no handle to reach for, so the running resolver
 * is found on the CONTEXT: `createResolver`'s entry points stamp it under
 * `RESOLVER`, and derived scopes inherit it because the key is an ENUMERABLE
 * symbol, which object spread and `childContext` both copy. `JSON` and
 * `structuredClone` drop symbols, so a context crossing to a worker never drags
 * a resolver with it.
 *
 * These fields live on the resolver itself rather than in a separate state record
 * it points back at: the resolver has to be a callable function (so it cannot
 * hold private class fields), and one object with a module-private type is
 * simpler than two objects with a back-reference. Only `Resolver` is exported, so
 * none of this reaches the published types.
 */
interface ResolverImpl extends Resolver {
  keyMap: Map<string, Node>;
  /** Lazy module loading: key → loader, loaded once then removed. */
  lazyMap: Map<string, Loader>;
  pendingLoads: Map<Loader, Promise<void>>;
  keyListeners: Set<(added: readonly string[]) => void>;
  translateFn: TranslateFn | null;
  /**
   * Every node registered here, including ones that lost first-wins on all of
   * their keys and so never entered `keyMap`. Teardown walks this, not `keyMap`,
   * so a node that owns resources still gets disposed.
   */
  nodes: Set<Node>;
  /** Backs the public read-only `destroyed`. */
  torndown: boolean;
  /** The tree walker. Dispatch goes straight here; `resolve` adds the step keys. */
  impl: ResolverFn;
}

type Loader = (resolver: Resolver) => void | Promise<void>;

/**
 * Where a context records the resolver it is running in.
 *
 * ENUMERABLE on purpose, and that is the whole mechanism: object spread copies
 * own enumerable symbol keys, so every `{ ...context }` and every
 * `childContext(...)` carries the resolver into the derived scope without a
 * single call site having to thread it. (`PARENT` in Node.ts is non-enumerable
 * for the opposite reason — a plain spread must NOT inherit a bubble target.)
 *
 * Symbol-keyed so templates cannot reach it: `var` reads string paths, and
 * `Object.keys` never lists symbols.
 */
const RESOLVER = Symbol("jexs.resolver");

interface Resolved extends Context {
  [RESOLVER]?: ResolverImpl;
}

/** Record `self` on a context, unless it already belongs to another resolver. */
function adopt<T extends Context>(self: ResolverImpl, context: T): T {
  const owner = (context as Resolved)[RESOLVER];
  if (owner === self) return context;
  if (owner !== undefined) {
    throw new Error(
      "This context is already running in another resolver. A context is one " +
      "flow and a flow belongs to one resolver, so pass a fresh context (or a " +
      "childContext of one already running here) rather than sharing a live one.",
    );
  }
  // Assigned, not defineProperty'd: it has to be enumerable so spreads carry it.
  (context as Resolved)[RESOLVER] = self;
  return context;
}

/** The resolver a context is running in, with its internals. */
function implFor(context: Context): ResolverImpl {
  const self = (context as Resolved)[RESOLVER];
  if (self === undefined) {
    throw new Error(
      "No resolver for this context. Resolve through a resolver at least once " +
      "(resolver.resolve / .runSteps), derive it from a scope that already has " +
      "one (childContext, or a plain spread), or pass it as createResolver's " +
      "`context` option.",
    );
  }
  return self;
}

/** The resolver a context is running in. Throws if it has never been adopted. */
export function resolverFor(context: Context): Resolver {
  return implFor(context);
}


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
 * A key view bound to one resolver's state. Lazy keys count too: an unloaded
 * module is still something this resolver can dispatch.
 */
function makeKeysView(self: ResolverImpl): ResolverKeys {
  const union = (): Set<string> => {
    const out = new Set<string>(self.keyMap.keys());
    for (const key of self.lazyMap.keys()) out.add(key);
    return out;
  };
  return {
    has: (key) => self.keyMap.has(key) || self.lazyMap.has(key),
    get size() { return union().size; },
    toArray: () => [...union()],
    [Symbol.iterator]: () => union().values(),
  };
}

/** A listener must never break a registration, so failures are swallowed. */
function announceKeys(self: ResolverImpl, added: string[]): void {
  if (added.length === 0) return;
  for (const cb of self.keyListeners) {
    try { cb(added); } catch { /* best-effort */ }
  }
}

function addNode(self: ResolverImpl, node: Node): void {
  self.nodes.add(node);
  const added: string[] = [];
  for (const key of node.handlerKeys ?? []) {
    if (!self.keyMap.has(key)) {
      self.keyMap.set(key, node);
      added.push(key);
    }
  }
  announceKeys(self, added);
}

function addLazy(self: ResolverImpl, keys: string[], loader: Loader): void {
  const added: string[] = [];
  for (const key of keys) {
    if (!self.lazyMap.has(key) && !self.keyMap.has(key)) added.push(key);
    self.lazyMap.set(key, loader);
  }
  announceKeys(self, added);
}

/**
 * Tear down: dispose every node registered here.
 *
 * Idempotent, and it does NOT touch any other resolver — one resolver's teardown
 * leaving another's timers and connections running is the whole point.
 */
function destroy(self: ResolverImpl): void {
  if (self.torndown) return;
  self.torndown = true;

  for (const node of self.nodes) {
    if (!node.dispose) continue;
    try { node.dispose(); } catch { /* best-effort */ }
  }
  self.keyListeners.clear();
  // keyMap/lazyMap are deliberately kept, so a destroyed resolver's `keys` view
  // still reports what it had rather than going silently empty.
}

export async function translate(text: string, context: Context): Promise<string> {
  const fn = implFor(context).translateFn;
  if (fn && /[a-zA-Z]/.test(text)) {
    return fn(text, context);
  }
  return text;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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
  if (isObject(value) && value.catch !== undefined) {
    const catchSteps = Array.isArray(value.catch) ? value.catch : [value.catch];
    // Bind under the bare key `error` (not `$error`): `var` strips a leading
    // `$`, so `{ "var": "$error.message" }` looks up `error.message` in context.
    // HTTP errors carry a status; any other thrown/rejected error (e.g. a worker
    // task failure) binds just its message.
    const error = isHttpError(err)
      ? { status: err.status, message: err.message }
      : { message: err instanceof Error ? err.message : String(err) };
    // A node that knows more than its message offers it as further variables of
    // its own (`fetch` hands over `$response`), so `$error` keeps the one shape
    // everywhere. Bound first, so none of them can displace `$error` itself.
    const bindings = isHttpError(err) ? err.bindings : undefined;
    const catchCtx = childContext(context, { ...bindings, error });
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
 * If the step def has a `"catch"` array and an HTTP error is thrown, the catch
 * steps are run with `$error: { status, message }` in context, alongside any
 * further variables the thrower offered (see `createHttpError`).
 */
export function resolve(value: unknown, context: Context): unknown;
export function resolve<T>(value: unknown, context: Context, cont: (v: unknown) => T): T | Promise<T>;
export function resolve(value: unknown, context: Context, cont?: (v: unknown) => unknown): unknown {
  // Read once, up front: the fire-and-forget path below settles on a later tick,
  // and pinning the resolver here keeps that continuation with the resolver the
  // work started in no matter what else is created meanwhile.
  const self = implFor(context);
  const obj = isObject(value) ? value : null;

  // Fire-and-forget: dispatch off the caller's stack (so even synchronous setup
  // doesn't block), run `then` with `$result` when it settles, and route errors
  // through `catch` (unhandled if none, like any background task). Hand the
  // sequence `undefined` immediately via `cont` so later steps run right away.
  if (obj !== null && obj.then !== undefined && !ownsThen(obj)) {
    void Promise.resolve()
      .then(() => self.impl(value, context))
      .then(result => runSteps(
        Array.isArray(obj.then) ? obj.then : [obj.then],
        childContext(context, { result }),
      ))
      .catch(err => handleErr(err, obj, context));
    return cont ? cont(undefined) : undefined;
  }

  const hasCatch = obj !== null && obj.catch !== undefined;

  let r: unknown;
  try {
    r = self.impl(value, context);
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
  const { impl } = implFor(context);
  const result: Record<string, unknown> = {};
  const pending: Promise<unknown>[] = [];
  const pendingKeys: string[] = [];
  for (const key of Object.keys(obj)) {
    // Never eagerly resolve the global step keys — they belong to the resolver's
    // step machinery (`as`/`return` via runSteps, `catch` via handleErr). Resolving
    // a `catch: [...]` array here would execute the error handler on success. Kept
    // raw so the object shape is preserved for callers that pass `r` through.
    if (GLOBAL_KEYS.has(key)) { result[key] = obj[key]; continue; }
    const r = impl(obj[key], context);
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
  const { impl } = implFor(context);
  const pendingPromises: Promise<unknown>[] = [];
  const pendingIndices: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const r = impl(values[i], context);
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
 *
 * Every step must be an expression object. A literal step resolves to itself, so
 * it can only ever be a no-op or, as the last step, a value dressed up as a
 * sequence — `["Hello"]` where `"Hello"` was meant. Deciding whether a slot holds
 * one step or many is `resolveSteps`' job, not this one's; callers that accept
 * either shape normalize before calling.
 */
export function runSteps(steps: unknown[], context: Context): unknown {
  let i = 0;
  function next(): unknown {
    if (i >= steps.length) return;
    const step = steps[i++];
    if (!isObject(step)) {
      throw new Error(
        `A step must be an expression object, got ${step === null ? "null" : typeof step}: ${JSON.stringify(step)}`,
      );
    }
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
  /**
   * The root context this resolver runs in.
   *
   * Only needed for a long-lived scope handed to detached callbacks BEFORE
   * anything resolves in it — the browser's `pageContext`, whose DOM event
   * handlers run steps against it. Everything else is covered without it: a
   * context arriving from outside (a worker message, an HTTP request, a call to
   * `resolver.resolve`) is attached by the entry point it arrives at, and a
   * derived scope inherits through `childContext` or a plain spread.
   */
  context?: Context;
}

/**
 * Build a resolver over a set of nodes.
 *
 * The nodes become this resolver's own: node state lives on the instances
 * (MathNode's seed, TimerNode's timer registries), so build a fresh set per
 * resolver — `coreNodes()`, `clientNodes()`, `serverNodes({ root })` — rather
 * than sharing one array. Sharing an instance is allowed and simply shares that
 * instance's state.
 */
export function createResolver(nodes: Node[], options?: ResolverOptions): Resolver {
  // The resolver IS the callable. It closes over itself, which is safe because
  // the body only runs once the binding is initialized.
  // Delegates to the catch-aware `resolve` wrapper rather than straight to
  // `impl`, so a top-level `catch` on the entry expression is honored too —
  // matching how `runSteps` (and every nested node) already resolves.
  const self = ((value: unknown, context: Context) =>
    self.resolve(value, context)) as ResolverImpl;

  const keyMap = self.keyMap = new Map<string, Node>();
  const lazyMap = self.lazyMap = new Map<string, Loader>();
  const pendingLoads = self.pendingLoads = new Map<Loader, Promise<void>>();
  self.keyListeners = new Set();
  self.translateFn = options?.translate ?? null;
  self.nodes = new Set<Node>();
  self.torndown = false;

  self.impl = function resolveImpl(value: unknown, context: Context): unknown {
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
              pending = Promise.resolve(loader(self)).catch((err: unknown) => {
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

  Object.defineProperties(self, {
    keys: { value: makeKeysView(self) },
    destroyed: { get: () => self.torndown },
  });

  self.onKeysChange = (cb) => {
    self.keyListeners.add(cb);
    return () => { self.keyListeners.delete(cb); };
  };
  self.registerNode = (node) => addNode(self, node);
  self.registerLazy = (keys, loader) => addLazy(self, keys, loader);
  self.nodeFor = (key) => self.keyMap.get(key);
  self.destroy = () => destroy(self);

  // Entry points: attach the context, then hand off to the free helpers, which
  // read the resolver back off it as every nested node call already does. This is
  // the only place a flow is bound to a resolver. Attaching is idempotent, so
  // re-entering an already-attached context costs a property compare.
  const at = (context: Context) => adopt(self, context);

  self.resolve = ((value: unknown, context: Context, cont?: (v: unknown) => unknown) => {
    at(context);
    return cont === undefined ? resolve(value, context) : resolve(value, context, cont);
  }) as Resolver["resolve"];
  self.resolveObj = (obj, context, then) => resolveObj(obj, at(context), then);
  self.resolveAll = (values, context, then) => resolveAll(values, at(context), then);
  self.runSteps = (steps, context) => runSteps(steps, at(context));
  self.resolveSteps = (value, context) => resolveSteps(value, at(context));
  self.runStepsDetached = (steps, context, def) => runStepsDetached(steps, at(context), def);

  for (const node of nodes) addNode(self, node);
  if (options?.context) adopt(self, options.context);

  return self;
}
