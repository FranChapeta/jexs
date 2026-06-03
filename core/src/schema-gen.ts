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

/** Output-filtered variants — used by enum and typed-array else branches in expandProperty. */
const FILTERED_REF: Record<JexsType, EmittedSchema> = {
  string:  { $ref: "#/$defs/exprFlat_string"  },
  number:  { $ref: "#/$defs/exprFlat_number"  },
  boolean: { $ref: "#/$defs/exprFlat_boolean" },
  array:   { $ref: "#/$defs/exprFlat_array"   },
  object:  { $ref: "#/$defs/exprFlat_object"  },
  null:    { $ref: "#/$defs/exprFlat_null"    },
};

// ── Property expansion ─────────────────────────────────────────────────────────

export type EmittedSchema = Record<string, unknown>;

/**
 * A schema slot value. JSON Schema 2020-12 allows a schema to be either an
 * object or a boolean (`true` = accept anything, `false` = reject anything;
 * equivalent to `{}` / `{ not: {} }`). We use `false` directly for rejection
 * entries in the filtered exprFlat variants — shorter than `{ not: {} }`.
 */
export type SchemaOrBool = EmittedSchema | boolean;

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

  if (prop.tuple !== undefined) {
    const [min, max] = typeof prop.tuple === "number"
      ? [prop.tuple, prop.tuple]
      : [prop.tuple[0], prop.tuple[1]];
    const out: EmittedSchema = {
      type: "array",
      minItems: min,
      maxItems: max,
      items: { ...REF.anyVal },
    };
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
}

export interface EmittedMethodSchema {
  properties: Record<string, EmittedSchema>;
  output?: string;
  outputDescription?: string;
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
}

function compileMethod(
  methodKey: string,
  method: JexsMethodSchema,
  ownerNode: string,
): CompiledMethod {
  const { output, outputDescription, siblings, ...primary } = method;
  const properties: Record<string, EmittedSchema> = {
    [methodKey]: expandProperty(primary),
  };
  for (const [k, v] of Object.entries(siblings ?? {})) {
    properties[k] = expandProperty(v);
  }
  return { properties, output, outputDescription, ownerNode };
}

/**
 * Builds a PackageSchema from a list of Node classes or instances. Each Node's
 * `static schema` is collected; collisions across nodes throw.
 *
 * Accepts either Node classes (the typeof Node value) or Node instances. The
 * resolver builds with instances, so callers can pass `coreNodes` directly.
 */
