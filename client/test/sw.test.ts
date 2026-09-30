import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServiceWorker } from "../src/sw.js";

// The runtime is written against the service worker globals, so the tests stand
// those up on globalThis: the event classes, `caches`, `clients`, `registration`
// and `fetch`. Events are dispatched by hand and their lifetimes awaited.

const ORIGIN = "https://app.test";
const abs = (url: string) => new URL(url, `${ORIGIN}/`).href;

class ExtendableEvent {
  lifetime: Promise<unknown>[] = [];
  constructor(readonly type: string) {}
  waitUntil(p: Promise<unknown>): void { this.lifetime.push(p); }
  /** Settle everything extended so far, including what that added in turn. */
  async done(): Promise<void> {
    for (let i = 0; i < this.lifetime.length; i++) await this.lifetime[i];
  }
}
class FetchEvent extends ExtendableEvent {
  response: Promise<Response> | null = null;
  constructor(readonly request: Request) { super("fetch"); }
  respondWith(r: Response | Promise<Response>): void {
    this.response = Promise.resolve(r);
    this.lifetime.push(this.response);
  }
}
class PushEvent extends ExtendableEvent {
  constructor(readonly data: { text(): string } | null) { super("push"); }
}
class NotificationEvent extends ExtendableEvent {
  closed = false;
  readonly notification: Record<string, unknown>;
  constructor(notification: Record<string, unknown>, readonly action = "") {
    super("notificationclick");
    this.notification = { ...notification, close: () => { this.closed = true; } };
  }
}
class ExtendableMessageEvent extends ExtendableEvent {
  constructor(readonly data: unknown, readonly source: { postMessage(m: unknown): void } | null) { super("message"); }
}

/** An in-memory Cache API, keyed by absolute URL. */
class FakeCache {
  entries = new Map<string, Response>();
  failOn: string | null = null;
  async match(req: Request | string): Promise<Response | undefined> {
    return this.entries.get(abs(typeof req === "string" ? req : req.url))?.clone();
  }
  async put(req: Request | string, res: Response): Promise<void> {
    this.entries.set(abs(typeof req === "string" ? req : req.url), res);
  }
  /** Atomic like the real one, and like it refuses a list naming one request twice. */
  async addAll(urls: string[]): Promise<void> {
    const got = new Map<string, Response>();
    for (const url of urls) {
      const key = abs(url);
      if (got.has(key)) throw new DOMException(`addAll: ${key} is listed twice`, "InvalidStateError");
      if (this.failOn !== null && key === abs(this.failOn)) throw new TypeError(`addAll: ${url} failed`);
      got.set(key, new Response(`cached ${new URL(key).pathname}`));
    }
    for (const [url, res] of got) this.entries.set(url, res);
  }
}
const stores = new Map<string, FakeCache>();

interface FakeClient {
  url: string;
  focused: boolean;
  navigatedTo: string | null;
  inbox: unknown[];
  controlled: boolean;
}
let windows: FakeClient[] = [];
let opened: string[] = [];
let notifications: { title: string; opts: Record<string, unknown> }[] = [];
let claimed = false;
let skipped = false;
let network: (req: Request) => Promise<Response>;
let listeners = new Map<string, (e: unknown) => void>();

function windowClient(c: FakeClient) {
  const client = {
    get url() { return c.url; },
    postMessage: (m: unknown) => { c.inbox.push(m); },
    focus: async () => { c.focused = true; return client; },
    navigate: async (url: string) => { c.navigatedTo = url; c.url = url; return client; },
  };
  return client;
}

const g = globalThis as unknown as Record<string, unknown>;
Object.assign(g, { ExtendableEvent, FetchEvent, PushEvent, NotificationEvent, ExtendableMessageEvent });
g.caches = {
  open: async (name: string) => {
    if (!stores.has(name)) stores.set(name, new FakeCache());
    return stores.get(name);
  },
  keys: async () => [...stores.keys()],
  delete: async (name: string) => stores.delete(name),
};
g.registration = {
  scope: `${ORIGIN}/`,
  showNotification: async (title: string, opts: Record<string, unknown>) => { notifications.push({ title, opts }); },
};
g.clients = {
  claim: async () => { claimed = true; },
  matchAll: async (o: { includeUncontrolled?: boolean }) =>
    windows.filter(c => o.includeUncontrolled || c.controlled).map(windowClient),
  openWindow: async (url: string) => { opened.push(url); return null; },
};
g.skipWaiting = async () => { skipped = true; };
g.location = { href: `${ORIGIN}/jexs/sw.js` };
g.addEventListener = (type: string, fn: (e: unknown) => void) => { listeners.set(type, fn); };
g.fetch = (req: Request) => network(req);

