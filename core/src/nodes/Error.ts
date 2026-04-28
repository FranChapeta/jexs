import { Node, Context, NodeValue } from "./Node.js";
import { resolveAll } from "../Resolver.js";
import { createHttpError } from "../errors.js";

export class ErrorNode extends Node {
  /**
   * Throws an HTTP error, aborting the current step sequence.
   * Caught by any ancestor step with a `"catch"` array, or converted to an HTTP error response by the server.
   *
   * @param {number} error HTTP status code (e.g. 403, 404, 500).
   * @param {string} message Human-readable error message.
   * @example
   * { "error": 403, "message": "Permission denied" }
   */
  error(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.error, def.message ?? ""], context, ([code, message]) => {
      throw createHttpError(Number(code), String(message));
    });
  }
}
