import bcrypt from "bcrypt";
import {
  randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv,
  timingSafeEqual as timingSafeEqualBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Node, Context, resolve, resolveAll, resolverFor } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { isProduction } from "../env.js";

/**
 * Compare two secrets in constant time. Digested first so the two buffers are
 * always the same length: the raw comparison throws on a mismatch, and
 * returning early for one would leak the length of the secret.
 */
export function tokensEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqualBytes(left, right);
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// One list per option, shared by the schema `enum` and the runtime check below,
// so what the editor offers and what the node accepts cannot drift apart.
const ALGORITHMS = ["sha256", "sha512", "sha1"] as const;
const ENCODINGS = ["hex", "base64", "base64url"] as const;

type Algorithm = (typeof ALGORITHMS)[number];
type Encoding = (typeof ENCODINGS)[number];

/**
 * Both values of a two-value op. A missing side is not a comparison that came
 * out false, it is a step that cannot run, and answering `false` to "does this
 * token match" when nothing was compared is the wrong answer to give.
 */
function pair(value: unknown, name: string, shape: string): unknown[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${name} needs two values: ${shape}`);
  }
  return value;
}

// APP_SECRET env is the source for the encryption key; outside production the
// `secret.key` file is a fallback, resolved under the root a CryptoNode is
// constructed with (default "src"). The key is cached per node, so two resolvers
// built at different roots read their own key file instead of the last
// constructor silently winning for the whole process.

/** Each node's key, once derived; kept off the node so nothing reads it there. */
const keys = new WeakMap<CryptoNode, Buffer>();

/** Derive a 32-byte key from APP_SECRET, else, outside production, a key file it writes once. */
function getEncryptionKey(self: CryptoNode): Buffer {
  const cached = keys.get(self);
  if (cached) return cached;

  const secret = process.env.APP_SECRET;
  let key: Buffer;
  if (secret) {
    key = createHash("sha256").update(secret).digest();
  } else if (isProduction()) {
    // A key written at startup changes with every fresh deploy or container, and
    // what it encrypted could no longer be read.
    throw new Error("APP_SECRET must be set in production: it is the key $encrypt, $decrypt and $webpush use");
  } else {
    const keyFile = path.join(self.keyFileDir, "secret.key");
    if (existsSync(keyFile)) {
      key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    } else {
      key = randomBytes(32);
      writeFileSync(keyFile, key.toString("hex"), "utf8");
    }
  }
  keys.set(self, key);
  return key;
}

/** The app secret of the resolver a context runs in, as `$encrypt` uses it, for
 *  the other nodes that derive keys from it. */
export function appSecret(context: Context): Buffer {
  const node = resolverFor(context).nodeFor("encrypt");
  if (!(node instanceof CryptoNode)) throw new Error("No CryptoNode in this resolver; build it with serverNodes().");
  return getEncryptionKey(node);
}

/** AES-256-GCM encrypt. Returns "iv:authTag:ciphertext" (all hex). */
export function encrypt(self: CryptoNode, plaintext: string): string {
  const key = getEncryptionKey(self);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** AES-256-GCM decrypt. Expects "iv:authTag:ciphertext" (all hex). */
export function decrypt(self: CryptoNode, ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey(self);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

export class CryptoNode extends Node {
  static schema: JexsNodeSchema = {
    sha256: {
      type: "string",
      output: "string",
      markdownDescription: "Computes the SHA-256 digest of a string. Pass `encoding` for `base64` or `base64url` instead of hex, which is what a digest going into a header or a URL wants.",
      outputDescription: "A 64-character lowercase hex string, or the digest in the requested `encoding`.",
      examples: [
        "{ \"$sha256\": { \"$var\": \"token\" } }",
      ],
      siblings: {
        encoding: {
          type: "string",
          enum: ENCODINGS,
          default: "hex",
          description: "Digest encoding (default `\"hex\"`).",
        },
      },
    },
    hmac: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The message to authenticate." },
        { type: "string", description: "The shared secret key." },
      ],
      output: "string",
      markdownDescription: "Computes an HMAC of the message under the key. This is what verifies a signed webhook: recompute the signature over the raw body and compare it to the header the sender supplied, with `timingSafeEqual` rather than `eq`.",
      outputDescription: "The MAC in the requested `encoding` (hex by default).",
      examples: [
        "{ \"$hmac\": [{ \"$var\": \"request.rawBody\" }, { \"$var\": \"env.WEBHOOK_SECRET\" }], \"$as\": \"expected\" }",
      ],
      siblings: {
        algorithm: {
          type: "string",
          enum: ALGORITHMS,
          default: "sha256",
          description: "Hash backing the MAC (default `\"sha256\"`).",
        },
        encoding: {
          type: "string",
          enum: ENCODINGS,
          default: "hex",
          description: "Output encoding (default `\"hex\"`).",
        },
      },
    },
    timingSafeEqual: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "One value, e.g. the signature a caller sent." },
        { type: "string", description: "The other, e.g. the signature you computed." },
      ],
      output: "boolean",
      markdownDescription: "Compares two strings in constant time. Use it for anything secret: an `eq` on a token or a signature returns as soon as the first byte differs, and the time that takes tells an attacker how much of a guess was right.\n\nBoth sides are digested before comparing, so values of different lengths compare safely and the comparison leaks no length.",
      outputDescription: "`true` when the two are identical.",
      examples: [
        "{ \"$timingSafeEqual\": [{ \"$var\": \"request.headers.x-signature\" }, { \"$var\": \"expected\" }] }",
      ],
    },
    encrypt: {
      type: "string",
      output: "string",
      markdownDescription: "Encrypts a string with AES-256-GCM using the app secret: `APP_SECRET` from the environment, which production requires, or else a `secret.key` file written once into the templates root (`src/` by default) and kept out of version control. The same secret derives `$webpush`'s keys, so changing it also invalidates every push subscription.",
      outputDescription: "A string `\"iv:authTag:ciphertext\"` (all hex). Pass it back to `decrypt` to recover the plaintext.",
      examples: [
        "{ \"$encrypt\": { \"$var\": \"token\" } }",
      ],
    },
    decrypt: {
      type: "string",
      output: "string",
      markdownDescription: "Decrypts a string previously produced by `encrypt` (expects `\"iv:authTag:ciphertext\"`, all hex).",
      outputDescription: "The original plaintext string. Throws if the format is malformed or the GCM auth tag fails to verify.",
      examples: [
        "{ \"$decrypt\": { \"$var\": \"stored\" } }",
      ],
    },
    hash: {
      type: "string",
      output: "string",
      markdownDescription: "Hashes a password with bcrypt. Pass `\"rounds\"` for the cost factor (default 12).",
      outputDescription: "A bcrypt hash string (e.g. `$2b$12$…`), safe to store. Check it later with `verify`.",
      examples: [
        "{ \"$hash\": { \"$var\": \"body.password\" }, \"rounds\": 12 }",
      ],
      siblings: {
        rounds: {
          type: "number",
          description: "Bcrypt cost factor (default `12`). Each step doubles the time a hash takes, for you and for anyone guessing.",
        },
      },
    },
    verify: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The plaintext password to check." },
        { type: "string", description: "The stored bcrypt hash to compare against." },
      ],
      output: "boolean",
      markdownDescription: "Compares a plaintext password against a bcrypt hash.",
      outputDescription: "`true` if the password matches the hash, otherwise `false`.",
      examples: [
        "{ \"$verify\": [{ \"$var\": \"body.password\" }, { \"$var\": \"user.password_hash\" }] }",
      ],
    },
    uuid: {
      type: "boolean",
      output: "string",
      markdownDescription: "Generates a random (version 4) UUID. Use it for an id a database has not issued yet: an idempotency key, a correlation id, a row id chosen before the insert.",
      outputDescription: "A 36-character UUID, e.g. `\"3f8a1c2e-…\"`.",
      examples: [
        "{ \"$uuid\": true, \"$as\": \"requestId\" }",
      ],
    },
  };

  /** Root the `secret.key` dev fallback is resolved under. An instance field, not
   *  a prototype member, so `handlerKeys` never sees it. */
  keyFileDir: string;

  constructor(root: string = "src") {
    super();
    this.keyFileDir = root;
  }

  sha256(def: Record<string, unknown>, context: Context) {
    return resolveAll([def.$sha256, def.encoding], context, ([value, encoding]) =>
      createHash("sha256")
        .update(this.toString(value))
        .digest(this.getOption(encoding, ENCODINGS, "sha256 encoding") ?? "hex"),
    );
  }

  hmac(def: Record<string, unknown>, context: Context) {
    // The tuple resolves before it is split, so the whole pair may come from one
    // expression: `{ "$hmac": { "$var": "signing" } }` is as valid as writing the
    // two values out.
    return resolveAll([def.$hmac, def.algorithm, def.encoding], context,
      ([args, algorithm, encoding]) => {
        const [message, key] = pair(args, "hmac", "[message, key]");
        return createHmac(
          this.getOption(algorithm, ALGORITHMS, "hmac algorithm") ?? "sha256",
          this.toString(key),
        )
          .update(this.toString(message))
          .digest(this.getOption(encoding, ENCODINGS, "hmac encoding") ?? "hex");
      },
    );
  }

  timingSafeEqual(def: Record<string, unknown>, context: Context) {
    return resolve(def.$timingSafeEqual, context, args => {
      const [a, b] = pair(args, "timingSafeEqual", "[value, value]");
      return tokensEqual(this.toString(a), this.toString(b));
    });
  }

  encrypt(def: Record<string, unknown>, context: Context) {
    return resolve(def.$encrypt, context, v => encrypt(this, this.toString(v)));
  }

  decrypt(def: Record<string, unknown>, context: Context) {
    return resolve(def.$decrypt, context, v => decrypt(this, this.toString(v)));
  }

  hash(def: Record<string, unknown>, context: Context) {
    return resolveAll([def.$hash, def.rounds], context, ([v, rounds]) =>
      bcrypt.hash(this.toString(v), rounds == null ? 12 : this.toNumber(rounds)));
  }

  verify(def: Record<string, unknown>, context: Context) {
    return resolve(def.$verify, context, args => {
      const [plainVal, hashedVal] = pair(args, "verify", "[password, hash]");
      return bcrypt.compare(this.toString(plainVal), this.toString(hashedVal));
    });
  }


  uuid(): string {
    return randomUUID();
  }
}
