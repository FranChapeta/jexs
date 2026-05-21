# Jexs

**JSON Expression System**

A Jexs app is JSON. Each object key dispatches to a typed Node class: `{ "if": ..., "then": ..., "else": ... }`, `{ "tag": "div", "content": [...] }`, `{ "query": "users", "where": {...} }`. Nodes can be sync or async; the resolver walks the tree, dispatches on keys, and threads a per-request context.

## Quick start

```bash
npm create @jexs my-app
cd my-app
npm install
```

The generator scaffolds a project, wires up a JSON schema for IDE autocomplete (VS Code config included), and writes a starter `src/app.json`.

## A taste

**Pure logic** — variables, conditionals, string interpolation:

```json
[
  { "setVars": { "name": { "var": "$request.query.name" } } },
  {
    "if": { "var": "$name" },
    "then": { "concat": ["Hello, ", { "var": "$name" }, "!"] },
    "else": "Hello, world!"
  }
]
```

Top-level arrays are step lists run sequentially. Each step can store its result back into context via `"as": "varName"`.

**A server** — HTTP listener, routing, file-loaded pages:

```json
[
  { "listen": 3000, "client": true, "do": [
    { "session": "load" },
    { "routes": {
      "/":            { "file": "pages/home.json" },
      "/users/:id":   { "file": "pages/user.json", "params": { "id": { "var": "$request.params.id" } } }
    } }
  ] }
]
```

Setting `"client": true` makes the server serve the `@jexs/client` browser bundle and auto-inject the script tag into rendered `<head>` elements.

**An HTML page** — declarative element tree with reactive children:

```json
{ "tag": "html", "content": [
  { "tag": "head", "content": [{ "tag": "title", "content": ["Users"] }] },
  { "tag": "body", "content": [
    { "tag": "h1", "content": ["Members"] },
    { "tag": "ul", "content": [
      { "foreach": { "query": "users", "limit": 50 }, "item": "user", "do":
        { "tag": "li", "content": [{ "var": "$user.name" }] }
      }
    ] }
  ] }
] }
```

**A DOM event handler** — runs in the browser, attached via `data-jexs-events`:

```json
[{ "type": "click", "do": [
  { "fetch": "/api/like", "method": "POST", "as": "result" },
  { "dom-set": { "var": "$target" }, "class": { "liked": true } }
] }]
```

## Packages

| Package | Purpose | Environment |
|---|---|---|
| [`@jexs/core`](core) | Resolver engine + pure logic nodes (var, if, foreach, math, strings, arrays, dates) | any |
| [`@jexs/physics`](physics) | `EntityStore`, collision, raycasting, vectors, GLB/GLTF loading | any |
| [`@jexs/client`](client) | Browser DOM nodes, fetch, audio, WebSocket, lazy-loaded entrypoint | browser |
| [`@jexs/gl`](gl) | WebGL rendering — lighting, shadows, SSAO, particles, text, post-processing | browser |
| [`@jexs/server`](server) | HTTP, routing, DB (SQLite / MySQL), sessions, OAuth, email, web-push | Node.js |
| [`@jexs/mcp`](mcp) | MCP server exposing node introspection to Claude Code / Claude Desktop | Node.js |
| [`@jexs/create`](create) | `npm create jexs` project scaffolder | Node.js |

`@jexs/client` lazy-loads `@jexs/physics` and `@jexs/gl` only when nodes from those packages are first encountered in the JSON — pay for what you use.

## Building from source

```bash
npm install
npm run build           # tsc -b for all packages + JSON schema generation
npm run build:browser   # esbuild client bundle -> client/dist/browser/
```

## Conventions

- No emojis in code or docs.
- Prefer runtime guards over typecasting.
- Keep barrel `index.ts` concise — public API only.

## License

[MIT](LICENSE)
