---
"@libris/docs": patch
---

Re-shoot the user-guide screenshots that showed the deleted API-key UI
(libris-xfh).

`libris-59m.35` rewrote the guide but had to _remove_ four screenshot references
rather than update them, because they still showed the pre-Better-Auth surface:
an "API Keys" tab, a setup flow that ended by handing you a key to copy down.
The files stayed on disk, unreferenced, and the Settings chapter shipped with no
pictures of the tabs it describes.

Captured against a seeded install and re-referenced:

- **`initial-setup.webp`** — the first-run form on a genuinely empty install, in
  Getting Started.
- **`settings-connections.webp`** — the Connections tab with three paired
  devices and a configured KoSync credential, in Getting Started and Settings.
- **`settings-account.webp`** (new) — Profile, Password and "Where you are
  signed in" with two browsers listed, in Settings.
- **`settings-users.webp`** (new) — the Users tab with a four-person household,
  admin badges and the per-row actions, in Getting Started and Settings.

Deleted: `settings-api-keys.webp` and `setup-complete.webp`. Both document a
flow that no longer exists — setup now signs the first admin straight in, with
nothing to copy down.

All four are 1376x1403 lossy WebP, matching the screenshots already in the
guide. No credential value appears in any of them: the app-password rows show
only their labels and the non-secret prefix the UI displays by design, the
KoSync password field is empty, and every address is `@example.test`.
