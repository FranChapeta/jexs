import { Node, Context, NodeValue } from "./Node.js";
import { resolveFields, isStep } from "../Resolver.js";
import { isObject } from "../helpers.js";
import type { JexsMethodSchema, JexsPropertySchema } from "../schema.js";

/**
 * How one of an op's fields holds steps the op runs itself: the field IS steps
 * (`do`), or it CONTAINS some (menu items, each with its own `do`).
 */
export type StepField = "steps" | "nested";

/** By op key, the fields that hold steps, named as written (`do`, or `$op` for the value). */
export type StepFields = Record<string, Record<string, StepField>>;

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
 *
 * The peer also says which of its ops' fields hold steps (see `stepFields`).
 * Those go over unresolved, so the steps run on the side that owns the op, when
 * it runs them: a `$shortcut`'s `do` runs in main when the key is pressed, not in
 * the page at registration.
 */
export class ProxyNode extends Node {
  private readonly keys: Set<string>;
  private readonly steps = new Map<string, Record<string, StepField>>();

  constructor(
    keys: Iterable<string>,
    private readonly forward: (call: Record<string, unknown>, context: Context) => unknown,
    steps: StepFields = {},
  ) {
    super();
    this.keys = new Set(keys);
    for (const [op, fields] of Object.entries(steps)) this.steps.set(op, fields);
  }

  /** `handlerKeys` is a getter, so growing this set is immediately visible. */
  get handlerKeys(): readonly string[] {
    return [...this.keys];
  }

  /** Adopt more remote keys, and their step fields. Returns the keys that were not already claimed. */
  addKeys(keys: Iterable<string>, steps: StepFields = {}): string[] {
    const added: string[] = [];
    for (const key of keys) {
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      added.push(key);
    }
    for (const [op, fields] of Object.entries(steps)) this.steps.set(op, fields);
    return added;
  }

  /** Whether this proxy claims a key — used to keep proxied keys out of the set
   *  a peer announces, which would otherwise send a key back where it came from. */
  claims(key: string): boolean {
    return this.keys.has(key);
  }

  resolve(def: unknown, context: Context, op?: string): NodeValue {
    // The resolver only ever dispatches a non-null, non-array object — it
    // returns early for everything else before reaching the key map — so this
    // guards direct callers rather than a real dispatch path. There is nothing
    // meaningful to forward, since a call is by definition a keyed object.
    if (!isObject(def)) return undefined;

    // Fields holding steps the remote op runs go over as written: a steps field
    // always, a field with steps inside unless it is a step producing the field
    // (a `$var` holding menu items), which resolves here like any value.
    const fields = op === undefined ? undefined : this.steps.get(op);
    const raw = fields === undefined ? [] : Object.keys(fields).filter(key =>
      key in def && (fields[key] === "steps" || !isStep(def[key])));
    const local = raw.length === 0 ? def : Object.fromEntries(Object.entries(def).filter(([key]) => !raw.includes(key)));

    // `resolveFields` leaves the global step keys (`$as`, `$catch`, `$then`) out of
    // the call; the resolver applies them to the returned promise in THIS thread.
    // That is what makes a remote call behave exactly like a local one: the remote
    // is only a value producer.
    return resolveFields(local, context, call => {
      for (const key of raw) call[key] = def[key];
      return Promise.resolve(this.forward(call, context));
    });
  }
}

/**
 * The fields of each op that hold steps, read from the nodes' schemas: the value
 * (`$op`) or a sibling declared as steps, or one whose schema has steps anywhere
 * inside it, following `$ref`s into the nodes' `schemaDefs` (`$menu` items, whose
 * `_menuItem` declares `do`). Siblings declared inside variants count too.
 */
export function stepFields(nodes: Iterable<Node>): StepFields {
  const classes = new Set<typeof Node>();
  for (const node of nodes) classes.add(node.constructor as typeof Node);
  const defs: Record<string, unknown> = {};
  for (const cls of classes) Object.assign(defs, cls.schemaDefs);

  const out: StepFields = {};
  for (const cls of classes) {
    for (const [op, method] of Object.entries(cls.schema)) {
      const fields: Record<string, StepField> = {};
      const add = (name: string, prop: JexsPropertySchema) => {
        const kind = stepKind(withoutScopes(prop), defs);
        if (kind !== null) fields[name] = kind;
      };
      add(`$${op}`, method);
      for (const [name, prop] of Object.entries(cls.commonSiblings ?? {})) add(name, prop);
      collect(method, add);
      if (Object.keys(fields).length > 0) out[op] = fields;
    }
  }
  return out;
}

/** Visit every sibling under a scope, including those its variants declare. */
function collect(scope: JexsMethodSchema, add: (name: string, prop: JexsPropertySchema) => void): void {
  for (const [name, prop] of Object.entries(scope.siblings ?? {})) {
    add(name, prop);
    for (const variant of Object.values(prop.variants ?? {})) collect(variant, add);
  }
  // A sibling-selected variant is itself a sibling, named by its key.
  const bySibling = (scope.variantBy ?? (scope.enum ? "value" : "sibling")) === "sibling";
  for (const [name, variant] of Object.entries(scope.variants ?? {})) {
    if (bySibling) add(name, variant);
    collect(variant, add);
  }
}

/** A property's own shape, without the scopes nested under it. */
function withoutScopes(prop: JexsPropertySchema): Record<string, unknown> {
  const { siblings: _s, variants: _v, ...shape } = prop as JexsMethodSchema;
  return shape;
}

/** Whether a schema fragment is steps, holds steps somewhere inside, or neither. */
function stepKind(fragment: Record<string, unknown>, defs: Record<string, unknown>): StepField | null {
  if (fragment.steps === true || fragment.$ref === "#/$defs/steps") return "steps";
  return holdsSteps(fragment, defs, new Set()) ? "nested" : null;
}

function holdsSteps(value: unknown, defs: Record<string, unknown>, seen: Set<string>): boolean {
  if (Array.isArray(value)) return value.some(v => holdsSteps(v, defs, seen));
  if (!isObject(value)) return false;
  if (value.steps === true || value.$ref === "#/$defs/steps") return true;
  const name = typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/") ? value.$ref.slice(8) : null;
  if (name !== null && name in defs && !seen.has(name)) {
    seen.add(name);
    if (holdsSteps(defs[name], defs, seen)) return true;
  }
  return Object.values(value).some(v => holdsSteps(v, defs, seen));
}
