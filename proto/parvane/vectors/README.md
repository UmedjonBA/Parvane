# Векторы протокола Parvane v2

Эталонные примеры, которые обязаны одинаково проходить движок
`parvane-protocol` и все его обвязки (web — WASM, desktop/android — C ABI).
Правило conformance закрыто, только когда его векторы проходят в каждом
клиенте.

## Формат файла

Каждый файл — JSON-объект:

```json
{
  "suite": "codec",
  "description": "что проверяет набор",
  "keys": { "alice_device": { "seed_hex": "…", "public_hex": "…" } },
  "cases": [
    { "name": "короткое имя", "input": { … }, "expect": { "ok": true } },
    { "name": "…", "input": { … }, "expect": { "error": "FieldLimit" } }
  ]
}
```

- `input` — поля зависят от набора (см. ниже). Байты — строкой hex
  (`*_hex`), тексты v1 — строкой как есть.
- `expect` — либо `{"ok": true}` (с необязательными полями результата), либо
  `{"error": "<вид>"}`, где вид — имя варианта `ProtoError`
  (`backend/protocol/src/error.rs`): `FrameTooLarge`, `Malformed`,
  `FieldLimit`, `ServerSetField`, `DuplicateField`, `TooDeep`,
  `UnsupportedMajor`, `WrongDirection`, `UnknownMethod`, `InvalidField`,
  `BadAddress`, `BadSignature`, `ContextMismatch`, `Duplicate`, `Forbidden`,
  `BadCertificate`, `RootMismatch`, `Crypto`, `Expired`, `RateLimited`,
  `BrokenChain`, `NotFound`. Обвязки сравнивают вид ошибки, текст не сравнивается.
- Содержимое (`Content` и т.п.) в ожиданиях — каноничный proto3-JSON
  (pbjson, имена полей как в схеме).
- Криптографические ключи в векторах — ТЕСТОВЫЕ: Ed25519 из фиксированного
  seed (`seed_hex`), никогда не используются вне тестов.

## Наборы

