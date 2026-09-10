/** Moves the selected account to the front without disturbing the others. */
export function prioritizeAccount<T extends { id: string }>(accounts: readonly T[], priorityId?: string): T[] {
  const priorityIndex = priorityId ? accounts.findIndex((account) => account.id === priorityId) : -1;

  if (priorityIndex <= 0) {
    return [...accounts];
  }

  const ordered = [...accounts];
  const [priority] = ordered.splice(priorityIndex, 1);
  ordered.unshift(priority);
  return ordered;
}
