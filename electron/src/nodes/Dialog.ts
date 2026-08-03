import { Node, Context, NodeValue } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** Element type of OpenDialogOptions.properties (the string-literal union). */
type OpenProp = NonNullable<Electron.OpenDialogOptions["properties"]>[number];

/**
 * Native file / message dialogs. The primary value is the dialog title / the
 * message; every other option is a flat sibling (no nested options object).
 */
export class DialogNode extends Node {
  static schema: JexsNodeSchema = {
    "dialog-open": {
      type: "string",
      output: "array",
      markdownDescription: "Show a native open dialog titled with the given string. Resolves to the array of selected paths (empty if cancelled).",
      examples: ["{ \"dialog-open\": \"Open save\", \"properties\": [\"openFile\"] }"],
      siblings: {
        properties: {
          type: "array",
          items: { type: "string", enum: ["openFile", "openDirectory", "multiSelections", "showHiddenFiles", "createDirectory"] },
          description: "What the dialog can select (e.g. openFile, openDirectory, multiSelections).",
        },
        filters: {
          type: "array",
          items: {
            properties: {
              name: { type: "string", description: "Label shown in the dialog's format dropdown." },
              extensions: { type: "array", items: { type: "string" }, description: "Matching extensions, no dot (\"*\" matches all)." },
            },
          },
          description: "File-type filters that populate the dialog's format dropdown.",
        },
        defaultPath: { type: "string", description: "Path the dialog opens at." },
      },
    },
    "dialog-message": {
      type: "string",
      output: "number",
      markdownDescription: "Show a native message box with the given message. Resolves to the index of the pressed button.",
      examples: ["{ \"dialog-message\": \"Quit game?\", \"buttons\": [\"Cancel\", \"Quit\"] }"],
      siblings: {
        buttons: { type: "array", items: { type: "string" }, description: "Button labels; the result is the pressed button's index." },
        type: { type: "string", enum: ["none", "info", "error", "question", "warning"], description: "Icon/style of the box." },
        title: { type: "string", description: "Window title of the box." },
        detail: { type: "string", description: "Extra detail text below the message." },
      },
    },
  };

  async "dialog-open"(def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { dialog } = await import("electron");
    const opts: Electron.OpenDialogOptions = {};
    if (typeof def["dialog-open"] === "string") opts.title = def["dialog-open"];
    if (typeof def.defaultPath === "string") opts.defaultPath = def.defaultPath;
    if (Array.isArray(def.properties)) {
      opts.properties = def.properties.filter((p): p is OpenProp => typeof p === "string");
    }
    if (Array.isArray(def.filters)) {
      opts.filters = def.filters.flatMap((f) =>
        this.isObject(f) && typeof f.name === "string" && Array.isArray(f.extensions)
          ? [{ name: f.name, extensions: f.extensions.map(String) }]
          : [],
      );
    }
    const res = await dialog.showOpenDialog(opts);
    return res.filePaths as NodeValue;
  }

  async "dialog-message"(def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { dialog } = await import("electron");
    const opts: Electron.MessageBoxOptions = {
      message: typeof def["dialog-message"] === "string" ? def["dialog-message"] : "",
    };
    if (Array.isArray(def.buttons)) opts.buttons = def.buttons.map(String);
    if (typeof def.title === "string") opts.title = def.title;
    if (typeof def.detail === "string") opts.detail = def.detail;
    if (def.type === "none" || def.type === "info" || def.type === "error" || def.type === "question" || def.type === "warning") {
      opts.type = def.type;
    }
    const res = await dialog.showMessageBox(opts);
    return res.response as NodeValue;
  }
}
