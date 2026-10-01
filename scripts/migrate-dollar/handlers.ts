/**
 * One-off rewrite of node handlers for the `$` prefix: inside the handler method
 * for op K, reads of K through the handler's definition parameter (and through
 * the object a `resolveObj(def, ...)` / `resolveFields(def, ...)` callback
 * receives) become reads of `$K`.
 * Every other property access is left alone, since `arr.map(...)` inside the
 * `map` handler is a method call, not the op.
 *
 * Usage: tsx scripts/migrate-dollar/handlers.ts <node source files>...
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(path.join(HERE, "pre-dollar.combined.schema.json"), "utf8")) as { byKey: Record<string, unknown> };
const HANDLERS = new Set(Object.keys(C.byKey));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Index just past the brace block starting at `open` (skips strings and comments). */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      continue;
    }
    if (s.startsWith("//", i)) { i = s.indexOf("\n", i); if (i < 0) return s.length; continue; }
    if (s.startsWith("/*", i)) { i = s.indexOf("*/", i) + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return s.length;
}

let total = 0;
for (const file of process.argv.slice(2)) {
  let s = readFileSync(file, "utf8");
  const edits: Array<{ start: number; end: number; text: string }> = [];
  // `  key(def...`, `  async key(def...`, `  ["key"](def...`, `  async ["key"](def...`
  const methodRe = /^[ \t]+(?:async\s+)?(?:\["([^"]+)"\]|([A-Za-z_$][\w$]*))\s*\(\s*(\w+)\s*:[^)]*\)[^{;]*\{/gm;
  for (const m of s.matchAll(methodRe)) {
    const key = m[1] ?? m[2];
    if (!HANDLERS.has(key)) continue;
    const param = m[3];
    const open = m.index! + m[0].length - 1;
    const end = blockEnd(s, open);
    const body = s.slice(open, end);
    // The definition parameter, plus whatever a resolveObj/resolveFields(<param>, ctx, cb) callback names its result.
    const names = new Set([param]);
    for (const r of body.matchAll(new RegExp(`(?:resolveObj|resolveFields)\\(\\s*${esc(param)}\\s*,\\s*\\w+\\s*,\\s*(?:async\\s*)?\\(?\\s*(\\w+)`, "g"))) names.add(r[1]);
    for (const n of names) {
      const patterns = [
        new RegExp(`\\b${esc(n)}\\.${esc(key)}\\b(?![\\w$])`, "g"),        // def.key
        new RegExp(`\\b${esc(n)}\\[\\s*(["'])${esc(key)}\\1\\s*\\]`, "g"),  // def["key"]
        new RegExp(`(["'])${esc(key)}\\1\\s+in\\s+${esc(n)}\\b`, "g"),     // "key" in def
      ];
      for (const re of patterns) {
        for (const x of body.matchAll(re)) {
          const at = open + x.index!;
          const text = x[0].includes(`"${key}"`) || x[0].includes(`'${key}'`)
            ? x[0].replace(new RegExp(`(["'])${esc(key)}\\1`), (_q, q: string) => `${q}$${key}${q}`)
            : x[0].replace(new RegExp(`\\.${esc(key)}$`), `.$${key}`);
          edits.push({ start: at, end: at + x[0].length, text });
        }
      }
    }
  }
  if (edits.length === 0) continue;
  const unique = [...new Map(edits.map(e => [e.start, e])).values()].sort((a, b) => b.start - a.start);
  for (const e of unique) s = s.slice(0, e.start) + e.text + s.slice(e.end);
  writeFileSync(file, s);
  total += unique.length;
  console.log(`${file}: ${unique.length}`);
}
console.log(`${total} reads rewritten.`);
