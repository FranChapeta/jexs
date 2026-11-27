// Shared by the ops that reach microphones and cameras: finding the browser's
// media devices, and saying what went wrong when opening one fails, including
// where the user can allow it.

/** What a capture asked for, as its error names it. */
export type MediaWanted = { audio: boolean; video: boolean };

/** `navigator.mediaDevices`, or an error saying why the page has none. */
export function mediaDevicesOf(op: string): MediaDevices {
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (devices) return devices;
  if (globalThis.isSecureContext === false) {
    throw new Error(`$${op}: microphones and cameras are reachable only from a secure page, served over https or from localhost`);
  }
  throw new Error(`$${op}: this browser has no media devices API, so microphones and cameras can't be reached`);
}

/** "microphone", "camera", or "microphone and camera". */
function nameOf(wanted: MediaWanted): string {
  return [wanted.audio && "microphone", wanted.video && "camera"].filter(Boolean).join(" and ");
}

/**
 * Where a refusal is undone. In Electron the page's grant is the app's, and the
 * system's privacy settings hold the one that matters; in a browser, the site's
 * settings do.
 */
function whereToAllow(wanted: MediaWanted): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (!agent.includes("Electron/")) return "Allow it in the site's settings, by the address bar, and try again.";
  const pages = [wanted.audio && "Microphone", wanted.video && "Camera"].filter(Boolean).join(" and ");
  if (agent.includes("Mac OS X")) return `Allow this app in System Settings > Privacy & Security > ${pages}, then restart it.`;
  if (agent.includes("Windows")) return `Allow it in Settings > Privacy > ${pages}, with access for desktop apps turned on.`;
  return "The app or the system refused it.";
}

/** A `getUserMedia` failure as a message naming what failed and what to do. */
export function mediaError(op: string, wanted: MediaWanted, err: unknown): Error {
  const what = nameOf(wanted);
  const name = err instanceof Error ? err.name : "";
  const detail = err instanceof Error ? err.message : String(err);
  let message: string;
  switch (name) {
    case "NotAllowedError":
      message = `access to the ${what} was refused. ${whereToAllow(wanted)}`;
      break;
    case "NotFoundError":
      message = `no ${what} was found`;
      break;
    case "NotReadableError":
      message = `the ${what} couldn't be opened: another app may be using it, or the system blocked it`;
      break;
    case "OverconstrainedError": {
      const constraint = Reflect.get(err as object, "constraint");
      message = `no ${what} can give ${typeof constraint === "string" && constraint ? `the \`${constraint}\` asked for` : "what was asked for"}`;
      break;
    }
    default:
      message = `the ${what} couldn't be opened: ${detail}`;
  }
  return new Error(`$${op}: ${message}`, { cause: err });
}
