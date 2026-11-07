import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMenuBarTitle,
  formatTimeUntil,
  formatUpdatedAt,
  getLatestFetchedAt,
  pickMenuBarAccount,
} from "./menu-bar-display.ts";
import type { UsageWindow } from "./providers/types.ts";

const accounts = [{ id: "codex:a" }, { id: "claude-code" }];
const now = Date.UTC(2026, 0, 1);
const session: UsageWindow = {
  id: "five_hour",
  label: "Session Limit",
  usedPercent: 42,
  resetsAt: now + (2 * 60 + 3) * 60 * 1000,
};

test("shows the favourite account when it is configured", () => {
  assert.equal(pickMenuBarAccount(accounts, "claude-code"), accounts[1]);
});

test("falls back to the first account without a favourite", () => {
  assert.equal(pickMenuBarAccount(accounts, null), accounts[0]);
});

test("falls back to the first account when the favourite is gone", () => {
  assert.equal(pickMenuBarAccount(accounts, "codex:removed"), accounts[0]);
});

test("returns null when no accounts are configured", () => {
  assert.equal(pickMenuBarAccount([], "claude-code"), null);
});

test("shows usage left by default", () => {
  assert.equal(formatMenuBarTitle(session, { showUsageUsed: false, showResetTime: false, now }), "58%");
});

test("shows usage used when preferred", () => {
  assert.equal(formatMenuBarTitle(session, { showUsageUsed: true, showResetTime: false, now }), "42%");
});

test("appends the reset time when asked", () => {
  assert.equal(formatMenuBarTitle(session, { showUsageUsed: false, showResetTime: true, now }), "58% · 2h 3m");
});

test("omits the reset time when the provider gives none", () => {
  assert.equal(
    formatMenuBarTitle({ ...session, resetsAt: null }, { showUsageUsed: false, showResetTime: true, now }),
    "58%",
  );
});

test("formats multi-day resets as days and hours", () => {
  assert.equal(formatTimeUntil(now + (3 * 1440 + 5 * 60) * 60 * 1000, now), "3d 5h");
});

test("describes a fetch under a minute old as just now", () => {
  assert.equal(formatUpdatedAt(now - 59_000, now), "Just now");
});

test("describes older fetches in minutes, then hours", () => {
  assert.equal(formatUpdatedAt(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatUpdatedAt(now - 3 * 3_600_000, now), "3h ago");
});

test("uses the newest fetch across accounts", () => {
  assert.equal(getLatestFetchedAt([{ fetchedAt: 10 }, { fetchedAt: null }, { fetchedAt: 30 }, { fetchedAt: 20 }]), 30);
});

test("has no fetch time before any account answers", () => {
  assert.equal(getLatestFetchedAt([{ fetchedAt: null }]), null);
});
