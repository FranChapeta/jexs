import { randomUUID, randomBytes } from "crypto";
import { CSRF_TOKEN, Node, Context, NodeValue, resolveAll, createHttpError, freezeData, isObject } from "@jexs/core";
import { COOKIES, SESSION, SESSION_COOKIES } from "../context.js";
import { isProduction } from "../env.js";
import { CacheNode, optionalName } from "./Cache.js";
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

/**
 * What the `$session` ops of one flow keep, under `SESSION` in the scope it
 * belongs to: a request's own scope, or with no request (a CLI) the scope the
 * flow started in. Its steps reach none of it; they read the current session's
 * data as `session`.
 */
export interface SessionState {
  /** The scope it belongs to, which holds the request, the cookies queued for
   *  the response, `session` and the CSRF token a page renders. */
  scope: Context;
  /** The cache an op chose by name, for the ops after it. */
  cacheName?: string;
  /** The session the ops read or started, so later ops use it instead of
   *  reading the cache again. */
  stored?: StoredSession;
  /** The cache `stored` came from. */
  storedIn?: CacheAdapter;
  /** The CSRF token the request sent, read before any step could change its body. */
  sentCsrf: unknown;
  /** Whether the request passed the CSRF check or started its own session, so
   *  later ops don't check again (`regenerate: true` rotates the token it was
   *  sent with). */
  trusted: boolean;
  /** The session id and CSRF token the ops handed the browser, which the
   *  request's cookies don't carry. */
  issuedSid?: string;
  issuedCsrf?: string;
  /** Whether the page read the session's token to render it, which makes its
   *  HTML this visitor's alone. */
  csrfRendered: boolean;
}

const PREFIX = "session:";
const TTL = 86400; // 24 hours in seconds
/** The session id's cookie, and its name once Secure: a browser takes a
 *  `__Host-` cookie only from this exact host over TLS, so a sibling subdomain
 *  can't plant one. */
const COOKIE_NAME = "sid";
const SECURE_COOKIE_NAME = "__Host-sid";
/** The HttpOnly cookies the session keeps; steps never see them. */
export const SESSION_COOKIE_NAMES: readonly string[] = [COOKIE_NAME, SECURE_COOKIE_NAME];
/** Read by the client's `$fetch`, which sends it back as `x-csrf-token`. */
const CSRF_COOKIE = "csrf";
/** Methods that must not change state, so they carry no CSRF token. */
export const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

