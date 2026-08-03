import { Node, Context, NodeValue } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

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

  async "app-path"(def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { app } = await import("electron");
    return app.getPath(String(def["app-path"]) as Parameters<typeof app.getPath>[0]) as NodeValue;
  }
}
