import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { mergeTls, parseDbUrl, parseTls, redactUrl } from "../src/connection.js";
import { DatabaseNode } from "../src/nodes/Database.js";
import { CacheNode } from "../src/nodes/Cache.js";
import { Cache } from "../src/cache/Cache.js";
// Redis is the only cache driver with a url; its dialect lives with its adapter.
import { parseRedisUrl } from "../src/cache/RedisCache.js";

// Certificate material is read off disk relative to the cwd, so the PEM tests
// run from a temp dir holding a stand-in file.
let root = "";
let cwd = "";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-conn-"));
  await fs.writeFile(path.join(root, "ca.pem"), CA_PEM);
  cwd = process.cwd();
  process.chdir(root);
});

after(async () => {
  process.chdir(cwd);
  await fs.rm(root, { recursive: true, force: true });
});

// ── Database urls ──────────────────────────────────────────────────────────────

test("postgres url decomposes into discrete connection settings", () => {
  assert.deepEqual(parseDbUrl("postgres://alice:s3cret@db.example.com:6432/app"), {
    type: "pg",
    host: "db.example.com",
    port: 6432,
    user: "alice",
    password: "s3cret",
    database: "app",
  });
});

test("url scheme selects the driver", () => {
  assert.equal(parseDbUrl("postgresql://h/d").type, "pg");
  assert.equal(parseDbUrl("pg://h/d").type, "pg");
  assert.equal(parseDbUrl("mysql://h/d").type, "mysql");
  assert.equal(parseDbUrl("mariadb://h/d").type, "mysql");
  assert.equal(parseDbUrl("sqlite:x.db").type, "sqlite");
  assert.throws(() => parseDbUrl("mongodb://h/d"), /Unsupported database url scheme/);
  assert.throws(() => parseDbUrl("db.example.com/app"), /no scheme/);
});

// Credentials routinely carry url-significant characters; a driver that gets the
// still-encoded form authenticates with the wrong password.
test("percent-encoded credentials and database names are decoded", () => {
  const parts = parseDbUrl("mysql://us%40er:p%40ss%2Fword@h:3306/my%20db");
  assert.equal(parts.user, "us@er");
  assert.equal(parts.password, "p@ss/word");
  assert.equal(parts.database, "my db");
});

test("IPv6 hosts lose the url brackets the drivers do not want", () => {
  assert.equal(parseDbUrl("postgres://[2001:db8::1]:5432/app").host, "2001:db8::1");
});

// sqlite paths are not urls — a `//` prefix is authority syntax, not part of the
// filename, and `:memory:` has to survive verbatim.
test("sqlite urls keep the path verbatim in every spelling", () => {
  assert.equal(parseDbUrl("sqlite:./data.db").filename, "./data.db");
  assert.equal(parseDbUrl("sqlite://./data.db").filename, "./data.db");
  assert.equal(parseDbUrl("sqlite:///var/lib/app.db").filename, "/var/lib/app.db");
  assert.equal(parseDbUrl("file:data.db").filename, "data.db");
  assert.equal(parseDbUrl("sqlite::memory:").filename, ":memory:");
});

// node-postgres semantics, not libpq's: everything but `disable` verifies, and
// `no-verify` is the explicit opt-out. libpq's `require` (encrypt, don't verify)
// would silently downgrade a pasted psql url, so it fails loudly instead.
test("every sslmode but disable and no-verify verifies the certificate", () => {
  for (const mode of ["allow", "prefer", "require", "verify-ca", "verify-full"]) {
    assert.deepEqual(
      parseDbUrl(`postgres://h/d?sslmode=${mode}`).ssl,
      { rejectUnauthorized: true },
      mode,
    );
  }
  assert.deepEqual(parseDbUrl("postgres://h/d?sslmode=no-verify").ssl, { rejectUnauthorized: false });
  assert.equal(parseDbUrl("postgres://h/d?sslmode=disable").ssl, false);
  assert.equal(parseDbUrl("postgres://h/d").ssl, undefined);
  assert.throws(() => parseDbUrl("postgres://h/d?sslmode=verify-al"), /Unknown sslmode/);
});

// knex copies query params verbatim on the mysql path, so `sslmode` there lands
// as an unknown key mysql2 ignores — a plaintext connection that looks encrypted.
test("sslmode applies to mysql urls too", () => {
  assert.deepEqual(parseDbUrl("mysql://h/d?sslmode=require").ssl, { rejectUnauthorized: true });
  assert.equal(parseDbUrl("mysql://h/d?sslmode=disable").ssl, false);
});

