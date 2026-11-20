import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchViaAgyCli,
  LocalHttpStatusError,
  postLocalJson,
  probeEndpoints,
  type LocalEndpoint,
} from "./providers/antigravity.ts";

test("falls back from RetrieveUserQuotaSummary 404 + extension 403 CSRF to GetUserStatus", async () => {
  const endpoints: LocalEndpoint[] = [
    { scheme: "https", port: 51000, csrfToken: "ide-token", requiresCsrfToken: true, source: "language-server" },
    { scheme: "http", port: 51000, csrfToken: "ide-token", requiresCsrfToken: true, source: "language-server" },
    { scheme: "http", port: 51001, csrfToken: "ide-token", requiresCsrfToken: true, source: "extension-server" },
  ];

  const snapshot = await probeEndpoints(endpoints, Date.now() + 5_000, async (endpoint, path) => {
    if (endpoint.scheme === "http" && endpoint.port === 51000) {
      throw new LocalHttpStatusError(400, "Client sent an HTTP request to an HTTPS server");
    }

    if (endpoint.port === 51001) {
      throw new LocalHttpStatusError(403, "invalid CSRF token");
    }

    if (path.endsWith("/GetUnleashData")) {
      return {};
    }

    if (path.endsWith("/RetrieveUserQuotaSummary")) {
      throw new LocalHttpStatusError(404, '{"code":"unimplemented"}');
    }

    if (path.endsWith("/GetUserStatus")) {
      return {
        userStatus: {
          email: "ide@example.com",
          userTier: { name: "Google AI Pro" },
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: "Gemini 3.1 Pro",
                modelOrAlias: { model: "gemini-3.1-pro" },
                quotaInfo: { remainingFraction: 0.75, resetTime: "2026-11-20T18:00:00Z" },
              },
            ],
          },
        },
      };
    }

    throw new LocalHttpStatusError(404, "not found");
  });

  assert.equal(snapshot.isQuotaSummary, false);
  assert.equal(snapshot.email, "ide@example.com");
  assert.equal(snapshot.plan, "Google AI Pro");
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].id, "antigravity:pool:gemini");
  assert.equal(snapshot.windows[0].usedPercent, 25);
});

test("rejects oversized local responses and mid-stream response errors cleanly", async () => {
  const endpoint: LocalEndpoint = {
    scheme: "http",
    port: 51000,
    csrfToken: "tok",
    requiresCsrfToken: true,
    source: "language-server",
  };

  let destroyed = false;
  const makeRequest = (driveResponse: (res: EventEmitter & { statusCode?: number }) => void): typeof http.request =>
    ((_options: unknown, callback?: (res: http.IncomingMessage) => void) => {
      const req = Object.assign(new EventEmitter(), {
        write() {},
        end() {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback?.(res as unknown as http.IncomingMessage);
          driveResponse(res);
        },
        destroy() {
          destroyed = true;
        },
      });
      return req as unknown as http.ClientRequest;
    }) as typeof http.request;

  await assert.rejects(
    () =>
      postLocalJson(
        endpoint,
        "/test",
        {},
        5_000,
        makeRequest((res) => {
          res.emit("data", Buffer.alloc(1_100_000, "x"));
        }),
      ),
    /size limit/,
  );
  assert.equal(destroyed, true);

  await assert.rejects(
    () =>
      postLocalJson(
        endpoint,
        "/test",
        {},
        5_000,
        makeRequest((res) => {
          res.emit("error", new Error("connection reset mid-body"));
        }),
      ),
    /connection reset mid-body/,
  );
});

test("runs agy CLI with auto-update disabled, browser stubbed, and accepts valid JSON even on non-zero exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "antigravity-cli-test-"));
  const fakeAgy = join(dir, "agy");

  const payload = JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            display_name: "Gemini Models",
            buckets: [
              {
                bucket_id: "gemini-5h",
                display_name: "5-hour limit",
                remaining_fraction: 0.6,
                reset_time: "2026-11-20T19:00:00Z",
              },
            ],
          },
        ],
      },
    },
  });

  await writeFile(
    fakeAgy,
    [
      "#!/bin/sh",
      'if [ "$AGY_CLI_DISABLE_AUTO_UPDATE" != "true" ]; then echo "missing env" >&2; exit 2; fi',
      'if open https://example.com 2>/dev/null; then echo "open should fail" >&2; exit 3; fi',
      `printf '%s\\n' '${payload}'`,
      "exit 1",
    ].join("\n"),
  );
  await chmod(fakeAgy, 0o700);

  try {
    const windows = await fetchViaAgyCli(fakeAgy, 5_000);
    assert.deepEqual(windows, [
      {
        id: "antigravity:summary:5h:gemini-5h",
        label: "Gemini 5h",
        usedPercent: 40,
        resetsAt: Date.parse("2026-11-20T19:00:00Z"),
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborts agy CLI immediately on auth prompt and cleans up grandchildren", async () => {
  const dir = await mkdtemp(join(tmpdir(), "antigravity-cli-auth-"));
  const fakeAgy = join(dir, "agy");

  await writeFile(
    fakeAgy,
    ["#!/bin/sh", "sleep 30 &", 'echo "Authentication required. Please visit the URL to log in:"', "sleep 30"].join(
      "\n",
    ),
  );
  await chmod(fakeAgy, 0o700);

  const startedAt = Date.now();
  try {
    await assert.rejects(() => fetchViaAgyCli(fakeAgy, 5_000), /Not signed in to Antigravity/);
    assert.ok(Date.now() - startedAt < 2_500, "auth prompt should abort without waiting for timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
