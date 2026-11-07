import {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  List,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { Fragment, useState, type ReactElement } from "react";
import { getProgressIcon } from "@raycast/utils";
import { useAccounts, type AccountState } from "./use-accounts";
import { getGlanceWindow } from "./account-display";
import { formatResetTimeRemaining, parseResetExpiry } from "./reset-expiry";
import { getBranding } from "./providers/branding";
import { getPace, type Pace } from "./pace";
import {
  clampPercent,
  formatPercent,
  formatResetDate,
  formatTimeUntil,
  formatUpdatedAt,
  getRemaining,
  pickMenuBarAccount,
} from "./menu-bar-display";
import { readFavourite, writeFavourite } from "./menu-bar-favourite";
import type { Account, AccountFailure, ResetCredit, ResetCreditsResponse } from "./providers/types";

export default function Command() {
  const { showUsageUsed } = getPreferenceValues<{ showUsageUsed: boolean }>();
  const { states, isLoading, refresh, rename, move, initialSelectedId } = useAccounts();
  // Controlled from the first render onwards, so nothing re-selects a row as
  // the accounts stream in one by one.
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId);
  // Null means no explicit favourite: the menu bar then shows the first account.
  const [favouriteId, setFavouriteId] = useState(readFavourite);
  const menuBarId = pickMenuBarAccount(
    states.map((state) => state.config),
    favouriteId,
  )?.id;
  const refreshAction = (
    <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} shortcut={{ modifiers: ["cmd"], key: "r" }} />
  );

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={states.length > 0}
      searchBarPlaceholder="Filter accounts…"
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
    >
      {states.length === 0 ? (
        <List.EmptyView
          icon={Icon.Gauge}
          title="No Accounts Configured"
          description="Add an account with codex-auth, or turn on ChatGPT or Claude Code in this extension's preferences."
          actions={
            <ActionPanel>
              <Action title="Open Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
            </ActionPanel>
          }
        />
      ) : null}
      {states.map((state, index) => (
        <AccountItem
          key={state.config.id}
          state={state}
          showUsageUsed={showUsageUsed}
          refreshAction={refreshAction}
          isInMenuBar={state.config.id === menuBarId}
          onShowInMenuBar={async () => {
            setFavouriteId(state.config.id);
            await writeFavourite(state.config.id);
            await showToast({ style: Toast.Style.Success, title: `Showing ${state.config.label} in the menu bar` });
          }}
          onRename={rename}
          onMoveUp={index > 0 ? () => move(state.config.id, -1) : undefined}
          onMoveDown={index < states.length - 1 ? () => move(state.config.id, 1) : undefined}
        />
      ))}
    </List>
  );
}

