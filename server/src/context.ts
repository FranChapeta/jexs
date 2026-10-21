// What the server keeps on a request's context for its nodes. Symbol keys, so a
// template can't read them with `$var` and request data or `$as` can't forge
// them; a spread or a child scope keeps them.

/** The `Set-Cookie` headers queued for the response. */
export const COOKIES = Symbol("jexs.cookies");
/** The parts of the page `$defer` resolves in the background, streamed after it. */
export const DEFERRED = Symbol("jexs.deferred");
/** A part of the page `$defer` resolves in the background, and the id of its
 *  placeholder. Its HTML never rejects: a failed part is logged and left empty. */
export type Deferred = { id: string; html: Promise<string> };
/** A WebSocket upgrade waiting for `$socket-accept`. */
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
      query?: Record<string, unknown>;
      params?: Record<string, unknown>;
      headers?: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string>;
    };
    /** The request's session data, once a `$session` step has loaded it. */
    session?: Record<string, unknown>;
  }
}
