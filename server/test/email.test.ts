import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createResolver, coreNodes } from "@jexs/core";
import { EmailNode, addresses, attachments, icalEvent, parseSmtpUrl, smtpOptions } from "../src/nodes/Email.js";

const resolve = createResolver([...coreNodes, new EmailNode()]);

/**
 * Enough of an SMTP server to hold a real conversation, so the accepted/rejected
 * paths are exercised as nodemailer actually drives them. `rcpt` answers the nth
 * RCPT TO, which is the only place a server decides who it will take.
 */
function smtpServer(rcpt: (n: number) => string): Promise<{ port: number; sent: string[]; close: () => void }> {
  let seen = 0;
  const sent: string[] = [];
  const server = net.createServer(socket => {
    let body: string[] | null = null;
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", chunk => {
      for (const line of chunk.toString().split("\r\n")) {
        // Inside DATA every line is message content until a lone dot ends it.
        if (body && line !== ".") { body.push(line); continue; }
        if (!line) continue;
        const command = line.slice(0, 4).toUpperCase();
        if (command === "EHLO" || command === "HELO") socket.write("250-localhost\r\n250 OK\r\n");
        else if (command === "MAIL") socket.write("250 OK\r\n");
        else if (command === "RCPT") socket.write(rcpt(++seen));
        else if (command === "DATA") { body = []; socket.write("354 go ahead\r\n"); }
        else if (line === ".") { sent.push((body ?? []).join("\n")); body = null; socket.write("250 queued as ABC123\r\n"); }
        else if (command === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => { /* nodemailer hangs up its own way */ });
  });
  return new Promise(done => {
    server.listen(0, () => {
      const address = server.address();
      done({
        port: typeof address === "object" && address ? address.port : 0,
        sent,
        close: () => server.close(),
      });
    });
  });
}

// ── Address lists ─────────────────────────────────────────────────────────────

// The old node ran every recipient through `toString`, so a list of addresses
// went out as the literal string `["a@x.com","b@x.com"]`.
test("addresses: a list stays a list", () => {
  assert.deepEqual(addresses(["a@x.com", "b@x.com"]), ["a@x.com", "b@x.com"]);
  assert.equal(addresses("a@x.com"), "a@x.com");
});

test("addresses: an unresolved recipient is absent, not \"undefined\"", () => {
  assert.equal(addresses(undefined), undefined);
  assert.equal(addresses(null), undefined);
  assert.equal(addresses(""), undefined);
  assert.deepEqual(addresses(["a@x.com", null, "", "b@x.com"]), ["a@x.com", "b@x.com"]);
  assert.equal(addresses([null, ""]), undefined);
});

// ── Attachments ───────────────────────────────────────────────────────────────

test("attachments: text, Buffer and ArrayBuffer content all survive", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const list = attachments([
    { filename: "a.txt", content: "hello" },
    { filename: "b.bin", content: bytes },
    { filename: "c.bin", content: bytes.buffer },
    { filename: "d.pdf", content: Buffer.from("pdf"), contentType: "application/pdf", cid: "doc" },
  ]) as Record<string, unknown>[];
  assert.equal(list.length, 4);
  assert.equal(list[0].content, "hello");
  assert.deepEqual(list[1].content, Buffer.from([1, 2, 3]));
  assert.deepEqual(list[2].content, Buffer.from([1, 2, 3]));
  assert.equal(list[3].contentType, "application/pdf");
  assert.equal(list[3].cid, "doc");
});

test("attachments: a path where content belongs says what to do instead", () => {
  assert.throws(
    () => attachments([{ filename: "report.pdf", path: "/reports/summary.pdf" }]),
    /needs string or binary content.*"file".*"content"/s,
  );
  assert.throws(() => attachments(["/reports/summary.pdf"]), /must be an object/);
});

test("attachments: absent stays absent", () => {
  assert.equal(attachments(null), undefined);
  assert.equal(attachments(undefined), undefined);
  assert.equal(attachments([]), undefined);
});

// ── Connection strings ────────────────────────────────────────────────────────

test("parseSmtpUrl: smtps is implicit TLS on 465, smtp is 587", () => {
  assert.deepEqual(parseSmtpUrl("smtps://user:pass@mail.example.com"), {
    secure: true, port: 465, host: "mail.example.com", auth: { user: "user", pass: "pass" },
  });
  assert.deepEqual(parseSmtpUrl("smtp://mail.example.com"), {
    secure: false, port: 587, host: "mail.example.com",
  });
  assert.equal(parseSmtpUrl("smtp://mail.example.com:2525").port, 2525);
});

