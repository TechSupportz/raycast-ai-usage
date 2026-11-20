import type { UsageWindow } from "./providers/types";

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Within this many percentage points of an even burn counts as on pace. */
const ON_PACE_TOLERANCE = 5;

export type Pace = {
  status: "under" | "on" | "over";
  /** Percentage points used beyond (positive) or short of (negative) an even burn. */
  delta: number;
};

/**
 * How long a window lasts from start to reset. Providers identify windows
 * differently: ChatGPT by length in minutes, Claude by name.
 */
export function getWindowDurationMs(window: UsageWindow): number | null {
  switch (window.id) {
    case "five_hour":
    case "session":
      return FIVE_HOURS_MS;
    case "seven_day":
    case "weekly_all":
      return WEEK_MS;
  }

  if (window.id.startsWith("antigravity:summary:5h:")) {
    return FIVE_HOURS_MS;
  }

  if (window.id.startsWith("antigravity:summary:weekly:")) {
    return WEEK_MS;
  }

  const minutes = Number(window.id);

  if (Number.isFinite(minutes) && minutes > 0) {
    return minutes * 60 * 1000;
  }

  if (window.label === "5h Limit" || window.label === "Session Limit") {
    return FIVE_HOURS_MS;
  }

  return window.label === "Weekly Limit" ? WEEK_MS : null;
}

/**
 * Compares what has been used against an even burn across the window: halfway
 * to the reset, 50% used is on pace. Null when the window has no reset time or
 * an unknown length, since there is nothing to measure against.
 */
export function getPace(window: UsageWindow, now = Date.now()): Pace | null {
  const durationMs = getWindowDurationMs(window);

  if (window.resetsAt === null || durationMs === null) {
    return null;
  }

  const remainingMs = Math.min(durationMs, Math.max(0, window.resetsAt - now));
  const expected = ((durationMs - remainingMs) / durationMs) * 100;
  const delta = window.usedPercent - expected;

  if (Math.abs(delta) <= ON_PACE_TOLERANCE) {
    return { status: "on", delta };
  }

  return { status: delta > 0 ? "over" : "under", delta };
}
