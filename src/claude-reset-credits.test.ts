import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeResetCredits } from "./providers/claude-reset-credits.ts";

const now = Date.parse("2026-09-25T00:00:00Z");

test("normalizes available Claude reset grants for the existing reset view", () => {
  assert.deepEqual(
    parseClaudeResetCredits(
      {
        cedar_ember: {
          eligible: true,
          grants: [
            {
              id: "opus-launch",
              label: "Opus launch reset",
              resets_left: 2,
              starts_at: "2026-09-22T16:00:00Z",
              ends_at: "2026-10-22T16:00:00Z",
              clears: ["five_hour", "seven_day"],
            },
          ],
        },
      },
      now,
    ),
    {
      available_count: 2,
      credits: [
        {
          id: "opus-launch:1",
          status: "available",
          granted_at: "2026-09-22T16:00:00Z",
          expires_at: "2026-10-22T16:00:00Z",
          title: "Opus launch reset",
        },
        {
          id: "opus-launch:2",
          status: "available",
          granted_at: "2026-09-22T16:00:00Z",
          expires_at: "2026-10-22T16:00:00Z",
          title: "Opus launch reset",
        },
      ],
    },
  );
});

test("does not claim a reset when eligibility or grant data is unavailable", () => {
  assert.equal(parseClaudeResetCredits({ cedar_ember: null }, now), null);
  assert.equal(parseClaudeResetCredits({ cedar_ember: { eligible: false, grants: [] } }, now), null);
  assert.equal(parseClaudeResetCredits({ cedar_ember: { eligible: true, grants: null } }, now), null);
});

test("ignores expired, future, paused, and malformed grants", () => {
  assert.deepEqual(
    parseClaudeResetCredits(
      {
        cedar_ember: {
          eligible: true,
          grants: [
            { id: "expired", resets_left: 1, starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-09-24T00:00:00Z" },
            { id: "future", resets_left: 1, starts_at: "2026-09-26T00:00:00Z", ends_at: "2026-10-22T00:00:00Z" },
            {
              id: "paused",
              resets_left: 1,
              starts_at: "2026-09-01T00:00:00Z",
              ends_at: "2026-10-22T00:00:00Z",
              paused: true,
            },
            { id: "bad-date", resets_left: 1, starts_at: "invalid", ends_at: "2026-10-22T00:00:00Z" },
            { id: "bad-count", resets_left: -1, starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-10-22T00:00:00Z" },
          ],
        },
      },
      now,
    ),
    { credits: [], available_count: 0 },
  );
});
