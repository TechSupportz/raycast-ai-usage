import type { ExtraUsage } from "./providers/types";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatExtraUsage(extra: ExtraUsage): string {
  const spent = dollars.format(extra.usedCredits / 100);
  return extra.monthlyLimit === null
    ? `${spent} spent · no monthly cap`
    : `${spent} / ${dollars.format(extra.monthlyLimit / 100)} spent this month`;
}
