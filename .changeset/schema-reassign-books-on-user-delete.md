---
"@libris/api-hono": patch
"@libris/web": patch
---

Deleting a user who owns books no longer 500s and half-deletes their account.

`books.created_by` is NOT NULL with `ON DELETE RESTRICT`, and Better Auth's
`internalAdapter.deleteUser` issues three UN-transacted statements: delete
sessions, delete accounts, delete user. The third hit the constraint after the
first two had already committed. `POST /api/auth/admin/remove-user` answered 500,
the user row survived without its credential so that person could never sign in
again, nothing in the response said so, and every retry failed the same way.
Recovery meant an admin running set-user-password to rebuild the credential.

The schema comment and the cutover test both claimed a reassignment path
existed. It did not. It does now: `reassignBooksOnRemoveUser` moves the target's
books to the acting admin before delegating, so the constraint has nothing left
to reject, and undoes the move if the removal is refused after all. A Libris
library is shared, so the books stay in it rather than leaving with the person.
