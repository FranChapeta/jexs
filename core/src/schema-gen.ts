/**
 * Schema generation utilities.
 *
 * Used by each package's build:schema step to produce its own dist/schema.json,
 * and by the create package to merge them into a single combined schema.
 *
 * Typical flow:
 *
 *   // In a package's build:schema script:
 *   import { buildPackageSchema } from "@jexs/core";
 *   import { coreNodes } from "@jexs/core";
 *   writeFileSync("dist/schema.json", JSON.stringify(buildPackageSchema(coreNodes()), null, 2));
 *
 *   // In create's build:schema script:
 *   import { mergePackageSchemas } from "@jexs/core";
 *   import coreSchema from "@jexs/core/dist/schema.json";
 *   // ...
 *   writeFileSync("create/dist/combined.schema.json",
 *     JSON.stringify(mergePackageSchemas([coreSchema, serverSchema, ...]), null, 2));
 *
 * Not imported by any runtime path — kept separate from Resolver/Node so the
 * client bundle doesn't pull it in.
 */

import type { Node } from "./nodes/Node.js";
import type {
  JexsMethodSchema, JexsNodeSchema, JexsPropertySchema, JexsType,
} from "./schema.js";

// ── Shared $defs and refs ──────────────────────────────────────────────────────

/**
 * Shared $defs.
 *
 * Typed-or-expr variants (`strOrExpr`, `numOrExpr`, …) take their `else` branch
 * to a per-output-type filtered exprFlat (e.g. `exprFlat_string`). That way a
 * slot declared `type: "string"` accepts either a literal string or a nested
 * expression whose method declares `output: "string"` or `"any"`. Methods with
 * no `output:` annotation are treated as "any" and appear in every variant.
 *
 * `anyVal` / `steps` keep referencing the unfiltered `exprFlat` since they don't
 * constrain output type.
 *
 * `mapVal` is deliberately NOT routed to `exprFlat`: a `map: true` slot's keys are
 * names the node keeps verbatim (variables, headers, columns, case labels), which
 * the runtime resolves per entry via `resolveObj` without ever dispatching the map
 * itself. Routing it to `exprFlat` would dispatch on those keys, so a column named
 * `email` or a variable named `fetch` would be validated as that op. Keys are
 * therefore opaque and only the VALUES are checked.
 */
export const sharedDefs = {
  anyVal: {
    if: { type: "object" },
    then: { $ref: "#/$defs/exprFlat" },
    else: {
      if: { type: "array" },
      then: { items: { if: { type: "object" }, then: { $ref: "#/$defs/exprFlat" }, else: {} } },
      else: {},
    },
  },
  mapVal: {
    type: "object",
    additionalProperties: { $ref: "#/$defs/anyVal" },
  },
  strOrExpr:   { if: { type: "string"  }, then: {}, else: { $ref: "#/$defs/exprFlat_string"  } },
  numOrExpr:   { if: { type: "number"  }, then: {}, else: { $ref: "#/$defs/exprFlat_number"  } },
  boolOrExpr:  { if: { type: "boolean" }, then: {}, else: { $ref: "#/$defs/exprFlat_boolean" } },
  nullOrExpr:  { if: { type: "null"    }, then: {}, else: { $ref: "#/$defs/exprFlat_null"    } },
  arrayOrExpr: { if: { type: "array"   }, then: {}, else: { $ref: "#/$defs/exprFlat_array"   } },
  // An array of expressions, or a single one. `runSteps` normalizes a lone
  // expression into a one-step sequence, so both shapes run identically and the
  // slot stays type-checked either way (an untyped slot would accept anything).
  steps: {
    if: { type: "array" },
    then: { items: { $ref: "#/$defs/exprFlat" } },
    else: { $ref: "#/$defs/exprFlat" },
  },
} as const;

const REF = {
  anyVal:      { $ref: "#/$defs/anyVal"      },
  mapVal:      { $ref: "#/$defs/mapVal"      },
  strOrExpr:   { $ref: "#/$defs/strOrExpr"   },
  numOrExpr:   { $ref: "#/$defs/numOrExpr"   },
  boolOrExpr:  { $ref: "#/$defs/boolOrExpr"  },
  nullOrExpr:  { $ref: "#/$defs/nullOrExpr"  },
  arrayOrExpr: { $ref: "#/$defs/arrayOrExpr" },
  steps:       { $ref: "#/$defs/steps"       },
  exprFlat:    { $ref: "#/$defs/exprFlat"    },
} as const;

/** Output-filtered variants — used by enum and typed-array else branches in
 *  expandProperty. Keyed by the types that HAVE a filtered exprFlat (see
 *  OUTPUT_TYPES); `object` has none (object slots route to `{ type: "object" }`),
 *  so it's intentionally absent. */
const FILTERED_REF: Record<Exclude<JexsType, "object">, EmittedSchema> = {
  string:  { $ref: "#/$defs/exprFlat_string"  },
  number:  { $ref: "#/$defs/exprFlat_number"  },
  boolean: { $ref: "#/$defs/exprFlat_boolean" },
  array:   { $ref: "#/$defs/exprFlat_array"   },
  null:    { $ref: "#/$defs/exprFlat_null"    },
};

// ── Property expansion ─────────────────────────────────────────────────────────

export type EmittedSchema = Record<string, unknown>;

const METADATA_KEYS = ["description", "markdownDescription", "examples", "default"] as const;

function liftMetadata(prop: JexsPropertySchema, target: EmittedSchema): void {
  for (const k of METADATA_KEYS) {
    if (prop[k] !== undefined) target[k] = prop[k];
  }
}

function typeOrExprRef(t: JexsType): EmittedSchema {
  switch (t) {
    case "string":  return { ...REF.strOrExpr   };
    case "number":  return { ...REF.numOrExpr   };
    case "boolean": return { ...REF.boolOrExpr  };
    case "null":    return { ...REF.nullOrExpr  };
    case "array":   return { ...REF.arrayOrExpr };
    case "object":  return { type: "object" };
  }
}

/**
 * Transforms an author-facing JexsPropertySchema into an emitted JSON Schema
 * fragment. Markers like `tuple`, `map`, `steps`, `literal` are resolved away.
 */
