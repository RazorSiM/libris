---
"@libris/api-hono": patch
"@libris/web": patch
---

Stop storing KoSync secrets as a bare unsalted digest of a user-chosen
password.

KOReader sends `md5(password)` as `x-auth-key`, so that digest is the bearer
secret and the plaintext never reaches the server. The previous scheme read
that as "the stored value covers a 128-bit random secret, so no work factor is
needed" and stored a plain `sha256` of it. The premise was wrong: `password` is
a string a human chose and typed into the settings form, and md5 is unkeyed,
unsalted and adds no entropy, so `sha256(md5(pw))` is exactly as guessable as
`sha256(pw)` — and with no salt, one GPU wordlist pass recovered every row at
once. A leaked backup or a read-only SQL injection would have yielded plaintext
passwords that people plausibly reuse for the Libris account itself, whose hash
in `accounts.password` is properly protected.

A password hash is not the fix either. This secret is verified on an
unauthenticated endpoint that KOReader hits on every progress read and write,
where a per-request work factor is a CPU-exhaustion lever anyone can pull for
free. So the secret moves out of the database instead:

    v1$<salt>$<HMAC-SHA256(pepper, "<salt>:<wire value>")>

The pepper is derived from `API_SECRET_KEY`, which lives in the environment and
never in the database, so a database-only disclosure yields nothing to compute
candidates against. The per-row salt costs nothing — the lookup is by username,
not by the digest — and stops any single pass covering more than one row.
Verification is two HMACs over short inputs, cheaper than the sha256 it
replaces, so the unauthenticated path gains no new cost.

**No migration and no action for existing users.** The version and salt live
inside the existing `secret_hash` text column, so no schema change was needed.
Rows in the old format still verify, and each one is transparently rewritten in
the new format the first time that device authenticates. Nobody has to re-enter
a credential or re-pair a device.

**Rotating `API_SECRET_KEY` now invalidates every stored KoSync credential.**
That is the intended blast radius of a pepper, but it is new behaviour: after a
rotation, every user must set their KoSync password again. This is documented in
the settings guide.

The settings form now offers to **Generate** the credential, and says plainly
that it is a device pairing secret rather than an account password. The stored
form is only as strong as the pepper's secrecy; removing the human choice
underneath it is what covers the case where an attacker gets both the database
and the environment.
