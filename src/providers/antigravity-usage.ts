import type { UsageWindow } from "./types";

export type AntigravityProcessKind = "app" | "cli" | "ide";

export type AntigravityProcessCandidate = {
  pid: number;
  kind: AntigravityProcessKind;
  csrfToken: string;
  extensionPort: number | null;
  extensionCsrfToken: string | null;
  command: string;
};

export type AntigravityIdentity = {
  email: string | null;
  plan: string | null;
};

export type AntigravityParsedUsage = AntigravityIdentity & {
  windows: UsageWindow[];
};

type QuotaBucketCadence = "5h" | "weekly" | "other";

const SESSION_CADENCE_ALIASES = new Set(["session", "5h", "5-hour", "five hour", "five-hour"]);
const PROCESS_KIND_RANK: Record<AntigravityProcessKind, number> = { app: 0, cli: 1, ide: 2 };

const LANGUAGE_SERVER_PATTERN = /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/i;
const CLI_PATH_PATTERN = /(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)/i;
const AGY_BINARY_PATTERN = /(^|[/\\])agy(\s|$)/i;
const AGY_ONE_SHOT_PATTERN = /\s(-p|--print|--version|--help|-h|-v)(\s|$)/i;

const IDE_MARKERS = [
  "antigravity ide.app/",
  "antigravity ide.app\\",
  "--app_data_dir antigravity-ide",
  "--app_data_dir=antigravity-ide",
  "/extensions/antigravity/bin/language_server",
  "\\extensions\\antigravity\\bin\\language_server",
];

const AUTH_PROMPT_PATTERNS = [
  /authentication\s+required/i,
  /select\s+login\s+method/i,
  /you\s+are\s+not\s+logged\s+into\s+antigravity/i,
  /keyring\s*auth\s*:\s*timed\s+out\b/i,
  /please\s+visit\s+the\s+url\s+to\s+log\s+in/i,
];

/**
 * Classifies running Antigravity processes from `ps -ax -o pid=,command=`.
 * Desktop app and IDE language servers require a `--csrf_token` flag; the CLI
 * accepts an empty token (newer `agy` releases reject tokenless requests and
 * fall through to `agy -p /usage --output-format json`).
 */
export function parseAntigravityProcesses(psOutput: string): AntigravityProcessCandidate[] {
  const candidates: AntigravityProcessCandidate[] = [];

  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;

    const kind = classifyProcessKind(command);
    if (!kind) continue;

    const csrfToken = extractFlag("--csrf_token", command);
    if (!csrfToken && kind !== "cli") {
      continue;
    }

    candidates.push({
      pid,
      kind,
      csrfToken: csrfToken ?? "",
      extensionPort: extractPort("--extension_server_port", command),
      extensionCsrfToken: extractFlag("--extension_server_csrf_token", command),
      command,
    });
  }

  return candidates.sort((a, b) => PROCESS_KIND_RANK[a.kind] - PROCESS_KIND_RANK[b.kind]);
}

/** Extracts unique local TCP listening ports from `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`. */
export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>();

  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) continue;
    const match = line.match(/(?:127\.0\.0\.1|\[::1\]|localhost|\*):(\d+)\s+\(LISTEN\)/i);
    if (!match) continue;

    const port = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }

  return [...ports];
}

/** Detects interactive sign-in prompts so non-interactive `agy` probes can abort immediately. */
export function isAntigravityAuthPrompt(text: string): boolean {
  return AUTH_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Parses Antigravity's structured `RetrieveUserQuotaSummary` response (from the
 * local Connect-RPC server or `agy -p /usage --output-format json`).
 */
