import {
  Color,
  Icon,
  Image,
  Keyboard,
  LaunchType,
  MenuBarExtra,
  getPreferenceValues,
  launchCommand,
  openExtensionPreferences,
} from "@raycast/api";
import { getProgressIcon as drawProgressRing } from "@raycast/utils";
import { useState } from "react";
import { useAccounts, type AccountState } from "./use-accounts";
import { getGlanceWindow } from "./account-display";
import { getBranding } from "./providers/branding";
import { readFavourite, writeFavourite } from "./menu-bar-favourite";
import {
  formatMenuBarTitle,
  formatPercent,
  formatTimeUntil,
  formatUpdatedAt,
  getDisplayedPercent,
  getLatestFetchedAt,
  getRemaining,
  pickMenuBarAccount,
} from "./menu-bar-display";
import type { UsageWindow } from "./providers/types";

type Preferences = {
  showUsageUsed: boolean;
  showResetTime: boolean;
};

/**
 * Shows the favourite account's glance window (the 5-hour / session limit when
 * there is one) in the menu bar, with every account's windows in the menu.
 * Shares `useAccounts`, and with it the cache, with the View AI Usage command.
 */
export default function Command() {
  const { showUsageUsed, showResetTime } = getPreferenceValues<Preferences>();
  const { states, isLoading, refresh } = useAccounts();
  const [favouriteId, setFavouriteId] = useState(readFavourite);
  const featuredId = pickMenuBarAccount(
    states.map((state) => state.config),
    favouriteId,
  )?.id;
  const featured = states.find((state) => state.config.id === featuredId) ?? null;

  return (
    <MenuBarExtra isLoading={isLoading} {...getTitle(featured, { showUsageUsed, showResetTime })}>
      {states.length === 0 ? (
        <MenuBarExtra.Item title="No accounts configured" onAction={openExtensionPreferences} />
      ) : null}
      {states.map((state) => (
        <AccountSection key={state.config.id} state={state} showUsageUsed={showUsageUsed} />
      ))}
      {states.length > 1 ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Submenu title="Show in Menu Bar" icon={Icon.Star}>
            {states.map((state) => (
              <MenuBarExtra.Item
                key={state.config.id}
                title={state.config.label}
                subtitle={getBranding(state.config.provider).name}
                icon={state.config.id === featured?.config.id ? Icon.Checkmark : undefined}
                onAction={async () => {
                  setFavouriteId(state.config.id);
                  await writeFavourite(state.config.id);
                }}
              />
            ))}
          </MenuBarExtra.Submenu>
        </MenuBarExtra.Section>
      ) : null}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          {...getRefreshText(isLoading, getLatestFetchedAt(states))}
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={refresh}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

/** The menu bar's own icon, title and tooltip for the featured account. */
function getTitle(
  state: AccountState | null,
  options: { showUsageUsed: boolean; showResetTime: boolean },
): { icon: MenuBarExtra.Props["icon"]; title?: string; tooltip: string } {
  if (state === null) {
    return { icon: Icon.Gauge, tooltip: "AI Usage: no accounts configured" };
  }

  const { config, account } = state;
  const branding = getBranding(config.provider);
  const icon = { source: branding.icon, tintColor: branding.iconTint };

  if (account === null) {
    return { icon, title: "…", tooltip: `${config.label}: checking…` };
  }

  if (account.failure) {
    return {
      icon: { source: account.failure.kind === "expired" ? Icon.Key : Icon.Warning, tintColor: Color.Orange },
      tooltip: `${config.label}: ${account.failure.message}`,
    };
  }

  const window = getGlanceWindow(account.provider, account.windows);

  if (window === null) {
    return { icon, tooltip: `${config.label}: no usage limits reported` };
  }

  return {
    icon,
    title: formatMenuBarTitle(window, options),
    tooltip: `${config.label} · ${describeWindow(window, options.showUsageUsed)}`,
  };
}

function AccountSection({ state, showUsageUsed }: { state: AccountState; showUsageUsed: boolean }) {
  const { config, account } = state;
  const branding = getBranding(config.provider);
  // Claude Code's label is its product name, so it would read "Claude Code · Claude Code".
  const title = config.label === branding.name ? branding.name : `${branding.name} · ${config.label}`;

  if (account === null) {
    return (
      <MenuBarExtra.Section title={title}>
        <MenuBarExtra.Item title="Checking…" />
      </MenuBarExtra.Section>
    );
  }

  if (account.failure) {
    return (
      <MenuBarExtra.Section title={title}>
        <MenuBarExtra.Item
          title={account.failure.kind === "expired" ? "Signed out" : "Unavailable"}
          icon={{ source: Icon.Warning, tintColor: account.failure.kind === "expired" ? Color.Yellow : Color.Red }}
          tooltip={account.failure.message}
          onAction={openUsageView}
        />
      </MenuBarExtra.Section>
    );
  }

  return (
    <MenuBarExtra.Section title={title}>
      {state.refreshError ? (
        <MenuBarExtra.Item
          title="Couldn't refresh"
          subtitle={state.fetchedAt === null ? undefined : `last updated ${describeUpdatedAt(state.fetchedAt)}`}
          icon={{ source: Icon.Warning, tintColor: Color.Orange }}
          tooltip={state.refreshError.message}
          onAction={openUsageView}
        />
      ) : null}
      {account.windows.map((window) => (
        <MenuBarExtra.Item
          key={window.id}
          title={window.label}
          subtitle={describeUsage(window, showUsageUsed)}
          icon={getProgressIcon(window, showUsageUsed)}
          onAction={openUsageView}
        />
      ))}
    </MenuBarExtra.Section>
  );
}

/**
 * Refresh doubles as the "when are these from" line. Clicking any item closes
 * the menu, so on reopening this tells you whether the refresh has landed.
 * It lives on Refresh rather than its own row because the menu draws an item
 * with no action as disabled, and that row came out as a bare icon.
 */
function getRefreshText(isLoading: boolean, fetchedAt: number | null): { title: string; subtitle?: string } {
  const updated = fetchedAt === null ? undefined : `updated ${describeUpdatedAt(fetchedAt)}`;

  return { title: isLoading ? "Refreshing…" : "Refresh", subtitle: updated };
}

/** "just now", "5m ago" or a date, to follow "updated" mid-sentence. */
function describeUpdatedAt(fetchedAt: number): string {
  const text = formatUpdatedAt(fetchedAt);

  return text === "Just now" ? "just now" : text;
}

/** "58% left · resets in 2h 3m" */
function describeUsage(window: UsageWindow, showUsageUsed: boolean): string {
  const percent = `${formatPercent(getDisplayedPercent(window, showUsageUsed))}% ${showUsageUsed ? "used" : "left"}`;

  return window.resetsAt === null ? percent : `${percent} · resets in ${formatTimeUntil(window.resetsAt)}`;
}

function describeWindow(window: UsageWindow, showUsageUsed: boolean): string {
  return `${window.label}: ${describeUsage(window, showUsageUsed)}`;
}

/**
 * The same smooth ring as View AI Usage. `getProgressIcon` writes the colour
 * into an SVG as Raycast's colour name (e.g. "raycast-green"), which the list
 * understands but the menu bar draws as a plain image and cannot resolve, so
 * the arc came out dark. Real hex colours fix that, with one ring per
 * appearance so the unfilled track suits a light or dark menu.
 */
function getProgressIcon(window: UsageWindow, showUsageUsed: boolean): Image.ImageLike {
  const progress = getDisplayedPercent(window, showUsageUsed) / 100;
  const colors = RING_COLORS[getUsageLevel(window)];

  return {
    source: {
      light: drawProgressRing(progress, colors.light, { background: "black", backgroundOpacity: 0.15 }),
      dark: drawProgressRing(progress, colors.dark, { background: "white", backgroundOpacity: 0.2 }),
    },
  };
}

type UsageLevel = "healthy" | "low" | "critical";

/** macOS system green, yellow and red, in their light and dark variants. */
const RING_COLORS: Record<UsageLevel, { light: string; dark: string }> = {
  healthy: { light: "#28A745", dark: "#30D158" },
  low: { light: "#E0A800", dark: "#FFD60A" },
  critical: { light: "#FF3B30", dark: "#FF453A" },
};

/** Same thresholds as View AI Usage: 20% or less left is critical, under 50% is low. */
function getUsageLevel(window: UsageWindow): UsageLevel {
  const remaining = getRemaining(window);

  if (remaining <= 20) {
    return "critical";
  }

  return remaining < 50 ? "low" : "healthy";
}

async function openUsageView() {
  await launchCommand({ name: "view-usage", type: LaunchType.UserInitiated });
}
