# @jexs/electron

Desktop runtime for Jexs. Runs a JSON app as an Electron main process, renders JSON page templates into renderer windows over a custom `app://` protocol, and bridges the two so node calls cross the process boundary without any IPC code in your templates.

See [ROADMAP.md](ROADMAP.md) for planned work.

## Install

```bash
npm create jexs@latest my-app -- --env electron
```

Or add it to an existing project:

```bash
npm i @jexs/electron electron
```

`package.json` needs `"main": "node_modules/@jexs/electron/dist/runner.js"`, and the renderer bundle must be built before launch:

```json
{
  "scripts": {
    "dev": "jexs bundle && jexs-electron --dev",
    "start": "jexs bundle && jexs-electron",
    "build": "jexs bundle && electron-builder"
  }
}
```

## How it works

There is no HTML file. `jexs-electron` registers `app://` as a privileged scheme and serves two things from it:

- **Pages.** A window loads `app://local/<page.json>?wrap=<token>`. The runner resolves a generated shell — an Element tree, not a file — with your template mounted in its `<body>`, and injects the client bundle into `<head>`. Your JSON is never sent to the renderer: FileNode reads it in the main process and the window receives HTML.
- **Assets.** Anything else resolves against `dist/browser/`, where `jexs bundle` writes `client.js` and the `chunks/` it code-splits into. Those are fetched lazily at runtime, not only at startup.

Templates live in `src/`. An optional `app/main.json` runs in the main process at startup; without one, the runner opens `src/index.json` in a default window.

## The IPC bridge

Node calls cross processes automatically. The preload exposes the main process's handler keys to the renderer, and `@jexs/client` registers a `ProxyNode` for the keys it does not have locally. Because resolver registration is first-wins, only the missing keys are forwarded:

- DOM ops (`setText`, `getValue`, `click`, …), `var`, `storage`, `tree-*` stay in the renderer
- `file`, `query`, `dialog-*`, `window-*`, `app-*` forward to main

So a page template can call `{ "query": "select", "table": "saves" }` directly. There is no `ipc` node and nothing to wire up.

## Security model

Windows are created with `contextIsolation: true` and `sandbox: true`, and the preload exposes only an allow-listed bridge — never `ipcRenderer` itself. On top of that, each window denies any navigation away from `app://` and refuses to open in-app windows, routing external links to the system browser instead. This matters because the bridge grants the renderer full main-process privileges, so foreign content must never be able to load.

### Restricting what a window may ask for

The renderer reaches main through a single IPC channel, and by default it may ask for anything main can do. That is usually fine, because a window can never navigate away from `app://` — so there is no ordinary way for foreign content to run in the first place.

Where a window shows content you do not fully control, constrain that window when you open it:

```json
{ "window-open": "preview.json", "name": "preview", "allow": ["query"] }
```

Any other op that window's page asks for is refused by name. It is per window on purpose: an editor needs `file` writes, a preview needs almost nothing, and the two should not share a limit.

List ops, not siblings. `table` in `{ "query": "select", "table": "saves" }` is data belonging to `query`, so `allow: ["query"]` is the whole list — siblings are declared by whichever package owns the op, and expecting an author to enumerate them would be both tedious and wrong. The check walks nested values as well, because a sibling's value is itself resolved: `{ "query": "x", "table": { "file": "/etc/passwd" } }` would otherwise reach `file` with only `query` and `table` at the top level.

Your own menu, tray and shortcut handlers are unaffected, because they run in main and never cross this channel — which is precisely what makes the list worth having rather than something that must permit everything.

The list governs the IPC channel, so `app://` gets its own controls rather than relying on it. A page shares the `app://local` origin and the scheme is fetchable, but `protocol.handle` receives only a `Request` — there is no window to attribute it to, so the list cannot be consulted there. Asset requests are confined to `dist/browser`, which holds nothing the renderer was not already given. Page requests carry a per-window token that `window-open` mints and binds to one template, so a window can re-request its own document and nothing else — without it, any page could make main resolve any template under `src/` with full privileges.

## Nodes