beforeEach(() => {
  stores.clear();
  windows = [];
  opened = [];
  notifications = [];
  claimed = false;
  skipped = false;
  listeners = new Map();
  network = async (req) => new Response(`network ${new URL(req.url).pathname}`);
  logged = [];
});

// The runtime logs a failed handler and lets the browser carry on, so a test
// that only checks for "no response" could pass on an error. Any log fails it.
let logged: unknown[][] = [];
console.error = (...args: unknown[]) => { logged.push(args); };
afterEach(() => {
  const seen = logged;
  logged = [];
  assert.deepEqual(seen, [], "unexpected console.error");
});

function dispatch<E extends ExtendableEvent>(event: E): E {
  const fn = listeners.get(event.type);
  assert.ok(fn, `no "${event.type}" listener`);
  fn(event);
  return event;
}

async function fetchVia(url: string, init?: RequestInit): Promise<FetchEvent> {
  const event = dispatch(new FetchEvent(new Request(abs(url), init)));
  await event.done();
  return event;
}

async function bodyOf(event: FetchEvent): Promise<string> {
  assert.ok(event.response, "expected respondWith");
  return (await event.response).text();
}

const cacheOf = (version = 1) => {
  const cache = stores.get(`jexs-${version}`);
  assert.ok(cache, `expected cache jexs-${version}`);
  return cache;
};

const OFFLINE = { path: "/**", strategy: "network-first", fallback: "/offline.html" } as const;

test("listeners are added synchronously; fetch only when there are routes", () => {
  startServiceWorker({ events: { push: { "$sw-post": 1 } } });
  assert.deepEqual([...listeners.keys()].sort(), ["activate", "install", "push"]);

  listeners = new Map();
  startServiceWorker({ routes: [{ path: "/**", strategy: "cache-first" }] });
  assert.deepEqual([...listeners.keys()].sort(), ["activate", "fetch", "install"]);
});

test("a config the runtime cannot honor is refused at startup", () => {
  assert.throws(() => startServiceWorker({ routes: [{ path: "/**", strategy: "fastest" }] }), /routes\[0\]/);
  assert.throws(() => startServiceWorker({ routes: [{ strategy: "cache-first" }] }), /routes\[0\].*path/);
  assert.throws(() => startServiceWorker({ routes: [{ path: [], strategy: "cache-first" }] }), /routes\[0\]/);
  assert.throws(() => startServiceWorker({ routes: [{ path: 3, strategy: "cache-first" }] }), /routes\[0\]/);
  assert.throws(() => startServiceWorker({ routes: [{ path: "assets/**", strategy: "cache-first" }] }), /must start with "\/"/);
  assert.throws(() => startServiceWorker({ routes: [{ path: "/**/x", strategy: "cache-first" }] }), /must come last/);
  assert.throws(() => startServiceWorker({ precache: ["/", 2] }), /precache/);
  assert.throws(() => startServiceWorker({ events: { fetch: {} } }), /routes/);
});

test("install precaches, skips waiting only when asked, then runs its steps", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({ precache: ["/", "/app.css"], events: { install: { "$sw-post": "installed" } } }, { version: "a" });
  await dispatch(new ExtendableEvent("install")).done();
  assert.equal(await (await cacheOf("a").match("/app.css"))?.text(), "cached /app.css");
  assert.equal(skipped, false);
  assert.deepEqual(windows[0].inbox, ["installed"]);

  startServiceWorker({ skipWaiting: true });
  await dispatch(new ExtendableEvent("install")).done();
  assert.equal(skipped, true);
});

