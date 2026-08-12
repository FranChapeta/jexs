import { Node, Context, NodeValue, resolve } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

type AppPathName = Parameters<Electron.App["getPath"]>[0];

/** App lifecycle + well-known paths. */
export class AppNode extends Node {
  static schema: JexsNodeSchema = {
    "app-quit": {
      output: "null",
      markdownDescription: "Quit the application.",
      examples: ["{ \"app-quit\": true }"],
    },
    "app-path": {
      type: "string",
      output: "string",
      markdownDescription: "Resolve a well-known app path by name (e.g. `userData`, `home`, `documents`) — the place to keep save games.",
      examples: ["{ \"app-path\": \"userData\" }"],
    },
  };

  async "app-quit"(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { app } = await import("electron");
    app.quit();
    return null;
  }

  // The path name may itself be an expression, so resolve the value first.
  "app-path"(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["app-path"], context, async (name) => {
      const { app } = await import("electron");
      return app.getPath(String(name) as AppPathName) as NodeValue;
    });
  }
}
