import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { mergeClaudeOAuthCredentials, shouldRefresh, type ClaudeOAuthRefresh } from "./claude-refresh";
import { parseClaudeResetCredits } from "./claude-reset-credits";
import { parseClaudeUsagePayload } from "./claude-usage";
import { isRecord, type Account, type ResetCreditsResponse, type UsageWindow } from "./types";

const execFileAsync = promisify(execFile);

export const CLAUDE_ACCOUNT_ID = "claude";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_WITH_RESETS_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const HTTP_TIMEOUT_MS = 10000;
const LOCK_TIMEOUT_MS = 12_000;
const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 5_000;
const USER_AGENT = "raycast-ai-usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = join(homedir(), ".claude/.credentials.json");

type CredentialSource = { kind: "keychain"; account: string | null } | { kind: "file"; path: string };

type Credentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType: string | null;
  source: CredentialSource;
  raw: Record<string, unknown>;
};

let refreshInFlight: Promise<Credentials | null> | null = null;

class ClaudeAuthExpiredError extends Error {
  constructor(message = "Claude Code token expired and could not be refreshed. Run `claude`.") {
    super(message);
    this.name = "ClaudeAuthExpiredError";
  }
}

class ClaudeRefreshRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRefreshRequestError";
  }
}

class ClaudeCredentialPersistenceError extends Error {
  constructor(message = "Claude refreshed its token, but the rotated credentials could not be saved. Run `claude`.") {
    super(message);
    this.name = "ClaudeCredentialPersistenceError";
  }
}

export async function fetchClaudeAccount(): Promise<Account> {
  const base: Account = {
    id: CLAUDE_ACCOUNT_ID,
    provider: "claude",
    label: "Claude Code",
    plan: null,
    email: null,
    windows: [],
    resets: null,
    failure: null,
  };

  let credentials = await readCredentials();

  if (!credentials) {
    return { ...base, failure: { kind: "expired", message: "Not signed in to Claude Code. Run `claude`." } };
  }

  base.plan = credentials.subscriptionType;

  try {
    if (shouldRefresh(credentials)) {
      try {
        credentials = (await refreshCredentials(credentials)) ?? credentials;
      } catch (error) {
        if (error instanceof ClaudeCredentialPersistenceError) {
          throw error;
        }

        if (isExpired(credentials)) {
          throw new ClaudeAuthExpiredError();
        }
      }

      base.plan = credentials.subscriptionType;
    }

    if (isExpired(credentials)) {
      throw new ClaudeAuthExpiredError();
    }

    return { ...base, ...(await fetchUsage(credentials)) };
  } catch (error) {
    if (error instanceof ClaudeAuthExpiredError) {
      return { ...base, failure: { kind: "expired", message: error.message } };
    }

    return { ...base, failure: { kind: "error", message: error instanceof Error ? error.message : String(error) } };
  }
}

function isExpired({ expiresAt }: { expiresAt: number | null }, now = Date.now()): boolean {
  return expiresAt !== null && expiresAt <= now;
}

async function readCredentials(): Promise<Credentials | null> {
  const keychain = await readKeychain();
  const keychainCredentials = parseCredentials(keychain?.raw ?? null, {
    kind: "keychain",
    account: keychain?.account ?? null,
  });

  return (
    keychainCredentials ??
    parseCredentials(await readCredentialsFile(CREDENTIALS_FILE), { kind: "file", path: CREDENTIALS_FILE })
  );
}

async function readCredentialsFromSource(source: CredentialSource): Promise<Credentials | null> {
  if (source.kind === "file") {
    return parseCredentials(await readCredentialsFile(source.path), source);
  }

  const keychain = await readKeychain();
  return parseCredentials(keychain?.raw ?? null, {
    kind: "keychain",
    account: keychain?.account ?? source.account,
  });
}

