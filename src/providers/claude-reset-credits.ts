import { parseResetExpiry } from "../reset-expiry.ts";
import { isRecord, type ResetCredit, type ResetCreditsResponse } from "./types.ts";

/** Claude only returns saved grants when the OAuth usage request is eligible for the CLI surface. */
export function parseClaudeResetCredits(payload: unknown, now = Date.now()): ResetCreditsResponse | null {
  if (!isRecord(payload) || !isRecord(payload.cedar_ember)) {
    return null;
  }

  const resetStatus = payload.cedar_ember;
  if (resetStatus.eligible !== true || !Array.isArray(resetStatus.grants)) {
    return null;
  }

  const credits = resetStatus.grants.filter(isRecord).flatMap((grant): ResetCredit[] => {
    const resetsLeft = grant.resets_left;
    const startsAtText = grant.starts_at;
    const endsAtText = grant.ends_at;
    if (
      typeof grant.id !== "string" ||
      !grant.id ||
      typeof resetsLeft !== "number" ||
      !Number.isSafeInteger(resetsLeft) ||
      resetsLeft <= 0 ||
      resetsLeft > 100 ||
      typeof startsAtText !== "string" ||
      typeof endsAtText !== "string" ||
      grant.paused === true
    ) {
      return [];
    }

    const startsAt = parseResetExpiry(startsAtText);
    const endsAt = parseResetExpiry(endsAtText);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt > now || endsAt <= now) {
      return [];
    }

    return Array.from({ length: resetsLeft }, (_, index) => ({
      id: `${grant.id}:${index + 1}`,
      status: "available",
      granted_at: startsAtText,
      expires_at: endsAtText,
      title: typeof grant.label === "string" ? grant.label : null,
    }));
  });

  return { credits, available_count: credits.length };
}
