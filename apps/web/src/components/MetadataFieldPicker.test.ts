// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { shallowMount } from "@vue/test-utils";
import type { MetadataSource } from "@libris/api-hono/types";
import type { Candidate } from "./MetadataFieldPicker.types";

// Provide Vue composition APIs that Nuxt normally auto-imports
Object.assign(globalThis, { ref, computed, reactive, watch });

// Provide Nuxt auto-imported schemas
const schemas = await import("../utils/schemas");
Object.assign(globalThis, {
  isbn10Schema: schemas.isbn10Schema,
  isbn13Schema: schemas.isbn13Schema,
  yearStringSchema: schemas.yearStringSchema,
  pageCountStringSchema: schemas.pageCountStringSchema,
  coverUrlSchema: schemas.coverUrlSchema,
});

const MetadataFieldPicker = (await import("./MetadataFieldPicker.vue")).default;

type FieldSelection = { source: string; value: unknown };
type SelectionsMap = Record<string, FieldSelection>;

// --- Test helpers ---
function makeCandidate(
  source: MetadataSource,
  confidence: string,
  normalized: Record<string, unknown>,
): Candidate {
  return {
    id: `${source}-1`,
    source,
    confidence,
    normalized,
  };
}

function lastEmitted(wrapper: ReturnType<typeof shallowMount>): SelectionsMap {
  const emitted = wrapper.emitted("update:modelValue")!;
  return emitted[emitted.length - 1]![0] as SelectionsMap;
}

const primaryCandidate = makeCandidate("hardcover", "0.9", {
  title: "The Great Gatsby",
  author: "F. Scott Fitzgerald",
  isbn10: "0743273567",
  isbn13: "9780743273565",
  publisher: "Scribner",
  publishedYear: 1925,
  language: "en",
  description: "A novel about the American Dream.",
  pageCount: 180,
  genres: ["Fiction", "Classic"],
  coverUrl: "https://hardcover.app/cover-primary.jpg",
});

const hardcoverCandidate = makeCandidate("hardcover", "0.7", {
  title: "The Great Gatsby",
  author: "Francis Scott Fitzgerald",
  isbn13: "9780743273565",
  publisher: "Charles Scribner's Sons",
  publishedYear: 1925,
  description: "Set in the Jazz Age on Long Island...",
  pageCount: 218,
  genres: ["Novel", "Fiction"],
  coverUrl: "https://hardcover.app/cover.jpg",
});

const fileCandidate = makeCandidate("file", "0.5", {
  title: "The Great Gatsby",
  author: "F. Scott Fitzgerald",
  coverUrl: "cover.jpg",
});

const stubs = {
  UFormField: { template: '<div class="u-form-field"><slot /></div>', props: ["error"] },
  UInput: {
    template: '<input class="u-input" :value="modelValue" />',
    props: ["modelValue", "type", "placeholder", "size"],
    emits: ["update:modelValue", "focus"],
  },
  UTextarea: {
    template: '<textarea class="u-textarea">{{ modelValue }}</textarea>',
    props: ["modelValue", "placeholder", "size", "rows"],
    emits: ["update:modelValue", "focus"],
  },
  UBadge: {
    template: '<span class="u-badge"><slot /></span>',
    props: ["variant", "color", "size"],
  },
};

function mountPicker(opts: { candidates?: Candidate[]; bookId?: string } = {}) {
  return shallowMount(MetadataFieldPicker, {
    props: {
      candidates: opts.candidates ?? [primaryCandidate, hardcoverCandidate],
      bookId: opts.bookId,
      modelValue: {},
    },
    global: { stubs },
  });
}

