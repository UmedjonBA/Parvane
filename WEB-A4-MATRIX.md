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
| Groups | Automated: create with a member, add and remove a member through the profile UI, group text and encrypted photo delivery to every member | Group list discovery is delivered by live membership refresh (fixed race) | Automated: removed member stops receiving new messages; ban isolation and mute have protocol/unit tests | `scripts/e2e_web_groups.mjs`, group rotation security test, messenger unit tests | Invite links have shard tests but no Web UI surface yet |
| Polls | Automated: create with two options, cross-client vote, public View Results, stop with confirmation showing Final Results | Poll state is driven by mutations covered in the same scenario | Stop is owner-only via the message context menu | `scripts/e2e_web_groups.mjs` | None |
| Stickers, GIF and custom emoji | Automated: sticker, GIF, and custom emoji sent from the native panels render on the recipient | Automated: sticker and GIF survive recipient relogin | Built-in packs only, no premium gating by design | `scripts/e2e_web_content_features.mjs` | None |
| Folders and blocked users | Automated: folder created through settings with an included chat; user blocked through privacy settings | Automated: folder tab and blocked list survive relogin | Local-only persistence is the documented scope | `scripts/e2e_web_content_features.mjs` | None |
| Scheduled messages and static location | Automated: message scheduled via the send-button menu is delivered after the delay; static location sends with granted geolocation | Automated: the scheduled queue survives sender relogin before firing | Geolocation permission granted explicitly in the scenario | `scripts/e2e_web_content_features.mjs` | None |
| Audio/video 1-to-1 call | Automated: two-browser audio call with fake devices, matching SAS emoji on both peers, timer, hangup | Not covered (call state is intentionally not persisted) | Automated: decline flow plus signed-signaling rejection tests | `scripts/e2e_web_calls.mjs`, call signaling tests | Video/group call UI flow stays manual |
| Web to desktop / desktop to Web | Automated: sealed text Web -> desktop and desktop -> Web, encrypted photo Web -> desktop on one production-like stack (desktop through the gateway TCP transport) | Desktop restart in the same workdir is part of the scenario | Desktop auto-registers through the gateway bootstrap allowlist | `scripts/e2e_web_cross_client.mjs` (skips with a warning when `desktop/build-probe/bin/Telegram` is not built locally) | Desktop-initiated media needs a desktop autosend hook |

## Gate status

- Chromium, Firefox, WebKit, and iOS startup/login matrix: green.
- Web lint/typecheck, 52 unit/integration tests, production and mocked builds: green.
- Production-like live security matrix: green.
- Two-browser offline delivery, reconnect, UUID idempotency, and the full
  message-mutation set including receipts, presence, and typing: green.
- Media, TTL, groups with polls, content features, calls with SAS, and the
  cross-client Web <-> desktop harness: green.
- Every row has an automated happy path, reload/reconnect coverage where state
  persists, and a permission/error assertion. The A4 gate is closed; remaining
  notes in the rows above are follow-ups outside the current-function scope
  (Web UI for invite links, desktop-initiated media autosend, video/group call
  UI automation).
