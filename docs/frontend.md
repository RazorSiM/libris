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
| `/settings`        | `pages/settings.vue`         | Tabbed: Connections (app passwords, OPDS/KoSync/Hardcover), Account (display name, change password, signed-in devices), and — for admins — Users, System, Jobs, Failed Jobs, Queues, Paths     |
| `/login`           | `pages/login.vue`            | Sign-in, and the first-run admin form while no credential exists. Renders with `layout: false`; the only route in `PUBLIC_PATHS`                                                               |

## Authentication Flow

The SPA authenticates directly with the Hono API via Better Auth's httpOnly session cookie. Sign-in and first-run setup both live on `/login` (`pages/login.vue`), which renders with `layout: false` so the sidebar never appears to a signed-out visitor.

1. `installRouterGuards` (`src/router/guards.ts`) registers one `router.beforeEach`. On the first navigation it awaits `check()`; after that it reads cached auth state.
2. `/login` is the only entry in `PUBLIC_PATHS`. An unauthenticated visit to anything else is redirected to `/login` with the intended destination carried in `?redirect=<fullPath>` (dropped when the target was `/`), so a deep link survives sign-in including its query and hash.
3. `/login` asks `GET /api/setup` which of its two forms to show. `required: true` means nobody on this install can sign in with a password yet — a fresh install, or one upgraded from the pre-Better-Auth schema — and the page renders the **first-run setup form** (name, email, password) instead of the sign-in form. Submitting it calls `POST /api/setup` and then signs in with the credentials just chosen, so the admin lands inside rather than at a second form.
4. Otherwise the page renders the **sign-in form** (email, password), which calls Better Auth's sign-in endpoint through `useAuth().login()`. The cookie is set by the API; `resolveRedirect` sends the user on to their intended destination.
5. All subsequent API requests carry the cookie automatically. `useApiClient()` sends `credentials: "include"`, and the SPA never sees a token.
6. Sign-in failures collapse to a single generic "Invalid email or password", identical whether the address is unknown or the password is wrong, so the form cannot be used to test whether somebody has an account here. Two cases are deliberately distinguishable: a network failure, and a 429 from Better Auth's own limiter (a throttled attempt is not a wrong password, and saying so sends people to reset a password that was fine). There is no forgot-password link — there is no mail transport, so the page says an admin can reset it instead.

