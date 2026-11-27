# @jexs/client

Browser runtime for **Jexs** — DOM rendering, audio, WebSocket, web-push, WebRTC, controllers, and a service-worker entrypoint.

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

The ops that write markup (`setProp` with `innerHTML` or `outerHTML`, and `insertHtml`) take a value as element content does: HTML from `$tag` or `$html` is markup and gets its `events` wired up, and a string is text, so a stored or fetched value cannot add elements or handlers to the page. A fragment fetched from your own server is a string too; trust it with `{ "$html": { "$fetch": "/fragment" } }`.

**Lazy-loaded nodes** (only fetched when first used):

| Node | Keys | Purpose |
|---|---|---|
| `WsNode` | `wsConnect`, `wsSend`, `wsClose`, `wsStatus` | WebSocket client, reconnecting on its own |
| `PushNode` | `pushSubscribe`, `pushUnsubscribe` | Web Push subscription |
| `WebRTCNode` | `rtc`, `rtcConnect`, `rtcSignal`, `rtcSend`, `rtcBroadcast`, `rtcClose`, `rtcStatus` | WebRTC peers, in named meshes |
| `GamepadNode` | `gamepad`, `gamepadRumble` | Controller state and vibration (see [Controllers](#controllers)) |
| `PermissionNode` | `permission` | Permission states, and their changes (see [Permissions](#permissions)) |
| `DevicesNode` | `devices` | Microphones, speakers and cameras, and their changes (see [Devices](#devices)) |
| from `@jexs/gl` | `glInit`, `glCamera`, `glTexture`, ... | WebGL rendering |
| from `@jexs/physics` | `entityAdd`, `physicsInit`, `collisionOn`, `jointAdd`, `parseGLB`, ... | Entities, physics and collision |

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
      "push": { "$swNotify": { "$var": "push.title" }, "body": { "$var": "push.body" }, "data": { "url": { "$var": "push.data.url" } } },
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
| `push` | `push`: the payload as JSON, or text, or `null` |
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

A handler for an event that fires often can run for only some of its events. `throttle: 100` runs the first event at once, then at most once every 100 ms, ending with the last event, so a drag still ends where the pointer let go. `throttle: "frame"` runs once per animation frame. `debounce: 300` runs once, 300 ms after the events stop, as a search box wants:

```json
{ "$tag": "input", "events": { "input": { "debounce": 300, "do": [{ "$fetch": { "$concat": ["/search?q=", { "$var": "value" }] }, "$as": "results" }] } } }
```

A held run happens after the event was dispatched, so `$preventDefault` in its steps is too late. The `preventDefault` and `stopPropagation` options act on every event, held or not.

Booting builds the app's resolver and context, hydrates the page, and registers the service worker the server named. The app is also `window.jexs = { resolver, context, hydrate }`: `context` for inspecting or seeding its state, `hydrate` for binding the handlers in content injected later.

On a page served by a Jexs server with sessions, a POST, PUT, PATCH or DELETE to the page's own origin, by `$fetch` like the one above or by a form, carries the session's CSRF token on its own, read from the `csrf` cookie. Nothing in the template needs to send it.

## Files

A file the user picks or drops is a `File`, read by path from the event: `target.files.0` on an `<input type="file">`, and `event.dataTransfer.files.0` on a `drop`, whose element also needs `preventDefault` on `dragover`. It stays on the user's machine; `$toBytes` reads its bytes, and `$fromBytes` its text.

```json
{ "$tag": "input", "type": "file", "accept": ".json", "events": { "change": { "do": [
  { "$parseJSON": { "$fromBytes": { "$var": "target.files.0" } }, "$as": "project", "$bubble": true }
] } } }
```

A file the page made goes back to the user through a link, with no server. `$setProp` makes a Blob (`$blob` makes one of text or bytes) into a URL naming it, for an `<a download>` to save:

```json
[{ "$tag": "a", "id": "export", "download": "project.json", "content": "Download the project" },
 { "$setProp": ["#export", "href", { "$blob": { "$stringify": { "$var": "project" } }, "type": "application/json" }] }]
```

Setting `href` again after each edit keeps the link current, and lets the old file go. The same goes for `src`, to play a recording in an `<audio controls>` or show a picked image before uploading it.

A link's click saves what its `href` names already, since its handlers run after the browser has acted on it. So a file made at the click is made by a button, which gives a hidden link its `href` and clicks it:

```json
{ "$tag": "button", "content": "Export", "events": { "click": { "do": [
  { "$setProp": ["#export", "href", { "$blob": { "$stringify": { "$var": "project" } }, "type": "application/json" }] },
  { "$click": "#export" }
] } } }
```

A Blob is your page's own, so one opened as a page would run as yours. A link saves an HTML, SVG, XML or untyped Blob rather than open it. An `<iframe>` or `<embed>` shows only a PDF, text, image or media Blob: show HTML through a sandboxed `srcdoc` instead. A `$tag` attribute takes no Blob, since markup has no element yet to hold its URL; set it with `$setProp` once the element is on the page.

## Controllers

A controller works like the keyboard. A press is an event on an element, as `keydown` is, and its `value` says which pad and which button:

| Event | `value` |
|---|---|
| `gamepadbuttondown`, `gamepadbuttonup` | `{ gamepad, button, value }`: the pad's index, the button's index, and how far it is pressed (0 to 1, for the triggers) |
| `gamepadconnected`, `gamepaddisconnected` | `{ gamepad, id, mapping }` |

```json
{ "$tag": "body", "events": { "gamepadbuttondown": { "do": [
  { "$if": { "$eq": [{ "$var": "value.button" }, 0] }, "then": { "$physicsApply": "player", "impulse": [0, -450] } }
] } } }
```

For movement and held buttons, read the pad every frame with `$gamepad`. It is the browser's own `Gamepad`: `buttons` by index, each `{ pressed, touched, value }`, and `axes` by index, each from -1 to 1 with down and right positive. A pad that isn't connected reads `undefined`.

```json
{ "$glInit": "#game", "onFrame": [
  { "$gamepad": 0, "$as": "pad" },
  { "$entityUpdate": "player", "moveX": { "$multiply": [{ "$coalesce": [{ "$var": "pad.axes.0" }, 0] }, 250] } }
] }
```

On a pad with the standard layout (`mapping` is `"standard"`), the indices are:

| Buttons | | Axes | |
|---|---|---|---|
| 0, 1, 2, 3 | Bottom, right, left, top face buttons | 0, 1 | Left stick X, Y |
| 4, 5 | Left, right bumper | 2, 3 | Right stick X, Y |
| 6, 7 | Left, right trigger (analog `value`) | | |
| 8, 9 | Select, start | | |
| 10, 11 | Left, right stick press | | |
| 12, 13, 14, 15 | D-pad up, down, left, right | | |
| 16 | Home | | |

The pad is read by path (`pad.buttons.0.pressed`). `$keys`, `$entries`, `$merge` and `$stringify` see none of its fields, since a browser keeps them on the object's prototype. To send input to a server, ask for `changes: true`: the buttons and axes that changed since that pad's last such read, as plain data, and `{}` (false to `$if`) when nothing did.

```json
[{ "$gamepad": 0, "changes": true, "throttle": 33, "$as": "changed" },
 { "$if": { "$var": "changed" }, "then": { "$wsSend": { "seq": { "$var": "seq" }, "input": { "$var": "changed" } } } }]
```

`throttle` reports at most once every that many milliseconds, whatever the frame rate, with everything that changed since the last report merged. A button pressed and released between two reports has not changed, so send presses that must arrive from `gamepadbuttondown`. Each pad's last report is kept in one place, so read a pad's changes from one step: two would each see part of them.

`{ "$gamepadRumble": 0, "duration": 300, "strong": 1, "weak": 0.5 }` vibrates a pad that can. Browsers show a page no controller until a button is pressed on it while the page is open.

## Permissions

The ops that need a permission ask for it the first time they run, as `$pushSubscribe` does. `$permission` never asks: it reads where a permission stands, for a notice when it is blocked or a page that reacts when it is revoked.

```json
[{ "$permission": "microphone", "$as": "mic", "$bubble": true },
 { "$if": { "$eq": [{ "$var": "mic.state" }, "denied"] }, "then": { "$setProp": ["#mic-blocked", "hidden", false] } }]
```

Its value is a name from the browser's Permissions API: `"microphone"`, `"camera"`, `"notifications"`, `"push"`, `"midi"`, `"geolocation"`, `"persistent-storage"`, or another the browser knows. A name it doesn't know throws. The result is the browser's `PermissionStatus`, the same one for a name every time, and its `state` (`"granted"`, `"denied"` or `"prompt"`) is live by path, so a stored status always reads the state as it is now.

Every name a step has read is reported when it changes, as a `permissionchange` event on the elements handling it:

| Event | `value` |
|---|---|
| `permissionchange` | `{ name, state }` |

```json
{ "$tag": "body", "events": { "permissionchange": { "do": [
  { "$if": { "$eq": [{ "$var": "value.state" }, "denied"] }, "then": { "$setProp": ["#mic-blocked", "hidden", false] } }
] } } }
```

Firefox and Safari may read `"prompt"` for a grant that lasts only the session, so `"denied"` is the one sure answer: to know whether something is allowed, use it.

## Devices

`$devices` lists the microphones (`"audioinput"`), speakers (`"audiooutput"`) or cameras (`"videoinput"`), each as `{ kind, deviceId, groupId, label }`, to build a device picker. `deviceId` stays the same for the site across visits, so a choice can be stored.

```json
{ "$tag": "button", "content": "Choose a microphone", "events": { "click": { "do": [
  { "$devices": "audioinput", "$as": "mics", "$bubble": true }
] } } }
```

Browsers name no device to a page that may not use one yet: they list a placeholder per kind instead, with an empty `deviceId` and `label`. So when the devices asked for are hidden, `$devices` asks for the microphone or the camera first, closes it at once, and lists them named. Once allowed, it lists without asking. Run it from a click, since it may prompt, and pass a kind: `true` asks for the camera too. A refusal throws, saying where to allow it.

Speakers are listed once the microphone is allowed, in Chromium. Firefox lists only the speakers the user has picked, and Safari lists none.

When a device is plugged in or out, the elements handling `devicechange` receive the list as the page sees it, read without asking:

| Event | `value` |
|---|---|
| `devicechange` | The devices, as `$devices` gives them, of every kind |

```json
{ "$tag": "body", "events": { "devicechange": { "do": [
  { "$setVars": { "mics": { "$filter": { "$var": "value" }, "item": "d", "do": { "$eq": [{ "$var": "d.kind" }, "audioinput"] } } }, "$bubble": true }
] } } }
```

The browser fires it only when the list it shows changes: rarely before a device is allowed, and while the page is hidden, only once it shows again.

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

A browser node package can give the page events of its own that happen off its elements, from a device, a sensor or a browser API, the way `sw-message` and the gamepad events arrive. `bridgeEvent(type, start)` makes `type` a bridged event: an element with a handler for it receives it, and its handlers read the event's detail as `value`. `start` runs with `send`, which dispatches the event to every such element on the page and gives how many it reached, so a source can tell when nothing handles it any more. It runs once the first element handles the type, and again once one does after every earlier one has left, so a source that stopped can start again; one that keeps running keeps track of whether it already is. It runs after the hydrate that bound that element is done, so an event it sends at once reaches every element that hydrate bound:

```ts
import { bridgeEvent } from "@jexs/client";

let listening = false;
bridgeEvent("screenorientation", (send) => {
  if (listening) return;
  listening = true;
  screen.orientation.addEventListener("change", () => send({ type: screen.orientation.type }));
});
```

A type can be bridged at any time, from a node loaded on first use too: the elements already bound to a handler for it receive it from then on. An element taken off the page stops receiving; put back from your own code, it receives again once `app.hydrate(el)` runs on it, as the client's own insertions do. To load a bridge's code only when it is needed, bridge the type early and import the code from `start`, as the client does for the gamepad events.

Each firing of a handler runs in a scope of its own on top of the page's context, holding `event`, `target` (the element the handler is on, or with a `target` selector the matching element the event happened in, plus its `index` and pointer `side`), `value`, and the `params` of the nearest element around it that has them. A value from an earlier event never lingers into the next, and two handlers awaiting at once each keep their own. A handler reads page state as it is at that moment, including what another handler changed while it was awaiting; a write meant as page state, for later handlers to read, takes `$bubble`, which writes it in the page's context (or in a scope between, if one has the variable as its own):

```json
{ "$setVars": { "count": { "$add": [{ "$var": "count" }, 1] } }, "$bubble": true }
```

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
