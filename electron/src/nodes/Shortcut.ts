import {
  Node, Context, NodeValue, childContext, resolve, runStepsDetached,
} from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

interface Registration { steps: unknown; context: Context; def: Record<string, unknown> }

/** Accelerator -> the steps it runs, so a re-registration replaces cleanly.
 *  Process-wide, like the OS shortcuts themselves. */
const registered = new Map<string, Registration>();

/** Test seam. */
export function resetShortcuts(): void {
  registered.clear();
}

export class ShortcutNode extends Node {
  /** The shortcuts this resolver registered. `dispose` unregisters each one
   *  still bound to its registration, leaving any another resolver has since
   *  taken over. */
  private readonly own = new Map<string, Registration>();
  private shortcuts: Electron.GlobalShortcut | null = null;

  dispose(): void {
    for (const [accelerator, registration] of this.own) {
      if (registered.get(accelerator) !== registration) continue;
      this.shortcuts?.unregister(accelerator);
      registered.delete(accelerator);
    }
    this.own.clear();
  }

  static schema: JexsNodeSchema = {
    shortcut: {
      type: "string",
      output: "boolean",
      markdownDescription:
        "Register a **system-wide** keyboard shortcut, which fires even when the app is not focused.\nFor shortcuts that should only work inside your own window, use a `keydown` handler in the page's `events` map instead — those do not steal the key from every other application.\nSteps run in the main process. Since a global shortcut usually fires while another app has focus, DOM ops inside them target the default window rather than the focused one.",
      outputDescription: "`true` if the OS accepted the registration. `false` means another application already owns that combination.",
      examples: [
        "{ \"$shortcut\": \"CommandOrControl+Shift+K\", \"do\": [{ \"$window-focus\": \"main\" }] }",
      ],
      siblings: {
        do: { steps: true, description: "Steps run in the main process when the shortcut fires." },
      },
    },
    "shortcut-remove": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Unregister one accelerator, or every one when given `true`.",
      examples: ["{ \"$shortcut-remove\": \"CommandOrControl+Shift+K\" }", "{ \"$shortcut-remove\": true }"],
    },
  };

  // `do` stays raw; only the accelerator resolves.
  shortcut(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$shortcut, context, async (value) => {
      const accelerator = typeof value === "string" ? value : "";
      if (!accelerator || def.do === undefined) return false;
      const steps = def.do;

      const { globalShortcut } = await import("electron");
      // Re-registering the same combination replaces its handler rather than
      // stacking a second one.
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);

      const ok = globalShortcut.register(accelerator, () => {
        // Looked up per fire rather than captured, so re-registering the same
        // accelerator swaps the handler instead of leaving the old one live.
        const entry = registered.get(accelerator);
        if (!entry) return;
        const ctx = childContext(entry.context, { accelerator });
        void runStepsDetached(entry.steps, ctx, entry.def, `[ShortcutNode] "${accelerator}" failed:`);
      });

      if (ok) {
        const registration = { steps, context, def };
        registered.set(accelerator, registration);
        this.own.set(accelerator, registration);
        this.shortcuts = globalShortcut;
      } else console.warn(`[ShortcutNode] the OS refused "${accelerator}" — another app likely owns it`);
      return ok;
    });
  }

  ["shortcut-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$shortcut-remove"], context, async (value) => {
      const { globalShortcut } = await import("electron");
      if (typeof value === "string" && value !== "") {
        globalShortcut.unregister(value);
        registered.delete(value);
        this.own.delete(value);
      } else {
        globalShortcut.unregisterAll();
        registered.clear();
        this.own.clear();
      }
      return null;
    });
  }
}
