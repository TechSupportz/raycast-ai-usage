# AI Usage

Raycast extension for checking your ChatGPT and Claude Code usage limits from the command palette.

## What it shows

For each account, one section listing its main rate-limit windows:

- **ChatGPT** — the 5-hour and weekly limits, plus banked usage resets
- **Claude Code** — the session and weekly limits, plus available saved usage resets

Every window shows how much you have left, coloured by how close you are to the limit. Its reset time appears when the provider reports a machine-readable timestamp.

Enable **Show usage used** in the extension preferences to show the percentage used instead, in both the account list and every usage window. Colours still indicate how close you are to the limit.

## Menu bar

Run **AI Usage in Menu Bar** once to pin it to the macOS menu bar. It shows one account's 5-hour (ChatGPT) or session (Claude Code) limit, falling back to the weekly limit when there is none. Open the menu to see every account's windows.

Pick which account the menu bar shows with **Show in Menu Bar** (⌘⇧M) in View AI Usage, or from the **Show in Menu Bar** submenu. The chosen account has a star in the list. Without a choice, the first account in your order is shown.

The menu bar refreshes every 5 minutes and shares its cache with View AI Usage. Turn on **Show time until reset** in the command's preferences to add the reset countdown to the title, e.g. `58% · 2h 3m`.

## Multiple ChatGPT accounts

ChatGPT account discovery requires [codex-auth](https://github.com/loongphy/codex-auth). Install it globally with npm or Bun:

```bash
npm install -g @loongphy/codex-auth
# or
bun add -g @loongphy/codex-auth
```

Sign in to each account with `codex-auth`, then confirm they appear:

```bash
codex-auth login
codex-auth list
```

Every managed account appears automatically in Raycast. Use **Rename Account** to give an email a shorter display name. Use **Move up** and **Move Down** (⌘⌥↑ and ⌘⌥↓) to reorder the list; the order is remembered.

## Requirements

- macOS
- [Raycast](https://www.raycast.com/)
- For ChatGPT limits: [codex-auth](https://github.com/loongphy/codex-auth) installed globally with at least one signed-in account
- For Claude Code limits: [Claude Code](https://claude.com/claude-code) installed and signed in

## Credentials

ChatGPT credentials stay owned by `codex-auth`. The extension reads its account registry and asks `codex-auth` for live usage. Claude Code is refreshed directly using its stored OAuth refresh token, without making an inference request. The extension coordinates with Claude Code's refresh lock, re-reads credentials after acquiring it, and saves rotated credentials back to the same source before using them.

Claude Code credentials are read from the macOS Keychain, falling back to `~/.claude/.credentials.json`.

## Usage

1. Install `codex-auth` and sign in to your ChatGPT accounts.
2. Install the extension in Raycast.
3. Run `View AI Usage`.
4. Review your limits. `⌘R` refreshes.

## Troubleshooting

**A codex-auth account is missing** — confirm it appears in `codex-auth list`.

**codex-auth will not load** — confirm `codex-auth list` works in Terminal, or reinstall it using one of the commands above.

## Development

```bash
npm install
npm run dev
```

### Updating a local install

```bash
npm run update
```

Pulls the latest changes, runs `ray develop` until Raycast has imported the new build, runs `ray build`, then stops the dev server. If the dev build fails or takes longer than two minutes, it prints the log and stops. Run `npm install` first if the pull changed dependencies.

## License

MIT
