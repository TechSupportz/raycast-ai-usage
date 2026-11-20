import assert from "node:assert/strict";
import test from "node:test";
import { getPace, getWindowDurationMs } from "./pace.ts";
import type { UsageWindow } from "./providers/types.ts";

const HOUR = 60 * 60 * 1000;
const now = 1_800_000_000_000;

function window(overrides: Partial<UsageWindow>): UsageWindow {
  return { id: "300", label: "5h Limit", usedPercent: 0, resetsAt: now + 2.5 * HOUR, ...overrides };
}

test("reads window lengths from Codex minutes, Claude names, and Antigravity summary IDs", () => {
  assert.equal(getWindowDurationMs(window({ id: "300" })), 5 * HOUR);
  assert.equal(getWindowDurationMs(window({ id: "10080", label: "Weekly Limit" })), 7 * 24 * HOUR);
  assert.equal(getWindowDurationMs(window({ id: "five_hour", label: "Session Limit" })), 5 * HOUR);
  assert.equal(getWindowDurationMs(window({ id: "seven_day", label: "Weekly Limit" })), 7 * 24 * HOUR);
  assert.equal(getWindowDurationMs(window({ id: "antigravity:summary:5h:gemini-5h", label: "Gemini 5h" })), 5 * HOUR);
  assert.equal(
    getWindowDurationMs(window({ id: "antigravity:summary:weekly:gemini-weekly", label: "Gemini Weekly" })),
    7 * 24 * HOUR,
  );
  assert.equal(getWindowDurationMs(window({ id: "antigravity:pool:gemini", label: "Gemini" })), null);
  assert.equal(getWindowDurationMs(window({ id: "mystery", label: "Other" })), null);
});

test("halfway through a five-hour window, 50% used is on pace", () => {
  assert.equal(getPace(window({ usedPercent: 52 }), now)?.status, "on");
});

test("using more than an even burn is over pace, less is under", () => {
  assert.deepEqual(getPace(window({ usedPercent: 70 }), now), { status: "over", delta: 20 });
  assert.deepEqual(getPace(window({ usedPercent: 20 }), now), { status: "under", delta: -30 });
});

test("has no pace without a reset time", () => {
  assert.equal(getPace(window({ resetsAt: null }), now), null);
});
