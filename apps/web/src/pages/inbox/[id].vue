<script lang="ts">
import { defineColadaLoader } from "vue-router/experimental/pinia-colada";
import type { MetadataSource } from "@libris/api-hono/types";
import { useApiClient } from "~/composables/useApiClient";
import { inboxKeys } from "~/composables/queries/inboxKeys";

export const useInboxDetailLoader = defineColadaLoader("/inbox/[id]", {
  key: (to) => inboxKeys.detail(to.params.id),
  query: async (to, { signal }) => {
    const client = useApiClient();
    const res = await client.api.inbox[":id"].$get(
      { param: { id: to.params.id } },
      { init: { signal } },
    );
    if (!res.ok) throw new Error("Not found");
    const json = await res.json();
    return {
      ...json,
      candidates: json.candidates.map((c) => ({
        ...c,
        source: c.source as MetadataSource,
        normalized: c.normalized as Record<string, unknown>,
      })),
    };
  },
  staleTime: 30_000,
});
</script>

<script setup lang="ts">
import type { ApproveBookBody, ApprovedFieldSource } from "@libris/api-hono/types";
import { useQueryCache } from "@pinia/colada";

useDashboard();
useHead({ title: "Review Book" });

const router = useRouter();

defineShortcuts({
  escape: () => router.push("/inbox"),
});

const route = useRoute("/inbox/[id]");
const toast = useToast();
const queryCache = useQueryCache();
const { isAdmin, userId: currentUserId } = useAuth();

const id = route.params.id;

const { data: book, status, refetch } = useInboxDetailLoader();

const canEditBook = computed(
  () => isAdmin.value || (book.value?.createdBy && book.value.createdBy === currentUserId.value),
);

const selections = ref<Record<string, { source: ApprovedFieldSource; value: unknown }>>({});

const showDeleteConfirm = ref(false);
const showHardcoverSearch = ref(false);
const pickerRef = ref<{
  hasValidationErrors: boolean;
  applyManualBulk: (values: Record<string, unknown>) => void;
}>();

const { mutateAsync: rescanBook } = useRescanBook();
const { mutateAsync: approveBook, isLoading: approving } = useApproveBook();
const { mutateAsync: deleteBook } = useDeleteBook();

// Rescan keeps a manual loading ref because the spinner should stay
// until the WebSocket metadata-ready event fires, not just when the HTTP call returns.
const rescanning = ref(false);

// WebSocket: listen for events filtered to this book
const { on } = useServerEvents({ bookId: id });
const alive = ref(true);
onUnmounted(() => {
  alive.value = false;
});

on("book:metadata-ready", async () => {
  if (!alive.value) return;
  if (rescanning.value) {
    rescanning.value = false;
    await refetch();
    if (!alive.value) return;
    toast.add({ title: "Metadata updated", color: "success" });
  } else {
    await refetch();
  }
});

on("book:organized", () => {
  if (!alive.value) return;
  toast.add({ title: "Book organized", color: "success" });
  queryCache.invalidateQueries({ key: inboxKeys.count() });
  queryCache.invalidateQueries({ key: ["series"] });
  router.push("/inbox");
});

async function handleRescan() {
  rescanning.value = true;
  try {
    await rescanBook(id);
    toast.add({ title: "Metadata rescan queued", color: "info" });
  } catch (err) {
    rescanning.value = false;
    toast.add({ title: err instanceof Error ? err.message : "Failed to rescan", color: "error" });
  } finally {
    queryCache.invalidateQueries({ key: ["library"] });
    queryCache.invalidateQueries({ key: ["book", id] });
    queryCache.invalidateQueries({ key: inboxKeys.list() });
  }
}

async function handleApprove() {
  if (Object.keys(selections.value).length === 0) {
    toast.add({ title: "Select at least one field", color: "warning" });
    return;
  }

  try {
    const body: ApproveBookBody = {
      fields: selections.value as ApproveBookBody["fields"],
    };
    await approveBook({ id, body });
    toast.add({ title: "Book approved and organized", color: "success" });
    router.push("/inbox");
  } catch (err) {
    toast.add({
      title: err instanceof Error ? err.message : "Failed to approve book",
      color: "error",
    });
  }
}

const hardcoverSearchInitialQuery = computed(() =>
  [book.value?.title, book.value?.author].filter(Boolean).join(" ").trim(),
);

function onHardcoverPick(hit: { normalized: Record<string, unknown> }) {
  pickerRef.value?.applyManualBulk(hit.normalized);
  showHardcoverSearch.value = false;
  toast.add({ title: "Filled from Hardcover — review and approve", color: "success" });
}

