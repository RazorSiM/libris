import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../../context.js";
import { cachedRoute } from "../../middleware/cache.js";
import {
  buildFeed,
  navigationEntry,
  OPDS_MIME_ACQUISITION,
  OPDS_MIME_NAVIGATION,
  OPDS_MIME_OPENSEARCH,
} from "../../shared/opds-xml.js";
import { getBaseUrl } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const rootCatalogRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "OPDS root catalog",
  description:
    "Returns the top-level OPDS navigation feed with links to New Arrivals, All Books, Genres, Series, and Languages sub-catalogs, plus an OpenSearch descriptor link.",
  middleware: [cachedRoute({ maxAge: 60 })] as const,
  responses: {
    200: {
      description: "OPDS navigation feed (Atom XML)",
      content: {
        [OPDS_MIME_NAVIGATION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsRootRoutes = new OpenAPIHono<{ Variables: AppVariables }>().openapi(
  rootCatalogRoute,
  async (c) => {
    const base = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const now = new Date();

    const entries = [
      navigationEntry({
        id: "urn:libris:opds:new",
        title: "New Arrivals",
        updated: now,
        content: "Recently added books",
        link: {
          rel: "subsection",
          href: `${base}/opds/new`,
          type: OPDS_MIME_ACQUISITION,
        },
      }),
      navigationEntry({
        id: "urn:libris:opds:books",
        title: "All Books",
        updated: now,
        content: "Browse all books alphabetically",
        link: {
          rel: "subsection",
          href: `${base}/opds/books`,
          type: OPDS_MIME_ACQUISITION,
        },
      }),
      navigationEntry({
        id: "urn:libris:opds:genres",
        title: "Genres",
        updated: now,
        content: "Browse books by genre",
        link: {
          rel: "subsection",
          href: `${base}/opds/genres`,
          type: OPDS_MIME_NAVIGATION,
        },
      }),
      navigationEntry({
        id: "urn:libris:opds:series",
        title: "Series",
        updated: now,
        content: "Browse books by series",
        link: {
          rel: "subsection",
          href: `${base}/opds/series`,
          type: OPDS_MIME_NAVIGATION,
        },
      }),
      navigationEntry({
        id: "urn:libris:opds:languages",
        title: "Languages",
        updated: now,
        content: "Browse books by language",
        link: {
          rel: "subsection",
          href: `${base}/opds/languages`,
          type: OPDS_MIME_NAVIGATION,
        },
      }),
    ];

    const xml = buildFeed(
      {
        id: "urn:libris:opds:root",
        title: "Libris",
        updated: now,
        selfHref: `${base}/opds`,
        selfType: OPDS_MIME_NAVIGATION,
        startHref: `${base}/opds`,
      },
      entries,
      [`  <link rel="search" type="${OPDS_MIME_OPENSEARCH}" href="${base}/opds/search"/>`],
    );

    return new Response(xml, {
      headers: { "Content-Type": OPDS_MIME_NAVIGATION },
    });
  },
);
