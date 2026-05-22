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
| `ListenNode` | `listen` | Start the HTTP server; can auto-serve the `@jexs/client` bundle |
| `RouterNode` | `routes` | Path-based routing with `:param` capture |
| `FileNode` | `file`, `directory` | Load JSON files as sub-templates, list/read/write files |
| `DatabaseNode` | `database` | Configure named connections (SQLite, MySQL) |
| `QueryNode` | `query-select`, `query-insert`, `query-upsert`, `query-update`, `query-delete`, `query-count`, `query-create`, `query-drop`, `query-alter` | DB queries |
| `SchemaNode` | `schema` | Define/validate row schemas |
| `SessionNode` | `session` | Cookie-backed sessions |
| `CryptoNode` | `hash`, `verify`, `random-bytes`, `jwt-sign`, `jwt-verify`, ... | Crypto helpers |
| `OAuthNode` | `oauth` | Generic OAuth2 (Google, GitHub, ...) |
| `EmailNode` | `email-send` | SMTP via nodemailer |
| `WebPushNode` | `push-send`, `push-vapid` | Browser push |
| `WebSocketNode` | `ws-broadcast`, `ws-send`, `ws-handle` | WebSocket server |
| `CacheNode` | `cache-get`, `cache-set`, `cache-del` | Memory / Redis / Memcached |
| `TailwindNode` | `tailwind` | On-demand Tailwind CSS generation |
| `TranslationNode` | `translate` | i18n |
| `DeferNode` | `defer` | Run steps after the response is sent |
| `StdioNode` | `stdin`, `stdout`, `stderr`, `exit` | Process I/O |

## Quick example — full server in JSON

`src/app.json`:

```json
[
  { "database": { "default": { "client": "sqlite", "filename": "data.db" } } },

  { "listen": 3000, "client": true, "do": [
    { "session": "load" },

    { "routes": {
      "/": { "file": "pages/home.json" },

      "/api/users": {
        "if": { "eq": [{ "var": "$request.method" }, "POST"] },
        "then": { "query-insert": "users", "data": { "var": "$request.body" } },
        "else": { "query-select": "users", "orderBy": { "id": "desc" }, "limit": 50 }
      },

      "/users/:id": {
        "file": "pages/user.json",
        "params": { "id": { "var": "$request.params.id" } }
      }
    } }
  ] }
]
```

Run with `tsx src/index.ts` (or whatever entry boots `Server`):

```ts
import { createResolver, coreNodes } from "@jexs/core";
import { Server, serverNodes } from "@jexs/server";

const resolve = createResolver([...coreNodes, ...serverNodes]);
const server = new Server(resolve);
server.setEntryFile("/app.json");
await server.start();
```

Or scaffold the whole thing with [`npm create @jexs my-app`](https://github.com/FranChapeta/jexs/tree/master/create).

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