test("a failed precache fails the install", async () => {
  startServiceWorker({ precache: ["/", "/missing"] });
  (await (g.caches as { open(n: string): Promise<FakeCache> }).open("jexs-1")).failOn = "/missing";
  await assert.rejects(dispatch(new ExtendableEvent("install")).done(), /missing/);
  assert.equal(logged.length, 1);
  logged = [];
});

test("activate drops older jexs caches, keeps others, claims when asked", async () => {
  stores.set("jexs-old", new FakeCache());
  stores.set("mine", new FakeCache());
  stores.set("jexs-new", new FakeCache());
  startServiceWorker({}, { version: "new" });
  await dispatch(new ExtendableEvent("activate")).done();
  assert.deepEqual([...stores.keys()].sort(), ["jexs-new", "mine"]);
  assert.equal(claimed, false);

  startServiceWorker({ claim: true });
  await dispatch(new ExtendableEvent("activate")).done();
  assert.equal(claimed, true);
});

test("fetch leaves non-GET, unmatched and cross-origin requests to the browser", async () => {
  startServiceWorker({ routes: [{ path: ["/assets/**", "/img/**"], strategy: "cache-first" }] });
  assert.equal((await fetchVia("/assets/a.js", { method: "POST", body: "x" })).response, null);
  assert.equal((await fetchVia("/api/data")).response, null);
  assert.equal((await fetchVia("https://cdn.test/assets/a.js")).response, null);
  assert.equal(await bodyOf(await fetchVia("/img/logo.png")), "network /img/logo.png");
});

test("paths match whole segments, in the router's syntax", async () => {
  startServiceWorker({
    routes: [
      { path: "/app", strategy: "network-first" },
      { path: "/img/*", strategy: "network-first" },
      { path: "/docs/**", strategy: "network-first" },
    ],
  });
  assert.equal(await bodyOf(await fetchVia("/app")), "network /app");
  assert.equal(await bodyOf(await fetchVia("/app/")), "network /app/");
  assert.equal((await fetchVia("/apple.css")).response, null);
  assert.equal((await fetchVia("/app/deeper")).response, null);
  assert.equal(await bodyOf(await fetchVia("/img/a.png")), "network /img/a.png");
  assert.equal((await fetchVia("/img/sub/a.png")).response, null);
  assert.equal(await bodyOf(await fetchVia("/docs/a/b")), "network /docs/a/b");
  assert.equal((await fetchVia("/docs")).response, null);
});

test("`/**` leaves the root to its own path, as the router's catch-all does", async () => {
  startServiceWorker({ routes: [{ path: "/**", strategy: "network-first" }] });
  assert.equal((await fetchVia("/")).response, null);
  startServiceWorker({ routes: [{ path: ["/", "/**"], strategy: "network-first" }] });
  assert.equal(await bodyOf(await fetchVia("/")), "network /");
});

test("routes are tried in order, and an absolute URL pins its origin", async () => {
  startServiceWorker({
    precache: ["/app.css"],
    routes: [
      { path: "https://cdn.test/fonts/**", strategy: "network-first" },
      { path: "/app.css", strategy: "cache-first" },
      { path: "/**", strategy: "network-first" },
    ],
  });
  await dispatch(new ExtendableEvent("install")).done();
  assert.equal(await bodyOf(await fetchVia("https://cdn.test/fonts/a.woff2")), "network /fonts/a.woff2");
  assert.equal(await bodyOf(await fetchVia("/app.css")), "cached /app.css");
  assert.equal(await bodyOf(await fetchVia("/page")), "network /page");
});

test("cache-first serves the cache, and caches what the network returns", async () => {
  startServiceWorker({ routes: [{ path: "/**", strategy: "cache-first" }] });
  assert.equal(await bodyOf(await fetchVia("/a.js")), "network /a.js");
  network = async () => { throw new TypeError("offline"); };
  assert.equal(await bodyOf(await fetchVia("/a.js")), "network /a.js");
});

test("a route's fallback is precached without being listed", async () => {
  startServiceWorker({ routes: [OFFLINE] });
  await dispatch(new ExtendableEvent("install")).done();
  assert.equal(await (await cacheOf().match("/offline.html"))?.text(), "cached /offline.html");
});

