/**
 * JSON Schema (draft 2020-12) validation for Router body/params and QueryNode
 * insert/update. Schemas are written as standard JSON Schema, the same dialect
 * the schema generator emits for combined.schema.json.
 *
 * Framework-agnostic: returns errors rather than throwing, so callers decide
 * how to surface them (HTTP 400 in Router, a plain Error in QueryNode).
 *
 * `strict: false` lets schemas carry keywords Ajv does not know (a table
 * document's `table`, `sqlType`, `x-entity`, ...) without rejecting them.
 */
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction, ErrorObject } from "ajv";

// ajv/dist/2020 and ajv-formats are CommonJS; under NodeNext the class/plugin
// are reached via the synthesized default's `.default`.
const Ajv2020 = AjvModule.default;
const addFormats = addFormatsModule.default;

/** How many compiled schemas a validation keeps before dropping the least recently used. */
export const MAX_COMPILED = 500;

/**
 * An Ajv instance and the validators compiled in it, by schema text, least
 * recently used first. Each node that validates holds its own (RouterNode for
 * route schemas, SchemaNode for table documents), so one resolver's schemas, and
 * their `$id`s, never meet another's in the same process.
 */
export interface Validation {
  readonly ajv: InstanceType<typeof Ajv2020>;
  readonly compiled: Map<string, ValidateFunction>;
}

export function createValidation(): Validation {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return { ajv, compiled: new Map() };
}

/**
 * The validator for `schema`, compiled in `validation`. Compiling checks the
 * schema itself, so a malformed one throws.
 *
 * Validators are kept by the schema's JSON text. Ajv keeps every schema object
 * it compiles, so it must only ever see one object per distinct schema: a route
 * handler written as an expression hands over an equal but new
 * `queryParams`/`body` object on every request, which would otherwise compile
 * again each time and throw on a reused `$id`. Keying on the text, and compiling
 * a copy made from it (Ajv's own cache is keyed by object), also means a schema
 * changed in place gets a validator for what it says now. Schemas that really
 * are new each time (one built from request data) would still grow the cache, so
 * it holds at most MAX_COMPILED, in order of use, and one dropped from it is
 * removed from Ajv as well.
 */
export function getValidator({ ajv, compiled }: Validation, schema: object): ValidateFunction {
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

function formatError(err: ErrorObject): string {
  const path = pathOf(err);
  return `${path ? `"${path}" ` : ""}${messageOf(err)}`;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate `data` against `schema`, returning a list of human-readable errors. */
export function validate(validation: Validation, schema: object, data: unknown): ValidationResult {
  const fn = getValidator(validation, schema);
  const valid = fn(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(formatError);
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
export function validateDetailed(validation: Validation, schema: object, data: unknown): DetailedValidationResult {
  const fn = getValidator(validation, schema);
  const valid = fn(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(err => ({ path: pathOf(err), message: messageOf(err), keyword: err.keyword }));
  return { valid: false, errors };
}
