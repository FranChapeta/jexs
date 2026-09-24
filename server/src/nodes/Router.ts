import { Node, Context, NodeValue, resolve, runSteps, createHttpError } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { validate } from "../validate.js";

/**
 * Route handler structure.
 *
 * `queryParams` and `body` are standard JSON Schema (draft 2020-12) objects,
 * validated by the shared Ajv validator against the request's query string /
 * parsed body. URL path params are matched and constrained structurally via
 * `paramName` / `paramRegex` at each route node, not by a handler schema.
 */
interface RouteHandler {
  file?: unknown;
  run?: unknown[];
  queryParams?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/**
 * Route node structure
 */
interface RouteNode {
  paramName?: string;
  paramRegex?: string;
  methods?: Record<string, RouteHandler>;
  children?: Record<string, RouteNode>;
  if?: unknown;
  else?: unknown;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return value !== null && value !== undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when `value` is shaped like a route tree (has structural route-tree keys
 * at the top level). Used to bypass `resolve()` for literal trees — otherwise
 * the resolver would walk into them and eagerly evaluate `{ "file": "..." }`
 * leaves into rendered HTML before the matcher ever sees them.
 *
 * Expression values (e.g. `{ "var": "$routes" }`, `{ "file": "...", "data": true }`)
 * don't have these markers and still flow through `resolve()` below.
 */
function isRouteTreeShape(value: unknown): value is RouteNode {
  if (!isObject(value)) return false;
  return "methods" in value || "children" in value
      || "paramName" in value || "paramRegex" in value;
}

const regexCache = new Map<string, RegExp>();
function getCachedRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern}$`);
    regexCache.set(pattern, re);
  }
  return re;
}

/**
 * RouterNode - Handles route matching and execution.
 *
 * Matches when definition has "routes" key:
 * {
 *   "routes": {
 *     "login": { "methods": { "GET": { "file": "..." } } },
 *     "*": { "paramName": "id", "methods": { ... } }
 *   }
 * }
 *
 * Uses request path and method from context to find matching route,
 * then executes the handler's run steps.
 */
export class RouterNode extends Node {
  static schema: JexsNodeSchema = {
    routes: {
      $ref: "#/$defs/_routesSlot",
      markdownDescription: "Matches the incoming request path and method against a route tree, then executes the handler.\nSupports exact segments, `*` (single param with optional `paramName`/`paramRegex`),\n`**` (catch-all), conditional `\"if\"` guards per node, and `queryParams`/`body` validation.\n\nA handler is a `file` to render or a `run` of steps, never both, or an expression resolving to one of those. A `WS` handler completes a WebSocket upgrade by calling `socket-accept` as a `run` step.",
      outputDescription: "The matched handler's result. A `file`/`run` step that renders to a string is wrapped as `{ response: <html> }`; a handler that returns an object passes it through unchanged, as either a response envelope (`{ response, responseStatus, responseType, responseHeaders }`) or a bare JSON value. Throws a 404 HTTP error when no route matches, so use a catch-all route (`**`) or wrap calls in `catch` to handle not-found.",
      examples: [
        "{ \"routes\": { \"children\": { \"users\": { \"methods\": { \"GET\": { \"file\": \"pages/users.json\" } } } } } }",
      ],
    },
  };

  static schemaDefs = {
    _routesSlot: {
      if: {
        anyOf: [
          { required: ["methods"] },   { required: ["children"] },
          { required: ["paramName"] }, { required: ["paramRegex"] },
        ],
      },
      then: { $ref: "#/$defs/_routeNode" },
      else: { $ref: "#/$defs/exprFlat" },
    },
    _routeNode: {
      type: "object",
      properties: {
        paramName:  { type: "string" },
        paramRegex: { type: "string" },
        methods:    { $ref: "#/$defs/_routeMethods" },
        children:   { type: "object", additionalProperties: { $ref: "#/$defs/_routeNode" } },
        if:    {},
        else:  {},
      },
      additionalProperties: { $ref: "#/$defs/_routeNode" },
    },
    _routeMethods: {
      type: "object",
      patternProperties: {
        "^(GET|POST|PUT|DELETE|PATCH|WS|HEAD|OPTIONS)$": { $ref: "#/$defs/_routeHandler" },
      },
      additionalProperties: false,
    },
    _routeHandler: {
      type: "object",
      properties: {
        // FileNode resolves this value, so it takes an expression too.
        file:    { $ref: "#/$defs/strOrExpr" },
        run:     { $ref: "#/$defs/steps" },
        // `queryParams`/`body` values are themselves JSON Schemas — describe them with
        // the 2020-12 meta-schema so editors give full JSON-Schema autocomplete
        // inside them (NOT exprFlat: these are static author-time schemas).
        queryParams: { $ref: "#/$defs/_jsonSchema" },
        body:        { $ref: "#/$defs/_jsonSchema" },
      },
      // One node to an object: a handler is a template, a step list or a bare
      // expression, never two. A step list already covers both, file last:
      //   { "run": [ { …, "as": "user" }, { "file": "pages/user.json" } ] }
      not: { required: ["file", "run"] },
    },
    _jsonSchema: { $ref: "https://json-schema.org/draft/2020-12/schema" },
  };

  routes(def: Record<string, unknown>, context: Context): NodeValue {
    const dispatch = async (rootNode: unknown): Promise<NodeValue> => {
      if (!isObject(rootNode)) {
        console.error("[RouterNode] Invalid routes definition");
        return null;
      }
      const method = context.request?.method?.toUpperCase() ?? "GET";
      const path = context.request?.path ?? "/";
      const handler = await matchRoute(
        rootNode as RouteNode,
        path,
        method,
        context,
      );
      if (!handler) throw createHttpError(404, "Not Found");
      if (isHandlerShape(handler)) return executeHandler(handler, context);

      // Not a `file`/`run` object, so the handler is an expression that has to
      // produce one. What it produces is the handler, `queryParams` and `body`
      // included, and takes the same path as an inline object.
      return resolve(handler, context, value => {
        if (!isHandlerShape(value)) {
          throw createHttpError(500, `${method} ${path}: a route handler must be, or resolve to, a "file" or "run" object`);
        }
        return executeHandler(value, context);
      }) as NodeValue;
    };

    // Fast path: the value is already a literal route tree. Skip resolve() —
    // otherwise it would walk in and turn { "file": "..." } handler leaves
    // into rendered HTML before the matcher ever runs.
    if (isRouteTreeShape(def.routes)) {
      return dispatch(def.routes);
    }
    // Expression path: e.g. { "var": "$routes" } or { "file": "routes.json", "data": true }.
    return resolve(def.routes, context, dispatch);
  }
}

