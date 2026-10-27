# @jexs/client

Browser runtime for **Jexs** — DOM rendering, audio, WebSocket, web-push, WebRTC, and a service-worker entrypoint.

The package is an ESM library. No prebuilt bundle ships: `jexs bundle`, from [@jexs/server](https://github.com/FranChapeta/jexs/tree/master/server), builds a project's bundle from it and the project's browser node packages, into `dist/browser`, which a `client` listener serves.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/client @jexs/core
```

`@jexs/physics` and `@jexs/gl` are optional peer dependencies, loaded only when a template first uses one of their ops.

## What's inside

**Always-loaded nodes** (`clientNodes`):

| Node | Keys | Purpose |
|---|---|---|
| `DomNode` | `getProp`, `setProp`, `addClass`, `toggleClass`, `setAttr`, `querySelector`, `insertHtml`, `moveElement`, `removeElement`, ... | Read and mutate the DOM |
| `AudioNode` | `audioLoad`, `audioPlay`, `audioStop`, `audioVolume`, `audioMaster`, ... | Web Audio playback |
| `StorageNode` | `storageGet`, `storageSet`, `storageDelete`, `storageHas`, `storage` | `localStorage` / `sessionStorage`, named as `cacheGet` and the rest name the server's cache |

**Lazy-loaded nodes** (only fetched when first used):

| Node | Keys | Purpose |
|---|---|---|
| `WsNode` | `wsConnect`, `wsSend`, `wsClose`, `wsStatus` | WebSocket client, reconnecting on its own |
| `PushNode` | `pushSubscribe`, `pushUnsubscribe` | Web Push subscription |
| `WebRTCNode` | `rtc`, `rtcConnect`, `rtcSignal`, `rtcSend`, `rtcBroadcast`, `rtcClose`, `rtcStatus` | WebRTC peers, in named meshes |
| from `@jexs/gl` | `glInit`, `glCamera`, `glTexture`, ... | WebGL rendering |
| from `@jexs/physics` | `entityAdd`, `physicsInit`, `vectorAdd`, `collisionOn`, `jointAdd`, `parseGLB`, ... | Entities, physics, collision and vector math |

`ServiceWorkerNode` (`swNotify`, `swOpen`, `swPost`, ...) is not in this set: it runs in the service worker, which has its own resolver (see below).

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
      "push": { "$swNotify": { "$var": "data.title" }, "body": { "$var": "data.body" }, "data": { "url": { "$var": "data.url" } } },
      "notificationclick": { "$swOpen": { "$var": "notification.data.url" } }
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
| `message` | `message`: the message a page sent; `source`: that page as `{ id, url, type }`, or `null` |
| `sync` | `tag`, and `lastChance`: true on the browser's final retry |
| `periodicsync` | `tag` |
| `pushsubscriptionchange` | `oldSubscription`, `newSubscription`: each `{ endpoint, keys }` or `null` |

**Ops**

| Op | Does |
|---|---|
| `$swNotify` | Show a notification (`body`, `icon`, `badge`, `image`, `tag`, `actions`, `requireInteraction`, `silent`, `data`). |
| `$swOpen` | Focus the window at a URL or open one; `navigate: true` reuses an open app window. |
| `$swPost` | Message pages: the sender, in a `message` handler, otherwise every window. Pages handle it with an `sw-message` event, the message as `value`. |

## Usage from HTML

`jexs bundle` builds the page's bundle, which boots Jexs when it loads. A page Jexs renders gets the script tag on its own, and an element's `events` become handlers the client binds:

```json
{ "$tag": "button", "content": ["Like"], "events": { "click": { "do": [
  { "$fetch": "/api/like", "method": "POST", "$as": "result" },
  { "$toggleClass": [{ "$var": "target" }, "liked"] }
] } } }
```

An element's `params` are variables for its handlers and those of the elements inside it, which is how one row's handlers know which row they are on:

```json
{ "$tag": "li", "params": { "index": { "$var": "index" } }, "content": [
  { "$tag": "button", "content": ["x"], "events": { "click": { "do": [{ "$remove": [{ "$var": "items" }, { "$var": "index" }] }] } } }
] }
```

When the row moves, `{ "$setAttr": [row, "data-jexs-params", { "index": 2 }] }` gives its handlers the new value.

Booting builds the app's resolver and context, hydrates the page, and registers the service worker the server named. The app is also `window.jexs = { resolver, context, hydrate }`: `context` for inspecting or seeding its state, `hydrate` for binding the handlers in content injected later.

On a page served by a Jexs server with sessions, a POST, PUT, PATCH or DELETE to the page's own origin, by `$fetch` like the one above or by a form, carries the session's CSRF token on its own, read from the `csrf` cookie. Nothing in the template needs to send it.

## Usage from JS

Importing `@jexs/client` starts nothing on its own. Boot the app with any nodes of your own; they are registered before the page hydrates, so a `mount` handler can use them:

```ts
import { boot } from "@jexs/client";

const app = boot({ nodes: [new MyNode()] });  // { resolver, context, hydrate }

app.hydrate(myElement);  // bind the handlers in content you inject later
```

`jexs bundle` writes this entry for you, with the nodes of every browser node package the project has installed.

A page can hold two apps, each with its own resolver and state. The page's app is `window.jexs` and takes a native host bridge if there is one; another is booted with `global: false`, and `root` keeps each to its part of the page:

```ts
boot({ nodes: [new WidgetNode()], root: document.querySelector("#widget")!, global: false });
```

`serviceWorker: false` skips registering the service worker the server named.

Each firing of a handler runs in a scope of its own on top of the page's context, holding `event`, `target` (the element the handler is on, or with a `target` selector the matching element the event happened in, plus its `index` and pointer `side`), `value`, and the `params` of the nearest element around it that has them. A value from an earlier event never lingers into the next, and two handlers awaiting at once each keep their own. A handler reads page state as it is at that moment, including what another handler changed while it was awaiting; a write meant as page state, for later handlers to read, takes `$bubble`, which writes it in the page's context (or in a scope between, if one has the variable as its own):

```json
{ "$setVars": { "count": { "$add": [{ "$var": "count" }, 1] } }, "$bubble": true }
```

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
