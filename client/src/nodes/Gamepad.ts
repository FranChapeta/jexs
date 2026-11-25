import { Node, Context, NodeValue, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import type { BridgeSend } from "../events.js";

/** A pad's buttons and axes as its last `changes` read saw them. Copied out of
 *  the pad, which a browser may update in place or hand over afresh each read. */
interface PadState {
  id: string;
  pressed: boolean[];
  touched: boolean[];
  values: number[];
  axes: number[];
  /** When a `changes` read last reported something, for `throttle`. */
  reportedAt: number;
}

/** A pad's index, as an op's value gives it. */
function padIndex(op: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`$${op} takes the pad's index, a whole number from 0 (a gamepad event's \`value.gamepad\`), not ${JSON.stringify(value)}`);
  }
  return value;
}

/** The pad at `index`, or undefined when there is none (or no Gamepad API). */
function padAt(index: number): Gamepad | undefined {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return undefined;
  return navigator.getGamepads()[index] ?? undefined;
}

/** A number sibling, `fallback` when absent. Anything else must pass `valid`:
 *  a value quietly clamped or ignored would rumble other than asked. */
function numberOption(op: string, name: string, value: unknown, fallback: number, valid: (n: number) => boolean, expected: string): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" || !valid(value)) throw new Error(`$${op}: \`${name}\` is ${expected}, not ${JSON.stringify(value)}`);
  return value;
}

const isFraction = (n: number) => n >= 0 && n <= 1;
const isDuration = (n: number) => n >= 0 && Number.isFinite(n);

/**
 * What changed on `pad` since the last read of it in `last` that reported,
 * which this read then replaces: each changed button as
 * `{ pressed, touched, value }` and each changed axis as its value, by index.
 * A pad not read before, or another device at its index, starts from nothing
 * known, so all of it has changed.
 *
 * Within `throttle` ms of the last report it reports nothing and leaves the
 * state alone, so what changes in the meantime builds up for the next report,
 * merged: a button pressed and released between two reports has not changed.
 * Only the result is allocated unless something changed.
 */
function changesOf(last: Map<number, PadState>, pad: Gamepad, throttle: number): Record<string, unknown> {
  const { buttons, axes } = pad;
  let state = last.get(pad.index);
  if (!state || state.id !== pad.id || state.values.length !== buttons.length || state.axes.length !== axes.length) {
    // NaN equals nothing, so every button and axis reads as changed.
    state = {
      id: pad.id,
      pressed: new Array<boolean>(buttons.length).fill(false),
      touched: new Array<boolean>(buttons.length).fill(false),
      values: new Array<number>(buttons.length).fill(NaN),
      axes: new Array<number>(axes.length).fill(NaN),
      reportedAt: -Infinity,
    };
    last.set(pad.index, state);
  }
  const changes: Record<string, unknown> = {};
  const now = throttle > 0 ? performance.now() : 0;
  if (now - state.reportedAt < throttle) return changes;
  let changedButtons: Record<number, unknown> | undefined;
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    const pressed = b.pressed, value = b.value;
    // Where a browser leaves it out, as the spec has it for a button with no
    // touch sensor: touched while it reads above 0, or while pressed.
    const touched = b.touched ?? (pressed || value > 0);
    if (pressed === state.pressed[i] && touched === state.touched[i] && value === state.values[i]) continue;
    state.pressed[i] = pressed;
    state.touched[i] = touched;
    state.values[i] = value;
    (changedButtons ??= {})[i] = { pressed, touched, value };
  }
  let changedAxes: Record<number, number> | undefined;
  for (let i = 0; i < axes.length; i++) {
    if (axes[i] === state.axes[i]) continue;
    state.axes[i] = axes[i];
    (changedAxes ??= {})[i] = axes[i];
  }
  if (changedButtons) changes.buttons = changedButtons;
  if (changedAxes) changes.axes = changedAxes;
  if (changedButtons || changedAxes) state.reportedAt = now;
  return changes;
}

