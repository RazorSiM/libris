---
title: OPDS Catalog
order: 8
---

# OPDS Catalog

Libris includes a built-in OPDS catalog server. Any OPDS-compatible e-reader can
browse the library and download books directly over HTTP, without going through
the web UI.

The catalog is served from `<host>/opds`. Access uses HTTP Basic
authentication with the realm `Libris OPDS`. Clients that support OPDS send the
credentials automatically on every browse and download request.

## Supported Readers

Any reader that speaks OPDS can connect, including:

- **KOReader** — open-source reader for Kindle, Kobo, Android, and more.
- **Calibre** — desktop library manager with OPDS browsing.
- **Marvin** — iOS reading app.
- **Thorium** — desktop reader (Windows, macOS, Linux).
- **Foliate** — Linux reader.

Other OPDS clients work the same way: point them at the catalog URL and sign in
with your account email and an app password.

## Connecting a Reader

There is no separate OPDS username and password. You sign a reader in with your
own account email and an **app password** — a per-device credential you mint
yourself, so your account password never goes onto a device.

1. Go to **Settings → Connections** in the Libris web UI.
2. In **App Passwords**, name the device (for example `Kobo Clara`) and click
   **Create app password**. Copy the value; it is shown once and cannot be
   retrieved later.
3. In the **OPDS Catalog** section just below, copy the catalog URL
   (`<host>/opds`).
4. In your reader, add a new OPDS catalog. Enter the URL, your **account email**
   as the username, and the **app password** as the password.

Only the password component is checked, so the username is informational — but
put your real address there anyway, because it is what makes the entry readable
when you come back to it.

Mint one app password per device. Revoking a row from the Connections tab
unpairs exactly that device, on its very next request, and leaves your browser
sessions and every other reader alone. Losing a device therefore costs you one
credential rather than all of them.

::: warning A banned account's devices stop too
Banning a user disables every app password they hold, and unbanning does **not**
re-enable them. A reader that was paired at ban time needs a fresh app password
afterwards. See [Banning](./getting-started.md#banning).
:::

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

Only the credential is per user. Reading progress, manual reading-status
overrides, and the other per-account connections remain private, but the set of
books available over OPDS is the same for everyone.
