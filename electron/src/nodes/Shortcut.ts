import { Node, Context, NodeValue, childContext, resolve, runSteps } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** Accelerator -> the steps it runs, so a re-registration replaces cleanly. */
const registered = new Map<string, { steps: unknown[]; context: Context }>();

/** Test seam. */
export function resetShortcuts(): void {
  registered.clear();
}

export class ShortcutNode extends Node {
  static schema: JexsNodeSchema = {
    shortcut: {
      type: "string",
      output: "boolean",
      markdownDescription:
        "Register a **system-wide** keyboard shortcut, which fires even when the app is not focused.\nFor shortcuts that should only work inside your own window, use a `keydown` handler in the page's `events` map instead — those do not steal the key from every other application.\nSteps run in the main process. Since a global shortcut usually fires while another app has focus, DOM ops inside them target the default window rather than the focused one.",
      outputDescription: "`true` if the OS accepted the registration. `false` means another application already owns that combination.",
      examples: [
        "{ \"shortcut\": \"CommandOrControl+Shift+K\", \"do\": [{ \"window-focus\": \"main\" }] }",
      ],
      siblings: {
        do: { steps: true, description: "Steps run in the main process when the shortcut fires." },
      },
    },
    "shortcut-remove": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Unregister one accelerator, or every one when given `true`.",
      examples: ["{ \"shortcut-remove\": \"CommandOrControl+Shift+K\" }", "{ \"shortcut-remove\": true }"],
    },
  };

  // `do` stays raw; only the accelerator resolves.
  shortcut(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.shortcut, context, async (value) => {
      const accelerator = typeof value === "string" ? value : "";
      if (!accelerator || !Array.isArray(def.do)) return false;

      const { globalShortcut } = await import("electron");
      // Re-registering the same combination replaces its handler rather than
      // stacking a second one.
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);

      const steps = def.do;
      const ok = globalShortcut.register(accelerator, () => {
        const entry = registered.get(accelerator);
        if (!entry) return;
        Promise.resolve(runSteps(entry.steps, childContext(entry.context, { accelerator })))
          .catch((err: unknown) => {
            console.error(`[ShortcutNode] "${accelerator}" failed:`, err);
          });
      });

      if (ok) registered.set(accelerator, { steps, context });
      else console.warn(`[ShortcutNode] the OS refused "${accelerator}" — another app likely owns it`);
      return ok;
    });
  }

  ["shortcut-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["shortcut-remove"], context, async (value) => {
      const { globalShortcut } = await import("electron");
      if (typeof value === "string" && value !== "") {
        globalShortcut.unregister(value);
        registered.delete(value);
      } else {
        globalShortcut.unregisterAll();
        registered.clear();
      }
      return null;
    });
  }
}