export class GamepadNode extends Node {
  /**
   * Each pad's last `changes` read, by index: what the next one compares with.
   * On the node, so it belongs to one resolver, as WsNode's connections do.
   */
  readonly last = new Map<number, PadState>();

  static schemaDefs = {
    _gamepadButton: {
      type: "object",
      description: "A button's state.",
      properties: {
        pressed: { type: "boolean", description: "Whether it is pressed." },
        touched: { type: "boolean", description: "Whether a finger is on it, on a pad that can tell. Otherwise whether it reads above 0, which for a digital button is the same as `pressed`, and for an analog one includes a light squeeze not yet far enough to count as pressed." },
        value: { type: "number", description: "How far it is pressed, from 0 to 1: in between only for an analog button, such as a trigger." },
      },
    },
    _gamepad: {
      type: "object",
      description: "A controller as the browser gives it. Its fields are read by path; `$keys`, `$entries`, `$merge` and `$stringify` see none of them.",
      properties: {
        index: { type: "number", description: "The pad's index, as `$gamepad` and the gamepad events name it." },
        id: { type: "string", description: "The browser's name for the device." },
        mapping: { type: "string", description: "`\"standard\"` when the browser knows the layout, which fixes what each index is; otherwise `\"\"`." },
        connected: { type: "boolean", description: "Whether it is still connected." },
        timestamp: { type: "number", description: "When its state last changed, in milliseconds on the page's clock." },
        buttons: { type: "array", items: { $ref: "#/$defs/_gamepadButton" }, description: "Each button, by index." },
        axes: { type: "array", items: { type: "number" }, description: "Each axis from -1 to 1, down and right positive, by index." },
      },
    },
    _gamepadChanges: {
      type: "object",
      description: "What changed on a pad since its last report, each part there only when something in it changed: `{}` when nothing did.",
      properties: {
        buttons: { type: "object", additionalProperties: { $ref: "#/$defs/_gamepadButton" }, description: "Each button that changed, by index." },
        axes: { type: "object", additionalProperties: { type: "number" }, description: "Each axis that changed, by index." },
      },
    },
  };

