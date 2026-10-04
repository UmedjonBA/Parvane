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
| `conformance/` | правила conformance как векторы (T088) | (US3) |

Все наборы прогоняет `parvane_protocol::conformance::run(<набор>, <json>)` —
его же зовут обвязки клиентов (WASM `runConformanceVectors`, C ABI
`pv_run_conformance_vectors`), так что тест клиента проверяет ту сборку движка,
что работает в клиенте. Имена наборов: `seal/sealed`, `seal/group`,
`invite/links`, `state/merge`, `content/kinds`, `l2/mode`, `codec/frames`,
`sign/ops`, `device_log/alice`, `group_log/group`, `content_guard/content`,
`legacy_v1/messages`, `call/signals`, `link/sas`. Там, где работу делает сам
клиент (содержимое UI, сигнал звонка, линковка), тест клиента дополнительно
сверяет собственную перекладку с теми же файлами: web —
`src/api/parvane/protocol.vectors.test.ts`, desktop/android (ядро) —
`desktop/parvane-core/tests/protocol_vectors_tests.cpp`.

`call/signals.json` и `link/sas.json` написаны вручную (движок их не порождает):
при правке — прогнать тест движка и оба клиентских.

Остальные файлы генерируются тестами `vectors_*` в `backend/protocol/tests/` при
`PARVANE_REGEN_VECTORS=1 cargo test -p parvane-protocol` (только при изменении
схемы/движка; результат коммитится) и ими же проверяются.
