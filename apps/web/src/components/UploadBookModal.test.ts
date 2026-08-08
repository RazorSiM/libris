// @vitest-environment happy-dom
/**
 * A skipped duplicate is not a failed upload (libris-s7t).
 *
 * The upload endpoint used to report a file it refused to re-ingest through
 * `errors[]`, so the modal toasted it in the same lane as "unsupported format"
 * and "exceeds 100MB". Those are different events: one means the user's request
 * was wrong, the other means the library already contains the book they asked
 * for. The modal now reads `skipped[]` and says so in its own voice.
 *
 * These tests drive the real drop zone and the real Upload button, so they also
 * cover the wiring between them and `upload()`.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { mount } from "@vue/test-utils";

interface Toast {
  title: string;
  description?: string;
  color: string;
}

interface UploadResult {
  uploaded: { filename: string; size: number }[];
  skipped: { filename: string; reason: string }[];
  errors: { filename: string; error: string }[];
}

const toasts: Toast[] = [];
let uploadResult: UploadResult;
let uploadCalls = 0;

const constants = await import("../utils/constants");

// Provide what Nuxt-style auto-imports normally inject into SFC scope.
Object.assign(globalThis, {
  ref,
  computed,
  reactive,
  watch,
  ACCEPTED_BOOK_EXTENSIONS: constants.ACCEPTED_BOOK_EXTENSIONS,
  ACCEPTED_BOOK_EXTENSION_SET: constants.ACCEPTED_BOOK_EXTENSION_SET,
  MAX_UPLOAD_SIZE_BYTES: constants.MAX_UPLOAD_SIZE_BYTES,
  useToast: () => ({
    add: (toast: Toast) => {
      toasts.push(toast);
    },
  }),
  useUpload: () => ({
    upload: async () => {
      uploadCalls++;
      return uploadResult;
    },
    cancel: () => {},
  }),
});

const UploadBookModal = (await import("./UploadBookModal.vue")).default;

/**
 * @nuxt/ui is not registered in the test build (see apps/web/vite.config.ts),
 * so the wrappers are stubbed by hand. UModal must render its slots
 * unconditionally — the real one teleports and gates on `open`.
 */
const stubs = {
  UModal: {
    template: `<div><slot name="header" /><slot name="body" /><slot name="footer" /></div>`,
  },
  // `v-bind="$attrs"` keeps the parent's `@click` attached as a DOM listener,
  // which is what lets `trigger("click")` reach the component's handler.
  UButton: { inheritAttrs: false, template: `<button v-bind="$attrs"></button>` },
  UIcon: { template: `<span />` },
  UProgress: { template: `<div />` },
};

function makeEpub(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/epub+zip" });
}

async function uploadFiles(...files: File[]) {
  const wrapper = mount(UploadBookModal, {
    props: { open: true },
    global: { stubs },
  });

  await wrapper
    .get('[data-testid="upload-drop-zone"]')
    .trigger("drop", { dataTransfer: { files } });
  await nextTick();

  await wrapper.get('[data-testid="upload-btn"]').trigger("click");
  await nextTick();
  await nextTick();

  return wrapper;
}

beforeEach(() => {
  toasts.length = 0;
  uploadCalls = 0;
  uploadResult = { uploaded: [], skipped: [], errors: [] };
});

describe("UploadBookModal reports skips separately from failures", () => {
  it("calls a duplicate 'already in your library', not an error", async () => {
    uploadResult = {
      uploaded: [],
      skipped: [
        { filename: "dup.epub", reason: "This file has already been uploaded to this library" },
      ],
      errors: [],
    };

    await uploadFiles(makeEpub("dup.epub"));

    expect(uploadCalls).toBe(1);
    expect(toasts).toHaveLength(1);
    // Pre-fix this file arrived in `errors[]` and was toasted as `warning`
    // with the raw server sentence. Neither of these would hold.
    expect(toasts[0]!.color).toBe("info");
    expect(toasts[0]!.title).toContain("already in your library");
    expect(toasts[0]!.description).toContain("dup.epub");
  });

  it("uses a different colour and wording for a real rejection", async () => {
    uploadResult = {
      uploaded: [],
      skipped: [],
      errors: [{ filename: "notes.txt", error: "Unsupported format: .txt. Supported: epub" }],
    };

    await uploadFiles(makeEpub("notes.epub"));

    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.color).toBe("error");
    expect(toasts[0]!.title).toContain("Unsupported format");
    // The two outcomes must not read alike.
    expect(toasts[0]!.title).not.toContain("already in your library");
  });

  it("says '1 file uploaded' and '1 already in your library' for a mixed batch", async () => {
    uploadResult = {
      uploaded: [{ filename: "fresh.epub", size: 3 }],
      skipped: [
        { filename: "dup.epub", reason: "This file has already been uploaded to this library" },
      ],
      errors: [],
    };

    await uploadFiles(makeEpub("fresh.epub"), makeEpub("dup.epub"));

    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.color).toBe("success");
    expect(toasts[0]!.title).toBe("1 file uploaded");
    // Pre-fix the second file produced a separate `warning` toast reading
    // "dup.epub: This file has already been uploaded to this library" — a
    // mixed batch looked like a partial failure.
    expect(toasts[0]!.description).toContain("1 already in your library");
    expect(toasts[0]!.description).toContain("dup.epub");
    expect(toasts.some((t) => t.color === "warning" || t.color === "error")).toBe(false);
  });

  it("still says nothing succeeded when a batch produced only errors", async () => {
    uploadResult = {
      uploaded: [],
      skipped: [],
      errors: [{ filename: "broken.epub", error: "Not a valid ZIP archive" }],
    };

    await uploadFiles(makeEpub("broken.epub"));

    // No "0 files uploaded" success toast — that regression stays fixed.
    expect(toasts.some((t) => t.color === "success")).toBe(false);
    expect(toasts).toHaveLength(1);
  });
});
