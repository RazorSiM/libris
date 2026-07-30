import { useMutation, useQueryCache } from "@pinia/colada";
import type { ApproveBookBody, ReadingStatusOverrideBody } from "@libris/api-hono/types";
import { inboxKeys } from "../queries/inboxKeys";

export function useApproveBook() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: { id: string; body: ApproveBookBody }) => {
      const res = await client.api.books[":id"].approve.$post({
        param: { id: vars.id },
        json: vars.body,
      });
      return res.json();
    },
    onSettled: () =>
      Promise.all([
        queryCache.invalidateQueries({ key: inboxKeys.list() }),
        queryCache.invalidateQueries({ key: inboxKeys.count() }),
        queryCache.invalidateQueries({ key: ["library"] }),
        queryCache.invalidateQueries({ key: ["series"] }),
      ]),
  });
}

export function useDeleteBook() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (id: string) => {
      await client.api.books[":id"].$delete({ param: { id } });
    },
    onSettled: () =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["library"] }),
        queryCache.invalidateQueries({ key: inboxKeys.list() }),
        queryCache.invalidateQueries({ key: inboxKeys.count() }),
        queryCache.invalidateQueries({ key: ["series"] }),
      ]),
  });
}

export function useEditBook() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: {
      id: string;
      data: {
        title?: string | null;
        author?: string | null;
        description?: string | null;
        publisher?: string | null;
        publishedYear?: number | null;
        language?: string | null;
        pageCount?: number | null;
        isbn10?: string | null;
        isbn13?: string | null;
        genres?: string[];
        tags?: string[];
        series?: string | null;
        seriesIndex?: number | null;
        coverUrl?: string | null;
      };
    }) => {
      await client.api.library[":id"].$patch({
        param: { id: vars.id },
        json: vars.data,
      });
    },
    onSettled: (_data, _error, vars) =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["library", vars.id] }),
        queryCache.invalidateQueries({ key: ["library"] }),
        queryCache.invalidateQueries({ key: ["series"] }),
      ]),
  });
}

export function useReorganizeBook() {
  const client = useApiClient();

  return useMutation({
    mutation: async (id: string) => {
      await client.api.library[":id"].reorganize.$post({ param: { id } });
    },
  });
}

export function useRescanBook() {
  const client = useApiClient();

  return useMutation({
    mutation: async (id: string) => {
      await client.api.inbox[":id"].rescan.$patch({ param: { id } });
    },
  });
}

export function useRefetchMetadata() {
  const client = useApiClient();

  return useMutation({
    mutation: async (id: string) => {
      await client.api.library[":id"].refetch.$post({ param: { id } });
    },
  });
}

export function useSetReadingStatus() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: { id: string; body: ReadingStatusOverrideBody }) => {
      const res = await client.api.library[":id"]["reading-status"].$patch({
        param: { id: vars.id },
        json: vars.body,
      });
      return res.json();
    },
    onSettled: (_data, _error, vars) =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["library", vars.id] }),
        queryCache.invalidateQueries({ key: ["library"] }),
        queryCache.invalidateQueries({ key: ["reading-status"] }),
      ]),
  });
}

export function useClearReadingStatus() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (id: string) => {
      const res = await client.api.library[":id"]["reading-status"].$delete({ param: { id } });
      return res.json();
    },
    onSettled: (_data, _error, id) =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["library", id] }),
        queryCache.invalidateQueries({ key: ["library"] }),
        queryCache.invalidateQueries({ key: ["reading-status"] }),
      ]),
  });
}

export function useApplyMetadata() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: {
      id: string;
      fields: Record<
        string,
        { source: string; value: string | number | boolean | string[] | null }
      >;
    }) => {
      await client.api.library[":id"]["apply-metadata"].$post({
        param: { id: vars.id },
        json: { fields: vars.fields },
      });
    },
    onSettled: (_data, _error, vars) =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["library", vars.id] }),
        queryCache.invalidateQueries({ key: ["library"] }),
        queryCache.invalidateQueries({ key: ["series"] }),
      ]),
  });
}
