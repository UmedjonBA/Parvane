#ifndef PARVANE_PROTOCOL_H
#define PARVANE_PROTOCOL_H

/* Сгенерировано cbindgen из backend/protocol/ffi — не править руками. */

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Планировщик анонимных соединений (sans-IO; непрозрачный указатель,
 * освобождать `pv_anon_planner_free`). Правила: соединение — одному
 * получателю (пользователю или группе) и в серии ≤ 60 с с открытия;
 * публичные запросы (журналы, бандлы, ключи жетонов) — всегда новое
 * одноразовое соединение.
 */
typedef struct PvAnonPlanner PvAnonPlanner;

/**
 * spec 035 (T070, contracts/engine-api.md): модель движка. Владеет хост; освобождать `pv_engine_free`.
 */
typedef struct PvEngine PvEngine;

/**
 * Хранилище движка профиля (непрозрачный указатель, освобождать `pv_store_free`).
 */
typedef struct PvStoreHandle PvStoreHandle;

/**
 * Байтовый буфер движка.
 */
typedef struct PvBytes {
  uint8_t *data;
  uintptr_t len;
} PvBytes;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

/**
 * Версия движка (статическая строка, освобождать не нужно).
 */
const char *parvane_protocol_version(void);

/**
 * Мажорная версия протокола.
 */
uint32_t parvane_protocol_major(void);

void parvane_protocol_string_free(char *s);

void parvane_protocol_bytes_free(struct PvBytes b);

/**
 * spec 035 (FR-046, contracts/versioning.md): `engineInfo()` этой сборки движка — JSON-строка;
 * освобождать `pv_free_string`.
 */
char *pv_engine_info(void);

/**
 * Открыть модель по конфигурации (`EngineConfig`, JSON). NULL — ошибка; тогда `*err` (если не NULL) —
 * JSON `{"error": "<вид>"}`, освобождать `pv_free_string`.
 */
struct PvEngine *pv_engine_open(const char *config_json,
                                char **err);

/**
 * Вызов модели по имени → JSON результата (ошибка — `{"error": "<вид>"}`, незнакомое имя —
 * `{"error": "UnknownCall"}`); освобождать `pv_free_string`. `args_json` NULL — `{}`.
 */
char *pv_engine_call(struct PvEngine *e,
                     const char *name,
                     const char *args_json);

/**
 * Закрыть модель.
 */
void pv_engine_free(struct PvEngine *e);

/**
 * Освободить строку движка (то же, что `parvane_protocol_string_free`; имя из contracts/versioning.md).
 */
void pv_free_string(char *s);

/**
 * Полные имена всех сообщений схемы — JSON-массив строк (тесты кодеков во всех обвязках, spec 035 T012);
 * освобождать `pv_free_string`.
 */
char *pv_schema_message_names(void);

/**
 * Функции без клиента по имени WASM (действия клиента — `clientCall` модели, `pv_engine_call`).
 */
char *pv_call(const char *name,
              const char *args,
              char **err);

/**
 * Разобрать ссылку-приглашение → `{"kind":"v2","domain","linkId"}` |
 * `{"kind":"legacy","token"}`; ошибка (в err) — не ссылка-приглашение.
 */
char *pv_parse_invite(const char *url, char **err);

struct PvBytes pv_encode_hello(int32_t channel, const char *kind, const char *version);

struct PvBytes pv_encode_auth(const char *token);

struct PvBytes pv_encode_request(uint64_t id,
                                 const char *method,
                                 const uint8_t *body,
                                 uintptr_t len,
                                 uint32_t timeout_ms);

/**
 * Запрос объекту сервера `dest` (spec 028, FED-1; пусто — свой сервер), с дополнением кадра до кратного
 * `pad_to` (spec 025, режим L2; 0 — без дополнения).
 */
struct PvBytes pv_encode_request_to(uint64_t id,
                                    const char *method,
                                    const uint8_t *body,
                                    uintptr_t len,
                                    uint32_t timeout_ms,
                                    const char *dest,
                                    uint32_t pad_to);

char *pv_decode_frame(const uint8_t *bytes, uintptr_t len, char **err);

char *pv_verify_server_descriptor(const uint8_t *bytes, uintptr_t len, char **err);

char *pv_split_sync_response(const uint8_t *bytes, uintptr_t len, char **err);

struct PvBytes pv_encode_message(const char *type_name, const char *json, char **err);

/**
 * Байты ответа → proto3-JSON по полному имени типа.
 */
char *pv_decode_message(const char *type_name, const uint8_t *bytes, uintptr_t len, char **err);

/**
 * Тело запроса любого метода реестра из proto3-JSON (T161).
 */
struct PvBytes pv_encode_method_request(const char *method, const char *json, char **err);

/**
 * Ответ любого метода реестра → proto3-JSON (T161).
 */
char *pv_decode_method_response(const char *method,
                                const uint8_t *bytes,
                                uintptr_t len,
                                char **err);

/**
 * Число записей в ответе `identity.device.log_sync_anon` (есть ли у
 * пользователя журнал устройств v2). -1 — ответ не разобран (подробности в err).
 */
int64_t pv_device_log_entries(const uint8_t *bytes,
                              uintptr_t len,
                              char **err);

/**
 * Прогнать набор векторов conformance движком: число сошедшихся случаев
 * или −1 (описание расхождения — в `err`).
 */
int64_t pv_run_conformance_vectors(const char *suite,
                                   const char *json,
                                   char **err);

