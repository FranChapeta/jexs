import { Node, Context, NodeValue } from "./Node.js";
import { resolveAll } from "../Resolver.js";
import { createHttpError } from "../errors.js";
import type { JexsNodeSchema } from "../schema.js";

export class ErrorNode extends Node {
  static schema: JexsNodeSchema = {
    error: {
      type: "number",
      markdownDescription: "Throws an HTTP error, aborting the current step sequence.\nCaught by any ancestor step with a `\"catch\"` array, or converted to an HTTP error response by the server.",
      examples: [
        "{ \"error\": 403, \"message\": \"Permission denied\" }",
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
    return resolveAll([def.error, def.message ?? ""], context, ([code, message]) => {
      throw createHttpError(Number(code), String(message));
    });
  }
}
