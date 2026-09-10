import assert from "node:assert/strict";
import test from "node:test";
import { getGlanceWindow } from "./account-display.ts";
import type { UsageWindow } from "./providers/types.ts";

const fiveHour: UsageWindow = {
  id: "18000",
  label: "5h Limit",
  usedPercent: 25,
  resetsAt: null,
};
const weekly: UsageWindow = {
  id: "604800",
  label: "Weekly Limit",
  usedPercent: 80,
  resetsAt: null,
};

test("uses Codex's five-hour window for the glance progress bar", () => {
  assert.equal(getGlanceWindow("codex", [fiveHour, weekly]), fiveHour);
});

test("recognises a five-hour Codex window by label for cached responses", () => {
  const cached = { ...fiveHour, id: "primary" };

  assert.equal(getGlanceWindow("codex", [cached, weekly]), cached);
});

test("uses Codex's weekly window when there is no five-hour limit", () => {
  const other = { ...fiveHour, id: "other", label: "Other Limit", usedPercent: 95 };

  assert.equal(getGlanceWindow("codex", [other, weekly]), weekly);
});

test("falls back to the tightest window when neither known Codex window exists", () => {
  assert.equal(getGlanceWindow("codex", [{ ...weekly, id: "other", label: "Other Limit" }])?.id, "other");
  assert.equal(getGlanceWindow("claude", [fiveHour, weekly]), weekly);
  assert.equal(getGlanceWindow("codex", []), null);
});
