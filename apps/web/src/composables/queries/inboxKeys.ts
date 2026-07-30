export const inboxKeys = {
  list: () => ["inbox-list"] as const,
  detail: (id: string) => ["inbox-detail", id] as const,
  processing: () => ["inbox-processing"] as const,
  count: () => ["inbox-count"] as const,
};
