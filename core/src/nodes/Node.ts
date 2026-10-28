/**
 * Base class for all value resolver nodes.
 *
 * Nodes interpret JSON expressions at runtime, transforming data structures
 * like { "$var": "user.name" } or { "$concat": ["Hello", " ", "World"] }
 * into actual values.
 */

import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";
import {
  splitPath, isObject, isPrototypeKey,
  toStringValue, toNumberValue, toBooleanValue, toArrayValue,
} from "../helpers.js";

export interface Context {
  [key: string]: unknown;
  /** What the runtime keeps for its nodes, out of templates' reach (see CLIENT_SCRIPT). */
  [key: symbol]: unknown;
  [TRANSLATE]?: Translator;
}

export type NodeValue = unknown;

/**
 * Marks a scope `boundaryContext` made, where a `$bubble` stops climbing. Read
 * as an own property only, since the scopes under a boundary inherit it.
 * Symbol-keyed so templates and request data can't reach or forge it, and
 * non-enumerable so a spread or a serialization of the scope never carries it.
 */
const BOUNDARY = Symbol("jexs.boundary");

// What one package's nodes set on the context for another's to read. Symbol
// keys, so a template can't read them with `$var` (string paths) and request
// data or `$as` can't forge them. A derived scope reads them from its parent.

/** The browser bundle's URL, when the page is served with it: a `<head>` loads it. */
export const CLIENT_SCRIPT = Symbol("jexs.clientScript");
/** The service worker's URL, which the client script registers. */
export const SW_SCRIPT = Symbol("jexs.swScript");
/** The session's CSRF token, which a form on a page without the client script carries. */
export const CSRF_TOKEN = Symbol("jexs.csrfToken");
/** Translates an element's literal text where it renders: a `Translator`, set
 *  for a request by a node such as the server's `$translate`. */
export const TRANSLATE = Symbol("jexs.translate");
export type Translator = (text: string) => string | Promise<string>;

/**
 * Derive a child scope from `parent`. It reads every variable of `parent` as it
 * is now, through its prototype, so nothing is copied; what it binds itself
 * (`extra`: loop bindings, params, symbol-keyed markers, and later what its steps
 * write without `$bubble`) is its own and shadows the parent's. A `$bubble` from
 * it passes up to `parent`. An extra named after a prototype key throws: params
 * parsed from JSON can hold an own `__proto__`, and binding it would re-parent
 * the scope.
 */
export function childContext(parent: Context, extra?: Record<PropertyKey, unknown>): Context {
  const scope = Object.create(parent) as Context;
  if (extra) {
    for (const key of Reflect.ownKeys(extra)) {
      if (typeof key === "string" && isPrototypeKey(key)) throw new Error(`Cannot bind "${key}" in a scope: it names the prototype, not a variable`);
      scope[key] = extra[key];
    }
  }
  return scope;
}

/**
 * Derive a scope that reads `parent` as a child does, but where a `$bubble`
 * stops: its steps can never write `parent`'s variables. For a scope that must
 * leave its caller's state alone, such as a request's (the startup context is
 * every request's) or a validator's.
 */
export function boundaryContext(parent: Context, extra?: Record<PropertyKey, unknown>): Context {
  const scope = childContext(parent, extra);
  Object.defineProperty(scope, BOUNDARY, { value: true });
  return scope;
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
   * or an expression). DatabaseTableNode's `tableSchema` is one, so a file with
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
   * Without `bubble` the write lands in `context`, which then has the variable
   * as its own. With `bubble` it lands in an enclosing scope: the nearest one
   * above `context` that has the variable (the path's first segment) as its
   * own, or when none does, the first boundary or top scope on the way, which
   * then has it. A boundary or top scope has nothing above it to write, so a
   * bubble from one lands in it. Every scope below the one written reads the
   * variable from there.
   */
  static setContextValue(context: Context, varName: string, value: unknown, bubble = false): void {
    writeContextValue(bubble ? bubbleTarget(context, splitPath(varName)[0]) : context, varName, value);
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
   * makes the step do something other than what it says. Spelled exactly as
   * listed, as the schema's `enum` checks it, and `name` reaches the message, so
   * qualify it ("fetch type", not "type").
   */
  protected getOption<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
    if (value === null || value === undefined) return undefined;
    const found = allowed.find(a => a === value);
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

/**
 * The scope a bubbled write of `name` lands in (see `setContextValue`). A top
 * scope is a plain object, so its prototype is `Object.prototype` (or `null`),
 * which is where the climb ends when no boundary ends it first.
 */
function bubbleTarget(context: Context, name: string): Context {
  let scope = context;
  while (!Object.hasOwn(scope, BOUNDARY)) {
    const parent = Object.getPrototypeOf(scope) as Context | null;
    if (parent === null || parent === Object.prototype) break;
    scope = parent;
    if (Object.hasOwn(scope, name)) break;
  }
  return scope;
}

/**
 * Write a single dot-path value into one context. A path through an object the
 * scope reads from its parent writes into that same object, as an assignment
 * through a shared reference does in JS. A path naming a prototype key throws,
 * since through one it would write the scope above a boundary, or the
 * prototype every object shares.
 */
function writeContextValue(context: Context, varName: string, value: unknown): void {
  const parts = splitPath(varName);
  const reserved = parts.find(isPrototypeKey);
  if (reserved !== undefined) throw new Error(`Cannot write "${varName}": "${reserved}" names the prototype, not a variable or its data`);
  if (parts.length === 1) {
    context[parts[0]] = value;
    return;
  }
  // A frozen object along the path is read-only data (`$setVars` with
  // `readonly`): said plainly, before the strict-mode TypeError would be.
  const writable = (target: object, depth: number) => {
    if (Object.isFrozen(target)) throw new Error(`Cannot write "${varName}": "${parts.slice(0, depth).join(".")}" is read-only data. Copy it into a variable to change it.`);
  };
  let target: Record<string, unknown> = context;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] && typeof target[parts[i]] === "object") {
      target = target[parts[i]] as Record<string, unknown>;
    } else {
      writable(target, i);
      target[parts[i]] = {};
      target = target[parts[i]] as Record<string, unknown>;
    }
  }
  writable(target, parts.length - 1);
  target[parts[parts.length - 1]] = value;
}
