---
"@libris/web": patch
---

Refresh the device list after you change your password.

Changing your password rotates this browser's session token, and with "Sign out
everywhere else" ticked it deletes every other session — but the mutation
invalidated nothing, and the signed-in devices card renders directly below the
password form. So the toast said every other browser had been signed out while
the card below still listed the phone and the work laptop with live "Sign out"
buttons. Clicking one fired a revoke for a token that no longer existed and
reported "Could not sign that device out" for a device that had in fact been
signed out, leaving the user unable to tell whether the revocation worked. The
"This browser" badge was wrong for the same reason: it is derived by comparing
the listed tokens against the current session's, which had just rotated.

The password change now invalidates the sessions query when it settles, the same
as every other mutation that ends a session, and the query key is defined once
and imported rather than spelled out in two files.
