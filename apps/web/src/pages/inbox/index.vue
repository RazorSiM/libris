<script setup lang="ts">
import { defineComponent, h, ref, resolveComponent, watch, type PropType } from "vue";
import type { TableColumn, TableRow } from "@nuxt/ui";
import { useLocalStorage } from "@vueuse/core";
import { useQueryCache } from "@pinia/colada";
import { inboxKeys } from "~/composables/queries/inboxKeys";

const UBadge = resolveComponent("UBadge");

useDashboard();

useHead({
  title: "Inbox",
});

const router = useRouter();
const queryCache = useQueryCache();

const { search, debouncedSearch } = useDebouncedSearch();
const page = ref(1);
const limit = DEFAULT_PAGE_SIZE;
const sort = useLocalStorage("inbox-sort", "detected_newest");
const uploadModalOpen = ref(false);

const sortOptions = [
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
  { label: "Newest first", value: "detected_newest" },
  { label: "Oldest first", value: "detected_oldest" },
  { label: "Status A-Z", value: "status_asc" },
  { label: "Status Z-A", value: "status_desc" },
];

const { data, status, refresh } = useInboxListQuery({
  page,
  search: debouncedSearch,
  sort,
  limit,
});

// Reset to page 1 when filters change
watch([debouncedSearch, sort], () => {
  page.value = 1;
});

interface InboxRow {
  id: string;
  coverUrl: string | null;
  coverSrc: string | null;
  title: string;
  uploaderLabel: string | null;
  format: string;
  status: "inbox" | "review" | "organized";
  createdAt: string;
}

function inboxCoverUrl(id: string): string {
  return `/api/inbox/${id}/cover`;
}

/**
 * Resolve the best cover image source for an inbox book.
 * Prefers external coverUrl (instant, no extraction). Falls back to the
 * extraction endpoint only when the book has an EPUB file (which may
 * contain an embedded cover). Returns null for non-EPUB items with no
 * HTTP coverUrl — the UI shows a placeholder instead of firing a request
 * that will always 404.
 */
function resolveInboxCover(book: {
  id: string;
  coverUrl: string | null;
  files: { format: string }[];
}): string | null {
  if (book.coverUrl?.startsWith("http")) {
    return book.coverUrl;
  }
  if (book.files?.some((f) => f.format === "epub")) {
    return inboxCoverUrl(book.id);
  }
  return null;
}

const rows = computed<InboxRow[]>(() => {
  return (data.value?.data ?? []).map((book) => ({
    id: book.id,
    coverUrl: null,
    coverSrc: resolveInboxCover(book),
    title: book.title || book.files[0]?.originalName || "Unknown",
    uploaderLabel: book.uploader?.label ?? null,
    format: book.files[0]?.format ?? "-",
    status: book.status as InboxRow["status"],
    createdAt: String(book.createdAt),
  }));
});

// Processing status — updated via WebSocket events and useQuery
const hasInboxBooks = computed(() => rows.value.some((r) => r.status === "inbox"));

const { data: processingData, refetch: refetchProcessing } = useInboxProcessingQuery(hasInboxBooks);

const processingMap = computed<Record<string, { stage: string; label: string }>>(
  () => processingData.value ?? {},
);

// WebSocket: listen for real-time updates from the backend
const { on } = useServerEvents();

on("book:detected", () => {
  queryCache.invalidateQueries({ key: inboxKeys.list() });
  queryCache.invalidateQueries({ key: inboxKeys.count() });
});

on("book:parsed", () => {
  refetchProcessing();
});

on("book:metadata-ready", () => {
  queryCache.invalidateQueries({ key: inboxKeys.list() });
  queryCache.invalidateQueries({ key: inboxKeys.count() });
  refetchProcessing();
});

on("book:organized", () => {
  queryCache.invalidateQueries({ key: inboxKeys.list() });
  queryCache.invalidateQueries({ key: inboxKeys.count() });
  queryCache.invalidateQueries({ key: ["series"] });
});

const UIcon = resolveComponent("UIcon");