async function handleDelete() {
  try {
    await deleteBook(id);
    toast.add({ title: "Book deleted", color: "success" });
    queryCache.invalidateQueries({ key: inboxKeys.count() });
    router.push("/inbox");
  } catch (err) {
    toast.add({
      title: err instanceof Error ? err.message : "Failed to delete book",
      color: "error",
    });
  }
}

function inboxCoverUrl(bookId: string): string {
  return `/api/inbox/${bookId}/cover`;
}

const isUrl = (v: unknown): v is string => typeof v === "string" && v.startsWith("http");

/** Fallback cover URL: use the extraction endpoint whenever an EPUB is present.
 *  The backend serves whatever embedded cover it can pull, even when coverUrl is null
 *  (e.g. Hardcover hasn't matched yet). Matches the inbox list's behaviour. */
const extractedCoverUrl = computed(() => {
  const b = book.value as (typeof book.value & { coverUrl?: string | null }) | null;
  if (b?.files?.some((f: { format: string }) => f.format === "epub")) {
    return inboxCoverUrl(id);
  }
  return null;
});

const selectedCoverUrl = computed(() => {
  const b = book.value as (typeof book.value & { coverUrl?: string | null }) | null;
  const cover = selections.value.coverUrl;
  if (cover?.value && isUrl(cover.value)) return cover.value as string;
  if (isUrl(b?.coverUrl)) return b!.coverUrl!;
  return extractedCoverUrl.value;
});

const bookTitle = computed(() => {
  const titleSel = selections.value.title;
  if (titleSel?.value) return titleSel.value as string;
  return book.value?.title || book.value?.files?.[0]?.originalName || "Unknown Book";
});

