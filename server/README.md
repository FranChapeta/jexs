# @jexs/server

Node.js server runtime for **Jexs** — HTTP, routing, database (SQLite / MySQL via knex), sessions, OAuth, email, web-push, WebSocket, Tailwind, file I/O, caching.

Your whole server — entry point, request handlers, queries, sessions, email templates — is JSON, loaded and resolved per request.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/server @jexs/core
```

## What's inside

**Server** — a small wrapper around Node's `http` and `ws` servers. Started declaratively from JSON via `ListenNode`.

**Nodes** (`serverNodes`):

| Node | Keys | Purpose |
|---|---|---|
| `ServerNode` | `listen` | Start an HTTP listener per `listen` step; can auto-serve the `@jexs/client` bundle |
| `RouterNode` | `routes` | Path-based routing with `*` / `**` segment capture |
| `FileNode` | `file`, `directory`, `disk` | Load JSON files as sub-templates, list/read/write files, report disk usage |
| `DatabaseNode` | `database` | Named connections (SQLite, MySQL): `connect`, `close`, `raw`, `tableExists`, `dropTable`, `info` |
| `QueryNode` | `query` | DB queries: `select`, `insert`, `upsert`, `update`, `delete`, `count`, `create`, `drop`, `alter` |
| `SchemaNode` | `schema` | Define/validate row schemas: `register`, `get`, `list`, `validator`, `validate` |
| `SessionNode` | `session` | Cookie-backed sessions |
| `CryptoNode` | `hash`, `verify`, `sha256`, `hmac`, `encrypt`, `decrypt`, `randomHex`, `uuid`, `timingSafeEqual` | Crypto helpers |
| `OAuthNode` | `oauth` | Generic OAuth2 (Google, GitHub, ...): `configure`, `authUrl`, `exchange`, `refresh`, `userInfo` |
| `EmailNode` | `email`, `email-connect` | SMTP via nodemailer |
| `WebPushNode` | `webpush` | Browser push over VAPID |
| `WebSocketNode` | `socket-accept`, `socket-send`, `socket-send-to`, `socket-broadcast`, `socket-join`, `socket-leave`, `socket-close`, `socket-count`, `socket-list` | WebSocket server |
| `CacheNode` | `cache-connect`, `cache-get`, `cache-set`, `cache-delete`, `cache-has`, `cache` | Memory / Redis / Memcached |
| `TailwindNode` | `tailwind` | On-demand Tailwind CSS generation |
| `TranslationNode` | `translate` | i18n |
| `DeferNode` | `defer` | Run steps after the response is sent |
| `StdioNode` | `stdio-listen`, `stdio-write`, `stdio-prompt`, `stdio-close` | Process I/O |

## Quick example — full server in JSON

`src/app.json`:

```json
[
  { "database": "connect", "filename": "data.db" },

  { "listen": 3000, "client": true, "do": [
    { "session": "load" },

    { "routes": {
      "methods": { "GET": { "file": "pages/home.json" } },
      "children": {
        "api": { "children": {
          "users": { "methods": {
            "GET": { "run": [
              { "query": "select", "table": "users", "options": { "orderBy": { "id": "desc" }, "limit": 50 } }
            ] },
            "POST": {
              "body": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } },
              "run": [
                { "query": "insert", "table": "users", "options": { "data": { "var": "$request.body" } } }
              ]
            }
          } }
        } },

        "users": { "children": {
          "*": {
            "paramName": "id",
            "paramRegex": "\\d+",
            "methods": { "GET": { "file": "pages/user.json" } }
          }
        } }
      }
    } }
  ] }
]
```

Routes are a tree, not flat path strings: `methods` handles the current path (keyed by HTTP verb), `children` nests path segments, `*` captures a single segment under `paramName` (constrained by an optional `paramRegex`), and `**` captures the remainder. A captured param is exposed to the handler as a top-level context var (`$id` above), the query string as `$request.query`, and the parsed body as `$request.body`. A handler is a `file` to render or a `run` of steps, not both, or an expression that resolves to one of those, and anything else is an error rather than a response. It may also declare `queryParams` and/or `body` JSON Schemas, validated against `$request.query` / `$request.body` and returning a 400 on failure.

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
await resolve({ file: "/index.json" }, { env: process.env });
```

Or scaffold the whole thing with [`npm create @jexs my-app`](https://github.com/FranChapeta/jexs/tree/master/create).

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
