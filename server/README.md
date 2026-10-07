# @jexs/server

Node.js server runtime for **Jexs** — HTTP, routing, database (SQLite / MySQL / PostgreSQL via knex), sessions, OAuth, email, web-push, WebSocket, Tailwind, file I/O, caching.

Your whole server — entry point, request handlers, queries, sessions, email templates — is JSON, loaded and resolved per request.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/server @jexs/core
```

## What's inside

**Server** — a small wrapper around Node's `http` and `ws` servers, started from JSON with `$listen`.

**Nodes** (`serverNodes`):

| Node | Keys | Purpose |
|---|---|---|
| `ServerNode` | `listen` | Start an HTTP listener per `listen` step (port `0` takes any free one; the step returns the port); can auto-serve the `@jexs/client` bundle |
| `RouterNode` | `routes` | Path-based routing with `*` / `**` segment capture |
| `FileNode` | `file`, `directory`, `disk` | Load JSON files as sub-templates, list/read/write files, report disk usage |
| `DatabaseNode` | `database` | Named connections (SQLite, MySQL, PostgreSQL), picked with `connection`: `connect`, `close`, `raw`, `tableExists`, `dropTable`, `info` |
| `QueryNode` | `query` | DB queries: `select`, `insert`, `upsert`, `update`, `delete`, `count`, `create`, `drop`, `alter` |
| `SchemaNode` | `schema` | Define/validate row schemas: `register`, `get`, `list`, `validator`, `validate` |
| `SessionNode` | `session` | Cookie-backed sessions, kept in a cache: `load`, set values (with `regenerate: true` at login), `destroy` |
| `CryptoNode` | `hash`, `verify`, `sha256`, `hmac`, `encrypt`, `decrypt`, `randomHex`, `uuid`, `timingSafeEqual` | Crypto helpers |
| `OAuthNode` | `oauth` | Generic OAuth2 (Google, GitHub, ...): `configure`, `authUrl`, `exchange`, `refresh`, `userInfo`; the login's state and PKCE verifier wait in the session, so a callback is just `{ "$oauth": "exchange" }` |
| `EmailNode` | `email`, `email-connect` | SMTP via nodemailer |
| `WebPushNode` | `webpush` | Browser push over VAPID |
| `WebSocketNode` | `socket-accept`, `socket-send`, `socket-send-to`, `socket-broadcast`, `socket-join`, `socket-leave`, `socket-close`, `socket-count`, `socket-list` | WebSocket server |
| `CacheNode` | `cache-connect`, `cache-get`, `cache-set`, `cache-delete`, `cache-has`, `cache` | Named caches (memory, Redis, Memcached), picked with `connection` |
| `TailwindNode` | `tailwind` | On-demand Tailwind CSS generation |
| `TranslationNode` | `translate` | i18n |
| `DeferNode` | `defer` | Run steps after the response is sent |
| `StdioNode` | `stdio-listen`, `stdio-write`, `stdio-prompt`, `stdio-close` | Process I/O |

## Quick example — full server in JSON

`src/app.json`:

```json
[
  { "$database": "connect", "filename": "data.db" },

  { "$listen": 3000, "client": true, "do": [
    { "$session": "load" },

    { "$routes": {
      "methods": { "GET": { "$file": "pages/home.json" } },
      "children": {
        "api": { "children": {
          "users": { "methods": {
            "GET": { "run": [
              { "$query": "select", "table": "users", "orderBy": { "id": "desc" }, "limit": 50 }
            ] },
            "POST": {
              "body": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } },
              "run": [
                { "$query": "insert", "table": "users", "data": { "$var": "request.body" } }
              ]
            }
          } }
        } },

        "users": { "children": {
          "*": {
            "paramName": "id",
            "paramRegex": "\\d+",
            "methods": { "GET": { "$file": "pages/user.json" } }
          }
        } }
      }
    } }
  ] }
]
```

Routes are a tree, not flat path strings: `methods` handles the current path (keyed by HTTP verb), `children` nests path segments, `*` captures a single segment under `paramName` (constrained by an optional `paramRegex`, which must match the whole segment), and `**` captures the remainder. A captured param is exposed to the handler as a top-level context var (`id` above), the query string as `request.query`, and the parsed body as `request.body`. A handler is a `$file` step to render or a `run` of steps, not both, or an expression that resolves to one of those, and anything else is an error rather than a response. It may also declare `queryParams` and/or `body` JSON Schemas, validated against `request.query` / `request.body` and returning a 400 on failure.

A route node can also be a step that produces one. It is resolved only when the matcher reaches it, after the params above it are captured, so `"admin": { "$if": { "$var": "session.admin" }, "then": { "$var": "adminRoutes" } }` adds the admin subtree only for admins, and a failed condition leaves no node there. Hold such a subtree by reference, stored with `{ "$setVars": { "adminRoutes": { ... } }, "data": true }` or loaded with `{ "$file": "routes/admin.json", "data": true }`: `$if` resolves the branch it picks, so an inline subtree would run its handlers.

## Security defaults

These are on without any configuration:

- **CSRF.** On a POST, PUT, PATCH or DELETE that carries a session cookie, every `$session` op first checks the session's token, sent as the `_csrf` body field or the `x-csrf-token` header, and answers 403 without it. A page that loads `@jexs/client` sends it on its own, on its `$fetch` calls and its form posts, read from the `csrf` cookie the session sets; a page served without the client gets the field rendered into its forms.
- **Cross-site requests.** A state-changing request or WebSocket upgrade that a browser sends from another site's page is refused with 403 before any step runs. Requests from outside a browser (webhooks, scripts) pass. Allow other origins with `$listen`'s `trustedOrigins`.
- **Session ids.** A cookie naming a session the server doesn't hold is never adopted, so a planted cookie can't choose a user's session. Log in with `{ "$session": { "user_id": ... }, "regenerate": true }`, which also moves the session to a new id and token.
- **Caching.** A response that sets a cookie gets `Cache-Control: private="Set-Cookie"` unless it sets its own, so a shared cache never hands one visitor's cookies to another.
- **Values are data.** Request bodies, rows and anything read with `$var` render as values; steps inside them never run.

Run with the `jexs` CLI — it resolves the entry as steps, and each `listen` step in it binds a port (add more `listen` steps to serve more ports):

```bash
jexs run app/index.json app
```

Or programmatically — build a resolver and resolve the entry; an HTTP app is just an entry with `listen` step(s):

```ts
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "@jexs/server";

const resolve = createResolver([...coreNodes(), ...serverNodes({ root: "app" })]);
// resolves /index.json (anchored at the app/ root); its `listen` step(s) create the listeners
await resolve({ $file: "/index.json" }, { env: process.env });
```

Or scaffold the whole thing with [`npm create @jexs my-app`](https://github.com/FranChapeta/jexs/tree/master/create).

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