// MySQL's own URI syntax hyphenates and upper-cases what libpq runs together
// and lower-cases. Both spellings work, on either driver.
test("MySQL's ssl-mode spelling and values are accepted", () => {
  assert.deepEqual(parseDbUrl("mysql://h/d?ssl-mode=REQUIRED").ssl, { rejectUnauthorized: true });
  assert.deepEqual(parseDbUrl("mysql://h/d?ssl-mode=VERIFY_IDENTITY").ssl, { rejectUnauthorized: true });
  assert.deepEqual(parseDbUrl("mysql://h/d?ssl-mode=PREFERRED").ssl, { rejectUnauthorized: true });
  assert.equal(parseDbUrl("mysql://h/d?ssl-mode=DISABLED").ssl, false);
  assert.deepEqual(parseDbUrl("postgres://h/d?ssl-mode=VERIFY_CA").ssl, { rejectUnauthorized: true });
});

test("MySQL's hyphenated certificate parameters are read like libpq's", () => {
  assert.deepEqual(parseDbUrl("mysql://h/d?ssl-ca=ca.pem&ssl-mode=VERIFY_CA").ssl, {
    ca: CA_PEM,
    rejectUnauthorized: true,
  });
  assert.deepEqual(parseDbUrl("mysql://h/d?ssl-cipher=ECDHE-RSA-AES128-GCM-SHA256").ssl, {
    ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
  });
});

// A url is a foreign standard: libpq defines `sslrootcert` as a file path and
// reads it off disk, so it stays a path here even though the `ssl` field cannot.
test("sslrootcert in a url stays a path and is read off disk", () => {
  assert.deepEqual(parseDbUrl("postgres://h/d?sslrootcert=ca.pem&sslmode=verify-full").ssl, {
    ca: CA_PEM,
    rejectUnauthorized: true,
  });
  // Material without a mode is still enough to turn TLS on.
  assert.deepEqual(parseDbUrl("postgres://h/d?sslca=ca.pem").ssl, { ca: CA_PEM });
  assert.throws(() => parseDbUrl("postgres://h/d?sslrootcert=missing.pem"), /Cannot read TLS ca/);
});

// The JSON-in-a-string form is mysql2's URL idiom, so it lives on the url path
// only — the `ssl` field takes a real object and rejects a string holding one.
test("mysql2 ssl=true and inline-JSON ssl query forms both work", () => {
  assert.equal(parseDbUrl("mysql://h/d?ssl=true").ssl, true);
  assert.equal(parseDbUrl("mysql://h/d?ssl=false").ssl, false);
  assert.deepEqual(parseDbUrl("mysql://h/d?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D").ssl, {
    rejectUnauthorized: false,
  });
  assert.throws(() => parseDbUrl("mysql://h/d?ssl=%7Bnope%7D"), /not valid JSON/);
  assert.throws(() => parseTls("{\"rejectUnauthorized\":false}"), /is not a TLS setting/);
});

// ── TLS values ─────────────────────────────────────────────────────────────────

test("parseTls distinguishes unset from off", () => {
  assert.equal(parseTls(undefined), undefined);
  assert.equal(parseTls(null), undefined);
  assert.equal(parseTls(""), undefined);
  assert.equal(parseTls(false), false);
  assert.equal(parseTls("disable"), false);
  assert.equal(parseTls(true), true);
  assert.equal(parseTls("require"), true);
});

// Certificate material only ever goes under a named key. A bare PEM string
// would make `{"ssl": {"var": "$x"}}` mean options or a CA depending on the
// runtime type of `$x` — one template, two meanings.
test("the ssl field refuses a bare string that is not a boolean spelling", () => {
  assert.throws(() => parseTls(CA_PEM), /is not a TLS setting/);
  assert.throws(() => parseTls(CA_PEM), /material goes under a key/);
  assert.throws(() => parseTls("ca.pem"), /is not a TLS setting/);
  // A path gets pointed at the load-it-first fix instead.
  assert.throws(() => parseTls("ca.pem"), /"raw": true/);
});

// Reading a file inside the field would resolve against the cwd while `{ file }`
// resolves against the resolver root, so the same string would name two files.
test("certificate keys take PEM content, never a path", () => {
  // Trimmed at the ends (env vars pick up stray whitespace); the newlines that
  // separate a concatenated chain are interior, so they stay.
  assert.deepEqual(parseTls({ ca: CA_PEM }), { ca: CA_PEM.trim() });
  assert.throws(() => parseTls({ ca: "certs/ca.pem" }), /"raw": true/);
  assert.throws(() => parseTls({ cert: "x.crt" }), /TLS cert must be PEM content/);
  assert.throws(() => parseTls({ key: "x.key" }), /TLS key must be PEM content/);
});

