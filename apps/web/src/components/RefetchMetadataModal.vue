<script setup lang="ts">
import type {
  ApprovedFieldSource,
  MetadataSource,
  NormalizedMetadata,
} from "@libris/api-hono/types";
import { useQueryCache } from "@pinia/colada";
import { inboxKeys } from "~/composables/queries/inboxKeys";

interface LibraryBookDetail {
  id: string;
  title: string | null;
  author: string | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  publishedYear: number | null;
  language: string | null;
  description: string | null;
  coverUrl: string | null;
  pageCount: number | null;
  genres: string[];
  tags: string[];
}

interface Candidate {
  id: string;
  source: MetadataSource;
  normalized: NormalizedMetadata;
  confidence: string;
  selectedFields: string[];
}

const { open, book } = defineProps<{
  open: boolean;
  book: LibraryBookDetail;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  applied: [];
}>();

const toast = useToast();
const queryCache = useQueryCache();
const { mutateAsync: refetchMetadata } = useRefetchMetadata();
const { mutateAsync: applyMetadataMutation, isLoading: applying } = useApplyMetadata();
// Disabled query: the pipeline decides when there is anything to read, so the
// event handler below drives it. Going through Colada anyway means the result
// is cached under ["library", id, …] and invalidated with the rest of the book.
const { refetch: refetchCandidates } = useBookCandidatesQuery(() => book.id);

type Phase = "idle" | "fetching" | "picking" | "no-results" | "error";
const phase = ref<Phase>("idle");
const candidates = ref<Candidate[]>([]);
const selections = ref<Record<string, { source: ApprovedFieldSource; value: unknown }>>({});
const errorMessage = ref("");
const pickerRef = ref<{ hasValidationErrors: boolean }>();

// WebSocket: listen for events filtered to this book
const { on, close: closeEvents } = useServerEvents({ bookId: book.id });

on("book:metadata-ready", async () => {
  if (phase.value !== "fetching") return;

  // `refetch()` resolves with the entry's state instead of rejecting, so a
  // failure is a status here rather than a catch.
  const state = await refetchCandidates();
  if (state.status === "error" || !state.data) {
    phase.value = "error";
    errorMessage.value = "Failed to load metadata candidates";
    return;
  }

  // Filter to only non-file candidates (freshly fetched)
  const externalCandidates = state.data.candidates.filter(
    (c: { source: string }) => c.source !== "file",
  );

  if (externalCandidates.length === 0) {
    phase.value = "no-results";
    return;
  }

  // Build synthetic "current" candidate from the book's existing metadata
  const currentCandidate: Candidate = {
    id: "current",
    source: "current" as MetadataSource,
    normalized: {
      title: book.title,
      author: book.author,
      isbn10: book.isbn10,
      isbn13: book.isbn13,
      publisher: book.publisher,
      publishedYear: book.publishedYear,
      language: book.language,
      description: book.description,
      coverUrl: book.coverUrl,
      pageCount: book.pageCount,
      genres: book.genres,
    },
    confidence: "1.0",
    selectedFields: [],
  };

  candidates.value = [currentCandidate, ...(externalCandidates as Candidate[])];
  phase.value = "picking";
});

on("job:failed", (event) => {
  if (phase.value !== "fetching") return;
  phase.value = "error";
  errorMessage.value =
    (event.payload?.message as string) || "Metadata fetch failed. Please try again.";
});

async function handleFetch() {
  phase.value = "fetching";
  selections.value = {};
  candidates.value = [];
  try {
    await refetchMetadata(book.id);
  } catch {
    phase.value = "error";
    errorMessage.value = "Failed to start metadata refetch";
  }
}

