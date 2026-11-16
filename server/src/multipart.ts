import { MIMEType } from "node:util";
import { createHttpError } from "@jexs/core";

/** The most one part's headers may come to. */
const MAX_HEADER_BYTES = 16 * 1024;

/** One part of a multipart body: its headers, and its bytes, read from the body only as they are asked for. */
export interface MultipartPart {
  headers: Headers;
  body: AsyncGenerator<Buffer>;
}

/** The boundary of a multipart Content-Type (`multipart/form-data; boundary=...`), or undefined for any other. */
export function multipartBoundary(contentType: string): string | undefined {
  try {
    const type = new MIMEType(contentType);
    return type.type === "multipart" ? type.params.get("boundary") ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The parts of a multipart body (RFC 2046) as `source` gives its bytes: a
 * form, a `multipart/mixed` response, any other. Each part is read only as it
 * is asked for, and asking for the next discards what is left of the one
 * before. A body that ends before its closing boundary, or a part whose
 * headers pass 16 KiB, fails with a 400.
 */
export async function* readMultipart(source: AsyncIterable<Uint8Array>, boundary: string): AsyncGenerator<MultipartPart> {
  const chunks = source[Symbol.asyncIterator]();
  // A boundary is the line break before it too, so the bytes start with one for the first.
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let held: Buffer = Buffer.from("\r\n");
  const more = async (): Promise<void> => {
    const { done, value } = await chunks.next();
    if (done) throw malformed("it ends before its closing boundary");
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    held = held.length === 0 ? bytes : Buffer.concat([held, bytes]);
  };

  // The part being read, counted so that a part's body read after the next part began gives nothing.
  let current = 0;
  let open = true;
  async function* body(part: number): AsyncGenerator<Buffer> {
    while (part === current && open) {
      const at = held.indexOf(delimiter);
      // Without the boundary, all but what could be its start, cut off at the end of a chunk.
      const ready = held.subarray(0, at >= 0 ? at : Math.max(0, held.length - delimiter.length + 1));
      held = held.subarray(at >= 0 ? at + delimiter.length : ready.length);
      if (at >= 0) open = false;
      if (ready.length > 0) yield ready;
      if (open) await more();
    }
  }

  try {
    for (;;) {
      // The preamble, or what the part before left unread.
      for (const rest = body(current); !(await rest.next()).done;);
      while (held.length < 2) await more();
      if (held[0] === 0x2d && held[1] === 0x2d) return;
      // The rest of the boundary's line (spaces at most), then the part's headers up to a blank line.
      let end: number;
      while ((end = held.indexOf("\r\n\r\n")) < 0) {
        if (held.length > MAX_HEADER_BYTES) throw malformed("a part's headers are too long");
        await more();
      }
      if (end > MAX_HEADER_BYTES) throw malformed("a part's headers are too long");
      const [padding, ...lines] = held.toString("latin1", 0, end).split("\r\n");
      held = held.subarray(end + 4);
      if (padding.trim() !== "") throw malformed("a boundary is followed by more than a line break");
      const headers = new Headers();
      for (const line of lines) {
        const colon = line.indexOf(":");
        try {
          if (colon <= 0) throw new Error();
          headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
        } catch {
          throw malformed(`a part has a header line that isn't one: ${JSON.stringify(line.slice(0, 80))}`);
        }
      }
      current++;
      open = true;
      yield { headers, body: body(current) };
    }
  } finally {
    await chunks.return?.();
  }
}

/**
 * The parameters of a Content-Disposition header (`form-data; name="doc";
 * filename="a.txt"`), by lowercase name. A `name*` one (RFC 8187,
 * `UTF-8''caf%C3%A9.png`) is taken over the plain one, and a plain one is read
 * as UTF-8, as browsers send it.
 */
export function dispositionParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const [, name, written] of header.matchAll(/;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g)) {
    const key = name.toLowerCase();
    const value = written.startsWith('"') ? written.slice(1, -1).replace(/\\(.)/g, "$1") : written.trim();
    if (key.endsWith("*")) {
      try {
        params.set(key.slice(0, -1), decodeURIComponent(value.replace(/^[^']*'[^']*'/, "")));
      } catch {
        // Malformed escapes: the plain parameter stands.
      }
    } else if (!params.has(key)) {
      params.set(key, Buffer.from(value, "latin1").toString("utf8"));
    }
  }
  return params;
}

function malformed(why: string): Error {
  return createHttpError(400, `Malformed multipart body: ${why}`);
}
