import { randomUUID, randomBytes, timingSafeEqual } from "crypto";
import { Node, Context, NodeValue, resolve, createHttpError, isObject } from "@jexs/core";
import { cacheFor } from "./Cache.js";
import type { CacheAdapter } from "../cache/CacheAdapter.js";
import type { JexsNodeSchema } from "@jexs/core";

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
/** Methods that must not change state, so they carry no CSRF token. */
export const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** Requests that passed the CSRF check or created their own session, so later
 *  session ops in the same request don't check again (`regenerate` rotates the
 *  token the request was sent with). */
const trusted = new WeakSet<object>();

/**
 * SessionNode - Handles session operations with cache persistence.
 *
 * Operations:
 * - { "$session": { "user_id": 123, "name": { "$var": "name" } } } -> set values
 * - { "$session": "destroy" } -> destroy session
 * - { "$session": "create" } -> create new session (returns session ID for cookie)
 *
 * Reading session values is done via VariablesNode:
 * - { "$var": "session.user_id" }
 *
 * Session ID comes from context.request.cookies.sid
 * Sessions are stored in cache with prefix "session:"
 */
export class SessionNode extends Node {
  static schema: JexsNodeSchema = {
    session: {
      type: ["string", "object"],
      enum: [
        "load",
        "create",
        "destroy",
        "regenerate",
        "object",
      ],
      markdownDescription: "Manages request sessions stored in cache. Pass an object to set session values. Read values with `{ \"$var\": \"session.key\" }`.\r\nSession ID is stored in a `sid` HTTP-only cookie with a 24-hour TTL.\r\nOn a request other than GET, HEAD or OPTIONS that carries a session cookie, every operation first checks the session's CSRF token, sent as the `_csrf` body field or the `x-csrf-token` header, and fails with 403 without it. A non-GET `form` rendered with the session loaded includes the field.",
      outputDescription: "`load` returns `null`; it populates `$session` for reading. `create`/`regenerate`/`destroy`/setting values return a small status object (`{ type: \"session\", action, sessionId?, cookie }`). The `sid` cookie is queued onto the response for you; you don't return it yourself.",
      examples: [
        "{ \"$session\": { \"user_id\": { \"$var\": \"user.id\" }, \"role\": { \"$var\": \"user.role\" } } }",
      ],
    },
  };

  session(def: Record<string, unknown>, context: Context): NodeValue {
    // A literal map has its values resolved; a step may resolve to an action
    // name or to a map of values.
    return resolve(def.$session, context, op => {
      if (op === "load") return loadSession(context);
      if (op === "destroy") return destroySession(context);
      if (op === "create") return createSession(context);
      if (op === "regenerate") return regenerateSession(context);
      if (this.isObject(op)) return setSessionValues(op, context);
      return null;
    });
  }
}

function getSessionId(context: Context): string | null {
  return context.request?.cookies?.[COOKIE_NAME] ?? null;
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** The stored session the request's cookie names. Every session op reads it
 *  through here, so a forged request can't reach a session without its token. */
async function readSession(context: Context, cache: CacheAdapter, id: string): Promise<SessionData | null> {
  const session = await cache.get<SessionData>(PREFIX + id);
  if (!session) return null;
  checkCsrf(context, session.data?._csrf);
  return session;
}

/** A state-changing request must send the session's token back. */
function checkCsrf(context: Context, stored: unknown): void {
  const request = context.request;
  if (!request || trusted.has(request)) return;
  // A WebSocket upgrade can't send a token; the listener checks its origin.
  const method = request.method?.toUpperCase() ?? "GET";
  if (method === "WS" || SAFE_METHODS.includes(method)) return;
  const header = request.headers?.["x-csrf-token"];
  const submitted = (isObject(request.body) ? request.body._csrf : undefined) ?? header;
  const a = Buffer.from(typeof stored === "string" ? stored : "");
  const b = Buffer.from(typeof submitted === "string" ? submitted : "");
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createHttpError(403, "CSRF token mismatch");
  }
  trusted.add(request);
}

