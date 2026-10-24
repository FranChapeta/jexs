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
| `FileNode` | `file`, `fileExists`, `fileStat`, `fileDelete`, `directory`, `directoryCreate`, `disk` | Load JSON files as sub-templates, read/write/copy/move/delete files, list and create directories, report disk usage |
| `DatabaseNode` | `database` | Named connections (SQLite, MySQL, PostgreSQL), picked with `connection`: `connect`, `close`, `raw`, `info`, the `tables` it has, steps run in a `transaction`, and the `validator` every query and table change on it passes |
| `DatabaseTableNode` | `tableCreate`, `tableSync`, `tableAlter`, `tableRename`, `tableDrop` | Tables, from table documents: create them, make the database match (`tableSync`), alter columns and indexes |
| `DatabaseQueryNode` | `querySelect`, `queryInsert`, `queryUpsert`, `queryUpdate`, `queryDelete`, `queryCount` | Rows, each op valued by its table |
| `SchemaNode` | `schema` | JSON Schema: `register` schemas (a table document as `table/<name>`) that route bodies, rows and other schemas can `$ref`, `unregister`, `list`, `validate` |
| `SessionNode` | `session` | Cookie-backed sessions, kept in a cache: `load`, set values (with `regenerate: true` at login), `destroy` |
| `CryptoNode` | `hash`, `verify`, `sha256`, `hmac`, `encrypt`, `decrypt`, `randomHex`, `uuid`, `timingSafeEqual` | Crypto helpers |
| `OAuthNode` | `oauth` | Generic OAuth2 (Google, GitHub, ...): `configure`, `authUrl`, `exchange`, `refresh`, `userInfo`; the login's state and PKCE verifier wait in the session, so a callback is just `{ "$oauth": "exchange" }` |
| `EmailNode` | `email`, `emailConnect` | SMTP via nodemailer |
| `WebPushNode` | `webpush` | Browser push over VAPID |
| `WebSocketNode` | `socketAccept`, `socketSend`, `socketSendTo`, `socketBroadcast`, `socketJoin`, `socketLeave`, `socketClose`, `socketCount`, `socketList` | WebSocket server |
| `CacheNode` | `cacheConnect`, `cacheGet`, `cacheSet`, `cacheDelete`, `cacheHas`, `cache` | Named caches (memory, Redis, Memcached), picked with `connection` |
| `TailwindNode` | `tailwind` | On-demand Tailwind CSS generation |
| `TranslationNode` | `translate` | i18n |
| `DeferNode` | `defer` | Run steps after the response is sent |
| `StdioNode` | `stdioListen`, `stdioWrite`, `stdioPrompt`, `stdioClose` | Process I/O |

## Quick example — full server in JSON

`src/app.json`:

