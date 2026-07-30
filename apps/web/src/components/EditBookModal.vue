<script setup lang="ts">
import { z } from "zod";
import { LANGUAGES, normalizeLanguage } from "@libris/api-hono/languages";
import type { HardcoverSearchHit } from "~/composables/useHardcoverSearch";

const { open, book } = defineProps<{
  open: boolean;
  book: {
    id: string;
    title: string | null;
    author: string | null;
    description: string | null;
    publisher: string | null;
    publishedYear: number | null;
    language: string | null;
    pageCount: number | null;
    isbn10: string | null;
    isbn13: string | null;
    genres: string[];
    tags: string[];
    series: string | null;
    seriesIndex: number | null;
    coverUrl: string | null;
  };
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [];
}>();

const toast = useToast();
const { mutateAsync: editBook, isLoading: saving } = useEditBook();

const seriesIndexStringSchema = z
  .string()
  .refine(
    (v) => !v || (!isNaN(Number(v)) && Number(v) >= 0 && Number(v) < 100000),
    "Enter a valid series position",
  );

const schema = z.object({
  title: z.string().max(500, "Max 500 characters"),
  author: z.string().max(500, "Max 500 characters"),
  description: z.string(),
  publisher: z.string().max(500, "Max 500 characters"),
  publishedYear: yearStringSchema,
  language: z.string().nullable(),
  pageCount: pageCountStringSchema,
  isbn10: isbn10Schema,
  isbn13: isbn13Schema,
  genresStr: z.string(),
  tagsStr: z.string(),
  series: z.string().max(500, "Max 500 characters"),
  seriesIndex: seriesIndexStringSchema,
  coverUrl: z.string().url("Must be a valid URL").or(z.literal("")),
});

const state = reactive({
  title: "",
  author: "",
  description: "",
  publisher: "",
  publishedYear: "",
  language: null as string | null,
  pageCount: "",
  isbn10: "",
  isbn13: "",
  genresStr: "",
  tagsStr: "",
  series: "",
  seriesIndex: "",
  coverUrl: "",
});

const formRef = ref<{ clear: () => void; submit: () => void } | null>(null);
const searchOpen = ref(false);

const languageItems = computed(() => {
  const items = LANGUAGES.map((l) => ({ label: l.name, value: l.code }));
  // Keep an unrecognized legacy value selectable so it still displays.
  const current = state.language;
  if (current && !items.some((i) => i.value === current)) {
    items.unshift({ label: current, value: current });
  }
  return items;
});

watch(
  () => open,
  (val) => {
    if (val) {
      state.title = book.title ?? "";
      state.author = book.author ?? "";
      state.description = book.description ?? "";
      state.publisher = book.publisher ?? "";
      state.publishedYear = book.publishedYear?.toString() ?? "";
      state.language = normalizeLanguage(book.language) ?? book.language ?? null;
      state.pageCount = book.pageCount?.toString() ?? "";
      state.isbn10 = book.isbn10 ?? "";
      state.isbn13 = book.isbn13 ?? "";
      state.genresStr = book.genres.join(", ");
      state.tagsStr = book.tags.join(", ");
      state.series = book.series ?? "";
      state.seriesIndex = book.seriesIndex?.toString() ?? "";
      state.coverUrl = book.coverUrl ?? "";
      searchOpen.value = false;
      formRef.value?.clear();
    }
  },
);

const initialQuery = computed(() => [book.title, book.author].filter(Boolean).join(" ").trim());

function applyHardcoverHit(hit: HardcoverSearchHit) {
  const n = hit.normalized;
  state.title = n.title ?? "";
  state.author = n.author ?? "";
  state.description = n.description ?? "";
  state.publisher = n.publisher ?? "";
  state.publishedYear = n.publishedYear?.toString() ?? "";
  state.language = normalizeLanguage(n.language) ?? null;
  state.pageCount = n.pageCount?.toString() ?? "";
  state.isbn10 = n.isbn10 ?? "";
  state.isbn13 = n.isbn13 ?? "";
  state.genresStr = (n.genres ?? []).join(", ");
  state.series = n.series ?? "";
  state.seriesIndex = n.seriesIndex?.toString() ?? "";
  state.coverUrl = n.coverUrl ?? "";
  searchOpen.value = false;
  toast.add({ title: "Filled from Hardcover — review and save", color: "success" });
}