export class SessionNode extends Node {
  static schema: JexsNodeSchema = {
    session: {
      type: ["string", "object"],
      enum: [
        "load",
        "destroy",
      ],
      markdownDescription: "Manages request sessions stored in cache. Pass an object to set session values. Read values with `{ \"$var\": \"session.key\" }`: `session` is read-only, and only a `$session` op changes it, for the whole request whichever scope it runs in.\r\n`load` reads the session the request's cookie names and starts none: a session starts when values are first set, so a visitor with nothing stored (a crawler, say) is sent no cookie and gets a page a cache may keep.\r\nSession ID is stored in an HTTP-only cookie with a 24-hour TTL: `sid`, or `__Host-sid` once Secure. Steps never see it: `request.cookies` and the `cookie` header leave it out, so a page that shows the request cannot hand a visitor's session to anyone. Its cookies are Secure in production (`NODE_ENV=production`) and whenever the app's URL is https (`BASE_URL`, or a trusted proxy's `X-Forwarded-Proto`; see `$listen`'s `trustProxy`).\r\nOn a request other than GET, HEAD or OPTIONS that carries a session cookie, every operation first checks the session's CSRF token, sent as the `_csrf` body field or the `x-csrf-token` header, and fails with 403 without it. The client runtime sends it on its own, read from the `csrf` cookie the session sets: as the header on the page's `$fetch`, and as the field on its form posts. A page served without the client gets the field rendered into its non-GET forms instead, once there is a session, masked anew on every response so that a compressed page never repeats the token.\r\nWith no request, as in a CLI, the session belongs to the flow its first op runs in, for as long as that flow runs.",
      outputDescription: "The session's data, which `load` and setting values also make readable as `session`; `{}` from `load` when there is no session, and `null` after `destroy`. The cookies are queued onto the response for you; you don't return them yourself.",
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
    return resolveAll([def.$session, def.cache ?? null, def.regenerate ?? null], context, async ([op, cacheName, regenerate]) => {
      const state = stateOf(context);
      state.cacheName = optionalName(cacheName) ?? state.cacheName;
      if (op === "load") return (await openSession(state))?.data ?? {};
      if (op === "destroy") return destroySession(state);
      if (!this.isObject(op)) throw new Error(`$session takes "load", "destroy" or a map of values to set, got ${JSON.stringify(op)}`);
      return regenerate === true ? regenerateSession(state, op) : setSessionData(state, op);
    });
  }
}

/**
 * Give `scope` a session of its own: the state its `$session` ops keep, and
 * `session`, read-only, for the data of the session they read or started. The
 * CSRF token its request sent, as the `_csrf` body field or the `x-csrf-token`
 * header, is read now, before a step can change the request's body.
 */
export function bindSession(scope: Context): SessionState {
  const request = scope.request;
  const sentCsrf = (isObject(request?.body) ? request.body._csrf : undefined) ?? request?.headers?.["x-csrf-token"];
  const state: SessionState = { scope, sentCsrf, trusted: false, csrfRendered: false };
  scope[SESSION] = state;
  Object.defineProperty(scope, "session", { get: () => state.stored?.data, enumerable: true });
  return state;
}

/** What another node keeps with the request's session under `key`, loading the
 *  session first when no `$session` op has; nothing when there is no session. */
export async function internalValue(context: Context, key: string): Promise<unknown> {
  return (await openSession(stateOf(context)))?.internal[key];
}

/** Keep `value` with the request's session under `key`, for another node,
 *  starting a session if the request has none. */
export async function setInternalValue(context: Context, key: string, value: unknown): Promise<void> {
  const state = stateOf(context);
  const stored = (await readSession(state)) ?? (await initSession(state));
  stored.internal[key] = value;
  await cacheOf(state).set(PREFIX + stored.id, stored, TTL);
}

/** The session state a step's ops share: its request's, else the one the first
 *  op of the flow it runs in started, at the scope the flow started in. */
function stateOf(context: Context): SessionState {
  return context[SESSION] ?? bindSession(topScope(context));
}

/** The scope at the end of `context`'s parents: the one its flow started in. */
function topScope(context: Context): Context {
  let scope = context;
  for (let parent = Object.getPrototypeOf(scope); parent !== null && parent !== Object.prototype; parent = Object.getPrototypeOf(parent)) {
    scope = parent;
  }
  return scope;
}

/** The cache holding the session: the one an op chose, else the default. */
function cacheOf(state: SessionState): CacheAdapter {
  return CacheNode.cacheFor(state.scope, state.cacheName);
}

/** The request's method, upper-cased; a flow with no request reads as a GET. */
function methodOf(state: SessionState): string {
  return state.scope.request?.method?.toUpperCase() ?? "GET";
}

/**
 * The session the request's cookie names: the copy an earlier op read or
 * started, else the cache's, checked against the request's CSRF token. Every
 * op reads through here, so a forged request can't reach a session without its
 * token.
 */
async function readSession(state: SessionState): Promise<StoredSession | null> {
  const cache = cacheOf(state);
  if (state.stored && state.storedIn === cache) return state.stored;

  const name = sidCookie(state);
  const kept = state.scope[SESSION_COOKIES] as Record<string, string> | undefined;
  const id = state.issuedSid ?? kept?.[name] ?? state.scope.request?.cookies?.[name];
  if (!id) return null;
  const stored = await cache.get<StoredSession>(PREFIX + id);
  // A record without a token can't be checked, so it counts as no session.
  if (!stored || typeof stored.csrf !== "string") return null;
  checkCsrf(state, stored.csrf);
  return stored;
}

/**
 * Make `stored` the session: readable as `session`, reused by later ops, and
 * its CSRF token handed to the page, masked, and noted as rendered once the page
 * reads it. Its data is frozen, since a write to it
 * would change the session for every request holding it without a `$session`
 * op; a `$session` op replaces it instead.
 */
function useSession(state: SessionState, stored: StoredSession): Readonly<Record<string, unknown>> {
  state.stored = stored;
  state.storedIn = cacheOf(state);
  Object.defineProperty(state.scope, CSRF_TOKEN, {
    get: () => {
      state.csrfRendered = true;
      return maskToken(stored.csrf);
    },
    configurable: true,
  });
  syncCsrfCookie(state, stored.csrf);
  return freezeData(stored.data);
}

/** A state-changing request must send the session's token back. */
function checkCsrf(state: SessionState, stored: string): void {
  if (!state.scope.request || state.trusted) return;
  // A WebSocket upgrade can't send a token; the listener checks its origin.
  const method = methodOf(state);
  if (method === "WS" || SAFE_METHODS.includes(method)) return;
  // The token itself, as the client runtime sends it from the `csrf` cookie, or
  // masked, as a rendered form sends it.
  const sent = state.sentCsrf;
  if (stored === "" || typeof sent !== "string" || !(tokensEqual(stored, sent) || tokensEqual(stored, unmaskToken(sent)))) {
    throw createHttpError(403, "CSRF token mismatch");
  }
  state.trusted = true;
}

/**
 * The session's token as a page renders it: a random mask, then the token
 * XORed with it, so a new string on every response. A compressed page that
 * carried the token as is would leak it to anyone who can watch its size
 * while echoing guesses into it (BREACH); masked, its bytes never repeat.
 */
function maskToken(token: string): string {
  const bytes = Buffer.from(token);
  const mask = randomBytes(bytes.length);
  return Buffer.concat([mask, Buffer.from(bytes.map((byte, i) => byte ^ mask[i]))]).toString("base64url");
}

/** The token a masked one carries; `""` for a value no mask made. */
function unmaskToken(masked: string): string {
  const bytes = Buffer.from(masked, "base64url");
  const half = bytes.length / 2;
  if (half === 0 || !Number.isInteger(half)) return "";
  return Buffer.from(bytes.subarray(half).map((byte, i) => byte ^ bytes[i])).toString();
}

/**
 * Whether the session's cookies are Secure: in production, which is served
 * over TLS even when a proxy in front terminates it, and wherever the app's URL
 * is https. `baseUrl` is the listener's, which believes a proxy's headers only
 * when told to trust it.
 */
function isSecure(state: SessionState): boolean {
  if (isProduction()) return true;
  const baseUrl = typeof state.scope.baseUrl === "string" ? state.scope.baseUrl : process.env.BASE_URL;
  return baseUrl !== undefined && /^https:\/\//i.test(baseUrl);
}

/** The name the session id's cookie has on this request. */
function sidCookie(state: SessionState): string {
  return isSecure(state) ? SECURE_COOKIE_NAME : COOKIE_NAME;
}

/** Queue a `Set-Cookie` onto the response, when there is one. */
function queueCookie(state: SessionState, name: string, value: string, maxAge = TTL): void {
  const cookies = state.scope[COOKIES];
  if (!Array.isArray(cookies)) return;
  cookies.push([
    `${name}=${value}`,
    "Path=/",
    // The session id stays out of reach of page scripts; the CSRF token is
    // meant for them, so `$fetch` can send it back.
    ...(name === CSRF_COOKIE ? [] : ["HttpOnly"]),
    "SameSite=Lax",
    ...(isSecure(state) ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; "));
}

/**
 * Hand the page the session's CSRF token in a cookie its scripts can read,
 * whenever the browser's copy is missing or stale (a new session, a rotation,
 * a session from before the cookie existed). Keeping it out of the HTML is
 * what lets pages be cached while `$fetch` still sends the token.
 */
function syncCsrfCookie(state: SessionState, token: string): void {
  if ((state.issuedCsrf ?? state.scope.request?.cookies?.[CSRF_COOKIE]) === token) return;
  state.issuedCsrf = token;
  queueCookie(state, CSRF_COOKIE, token);
}

/**
 * Store a new session with the given data and send its cookie. The id and the
 * CSRF token are always new ones: a session id the server didn't issue, such as
 * one in a cookie an attacker planted, is never adopted.
 */
async function initSession(
  state: SessionState,
  data: Record<string, unknown> = {},
  internal: Record<string, unknown> = {},
): Promise<StoredSession> {
  const stored: StoredSession = { id: randomUUID(), data, csrf: randomBytes(32).toString("hex"), internal, createdAt: Date.now() };
  await cacheOf(state).set(PREFIX + stored.id, stored, TTL);

  state.trusted = true;
  // Later ops see the new id.
  state.issuedSid = stored.id;
  queueCookie(state, sidCookie(state), stored.id);
  useSession(state, stored);
  return stored;
}

async function destroySession(state: SessionState): Promise<null> {
  const stored = await readSession(state);
  if (stored) await cacheOf(state).delete(PREFIX + stored.id);
  state.stored = undefined;
  delete state.scope[CSRF_TOKEN];
  queueCookie(state, sidCookie(state), "", 0);
  queueCookie(state, CSRF_COOKIE, "", 0);
  return null;
}

/**
 * Set `values` on the session, starting one if there is none. The data is
 * replaced, never changed in place, since it is frozen and may be shared with
 * other requests; `values` is copied in, so a step changing what it set them
 * from changes nothing stored. A spread keeps a `__proto__` key a key.
 */
async function setSessionData(state: SessionState, values: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>> {
  const stored = await readSession(state);
  if (!stored) return (await initSession(state, structuredClone(values))).data;

  stored.data = { ...stored.data, ...structuredClone(values) };
  await cacheOf(state).set(PREFIX + stored.id, stored, TTL);
  return useSession(state, stored);
}

/** Move the session to a new id and token, keeping its data, then set `values`. */
async function regenerateSession(state: SessionState, values: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>> {
  const stored = await readSession(state);
  if (stored) await cacheOf(state).delete(PREFIX + stored.id);
  // A new token as well as a new id, so one obtained before can't ride along.
  return (await initSession(state, { ...stored?.data, ...structuredClone(values) }, stored?.internal)).data;
}

/**
 * The session the request's cookie names, if there is one. Reading starts
 * none: a visitor with nothing stored is sent no cookie, so the page they get
 * is the same as any other's and a cache may keep it. A request without a
 * session has nothing for a token to protect.
 */
async function openSession(state: SessionState): Promise<StoredSession | null> {
  const stored = await readSession(state);
  if (stored) useSession(state, stored);
  return stored;
}
