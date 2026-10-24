import fs from "fs/promises";
import path from "path";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction, ErrorObject } from "ajv";
import { Node, Context, NodeValue, isObject, isStep, resolve, resolveAll, resolverFor } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

// ajv/dist/2020 and ajv-formats are CommonJS; under NodeNext the class/plugin
// are reached via the synthesized default's `.default`.
const Ajv2020 = AjvModule.default;
const addFormats = addFormatsModule.default;

/** JSON Schema's own `$` keywords. An object with one is a schema written out,
 *  never a step, however it is otherwise shaped. */
const SCHEMA_KEYWORDS = ["$schema", "$id", "$ref", "$defs", "$anchor", "$dynamicRef", "$dynamicAnchor", "$vocabulary", "$comment"];

/** How many inline schemas a SchemaNode keeps compiled before dropping the least recently used. */
export const MAX_COMPILED = 500;

/** The id a table document is registered under, which the table and query ops look it up by. */
export function tableId(table: string): string {
  return `table/${table}`;
}

/** A table document: a `table` name and its column `properties`. */
export function isTableDocument(value: unknown): value is { table: string; properties: Record<string, unknown> } {
  return isObject(value) && typeof value.table === "string" && isObject(value.properties);
}

/**
 * A `schema` value, resolved once: a schema written out is kept as written, so
 * its `$` keywords stay JSON Schema's and a table document's `validator` stays
 * steps; a step producing one (`$var`, a `$file` with `data: true`) resolves to
 * it; a string names a registered schema.
 */
export async function schemaArg(value: unknown, context: Context): Promise<unknown> {
  const written = isObject(value) && SCHEMA_KEYWORDS.some(k => k in value);
  return isStep(value) && !written ? resolve(value, context) : value;
}

/** The resolver's SchemaNode, which route, table and `$schema` validation all go through. */
export function requireSchemaNode(context: Context): SchemaNode {
  const node = resolverFor(context).nodeFor("schema");
  if (!(node instanceof SchemaNode)) throw new Error("No SchemaNode in this resolver; build it with serverNodes().");
  return node;
}

const result = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where, dotted; `\"\"` for the root." },
          message: { type: "string" },
          keyword: { type: "string", description: "The JSON Schema keyword that failed." },
        },
      },
    },
  },
} as const;

export class SchemaNode extends Node {
  static schemaDefs: Record<string, Record<string, unknown>> = {
    // A schema written out (no `$` key, or one of JSON Schema's own), or a step
    // producing one.
    _schemaDocument: {
      if: {
        type: "object",
        anyOf: [{ propertyNames: { not: { pattern: "^\\$" } } }, ...SCHEMA_KEYWORDS.map(k => ({ required: [k] }))],
      },
      then: { type: "object" },
      else: { $ref: "#/$defs/exprFlat" },
    },
    // A registered schema's id, or a schema as `_schemaDocument` takes it.
    _schemaOrId: {
      if: { type: "string" },
      then: { type: "string" },
      else: { $ref: "#/$defs/_schemaDocument" },
    },
  };

  static schema: JexsNodeSchema = {
    schema: {
      type: "string",
      enum: ["register", "unregister", "list", "validate"],
      markdownDescription: "JSON Schema (draft 2020-12): registered schemas, which route bodies, table rows and other schemas can `$ref` by id, and checking a value against one. A table document registers as `table/<name>`; `$tableCreate` and `$tableSync` register theirs themselves.",
      examples: [
        "{ \"$schema\": \"register\", \"path\": \"db/schemas\" }",
        "{ \"$schema\": \"validate\", \"schema\": \"table/users\", \"data\": { \"$var\": \"request.body\" } }",
      ],
      variants: {
        register: {
          output: { type: "array", items: { type: "string" } },
          outputDescription: "The ids it registered.",
          markdownDescription: "Registers a `schema`, or every document in a `path` directory, under its `$id` (a table document under `table/<name>`), replacing what was there.",
          siblings: {
            schema: { $ref: "#/$defs/_schemaDocument", literal: true, description: "A schema with an `$id`, or a table document, written out or from a step (`$file` with `data: true`)." },
            path: { type: "string", description: "Directory of schema documents to register." },
          },
        },
        unregister: {
          output: "boolean",
          outputDescription: "Whether something was registered under the id.",
          markdownDescription: "Forgets a registered schema. A table's document going leaves the table as it is; query writes to it are just no longer checked.",
          siblings: { id: { type: "string", required: true, description: "The schema's id, `table/<name>` for a table." } },
        },
        list: {
          output: { type: "array", items: { type: "object" } },
          outputDescription: "Copies of the registered documents, as they were written.",
          markdownDescription: "Lists the registered schemas.",
        },
        validate: {
          output: result,
          outputDescription: "Whether the data is valid, and why not when it isn't.",
          markdownDescription: "Checks `data` against a schema: a registered one by id, or one written out. Returns the result rather than throwing for invalid data, so the caller decides what that means. An unknown id or a schema that does not compile is the caller's mistake, and an error.",
          siblings: {
            schema: { $ref: "#/$defs/_schemaOrId", literal: true, required: true, description: "A registered schema's id, or a schema. One written out compiles once per distinct schema, inline or by `$var`." },
            data: { description: "The value to check." },
          },
        },
      },
    },
  };

