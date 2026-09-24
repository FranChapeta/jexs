/**
 * Author-facing schema types for Node classes.
 *
 * Each Node subclass declares `static schema: JexsNodeSchema` describing the
 * handler methods on the class. The schema generator (scripts/gen-schema/)
 * collects these via dynamic import and emits create/dist/combined.schema.json
 * for VS Code and (later) the runtime validator.
 */

export type JexsType = "string" | "number" | "boolean" | "array" | "object" | "null";
export type JexsOutput = JexsType | "any";

/**
 * Schema for a single property. Used for sibling properties under a method, and
 * (extended by JexsMethodSchema) for the method's primary key itself.
 *
 * By default a typed property accepts EITHER its declared type OR a nested
 * expression object. Set `literal: true` to reject expressions and require
 * the literal value only.
 *
 * `type` may be a single primitive (`"string"`) or an array of primitives
 * (`["string", "boolean"]`) when a handler accepts multiple literal types —
 * e.g. `dateNow` accepts either a format string OR `true` (shorthand for ms).
 */
export interface JexsPropertySchema {
  type?: JexsType | readonly JexsType[];
  enum?: readonly unknown[];
  items?: JexsPropertySchema;
  description?: string;
  markdownDescription?: string;
  examples?: unknown[];
  /** Direct JSON Pointer ref into the combined schema's $defs (e.g. `"#/$defs/_routeNode"`). */
  $ref?: string;
  /**
   * The step is invalid without this property. Valid on a SIBLING (or a key inside
   * a nested `properties` block), not on the primary key, which is the dispatch
   * trigger and always present.
   *
   * Emits a JSON Schema `required` on the enclosing object, so a missing property
   * is reported where the step is written. Declared inside a `variants` entry it is
   * gated by that variant's discriminator, so it applies only to that operation.
   *
   * Mark a property required only when the handler itself refuses to run without
   * it. A value that merely has a default, or one the node can source elsewhere at
   * runtime (e.g. a `from` that `email-connect` may already have supplied), is not
   * required here: the schema cannot see that state and would report a valid step
   * as broken.
   */
  required?: boolean;

