import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isAntigravityAuthPrompt,
  parseAntigravityCliUsageReport,
  parseAntigravityCommandModelConfigs,
  parseAntigravityProcesses,
  parseAntigravityQuotaSummary,
  parseAntigravityUserIdentity,
  parseAntigravityUserStatus,
  parseListeningPorts,
  type AntigravityParsedUsage,
  type AntigravityProcessCandidate,
} from "./antigravity-usage.ts";
import { buildCliPath } from "./cli.ts";
import type { Account } from "./types.ts";

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_ACCOUNT_ID = "antigravity";

const QUOTA_SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const GET_USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const COMMAND_MODEL_CONFIG_PATH = "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs";
const UNLEASH_PATH = "/exa.language_server_pb.LanguageServerService/GetUnleashData";

const PS_TIMEOUT_MS = 3_000;
const LSOF_TIMEOUT_MS = 3_000;
const LOCAL_PROBE_DEADLINE_MS = 8_000;
const PROBE_TIMEOUT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 5_000;
const IDENTITY_TIMEOUT_MS = 1_500;
const CLI_TIMEOUT_MS = 20_000;
const CLI_EXIT_GRACE_MS = 200;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// Minimal placeholder metadata required by the local Connect-RPC request schemas;
// the local language server does not validate these client fields against account state.
const DEFAULT_METADATA_BODY = {
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en",
  },
};

const UNLEASH_BODY = {
  context: {
    properties: {
      devMode: "false",
      extensionVersion: "unknown",
      hasAnthropicModelAccess: "true",
      ide: "antigravity",
      ideVersion: "unknown",
      installationId: "raycast-ai-usage",
      language: "UNSPECIFIED",
      os: "macos",
      requestedModelId: "MODEL_UNSPECIFIED",
    },
  },
};

class AntigravityAuthError extends Error {
  constructor(message = "Not signed in to Antigravity. Open Antigravity or run `agy` to sign in.") {
    super(message);
    this.name = "AntigravityAuthError";
  }
}

export class LocalHttpStatusError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`Antigravity local server returned HTTP ${statusCode}.`);
    this.name = "LocalHttpStatusError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export type LocalEndpoint = {
  scheme: "https" | "http";
  port: number;
  csrfToken: string;
  requiresCsrfToken: boolean;
  source: "language-server" | "extension-server" | "cli";
};

type LocalSnapshot = AntigravityParsedUsage & {
  isQuotaSummary: boolean;
};

let fetchInFlight: Promise<Account> | null = null;

/** Deduplicates concurrent refreshes so View AI Usage and Menu Bar never overlap `agy` runs. */
export function fetchAntigravityAccount(): Promise<Account> {
  if (fetchInFlight) {
    return fetchInFlight;
  }

  const operation = fetchAntigravityAccountOnce();
  fetchInFlight = operation;

  return operation.finally(() => {
    if (fetchInFlight === operation) {
      fetchInFlight = null;
    }
  });
}