7. A session that dies server-side (a ban, a revoke from another device, expiry) is caught by the recovery handler — see [Recovering from a dead session](#recovering-from-a-dead-session) below.

App passwords are a separate credential minted under **Settings → Connections → App Passwords** for e-readers and scripts. They are never used by the SPA.

## Layout

Single `default.vue` layout with:

- **Sidebar:** Logo, search button, nav links (Home, Inbox with badge, Library, Series, Stats), Reading section (Reading, Finished, Unread, Paused links with count badges), your own name (a link to `/settings?tab=account`, with an Admin badge where it applies), Settings link with failed jobs badge, and an external Documentation link (shown only when the runtime config `docsUrl` is set). The color mode and theme toggles are not in the sidebar — they live in each page's toolbar (see Styling).
- **Global search:** Debounced (200ms) command palette searching books and navigation links
- **Content area:** `<RouterView>`

## Composables

Composables are split into general-purpose utilities (`composables/`) and data-fetching queries (`composables/queries/`). All queries use Pinia Colada (`useQuery`/`defineQuery`) with automatic caching and stale-time management.

Detail pages additionally use route-level data loaders defined inline via `defineColadaLoader` from `vue-router/experimental/pinia-colada`: `useInboxDetailLoader` (`pages/inbox/[id].vue`), `useBookDetailLoader` (`pages/library/[id].vue`), and `useSeriesDetailLoader` (`pages/series/[name].vue`). These loaders resolve the page's primary record during navigation and are distinct from the query composables listed below.

### General

| Composable             | Purpose                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `useApiClient()`       | Typed Hono RPC client — cookie-based auth, automatic error wrapping via `ApiError`                                   |
| `useAuth()`            | Auth state (`isAuthenticated`, `isAdmin`, `userId`, `userLabel`, `checked`) and methods (`check`, `login`, `logout`) |
| `useDashboard()`       | Shared keyboard shortcuts (`G+H/I/L/S` navigation, `?` shortcuts modal)                                              |
| `useDebouncedSearch()` | Reactive `search`/`debouncedSearch` ref pair with configurable delay (default 300ms)                                 |
| `useUpload()`          | XHR-based file upload with progress tracking and cancellation                                                        |
| `useServerEvents()`    | WebSocket event streaming for real-time updates (book pipeline, Hardcover sync, job status)                          |
| `useTheme()`           | Color-theme picker state: the selected theme value and the list of available themes (see Styling)                    |
| `useChartTheme()`      | Resolves an ECharts theme object from the current color mode and Nuxt UI design tokens, used by the `/stats` charts  |
| `useLibrisConfig()`    | Returns the runtime `AppConfig` (`docsUrl`, `wsBaseUrl`) loaded from `/config.json` and provided in `main.ts`        |

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

| Component                 | Purpose                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MetadataFieldPicker`     | Multi-source metadata selector — field-by-field candidate selection with manual entry and validation                                                                                         |
| `UploadBookModal`         | Drag-and-drop file upload with progress tracking                                                                                                                                             |
| `EditBookModal`           | Book metadata edit form with Zod validation; embeds `HardcoverSearchPanel` for autofill                                                                                                      |
| `EditReadingStatusModal`  | Sets or clears a manual reading status (unread/reading/finished/paused) with optional started/finished dates; clearing reverts to the KoReader-computed status                               |
| `HardcoverSearchPanel`    | Free-text Hardcover search; emits the picked candidate so callers can autofill forms or selections                                                                                           |
| `ConfirmDialog`           | Reusable confirmation dialog                                                                                                                                                                 |
| `ColorModeToggle`         | Light/Dark/System color-mode switcher; also embeds the `ThemePicker` (rendered in each page toolbar)                                                                                         |
| `ThemePicker`             | `USelect` (with `i-lucide-palette`) for the 12 named color themes; backed by `useTheme()`                                                                                                    |
| `ErrorBoundary`           | Catches and renders errors from its slotted subtree                                                                                                                                          |
| `ApiError`                | Error display with retry button                                                                                                                                                              |
| `RefetchMetadataModal`    | Modal for re-fetching and selecting metadata from external sources                                                                                                                           |
| `SettingsAppPasswords`    | Mint, list and revoke app passwords. The new value is shown once, on creation; labels are capped at 32 characters                                                                            |
| `SettingsAccount*`        | Account tab: `Profile` (display name; email is read-only), `Password` (requires the current one, optional "sign out everywhere else"), `Sessions` (device list with per-row and bulk revoke) |
| `SettingsUsers`           | Admin-only. Create an account, toggle role, ban/unban, set someone's password. The last admin cannot be demoted or banned, and nobody can ban themselves                                     |
| `SettingsJobsBrowser`     | Paginated job browser with queue/status filters, clickable rows opening detail slideover                                                                                                     |
| `SettingsJobDetail`       | Slideover showing full job details: status, timestamps, payload, logs, errors, stack traces                                                                                                  |
| `SettingsQueueManagement` | Queue admin panel with pause/resume, clean failed jobs, and drain actions per queue                                                                                                          |

## Auth

**`useAuth()` composable** (backed by a Pinia `auth` store in `src/stores/auth.ts`): exposes the computed refs `isAuthenticated`, `isAdmin`, `userId`, `userName`, `userEmail`, `userLabel`, plus `checked`. Methods: `check()`, `login(email, password)`, `logout()`, `refresh()`, `setAuthenticated(value)`.

It is the only file in the app that touches `authClient` (`src/lib/auth-client.ts`, the Better Auth Vue client) — every other call site goes through this composable, so the transport lives in one place. `check()` calls `authClient.getSession()`; `login()` calls `authClient.signIn.email()` and then forces a `check()`, because the sign-in response does not carry the role.

`check()` is guarded by a generation counter and a single in-flight promise, both held in the store rather than in the composable's closure — see [One source of truth for who is signed in](#one-source-of-truth-for-who-is-signed-in) below. A failed sign-out request still clears local state rather than stranding the user in a signed-in UI.

On both successful login and logout, `clearFrontendQueryCache()` cancels and removes all Pinia Colada cached queries (via `useQueryCache()` from `@pinia/colada`) to prevent stale data from one user being visible to another after switching accounts.

### One source of truth for who is signed in

`useAuth()` is a plain function with no memoisation, and it is called separately from the router guard, `pages/settings.vue`, several settings components and the mutation composables. Everything that has to agree **across** those call sites therefore lives in the store, not in the closure:

| Store field  | What it is for                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation` | Bumped by anything that changes _who_ is signed in. A session request already on the wire compares the generation it was issued under and discards itself if it no longer matches, so a sign-out cannot be overwritten by a `check()` that started before it. |
| `inFlight`   | The single session request in flight, shared so that N components mounting at once produce one `getSession()`.                                                                                                                                                |

`login()`, `logout()` and `refresh()` all go through `beginNewSession()`, which bumps `generation` and drops `inFlight`.

### Recovering from a dead session

A session can die while a tab sits open — an admin bans you, another device revokes your session, an admin sets your password, or it simply expires. `check()` short-circuits on `checked` for the rest of the page's life, so nothing would notice.

`src/lib/session-invalidation.ts` is the single point that learns about it. Both transports report into it — the `fetch` wrapper in `useApiClient()` and `authClient`'s `fetchOptions.onError` — and `installSessionRecovery()` in `src/router/guards.ts` installs the one handler: `logout()` (which clears the store _and_ the query cache) followed by `router.replace('/login?redirect=…')`.

Two exclusions keep it from firing wrongly:

- 401s from `/sign-in`, `/sign-up`, `/sign-out` and `/get-session` are ignored. Better Auth answers a wrong password on sign-in with 401, and treating that as a dead session would sign out a user who mistyped.
- The handler no-ops when the store already says nobody is signed in, and does not navigate when the user is already on `/login`.

Recoveries do not stack: a page that fires six queries and collects six 401s signs out and redirects once.

Realtime transport is owned by `src/plugins/server-events.ts`, which runs once at app bootstrap in `main.ts` and provides the bus via `app.provide(serverEventsKey, api)`; `useServerEvents()` injects it and is just a subscriber wrapper that unregisters listeners when the calling component scope is disposed. The WebSocket base URL comes from the runtime `wsBaseUrl` config (see `useLibrisConfig()`).

The socket is **keyed on `userId`**, not opened once per tab. The server binds a subscription's user id and admin flag at upgrade time and never re-checks them, so a socket that outlives its session is a subscription in somebody else's name — and sign-out/sign-in are both SPA navigations, with no page load to reset anything. A watcher closes and re-dials whenever the signed-in identity changes, and no socket is opened at all while signed out.

Reconnection is unbounded (`retries` never gives up, backoff doubles to a 30s ceiling) with **one** exception, decided by the close code the plugin reads in `onDisconnected`:

- **`4401` — terminal.** The credential behind the socket is gone: banned, revoked from another device, expired. The plugin stops re-dialling and reports into `reportSessionInvalidated()`, so the user gets the same sign-out-and-redirect as a 401 from either HTTP transport instead of a page that quietly stops updating. Without this a banned tab re-dialled every 30s for as long as it stayed open and explained nothing.
- **`4409` — reconnect.** The session is fine; only this socket's scope is stale (the account was promoted or demoted, or the cookie now resolves to somebody else). The server wants a fresh socket it can rebind, not a sign-out. This is handled explicitly rather than by falling through, because "any 4xxx means signed out" is precisely the shortcut that made a promotion log the user out.
- **Everything else — reconnect.** 1006 from a dropped connection, 1001/1012 from a restart or proxy timeout, 1000 from a missed heartbeat. Treating any of these as terminal would sign people out over a flaky network, which is worse than the bug the 4401 handling fixes.

Both codes are restated in the plugin (`SESSION_REVOKED_CLOSE_CODE`, `SOCKET_RESCOPE_CLOSE_CODE`) rather than imported from the API package — they are wire constants, and importing would pull server code into the SPA bundle. The two-code contract is documented server-side in [architecture.md](architecture.md#revoking-a-live-event-socket). The terminal flag is per-socket and cleared when the identity changes, so the next person to sign in on the tab gets an ordinary socket.

A `4409` re-dial goes through the normal backoff, which is **1s** in practice, not 30s: `retries` resets to 0 on every successful open and the re-scope close can only reach a socket that was open, so the delay is always the first step of the curve. The 30s ceiling is only ever reached after six consecutive failed dials.

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
