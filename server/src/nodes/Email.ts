import nodemailer from "nodemailer";
import type { Transporter, SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { Node, Context, NodeValue, resolveObj, createHttpError } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { parseTls, redactUrl, TLS_STRINGS } from "../connection.js";

export type SmtpOptions = SMTPTransport.Options;

/** One entry of nodemailer's `attachments` */
type EmailAttachment = NonNullable<SendMailOptions["attachments"]>[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let transporter: Transporter | null = null;
let defaultFrom: string | undefined;
let preview = false;

const SMTP_SCHEMES = new Set(["smtp", "smtps"]);

/** Shared by the schema `enum` and the runtime check, so the two cannot drift. */
const PRIORITIES: readonly NonNullable<SendMailOptions["priority"]>[] = ["high", "normal", "low"];

/**
 * Parse an SMTP connection string. `smtps://` is implicit TLS (port 465 by default).
 * `smtp://` starts in plaintext on 587 and upgrades with STARTTLS.
 */
export function parseSmtpUrl(raw: string): SmtpOptions {
  const s = String(raw).trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1].toLowerCase();
  if (!scheme || !SMTP_SCHEMES.has(scheme)) {
    throw new Error(`SMTP url must start with smtp:// or smtps:// (got "${redactUrl(s)}")`);
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`Malformed SMTP url: "${redactUrl(s)}"`);
  }
  const secure = scheme === "smtps";
  const options: SmtpOptions = { secure, port: url.port ? Number(url.port) : secure ? 465 : 587 };
  // `hostname` keeps the brackets on an IPv6 literal; the socket wants it bare.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host) options.host = host;
  if (url.username) {
    options.auth = {
      user: decodeURIComponent(url.username),
      pass: url.password ? decodeURIComponent(url.password) : undefined,
    };
  }
  return options;
}

/**
 * One or more addresses.
 */
export function addresses(value: unknown): string | string[] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) {
    const list = value
      .filter(v => v !== null && v !== undefined && v !== "")
      .map(v => String(v));
    return list.length > 0 ? list : undefined;
  }
  return String(value);
}

/** Attachment content, as bytes or text, never a path. */
function attachmentContent(value: unknown, filename: string): string | Buffer {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(
    `Attachment "${filename}" needs string or binary content. Load the file first, e.g. ` +
    `{ "file": "/reports/summary.pdf", "as": "pdf" } then { "content": { "var": "$pdf" } }`,
  );
}

/**
 * Attachments carry their content
 */
export function attachments(value: unknown): EmailAttachment[] | undefined {
  if (value === null || value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const out = list.map((entry, i) => {
    if (!isObject(entry)) {
      throw new Error(`Attachment ${i + 1} must be an object with "filename" and "content"`);
    }
    const filename = entry.filename === undefined ? `attachment-${i + 1}` : String(entry.filename);
    const item: EmailAttachment = {
      filename,
      content: attachmentContent(entry.content, filename),
    };
    if (entry.contentType !== undefined) item.contentType = String(entry.contentType);
    if (entry.cid !== undefined) item.cid = String(entry.cid);
    if (entry.encoding !== undefined) item.encoding = String(entry.encoding);
    return item;
  });
  return out.length > 0 ? out : undefined;
}

/** One `List-*` header value: a bare url, or one carrying a human label. */
type ListItem = string | { url: string; comment: string };

function listItem(value: unknown): ListItem | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (!isObject(value)) return String(value);
  if (value.url == null) throw new Error("A list header object needs a \"url\"");
  return { url: String(value.url), comment: String(value.comment ?? "") };
}

/**
 * The `List-*` header set, from a map keyed by the part after the dash:
 * `unsubscribe` becomes `List-Unsubscribe`, and a `{ url, comment }` becomes
 * `<url> (comment)`. Nodemailer writes the angle brackets, which is the reason
 * to spell these here rather than as raw `headers`, where getting them wrong is
 * easy and silent.
 */
export function listHeaders(value: unknown): Record<string, ListItem | ListItem[]> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, ListItem | ListItem[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Array.isArray(raw)) {
      const items = raw.map(listItem).filter((item): item is ListItem => item !== undefined);
      if (items.length > 0) out[key] = items;
      continue;
    }
    const item = listItem(raw);
    if (item !== undefined) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A calendar invitation, as nodemailer's own `icalEvent` shape. */
