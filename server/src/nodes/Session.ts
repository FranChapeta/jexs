import { randomUUID, randomBytes } from "crypto";
import { Node, Context, NodeValue, resolveAll, createHttpError, isObject } from "@jexs/core";
import { cacheFor, optionalName } from "./Cache.js";
import { tokensEqual } from "./Crypto.js";
import type { CacheAdapter } from "../cache/CacheAdapter.js";
import type { JexsNodeSchema } from "@jexs/core";

/** A session as the cache keeps it. */
interface StoredSession {
  id: string;
  data: Record<string, unknown>;
  createdAt: number;
}

const PREFIX = "session:";
const TTL = 86400; // 24 hours in seconds
const COOKIE_NAME = "sid";
/** Read by the client's `$fetch`, which sends it back as `x-csrf-token`. */
const CSRF_COOKIE = "csrf";
/** Methods that must not change state, so they carry no CSRF token. */
export const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** Requests that passed the CSRF check or created their own session, so later
 *  session ops in the same request don't check again (`regenerate: true`
 *  rotates the token the request was sent with). */
const trusted = new WeakSet<object>();

/** The cache each request's session ops chose, so later ops in it use the same one. */
const chosenCache = new WeakMap<object, string>();

/** The session each request has read or started, and the cache it came from, so
 *  later ops in the request use that copy instead of reading the cache again.
 *  Its `data` is what `session` holds. */
const current = new WeakMap<object, { cache: CacheAdapter; stored: StoredSession }>();

export class SessionNode extends Node {
  static schema: JexsNodeSchema = {
    session: {
      type: ["string", "object"],
      enum: [
        "load",
        "destroy",
        "object",
      ],
      markdownDescription: "Manages request sessions stored in cache. Pass an object to set session values. Read values with `{ \"$var\": \"session.key\" }`.\r\nSession ID is stored in a `sid` HTTP-only cookie with a 24-hour TTL.\r\nOn a request other than GET, HEAD or OPTIONS that carries a session cookie, every operation first checks the session's CSRF token, sent as the `_csrf` body field or the `x-csrf-token` header, and fails with 403 without it. The client runtime sends it on its own, read from the `csrf` cookie the session sets: as the header on the page's `$fetch`, and as the field on its form posts. A page served without the client gets the field rendered into its non-GET forms instead.",
      outputDescription: "The session's data, which `load` and setting values also make readable as `session`; `null` after `destroy`. The cookies are queued onto the response for you; you don't return them yourself.",
      examples: [
        "{ \"$session\": { \"user_id\": { \"$var\": \"user.id\" }, \"role\": { \"$var\": \"user.role\" } }, \"regenerate\": true }",
        "{ \"$session\": \"load\", \"cache\": \"sessions\" }",
      ],
      siblings: {
        cache: {
          type: "string",
          description: "Named cache that stores sessions, remembered for the rest of the request; the default cache if omitted.",
        },
        regenerate: {
          type: "boolean",
          description: "With values: move the session to a new id and CSRF token first, keeping its data, then set them. Do this when a user logs in or changes privileges, so an id or token obtained before cannot ride along. `{}` rotates without setting anything.",
        },
      },
    },
  };

  session(def: Record<string, unknown>, context: Context): NodeValue {
    // A literal map has its values resolved; a step may resolve to an action
    // name or to a map of values.
    return resolveAll([def.$session, def.cache ?? null, def.regenerate ?? null], context, ([op, cacheName, regenerate]) => {
      const cache = sessionCache(context, optionalName(cacheName));
      if (op === "load") return loadSession(context, cache);
      if (op === "destroy") return destroySession(context, cache);
      if (!this.isObject(op)) return null;
      return regenerate === true ? regenerateSession(op, context, cache) : setSessionValues(op, context, cache);
    });
  }
}

/** The request's session data for another node, loading it first when no
 *  `$session` op has (a page view starts one, as `load` does). */
export function sessionData(context: Context): Promise<Record<string, unknown>> {
  return loadSession(context, sessionCache(context));
}

/** Merge values into the request's session for another node, starting one if
 *  the request has none. */
export async function setSessionData(context: Context, values: Record<string, unknown>): Promise<void> {
  await setSessionValues(values, context, sessionCache(context));
}

/** The cache holding this request's session: the op's own `cache`, else the one
 *  an earlier op in the request chose, else the default. */