test("parseSmtpUrl: credentials are percent-decoded", () => {
  const auth = parseSmtpUrl("smtps://api%40key:p%40ss%2Fword@mail.example.com").auth as Record<string, string>;
  assert.equal(auth.user, "api@key");
  assert.equal(auth.pass, "p@ss/word");
});

test("parseSmtpUrl: a wrong scheme is refused with the password redacted", () => {
  assert.throws(
    () => parseSmtpUrl("https://user:hunter2@mail.example.com"),
    (err: Error) => {
      assert.match(err.message, /must start with smtp:\/\/ or smtps:\/\//);
      assert.doesNotMatch(err.message, /hunter2/);
      return true;
    },
  );
});

// ── The node ──────────────────────────────────────────────────────────────────

// Runs before any email-connect in this file: there is no implicit transport, so
// an unconfigured send has to say how to configure one rather than guess.
test("email: no transport is an error naming the way to open one, before resolving", async () => {
  await assert.rejects(
    // The body throws a 418 of its own if anything resolves it, so an attachment
    // is never read off disk for a send that had nowhere to go.
    async () => {
      await resolve(
        { email: "a@x.com", subject: "hi", from: "me@x.com", body: { error: 418, message: "body resolved" } },
        {},
      );
    },
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /email-connect/);
      return true;
    },
  );
});

test("email-connect: a url configures the transport and reports the host", async () => {
  assert.equal(
    await resolve({ "email-connect": "smtps://user:pass@mail.example.com" }, {}),
    "mail.example.com",
  );
  assert.equal(
    await resolve({ "email-connect": "mail.example.com", port: 2525, user: "u" }, {}),
    "mail.example.com",
  );
});

/** The options a connect would hand to nodemailer, for the given siblings. */
function optionsFor(target: string, siblings: Record<string, unknown> = {}): Record<string, unknown> {
  return smtpOptions(parseSmtpUrl(target), siblings) as Record<string, unknown>;
}

test("smtpOptions: asking for TLS requires it, rather than upgrading only if offered", () => {
  // A `ca` that applied just when the server felt like offering STARTTLS would be
  // a guarantee in name only, so material and `true` both set requireTLS.
  assert.equal(optionsFor("smtp://mail.example.com", { tls: true }).requireTLS, true);
  assert.equal(optionsFor("smtp://mail.example.com", { tls: true }).ignoreTLS, undefined);

  const withMaterial = optionsFor("smtp://mail.example.com", { tls: { servername: "mail.internal" } });
  assert.equal(withMaterial.requireTLS, true);
  assert.deepEqual(withMaterial.tls, { servername: "mail.internal" });
});

test("smtpOptions: TLS false is plaintext, and secure needs no requireTLS", () => {
  const plaintext = optionsFor("smtp://mail.example.com", { tls: false });
  assert.equal(plaintext.ignoreTLS, true);
  assert.equal(plaintext.secure, false);
  assert.equal(plaintext.requireTLS, undefined);

  // Already encrypted from the first byte: there is no upgrade to require.
  const implicit = optionsFor("smtps://mail.example.com", { tls: true });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, undefined);
});

test("smtpOptions: no tls leaves nodemailer's own default, for a relay without one", () => {
  const bare = optionsFor("smtp://127.0.0.1:1025");
  assert.equal(bare.requireTLS, undefined);
  assert.equal(bare.ignoreTLS, undefined);
  assert.equal(bare.secure, false);
});

test("smtpOptions: siblings layer over the url, either supplying either half", () => {
  const merged = optionsFor("smtp://fromurl@mail.example.com", { password: "sibling", port: 2525 });
  assert.deepEqual(merged.auth, { user: "fromurl", pass: "sibling" });
  assert.equal(merged.port, 2525);
});

test("email-connect: TLS material must be PEM content, not a path", async () => {
  await assert.rejects(
    async () => { await resolve({ "email-connect": "smtp://mail.example.com", tls: { ca: "/certs/ca.pem" } }, {}); },
    /must be PEM content, not a path/,
  );
});

test("email: a missing subject, recipient or sender is an error, not a silent no-op", async () => {
  await resolve({ "email-connect": "smtp://127.0.0.1:1" }, {});
  await assert.rejects(
    async () => { await resolve({ email: "a@x.com", body: "hi", from: "me@x.com" }, {}); },
    /needs a subject/,
  );
  await assert.rejects(
    async () => { await resolve({ email: { var: "$missing" }, subject: "hi", from: "me@x.com" }, {}); },
    /needs at least one recipient/,
  );
  // No `from` on the message and none on the transport: nothing to fall back to,
  // and inventing a noreply@ address would only fail SPF at the far end.
  await assert.rejects(
    async () => { await resolve({ email: "a@x.com", subject: "hi" }, {}); },
    /needs a from address/,
  );
});

