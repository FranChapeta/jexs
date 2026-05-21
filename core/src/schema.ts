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

  // Markers — resolved by the generator, never emitted verbatim.
  /** Strict literal. Opt out of implicit type-or-expression wrapping. */
  literal?: boolean;
  /** Fixed-arity tuple. Items default to anyVal (any literal OR expression). */
  tuple?: number | readonly [number, number];
  /** Object whose values are themselves expressions / step arrays / primitives. */
  map?: boolean;
  /** Strictly an array of step expressions. */
  steps?: boolean;
}

/**
 * A method's schema. Inherited JexsPropertySchema fields describe the PRIMARY
 * KEY (the dispatch trigger). `siblings` describes properties that may appear
 * alongside the primary key. `output` declares the method's resolved return
 * type — captured now, cross-method type-checking lands later.
 *
 * Universal keys (`as`, `catch`) are NOT listed here — they're injected once at
 * the combined schema's top level.
 */
export interface JexsMethodSchema extends JexsPropertySchema {
  output?: JexsOutput;
  siblings?: Record<string, JexsPropertySchema>;
}

/**
 * A Node class's `static schema` is the dependentSchemas map keyed by handler name.
 * The generator wraps this in { type: "object", dependentSchemas: ... } on emit.
 */
export type JexsNodeSchema = Record<string, JexsMethodSchema>;