| Key | Purpose |
|---|---|
| `window-open` | Open a BrowserWindow on a page template; resolves to its registered name |
| `window-close` `window-focus` `window-min` `window-max` `window-restore` `window-reload` `window-devtools` | Act on a window; the value names it, `true` means the implicit target |
| `window-title` `window-bounds` | Set a title or geometry; target with the `window` sibling |
| `window-list` | Every open window with its name, id, title, state and bounds |
| `window-run` | Run steps inside a specific window's page |
| `menu` | Native application or per-window menu from a JSON item tree |
| `tray` `tray-destroy` | System tray icon, tooltip and right-click menu |
| `shortcut` `shortcut-remove` | System-wide keyboard shortcuts |
| `dialog-open` `dialog-save` | Native file dialogs; resolve to the chosen path(s) |
| `dialog-message` | Native message box; resolves to the pressed button index |
| `shell-open` `shell-open-path` `shell-show` `shell-trash` `shell-beep` | Hand a URL or file to the desktop environment |
| `notify` | Native OS notification |
| `app-quit` `app-relaunch` | End or restart the app |
| `app-path` `app-version` `app-locale` | Well-known paths and app info |
| `app-on` | Run steps on an application lifecycle event |

### Addressing windows

Every window is registered under a name — the `name` sibling if given, otherwise the template's basename (`settings.json` becomes `settings`, deduped `settings-2`). `window-open` resolves to that name, so `as` can capture it.

Opening is `window-open` rather than `window` so that `window` is free to be the target sibling. If the open op owned the bare key, `{ "window": "main", "window-title": "Saved" }` would dispatch on whichever key came first in the object and spawn a window instead of retitling one.

The **first window opened becomes the default target**, and ops resolve in the order: explicit name, then the calling renderer's own window, then the default. So a page can say `{ "window-close": true }` and mean itself, while `app/main.json` can say `{ "window-title": "Saved", "window": "editor" }` and mean a specific one.

Note what is deliberately absent: focus. `getFocusedWindow()` returns null whenever the app is in the background, so a tray or global-shortcut handler firing while another app has focus would resolve to nothing. An insertion-ordered default is deterministic. When the default window closes, the next remaining window is promoted rather than the default being left empty.

## Where steps run

A main-process handler — a menu item, a tray click, a shortcut, an `app-on` event — resolves in **main**. DOM ops inside it are forwarded to a window automatically, so this works with no wrapper:

```json
{ "label": "Save", "do": [
    { "getValue": "#editor", "as": "text" },
    { "file": { "var": "$path" }, "write": { "var": "$text" } } ] }
```

`getValue` crosses to the window, `file` stays in main, and `as` binds in main because the resolver applies global step keys in the calling thread.

`window-run` is the exception, and the difference matters: its steps are sent **unresolved** and run against the page's context, not main's. So a `{ "var": "$x" }` inside `window-run` looks up `x` in the page, not in the handler. Pass main-side values through `params`:

```json
{ "window-run": [{ "setText": ["#status", { "var": "$msg" }] }],
  "window": "editor",
  "params": { "msg": { "var": "$status" } } }
```

Each window is a separate JavaScript realm, so nothing is shared between them — separate page context, separate everything. State that must be global belongs in main.

## Dev mode

```bash
npm run dev          # jexs bundle && jexs-electron --dev
```

`--dev` opens devtools on every window and reloads them when a `.json` template under `src/` changes. Recursive watching is unavailable on some Linux setups; devtools still work there.

`npm start` is the same run without the flag, which is what a user sees.

## Packaging

`electron-builder` must unpack native modules from the asar archive, or `better-sqlite3` and `bcrypt` fail at runtime. The scaffolder writes this for you:

```yaml
asarUnpack: "**/*.node"
```

## Gotchas

- **Rebuild the bundle after upgrading `@jexs/client`.** `dist/browser/client.js` is a build artifact; an upgraded dependency with a stale bundle still ships the old bridge. Re-run `jexs bundle`.
- **There is nowhere to put static assets yet.** The asset branch resolves only against `dist/browser`, which is build output, and `jexs bundle` copies nothing into it. So `{ "tag": "img", "src": "/logo.png" }` in a template 404s. Inline it as a data URI or read it with `{ "file": ... }` until there is a `public/` equivalent.
- **Never import `electron` at the top level of a node file.** Schema generation imports `dist/nodes/*.js` under plain Node, where the electron runtime does not exist. Use `await import("electron")` inside the handler, as every node here does.
