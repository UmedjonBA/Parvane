# Индекс векторов conformance v2 (spec 007, T088)

Правила — `conformance/README.md`, машиночитаемо — `conformance/sync-rules.json`.
Каждый клиент прогоняет векторы своей обвязкой движка: web — WASM
(`runConformanceVectors`, тест `web/telegram-tt/src/api/parvane/protocol.vectors.test.ts`),
desktop — C ABI `pv_run_conformance_vectors`
(`desktop/parvane-core/tests/protocol_vectors_tests.cpp`), android — то же
через JNI (`android/libtd/src/test/java/org/drinkless/tdlib/ProtocolVectorsTest.kt`). Логика сверки одна —
`backend/protocol/src/conformance.rs`; эталонные тесты движка —
`backend/protocol/tests/vectors_*.rs`, `state_vectors.rs`.

| Правило | Векторы | Набор движка / тест |
|---|---|---|
| PROTO-1 (кадры, лимиты, направление) | `codec/frames.json` | `tests/vectors_codec.rs` |
| OP-SIG (бывш. SEND-1) | `sign/ops.json` | `tests/vectors_sign.rs` |
| SEAL-1 (бывш. E2E-1 для 1-1) | `seal/sealed.json` | `seal/sealed`, `tests/vectors_seal.rs` |
| GSEAL-1 (бывш. E2E-1 для групп) | `seal/group.json` | `seal/group`, `tests/vectors_seal.rs` |
| KEY-1 v2, LINK-1 (журнал устройств, TOFU, откат) | `device_log/alice.json` | `tests/vectors_logs.rs` |
| GROUP-1 (ревизия группы = версия журнала) | `group_log/group.json` | `tests/vectors_logs.rs` |
| GROUP-2 (права по типу содержимого) | `content_guard/content.json` | `tests/vectors_content_guard.rs` |
| STATE-1 (сведение личного состояния) | `state/*.json` | `state/merge`, `tests/state_vectors.rs` |
| CONTENT-1 (все виды содержимого, показ/заглушка, содержимое UI) | `content/kinds.json` | `content/kinds`, `tests/vectors_content.rs` |
| L2-1 (режим «усиленная приватность»: сетка, согласование, эфемерные) | `l2/mode.json`, случаи `chat-mode-*` в `content/kinds.json` | `l2/mode`, `tests/vectors_l2.rs`, `tests/client_flow.rs` |
| Ссылки-приглашения (один формат) | `invite/links.json` | `invite/links`, `tests/vectors_invite.rs` |
| v1-история в v2 (переходный период) | `legacy_v1/messages.json` | `tests/vectors_legacy.rs` |

Правила без собственных векторов в v2 — поведение клиента, а не формат:
SYNC-1/SYNC-2 (курсор журнала = `seq` последней применённой записи, движок
`sync::Cursor`, тест `backend/protocol/src/sync.rs`), READ-1 (прочтение —
E2E-квитанция `Receipt`), PROFILE-1, FAIL-1, MAP-1 (тайлы — `preview.map_tile`
через анонимный канал), PACK-1/EMOJI-1 (поля `PackRef` в `content.proto`),
EPHEMERAL-1 (секретные каналы typing/presence, `backend/protocol/src/ephemeral.rs`),
BLOB-1 (PVB2 без изменений), CALL-1 (`IceCandidate` в `call.proto`).