function parseList(str: string): string[] {
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function onSubmit(event: { data: z.output<typeof schema> }) {
  try {
    const d = event.data;
    await editBook({
      id: book.id,
      data: {
        title: d.title.trim() || null,
        author: d.author.trim() || null,
        description: d.description.trim() || null,
        publisher: d.publisher.trim() || null,
        publishedYear: d.publishedYear ? Number(d.publishedYear) : null,
        language: d.language || null,
        pageCount: d.pageCount ? Number(d.pageCount) : null,
        isbn10: d.isbn10.trim() || null,
        isbn13: d.isbn13.trim() || null,
        genres: parseList(d.genresStr),
        tags: parseList(d.tagsStr),
        series: d.series.trim() || null,
        seriesIndex: d.seriesIndex ? Number(d.seriesIndex) : null,
        coverUrl: d.coverUrl.trim() || null,
      },
    });
    toast.add({ title: "Book updated", color: "success" });
    emit("saved");
    emit("update:open", false);
  } catch {
    toast.add({ title: "Failed to update book", color: "error" });
  }
}
</script>

<template>
  <UModal :open="open" @update:open="emit('update:open', $event)">
    <template #header>
      <h3 class="text-lg font-semibold text-highlighted">Edit Metadata</h3>
    </template>

    <template #body>
      <div class="mb-4">
        <UButton
          :label="searchOpen ? 'Hide Hardcover search' : 'Search Hardcover to autofill'"
          :icon="searchOpen ? 'i-lucide-chevron-up' : 'i-lucide-search'"
          variant="outline"
          color="neutral"
          block
          data-testid="open-hardcover-search-btn"
          :aria-expanded="searchOpen"
          @click="searchOpen = !searchOpen"
        />
        <div v-if="searchOpen" class="pt-3">
          <HardcoverSearchPanel :initial-query="initialQuery" @pick="applyHardcoverHit" />
        </div>
      </div>

      <UForm ref="formRef" :schema="schema" :state="state" @submit="onSubmit">
        <div class="space-y-4">
          <UFormField name="title" label="Title">
            <UInput
              v-model="state.title"
              placeholder="Book title"
              class="w-full"
              data-testid="field-title"
            />
          </UFormField>

          <UFormField name="author" label="Author">
            <UInput
              v-model="state.author"
              placeholder="Author name"
              class="w-full"
              data-testid="field-author"
            />
          </UFormField>

          <UFormField name="description" label="Description">
            <UTextarea
              v-model="state.description"
              placeholder="Book description..."
              :rows="3"
              class="w-full"
              data-testid="field-description"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField name="publisher" label="Publisher">
              <UInput
                v-model="state.publisher"
                placeholder="Publisher"
                class="w-full"
                data-testid="field-publisher"
              />
            </UFormField>

            <UFormField name="publishedYear" label="Published Year">
              <UInput
                v-model="state.publishedYear"
                type="number"
                placeholder="e.g. 2024"
                class="w-full"
                data-testid="field-published-year"
              />
            </UFormField>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <UFormField name="language" label="Language">
              <USelectMenu
                v-model="state.language"
                :items="languageItems"
                value-key="value"
                clear
                :reset-model-value-on-clear="true"
                icon="i-lucide-languages"
                placeholder="Select language"
                class="w-full"
                data-testid="field-language"
              />
            </UFormField>

            <UFormField name="pageCount" label="Page Count">
              <UInput
                v-model="state.pageCount"
                type="number"
                placeholder="e.g. 320"
                class="w-full"
                data-testid="field-page-count"
              />
            </UFormField>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <UFormField name="isbn10" label="ISBN-10">
              <UInput
                v-model="state.isbn10"
                placeholder="ISBN-10"
                class="w-full"
                data-testid="field-isbn10"
              />
            </UFormField>

            <UFormField name="isbn13" label="ISBN-13">
              <UInput
                v-model="state.isbn13"
                placeholder="ISBN-13"
                class="w-full"
                data-testid="field-isbn13"
              />
            </UFormField>
          </div>

          <UFormField name="genresStr" label="Genres" hint="Comma-separated">
            <UInput
              v-model="state.genresStr"
              placeholder="e.g. Fiction, Science Fiction"
              class="w-full"
              data-testid="field-genres"
            />
          </UFormField>

          <UFormField name="tagsStr" label="Tags" hint="Comma-separated">
            <UInput
              v-model="state.tagsStr"
              placeholder="e.g. classic, award-winner"
              class="w-full"
              data-testid="field-tags"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField name="series" label="Series">
              <UInput
                v-model="state.series"
                placeholder="e.g. The Lord of the Rings"
                class="w-full"
                data-testid="field-series"
              />
            </UFormField>

            <UFormField name="seriesIndex" label="Series #">
              <UInput
                v-model="state.seriesIndex"
                placeholder="e.g. 1"
                inputmode="numeric"
                class="w-full"
                data-testid="field-series-index"
              />
            </UFormField>
          </div>

          <UFormField name="coverUrl" label="Cover Image URL">
            <UInput
              v-model="state.coverUrl"
              placeholder="https://..."
              class="w-full"
              data-testid="field-coverUrl"
            />
          </UFormField>
        </div>
      </UForm>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          label="Cancel"
          variant="outline"
          color="neutral"
          data-testid="cancel-btn"
          @click="emit('update:open', false)"
        />
        <UButton
          label="Save"
          color="primary"
          :loading="saving"
          data-testid="save-btn"
          @click="formRef?.submit()"
        />
      </div>
    </template>
  </UModal>
</template>
