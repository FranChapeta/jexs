import { randomUUID, randomBytes } from "crypto";
import { CSRF_TOKEN, Node, Context, NodeValue, resolveAll, createHttpError, isObject } from "@jexs/core";
import { COOKIES } from "../context.js";
import { cacheFor, optionalName } from "./Cache.js";
import { tokensEqual } from "./Crypto.js";
import type { CacheAdapter } from "../cache/CacheAdapter.js";
import type { JexsNodeSchema } from "@jexs/core";

/**
 * A session as the cache keeps it. `data` is what templates read as `session`;
 * its CSRF token and what other nodes keep with it (`internal`, by key) sit
 * beside it, out of their reach.
 */
interface StoredSession {
  id: string;
  data: Record<string, unknown>;
  csrf: string;
  internal: Record<string, unknown>;
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

/** What another node keeps with the request's session under `key`, loading the
 *  session first when no `$session` op has (a page view starts one, as `load`
 *  does). */
export async function sessionValue(context: Context, key: string): Promise<unknown> {
  return (await openSession(context, sessionCache(context)))?.internal[key];
}

/** Keep `value` with the request's session under `key`, for another node,
 *  starting a session if the request has none. */
export async function setSessionValue(context: Context, key: string, value: unknown): Promise<void> {
  const cache = sessionCache(context);
  const stored = (await readSession(context, cache)) ?? (await initSession(context, cache));
  stored.internal[key] = value;
  await cache.set(PREFIX + stored.id, stored, TTL);
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
  // A record without a token can't be checked, so it counts as no session.
  if (!stored || typeof stored.csrf !== "string") return null;
  checkCsrf(context, stored.csrf);
  return stored;
}

/** Make `stored` the request's session: readable as `session`, reused by later
 *  ops, and its CSRF token handed to the page. */
function useSession(context: Context, cache: CacheAdapter, stored: StoredSession): Record<string, unknown> {
  context.session = stored.data;
  context[CSRF_TOKEN] = stored.csrf;
  if (context.request) current.set(context.request, { cache, stored });
  syncCsrfCookie(context, stored.csrf);
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
  const cookies = context[COOKIES];
  if (Array.isArray(cookies)) cookies.push(cookie);
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
function syncCsrfCookie(context: Context, token: string): void {
  const cookies = context.request?.cookies;
  if (cookies?.[CSRF_COOKIE] === token) return;
  if (cookies) cookies[CSRF_COOKIE] = token;
  pushCookie(context, buildCookie(context, CSRF_COOKIE, token));
}

/**
 * Store a new session with the given data and send its cookie. The id and the
 * CSRF token are always new ones: a session id the server didn't issue, such as
 * one in a cookie an attacker planted, is never adopted.
 */
async function initSession(
  context: Context,
  cache: CacheAdapter,
  data: Record<string, unknown> = {},
  internal: Record<string, unknown> = {},
): Promise<StoredSession> {
  const stored: StoredSession = { id: randomUUID(), data, csrf: newToken(), internal, createdAt: Date.now() };
  await cache.set(PREFIX + stored.id, stored, TTL);

  if (context.request) trusted.add(context.request);
  // Later ops in this request see the new id.
  if (context.request?.cookies) context.request.cookies[COOKIE_NAME] = stored.id;
  pushCookie(context, buildCookie(context, COOKIE_NAME, stored.id));
  useSession(context, cache, stored);
  return stored;
}

async function destroySession(context: Context, cache: CacheAdapter): Promise<null> {
  const stored = await readSession(context, cache);
  if (stored) await cache.delete(PREFIX + stored.id);
  if (context.request) current.delete(context.request);

  context.session = {};
  delete context[CSRF_TOKEN];
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
  if (!stored) return (await initSession(context, cache, { ...values })).data;

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
  return (await initSession(context, cache, { ...stored?.data, ...values }, stored?.internal)).data;
}

/**
 * The request's session: the one its cookie names, or a new one for a page
 * view. A state-changing request without one has nothing to protect, so it
 * gets none.
 */
async function openSession(context: Context, cache: CacheAdapter): Promise<StoredSession | null> {
  const stored = await readSession(context, cache);
  if (stored) {
    useSession(context, cache, stored);
    return stored;
  }
  if (SAFE_METHODS.includes(context.request?.method?.toUpperCase() ?? "GET")) return initSession(context, cache);
  return null;
}

async function loadSession(context: Context, cache: CacheAdapter): Promise<Record<string, unknown>> {
  const stored = await openSession(context, cache);
  if (stored) return stored.data;
  context.session = {};
  return context.session;
}