async function fetchAntigravityAccountOnce(): Promise<Account> {
  const base: Account = {
    id: ANTIGRAVITY_ACCOUNT_ID,
    provider: "antigravity",
    label: "Antigravity",
    plan: null,
    email: null,
    windows: [],
    resets: null,
    failure: null,
  };

  // `agy -p /usage` is the only supported way to read limits. The local language
  // server RPCs (`fetchFromLocalServers`) are undocumented and against Google's
  // ToS, so they are kept for when Google supports usage reporting officially
  // but are not called.
  const agyBinary = resolveAgyBinary();
  if (!agyBinary) {
    return {
      ...base,
      failure: {
        kind: "error",
        message: "The `agy` CLI was not found. Install `agy` and sign in to see Antigravity limits.",
      },
    };
  }

  try {
    const windows = await fetchViaAgyCli(agyBinary);
    return { ...base, windows };
  } catch (error) {
    if (error instanceof AntigravityAuthError) {
      return { ...base, failure: { kind: "expired", message: error.message } };
    }
    return {
      ...base,
      failure: { kind: "error", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** Unused: undocumented local language server path, kept for future use. */
export async function fetchFromLocalServers(): Promise<LocalSnapshot | null> {
  const deadline = Date.now() + LOCAL_PROBE_DEADLINE_MS;
  const candidates = await detectAntigravityProcesses();
  if (candidates.length === 0) {
    return null;
  }

  let best: LocalSnapshot | null = null;
  let authError: AntigravityAuthError | null = null;
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    if (Date.now() >= deadline) {
      lastError ??= new Error("Antigravity local server probe timed out.");
      break;
    }

    try {
      const snapshot = await probeCandidate(candidate, deadline);
      if (!snapshot) continue;

      if (!best || scoreSnapshot(snapshot) > scoreSnapshot(best)) {
        best = snapshot;
      }

      // An Antigravity desktop app quota summary already carries the richest
      // data available locally, so stop probing further processes.
      if (candidate.kind === "app" && snapshot.isQuotaSummary) {
        return snapshot;
      }
    } catch (error) {
      if (error instanceof AntigravityAuthError) {
        authError = error;
      } else if (error instanceof Error) {
        lastError = error;
      }
    }
  }

  if (best) {
    return best;
  }

  if (authError) {
    throw authError;
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function scoreSnapshot(snapshot: LocalSnapshot): number {
  let score = snapshot.isQuotaSummary ? 1_000 : 0;
  score += snapshot.windows.length * 10;
  if (snapshot.email) score += 2;
  if (snapshot.plan) score += 1;
  return score;
}

function remainingTimeout(deadline: number, maxTimeoutMs: number): number | null {
  const remaining = deadline - Date.now();
  return remaining > 0 ? Math.min(maxTimeoutMs, remaining) : null;
}

async function detectAntigravityProcesses(): Promise<AntigravityProcessCandidate[]> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseAntigravityProcesses(stdout);
  } catch {
    return [];
  }
}

async function detectListeningPorts(pid: number, deadline: number): Promise<number[]> {
  const timeout = remainingTimeout(deadline, LSOF_TIMEOUT_MS);
  if (timeout === null) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", `${pid}`], {
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return parseListeningPorts(stdout);
  } catch {
    return [];
  }
}

async function probeCandidate(candidate: AntigravityProcessCandidate, deadline: number): Promise<LocalSnapshot | null> {
  const ports = await detectListeningPorts(candidate.pid, deadline);
  const endpoints = buildCandidateEndpoints(candidate, ports);

  if (endpoints.length === 0) {
    return null;
  }

  return probeEndpoints(endpoints, deadline);
}

export type LocalJsonRequester = (
  endpoint: LocalEndpoint,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

/** Exported for unit testing local Connect-RPC fallback and error handling. */
export async function probeEndpoints(
  endpoints: readonly LocalEndpoint[],
  deadline = Date.now() + LOCAL_PROBE_DEADLINE_MS,
  requestJson: LocalJsonRequester = postLocalJson,
): Promise<LocalSnapshot> {
  const orderedEndpoints = await prioritizeWorkingEndpoints(endpoints, deadline, requestJson);
  let authError: AntigravityAuthError | null = null;

  // 1. Prefer RetrieveUserQuotaSummary (5h + Weekly per model family), then enrich with GetUserStatus identity.
  try {
    const summaryResult = await requestFirstParsed(
      orderedEndpoints,
      QUOTA_SUMMARY_PATH,
      { forceRefresh: true },
      deadline,
      REQUEST_TIMEOUT_MS,
      parseAntigravityQuotaSummary,
      requestJson,
    );

    const identity = await requestFirstParsed(
      [summaryResult.endpoint],
      GET_USER_STATUS_PATH,
      DEFAULT_METADATA_BODY,
      deadline,
      IDENTITY_TIMEOUT_MS,
      parseAntigravityUserIdentity,
      requestJson,
    ).catch(() => null);

    return {
      windows: summaryResult.value,
      email: identity?.value.email ?? null,
      plan: identity?.value.plan ?? null,
      isQuotaSummary: true,
    };
  } catch (error) {
    if (error instanceof AntigravityAuthError) {
      authError = error;
    }
  }

  // 2. Fall back to GetUserStatus (used by Antigravity IDE local servers).
  try {
    const statusResult = await requestFirstParsed(
      orderedEndpoints,
      GET_USER_STATUS_PATH,
      DEFAULT_METADATA_BODY,
      deadline,
      REQUEST_TIMEOUT_MS,
      parseAntigravityUserStatus,
      requestJson,
    );

    return {
      ...statusResult.value,
      isQuotaSummary: false,
    };
  } catch (error) {
    if (error instanceof AntigravityAuthError) {
      authError = error;
    }
  }

  // 3. Final local fallback: GetCommandModelConfigs.
  try {
    const modelsResult = await requestFirstParsed(
      orderedEndpoints,
      COMMAND_MODEL_CONFIG_PATH,
      DEFAULT_METADATA_BODY,
      deadline,
      REQUEST_TIMEOUT_MS,
      parseAntigravityCommandModelConfigs,
      requestJson,
    );

    return {
      windows: modelsResult.value,
      email: null,
      plan: null,
      isQuotaSummary: false,
    };
  } catch (error) {
    if (error instanceof AntigravityAuthError) {
      throw error;
    }
    if (authError) {
      throw authError;
    }
    throw error;
  }
}

export function buildCandidateEndpoints(
  candidate: AntigravityProcessCandidate,
  listeningPorts: number[],
): LocalEndpoint[] {
  const endpoints: LocalEndpoint[] = [];
  const seen = new Set<string>();

  const push = (endpoint: LocalEndpoint) => {
    const key = `${endpoint.scheme}:${endpoint.port}:${endpoint.csrfToken}:${endpoint.requiresCsrfToken}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(endpoint);
  };

  for (const port of listeningPorts) {
    for (const scheme of ["https", "http"] as const) {
      push({
        scheme,
        port,
        csrfToken: candidate.csrfToken,
        requiresCsrfToken: candidate.kind !== "cli" || candidate.csrfToken.length > 0,
        source: candidate.kind === "cli" ? "cli" : "language-server",
      });
    }
  }

  if (candidate.extensionPort !== null) {
    if (candidate.extensionCsrfToken) {
      push({
        scheme: "http",
        port: candidate.extensionPort,
        csrfToken: candidate.extensionCsrfToken,
        requiresCsrfToken: true,
        source: "extension-server",
      });
    } else if (candidate.csrfToken) {
      push({
        scheme: "http",
        port: candidate.extensionPort,
        csrfToken: candidate.csrfToken,
        requiresCsrfToken: true,
        source: "extension-server",
      });
    }
  }

  return endpoints;
}

async function prioritizeWorkingEndpoints(
  endpoints: readonly LocalEndpoint[],
  deadline: number,
  requestJson: LocalJsonRequester,
): Promise<LocalEndpoint[]> {
  const timeout = remainingTimeout(deadline, PROBE_TIMEOUT_MS);
  if (timeout === null) {
    return [...endpoints];
  }

  const results = await Promise.all(
    endpoints.map(async (endpoint) => ({
      endpoint,
      reachable: await isEndpointReachable(endpoint, timeout, requestJson),
    })),
  );
  const reachable = results.filter((result) => result.reachable).map((result) => result.endpoint);
  return reachable.length > 0 ? reachable : [...endpoints];
}

async function isEndpointReachable(
  endpoint: LocalEndpoint,
  timeoutMs: number,
  requestJson: LocalJsonRequester,
): Promise<boolean> {
  try {
    await requestJson(endpoint, UNLEASH_PATH, UNLEASH_BODY, timeoutMs);
    return true;
  } catch (error) {
    if (!(error instanceof LocalHttpStatusError)) {
      return false;
    }

    // Go TLS servers answer plain HTTP probes with HTTP 400 ("Client sent an HTTP request to an HTTPS server").
    if (endpoint.scheme === "http" && error.statusCode === 400 && /https server/i.test(error.body)) {
      return false;
    }

    // A CSRF rejection on the probe port means this endpoint/token pair cannot serve RPCs.
    if ((error.statusCode === 401 || error.statusCode === 403) && /csrf/i.test(error.body)) {
      return false;
    }

    return true;
  }
}

async function requestFirstParsed<T>(
  endpoints: readonly LocalEndpoint[],
  path: string,
  body: Record<string, unknown>,
  deadline: number,
  maxTimeoutMs: number,
  parse: (payload: unknown) => T,
  requestJson: LocalJsonRequester,
): Promise<{ endpoint: LocalEndpoint; value: T }> {
  let authError: AntigravityAuthError | null = null;
  let sawUnsupportedMethod = false;
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const timeoutMs = remainingTimeout(deadline, maxTimeoutMs);
    if (timeoutMs === null) {
      lastError ??= new Error("Antigravity local request timed out.");
      break;
    }

    try {
      const payload = await requestJson(endpoint, path, body, timeoutMs);
      return { endpoint, value: parse(payload) };
    } catch (error) {
      if (error instanceof LocalHttpStatusError) {
        if (error.statusCode === 404 || error.statusCode === 501) {
          sawUnsupportedMethod = true;
          lastError = error;
          continue;
        }

        if (error.statusCode === 401 || error.statusCode === 403) {
          // CSRF or token-mismatch rejections (e.g. tokenless `agy` 1.2.2+ or wrong extension token)
          // are transport mismatches, not proof that the user is signed out.
          const isCsrfRejection =
            /csrf/i.test(error.body) || (endpoint.source === "cli" && !endpoint.requiresCsrfToken);
          if (!isCsrfRejection && endpoint.source !== "extension-server") {
            authError = new AntigravityAuthError();
          }
          lastError = error;
          continue;
        }
      }

      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (authError && !sawUnsupportedMethod) {
    throw authError;
  }

  throw lastError ?? new Error("Could not reach the local Antigravity server.");
}

export function postLocalJson(
  endpoint: LocalEndpoint,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  requestImpl?: typeof http.request,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const serialized = JSON.stringify(body);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(serialized),
      "Connect-Protocol-Version": "1",
    };

    if (endpoint.requiresCsrfToken) {
      headers["X-Codeium-Csrf-Token"] = endpoint.csrfToken;
    }

    const requestOptions: https.RequestOptions = {
      hostname: "127.0.0.1",
      port: endpoint.port,
      path,
      method: "POST",
      headers,
      timeout: timeoutMs,
      ...(endpoint.scheme === "https" ? { rejectUnauthorized: false } : {}),
    };

    const requestFn = requestImpl ?? (endpoint.scheme === "https" ? https.request : http.request);
    const req = requestFn(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;

      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          const sizeError = new Error("Antigravity local response exceeded size limit.");
          req.destroy(sizeError);
          finish(() => reject(sizeError));
          return;
        }
        chunks.push(chunk);
      });

      res.on("error", (error) => {
        finish(() => reject(error));
      });

      res.on("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        const statusCode = res.statusCode ?? 0;

        if (statusCode !== 200) {
          finish(() => reject(new LocalHttpStatusError(statusCode, text)));
          return;
        }

        try {
          const parsed: unknown = JSON.parse(text);
          finish(() => resolve(parsed));
        } catch {
          finish(() => reject(new Error("Antigravity local server returned invalid JSON.")));
        }
      });
    });

    req.on("timeout", () => {
      const timeoutError = new Error("Antigravity local request timed out.");
      req.destroy(timeoutError);
      finish(() => reject(timeoutError));
    });

    req.on("error", (error) => {
      finish(() => reject(error));
    });

    req.write(serialized);
    req.end();
  });
}

function resolveAgyBinary(): string | null {
  const override = process.env.ANTIGRAVITY_CLI_PATH;
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed && isExecutable(trimmed) ? trimmed : null;
  }

  const candidates = [
    join(homedir(), ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    ...(process.env.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => join(dir, "agy")),
  ];

  return candidates.find(isExecutable) ?? null;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `agy -p /usage --output-format json` in a private temporary directory
 * with failing browser launchers so signed-out background refreshes never open
 * a browser tab or trigger CLI auto-updates. Exported for unit testing.
 */
export async function fetchViaAgyCli(binaryPath: string, timeoutMs = CLI_TIMEOUT_MS): Promise<Account["windows"]> {
  const probeDir = await mkdtemp(join(tmpdir(), "raycast-antigravity-"));

  try {
    const failingLauncher = "#!/bin/sh\nexit 1\n";
    const openStub = join(probeDir, "open");
    await writeFile(openStub, failingLauncher, { mode: 0o700 });
    await writeFile(join(probeDir, "xdg-open"), failingLauncher, { mode: 0o700 });

    const { stdout, code } = await runAgyUsageCommand(binaryPath, probeDir, openStub, timeoutMs);

    try {
      return parseAntigravityCliUsageReport(stdout);
    } catch (parseError) {
      if (code !== 0) {
        throw new Error(`Antigravity CLI exited with status ${code ?? "unknown"}.`);
      }
      throw parseError;
    }
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runAgyUsageCommand(
  binaryPath: string,
  probeDir: string,
  openStub: string,
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["-p", "/usage", "--output-format", "json"], {
      cwd: probeDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        BROWSER: openStub,
        PATH: `${probeDir}:${buildCliPath([join(homedir(), ".local/bin")])}`,
      },
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let combinedText = "";
    let settled = false;
    let exitCode: number | null = null;
    let exitGraceTimer: NodeJS.Timeout | null = null;

    const killProcessGroup = () => {
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // Process already exited.
          }
        }

        const hardKill = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Process group already exited.
          }
        }, 1_000);
        hardKill.unref();
      }
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = null;
      }
      callback();
    };

    const checkAuthPrompt = (chunk: Buffer) => {
      combinedText = `${combinedText}${chunk.toString("utf8")}`.slice(-4096);
      if (isAntigravityAuthPrompt(combinedText)) {
        killProcessGroup();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(() => reject(new AntigravityAuthError()));
      }
    };

    const timer = setTimeout(() => {
      killProcessGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(() => reject(new Error("Antigravity CLI usage check timed out.")));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_RESPONSE_BYTES) {
        stdoutChunks.push(chunk);
      }
      checkAuthPrompt(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      checkAuthPrompt(chunk);
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("exit", (code) => {
      exitCode = code;
      // Allow a brief window for buffered stdout to flush; if a detached grandchild
      // (such as an MCP helper) still holds the pipe open, reap the group and settle.
      exitGraceTimer = setTimeout(() => {
        killProcessGroup();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(() => resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), code: exitCode }));
      }, CLI_EXIT_GRACE_MS);
    });

    child.on("close", (code) => {
      killProcessGroup();
      finish(() => resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), code: code ?? exitCode }));
    });
  });
}
