import { Node, Context, NodeValue } from "@jexs/core";
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

  async ["ws-connect"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const url = String(await resolve(def["ws-connect"], context));
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

    // Store for reconnection
    WsNode.lastConnectDef = def;
    WsNode.lastConnectContext = context;
    WsNode.lastConnectUrl = fullUrl;

    WsNode.openConnection(fullUrl, def, context);

    return null;
  }

  async ["ws-send"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const data = await resolve(def["ws-send"], context);
    if (!WsNode.connection || WsNode.connection.readyState !== WebSocket.OPEN) return null;
    WsNode.connection.send(typeof data === "string" ? data : JSON.stringify(data));
    return null;
  }

  async ["ws-close"](_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
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
        WsNode.runSteps(def["on-open"] as unknown[], baseContext);
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
        WsNode.runSteps(def["on-message"] as unknown[], baseContext);
      }
    };

    ws.onclose = () => {
      WsNode.connection = null;
      if (Array.isArray(def["on-close"])) {
        WsNode.runSteps(def["on-close"] as unknown[], baseContext);
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
    // Exponential backoff, cap at 30s
    WsNode.reconnectDelay = Math.min(WsNode.reconnectDelay * 2, 30000);
  }

  private static attemptReconnect(): void {
    if (WsNode.connection?.readyState === WebSocket.OPEN) return;
    if (!WsNode.lastConnectUrl || !WsNode.lastConnectDef || !WsNode.lastConnectContext) return;
    WsNode.openConnection(WsNode.lastConnectUrl, WsNode.lastConnectDef, WsNode.lastConnectContext);
  }

  private static async runSteps(steps: unknown[], context: Context): Promise<void> {
    try {
      for (const step of steps) {
        const result = await resolve(step, context);
        if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
          const varName = String((step as Record<string, unknown>).as).replace(/^\$/, "");
          context[varName] = result;
        }
      }
    } catch (error) {
      console.error("[WS] Error in step execution:", error);
    }
  }

  static getId(): string | null {
    return WsNode.localId;
  }

  static getConnection(): WebSocket | null {
    return WsNode.connection;
  }

  /** Clean up all static state: close connection, cancel reconnect, remove listeners. */
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

  /** @internal — called once at module init to set up visibility reconnection. */
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

// Initialize visibility handler
WsNode.initVisibilityHandler();
