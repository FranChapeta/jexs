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
  /** Nested object with a declared inner shape (e.g. a query's `options`). Emits
   *  `{ type: "object", properties, additionalProperties }`. `additionalProperties`
   *  defaults to `false` so typos in the nested keys are caught. */
  properties?: Record<string, JexsPropertySchema>;
  /** Companion to `properties`: override the default `additionalProperties: false`
   *  (e.g. set `true` to allow arbitrary extra keys). */
  additionalProperties?: boolean;
}

/**
 * A method's schema. Inherited JexsPropertySchema fields describe the PRIMARY
 * KEY (the dispatch trigger). `siblings` describes properties that may appear
 * alongside the primary key. `output` declares the method's resolved return
 * type — captured now, cross-method type-checking lands later.
 *
 * For multi-op methods, declare `variants`: one ergonomic dispatch key whose
 * resolved output type and valid siblings depend on a discriminator (the variant
 * map key). Each variant is itself a method schema (minus nested `variants`); the
 * discriminator mode is inferred from the primary key — `enum` present ⇒
 * value-mode, else sibling-mode — unless overridden with `variantBy`. In
 * sibling-mode the variant key names the trigger sibling and its `type` narrows
 * that sibling's value. A method-level `output` alongside `variants` is the
 * default/fallback output: it applies when no variant's discriminator matches
 * (e.g. FileNode's `file`: `output: "any"` for load mode, a `write` variant for
 * boolean) AND is inherited by any variant that omits its own `output` (handy
 * when variants vary only their siblings — e.g. cache-connect by driver, all
 * returning a string).
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
  /** Discriminated operations keyed by discriminator value. A sibling `output`
   *  acts as the fallback when no variant's discriminator matches.
   *
   *  Variants NEST: a variant may itself declare `variants`, composing
   *  discriminators with `allOf`. The top level is value-mode (handler-key
   *  `enum`) or sibling-mode; every NESTED level is sibling-mode (the variant key
   *  names a sibling tested for presence). A DOTTED key tests a NESTED clause's
   *  presence, so the discriminator can reach into a nested object without forcing
   *  the clause to the root. So e.g. a query `update` (value-mode on `query`) nests
   *  `{ "options.returning": { output: "array" } }` with its own `output: "number"`
   *  fallback — resolving to number, or array when `options.returning` is present,
   *  while `returning` stays where it belongs (inside `options`). (Nested
   *  value-mode — discriminating on a sibling's VALUE — is not inferred; it would
   *  need an explicit discriminator key, added only if needed.) */
  variants?: Record<string, JexsMethodSchema>;
  /** Override the inferred discriminator mode. Defaults: `enum` ⇒ "value", else "sibling". */
  variantBy?: "sibling" | "value";
}

/**
 * A Node class's `static schema` is the dependentSchemas map keyed by handler name.
 * The generator wraps this in { type: "object", dependentSchemas: ... } on emit.
 */
export type JexsNodeSchema = Record<string, JexsMethodSchema>;
