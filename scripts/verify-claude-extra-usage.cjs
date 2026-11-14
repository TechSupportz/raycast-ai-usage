// Provider integration probe. All credentials and HTTP responses are fictional.
// Failure cases defined before implementation: premature spend requests, missed
// session/weekly exhaustion, stale reset timestamps, disabled/malformed spend,
// unlimited caps, failed HTTP/JSON/network, fallback without the CLI, and recovery.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-extra-usage-"));
fs.mkdirSync(path.join(dir, ".claude"));
fs.writeFileSync(
  path.join(dir, ".claude/.credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "fictional", expiresAt: Date.now() + 86400000 } }),
);
os.homedir = () => dir;
const originalExec = cp.execFile;
let cliAvailable = true;
cp.execFile = (file, args, options, callback) => {
  if (file === "claude" && cliAvailable) callback(null, "2.1.0", "");
  else callback(new Error("fixture: unavailable"), "", "");
};
const bundle = path.join(dir, "provider.cjs");
buildSync({ entryPoints: ["src/providers/claude.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle });
const { fetchClaudeAccount } = require(bundle);
const future = new Date(Date.now() + 3600000).toISOString();
const cases = [
  { name: "healthy", session: 99.99, weekly: 20, requests: 1 },
  { name: "session depleted", session: 100, weekly: 20, requests: 2, visible: true },
  { name: "weekly depleted", session: 20, weekly: 100, requests: 2, visible: true },
  { name: "disabled", session: 100, requests: 2, extra: { is_enabled: false }, visible: false },
  {
    name: "unlimited cap",
    session: 100,
    requests: 2,
    extra: { is_enabled: true, used_credits: 125, monthly_limit: null },
    visible: true,
  },
  {
    name: "malformed amount",
    session: 100,
    requests: 2,
    extra: { is_enabled: true, used_credits: -1, monthly_limit: 1000 },
  },
  { name: "spend HTTP failure", session: 100, requests: 2, fail: "http" },
  { name: "spend network failure", session: 100, requests: 2, fail: "network" },
  { name: "spend JSON failure", session: 100, requests: 2, fail: "json" },
  { name: "past reset", session: 100, requests: 1, reset: new Date(Date.now() - 1000).toISOString() },
  { name: "recovered", session: 10, weekly: 10, requests: 1 },
];
(async () => {
  const results = [];
  for (const c of cases) {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      const spend = !new URL(url).searchParams.has("skip_spend");
      if (spend && c.fail === "network") throw new Error("fictional network failure");
      if (spend && c.fail === "http") return new Response("", { status: 503 });
      if (spend && c.fail === "json") return new Response("invalid json");
      return Response.json({
        five_hour: { utilization: c.session, resets_at: c.reset ?? future },
        seven_day: { utilization: c.weekly ?? 20, resets_at: future },
        extra_usage: c.extra ?? { is_enabled: true, used_credits: 125, monthly_limit: 1000 },
      });
    };
    const account = await fetchClaudeAccount();
    assert.equal(urls.length, c.requests, c.name);
    assert.ok(new URL(urls[0]).searchParams.has("skip_spend"), c.name);
    assert.equal(!!account.extraUsage, !!c.visible, c.name);
    assert.equal(account.failure, null, c.name);
    if (c.visible) assert.equal(account.extraUsage.usedCredits, 125, c.name);
    results.push({ scenario: c.name, requests: urls.length, visible: !!account.extraUsage, result: "pass" });
  }
  const artifact = path.resolve(process.argv[2] ?? "/tmp/claude-extra-usage-verification.json");
  fs.writeFileSync(
    artifact,
    JSON.stringify(
      {
        command: "node scripts/verify-claude-extra-usage.cjs",
        scope: "Provider integration with fictional credentials and HTTP; no live Raycast UI",
        results,
      },
      null,
      2,
    ),
  );
  console.log(`${results.length} scenarios passed. Artifact: ${artifact}`);
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cp.execFile = originalExec;
    fs.rmSync(dir, { recursive: true, force: true });
  });