  static schema: JexsNodeSchema = {
    gamepad: {
      type: "number",
      output: { $ref: "#/$defs/_gamepad" },
      markdownDescription: "Reads the controller at an index (the first one connected is `0`) as the browser gives it: a `Gamepad`, with `buttons` (each `{ pressed, touched, value }`) and `axes` by index. On a pad whose `mapping` is `\"standard\"`, buttons 0 to 3 are the bottom, right, left and top face buttons, 4 and 5 the bumpers, 6 and 7 the triggers, 8 and 9 select and start, 10 and 11 the stick presses, 12 to 15 the d-pad up, down, left and right, and 16 home; axes 0 and 1 are the left stick, 2 and 3 the right.\n\nRead it every frame, in `glInit`'s `onFrame`, for movement and held buttons; for a press, handle `gamepadbuttondown` on an element instead, as you would `keydown`. To send input to a server, pass `changes`.\n\nBrowsers show a page no controller until a button is pressed on it while the page is open.",
      outputDescription: "The pad, or `undefined` when no pad has that index.",
      examples: [
        "{ \"$gamepad\": 0, \"$as\": \"pad\" }",
        "[{ \"$gamepad\": 0, \"$as\": \"pad\" },\n { \"$entityUpdate\": \"player\", \"moveX\": { \"$multiply\": [{ \"$coalesce\": [{ \"$var\": \"pad.axes.0\" }, 0] }, 250] } }]",
      ],
      siblings: {
        changes: {
          type: "boolean",
          default: false,
          variantBy: "value",
          description: "Give only what changed since the pad's last report (default `false`).",
          variants: {
            true: {
              output: { $ref: "#/$defs/_gamepadChanges" },
              markdownDescription: "Gives only the buttons and axes that changed since the pad's last report, as plain data to send to a server. The first read gives all of them, and so does the first after the pad reconnects or another device takes its index. Each pad's last report is kept in one place, so read a pad's changes from one step: two would each see part of them.",
              outputDescription: "What changed, `{}` (false to `$if`) when nothing did, or `undefined` when no pad has that index.",
              examples: [
                "[{ \"$gamepad\": 0, \"changes\": true, \"$as\": \"changed\" },\n { \"$if\": { \"$var\": \"changed\" }, \"then\": { \"$wsSend\": { \"$var\": \"changed\" } } }]",
                "{ \"$gamepad\": 0, \"changes\": true, \"throttle\": 33 }",
              ],
              siblings: {
                throttle: {
                  type: "number",
                  markdownDescription: "Report at most once per this many milliseconds: a read sooner than that after the last one that reported gives `{}`, and the next one after it gives everything that changed since, merged. For sending input to a server at a steady rate, whatever the frame rate. A button pressed and released between two reports has not changed, so send presses that must arrive from `gamepadbuttondown`.",
                },
              },
            },
          },
        },
      },
    },
    gamepadRumble: {
      type: "number",
      output: "boolean",
      markdownDescription: "Vibrates the controller at an index. Returns at once rather than when the vibration ends, so a frame is not held up; a second rumble replaces one still running.",
      outputDescription: "`true` when the rumble started, `false` when no pad has that index or the pad cannot vibrate.",
      examples: [
        "{ \"$gamepadRumble\": 0 }",
        "{ \"$gamepadRumble\": { \"$var\": \"value.gamepad\" }, \"duration\": 400, \"strong\": 0.8, \"weak\": 0.2 }",
      ],
      siblings: {
        duration: { type: "number", description: "Milliseconds to vibrate (default 200)." },
        strong: { type: "number", description: "Strength of the low-frequency motor, from 0 to 1 (default 1)." },
        weak: { type: "number", description: "Strength of the high-frequency motor, from 0 to 1 (default 1)." },
      },
    },
  };

  gamepad(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$gamepad, def.changes, def.throttle], context, ([indexRaw, changesRaw, throttleRaw]) => {
      const index = padIndex("gamepad", indexRaw);
      const pad = padAt(index);
      const changes = this.toBoolean(changesRaw);
      const throttle = numberOption("gamepad", "throttle", throttleRaw, 0, isDuration, "a number of milliseconds from 0");
      if (throttle > 0 && !changes) throw new Error("$gamepad: `throttle` paces `changes` reads, so it needs `changes: true`");
      if (!changes) return pad;
      if (!pad) {
        // Gone: a pad connecting there later starts from nothing known.
        this.last.delete(index);
        return undefined;
      }
      return changesOf(this.last, pad, throttle);
    });
  }

  gamepadRumble(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$gamepadRumble, def.duration, def.strong, def.weak], context, ([index, durationRaw, strongRaw, weakRaw]) => {
      const duration = numberOption("gamepadRumble", "duration", durationRaw, 200, isDuration, "a number of milliseconds from 0");
      const strongMagnitude = numberOption("gamepadRumble", "strong", strongRaw, 1, isFraction, "a number from 0 to 1");
      const weakMagnitude = numberOption("gamepadRumble", "weak", weakRaw, 1, isFraction, "a number from 0 to 1");
      const actuator: unknown = padAt(padIndex("gamepadRumble", index))?.vibrationActuator;
      const playEffect: unknown = actuator && Reflect.get(actuator, "playEffect");
      // Where the browser lists the effects a pad has, one without this has no motors.
      const effects: unknown = actuator && Reflect.get(actuator, "effects");
      if (typeof playEffect !== "function" || (Array.isArray(effects) && !effects.includes("dual-rumble"))) return false;
      Promise.resolve(playEffect.call(actuator, "dual-rumble", { duration, strongMagnitude, weakMagnitude }))
        .catch((err: unknown) => console.error("[Jexs] $gamepadRumble failed:", err));
      return true;
    });
  }
}

