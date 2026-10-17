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
        "{ \"$storage-get\": \"username\" }",
        "{ \"$storage-get\": \"cart\", \"session\": true }",
      ],
    },
    "storage-set": {
      type: "string",
      markdownDescription: "Writes the `value` sibling under the given key. Non-string values are JSON-encoded.",
      outputDescription: "The stored value.",
      examples: [
        "{ \"$storage-set\": \"username\", \"value\": \"Alice\" }",
        "{ \"$storage-set\": \"prefs\", \"value\": { \"theme\": \"dark\" } }",
      ],
      siblings: {
        value: { required: true, description: "The value to store. Non-string values are JSON-encoded." },
      },
    },
    "storage-delete": {
      type: "string",
      output: "boolean",
      markdownDescription: "Removes the entry under the given key.",
      outputDescription: "`true` if the key existed and was removed, otherwise `false`.",
      examples: [
        "{ \"$storage-delete\": \"username\" }",
      ],
    },
    "storage-has": {
      type: "string",
      output: "boolean",
      markdownDescription: "Checks whether the given key is present.",
      outputDescription: "`true` if the key is present, otherwise `false`, even when the stored value is the string `\"null\"`.",
      examples: [
        "{ \"$storage-has\": \"username\" }",
      ],
    },
    // Keyless bulk ops fold into the bare `storage` key (value-mode); the keyed
    // ones (`storage-get`/`set`/`delete`/`has`, as `cache-*` names them) keep
    // their prefix. All honor `session`.
    storage: {
      type: "string",
      enum: ["clear", "keys"],
      markdownDescription: "Storage bulk operation (the value is the op). Honors `session`.",
      examples: [
        "{ \"$storage\": \"keys\" }",
        "{ \"$storage\": \"clear\", \"session\": true }",
      ],
      variants: {
        clear: { output: "null", markdownDescription: "Clears every entry in the selected store." },
        keys:  { output: { type: "array", items: { type: "string" } }, markdownDescription: "Returns all keys present in the selected store as a string array." },
      },
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    session: {
      type: "boolean",
      description: "If true, target `sessionStorage` instead of `localStorage`.",
    },
  };

  ["storage-get"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$storage-get"], def.session], context, ([keyRaw, sessionRaw]) => {
      const store = pickStore(sessionRaw);
      return decode(store.getItem(String(keyRaw)));
    });
  }

  ["storage-set"](def: Record<string, unknown>, context: Context): NodeValue {
    if (!("value" in def)) throw new Error("storage-set needs a `value` to store");
    return resolveAll([def["$storage-set"], def.value, def.session], context, ([keyRaw, value, sessionRaw]) => {
      pickStore(sessionRaw).setItem(String(keyRaw), encode(value));
      return value;
    });
  }

  ["storage-delete"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$storage-delete"], def.session], context, ([keyRaw, sessionRaw]) => {
      const store = pickStore(sessionRaw);
      const key = String(keyRaw);
      const existed = store.getItem(key) !== null;
      store.removeItem(key);
      return existed;
    });
  }

  ["storage-has"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$storage-has"], def.session], context, ([keyRaw, sessionRaw]) =>
      pickStore(sessionRaw).getItem(String(keyRaw)) !== null);
  }

  ["storage"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$storage, def.session], context, ([op, sessionRaw]) => {
      const store = pickStore(sessionRaw);
      switch (op) {
        case "clear":
          store.clear();
          return null;
        case "keys": {
          const keys: string[] = [];
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k !== null) keys.push(k);
          }
          return keys;
        }
        default:
          throw new Error(`$storage: unknown operation ${JSON.stringify(op)}`);
      }
    });
  }
}
