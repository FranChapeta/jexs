/**
 * Base class for all value resolver nodes.
 *
 * Nodes interpret JSON expressions at runtime, transforming data structures
 * like { "var": "$user.name" } or { "concat": ["Hello", " ", "World"] }
 * into actual values.
 */

import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";
import { splitPath, hasAnyKey, isObject } from "../helpers.js";

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
 * `bubble`). Symbol-keyed AND non-enumerable, on purpose:
 *  - templates can't read it as a `$var`, and request data / `as` (string keys
 *    only) can't forge it;
 *  - JSON and structuredClone drop symbols, so the chain never serializes to a
 *    worker or a log;
 *  - being NON-enumerable, object spread `{ ...ctx }` does NOT copy it. A scope
 *    only gains a parent link when a site explicitly derives one via
 *    `childContext`. This is deliberate: it means a plain spread — e.g. the
 *    server's per-request context spread from the shared startup context — never
 *    inherits a stale link and can never leak a `bubble` write into an
 *    unrelated scope. Untouched child-context sites are simply bubble
 *    boundaries, never mis-routes.
 */
export const PARENT = Symbol("jexs.parent");

/**
 * Derive a child scope from `parent`, linked back via PARENT so `setVars` / `as`
 * with `bubble` can write through to it. `extra` is merged on top (loop
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
   * Naming convention: entries whose names start with `_` are internal helpers.
   * Entries whose names DON'T start with `_` are also added to the combined
   * schema's top-level `anyOf` as root-matchable branches (e.g. `routeNode`
   * lets a bare routes-tree file validate at the file root).
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

  /**
   * Helper: Check if value is a plain object
   */
  protected isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Helper: Set nested value in context using dot notation for "as" support.
   * e.g. setContextValue(ctx, "request.body.value", hash) sets ctx.request.body.value
   *
   * With `bubble`, the same write is also applied to every enclosing scope up
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

  /**
   * Helper: Convert value to string
   */
  protected toString(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    return JSON.stringify(value);
  }

  /**
   * Helper: Convert value to number
   */
  protected toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const num = parseFloat(value);
      return isNaN(num) ? 0 : num;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return 0;
  }

  /**
   * Helper: Convert value to boolean. Static so resolver machinery (e.g. the
   * global `bubble` modifier) can coerce a resolved flag with the exact same
   * rules the instance helper gives every node's condition inputs.
   */
  static toBooleanValue(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      return value !== "" && value !== "0" && value.toLowerCase() !== "false";
    }
    if (Array.isArray(value)) return value.length > 0;
    if (isObject(value)) {
      if ("nodeType" in value) return true; // DOM nodes are truthy
      return hasAnyKey(value);
    }
    return value !== null && value !== undefined;
  }

  /** Helper: Convert value to boolean (instance sugar for `toBooleanValue`). */
  protected toBoolean(value: unknown): boolean {
    return Node.toBooleanValue(value);
  }

  /**
   * Helper: Convert value to array
   */
  protected toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
  }
}

const nodeProtoKeys = new Set(Object.getOwnPropertyNames(Node.prototype));

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
