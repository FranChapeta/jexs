import { Node, Context, NodeValue, resolveFields, isObject } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** Element type of OpenDialogOptions.properties (the string-literal union). */
type OpenProp = NonNullable<Electron.OpenDialogOptions["properties"]>[number];

const MESSAGE_TYPES = ["none", "info", "error", "question", "warning"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];

/** Build OpenDialogOptions from resolved siblings. Pure — no electron runtime. */
export function openDialogOptions(r: Record<string, unknown>): Electron.OpenDialogOptions {
  const opts: Electron.OpenDialogOptions = {};
  if (typeof r.$dialogOpen === "string") opts.title = r.$dialogOpen;
  if (typeof r.defaultPath === "string") opts.defaultPath = r.defaultPath;
  if (Array.isArray(r.properties)) {
    opts.properties = r.properties.filter((p): p is OpenProp => typeof p === "string");
  }
  if (Array.isArray(r.filters)) {
    opts.filters = r.filters.flatMap((f) =>
      isObject(f) && typeof f.name === "string" && Array.isArray(f.extensions)
        ? [{ name: f.name, extensions: f.extensions.map(String) }]
        : [],
    );
  }
  return opts;
}

/** Build SaveDialogOptions from resolved siblings. Pure — no electron runtime. */
export function saveDialogOptions(r: Record<string, unknown>): Electron.SaveDialogOptions {
  const opts: Electron.SaveDialogOptions = {};
  if (typeof r.$dialogSave === "string") opts.title = r.$dialogSave;
  if (typeof r.defaultPath === "string") opts.defaultPath = r.defaultPath;
  if (typeof r.buttonLabel === "string") opts.buttonLabel = r.buttonLabel;
  if (Array.isArray(r.filters)) {
    opts.filters = r.filters.flatMap((f) =>
      isObject(f) && typeof f.name === "string" && Array.isArray(f.extensions)
        ? [{ name: f.name, extensions: f.extensions.map(String) }]
        : [],
    );
  }
  return opts;
}

/** Build MessageBoxOptions from resolved siblings. Pure — no electron runtime. */
export function messageBoxOptions(r: Record<string, unknown>): Electron.MessageBoxOptions {
  const opts: Electron.MessageBoxOptions = {
    message: typeof r.$dialogMessage === "string" ? r.$dialogMessage : "",
  };
  if (Array.isArray(r.buttons)) opts.buttons = r.buttons.map(String);
  if (typeof r.title === "string") opts.title = r.title;
  if (typeof r.detail === "string") opts.detail = r.detail;
  if (MESSAGE_TYPES.includes(r.type as MessageType)) opts.type = r.type as MessageType;
  return opts;
}

/**
 * Native file / message dialogs. The primary value is the dialog title / the
 * message; every other option is a flat sibling (no nested options object).
 */
export class DialogNode extends Node {
  static schema: JexsNodeSchema = {
    dialogOpen: {
      type: "string",
      output: { type: "array", items: { type: "string" } },
      markdownDescription: "Show a native open dialog titled with the given string. Resolves to the array of selected paths (empty if cancelled).",
      examples: ["{ \"$dialogOpen\": \"Open save\", \"properties\": [\"openFile\"] }"],
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
    dialogSave: {
      type: "string",
      output: "string",
      markdownDescription: "Show a native save dialog titled with the given string. Resolves to the chosen path, or an empty string if the user cancelled.",
      outputDescription: "The path the user chose, or `\"\"` on cancel — so `empty` distinguishes the two without a separate flag.",
      examples: ["{ \"$dialogSave\": \"Save game\", \"defaultPath\": \"save.json\" }"],
      siblings: {
        defaultPath: { type: "string", description: "Path and filename the dialog opens with." },
        buttonLabel: { type: "string", description: "Label for the confirm button." },
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
      },
    },
    dialogMessage: {
      type: "string",
      output: "number",
      markdownDescription: "Show a native message box with the given message. Resolves to the index of the pressed button.",
      examples: ["{ \"$dialogMessage\": \"Quit game?\", \"buttons\": [\"Cancel\", \"Quit\"] }"],
      siblings: {
        buttons: { type: "array", items: { type: "string" }, description: "Button labels; the result is the pressed button's index." },
        type: { type: "string", enum: ["none", "info", "error", "question", "warning"], description: "Icon/style of the box." },
        title: { type: "string", description: "Window title of the box." },
        detail: { type: "string", description: "Extra detail text below the message." },
      },
    },
  };

  // Siblings arrive unresolved, so resolve the whole def before building options.
  dialogOpen(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, async (r) => {
      const { dialog } = await import("electron");
      const res = await dialog.showOpenDialog(openDialogOptions(r));
      return res.filePaths as NodeValue;
    });
  }

  dialogSave(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, async (r) => {
      const { dialog } = await import("electron");
      const res = await dialog.showSaveDialog(saveDialogOptions(r));
      // "" rather than null on cancel, so `empty` works and a path is always a
      // string — callers pass it straight to `file` without a type check.
      return res.canceled || !res.filePath ? "" : res.filePath;
    });
  }

  dialogMessage(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, async (r) => {
      const { dialog } = await import("electron");
      const res = await dialog.showMessageBox(messageBoxOptions(r));
      return res.response as NodeValue;
    });
  }
}