```json
[
  { "$database": "connect", "filename": "data.db" },
  { "$schema": "register", "path": "db/tables" },
  { "$tableSync": "*" },

  { "$listen": 3000, "client": true, "do": [
    { "$session": "load" },

    { "$routes": {
      "methods": { "GET": { "$file": "pages/home.json" } },
      "children": {
        "api": { "children": {
          "users": { "methods": {
            "GET": { "do": [
              { "$querySelect": "users", "orderBy": { "id": "desc" }, "limit": 50 }
            ] },
            "POST": {
              "body": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } },
              "do": [
                { "$queryInsert": "users", "data": { "$var": "request.body" } }
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

Routes are a tree, not flat path strings: `methods` handles the current path (keyed by HTTP verb), `children` nests path segments, `*` captures a single segment under `paramName` (constrained by an optional `paramRegex`, which must match the whole segment), and `**` captures the remainder. A captured param is exposed to the handler as `request.params` (`request.params.id` above), beside the query string as `request.query` and the parsed body as `request.body`. A handler is a `$file` step to render or a `do` of steps, not both, or an expression that resolves to one of those, and anything else is an error rather than a response. What the `$listen` steps yield, a `$return`'s value or the last step's, is the response: a string is sent as HTML and any other value as JSON, and a response object (one with a `response`, its body) chooses how with `responseStatus`, `responseType` and `responseHeaders`, as `{ "response": "/login", "responseType": "redirect" }` or `{ "response": { "id": 7 }, "responseStatus": 201 }` do. A handler may also declare `queryParams` and/or `body` JSON Schemas, validated against `request.query` / `request.body` and returning a 400 on failure.

A route node can also be a step that produces one. It is resolved only when the matcher reaches it, after the params above it are captured into `request.params`, so `"admin": { "$if": { "$var": "session.admin" }, "then": { "$var": "adminRoutes" } }` adds the admin subtree only for admins, and a failed condition leaves no node there. Hold such a subtree by reference, stored with `{ "$setVars": { "adminRoutes": { ... } }, "data": true }` or loaded with `{ "$file": "routes/admin.json", "data": true }`: `$if` resolves the branch it picks, so an inline subtree would run its handlers.

## Security defaults

These are on without any configuration:

- **CSRF.** On a POST, PUT, PATCH or DELETE that carries a session cookie, every `$session` op first checks the session's token, sent as the `_csrf` body field or the `x-csrf-token` header, and answers 403 without it. A page that loads `@jexs/client` sends it on its own, on its `$fetch` calls and its form posts, read from the `csrf` cookie the session sets; a page served without the client gets the field rendered into its forms.
- **Cross-site requests.** A state-changing request or WebSocket upgrade that a browser sends from another site's page is refused with 403 before any step runs. Requests from outside a browser (webhooks, scripts) pass. Allow other origins with `$listen`'s `trustedOrigins`.
- **Session ids.** A cookie naming a session the server doesn't hold is never adopted, so a planted cookie can't choose a user's session. Log in with `{ "$session": { "user_id": ... }, "regenerate": true }`, which also moves the session to a new id and token.
- **Session cookies.** In production (`NODE_ENV=production`, which `jexs run --prod` sets) and whenever the app's URL is https, the session's cookies are `Secure`, and its id's is named `__Host-sid`, which a browser accepts only from this exact host.
- **Proxies.** `X-Forwarded-Host` and `X-Forwarded-Proto` are ignored, since any client can send them, unless `$listen` has `trustProxy: true` because a proxy in front sets them.
- **Secrets.** `$encrypt` and `$decrypt` key off `APP_SECRET`. In production it must be set; elsewhere a `secret.key` file is generated once as a fallback.
- **Caching.** A response that sets a cookie gets `Cache-Control: private="Set-Cookie"` unless it sets its own, so a shared cache never hands one visitor's cookies to another.
- **Source maps.** `.map` files in `public/` are not served, so a deploy can't hand out the app's own sources; the client bundle's maps still are.
- **Values are data.** Request bodies, rows and anything read with `$var` render as values; steps inside them never run.

Run with the `jexs` CLI — it resolves the entry as steps, and each `listen` step in it binds a port (add more `listen` steps to serve more ports). The second argument is the root a `/`-prefixed path anchors at; without it, the current directory:

```bash
jexs run app/index.json app
```

`jexs schema` writes the project's `.jexs/` schemas for editor autocomplete and the MCP server, and `jexs schema --package` prebuilds a node package's own `dist/schema.json`. `jexs --help` lists every command.

Or programmatically — build a resolver and resolve the entry; an HTTP app is just an entry with `listen` step(s):

```ts
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "@jexs/server";

const resolve = createResolver([...coreNodes(), ...serverNodes({ root: "app" })]);
// resolves /index.json (anchored at the app/ root); its `listen` step(s) create the listeners
await resolve({ $file: "/index.json" }, { env: process.env });
```

The nodes' own messages (a port bound, a cache connected, an error caught in a detached handler) go to the resolver's `logger`, the console unless you pass one: `createResolver(nodes, { logger: { info, warn, error } })`. The `jexs` CLI writes them all to stderr, so stdout carries only what the app writes; `jexs run --log=stdout` sends them to stdout instead, for a platform that reads a server's log there, and `--log=silent` drops them.

Or scaffold the whole thing with [`npm create @jexs my-app`](https://github.com/FranChapeta/jexs/tree/master/create).

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