test("email: a missing subject is caught before the body is resolved", async () => {
  await resolve({ "email-connect": "smtp://127.0.0.1:1" }, {});
  await assert.rejects(
    // The body throws a 418 of its own if anything resolves it, so the message
    // that comes back says which check ran first.
    async () => { await resolve({ email: "a@x.com", from: "me@x.com", body: { error: 418, message: "body resolved" } }, {}); },
    /needs a subject/,
  );
});

// Port 1 refuses immediately, so this exercises the real failure path without
// reaching the network.
test("email: a delivery failure throws a 502 catch can read", async () => {
  await resolve({ "email-connect": "smtp://127.0.0.1", port: 1, timeout: 2000, from: "me@x.com" }, {});
  const out = await resolve(
    {
      email: ["a@x.com", "b@x.com"],
      subject: "Report",
      body: "hi",
      catch: [{ concat: [{ var: "$error.status" }, " ", { var: "$smtp.code" }] }],
    },
    {},
  );
  // The code itself is nodemailer's to choose (ESOCKET, ECONNECTION, EAUTH); what
  // matters is that a catch can read one at all.
  assert.match(out as string, /^502 E[A-Z]+$/);
});

test("email: a send the server takes reports who it accepted", async () => {
  const server = await smtpServer(() => "250 OK\r\n");
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    const out = await resolve(
      { email: ["a@x.com", "b@x.com"], subject: "Report", body: "hi" },
      {},
    ) as Record<string, unknown>;
    assert.deepEqual(out.accepted, ["a@x.com", "b@x.com"]);
    assert.deepEqual(out.rejected, []);
    assert.match(String(out.messageId), /@/);
  } finally {
    server.close();
  }
});

// Read off the wire rather than off the options, since threading only works if
// the headers actually reach the message.
test("email: a reply threads with In-Reply-To and References", async () => {
  const server = await smtpServer(() => "250 OK\r\n");
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    await resolve(
      {
        email: "reporter@x.com",
        subject: "Re: Ticket 12",
        body: "on it",
        inReplyTo: "<first@x.com>",
        references: ["<first@x.com>", "<second@x.com>"],
      },
      {},
    );
    const message = server.sent[0];
    assert.match(message, /^In-Reply-To: <first@x\.com>$/m);
    assert.match(message, /^References: <first@x\.com> <second@x\.com>$/m);
    // Custom headers ride the same path, so one assertion covers both.
    assert.doesNotMatch(message, /^X-/m);
  } finally {
    server.close();
  }
});

test("email: priority writes the headers clients read, and a typo says so", async () => {
  const server = await smtpServer(() => "250 OK\r\n");
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    await resolve({ email: "a@x.com", subject: "Alarm", body: "hi", priority: "high" }, {});
    assert.match(server.sent[0], /^X-Priority: 1 \(Highest\)$/m);
    assert.match(server.sent[0], /^Importance: High$/m);

    // "normal" is nodemailer's default and writes no header at all.
    await resolve({ email: "a@x.com", subject: "Notice", body: "hi", priority: "normal" }, {});
    assert.doesNotMatch(server.sent[1], /^X-Priority:/m);

    await assert.rejects(
      async () => { await resolve({ email: "a@x.com", subject: "s", body: "hi", priority: "urgent" }, {}); },
      /Invalid email priority "urgent": expected high, normal, low/,
    );
  } finally {
    server.close();
  }
});

test("email: list writes the List-* set, brackets and all", async () => {
  const server = await smtpServer(() => "250 OK\r\n");
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    await resolve(
      {
        email: "a@x.com",
        subject: "News",
        body: "hi",
        list: {
          unsubscribe: { concat: ["https://example.com/u/", { var: "$token" }] },
          help: { url: "mailto:help@example.com", comment: "Support" },
          id: "news.example.com",
        },
        // The one-click header is not part of the List-* set, so it rides here.
        headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      },
      { token: "abc" },
    );
    assert.match(server.sent[0], /^List-Unsubscribe: <https:\/\/example\.com\/u\/abc>$/m);
    assert.match(server.sent[0], /^List-Help: <mailto:help@example\.com> \(Support\)$/m);
    assert.match(server.sent[0], /^List-ID: <news\.example\.com>$/m);
    assert.match(server.sent[0], /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  } finally {
    server.close();
  }
});

