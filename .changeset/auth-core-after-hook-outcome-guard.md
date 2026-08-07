---
"@libris/api-hono": patch
---

Stop an unauthenticated caller from force-logging-out any user. Better Auth's dispatcher converts an endpoint's authorization failure into a return value and runs `hooks.after` regardless, so the hook on `/admin/set-user-password` read `userId` off the body of a _rejected_ request and deleted that user's sessions anyway — a credential-free denial of service when looped over admin ids. The hook now inspects the endpoint's outcome and does nothing unless it succeeded.
