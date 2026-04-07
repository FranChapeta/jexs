import bcrypt from "bcrypt";
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Node, Context, resolve } from "@jexs/core";

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
  async sha256(def: Record<string, unknown>, context: Context) {
    return sha256(this.toString(await resolve(def.sha256, context)));
  }

  async encrypt(def: Record<string, unknown>, context: Context) {
    return encrypt(this.toString(await resolve(def.encrypt, context)));
  }

  async decrypt(def: Record<string, unknown>, context: Context) {
    return decrypt(this.toString(await resolve(def.decrypt, context)));
  }

  async hash(def: Record<string, unknown>, context: Context): Promise<string> {
    const str = this.toString(await resolve(def.hash, context));
    const rounds = def.rounds
      ? this.toNumber(await resolve(def.rounds, context))
      : 10;
    return bcrypt.hash(str, rounds);
  }

  async verify(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const args = this.toArray(def.verify);
    if (args.length < 2) return false;
    const plain = this.toString(await resolve(args[0], context));
    const hashed = this.toString(await resolve(args[1], context));
    return bcrypt.compare(plain, hashed);
  }

  async randomHex(def: Record<string, unknown>, context: Context): Promise<string> {
    const bytes = this.toNumber(await resolve(def.randomHex, context)) || 32;
    return randomBytes(bytes).toString("hex");
  }
}
