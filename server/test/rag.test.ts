import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";

// The recipes in fixtures/rag, run against a local server that answers as
// the Anthropic, OpenAI-compatible and embeddings APIs do.

const resolve = createResolver([...coreNodes(), ...serverNodes({ root: path.join(import.meta.dirname, "fixtures/rag") })]);

interface Recorded { path: string; headers: http.IncomingHttpHeaders; body: any }
type Reply = { json: unknown } | { sse: Array<{ type: string } & Record<string, unknown>> };

const requests: Recorded[] = [];
const replies: Reply[] = [];
let embeddingCalls = 0;

// A word-count embedding over a tiny vocabulary: texts about the same animal
// point the same way, and the small constant keeps every vector nonzero.
const VOCABULARY = ["cat", "dog", "fish", "moon"];
const embed = (text: string) => VOCABULARY.map(word => text.toLowerCase().split(word).length - 1 + 0.01);

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const url = req.url ?? "";
  if (url.endsWith("/embeddings")) {
    embeddingCalls++;
    const data = body.input.map((text: string, index: number) => ({ index, embedding: embed(text) }));
    res.writeHead(200, { "content-type": "application/json" });
    // Out of order, as nothing promises they come back in it.
    res.end(JSON.stringify({ data: data.reverse() }));
    return;
  }
  requests.push({ path: url, headers: req.headers, body });
  const reply = replies.shift();
  if (reply === undefined) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no reply scripted" } }));
  } else if ("json" in reply) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.json));
  } else {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of reply.sse) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (typeof address !== "object" || address === null) throw new Error("The stub server has no port");
const base = `http://127.0.0.1:${address.port}`;

const anthropic = { provider: "anthropic", model: "claude-opus-5-5", apiKey: "test-key", baseUrl: `${base}/anthropic` };
const openai = { provider: "openai", model: "gpt-test", apiKey: "test-key", baseUrl: `${base}/openai/v1` };
const embedding = { model: "embed-test", baseUrl: `${base}/openai/v1` };

const addTool = {
  name: "add",
  description: "Adds two numbers.",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  do: { $add: [{ $var: "a" }, { $var: "b" }] },
};

async function run(file: string, vars: Record<string, unknown>): Promise<any> {
  return resolve({ $file: file }, vars);
}

/** An Anthropic message reply. */
function message(content: unknown[], stopReason: string): Reply {
  return { json: { id: "msg", type: "message", role: "assistant", content, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } } };
}

/** The same reply as a stream, its blocks sent in pieces. */
function streamed(blocks: Array<{ start: Record<string, unknown>; deltas: Array<Record<string, unknown>> }>, stopReason: string): Reply {
  return {
    sse: [
      { type: "message_start", message: { id: "msg", usage: { input_tokens: 10, output_tokens: 1 } } },
      ...blocks.flatMap(({ start, deltas }, index) => [
        { type: "content_block_start", index, content_block: start },
        ...deltas.map(delta => ({ type: "content_block_delta", index, delta })),
        { type: "content_block_stop", index },
      ]),
      { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ],
  };
}

beforeEach(() => {
  requests.length = 0;
  replies.length = 0;
  embeddingCalls = 0;
});

after(async () => {
  resolve.destroy();
  await new Promise(done => server.close(done));
});

test("agent: an Anthropic model calls a tool, and its thinking goes back unchanged", async () => {
  const firstTurn = [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Let me add those." },
    { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
  ];
  replies.push(message(firstTurn, "tool_use"), message([{ type: "text", text: "2 + 3 is 5." }], "end_turn"));

  const out = await run("/agent.json", { ...anthropic, system: "You add numbers.", messages: [{ role: "user", content: "What is 2 + 3?" }], tools: [addTool] });

  assert.equal(out.text, "2 + 3 is 5.");
  assert.equal(out.reason, "end_turn");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, "/anthropic/v1/messages");
  assert.equal(requests[0].headers["x-api-key"], "test-key");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(requests[0].body, {
    model: "claude-opus-5-5",
    max_tokens: 16000,
    system: "You add numbers.",
    messages: [{ role: "user", content: "What is 2 + 3?" }],
    tools: [{ name: "add", description: "Adds two numbers.", input_schema: addTool.inputSchema }],
  });
  const history = [
    { role: "user", content: "What is 2 + 3?" },
    { role: "assistant", content: firstTurn },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }] },
  ];
  assert.deepEqual(requests[1].body.messages, history);
  assert.deepEqual(JSON.parse(JSON.stringify(out.messages)), [...history, { role: "assistant", content: [{ type: "text", text: "2 + 3 is 5." }] }]);
});