describe("MetadataFieldPicker", () => {
  describe("field rendering", () => {
    it("renders all 12 metadata fields", () => {
      const wrapper = mountPicker();
      const labels = wrapper.findAll(".text-sm.font-medium.text-highlighted");
      const labelTexts = labels.map((l) => l.text());
      expect(labelTexts).toEqual([
        "Title",
        "Author",
        "Publisher",
        "Year",
        "ISBN-10",
        "ISBN-13",
        "Language",
        "Description",
        "Pages",
        "Series",
        "Genres",
        "Cover",
      ]);
    });

    it("shows source labels for candidates with values", () => {
      const wrapper = mountPicker({ candidates: [primaryCandidate] });
      const sourceLabels = wrapper.findAll(".text-xs.font-medium.text-muted");
      const texts = sourceLabels.map((s) => s.text());
      expect(texts).toContain("Hardcover");
      expect(texts).toContain("Manual");
    });

    it("shows confidence percentages", () => {
      const wrapper = mountPicker({ candidates: [primaryCandidate] });
      const html = wrapper.html();
      expect(html).toContain("90%");
    });

    it("shows 'No metadata found' hint for fields with no sources", () => {
      const emptyCandidate = makeCandidate("hardcover", "0.9", {
        title: "Only Title",
      });
      const wrapper = mountPicker({ candidates: [emptyCandidate] });
      const hints = wrapper.findAll(".text-xs.text-dimmed.italic");
      expect(hints.length).toBeGreaterThan(0);
      expect(hints[0]!.text()).toBe("No metadata found — enter manually");
    });
  });

  describe("source selection", () => {
    it("auto-selects highest confidence source on mount", async () => {
      const wrapper = mountPicker();
      await nextTick();
      const emitted = wrapper.emitted("update:modelValue");
      expect(emitted).toBeTruthy();
      const selections = lastEmitted(wrapper);
      // Primary has 0.9 confidence vs secondary 0.7 — primary auto-selected
      expect(selections.title!.source).toBe("hardcover");
      expect(selections.title!.value).toBe("The Great Gatsby");
      expect(selections.author!.source).toBe("hardcover");
    });

    it("sorts sources by confidence (highest first)", () => {
      const wrapper = mountPicker();
      // For title: hardcover 0.9, hardcover 0.7, Manual
      const radioInputs = wrapper.findAll('input[type="radio"][name="title"]');
      expect(radioInputs.length).toBe(3);
      // First radio should be checked (auto-selected highest confidence)
      expect((radioInputs[0]!.element as HTMLInputElement).checked).toBe(true);
    });

    it("selects source on radio change", async () => {
      const wrapper = mountPicker();
      await nextTick();

      // Click the second radio (Hardcover) for the title field
      const titleRadios = wrapper.findAll('input[type="radio"][name="title"]');
      await titleRadios[1]!.trigger("change");
      await nextTick();

      const selections = lastEmitted(wrapper);
      expect(selections.title!.source).toBe("hardcover");
      expect(selections.title!.value).toBe("The Great Gatsby");
    });

    it("does not re-auto-select when selections already exist", async () => {
      const wrapper = shallowMount(MetadataFieldPicker, {
        props: {
          candidates: [primaryCandidate],
          modelValue: { title: { source: "manual", value: "Custom Title" } },
        },
        global: { stubs },
      });
      await nextTick();

      // Auto-select should NOT overwrite existing selections
      const emitted = wrapper.emitted("update:modelValue");
      if (emitted && emitted.length > 0) {
        const selections = lastEmitted(wrapper);
        if (selections.title) {
          expect(selections.title.source).toBe("manual");
        }
      }
    });
  });

  describe("manual input", () => {
    it("selects manual source when manual radio is clicked", async () => {
      const wrapper = mountPicker();
      await nextTick();

      const titleRadios = wrapper.findAll('input[type="radio"][name="title"]');
      const manualRadio = titleRadios[titleRadios.length - 1]!;
      await manualRadio.trigger("change");
      await nextTick();

      const selections = lastEmitted(wrapper);
      expect(selections.title!.source).toBe("manual");
    });

    it("parses number fields as numbers", async () => {
      const wrapper = mountPicker();
      await nextTick();

      const yearRadios = wrapper.findAll('input[type="radio"][name="publishedYear"]');
      const manualRadio = yearRadios[yearRadios.length - 1]!;
      await manualRadio.trigger("change");
      await nextTick();

      const selections = lastEmitted(wrapper);
      expect(selections.publishedYear!.source).toBe("manual");
      // Empty manual value for number type returns null
      expect(selections.publishedYear!.value).toBeNull();
    });

    it("parses tags field as comma-separated array", async () => {
      const wrapper = mountPicker({ candidates: [] });
      await nextTick();

      const genreRadios = wrapper.findAll('input[type="radio"][name="genres"]');
      const manualRadio = genreRadios[genreRadios.length - 1]!;
      await manualRadio.trigger("change");
      await nextTick();

      const selections = lastEmitted(wrapper);
      expect(selections.genres!.source).toBe("manual");
      // Empty tags value returns []
      expect(selections.genres!.value).toEqual([]);
    });
  });

  describe("cover filtering", () => {
    it("resolves HTTP cover URLs directly", () => {
      const wrapper = mountPicker({ candidates: [primaryCandidate] });
      const imgs = wrapper.findAll("img");
      const coverImg = imgs.find((img) => img.attributes("src")?.startsWith("https://"));
      expect(coverImg).toBeTruthy();
      expect(coverImg!.attributes("src")).toBe("https://hardcover.app/cover-primary.jpg");
    });

    it("resolves bare filename covers via inbox endpoint when bookId provided", () => {
      const wrapper = mountPicker({
        candidates: [fileCandidate],
        bookId: "book-123",
      });
      const imgs = wrapper.findAll("img");
      const coverImg = imgs.find((img) => img.attributes("src") === "/api/inbox/book-123/cover");
      expect(coverImg).toBeTruthy();
    });

    it("does not render cover image for bare filename when no bookId", () => {
      const wrapper = mountPicker({
        candidates: [fileCandidate],
        bookId: undefined,
      });
      const imgs = wrapper.findAll("img");
      expect(imgs.length).toBe(0);
    });
  });

  describe("validation", () => {
    it("exposes hasValidationErrors as false when no manual fields selected", async () => {
      const wrapper = mountPicker();
      await nextTick();
      expect((wrapper.vm as unknown as { hasValidationErrors: boolean }).hasValidationErrors).toBe(
        false,
      );
    });

    it("reports no validation errors for empty manual values (optional fields)", async () => {
      const wrapper = mountPicker();
      await nextTick();

      const isbn10Radios = wrapper.findAll('input[type="radio"][name="isbn10"]');
      const manualRadio = isbn10Radios[isbn10Radios.length - 1]!;
      await manualRadio.trigger("change");
      await nextTick();

      // Empty value passes validation (schemas allow empty strings)
      expect((wrapper.vm as unknown as { hasValidationErrors: boolean }).hasValidationErrors).toBe(
        false,
      );
    });
  });

  describe("genres display", () => {
    it("renders genre tags as badges", () => {
      const wrapper = mountPicker({ candidates: [primaryCandidate] });
      const badges = wrapper.findAll(".u-badge");
      const badgeTexts = badges.map((b) => b.text());
      expect(badgeTexts).toContain("Fiction");
      expect(badgeTexts).toContain("Classic");
    });
  });

  describe("description display", () => {
    it("renders description text with line clamping", () => {
      const wrapper = mountPicker({ candidates: [primaryCandidate] });
      const descParas = wrapper.findAll("p.line-clamp-3");
      expect(descParas.length).toBeGreaterThan(0);
      expect(descParas[0]!.text()).toBe("A novel about the American Dream.");
    });
  });

  describe("source filtering", () => {
    it("excludes sources with null values", () => {
      const candidate = makeCandidate("hardcover", "0.9", {
        title: "Has Title",
        author: null,
      });
      const wrapper = mountPicker({ candidates: [candidate] });
      const authorRadios = wrapper.findAll('input[type="radio"][name="author"]');
      expect(authorRadios.length).toBe(1); // only manual
    });

    it("excludes sources with empty string values", () => {
      const candidate = makeCandidate("hardcover", "0.9", {
        title: "Has Title",
        publisher: "",
      });
      const wrapper = mountPicker({ candidates: [candidate] });
      const publisherRadios = wrapper.findAll('input[type="radio"][name="publisher"]');
      expect(publisherRadios.length).toBe(1); // only manual
    });

    it("excludes sources with empty array values", () => {
      const candidate = makeCandidate("hardcover", "0.9", {
        title: "Has Title",
        genres: [],
      });
      const wrapper = mountPicker({ candidates: [candidate] });
      const genreRadios = wrapper.findAll('input[type="radio"][name="genres"]');
      expect(genreRadios.length).toBe(1); // only manual
    });
  });
});