test("a URL named by precache and as a fallback, spelled differently, is cached once", async () => {
  startServiceWorker({ precache: [abs("/offline.html"), "/"], routes: [OFFLINE, { ...OFFLINE, path: "/docs/**" }] });
  await dispatch(new ExtendableEvent("install")).done();
  assert.equal(await (await cacheOf().match("/offline.html"))?.text(), "cached /offline.html");
});

test("network-first falls back to cache, then to `fallback`, then to 503", async () => {
  startServiceWorker({ routes: [OFFLINE] });
  await dispatch(new ExtendableEvent("install")).done();
  await fetchVia("/page");
  network = async () => { throw new TypeError("offline"); };
  assert.equal(await bodyOf(await fetchVia("/page")), "network /page");
  assert.equal(await bodyOf(await fetchVia("/other")), "cached /offline.html");

  startServiceWorker({ routes: [{ path: "/**", strategy: "network-first" }] });
  const res = await (await fetchVia("/nowhere")).response;
  assert.equal(res?.status, 503);
});

test("a failed response is passed through but not cached", async () => {
  startServiceWorker({ routes: [{ path: "/**", strategy: "network-first" }] });
  network = async () => new Response("nope", { status: 500 });
  assert.equal((await (await fetchVia("/x")).response)?.status, 500);
  assert.equal(await cacheOf().match("/x"), undefined);
});

test("stale-while-revalidate serves the cache and refreshes it", async () => {
  startServiceWorker({ routes: [{ path: "/**", strategy: "stale-while-revalidate" }] });
  await fetchVia("/data.json");
  network = async () => new Response("fresh");
  assert.equal(await bodyOf(await fetchVia("/data.json")), "network /data.json");
  assert.equal(await (await cacheOf().match("/data.json"))?.text(), "fresh");
});

test("push data is JSON when it parses, text otherwise, null when absent", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({ events: { push: { "$sw-post": { "$var": "data" } } } });
  await dispatch(new PushEvent({ text: () => '{"title":"Hi"}' })).done();
  await dispatch(new PushEvent({ text: () => "plain" })).done();
  await dispatch(new PushEvent(null)).done();
  assert.deepEqual(windows[0].inbox, [{ title: "Hi" }, "plain", null]);
});

test("every handler sees the worker's version", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({ events: { message: { "$sw-post": { "$var": "version" } } } }, { version: "3f9a" });
  await dispatch(new ExtendableMessageEvent("hi", null)).done();
  startServiceWorker({ events: { message: { "$sw-post": { "$var": "version" } } } });
  await dispatch(new ExtendableMessageEvent("hi", null)).done();
  assert.deepEqual(windows[0].inbox, ["3f9a", 1]);
});

test("a message names the page that sent it", async () => {
  const replies: unknown[] = [];
  const page = { id: "c1", url: abs("/inbox"), type: "window", postMessage: (m: unknown) => replies.push(m) };
  startServiceWorker({ events: { message: { "$sw-post": { "$var": "source" } } } });
  await dispatch(new ExtendableMessageEvent("hi", page)).done();
  assert.deepEqual(replies, [{ id: "c1", url: abs("/inbox"), type: "window" }]);
});

test("sync carries its tag and whether it is the last retry", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({ events: { sync: { "$sw-post": { "tag": { "$var": "tag" }, "last": { "$var": "lastChance" } } } } });
  await dispatch(Object.assign(new ExtendableEvent("sync"), { tag: "outbox", lastChance: true })).done();
  await dispatch(Object.assign(new ExtendableEvent("sync"), { tag: "outbox", lastChance: false })).done();
  assert.deepEqual(windows[0].inbox, [{ tag: "outbox", last: true }, { tag: "outbox", last: false }]);
});

test("pushsubscriptionchange carries both subscriptions as JSON", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({
    events: { pushsubscriptionchange: { "$sw-post": { "old": { "$var": "oldSubscription.endpoint" }, "new": { "$var": "newSubscription" } } } },
  });
  const oldSubscription = { toJSON: () => ({ endpoint: "https://push.test/old", keys: { p256dh: "k", auth: "a" } }) };
  await dispatch(Object.assign(new ExtendableEvent("pushsubscriptionchange"), { oldSubscription, newSubscription: null })).done();
  assert.deepEqual(windows[0].inbox, [{ old: "https://push.test/old", new: null }]);
});