// ─── The controller events ───────────────────────────────────────────────────
//
// Browsers announce a controller connecting and disconnecting on `window`, but
// fire nothing when a button is pressed: its state has to be read. So while a
// pad is connected and an element handles a button, the bridge reads the pads
// once a frame and sends each button that changed. Its state is the page's, as
// the events' elements are, rather than one resolver's.
//
// Each event's `value` is its detail: `{ gamepad, id, mapping }` for connecting
// and disconnecting, `{ gamepad, button, value }` for a button, with `button`
// its index, as `$gamepad`'s `buttons` has it.

/** The `send` each controller event's bridge started with, by event type. */
const senders = new Map<string, BridgeSend>();
/**
 * How many elements each button event reached when last sent: `Infinity` from
 * when its bridge starts until it is sent, 0 for one nothing handles. The pads
 * are read while either can reach an element, so a page that moved on from the
 * game stops reading them after the next press and release, and the next
 * element to handle one starts its bridge, and the reading, again.
 */
let downReach = 0;
let upReach = 0;
/** Each connected pad's buttons as last read, pressed or not, by pad index. */
const pressedPads = new Map<number, boolean[]>();
let listening = false;
let polling = false;

/** Read the pads once a frame while one is connected and a button is handled. */
function pollSoon(): void {
  if (polling || (downReach === 0 && upReach === 0) || pressedPads.size === 0) return;
  polling = true;
  requestAnimationFrame(poll);
}

/** Send each button that changed since the last frame. The loop allocates
 *  nothing unless a button changed, which on most frames none has. */
function poll(): void {
  polling = false;
  for (const pad of navigator.getGamepads()) {
    const before = pad && pressedPads.get(pad.index);
    if (!pad || !before) continue;
    const buttons = pad.buttons;
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const pressed = b.pressed;
      if (pressed === (before[i] ?? false)) continue;
      before[i] = pressed;
      const detail = { gamepad: pad.index, button: i, value: b.value };
      if (pressed) downReach = senders.get("gamepadbuttondown")?.(detail) ?? 0;
      else upReach = senders.get("gamepadbuttonup")?.(detail) ?? 0;
    }
  }
  pollSoon();
}

/** Start tracking a pad, its buttons all released, so the press that made the
 *  browser announce it is a `gamepadbuttondown`, and announce it. */
function connect(pad: Gamepad): void {
  if (pressedPads.has(pad.index)) return;
  pressedPads.set(pad.index, new Array<boolean>(pad.buttons.length).fill(false));
  senders.get("gamepadconnected")?.({ gamepad: pad.index, id: pad.id, mapping: pad.mapping });
  pollSoon();
}

/** Start the controller event `type`, which an element handles now and none
 *  did until it: the `start` of each controller event's bridge. For a button,
 *  that starts the pads being read again, if they had stopped. */
export function receiveGamepadEvents(send: BridgeSend, type: string): void {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return;
  senders.set(type, send);
  if (type === "gamepadbuttondown") downReach = Infinity;
  else if (type === "gamepadbuttonup") upReach = Infinity;
  pollSoon();
  if (listening) return;
  listening = true;

  window.addEventListener("gamepadconnected", (e: GamepadEvent) => connect(e.gamepad));
  window.addEventListener("gamepaddisconnected", (e: GamepadEvent) => {
    if (!pressedPads.delete(e.gamepad.index)) return;
    senders.get("gamepaddisconnected")?.({ gamepad: e.gamepad.index, id: e.gamepad.id, mapping: e.gamepad.mapping });
  });
  // A pad the page saw before this bridge started was announced to no one.
  for (const pad of navigator.getGamepads()) if (pad) connect(pad);
}
