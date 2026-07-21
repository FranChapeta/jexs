import { Node, Context, NodeValue } from "@jexs/core";
import { resolveAll } from "@jexs/core";
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

function pickStore(useSession: unknown): Storage {
  return useSession ? window.sessionStorage : window.localStorage;
}

function decode(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function encode(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class StorageNode extends Node {
  static schema: JexsNodeSchema = {
    "storage-get": {
      type: "string",
      markdownDescription: "Reads a value from `localStorage` (or `sessionStorage` if `session: true`). Returns the JSON-parsed value, the raw string if parsing fails, or `null` if the key is absent.",
      examples: [
        "{ \"storage-get\": \"username\" }",
        "{ \"storage-get\": \"cart\", \"session\": true }",
      ],
    },
    "storage-set": {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The storage key." },
        { description: "The value to store. Non-string values are JSON-encoded." },
      ],
      markdownDescription: "Writes a value under a key. Pass `[\"key\", value]`. Non-string values are JSON-encoded. Returns the stored value.",
      examples: [
        "{ \"storage-set\": [\"username\", \"Alice\"] }",
        "{ \"storage-set\": [\"prefs\", { \"theme\": \"dark\" }] }",
      ],
    },
    "storage-remove": {
      type: "string",
      output: "boolean",
      markdownDescription: "Deletes the entry under `key`. Returns `true`.",
      examples: [
        "{ \"storage-remove\": \"username\" }",
      ],
    },
    // Keyless bulk ops fold into the bare `storage` key (value-mode); the keyed
    // CRUD (`storage-get`/`set`/`remove`) keeps its prefix. Both honor `session`.
    storage: {
      type: "string",
      enum: ["clear", "keys"],
      markdownDescription: "Storage bulk operation (the value is the op). Honors `session`.",
      examples: [
        "{ \"storage\": \"keys\" }",
        "{ \"storage\": \"clear\", \"session\": true }",
      ],
      variants: {
        clear: { output: "boolean", markdownDescription: "Clears every entry in the selected store. Returns `true`." },
        keys:  { output: "array", markdownDescription: "Returns all keys present in the selected store as a string array." },
      },
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    // `session` shares a name with SessionNode's handler key, but the combined
    // schema gates dispatch by primary key — when a `storage-*` op is present,
    // `session` is validated as this sibling, not as a SessionNode op.
    session: {
      type: "boolean",
      description: "If true, target `sessionStorage` instead of `localStorage`.",
    },
  };

  ["storage-get"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["storage-get"], def.session], context, ([keyRaw, sessionRaw]) => {
      const store = pickStore(sessionRaw);
      return decode(store.getItem(String(keyRaw)));
    });
  }

  ["storage-set"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["storage-set"], def.session], context, ([argsRaw, sessionRaw]) => {
      if (!Array.isArray(argsRaw) || argsRaw.length < 2) return null;
      const [keyRaw, value] = argsRaw;
      const store = pickStore(sessionRaw);
      store.setItem(String(keyRaw), encode(value));
      return value;
    });
  }

  ["storage-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["storage-remove"], def.session], context, ([keyRaw, sessionRaw]) => {
      const store = pickStore(sessionRaw);
      store.removeItem(String(keyRaw));
      return true;
    });
  }

  ["storage"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.storage, def.session], context, ([op, sessionRaw]) => {
      const store = pickStore(sessionRaw);
      switch (op) {
        case "clear":
          store.clear();
          return true;
        case "keys": {
          const keys: string[] = [];
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k !== null) keys.push(k);
          }
          return keys;
        }
        default:
          return null;
      }
    });
  }
}
