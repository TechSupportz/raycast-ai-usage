import type { UsageWindow } from "./providers/types";

/**
 * The account shown in the menu bar: the favourite when it is still
 * configured, otherwise the first account in the user's order. Falling back
 * keeps the menu bar useful after a favourite is signed out or turned off.
 */
export function pickMenuBarAccount<T extends { id: string }>(
  accounts: readonly T[],
  favouriteId: string | null,
): T | null {
  return accounts.find((account) => account.id === favouriteId) ?? accounts[0] ?? null;
}

/**
 * The menu bar title for one window, e.g. "58%" or "58% · 2h 3m". The reset
 * time is optional because menu bar space is tight.
 */
export function formatMenuBarTitle(
  window: UsageWindow,
  { showUsageUsed, showResetTime, now = Date.now() }: { showUsageUsed: boolean; showResetTime: boolean; now?: number },
): string {
  const percent = `${formatPercent(getDisplayedPercent(window, showUsageUsed))}%`;

  if (!showResetTime || window.resetsAt === null) {
    return percent;
  }

  return `${percent} · ${formatTimeUntil(window.resetsAt, now)}`;
}

/** Percentage shown for a window in the chosen display mode, clamped to 0-100. */
export function getDisplayedPercent(window: UsageWindow, showUsageUsed: boolean): number {
  return showUsageUsed ? clampPercent(window.usedPercent) : getRemaining(window);
}

export function getRemaining(window: UsageWindow): number {
  return clampPercent(100 - window.usedPercent);
}

export function formatTimeUntil(timestampMs: number, now = Date.now()): string {
  const totalMinutes = Math.max(0, Math.round((timestampMs - now) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatResetDate(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

/** How long ago we last heard from the provider; cached values can be minutes old. */
export function formatUpdatedAt(timestampMs: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestampMs) / 60000);

  if (minutes < 1) {
    return "Just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h ago` : formatResetDate(timestampMs);
}

/**
 * The newest fetch across accounts, for the menu's "Updated" line. Accounts
 * whose refresh failed are flagged in their own section, so one stuck account
 * does not make every other account look out of date.
 */
export function getLatestFetchedAt(states: readonly { fetchedAt: number | null }[]): number | null {
  return states.reduce<number | null>(
    (latest, { fetchedAt }) => (fetchedAt !== null && (latest === null || fetchedAt > latest) ? fetchedAt : latest),
    null,
  );
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}`;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
