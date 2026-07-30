<script setup lang="ts">
import type { MetadataSource, ApprovedFieldSource } from "@libris/api-hono/types";
import { LANGUAGES, languageLabel } from "@libris/api-hono/languages";
import type { z } from "zod";
import type { Candidate, FieldSelection } from "./MetadataFieldPicker.types";

const languageItems = LANGUAGES.map((l) => ({ label: l.name, value: l.code }));

const { candidates, bookId } = defineProps<{
  candidates: Candidate[];
  /** Book ID used to construct the inbox cover extraction endpoint URL */
  bookId?: string;
}>();

const selections = defineModel<Record<string, FieldSelection>>({ default: () => ({}) });

const manualValues = reactive<Record<string, string>>({});

const manualFieldSchemas: Record<string, z.ZodType<string>> = {
  isbn10: isbn10Schema,
  isbn13: isbn13Schema,
  publishedYear: yearStringSchema,
  pageCount: pageCountStringSchema,
  coverUrl: coverUrlSchema,
};

function getManualError(fieldKey: string): string | undefined {
  const schema = manualFieldSchemas[fieldKey];
  if (!schema) return undefined;
  const value = manualValues[fieldKey] ?? "";
  if (!value) return undefined;
  const result = schema.safeParse(value);
  if (!result.success) return result.error.issues[0]?.message;
  return undefined;
}

const hasValidationErrors = computed(() => {
  for (const [key, sel] of Object.entries(selections.value)) {
    if (sel.source === "manual" && getManualError(key)) return true;
  }
  return false;
});

const BULK_APPLY_KEYS = [
  "title",
  "author",
  "publisher",
  "publishedYear",
  "isbn10",
  "isbn13",
  "language",
  "description",
  "pageCount",
  "series",
  "seriesIndex",
  "genres",
  "coverUrl",
] as const;

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/** Populate manual values + selections in one shot. Used when the user picks a
 *  Hardcover search result and wants every present field treated as a manual
 *  override of whatever the picker is currently showing. */
function applyManualBulk(values: Record<string, unknown>) {
  const next: Record<string, FieldSelection> = { ...selections.value };
  for (const key of BULK_APPLY_KEYS) {
    const v = values[key];
    if (isEmptyValue(v)) continue;
    manualValues[key] = Array.isArray(v) ? v.join(", ") : String(v);
    next[key] = { source: "manual", value: v };
  }
  selections.value = next;
}

defineExpose({ hasValidationErrors, applyManualBulk });

const fields = [
  { key: "title", label: "Title", type: "text" },
  { key: "author", label: "Author", type: "text" },
  { key: "publisher", label: "Publisher", type: "text" },
  { key: "publishedYear", label: "Year", type: "number" },
  { key: "isbn10", label: "ISBN-10", type: "text" },
  { key: "isbn13", label: "ISBN-13", type: "text" },
  { key: "language", label: "Language", type: "language" },
  { key: "description", label: "Description", type: "textarea" },
  { key: "pageCount", label: "Pages", type: "number" },
  { key: "series", label: "Series", type: "series" },
  { key: "genres", label: "Genres", type: "tags" },
  { key: "coverUrl", label: "Cover", type: "cover" },
] as const;

const sourceLabels: Record<string, string> = {
  file: "File",
  hardcover: "Hardcover",
  current: "Current",
  manual: "Manual",
};

function getCandidateValue(candidate: Candidate, fieldKey: string): unknown {
  return (candidate.normalized as Record<string, unknown>)?.[fieldKey] ?? null;
}

function getCandidateFieldBySource(source: string, fieldKey: string): unknown {
  const candidate = candidates.find((c) => c.source === source);
  if (!candidate) return null;
  return getCandidateValue(candidate, fieldKey);
}

function getSourcesForField(fieldKey: string) {
  return candidates
    .filter((c) => {
      const val = getCandidateValue(c, fieldKey);
      if (val === null || val === undefined) return false;
      if (Array.isArray(val) && val.length === 0) return false;
      if (val === "") return false;
      return true;
    })
    .map((c) => ({
      source: c.source as MetadataSource,
      value: getCandidateValue(c, fieldKey),
      confidence: c.confidence,
    }))
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));
}

/** Resolve the display URL for a cover value — bare filenames use the inbox cover extraction endpoint */
function resolveCoverPreviewUrl(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("http")) return value;
  // Bare filename from EPUB extraction — use inbox cover endpoint if bookId is available
  if (bookId) return `/api/inbox/${bookId}/cover`;
  return null;
}

