/**
 * Base class for all value resolver nodes.
 *
 * Nodes interpret JSON expressions at runtime, transforming data structures
 * like { "$var": "user.name" } or { "$concat": ["Hello", " ", "World"] }
 * into actual values.
 */

import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";
import {
  splitPath, isObject,
  toStringValue, toNumberValue, toBooleanValue, toArrayValue,
} from "../helpers.js";

export interface Context {
  [key: string]: unknown;
  /** HTTP request data */
  request?: {
    method?: string;
    path?: string;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    params?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string>;
  };
  /** Session data */
  session?: Record<string, unknown>;
  /** Current loop context for foreach */
  loop?: {
    item: unknown;
    index: number;
    key: string | number;
    first: boolean;
    last: boolean;
    length: number;
  };
}

export type NodeValue = unknown;

/**
 * Links a derived (child) scope back to the context it was spread from, so a
 * write can travel upward past the copy that made it (see `setContextValue`'s
 * `$bubble`). Symbol-keyed AND non-enumerable, on purpose:
 *  - templates can't read it as a `$var`, and request data / `$as` (string keys
 *    only) can't forge it;
 *  - JSON and structuredClone drop symbols, so the chain never serializes to a
 *    worker or a log;
 *  - being NON-enumerable, object spread `{ ...ctx }` does NOT copy it. A scope
 *    only gains a parent link when a site explicitly derives one via
 *    `childContext`. This is deliberate: it means a plain spread — e.g. the
 *    server's per-request context spread from the shared startup context — never
 *    inherits a stale link and can never leak a `$bubble` write into an
 *    unrelated scope. Untouched child-context sites are simply bubble
 *    boundaries, never mis-routes.
 */
export const PARENT = Symbol("jexs.parent");

/**
 * Derive a child scope from `parent`, linked back via PARENT so `$setVars` / `$as`
 * with `$bubble` can write through to it. `extra` is merged on top (loop
 * bindings, fileDir, params) and may carry symbol keys (e.g. the fileDir marker).
 * The link is non-enumerable, so it never shows up in a later spread/serialize.
 */
export function childContext(parent: Context, extra?: Record<PropertyKey, unknown>): Context {
  const child: Context = extra ? { ...parent, ...(extra as Record<string, unknown>) } : { ...parent };
  Object.defineProperty(child, PARENT, { value: parent, writable: true, configurable: true });
  return child;
}

export abstract class Node {
  /**
   * JSON schema describing this Node's handler methods. Subclasses override with
   * a literal map of methodKey → JexsMethodSchema. The `JexsNodeSchema` type is
   * inherited via subclass static field assignment — subclasses can write
   * `static schema = { ... };` without re-annotating.
   */
  static schema: JexsNodeSchema = {};

  /**
   * Optional raw JSON Schema fragments this Node contributes to the combined
   * schema's `$defs`. Use for structures that don't fit JexsPropertySchema —
   * e.g. recursive trees, patternProperties. Schema author refs them via
   * `{ $ref: "#/$defs/<name>" }` on a property.
   *
   * Naming convention: entries whose names start with `_` are internal helpers,
   * reachable only through a property that refs them. An entry whose name DOESN'T
   * start with `_` is also a ROOT DOCUMENT KIND: a file whose root object has every
   * key the entry `required`s must match it, and every other file is Jexs (steps
   * or an expression). SchemaNode's `tableSchema` is one, so a file with
   * `properties` and `table` at its root is checked as a table document.
   *
   * The required keys are the only thing that tells a kind apart, so choose keys
   * only that kind of document has: a kind requiring just `type` would claim
   * ordinary templates. The build refuses a kind with no `required`, one requiring
   * a `$` op key, and two kinds requiring the same keys; when one kind's keys
   * include another's, the more specific one is tested first.
   */
  static schemaDefs?: Record<string, Record<string, unknown>>;

  /**
   * Siblings shared across every method declared by this Node. The framework
   * auto-creates a `_<NodeName>Siblings` $defs entry from this map and refs
   * it from every byKey entry — so the sibling block is stored once, not
   * duplicated per method. Each method's own `siblings` field can still add
   * method-specific entries on top.
   */
  static commonSiblings?: Record<string, JexsPropertySchema>;