async function readKeychain(): Promise<{ raw: string; account: string | null } | null> {
  try {
    const [{ stdout: raw }, accountResult] = await Promise.all([
      execFileAsync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
        timeout: 5000,
      }),
      execFileAsync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], {
        encoding: "utf8",
        timeout: 5000,
      }).catch(() => null),
    ]);

    const accountOutput = `${accountResult?.stdout ?? ""}\n${accountResult?.stderr ?? ""}`;
    const accountMatch = accountOutput.match(/"acct"<blob>="([^"]+)"/);
    return { raw, account: accountMatch?.[1] ?? null };
  } catch {
    return null;
  }
}

async function readCredentialsFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

function parseCredentials(raw: string | null, source: CredentialSource): Credentials | null {
  if (!raw) {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = isRecord(payload) ? payload : null;

  if (!root) {
    return null;
  }

  const oauth = isRecord(root.claudeAiOauth) ? root.claudeAiOauth : null;

  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    return null;
  }

  return {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : null,
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    source,
    raw: root,
  };
}

async function refreshCredentials(credentials: Credentials): Promise<Credentials | null> {
  if (!credentials.refreshToken) {
    return null;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  const operation = refreshCredentialsOnce(credentials);
  refreshInFlight = operation;

  try {
    return await operation;
  } finally {
    if (refreshInFlight === operation) {
      refreshInFlight = null;
    }
  }
}

async function refreshCredentialsOnce(original: Credentials): Promise<Credentials | null> {
  return withRefreshLocks(original.source, async () => {
    const latest = await readCredentialsFromSource(original.source);

    if (!latest) {
      return null;
    }

    if (latest.accessToken !== original.accessToken) {
      return latest;
    }

    if (!latest.refreshToken) {
      return null;
    }

    assertCredentialSourceWritable(latest.source);

    const spentRefreshToken = latest.refreshToken;
    const refreshed = await requestOAuthRefresh(spentRefreshToken, latest.scopes);
    const current = await readCredentialsFromSource(latest.source);

    if (current && (current.accessToken !== latest.accessToken || current.refreshToken !== spentRefreshToken)) {
      if (current.accessToken !== latest.accessToken) {
        return current;
      }

      throw new ClaudeCredentialPersistenceError(
        "Claude credentials changed during token refresh. Run `claude` to verify the session.",
      );
    }

    const nextRaw = mergeClaudeOAuthCredentials(latest.raw, refreshed);
    await persistCredentials(latest.source, nextRaw);

    const persisted = await readCredentialsFromSource(latest.source);
    const expectedRefreshToken = refreshed.refreshToken ?? spentRefreshToken;

    if (
      !persisted ||
      persisted.accessToken !== refreshed.accessToken ||
      persisted.refreshToken !== expectedRefreshToken
    ) {
      throw new ClaudeCredentialPersistenceError();
    }

    return persisted;
  });
}

function assertCredentialSourceWritable(source: CredentialSource): void {
  if (source.kind === "keychain" && !source.account) {
    throw new ClaudeCredentialPersistenceError(
      "Claude's Keychain account could not be identified, so its rotating token was not refreshed. Run `claude`.",
    );
  }
}

async function requestOAuthRefresh(refreshToken: string, scopes: string[]): Promise<ClaudeOAuthRefresh> {
  let response: Response;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  if (scopes.length > 0) {
    body.set("scope", scopes.join(" "));
  }

  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ClaudeRefreshRequestError(
      `Claude token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new ClaudeRefreshRequestError(`Claude token refresh returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();

  if (
    !isRecord(payload) ||
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw new ClaudeRefreshRequestError("Claude token refresh returned an invalid response.");
  }

  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : null,
    expiresIn: payload.expires_in,
  };
}

async function persistCredentials(source: CredentialSource, raw: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(raw);

  try {
    if (source.kind === "keychain") {
      if (!source.account) {
        throw new Error("Missing Keychain account");
      }

      await execFileAsync(
        "/usr/bin/security",
        ["add-generic-password", "-U", "-a", source.account, "-s", KEYCHAIN_SERVICE, "-w", serialized],
        { encoding: "utf8", timeout: 5000 },
      );
      return;
    }

    await writeCredentialsFile(source.path, serialized);
  } catch {
    // execFile includes its arguments in some error messages. Never surface
    // that error here because the Keychain write arguments contain both tokens.
    throw new ClaudeCredentialPersistenceError();
  }
}

async function writeCredentialsFile(path: string, serialized: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function withRefreshLocks<T>(source: CredentialSource, operation: () => Promise<T>): Promise<T> {
  const configDirectory = source.kind === "file" ? dirname(source.path) : dirname(CREDENTIALS_FILE);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(configDirectory).catch(() => configDirectory);
  // Claude Code uses the first lock for OAuth rotation and still checks the
  // legacy config-directory lock. Taking both makes us one coordinated writer.
  const lockPaths = [join(configDirectory, ".oauth_refresh.lock"), `${canonicalDirectory}.lock`];
  const releases: Array<() => Promise<void>> = [];

  try {
    for (const lockPath of lockPaths) {
      releases.push(await acquireLock(lockPath));
    }

    return await operation();
  } finally {
    for (const release of releases.reverse()) {
      await release();
    }
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      if (await isStaleLock(path)) {
        await rmdir(path).catch(() => undefined);
        continue;
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new ClaudeRefreshRequestError("Timed out waiting for Claude Code's token refresh lock.");
      }

      await delay(100);
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
  }, LOCK_UPDATE_MS);

  return async () => {
    clearInterval(heartbeat);
    await rmdir(path).catch(() => undefined);
  };
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Date.now() - metadata.mtimeMs >= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ClaudeUsageClient = { url: string; userAgent: string; includesResets: boolean };

const STANDARD_USAGE_CLIENT: ClaudeUsageClient = { url: USAGE_URL, userAgent: USER_AGENT, includesResets: false };

async function fetchUsage(
  credentials: Credentials,
): Promise<{ windows: UsageWindow[]; resets: ResetCreditsResponse | null }> {
  let token = credentials.accessToken;
  let usage = await requestUsageWithFallback(token, await resolveUsageClient());

  if (usage.response.status === 401 && credentials.refreshToken) {
    let refreshed: Credentials | null;

    try {
      refreshed = await refreshCredentials(credentials);
    } catch (error) {
      if (error instanceof ClaudeCredentialPersistenceError) {
        throw error;
      }

      throw new ClaudeAuthExpiredError();
    }

    if (refreshed) {
      token = refreshed.accessToken;
      usage = await requestUsageWithFallback(token, usage.client);
    }
  }

  if (usage.response.status === 401) {
    throw new ClaudeAuthExpiredError();
  }

  if (!usage.response.ok) {
    throw new Error(`Claude usage returned HTTP ${usage.response.status}.`);
  }

  const payload = await usage.response.json();
  return {
    windows: parseClaudeUsagePayload(payload),
    resets: usage.client.includesResets ? parseClaudeResetCredits(payload) : null,
  };
}

async function requestUsageWithFallback(
  token: string,
  client: ClaudeUsageClient,
): Promise<{ client: ClaudeUsageClient; response: Response }> {
  if (client.includesResets) {
    try {
      const response = await requestUsage(token, client);
      if (response.ok || response.status === 401) {
        return { client, response };
      }
    } catch {
      // Reset discovery is optional; the ordinary usage request remains authoritative.
    }
  }

  return { client: STANDARD_USAGE_CLIENT, response: await requestUsage(token, STANDARD_USAGE_CLIENT) };
}

async function resolveUsageClient(): Promise<ClaudeUsageClient> {
  const searchPath = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    join(homedir(), ".claude/local"),
    join(homedir(), ".bun/bin"),
    process.env.PATH ?? "",
  ].join(":");

  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      env: { ...process.env, PATH: searchPath },
    });
    const version = stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];

    if (version) {
      return {
        url: USAGE_WITH_RESETS_URL,
        userAgent: `claude-cli/${version} (external, cli) ${USER_AGENT}`,
        includesResets: true,
      };
    }
  } catch {
    // Usage windows remain available when Claude Code's executable cannot be found.
  }

  return STANDARD_USAGE_CLIENT;
}

async function requestUsage(token: string, client: ClaudeUsageClient): Promise<Response> {
  return fetch(client.url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": client.userAgent,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}
