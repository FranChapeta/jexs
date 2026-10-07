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

`sw-*` (`ServiceWorkerNode`) is not in this set: it runs in the service worker, which has its own resolver (see below).

## Service worker

A service worker is a config: what to precache, how to answer requests, and the steps to resolve when an event fires.

```json
{
  "$listen": 3000,
  "client": true,
  "sw": {
    "precache": ["/"],
    "routes": [
      { "path": "/jexs/chunks/**", "strategy": "cache-first" },
      { "path": ["/", "/**"], "strategy": "network-first", "fallback": "/offline.html" }
    ],
    "skipWaiting": true,
    "claim": true,
    "events": {
      "push": { "$sw-notify": { "$var": "data.title" }, "body": { "$var": "data.body" }, "data": { "url": { "$var": "data.url" } } },
      "notificationclick": { "$sw-open": { "$var": "notification.data.url" } }
    }
  }
}
```

| Key | Does |
|---|---|
| `precache` | URLs cached on install, for pages to open offline without a route pointing at them. Every route's `fallback` is precached on its own. One failure fails the install, so a new version never activates with a partial cache. |
| `routes` | How GET requests are answered, tried in order, first match wins: `cache-first`, `network-first` or `stale-while-revalidate`, for a `path` in the router's segment syntax (`*` one segment, `**` the rest, so `/**` leaves `/` out; an absolute URL for another origin; or a list), with an optional cached `fallback`. Unmatched and non-GET requests go to the browser untouched; without routes the worker handles no requests at all. |
| `skipWaiting` | Activate a new version at once instead of when every tab of the old one has closed. Those tabs move over mid-session, so they may ask for files the new version no longer has. |
| `claim` | On activate, take control of pages no worker controls yet, so the first visit is served without a reload. |
| `events` | Steps per event: `install`, `activate`, `push`, `notificationclick`, `notificationclose`, `message`, `sync`, ... |

Use `cache-first` only for URLs whose content never changes under the same name, such as the bundle's hashed `/jexs/chunks/`; unhashed files belong under `network-first` or `stale-while-revalidate`.

With `@jexs/server`, `sw` on a `client` listener serves `/jexs/sw.js` and the client script registers it at scope `/`. Its settings are expressions like anything else, resolved once when the listener starts (`"precache": { "$var": "offlinePages" }`). A literal `events` map is left for the worker to resolve; `events` can also be a step that produces the map, as long as it hands the map over by reference (`$file` with `data: true`, or `$setVars` with `data: true`), so the server does not run the handlers' steps. The generated script embeds the config and a version hashed from it and the bundle, so changing either installs a new worker into a fresh cache and deletes the old one.

On a static host, write `sw.js` beside the bundle yourself and bump `version` to ship a change:

```js
import { startServiceWorker } from "./sw-runtime.js";
startServiceWorker({ /* config */ }, { version: 2 });
```

Register it from the page with `navigator.serviceWorker.register("/jexs/sw.js", { scope: "/", type: "module" })`; serving it with `Service-Worker-Allowed: /` lets it control the whole origin.

**Context per event**

Every handler sees `version`, the worker's version (the hash the server generates, or the one passed to `startServiceWorker`).

| Event | Context |
|---|---|
| `push` | `data`: the payload as JSON, or text, or `null` |
| `notificationclick`, `notificationclose` | `notification`: `{ title, body, tag, icon, badge, image, actions, timestamp, requireInteraction, silent, data }`, and `action` (the button clicked) |
| `message` | `data`: the message a page sent; `source`: that page as `{ id, url, type }`, or `null` |
| `sync` | `tag`, and `lastChance`: true on the browser's final retry |
| `periodicsync` | `tag` |
| `pushsubscriptionchange` | `oldSubscription`, `newSubscription`: each `{ endpoint, keys }` or `null` |

**Ops**

| Op | Does |
|---|---|
| `$sw-notify` | Show a notification (`body`, `icon`, `badge`, `image`, `tag`, `actions`, `requireInteraction`, `silent`, `data`). |
| `$sw-open` | Focus the window at a URL or open one; `navigate: true` reuses an open app window. |
| `$sw-post` | Message pages: the sender, in a `message` handler, otherwise every window. Pages handle it with an `sw-message` event, the message as `value`. |

## Usage from HTML

Drop the bundle in a page and Jexs auto-initializes on `DOMContentLoaded`:

```html
<script type="module" src="/jexs/client.js"></script>

<button data-jexs-events='[{
  "type": "click",
  "do": [
    { "$fetch": "/api/like", "method": "POST", "$as": "result" },
    { "$toggleClass": [{ "$var": "target" }, "liked"] }
  ]
}]'>Like</button>
```

Importing `@jexs/client` in the browser builds the resolver and auto-hydrates the page. It also exposes `window.jexs = { context, hydrate }` — `context` for inspecting/seeding shared state, `hydrate` for (re)binding events after you inject content.

On a page served by a Jexs server with sessions, a POST, PUT, PATCH or DELETE to the page's own origin, by `$fetch` like the one above or by a form, carries the session's CSRF token on its own, read from the `csrf` cookie. Nothing in the template needs to send it.

## Usage from JS

```ts
import { hydrate } from "@jexs/client";

hydrate();              // scan the whole document
hydrate(myElement);     // or just a subtree
```

The client shares its event context across handlers (so `value`, `target`, `event` from the previous click are still available in the next), which lets you compose chains of handlers naturally.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