test("agent: an OpenAI-compatible model calls a tool", async () => {
  const toolCall = { id: "call_1", type: "function", function: { name: "add", arguments: "{\"a\":2,\"b\":3}" } };
  replies.push(
    { json: { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }] } },
    { json: { choices: [{ message: { role: "assistant", content: "It is 5." }, finish_reason: "stop" }] } },
  );

  const out = await run("/agent.json", { ...openai, system: "You add numbers.", messages: [{ role: "user", content: "What is 2 + 3?" }], tools: [addTool] });

  assert.equal(out.text, "It is 5.");
  assert.equal(requests[0].path, "/openai/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.deepEqual(requests[0].body.tools, [{ type: "function", function: { name: "add", description: "Adds two numbers.", parameters: addTool.inputSchema } }]);
  assert.deepEqual(requests[1].body.messages, [
    { role: "system", content: "You add numbers." },
    { role: "user", content: "What is 2 + 3?" },
    { role: "assistant", content: null, tool_calls: [toolCall] },
    { role: "tool", tool_call_id: "call_1", content: "5" },
  ]);
  assert.equal(out.messages.length, 4, "the system prompt stays out of the history");
});

test("agent: a tool that is unknown, gets bad input, throws or runs an op it may not is an error result", async () => {
  const tools = [
    addTool,
    { name: "fail", description: "Fails.", do: { $error: 503, message: "the service is down" } },
    { name: "shout", description: "Shouts.", allow: ["var"], do: { $upper: { $var: "text" } } },
  ];
  replies.push(
    message([
      { type: "tool_use", id: "t1", name: "missing", input: {} },
      { type: "tool_use", id: "t2", name: "add", input: { a: "two", b: 3 } },
      { type: "tool_use", id: "t3", name: "fail", input: {} },
      { type: "tool_use", id: "t4", name: "shout", input: { text: "hi" } },
      { type: "tool_use", id: "t5", name: "add", input: { a: 1, b: 1 } },
    ], "tool_use"),
    message([{ type: "text", text: "Done." }], "end_turn"),
  );

  await run("/agent.json", { ...anthropic, messages: [{ role: "user", content: "Go." }], tools });

  const results = requests[1].body.messages[2].content;
  assert.deepEqual(results.map((r: { tool_use_id: string; is_error?: boolean }) => [r.tool_use_id, r.is_error ?? false]), [
    ["t1", true], ["t2", true], ["t3", true], ["t4", true], ["t5", false],
  ]);
  assert.equal(results[0].content, "Unknown tool: missing");
  assert.match(results[1].content, /^Invalid input: a must be number/);
  assert.equal(results[2].content, "Error: the service is down");
  assert.match(results[3].content, /^Error: "\$upper" is not allowed here/);
  assert.equal(results[4].content, "2");
});

test("agent: a model that keeps calling tools stops at maxRounds", async () => {
  for (let i = 0; i < 3; i++) replies.push(message([{ type: "tool_use", id: `t${i}`, name: "add", input: { a: 1, b: i } }], "tool_use"));
  await assert.rejects(run("/agent.json", { ...anthropic, messages: [{ role: "user", content: "Loop." }], tools: [addTool], maxRounds: 2 }),
    /\$while ran its 2 rounds and its condition still holds/);
  assert.equal(requests.length, 2);
});

