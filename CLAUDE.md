# Jexs — JSON Expression System

Monorepo for the Jexs library. JSON as a declarative expression language — all UI, logic, routing, and data operations defined in JSON templates, resolved at runtime by typed Node classes.

## Packages

- `core/` — Resolver engine + pure logic nodes (env-agnostic, no DOM or Node.js deps)
- `physics/` — EntityStore, physics simulation, collision, vectors (env-agnostic)
- `client/` — Browser DOM nodes + lazy-loaded entry point
- `gl/` — WebGL rendering (used by client via lazy import)
- `server/` — HTTP server, DB, auth, cache, routing (Node.js)

## Build

```bash
npm run build          # tsc -b all packages
npm run build:browser  # esbuild client → client/dist/browser/
```

Packages use TypeScript project references (`composite: true`, `tsc -b`).

## Architecture

- **Resolver** (`core/src/Resolver.ts`) — walks JSON, dispatches keys to registered Nodes. `registerNode()` for eager, `registerLazy()` for code-split.
- **Node** (`core/src/nodes/Node.ts`) — base class. Each method name matches a JSON key (e.g. `if`, `foreach`, `query`).
- **Barrel exports** — each package has `src/index.ts` re-exporting public API.
- **Client auto-serve** — `{ "listen": 3000, "client": true }` in JSON makes the server serve the pre-built browser bundle from `@jexs/client/dist/browser/` and auto-inject the `<script>` tag into `<head>`.

## Key Patterns

- `{ "var": "SomeString" }` resolves a variable from context, not a literal.
- `peerDependencies` with `optional: true` for cross-package deps (physics, gl).
- `registerLazy()` for browser code-splitting — chunks loaded on first use.
- Server uses consumer-composed node arrays (e.g. physics nodes not included by default).
- `Server.ts` lives at `server/src/` root (not in `nodes/`) — it's not a Node.

## Conventions

- No emojis in code or docs
- Prefer runtime guards over type assertions (`as`)
- Keep barrel index.ts concise — only public API