  /**
   * Keys this node handles for key-based dispatch in the resolver.
   * Default: auto-discovers own prototype methods not on Node.prototype.
   */
  get handlerKeys(): readonly string[] | null {
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(this));
    const result = own.filter(k => !nodeProtoKeys.has(k) && k !== "constructor");
    return result.length > 0 ? result : null;
  }

  /**
   * Release anything this node owns, called when a resolver it belongs to is
   * destroyed or replaced.
   */
  dispose?(): void;

  /**
   * Resolve this node to a concrete value.
   * matchedKey is the key that triggered dispatch (e.g. "concat", "if").
   * Default: calls this[matchedKey](definition, context) via prototype.
   */
  resolve(definition: unknown, context: Context, matchedKey?: string): NodeValue {
    if (!matchedKey || !this.isObject(definition)) return undefined;
    const handler = Object.getPrototypeOf(this)[matchedKey];
    return typeof handler === "function" ? handler.call(this, definition, context) : null;
  }

  /** Helper: Check if value is a plain object. */
  protected isObject(value: unknown): value is Record<string, unknown> {
    return isObject(value);
  }

  /**
   * Helper: Set nested value in context using dot notation for "as" support.
   * e.g. setContextValue(ctx, "request.body.value", hash) sets ctx.request.body.value
   *
   * With `$bubble`, the same write is also applied to every enclosing scope up
   * the PARENT chain, so the value survives after the current file/loop/branch
   * (each a copied context) returns — this is how state moves upward.
   */
  static setContextValue(context: Context, varName: string, value: unknown, bubble = false): void {
    writeContextValue(context, varName, value);
    if (!bubble) return;
    let ancestor = (context as { [PARENT]?: Context })[PARENT];
    while (ancestor) {
      writeContextValue(ancestor, varName, value);
      ancestor = (ancestor as { [PARENT]?: Context })[PARENT];
    }
  }

  // Coercion sugar for handler bodies. The rules live in helpers.ts as free
  // functions, since none of them touch a node and a node's own module-scope
  // helpers need them too (a module function cannot reach a protected member,
  // even when handed the instance).

  /** Helper: Convert value to string. */
  protected toString(value: unknown): string {
    return toStringValue(value);
  }

  /** Helper: Convert value to number. */
  protected toNumber(value: unknown): number {
    return toNumberValue(value);
  }

  /**
   * Helper: Convert value to boolean. Also exposed as a static, so the resolver
   * machinery (the global `$bubble` modifier) coerces a resolved flag by exactly
   * the rules every node's condition inputs get.
   */
  protected toBoolean(value: unknown): boolean {
    return toBooleanValue(value);
  }

  static toBooleanValue(value: unknown): boolean {
    return toBooleanValue(value);
  }

  /** Helper: Convert value to array. */
  protected toArray(value: unknown): unknown[] {
    return toArrayValue(value);
  }

  /**
   * Helper: the member of an enum sibling's allowed list that a value names, or
   * undefined when absent, so a caller spells its default with `??`. Anything
   * present must be a member, an empty string included: a value quietly ignored
   * makes the step do something other than what it says. Folds case, and `name`
   * reaches the message, so qualify it ("fetch type", not "type").
   */
  protected getOption<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
    if (value === null || value === undefined) return undefined;
    const found = allowed.find(a => a === String(value).toLowerCase());
    if (!found) {
      throw new Error(`Invalid ${name} "${String(value)}": expected ${allowed.join(", ")}`);
    }
    return found;
  }
}

/**
 * Names `handlerKeys` must never report as ops. Everything on `Node.prototype`,
 * plus `dispose` by hand: `dispose?(): void` above is a bodiless declaration, so
 * TypeScript emits nothing for it and it is absent from the prototype — leaving a
 * node that implements it (MathNode, TimerNode) to register `dispose` as an op.
 */
const nodeProtoKeys = new Set([...Object.getOwnPropertyNames(Node.prototype), "dispose"]);

/** Write a single dot-path value into one context (no propagation). */
function writeContextValue(context: Context, varName: string, value: unknown): void {
  // Strip a leading `$` (charCode 36) so "$a.b" and "a.b" share one cache key.
  const normalized = varName.charCodeAt(0) === 36 ? varName.slice(1) : varName;
  const parts = splitPath(normalized);
  if (parts.length === 1) {
    context[parts[0]] = value;
    return;
  }
  let target: Record<string, unknown> = context;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] && typeof target[parts[i]] === "object") {
      target = target[parts[i]] as Record<string, unknown>;
    } else {
      target[parts[i]] = {};
      target = target[parts[i]] as Record<string, unknown>;
    }
  }
  target[parts[parts.length - 1]] = value;
}