  /**
   * The resolver's one Ajv: route, table and `$schema` schemas all compile here,
   * so registered ones can be `$ref`d from any of them, while one resolver's
   * schemas, and their `$id`s, never meet another's in the same process.
   * `strict: false` lets schemas carry keywords Ajv does not know (a table
   * document's `table`, `sqlType`, ...) without rejecting them.
   */
  readonly ajv = new Ajv2020({ allErrors: true, strict: false });

  /** Inline schemas compiled in `ajv`, by their JSON text, least recently used first. */
  readonly compiled = new Map<string, ValidateFunction>();

  /** Registered documents by id, as written. Ajv keeps its own compiled copies,
   *  but cannot list them. */
  readonly documents = new Map<string, Record<string, unknown>>();

  private root: string;

  constructor(root: string = "src") {
    super();
    this.root = root;
    addFormats(this.ajv);
  }

  schema(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$schema, context, async op => {
      switch (op) {
        case "register": {
          const docs = await documentsOf(def, context, this.root);
          return docs.map(doc => SchemaNode.register(this, doc));
        }
        case "unregister":
          return resolve(def.id, context, id => SchemaNode.unregister(this, String(id)));
        case "list":
          // Copies: a step that changes what it reads must not change the registry.
          return Array.from(this.documents.values(), doc => structuredClone(doc));
        case "validate":
          return check(this, def, context);
        default:
          throw new Error(`$schema: unknown operation ${JSON.stringify(op)}`);
      }
    });
  }

  // API for the other nodes. Statics rather than methods, since every method on
  // a Node registers as an op.

  /**
   * Register `doc` under its id, replacing what was there, and return the id.
   * It compiles now, so a malformed one throws here and stays unregistered.
   * Inline schemas compiled against what was there are dropped, to compile again
   * against this one; another registered schema that `$ref`s it keeps the old
   * one until it is registered again.
   */
  static register(node: SchemaNode, doc: unknown): string {
    if (!isObject(doc)) throw new Error("A schema to register must be an object");
    const own = structuredClone(doc);
    const declared = own.$id;
    let id: string;
    if (isTableDocument(own)) {
      if (declared !== undefined) {
        throw new Error(`Table "${own.table}" is registered as "${tableId(own.table)}"; leave \`$id\` out of a table document`);
      }
      id = tableId(own.table);
    } else if (typeof declared === "string" && declared !== "") {
      id = declared;
    } else {
      throw new Error("A schema needs an `$id` to be registered (a table document is registered by its `table`)");
    }
    SchemaNode.unregister(node, id);
    node.ajv.addSchema({ ...own, $id: id });
    try {
      node.ajv.getSchema(id);
    } catch (error) {
      node.ajv.removeSchema(id);
      throw error;
    }
    node.documents.set(id, own);
    return id;
  }

  /** Forget the schema registered as `id`, and the inline schemas compiled against it. */
  static unregister(node: SchemaNode, id: string): boolean {
    node.ajv.removeSchema(id);
    for (const fn of node.compiled.values()) {
      if (typeof fn.schema === "object") node.ajv.removeSchema(fn.schema);
    }
    node.compiled.clear();
    return node.documents.delete(id);
  }

  /** The registered documents whose id starts with `prefix`. */
  static all(node: SchemaNode, prefix = ""): Record<string, unknown>[] {
    return [...node.documents].filter(([id]) => id.startsWith(prefix)).map(([, doc]) => doc);
  }
}

/**
 * The validator for `schema`: the one registered under that id when it is a
 * string, else the schema compiled in the node's Ajv. Compiling checks the
 * schema itself, so a malformed one throws.
 *
 * An inline schema is kept by its JSON text. Ajv keeps every schema object it
 * compiles, so it must only ever see one object per distinct schema: a route
 * handler written as an expression hands over an equal but new
 * `queryParams`/`body` object on every request, which would otherwise compile
 * again each time and throw on a reused `$id`. Keying on the text, and compiling
 * a copy made from it (Ajv's own cache is keyed by object), also means a schema
 * changed in place gets a validator for what it says now. Schemas that really
 * are new each time (one built from request data) would still grow the cache, so
 * it holds at most MAX_COMPILED, in order of use, and one dropped from it is
 * removed from Ajv as well.
 */
