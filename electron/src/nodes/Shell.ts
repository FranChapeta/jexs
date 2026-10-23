import { Node, Context, NodeValue, createHttpError, resolve } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/**
 * Schemes `shellOpen` will hand to the OS.
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

/** Whether `shellOpen` may hand this URL to the desktop. */
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
    shellOpen: {
      type: "string",
      output: "null",
      markdownDescription:
        "Open a URL in the user's default browser, or a `mailto:` in their mail client.\nOnly `http`, `https` and `mailto` are allowed. Anything else is refused, because this asks the OS to launch whatever is registered for the scheme — a `file://` URL runs an executable on Windows, and a custom protocol reaches any app that claimed it.\nTo open a local file with its default application, use `shellOpenPath`.",
      examples: ["{ \"$shellOpen\": \"https://example.com/docs\" }"],
    },
    shellOpenPath: {
      type: "string",
      output: "null",
      markdownDescription: "Open a local file or folder with whatever application owns that type.\nThrows if the OS could not open it, so handle that with a `$catch` rather than a return value.",
      examples: ["{ \"$shellOpenPath\": { \"$var\": \"savePath\" }, \"$catch\": [{ \"$dialogMessage\": \"Could not open the file\" }] }"],
    },
    shellShow: {
      type: "string",
      output: "null",
      markdownDescription: "Reveal a file in the system file manager, selected — Explorer on Windows, Finder on macOS.",
      examples: ["{ \"$shellShow\": { \"$var\": \"savePath\" } }"],
    },
    shellTrash: {
      type: "string",
      output: "null",
      markdownDescription: "Move a file or folder to the Recycle Bin or Trash. Recoverable by the user, unlike deleting it.\nThrows if the OS refused — a locked file, a missing path, no permission — so handle that with a `$catch`.",
      examples: ["{ \"$shellTrash\": { \"$var\": \"oldSave\" }, \"$catch\": [{ \"$notify\": \"Could not move it to the bin\" }] }"],
    },
    shellBeep: {
      output: "null",
      markdownDescription: "Play the system beep.",
      examples: ["{ \"$shellBeep\": true }"],
    },
  };

  shellOpen(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$shellOpen, context, async (value) => {
      const url = this.toString(value);
      if (!isSafeExternal(url)) {
        throw createHttpError(
          400,
          `shellOpen refused "${url}": only http, https and mailto may be handed to the desktop. ` +
            `Use shellOpenPath to open a local file.`,
        );
      }
      const { shell } = await import("electron");
      await shell.openExternal(url);
      return null;
    });
  }

  shellOpenPath(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$shellOpenPath, context, async (value) => {
      const path = this.toString(value);
      const { shell } = await import("electron");
      // Electron reports failure by RETURNING the reason rather than throwing.
      // Convert it, so the caller handles this the way it handles every other
      // failure -- with `$catch` -- instead of remembering that an empty string
      // means success here and nowhere else.
      const reason = await shell.openPath(path);
      if (reason) throw createHttpError(500, `could not open "${path}": ${reason}`);
      return null;
    });
  }

  shellShow(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$shellShow, context, async (value) => {
      const { shell } = await import("electron");
      shell.showItemInFolder(this.toString(value));
      return null;
    });
  }

  shellTrash(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$shellTrash, context, async (value) => {
      const { shell } = await import("electron");
      await shell.trashItem(this.toString(value));
      return null;
    });
  }

  async shellBeep(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { shell } = await import("electron");
    shell.beep();
    return null;
  }
}
