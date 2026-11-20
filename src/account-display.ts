import type { ProviderId, UsageWindow } from "./providers/types";

/**
 * Picks the one usage window shown beside an account in the compact list.
 * Prefer the five-hour window for both providers, falling back to weekly when
 * no five-hour limit is available. Unusual responses with neither known window
 * keep the previous behaviour of showing whichever limit is most constrained.
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

  if (provider === "claude") {
    const fiveHour = windows.find(
      (window) => window.id === "five_hour" || window.id === "session" || window.label === "Session Limit",
    );

    if (fiveHour) {
      return fiveHour;
    }

    const weekly = windows.find(
      (window) => window.id === "seven_day" || window.id === "weekly_all" || window.label === "Weekly Limit",
    );

    if (weekly) {
      return weekly;
    }
  }

  if (provider === "antigravity") {
    const geminiFiveHour = windows.find(
      (window) => window.id.startsWith("antigravity:summary:5h:gemini") || window.label === "Gemini 5h",
    );

    if (geminiFiveHour) {
      return geminiFiveHour;
    }

    const anyFiveHour = windows.find((window) => window.id.startsWith("antigravity:summary:5h:"));

    if (anyFiveHour) {
      return anyFiveHour;
    }

    const geminiWeekly = windows.find(
      (window) => window.id.startsWith("antigravity:summary:weekly:gemini") || window.label === "Gemini Weekly",
    );

    if (geminiWeekly) {
      return geminiWeekly;
    }

    const anyWeekly = windows.find((window) => window.id.startsWith("antigravity:summary:weekly:"));

    if (anyWeekly) {
      return anyWeekly;
    }

    const geminiPool = windows.find((window) => window.id === "antigravity:pool:gemini" || window.label === "Gemini");

    if (geminiPool) {
      return geminiPool;
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

/** Identifies Antigravity's Claude/GPT quota windows so they can be hidden independently of Gemini. */
export function isAntigravityClaudeGptWindow(window: UsageWindow): boolean {
  return (
    window.id === "antigravity:pool:claude-gpt" ||
    window.label === "Claude/GPT" ||
    window.label.startsWith("Claude/GPT ")
  );
}

/** Applies display-level window visibility preferences without invalidating cached provider responses. */
export function getVisibleWindows(
  provider: ProviderId,
  windows: UsageWindow[],
  { showAntigravityClaudeGpt = true }: { showAntigravityClaudeGpt?: boolean } = {},
): UsageWindow[] {
  if (provider !== "antigravity" || showAntigravityClaudeGpt) {
    return windows;
  }

  return windows.filter((window) => !isAntigravityClaudeGptWindow(window));
}

const PRODUCT_NAMES: Record<ProviderId, string> = {
  codex: "ChatGPT",
  claude: "Claude",
  antigravity: "Antigravity",
};

/** Formats the product and plan line for an account detail row without doubling brand prefixes. */
export function formatProductPlan(provider: ProviderId, plan: string | null): string {
  const product = PRODUCT_NAMES[provider];
  const trimmed = plan?.trim() ?? "";

  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return product;
  }

  if (provider === "antigravity" && /^(antigravity|google)\b/i.test(trimmed)) {
    return trimmed;
  }

  const formatted = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return `${product} ${formatted}`;
}
