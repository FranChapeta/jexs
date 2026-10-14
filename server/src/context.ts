// What the server keeps on a request's context for its nodes. Symbol keys, so a
// template can't read them with `$var` and request data or `$as` can't forge
// them; a spread or a child scope keeps them.

/** The `Set-Cookie` headers queued for the response. */
export const COOKIES = Symbol("jexs.cookies");
/** The parts of the page `$defer` resolves in the background, streamed after it. */
export const DEFERRED = Symbol("jexs.deferred");
/** A part of the page `$defer` resolves in the background, and the id of its placeholder. */
export type Deferred = { id: string; promise: Promise<unknown> };
/** A WebSocket upgrade waiting for `$socket-accept`. */
export const UPGRADE = Symbol("jexs.upgrade");
/** The connection a socket handler runs for, and the path it was opened on. */
export const WS = Symbol("jexs.ws");
export const WS_PATH = Symbol("jexs.wsPath");
