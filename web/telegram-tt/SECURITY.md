# Web security model

## Local credentials and E2E state

The account password is used only to obtain a gateway token and is kept in
memory for that login attempt. `localStorage` retains the account address for
the next login screen, but never the password. A legacy `parvane:creds` value is
consumed once and deleted immediately. Login-link fragments are removed from
the address bar before the UI starts.

Olm/Megolm state uses storage schema v2. The complete state, including decrypted
message cache and a random per-account Olm pickle key, is AES-256-GCM encrypted
in IndexedDB. WebCrypto generates the protection key as non-extractable and the
browser stores that `CryptoKey` separately from the ciphertext. AES-GCM
additional authenticated data binds a record to its schema version and account.
Legacy localStorage pickles are re-encrypted once and all legacy E2E records are
then removed.

If IndexedDB ciphertext survives but its protection key is missing, or if the
record fails authentication, E2E initialization fails closed. The client does
not silently send plaintext or replace the identity during that session.
Signing out clears the saved address, token-bearing runtime, encrypted E2E
state, decrypted cache, local user journals/settings, and in-memory media cache.
A connection-only shutdown may explicitly preserve the local session.

## Browser threat boundary

At-rest encryption protects against casual localStorage inspection, raw
IndexedDB ciphertext disclosure, and reuse of one source-code-wide pickle
password. It does not protect against JavaScript already executing in the
Parvane origin: active XSS can ask WebCrypto to decrypt with a non-extractable
key, read plaintext from the page, or intercept a password while it is entered.
It also does not defend a fully compromised browser profile or operating system.

The deployment must therefore keep a strict CSP without inline script, minimize
third-party origins, pin dependencies and lockfiles, review bundle changes, and
serve the application and gateway only over authenticated HTTPS/WSS outside
local development. Display names, filenames, captions, previews, sticker
metadata, and localization strings remain untrusted input and must reach the DOM
through escaped text or explicitly audited sanitizers.
