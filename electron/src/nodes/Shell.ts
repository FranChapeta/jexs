import { Node, Context, NodeValue, createHttpError, resolve } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/**
 * Schemes `shell-open` will hand to the OS.
 *
 * This is a security boundary, not tidiness. `shell.openExternal` asks the
 * desktop to launch whatever is registered for a scheme, so on Windows a
 * `file://` URL runs an executable and a custom protocol reaches any app that
 * claimed it. A URL is exactly the kind of value that arrives from a page, a
 * config file, or a fetched document, so the default has to be narrow.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The scheme of a URL, or null when it does not parse as one. */
export function urlScheme(value: string): string | null {
  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

/** Whether `shell-open` may hand this URL to the desktop. */
export function isSafeExternal(value: string): boolean {
  const scheme = urlScheme(value);
  return scheme !== null && SAFE_SCHEMES.has(scheme);
}

/**
 * Electron's `shell` module: hand a URL or a file to the desktop environment and
 * let the OS pick the handler.
 *
 * Unrelated to a command shell despite the name — there are no pipes, no exit
 * code and no output, and you do not choose what runs.
 */
export class ShellNode extends Node {
  static schema: JexsNodeSchema = {
    "shell-open": {
      type: "string",
      output: "null",
      markdownDescription:
        "Open a URL in the user's default browser, or a `mailto:` in their mail client.\nOnly `http`, `https` and `mailto` are allowed. Anything else is refused, because this asks the OS to launch whatever is registered for the scheme — a `file://` URL runs an executable on Windows, and a custom protocol reaches any app that claimed it.\nTo open a local file with its default application, use `shell-open-path`.",
      examples: ["{ \"shell-open\": \"https://example.com/docs\" }"],
    },
    "shell-open-path": {
      type: "string",
      output: "null",
      markdownDescription: "Open a local file or folder with whatever application owns that type.\nThrows if the OS could not open it, so handle that with a `catch` rather than a return value.",
      examples: ["{ \"shell-open-path\": { \"var\": \"$savePath\" }, \"catch\": [{ \"dialog-message\": \"Could not open the file\" }] }"],
    },
    "shell-show": {
      type: "string",
      output: "null",
      markdownDescription: "Reveal a file in the system file manager, selected — Explorer on Windows, Finder on macOS.",
      examples: ["{ \"shell-show\": { \"var\": \"$savePath\" } }"],
    },
    "shell-trash": {
      type: "string",
      output: "null",
      markdownDescription: "Move a file or folder to the Recycle Bin or Trash. Recoverable by the user, unlike deleting it.\nThrows if the OS refused — a locked file, a missing path, no permission — so handle that with a `catch`.",
      examples: ["{ \"shell-trash\": { \"var\": \"$oldSave\" }, \"catch\": [{ \"notify\": \"Could not move it to the bin\" }] }"],
    },
    "shell-beep": {
      output: "null",
      markdownDescription: "Play the system beep.",
      examples: ["{ \"shell-beep\": true }"],
    },
  };

  ["shell-open"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["shell-open"], context, async (value) => {
      const url = this.toString(value);
      if (!isSafeExternal(url)) {
        throw createHttpError(
          400,
          `shell-open refused "${url}": only http, https and mailto may be handed to the desktop. ` +
            `Use shell-open-path to open a local file.`,
        );
      }
      const { shell } = await import("electron");
      await shell.openExternal(url);
      return null;
    });
  }

  ["shell-open-path"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["shell-open-path"], context, async (value) => {
      const path = this.toString(value);
      const { shell } = await import("electron");
      // Electron reports failure by RETURNING the reason rather than throwing.
      // Convert it, so the caller handles this the way it handles every other
      // failure -- with `catch` -- instead of remembering that an empty string
      // means success here and nowhere else.
      const reason = await shell.openPath(path);
      if (reason) throw createHttpError(500, `could not open "${path}": ${reason}`);
      return null;
    });
  }

  ["shell-show"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["shell-show"], context, async (value) => {
      const { shell } = await import("electron");
      shell.showItemInFolder(this.toString(value));
      return null;
    });
  }

  ["shell-trash"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["shell-trash"], context, async (value) => {
      const { shell } = await import("electron");
      await shell.trashItem(this.toString(value));
      return null;
    });
  }

  async ["shell-beep"](_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { shell } = await import("electron");
    shell.beep();
    return null;
  }
}
