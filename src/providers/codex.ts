import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  applyCodexAuthRegistry,
  parseCodexAuthError,
  parseCodexAuthJson,
  parseCodexAuthSwitchJson,
  parseCodexAuthTable,
} from "./codex-auth-table";
import { fetchCodexResetCredits } from "./codex-reset-credits";
import { isRecord } from "./types";
import type { Account } from "./types";

const execFileAsync = promisify(execFile);
const CACHE_MS = 10_000;
const INSTALL_MESSAGE =
  "codex-auth not found. Install it with `npm install -g @loongphy/codex-auth` or `bun add -g @loongphy/codex-auth`.";

let cached: { at: number; accounts: Promise<Account[]> } | null = null;

/** Fast local-only discovery used to create one Raycast row per stored account. */
export function getCodexAccounts(): Account[] {
  try {
    return listCodexAccountsSync();
  } catch (error) {
    return [unavailableAccount(error)];
  }
}

export async function fetchCodexAccount(id: string): Promise<Account> {
  const base = emptyAccount(id);

  try {
    const accounts = await listCodexAccounts();
    return (
      accounts.find((candidate) => candidate.id === id) ?? {
        ...base,
        failure: { kind: "expired", message: "codex-auth no longer lists this account." },
      }
    );
  } catch (error) {
    return {
      ...base,
      failure: { kind: "error", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function switchCodexAccount(query: string, expectedId: string): Promise<void> {
  const wasRunning = await isChatGptRunning();
  const expectedKey = expectedId.startsWith("codex-auth:") ? expectedId.slice("codex-auth:".length) : null;
  let switchedKey: string | null;

  try {
    const stdout = await runCodexAuth(["switch", query, "--json"], 30_000);
    switchedKey = parseCodexAuthSwitchJson(stdout);

    if (switchedKey === null) {
      throw new Error("codex-auth returned an invalid switch response.");
    }
  } catch (error) {
    throw new Error(commandErrorMessage(error));
  }

  if (expectedKey && switchedKey !== expectedKey) {
    throw new Error("codex-auth did not activate the selected account.");
  }

  cached = null;

  if (wasRunning) {
    await execFileAsync("/usr/bin/pkill", ["-KILL", "-f", "^/Applications/ChatGPT\\.app/Contents/"]).catch(
      () => undefined,
    );

    for (let attempt = 0; attempt < 100 && (await isChatGptRunning()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (await isChatGptRunning()) {
      throw new Error("Account switched, but Codex did not finish quitting. Reopen it manually.");
    }

    try {
      // -g relaunches Codex without pulling focus, which would otherwise
      // dismiss the Raycast window mid-switch.
      await execFileAsync("/usr/bin/open", ["-g", "-b", "com.openai.codex"]);
    } catch {
      throw new Error("Account switched, but Codex could not reopen. Reopen it manually.");
    }
  }
}

function commandErrorMessage(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const message = error instanceof Error ? error.message : "codex-auth could not switch accounts.";
  const structured = parseCodexAuthError(stdout);

  return structured?.message || stderr || stdout || message;
}

function emptyAccount(id: string): Account {
  return {
    id,
    provider: "codex",
    label: "Codex",
    plan: null,
    email: null,
    windows: [],
    resets: null,
    failure: null,
  };
}

function listCodexAccounts(): Promise<Account[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.accounts;
  }

  const accounts = listCodexAccountsAsync().then(addResetCredits);

  cached = { at: Date.now(), accounts };
  return accounts;
}

function parseAccounts(output: string): Account[] {
  return applyCodexAuthRegistry(parseCodexAuthTable(output), readRegistry());
}

function listCodexAccountsSync(): Account[] {
  try {
    const accounts = parseCodexAuthJson(runCodexAuthSync(["list", "--skip-api", "--json"], 5_000));

    if (accounts !== null) {
      return accounts;
    }
  } catch {
    // codex-auth v0.2 has no JSON output; retry with its table interface below.
  }

  return parseAccounts(runCodexAuthSync(["list", "--skip-api"], 5_000));
}

async function listCodexAccountsAsync(): Promise<Account[]> {
  try {
    const accounts = parseCodexAuthJson(await runCodexAuth(["list", "--json"], 30_000));

    if (accounts !== null) {
      return accounts;
    }
  } catch {
    // codex-auth v0.2 has no JSON output; retry with its table interface below.
  }

  return parseAccounts(await runCodexAuth(["list"], 30_000));
}

function readRegistry(): unknown {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".codex/accounts/registry.json"), "utf8"));
  } catch {
    return null;
  }
}

async function addResetCredits(accounts: Account[]): Promise<Account[]> {
  const result: Account[] = [];

  for (const account of accounts) {
    const accountKey = account.id.startsWith("codex-auth:") ? account.id.slice("codex-auth:".length) : null;

    if (!accountKey || accountKey === "unavailable") {
      result.push(account);
      continue;
    }

    try {
      const filename = `${Buffer.from(accountKey).toString("base64url")}.auth.json`;
      const auth: unknown = JSON.parse(readFileSync(join(homedir(), ".codex/accounts", filename), "utf8"));
      const tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : {};
      const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : null;
      const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;

      result.push({
        ...account,
        resets: accessToken ? await fetchCodexResetCredits(accessToken, accountId).catch(() => null) : null,
      });
    } catch {
      result.push(account);
    }
  }

  return result;
}

async function isChatGptRunning(): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-f", "^/Applications/ChatGPT\\.app/Contents/"]);
    return true;
  } catch {
    return false;
  }
}

