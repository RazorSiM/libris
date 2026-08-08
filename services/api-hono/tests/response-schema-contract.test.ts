/**
 * A response must be the shape its own OpenAPI schema says it is (libris-dnx).
 *
 * `PATCH /api/library/{id}` and `POST /api/library/{id}/apply-metadata` both
 * declare `BookUpdatedSchema` and both fulfilled it with a bare
 * `db.update(…).returning()` — the argument-less form, which returns EVERY
 * column of `books`. That includes `search_vector`: the internal tsvector the
 * schema deliberately omits, a lexeme dump of the title, author, series and
 * description, shipped to the client on every metadata edit and described by
 * nothing in the OpenAPI document.
 *
 * Asserted against the schema each route actually names in its `responses`,
 * never against a hand-copied field list — a test carrying its own copy of the
 * shape can agree with neither side and still pass.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { bootstrapAdmin, createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import type { AppServices } from "../src/bootstrap.js";
import { books } from "../src/db/schema.js";
import { BookUpdatedSchema } from "../src/shared/schemas.js";

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let services: AppServices;

let adminKey: string;
let adminUserId: string;

function adminAuth() {
  return { authorization: `Bearer ${adminKey}` };
}

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  services = testApp.services;
});

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });
  const admin = await bootstrapAdmin(services, $fetchRaw);
  adminUserId = admin.userId;
  adminKey = admin.rawKey;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });
});

describe("the book-edit routes return their declared shape and nothing else", () => {
  let bookId: string;

  beforeEach(async () => {
    const { data } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [
          {
            title: "The Left Hand of Darkness",
            author: "Ursula K. Le Guin",
            description: "Envoy to a world without fixed gender.",
            status: "organized",
          },
        ],
      },
    });
    bookId = data.inserted[0].id;
    await testDb.update(books).set({ createdBy: adminUserId }).where(eq(books.id, bookId));
  });

  it("PATCH /api/library/{id} does not ship search_vector", async () => {
    const { data, status } = await $fetchRaw(`/api/library/${bookId}`, {
      method: "PATCH",
      body: { title: "The Dispossessed" },
      headers: adminAuth(),
    });

    expect(status).toBe(200);
    // The assertion that was red before the fix. `search_vector` is maintained
    // by a trigger over title/author/series/description, so the seeded book has
    // a populated one, and the bare `.returning()` handed the whole lexeme dump
    // to the client under `searchVector`.
    expect(data).not.toHaveProperty("searchVector");
    expect(data).not.toHaveProperty("search_vector");
  });

  it("PATCH /api/library/{id} returns exactly the fields BookUpdatedSchema declares", async () => {
    const { data } = await $fetchRaw(`/api/library/${bookId}`, {
      method: "PATCH",
      body: { title: "The Dispossessed" },
      headers: adminAuth(),
    });

    // Not a subset check: an extra key IS the defect. Compared against the very
    // schema the route names in its `responses`, so widening one side without
    // the other fails here.
    expect(Object.keys(data).sort()).toEqual(Object.keys(BookUpdatedSchema.shape).sort());
    expect(data.title).toBe("The Dispossessed");
  });

  it("POST /api/library/{id}/apply-metadata returns exactly those fields too", async () => {
    // Same schema, second call site — its bare `.returning()` sat inside a
    // transaction, so fixing only PATCH would have left this one leaking.
    const { data, status } = await $fetchRaw(`/api/library/${bookId}/apply-metadata`, {
      method: "POST",
      body: { fields: { publisher: { source: "manual", value: "Ace Books" } } },
      headers: adminAuth(),
    });

    expect(status).toBe(200);
    expect(data).not.toHaveProperty("searchVector");
    expect(Object.keys(data).sort()).toEqual(Object.keys(BookUpdatedSchema.shape).sort());
    expect(data.publisher).toBe("Ace Books");
  });

  it("POST /api/books/{id}/approve returns exactly its declared fields too", async () => {
    // The same shape on the review surface, found while checking whether the
    // two library routes were alone. It declared a hand-written seven-field
    // summary and answered with the entire row — so it leaked search_vector,
    // and the fields callers do read off it (isbn13, publisher, language,
    // approvedAt) were undeclared. It now declares the same BookUpdatedSchema
    // the library edit routes do, which is what the response always was minus
    // the tsvector.
    const { data: seeded } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: { books: [{ title: "Awaiting Review", author: "Someone", status: "review" }] },
    });
    const reviewId = seeded.inserted[0].id;
    await testDb.update(books).set({ createdBy: adminUserId }).where(eq(books.id, reviewId));

    const { data, status } = await $fetchRaw(`/api/books/${reviewId}/approve`, {
      method: "POST",
      body: { fields: { title: { source: "manual", value: "Reviewed Title" } } },
      headers: adminAuth(),
    });

    expect(status).toBe(200);
    expect(data).not.toHaveProperty("searchVector");
    expect(Object.keys(data).sort()).toEqual(Object.keys(BookUpdatedSchema.shape).sort());
    expect(data.title).toBe("Reviewed Title");
  });
});
