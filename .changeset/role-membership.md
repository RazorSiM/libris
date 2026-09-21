---
"@libris/api-hono": patch
"@libris/web": patch
---

Treat admin as a membership test rather than an exact role match. Better Auth stores multiple roles as a comma-joined string, so a user with `admin,user` is now counted as an active admin by the last-admin guard (SQL and session checks), granted admin routes, and shown as an admin in the settings user list. Previously the two-step demotion `admin` → `admin,user` → `user` could lock the sole admin out of the install.