function selectSource(fieldKey: string, source: ApprovedFieldSource, value: unknown) {
  const updated = { ...selections.value, [fieldKey]: { source, value } };
  // When selecting a series source, also auto-select seriesIndex from the same source if available
  if (fieldKey === "series") {
    const candidate = candidates.find((c) => c.source === source);
    const idx = candidate?.normalized?.seriesIndex;
    if (idx != null) {
      updated["seriesIndex"] = { source, value: idx };
    }
  }
  selections.value = updated;
}

function parseManualValue(fieldKey: string, raw: string): unknown {
  const field = fields.find((f) => f.key === fieldKey);
  if (field?.type === "number") return raw ? Number(raw) : null;
  if (field?.type === "tags")
    return raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return raw;
}

function updateManualValue(fieldKey: string, raw: string) {
  manualValues[fieldKey] = raw;
  if (selections.value[fieldKey]?.source === "manual") {
    selections.value = {
      ...selections.value,
      [fieldKey]: { source: "manual", value: parseManualValue(fieldKey, raw) },
    };
  }
}

function selectManual(fieldKey: string) {
  const raw = manualValues[fieldKey] ?? "";
  const updated = {
    ...selections.value,
    [fieldKey]: { source: "manual" as const, value: parseManualValue(fieldKey, raw) },
  };
  // When selecting manual for series, also set seriesIndex to manual
  if (fieldKey === "series") {
    const idxRaw = manualValues["seriesIndex"] ?? "";
    updated["seriesIndex"] = {
      source: "manual" as const,
      value: idxRaw ? Number(idxRaw) : null,
    };
  }
  selections.value = updated;
}