function pushCookie(context: Context, cookie: string): void {
  if (Array.isArray(context._cookies)) {
    (context._cookies as string[]).push(cookie);
  }
}

function shouldUseSecureCookie(context: Context): boolean {
  const baseUrl = process.env.BASE_URL;
  if (baseUrl && /^https:\/\//i.test(baseUrl)) return true;

  const forwardedProto = context.request?.headers?.["x-forwarded-proto"];
  if (typeof forwardedProto === "string") {
    return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  }

  return false;
}

function buildCookie(context: Context, value: string, maxAge?: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (shouldUseSecureCookie(context)) {
    parts.push("Secure");
  }

  if (maxAge !== undefined) {
    parts.push(`Max-Age=${maxAge}`);
  } else {
    parts.push(`Max-Age=${TTL}`);
  }

  return parts.join("; ");
}

/**
 * Create a new session entry with the given data, set cookie, update context.
 * The id is always a new one: a session id the server didn't issue, such as
 * one in a cookie an attacker planted, is never adopted.
 */
async function initSession(
  context: Context,
  data: Record<string, unknown> = {},
): Promise<SessionResult> {
  const cache = cacheFor(context);
  const id = randomUUID();

  // Ensure CSRF token exists
  if (!data._csrf) {
    data._csrf = newToken();
  }

  const sessionData: SessionData = { id, data, createdAt: Date.now() };
  await cache.set(PREFIX + id, sessionData, TTL);

  context.session = data;
  if (context.request) trusted.add(context.request);

  // Update cookie reference so later calls in this request see the new ID
  if (context.request?.cookies) {
    context.request.cookies[COOKIE_NAME] = id;
  }

  const cookie = buildCookie(context, id);
  pushCookie(context, cookie);

  return { type: "session", action: "create", sessionId: id, cookie };
}

async function createSession(context: Context): Promise<SessionResult> {
  return initSession(context);
}

async function destroySession(context: Context): Promise<SessionResult> {
  const sessionId = getSessionId(context);

  if (sessionId) {
    const cache = cacheFor(context);
    await readSession(context, cache, sessionId);
    await cache.delete(PREFIX + sessionId);
  }

  context.session = {};

  const cookie = buildCookie(context, "", 0);
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
  const cache = cacheFor(context);
  const id = getSessionId(context);
  const sessionData = id ? await readSession(context, cache, id) : null;

  if (!sessionData) {
    const { sessionId, cookie } = await initSession(context, { ...values });
    return { type: "session", action: "set", data: context.session, sessionId, cookie };
  }

  Object.assign(sessionData.data, values);
  await cache.set(PREFIX + sessionData.id, sessionData, TTL);
  context.session = sessionData.data;
  return { type: "session", action: "set", data: sessionData.data };
}

async function regenerateSession(context: Context): Promise<SessionResult> {
  const cache = cacheFor(context);
  const oldId = getSessionId(context);

  let data: Record<string, unknown> = {};
  if (oldId) {
    const existing = await readSession(context, cache, oldId);
    if (existing) data = existing.data;
    await cache.delete(PREFIX + oldId);
  }

  // Rotate CSRF token on regeneration
  data._csrf = newToken();

  return initSession(context, data);
}

async function loadSession(context: Context): Promise<null> {
  const cache = cacheFor(context);
  const id = getSessionId(context);
  const sessionData = id ? await readSession(context, cache, id) : null;

  if (!sessionData) {
    const method = context.request?.method?.toUpperCase() ?? "GET";
    if (SAFE_METHODS.includes(method)) {
      await initSession(context, {});
    } else {
      context.session = {};
    }
    return null;
  }

  const data = sessionData.data ?? {};

  // Auto-generate CSRF token if missing
  if (!data._csrf) {
    data._csrf = newToken();
    sessionData.data = data;
    await cache.set(PREFIX + sessionData.id, sessionData, TTL);
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
