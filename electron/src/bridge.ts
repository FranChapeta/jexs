import { createHttpError, registerNode, ProxyNode } from "@jexs/core";
import type { Context, Resolver } from "@jexs/core";

/**
 * The process boundary, both directions.
 *
 * renderer -> main  `jexs:keys` (sync handshake), `jexs:invoke`
 * main -> renderer  `jexs:call` / `jexs:result`, `jexs:keys-added`
 * both              key announcements, so either side can adopt the other's ops
 *
 * Nothing here imports `electron` at module scope: `nodes/Window.ts` imports
 * this file, and schema generation loads `dist/nodes/*.js` under plain Node
 * where the electron runtime does not exist. A top-level import would throw out
 * of `jexs schema` and kill schema generation for every package in the repo.
 */

// ---------------------------------------------------------------------------
// Call transport (main -> renderer)
//
// `webContents.send` is fire-and-forget, but a proxied DOM op has to return a
// value — `{ "getValue": "#editor", "as": "text" }` is useless otherwise. Each
// message carries a correlation id and the renderer answers on `jexs:result`.
// Errors travel back the same way, so a failing DOM op surfaces in main where
// the developer is looking rather than in a renderer console nobody has open.
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const pending = new Map<number, Pending>();
let nextId = 1;

/** Settle a call from the renderer's reply. Unknown ids are stale and ignored. */
export function settle(id: number, value: unknown, error?: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (error) entry.reject(createHttpError(500, error));
  else entry.resolve(value);
}

/**
 * Fail every in-flight call. A window can close mid-call, and without this the
 * promise never settles and the step sequence that issued it hangs forever.
 */
export function rejectAll(reason: string): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(createHttpError(500, reason));
}

/** Tag a payload with a correlation id, send it, and await the reply. */
function send(win: Electron.BrowserWindow, payload: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    win.webContents.send("jexs:call", { id, ...payload });
  });
}

/** Forward a single resolved node call — one proxied DOM op. */
export function callRenderer(
  win: Electron.BrowserWindow,
  call: Record<string, unknown>,
): Promise<unknown> {
  return send(win, { call });
}

/**
 * Run a step array in a window's page.
 *
 * `steps` travels as steps rather than being wrapped into a synthesized node
 * call: the main process should never author Jexs JSON on the user's behalf,
 * and wrapping would also make this silently depend on a particular op existing
 * in the renderer. The receiver discriminates on the presence of `steps`, so
 * that field must never appear on a plain call.
 *
 * `params` is dropped unless it resolved to an object — it becomes a child
 * scope in the renderer, and spreading a string or array into one would produce
 * index-keyed nonsense rather than named variables.
 */
export function runInRenderer(
  win: Electron.BrowserWindow,
  steps: unknown,
  params?: unknown,
): Promise<unknown> {
  const scoped = params !== null && typeof params === "object" && !Array.isArray(params);
  return send(win, scoped ? { steps, params } : { steps });
}

/** The op a call is dispatching — its first key. Used for error messages. */
export function callKey(call: Record<string, unknown>): string {
  for (const key of Object.keys(call)) return key;
  return "(empty call)";
}

/**
 * Raised when a renderer op is issued with no window to send it to.
 *
 * This is an error rather than a silent no-op on purpose. A tray app launched at
 * login sits with no window as its NORMAL state, and tray, shortcut and
 * lifecycle handlers overwhelmingly do main-side work — open a window, toggle a
 * setting, quit — so they never reach here. One that genuinely reaches for the
 * DOM with no window open has a real bug, and should be told which op failed.
 */
