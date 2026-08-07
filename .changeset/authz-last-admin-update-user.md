---
"@libris/api-hono": patch
---

Close the last-admin bypass through `POST /api/auth/admin/update-user`.

The guard that stops an install from losing its final administrator was wired to
three named Better Auth endpoints (`set-role`, `ban-user`, `remove-user`), but
the admin plugin's `update-user` performs the same writes with the role and ban
fields nested under `data`. An admin could therefore demote themselves through
`update-user` and leave the instance with zero admins — no job queue access, no
settings changes, no way to create a replacement admin without editing the
database by hand.

The middleware now covers the whole `/api/auth/admin/*` subtree and classifies
each endpoint itself, reading the privilege fields in both the flat and the
nested body shape. Endpoints Better Auth adds in future are guarded by default
whenever they carry a role or ban field, and a test enumerates the installed
plugin's routes so an unclassified new endpoint fails the build.