async function handleApply() {
  if (Object.keys(selections.value).length === 0) {
    toast.add({ title: "Select at least one field", color: "warning" });
    return;
  }

  try {
    await applyMetadataMutation({
      id: book.id,
      fields: selections.value as Record<
        string,
        { source: string; value: string | number | boolean | string[] | null }
      >,
    });
    toast.add({ title: "Metadata updated", color: "success" });
    emit("applied");
    handleClose();
  } catch {
    toast.add({ title: "Failed to apply metadata", color: "error" });
  } finally {
    queryCache.invalidateQueries({ key: ["library"] });
    queryCache.invalidateQueries({ key: ["book", book.id] });
    queryCache.invalidateQueries({ key: inboxKeys.list() });
    queryCache.invalidateQueries({ key: inboxKeys.count() });
    queryCache.invalidateQueries({ key: ["series"] });
  }
}

function handleClose() {
  phase.value = "idle";
  selections.value = {};
  candidates.value = [];
  errorMessage.value = "";
  emit("update:open", false);
}

onUnmounted(() => closeEvents());
</script>

<template>
  <UModal :open="open" :ui="{ content: 'sm:max-w-3xl' }" @update:open="handleClose">
    <template #header>
      <h3 class="text-lg font-semibold text-highlighted">Refetch Metadata</h3>
    </template>

    <template #body>
      <!-- Idle: confirm refetch -->
      <div v-if="phase === 'idle'" data-testid="refetch-idle" class="text-center py-6 space-y-4">
        <UIcon name="i-lucide-globe" class="text-4xl text-primary" />
        <p class="text-sm text-muted">
          Re-fetch metadata from Hardcover for this book. You'll be able to review and pick which
          fields to update.
        </p>
        <UButton
          data-testid="refetch-fetch-btn"
          label="Fetch metadata"
          icon="i-lucide-refresh-cw"
          color="primary"
          @click="handleFetch"
        />
      </div>

      <!-- Fetching: loading state -->
      <div
        v-else-if="phase === 'fetching'"
        data-testid="refetch-fetching"
        class="text-center py-12 space-y-4"
      >
        <UIcon name="i-lucide-loader-circle" class="text-4xl text-primary animate-spin" />
        <p class="text-sm text-muted">Fetching metadata from external sources...</p>
      </div>

      <!-- No results -->
      <div
        v-else-if="phase === 'no-results'"
        data-testid="refetch-no-results"
        class="text-center py-6 space-y-4"
      >
        <UIcon name="i-lucide-search-x" class="text-4xl text-muted" />
        <p class="text-sm text-muted">No external metadata found for this book.</p>
        <UButton
          data-testid="refetch-retry-btn"
          label="Try again"
          variant="outline"
          color="neutral"
          @click="handleFetch"
        />
      </div>

      <!-- Error -->
      <div
        v-else-if="phase === 'error'"
        data-testid="refetch-error"
        class="text-center py-6 space-y-4"
      >
        <UIcon name="i-lucide-alert-triangle" class="text-4xl text-error" />
        <p class="text-sm text-error">{{ errorMessage }}</p>
        <UButton
          data-testid="refetch-retry-btn"
          label="Try again"
          variant="outline"
          color="neutral"
          @click="handleFetch"
        />
      </div>

      <!-- Picking: show MetadataFieldPicker -->
      <div v-else-if="phase === 'picking'" data-testid="refetch-picker">
        <p class="text-sm text-muted mb-4">
          Choose the best value for each field. "Current" shows the book's existing metadata.
        </p>
        <MetadataFieldPicker
          ref="pickerRef"
          v-model="selections"
          :candidates="candidates"
          :book-id="book.id"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          data-testid="refetch-cancel-btn"
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="handleClose"
        />
        <UButton
          v-if="phase === 'picking'"
          data-testid="refetch-apply-btn"
          :label="`Apply (${Object.keys(selections).length})`"
          color="primary"
          :loading="applying"
          :disabled="Object.keys(selections).length === 0 || pickerRef?.hasValidationErrors"
          @click="handleApply"
        />
      </div>
    </template>
  </UModal>
</template>
