import type { ProviderId, UsageWindow } from "./providers/types";

/**
 * Picks the one usage window shown beside an account in the compact list.
 * Codex's five-hour window is the most useful at-a-glance signal. Pro accounts
 * may only expose a weekly window, so that is the explicit second choice.
 * Other providers, and unusual Codex responses with neither known window, keep
 * the previous behaviour of showing whichever limit is most constrained.
 */
export function getGlanceWindow(provider: ProviderId, windows: UsageWindow[]): UsageWindow | null {
  if (provider === "codex") {
    const fiveHour = windows.find((window) => window.id === "18000" || window.label === "5h Limit");

    if (fiveHour) {
      return fiveHour;
    }

    const weekly = windows.find((window) => window.id === "604800" || window.label === "Weekly Limit");

    if (weekly) {
      return weekly;
    }
  }

  return windows.reduce<UsageWindow | null>(
    (tightest, window) => (tightest === null || getRemaining(window) < getRemaining(tightest) ? window : tightest),
    null,
  );
}

function getRemaining(window: UsageWindow): number {
  return 100 - window.usedPercent;
}
