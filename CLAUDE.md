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

## Conventions

- No emojis in code or docs
- Prefer runtime guards over typecasting
- Keep barrel index.ts concise — only public API
