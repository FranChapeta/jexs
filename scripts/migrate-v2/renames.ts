/**
 * Every op and handler sibling that v2 renames from kebab-case to camelCase,
 * old name to new. Op names lead with their noun (`cache-get` is `cacheGet`);
 * physics' vector math is `vector*`, and `register-mesh` leads with its noun.
 */

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const KEBAB_OPS = [
  // server
  "cache-connect", "cache-delete", "cache-get", "cache-has", "cache-set", "email-connect",
  "socket-accept", "socket-broadcast", "socket-close", "socket-count", "socket-join", "socket-leave",
  "socket-list", "socket-send", "socket-send-to", "stdio-close", "stdio-listen", "stdio-prompt", "stdio-write",
  // client
  "audio-load", "audio-master", "audio-play", "audio-stop", "audio-unload", "audio-volume",
  "push-subscribe", "push-unsubscribe", "rtc-broadcast", "rtc-close", "rtc-connect", "rtc-send", "rtc-signal",
  "rtc-status", "storage-delete", "storage-get", "storage-has", "storage-set", "sw-notify", "sw-open", "sw-post",
  "ws-close", "ws-connect", "ws-send", "ws-status",
  // physics
  "collision-off", "collision-on", "entity-add", "entity-clear", "entity-get", "entity-init", "entity-list",
  "entity-move", "entity-nearest", "entity-remove", "entity-update", "joint-add", "joint-remove",
  "physics-apply", "physics-destroy", "physics-init", "physics-pause", "physics-raycast", "physics-resume", "physics-step",
  // gl
  "gl-animate", "gl-atlas", "gl-blur", "gl-camera", "gl-destroy", "gl-font", "gl-frame", "gl-hit", "gl-init",
  "gl-particle", "gl-raycast", "gl-register-mesh", "gl-shader", "gl-ssao", "gl-text", "gl-texture", "gl-tilemap",
  "gl-tilemap-set", "gl-trail", "gl-trail-remove", "gl-transition", "gl-tween",
  // electron
  "app-locale", "app-on", "app-path", "app-quit", "app-relaunch", "app-version", "dialog-message", "dialog-open",
  "dialog-save", "shell-beep", "shell-open", "shell-open-path", "shell-show", "shell-trash", "shortcut-remove",
  "tray-destroy", "window-bounds", "window-close", "window-devtools", "window-focus", "window-list", "window-max",
  "window-min", "window-open", "window-reload", "window-restore", "window-run", "window-title",
];

/** Old op name to new, without the `$`. */
export const OP_RENAMES: Record<string, string> = {
  ...Object.fromEntries(KEBAB_OPS.map(op => [op, camel(op)])),
  "register-mesh": "meshRegister",
  ...Object.fromEntries(
    ["add", "cross", "direction", "distance", "dot", "lerp", "normalize", "scale", "sub", "toward"]
      .map(verb => [`v-${verb}`, `vector${verb[0].toUpperCase()}${verb.slice(1)}`]),
  ),
};

/** Old handler sibling name to new, on whichever op declares it. */
export const HANDLER_RENAMES: Record<string, string> = Object.fromEntries(
  ["on-open", "on-message", "on-close", "on-signal", "on-peer", "on-frame"].map(name => [name, camel(name)]),
);
