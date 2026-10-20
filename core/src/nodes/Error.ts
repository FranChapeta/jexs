import { Node, Context, NodeValue } from "./Node.js";
import { resolveAll } from "../Resolver.js";
import { createHttpError } from "../errors.js";
import type { JexsNodeSchema } from "../schema.js";

export class ErrorNode extends Node {
  static schema: JexsNodeSchema = {
    error: {
      type: "number",
      markdownDescription: "Throws an HTTP error with the given status (100-599), aborting the current step sequence. A status that resolves to nothing is 500; one that is not an HTTP status is an error of its own.\nCaught by any ancestor step with a `\"$catch\"` array, or converted to an HTTP error response by the server.",
      outputDescription: "Never resolves to a value; it always throws. Control jumps to the nearest enclosing `$catch` (which receives `error`: `{ status, message }`), or the server turns it into an HTTP error response with that status.",
      examples: [
        "{ \"$error\": 403, \"message\": \"Permission denied\" }",
      ],
      siblings: {
        message: {
          type: "string",
          description: "Human-readable error message.",
        },
      },
    },
  };

  error(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$error, def.message], context, ([code, message]) => {
      // A status that resolves to nothing is a server error; any other has to be
      // one, so a mistyped status is reported rather than sent as a 500.
      if (code === undefined) throw createHttpError(500, String(message ?? ""));
      const status = typeof code === "number" ? code : typeof code === "string" && code.trim() !== "" ? Number(code) : NaN;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error(`$error status must be an HTTP status (100-599), got ${JSON.stringify(code)}`);
      }
      throw createHttpError(status, String(message ?? ""));
    });
  }
}