const OUTPUT_MARKER = "__CODEX_AUTH_OUTPUT__";
// Markers split codex-auth's output from prompt/banner noise printed by the user's shell config.
const SHELL_SCRIPT = `command -v codex-auth >/dev/null 2>&1 || exit 127; printf %s ${OUTPUT_MARKER}; printf %s ${OUTPUT_MARKER} >&2; exec codex-auth "$@"`;

let shell: string | null = null;

/** The user's zsh or bash; Raycast doesn't load ~/.zshrc, where bun/fnm/pnpm add themselves to PATH. */
function findShell(): string {
  if (shell) {
    return shell;
  }

  const preferred = process.env.SHELL && /\/(zsh|bash)$/.test(process.env.SHELL) ? [process.env.SHELL] : [];
  shell = [...preferred, "/bin/zsh", "/bin/bash"].find(existsSync) ?? "/bin/zsh";
  return shell;
}

function shellArgs(args: readonly string[]): string[] {
  return ["-ilc", SHELL_SCRIPT, "codex-auth", ...args];
}

function stripShellNoise(output: string): string {
  const index = output.indexOf(OUTPUT_MARKER);
  return index === -1 ? output : output.slice(index + OUTPUT_MARKER.length);
}

/** Cleans shell noise off a failed run's output and maps "command not found" to the install hint. */
function codexAuthError(error: unknown): unknown {
  if (!isRecord(error)) {
    return error;
  }

  if (error.status === 127 || error.code === 127) {
    return new Error(INSTALL_MESSAGE);
  }

  if (typeof error.stdout === "string") {
    error.stdout = stripShellNoise(error.stdout);
  }

  if (typeof error.stderr === "string") {
    error.stderr = stripShellNoise(error.stderr);
  }

  return error;
}

function runCodexAuthSync(args: readonly string[], timeout: number): string {
  try {
    const output = execFileSync(findShell(), shellArgs(args), {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stripShellNoise(output);
  } catch (error) {
    throw codexAuthError(error);
  }
}

async function runCodexAuth(args: readonly string[], timeout: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(findShell(), shellArgs(args), { encoding: "utf8", timeout });
    return stripShellNoise(stdout);
  } catch (error) {
    throw codexAuthError(error);
  }
}

function unavailableAccount(error: unknown): Account {
  return {
    id: "codex-auth:unavailable",
    provider: "codex",
    label: "codex-auth",
    plan: null,
    email: null,
    windows: [],
    resets: null,
    failure: {
      kind: "error",
      message: error instanceof Error ? error.message : INSTALL_MESSAGE,
    },
  };
}