export function expandProperty(prop: JexsPropertySchema): EmittedSchema {
  if (prop.default !== undefined && prop.enum && !prop.enum.includes(prop.default)) {
    throw new Error(`default ${JSON.stringify(prop.default)} is not one of the enum values ${JSON.stringify(prop.enum)}.`);
  }

  // Direct $ref: emit the ref with metadata. $ref siblings are evaluated in
  // JSON Schema 2020-12, so markdownDescription stays accessible for hover.
  if (prop.$ref) {
    const out: EmittedSchema = { $ref: prop.$ref };
    liftMetadata(prop, out);
    return out;
  }

  // Nested object with a declared inner shape (e.g. a query's `options`). One
  // level of `properties` + `additionalProperties` (default false to catch
  // typos). Values recurse via expandProperty; `additionalProperties: false`
  // carries no recursive catch-all, so this is safe for the depth budget.
  if (prop.properties) {
    const props: Record<string, EmittedSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(prop.properties)) {
      props[k] = expandNested(v, `nested property "${k}"`);
      if (v.required) required.push(k);
    }
    const out: EmittedSchema = {
      type: "object",
      properties: props,
      additionalProperties: prop.additionalProperties ?? false,
    };
    if (required.length > 0) out.required = required;
    liftMetadata(prop, out);
    return out;
  }

  if (prop.tuple !== undefined) {
    const [min, max] = typeof prop.tuple === "number"
      ? [prop.tuple, prop.tuple]
      : [prop.tuple[0], prop.tuple[1]];
    const out: EmittedSchema = {
      type: "array",
      minItems: min,
      maxItems: max,
    };
    // `prefixItems` types each slot by index (draft 2020-12). Slots past the
    // list — a variadic tail, when `max` exceeds its length — fall back to anyVal;
    // without a prefix, every slot is anyVal (any literal OR expression).
    if (prop.prefixItems) {
      out.prefixItems = prop.prefixItems.map((p, i) => expandNested(p, `tuple slot ${i}`));
      if (max > prop.prefixItems.length) out.items = { ...REF.anyVal };
    } else {
      out.items = { ...REF.anyVal };
    }
    liftMetadata(prop, out);
    return out;
  }

  if (prop.map) {
    // `map` fixes the KEY semantics (opaque); `type` says only which CONTAINER
    // shapes are accepted. No type-or-expr wrapping and no output narrowing here:
    // an opaque-key map has no expression alternative to narrow. `array` present
    // means a list of maps (query `data`'s rows), and the one-or-many shape is
    // emitted inline rather than as its own $defs entry, since dedupeShapes hoists
    // any shape that gains a second use.
    const types = prop.type === undefined
      ? []
      : Array.isArray(prop.type) ? prop.type : [prop.type];
    const acceptsArray = types.includes("array");
    const acceptsObject = types.length === 0 || types.includes("object");

    let out: EmittedSchema;
    if (!acceptsArray) {
      out = { ...REF.mapVal };                              // a map
    } else if (!acceptsObject) {
      out = { type: "array", items: { ...REF.mapVal } };    // a list of maps
    } else {
      out = {                                               // either (query `data`)
        if: { type: "array" },
        then: { items: { ...REF.mapVal } },
        else: { ...REF.mapVal },
      };
    }
    liftMetadata(prop, out);
    return out;
  }

  if (prop.steps === true) {
    const out: EmittedSchema = { ...REF.steps };
    liftMetadata(prop, out);
    return out;
  }

  // Multi-type (e.g. ["string", "boolean"]): accept any of those literal types
  // OR a nested expression. If `enum` is set, it constrains only the string type.
  if (Array.isArray(prop.type)) {
    const types = [...prop.type];
    if (prop.literal) {
      const out: EmittedSchema = { type: types };
      if (prop.enum) out.enum = [...prop.enum];
      liftMetadata(prop, out);
      return out;
    }
    // type-or-expr: literal type accepted; else fall back to unfiltered exprFlat
    // (a multi-type slot's output-type filter is ambiguous, so no narrowing).
    const acceptsString = types.includes("string");
    const literalBranch: EmittedSchema = prop.enum && acceptsString
      ? { if: { type: "string" }, then: { enum: [...prop.enum] }, else: {} }
      : {};
    const out: EmittedSchema = {
      if: { type: types },
      then: literalBranch,
      else: { ...REF.exprFlat },
    };
    liftMetadata(prop, out);
    return out;
  }

  if (prop.enum && prop.type === "string") {
    if (prop.literal) {
      const out: EmittedSchema = { type: "string", enum: [...prop.enum] };
      liftMetadata(prop, out);
      return out;
    }
    const out: EmittedSchema = {
      if: { type: "string" },
      then: { enum: [...prop.enum] },
      else: { ...FILTERED_REF.string },
    };
    liftMetadata(prop, out);
    return out;
  }

  if (prop.literal && prop.type) {
    const out: EmittedSchema = { type: prop.type };
    if (prop.enum) out.enum = [...prop.enum];
    if (prop.items && prop.type === "array") out.items = expandNested(prop.items, "items");
    liftMetadata(prop, out);
    return out;
  }

  if (prop.type === "array" && prop.items) {
    const out: EmittedSchema = {
      if: { type: "array" },
      then: { items: expandNested(prop.items, "items") },
      else: { ...FILTERED_REF.array },
    };
    liftMetadata(prop, out);
    return out;
  }

  if (prop.type && typeof prop.type === "string") {
    const out: EmittedSchema = typeOrExprRef(prop.type);
    liftMetadata(prop, out);
    return out;
  }

  const out: EmittedSchema = { ...REF.anyVal };
  liftMetadata(prop, out);
  return out;
}

/** A value inside a property (a nested key, an array item, a tuple slot). Variants
 *  select through a step's own keys, so one declared down here could never be
 *  selected and is rejected rather than silently ignored. */
function expandNested(prop: JexsPropertySchema, where: string): EmittedSchema {
  if (prop.variants) {
    throw new Error(`variants are valid on a method's primary key, its siblings and its variants, not on a ${where}.`);
  }
  return expandProperty(prop);
}

// ── Package schema build ───────────────────────────────────────────────────────

/**
 * The compiled schema for a single package — the artifact each package emits
 * to its dist/schema.json. Multiple packages' PackageSchemas can be merged into
 * a CombinedSchema via mergePackageSchemas().
 */
export interface PackageSchema {
  $schema: string;
  packageName?: string;
  byKey: Record<string, EmittedMethodSchema>;
  byNode: Record<string, EmittedNodeSchema>;
  /** Raw $defs entries contributed by individual Nodes. Names starting with `_`
   *  are internal helpers; non-underscored names are added to the combined
   *  schema's top-level `anyOf` as root-matchable branches. */
  extraDefs?: Record<string, EmittedSchema>;
  /** sibling name → host method keys that declare it. The merge step uses this to
   *  gate dispatch for siblings that share a handler-key name (e.g. `session`). */
  siblingHosts?: Record<string, string[]>;
  /** method key → owning Node class. `byNode` reversed, so naming an op's class
   *  is a lookup rather than a scan of every class's key list. */
  keyNode?: Record<string, string>;
  /** method key → its siblings with prose, flattened from the authored schema
   *  (own + per-variant + the Node's `commonSiblings`). Documentation only: the
   *  validating form of the same information is `properties`/`allOf`/`$ref`. */
  siblingDocs?: Record<string, SiblingDoc[]>;
}

export interface EmittedMethodSchema {
  properties: Record<string, EmittedSchema>;
  output?: string;
  outputDescription?: string;
  /** Build-only: the output as ordered rules, the first whose condition holds
   *  deciding, used by the filtered-variant loop for output narrowing. Absent when
   *  `output` alone decides. Stripped on emit. */
  variantOutputs?: VariantOutput[];
  /** Build-only: the operations selected by the primary key's VALUE, for the
   *  hover "Operations" list. Operations selected by a sibling's presence are
   *  documented on that sibling in `siblingDocs` instead. Stripped. */
  variantDocs?: ValueDoc[];
  /** Conditional sibling constraints for variants methods. Emitted (real schema). */
  allOf?: EmittedSchema[];
  /** Siblings the handler refuses to run without. Emitted (real schema): the entry
   *  is applied to the whole step via `dependentSchemas`, so this reports a missing
   *  property on the step itself. Variant-specific ones live in `allOf` instead. */
  required?: string[];
  /** Shared `commonSiblings` block, attached on merge (2020-12 evaluates $ref siblings). */
  $ref?: string;
  /** Per-handler catch-all for undeclared siblings, attached on merge. */
  additionalProperties?: EmittedSchema;
}

/** One output rule: while `cond` holds (and no earlier rule's does), the method
 *  resolves to `output`, or to one of them when it is a list (absent means any).
 *  `when` is `cond` before emitting, kept so rules that can never hold together
 *  are recognised. Build-only. */
export interface VariantOutput {
  cond: EmittedSchema;
  when: WhenTest[];
  output?: string | string[];
}

/** An operation selected by a property's value, for documentation. */
export interface ValueDoc {
  value: unknown;
  output?: string;
  outputDescription?: string;
  description?: string;
}

/**
 * Compressed representation: the list of handler-key method names a Node class
 * owns. Consumers wanting a full dispatch JSON Schema can build it from byKey:
 *
 *   const nodeSchema = {
 *     type: "object",
 *     dependentSchemas: Object.fromEntries(
 *       byNode[name].map(k => [k, { $ref: `#/byKey/${k}` }])
 *     ),
 *   };
 */
export type EmittedNodeSchema = string[];

// ── Method normalization ───────────────────────────────────────────────────────

/** One discriminator test on the way to a variant: a VALUE test when `value` is
 *  present (the key holds exactly that value), otherwise a PRESENCE test. A
 *  dotted key reaches into a nested object (`options.returning`). */
export interface WhenTest {
  key: string;
  value?: unknown;
  /** `value` is the property's `default`, so the test also holds when the key is absent. */
  default?: true;
}

/**
 * One node of a method's authored tree, with every discriminator rule already
 * applied: the method itself (the root), one of its variants, or a variant of one
 * of its siblings. The emitted schema, the sibling-host index and the sibling docs
 * are all folds over this tree, so the rules for which property a variant tests
 * and what it registers live in `normalizeMethod` alone.
 */
interface Scope {
  /** The variant key; the method key at the root. */
  name: string;
  schema: JexsMethodSchema;
  /** The tests that select this scope, outermost first. Empty at the root. */
  when: WhenTest[];
  /** Every test in `when`, emitted and composed. Null at the root, which is always selected. */
  cond: EmittedSchema | null;
  /** A sibling-mode variant IS a sibling carrying the operation's input, so it is
   *  registered as a property and documented as one. */
  trigger: boolean;
  /** Variants selected through this scope's own property. */
  variants: VariantGroup;
  /** Variants selected through this scope's siblings, by sibling, in declaration order. */
  siblingVariants: Map<string, VariantGroup>;
}

