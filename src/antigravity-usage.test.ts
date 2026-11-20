import assert from "node:assert/strict";
import test from "node:test";
import {
  isAntigravityAuthPrompt,
  parseAntigravityCliUsageReport,
  parseAntigravityCommandModelConfigs,
  parseAntigravityProcesses,
  parseAntigravityQuotaSummary,
  parseAntigravityUserIdentity,
  parseAntigravityUserStatus,
  parseListeningPorts,
} from "./providers/antigravity-usage.ts";

test("classifies Antigravity app, CLI, and IDE processes in priority order", () => {
  const psOutput = [
    "  100 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --app_data_dir antigravity-ide --csrf_token ide-tok --extension_server_port 51001",
    "  200 /opt/homebrew/bin/agy",
    "  300 /Applications/Antigravity.app/Contents/Resources/language_server_macos_arm --app_data_dir antigravity --csrf_token app-tok --extension_server_port=52001 --extension_server_csrf_token ext-tok",
    "  400 /Applications/Antigravity.app/Contents/Resources/language_server_macos_arm --app_data_dir antigravity",
    "  500 /opt/homebrew/bin/agy -p /usage --output-format json",
    "  600 /usr/bin/python3 -m http.server",
  ].join("\n");

  const candidates = parseAntigravityProcesses(psOutput);

  assert.deepEqual(
    candidates.map(({ pid, kind, csrfToken, extensionPort, extensionCsrfToken }) => ({
      pid,
      kind,
      csrfToken,
      extensionPort,
      extensionCsrfToken,
    })),
    [
      {
        pid: 300,
        kind: "app",
        csrfToken: "app-tok",
        extensionPort: 52001,
        extensionCsrfToken: "ext-tok",
      },
      {
        pid: 200,
        kind: "cli",
        csrfToken: "",
        extensionPort: null,
        extensionCsrfToken: null,
      },
      {
        pid: 100,
        kind: "ide",
        csrfToken: "ide-tok",
        extensionPort: 51001,
        extensionCsrfToken: null,
      },
    ],
  );
});

test("recognizes the renamed Gemini desktop app bundle as an Antigravity app server", () => {
  const candidates = parseAntigravityProcesses(
    "42 /Applications/Gemini.app/Contents/Resources/language_server_macos_arm --csrf_token gem-tok",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "app");
  assert.equal(candidates[0].csrfToken, "gem-tok");
});

test("extracts unique loopback and wildcard listening ports from lsof output", () => {
  const lsofOutput = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "language_ 300 user   10u  IPv4 0x1234      0t0  TCP 127.0.0.1:49152 (LISTEN)",
    "language_ 300 user   11u  IPv6 0x1235      0t0  TCP [::1]:49152 (LISTEN)",
    "language_ 300 user   12u  IPv4 0x1236      0t0  TCP *:49153 (LISTEN)",
    "language_ 300 user   13u  IPv4 0x1237      0t0  TCP 127.0.0.1:49152->127.0.0.1:61234 (ESTABLISHED)",
  ].join("\n");

  assert.deepEqual(parseListeningPorts(lsofOutput), [49152, 49153]);
});

test("parses RetrieveUserQuotaSummary groups in Gemini then Claude/GPT order with 5h before Weekly", () => {
  const windows = parseAntigravityQuotaSummary({
    response: {
      groups: [
        {
          displayName: "Claude and GPT models",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly limit",
              remaining: { remainingFraction: 0.7 },
              resetTime: "2026-11-27T00:00:00Z",
            },
            {
              bucketId: "3p-5h",
              displayName: "5-hour limit",
              remaining: { case: "remainingFraction", value: 0.85 },
              resetTime: "2026-11-20T18:00:00Z",
            },
          ],
        },
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly limit",
              remainingFraction: 0.6,
              resetTime: "2026-11-27T00:00:00Z",
              window: "weekly",
            },
            {
              bucketId: "gemini-5h",
              displayName: "5-hour limit",
              remainingFraction: 0.25,
              resetTime: "2026-11-20T16:30:00Z",
              window: "5h",
            },
            {
              bucketId: "gemini-disabled",
              displayName: "Disabled",
              remainingFraction: 0,
              disabled: true,
            },
          ],
        },
        {
          displayName: "Gemini 4 Argon",
          buckets: [
            {
              bucketId: "argon-weekly",
              displayName: "Weekly",
              remainingFraction: 0.9,
              resetTime: "2026-11-27T00:00:00Z",
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(windows, [
    {
      id: "antigravity:summary:5h:gemini-5h",
      label: "Gemini 5h",
      usedPercent: 75,
      resetsAt: Date.parse("2026-11-20T16:30:00Z"),
    },
    {
      id: "antigravity:summary:weekly:gemini-weekly",
      label: "Gemini Weekly",
      usedPercent: 40,
      resetsAt: Date.parse("2026-11-27T00:00:00Z"),
    },
    {
      id: "antigravity:summary:weekly:argon-weekly",
      label: "Gemini 4 Argon Weekly",
      usedPercent: 10,
      resetsAt: Date.parse("2026-11-27T00:00:00Z"),
    },
    {
      id: "antigravity:summary:5h:3p-5h",
      label: "Claude/GPT 5h",
      usedPercent: 15,
      resetsAt: Date.parse("2026-11-20T18:00:00Z"),
    },
    {
      id: "antigravity:summary:weekly:3p-weekly",
      label: "Claude/GPT Weekly",
      usedPercent: 30,
      resetsAt: Date.parse("2026-11-27T00:00:00Z"),
    },
  ]);
});

test("parses snake_case JSON output from `agy -p /usage --output-format json`", () => {
  const stdout = [
    "I1120 15:00:00.000000 1 server.go:100] Starting",
    JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              display_name: "Gemini Models",
              buckets: [
                {
                  bucket_id: "gemini-weekly",
                  display_name: "Weekly limit",
                  remaining_fraction: 0.82,
                  reset_time: "2026-11-27T00:00:00Z",
                },
              ],
            },
          ],
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseAntigravityCliUsageReport(stdout), [
    {
      id: "antigravity:summary:weekly:gemini-weekly",
      label: "Gemini Weekly",
      usedPercent: 18,
      resetsAt: Date.parse("2026-11-27T00:00:00Z"),
    },
  ]);
});

