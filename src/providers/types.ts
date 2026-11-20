/** A single rate-limit window, normalised across providers. */
export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  /** Epoch milliseconds, or null when the provider does not say. */
  resetsAt: number | null;
};

/** One available banked usage reset. */
export type ResetCredit = {
  id: string;
  status: string;
  granted_at: string;
  expires_at: string;
  title?: string | null;
  description?: string | null;
};

export type ResetCreditsResponse = {
  credits: ResetCredit[];
  available_count: number;
};

/**
 * Why an account has no usage to show. `expired` is separated from `error`
 * because it is the one case the user can fix, and we tell them how.
 */
export type AccountFailure = {
  kind: "expired" | "error";
  message: string;
};

export type ProviderId = "codex" | "claude" | "antigravity";

export type ExtraUsage = {
  usedCredits: number;
  monthlyLimit: number | null;
};

export type Account = {
  id: string;
  provider: ProviderId;
  /** Short name shown in the section header, e.g. "Personal". */
  label: string;
  /** Plan as the provider reports it, e.g. "plus", "education", "pro". */
  plan: string | null;
  email: string | null;
  windows: UsageWindow[];
  /** Null when banked reset data is not available from the provider. */
  resets: ResetCreditsResponse | null;
  /** Spend amounts in USD cents, available only while a Claude limit is depleted. */
  extraUsage?: ExtraUsage | null;
  failure: AccountFailure | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
