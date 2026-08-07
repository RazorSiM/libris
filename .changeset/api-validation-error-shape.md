---
"@libris/api-hono": patch
---

Return the documented validation error shape (`{"error":"Validation failed","issues":[...]}`) from every endpoint. Routers built their own OpenAPI instance at import time, so the root app's validation hook never reached them and an invalid request came back as a raw serialized ZodError. All routers are now built through one factory that installs the hook, and a test fails CI if a new router skips it.