test("email: an invitation goes out as a calendar part, not an attachment", async () => {
  const server = await smtpServer(() => "250 OK\r\n");
  const invite = "BEGIN:VCALENDAR\nVERSION:2.0\nMETHOD:REQUEST\nBEGIN:VEVENT\nUID:1\nEND:VEVENT\nEND:VCALENDAR";
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    await resolve(
      {
        email: "a@x.com",
        subject: "Kickoff",
        body: "See invite",
        icalEvent: { method: "REQUEST", filename: "meeting.ics", content: { var: "$invite" } },
      },
      { invite },
    );
    // `method=REQUEST` on the part is what makes a client offer accept/decline.
    assert.match(server.sent[0], /Content-Type: text\/calendar;.*method=REQUEST/s);
    assert.match(server.sent[0], /filename=meeting\.ics/);
  } finally {
    server.close();
  }
});

test("email: an invitation path is refused the way an attachment path is", () => {
  assert.throws(
    () => icalEvent({ method: "REQUEST", path: "/invites/meeting.ics" }),
    /needs string or binary content/,
  );
});

test("email: custom headers reach the message", async () => {
  const server = await smtpServer(() => "250 OK\r\n");
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    await resolve(
      {
        email: "a@x.com",
        subject: "News",
        body: "hi",
        headers: {
          "List-Unsubscribe": "<https://example.com/u/abc>",
          "List-Unsubscribe-Post": { concat: ["List-Unsubscribe=", "One-Click"] },
        },
      },
      {},
    );
    assert.match(server.sent[0], /^List-Unsubscribe: <https:\/\/example\.com\/u\/abc>$/m);
    assert.match(server.sent[0], /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  } finally {
    server.close();
  }
});

// The lists earn their place here: the promise resolves, so without them a send
// that reached one of two recipients would look identical to a clean one.
test("email: a partial rejection resolves, and says who was dropped", async () => {
  const server = await smtpServer(n => (n === 1 ? "250 OK\r\n" : "550 no such user\r\n"));
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    const out = await resolve(
      { email: ["good@x.com", "bad@x.com"], subject: "Report", body: "hi" },
      {},
    ) as Record<string, unknown>;
    assert.deepEqual(out.accepted, ["good@x.com"]);
    assert.deepEqual(out.rejected, ["bad@x.com"]);
  } finally {
    server.close();
  }
});

// Every recipient refused rejects the promise (EENVELOPE) rather than resolving
// with an empty `accepted`, so the catch path is where those addresses surface.
test("email: every recipient refused throws, naming them in $smtp", async () => {
  const server = await smtpServer(() => "550 no such user\r\n");
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    const out = await resolve(
      {
        email: ["a@x.com", "b@x.com"],
        subject: "Report",
        body: "hi",
        catch: [{ concat: [{ var: "$error.status" }, " ", { var: "$smtp.code" }, " ", { var: "$smtp.rejected" }] }],
      },
      {},
    );
    // `concat` renders a list as JSON, which is how any array reads in a string slot.
    assert.equal(out, "502 EENVELOPE [\"a@x.com\",\"b@x.com\"]");
  } finally {
    server.close();
  }
});

// An uncaught HTTP error's message becomes the response body, so a long
// recipient list must not ride along in it.
test("email: a long recipient list is summarised in the message, whole in $smtp", async () => {
  const server = await smtpServer(() => "550 no such user\r\n");
  const to = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"];
  try {
    await resolve({ "email-connect": "smtp://127.0.0.1", port: server.port, tls: false, from: "me@x.com" }, {});
    await assert.rejects(
      async () => { await resolve({ email: to, subject: "Report", body: "hi" }, {}); },
      (err: Error) => {
        assert.match(err.message, /^Email to a@x\.com, b@x\.com, c@x\.com and 2 more failed:/);
        assert.doesNotMatch(err.message, /d@x\.com|e@x\.com/);
        return true;
      },
    );
    // The catch path still gets every one of them.
    const out = await resolve(
      { email: to, subject: "Report", body: "hi", catch: [{ var: "$smtp.rejected" }] },
      {},
    );
    assert.deepEqual(out, to);
  } finally {
    server.close();
  }
});

test("email: the failure message names the recipients without inventing one", async () => {
  await resolve({ "email-connect": "smtp://127.0.0.1", port: 1, timeout: 2000, from: "me@x.com" }, {});
  await assert.rejects(
    async () => { await resolve({ email: ["a@x.com", "b@x.com"], subject: "Report" }, {}); },
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /^Email to a@x\.com, b@x\.com failed:/);
      return true;
    },
  );
});