/**
 * Match route against path starting from root node.
 * Conditions are evaluated during traversal, params set on context.
 */
async function matchRoute(
  root: RouteNode,
  urlPath: string,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  const segments = urlPath.split("/").filter(Boolean);

  // If path is "/" (no segments), check root methods
  if (segments.length === 0) {
    if (await checkConditionFails(root, context)) return null;
    return root.methods?.[method] ?? null;
  }

  // Match segments starting from root's children
  if (root.children) {
    return matchSegments(root.children, segments, 0, method, context);
  }

  return null;
}

/**
 * Recursively match segments against children
 */
async function matchSegments(
  children: Record<string, RouteNode>,
  segments: string[],
  index: number,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  const segment = segments[index];

  // 1. Try exact match
  if (segment in children) {
    const node = children[segment];
    const result = await matchNode(node, segments, index, method, context);
    if (result) return result;
  }

  // 2. Try * (single param)
  if ("*" in children) {
    const node = children["*"];

    // Check regex constraint
    if (node.paramRegex) {
      const regex = getCachedRegex(node.paramRegex);
      if (!regex.test(segment)) {
        return tryCatchAll(children, segments, index, method, context);
      }
    }

    // Capture param on context
    if (node.paramName) {
      context[node.paramName] = segment;
    }

    const result = await matchNode(node, segments, index, method, context);
    if (result) return result;
  }

  // 3. Try ** (catch-all)
  return tryCatchAll(children, segments, index, method, context);
}

/**
 * Try to match catch-all route
 */