| Каталог | Что | Вход |
|---|---|---|
| `codec/` | кадры: размер, лимиты полей, акторы, направление, версия | `origin` (`client`/`server`), `frame_hex` |
| `sign/` | каноничные подписи операций (D-10), перекрёстные операции, адресат SDP | `op` (`body_hex`, `signature_hex`, `signer_hex`), `expect_domain`, `expect_op_type`, `audience`? |
| `legacy_v1/` | разбор v1-сообщений всех трёх клиентов (диалекты D-1…D-26) | `layer` (`stored`/`olm`/`megolm`/`ice`), `json` |
| `content_guard/` | страж содержимого у получателя (класс 16) | `content` (proto3-JSON) → ожидаемый обезвреженный |
| `device_log/` | журнал устройств, откат, подсунутые устройства (D-01, D-11) | последовательность записей |
| `group_log/` | журнал группы: перестановка, перенос, форк (D-02, D-03) | последовательность записей |
| `link/` | LINK-1: обязательство нового устройства и код сверки (12 цифр) | `new_pub_b64`, `old_pub_b64` → `commitment_of_new_b64`, `sas` |
| `call/` | сигнал звонка v1 (JSON шарда call) ↔ v2 (`parvane.call.v2.CallSignal`, proto3-JSON), личный и групповой | `direction` (`to_v2`/`from_v2`), `v1` либо `v2`, `group_call_id`? → `v2` либо `v1` (`null` — не передаётся), `ice`? |
| `content/` | все виды содержимого (CONTENT-1): байты ↔ proto3-JSON, лимиты, показ/заглушка, содержимое UI клиентов | `content_hex`, `critical_fields`? → `content`, `disposition`; `client` (`class`, `v1`) |
| `history/` | журнал истории аккаунта (spec 033, HIST-1/HIST-2/READ-2): сведение строки (`merge`), непрочитанное, маркеры и права удаления (`unread`), сегменты, горизонт, строка формата привязки (`segment`), ключ истории и записи (`aead`) | `kind` случая + proto3-JSON сообщений `history.v1` (id сообщений — UUID-строки) |
| `conformance/` | правила conformance как векторы (T088) | (US3) |
| `unknown/` | spec 035 (FR-031): `unknown::scan` — неизвестное поле на любой глубине, вид oneof (обычный/критичный), значение enum; ожидания руками | `type`, `hex` → `items[]` (`path`, `kind`, `number`, `critical`) |
| `state2/` | spec 035 (FR-010…FR-017): личное состояние v2 — патч по полям (`patch`), множества (`sets`), упорядоченные списки (`ordered`), «удаление против правки» (`delete_vs_edit`), отметки (`marks`), неизвестное (`unknown_fields`), отказы (`rejected`); ожидания руками, каждый случай — во всех перестановках, с повтором и разбиением через снимок | `ops[]` — краткая запись операций (см. `description`) → `rejected`, `max_lamport`, `objects` (показ), `held`, `write_blocked`, `kept_fields` |
| `content/critical.json`, `model/critical_journal.json` | spec 035 (FR-041/FR-042): критичность номером вида — показ содержимого по исходным байтам (`show`/`stub`/`stub_critical`) и разрешённые действия; критичный вид закрывает журнал (state, history) для записи, отметки `range-hold`; ожидания руками | `content_hex`, `critical_fields`? → `disposition`, `actions`; `journal`, `ops`/`records_hex` → `write`, `holds`, `submit`, `objects` |
| `model/` (кроме `critical_journal`) | spec 035 T062 (contracts/engine-api.md): модель движка — намерения → изменения модели через границу `PvEngine` / `pv_engine_call` (`send_direct`, `delete_everyone_direct`, `delete_me`, `edit_before_row`, `state_patch_folder`, `group_perms_media`, `unknown_content_stub`, `features_text_fallback`, `history_paging`, `fave_sticker`); ожидания руками. Движок открывается с `config.vectors = true` над пустым хранилищем хоста (`start` → `storeLoaded` без записей, пачки фиксируются и подтверждаются `storeCommitted`); прогон — `backend/protocol/tests/model_vectors.rs`, клиенты — через свою обвязку (web `modelVectors.test.ts`, ядро `model_vectors_tests.cpp`, android `ModelVectorsTest.kt`) | `config`, `steps[]`: `submit` (Intent), `input` (`vectorInput`: `incoming`, `history`, `group`), `historyPage`/`chatList`/`capabilities`/`viewState`/`viewGroup`; `expect`: `changes[]` (подмножество каждого `ModelChange`, `null` — поля нет, `"$x"` — переменная), `requests[]` (методы по порядку, включая выпущенные после фиксации), `puts[]` (виды записей пачки), `error`, `result` |
| `storage/` | spec 035 (contracts/storage.md): AAD и ключ записи (`aad`), KEK/проверка PIN (`wrap`), перенос поколения P1–P6 с прерываниями (`generation`), слишком новый формат (`too_new`) — `backend/protocol/tests/store_vectors.rs`; общий набор адаптеров хоста (`adapter`) — ctest ядра `store_fs_tests`, web `v2/storeIdb.test.ts` | см. `description` файлов |

Все наборы прогоняет `parvane_protocol::conformance::run(<набор>, <json>)` —
его же зовут обвязки клиентов (WASM `runConformanceVectors`, C ABI
`pv_run_conformance_vectors`), так что тест клиента проверяет ту сборку движка,
что работает в клиенте. Имена наборов: `seal/sealed`, `seal/group`,
`invite/links`, `state/merge`, `content/kinds`, `l2/mode`, `codec/frames`,
`sign/ops`, `device_log/alice`, `group_log/group`, `content_guard/content`,
`legacy_v1/messages`, `call/signals`, `link/sas`, `history/merge`, `history/unread`,
`history/segment`, `history/aead`, `history/checkpoint`, `state2/patch`, `state2/sets`, `state2/ordered`,
`state2/delete_vs_edit`, `state2/marks`, `state2/unknown_fields`, `state2/rejected`, `content/critical`,
`model/critical_journal`. Там, где работу делает сам
клиент (содержимое UI, сигнал звонка, линковка), тест клиента дополнительно
сверяет собственную перекладку с теми же файлами: web —
`src/api/parvane/protocol.vectors.test.ts`, desktop/android (ядро) —
`desktop/parvane-core/tests/protocol_vectors_tests.cpp`.

`call/signals.json` и `link/sas.json` написаны вручную (движок их не порождает):
при правке — прогнать тест движка и оба клиентских.

Остальные файлы генерируются тестами `vectors_*` (`history/` — `history_vectors.rs`) в `backend/protocol/tests/` при
`PARVANE_REGEN_VECTORS=1 cargo test -p parvane-protocol` (только при изменении
схемы/движка; результат коммитится) и ими же проверяются.