export function getValidator({ ajv, compiled }: SchemaNode, schema: object | string): ValidateFunction {
  if (typeof schema === "string") {
    const registered = ajv.getSchema(schema);
    if (!registered) throw new Error(`No schema is registered as "${schema}"`);
    return registered;
  }
  const key = JSON.stringify(schema);
  const kept = compiled.get(key);
  if (kept) {
    compiled.delete(key);
    compiled.set(key, kept);
    return kept;
  }
  const fn = ajv.compile(JSON.parse(key) as object);
  compiled.set(key, fn);
  if (compiled.size > MAX_COMPILED) {
    const [oldestKey, oldest] = compiled.entries().next().value!;
    compiled.delete(oldestKey);
    if (typeof oldest.schema === "object") ajv.removeSchema(oldest.schema);
  }
  return fn;
}

/** An error's instance path, dotted, `""` for the document root. */
function pathOf(err: ErrorObject): string {
  return err.instancePath ? err.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";
}

/** An error's message, naming the property where Ajv's own leaves it out. */
function messageOf(err: ErrorObject): string {
  const { additionalProperty, propertyName } = err.params;
  if (err.keyword === "additionalProperties" && typeof additionalProperty === "string") {
    return `must not have property "${additionalProperty}"`;
  }
  if (err.keyword === "propertyNames" && typeof propertyName === "string") {
    return `must not have a property named "${propertyName}"`;
  }
  if (err.keyword === "false schema") return "is not allowed here";
  // A failure inside `propertyNames` is about one name, held on the error itself.
  if (err.propertyName !== undefined) return `property name "${err.propertyName}" ${err.message ?? "is invalid"}`;
  return err.message ?? "is invalid";
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate `data` against `schema` (a document, or a registered id), returning
 * a list of human-readable errors rather than throwing, so callers decide how
 * to surface them: an HTTP 400 for a route, an Error for a table row.
 */
export function validate(node: SchemaNode, schema: object | string, data: unknown): ValidationResult {
  const fn = getValidator(node, schema);
  const valid = fn(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(err => {
    const where = pathOf(err);
    return `${where ? `"${where}" ` : ""}${messageOf(err)}`;
  });
  return { valid: false, errors };
}

/** One error, with the pieces a caller needs to rank or filter it. */
export interface DetailedError {
  /** Dotted instance path, `""` for the document root. */
  path: string;
  message: string;
  /** The Ajv keyword that failed, e.g. `"type"`, `"anyOf"`, `"additionalProperties"`. */
  keyword: string;
}

export interface DetailedValidationResult {
  valid: boolean;
  errors: DetailedError[];
}

/**
 * Validate, keeping each error's path and keyword separate rather than flattened
 * into prose.
 *
 * `validate` above is right for a handful of errors on a small table row. A
 * document validated against a large `anyOf` union produces hundreds, most of
 * them the union's own bookkeeping, and the only way to reduce that to the few
 * that name the actual mistake is to rank by path depth and drop the combinator
 * keywords, neither of which survives being formatted into a string.
 */
export function validateDetailed(node: SchemaNode, schema: object | string, data: unknown): DetailedValidationResult {
  const fn = getValidator(node, schema);
  const valid = fn(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(err => ({ path: pathOf(err), message: messageOf(err), keyword: err.keyword }));
  return { valid: false, errors };
}

/** `validate`: check `data` against a registered schema or one written out. */
async function check(node: SchemaNode, def: Record<string, unknown>, context: Context): Promise<unknown> {
  const schema = await schemaArg(def.schema, context);
  return resolveAll([def.data ?? null], context, ([data]) => {
    if (typeof schema !== "string" && !isObject(schema)) {
      throw new Error("$schema validate needs `schema`: a registered schema's id, or a schema");
    }
    // An unknown id or a schema that won't compile is the caller's mistake, not
    // the data's, so it throws rather than reading as invalid data.
    return validateDetailed(node, schema, data);
  });
}

/**
 * The documents a `register` was given: its `schema`, or every JSON file in its
 * `path` directory, in name order.
 */
async function documentsOf(def: Record<string, unknown>, context: Context, root: string): Promise<unknown[]> {
  if (def.schema !== undefined) return [await schemaArg(def.schema, context)];
  const dir = await resolve(def.path ?? null, context);
  if (typeof dir !== "string") throw new Error("$schema register needs a `schema` or a `path`");
  const dirPath = path.resolve(root, dir);
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith(".json")).sort();
  return Promise.all(files.map(async file => {
    const content = await fs.readFile(path.join(dirPath, file), "utf-8");
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`$schema register: ${path.join(dir, file)} is not valid JSON: ${(error as Error).message}`);
    }
  }));
}
