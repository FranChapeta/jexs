import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

// A fixed reference instant used across the extraction / boundary tests.
// 2026-07-01T12:30:45.123Z is a Wednesday (getUTCDay() === 3).
const TS = Date.UTC(2026, 6, 1, 12, 30, 45, 123);

// ── dateParse — the inverse of dateFormat ──

test("dateParse: ISO string to Unix ms", () => {
  assert.equal(resolve({ dateParse: "2026-07-01T12:00:00Z" }, {}), Date.UTC(2026, 6, 1, 12));
});

test("dateParse: a number passes through unchanged", () => {
  assert.equal(resolve({ dateParse: 12345 }, {}), 12345);
});

test("dateParse: unparseable input is null", () => {
  assert.equal(resolve({ dateParse: "not a date" }, {}), null);
});

test("dateParse round-trips dateFormat(iso)", () => {
  const iso = resolve({ dateFormat: TS, format: "iso" }, {});
  assert.equal(resolve({ dateParse: iso }, {}), TS);
});

// ── dateDiff — fixed-length units, truncated toward zero, signed ──

test("dateDiff: whole units between two timestamps", () => {
  const from = Date.UTC(2026, 6, 1);
  const to = Date.UTC(2026, 6, 8);
  assert.equal(resolve({ dateDiff: [from, to], unit: "day" }, {}), 7);
  assert.equal(resolve({ dateDiff: [from, to], unit: "week" }, {}), 1);
  assert.equal(resolve({ dateDiff: [from, to], unit: "hour" }, {}), 168);
});

test("dateDiff: default unit is milliseconds", () => {
  assert.equal(resolve({ dateDiff: [0, 5000] }, {}), 5000);
});

test("dateDiff: negative when `to` precedes `from`, truncated toward zero", () => {
  assert.equal(resolve({ dateDiff: [Date.UTC(2026, 6, 8), Date.UTC(2026, 6, 1)], unit: "day" }, {}), -7);
  // 1.04 days -> truncates to 1
  assert.equal(resolve({ dateDiff: [0, 90_000_000], unit: "day" }, {}), 1);
});

test("dateDiff: fewer than two args or unknown unit is null", () => {
  assert.equal(resolve({ dateDiff: [123] }, {}), null);
  assert.equal(resolve({ dateDiff: [0, 1000], unit: "month" }, {}), null);
});

// ── datePart — UTC component extraction ──

test("datePart: extracts each component in UTC", () => {
  assert.equal(resolve({ datePart: TS, part: "year" }, {}), 2026);
  assert.equal(resolve({ datePart: TS, part: "month" }, {}), 7); // 1-12
  assert.equal(resolve({ datePart: TS, part: "day" }, {}), 1);
  assert.equal(resolve({ datePart: TS, part: "hour" }, {}), 12);
  assert.equal(resolve({ datePart: TS, part: "minute" }, {}), 30);
  assert.equal(resolve({ datePart: TS, part: "second" }, {}), 45);
  assert.equal(resolve({ datePart: TS, part: "ms" }, {}), 123);
  assert.equal(resolve({ datePart: TS, part: "weekday" }, {}), 3); // Wednesday
});

test("datePart: missing or unknown part is null", () => {
  assert.equal(resolve({ datePart: TS }, {}), null);
  assert.equal(resolve({ datePart: TS, part: "fortnight" }, {}), null);
});

// ── dateStartOf / dateEndOf — UTC boundaries, week starts Monday ──

test("dateStartOf: snaps down to the unit boundary", () => {
  assert.equal(resolve({ dateStartOf: TS, unit: "day" }, {}), Date.UTC(2026, 6, 1));
  assert.equal(resolve({ dateStartOf: TS, unit: "month" }, {}), Date.UTC(2026, 6, 1));
  assert.equal(resolve({ dateStartOf: TS, unit: "year" }, {}), Date.UTC(2026, 0, 1));
  assert.equal(resolve({ dateStartOf: TS, unit: "hour" }, {}), Date.UTC(2026, 6, 1, 12));
  assert.equal(resolve({ dateStartOf: TS, unit: "minute" }, {}), Date.UTC(2026, 6, 1, 12, 30));
});

test("dateStartOf: default unit is day", () => {
  assert.equal(resolve({ dateStartOf: TS }, {}), Date.UTC(2026, 6, 1));
});

test("dateStartOf: week snaps back to Monday", () => {
  // 2026-07-01 is a Wednesday; its ISO week starts Monday 2026-06-29.
  assert.equal(resolve({ dateStartOf: TS, unit: "week" }, {}), Date.UTC(2026, 5, 29));
});

test("dateEndOf: snaps up to the last millisecond of the unit", () => {
  assert.equal(resolve({ dateEndOf: TS, unit: "day" }, {}), Date.UTC(2026, 6, 2) - 1);
  assert.equal(resolve({ dateEndOf: TS, unit: "month" }, {}), Date.UTC(2026, 7, 1) - 1);
  assert.equal(resolve({ dateEndOf: TS, unit: "year" }, {}), Date.UTC(2027, 0, 1) - 1);
  assert.equal(resolve({ dateEndOf: TS, unit: "week" }, {}), Date.UTC(2026, 6, 6) - 1);
});

test("dateStartOf: honors the format sibling like dateAdd", () => {
  assert.equal(
    resolve({ dateStartOf: TS, unit: "day", format: "iso" }, {}),
    "2026-07-01T00:00:00.000Z",
  );
});

// ── nested-expression inputs resolve like the rest of the family ──

test("date ops resolve nested-expression arguments", () => {
  const ctx = { ts: TS };
  assert.equal(resolve({ datePart: { var: "$ts" }, part: "year" }, ctx), 2026);
  assert.equal(
    resolve({ dateDiff: [{ var: "$ts" }, { dateAdd: [{ var: "$ts" }, "2d"] }], unit: "day" }, ctx),
    2,
  );
});

// ── dateRelative — Intl relative-time, pinned to a fixed `base` for determinism ──

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN = 60_000;

test("dateRelative: past reads 'ago', future reads 'in'", () => {
  assert.equal(resolve({ dateRelative: [TS - 3 * HOUR, TS], locale: "en-US" }, {}), "3 hours ago");
  assert.equal(resolve({ dateRelative: [TS + 5 * MIN, TS], locale: "en-US" }, {}), "in 5 minutes");
});

test("dateRelative: auto-selects the largest fitting unit", () => {
  assert.equal(resolve({ dateRelative: [TS - 45 * MIN, TS], locale: "en-US" }, {}), "45 minutes ago");
  assert.equal(resolve({ dateRelative: [TS - 2 * DAY, TS], locale: "en-US" }, {}), "2 days ago");
  // 400 days clears the 365-day year threshold -> "1 year ago".
  assert.equal(resolve({ dateRelative: [TS - 400 * DAY, TS], locale: "en-US" }, {}), "1 year ago");
});

test("dateRelative: unit forces the display unit", () => {
  assert.equal(resolve({ dateRelative: [TS - 2 * DAY, TS], unit: "hour", locale: "en-US" }, {}), "48 hours ago");
});

test("dateRelative: numeric 'auto' uses named terms", () => {
  assert.equal(resolve({ dateRelative: [TS - 1 * DAY, TS], numeric: "auto", locale: "en-US" }, {}), "yesterday");
});

test("dateRelative: base defaults to now when the tuple omits it", () => {
  const out = resolve({ dateRelative: [Date.now() - 3 * HOUR], locale: "en-US" }, {});
  assert.match(String(out), /hours? ago/);
});
