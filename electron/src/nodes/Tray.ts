import {
  Node, Context, NodeValue, childContext, resolveObj, runStepsDetached,
} from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { buildMenuTemplate } from "./Menu.js";

/**
 * The live Tray, held at module scope.
 *
 * This is load-bearing, not incidental: Electron's Tray is garbage collected
 * like any object, and a tray whose only reference was a local would have its
 * icon vanish from the system bar at the next GC, with no error anywhere.
 */
let tray: Electron.Tray | null = null;

/** Whether a tray is currently installed. The runner's quit rule depends on it. */
export function hasTray(): boolean {
  return tray !== null;
}

/** Test seam. */
export function resetTray(): void {
  tray = null;
}

export class TrayNode extends Node {
  static schema: JexsNodeSchema = {
    tray: {
      type: "string",
      output: "null",
      markdownDescription:
        "Put an icon in the system tray. The value is the icon path, relative to the project root.\nCalling it again updates the existing tray in place rather than adding a second one, so this doubles as the update path for the tooltip or the menu.\n**A tray app outlives its windows**: closing the last window no longer quits on Windows or Linux, because minimize-to-tray is the whole point. Give the tray menu a Quit item, or the app becomes unkillable from the UI.",
      examples: [
        "{ \"tray\": \"assets/icon.png\", \"tooltip\": \"My App\", \"items\": [{ \"label\": \"Quit\", \"role\": \"quit\" }] }",
      ],
      siblings: {
        tooltip: { type: "string", description: "Hover text for the tray icon." },
        // Named `items`, not `menu`: `menu` is a handler key, and the resolver
        // dispatches on the first key it recognizes in an object. As a sibling it
        // would make { "menu": [...], "tray": "icon.png" } set the APPLICATION
        // menu and never create the tray -- silently, and depending on key order.
        items: {
          type: "array",
          items: { $ref: "#/$defs/_menuItem" },
          description: "Right-click menu, using the same item shape as `menu`.",
        },
        do: { steps: true, description: "Steps run in the main process when the icon is clicked." },
      },
    },
    "tray-destroy": {
      output: "null",
      markdownDescription: "Remove the tray icon. This also restores the normal quit rule, so closing the last window ends the app again.",
      examples: ["{ \"tray-destroy\": true }"],
    },
  };

  // `menu` and `do` must reach their builders raw, so only the scalar siblings
  // go through the resolver.
  tray(def: Record<string, unknown>, context: Context): NodeValue {
    const scalars = { tray: def.tray, tooltip: def.tooltip };
    return resolveObj(scalars, context, async (r) => {
      const { Tray, nativeImage, Menu } = await import("electron");
      const iconPath = typeof r.tray === "string" ? r.tray : "";

      if (!tray) {
        tray = new Tray(nativeImage.createFromPath(iconPath));
      } else if (iconPath) {
        tray.setImage(nativeImage.createFromPath(iconPath));
      }

      if (typeof r.tooltip === "string") tray.setToolTip(r.tooltip);

      if (def.items !== undefined) {
        const template = await buildMenuTemplate(def.items, context, (raw, steps, item) => {
          const extra = { menuLabel: item.label, menuId: item.id, menuChecked: item.checked };
          runStepsDetached(steps, childContext(context, extra), raw).catch((err: unknown) => {
            console.error(`[TrayNode] "${String(item.label ?? "item")}" failed:`, err);
          });
        });
        tray.setContextMenu(Menu.buildFromTemplate(template));
      }

      if (Array.isArray(def.do)) {
        const steps = def.do;
        tray.removeAllListeners("click");
        tray.on("click", () => {
          runStepsDetached(steps, childContext(context, {}), def).catch((err: unknown) => {
            console.error("[TrayNode] click handler failed:", err);
          });
        });
      }

      return null;
    });
  }

  ["tray-destroy"](_def: Record<string, unknown>, _context: Context): NodeValue {
    tray?.destroy();
    tray = null;
    return null;
  }
}
