export type ParsedUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
};

const MAIN_LIMIT_LABELS = new Map([
  ["five_hour", "Session Limit"],
  ["seven_day", "Weekly Limit"],
  ["session", "Session Limit"],
  ["weekly_all", "Weekly Limit"],
]);

/**
 * Claude's OAuth endpoint exposes named top-level windows such as `five_hour`
 * and `seven_day`. The legacy array fallback keeps the parser tolerant of the
 * alternate normalised shape seen in older clients.
 */
export function parseClaudeUsagePayload(payload: unknown): ParsedUsageWindow[] {
  if (!isRecord(payload)) {
    throw new Error("Claude returned an unexpected usage response.");
  }

  const windows = Object.entries(payload).flatMap(([kind, value]) => {
    const label = MAIN_LIMIT_LABELS.get(kind);

    if (!label || !isRecord(value) || typeof value.utilization !== "number") {
      return [];
    }

    return [
      {
        id: kind,
        label,
        usedPercent: value.utilization,
        resetsAt: parseResetAt(value.resets_at),
      },
    ];
  });

  if (windows.length > 0) {
    return windows;
  }

  const legacyWindows = Array.isArray(payload.limits) ? payload.limits.filter(isRecord) : [];
  const parsedLegacyWindows = legacyWindows.flatMap((limit) => {
    const kind = limit.kind;
    if (typeof kind !== "string" || typeof limit.percent !== "number") {
      return [];
    }

    const label = MAIN_LIMIT_LABELS.get(kind);
    if (!label) {
      return [];
    }

    return [
      {
        id: kind,
        label,
        usedPercent: limit.percent,
        resetsAt: parseResetAt(limit.resets_at),
      },
    ];
  });

  if (parsedLegacyWindows.length === 0) {
    throw new Error("Claude returned an unexpected usage response.");
  }

  return parsedLegacyWindows;
}

function parseResetAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