function sessionCache(context: Context, name?: string): CacheAdapter {
  const request = context.request;
  if (name !== undefined && request) chosenCache.set(request, name);
  return cacheFor(context, name ?? (request ? chosenCache.get(request) : undefined));
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The session the request's cookie names: the copy an earlier op in this
 * request read or started, else the cache's, checked against the request's
 * CSRF token. Every op reads through here, so a forged request can't reach a
 * session without its token.
 */
async function readSession(context: Context, cache: CacheAdapter): Promise<StoredSession | null> {
  const request = context.request;
  const known = request ? current.get(request) : undefined;
  if (known?.cache === cache) return known.stored;

  const id = request?.cookies?.[COOKIE_NAME];
  if (!id) return null;
  const stored = await cache.get<StoredSession>(PREFIX + id);
  if (!stored) return null;
  checkCsrf(context, stored.data._csrf);
  return stored;
}

/** Make `stored` the request's session: readable as `session`, reused by later
 *  ops, and its CSRF token handed to the page. */
function useSession(context: Context, cache: CacheAdapter, stored: StoredSession): Record<string, unknown> {
  context.session = stored.data;
  if (context.request) current.set(context.request, { cache, stored });
  syncCsrfCookie(context, stored.data);
  return stored.data;
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
  if (typeof stored !== "string" || stored === "" || typeof submitted !== "string" || !tokensEqual(stored, submitted)) {
    throw createHttpError(403, "CSRF token mismatch");
  }
  trusted.add(request);
}

function pushCookie(context: Context, cookie: string): void {
  if (Array.isArray(context._cookies)) context._cookies.push(cookie);
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

function buildCookie(context: Context, name: string, value: string, maxAge = TTL): string {
  return [
    `${name}=${value}`,
    "Path=/",
    // The session id stays out of reach of page scripts; the CSRF token is
    // meant for them, so `$fetch` can send it back.
    ...(name === COOKIE_NAME ? ["HttpOnly"] : []),
    "SameSite=Lax",
    ...(shouldUseSecureCookie(context) ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/**
 * Hand the page the session's CSRF token in a cookie its scripts can read,
 * whenever the browser's copy is missing or stale (a new session, a rotation,
 * a session from before the cookie existed). Keeping it out of the HTML is
 * what lets pages be cached while `$fetch` still sends the token.
 */
function syncCsrfCookie(context: Context, data: Record<string, unknown>): void {
  const token = data._csrf;
  const cookies = context.request?.cookies;
  if (typeof token !== "string" || cookies?.[CSRF_COOKIE] === token) return;
  if (cookies) cookies[CSRF_COOKIE] = token;
  pushCookie(context, buildCookie(context, CSRF_COOKIE, token));
}

/**
 * Store a new session with the given data and send its cookie. The id is
 * always a new one: a session id the server didn't issue, such as one in a
 * cookie an attacker planted, is never adopted.
 */
async function initSession(
  context: Context,
  cache: CacheAdapter,
  data: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  data._csrf ||= newToken();
  const stored: StoredSession = { id: randomUUID(), data, createdAt: Date.now() };
  await cache.set(PREFIX + stored.id, stored, TTL);

  if (context.request) trusted.add(context.request);
  // Later ops in this request see the new id.
  if (context.request?.cookies) context.request.cookies[COOKIE_NAME] = stored.id;
  pushCookie(context, buildCookie(context, COOKIE_NAME, stored.id));
  return useSession(context, cache, stored);
}

async function destroySession(context: Context, cache: CacheAdapter): Promise<null> {
  const stored = await readSession(context, cache);
  if (stored) await cache.delete(PREFIX + stored.id);
  if (context.request) current.delete(context.request);

  context.session = {};
  pushCookie(context, buildCookie(context, COOKIE_NAME, "", 0));
  pushCookie(context, buildCookie(context, CSRF_COOKIE, "", 0));
  return null;
}

async function setSessionValues(
  values: Record<string, unknown>,
  context: Context,
  cache: CacheAdapter,
): Promise<Record<string, unknown>> {
  const stored = await readSession(context, cache);
  if (!stored) return initSession(context, cache, { ...values });

  Object.assign(stored.data, values);
  await cache.set(PREFIX + stored.id, stored, TTL);
  return useSession(context, cache, stored);
}

/** Move the session to a new id and token, keeping its data, then set `values`. */
async function regenerateSession(
  values: Record<string, unknown>,
  context: Context,
  cache: CacheAdapter,
): Promise<Record<string, unknown>> {
  const stored = await readSession(context, cache);
  if (stored) await cache.delete(PREFIX + stored.id);
  // A new token as well as a new id, so one obtained before can't ride along.
  return initSession(context, cache, { ...stored?.data, ...values, _csrf: newToken() });
}

async function loadSession(context: Context, cache: CacheAdapter): Promise<Record<string, unknown>> {
  const stored = await readSession(context, cache);
  if (stored) return useSession(context, cache, stored);

  // A page view starts a session; a state-changing request without one has
  // nothing to protect, so it gets none.
  if (SAFE_METHODS.includes(context.request?.method?.toUpperCase() ?? "GET")) return initSession(context, cache);
  context.session = {};
  return context.session;
}
