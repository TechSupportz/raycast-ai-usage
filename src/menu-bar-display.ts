import type { UsageWindow } from "./providers/types";

/** Resolve the Raycast preference by ID, email, or display name; empty or missing choices use the first account. */
export function pickMenuBarAccount<T extends { id: string; label?: string; email?: string | null }>(
  accounts: readonly T[],
  selection: string | null,
): T | null {
  const value = selection?.trim().toLowerCase();
  if (!value) return accounts[0] ?? null;
  return (
    accounts.find((account) => account.id.toLowerCase() === value) ??
    accounts.find((account) => account.email?.toLowerCase() === value) ??
    accounts.find((account) => account.label?.toLowerCase() === value) ??
    accounts[0] ??
    null
  );
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
