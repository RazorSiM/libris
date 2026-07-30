---
title: OPDS Catalog
order: 8
---

# OPDS Catalog

Libris includes a built-in OPDS catalog server. Any OPDS-compatible e-reader can
browse the library and download books directly over HTTP, without going through
the web UI.

The catalog is served from `<host>/opds`. Access uses HTTP Basic
authentication with the realm `libris-opds`. Clients that support OPDS send the
credentials automatically on every browse and download request.

## Supported Readers

Any reader that speaks OPDS can connect, including:

- **KOReader** — open-source reader for Kindle, Kobo, Android, and more.
- **Calibre** — desktop library manager with OPDS browsing.
- **Marvin** — iOS reading app.
- **Thorium** — desktop reader (Windows, macOS, Linux).
- **Foliate** — Linux reader.

Other OPDS clients work the same way: point them at the catalog URL and supply
your OPDS credentials.

## Connecting a Reader

1. Go to **Settings > Connections** in the Libris web UI.
2. In the **OPDS Catalog** section, note the catalog URL (`<host>/opds`).
3. Set a username and password for OPDS access. These credentials are stored
   per user (hashed with bcrypt) and are independent of your web session.
4. In your reader, add a new OPDS catalog and enter the URL and the username and
   password you set.

Each user has their own OPDS credentials. The credentials are the only per-user
part of OPDS — see [The catalog is shared](#the-catalog-is-shared) below.

## What You Can Browse

The root catalog (`<host>/opds`) is a navigation feed with these entries:

- **New Arrivals** (`/opds/new`) — recently added books.
- **All Books** (`/opds/books`) — a paginated feed of every organized book,
  sorted alphabetically by title.
- **Genres** (`/opds/genres`) — books grouped by genre.
- **Series** (`/opds/series`) — books grouped by series.
- **Languages** (`/opds/languages`) — books grouped by language. Only the
  languages actually present in the library are listed, rendered as full names
  from their ISO 639-1 codes.
- **Search** — full-text search exposed as an OpenSearch descriptor
  (`/opds/search`), so readers that support search can query the catalog from
  within the app.

There is no top-level "by author" feed. A per-author acquisition feed exists at
`/opds/authors/{slug}`, where `{slug}` is a URL-friendly form of the author name.
Author names appear on each book entry; reaching an author feed depends on the
reader following that path.

## Downloading Books

Books are downloaded directly from the catalog. Only **EPUB** is a recognized
download format — it is the only format mapped to an OPDS acquisition link
(`application/epub+zip`). The same credentials used for browsing apply to
downloads; readers send them automatically.

## The Catalog Is Shared

The OPDS catalog serves the shared organized library. Every authenticated OPDS
user sees the entire catalog, regardless of who uploaded each book. The feed is
filtered only by status (organized books), not by uploader.

Only the OPDS credentials are per user. Reading progress, manual reading-status
overrides, and other service credentials remain per user, but the set of books
available over OPDS is the same for everyone.
