// Electron preload (CommonJS — runs in the isolated renderer world before the
// page loads). Exposes a minimal, allow-listed bridge on window.jexsHost that
// @jexs/client uses. Both directions are here:
//
//   renderer -> main
//     keys:     main's handler keys, read synchronously at load so the renderer
//               can register a ProxyNode for the keys it lacks before any step
//               runs.
//     invoke:   forward a (renderer-resolved) node call to the main-process
//               resolver and return the result.
//     announce: tell main which keys this renderer owns, so main can proxy DOM
//               ops back the other way. Called again whenever the set grows.
//
//   main -> renderer
//     onCall:   receive a node call (or step array) from main, run it here, and
//               reply on the same correlation id.
//     onKeys:   main registered nodes after this page loaded; adopt them too.
const { contextBridge, ipcRenderer } = require("electron");

const keys = ipcRenderer.sendSync("jexs:keys");

// Main can send a call before the client bundle has parsed and registered its
// handler — from did-finish-load, or an early menu click. Buffer until then
// rather than dropping, which would be maddening to debug, and cheaper than
// inventing a readiness handshake.
let handler = null;
const pending = [];

ipcRenderer.on("jexs:call", (_event, message) => {
  if (handler) handler(message);
  else pending.push(message);
});

// Same race for key pushes: main can register a node before this page's bundle
// has parsed. Buffering keeps the two channels consistent.
let keysHandler = null;
const pendingKeys = [];

ipcRenderer.on("jexs:keys-added", (_event, added) => {
  if (keysHandler) keysHandler(added);
  else pendingKeys.push(added);
});

contextBridge.exposeInMainWorld("jexsHost", {
  keys,
  invoke: (call) => ipcRenderer.invoke("jexs:invoke", call),
  // Synchronous for the same reason `jexs:keys` is: main must know this page's
  // keys before the page finishes loading. `loadURL` resolves once scripts have
  // run, so a main-process step sequence that opens a window and then touches
  // the DOM would otherwise race the announcement -- main would have no handler
  // for `setText` yet and silently resolve it as plain data.
  announce: (ownKeys) => ipcRenderer.sendSync("jexs:renderer-keys", ownKeys),
  onCall: (cb) => {
    handler = cb;
    for (const message of pending.splice(0)) cb(message);
  },
  onKeys: (cb) => {
    keysHandler = cb;
    for (const added of pendingKeys.splice(0)) cb(added);
  },
  reply: (id, value, error) => ipcRenderer.send("jexs:result", { id, value, error }),
});