function isSelected(fieldKey: string, source: string): boolean {
  return selections.value[fieldKey]?.source === source;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

// Auto-select highest confidence source for each field when candidates load
watch(
  () => candidates,
  (candidates) => {
    if (candidates.length > 0 && Object.keys(selections.value).length === 0) {
      const initial: Record<string, FieldSelection> = {};
      for (const field of fields) {
        const sources = getSourcesForField(field.key);
        if (sources.length > 0) {
          initial[field.key] = { source: sources[0]!.source, value: sources[0]!.value };
          // Auto-select seriesIndex from the same candidate
          if (field.key === "series") {
            const candidate = candidates.find((c) => c.source === sources[0]!.source);
            const idx = candidate?.normalized?.seriesIndex;
            if (idx != null) {
              initial["seriesIndex"] = { source: sources[0]!.source, value: idx };
            }
          }
        }
      }
      if (Object.keys(initial).length > 0) {
        selections.value = initial;
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="divide-y divide-default">
    <div
      v-for="field in fields"
      :key="field.key"
      :data-testid="`field-${field.key}`"
      class="py-4 first:pt-0 last:pb-0"
    >
      <div class="flex items-start gap-4">
        <div class="w-24 shrink-0 pt-2">
          <span class="text-sm font-medium text-highlighted">{{ field.label }}</span>
        </div>

        <div class="flex-1 space-y-2">
          <!-- Source options -->
          <label
            v-for="src in getSourcesForField(field.key)"
            :key="src.source"
            class="flex items-start gap-3 p-2 rounded-md cursor-pointer transition-colors"
            :class="
              isSelected(field.key, src.source)
                ? 'bg-primary/5 ring-1 ring-primary'
                : 'hover:bg-elevated/50'
            "
          >
            <input
              type="radio"
              :name="field.key"
              :checked="isSelected(field.key, src.source)"
              class="mt-1 accent-primary"
              @change="selectSource(field.key, src.source, src.value)"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-muted">{{ sourceLabels[src.source] }}</span>
                <span class="text-xs text-dimmed">
                  ({{ (Number(src.confidence) * 100).toFixed(0) }}%)
                </span>
              </div>

              <!-- Cover preview -->
              <template v-if="field.type === 'cover' && resolveCoverPreviewUrl(src.value)">
                <img
                  :src="resolveCoverPreviewUrl(src.value)!"
                  :alt="`Cover from ${sourceLabels[src.source]}`"
                  class="mt-1 h-32 rounded shadow-sm object-cover"
                  loading="lazy"
                />
              </template>

              <!-- Description (truncated) -->
              <template v-else-if="field.type === 'textarea'">
                <p class="text-sm text-default mt-0.5 line-clamp-3">
                  {{ formatValue(src.value) }}
                </p>
              </template>

              <!-- Tags/genres -->
              <template v-else-if="field.type === 'tags' && Array.isArray(src.value)">
                <div class="flex flex-wrap gap-1 mt-0.5">
                  <UBadge
                    v-for="tag in src.value as string[]"
                    :key="tag"
                    variant="subtle"
                    color="neutral"
                    size="xs"
                  >
                    {{ tag }}
                  </UBadge>
                </div>
              </template>

              <!-- Language — show the full name for the code -->
              <template v-else-if="field.type === 'language'">
                <span class="text-sm text-default">{{ languageLabel(src.value as string) }}</span>
              </template>

              <!-- Series name + inline position -->
              <template v-else-if="field.type === 'series'">
                <div class="flex items-center gap-2">
                  <span class="text-sm text-default">{{ formatValue(src.value) }}</span>
                  <template v-if="getCandidateFieldBySource(src.source, 'seriesIndex')">
                    <span class="text-xs text-muted"
                      >#{{ getCandidateFieldBySource(src.source, "seriesIndex") }}</span
                    >
                  </template>
                </div>
              </template>

              <!-- Default text/number -->
              <template v-else>
                <span class="text-sm text-default">{{ formatValue(src.value) }}</span>
              </template>
            </div>
          </label>

          <!-- Manual option -->
          <label
            class="flex items-start gap-3 p-2 rounded-md cursor-pointer transition-colors"
            :class="
              isSelected(field.key, 'manual')
                ? 'bg-primary/5 ring-1 ring-primary'
                : 'hover:bg-elevated/50'
            "
          >
            <input
              type="radio"
              :name="field.key"
              :checked="isSelected(field.key, 'manual')"
              class="mt-1 accent-primary"
              @change="selectManual(field.key)"
            />
            <div class="flex-1 min-w-0">
              <span class="text-xs font-medium text-muted">Manual</span>
              <UFormField
                :error="isSelected(field.key, 'manual') ? getManualError(field.key) : undefined"
                class="mt-1"
              >
                <UTextarea
                  v-if="field.type === 'textarea'"
                  :model-value="manualValues[field.key] ?? ''"
                  placeholder="Enter value..."
                  size="sm"
                  :rows="3"
                  @update:model-value="updateManualValue(field.key, $event as string)"
                  @focus="selectManual(field.key)"
                />
                <USelectMenu
                  v-else-if="field.type === 'language'"
                  :model-value="manualValues[field.key] ?? ''"
                  :items="languageItems"
                  value-key="value"
                  clear
                  placeholder="Select language"
                  size="sm"
                  @update:model-value="
                    (v: string | null) => {
                      updateManualValue(field.key, v ?? '');
                      selectManual(field.key);
                    }
                  "
                />
                <UInput
                  v-else
                  :model-value="manualValues[field.key] ?? ''"
                  :type="field.type === 'number' ? 'number' : 'text'"
                  :placeholder="
                    field.type === 'cover'
                      ? 'Paste cover image URL (https://...)'
                      : field.type === 'tags'
                        ? 'Comma-separated values...'
                        : 'Enter value...'
                  "
                  size="sm"
                  @update:model-value="updateManualValue(field.key, String($event))"
                  @focus="selectManual(field.key)"
                />
              </UFormField>
            </div>
          </label>

          <!-- Series # input — always visible, independent of series name source -->
          <div
            v-if="field.type === 'series'"
            class="flex items-center gap-2 px-2 pt-1"
            data-testid="field-seriesIndex"
          >
            <span class="text-xs font-medium text-muted">Book #</span>
            <UInput
              :model-value="
                selections['seriesIndex']?.value != null
                  ? String(selections['seriesIndex'].value)
                  : ''
              "
              type="number"
              placeholder="Position in series"
              size="sm"
              class="w-40"
              @update:model-value="
                (v: string | number) => {
                  selections = {
                    ...selections,
                    seriesIndex: { source: 'manual', value: v ? Number(v) : null },
                  };
                }
              "
            />
          </div>

          <!-- No sources hint -->
          <p
            v-if="getSourcesForField(field.key).length === 0 && !isSelected(field.key, 'manual')"
            class="text-xs text-dimmed italic"
          >
            No metadata found — enter manually
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