export function noWindowError(op: string): Error {
  return createHttpError(
    500,
    `"${op}" runs in a window, but none is open. Open one with window-open first, ` +
      `or move this step into a page template.`,
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface BridgeHooks {
  resolver: Resolver;
  /** Build a main-process context for a call arriving from a window. */
  contextFor(win: Electron.BrowserWindow | null): Context;
  /** Which window a main-originated renderer op should target. */
  windowFor(context: Context): Electron.BrowserWindow | null;
}

/**
 * Install every IPC handler. Call once, after the resolver exists.
 *
 * The symmetry is the point: each side registers a ProxyNode over the keys the
 * OTHER side owns and it lacks, so ops cross transparently in both directions.
 * First-wins registration is what keeps that safe — main registered core, server
 * and electron nodes first, so `var`, `file` and `query` stay local and only the
 * DOM-ish keys get adopted.
 */
export async function installBridge(hooks: BridgeHooks): Promise<void> {
  const { ipcMain, BrowserWindow } = await import("electron");
  const { resolver } = hooks;
  let rendererProxy: ProxyNode | null = null;

  /**
   * Keys main genuinely owns. Keys it merely proxies FROM a renderer are
   * excluded: announcing those would hand a key back to the side it came from,
   * and with two windows that becomes an infinite forwarding loop (main adopts
   * `foo` from window A, tells B, B calls `foo`, main forwards it onward).
   */
  const localKeys = (): string[] =>
    [...resolver.keys].filter((key) => !rendererProxy?.claims(key));

  function forwardToRenderer(call: Record<string, unknown>, context: Context): unknown {
    // No `window` sibling: DOM ops are declared by @jexs/client, and one package
    // cannot add a sibling to another package's op. Explicit targeting is
    // `window-run`. This picks the caller's own window, else the default.
    const win = hooks.windowFor(context);
    if (!win) throw noWindowError(callKey(call));
    return callRenderer(win, call);
  }

  // --- renderer -> main ----------------------------------------------------

  // Read synchronously at preload time, before any step runs, so the renderer
  // can register its proxy for main's keys before the page resolves anything.
  ipcMain.on("jexs:keys", (event) => { event.returnValue = localKeys(); });

  // The sender's window becomes the implicit target, so a page can say
  // { "window-close": true } and mean its own window.
  ipcMain.handle("jexs:invoke", (event, call: unknown) =>
    Promise.resolve(resolver(call, hooks.contextFor(BrowserWindow.fromWebContents(event.sender)))));

  // --- main -> renderer ----------------------------------------------------

  // Sent synchronously: a main-process sequence that opens a window and then
  // touches the DOM must not outrun this. `event.returnValue` MUST be set on
  // every path — a `sendSync` with no reply blocks the renderer forever.
  ipcMain.on("jexs:renderer-keys", (event, announced: unknown) => {
    event.returnValue = true;
    if (!Array.isArray(announced)) return;
    // Adopt only what main lacks. After the first round the proxy's keys are in
    // the resolver too, so re-announcements filter down to genuinely new ones.
    const fresh = announced.filter(
      (key): key is string => typeof key === "string" && !resolver.keys.has(key),
    );
    if (fresh.length === 0) return;

    rendererProxy ??= new ProxyNode([], forwardToRenderer);
    rendererProxy.addKeys(fresh);
    // The resolver COPIES a node's keys into its dispatch map at registration,
    // so growing the proxy's own set is not enough — without re-registering the
    // new keys would never dispatch. Only absent keys are added, so first-wins
    // still protects every local handler.
    registerNode(rendererProxy);
  });

  ipcMain.on("jexs:result", (_event, msg: { id?: number; value?: unknown; error?: string }) => {
    if (typeof msg?.id === "number") settle(msg.id, msg.value, msg.error);
  });

  // `registerNode` is a runtime API, not a boot-time one, so a node registered
  // in main later must still become reachable from pages already open. Without
  // this the renderer's key set would be whatever it read at preload, frozen for
  // the life of the process.
  resolver.onKeysChange((added) => {
    const fresh = added.filter((key) => !rendererProxy?.claims(key));
    if (fresh.length === 0) return;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("jexs:keys-added", fresh);
    }
  });
}