export function parseAntigravityQuotaSummary(payload: unknown): UsageWindow[] {
  if (!isRecord(payload)) {
    throw new Error("Antigravity returned an unexpected quota summary response.");
  }

  assertOkCode(payload.code);

  const summary =
    (isRecord(payload.response) ? payload.response : null) ??
    (isRecord(payload.summary) ? payload.summary : null) ??
    (Array.isArray(payload.groups) ? payload : null);

  if (!summary || !Array.isArray(summary.groups)) {
    throw new Error("Antigravity quota summary is missing quota groups.");
  }

  type ParsedBucket = {
    cadence: QuotaBucketCadence;
    window: UsageWindow;
  };
  type ParsedGroup = {
    title: string;
    rank: number;
    index: number;
    buckets: ParsedBucket[];
  };

  const groups: ParsedGroup[] = [];

  summary.groups.forEach((rawGroup, index) => {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.buckets)) {
      return;
    }

    const rawTitle = firstNonEmptyString(rawGroup.displayName, rawGroup.display_name, rawGroup.name) ?? "Quota";
    const title = normalizeGroupTitle(rawTitle);
    const buckets: ParsedBucket[] = [];

    for (const rawBucket of rawGroup.buckets) {
      if (!isRecord(rawBucket)) continue;
      if (rawBucket.disabled === true) continue;

      const bucketId = firstNonEmptyString(rawBucket.bucketId, rawBucket.bucket_id, rawBucket.id);
      if (!bucketId) continue;

      const remainingFraction = extractBucketRemainingFraction(rawBucket);
      if (remainingFraction === null) continue;

      const bucketDisplayName =
        firstNonEmptyString(rawBucket.displayName, rawBucket.display_name, rawBucket.name) ?? bucketId;
      const explicitWindow = firstNonEmptyString(rawBucket.window);
      const cadence = classifyBucketCadence(explicitWindow, bucketId, bucketDisplayName);
      const suffix = cadence === "5h" ? "5h" : cadence === "weekly" ? "Weekly" : bucketDisplayName;

      buckets.push({
        cadence,
        window: {
          id: `antigravity:summary:${cadence}:${bucketId}`,
          label: `${title} ${suffix}`,
          usedPercent: fractionToUsedPercent(remainingFraction),
          resetsAt: parseTimestamp(rawBucket.resetTime ?? rawBucket.reset_time),
        },
      });
    }

    if (buckets.length === 0) return;

    buckets.sort((a, b) => cadenceRank(a.cadence) - cadenceRank(b.cadence));
    groups.push({
      title,
      rank: groupSortRank(title),
      index,
      buckets,
    });
  });

  groups.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index));

  const windows = groups.flatMap((group) => group.buckets.map((bucket) => bucket.window));

  if (windows.length === 0) {
    throw new Error("Antigravity quota summary has no usable quota buckets.");
  }

  return windows;
}

/** Parses stdout from `agy -p /usage --output-format json`. */
export function parseAntigravityCliUsageReport(stdout: string): UsageWindow[] {
  const payload = parseJsonFromOutput(stdout);

  if (!isRecord(payload)) {
    throw new Error("Antigravity CLI returned an invalid usage report.");
  }

  const status = firstNonEmptyString(payload.status);
  const command = isRecord(payload.command) ? payload.command : null;
  const commandName = command ? firstNonEmptyString(command.name) : null;

  if (status !== "SUCCESS" || commandName !== "usage" || !command || command.data === undefined) {
    throw new Error("Antigravity CLI usage report did not succeed.");
  }

  return parseAntigravityQuotaSummary(command.data);
}

/** Extracts account email and plan from a `GetUserStatus` payload without requiring quota rows. */
export function parseAntigravityUserIdentity(payload: unknown): AntigravityIdentity {
  if (!isRecord(payload)) {
    return { email: null, plan: null };
  }

  try {
    assertOkCode(payload.code);
  } catch {
    return { email: null, plan: null };
  }

  const userStatus = getRecord(payload, "userStatus", "user_status");
  if (!userStatus) {
    return { email: null, plan: null };
  }

  return {
    email: firstNonEmptyString(userStatus.email),
    plan: extractPlanName(userStatus),
  };
}

/**
 * Parses `GetUserStatus` (used as fallback when `RetrieveUserQuotaSummary` is
 * unavailable, such as on the Antigravity IDE local language server).
 */
export function parseAntigravityUserStatus(payload: unknown): AntigravityParsedUsage {
  if (!isRecord(payload)) {
    throw new Error("Antigravity returned an unexpected status response.");
  }

  assertOkCode(payload.code);

  const userStatus = getRecord(payload, "userStatus", "user_status");
  if (!userStatus) {
    throw new Error("Antigravity status response is missing userStatus.");
  }

  const modelData = getRecord(userStatus, "cascadeModelConfigData", "cascade_model_config_data");
  const configs = modelData ? (modelData.clientModelConfigs ?? modelData.client_model_configs) : null;
  const windows = parseModelConfigsToPoolWindows(configs);

  return {
    email: firstNonEmptyString(userStatus.email),
    plan: extractPlanName(userStatus),
    windows,
  };
}

/** Parses fallback `GetCommandModelConfigs` responses. */
export function parseAntigravityCommandModelConfigs(payload: unknown): UsageWindow[] {
  if (!isRecord(payload)) {
    throw new Error("Antigravity returned an unexpected model config response.");
  }

  assertOkCode(payload.code);

  return parseModelConfigsToPoolWindows(payload.clientModelConfigs ?? payload.client_model_configs);
}

type ModelQuotaRow = {
  label: string;
  modelId: string;
  remainingFraction: number;
  resetsAt: number | null;
  pool: "gemini" | "claude-gpt" | null;
  selectable: boolean;
};