// `true` and `false` are not interchangeable with the object form: `true` is
// exactly `{}`, but NO object can mean plaintext, so `false` is the only way to
// override a mode the url already set.
test("true is the strictest setting and false is the only plaintext", () => {
  assert.equal(parseTls(true), true);
  assert.equal(parseTls(false), false);
  // Text from $env reaches the same two answers. The runtime folds case; the
  // schema's enum lists the lowercase spellings.
  for (const on of ["true", "1", "require", "REQUIRE"]) {
    assert.equal(parseTls(on), true, on);
  }
  for (const off of ["false", "0", "disable", "Disable"]) {
    assert.equal(parseTls(off), false, off);
  }
  // Anything else is refused rather than guessed at, and the error lists the set.
  assert.throws(() => parseTls("banana"), /one of true, false, 1, 0, require, disable/);
  // false beats a url that asked for TLS; nothing else can express that.
  assert.equal(mergeTls({ rejectUnauthorized: true }, parseTls(false)), false);
});

test("object options take a PEM chain and normalize the rest", () => {
  assert.deepEqual(
    parseTls({ ca: [CA_PEM], rejectUnauthorized: "false", minVersion: "1.2", servername: "db.internal" }),
    { ca: [CA_PEM.trim()], rejectUnauthorized: false, minVersion: "TLSv1.2", servername: "db.internal" },
  );
  assert.deepEqual(parseTls({ minVersion: "TLSv1.3" }), { minVersion: "TLSv1.3" });
  assert.throws(() => parseTls({ minVersion: "1.4" }), /Unknown TLS version/);
});

// An empty object is still "use TLS", so it must not collapse to undefined.
test("an empty options object means TLS with defaults", () => {
  assert.deepEqual(parseTls({}), {});
});

test("explicit options layer over what the url implied", () => {
  assert.deepEqual(
    mergeTls({ rejectUnauthorized: false }, { ca: CA_PEM }),
    { rejectUnauthorized: false, ca: CA_PEM },
  );
  assert.equal(mergeTls({ ca: CA_PEM }, false), false);
  assert.deepEqual(mergeTls(undefined, { ca: CA_PEM }), { ca: CA_PEM });
  assert.equal(mergeTls(true, undefined), true);
});

// ── Cache urls ─────────────────────────────────────────────────────────────────

// The url is passed to ioredis untouched, so this only guards the scheme —
// ioredis reads `http://h:6379` as the hostname `http` instead of failing.
test("redis urls are guarded on their scheme and otherwise passed through", () => {
  assert.equal(parseRedisUrl("redis://h:6379/0"), "redis://h:6379/0");
  assert.equal(parseRedisUrl("rediss://u:p@h:6379"), "rediss://u:p@h:6379");
  assert.throws(() => parseRedisUrl("http://h:6379"), /must start with redis/);
  assert.throws(() => parseRedisUrl("h:6379"), /must start with redis/);
  assert.throws(() => parseRedisUrl("my-cache.internal"), /must start with redis/);
});


// ── DatabaseNode connect ───────────────────────────────────────────────────────

