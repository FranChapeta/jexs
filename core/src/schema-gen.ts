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
 *   writeFileSync("dist/schema.json", JSON.stringify(buildPackageSchema(coreNodes), null, 2));
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
 * `anyVal` / `mapVal` / `steps` keep referencing the unfiltered `exprFlat`
 * since they don't constrain output type.
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
    if: { type: "array" },
    then: { items: { $ref: "#/$defs/exprFlat" } },
    else: { if: { type: "object" }, then: { $ref: "#/$defs/exprFlat" }, else: {} },
  },
  strOrExpr:   { if: { type: "string"  }, then: {}, else: { $ref: "#/$defs/exprFlat_string"  } },
  numOrExpr:   { if: { type: "number"  }, then: {}, else: { $ref: "#/$defs/exprFlat_number"  } },
  boolOrExpr:  { if: { type: "boolean" }, then: {}, else: { $ref: "#/$defs/exprFlat_boolean" } },
  nullOrExpr:  { if: { type: "null"    }, then: {}, else: { $ref: "#/$defs/exprFlat_null"    } },
  arrayOrExpr: { if: { type: "array"   }, then: {}, else: { $ref: "#/$defs/exprFlat_array"   } },
  steps:       { type: "array", items: { $ref: "#/$defs/exprFlat" } },
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