function parseModelConfigsToPoolWindows(rawConfigs: unknown): UsageWindow[] {
  if (!Array.isArray(rawConfigs)) {
    throw new Error("Antigravity returned no model quota configurations.");
  }

  const rows: ModelQuotaRow[] = [];

  for (const item of rawConfigs) {
    if (!isRecord(item)) continue;
    const quotaInfo = getRecord(item, "quotaInfo", "quota_info");
    if (!quotaInfo) continue;

    const remainingFraction = readFiniteNumber(quotaInfo.remainingFraction ?? quotaInfo.remaining_fraction);
    if (remainingFraction === null) continue;

    const modelAlias = getRecord(item, "modelOrAlias", "model_or_alias");
    const modelId = firstNonEmptyString(modelAlias?.model, item.modelId, item.model_id) ?? "";
    const label = firstNonEmptyString(item.label, item.displayName, item.display_name, modelId) ?? "Model";

    const lowerId = modelId.toLowerCase();
    const lowerLabel = label.toLowerCase();
    const isLite = lowerId.includes("lite") || lowerLabel.includes("lite");
    const isImage = lowerId.includes("image") || lowerLabel.includes("image");
    const isAutocomplete =
      lowerId.includes("autocomplete") || lowerLabel.includes("autocomplete") || lowerId.startsWith("tab_");

    rows.push({
      label,
      modelId,
      remainingFraction,
      resetsAt: parseTimestamp(quotaInfo.resetTime ?? quotaInfo.reset_time),
      pool: classifyModelPool(lowerId, lowerLabel),
      selectable: !isLite && !isImage && !isAutocomplete,
    });
  }

  const selectable = rows.filter((row) => row.selectable);
  const gemini = pickMostConstrainedRow(selectable.filter((row) => row.pool === "gemini"));
  const claudeGpt = pickMostConstrainedRow(selectable.filter((row) => row.pool === "claude-gpt"));

  const windows: UsageWindow[] = [];

  if (gemini) {
    windows.push({
      id: "antigravity:pool:gemini",
      label: "Gemini",
      usedPercent: fractionToUsedPercent(gemini.remainingFraction),
      resetsAt: gemini.resetsAt,
    });
  }

  if (claudeGpt) {
    windows.push({
      id: "antigravity:pool:claude-gpt",
      label: "Claude/GPT",
      usedPercent: fractionToUsedPercent(claudeGpt.remainingFraction),
      resetsAt: claudeGpt.resetsAt,
    });
  }

  if (windows.length === 0) {
    const fallback = pickMostConstrainedRow(selectable);
    if (fallback) {
      windows.push({
        id: `antigravity:model:${fallback.modelId || fallback.label}`,
        label: fallback.label,
        usedPercent: fractionToUsedPercent(fallback.remainingFraction),
        resetsAt: fallback.resetsAt,
      });
    }
  }

  if (windows.length === 0) {
    throw new Error("Antigravity reported no usable model quotas.");
  }

  return windows;
}

function pickMostConstrainedRow(rows: readonly ModelQuotaRow[]): ModelQuotaRow | null {
  if (rows.length === 0) return null;

  return rows.reduce((best, candidate) => {
    if (candidate.remainingFraction !== best.remainingFraction) {
      return candidate.remainingFraction < best.remainingFraction ? candidate : best;
    }

    if (candidate.resetsAt !== best.resetsAt) {
      if (candidate.resetsAt !== null && (best.resetsAt === null || candidate.resetsAt < best.resetsAt)) {
        return candidate;
      }
      return best;
    }

    return candidate.label.localeCompare(best.label, undefined, { sensitivity: "base" }) < 0 ? candidate : best;
  });
}

function classifyModelPool(lowerId: string, lowerLabel: string): "gemini" | "claude-gpt" | null {
  const fromId = poolFromText(lowerId);
  return fromId ?? poolFromText(lowerLabel);
}

function poolFromText(text: string): "gemini" | "claude-gpt" | null {
  if (text.includes("claude") || text.includes("gpt") || text.includes("openai")) {
    return "claude-gpt";
  }

  if (text.includes("gemini") && (text.includes("pro") || text.includes("flash"))) {
    return "gemini";
  }

  return null;
}

function classifyProcessKind(command: string): AntigravityProcessKind | null {
  const lower = command.toLowerCase();

  if (LANGUAGE_SERVER_PATTERN.test(lower) && isAntigravityCommand(lower)) {
    return IDE_MARKERS.some((marker) => lower.includes(marker)) ? "ide" : "app";
  }

  if ((CLI_PATH_PATTERN.test(lower) || AGY_BINARY_PATTERN.test(lower)) && !AGY_ONE_SHOT_PATTERN.test(lower)) {
    return "cli";
  }

  return null;
}

