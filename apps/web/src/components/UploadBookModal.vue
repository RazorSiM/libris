<script setup lang="ts">
const { open } = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  uploaded: [];
}>();

const { upload: uploadFiles, cancel: cancelUpload } = useUpload();
const toast = useToast();

const files = ref<File[]>([]);
const uploading = ref(false);
const progress = ref(0);
const dragging = ref(false);

const fileInput = ref<HTMLInputElement | null>(null);

watch(
  () => open,
  (val) => {
    if (val) {
      files.value = [];
      progress.value = 0;
      uploading.value = false;
      dragging.value = false;
    }
  },
);

function addFiles(newFiles: FileList | File[]) {
  const added: File[] = [];
  for (const file of newFiles) {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_BOOK_EXTENSION_SET.has(ext)) {
      toast.add({ title: `Skipped ${file.name}: unsupported format`, color: "warning" });
      continue;
    }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      toast.add({ title: `Skipped ${file.name}: exceeds 100MB`, color: "warning" });
      continue;
    }
    // Avoid duplicates by name
    if (!files.value.some((f) => f.name === file.name && f.size === file.size)) {
      added.push(file);
    }
  }
  files.value = [...files.value, ...added];
}

function onFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files) {
    addFiles(input.files);
    input.value = "";
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (event.dataTransfer?.files) {
    addFiles(event.dataTransfer.files);
  }
}

function removeFile(index: number) {
  files.value = files.value.filter((_, i) => i !== index);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function upload() {
  if (files.value.length === 0) return;

  uploading.value = true;
  progress.value = 0;

  try {
    const result = await uploadFiles(files.value, (pct: number) => {
      progress.value = pct;
    });

    const count = result.uploaded.length;
    toast.add({
      title: `${count} ${count === 1 ? "file" : "files"} uploaded`,
      color: "success",
    });

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        toast.add({ title: `${err.filename}: ${err.error}`, color: "warning" });
      }
    }

    emit("uploaded");
    emit("update:open", false);
  } catch (err: unknown) {
    toast.add({
      title: err instanceof Error ? err.message : "Upload failed",
      color: "error",
    });
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <UModal :open="open" @update:open="emit('update:open', $event)">
    <template #header>
      <h3 class="text-lg font-semibold text-highlighted">Upload Books</h3>
    </template>

    <template #body>
      <div class="space-y-4">
        <!-- Drop zone -->
        <div
          role="button"
          tabindex="0"
          aria-label="Drop book files here or click to browse"
          data-testid="upload-drop-zone"
          class="border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :class="dragging ? 'border-primary bg-primary/5' : 'border-accented hover:border-muted'"
          @click="fileInput?.click()"
          @keydown.enter.prevent="fileInput?.click()"
          @keydown.space.prevent="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragenter.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <UIcon name="i-lucide-upload" class="text-3xl text-muted mb-2" />
          <p class="text-sm text-muted">
            Drag & drop book files here, or <span class="text-primary font-medium">browse</span>
          </p>
          <p class="text-xs text-dimmed mt-1">epub - Max 100MB per file</p>
          <input
            ref="fileInput"
            type="file"
            :accept="ACCEPTED_BOOK_EXTENSIONS"
            multiple
            class="hidden"
            data-testid="file-input"
            @change="onFileSelect"
          />
        </div>

        <!-- File list -->
        <div v-if="files.length > 0" class="space-y-2">
          <div
            v-for="(file, i) in files"
            :key="file.name + file.size"
            class="flex items-center gap-3 p-2 rounded bg-elevated"
          >
            <UIcon name="i-lucide-file-text" class="text-muted shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-sm truncate">{{ file.name }}</p>
              <p class="text-xs text-muted">{{ formatSize(file.size) }}</p>
            </div>
            <UButton
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              size="xs"
              :disabled="uploading"
              :data-testid="`remove-file-btn-${i}`"
              @click="removeFile(i)"
            />
          </div>
        </div>

        <!-- Progress bar -->
        <div v-if="uploading" class="space-y-1">
          <div class="flex justify-between text-xs text-muted">
            <span>Uploading...</span>
            <span>{{ progress }}%</span>
          </div>
          <UProgress :model-value="progress" :max="100" />
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          label="Cancel"
          variant="outline"
          color="neutral"
          data-testid="cancel-btn"
          @click="uploading ? cancelUpload() : emit('update:open', false)"
        />
        <UButton
          label="Upload"
          icon="i-lucide-upload"
          color="primary"
          :loading="uploading"
          :disabled="files.length === 0"
          data-testid="upload-btn"
          @click="upload"
        />
      </div>
    </template>
  </UModal>
</template>
