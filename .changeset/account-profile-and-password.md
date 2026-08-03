---
"@libris/web": minor
---

Add an Account tab to Settings: change your own password, and edit your display
name.

Until now the only way to change a password was to ask an admin to set one for
you, which meant the household's one admin was a bottleneck for something every
user should be able to do alone. The tab is visible to everyone; nothing on it
is an admin concern.

- **Password.** Requires the current password, confirms the new one client-side,
  and offers "Sign out everywhere else" — Better Auth's `revokeOtherSessions`,
  which ends every other browser and re-issues this one a fresh cookie. App
  passwords deliberately survive it: they are separate credentials with their own
  revocation on the Connections tab, and silently unpairing every e-reader in the
  house would be a worse surprise than leaving them alone. The checkbox says so.
- **Profile.** The display name is editable. Email is read-only with an
  explanation, because Better Auth refuses to change it and an editable field
  would be a promise the server does not keep.
- Your name in the sidebar is now a link to the tab, which is where people look
  for "change my password".

A rejected current password reports "That is not your current password" rather
than Better Auth's "Invalid password", which on a form with three password
fields reads as though the new one was refused.

Also fixes the app-password reveal banner rendering the literal characters `\n`
around its warning text — the one piece of copy on that panel that has to be
read carefully.
