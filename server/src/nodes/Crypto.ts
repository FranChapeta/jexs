import bcrypt from "bcrypt";
import {
  randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv,
  timingSafeEqual as timingSafeEqualBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Node, Context, resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** Reusable SHA-256 helper (used by SchemaNode and QueryNode) */
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

// APP_SECRET env is the primary source for the encryption key; the `secret.key`
// file is a dev fallback, resolved under the root a CryptoNode is constructed
// with (default "app"). Both the root and the cached key live on the node, so two
// resolvers built at different roots read their own key file instead of the last
// constructor silently winning for the whole process.

function keyFilePath(self: CryptoNode): string {
  return path.join(self.keyFileDir, "secret.key");
}

/** Derive a 32-byte key from APP_SECRET env var, key file, or auto-generated key file */
function getEncryptionKey(self: CryptoNode): Buffer {
  if (self.cachedKey) return self.cachedKey;

  const secret = process.env.APP_SECRET;
  if (secret) {
    self.cachedKey = createHash("sha256").update(secret).digest();
    return self.cachedKey;
  }

  const keyFile = keyFilePath(self);
  if (existsSync(keyFile)) {
    self.cachedKey = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    return self.cachedKey;
  }

  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString("hex"), "utf8");
  self.cachedKey = key;
  return self.cachedKey;
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
  if (parts.length !== 3) throw new Error("[Crypto] Invalid encrypted format");
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey(self);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Handles cryptographic operations (server-only, requires Node.js).
 *
 * Supported operations:
 * - { "hash": "password" }              -> "$2b$10$..." (bcrypt hash)
 * - { "hash": "password", "rounds": 12 } -> bcrypt with custom rounds
 * - { "verify": ["password", "$2b$..."] } -> true/false (bcrypt compare)
 * - { "randomHex": 32 }                 -> random hex string (32 bytes)
 * - { "sha256": "text" }                -> SHA-256 hex digest
 * - { "encrypt": "plaintext" }          -> AES-256-GCM encrypted string
 * - { "decrypt": "ciphertext" }         -> decrypted plaintext
 */
export class CryptoNode extends Node {
  static schema: JexsNodeSchema = {
    sha256: {
      type: "string",
      output: "string",
      markdownDescription: "Computes the SHA-256 digest of a string. Pass `encoding` for `base64` or `base64url` instead of hex, which is what a digest going into a header or a URL wants.",
      outputDescription: "A 64-character lowercase hex string, or the digest in the requested `encoding`.",
      examples: [
        "{ \"sha256\": { \"var\": \"$token\" } }",
      ],
      siblings: {
        encoding: {
          type: "string",
          enum: ENCODINGS,
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
        "{ \"hmac\": [{ \"var\": \"$request.rawBody\" }, { \"var\": \"$env.WEBHOOK_SECRET\" }], \"as\": \"expected\" }",
      ],
      siblings: {
        algorithm: {
          type: "string",
          enum: ALGORITHMS,
          description: "Hash backing the MAC (default `\"sha256\"`).",
        },
        encoding: {
          type: "string",
          enum: ENCODINGS,
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
        "{ \"timingSafeEqual\": [{ \"var\": \"$request.headers.x-signature\" }, { \"var\": \"$expected\" }] }",
      ],
    },
    encrypt: {
      type: "string",
      output: "string",
      markdownDescription: "Encrypts a string with AES-256-GCM using the app secret key (`APP_SECRET` env or an auto-generated `app/secret.key`).",
      outputDescription: "A string `\"iv:authTag:ciphertext\"` (all hex). Pass it back to `decrypt` to recover the plaintext.",
      examples: [
        "{ \"encrypt\": { \"var\": \"$token\" } }",
      ],
    },
    decrypt: {
      type: "string",
      output: "string",
      markdownDescription: "Decrypts a string previously produced by `encrypt` (expects `\"iv:authTag:ciphertext\"`, all hex).",
      outputDescription: "The original plaintext string. Throws if the format is malformed or the GCM auth tag fails to verify.",
      examples: [
        "{ \"decrypt\": { \"var\": \"$stored\" } }",
      ],
    },
    hash: {
      type: "string",
      output: "string",
      markdownDescription: "Hashes a password with bcrypt. Pass `\"rounds\"` for the cost factor (default 10).",
      outputDescription: "A bcrypt hash string (e.g. `$2b$10$…`), safe to store. Check it later with `verify`.",
      examples: [
        "{ \"hash\": { \"var\": \"$body.password\" }, \"rounds\": 12 }",
      ],
      siblings: {
        rounds: {
          type: "number",
          description: "Bcrypt cost factor (default `10`).",
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
        "{ \"verify\": [{ \"var\": \"$body.password\" }, { \"var\": \"$user.password_hash\" }] }",
      ],
    },
    randomHex: {
      type: "number",
      output: "string",
      markdownDescription: "Generates cryptographically random bytes (default 32).",
      outputDescription: "A hex string `2 × bytes` characters long.",
      examples: [
        "{ \"randomHex\": 16 }",
      ],
    },
    uuid: {
      type: "boolean",
      output: "string",
      markdownDescription: "Generates a random (version 4) UUID. Use it for an id a database has not issued yet: an idempotency key, a correlation id, a row id chosen before the insert.",
      outputDescription: "A 36-character UUID, e.g. `\"3f8a1c2e-…\"`.",
      examples: [
        "{ \"uuid\": true, \"as\": \"requestId\" }",
      ],
    },
  };

  /** Root the `secret.key` dev fallback is resolved under. Instance fields, not
   *  prototype members, so `handlerKeys` never sees them. */
  keyFileDir: string;
  cachedKey: Buffer | null = null;

  constructor(root: string = "app") {
    super();
    this.keyFileDir = root;
  }

  sha256(def: Record<string, unknown>, context: Context) {
    return resolveAll([def.sha256, def.encoding], context, ([value, encoding]) =>
      createHash("sha256")
        .update(this.toString(value))
        .digest(this.getOption(encoding, ENCODINGS, "sha256 encoding") ?? "hex"),
    );
  }

  hmac(def: Record<string, unknown>, context: Context) {
    // The tuple resolves before it is split, so the whole pair may come from one
    // expression: `{ "hmac": { "var": "$signing" } }` is as valid as writing the
    // two values out.
    return resolveAll([def.hmac, def.algorithm, def.encoding], context,
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
    return resolve(def.timingSafeEqual, context, args => {
      const [a, b] = pair(args, "timingSafeEqual", "[value, value]");
      // Digested first so the two buffers are always the same length: the raw
      // comparison throws on a mismatch, and returning early for one would leak
      // the length of the secret.
      const left = createHash("sha256").update(this.toString(a)).digest();
      const right = createHash("sha256").update(this.toString(b)).digest();
      return timingSafeEqualBytes(left, right);
    });
  }

  encrypt(def: Record<string, unknown>, context: Context) {
    return resolve(def.encrypt, context, v => encrypt(this, this.toString(v)));
  }

  decrypt(def: Record<string, unknown>, context: Context) {
    return resolve(def.decrypt, context, v => decrypt(this, this.toString(v)));
  }

  hash(def: Record<string, unknown>, context: Context) {
    return resolve(def.hash, context, v => {
      const str = this.toString(v);
      if (!def.rounds) return bcrypt.hash(str, 10);
      return resolve(def.rounds, context, r => bcrypt.hash(str, this.toNumber(r)));
    });
  }

  verify(def: Record<string, unknown>, context: Context) {
    return resolve(def.verify, context, args => {
      const [plainVal, hashedVal] = pair(args, "verify", "[password, hash]");
      return bcrypt.compare(this.toString(plainVal), this.toString(hashedVal));
    });
  }

  randomHex(def: Record<string, unknown>, context: Context) {
    return resolve(def.randomHex, context, v => {
      // Absent means the documented 32. Anything else has to be a real count:
      // `toNumber` reads "abc" as 0, and the `|| 32` that followed then handed
      // back a token of a size nobody asked for.
      if (v === null || v === undefined) return randomBytes(32).toString("hex");
      const bytes = typeof v === "number" ? v
        : typeof v === "string" && v.trim() !== "" ? Number(v)
        : NaN;
      if (!Number.isInteger(bytes) || bytes < 1) {
        throw new Error(`Invalid randomHex "${String(v)}": expected a positive whole number of bytes`);
      }
      return randomBytes(bytes).toString("hex");
    });
  }

  uuid(): string {
    return randomUUID();
  }
}
