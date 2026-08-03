# Frontend

The web app lives at `apps/web/` and is a Vue 3 SPA built with Vite+ (the `vp` CLI, Rolldown-Vite under the hood), vue-router 5 (file-based routing via `vue-router/unplugin/vite` + data loaders via `vue-router/experimental/pinia-colada`), Nuxt UI v4 (the component library — framework-agnostic), and Tailwind CSS v4. It is not a Nuxt app; there is no `nuxt` dependency. It runs on port 3100 in development.

## Pages

Pages live under `src/pages/` (auto-routed by vue-router's file-based routing).

| Route              | File                         | Purpose                                                                                                                                                                                        |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                | `pages/index.vue`            | Dashboard: stats cards, currently reading, recent additions, pipeline status                                                                                                                   |
| `/inbox`           | `pages/inbox/index.vue`      | Paginated inbox list with search, sort, upload button, processing status, and uploader attribution                                                                                             |
| `/inbox/:id`       | `pages/inbox/[id].vue`       | Metadata review: candidate picker, duplicate warnings, approve/delete/rescan, uploader attribution                                                                                             |
| `/library`         | `pages/library/index.vue`    | Library grid/list view with full-text search, pagination, and a consolidated filter panel for author, genre, language, series, and uploader                                                    |
| `/library/:id`     | `pages/library/[id].vue`     | Book detail: metadata, uploader attribution, files/downloads, reading-progress per device, and (owner/admin) Edit metadata, Edit reading status, Refetch metadata, Re-organize, Delete actions |
| `/reading`         | `pages/reading/index.vue`    | Thin redirect to `/reading/reading` (sidebar anchor for the Reading section)                                                                                                                   |
| `/reading/:status` | `pages/reading/[status].vue` | Filtered reading list: reading, finished, unread, paused                                                                                                                                       |
| `/series`          | `pages/series/index.vue`     | Series browsing page with search, cover grid, and book counts                                                                                                                                  |
| `/series/:name`    | `pages/series/[name].vue`    | Series detail: ordered book list with position numbers, covers, genres                                                                                                                         |
| `/stats`           | `pages/stats.vue`            | Reading analytics: books finished, streaks, daily activity chart, genre distribution                                                                                                           |
| `/settings`        | `pages/settings.vue`         | Tabbed: Connections (app passwords, OPDS/KoSync/Hardcover), Account (display name, change password), and — for admins — Users, System, Jobs, Failed Jobs, Queues, Paths                        |

## Authentication Flow

The SPA authenticates directly with the Hono API via httpOnly cookies.

1. User enters API key on `/settings` (or runs first-time setup)
2. The SPA calls the Hono API's `/api/auth/login` endpoint, which validates the key and sets an httpOnly auth cookie
3. All subsequent API requests include the cookie automatically — the Hono API reads it to authenticate
4. A `router.beforeEach` guard (`src/router/guards.ts`) checks auth state on every navigation and redirects unauthenticated users to `/settings`

## Layout

Single `default.vue` layout with:

- **Sidebar:** Logo, search button, nav links (Home, Inbox with badge, Library, Series, Stats), Reading section (Reading, Finished, Unread, Paused links with count badges), your own name (a link to `/settings?tab=account`, with an Admin badge where it applies), Settings link with failed jobs badge, and an external Documentation link (shown only when the runtime config `docsUrl` is set). The color mode and theme toggles are not in the sidebar — they live in each page's toolbar (see Styling).
- **Global search:** Debounced (200ms) command palette searching books and navigation links
- **Content area:** `<RouterView>`

## Composables

Composables are split into general-purpose utilities (`composables/`) and data-fetching queries (`composables/queries/`). All queries use Pinia Colada (`useQuery`/`defineQuery`) with automatic caching and stale-time management.

Detail pages additionally use route-level data loaders defined inline via `defineColadaLoader` from `vue-router/experimental/pinia-colada`: `useInboxDetailLoader` (`pages/inbox/[id].vue`), `useBookDetailLoader` (`pages/library/[id].vue`), and `useSeriesDetailLoader` (`pages/series/[name].vue`). These loaders resolve the page's primary record during navigation and are distinct from the query composables listed below.

### General

| Composable             | Purpose                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `useApiClient()`       | Typed Hono RPC client — cookie-based auth, automatic error wrapping via `ApiError`                                  |
| `useAuth()`            | Auth state (`isAuthenticated`, `checked`) and methods (`check`, `login`, `logout`)                                  |
| `useDashboard()`       | Shared keyboard shortcuts (`G+H/I/L/S` navigation, `?` shortcuts modal)                                             |
| `useDebouncedSearch()` | Reactive `search`/`debouncedSearch` ref pair with configurable delay (default 300ms)                                |
| `useUpload()`          | XHR-based file upload with progress tracking and cancellation                                                       |
| `useServerEvents()`    | WebSocket event streaming for real-time updates (book pipeline, Hardcover sync, job status)                         |
| `useTheme()`           | Color-theme picker state: the selected theme value and the list of available themes (see Styling)                   |
| `useChartTheme()`      | Resolves an ECharts theme object from the current color mode and Nuxt UI design tokens, used by the `/stats` charts |
| `useLibrisConfig()`    | Returns the runtime `AppConfig` (`docsUrl`, `wsBaseUrl`) loaded from `/config.json` and provided in `main.ts`       |

### Query Composables (`queries/`)

| Composable                   | Purpose                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `useDashboardQuery()`        | Dashboard data (stats, currently reading, recent additions)                           |
| `useInboxListQuery()`        | Paginated inbox list with search and sort                                             |
| `useInboxProcessingQuery()`  | Currently processing inbox items                                                      |
| `useInboxDetailQuery()`      | Single inbox item with metadata candidates                                            |
| `useLibraryListQuery()`      | Paginated library list with search plus author/genre/language/series/uploader filters |
| `useLibraryFacetsQuery()`    | Library filter facets (authors, genres, languages, series, uploaders)                 |
| `useBookDetailQuery()`       | Single book detail                                                                    |
| `useBookProgressQuery()`     | Reading progress for a single book                                                    |
| `useReadingQuery()`          | Filtered reading list by status (reading, finished, unread, paused)                   |
| `useSeriesListQuery()`       | Series list with search                                                               |
| `useSeriesDetailQuery()`     | Series detail with ordered book list                                                  |
| `useStatsQuery()`            | Reading analytics data                                                                |
| `useSettingsStatusQuery()`   | Combined settings status (health, queues, credentials, app settings)                  |
| `useHardcoverStatusQuery()`  | Hardcover connection status                                                           |
| `useHardcoverSyncLogQuery()` | Hardcover sync log entries                                                            |
| `useHardcoverSearch()`       | Debounced free-text search against Hardcover for manual metadata autofill             |
| `useJobsQuery()`             | Paginated job browser with queue/status filters                                       |
| `useInboxCountQuery()`       | Inbox count for sidebar badge                                                         |
| `useReadingCountsQuery()`    | Reading status counts for sidebar badges                                              |
| `useFailedJobsCountQuery()`  | Failed jobs count for settings badge                                                  |

## Components

| Component                 | Purpose                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MetadataFieldPicker`     | Multi-source metadata selector — field-by-field candidate selection with manual entry and validation                                                           |
| `UploadBookModal`         | Drag-and-drop file upload with progress tracking                                                                                                               |
| `EditBookModal`           | Book metadata edit form with Zod validation; embeds `HardcoverSearchPanel` for autofill                                                                        |
| `EditReadingStatusModal`  | Sets or clears a manual reading status (unread/reading/finished/paused) with optional started/finished dates; clearing reverts to the KoReader-computed status |
| `HardcoverSearchPanel`    | Free-text Hardcover search; emits the picked candidate so callers can autofill forms or selections                                                             |
| `ConfirmDialog`           | Reusable confirmation dialog                                                                                                                                   |
| `ColorModeToggle`         | Light/Dark/System color-mode switcher; also embeds the `ThemePicker` (rendered in each page toolbar)                                                           |
| `ThemePicker`             | `USelect` (with `i-lucide-palette`) for the 12 named color themes; backed by `useTheme()`                                                                      |
| `ErrorBoundary`           | Catches and renders errors from its slotted subtree                                                                                                            |
| `ApiError`                | Error display with retry button                                                                                                                                |
| `RefetchMetadataModal`    | Modal for re-fetching and selecting metadata from external sources                                                                                             |
| `SettingsJobsBrowser`     | Paginated job browser with queue/status filters, clickable rows opening detail slideover                                                                       |
| `SettingsJobDetail`       | Slideover showing full job details: status, timestamps, payload, logs, errors, stack traces                                                                    |
| `SettingsQueueManagement` | Queue admin panel with pause/resume, clean failed jobs, and drain actions per queue                                                                            |

## Auth

**`useAuth()` composable** (backed by a Pinia `auth` store in `src/stores/auth.ts`): Exposes `isAuthenticated`, `isAdmin`, `userLabel`, `apiKeyId` (computed) and `checked` refs. Methods: `check()`, `login(apiKey)`, `logout()`, `setAuthenticated(value)`. Auth state is checked via the Hono API `/api/auth/session` endpoint using the typed RPC client. Login sets an httpOnly cookie directly on the API. On both successful login and logout, `clearFrontendQueryCache()` cancels and removes all Pinia Colada cached queries (via `useQueryCache()` from `@pinia/colada`) to prevent stale data from one user being visible to another after switching accounts.

Realtime transport is owned by `src/plugins/server-events.ts`, which runs once at app bootstrap in `main.ts` and opens a single `/api/events` WebSocket per browser tab (the WebSocket base URL comes from the runtime `wsBaseUrl` config, see `useLibrisConfig()`). The bus is exposed via `app.provide(serverEventsKey, api)`; `useServerEvents()` injects it and is just a subscriber wrapper that unregisters listeners when the calling component scope is disposed.

## Keyboard Shortcuts

- `?` — Toggle keyboard shortcuts modal
- `G` then `H` — Go to Home
- `G` then `I` — Go to Inbox
- `G` then `L` — Go to Library
- `G` then `S` — Go to Settings
- `Escape` — Back to parent page (from detail views: inbox detail, library detail, series detail)

## Styling

- **Theme:** Nuxt UI v4 with blue primary, zinc neutral
- **Color themes:** A 12-theme color picker is available via `useTheme()` (`src/composables/useTheme.ts`): Default, Ayu, Catppuccin, Dracula, Gruvbox, Material, Nord, One, Rosé Pine, Sepia, Solarized, and Tokyo Night. The selection persists to the `localStorage` key `libris-theme` and is applied by setting a `data-theme` attribute on `<html>` (the Default theme removes the attribute). It is surfaced by `ThemePicker.vue`, which is bundled inside `ColorModeToggle.vue` next to the light/dark/system `UColorModeSelect`. `ColorModeToggle` is rendered in each page's toolbar (index, inbox, library, reading, series, settings, stats), not in the sidebar.
- **Font:** Merriweather (serif variable font via `@fontsource-variable/merriweather`, imported in `src/main.ts`)
- **Dark mode:** Full support via `useColorMode()`
- **Icons:** Lucide via Iconify
- **Cover images:** Library and inbox covers use native `<img loading="lazy">` because the cover sources are authenticated API endpoints and need the browser's cookie-authenticated request path.

## Form Validation

Zod schemas in `utils/schemas.ts`: ISBN-10/13 format, year range (1000-2100), page count, cover URL (HTTP/HTTPS).
