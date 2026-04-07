import { randomUUID, randomBytes } from "crypto";
import { Node, Context, NodeValue, resolve } from "@jexs/core";
import { Cache } from "../cache/Cache.js";

/**
 * Session data stored in cache
 */
interface SessionData {
  id: string;
  data: Record<string, unknown>;
  createdAt: number;
}

const PREFIX = "session:";
const TTL = 86400; // 24 hours in seconds
const COOKIE_NAME = "sid";

/**
 * SessionNode - Handles session operations with cache persistence.
 *
 * Operations:
 * - { "session": { "user_id": 123, "name": { "var": "$name" } } } -> set values
 * - { "session": "destroy" } -> destroy session
 * - { "session": "create" } -> create new session (returns session ID for cookie)
 *
 * Reading session values is done via VariablesNode:
 * - { "var": "$session.user_id" }
 *
 * Session ID comes from context.request.cookies.sid
 * Sessions are stored in cache with prefix "session:"
 */
export class SessionNode extends Node {
  session(def: Record<string, unknown>, context: Context): NodeValue {
    const sessionOp = def.session;

    if (sessionOp === "load") return loadSession(context);
    if (sessionOp === "destroy") return destroySession(context);
    if (sessionOp === "create") return createSession(context);
    if (sessionOp === "regenerate") return regenerateSession(context);

    if (sessionOp && typeof sessionOp === "object" && !Array.isArray(sessionOp)) {
      return setSessionValues(sessionOp as Record<string, unknown>, context);
    }

    return null;
  }
}

function getSessionId(context: Context): string | null {
  return context.request?.cookies?.[COOKIE_NAME] ?? null;
}

function pushCookie(context: Context, cookie: string): void {
  if (Array.isArray(context._cookies)) {
    (context._cookies as string[]).push(cookie);
  }
}

function buildCookie(value: string, maxAge?: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ];

  if (maxAge !== undefined) {
    parts.push(`Max-Age=${maxAge}`);
  } else {
    parts.push(`Max-Age=${TTL}`);
  }

  return parts.join("; ");
}

/**
 * Create a new session entry with the given data, set cookie, update context.
 * Shared by createSession and regenerateSession.
 */
async function initSession(
  context: Context,
  data: Record<string, unknown> = {},
): Promise<SessionResult> {
  const cache = Cache.getInstance();
  const id = randomUUID();

  // Ensure CSRF token exists
  if (!data._csrf) {
    data._csrf = randomBytes(32).toString("hex");
  }

  const sessionData: SessionData = { id, data, createdAt: Date.now() };
  await cache.set(PREFIX + id, sessionData, TTL);

  context.session = data;

  // Update cookie reference so later calls in this request see the new ID
  if (context.request?.cookies) {
    context.request.cookies[COOKIE_NAME] = id;
  }

  const cookie = buildCookie(id);
  pushCookie(context, cookie);

  return { type: "session", action: "create", sessionId: id, cookie };
}

async function createSession(context: Context): Promise<SessionResult> {
  return initSession(context);
}

async function destroySession(context: Context): Promise<SessionResult> {
  const sessionId = getSessionId(context);

  if (sessionId) {
    const cache = Cache.getInstance();
    await cache.delete(PREFIX + sessionId);
  }

  context.session = {};

  const cookie = buildCookie("", 0);
  pushCookie(context, cookie);

  return {
    type: "session",
    action: "destroy",
    cookie,
  };
}

async function setSessionValues(
  values: Record<string, unknown>,
  context: Context,
): Promise<SessionResult> {
  const cache = Cache.getInstance();
  let sessionId = getSessionId(context);
  let isNew = false;

  if (!sessionId) {
    sessionId = randomUUID();
    isNew = true;
  }

  let sessionData = await cache.get<SessionData>(PREFIX + sessionId);

  if (!sessionData) {
    sessionData = {
      id: sessionId,
      data: {},
      createdAt: Date.now(),
    };
    isNew = true;
  }

  for (const [key, value] of Object.entries(values)) {
    const resolved = await resolve(value, context);
    sessionData.data[key] = resolved;
  }

  await cache.set(PREFIX + sessionId, sessionData, TTL);

  context.session = sessionData.data;

  const result: SessionResult = {
    type: "session",
    action: "set",
    data: sessionData.data,
  };

  if (isNew) {
    result.sessionId = sessionId;
    result.cookie = buildCookie(sessionId);
    pushCookie(context, result.cookie);
  }

  return result;
}

async function regenerateSession(context: Context): Promise<SessionResult> {
  const cache = Cache.getInstance();
  const oldId = getSessionId(context);

  let data: Record<string, unknown> = {};
  if (oldId) {
    const existing = await cache.get<SessionData>(PREFIX + oldId);
    if (existing) data = existing.data;
    await cache.delete(PREFIX + oldId);
  }

  // Rotate CSRF token on regeneration
  data._csrf = randomBytes(32).toString("hex");

  return initSession(context, data);
}

async function loadSession(context: Context): Promise<null> {
  const sessionId = getSessionId(context);
  if (!sessionId) {
    context.session = {};
    return null;
  }

  const cache = Cache.getInstance();
  const sessionData = await cache.get<SessionData>(PREFIX + sessionId);

  const data = sessionData?.data ?? {};

  // Auto-generate CSRF token if missing
  if (!data._csrf) {
    data._csrf = randomBytes(32).toString("hex");
    if (sessionData) {
      sessionData.data = data;
      await cache.set(PREFIX + sessionId, sessionData, TTL);
    }
  }

  context.session = data;
  return null;
}

/**
 * Session operation result
 */
export interface SessionResult {
  type: "session";
  action: "create" | "set" | "destroy";
  sessionId?: string;
  cookie?: string;
  data?: Record<string, unknown>;
}