async function tryCatchAll(
  children: Record<string, RouteNode>,
  segments: string[],
  index: number,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  if ("**" in children) {
    const node = children["**"];
    const rest = segments.slice(index).join("/");

    // Validate against paramRegex before capturing — a non-matching rest-path
    // means this catch-all does not apply (mirrors the `*` single-param check).
    if (node.paramRegex && !getCachedRegex(node.paramRegex).test(rest)) {
      return null;
    }

    // Capture rest of path
    if (node.paramName) {
      context[node.paramName] = rest;
    }

    if (await checkConditionFails(node, context)) return null;
    return node.methods?.[method] ?? null;
  }

  return null;
}

/**
 * Match a specific node (after segment matched).
 * Evaluates "if" condition before proceeding — stops early on failure.
 */
async function matchNode(
  node: RouteNode,
  segments: string[],
  index: number,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  if (await checkConditionFails(node, context)) return null;

  const nextIndex = index + 1;
  const isLast = nextIndex >= segments.length;

  if (isLast) {
    return node.methods?.[method] ?? null;
  }

  if (node.children) {
    return matchSegments(
      node.children,
      segments,
      nextIndex,
      method,
      context,
    );
  }

  return null;
}

/**
 * Returns true if the node has an "if" condition that evaluates to false.
 */
function checkConditionFails(node: RouteNode, context: Context): unknown {
  if (!node.if) return false;
  return resolve(node.if, context, result => !toBoolean(result));
}

/**
 * Execute route handler
 */
async function executeHandler(
  handler: RouteHandler,
  context: Context,
): Promise<unknown> {
  checkRequest(handler, context);

  if (Array.isArray(handler.run)) {
    const result = await Promise.resolve(runSteps(handler.run, context));
    return isResponse(result) ? result : asBody(result ?? null);
  }
  // A `file`, then, since `isHandlerShape` admits nothing else. Resolved through
  // the resolver so FileNode loads it and ElementNode renders it.
  return resolve(handler, context, asBody);
}

/**
 * The request checks a handler declares: a CSRF token on a state-changing
 * method, then its query/body schemas. Read from the handler that runs, so an
 * expression handler's come from whatever it resolved to.
 */
function checkRequest(handler: RouteHandler, context: Context): void {
  const CSRF_SAFE_METHODS = ["GET", "HEAD", "OPTIONS", "WS"];
  const reqMethod = context.request?.method?.toUpperCase() ?? "GET";
  const sessionToken = (context.session as Record<string, unknown> | undefined)?._csrf;
  if (!CSRF_SAFE_METHODS.includes(reqMethod) && sessionToken) {
    const submittedToken =
      (context.request?.body as Record<string, unknown> | undefined)?._csrf ??
      (context.request?.headers as Record<string, string | undefined> | undefined)?.["x-csrf-token"];
    if (!submittedToken || sessionToken !== submittedToken) {
      throw createHttpError(403, "CSRF token mismatch");
    }
  }

  if (handler.queryParams) {
    validateAgainstSchema(handler.queryParams, context.request?.query as Record<string, unknown> ?? {}, "query");
  }

  if (handler.body) {
    validateAgainstSchema(handler.body, context.request?.body as Record<string, unknown> ?? {}, "body");
  }
}

/** A string renders as HTML; anything else is sent as it stands. */
function asBody(value: unknown): unknown {
  return typeof value === "string" ? { response: value } : value;
}

/**
 * Validate a value against a JSON Schema (draft 2020-12) using the shared Ajv
 * validator. Used for both `params` and `body`. Throws a 400 HTTP error listing
 * the validation failures.
 */
function validateAgainstSchema(
  schema: Record<string, unknown>,
  source: Record<string, unknown>,
  label: string,
): void {
  const { valid, errors } = validate(schema, source);
  if (!valid) {
    throw createHttpError(400, `Invalid ${label}: ${errors.join("; ")}`);
  }
}

/**
 * A value the router can execute as a handler rather than send as a body. Tests
 * what the branches above actually act on, so a match always leaves by one of
 * them and the resolve below never reaches this function twice.
 */
function isHandlerShape(value: unknown): value is RouteHandler {
  return isObject(value) && (Array.isArray(value.run) || !!value.file);
}

/**
 * Check if result is a response object
 */
function isResponse(value: unknown): boolean {
  if (!isObject(value)) return false;
  return "response" in (value as Record<string, unknown>);
}