test("a clicked notification is passed whole", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({ events: { notificationclick: { "$sw-post": { "$var": "notification" } } } });
  await dispatch(new NotificationEvent({
    title: "Hi", body: "b", tag: "t", icon: "/i.png", image: "/big.png",
    actions: [{ action: "open", title: "Open" }], timestamp: 5, requireInteraction: true, silent: false, data: { url: "/x" },
  })).done();
  assert.deepEqual(windows[0].inbox, [{
    title: "Hi", body: "b", tag: "t", icon: "/i.png", badge: "", image: "/big.png",
    actions: [{ action: "open", title: "Open" }], timestamp: 5, requireInteraction: true, silent: false, data: { url: "/x" },
  }]);
});

test("sw-notify passes its siblings as notification options", async () => {
  startServiceWorker({
    events: {
      push: {
        "$sw-notify": { "$var": "data.title" },
        "body": "b",
        "requireInteraction": true,
        "actions": [{ "action": "open", "title": "Open" }, { "title": "no id" }],
        "data": { "url": "/inbox" },
      },
    },
  });
  await dispatch(new PushEvent({ text: () => '{"title":"Hi"}' })).done();
  assert.deepEqual(notifications, [{
    title: "Hi",
    opts: { body: "b", requireInteraction: true, actions: [{ action: "open", title: "Open" }], data: { url: "/inbox" } },
  }]);
});

test("sw-open focuses a window at the URL, else opens one, and closes the notification", async () => {
  windows = [
    { url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true },
    { url: abs("/inbox"), focused: false, navigatedTo: null, inbox: [], controlled: true },
  ];
  startServiceWorker({ events: { notificationclick: { "$sw-open": { "$var": "notification.data.url" } } } });
  const click = await dispatch(new NotificationEvent({ data: { url: "/inbox" } }));
  await click.done();
  assert.equal(click.closed, true);
  assert.equal(windows[1].focused, true);
  assert.deepEqual(opened, []);

  await dispatch(new NotificationEvent({ data: { url: "/settings" } })).done();
  assert.deepEqual(opened, [abs("/settings")]);
  assert.equal(windows[0].navigatedTo, null);
});

test("sw-open with navigate reuses a controlled window", async () => {
  windows = [
    { url: abs("/a"), focused: false, navigatedTo: null, inbox: [], controlled: false },
    { url: abs("/b"), focused: false, navigatedTo: null, inbox: [], controlled: true },
  ];
  startServiceWorker({ events: { notificationclick: { "$sw-open": "/c", "navigate": true } } });
  await dispatch(new NotificationEvent({})).done();
  assert.equal(windows[0].navigatedTo, null);
  assert.equal(windows[1].navigatedTo, abs("/c"));
  assert.deepEqual(opened, []);
});

test("sw-post replies to the sender of a message, and broadcasts elsewhere", async () => {
  const replies: unknown[] = [];
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({
    events: {
      message: { "$sw-post": { "got": { "$var": "data" } } },
      activate: { "$sw-post": "updated" },
    },
  });
  await dispatch(new ExtendableMessageEvent("ping", { postMessage: (m) => replies.push(m) })).done();
  await dispatch(new ExtendableEvent("activate")).done();
  assert.deepEqual(replies, [{ got: "ping" }]);
  assert.deepEqual(windows[0].inbox, ["updated"]);
});

test("a step list runs in order", async () => {
  windows = [{ url: abs("/"), focused: false, navigatedTo: null, inbox: [], controlled: true }];
  startServiceWorker({
    events: {
      message: [
        { "$concat": [{ "$var": "data" }, "!"], "$as": "loud" },
        { "$sw-post": { "$var": "loud" } },
      ],
    },
  });
  await dispatch(new ExtendableMessageEvent("hi", null)).done();
  assert.deepEqual(windows[0].inbox, ["hi!"]);
});