interface IcalEvent {
  filename?: string;
  method?: string;
  encoding?: string;
  content: string | Buffer;
}

/**
 * A calendar invitation. Content only, never a path or an `href`, for the same
 * reason attachments are: load it with `file` and pass the value. `method` is
 * what decides whether a client shows an accept/decline card (`REQUEST`) or a
 * plain calendar file, and it has to match the `METHOD:` inside the content.
 */
export function icalEvent(value: unknown): IcalEvent | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isObject(value)) return { content: attachmentContent(value, "invite.ics") };
  const filename = value.filename === undefined ? "invite.ics" : String(value.filename);
  const event: IcalEvent = { filename, content: attachmentContent(value.content, filename) };
  if (value.method !== undefined) event.method = String(value.method);
  if (value.encoding !== undefined) event.encoding = String(value.encoding);
  return event;
}

/**
 * Layer the `email-connect` siblings over whatever the target spelled out, into
 * the options `createTransport` takes. Pure, and exported, because this is where
 * the TLS decisions are made and they are worth asserting on directly.
 */
export function smtpOptions(base: SmtpOptions, siblings: Record<string, unknown>): SmtpOptions {
  const options: SmtpOptions = { ...base };
  if (siblings.port != null) options.port = Number(siblings.port);
  // Siblings layer over whatever the url carried, so either can supply either
  // half. `auth` is a union of nodemailer's login and OAuth2 shapes, so each half
  // is read only where the shape in hand actually has it.
  const auth = options.auth;
  const user = siblings.user != null ? String(siblings.user)
    : auth && "user" in auth ? auth.user : undefined;
  const pass = siblings.password != null ? String(siblings.password)
    : auth && "pass" in auth ? auth.pass : undefined;
  if (user) options.auth = { user, pass };
  if (siblings.secure != null) options.secure = Node.toBooleanValue(siblings.secure);
  if (siblings.timeout != null) {
    const ms = Number(siblings.timeout);
    options.connectionTimeout = ms;
    options.greetingTimeout = ms;
    options.socketTimeout = ms;
  }
  // Settled before TLS, which needs to know whether the connection is already
  // encrypted from the first byte.
  if (options.secure === undefined) options.secure = options.port === 465;
  if (options.port === undefined) options.port = options.secure ? 465 : 587;

  // `tls` is the same one knob it is for the cache and the database: off, or
  // on-and-therefore-required. SMTP spreads that across two nodemailer fields
  // because a plaintext connection MAY upgrade with STARTTLS: `ignoreTLS` never
  // upgrades, `requireTLS` fails unless the upgrade succeeds, and neither means
  // "upgrade if the server happens to offer it". That default is what an attacker
  // strips, and it would make a `ca` a guarantee in name only (TLS material that
  // applies just when the server feels like it), so asking for TLS requires it.
  const tls = parseTls(siblings.tls ?? siblings.ssl);
  if (tls === false) {
    options.secure = false;
    options.ignoreTLS = true;
  } else if (tls !== undefined) {
    if (typeof tls === "object") options.tls = tls;
    if (!options.secure) options.requireTLS = true;
  }
  if (!options.host) throw new Error("email-connect needs a host");
  return options;
}

/** Ethereal: a throwaway account that captures mail and hands back a preview URL. */
async function etherealOptions(): Promise<SmtpOptions> {
  const account = await nodemailer.createTestAccount();
  return {
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: { user: account.user, pass: account.pass },
  };
}

/** Checked in two places: before resolving, and again on what resolving produced. */
const NO_FROM = "email needs a from address: set `from` on email-connect, or on the message";

/**
 * Addresses as one short string, for an error message. Capped at three and a
 * count, because an uncaught HTTP error's message becomes the response body, and
 * a failed send to a hundred people should not hand that list to whoever made
 * the request. The full set stays in `$smtp.rejected`, which only a `catch`
 * that asks for it can read.
 */