/** Inline cover cell component — renders image with error fallback to placeholder. */
const CoverCell = defineComponent({
  props: { src: { type: [String, null] as unknown as PropType<string | null>, default: null } },
  setup(props) {
    const failed = ref(false);
    watch(
      () => props.src,
      () => {
        failed.value = false;
      },
    );
    return () => {
      if (props.src && !failed.value) {
        return h("img", {
          src: props.src,
          alt: "",
          class: "w-[40px] h-[60px] object-cover rounded",
          loading: "lazy",
          decoding: "async",
          onError: () => {
            failed.value = true;
          },
        });
      }
      return h(
        "div",
        { class: "w-[40px] h-[60px] rounded bg-elevated flex items-center justify-center" },
        [h(UIcon, { name: "i-lucide-book-open", class: "text-lg text-muted" })],
      );
    };
  },
});

const columns: TableColumn<InboxRow>[] = [
  {
    accessorKey: "coverSrc",
    header: "",
    cell: ({ row }) => h(CoverCell, { src: row.original.coverSrc }),
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => {
      return h("div", { class: "min-w-0" }, [
        h("p", { class: "truncate text-sm text-highlighted" }, row.original.title),
        row.original.uploaderLabel
          ? h(
              "p",
              { class: "truncate text-xs text-muted mt-0.5" },
              `Uploaded by ${row.original.uploaderLabel}`,
            )
          : null,
      ]);
    },
  },
  {
    accessorKey: "format",
    header: "Format",
    cell: ({ row }) => {
      return h(
        "span",
        { class: "uppercase text-xs font-medium text-muted" },
        row.getValue("format"),
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const bookId = row.original.id;
      const bookStatus = row.getValue("status") as string;
      const stage = processingMap.value[bookId];

      // Show processing stage for books still being processed
      if (bookStatus === "inbox" && stage) {
        return h("div", { class: "flex items-center gap-1.5" }, [
          h(UIcon, {
            name: "i-lucide-loader-circle",
            class: "size-3.5 text-warning animate-spin",
          }),
          h("span", { class: "text-xs text-muted" }, stage.label),
        ]);
      }

      const color = (
        {
          inbox: "neutral" as const,
          review: "info" as const,
          organized: "success" as const,
        } as Record<string, "neutral" | "info" | "success">
      )[bookStatus];

      return h(
        UBadge,
        { "data-testid": "status-badge", class: "capitalize", variant: "subtle", color },
        () => bookStatus,
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Detected",
    cell: ({ row }) => {
      return new Date(row.getValue("createdAt")).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    },
  },
];

const totalPages = computed(() => data.value?.pagination?.totalPages ?? 1);

function onSelect(_e: Event, row: TableRow<InboxRow>) {
  router.push(`/inbox/${row.original.id}`);
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Inbox">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <UButton
              data-testid="upload-btn"
              label="Upload"
              icon="i-lucide-upload"
              color="primary"
              @click="uploadModalOpen = true"
            />

            <div class="w-px h-6 bg-accented" />

            <USelect
              v-model="sort"
              :items="sortOptions"
              icon="i-lucide-arrow-up-down"
              class="w-44"
              data-testid="sort-select"
            />

            <div class="w-px h-6 bg-accented" />

            <UInput
              v-model="search"
              icon="i-lucide-search"
              placeholder="Search books..."
              class="w-64"
              data-testid="search-input"
            />

            <div class="w-px h-6 bg-accented" />

            <ColorModeToggle />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <ApiError v-if="status === 'error'" message="Could not load inbox" @retry="refresh" />

      <UTable
        v-else
        :data="rows"
        :columns="columns"
        :loading="status === 'pending'"
        class="w-full"
        @select="onSelect"
      />

      <div
        v-if="totalPages > 1"
        data-testid="pagination"
        class="flex justify-center py-4 border-t border-accented"
      >
        <UPagination
          v-model:page="page"
          :total="data?.pagination?.total ?? 0"
          :items-per-page="limit"
        />
      </div>

      <div
        v-if="status === 'success' && rows.length === 0"
        class="flex items-center justify-center py-12"
      >
        <p data-testid="empty-inbox" class="text-muted">No books in inbox</p>
      </div>
    </template>
  </UDashboardPanel>

  <UploadBookModal
    :open="uploadModalOpen"
    @update:open="uploadModalOpen = $event"
    @uploaded="() => queryCache.invalidateQueries({ key: ['inbox'] })"
  />
</template>
