import { Node, Context, NodeValue, runSteps } from "@jexs/core";
import { resolve } from "@jexs/core";

/**
 * WsNode — Client-side WebSocket operations.
 *
 * Operations:
 * - { "ws-connect": "/path", "on-open": [...], "on-message": [...], "on-close": [...] }
 * - { "ws-send": data }
 * - { "ws-close": true }
 */
export class WsNode extends Node {
  private static connection: WebSocket | null = null;
  private static localId: string | null = null;
  private static intentionalClose = false;
  private static reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static reconnectDelay = 1000;
  private static lastConnectDef: Record<string, unknown> | null = null;
  private static lastConnectContext: Context | null = null;
  private static lastConnectUrl: string | null = null;

  /**
   * Opens a WebSocket connection. Relative URLs are auto-prefixed with `ws://` or `wss://`.
   * Pass `on-open`, `on-message`, and `on-close` step arrays. Reconnects automatically with exponential backoff.
   * Each message sets `$wsMessage` (parsed data) and `$wsId` (server-assigned client ID) in context.
   * @example
   * { "ws-connect": "/ws", "on-message": [{ "var": "$wsMessage" }] }
   */
  ["ws-connect"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["ws-connect"], context, urlRaw => {
      const url = String(urlRaw);
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const fullUrl = url.startsWith("ws") ? url : proto + "//" + location.host + url;

      WsNode.intentionalClose = false;
      if (WsNode.reconnectTimer) {
        clearTimeout(WsNode.reconnectTimer);
        WsNode.reconnectTimer = null;
      }

      if (WsNode.connection) {
        WsNode.intentionalClose = true;
        WsNode.connection.close();
        WsNode.intentionalClose = false;
      }

      WsNode.lastConnectDef = def;
      WsNode.lastConnectContext = context;
      WsNode.lastConnectUrl = fullUrl;

      WsNode.openConnection(fullUrl, def, context);
      return null;
    });
  }

  /** Sends data over the active WebSocket. Objects are JSON-serialized automatically. */
  ["ws-send"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["ws-send"], context, data => {
      if (!WsNode.connection || WsNode.connection.readyState !== WebSocket.OPEN) return null;
      WsNode.connection.send(typeof data === "string" ? data : JSON.stringify(data));
      return null;
    });
  }

  /** Closes the WebSocket connection and disables automatic reconnection. */
  ["ws-close"](_def: Record<string, unknown>, _context: Context): NodeValue {
    WsNode.intentionalClose = true;
    if (WsNode.reconnectTimer) {
      clearTimeout(WsNode.reconnectTimer);
      WsNode.reconnectTimer = null;
    }
    if (WsNode.connection) {
      WsNode.connection.close();
      WsNode.connection = null;
    }
    WsNode.lastConnectDef = null;
    WsNode.lastConnectContext = null;
    WsNode.lastConnectUrl = null;
    return null;
  }

  private static openConnection(fullUrl: string, def: Record<string, unknown>, baseContext: Context): void {
    const ws = new WebSocket(fullUrl);
    WsNode.connection = ws;

    ws.onopen = () => {
      WsNode.reconnectDelay = 1000;
      if (Array.isArray(def["on-open"])) {
        Promise.resolve(runSteps(def["on-open"] as unknown[], baseContext))
          .catch(e => console.error("[WS] on-open error:", e));
      }
    };

    ws.onmessage = (e: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        data = e.data;
      }

      if (data && typeof data === "object" && (data as Record<string, unknown>).type === "welcome") {
        WsNode.localId = String((data as Record<string, unknown>).id ?? "");
      }

      if (Array.isArray(def["on-message"])) {
        baseContext.wsMessage = data;
        baseContext.wsId = WsNode.localId;
        Promise.resolve(runSteps(def["on-message"] as unknown[], baseContext))
          .catch(e => console.error("[WS] on-message error:", e));
      }
    };

    ws.onclose = () => {
      WsNode.connection = null;
      if (Array.isArray(def["on-close"])) {
        Promise.resolve(runSteps(def["on-close"] as unknown[], baseContext))
          .catch(e => console.error("[WS] on-close error:", e));
      }
      if (!WsNode.intentionalClose) {
        WsNode.scheduleReconnect();
      }
    };
  }

  private static scheduleReconnect(): void {
    if (WsNode.reconnectTimer) return;
    WsNode.reconnectTimer = setTimeout(() => {
      WsNode.reconnectTimer = null;
      WsNode.attemptReconnect();
    }, WsNode.reconnectDelay);
    WsNode.reconnectDelay = Math.min(WsNode.reconnectDelay * 2, 30000);
  }

  private static attemptReconnect(): void {
    if (WsNode.connection?.readyState === WebSocket.OPEN) return;
    if (!WsNode.lastConnectUrl || !WsNode.lastConnectDef || !WsNode.lastConnectContext) return;
    WsNode.openConnection(WsNode.lastConnectUrl, WsNode.lastConnectDef, WsNode.lastConnectContext);
  }

  static getId(): string | null {
    return WsNode.localId;
  }

  static getConnection(): WebSocket | null {
    return WsNode.connection;
  }

  static destroy(): void {
    WsNode.intentionalClose = true;
    if (WsNode.reconnectTimer) {
      clearTimeout(WsNode.reconnectTimer);
      WsNode.reconnectTimer = null;
    }
    if (WsNode.connection) {
      WsNode.connection.close();
      WsNode.connection = null;
    }
    WsNode.lastConnectDef = null;
    WsNode.lastConnectContext = null;
    WsNode.lastConnectUrl = null;
    WsNode.localId = null;
    WsNode.reconnectDelay = 1000;
    if (WsNode.visibilityHandler) {
      document.removeEventListener("visibilitychange", WsNode.visibilityHandler);
      WsNode.visibilityHandler = null;
    }
  }

  private static visibilityHandler: (() => void) | null = null;

  static initVisibilityHandler(): void {
    if (WsNode.visibilityHandler) return;
    WsNode.visibilityHandler = () => {
      const visible = document.visibilityState === "visible";
      if (visible && !WsNode.connection) {
        if (WsNode.reconnectTimer) {
          clearTimeout(WsNode.reconnectTimer);
          WsNode.reconnectTimer = null;
        }
        WsNode.reconnectDelay = 1000;
        WsNode.attemptReconnect();
      }
      const ws = WsNode.connection;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "presence", active: visible }));
      }
    };
    document.addEventListener("visibilitychange", WsNode.visibilityHandler);
  }
}

WsNode.initVisibilityHandler();