function AccountItem({
  state,
  showUsageUsed,
  refreshAction,
  isInMenuBar,
  onShowInMenuBar,
  onRename,
  onMoveUp,
  onMoveDown,
}: {
  state: AccountState;
  showUsageUsed: boolean;
  refreshAction: ReactElement;
  /** Whether this is the account the AI Usage in Menu Bar command shows. */
  isInMenuBar: boolean;
  onShowInMenuBar: () => Promise<void>;
  onRename: RenameHandler;
  /** Absent when the account is already first, so the action is hidden. */
  onMoveUp?: () => void;
  /** Absent when the account is already last. */
  onMoveDown?: () => void;
}) {
  const { config, account, isStale } = state;
  const branding = getBranding(config.provider);
  const resets = account?.resets ? getAvailableResets(account.resets) : [];

  return (
    <List.Item
      id={config.id}
      icon={{ source: branding.icon, tintColor: getBrandTint(account) ?? branding.iconTint }}
      title={config.label}
      keywords={[branding.name, account?.email ?? "", formatPlan(account?.plan ?? null) ?? ""]}
      accessories={[
        ...(isInMenuBar
          ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow }, tooltip: "Shown in the menu bar" }]
          : []),
        ...getAccessories(account, isStale, state.refreshError, showUsageUsed),
      ]}
      detail={
        <AccountDetail
          state={state}
          resets={resets}
          resetCount={account?.resets?.available_count ?? null}
          showUsageUsed={showUsageUsed}
        />
      }
      actions={
        <ActionPanel>
          {account?.id === "codex-auth:unavailable" ? (
            <Action.CopyToClipboard
              title="Copy Codex-Auth Install Command"
              icon={Icon.Download}
              content="npm install -g @loongphy/codex-auth"
            />
          ) : null}
          {refreshAction}
          {isInMenuBar ? null : (
            <Action
              title="Show in Menu Bar"
              icon={Icon.Star}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
              onAction={onShowInMenuBar}
            />
          )}
          <Action.Push
            title="Rename Account"
            icon={Icon.Pencil}
            shortcut={{ modifiers: ["cmd"], key: "e" }}
            target={<RenameForm state={state} onRename={onRename} />}
          />
          {onMoveUp ? (
            <Action
              title="Move up"
              icon={Icon.ArrowUp}
              shortcut={{ modifiers: ["cmd", "opt"], key: "arrowUp" }}
              onAction={onMoveUp}
            />
          ) : null}
          {onMoveDown ? (
            <Action
              title="Move Down"
              icon={Icon.ArrowDown}
              shortcut={{ modifiers: ["cmd", "opt"], key: "arrowDown" }}
              onAction={onMoveDown}
            />
          ) : null}
          {account?.email ? (
            <Action.CopyToClipboard title="Copy Account Email" content={account.email} icon={Icon.Envelope} />
          ) : null}
          <Action title="Open Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

type RenameHandler = (id: string, name: string) => Promise<void>;

/**
 * Renames an account for display only; codex-auth continues to own its
 * credentials. Submitting an empty field restores the account email.
 */
function RenameForm({ state, onRename }: { state: AccountState; onRename: RenameHandler }) {
  const { pop } = useNavigation();
  const [name, setName] = useState(state.config.label);

  return (
    <Form
      navigationTitle={`Rename ${state.config.label}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Name"
            icon={Icon.Check}
            onSubmit={async () => {
              await onRename(state.config.id, name);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder={state.configuredLabel}
        info="Shown in the list instead of the configured label. Leave empty to go back to the default."
        value={name}
        onChange={setName}
      />
      <Form.Description title="Provider" text={getBranding(state.config.provider).name} />
      {state.account?.email ? <Form.Description title="Account" text={state.account.email} /> : null}
    </Form>
  );
}

/**
 * The list is narrow in detail mode, so the accessory carries only the single
 * preferred glance window - enough to triage without opening each account.
 */
function getAccessories(
  account: Account | null,
  isStale: boolean,
  refreshError: AccountFailure | null,
  showUsageUsed: boolean,
): List.Item.Accessory[] {
  if (account === null) {
    return [{ tag: { value: "…", color: Color.SecondaryText } }];
  }

  if (account.failure) {
    return [
      {
        icon: {
          source: account.failure.kind === "expired" ? Icon.Key : Icon.Warning,
          tintColor: account.failure.kind === "expired" ? Color.Yellow : Color.Red,
        },
        tooltip: account.failure.message,
      },
    ];
  }

  const glanceWindow = getGlanceWindow(account.provider, account.windows);
  const accessories: List.Item.Accessory[] = [];

  if (glanceWindow) {
    const remaining = getRemaining(glanceWindow);
    const percent = showUsageUsed ? clampPercent(glanceWindow.usedPercent) : remaining;
    accessories.push({
      icon: getProgressIcon(percent / 100, getRemainingColor(remaining)),
      text: `${formatPercent(percent)}%`,
      tooltip: `${glanceWindow.label}: ${formatPercent(percent)}% ${showUsageUsed ? "used" : "left"}`,
    });
  }

  if (isStale) {
    accessories.unshift({
      icon: Icon.ArrowClockwise,
      tooltip: "Showing the last known values while refreshing…",
    });
  }

  if (refreshError) {
    accessories.unshift({
      icon: { source: Icon.Warning, tintColor: Color.Orange },
      tooltip: `Could not refresh: ${refreshError.message}`,
    });
  }

  return accessories;
}

/**
 * The pane reads as a stack of small blocks - one per usage window, then the
 * account itself, its banked resets, and when we last looked - with a rule
 * between each. Empty blocks drop out rather than leaving a rule behind.
 */
function AccountDetail({
  state,
  resets,
  resetCount,
  showUsageUsed,
}: {
  state: AccountState;
  resets: ResetCredit[];
  resetCount: number | null;
  showUsageUsed: boolean;
}) {
  const sections = [
    ...buildWindowSections(state, showUsageUsed),
    buildAccountRows(state),
    buildResetRows(resets, resetCount),
    buildMetaRows(state),
  ]
    .filter((rows) => rows.length > 0)
    .map((rows, index) => (
      <Fragment key={index}>
        {index > 0 ? <List.Item.Detail.Metadata.Separator /> : null}
        {rows}
      </Fragment>
    ));

  return (
    <List.Item.Detail
      markdown={buildMarkdown(state)}
      metadata={<List.Item.Detail.Metadata>{sections}</List.Item.Detail.Metadata>}
    />
  );
}

/**
 * One block per window: usage in the preferred display mode, and when it resets. While an
 * account is still loading we list the windows this provider usually returns,
 * so the pane keeps its shape instead of jumping when the real response lands.
 */
function buildWindowSections({ config, account }: AccountState, showUsageUsed: boolean): ReactElement[][] {
  if (account === null) {
    return getBranding(config.provider).skeletonWindows.map((label) => [
      <List.Item.Detail.Metadata.Label
        key={label}
        title={label}
        text={{ value: "Checking…", color: Color.SecondaryText }}
      />,
    ]);
  }

  if (account.failure) {
    return [
      [
        <List.Item.Detail.Metadata.TagList key="status" title="Status">
          <List.Item.Detail.Metadata.TagList.Item
            text={account.failure.kind === "expired" ? "Signed Out" : "Unavailable"}
            color={account.failure.kind === "expired" ? Color.Yellow : Color.Red}
          />
        </List.Item.Detail.Metadata.TagList>,
      ],
    ];
  }

  // Two lines per window: usage and its pace as pills, then a plain
  // line for when it comes back.
  return account.windows.map((window) => {
    const remaining = getRemaining(window);
    const percent = showUsageUsed ? clampPercent(window.usedPercent) : remaining;
    const resetsAt = window.resetsAt;
    const pace = getPace(window);
    const rows = [
      <List.Item.Detail.Metadata.TagList key={window.id} title={window.label}>
        <List.Item.Detail.Metadata.TagList.Item
          text={`${formatPercent(percent)}% ${showUsageUsed ? "used" : "left"}`}
          icon={getProgressIcon(percent / 100, getRemainingColor(remaining))}
          color={getRemainingColor(remaining)}
        />
        {pace ? (
          <List.Item.Detail.Metadata.TagList.Item
            icon={{ source: PACE_ICONS[pace.status], tintColor: PACE_COLORS[pace.status] }}
            color={PACE_COLORS[pace.status]}
          />
        ) : null}
      </List.Item.Detail.Metadata.TagList>,
    ];

    if (resetsAt) {
      rows.push(
        <List.Item.Detail.Metadata.Label
          key={`${window.id}-resets`}
          title="Resets"
          text={`in ${formatTimeUntil(resetsAt)} · ${formatResetDate(resetsAt)}`}
        />,
      );
    }

    return rows;
  });
}

/** Pace reads as a chevron: burning faster than the window, level with it, or slower. */
const PACE_ICONS: Record<Pace["status"], Icon> = {
  under: Icon.ChevronDownSmall,
  on: Icon.Minus,
  over: Icon.ChevronUpSmall,
};

/** Under pace is unremarkable, on pace is a quiet confirmation, over pace is a warning. */
const PACE_COLORS: Record<Pace["status"], Color> = {
  under: Color.SecondaryText,
  on: Color.Blue,
  over: Color.Orange,
};

/** Who this account is: the product and plan as one line, then the signed-in address. */
function buildAccountRows({ config, account }: AccountState): ReactElement[] {
  const branding = getBranding(config.provider);
  const plan = formatPlan(account?.plan ?? null);
  const product = config.provider === "codex" ? "ChatGPT" : "Claude";
  const rows = [
    <List.Item.Detail.Metadata.Label
      key="plan"
      title="Plan"
      text={plan ? `${product} ${plan}` : product}
      icon={{ source: branding.icon, tintColor: branding.iconTint }}
    />,
  ];

  if (account?.email) {
    rows.push(<List.Item.Detail.Metadata.Label key="email" title="Account" text={account.email} icon={Icon.Person} />);
  }

  return rows;
}

/** How current these numbers are, and anything that went wrong getting them. */
function buildMetaRows({ fetchedAt, refreshError }: AccountState): ReactElement[] {
  const rows: ReactElement[] = [];

  if (fetchedAt !== null) {
    rows.push(
      <List.Item.Detail.Metadata.Label
        key="updated"
        title="Updated"
        text={formatUpdatedAt(fetchedAt)}
        icon={Icon.Clock}
      />,
    );
  }

  if (refreshError) {
    rows.push(
      <List.Item.Detail.Metadata.Label
        key="refresh-error"
        title="Refresh Failed"
        text={refreshError.message}
        icon={{ source: Icon.Warning, tintColor: Color.Orange }}
      />,
    );
  }

  return rows;
}

/** Only states that need a sentence get prose; healthy accounts are metadata alone. */
function buildMarkdown({ config, account }: AccountState): string | undefined {
  if (account?.failure) {
    return [`# ${config.label}`, account.failure.message].join("\n\n");
  }

  if (account && account.windows.length === 0) {
    return [`# ${config.label}`, "This account reported no usage limits."].join("\n\n");
  }

  return undefined;
}

/**
 * Every banked reset, soonest to expire first. They were behind a pushed view
 * when the pane was busier; there is room for them here now.
 */
function buildResetRows(credits: ResetCredit[], availableCount: number | null): ReactElement[] {
  if (availableCount === null) {
    return [];
  }

  return [
    <List.Item.Detail.Metadata.TagList key="available" title="Usage Resets">
      <List.Item.Detail.Metadata.TagList.Item text={`${availableCount} available`} color={Color.Purple} />
    </List.Item.Detail.Metadata.TagList>,
    ...credits.map((credit, index) => (
      <List.Item.Detail.Metadata.TagList key={credit.id} title={`Reset ${index + 1}`}>
        <List.Item.Detail.Metadata.TagList.Item text={formatExpiryDate(credit.expires_at)} color={Color.PrimaryText} />
        <List.Item.Detail.Metadata.TagList.Item
          text={formatTimeRemainingTag(credit.expires_at)}
          color={getResetExpiryColor(credit.expires_at)}
        />
      </List.Item.Detail.Metadata.TagList>
    )),
  ];
}

function getBrandTint(account: Account | null): Color | undefined {
  if (account === null) {
    return Color.SecondaryText;
  }

  if (!account.failure) {
    return undefined;
  }

  return account.failure.kind === "expired" ? Color.Yellow : Color.Red;
}

function getAvailableResets(response: ResetCreditsResponse): ResetCredit[] {
  return response.credits
    .filter((credit) => credit.status === "available")
    .sort((a, b) => parseResetExpiry(a.expires_at) - parseResetExpiry(b.expires_at));
}

function formatPlan(plan: string | null): string | null {
  if (!plan || plan === "unknown") {
    return null;
  }

  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatTimeRemainingTag(date: string): string {
  const remaining = formatResetTimeRemaining(date);

  return remaining === "Expired" ? remaining : `${remaining} left`;
}

function formatExpiryDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(parseResetExpiry(date));
}

function getResetExpiryColor(date: string): Color {
  const daysRemaining = (parseResetExpiry(date) - Date.now()) / (24 * 60 * 60 * 1000);

  if (daysRemaining < 7) {
    return Color.Red;
  }

  return daysRemaining <= 14 ? Color.Yellow : Color.Green;
}

function getRemainingColor(remainingPercent: number): Color {
  if (remainingPercent <= 20) {
    return Color.Red;
  }

  return remainingPercent < 50 ? Color.Yellow : Color.Green;
}
