import { Cache, LaunchType, launchCommand } from "@raycast/api";

/**
 * Kept in the synchronous cache, which every command of this extension shares,
 * so the menu bar can draw its first frame with the right account.
 */
const cache = new Cache();
const FAVOURITE_KEY = "menu-bar-favourite";

export const MENU_BAR_COMMAND = "menu-bar-usage";

export function readFavourite(): string | null {
  return cache.get(FAVOURITE_KEY) ?? null;
}

/**
 * Saves the account to show in the menu bar, then asks the menu bar command to
 * redraw. That launch fails when the user has not activated the menu bar
 * command, which is fine: it reads the favourite the next time it runs.
 */
export async function writeFavourite(id: string): Promise<void> {
  cache.set(FAVOURITE_KEY, id);

  try {
    await launchCommand({ name: MENU_BAR_COMMAND, type: LaunchType.Background });
  } catch {
    // Menu bar command not activated.
  }
}