// knex never dials until a query runs, so these configure without connecting.
const resolve = createResolver([...coreNodes(), new DatabaseNode()]);
const connect = async (step: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await Promise.resolve(resolve(step, {})) as Record<string, unknown>;

after(async () => { await DatabaseNode.closeAll(); });

test("url and the discrete endpoint properties are alternatives, not layers", async () => {
  await assert.rejects(
    async () => connect({ database: "connect", name: "c1", url: "postgres://h/d", host: "elsewhere" }),
    /already carries the endpoint/,
  );
  await assert.rejects(
    async () => connect({ database: "connect", name: "c2", url: "sqlite:a.db", filename: "b.db" }),
    /already carries the endpoint/,
  );
});

// `ssl` says HOW to connect rather than WHERE, so it refines a url rather than
// contradicting it. This is the case that justifies allowing both: the url comes
// from the provider's $env (with its own sslmode) and the CA from the deploy, and
// since the field takes PEM content it is the ONLY channel for loaded material.
test("ssl layers over a url instead of colliding with it", async () => {
  const r = await connect({
    database: "connect", name: "c3",
    url: "postgres://h/d?sslmode=no-verify",
    ssl: { ca: CA_PEM },
  });
  const info = r.info as Record<string, unknown>;
  assert.equal(info.ssl, true);
  const settings = DatabaseNode.getKnex("c3").client.connectionSettings as Record<string, unknown>;
  // Merged key-wise. node-postgres would have the url REPLACE the ssl object.
  assert.deepEqual(settings.ssl, { rejectUnauthorized: false, ca: CA_PEM.trim() });
});

// Omitted `bindings` used to reach knex as `null`, which it reads as ONE
// binding — so a statement with no placeholders failed with "Expected 1
// bindings, saw 0". A real guard turns it back into the no-bindings call.
test("raw works with bindings omitted, present, or wrong", async () => {
  await connect({ database: "connect", name: "mem", url: "sqlite::memory:" });
  const run = (step: Record<string, unknown>) =>
    connect({ ...step, database: "raw", connection: "mem" });

  assert.deepEqual(await run({ sql: "select 1 as n" }), [{ n: 1 }]);
  assert.deepEqual(await run({ sql: "select ? as n", bindings: [7] }), [{ n: 7 }]);
  assert.deepEqual(await run({ sql: "select ? as n", bindings: [null] }), [{ n: null }]);

  // A non-array, and a bad element, are both named against the step.
  await assert.rejects(
    async () => run({ sql: "select ? as n", bindings: "7" }),
    /"bindings" must be an array/,
  );
  await assert.rejects(
    async () => run({ sql: "select ? as n", bindings: [{ a: 1 }] }),
    /"bindings" item 0 is object/,
  );
});

// "not connected" alone leaves out the half that is usually the real problem
// now that the drivers are optional peers.
test("using an unopened connection names it and lists the drivers", async () => {
  await assert.rejects(
    async () => connect({ database: "raw", connection: "typo", sql: "select 1" }),
    /Database "typo" is not connected\.[\s\S]*npm install pg\s+for \{ "type": "pg" \}/,
  );
});

test("a type contradicting the url scheme is refused", async () => {
  await assert.rejects(
    async () => connect({ database: "connect", name: "c4", type: "mysql", url: "postgres://h/d" }),
    /contradicts the url scheme/,
  );
});

// ── CacheNode connect ──────────────────────────────────────────────────────────

// Same rule as `database: "connect"`, so the two nodes do not disagree about
// what carrying both spellings means.
test("cache-connect refuses a url alongside the discrete endpoint", async () => {
  const cacheResolve = createResolver([...coreNodes(), new CacheNode()]);
  const run = async (step: Record<string, unknown>) =>
    await Promise.resolve(cacheResolve(step, {}));

  await assert.rejects(
    async () => run({ "cache-connect": "redis", url: "redis://h:6379", host: "elsewhere" }),
    /already carries the endpoint/,
  );
  await assert.rejects(
    async () => run({ "cache-connect": "redis", url: "redis://h:6379", password: "p" }),
    /already carries the endpoint/,
  );
  // `tls` is not part of the endpoint, so it still rides along with a url.
  assert.equal(await run({ "cache-connect": "redis", url: "rediss://h:6379", tls: true }), "redis");
  // memcached has no url at all, so its server list is the only spelling.
  assert.equal(
    await run({ "cache-connect": "memcached", servers: ["h:11211"], username: "u" }),
    "memcached",
  );
  await Cache.close();
});

// `createAdapter` falls through to memory on `default`, so an unrecognized
// driver used to connect in-process while the log and the return value both
// claimed the driver that was asked for.
test("cache-connect refuses an unknown driver instead of falling back to memory", async () => {
  const cacheResolve = createResolver([...coreNodes(), new CacheNode()]);
  const run = async (step: Record<string, unknown>) =>
    await Promise.resolve(cacheResolve(step, {}));

  await assert.rejects(
    async () => run({ "cache-connect": "redys" }),
    /Unknown cache driver "redys" \(expected memory, redis, memcached\)/,
  );
  assert.equal(await run({ "cache-connect": "memory" }), "memory");
  await Cache.close();
});

// Connection strings reach error messages and logs; the password must not.
test("redaction strips the password from a url", () => {
  assert.equal(redactUrl("postgres://alice:s3cret@h:5432/app"), "postgres://alice:***@h:5432/app");
  assert.equal(redactUrl("postgres://h:5432/app"), "postgres://h:5432/app");
});
