import { useMutation, useQueryCache } from "@pinia/colada";

export function usePauseQueue() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (name: string) => {
      await client.api.jobs.queues[":name"].pause.$post({ param: { name } });
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings", "status"] }),
  });
}

export function useResumeQueue() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (name: string) => {
      await client.api.jobs.queues[":name"].resume.$post({ param: { name } });
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings", "status"] }),
  });
}

export function useCleanQueue() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (name: string) => {
      const res = await client.api.jobs.queues[":name"].clean.$post({
        param: { name },
      });
      return (await res.json()) as {
        success: boolean;
        queue: string;
        removed: number;
      };
    },
    onSettled: () =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["settings", "status"] }),
        queryCache.invalidateQueries({ key: ["jobs", "list"] }),
      ]),
  });
}

export function useDrainQueue() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (name: string) => {
      await client.api.jobs.queues[":name"].drain.$post({ param: { name } });
    },
    onSettled: () =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["settings", "status"] }),
        queryCache.invalidateQueries({ key: ["jobs", "list"] }),
      ]),
  });
}

export function useRetryJob() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (args: { id: string; queueName: string }) => {
      await client.api.jobs[":id"].retry.$post({
        param: { id: args.id },
        query: { queueName: args.queueName },
      });
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings", "status"] }),
  });
}