test("rejects unsuccessful CLI usage reports, malformed JSON, and empty quota summaries", () => {
  assert.throws(
    () => parseAntigravityCliUsageReport(JSON.stringify({ status: "ERROR", command: { name: "usage", data: {} } })),
    /did not succeed/,
  );

  assert.throws(() => parseAntigravityCliUsageReport("noise { not json } noise"), /non-JSON output/);

  assert.throws(
    () =>
      parseAntigravityQuotaSummary({
        response: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [{ bucketId: "gemini-5h", displayName: "5h" }],
            },
          ],
        },
      }),
    /no usable quota buckets/,
  );
});

test("parses legacy GetUserStatus into Gemini and Claude/GPT pools and prefers userTier.name", () => {
  const parsed = parseAntigravityUserStatus({
    userStatus: {
      email: "alex@example.com",
      userTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
      planStatus: { planInfo: { planDisplayName: "Pro" } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Gemini 3.1 Pro (High)",
            modelOrAlias: { model: "gemini-3.1-pro-high" },
            quotaInfo: { remainingFraction: 0.65, resetTime: "2026-11-20T18:00:00Z" },
          },
          {
            label: "Gemini 3.1 Flash",
            modelOrAlias: { model: "gemini-3.1-flash" },
            quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-20T17:00:00Z" },
          },
          {
            label: "Gemini 3.1 Flash Lite",
            modelOrAlias: { model: "gemini-3.1-flash-lite" },
            quotaInfo: { remainingFraction: 0.05, resetTime: "2026-11-20T16:00:00Z" },
          },
          {
            label: "Claude Sonnet 4.6",
            modelOrAlias: { model: "claude-sonnet-4-6" },
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-11-20T19:00:00Z" },
          },
          {
            label: "GPT-OSS 120B",
            modelOrAlias: { model: "gpt-oss-120b" },
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-20T18:30:00Z" },
          },
        ],
      },
    },
  });

  assert.deepEqual(parsed, {
    email: "alex@example.com",
    plan: "Google AI Ultra",
    windows: [
      {
        id: "antigravity:pool:gemini",
        label: "Gemini",
        usedPercent: 60,
        resetsAt: Date.parse("2026-11-20T17:00:00Z"),
      },
      {
        id: "antigravity:pool:claude-gpt",
        label: "Claude/GPT",
        usedPercent: 20,
        resetsAt: Date.parse("2026-11-20T18:30:00Z"),
      },
    ],
  });
});

test("extracts identity cleanly and parses fallback GetCommandModelConfigs", () => {
  assert.deepEqual(
    parseAntigravityUserIdentity({
      userStatus: {
        email: "dev@example.com",
        planStatus: { planInfo: { planDisplayName: "Google AI Pro" } },
      },
    }),
    { email: "dev@example.com", plan: "Google AI Pro" },
  );

  assert.deepEqual(
    parseAntigravityCommandModelConfigs({
      clientModelConfigs: [
        {
          label: "Gemini 3.1 Pro",
          modelOrAlias: { model: "gemini-3.1-pro" },
          quotaInfo: { remainingFraction: 0.5, resetTime: "1774915200" },
        },
      ],
    }),
    [
      {
        id: "antigravity:pool:gemini",
        label: "Gemini",
        usedPercent: 50,
        resetsAt: 1_774_915_200_000,
      },
    ],
  );
});

test("detects interactive Antigravity sign-in prompts", () => {
  assert.equal(isAntigravityAuthPrompt("Authentication required. Please visit the URL to log in:"), true);
  assert.equal(isAntigravityAuthPrompt("Select login method:"), true);
  assert.equal(isAntigravityAuthPrompt('{"status":"SUCCESS"}'), false);
});