test("agent: an unknown provider fails before any request", async () => {
  await assert.rejects(run("/agent.json", { ...anthropic, provider: "nope", messages: [] }), /Unknown provider: nope/);
  assert.equal(requests.length, 0);
});

test("agent: an Anthropic stream builds the same turn, forwarding text as it arrives", async () => {
  replies.push(
    streamed([
      { start: { type: "thinking", thinking: "", signature: "" }, deltas: [{ type: "thinking_delta", thinking: "Adding." }, { type: "signature_delta", signature: "sig-1" }] },
      { start: { type: "text", text: "" }, deltas: [{ type: "text_delta", text: "Let me " }, { type: "text_delta", text: "add." }] },
      { start: { type: "tool_use", id: "toolu_1", name: "add", input: {} }, deltas: [{ type: "input_json_delta", partial_json: "{\"a\": 2," }, { type: "input_json_delta", partial_json: " \"b\": 3}" }] },
    ], "tool_use"),
    streamed([{ start: { type: "text", text: "" }, deltas: [{ type: "text_delta", text: "5." }] }], "end_turn"),
  );
  const deltas: string[] = [];

  const out = await run("/agent.json", {
    ...anthropic,
    stream: true,
    onText: { $push: [{ $var: "deltas" }, { $var: "text" }] },
    deltas,
    messages: [{ role: "user", content: "What is 2 + 3?" }],
    tools: [addTool],
  });

  assert.equal(out.text, "5.");
  assert.deepEqual(deltas, ["Let me ", "add.", "5."]);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 64000);
  assert.equal(requests[0].body.tools[0].eager_input_streaming, true);
  assert.deepEqual(requests[1].body.messages.slice(1), [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Adding.", signature: "sig-1" },
        { type: "text", text: "Let me add." },
        { type: "tool_use", id: "toolu_1", name: "add", input: { a: 2, b: 3 } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "5" }] },
  ]);
});

test("agent: a streamed tool input cut short is an error result, not a call", async () => {
  replies.push(
    streamed([{ start: { type: "tool_use", id: "toolu_1", name: "add", input: {} }, deltas: [{ type: "input_json_delta", partial_json: "{\"a\": 2, \"b\"" }] }], "tool_use"),
    streamed([{ start: { type: "text", text: "" }, deltas: [{ type: "text_delta", text: "Sorry." }] }], "end_turn"),
  );

  await run("/agent.json", { ...anthropic, stream: true, messages: [{ role: "user", content: "Add." }], tools: [addTool] });

  assert.deepEqual(requests[1].body.messages[1].content, [{ type: "tool_use", id: "toolu_1", name: "add", input: {} }]);
  assert.deepEqual(requests[1].body.messages[2].content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "Invalid input: it is not a JSON object", is_error: true },
  ]);
});

