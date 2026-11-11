import type { Validator } from "./nodes/Database.js";
import type { SessionState } from "./nodes/Session.js";

// What the server keeps on a request's context for its nodes. Symbol keys, so a
// template can't read them with `$var` and request data or `$as` can't forge
// them; a spread or a child scope keeps them.

/** The `Set-Cookie` headers queued for the response. */
export const COOKIES = Symbol("jexs.cookies");
/** The innermost `$database: "validator"` around a step, whose `scope` holds the one around it. */
export const DATABASE_VALIDATORS = Symbol("jexs.databaseValidators");
/** The cookies the session ops keep from steps: the session id's, HttpOnly, as
 *  the request sent it. `request.cookies` and its `cookie` header leave it out,
 *  so a page that echoes them can't hand a visitor's session to anyone. */
export const SESSION_COOKIES = Symbol("jexs.sessionCookies");
/** The session a scope's `$session` ops keep, which its `session` reads. */
export const SESSION = Symbol("jexs.session");
/** The parts of the page `$defer` resolves in the background, streamed after it. */
export const DEFERRED = Symbol("jexs.deferred");
/** A part of the page `$defer` resolves in the background, and the id of its
 *  placeholder. Its HTML never rejects: a failed part is logged and left empty. */
export type Deferred = { id: string; html: Promise<string> };
/** A WebSocket upgrade waiting for `$socketAccept`. */
export const UPGRADE = Symbol("jexs.upgrade");
/** The connection a socket handler runs for, and the path it was opened on. */
export const WS = Symbol("jexs.ws");
export const WS_PATH = Symbol("jexs.wsPath");

// What a request's steps read, which templates reach with `$var`.
declare module "@jexs/core" {
  interface Context {
    /** The HTTP request a `$listen` step is answering. */
    request?: {
      method?: string;
      path?: string;
      body?: Record<string, unknown>;
      /** The body as the text it came as, for checking a signature over it. */
      rawBody?: string;
      query?: Record<string, unknown>;
      params?: Record<string, unknown>;
      headers?: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string>;
      /** The client's address. */
      ip?: string;
    };
    /** The request's session data, once a `$session` step has loaded it. */
    session?: Record<string, unknown>;
    [DATABASE_VALIDATORS]?: Validator;
    [SESSION]?: SessionState;
  }
}
