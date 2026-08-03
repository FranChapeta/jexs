// Electron preload (CommonJS — runs in the isolated renderer world before the
// page loads). Exposes a minimal, allow-listed bridge on window.jexsHost that
// @jexs/client uses:
//   - keys:   main's handler keys, read synchronously at load so the renderer can
//             register a ProxyNode for the keys it lacks before any step runs.
//   - invoke: forward a (renderer-resolved) node call to the main-process resolver
//             via the "jexs:invoke" channel and return the result.
const { contextBridge, ipcRenderer } = require("electron");

const keys = ipcRenderer.sendSync("jexs:keys");

contextBridge.exposeInMainWorld("jexsHost", {
  keys,
  invoke: (call) => ipcRenderer.invoke("jexs:invoke", call),
});