function isAntigravityCommand(lowerCommand: string): boolean {
  if (lowerCommand.includes("--app_data_dir") && lowerCommand.includes("antigravity")) return true;
  if (lowerCommand.includes("antigravity.app/") || lowerCommand.includes("antigravity.app\\")) return true;
  if (lowerCommand.includes("/gemini.app/") || lowerCommand.includes("\\gemini.app\\")) return true;
  if (lowerCommand.includes("antigravity ide.app/") || lowerCommand.includes("antigravity ide.app\\")) return true;
  if (lowerCommand.includes("/antigravity/") || lowerCommand.includes("\\antigravity\\")) return true;
  return false;
}

function extractFlag(flag: string, command: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escaped}[=\\s]+([^\\s]+)`, "i"));
  return match?.[1] ?? null;
}

function extractPort(flag: string, command: string): number | null {
  const raw = extractFlag(flag, command);
  if (!raw) return null;
  const port = Number.parseInt(raw, 10);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function normalizeGroupTitle(rawTitle: string): string {
  const title = rawTitle.trim();
  const lower = title.toLowerCase();

  // Preserve versioned Gemini pools such as "Gemini 4 Argon".
  if (lower.includes("gemini") && !/\d/.test(title)) {
    return "Gemini";
  }

  if (lower.includes("claude") || lower.includes("gpt")) {
    return "Claude/GPT";
  }

  return title || "Quota";
}

function groupSortRank(title: string): number {
  if (title === "Gemini") return 0;
  if (title.toLowerCase().includes("gemini")) return 1;
  if (title === "Claude/GPT") return 2;
  return 3;
}

function cadenceRank(cadence: QuotaBucketCadence): number {
  if (cadence === "5h") return 0;
  if (cadence === "weekly") return 1;
  return 2;
}

function classifyBucketCadence(
  explicitWindow: string | null,
  bucketId: string,
  displayName: string,
): QuotaBucketCadence {
  const rawValues = explicitWindow ? [explicitWindow] : [bucketId, displayName];
  const candidates = new Set<string>();

  for (const rawValue of rawValues) {
    const normalized = rawValue.trim().toLowerCase().replace(/_/g, "-");
    if (!normalized) continue;

    const forms = normalized.endsWith(" limit")
      ? [normalized, normalized.slice(0, -" limit".length).trim()]
      : [normalized];

    for (const form of forms) {
      candidates.add(form);
      for (const alias of [...SESSION_CADENCE_ALIASES, "weekly"]) {
        if (form.endsWith(`-${alias}`)) {
          candidates.add(alias);
        }
      }
    }
  }

  for (const alias of SESSION_CADENCE_ALIASES) {
    if (candidates.has(alias)) {
      return "5h";
    }
  }

  return candidates.has("weekly") ? "weekly" : "other";
}

function extractBucketRemainingFraction(bucket: Record<string, unknown>): number | null {
  const direct = readFiniteNumber(bucket.remainingFraction ?? bucket.remaining_fraction);
  if (direct !== null) return direct;

  const remaining = isRecord(bucket.remaining) ? bucket.remaining : null;
  if (!remaining) return null;

  const nested = readFiniteNumber(remaining.remainingFraction ?? remaining.remaining_fraction);
  if (nested !== null) return nested;

  if (remaining.case === "remainingFraction" || remaining.case === "remaining_fraction") {
    return readFiniteNumber(remaining.value);
  }

  return null;
}

function extractPlanName(userStatus: Record<string, unknown>): string | null {
  // Prefer userTier.name (actual subscription tier) over planInfo (may say "Pro" for Ultra).
  const userTier = getRecord(userStatus, "userTier", "user_tier");
  const tierName = userTier ? firstNonEmptyString(userTier.name) : null;
  if (tierName) return tierName;

  const planStatus = getRecord(userStatus, "planStatus", "plan_status");
  const planInfo = planStatus ? getRecord(planStatus, "planInfo", "plan_info") : null;
  if (!planInfo) return null;

  return firstNonEmptyString(
    planInfo.planDisplayName,
    planInfo.plan_display_name,
    planInfo.displayName,
    planInfo.display_name,
    planInfo.productName,
    planInfo.product_name,
    planInfo.planName,
    planInfo.plan_name,
    planInfo.planShortName,
    planInfo.plan_short_name,
  );
}

function assertOkCode(code: unknown): void {
  if (code === undefined || code === null) return;

  if (typeof code === "number") {
    if (code === 0) return;
    throw new Error(`Antigravity returned status code ${code}.`);
  }

  if (typeof code === "string") {
    const normalized = code.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "ok" || normalized === "success") {
      return;
    }
    throw new Error(`Antigravity returned status ${code}.`);
  }

  throw new Error("Antigravity returned an invalid status code.");
}

function parseJsonFromOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Antigravity CLI returned no output.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the uniform error below.
      }
    }
    throw new Error("Antigravity CLI returned non-JSON output.");
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function fractionToUsedPercent(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round((1 - clamped) * 10000) / 100;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function getRecord(source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