/** The variants selected through one property. */
interface VariantGroup {
  /** The property the variants are declared on, and the key it is written as
   *  (null for presence-selected variants under a value, which test no property). */
  owner: JexsPropertySchema;
  subject: string | null;
  /** Where the variants hang: the scope that declares them. */
  parent: Parent;
  scopes: Scope[];
  /** Set when the variants cover every value of the property's `enum` and each
   *  declares its own `output`: the property must hold one of those values, so a
   *  step that names it through an expression still resolves to one of their
   *  outputs rather than to the enclosing fallback. Where that holds, i.e. where
   *  the property is present. */
  covering: Parent | null;
}

/** A scope's direct children: its own variants, then its siblings'. */
function childrenOf(scope: Scope): Scope[] {
  return [scope.variants, ...scope.siblingVariants.values()].flatMap(g => g.scopes);
}

/**
 * The one place the discriminator mode is decided: `enum` means the variant keys
 * are values, otherwise they name siblings tested for presence.
 */
function variantMode(spec: { variantBy?: JexsPropertySchema["variantBy"]; enum?: readonly unknown[] }): "sibling" | "value" {
  return spec.variantBy ?? (spec.enum ? "value" : "sibling");
}

function normalizeMethod(methodKey: string, method: JexsMethodSchema): Scope {
  return scopeOf(methodKey, method, methodKey, [], null, false, methodKey);
}

/** `subject` is the property this scope's own variants test, or null when the
 *  scope is a value (which has no property of its own to test). */
function scopeOf(
  name: string,
  schema: JexsMethodSchema,
  subject: string | null,
  when: WhenTest[],
  cond: EmittedSchema | null,
  trigger: boolean,
  methodKey: string,
): Scope {
  const scope: Scope = {
    name, schema, when, cond, trigger,
    variants: { owner: schema, subject, parent: { name, when, cond }, scopes: [], covering: null },
    siblingVariants: new Map(),
  };
  // This scope's own property is present wherever the scope is selected: the
  // primary key always, a trigger by its own test.
  if (schema.variants) scope.variants = childScopes(schema, subject, scope, scope, methodKey);
  for (const [sibling, prop] of Object.entries(schema.siblings ?? {})) {
    if (!prop.variants) continue;
    // A value test already requires the sibling; presence-selected variants of
    // a sibling apply only alongside it, so that presence joins their condition.
    const present = within(scope, { key: sibling });
    const parent = variantMode(prop) === "value" ? scope : present;
    scope.siblingVariants.set(sibling, childScopes(prop, sibling, parent, present, methodKey));
  }
  return scope;
}

/** Where child scopes hang: the parent's name (for errors) and its condition. */
type Parent = Pick<Scope, "name" | "when" | "cond">;

function within(parent: Parent, test: WhenTest): Parent {
  const local = testCond(test);
  return { name: parent.name, when: [...parent.when, test], cond: parent.cond ? { allOf: [parent.cond, local] } : local };
}

/** `present` is where `subject` is known to be present, for the covering rule. */
function childScopes(
  owner: JexsPropertySchema,
  subject: string | null,
  parent: Parent,
  present: Parent,
  methodKey: string,
): VariantGroup {
  const mode = variantMode(owner);
  if (mode === "value" && subject === null) {
    throw new Error(
      `"${methodKey}": the variants under "${parent.name}" select by value, but "${parent.name}" is itself a value, not a property. Only presence-selected variants can nest there.`,
    );
  }
  const variants = Object.entries(owner.variants ?? {});
  const keys = new Set(variants.map(([key]) => key));
  const covers = mode === "value"
    && owner.enum !== undefined
    && owner.enum.every(e => keys.has(String(e)))
    && variants.every(([, v]) => v.output !== undefined);
  const scopes = variants.map(([key, variant]) => {
    let test: WhenTest = { key };
    if (mode === "value") {
      const value = variantValue(owner, key, subject!, methodKey);
      test = owner.default !== undefined && owner.default === value
        ? { key: subject!, value, default: true }
        : { key: subject!, value };
    }
    const { when, cond } = within(parent, test);
    // A trigger is a real sibling, so the variants nested under it test IT; a
    // dotted key names a clause inside a nested object, whose own schema
    // declares it, so it is tested but never registered at the root.
    const trigger = mode === "sibling" && !key.includes(".");
    return scopeOf(key, variant, mode === "sibling" ? key : null, when, cond, trigger, methodKey);
  });
  return { owner, subject, parent, scopes, covering: covers ? present : null };
}

/** The value a value-mode variant key stands for: the `enum` entry it spells, so
 *  a boolean or number enum matches its real value, or, with no `enum`, the key
 *  converted by the property's `type`. */
function variantValue(owner: JexsPropertySchema, key: string, subject: string, methodKey: string): unknown {
  if (owner.enum) {
    const hit = owner.enum.find(e => String(e) === key);
    if (hit === undefined) {
      throw new Error(`"${methodKey}": variant "${key}" of "${subject}" is not one of its enum values.`);
    }
    return hit;
  }
  if (owner.type === "boolean" && (key === "true" || key === "false")) return key === "true";
  if (owner.type === "number" && key.trim() !== "" && Number.isFinite(Number(key))) return Number(key);
  return key;
}

/**
 * A test, emitted. `{ required: ["write"] }` for presence and
 * `{ properties: { type: { const: "light" } }, required: ["type"] }` for a value;
 * a DOTTED key nests it, so `options.returning` becomes
 * `{ properties: { options: { required: ["returning"] } } }` and a clause can
 * select a variant from inside a nested object without being forced to the root.
 */
function testCond(test: WhenTest): EmittedSchema {
  const parts = test.key.split(".");
  const last = parts[parts.length - 1];
  // `properties` holds when the key is absent, so a default value's test simply
  // leaves out `required`.
  let cond: EmittedSchema = !("value" in test) ? { required: [last] }
    : test.default ? { properties: { [last]: { const: test.value } } }
    : { properties: { [last]: { const: test.value } }, required: [last] };
  for (let i = parts.length - 2; i >= 0; i--) cond = { properties: { [parts[i]]: cond } };
  return cond;
}

/** Every scope under `scope` (not `scope` itself), parents before children. */
function descendants(scope: Scope): Scope[] {
  const out: Scope[] = [];
  for (const child of childrenOf(scope)) out.push(child, ...descendants(child));
  return out;
}

// ── Method emission ────────────────────────────────────────────────────────────

/**
 * The validating form of a method. Root siblings go straight into `properties`;
 * a variant's siblings are enforced only under its condition, through `allOf`,
 * with a permissive stub left in `properties` so that one name can carry a
 * different shape in each operation (per-op `options`) without either clobbering
 * the other. The stub never overwrites an existing entry: a root sibling (e.g.
 * ElementNode's `content`, which routes children to exprFlat) or an earlier
 * variant's stub must survive, with this variant's shape layered on top.
 */
function emitMethod(methodKey: string, root: Scope, common: ReadonlySet<string>): EmittedMethodSchema {
  const properties: Record<string, EmittedSchema> = { [methodKey]: expandProperty(root.schema) };
  const required: string[] = [];
  const allOf: EmittedSchema[] = [];

  for (const scope of [root, ...descendants(root)]) {
    if (scope.trigger) properties[scope.name] = expandProperty(scope.schema);
    const gated: Record<string, EmittedSchema> = {};
    const gatedRequired: string[] = [];
    for (const [k, v] of Object.entries(scope.schema.siblings ?? {})) {
      if (!scope.cond) {
        properties[k] = expandProperty(v);
        if (v.required) required.push(k);
        continue;
      }
      if (!(k in properties)) properties[k] = {};
      gated[k] = expandProperty(v);
      if (v.required) gatedRequired.push(k);
    }
    if (scope.cond && Object.keys(gated).length > 0) {
      // `required` rides the SAME gate as the shapes: a sibling a variant cannot
      // run without is only missing while that variant is selected.
      const then: EmittedSchema = { properties: gated };
      if (gatedRequired.length > 0) then.required = gatedRequired;
      allOf.push({ if: scope.cond, then });
    }
  }
  allOf.push(...exclusions(root, new Set([methodKey, ...common])));

  const entry: EmittedMethodSchema = { properties };
  const { output, outputDescription } = root.schema;
  if (output !== undefined) entry.output = output;
  if (outputDescription !== undefined) entry.outputDescription = outputDescription;
  const rules = outputRules(root);
  // Nothing after an unconditional rule can decide (a covering primary key's
  // rule shadows the root's own fallback).
  const always = rules.findIndex(r => Object.keys(r.cond).length === 0);
  rules.length = always + 1;
  // A single rule is the root's own `output`, which `output` already says.
  if (rules.length > 1 || rules[0].output !== output) entry.variantOutputs = rules;
  const values = valueDocs(root.variants.scopes, output);
  if (values) entry.variantDocs = values;
  if (allOf.length > 0) entry.allOf = allOf;
  if (required.length > 0) entry.required = required;
  return entry;
}

