import { Color, type Image } from "@raycast/api";
import type { ProviderId } from "./types";

type Branding = {
  /** Product name shown on an account's header row. */
  name: string;
  /** Asset filename; the view tints it when an account is loading or broken. */
  icon: Image.Source;
  /** Tint for single-colour marks, so they follow light and dark mode. */
  iconTint?: Color;
  /**
   * Window labels the provider almost always returns. Used only to shape the
   * loading skeleton so rows do not jump once the real response lands.
   */
  skeletonWindows: string[];
};

/**
 * `claude.svg` is the official mark from Simple Icons (CC0); `chatgpt.svg` and
 * `antigravity.svg` are from LobeHub Icons (MIT). `antigravity.png` is
 * rasterised from `antigravity.svg` because macOS's menu bar SVG renderer drops
 * its layered radial gradients.
 */
const BRANDING: Record<ProviderId, Branding> = {
  codex: {
    name: "ChatGPT",
    icon: "chatgpt.svg",
    iconTint: Color.PrimaryText,
    skeletonWindows: ["5h Limit", "Weekly Limit"],
  },
  claude: {
    name: "Claude Code",
    icon: "claude.svg",
    skeletonWindows: ["Session Limit", "Weekly Limit"],
  },
  antigravity: {
    name: "Antigravity",
    icon: "antigravity.png",
    skeletonWindows: ["Gemini 5h", "Gemini Weekly", "Claude/GPT 5h", "Claude/GPT Weekly"],
  },
};

export function getBranding(provider: ProviderId): Branding {
  return BRANDING[provider];
}
