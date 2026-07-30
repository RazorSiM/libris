import { useQuery } from "@pinia/colada";

export function useLibraryFacetsQuery() {
  const client = useApiClient();

  return useQuery({
    key: ["library", "facets"],
    query: () => client.api.library.facets.$get().then((r) => r.json()),
    staleTime: 30_000,
  });
}

export function useLibraryListQuery(params: {
  page: Ref<number>;
  limit: number;
  debouncedSearch: Ref<string>;
  author: Ref<string | undefined>;
  genre: Ref<string | undefined>;
  language: Ref<string | undefined>;
  series: Ref<string | undefined>;
  uploaderId: Ref<string | undefined>;
  sort: Ref<string>;
}) {
  const client = useApiClient();

  return useQuery({
    key: () => [
      "library",
      {
        page: params.page.value,
        q: params.debouncedSearch.value,
        author: params.author.value,
        genre: params.genre.value,
        language: params.language.value,
        series: params.series.value,
        uploaderId: params.uploaderId.value,
        sort: params.sort.value,
      },
    ],
    query: () =>
      client.api.library
        .$get({
          query: {
            page: String(params.page.value),
            limit: String(params.limit),
            q: params.debouncedSearch.value || "",
            author: params.author.value || "",
            genre: params.genre.value || "",
            language: params.language.value || "",
            series: params.series.value || "",
            uploaderId: params.uploaderId.value || "",
            sort: params.sort.value as "title_asc",
          },
        })
        .then((r) => r.json()),
    staleTime: 30_000,
  });
}
