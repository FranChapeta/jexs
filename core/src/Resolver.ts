import { Context, Node, childContext } from "./nodes/Node.js";
import { isHttpError } from "./errors.js";
import { isObject } from "./helpers.js";

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

/**
 * What `createResolver` hands back: the entry point, plus the API for the
 * dispatch table it carries.
 *
 * Calling it runs a template in a context, the way a template file is read: an
 * array runs as steps (the last step's value is the result), anything else
 * resolves as one expression. The context is attached to this resolver first;
 * inside a flow, nodes use the free `resolve` / `runSteps` / … functions, which
 * find the resolver on the context.
 */
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
 * hold private class fields), and one object is simpler than two objects with a
 * back-reference. `resolverFor` hands back this type, so the module's own
 * helpers reach the dispatch state through the same lookup callers use; the
 * extra fields are internal and not part of the supported API.
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

/** The resolver a context is running in. Throws if it has never been adopted. */
export function resolverFor(context: Context): ResolverImpl {
  const self = (context as Resolved)[RESOLVER];
  if (self === undefined) {
    throw new Error(
      "No resolver for this context. Resolve through a resolver at least once " +
      "(call the resolver with it), derive it from a scope that already has " +
      "one (childContext, or a plain spread), or pass it as createResolver's " +
      "`context` option.",
    );
  }
  return self;
}


/**
 * Global step keys handled by the resolver machinery, not by nodes: `$as`,
 * `$catch`, `$then` and `$bubble` (a modifier on `$as`) are applied where a step
 * dispatches (in `walk`), and `$return` by `runSteps`. They must never be
 * eagerly resolved as node inputs.
 *
 * Exported because ProxyNode strips them before forwarding a call — the remote
 * side is only a value producer, and these are applied in the calling thread —
 * and because a host filtering IPC calls must not mistake `$as` or `$catch` for an
 * op. `GLOBAL_KEY_DOCS` in schema-gen describes the same five for autocomplete;
 * a test asserts the two cannot drift apart.
 */
export const GLOBAL_KEYS = new Set(["as", "return", "catch", "bubble", "then"]);

/** A key the resolver owns is written with this prefix: `{ "$concat": [...] }`
 *  dispatches on `concat`, and `$as`/`$then`/`$catch`/`$return`/`$bubble` are the
 *  global step keys. Every other key is a sibling or data, never dispatched. */
export const KEY_PREFIX = "$";

/** The resolver-owned name in `key` (`"$concat"` → `"concat"`), or null for any other key. */
export function ownedKey(key: string): string | null {
  return isOwnedKey(key) ? key.slice(1) : null;
}

/** Whether the resolver owns `key`, without building its bare name. */
export function isOwnedKey(key: string): boolean {
  return key.charCodeAt(0) === 36 /* $ */;
}

/** An object with a `$` key: a step the resolver acts on. An object without one
 *  is data, whose values are resolved but which never dispatches itself. */
export function isStep(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).some(isOwnedKey);
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

export async function translate(text: string, context: Context): Promise<string> {
  const fn = resolverFor(context).translateFn;
  if (fn && /[a-zA-Z]/.test(text)) {
    return fn(text, context);
  }
  return text;
}

/**
 * Write a step's result to its `$as` name and hand the result on. `$bubble`
 * alongside `$as` also writes it up the parent-context chain, so it survives the
 * current file/loop/branch scope. `$bubble` may be an expression, so it is
 * resolved first, and the result is handed on only once the write is done.
 */
function storeAs(step: Record<string, unknown>, value: unknown, context: Context): unknown {
  const name = String(step.$as);
  if (step.$bubble === undefined) { Node.setContextValue(context, name, value); return value; }
  return resolve(step.$bubble, context, b => {
    Node.setContextValue(context, name, value, Node.toBooleanValue(b));
    return value;
  });
}

/**
 * Run a step's `$catch` array (if present) with `error` bound, else rethrow.
 * Exported so async nodes that handle their own rejection off the normal
 * `resolve` flow (e.g. the fire-and-forget `thread` node) reuse the same
 * `$catch`/`error` semantics.
 */
