# @jexs/client

Browser runtime for **Jexs** — DOM rendering, audio, WebSocket, web-push, WebRTC, and a service-worker entrypoint.

The package ships both an ESM library (for bundling) and a pre-built browser bundle that [@jexs/server](https://github.com/FranChapeta/jexs/tree/master/server) can serve automatically.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/client @jexs/core
```

`@jexs/physics` and `@jexs/gl` are optional peer dependencies — lazy-loaded only when an entity-, physics-, or gl-prefixed key appears in the JSON.

## What's inside

**Always-loaded nodes** (`clientNodes`):

| Node | Keys | Purpose |
|---|---|---|
| `DomNode` | `setText`, `setHtml`, `getValue`, `setValue`, `addClass`, `toggleClass`, `setAttr`, `querySelector`, `append`, `removeEl`, ... | Read and mutate the DOM |
| `AudioNode` | `audio-load`, `audio-play`, `audio-stop`, `audio-volume`, `audio-master`, ... | Web Audio playback |
| `StorageNode` | `storage-get`, `storage-set`, `storage-remove`, `storage` | `localStorage` / `sessionStorage` |

**Lazy-loaded nodes** (only fetched when first used):

- `tree-*` — incremental tree rendering
- `list-*` — sortable / serializable lists
- `ws-*` — WebSocket client
- `push-*` — web-push subscription
- `rtc-*` — WebRTC peer connection
- `gl-*` — pulls in `@jexs/gl`
- `entity-*`, `physics-*`, `v-*`, `collision-*`, `joint-*`, `parseGLB`, ... — pulls in `@jexs/physics`

`sw-*` (`ServiceWorkerNode`) is not in this set: it registers in the service-worker entry point (`sw.js`), which runs its own resolver.

## Usage from HTML

Drop the bundle in a page and Jexs auto-initializes on `DOMContentLoaded`:

```html
<script type="module" src="/jexs/client.js"></script>

<button data-jexs-events='[{
  "type": "click",
  "do": [
    { "fetch": "/api/like", "method": "POST", "as": "result" },
    { "toggleClass": [{ "var": "$target" }, "liked"] }
  ]
}]'>Like</button>
```

Importing `@jexs/client` in the browser builds the resolver and auto-hydrates the page. It also exposes `window.jexs = { context, hydrate }` — `context` for inspecting/seeding shared state, `hydrate` for (re)binding events after you inject content.

## Usage from JS

```ts
import { hydrate } from "@jexs/client";

hydrate();              // scan the whole document
hydrate(myElement);     // or just a subtree
```

The client shares its event context across handlers (so `$value`, `$target`, `$event` from the previous click are still available in the next), which lets you compose chains of handlers naturally.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