test("agent: an error event in a stream fails the turn with the API's message", async () => {
  replies.push({
    sse: [
      { type: "message_start", message: { id: "msg", usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ],
  });
  await assert.rejects(run("/agent.json", { ...anthropic, stream: true, messages: [{ role: "user", content: "Hi." }] }), /Overloaded/);
});

const docs = [
  "The cat sleeps all day. A cat purrs when it is happy. The cat eats fish.",
  "A dog barks at night. The dog fetches sticks. Every dog needs a walk.",
  "The moon rises late. The moon is full tonight.",
];

test("ingest: text splits into capped chunks that overlap by a sentence, embedded in batches", async () => {
  const records = await run("/ingest.json", { text: docs[0], chunkSize: 60, meta: { source: "cats" }, embedding: { ...embedding, batchSize: 2 } });

  assert.deepEqual(records.map((r: { text: string }) => r.text), [
    "The cat sleeps all day. A cat purrs when it is happy.",
    "A cat purrs when it is happy. The cat eats fish.",
  ], "each chunk after the first starts with the last sentence of the one before");
  assert.equal(embeddingCalls, 1);
  for (const record of records) {
    assert.deepEqual(record.meta, { source: "cats" });
    assert.ok(Math.abs(Math.hypot(...record.embedding) - 1) < 1e-9, "embeddings are normalized");
  }

  const many = await run("/ingest.json", { text: docs.join(" "), chunkSize: 30, embedding: { ...embedding, batchSize: 2 } });
  assert.equal(embeddingCalls, 1 + Math.ceil(many.length / 2));
  assert.equal(many.length, many.filter((r: { embedding: number[] }) => r.embedding.length === VOCABULARY.length).length);
});

async function ingestAll(texts: string[]): Promise<unknown[]> {
  const records: unknown[] = [];
  for (const [i, text] of texts.entries()) {
    records.push(...await run("/ingest.json", { text, meta: { doc: i, tenant: i === 2 ? "b" : "a" }, embedding }));
  }
  return records;
}

test("retrieve: the k records nearest the query, best first, filtered by meta", async () => {
  const records = await ingestAll(docs);

  const top = await run("/retrieve.json", { query: "Where is the moon?", records, k: 2, embedding });
  assert.equal(top.length, 2);
  assert.deepEqual(top[0].meta, { doc: 2, tenant: "b" });
  assert.ok(top[0].score > top[1].score);

  const own = await run("/retrieve.json", { query: "Where is the moon?", records, k: 2, where: { tenant: "a" }, embedding });
  assert.ok(own.every((r: { meta: { tenant: string } }) => r.meta.tenant === "a"), "another tenant's chunks are never scored");
});

test("retrieve: a record embedded by another model fails rather than scoring", async () => {
  const records = [{ text: "old", embedding: [1, 0, 0], meta: {} }];
  await assert.rejects(run("/retrieve.json", { query: "cat", records, embedding }), /Expected a vector of 4 numbers, got one of 3/);
});

test("rag: retrieved passages ground the answer, and the model can search for more", async () => {
  const records = await ingestAll(docs);
  replies.push(
    message([{ type: "tool_use", id: "toolu_1", name: "search", input: { query: "dog" } }], "tool_use"),
    message([{ type: "text", text: "The cat eats fish, and the dog fetches sticks." }], "end_turn"),
  );

  const out = await run("/rag.json", { ...anthropic, question: "What does the cat eat?", records, k: 1, embedding });

  assert.equal(out.text, "The cat eats fish, and the dog fetches sticks.");
  assert.match(requests[0].body.system, /<passage>\n[^<]*cat eats fish[^<]*\n<\/passage>/);
  assert.deepEqual(requests[0].body.tools.map((t: { name: string }) => t.name), ["search"]);
  const [result] = requests[1].body.messages[2].content;
  assert.equal(result.tool_use_id, "toolu_1");
  assert.match(result.content, /dog/);
});

// sqlite-vec is an optional peer: this test skips when it isn't installed.
const vecPackage = "sqlite-vec";
const skipVec = await import(vecPackage).then(() => false, () => "sqlite-vec is not installed");

test("sqlite-vec: records stored in a vec0 table come back nearest first", { skip: skipVec }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-rag-"));
  try {
    await resolve({ $database: "connect", connection: "rag", filename: path.join(dir, "rag.db"), extensions: ["sqlite-vec"] }, {});
    const records = await ingestAll(docs);
    assert.equal(await run("/sqlite-store.json", { connection: "rag", table: "chunks", records }), records.length);

    const top = await run("/sqlite-retrieve.json", { connection: "rag", table: "chunks", query: "Where is the moon?", k: 2, embedding });
    assert.equal(top.length, 2);
    assert.deepEqual(top[0].meta, { doc: 2, tenant: "b" });
    assert.ok(top[0].score > top[1].score);
  } finally {
    await resolve({ $database: "close", connection: "rag" }, {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