/**
 * Refusals for exclusive variant siblings (see JexsPropertySchema.exclusive). For
 * each value-selected group, a sibling declared nowhere but inside its variants
 * (anywhere in their subtrees, triggers included) is refused wherever the group
 * applies and its property holds a literal value, or is absent with a `default`,
 * whose variant does not declare it. `open` names siblings that are never
 * refused: the method key and the Node's `commonSiblings`.
 */
function exclusions(root: Scope, open: ReadonlySet<string>): EmittedSchema[] {
  const all = [root, ...descendants(root)];
  const declaring = new Map<string, Scope[]>();
  for (const s of all) {
    for (const name of [...(s.trigger ? [s.name] : []), ...Object.keys(s.schema.siblings ?? {})]) {
      if (!open.has(name)) declaring.set(name, [...(declaring.get(name) ?? []), s]);
    }
  }

  const out: EmittedSchema[] = [];
  for (const group of all.flatMap(s => [s.variants, ...s.siblingVariants.values()])) {
    const subject = group.subject;
    if (subject === null || group.scopes.length === 0 || group.owner.exclusive === false
      || variantMode(group.owner) !== "value") continue;
    // Each scope inside the group, mapped to the value that selects it.
    const valueOf = new Map<Scope, unknown>();
    for (const v of group.scopes) {
      for (const s of [v, ...descendants(v)]) valueOf.set(s, v.when[v.when.length - 1].value);
    }
    // Names confined to the group, bucketed by the values that allow them.
    const buckets = new Map<string, { allowed: unknown[]; names: string[] }>();
    for (const [name, scopes] of declaring) {
      if (!scopes.every(s => valueOf.has(s))) continue;
      const allowed = [...new Set(scopes.map(s => valueOf.get(s)))];
      const key = JSON.stringify(allowed);
      if (!buckets.has(key)) buckets.set(key, { allowed, names: [] });
      buckets.get(key)!.names.push(name);
    }
    for (const { allowed, names } of buckets.values()) {
      const refused = refusedUnless(subject, allowed, group.owner.default);
      out.push({
        if: group.parent.cond ? { allOf: [group.parent.cond, refused] } : refused,
        then: { properties: Object.fromEntries(names.map(n => [n, false])) },
      });
    }
  }
  return out;
}

/** `key` holds a literal outside `allowed`, or is absent while its default is. An
 *  expression (an object) is never refused: it could resolve to any value. */
function refusedUnless(key: string, allowed: unknown[], fallback: unknown): EmittedSchema {
  const parts = key.split(".");
  const last = parts[parts.length - 1];
  const outside: EmittedSchema = { not: { anyOf: [{ type: "object" }, { enum: allowed }] } };
  let cond: EmittedSchema = fallback !== undefined && !allowed.includes(fallback)
    ? { properties: { [last]: outside } }
    : { properties: { [last]: outside }, required: [last] };
  for (let i = parts.length - 2; i >= 0; i--) cond = { properties: { [parts[i]]: cond } };
  return cond;
}

/**
 * The method's output as ordered rules, the first whose condition holds deciding
 * (the precedence JexsMethodSchema documents): a scope's own variants, then its
 * siblings' variants, then its own `output` when it declares one. A scope with no
 * `output` of its own adds no closing rule, so when none of its descendants
 * match, the enclosing scope's later rules decide; that is how it inherits both
 * the enclosing output and the enclosing siblings' refinements. The root always
 * closes the list, so every step matches some rule.
 *
 * A covering group (see VariantGroup) closes itself too: when its property is
 * present but no value rule matched, the value came from an expression and is
 * still one of the covered ones, so the step resolves to one of their outputs.
 */
function outputRules(scope: Scope): VariantOutput[] {
  const rules: VariantOutput[] = [];
  for (const group of [scope.variants, ...scope.siblingVariants.values()]) {
    const inner = group.scopes.flatMap(outputRules);
    rules.push(...inner);
    if (group.covering) {
      rules.push({ cond: group.covering.cond ?? {}, when: group.covering.when, output: anyOf(inner.map(r => r.output)) });
    }
  }
  if (scope.cond === null || scope.schema.output !== undefined) {
    rules.push({ cond: scope.cond ?? {}, when: scope.when, output: scope.schema.output });
  }
  return rules;
}

/** The outputs a step may have when it has one of `outputs`: a single type, a
 *  list of several, or undefined (any) once any of them is unknown. */
function anyOf(outputs: VariantOutput["output"][]): VariantOutput["output"] {
  const all = new Set<string>();
  for (const o of outputs) {
    if (o === undefined || o === "any") return undefined;
    for (const t of Array.isArray(o) ? o : [o]) all.add(t);
  }
  return all.size === 1 ? [...all][0] : [...all];
}

/** Two rules that test one key against different values can never both hold. */
function disjoint(a: WhenTest[], b: WhenTest[]): boolean {
  return a.some(x => "value" in x && b.some(y => "value" in y && y.key === x.key && y.value !== x.value));
}

/** Every sibling name a method can carry: each scope's siblings, and each trigger,
 *  which is a sibling too. Used to map sibling names to the ops that host them. */
function siblingNames(root: Scope): string[] {
  return [root, ...descendants(root)].flatMap(s => [
    ...(s.trigger ? [s.name] : []),
    ...Object.keys(s.schema.siblings ?? {}),
  ]);
}

/** The value-selected operations among `scopes`, or undefined when they are
 *  selected by presence (and so documented as the siblings they are). A scope
 *  that declares no output shows `inherited`, when given. */
