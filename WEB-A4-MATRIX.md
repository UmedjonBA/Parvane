# WEB-A4 acceptance matrix

This matrix tracks the current-function acceptance gate from `WEB-ROADMAP.md`.
`Automated` means the behavior runs against the production-like NATS, gateway,
and shard stack. Security-only coverage does not count as a user-facing happy
path.

| Area | Happy path | Reload / reconnect | Permission / error | Current evidence | Next gap |
| --- | --- | --- | --- | --- | --- |
| Register and sign in | Automated | Automated: reload restores the saved address and asks for the password again | Automated: invalid password shows an error, keeps the form usable, and does not register | `tests/playwright/live-stack.spec.ts`, `tests/playwright/auth-lifecycle.spec.ts` | None |
| Logout | Automated: settings menu sign-out returns to the address screen | Covered by the re-login step of the same scenario | Automated: login address, non-extractable key, and encrypted state are wiped | `tests/playwright/auth-lifecycle.spec.ts` | None |
| Profile and avatar | Automated: display name and avatar edit through settings | Automated: both survive relogin and load from identity/cloud | Cloud public/private ACL is automated | `tests/playwright/profile.spec.ts`, `tests/playwright/cloud-security.spec.ts` | Bio and username are not backed by the server and stay local-only |
| Personal text | Automated, including live delivery while both clients are online | Automated | Plaintext rejection is automated | `scripts/e2e_web_sync_reconnect.mjs`, gateway security test | None |
| Reply, edit, delete, reaction, pin, forward | All six actions automated, plus reaction removal, unpin, and two-message forwarding | All six actions automated after reconnect | Signed sealed mutations, participant checks, group roles, and invalid signatures are automated | Two-browser reconnect script; messenger action-authorization tests | None |
| Read receipt, unread, typing, presence | Automated: recipient read turns the sender check into ✓✓, online presence and typing show in the peer header | Covered by the same two-browser scenario after reconnect | Forged actors and wildcard subjects are automated | Gateway security test; reconnect script | None |
| User and message search | User search and global message search are automated | Not covered separately (search state is not persisted) | Empty query returns no results by design | Reconnect script opens peers and finds message text through UI search | None |
| Photo and file | Automated: photo and document upload through the attach UI, recipient decrypts the photo and downloads the file byte-exact | Automated: both media survive recipient relogin | Owner/recipient/public ACL is automated | `scripts/e2e_web_media_ttl.mjs`, cloud security test | None |
| E2E and TTL | Text E2E is automated | E2E reconnect is automated; TTL text disappears on both clients and stays deleted after reload | Plaintext fallback is automated | Unit policy tests, live gateway tests, `scripts/e2e_web_media_ttl.mjs` | None |
| Groups | Ban isolation is automated | Not covered | Banned-member isolation is automated | Group rotation security test | Add create/add/remove/mute/invite/encrypted media |
| Polls | Not covered | Not covered | Not covered | Provider implementation only | Add create/vote/close/public-voters flow |
| Stickers, GIF and custom emoji | Not covered | Not covered | Not covered | Built-in provider implementation only | Add send/render/reload flow |
| Folders and blocked users | Not covered | Not covered | Not covered | Local persistence implementation only | Add reload persistence flow |
| Scheduled messages and static location | Not covered | Not covered | Not covered | Provider implementation only | Add scheduling and send-now flow |
| Audio/video 1-to-1 call | Automated: two-browser audio call with fake devices, matching SAS emoji on both peers, timer, hangup | Not covered (call state is intentionally not persisted) | Automated: decline flow plus signed-signaling rejection tests | `scripts/e2e_web_calls.mjs`, call signaling tests | Video/group call UI flow stays manual |
| Web to desktop / desktop to Web | Not covered | Not covered | Not covered | No automated cross-client harness | Add text and encrypted media parity harness |

## Gate status

- Chromium, Firefox, WebKit, and iOS startup/login matrix: green.
- Web lint/typecheck, 52 unit/integration tests, production and mocked builds: green.
- Production-like live security matrix: green.
- Two-browser offline delivery, reconnect, UUID idempotency, reply, edit,
  delete, reaction, pin, and forward: green.
- A4 remains open until every row has an automated happy path, reload/reconnect
  coverage where state persists, and a permission/error assertion.