  // Markers — resolved by the generator, never emitted verbatim.
  /** Strict literal. Opt out of implicit type-or-expression wrapping. */
  literal?: boolean;
  /** Fixed-arity tuple. Items default to anyVal (any literal OR expression). */
  tuple?: number | readonly [number, number];
  /** Per-position schemas for a tuple (draft 2020-12 `prefixItems`): each entry
   *  types one slot by index, letting a tuple carry e.g. an `enum` on one position.
   *  Pairs with `tuple` for arity; slots past the list (when `tuple`'s max exceeds
   *  its length) fall back to anyVal. */
  prefixItems?: readonly JexsPropertySchema[];
  /** Opaque-key map: the KEYS are names the node keeps verbatim (variable names,
   *  header names, column names, case labels) and the VALUES are expressions. The
   *  map is never dispatched as an expression itself, matching the per-entry
   *  `resolveObj` the runtime resolves these with, so a key that happens to
   *  collide with a handler key stays a name.
   *
   *  `map` describes the KEYS; a `type` alongside it describes the CONTAINER, so
   *  the two are orthogonal. An opaque-key map has no expression alternative, so
   *  `type` here says only which container shapes are accepted and does NOT get
   *  the type-or-expression wrapping or output narrowing a normal typed slot gets:
   *
   *    map: true                            an object (the default)
   *    map: true, type: "object"            the same, spelled out
   *    map: true, type: ["object","array"]  one map or a list of them (query `data`)
   *    map: true, type: "array"             a list of maps only
   */
  map?: boolean;
  /** Strictly an array of step expressions. */
  steps?: boolean;
  /** Nested object with a declared inner shape (e.g. a query's `options`). Emits
   *  `{ type: "object", properties, additionalProperties }`. `additionalProperties`
   *  defaults to `false` so typos in the nested keys are caught. */
  properties?: Record<string, JexsPropertySchema>;
  /** Companion to `properties`: override the default `additionalProperties: false`
   *  (e.g. set `true` to allow arbitrary extra keys). */
  additionalProperties?: boolean;
  /**
   * Operations selected through THIS property. A variant belongs to the property
   * it discriminates on, the same way everywhere it appears:
   *
   *   - value-mode (`enum` present, or `variantBy: "value"`): the variant key is a
   *     value of this property. `{ "type": "light" }` selects the `light` variant
   *     of a `type` sibling. A key is matched against the `enum` entry it spells,
   *     so a boolean or number enum works (`"true"` selects `true`); with no
   *     `enum`, a `boolean`/`number` type converts the key the same way.
   *   - sibling-mode (otherwise): the variant key names a root sibling whose
   *     PRESENCE selects it. That sibling is the variant's own input, so the
   *     variant's property fields (`type`, `enum`, ...) type it, and its own
   *     `variants` discriminate on it in turn. A DOTTED key tests a clause inside
   *     a nested object (`options.returning`) and registers nothing at the root.
   *
   * Valid on a method's primary key, on a sibling, and on a variant. A value-mode
   * variant is a value, not a property, so the variants nested under it can only
   * be sibling-mode. Not valid inside nested `properties`, `items`, `prefixItems`
   * or a Node's `commonSiblings`; the build rejects those.
   *
   * Every variant is a JexsMethodSchema: it may declare `siblings` (enforced only
   * while it is selected), nested `variants`, and an `output` (see
   * JexsMethodSchema for how outputs resolve).
   */
  variants?: Record<string, JexsMethodSchema>;
  /** Override the inferred discriminator mode. Defaults: `enum` means "value", otherwise "sibling". */
  variantBy?: "sibling" | "value";
  /**
   * The value the handler uses when this property is absent. Emitted as the JSON
   * Schema `default` (editors offer it), and it selects: the value-mode variant
   * for this value also applies when the property is omitted, so
   * `{ "fetch": "/x" }` is treated as `method: "GET"`. Must be one of the `enum`
   * values when there is an `enum`.
   */
  default?: unknown;
  /**
   * Value-mode variants are EXCLUSIVE by default: a sibling declared only inside
   * this property's variants is refused when the property holds a literal value
   * (or is absent and its `default` is a value) whose variant does not declare
   * it, so `{ "fetch": "/x", "body": ... }` is an error because `GET` sends no
   * body. A value from an expression refuses nothing, since it could be any of
   * them. Siblings declared outside these variants are never refused. Set
   * `false` for a property whose values only ADD known siblings on top of
   * arbitrary ones (ElementNode's `tag`, where any attribute is valid).
   */
  exclusive?: boolean;
}

/**
 * A method's schema. Inherited JexsPropertySchema fields describe the PRIMARY
 * KEY (the dispatch trigger). `siblings` describes properties that may appear
 * alongside the primary key. `output` declares the method's resolved return
 * type — captured now, cross-method type-checking lands later.
 *
 * For multi-op methods, declare `variants` (see JexsPropertySchema): on the
 * primary key they select by its value or by a sibling's presence, and on a
 * sibling they select by that sibling's value.
 *
 * The output resolves from the most specific selected scope that declares one:
 *
 *   1. a selected variant of this scope (recursively, its own rules first);
 *   2. otherwise a selected value-variant of one of this scope's siblings, the
 *      first declared sibling winning;
 *   3. otherwise this scope's own `output`, or, when it has none, the enclosing
 *      scope's rules continue.
 *
 * So `{ "fetch": ..., "full": true, "type": "text" }` resolves through the `full`
 * variant (an object) even though `type: "text"` alone narrows to a string, and a
 * variant that omits `output` inherits both the enclosing output and the
 * enclosing siblings' refinements.
 *
 * Universal keys (`as`, `catch`) are NOT listed here — they're injected once at
 * the combined schema's top level.
 */
export interface JexsMethodSchema extends JexsPropertySchema {
  output?: JexsOutput;
  /**
   * Human-readable description of what this method resolves to. Surfaced in
   * the primary key's hover (as a "Returns:" line) and by the MCP `describe_op`
   * tool. Use it for non-obvious return shapes — e.g. a node that returns a
   * `{ response, responseStatus }` envelope rather than a plain value.
   */
  outputDescription?: string;
  siblings?: Record<string, JexsPropertySchema>;
}

/**
 * A Node class's `static schema` is the dependentSchemas map keyed by handler name.
 * The generator wraps this in { type: "object", dependentSchemas: ... } on emit.
 */
export type JexsNodeSchema = Record<string, JexsMethodSchema>;