function valueDocs(scopes: Scope[], inherited?: string): ValueDoc[] | undefined {
  if (scopes.length === 0 || scopes[0].trigger || !("value" in scopes[0].when[scopes[0].when.length - 1])) return undefined;
  return scopes.map(s => {
    const output = s.schema.output ?? inherited;
    const description = s.schema.markdownDescription ?? s.schema.description;
    return {
      value: s.when[s.when.length - 1].value,
      ...(output !== undefined ? { output } : {}),
      ...(s.schema.outputDescription !== undefined ? { outputDescription: s.schema.outputDescription } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  });
}

/** One sibling key of a method, flattened for documentation consumers. */
export interface SiblingDoc {
  name: string;
  description?: string;
  /** The step is invalid without it. */
  required?: boolean;
  /** What must hold for this sibling to apply, outermost first; absent when it
   *  always applies. `[{ key: "database", value: "connect" }, { key: "host" }]`
   *  reads `database: "connect"` + `host`. */
  when?: WhenTest[];
  /** Set on a sibling whose PRESENCE selects an operation: what it resolves to. */
  output?: string;
  outputDescription?: string;
  /** Set on a sibling whose VALUE selects operations: one entry per value. */
  values?: ValueDoc[];
}

/**
 * A method's siblings with the prose the author wrote: this sibling, this
 * description, required or not, when it applies, and what it selects. The EMITTED
 * schema carries all of that too, but scattered by the lowering that makes it
 * valid JSON Schema (shared siblings behind a `$ref`, variant siblings inside
 * `allOf` branches, a description-less stub left in `properties`), so reading it
 * back out would be a lossy round trip.
 */
function siblingDocsOf(
  methodKey: string,
  root: Scope,
  commonSiblings: Record<string, JexsPropertySchema> | undefined,
): SiblingDoc[] {
  // Keyed by condition + name: one name routinely means different things in
  // different operations (SchemaNode's `table` is an inline document under
  // `register` and a table NAME under `get`), so they are separate entries.
  const out = new Map<string, SiblingDoc>();

  const add = (name: string, prop: JexsPropertySchema, when: WhenTest[], extra: Partial<SiblingDoc> = {}): void => {
    if (name === methodKey) return;
    const key = JSON.stringify([when, name]);
    if (out.has(key)) return;
    const description = prop.markdownDescription ?? prop.description;
    out.set(key, {
      name,
      ...(description ? { description } : {}),
      ...(prop.required ? { required: true } : {}),
      ...(when.length > 0 ? { when } : {}),
      ...extra,
    });
  };

  const walk = (scope: Scope): void => {
    for (const [name, prop] of Object.entries(scope.schema.siblings ?? {})) {
      const values = valueDocs(scope.siblingVariants.get(name)?.scopes ?? []);
      add(name, prop, scope.when, values ? { values } : {});
    }
    for (const v of childrenOf(scope)) {
      // A trigger is the sibling that selects its operation, so the operation is
      // documented here, on it, once: `{ "file": "x.json", "write": … }`. It
      // applies wherever its own test (the last) is evaluated.
      if (v.trigger) {
        const values = valueDocs(v.variants.scopes);
        add(v.name, v.schema, v.when.slice(0, -1), {
          ...(v.schema.output !== undefined ? { output: v.schema.output } : {}),
          ...(v.schema.outputDescription !== undefined ? { outputDescription: v.schema.outputDescription } : {}),
          ...(values ? { values } : {}),
        });
      }
    }
    for (const child of childrenOf(scope)) walk(child);
  };
  walk(root);

  // Last: they apply to every method on the node, so a method's own declaration
  // of the same name is the more specific one and wins.
  for (const [name, prop] of Object.entries(commonSiblings ?? {})) add(name, prop, []);

  return [...out.values()];
}

/**
 * Options shared by {@link buildPackageSchema} and {@link mergePackageSchemas}
 * for handling duplicate handler keys / node classes / `$defs` names.
 */
export interface SchemaBuildOptions {
  /**
   * `"throw"` (default) aborts on the first batch of collisions — correct for the
   * curated in-repo build. `"skip"` keeps the first occurrence and reports the
   * rest via {@link SchemaBuildOptions.onWarn}, mirroring the resolver's
   * first-registration-wins semantics so a third-party package that redeclares an
   * existing key degrades gracefully instead of breaking the whole schema.
   */
  onCollision?: "throw" | "skip";
  /** Sink for collision messages when `onCollision` is `"skip"`. Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
}

function reportCollisions(collisions: string[], opts: SchemaBuildOptions, context: string): void {
  if (collisions.length === 0) return;
  if (opts.onCollision === "skip") {
    const warn = opts.onWarn ?? ((m: string) => console.warn(m));
    for (const c of collisions) warn(`${context}: ${c}`);
    return;
  }
  throw new Error(`${context}: found ${collisions.length} collision(s):\n  ${collisions.join("\n  ")}`);
}

/**
 * Builds a PackageSchema from a list of Node classes or instances. Each Node's
 * `static schema` is collected; collisions across nodes throw (or, with
 * `onCollision: "skip"`, keep the first and warn).
 *
 * Accepts either Node classes (the typeof Node value) or Node instances. The
 * resolver builds with instances, so callers can pass `coreNodes()` directly.
 */
export function buildPackageSchema(
  nodes: ReadonlyArray<Node | (typeof Node)>,
  packageName?: string,
  opts: SchemaBuildOptions = {},
): PackageSchema {
  // byKey is the canonical store; byNode is a compact index of method names per
  // Node class. Consumers wanting a full per-Node dispatch schema construct it
  // on the fly via `{ type: "object", dependentSchemas: byNode[name].map(...) }`.
  const byKey: Record<string, EmittedMethodSchema> = {};
  const byNode: Record<string, EmittedNodeSchema> = {};
  const keyNode: Record<string, string> = {};
  const collisions: string[] = [];
  const extraDefs: Record<string, EmittedSchema> = {};
  /** Per-Node $defs ref to a shared siblings block (built from `commonSiblings`). */
  const nodeSiblingsRef: Record<string, string> = {};
  /** sibling name → the method keys (host ops) that declare it. Lets the merge
   *  step gate dispatch so a sibling sharing a handler-key name (e.g. `session`)
   *  is validated as that op's sibling, not as its own op. */
  const siblingHosts: Record<string, Set<string>> = {};
  const addSiblingHost = (sibling: string, host: string) => {
    (siblingHosts[sibling] ??= new Set()).add(host);
  };
  /** method key → its siblings with prose, for documentation consumers. */
  const siblingDocs: Record<string, SiblingDoc[]> = {};

  for (const n of nodes) {
    // Resolve to the class (constructor) — works for both instances and classes.
    const cls = (typeof n === "function" ? n : n.constructor) as typeof Node;
    const schema = cls.schema;
    if (!schema) continue;
    const nodeClass = cls.name;

    // If the Node declares commonSiblings, auto-create a `_<NodeName>Siblings`
    // $defs entry from it. byKey emission below picks it up via nodeSiblingsRef.
    const nodeCommonSiblings = cls.commonSiblings;
    const methodKeys = Object.keys(schema);
    if (nodeCommonSiblings && Object.keys(nodeCommonSiblings).length > 0) {
      const siblingsDefName = `_${nodeClass}Siblings`;
      const expandedProps: Record<string, EmittedSchema> = {};
      for (const [k, v] of Object.entries(nodeCommonSiblings)) {
        // A shared block has no method whose output or `allOf` it could gate.
        if (v.variants) {
          throw new Error(`${nodeClass}: commonSiblings "${k}" declares variants; declare it on each method's siblings instead.`);
        }
        expandedProps[k] = expandProperty(v);
      }
      extraDefs[siblingsDefName] = { properties: expandedProps };
      nodeSiblingsRef[nodeClass] = `#/$defs/${siblingsDefName}`;
      // commonSiblings apply to every method on the node, so all are hosts.
      for (const sib of Object.keys(nodeCommonSiblings)) {
        for (const mk of methodKeys) addSiblingHost(sib, mk);
      }
    }

    for (const [methodKey, method] of Object.entries(schema)) {
      const prior = keyNode[methodKey];
      if (prior && prior !== nodeClass) {
        collisions.push(
          `Handler key "${methodKey}" is declared by both ${prior} and ${nodeClass}.`,
        );
        continue;
      }
      const root = normalizeMethod(methodKey, method);
      const entry = emitMethod(methodKey, root, new Set(Object.keys(nodeCommonSiblings ?? {})));
      // 2020-12 evaluates $ref siblings, so the local `properties` (primary key)
      // applies in addition to the shared siblings block from the ref'd schema.
      const ref = nodeSiblingsRef[nodeClass];
      if (ref) entry.$ref = ref;
      byKey[methodKey] = entry;
      keyNode[methodKey] = nodeClass;
      (byNode[nodeClass] ??= []).push(methodKey);
      const docs = siblingDocsOf(methodKey, root, nodeCommonSiblings);
      if (docs.length > 0) siblingDocs[methodKey] = docs;
      for (const sib of siblingNames(root)) addSiblingHost(sib, methodKey);
    }

    // Per-Node $defs contributions (e.g. RouterNode's _routeNode tree shape).
    const nodeDefs = cls.schemaDefs;
    if (nodeDefs) {
      for (const [defName, defSchema] of Object.entries(nodeDefs)) {
        if (defName in extraDefs) {
          collisions.push(`$defs name "${defName}" contributed by multiple Nodes.`);
          continue;
        }
        extraDefs[defName] = defSchema;
      }
    }
  }

  reportCollisions(collisions, opts, `buildPackageSchema(${packageName ?? "?"})`);

  const out: PackageSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    byKey,
    byNode,
  };
  if (packageName) out.packageName = packageName;
  if (Object.keys(extraDefs).length > 0) out.extraDefs = extraDefs;
  if (Object.keys(siblingHosts).length > 0) {
    out.siblingHosts = Object.fromEntries(
      Object.entries(siblingHosts).map(([sib, hosts]) => [sib, [...hosts]]),
    );
  }
  if (Object.keys(keyNode).length > 0) out.keyNode = keyNode;
  if (Object.keys(siblingDocs).length > 0) out.siblingDocs = siblingDocs;
  return out;
}

// ── Rich markdown composer (for hover descriptions on primary keys) ───────────

interface MaybeMeta {
  description?: string;
  markdownDescription?: string;
  examples?: unknown[];
}

function pickDesc(p: MaybeMeta | undefined): string {
  return p?.markdownDescription ?? p?.description ?? "";
}

/** Spells out a `when` path: `` `database: "connect"` + `host` ``. */
function formatWhen(when: WhenTest[]): string {
  return when.map(t => "value" in t ? `\`${t.key}: ${JSON.stringify(t.value)}\`` : `\`${t.key}\``).join(" + ");
}

/** One operation line: `` - `connect` → object: Opens… ``. */
function formatValue(v: ValueDoc, indent = ""): string {
  const out = v.output ? ` → ${v.output}` : "";
  const text = v.description ?? v.outputDescription;
  return `${indent}- \`${String(v.value)}\`${out}${text ? `: ${text}` : ""}`;
}

/**
 * Composes the rich markdownDescription for a primary handler key's hover.
 * Includes the method's own description, a bulleted list of sibling properties
 * with their descriptions, and the first example as a fenced code block.
 */
function buildRichMarkdown(methodKey: string, m: EmittedMethodSchema, docs: SiblingDoc[] | undefined): string {
  const primary = m.properties[methodKey] as MaybeMeta | undefined;
  let md = pickDesc(primary);

  // Operations selected by the primary key's value. Those selected by a sibling's
  // presence are that sibling's own entry below, with the output it selects.
  if (m.variantDocs && m.variantDocs.length > 0) {
    const ops = m.variantDocs.map(v => formatValue(v));
    md = (md ? md + "\n\n" : "") + `**Operations** *(value of \`${methodKey}\`)*:\n` + ops.join("\n");
  }

  // Siblings come from `siblingDocs`, not from `m.properties`: by this point the
  // emitted form has scattered them (shared ones behind a `$ref`, variant-specific
  // ones into `allOf` with only a stub left inline), so reading `properties` here
  // would silently drop every `commonSiblings` key and every variant's keys.
  // Listed for variants methods too, under the operations, since an operation's
  // options are exactly what the reader needs next.
  if (docs && docs.length > 0) {
    const lines = docs.flatMap(d => {
      const req = d.required ? " *(required)*" : "";
      const out = d.output ? ` → ${d.output}` : "";
      const scope = d.when ? ` *(with ${formatWhen(d.when)})*` : "";
      const text = d.description ?? d.outputDescription;
      const head = `- \`${d.name}\`${req}${out}${scope}${text ? `: ${text}` : ""}`;
      return [head, ...(d.values ?? []).map(v => formatValue(v, "  "))];
    });
    md = (md ? md + "\n\n" : "") + "**Properties:**\n" + lines.join("\n");
  }

  if (m.outputDescription) {
    md = (md ? md + "\n\n" : "") + "**Returns:** " + m.outputDescription;
  }

  // The example string is preserved on the emitted schema's `examples` array.
  // VS Code renders that as a fenced JSON code block in hover automatically,
  // so we don't duplicate it inside markdownDescription.

  return md;
}

// ── Combined schema merge ──────────────────────────────────────────────────────

/**
 * Global step keys handled by the resolver itself rather than any Node, so they
 * may appear as a sibling on any step but never show up in `list_nodes`. The keys
 * themselves are GLOBAL_KEYS in Resolver.ts; this is the single source of truth
 * for their docs, consumed by `UNIVERSAL` (below, for the JSON schema) and
 * re-exported for the MCP introspection tools so `describe_op return` works.
 */
export const GLOBAL_KEY_DOCS: Record<string, { markdownDescription: string; examples?: string[] }> = {
  as: {
    markdownDescription:
      "Store this step's result in a named context variable, read later via `{ \"var\": \"name\" }`. Works on any step.",
    examples: ["{ \"var\": \"$user.name\", \"as\": \"name\" }"],
  },
  return: {
    markdownDescription:
      "In a step array, a step that resolves to `{ \"return\": X }` stops the array early and yields `X`. Escapes only the current array, so nest the wrapper to exit outer arrays.",
    examples: [
      "{ \"if\": { \"empty\": { \"var\": \"$name\" } }, \"then\": { \"return\": \"Hello, world!\" } }",
    ],
  },
  catch: {
    markdownDescription:
      "Step array to run if this expression throws. Catches ANY error, not just HTTP ones. The `$error` context variable carries `{ message }`, plus `status` when the thrower was an HTTP error (and whatever further variables it offered, e.g. `fetch`'s `$response`).",
    examples: ["{ \"query-select\": \"users\", \"catch\": [{ \"var\": \"$error.message\" }] }"],
  },
  then: {
    markdownDescription:
      "Run these steps as a FIRE-AND-FORGET continuation (like a Promise `.then`): the step returns immediately (later steps do NOT block on it), and once this expression settles, the steps run with the result bound as `$result`. A rejection runs `catch`. The step itself yields `null` (the result is delivered to `$result`, not returned), so a sibling `as` here would bind `null`; read the value via `$result` inside `then`. Works on ANY node; use it to kick off async I/O (`query`, `file`, a host `dialog`, `thread`) without stalling the sequence. (Under `if`, `then` is the branch, not a continuation.)",
    examples: ["{ \"query-select\": \"saves\", \"then\": [{ \"set-html\": [\"#list\", { \"var\": \"$result\" }] }] }"],
  },
  bubble: {
    markdownDescription:
      "Modifier for a write, only valid alongside `as` or `setVars`. Also writes the result up into every enclosing scope, so it survives after the current file / loop / branch returns. Without it, writes are scoped to the copied context and lost on return.",
    examples: ["{ \"var\": \"$total\", \"as\": \"total\", \"bubble\": true }"],
  },
};

/** Universal keys (`as`, `return`, `catch`, `then`) declared once at the top of
 *  exprFlat. `then` is also a sibling of `if` (LogicNode's branch); the emission
 *  loop gates it via `siblingHosts` so it validates as the branch under `if` and
 *  as a continuation everywhere else. */
// `examples` rides along with the prose: a standard JSON Schema annotation, so
// Ajv ignores it and the editor renders it on hover. It also makes exprFlat the
// complete published record of the global keys, which is what the MCP server
// reads them from rather than keeping a hand-copied list of its own.
const UNIVERSAL: Record<string, { ref: EmittedSchema; markdownDescription: string; examples?: string[] }> = {
  as:     { ref: { ...REF.strOrExpr },  ...GLOBAL_KEY_DOCS.as },
  return: { ref: { ...REF.anyVal },     ...GLOBAL_KEY_DOCS.return },
  catch:  { ref: { ...REF.steps },      ...GLOBAL_KEY_DOCS.catch },
  then:   { ref: { ...REF.steps },      ...GLOBAL_KEY_DOCS.then },
  bubble: { ref: { ...REF.boolOrExpr }, ...GLOBAL_KEY_DOCS.bubble },
};

export interface CombinedSchema {
  $schema: string;
  $id: string;
  $defs: Record<string, unknown>;
  /** Primary key value-schemas (with rich markdown). Hover/autocomplete refs land here. */
  vp: Record<string, EmittedSchema>;
  byKey: Record<string, EmittedMethodSchema>;
  byNode: Record<string, EmittedNodeSchema>;
  anyOf: EmittedSchema[];
}

/**
 * Merges multiple per-package schemas into a single combined schema with
 * shared $defs, an exprFlat editor entry point, and the anti-cascade design
 * (every primary handler key listed flat in exprFlat.properties).
 *
 * The inputs are cloned on the way in, because the passes below rewrite what
 * they take ownership of: the vp hoist swaps each primary property for a
 * `$ref`, and the catch-all pass stamps `additionalProperties` onto every
 * byKey entry. Aliasing the caller's objects would leave a PackageSchema
 * gutted after a merge — the entries reduced to dangling `#/vp/*` refs whose
 * target only exists in the CombinedSchema returned here.
 */
export function mergePackageSchemas(packages: PackageSchema[], opts: SchemaBuildOptions = {}): CombinedSchema {
  const byKey: Record<string, EmittedMethodSchema> = {};
  const byNode: Record<string, EmittedNodeSchema> = {};
  const extraDefs: Record<string, EmittedSchema> = {};
  const collisions: string[] = [];
  const siblingHosts: Record<string, Set<string>> = {};
  const siblingDocs: Record<string, SiblingDoc[]> = {};

  for (const pkg of packages) {
    for (const [k, v] of Object.entries(pkg.byKey)) {
      if (k in byKey) {
        collisions.push(`Handler key "${k}" appears in multiple packages.`);
        continue;
      }
      byKey[k] = structuredClone(v);
    }
    for (const [k, v] of Object.entries(pkg.siblingDocs ?? {})) {
      if (!(k in siblingDocs)) siblingDocs[k] = v;
    }
    for (const [sib, hosts] of Object.entries(pkg.siblingHosts ?? {})) {
      for (const h of hosts) (siblingHosts[sib] ??= new Set()).add(h);
    }
    for (const [n, v] of Object.entries(pkg.byNode)) {
      if (n in byNode) {
        collisions.push(`Node class "${n}" appears in multiple packages.`);
        continue;
      }
      byNode[n] = structuredClone(v);
    }
    for (const [defName, defSchema] of Object.entries(pkg.extraDefs ?? {})) {
      if (defName in extraDefs) {
        collisions.push(`$defs name "${defName}" appears in multiple packages.`);
        continue;
      }
      extraDefs[defName] = structuredClone(defSchema);
    }
  }
  reportCollisions(collisions, opts, "mergePackageSchemas");
  // Underscore convention: non-underscored extraDefs entries are root-matchable.
  const rootMatches = Object.keys(extraDefs).filter(name => !name.startsWith("_"));

  // Two canonical stores at the schema root:
  //   - byKey/<k> = method-dispatch schema (sibling constraints), used by
  //     dependentSchemas refs across exprFlat, filtered variants, and runtime
  //     consumers building per-Node validators from byNode.
  //   - vp/<k>    = the primary key's VALUE schema (constraint + rich markdown).
  //     Hover/autocomplete refs in exprFlat.properties and filtered variants
  //     resolve here.
  const vp: Record<string, EmittedSchema> = {};
  for (const [methodKey, m] of Object.entries(byKey)) {
    const primaryEntry = m.properties[methodKey];
    if (!primaryEntry) continue;
    const md = buildRichMarkdown(methodKey, m, siblingDocs[methodKey]);
    if (md) primaryEntry.markdownDescription = md;
    vp[methodKey] = primaryEntry;
    m.properties[methodKey] = { $ref: `#/vp/${methodKey}` };
  }

  // Structural shape dedup runs as a whole-schema pass at the end (dedupeShapes),
  // subsuming the old vp-only `_p` loop — it hoists any repeated subschema (vp
  // shapes, byKey gating fragments, repeated enum shapes, …), keeping per-node
  // metadata inline next to the `$ref`.

  const methodSchemaRefs: Record<string, EmittedSchema> = {};
  const primaryValueRefs: Record<string, EmittedSchema> = {};
  for (const methodKey of Object.keys(byKey)) {
    methodSchemaRefs[methodKey] = { $ref: `#/byKey/${methodKey}` };
    primaryValueRefs[methodKey] = { $ref: `#/vp/${methodKey}` };
  }

  const exprFlatProperties: Record<string, EmittedSchema> = {};
  const exprFlatDependentSchemas: Record<string, EmittedSchema> = {};
  for (const methodKey of Object.keys(byKey)) {
    // A key that's ALSO a sibling of other ops (e.g. `session`) must not be
    // validated as its own op when used as that sibling. Mirror the runtime
    // (first handler key dispatches): if a host op is present, treat this key as
    // its sibling (the host's byKey validates the value); only dispatch it as its
    // own op when no host is present. Keep it in `properties` (as a description
    // stub — no value constraint) so editor completion still offers the key.
    const hosts = [...(siblingHosts[methodKey] ?? [])].filter(h => h !== methodKey && h in byKey);
    if (hosts.length > 0) {
      const md = vp[methodKey]?.markdownDescription;
      exprFlatProperties[methodKey] = md ? { markdownDescription: md } : {};
      exprFlatDependentSchemas[methodKey] = {
        if: { anyOf: hosts.map(h => ({ required: [h] })) },
        then: true,
        else: methodSchemaRefs[methodKey],
      };
    } else {
      exprFlatProperties[methodKey] = primaryValueRefs[methodKey];
      exprFlatDependentSchemas[methodKey] = methodSchemaRefs[methodKey];
    }
  }
  for (const [name, info] of Object.entries(UNIVERSAL)) {
    // A universal key that a node ALSO declares as its own sibling (e.g. `then`,
    // which LogicNode's `if` owns as a branch) must defer to that host op's
    // validation when the host is present, and only apply the universal schema
    // when used standalone — the same gating as a handler-key-named sibling
    // (above). Otherwise `{ "if": ..., "then": "yes" }` would fail the universal
    // (steps-array) constraint.
    const hosts = [...(siblingHosts[name] ?? [])].filter(h => h in byKey);
    if (hosts.length > 0) {
      // The property carries only the docs (always shown); the VALUE constraint is
      // gated: when a host op is present it's that op's sibling (host validates it,
      // e.g. `if`'s scalar/array branch), otherwise it's the universal value (steps
      // for `then`). `dependentSchemas` constrains the whole object, so the else
      // wraps the constraint back onto this property, not the object.
      exprFlatProperties[name] = { markdownDescription: info.markdownDescription, ...(info.examples ? { examples: info.examples } : {}) };
      exprFlatDependentSchemas[name] = {
        if: { anyOf: hosts.map(h => ({ required: [h] })) },
        then: true,
        else: { properties: { [name]: { ...info.ref } } },
      };
    } else {
      exprFlatProperties[name] = {
        ...info.ref,
        markdownDescription: info.markdownDescription,
        ...(info.examples ? { examples: info.examples } : {}),
      };
    }
  }

  // `bubble` is a modifier on a write, meaningless on its own. Gate it so the
  // schema only accepts it when the step also carries `as` or is a `setVars` —
  // i.e. `{ ..., "as": "x", "bubble": true }` or `{ "setVars": {...}, "bubble":
  // true }` validate, but a bare `{ "concat": [...], "bubble": true }` does not.
  // A `dependentSchemas` co-occurrence check keeps the flat authoring shape (a
  // literal nested key can't live inside `setVars`, which is a value map) and is
  // non-recursive, so it doesn't feed the anti-cascade blow-up.
  exprFlatDependentSchemas.bubble = {
    anyOf: [{ required: ["as"] }, { required: ["setVars"] }],
  };

  // Default schema for keys not enumerated in `properties` — i.e. siblings of
  // a declared handler key, and any custom user keys. A sibling value may be a
  // nested expression (object), a step/value array, or a primitive — dispatched
  // by instance type via `if/then/else` (deterministic; no `anyOf` backtracking).
  //
  // CRUCIAL: this lives on each `byKey` entry, NOT on `exprFlat` (whose
  // `additionalProperties` is `true`). A node's declared siblings — including its
  // big recursive ones (`content`, `cases`, step sequences) — are validated by
  // that handler's `byKey.properties` via `dependentSchemas`. If `exprFlat` ALSO
  // had a recursive catch-all, every such sibling would be validated TWICE per
  // nesting level — an O(2^depth) blow-up that makes the editor's JSON validator
  // give up on deeply-nested files. Scoping the catch-all to `byKey` means each
  // property is validated exactly once (by `properties` if declared, else by this
  // catch-all), keeping validation full AND linear in depth.
  // Stored as a shared $defs entry referenced from every byKey entry.
  const additionalPropertiesDef: EmittedSchema = {
    if: { type: "object" },
    then: { ...REF.exprFlat },
    else: {
      if: { type: "array" },
      then: { type: "array", items: { ...REF.anyVal } },
      else: { type: ["string", "number", "boolean", "null"] },
    },
  };
  const additionalPropertiesRef: EmittedSchema = { $ref: "#/$defs/_addProps" };

  // The catch-all is per-handler (see above): each byKey entry validates its own
  // undeclared siblings. exprFlat itself accepts unlisted keys freely (`true`).
  for (const m of Object.values(byKey)) {
    m.additionalProperties = { ...additionalPropertiesRef };
  }

  const exprFlat: EmittedSchema = {
    type: "object",
    properties: exprFlatProperties,
    additionalProperties: true,
    dependentSchemas: exprFlatDependentSchemas,
  };

  // Per-output-type filtered exprFlat variants. Slots declared `type: T` route
  // to `exprFlat_T` for the expression-object branch, catching output-type
  // mismatches at validation time.
  //
  // Each variant is `allOf: [ {$ref: exprFlat}, override ]` — it INHERITS the
  // base `exprFlat` (all allowed keys' value+dependent schemas, the universal
  // keys, and `additionalProperties`) and only overrides the differences:
  //   - keys whose output can't match T → `properties: { key: false }` (reject).
  //   - keys that match only under some discriminators → `dependentSchemas:
  //     { key: <gate> }`, ANDed (via the outer allOf) onto the base's method
  //     schema for that key.
  // Keys whose output matches unconditionally are simply inherited (not relisted),
  // which is the bulk of the size saving vs. emitting every key per variant.
  //
  // `object` is intentionally absent: object-typed slots route to a plain
  // `{ type: "object" }` (see `typeOrExprRef`) rather than to an `exprFlat_object`,
  // so emitting that variant would just be dead weight (zero references).
  const OUTPUT_TYPES: JexsType[] = ["string", "number", "boolean", "array", "null"];
  const filteredVariants: Record<string, EmittedSchema> = {};
  for (const target of OUTPUT_TYPES) {
    const rejected: Record<string, false> = {};
    const gated: Record<string, EmittedSchema> = {};
    const accepts = (o: VariantOutput["output"]): boolean =>
      Array.isArray(o) ? o.some(accepts) : o === undefined || o === "any" || o === target;
    for (const [methodKey, m] of Object.entries(byKey)) {
      // The first rule whose condition holds decides the output, so a rule with
      // an output that fits this bucket accepts the key only where no EARLIER rule
      // with an output that doesn't fit holds. Earlier rules that fit need no
      // exclusion (either way the key is accepted), and neither do rules that
      // test one key against another value, which can never hold together.
      const rules = m.variantOutputs ?? [{ cond: {}, when: [], output: m.output }];
      const clauses: EmittedSchema[] = [];
      let always = false;
      rules.forEach((rule, i) => {
        if (always || !accepts(rule.output)) return;
        const earlier = rules.slice(0, i)
          .filter(e => !accepts(e.output) && !disjoint(e.when, rule.when))
          .map(e => e.cond);
        const unless: EmittedSchema | null = earlier.length === 0 ? null
          : { not: earlier.length === 1 ? earlier[0] : { anyOf: earlier } };
        const empty = Object.keys(rule.cond).length === 0;
        if (empty && !unless) always = true;
        else clauses.push(!unless ? rule.cond : empty ? unless : { allOf: [rule.cond, unless] });
      });
      if (always) continue;                          // inherit from base, nothing to emit
      if (clauses.length === 0) rejected[methodKey] = false;
      else gated[methodKey] = clauses.length === 1 ? clauses[0] : { anyOf: clauses };
    }
    const override: EmittedSchema = { properties: rejected };
    const deps: Record<string, EmittedSchema> = { ...gated };
    // A fire-and-forget `then` (present WITHOUT `if` — the branch form) makes the
    // whole expression resolve to null, so it can't stand in a non-null-typed
    // slot. Require `if` alongside `then` in these buckets: `{ node, then }`
    // (fire-and-forget) is rejected where a real value is expected, while
    // `{ if, then }` (the branch) still passes. `exprFlat_null` is left permissive
    // (null output is exactly what a null slot wants).
    if (target !== "null") deps.then = { required: ["if"] };
    if (Object.keys(deps).length > 0) override.dependentSchemas = deps;
    filteredVariants[`exprFlat_${target}`] = {
      allOf: [{ $ref: "#/$defs/exprFlat" }, override],
    };
  }

  // Strip build-only fields from emitted byKey entries: `output` drives the
  // filter-variant routing above, and `outputDescription` has already been
  // folded into the primary key's rich markdown — nothing reads either at
  // runtime.
  for (const m of Object.values(byKey)) {
    delete m.output;
    delete m.outputDescription;
    delete m.variantOutputs;
    delete m.variantDocs;
  }

  const combined: CombinedSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "jexs://combined",
    $defs: {
      ...sharedDefs,
      _addProps: additionalPropertiesDef,
      ...extraDefs,
      exprFlat,
      ...filteredVariants,
    },
    vp,
    byKey,
    byNode,
    anyOf: [
      { ...REF.steps },
      { ...REF.exprFlat },
      ...rootMatches.map(name => ({ $ref: `#/$defs/${name}` })),
    ],
  };
  dedupeShapes(combined);
  return combined;
}

// ── Structural shape dedup ──────────────────────────────────────────────────────

const DEDUP_METADATA = new Set(["markdownDescription", "examples", "description", "default"]);
// JSON Schema 2020-12 keywords whose values hold subschema(s) WE emit. Used to
// walk only real schema positions (never `properties`/`required` CONTAINERS or
// data like `enum`/`const`), so replacing a node with `{ $ref }` stays valid.
const SCHEMA_SLOT_KEYS = ["if", "then", "else", "not", "items", "additionalProperties", "contains", "propertyNames"];
const SCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAP_KEYS = ["properties", "$defs", "dependentSchemas", "patternProperties"];

function isSchemaObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Stable serialization (object keys sorted at every level) for shape matching. */
function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (isSchemaObj(v)) {
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** Canonical form of a node's STRUCTURE (metadata fields stripped from the top). */
function shapeCanonical(node: Record<string, unknown>): string {
  const shape: Record<string, unknown> = {};
  for (const k of Object.keys(node)) if (!DEDUP_METADATA.has(k)) shape[k] = node[k];
  return canonicalize(shape);
}

/** Map each child SCHEMA of `node` (in real schema positions) through `fn`. */
function mapChildSchemas(node: Record<string, unknown>, fn: (c: Record<string, unknown>) => Record<string, unknown>): void {
  for (const k of SCHEMA_SLOT_KEYS) {
    const c = node[k];
    if (isSchemaObj(c)) node[k] = fn(c);
  }
  for (const k of SCHEMA_LIST_KEYS) {
    const a = node[k];
    if (Array.isArray(a)) for (let i = 0; i < a.length; i++) {
      const e = a[i];
      if (isSchemaObj(e)) a[i] = fn(e);
    }
  }
  for (const k of SCHEMA_MAP_KEYS) {
    const m = node[k];
    if (isSchemaObj(m)) for (const mk of Object.keys(m)) {
      const e = m[mk];
      if (isSchemaObj(e)) m[mk] = fn(e);
    }
  }
}

/** How a single dedup pass keys nodes and emits replacements. */
interface DedupMode {
  /** Canonical key for `node`, or `null` to skip it. */
  key: (node: Record<string, unknown>) => string | null;
  /** The replacement node referencing the hoisted def. */
  ref: (node: Record<string, unknown>, defName: string) => Record<string, unknown>;
}

/**
 * One dedup pass: hoist every node sharing a `mode.key` (≥2 uses, net-positive
 * bytes) to a shared `$defs/_p<N>`, replacing occurrences via `mode.ref`. The def
 * body is `JSON.parse(key)` — the key IS canonical JSON. Returns true if anything
 * was hoisted. Walks only real schema positions, so `{ $ref }` is always valid.
 */
function dedupePass(combined: CombinedSchema, mode: DedupMode, counter: { n: number }): boolean {
  const defs = combined.$defs as Record<string, Record<string, unknown>>;
  const roots: Record<string, unknown>[] = [
    ...Object.values(combined.vp),
    ...Object.values(combined.byKey),
    ...Object.values(defs),
    ...combined.anyOf,
  ].filter(isSchemaObj);

  const counts = new Map<string, number>();
  const count = (node: Record<string, unknown>): Record<string, unknown> => {
    const k = mode.key(node);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
    mapChildSchemas(node, count);
    return node;
  };
  for (const r of roots) count(r);

  // Replacing `n` copies of an `L`-byte node with refs (~24b) + one def (L + ~9b
  // key overhead): saved = (n-1)*L - 24n - 9. Deterministic name order.
  const hoist = new Map<string, string>();
  for (const k of [...counts.keys()].sort()) {
    const c = counts.get(k)!;
    if (c >= 2 && (c - 1) * k.length - c * 24 - 9 > 0) hoist.set(k, `_p${counter.n++}`);
  }
  if (hoist.size === 0) return false;

  const newDefs = new Set<string>();
  for (const [k, name] of hoist) { defs[name] = JSON.parse(k); newDefs.add(name); }

  const transform = (node: Record<string, unknown>): Record<string, unknown> => {
    const k = mode.key(node);
    const name = k !== null ? hoist.get(k) : undefined;
    if (name) return mode.ref(node, name);
    mapChildSchemas(node, transform);
    return node;
  };
  for (const map of [combined.vp, combined.byKey] as Record<string, Record<string, unknown>>[]) {
    for (const mk of Object.keys(map)) if (isSchemaObj(map[mk])) map[mk] = transform(map[mk]);
  }
  for (const dk of Object.keys(defs)) {
    if (!isSchemaObj(defs[dk])) continue;
    if (newDefs.has(dk)) mapChildSchemas(defs[dk], transform);  // descend only — never alias to self
    else defs[dk] = transform(defs[dk]);
  }
  combined.anyOf = combined.anyOf.map(e => isSchemaObj(e) ? transform(e) : e);
  return true;
}

/**
 * Hoist repeated subschemas to shared `$defs/_p<N>`. Runs two modes to fixpoint:
 *   - EXACT (metadata included): collapses identical nodes whole — including
 *     `{ $ref, description }` duplicates the shape pass would skip.
 *   - SHAPE (metadata stripped): collapses same-structure nodes whose docs differ,
 *     keeping each occurrence's metadata inline next to the `$ref`.
 * Exact runs first (no inline-metadata repeat); the loop re-collapses the
 * `{ $ref, description }` results the shape pass produces. Lossless — `$ref` is
 * pure inclusion in 2020-12. Subsumes the old vp-only `_p` loop.
 */
function dedupeShapes(combined: CombinedSchema): void {
  const ref = (defName: string): Record<string, unknown> => ({ $ref: `#/$defs/${defName}` });
  const exact: DedupMode = {
    // skip a bare `{ $ref }` (no metadata) — hoisting only aliases the ref.
    key: node => { const ks = Object.keys(node); return ks.length === 1 && ks[0] === "$ref" ? null : canonicalize(node); },
    ref: (_node, name) => ref(name),
  };
  const shape: DedupMode = {
    key: node => {
      const st = Object.keys(node).filter(k => !DEDUP_METADATA.has(k));
      return st.length === 0 || (st.length === 1 && st[0] === "$ref") ? null : shapeCanonical(node);
    },
    ref: (node, name) => {
      const r = ref(name);
      for (const k of DEDUP_METADATA) if (node[k] !== undefined) r[k] = node[k];
      return r;
    },
  };
  const counter = { n: 0 };
  for (let guard = 0; guard < 10; guard++) {
    const a = dedupePass(combined, exact, counter);
    const b = dedupePass(combined, shape, counter);
    if (!a && !b) break;
  }
}