const fieldCount = computed(() => Object.keys(selections.value).length);
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>

        <template #title>
          <UBreadcrumb
            :items="[
              { label: 'Inbox', icon: 'i-lucide-inbox', to: '/inbox' },
              { label: bookTitle },
            ]"
          />
          <UBadge
            v-if="book"
            data-testid="status-badge"
            :color="book.status === 'review' ? 'info' : 'neutral'"
            variant="subtle"
            class="capitalize ml-2"
          >
            {{ book.status }}
          </UBadge>
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <template v-if="canEditBook">
              <UButton
                data-testid="rescan-btn"
                icon="i-lucide-refresh-cw"
                label="Rescan"
                variant="outline"
                color="neutral"
                size="sm"
                :loading="rescanning"
                :disabled="!book || book.status === 'organized'"
                @click="handleRescan"
              />
              <UButton
                data-testid="delete-btn"
                icon="i-lucide-trash-2"
                variant="outline"
                color="error"
                size="sm"
                aria-label="Delete book"
                @click="showDeleteConfirm = true"
              />
              <UButton
                data-testid="approve-btn"
                icon="i-lucide-check"
                :label="`Approve (${fieldCount})`"
                color="primary"
                size="sm"
                :loading="approving"
                :disabled="
                  fieldCount === 0 || book?.status !== 'review' || pickerRef?.hasValidationErrors
                "
                @click="handleApprove"
              />
            </template>

            <div class="w-px h-6 bg-accented" />

            <ColorModeToggle />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeleton -->
      <div v-if="status === 'pending'" class="max-w-4xl mx-auto p-6 space-y-6">
        <div class="flex gap-6">
          <USkeleton class="w-32 h-48 shrink-0 rounded-lg" />
          <div class="flex-1 space-y-3">
            <USkeleton class="h-6 w-3/4" />
            <USkeleton class="h-4 w-1/3" />
            <div class="mt-3 space-y-2">
              <USkeleton class="h-4 w-2/3" />
              <USkeleton class="h-4 w-1/2" />
            </div>
            <USkeleton class="h-3 w-36 mt-3" />
          </div>
        </div>
        <div class="border-t border-default" />
        <div>
          <USkeleton class="h-6 w-40 mb-4" />
          <USkeleton class="h-4 w-72 mb-4" />
          <div class="space-y-3">
            <USkeleton v-for="i in 4" :key="i" class="h-12 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <ApiError
        v-else-if="status === 'error'"
        message="Could not load book details"
        @retry="refetch"
      />

      <div v-else-if="!book" class="flex items-center justify-center py-12">
        <p class="text-muted">Book not found</p>
      </div>

      <div v-else class="max-w-4xl mx-auto p-6 space-y-6">
        <!-- Duplicate warning banner -->
        <div
          v-if="book.possibleDuplicate"
          class="flex items-center gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4"
        >
          <UIcon name="i-lucide-copy" class="text-warning text-lg shrink-0" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-warning">Possible duplicate detected</p>
            <p class="text-sm text-muted mt-0.5">
              This may be a duplicate of
              <RouterLink
                :to="
                  book.possibleDuplicate.status === 'organized'
                    ? `/library/${book.possibleDuplicate.id}`
                    : `/inbox/${book.possibleDuplicate.id}`
                "
                class="font-medium text-primary underline underline-offset-2"
              >
                {{ book.possibleDuplicate.title || "Unknown" }}
              </RouterLink>
              <template v-if="book.possibleDuplicate.author">
                by {{ book.possibleDuplicate.author }}
              </template>
            </p>
          </div>
        </div>

        <!-- Book info header -->
        <div class="flex gap-6">
          <!-- Cover preview (updates live based on selection) -->
          <div class="shrink-0">
            <img
              v-if="selectedCoverUrl"
              data-testid="cover-preview"
              :src="selectedCoverUrl"
              :alt="bookTitle"
              class="w-32 h-48 rounded-lg shadow-md object-cover"
            />
            <div
              v-else
              data-testid="cover-placeholder"
              class="w-32 h-48 rounded-lg bg-elevated flex items-center justify-center"
            >
              <UIcon name="i-lucide-book-open" class="text-3xl text-muted" />
            </div>
          </div>

          <!-- Book details -->
          <div class="flex-1 min-w-0">
            <h1 class="text-xl font-semibold text-highlighted truncate">
              {{ book.title || book.files[0]?.originalName || "Unknown" }}
            </h1>
            <p v-if="book.author" class="text-muted mt-1">{{ book.author }}</p>
            <p
              v-if="book.uploader?.label"
              class="text-sm text-dimmed mt-2"
              data-testid="book-uploader"
            >
              Uploaded by <span class="text-highlighted">{{ book.uploader.label }}</span>
            </p>

            <div class="mt-3 space-y-1">
              <div
                v-for="file in book.files"
                :key="file.id"
                class="flex items-center gap-2 text-sm text-dimmed"
              >
                <UIcon name="i-lucide-file" class="shrink-0" />
                <span class="truncate">{{ file.originalName }}</span>
                <UBadge variant="subtle" color="neutral" size="xs" class="uppercase">
                  {{ file.format }}
                </UBadge>
              </div>
            </div>

            <p class="text-xs text-dimmed mt-3">
              {{ book.candidates.length }} metadata source{{
                book.candidates.length !== 1 ? "s" : ""
              }}
              found
            </p>
          </div>
        </div>

        <div class="border-t border-default" />

        <!-- Metadata field picker -->
        <div>
          <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <h2 class="text-lg font-medium text-highlighted">Select Metadata</h2>
            <UButton
              v-if="canEditBook"
              data-testid="open-hardcover-search-btn"
              icon="i-lucide-search"
              label="Search Hardcover"
              variant="outline"
              color="neutral"
              size="sm"
              :disabled="book.status === 'organized'"
              @click="showHardcoverSearch = true"
            />
          </div>
          <p class="text-sm text-muted mb-4">
            Choose the best value for each field from the available sources, or enter manually.
          </p>
          <UAlert
            v-if="book.candidates.length === 0"
            data-testid="manual-review-alert"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Manual review needed"
            description="No metadata could be extracted from this EPUB. Enter the details manually, then approve the book to continue."
            class="mb-4"
          />
          <ErrorBoundary>
            <MetadataFieldPicker
              ref="pickerRef"
              v-model="selections"
              :candidates="book.candidates"
              :book-id="id"
            />
            <template #error="{ error, clearError }">
              <div data-testid="field-picker-boundary-error">
                <ApiError
                  message="Something went wrong displaying the metadata picker"
                  @retry="clearError"
                />
              </div>
            </template>
          </ErrorBoundary>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <ConfirmDialog
    :open="showDeleteConfirm"
    title="Delete Book"
    message="Are you sure? This will permanently remove the book and its files. This action cannot be undone."
    confirm-label="Delete"
    @update:open="showDeleteConfirm = $event"
    @confirm="handleDelete"
  />

  <UModal
    :open="showHardcoverSearch"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="showHardcoverSearch = $event"
  >
    <template #header>
      <h3 class="text-lg font-semibold text-highlighted">Search Hardcover</h3>
    </template>
    <template #body>
      <p class="text-sm text-muted mb-3">
        Pick a result to fill the metadata fields below. You can still edit each field before
        approving.
      </p>
      <HardcoverSearchPanel :initial-query="hardcoverSearchInitialQuery" @pick="onHardcoverPick" />
    </template>
    <template #footer>
      <div class="flex justify-end">
        <UButton
          label="Close"
          variant="outline"
          color="neutral"
          data-testid="hardcover-search-close-btn"
          @click="showHardcoverSearch = false"
        />
      </div>
    </template>
  </UModal>
</template>