const METADATA_KEYS = ["description", "markdownDescription", "examples"] as const;

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
    for (const [k, v] of Object.entries(prop.properties)) props[k] = expandProperty(v);
    const out: EmittedSchema = {
      type: "object",
      properties: props,
      additionalProperties: prop.additionalProperties ?? false,
    };
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
      out.prefixItems = prop.prefixItems.map(expandProperty);
      if (max > prop.prefixItems.length) out.items = { ...REF.anyVal };
    } else {
      out.items = { ...REF.anyVal };
    }
    liftMetadata(prop, out);
    return out;
  }

  if (prop.map === true) {
    const out: EmittedSchema = { ...REF.mapVal };
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
    if (prop.items && prop.type === "array") out.items = expandProperty(prop.items);
    liftMetadata(prop, out);
    return out;
  }

  if (prop.type === "array" && prop.items) {
    const out: EmittedSchema = {
      if: { type: "array" },
      then: { items: expandProperty(prop.items) },
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
}

export interface EmittedMethodSchema {
  properties: Record<string, EmittedSchema>;
  output?: string;
  outputDescription?: string;
  /** Build-only: flattened per-(possibly nested)-variant output + discriminator
   *  condition, used by the filtered-variant loop for output narrowing. Stripped
   *  on emit. */
  variantOutputs?: VariantOutput[];
  /** Build-only: TOP-LEVEL variant docs for the hover "Operations" list (nesting
   *  is flattened away in `variantOutputs`, so docs come from here). Stripped. */
  variantDocs?: VariantDoc[];
  /** Conditional sibling constraints for variants methods. Emitted (real schema). */
  allOf?: EmittedSchema[];
  /** Shared `commonSiblings` block, attached on merge (2020-12 evaluates $ref siblings). */
  $ref?: string;
  /** Per-handler catch-all for undeclared siblings, attached on merge. */
  additionalProperties?: EmittedSchema;
}

/** One (possibly nested) variant's discriminator condition + resolved output
 *  type, used by the filtered-variant loop to gate output-type narrowing. The
 *  `cond` is the full composed condition (parent ∧ child). Build-only. */
export interface VariantOutput {
  cond: EmittedSchema;
  output?: string;
}

/** A top-level variant's doc entry for hover. Build-only. */
export interface VariantDoc {
  key: string;
  output?: string;
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

interface CompiledMethod {
  properties: Record<string, EmittedSchema>;
  output?: string;
  outputDescription?: string;
  ownerNode: string;
  variantOutputs?: VariantOutput[];
  variantDocs?: VariantDoc[];
  allOf?: EmittedSchema[];
}

function compileMethod(
  methodKey: string,
  method: JexsMethodSchema,
  ownerNode: string,
): CompiledMethod {
  const { output, outputDescription, siblings, variants, variantBy, ...primary } = method;

  if (variants) {
    return compileVariantMethod(methodKey, primary, variants, variantBy, siblings, output, outputDescription, ownerNode);
  }

  const properties: Record<string, EmittedSchema> = {
    [methodKey]: expandProperty(primary),
  };
  for (const [k, v] of Object.entries(siblings ?? {})) {
    properties[k] = expandProperty(v);
  }
  return { properties, output, outputDescription, ownerNode };
}

/**
 * Compile a multi-op method declared via `variants`. The variant map KEY is the
 * discriminator: in sibling-mode (no `enum`) it's a sibling whose presence selects
 * the variant; in value-mode (primary has an `enum`) it's the primary key's value.
 *
 * Variants NEST: a variant may itself declare `variants` (always sibling-mode at
 * nested levels). `walkVariants` flattens the tree into `variantOutputs` whose
 * conditions are `allOf`-composed down the path — so output can narrow on, e.g.,
 * the query value AND a `returning` sibling's presence. A level's `output` is the
 * fallback when none of its variants match (e.g. FileNode `file` → "any" load
 * mode + a `write` variant → boolean; query `update` → "number" + `returning` →
 * array). `variantDocs` keeps the TOP-LEVEL ops for hover.
 */
function compileVariantMethod(
  methodKey: string,
  primary: JexsPropertySchema,
  variants: NonNullable<JexsMethodSchema["variants"]>,
  variantBy: JexsMethodSchema["variantBy"],
  commonSiblings: Record<string, JexsPropertySchema> | undefined,
  output: string | undefined,
  outputDescription: string | undefined,
  ownerNode: string,
): CompiledMethod {
  const properties: Record<string, EmittedSchema> = {
    [methodKey]: expandProperty(primary),
  };
  // Method-level siblings apply to every variant (e.g. `flags` for regex).
  for (const [k, v] of Object.entries(commonSiblings ?? {})) {
    properties[k] = expandProperty(v);
  }
  const allOf: EmittedSchema[] = [];
  const variantOutputs = walkVariants(
    { variants, variantBy, output, enum: primary.enum },
    methodKey, null, properties, allOf,
  );

  // Top-level ops for hover (nesting is flattened in variantOutputs).
  const variantDocs: VariantDoc[] = Object.entries(variants).map(([key, v]) => ({
    key,
    output: v.output ?? output,
    description: v.markdownDescription ?? v.description ?? v.outputDescription,
  }));

  return {
    properties,
    output,
    outputDescription,
    ownerNode,
    variantOutputs,
    variantDocs,
    allOf: allOf.length > 0 ? allOf : undefined,
  };
}

/** A variants-bearing spec (top method or a nested variant). */
interface VariantSpec {
  variants: NonNullable<JexsMethodSchema["variants"]>;
  variantBy?: JexsMethodSchema["variantBy"];
  output?: string;
  enum?: readonly unknown[];
}

/**
 * A sibling-mode presence condition. A plain key tests a root sibling; a DOTTED
 * key (e.g. `options.returning`) tests a NESTED property's presence — letting a
 * variant narrow on a clause that lives inside a nested object (so the user's
 * data stays regular, e.g. `returning` stays in `options`) rather than forcing
 * it to the root. `{ required: ["returning"] }` ⇒ `{ properties: { options: {
 * required: ["returning"] } } }`.
 */
function presenceCond(key: string): EmittedSchema {
  const parts = key.split(".");
  let cond: EmittedSchema = { required: [parts[parts.length - 1]] };
  for (let i = parts.length - 2; i >= 0; i--) {
    cond = { properties: { [parts[i]]: cond } };
  }
  return cond;
}

/**
 * Recursively flatten a variants tree into output-narrowing entries, registering
 * each variant's siblings into `properties`/`allOf`. `baseCond` is the parent's
 * composed discriminator (null at the top). value-mode is only valid at the top
 * (it reads `methodKey`'s value); nested levels are sibling-mode (variant key =
 * sibling presence, dotted for a nested clause).
 */
function walkVariants(
  spec: VariantSpec,
  methodKey: string,
  baseCond: EmittedSchema | null,
  properties: Record<string, EmittedSchema>,
  allOf: EmittedSchema[],
): VariantOutput[] {
  const mode = spec.variantBy ?? (spec.enum ? "value" : "sibling");
  const out: VariantOutput[] = [];
  const localConds: EmittedSchema[] = [];

  for (const [key, variant] of Object.entries(spec.variants)) {
    const localCond: EmittedSchema = mode === "value"
      ? { properties: { [methodKey]: { const: key } }, required: [methodKey] }
      : presenceCond(key);
    localConds.push(localCond);
    const cond: EmittedSchema = baseCond ? { allOf: [baseCond, localCond] } : localCond;

    // Sibling-mode: the trigger key is itself a sibling carrying the op's input —
    // unless it's dotted, in which case the target lives inside a nested object
    // (e.g. `options`) whose own schema already registers/validates it.
    if (mode === "sibling" && !key.includes(".")) {
      const { output: _o, outputDescription: _od, siblings: _s, variants: _v, variantBy: _vb, ...triggerProp } = variant;
      properties[key] = expandProperty(triggerProp);
    }

    // Extra siblings: REAL shape enforced only under this variant's discriminator
    // via `allOf`; base `properties` stays permissive so a same-named sibling with
    // different shapes per variant (e.g. per-op `options`) isn't clobbered.
    // Guard: never overwrite an existing base — a method-level sibling (e.g.
    // ElementNode's `content`, which routes children to exprFlat) or an
    // earlier variant's permissive `{}` must survive, with this variant's shape
    // layered on via the gated `allOf` below.
    const extra: Record<string, EmittedSchema> = {};
    for (const [sk, sv] of Object.entries(variant.siblings ?? {})) {
      if (!(sk in properties)) properties[sk] = {};
      extra[sk] = expandProperty(sv);
    }
    if (Object.keys(extra).length > 0) {
      allOf.push({ if: cond, then: { properties: extra } });
    }

    if (variant.variants) {
      // Nested variants compose: recurse with this variant's condition as base.
      out.push(...walkVariants(
        { variants: variant.variants, variantBy: variant.variantBy, output: variant.output, enum: variant.enum },
        key, cond, properties, allOf,
      ));
    } else {
      out.push({ cond, output: variant.output ?? spec.output });
    }
  }

  // Fallback: this level's `output` applies when none of its variants match.
  if (spec.output !== undefined) {
    const none: EmittedSchema = localConds.length > 0 ? { not: { anyOf: localConds } } : {};
    out.push({ cond: baseCond ? { allOf: [baseCond, none] } : none, output: spec.output });
  }

  return out;
}

/** All sibling-property names a method can carry (its own siblings + every
 *  variant's, recursively). Used to map sibling names to their host ops. */
function collectMethodSiblings(method: JexsMethodSchema): string[] {
  const out: string[] = [];
  const walk = (m: JexsMethodSchema) => {
    for (const k of Object.keys(m.siblings ?? {})) out.push(k);
    if (m.variants) for (const v of Object.values(m.variants)) walk(v);
  };
  walk(method);
  return out;
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
 * resolver builds with instances, so callers can pass `coreNodes` directly.
 */
export function buildPackageSchema(
  nodes: ReadonlyArray<Node | (typeof Node)>,
  packageName?: string,
  opts: SchemaBuildOptions = {},
): PackageSchema {
  const compiled: Record<string, CompiledMethod> = {};
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
      const prior = compiled[methodKey];
      if (prior && prior.ownerNode !== nodeClass) {
        collisions.push(
          `Handler key "${methodKey}" is declared by both ${prior.ownerNode} and ${nodeClass}.`,
        );
        continue;
      }
      compiled[methodKey] = compileMethod(methodKey, method, nodeClass);
      for (const sib of collectMethodSiblings(method)) addSiblingHost(sib, methodKey);
    }

    // Per-Node $defs contributions (e.g. RouterNode's routeNode tree shape).
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

  // byKey is the canonical store; byNode is a compact index of method names per
  // Node class. Consumers wanting a full per-Node dispatch schema construct it
  // on the fly via `{ type: "object", dependentSchemas: byNode[name].map(...) }`.
  const byKey: Record<string, EmittedMethodSchema> = {};
  const byNode: Record<string, EmittedNodeSchema> = {};
  for (const [methodKey, m] of Object.entries(compiled)) {
    const entry: EmittedMethodSchema = { properties: m.properties };
    if (m.output !== undefined) entry.output = m.output;
    if (m.outputDescription !== undefined) entry.outputDescription = m.outputDescription;
    if (m.variantOutputs !== undefined) entry.variantOutputs = m.variantOutputs;
    if (m.variantDocs !== undefined) entry.variantDocs = m.variantDocs;
    if (m.allOf !== undefined) entry.allOf = m.allOf;
    // 2020-12 evaluates $ref siblings, so the local `properties` (primary key)
    // applies in addition to the shared siblings block from the ref'd schema.
    const ref = nodeSiblingsRef[m.ownerNode];
    if (ref) entry.$ref = ref;
    byKey[methodKey] = entry;
    (byNode[m.ownerNode] ??= []).push(methodKey);
  }

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

/**
 * Composes the rich markdownDescription for a primary handler key's hover.
 * Includes the method's own description, a bulleted list of sibling properties
 * with their descriptions, and the first example as a fenced code block.
 */
function buildRichMarkdown(methodKey: string, m: EmittedMethodSchema): string {
  const primary = m.properties[methodKey] as MaybeMeta | undefined;
  let md = pickDesc(primary);

  // Variants methods document their (top-level) operations, each with its output
  // type — the variant keys ARE the operations.
  if (m.variantDocs && m.variantDocs.length > 0) {
    const ops = m.variantDocs.map(v => {
      const out = v.output ? ` → ${v.output}` : "";
      const desc = v.description ? `: ${v.description}` : "";
      return `- \`${v.key}\`${out}${desc}`;
    });
    md = (md ? md + "\n\n" : "") + "**Operations:**\n" + ops.join("\n");
  } else {
    const siblings = Object.entries(m.properties)
      .filter(([k]) => k !== methodKey)
      .map(([k, v]) => {
        const desc = pickDesc(v as MaybeMeta);
        return desc ? `- \`${k}\`: ${desc}` : `- \`${k}\``;
      });
    if (siblings.length > 0) {
      md = (md ? md + "\n\n" : "") + "**Properties:**\n" + siblings.join("\n");
    }
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
 * may appear as a sibling on any step but never show up in `list_nodes`. This is
 * the single source of truth for their docs — consumed by `UNIVERSAL` (below,
 * for the JSON schema) and re-exported for the MCP introspection tools so
 * `describe_op return` works.
 */
/** Prose for the global step keys, for autocomplete. The keys themselves are
 *  GLOBAL_KEYS in Resolver.ts; this only describes them. */
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
      "Step array to run if this expression throws an HTTP error. The `$error` context variable carries `{ status, message }`.",
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
const UNIVERSAL: Record<string, { ref: EmittedSchema; markdownDescription: string }> = {
  as:     { ref: { ...REF.strOrExpr },  markdownDescription: GLOBAL_KEY_DOCS.as.markdownDescription },
  return: { ref: { ...REF.anyVal },     markdownDescription: GLOBAL_KEY_DOCS.return.markdownDescription },
  catch:  { ref: { ...REF.steps },      markdownDescription: GLOBAL_KEY_DOCS.catch.markdownDescription },
  then:   { ref: { ...REF.steps },      markdownDescription: GLOBAL_KEY_DOCS.then.markdownDescription },
  bubble: { ref: { ...REF.boolOrExpr }, markdownDescription: GLOBAL_KEY_DOCS.bubble.markdownDescription },
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
 */
export function mergePackageSchemas(packages: PackageSchema[], opts: SchemaBuildOptions = {}): CombinedSchema {
  const byKey: Record<string, EmittedMethodSchema> = {};
  const byNode: Record<string, EmittedNodeSchema> = {};
  const extraDefs: Record<string, EmittedSchema> = {};
  const collisions: string[] = [];
  const siblingHosts: Record<string, Set<string>> = {};

  for (const pkg of packages) {
    for (const [k, v] of Object.entries(pkg.byKey)) {
      if (k in byKey) {
        collisions.push(`Handler key "${k}" appears in multiple packages.`);
        continue;
      }
      byKey[k] = v;
    }
    for (const [sib, hosts] of Object.entries(pkg.siblingHosts ?? {})) {
      for (const h of hosts) (siblingHosts[sib] ??= new Set()).add(h);
    }
    for (const [n, v] of Object.entries(pkg.byNode)) {
      if (n in byNode) {
        collisions.push(`Node class "${n}" appears in multiple packages.`);
        continue;
      }
      byNode[n] = v;
    }
    for (const [defName, defSchema] of Object.entries(pkg.extraDefs ?? {})) {
      if (defName in extraDefs) {
        collisions.push(`$defs name "${defName}" appears in multiple packages.`);
        continue;
      }
      extraDefs[defName] = defSchema;
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
    const md = buildRichMarkdown(methodKey, m);
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
      exprFlatProperties[name] = { markdownDescription: info.markdownDescription };
      exprFlatDependentSchemas[name] = {
        if: { anyOf: hosts.map(h => ({ required: [h] })) },
        then: true,
        else: { properties: { [name]: { ...info.ref } } },
      };
    } else {
      exprFlatProperties[name] = {
        ...info.ref,
        markdownDescription: info.markdownDescription,
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
  //   - variant keys accepted only under a discriminator → `dependentSchemas:
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
    for (const [methodKey, m] of Object.entries(byKey)) {
      // Variants method: accept the key in this bucket only under the
      // discriminator of a variant whose output matches the bucket (an
      // any/absent-output variant matches every bucket, but still only under its
      // own discriminator). A method-level fallback output applies when NO
      // variant's discriminator holds.
      if (m.variantOutputs) {
        const outMatches = (o: string | undefined) => o === undefined || o === "any" || o === target;
        const accept: EmittedSchema[] = m.variantOutputs.filter(v => outMatches(v.output)).map(v => v.cond);
        // A method-level `output` is the fallback when no variant matches.
        if (m.output !== undefined && outMatches(m.output)) {
          const allConds = m.variantOutputs.map(v => v.cond);
          accept.push(allConds.length > 0 ? { not: { anyOf: allConds } } : {});
        }
        if (accept.length === 0) {
          rejected[methodKey] = false;
        } else if (!accept.some(c => Object.keys(c).length === 0)) {
          // Not a tautology (`{}` = always accept): gate the key on the
          // accepting discriminators. The base supplies the method schema.
          gated[methodKey] = accept.length === 1 ? accept[0] : { anyOf: accept };
        }
        // else: unconditionally accepted → inherit from base, nothing to emit.
        continue;
      }
      const out = m.output;
      if (!(out === undefined || out === "any" || out === target)) {
        rejected[methodKey] = false; // wrong output type → reject; allowed ones inherit.
      }
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

const DEDUP_METADATA = new Set(["markdownDescription", "examples", "description"]);
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