export function handleErr(err: unknown, value: unknown, context: Context): unknown {
  if (isObject(value) && value.$catch !== undefined) {
    // Bound as `error`, so `{ "$var": "error.message" }` reads the message.
    // HTTP errors carry a status; any other thrown/rejected error (e.g. a worker
    // task failure) binds just its message.
    const error = isHttpError(err)
      ? { status: err.status, message: err.message }
      : { message: err instanceof Error ? err.message : String(err) };
    // A node that knows more than its message offers it as further variables of
    // its own (`fetch` hands over `response`), so `error` keeps the one shape
    // everywhere. Bound first, so none of them can displace `error` itself.
    const bindings = isHttpError(err) ? err.bindings : undefined;
    const catchCtx = childContext(context, { ...bindings, error });
    return runSteps(value.$catch, catchCtx);
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
 * A step's `$then` and `$catch` are applied where it dispatches (see
 * `walk`), so they hold for a step at any depth, not only for the value
 * handed in here.
 */
export function resolve(value: unknown, context: Context): unknown;
export function resolve<T>(value: unknown, context: Context, cont: (v: unknown) => T): T | Promise<T>;
export function resolve(value: unknown, context: Context, cont?: (v: unknown) => unknown): unknown {
  const r = walk(resolverFor(context), value, context);
  return cont ? andThen(r, cont) : r;
}

/** Apply `f` to a value that may still be pending: now if it is ready, else when it settles. */
function andThen<V, T>(v: V | Promise<V>, f: (v: V) => T): T | Promise<T> {
  return v instanceof Promise ? v.then(f) : f(v);
}

/**
 * Resolve every field of a step def in parallel, sync-first, and pass `then` a
 * new record of the results. For a node that wants all of its step's inputs at
 * once (the def itself, or an option bag it built from the def's fields).
 * `resolve(def)` cannot do this: it would dispatch the step again.
 *
 * The global step keys are left out of the result: they belong to the resolver
 * (`$return` to runSteps, the rest to dispatch), and resolving a
 * `$catch` array here would run the error handler on success.
 */
export function resolveFields<T>(def: Record<string, unknown>, context: Context, then: (r: Record<string, unknown>) => T): T | Promise<T> {
  const keys = Object.keys(def).filter(key => !(isOwnedKey(key) && GLOBAL_KEYS.has(key.slice(1))));
  return andThen(resolveKeys(resolverFor(context), def, keys, {}, context), then);
}

/**
 * Resolve multiple values in parallel, sync-first.
 * Mutates the input array in-place (callers must pass a fresh array literal).
 * On the sync path: no allocations — writes resolved values in-place, calls then(values) directly.
 * On the async path: waits for all async values via Promise.all, then calls then(values).
 */
export function resolveAll<T>(values: unknown[], context: Context, then: (args: unknown[]) => T): T | Promise<T> {
  return andThen(resolveItems(resolverFor(context), values, values, context), then);
}

/**
 * Resolve each item of `src` into the same index of `out`, in parallel,
 * sync-first. `out` may be `src` itself (resolveAll's in-place contract);
 * otherwise it is a fresh array, so a literal array in a template is never
 * handed out, only a copy of it.
 */
function resolveItems(self: ResolverImpl, src: readonly unknown[], out: unknown[], context: Context): unknown[] | Promise<unknown[]> {
  let pending: Promise<unknown>[] | null = null;
  let pendingAt: number[] | null = null;
  for (let i = 0; i < src.length; i++) {
    const r = walk(self, src[i], context);
    if (r instanceof Promise) { (pending ??= []).push(r); (pendingAt ??= []).push(i); }
    else out[i] = r;
  }
  if (pending === null) return out;
  return Promise.all(pending).then(values => {
    pendingAt!.forEach((at, j) => { out[at] = values[j]; });
    return out;
  });
}

/** `resolveItems` for the named `keys` of an object. */
function resolveKeys(
  self: ResolverImpl,
  src: Record<string, unknown>,
  keys: readonly string[],
  out: Record<string, unknown>,
  context: Context,
): Record<string, unknown> | Promise<Record<string, unknown>> {
  let pending: Promise<unknown>[] | null = null;
  let pendingAt: string[] | null = null;
  for (const key of keys) {
    const r = walk(self, src[key], context);
    if (r instanceof Promise) { (pending ??= []).push(r); (pendingAt ??= []).push(key); }
    else out[key] = r;
  }
  if (pending === null) return out;
  return Promise.all(pending).then(values => {
    pendingAt!.forEach((key, j) => { out[key] = values[j]; });
    return out;
  });
}

/**
 * The tree walker. Walks template literals only: whatever a node returns is a
 * value and is never walked again. A literal array or plain object comes back as
 * a NEW container every time, never the template's own, so a node mutating a
 * value in place (ArrayNode's `$push`) cannot edit the template for the next run.
 */
function walk(self: ResolverImpl, value: unknown, context: Context): unknown {
  // Hottest case first: anything that isn't a non-null object resolves to
  // itself. Covers null/undefined/boolean/number/string and also
  // function/symbol/bigint.
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return resolveItems(self, value, new Array(value.length), context);

  // A class instance (a Date, a buffer, a DOM node) is a value, not a literal.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  // Dispatch on the step's one `$` op key. Nothing else is ever dispatched,
  // so an object without one is plain data, whatever its keys are called.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const op = stepOp(obj, keys);
  if (op === null) return resolveKeys(self, obj, keys, {}, context);

  // A step runs through its node, with its global keys applied around it.
  //
  // `$then` makes the step FIRE-AND-FORGET: the work starts off the caller's
  // stack (so even synchronous setup doesn't block), the caller gets `undefined`
  // right away, and when the work settles the `$then` steps run with the result
  // bound as `result`. Errors go through `$catch`, unhandled if there is none,
  // like any background task.
  //
  // `$catch` runs its steps with `error` (`{ status, message }`) bound, alongside
  // any further variables the thrower offered (see `createHttpError`).
  //
  // `$as` stores what the step ends up with: the node's value, the `$catch`
  // steps' value, or `undefined` under `$then`.
  let r: unknown;
  if (obj.$then !== undefined) {
    const then = obj.$then;
    void Promise.resolve()
      .then(() => callNode(self, obj, op, context))
      .then(result => runSteps(then, childContext(context, { result })))
      .catch(err => handleErr(err, obj, context));
  } else if (obj.$catch === undefined) {
    r = callNode(self, obj, op, context);
  } else {
    r = withCatch(() => callNode(self, obj, op, context), obj, context);
  }
  return obj.$as === undefined ? r : andThen(r, v => storeAs(obj, v, context));
}

/**
 * The op a step dispatches on, or null for plain data. A step names exactly one
 * op; the global keys ride along with it and mean nothing on their own, except
 * `$return`, which is the value a sequence yields rather than a step.
 */
function stepOp(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  let op: string | null = null;
  let global: string | null = null;
  for (const key of keys) {
    if (!isOwnedKey(key)) continue;
    const name = key.slice(1);
    if (GLOBAL_KEYS.has(name)) { if (name !== "return") global = key; continue; }
    if (op !== null) {
      throw new Error(`A step dispatches on one op, but this one names both "$${op}" and "${key}".`);
    }
    op = name;
  }
  if (op === null && global !== null) {
    throw new Error(`A step needs an op: "${global}" does nothing on its own, in ${JSON.stringify(obj)}.`);
  }
  return op;
}

/** Run `fn`, sending a synchronous throw or an async rejection to `step`'s `$catch`. */
function withCatch(fn: () => unknown, step: unknown, context: Context): unknown {
  let r: unknown;
  try {
    r = fn();
  } catch (err) {
    return handleErr(err, step, context);
  }
  return r instanceof Promise ? r.catch(err => handleErr(err, step, context)) : r;
}

/** Hand a step to the node registered for its op, loading a lazy module first. */
function callNode(self: ResolverImpl, step: Record<string, unknown>, op: string, context: Context): unknown {
  const node = self.keyMap.get(op);
  if (node) return node.resolve(step, context, op);
  const loader = self.lazyMap.get(op);
  if (!loader) throw new Error(`Unknown op "$${op}".`);
  let pending = self.pendingLoads.get(loader);
  if (!pending) {
    pending = Promise.resolve(loader(self)).catch((err: unknown) => {
      self.pendingLoads.delete(loader);
      throw err;
    });
    self.pendingLoads.set(loader, pending);
  }
  return pending.then(() => {
    for (const [key, fn] of self.lazyMap) { if (fn === loader) self.lazyMap.delete(key); }
    const loaded = self.keyMap.get(op);
    if (!loaded) throw new Error(`Unknown op "$${op}": its module loaded without registering it.`);
    return loaded.resolve(step, context, op);
  });
}

/**
 * Run a steps slot: one step, or an array of steps run in order.
 *
 * An array is a sequence, sync-first, yielding the last step's value. A step
 * that resolves to `{ $return: X }` stops the sequence and yields `X`. The
 * wrapper does not propagate to enclosing sequences; to escape more levels, nest
 * it (`{ $return: { $return: X } }`).
 *
 * Anything else is a single expression, not a sequence, so a `{ $return: X }` it
 * resolves to passes through to the sequence around it. That is what lets
 * `{ "$if": …, "then": { "$return": X } }` end the enclosing sequence.
 *
 * A loop rather than recursion: synchronous steps run without growing the stack,
 * and only an async step hands the rest of the sequence to its promise.
 *
 * Every item of a sequence must be an expression object. A literal item resolves
 * to itself, so it can only ever be a no-op or, as the last one, a value dressed
 * up as a sequence: `["Hello"]` where `"Hello"` was meant.
 */
export function runSteps(steps: unknown, context: Context): unknown {
  const self = resolverFor(context);
  if (!Array.isArray(steps)) return walk(self, steps, context);
  const run = (from: number): unknown => {
    let v: unknown;
    for (let i = from; i < steps.length; i++) {
      const step = steps[i];
      if (!isObject(step)) {
        throw new Error(
          `A step must be an expression object, got ${step === null ? "null" : typeof step}: ${JSON.stringify(step)}`,
        );
      }
      v = walk(self, step, context);
      if (v instanceof Promise) {
        const next = i + 1;
        return v.then(r => isReturn(r) ? r.$return : next < steps.length ? run(next) : r);
      }
      if (isReturn(v)) return v.$return;
    }
    return v;
  };
  return run(0);
}

function isReturn(value: unknown): value is { $return: unknown } {
  return isObject(value) && "$return" in value;
}

/**
 * Run steps from a deferred callback — a timer tick, a socket message, a menu
 * click, an OS event — where `resolve` has long since returned and the resolver
 * is no longer wrapped around the call.
 * `def` is the step object whose `$catch` should be honored.
 *
 * The steps start synchronously, on the caller's stack; only the outcome comes
 * back as a promise. When nothing handled an error, the promise rejects, or,
 * given a `label`, the error is logged under it and the promise resolves to
 * `undefined`, since a callback has nobody left to hand it to.
 */
export async function runStepsDetached(
  steps: unknown,
  context: Context,
  def: unknown = null,
  label?: string,
): Promise<unknown> {
  try {
    return await withCatch(() => runSteps(steps, context), def, context);
  } catch (err) {
    if (label === undefined) throw err;
    console.error(label, err);
    return undefined;
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
   * the resolver) is attached by the entry point it arrives at, and a
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
  // The resolver IS the callable, and the one place a flow is bound to a
  // resolver: it attaches the context, then runs the template. It closes over
  // itself, which is safe because the body only runs once the binding is
  // initialized. Attaching is idempotent, so re-entering an already-attached
  // context costs a property compare.
  const self = ((template: unknown, context: Context) =>
    runSteps(template, adopt(self, context))) as ResolverImpl;

  self.keyMap = new Map<string, Node>();
  self.lazyMap = new Map<string, Loader>();
  self.pendingLoads = new Map<Loader, Promise<void>>();
  self.keyListeners = new Set();
  self.translateFn = options?.translate ?? null;
  self.nodes = new Set<Node>();
  self.torndown = false;

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
  // Idempotent, and it does NOT touch any other resolver: one resolver's teardown
  // leaving another's timers and connections running is the whole point.
  self.destroy = () => {
    if (self.torndown) return;
    self.torndown = true;
    for (const node of self.nodes) {
      if (!node.dispose) continue;
      try { node.dispose(); } catch { /* best-effort */ }
    }
    self.keyListeners.clear();
    // keyMap/lazyMap are deliberately kept, so a destroyed resolver's `keys` view
    // still reports what it had rather than going silently empty.
  };

  for (const node of nodes) addNode(self, node);
  if (options?.context) adopt(self, options.context);

  return self;
}
