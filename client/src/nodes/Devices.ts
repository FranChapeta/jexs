import { Node, resolve } from "@jexs/core";
import type { Context, JexsNodeSchema, NodeValue } from "@jexs/core";
import type { BridgeSend } from "../events.js";
import { mediaDevicesOf, mediaError, type MediaWanted } from "../media.js";

const KINDS = ["audioinput", "audiooutput", "videoinput"] as const;
type DeviceKind = typeof KINDS[number];

/** A device as plain data: the browser's `MediaDeviceInfo` keeps its fields on
 *  the prototype, where `$keys`, `$merge` and `$stringify` don't see them. */
interface Device {
  kind: DeviceKind;
  deviceId: string;
  groupId: string;
  label: string;
}

function copyOf(d: MediaDeviceInfo): Device {
  return { kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: d.label };
}

/** Whether the browser hides a kind's devices: before the page may use one, it
 *  lists at most a placeholder for the kind, with no label. */
function hidden(list: MediaDeviceInfo[], kind: DeviceKind): boolean {
  return list.some(d => d.kind === kind && d.label === "");
}

/**
 * The devices of `kinds`. When some are hidden, it asks for them first, with
 * the mic for audio inputs and outputs (Chrome shows outputs to a page that may
 * use the mic) and the camera for video inputs, stops what it opened at once,
 * and lists again. Outputs hidden with the mic allowed stay hidden, since
 * asking again would show no more of them.
 */
async function listDevices(kinds: readonly DeviceKind[]): Promise<Device[]> {
  const media = mediaDevicesOf("devices");
  let list = await media.enumerateDevices();
  const wanted: MediaWanted = {
    audio: (kinds.includes("audioinput") || kinds.includes("audiooutput")) && hidden(list, "audioinput"),
    video: kinds.includes("videoinput") && hidden(list, "videoinput"),
  };
  if (wanted.audio || wanted.video) {
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia(wanted);
    } catch (err) {
      throw mediaError("devices", wanted, err);
    }
    for (const track of stream.getTracks()) track.stop();
    list = await media.enumerateDevices();
  }
  return list.filter(d => kinds.includes(d.kind)).map(copyOf);
}

export class DevicesNode extends Node {
  static schemaDefs = {
    _device: {
      type: "object",
      description: "A microphone, speaker or camera, as plain data.",
      properties: {
        kind: { type: "string", enum: [...KINDS], description: "`\"audioinput\"` for a microphone, `\"audiooutput\"` for a speaker or headphones, `\"videoinput\"` for a camera." },
        deviceId: { type: "string", description: "The device's id for this site, kept across visits: `$mediaCapture`'s `device` for an input, `$audioGraph`'s `sink` for an output. Empty for a placeholder." },
        groupId: { type: "string", description: "Shared by the devices of one piece of hardware, such as a headset's microphone and earphones." },
        label: { type: "string", description: "The device's name, such as \"USB Microphone\". Empty for a placeholder." },
      },
    },
  };

  static schema: JexsNodeSchema = {
    devices: {
      type: ["boolean", "string"],
      enum: [true, ...KINDS],
      output: { type: "array", items: { $ref: "#/$defs/_device" } },
      markdownDescription: "Lists the microphones (`\"audioinput\"`), speakers (`\"audiooutput\"`) or cameras (`\"videoinput\"`), or all of them for `true`, to build a device picker.\n\nBrowsers name no device to a page that may not use one yet, listing a placeholder with an empty `deviceId` and `label` instead. So when the devices asked for are hidden, it asks for the microphone or camera first, closing it at once, and lists them named; once allowed, it lists without asking. Pass a kind: `true` asks for the camera too. Speakers are listed with the microphone allowed, in Chromium; Firefox lists only those the user picked, and Safari none.\n\nWhen a device is plugged in or out, the elements handling `devicechange` receive the list as its `value`, read without asking, so a picker can follow it without a prompt.",
      outputDescription: "The devices, each `{ kind, deviceId, groupId, label }`. A page with no media devices API (one not served over https or from localhost), or a refusal, throws, saying which.",
      examples: [
        "{ \"$devices\": \"audioinput\", \"$as\": \"mics\" }",
        "{ \"$tag\": \"body\", \"events\": { \"devicechange\": { \"do\": { \"$setVars\": { \"devices\": { \"$var\": \"value\" } } } } } }",
      ],
    },
  };

  devices(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$devices, context, what => {
      if (what === true) return listDevices(KINDS);
      const kind = KINDS.find(k => k === what);
      if (!kind) throw new Error(`$devices takes true or a kind of device, "audioinput", "audiooutput" or "videoinput", not ${JSON.stringify(what)}`);
      return listDevices([kind]);
    });
  }
}

// `devicechange` reaches the elements handling it with the devices listed as
// the page sees them, read without asking. The browser fires it when that list
// changes, so rarely before the page may use a device, and not while the page
// is hidden until it shows again.

let sendChange: BridgeSend | undefined;
let changes = 0;

/** Start sending `devicechange`: the start of its bridge. */
export function receiveDeviceChanges(send: BridgeSend): void {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media) return;
  const listening = sendChange !== undefined;
  sendChange = send;
  if (listening) return;
  media.addEventListener("devicechange", () => {
    // Two changes close together may list in either order; only the last sends.
    const change = ++changes;
    media.enumerateDevices().then(
      list => { if (change === changes) sendChange?.(list.map(copyOf)); },
      (err: unknown) => console.error("[Jexs] devicechange: the devices couldn't be listed:", err),
    );
  });
}