export function buildPackageSchema(
  nodes: ReadonlyArray<Node | (typeof Node)>,
  packageName?: string,
): PackageSchema {
  const compiled: Record<string, CompiledMethod> = {};
  const collisions: string[] = [];
  const extraDefs: Record<string, EmittedSchema> = {};
  /** Per-Node $defs ref to a shared siblings block (built from `commonSiblings`). */
  const nodeSiblingsRef: Record<string, string> = {};

  for (const n of nodes) {
    // Resolve to the class (constructor) — works for both instances and classes.
    const cls = (typeof n === "function" ? n : n.constructor) as typeof Node;
    const schema = (cls as unknown as { schema?: JexsNodeSchema }).schema;
    if (!schema) continue;
    const nodeClass = cls.name;

    // If the Node declares commonSiblings, auto-create a `_<NodeName>Siblings`
    // $defs entry from it. byKey emission below picks it up via nodeSiblingsRef.
    const nodeCommonSiblings = (cls as unknown as {
      commonSiblings?: Record<string, JexsPropertySchema>;
    }).commonSiblings;
    if (nodeCommonSiblings && Object.keys(nodeCommonSiblings).length > 0) {
      const siblingsDefName = `_${nodeClass}Siblings`;
      const expandedProps: Record<string, EmittedSchema> = {};
      for (const [k, v] of Object.entries(nodeCommonSiblings)) {
        expandedProps[k] = expandProperty(v);
      }
      extraDefs[siblingsDefName] = { properties: expandedProps };
      nodeSiblingsRef[nodeClass] = `#/$defs/${siblingsDefName}`;
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
    }

    // Per-Node $defs contributions (e.g. RouterNode's routeNode tree shape).
    const nodeDefs = (cls as unknown as { schemaDefs?: Record<string, EmittedSchema> }).schemaDefs;
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

  if (collisions.length > 0) {
    throw new Error(
      `Found ${collisions.length} schema-collision(s):\n  ${collisions.join("\n  ")}`,
    );
  }

  // byKey is the canonical store; byNode is a compact index of method names per
  // Node class. Consumers wanting a full per-Node dispatch schema construct it
  // on the fly via `{ type: "object", dependentSchemas: byNode[name].map(...) }`.
  const byKey: Record<string, EmittedMethodSchema> = {};
  const byNode: Record<string, EmittedNodeSchema> = {};
  for (const [methodKey, m] of Object.entries(compiled)) {
    const entry: EmittedMethodSchema = { properties: m.properties };
    if (m.output !== undefined) entry.output = m.output;
    if (m.outputDescription !== undefined) entry.outputDescription = m.outputDescription;
    // 2020-12 evaluates $ref siblings, so the local `properties` (primary key)
    // applies in addition to the shared siblings block from the ref'd schema.
    const ref = nodeSiblingsRef[m.ownerNode];
    if (ref) (entry as unknown as Record<string, unknown>).$ref = ref;
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

  const siblings = Object.entries(m.properties)
    .filter(([k]) => k !== methodKey)
    .map(([k, v]) => {
      const desc = pickDesc(v as MaybeMeta);
      return desc ? `- \`${k}\` — ${desc}` : `- \`${k}\``;
    });
  if (siblings.length > 0) {
    md = (md ? md + "\n\n" : "") + "**Properties:**\n" + siblings.join("\n");
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

/** Universal keys (`as`, `catch`) declared once at the top of exprFlat. */
const UNIVERSAL: Record<string, { ref: EmittedSchema; markdownDescription: string }> = {
  as: {
    ref: { ...REF.strOrExpr },
    markdownDescription:
      "Store the result in a named variable, accessible via `{ \"var\": \"name\" }`.",
  },
  catch: {
    ref: { ...REF.steps },
    markdownDescription:
      "Step array to run if this expression throws an HTTP error. The `$error` context variable carries `{ status, message }`.",
  },
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
export function mergePackageSchemas(packages: PackageSchema[]): CombinedSchema {
  const byKey: Record<string, EmittedMethodSchema> = {};
  const byNode: Record<string, EmittedNodeSchema> = {};
  const extraDefs: Record<string, EmittedSchema> = {};
  const collisions: string[] = [];

  for (const pkg of packages) {
    for (const [k, v] of Object.entries(pkg.byKey)) {
      if (k in byKey) {
        collisions.push(`Handler key "${k}" appears in multiple packages.`);
        continue;
      }
      byKey[k] = v;
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
  if (collisions.length > 0) {
    throw new Error(`Schema merge collisions:\n  ${collisions.join("\n  ")}`);
  }
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

  // Shape dedup: many vp entries share the same structural shape (e.g. 40+
  // methods use `{ type: "array", minItems: 2, maxItems: 2, items: anyVal }`
  // for tuple-2). Detect repeating shapes and move them to `$defs/_p<n>`.
  // Per-method metadata (markdownDescription, examples, description) stays
  // alongside the new $ref so VS Code hover and autocomplete still resolve.
  const METADATA_FIELDS = new Set(["markdownDescription", "examples", "description"]);
  const shapePatterns = new Map<string, string[]>();
  for (const [k, v] of Object.entries(vp)) {
    const shape: Record<string, unknown> = {};
    for (const [fk, fv] of Object.entries(v)) {
      if (!METADATA_FIELDS.has(fk)) shape[fk] = fv;
    }
    const serialized = JSON.stringify(shape);
    if (serialized === "{}") continue;  // empty shape — nothing to dedup
    if (serialized.length < 40) continue;  // already small ($refs); not worth deduping
    if (!shapePatterns.has(serialized)) shapePatterns.set(serialized, []);
    shapePatterns.get(serialized)!.push(k);
  }
  const dedupDefs: Record<string, EmittedSchema> = {};
  let dedupCount = 0;
  for (const [shape, methodKeys] of shapePatterns) {
    if (methodKeys.length < 3) continue;  // needs at least 3 uses to be worth the indirection
    const defName = `_p${dedupCount++}`;
    dedupDefs[defName] = JSON.parse(shape);
    for (const mk of methodKeys) {
      const entry = vp[mk];
      const replacement: EmittedSchema = { $ref: `#/$defs/${defName}` };
      for (const f of METADATA_FIELDS) {
        if (entry[f] !== undefined) replacement[f] = entry[f];
      }
      vp[mk] = replacement;
    }
  }

  const methodSchemaRefs: Record<string, EmittedSchema> = {};
  const primaryValueRefs: Record<string, EmittedSchema> = {};
  for (const methodKey of Object.keys(byKey)) {
    methodSchemaRefs[methodKey] = { $ref: `#/byKey/${methodKey}` };
    primaryValueRefs[methodKey] = { $ref: `#/vp/${methodKey}` };
  }

  const exprFlatProperties: Record<string, EmittedSchema> = {};
  const exprFlatDependentSchemas: Record<string, EmittedSchema> = {};
  for (const methodKey of Object.keys(byKey)) {
    exprFlatProperties[methodKey] = primaryValueRefs[methodKey];
    exprFlatDependentSchemas[methodKey] = methodSchemaRefs[methodKey];
  }
  for (const [name, info] of Object.entries(UNIVERSAL)) {
    exprFlatProperties[name] = {
      ...info.ref,
      markdownDescription: info.markdownDescription,
    };
  }

  // Default schema for keys not enumerated in `properties` — i.e. siblings of
  // a declared handler key, and any custom user keys. Array items use anyVal
  // rather than exprFlat so a numeric/string array like `[0.4, 0.25, 0.15, 1]`
  // (e.g. an RGBA tuple inside a `switch` `cases` value) passes through
  // anyVal's primitive branch. Object items still recurse into exprFlat.
  // Stored as a shared $defs entry referenced from exprFlat and every filtered
  // variant — saves ~1KB vs inlining.
  const additionalPropertiesDef: EmittedSchema = {
    anyOf: [
      { ...REF.exprFlat },
      { type: ["string", "number", "boolean", "null"] },
      { type: "array", items: { ...REF.anyVal } },
    ],
  };
  const additionalPropertiesRef: EmittedSchema = { $ref: "#/$defs/_addProps" };

  const exprFlat: EmittedSchema = {
    type: "object",
    properties: exprFlatProperties,
    additionalProperties: additionalPropertiesRef,
    dependentSchemas: exprFlatDependentSchemas,
  };

  // Per-output-type filtered exprFlat variants. Slots declared `type: T` route
  // to `exprFlat_T` for the expression-object branch, catching output-type
  // mismatches at validation time.
  //
  // For each known handler key in the filtered variant's properties:
  //   - matching output (T, "any", or absent → "any"): normal schema, included in dependentSchemas.
  //   - non-matching output: boolean `false` schema — any value fails.
  // Listing every known handler key (matching or not) prevents wrong-output-type
  // expressions from sneaking through `additionalProperties`.
  const OUTPUT_TYPES: JexsType[] = ["string", "number", "boolean", "array", "object", "null"];
  const filteredVariants: Record<string, EmittedSchema> = {};
  for (const target of OUTPUT_TYPES) {
    const props: Record<string, SchemaOrBool> = {};
    const deps: Record<string, EmittedSchema> = {};
    for (const [methodKey, m] of Object.entries(byKey)) {
      const out = m.output;
      if (out === undefined || out === "any" || out === target) {
        props[methodKey] = exprFlatProperties[methodKey];
        deps[methodKey] = methodSchemaRefs[methodKey];
      } else {
        props[methodKey] = false;
      }
    }
    // Universal keys (`as`, `catch`) apply regardless of output type.
    for (const [name, info] of Object.entries(UNIVERSAL)) {
      props[name] = {
        ...info.ref,
        markdownDescription: info.markdownDescription,
      };
    }
    filteredVariants[`exprFlat_${target}`] = {
      type: "object",
      properties: props,
      additionalProperties: additionalPropertiesRef,
      dependentSchemas: deps,
    };
  }

  // Strip build-only fields from emitted byKey entries: `output` drives the
  // filter-variant routing above, and `outputDescription` has already been
  // folded into the primary key's rich markdown — nothing reads either at
  // runtime.
  for (const m of Object.values(byKey)) {
    delete (m as { output?: unknown }).output;
    delete (m as { outputDescription?: unknown }).outputDescription;
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "jexs://combined",
    $defs: {
      ...sharedDefs,
      _addProps: additionalPropertiesDef,
      ...extraDefs,
      ...dedupDefs,
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
}
