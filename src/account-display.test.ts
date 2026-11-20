import assert from "node:assert/strict";
import test from "node:test";
import { formatProductPlan, getGlanceWindow, getVisibleWindows } from "./account-display.ts";
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
  assert.equal(getGlanceWindow("codex", []), null);
});

test("prefers Gemini 5h, then any 5h, then Gemini Weekly for Antigravity's glance window", () => {
  const gemini5h: UsageWindow = {
    id: "antigravity:summary:5h:gemini-5h",
    label: "Gemini 5h",
    usedPercent: 30,
    resetsAt: null,
  };
  const geminiWeekly: UsageWindow = {
    id: "antigravity:summary:weekly:gemini-weekly",
    label: "Gemini Weekly",
    usedPercent: 80,
    resetsAt: null,
  };
  const claude5h: UsageWindow = {
    id: "antigravity:summary:5h:3p-5h",
    label: "Claude/GPT 5h",
    usedPercent: 50,
    resetsAt: null,
  };
  const geminiPool: UsageWindow = {
    id: "antigravity:pool:gemini",
    label: "Gemini",
    usedPercent: 20,
    resetsAt: null,
  };
  const claudePool: UsageWindow = {
    id: "antigravity:pool:claude-gpt",
    label: "Claude/GPT",
    usedPercent: 75,
    resetsAt: null,
  };

  assert.equal(getGlanceWindow("antigravity", [claude5h, geminiWeekly, gemini5h]), gemini5h);
  assert.equal(getGlanceWindow("antigravity", [geminiWeekly, claude5h]), claude5h);
  assert.equal(getGlanceWindow("antigravity", [geminiWeekly]), geminiWeekly);
  assert.equal(getGlanceWindow("antigravity", [claudePool, geminiPool]), geminiPool);
});

test("hides Antigravity Claude/GPT windows when showAntigravityClaudeGpt is false", () => {
  const windows: UsageWindow[] = [
    { id: "antigravity:summary:5h:gemini-5h", label: "Gemini 5h", usedPercent: 20, resetsAt: null },
    { id: "antigravity:summary:weekly:gemini-weekly", label: "Gemini Weekly", usedPercent: 40, resetsAt: null },
    { id: "antigravity:summary:5h:3p-5h", label: "Claude/GPT 5h", usedPercent: 0, resetsAt: null },
    { id: "antigravity:summary:weekly:3p-weekly", label: "Claude/GPT Weekly", usedPercent: 0, resetsAt: null },
    { id: "antigravity:pool:claude-gpt", label: "Claude/GPT", usedPercent: 0, resetsAt: null },
  ];

  assert.deepEqual(
    getVisibleWindows("antigravity", windows, { showAntigravityClaudeGpt: false }).map((window) => window.id),
    ["antigravity:summary:5h:gemini-5h", "antigravity:summary:weekly:gemini-weekly"],
  );
  assert.equal(getVisibleWindows("antigravity", windows, { showAntigravityClaudeGpt: true }).length, 5);
  assert.equal(getVisibleWindows("claude", windows, { showAntigravityClaudeGpt: false }).length, 5);
});

test("formats product and plan labels cleanly across providers", () => {
  assert.equal(formatProductPlan("codex", "plus"), "ChatGPT Plus");
  assert.equal(formatProductPlan("claude", "max"), "Claude Max");
  assert.equal(formatProductPlan("antigravity", null), "Antigravity");
  assert.equal(formatProductPlan("antigravity", "pro"), "Antigravity Pro");
  assert.equal(formatProductPlan("antigravity", "Google AI Ultra"), "Google AI Ultra");
  assert.equal(formatProductPlan("antigravity", "Antigravity Pro"), "Antigravity Pro");
});
