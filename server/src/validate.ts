/**
 * Shared JSON Schema (draft 2020-12) validator.
 *
 * A single Ajv2020 instance reused for both Router body/params validation and
 * QueryNode insert/update validation. Schemas are written as standard JSON
 * Schema — the same dialect the schema generator emits for combined.schema.json.
 *
 * Framework-agnostic: returns errors rather than throwing, so callers decide
 * how to surface them (HTTP 400 in Router, a plain Error in QueryNode).
 *
 * `strict: false` lets schemas carry custom annotation keywords (e.g. table
 * schemas' `x-db` / `x-entity`) without Ajv rejecting them.
 */
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction, ErrorObject } from "ajv";

// ajv/dist/2020 and ajv-formats are CommonJS; under NodeNext the class/plugin
// are reached via the synthesized default's `.default`.
const Ajv2020 = AjvModule.default;
const addFormats = addFormatsModule.default;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/** Compiled validators cached by schema-object identity. Route/table schema
 *  objects are stable after load, so each compiles once. Compilation also
 *  validates the schema itself — a malformed schema throws here. */
const cache = new WeakMap<object, ValidateFunction>();

export function getValidator(schema: object): ValidateFunction {
  const cached = cache.get(schema);
  if (cached) return cached;
  const fn = ajv.compile(schema);
  cache.set(schema, fn);
  return fn;
}

function formatError(err: ErrorObject): string {
  const path = err.instancePath ? err.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";
  const where = path ? `"${path}" ` : "";
  return `${where}${err.message ?? "is invalid"}`.trim();
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate `data` against `schema`, returning a list of human-readable errors. */
export function validate(schema: object, data: unknown): ValidationResult {
  const fn = getValidator(schema);
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
export function validateDetailed(schema: object, data: unknown): DetailedValidationResult {
  const fn = getValidator(schema);
  const valid = fn(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(err => ({
    path: err.instancePath ? err.instancePath.replace(/^\//, "").replace(/\//g, ".") : "",
    message: err.message ?? "is invalid",
    keyword: err.keyword,
  }));
  return { valid: false, errors };
}
