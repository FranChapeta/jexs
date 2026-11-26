import { Node, resolve } from "@jexs/core";
import type { Context, JexsNodeSchema, NodeValue } from "@jexs/core";
import { bridgeEvent, type BridgeSend } from "../events.js";

/** Sends `permissionchange`, from when an element first handles it. */
let sendChange: BridgeSend | undefined;

// Bridged as the node loads, on the first `$permission`: the elements bound to
// a handler for it before then receive it from now on.
bridgeEvent("permissionchange", send => { sendChange = send; });

/**
 * The query for `name`. Chrome refuses `push` without `userVisibleOnly`, and
 * `$pushSubscribe` subscribes with it. TypeScript's `PermissionName` lists
 * fewer names than browsers know (`microphone`, `camera`, `midi` among them),
 * and the browser checks the name itself, rejecting one it doesn't know.
 */
function descriptorOf(name: string): PermissionDescriptor {
  return (name === "push" ? { name, userVisibleOnly: true } : { name }) as PermissionDescriptor;
}

export class PermissionNode extends Node {
  /** Each name's status, the same one on every read, so its `state` is live. */
  readonly statuses = new Map<string, Promise<PermissionStatus>>();

  /** Aborted by `dispose`, removing every status's `change` listener. */
  readonly listening = new AbortController();

  static schemaDefs = {
    _permissionStatus: {
      type: "object",
      description: "A permission's state as the browser gives it, a `PermissionStatus`. Its fields are read by path and stay live: a stored status reads the state as it is now.",
      properties: {
        name: { type: "string", description: "The permission's name." },
        state: { type: "string", enum: ["granted", "denied", "prompt"], description: "`\"granted\"`, `\"denied\"`, or `\"prompt\"` when using it would ask." },
      },
    },
  };

  static schema: JexsNodeSchema = {
    permission: {
      type: "string",
      // Value-mode without an enum: the known names are documented, and any
      // other the browser knows still validates.
      variantBy: "value",
      variants: {
        microphone: { markdownDescription: "Capturing audio from a microphone. Asked when the page first captures one." },
        camera: { markdownDescription: "Capturing video from a camera. Asked when the page first captures one." },
        notifications: { markdownDescription: "Showing notifications. Asked by `$pushSubscribe`, or when the page first shows one." },
        push: { markdownDescription: "Receiving web push messages, which show a notification. Asked by `$pushSubscribe`." },
        midi: { markdownDescription: "Using MIDI devices, without system exclusive messages." },
        geolocation: { markdownDescription: "Reading the device's location." },
        "persistent-storage": { markdownDescription: "Keeping the site's storage when the browser is short of space, instead of clearing it." },
        "screen-wake-lock": { markdownDescription: "Keeping the screen on. Chromium and Safari." },
        "clipboard-read": { markdownDescription: "Reading the clipboard. Chromium only." },
        "clipboard-write": { markdownDescription: "Writing to the clipboard. Chromium only, and granted to a page in focus." },
        "storage-access": { markdownDescription: "Its cookies and storage when embedded in another site's page." },
      },
      output: { $ref: "#/$defs/_permissionStatus" },
      markdownDescription: "Reads a permission's state, to show a notice when it is blocked or react when it is revoked: `\"microphone\"`, `\"camera\"`, `\"notifications\"`, `\"push\"`, `\"midi\"`, `\"geolocation\"`, `\"persistent-storage\"`, or another name the browser knows. It never asks: the ops that need a permission ask on first use, such as `$mediaCapture` and `$pushSubscribe`.\n\nIt gives the same status for a name every time, and its `state` is live by path, so a stored status reads `{ \"$var\": \"mic.state\" }` as it is now. Each name read is reported when it changes, as a `permissionchange` event on the elements handling it, its `value` being `{ name, state }`.\n\nFirefox and Safari may read `\"prompt\"` for a grant that lasts only the session, so treat `\"denied\"` as the one sure answer.",
      outputDescription: "The status. A browser without the Permissions API, or one that doesn't know the name, throws, saying which.",
      examples: [
        "{ \"$permission\": \"microphone\", \"$as\": \"mic\" }",
        "{ \"$if\": { \"$eq\": [{ \"$var\": \"mic.state\" }, \"denied\"] }, \"then\": { \"$setProp\": [\"#mic-blocked\", \"hidden\", false] } }",
      ],
    },
  };

  permission(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$permission, context, name => {
      if (typeof name !== "string" || name === "") {
        throw new Error(`$permission takes a permission's name, such as "microphone", not ${JSON.stringify(name)}`);
      }
      const known = this.statuses.get(name);
      if (known) return known;
      const status = queryStatus(this, name);
      this.statuses.set(name, status);
      // A name that failed is asked again next time rather than failing for good.
      status.catch(() => this.statuses.delete(name));
      return status;
    });
  }

  /** Remove the listeners. Called by `resolver.destroy()`. */
  dispose(): void {
    this.listening.abort();
    this.statuses.clear();
  }
}

// The helper below takes the node rather than living on it: every method on a
// Node registers as a dispatch key, so only the ops and `dispose` can be methods.

/** Query `name`, and report its changes from then on. */
async function queryStatus(node: PermissionNode, name: string): Promise<PermissionStatus> {
  const permissions = typeof navigator === "undefined" ? undefined : navigator.permissions;
  if (!permissions) throw new Error("$permission: this browser has no Permissions API, so a permission's state can't be read");
  let status: PermissionStatus;
  try {
    status = await permissions.query(descriptorOf(name));
  } catch (err) {
    throw new Error(`$permission: this browser doesn't know the permission ${JSON.stringify(name)}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  status.addEventListener("change", () => { sendChange?.({ name, state: status.state }); }, { signal: node.listening.signal });
  return status;
}
