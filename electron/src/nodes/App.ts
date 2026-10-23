import {
  Node, Context, NodeValue, childContext, resolve, runStepsDetached,
} from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

type AppPathName = Parameters<Electron.App["getPath"]>[0];

/**
 * App events worth exposing. Deliberately not every Electron event: these are
 * the ones a JSON app can act on without needing the event object itself.
 */
const APP_EVENTS = [
  "activate", "second-instance", "before-quit", "will-quit", "quit",
  "browser-window-focus", "browser-window-blur", "open-file", "open-url",
] as const;
type AppEvent = (typeof APP_EVENTS)[number];

/** App lifecycle + well-known paths. */
export class AppNode extends Node {
  /** The `app` listeners this resolver added, removed by `dispose`: the app
   *  outlives the resolver, and its listeners would keep running the steps. */
  private readonly listeners: Array<{ app: Electron.App; event: string; listener: () => void }> = [];

  dispose(): void {
    for (const { app, event, listener } of this.listeners) {
      // `removeListener` is declared per event name, like `on`; see `appOn`.
      (app.removeListener.bind(app) as (e: string, cb: () => void) => unknown)(event, listener);
    }
    this.listeners.length = 0;
  }

  static schema: JexsNodeSchema = {
    appQuit: {
      output: "null",
      markdownDescription: "Quit the application.",
      examples: ["{ \"$appQuit\": true }"],
    },
    appPath: {
      type: "string",
      output: "string",
      markdownDescription: "Resolve a well-known app path by name (e.g. `userData`, `home`, `documents`) — the place to keep save games.",
      examples: ["{ \"$appPath\": \"userData\" }"],
    },
    appVersion: {
      output: "string",
      markdownDescription: "The version from the app's package.json, for an About box or a crash report.",
      examples: ["{ \"$appVersion\": true }"],
    },
    appLocale: {
      output: "string",
      markdownDescription: "The user's current locale, e.g. `en-GB`. Available only after the app is ready.",
      examples: ["{ \"$appLocale\": true }"],
    },
    appRelaunch: {
      output: "null",
      markdownDescription: "Restart the app: queues a fresh instance and quits this one. Use after a settings change that only applies at startup.",
      examples: ["{ \"$appRelaunch\": true }"],
    },
    appOn: {
      type: "string",
      enum: [...APP_EVENTS],
      output: "null",
      markdownDescription:
        "Run steps when an application event fires.\nListeners add rather than replace, so this does not disturb the runner's own lifecycle handling — an `activate` handler runs alongside the default window restore, it does not suppress it.",
      examples: ["{ \"$appOn\": \"before-quit\", \"do\": [{ \"$file\": \"state.json\", \"write\": { \"$var\": \"state\" } }] }"],
      siblings: {
        do: { steps: true, required: true, description: "Steps run in the main process when the event fires. An array runs as a sequence; a single expression is run on its own." },
      },
    },
  };

  async "appQuit"(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { app } = await import("electron");
    app.quit();
    return null;
  }

  // The path name may itself be an expression, so resolve the value first.
  "appPath"(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$appPath, context, async (name) => {
      const { app } = await import("electron");
      return app.getPath(String(name) as AppPathName) as NodeValue;
    });
  }

  async "appVersion"(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { app } = await import("electron");
    return app.getVersion();
  }

  async "appLocale"(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { app } = await import("electron");
    return app.getLocale();
  }

  async "appRelaunch"(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const { app } = await import("electron");
    // relaunch only QUEUES the restart; without the quit nothing happens.
    app.relaunch();
    app.quit();
    return null;
  }

  // `do` stays raw; only the event name resolves.
  "appOn"(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$appOn, context, async (value) => {
      const event = String(value);
      if (!APP_EVENTS.includes(event as AppEvent)) return null;
      // A handler with no steps registers and then does nothing every time the
      // event fires, which reads as the event never arriving.
      if (def.do === undefined) throw new Error("appOn needs `do` steps");
      const steps = def.do;

      const { app } = await import("electron");
      // `app.on` is declared as one overload per event name, each with its own
      // listener signature, so a union of names matches none of them. The name is
      // checked against APP_EVENTS above and this listener ignores every event
      // argument, so erasing to a plain string handler loses nothing real.
      const on = app.on.bind(app) as (e: string, cb: () => void) => unknown;
      const listener = () => {
        // The event fires long after this step returned, so the resolver is no
        // longer wrapped around the call. runStepsDetached keeps the step's own
        // `$catch` working and stops a synchronous throw escaping the handler.
        const ctx = childContext(context, { appEvent: event });
        void runStepsDetached(steps, ctx, { step: def, logAs: `[AppNode] "${event}" handler failed:` });
      };
      on(event, listener);
      this.listeners.push({ app, event, listener });
      return null;
    });
  }
}
