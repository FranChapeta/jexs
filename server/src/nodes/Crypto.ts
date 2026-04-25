import bcrypt from "bcrypt";
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Node, Context, resolve, resolveAll } from "@jexs/core";

/** Reusable SHA-256 helper (used by SchemaNode and QueryNode) */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const KEY_FILE = path.join("app", "secret.key");
let cachedKey: Buffer | null = null;

/** Derive a 32-byte key from APP_SECRET env var, key file, or auto-generated key file */
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const secret = process.env.APP_SECRET;
  if (secret) {
    cachedKey = createHash("sha256").update(secret).digest();
    return cachedKey;
  }

  if (existsSync(KEY_FILE)) {
    cachedKey = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
    return cachedKey;
  }

  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key.toString("hex"), "utf8");
  cachedKey = key;
  return cachedKey;
}

/** AES-256-GCM encrypt. Returns "iv:authTag:ciphertext" (all hex). */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** AES-256-GCM decrypt. Expects "iv:authTag:ciphertext" (all hex). */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("[Crypto] Invalid encrypted format");
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey();
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
  /**
   * Returns the SHA-256 hex digest of a string.
   *
   * @param {string} sha256 The input string to hash.
   * @example
   * { "sha256": { "var": "$token" } }
   */
  sha256(def: Record<string, unknown>, context: Context) {
    return resolve(def.sha256, context, v => sha256(this.toString(v)));
  }

  /**
   * Encrypts a string with AES-256-GCM using the app secret key. Returns `"iv:authTag:ciphertext"` (hex).
   *
   * @param {string} encrypt The plaintext string to encrypt.
   * @example
   * { "encrypt": { "var": "$token" } }
   */
  encrypt(def: Record<string, unknown>, context: Context) {
    return resolve(def.encrypt, context, v => encrypt(this.toString(v)));
  }

  /**
   * Decrypts a string previously encrypted by `encrypt`. Expects `"iv:authTag:ciphertext"` (hex).
   *
   * @param {string} decrypt The encrypted string to decrypt.
   * @example
   * { "decrypt": { "var": "$stored" } }
   */
  decrypt(def: Record<string, unknown>, context: Context) {
    return resolve(def.decrypt, context, v => decrypt(this.toString(v)));
  }

  /**
   * Hashes a password with bcrypt. Pass `"rounds"` for cost factor (default 10).
   *
   * @param {string} hash The plaintext password to hash.
   * @param {number} rounds Bcrypt cost factor (default `10`).
   * @example
   * { "hash": { "var": "$body.password" }, "rounds": 12 }
   */
  hash(def: Record<string, unknown>, context: Context) {
    return resolve(def.hash, context, v => {
      const str = this.toString(v);
      if (!def.rounds) return bcrypt.hash(str, 10);
      return resolve(def.rounds, context, r => bcrypt.hash(str, this.toNumber(r)));
    });
  }

  /**
   * Compares a plaintext password against a bcrypt hash. Returns `true` or `false`.
   *
   * @param {[2]} verify `[plaintext, hash]`.
   * @example
   * { "verify": [{ "var": "$body.password" }, { "var": "$user.password_hash" }] }
   */
  verify(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.verify);
    if (args.length < 2) return false;
    return resolveAll([args[0], args[1]], context, ([plainVal, hashedVal]) =>
      bcrypt.compare(this.toString(plainVal), this.toString(hashedVal))
    );
  }

  /**
   * Returns a cryptographically random hex string of N bytes (default 32).
   *
   * @param {number} randomHex Number of random bytes (output length is double this).
   * @example
   * { "randomHex": 16 }
   */
  randomHex(def: Record<string, unknown>, context: Context) {
    return resolve(def.randomHex, context, v => {
      const bytes = this.toNumber(v) || 32;
      return randomBytes(bytes).toString("hex");
    });
  }
}