/**
 * base64 → байты (для тел запросов/записей из JSON-ответов движка).
 */
struct PvBytes pv_from_base64(const char *s,
                              char **err);

/**
 * Материал гранта линковки (строка JSON) + копия корня под ключом
 * восстановления (поле `rb`) → новая строка материала. NULL — ошибка.
 */
char *pv_grant_with_root_backup(const char *material,
                                const uint8_t *backup,
                                uintptr_t len);

/**
 * Копия корня из материала гранта (пустой буфер — гранта без копии).
 */
struct PvBytes pv_grant_root_backup(const char *material);

/**
 * T130: корень (32 байта) из копии под ключом восстановления на устройстве
 * без журнала. Пустой буфер — ошибка (в `err`: неверный ключ/копия).
 */
struct PvBytes pv_import_root_backup_for(const char *user,
                                         const uint8_t *blob,
                                         uintptr_t len,
                                         const char *recovery_key,
                                         char **err);

/**
 * Новый ключ восстановления (≥ 128 бит) — строка для показа пользователю
 * (освобождать `parvane_protocol_string_free`).
 */
char *pv_generate_recovery_key(void);

struct PvAnonPlanner *pv_anon_planner_new(void);

void pv_anon_planner_free(struct PvAnonPlanner *p);

/**
 * Запрос анонимного канала (метод + тело) → JSON `{"conn":N,"open":bool,
 * "closeAfter":bool}`: `open` — открыть новое соединение ANONYMOUS_DELIVERY
 * под номером `conn`, `closeAfter` — закрыть сразу после ответа.
 */
char *pv_anon_planner_assign(struct PvAnonPlanner *p,
                             const char *method,
                             const uint8_t *body,
                             uintptr_t len,
                             int64_t now_ms,
                             char **err);

/**
 * Соединения, серия которых истекла, — JSON-массив номеров (закрыть).
 */
char *pv_anon_planner_expired(struct PvAnonPlanner *p,
                              int64_t now_ms);

/**
 * Соединение закрылось (обрыв/таймаут) — больше не выдавать.
 */
void pv_anon_planner_closed(struct PvAnonPlanner *p,
                            uint64_t conn);

/**
 * Открытых соединений с получателем (для тестов/диагностики).
 */
uintptr_t pv_anon_planner_open_count(const struct PvAnonPlanner *p);

/**
 * Открыть хранилище: байты корня (`root`) либо пусто (`len = 0`) — новый профиль (поколение 1, новый DEK;
 * обёртку даёт `pv_store_wrap_device`). Существующее — заблокировано до `pv_store_unlock_*`.
 */
struct PvStoreHandle *pv_store_open(const uint8_t *root,
                                    uintptr_t len,
                                    char **err);

void pv_store_free(struct PvStoreHandle *h);

/**
 * Состояние и сводка корня (JSON: `state`, `activeGeneration`, `pendingGeneration`, `retiringGeneration`,
 * `wraps`); освобождать `pv_free_string`.
 */
char *pv_store_info(struct PvStoreHandle *h);

/**
 * Разблокировать ключом устройства (32 байта: desktop — производная локального ключа tdata, android —
 * ключ под Android Keystore; тот же, что у `storecrypt::setKey`).
 */
bool pv_store_unlock_device(struct PvStoreHandle *h,
                            const uint8_t *key,
                            uintptr_t len,
                            char **err);

/**
 * Обернуть DEK ключом устройства (новый профиль, снятие PIN) — пачка только с корнем (JSON `StoreBatch`).
 */
char *pv_store_wrap_device(struct PvStoreHandle *h,
                           const uint8_t *key,
                           uintptr_t len,
                           char **err);

/**
 * Пачка записей и удалений: `{"puts": [{"kind", "name", "value"(base64)}], "deletes": [{"kind", "name"}]}` →
 * JSON `StoreBatch` (во время переноса — в оба поколения).
 */
char *pv_store_write(struct PvStoreHandle *h,
                     const char *ops_json,
                     char **err);

/**
 * Открыть запись по ключу носителя и значению; освобождать `parvane_protocol_bytes_free`.
 */
struct PvBytes pv_store_open_record(struct PvStoreHandle *h,
                                    const char *key,
                                    const uint8_t *value,
                                    uintptr_t len,
                                    char **err);

/**
 * Хост зафиксировал пачку.
 */
void pv_store_committed(struct PvStoreHandle *h, uint64_t batch_id);

/**
 * Хост не смог зафиксировать пачку (нет места, ошибка записи).
 */
void pv_store_failed(struct PvStoreHandle *h,
                     uint64_t batch_id,
                     const char *reason);

/**
 * P1 переноса поколения — JSON `StoreBatch`.
 */
char *pv_store_begin_rotation(struct PvStoreHandle *h, char **err);

/**
 * Следующее действие переноса (JSON): `{"type":"read","reads":StoreReads}` | `{"type":"write","batch":StoreBatch}`
 * | `{"type":"continue"}` | `{"type":"done"}` | `{"type":"aborted","errors":[…]}`.
 */
char *pv_store_rotation_next(struct PvStoreHandle *h,
                             char **err);

/**
 * Прочитанное по `read` переноса — JSON `StoreLoaded` (как отдаёт `store_fs::Store::readJson`).
 */
bool pv_store_rotation_loaded(struct PvStoreHandle *h,
                              const char *loaded_json,
                              char **err);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* PARVANE_PROTOCOL_H */