function label(to: string | string[]): string {
  const list = Array.isArray(to) ? to : [to];
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

export class EmailNode extends Node {
  /**
   * `list` and `icalEvent` take shapes of their own rather than a value, so they
   * are spelled out here instead of going through `map`, which would leave every
   * key and value unchecked. Both have to tell their own shape apart from an
   * expression that produces it, since both are objects: the presence of the
   * shape's required key is the discriminator, and anything else routes to
   * `exprFlat` so `{ "var": "$invite" }` still validates.
   */
  static schemaDefs: Record<string, Record<string, unknown>> = {
    _listHeaders: {
      type: "object",
      properties: {
        unsubscribe: { $ref: "#/$defs/_listHeaderValue", markdownDescription: "Where to unsubscribe, as a url or a `mailto:`. Pair it with a `List-Unsubscribe-Post` header for the one-click form." },
        subscribe:   { $ref: "#/$defs/_listHeaderValue", description: "Where to subscribe." },
        help:        { $ref: "#/$defs/_listHeaderValue", description: "Where to get help with the list." },
        post:        { $ref: "#/$defs/_listHeaderValue", description: "Where to post to the list, or `\"NO\"` for an announce-only list." },
        archive:     { $ref: "#/$defs/_listHeaderValue", description: "Where the list archive lives." },
        owner:       { $ref: "#/$defs/_listHeaderValue", description: "How to reach the list owner." },
        id:          { $ref: "#/$defs/_listHeaderValue", description: "The list's own identifier, e.g. `\"news.example.com\"`." },
      },
      // Any other key becomes `List-<Key>`, so unknown ones are values, not typos.
      additionalProperties: { $ref: "#/$defs/_listHeaderValue" },
    },
    _listHeaderValue: {
      if: { type: "array" },
      then: { items: { $ref: "#/$defs/_listHeaderItem" } },
      else: { $ref: "#/$defs/_listHeaderItem" },
    },
    _listHeaderItem: {
      if: { type: "object" },
      then: {
        if: { required: ["url"] },
        then: {
          type: "object",
          properties: {
            url: { $ref: "#/$defs/strOrExpr", description: "The target, wrapped in angle brackets for you." },
            comment: { $ref: "#/$defs/strOrExpr", description: "A human label, rendered after the url in parentheses." },
          },
          additionalProperties: false,
        },
        else: { $ref: "#/$defs/exprFlat_string" },
      },
      else: { type: "string" },
    },
    _icalEvent: {
      if: { type: "object" },
      then: {
        if: { required: ["content"] },
        then: {
          type: "object",
          properties: {
            content: { $ref: "#/$defs/anyVal", description: "The calendar text, or the bytes a `file` step loaded." },
            method: { $ref: "#/$defs/strOrExpr", description: "`REQUEST` to invite, `CANCEL` to withdraw, `PUBLISH` (the default) to announce. Must match the `METHOD:` inside the content." },
            filename: { $ref: "#/$defs/strOrExpr", description: "Name of the calendar part (default `invite.ics`)." },
            encoding: { $ref: "#/$defs/strOrExpr", description: "Encoding of a string `content`, e.g. `\"base64\"`." },
          },
          additionalProperties: false,
        },
        else: { $ref: "#/$defs/exprFlat" },
      },
      else: { type: "string" },
    },
  };

  static schema: JexsNodeSchema = {
    email: {
      type: ["string", "array"],
      output: "object",
      markdownDescription: "Sends an email via SMTP to one address or a list of them, over the transport `email-connect` opened. Requires `subject`; use `body` for plain text, `html` for an HTML body, or both.\n\nA delivery failure throws a `502` HTTP error, so an enclosing `catch` gets `$error.status` and `$error.message`, plus `$smtp` (`{ code, responseCode, command }`) telling apart an auth rejection from a refused connection. A send where every recipient was rejected throws the same way, so nothing is reported as sent that was not.",
      outputDescription: "`{ messageId, accepted, rejected, response }`. `accepted` and `rejected` are address lists, so a send that reached some recipients but not all is visible rather than silent. Adds `previewUrl` on the Ethereal development transport.",
      examples: [
        "{ \"email\": { \"var\": \"$user.email\" }, \"subject\": \"Welcome!\", \"html\": \"<p>Hi there</p>\" }",
        "{ \"email\": [\"a@example.com\", \"b@example.com\"], \"cc\": { \"var\": \"$manager\" }, \"subject\": \"Report\", \"body\": \"Attached.\", \"attachments\": [{ \"filename\": \"report.pdf\", \"content\": { \"var\": \"$pdf\" } }] }",
        "{ \"email\": { \"var\": \"$ticket.reporter\" }, \"subject\": { \"concat\": [\"Re: \", { \"var\": \"$ticket.subject\" }] }, \"body\": { \"var\": \"$reply\" }, \"inReplyTo\": { \"var\": \"$ticket.messageId\" }, \"references\": { \"var\": \"$ticket.thread\" } }",
      ],
      siblings: {
        subject: {
          type: "string",
          required: true,
          description: "Subject line. Required: a send without one is treated as a mistake rather than sent unlabelled.",
        },
        body: {
          type: "string",
          description: "Plain text body. Can be sent alongside `html`, which is what mail clients prefer.",
        },
        html: {
          type: "string",
          description: "HTML body.",
        },
        from: {
          type: "string",
          description: "Sender address, overriding the `from` set on `email-connect`.",
        },
        cc: {
          type: ["string", "array"],
          markdownDescription: "Carbon copy: one address or a list.\n\nHow many recipients a message may carry across `to`, `cc` and `bcc` is the server's policy, not this node's: RFC 5321 guarantees only 100, and providers range from 50 (SES, Postmark) to 1000 (SendGrid). Past the cap the server answers `452` and the send throws, so a larger audience wants sending in batches.",
        },
        bcc: {
          type: ["string", "array"],
          description: "Blind carbon copy: one address or a list, hidden from the other recipients.",
        },
        replyTo: {
          type: ["string", "array"],
          description: "Where replies should go, when that is not the sender.",
        },
        priority: {
          type: "string",
          enum: PRIORITIES,
          markdownDescription: "Message importance, written as the `X-Priority`, `X-MSMail-Priority` and `Importance` headers that clients read. `\"normal\"` is the default and writes nothing at all, so it is only worth passing to override a value coming from an expression.\n\nIt marks the message, it does not speed it up: the server queues it the same either way, and a `\"high\"` on routine mail is the kind of thing spam filters notice.",
        },
        inReplyTo: {
          type: "string",
          markdownDescription: "The message id this one answers, which is what makes a client file it under the existing conversation instead of starting a new one. It is the `messageId` a previous `email` step returned, so a ticket or comment thread stores that and passes it back here.",
        },
        references: {
          type: ["string", "array"],
          markdownDescription: "Every message id already in the thread, oldest first, with the one in `inReplyTo` last. Most clients thread on this rather than on `inReplyTo` alone, so a long conversation needs the chain, not just the parent.",
        },
        list: {
          $ref: "#/$defs/_listHeaders",
          markdownDescription: "The `List-*` headers, keyed by the part after the dash. A value is a url, or `{ \"url\": …, \"comment\": … }` to label it, or a list of either.\n\nNodemailer writes the angle brackets and formatting, which is the reason to spell them here rather than as raw `headers`. One caveat for bulk mail: the one-click header Gmail and Yahoo require is `List-Unsubscribe-Post`, which is not part of this set, so it still goes in `headers` alongside.",
          examples: [
            "{ \"unsubscribe\": \"https://example.com/u/abc\", \"help\": { \"url\": \"mailto:help@example.com\", \"comment\": \"Support\" } }",
          ],
        },
        icalEvent: {
          $ref: "#/$defs/_icalEvent",
          markdownDescription: "A calendar invitation, which is what makes a client render an accept/decline card instead of a dead attachment. Either the calendar text itself, or `{ method, content, filename }`.\n\n`method` must match the `METHOD:` inside the content: `REQUEST` to invite, `CANCEL` to withdraw, `PUBLISH` (the default) for an event that is merely announced. Content is text or bytes, never a path, so load an `.ics` with `file` first.",
          examples: [
            "{ \"method\": \"REQUEST\", \"filename\": \"meeting.ics\", \"content\": { \"var\": \"$invite\" } }",
          ],
        },
        attachments: {
          type: "array",
          items: {
            properties: {
              // `filename` is NOT required: an attachment without one is named
              // `attachment-<n>`. `content` has no such fallback and throws.
              filename: { type: "string", description: "Name the recipient sees." },
              content: { required: true, description: "The bytes or text to attach. Load a file with `file` and pass the result." },
              contentType: { type: "string", description: "MIME type; inferred from the filename when omitted." },
              cid: { type: "string", description: "Content ID, to reference the attachment from the HTML body as `cid:<value>`." },
              encoding: { type: "string", description: "Encoding of a string `content` (e.g. `\"base64\"`)." },
            },
          },
          markdownDescription: "Files to attach, each `{ filename, content }`. Content is bytes or text, never a path. Load it the way Jexs loads anything, `{ \"file\": \"/reports/x.pdf\", \"as\": \"pdf\" }`, then pass `{ \"var\": \"$pdf\" }`.",
          examples: [
            "[{ \"filename\": \"invoice.pdf\", \"content\": { \"var\": \"$pdf\" } }]",
          ],
        },
        headers: {
          map: true,
          markdownDescription: "Extra message headers, each value resolved as an expression. For the ones mail infrastructure reads rather than people:\n\n- **Deliverability.** `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, which Gmail and Yahoo have required from bulk senders since February 2024. `Auto-Submitted: auto-generated` keeps out-of-office bots from replying to a password reset.\n- **Provider instructions.** `X-SMTPAPI` (SendGrid), `X-Mailgun-Variables`, `X-PM-Metadata-*` (Postmark), `X-SES-MESSAGE-TAGS`, which carry tags and metadata that come back on the provider's delivery webhooks.\n- **Your own.** A correlation id tying the send back to the request that caused it.\n\nNot for anything with its own sibling or nodemailer option (`replyTo`, message id, date, priority, the `List-*` set), which this would only fight.",
          examples: [
            "{ \"List-Unsubscribe\": \"<https://example.com/u/abc>\", \"List-Unsubscribe-Post\": \"List-Unsubscribe=One-Click\" }",
          ],
        },
      },
    },
    "email-connect": {
      type: "string",
      output: "string",
      markdownDescription: "Opens the SMTP transport every `email` step then sends over. The value is a connection string (`smtps://user:pass@smtp.example.com`), a bare hostname with the details in siblings, or `\"ethereal\"` for a development transport that captures mail and returns a preview URL instead of delivering it.\n\nCall it once at startup, reading credentials the way any other value arrives, `{ \"var\": \"$env.SMTP_URL\" }`. A later call replaces the transport. There is no implicit configuration: without this, an `email` step says so rather than guessing.",
      outputDescription: "The configured host.",
      examples: [
        "{ \"email-connect\": { \"var\": \"$env.SMTP_URL\" }, \"from\": \"noreply@example.com\" }",
        "{ \"email-connect\": \"smtp.example.com\", \"port\": 587, \"user\": \"apikey\", \"password\": { \"var\": \"$env.SMTP_PASS\" }, \"tls\": true }",
        "{ \"email-connect\": \"ethereal\" }",
      ],
      siblings: {
        port: {
          type: "number",
          description: "Port (default `465` when `secure`, otherwise `587`).",
        },
        user: {
          type: "string",
          description: "Username for SMTP auth. Omit both this and `password` for a relay that takes none.",
        },
        password: {
          type: "string",
          description: "Password for SMTP auth.",
        },
        from: {
          type: "string",
          description: "Default sender for every message that does not give its own `from`.",
        },
        secure: {
          type: "boolean",
          markdownDescription: "**When** TLS starts, as opposed to `tls`, which is whether it is used at all. `true` encrypts from the first byte, the port-465 style; `false` starts in plaintext and upgrades with STARTTLS, the port-587 style. Defaults from the port (465) or the url scheme (`smtps://`), so it is only worth setting for a provider doing implicit TLS on some other port.",
        },
        tls: {
          type: ["boolean", "string", "object"],
          enum: TLS_STRINGS,
          markdownDescription: "TLS for the connection, also spelled `ssl`, and the same knob it is on `cache-connect` and `database`. `true` encrypts and verifies against the system trust store, and **fails** rather than sending in the clear. Worth setting on any connection that is not already `secure`, because SMTP's own default is to upgrade only if the server offers to, which is exactly what an attacker strips. An object does the same with its own material: `ca`, `cert`, `key`, `passphrase`, `servername`, `rejectUnauthorized`, `minVersion`, `ciphers`. `false` refuses TLS altogether, for a local relay that has none.\n\nCertificates are PEM **content**, not paths: load the file first with `{ \"file\": \"/certs/smtp-ca.pem\", \"raw\": true, \"as\": \"ca\" }` and pass `{ \"var\": \"$ca\" }`.",
          examples: [
            "true",
            "{ \"ca\": { \"var\": \"$ca\" }, \"servername\": \"mail.internal\" }",
          ],
        },
        timeout: {
          type: "number",
          description: "Milliseconds to wait for the connection, the greeting, and each socket read. Unset leaves nodemailer's own two-minute defaults.",
        },
      },
    },
  };

  ["email-connect"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, async o => {
      const target = this.toString(o["email-connect"]).trim();
      if (!target) throw new Error("email-connect needs a host, an smtp:// url, or \"ethereal\"");

      preview = target.toLowerCase() === "ethereal";
      const base: SmtpOptions = preview
        ? await etherealOptions()
        // A scheme is what separates the two spellings: anything else is a host.
        : /^[a-z][a-z0-9+.-]*:/i.test(target)
          ? parseSmtpUrl(target)
          : { host: target };

      const options = smtpOptions(base, o);
      defaultFrom = o.from != null ? this.toString(o.from) : undefined;
      // The default `from` has to ride in the second argument; nodemailer ignores
      // one set inside the transport options, though the type accepts it there.
      transporter = nodemailer.createTransport(options, defaultFrom ? { from: defaultFrom } : undefined);
      return options.host;
    });
  }

  email(def: Record<string, unknown>, context: Context): NodeValue {
    if (!("subject" in def)) throw new Error("email needs a subject");
    if (!defaultFrom && !("from" in def)) throw new Error(NO_FROM);

    const t = transporter;
    if (!t) {
      throw createHttpError(
        500,
        "Email has no transport: run { \"email-connect\": … } at startup: a url " +
        "(\"smtps://user:pass@host\"), a hostname with the credentials alongside, " +
        "or \"ethereal\" for a development preview transport.",
      );
    }

    const { headers, ...fields } = def;
    const headerDef = this.isObject(headers) ? headers : {};
    return resolveObj(fields, context, o =>
      resolveObj(headerDef, context, async headerValues => {
        const to = addresses(o.email);
        if (!to) throw new Error("email needs at least one recipient");
        // The preflight only proved a `from` was WRITTEN; this is checking the resolved value.
        if (o.from == null && !defaultFrom) throw new Error(NO_FROM);

        const message: SendMailOptions = { to, subject: this.toString(o.subject) };
        if (o.from != null) message.from = this.toString(o.from);
        if (o.body != null) message.text = this.toString(o.body);
        if (o.html != null) message.html = this.toString(o.html);
        const cc = addresses(o.cc);
        if (cc) message.cc = cc;
        const bcc = addresses(o.bcc);
        if (bcc) message.bcc = bcc;
        const replyTo = addresses(o.replyTo);
        if (replyTo) message.replyTo = Array.isArray(replyTo) ? replyTo.join(", ") : replyTo;
        if (o.priority != null) {
          const priority = PRIORITIES.find(p => p === this.toString(o.priority).toLowerCase());
          if (!priority) {
            throw new Error(`Invalid email priority "${this.toString(o.priority)}": expected ${PRIORITIES.join(", ")}`);
          }
          message.priority = priority;
        }
        if (o.inReplyTo != null) message.inReplyTo = this.toString(o.inReplyTo);
        // Message ids take the same one-or-a-list shape an address field does.
        const references = addresses(o.references);
        if (references) message.references = references;
        const files = attachments(o.attachments);
        if (files) message.attachments = files;
        const list = listHeaders(o.list);
        if (list) message.list = list;
        const invite = icalEvent(o.icalEvent);
        if (invite) message.icalEvent = invite;
        const extra: Record<string, string> = {};
        for (const [name, value] of Object.entries(headerValues)) {
          if (value === null || value === undefined) continue;
          extra[name] = String(value);
        }
        if (Object.keys(extra).length > 0) message.headers = extra;

        let info;
        try {
          info = await t.sendMail(message);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw createHttpError(
            502,
            `Email to ${label(to)} failed: ${reason}`,
            { smtp: isObject(error) ? { ...error } : {} }
          );
        }

        // Reaching here means at least one recipient was accepted: a send the
        // server refused outright rejects the promise above, with the addresses
        // on the error. The lists are what tell a PARTIAL delivery apart.
        const result: Record<string, unknown> = {
          messageId: info.messageId,
          accepted: (info.accepted ?? []).map(String),
          rejected: (info.rejected ?? []).map(String),
          response: info.response ?? null,
        };
        if (preview) {
          const previewUrl = nodemailer.getTestMessageUrl(info);
          console.log(`[EmailNode] Preview: ${previewUrl}`);
          result.previewUrl = previewUrl;
        }
        return result;
      }),
    );
  }
}
