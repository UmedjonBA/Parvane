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
| Personal text | Automated | Automated | Plaintext rejection is automated | `scripts/e2e_web_sync_reconnect.mjs`, gateway security test | Add online delivery in the full mutation scenario |
| Reply, edit, delete, reaction, pin, forward | All six actions automated | All six actions automated after reconnect | Signed sealed mutations, participant checks, group roles, and invalid signatures are automated | Two-browser reconnect script; messenger action-authorization tests | Add reaction removal, unpin, and multi-message forwarding |
| Read receipt, unread, typing, presence | Partially covered | Not covered | Forged actors and wildcard subjects are automated | Gateway security test; reconnect script | Add two-client UI state assertions |
| User and message search | User search is automated | Not covered | Empty/error paths not covered | Reconnect script opens peers through UI search | Add message-search acceptance |
| Photo and file | Not covered | Not covered | Owner/recipient/public ACL is automated | Cloud security test | Add encrypted Web upload/download UI path |
| E2E and TTL | Text E2E is automated | E2E reconnect is automated | Plaintext fallback is automated | Unit policy tests and live gateway tests | Add TTL expiry in two browsers |
| Groups | Ban isolation is automated | Not covered | Banned-member isolation is automated | Group rotation security test | Add create/add/remove/mute/invite/encrypted media |
| Polls | Not covered | Not covered | Not covered | Provider implementation only | Add create/vote/close/public-voters flow |
| Stickers, GIF and custom emoji | Not covered | Not covered | Not covered | Built-in provider implementation only | Add send/render/reload flow |
| Folders and blocked users | Not covered | Not covered | Not covered | Local persistence implementation only | Add reload persistence flow |
| Scheduled messages and static location | Not covered | Not covered | Not covered | Provider implementation only | Add scheduling and send-now flow |
| Audio/video 1-to-1 call | Not covered | Not covered | Signed signaling rejection is automated | Call signaling tests and provider controller | Add two-browser call UI flow |
| Web to desktop / desktop to Web | Not covered | Not covered | Not covered | No automated cross-client harness | Add text and encrypted media parity harness |

## Gate status

- Chromium, Firefox, WebKit, and iOS startup/login matrix: green.
- Web lint/typecheck, 52 unit/integration tests, production and mocked builds: green.
- Production-like live security matrix: green.
- Two-browser offline delivery, reconnect, UUID idempotency, reply, edit,
  delete, reaction, pin, and forward: green.
- A4 remains open until every row has an automated happy path, reload/reconnect
  coverage where state persists, and a permission/error assertion.
