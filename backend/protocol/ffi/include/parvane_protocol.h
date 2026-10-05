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
 * Клиентское ядро устройства (непрозрачный указатель).
 */
typedef struct PvClient PvClient;

/**
 * Сессия журнала личного состояния (непрозрачный указатель,
 * освобождать `pv_state_free`).
 */
typedef struct PvStateSession PvStateSession;

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

struct PvClient *pv_client_new(const char *user,
                               const char *device,
                               const char *domain,
                               char **err);

struct PvClient *pv_client_import(const uint8_t *blob,
                                  uintptr_t len,
                                  const uint8_t *key,
                                  uintptr_t key_len,
                                  char **err);

void pv_client_free(struct PvClient *c);

struct PvBytes pv_client_export(struct PvClient *c,
                                const uint8_t *key,
                                uintptr_t key_len,
                                char **err);

/**
 * Импорт Olm-аккаунта v1 (JSON-pickle parvane-e2e).
 */
bool pv_client_import_v1_account(struct PvClient *c, const char *pickle_json, char **err);

char *pv_client_create_identity(struct PvClient *c, uintptr_t otk, char **err);

char *pv_client_link_grant_material(struct PvClient *c, char **err);

char *pv_client_join_with_grant(struct PvClient *c,
                                const char *material,
                                uintptr_t otk,
                                char **err);

char *pv_client_otk_request(struct PvClient *c, uintptr_t n, char **err);

char *pv_client_sync_request(struct PvClient *c, char **err);

char *pv_client_ack_request(struct PvClient *c, char **err);

char *pv_client_ingest_log(struct PvClient *c,
                           const char *user,
                           const uint8_t *resp,
                           uintptr_t len,
                           char **err);

/**
 * KEY-1 v2: принять смену корня собеседника (после предупреждения).
 * true — ожидавшая смена принята.
 */
bool pv_client_accept_root_change(struct PvClient *c,
                                  const char *user,
                                  char **err);

/**
 * T130: восстановление на новом устройстве по корню (32 байта) и ответу
 * `identity.device.log_sync` с версии 0 → JSON-массив запросов.
 */
char *pv_client_recover_with_root(struct PvClient *c,
                                  const uint8_t *root,
                                  uintptr_t root_len,
                                  const uint8_t *log_resp,
                                  uintptr_t log_len,
                                  uintptr_t otk,
                                  char **err);

/**
 * T130: сброс личности — как `pv_client_create_identity`; первый запрос —
 * `identity.root.rotate`.
 */
char *pv_client_reset_identity(struct PvClient *c,
                               uintptr_t otk,
                               char **err);

char *pv_client_ingest_bundle(struct PvClient *c,
                              const char *user,
                              const uint8_t *resp,
                              uintptr_t len,
                              char **err);

char *pv_client_token_request(struct PvClient *c,
                              const uint8_t *list,
                              uintptr_t list_len,
                              const uint8_t *server_key,
                              uintptr_t key_len,
                              uintptr_t count,
                              char **err);

char *pv_client_token_response(struct PvClient *c, const uint8_t *resp, uintptr_t len, char **err);

/**
 * Сигнал звонка собеседнику (D-08): `signal_json` — proto3-JSON
 * `parvane.call.v2.CallSignal`. Запросы — как у `pv_client_prepare_direct`:
 * оффер — `call.ring_sealed`, остальное — `call.signal_sealed` (анонимный канал).
 */
char *pv_client_prepare_call(struct PvClient *c,
                             const char *peer,
                             const char *signal_json,
                             char **err);

/**
 * Сервер отверг ключ доступа собеседника (FORBIDDEN на доставке): он сменил
 * ключ — дальше слепым жетоном. true — ключ был и сброшен (отправку стоит
 * повторить).
 */
bool pv_client_delivery_key_rejected(struct PvClient *c,
                                     const char *peer);

/**
 * Кто прочитал своё сообщение (по E2E-квитанциям) — JSON-массив
 * `[{"user","tsMs"}]` («Просмотрено» в чате v2, T151).
 */
char *pv_client_readers(const struct PvClient *c,
                        const char *id,
                        char **err);

/**
 * Известен ли ключ доступа собеседника: сигнал звонка сервер принимает только
 * с ним (слепой жетон для звонков не годится).
 */
bool pv_client_has_peer_delivery_key(const struct PvClient *c,
                                     const char *peer);

/**
 * Отозвать своё другое устройство и выполнить последствия → JSON
 * `{"requests":[…],"pendingKeyShares":[…],"pendingEpochs":[hex…],
 * "epochsNeedAdmin":[hex…],"sskRotationRequired":bool,"stateKeyVersion":n|null}`.
 * Первый запрос — запись журнала (обязателен), остальные — ротации ключей.
 */
char *pv_client_revoke_device(struct PvClient *c,
                              const char *device_id,
                              char **err);

/**
 * Отозвать ключ доступа у собеседника (FR-033; блокировка) → JSON итога как у
 * `pv_client_revoke_device` (заполнены `requests` и `pendingKeyShares`).
 */
char *pv_client_revoke_contact_access(struct PvClient *c,
                                      const char *peer,
                                      char **err);

/**
 * Группы v2 — своим новым устройствам (T142): `devices_json` — JSON-массив id
 * устройств. JSON-массив запросов (пустой — пересылать нечего).
 */
char *pv_client_share_groups_with_own_devices(struct PvClient *c,
                                              const char *devices_json,
                                              char **err);

/**
 * Раздать текущий ключ доступа собеседнику (отложенное после отзыва).
 */
char *pv_client_share_delivery_key(struct PvClient *c,
                                   const char *peer,
                                   char **err);

/**
 * Сменить SSK корнем (D-12): `root` — 32 байта секрета корня (из резервной
 * копии под ключом восстановления). JSON-массив запросов.
 */
char *pv_client_rotate_ssk(struct PvClient *c,
                           const uint8_t *root,
                           uintptr_t root_len,
                           char **err);

/**
 * Свой SSK раскрыт (отозвано державшее его устройство) и ещё не сменён.
 */
bool pv_client_own_ssk_exposed(const struct PvClient *c);

/**
 * Подписаться на каналы чатов `{"peers":[адрес…],"groups":[hex…]}` →
 * JSON-массив запросов `ephemeral.subscribe` (только новые каналы).
 */
char *pv_client_eph_subscribe(struct PvClient *c,
                              const char *chats_json,
                              char **err);

/**
 * Соединение пересоздано — подписок на эфемерные каналы больше нет.
 */
void pv_client_eph_reset(struct PvClient *c);

/**
 * «Печатает»: `chat` — адрес собеседника либо hex группы, `action` — номер
 * `TypingAction`. JSON-массив запросов (пустой — канала нет или чат в L2).
 */
char *pv_client_eph_typing(const struct PvClient *c,
                           const char *chat,
                           int32_t action,
                           char **err);

/**
 * Своё присутствие → JSON-массив запросов (пустой — L2 активен в каком-то чате).
 */
char *pv_client_eph_presence(const struct PvClient *c,
                             bool online,
                             int64_t last_seen_ms,
                             char **err);

/**
 * Событие подписки `ephemeral` → JSON-массив событий `typing`/`presence`.
 */
char *pv_client_eph_open(const struct PvClient *c,
                         const uint8_t *body,
                         uintptr_t len);

char *pv_client_prepare_direct(struct PvClient *c,
                               const char *peer,
                               const char *content_json,
                               const char *op_id,
                               char **err);

char *pv_client_open_record(struct PvClient *c, const uint8_t *rec, uintptr_t len, char **err);

char *pv_client_drain_ready(struct PvClient *c, char **err);

char *pv_client_last_error(struct PvClient *c, char **err);

/**
 * Группа, переводимая из v1 (T180): `migrated_from` — прежний `group_id`.
 */
char *pv_client_group_create_from(struct PvClient *c,
                                  int32_t kind,
                                  const char *name,
                                  const char *members_json,
                                  const char *perms_json,
                                  const char *migrated_from,
                                  char **err);

char *pv_client_group_create(struct PvClient *c,
                             int32_t kind,
                             const char *name,
                             const char *members_json,
                             const char *perms_json,
                             char **err);

char *pv_client_group_ingest(struct PvClient *c,
                             const char *domain,
                             const char *group,
                             const uint8_t *resp,
                             uintptr_t len,
                             char **err);

char *pv_client_group_change(struct PvClient *c,
                             const char *group,
                             const char *change_json,
                             char **err);

/**
 * Решение по заявке на вступление в группу: JSON запроса `group.request.decide`
 * (одобрение — запись `AddMember`, локальный журнал уже продвинут).
 */
char *pv_client_group_request_decide(struct PvClient *c,
                                     const char *group,
                                     const char *user,
                                     bool approve,
                                     char **err);

char *pv_client_group_rotate_epoch(struct PvClient *c, const char *group, char **err);

char *pv_client_prepare_group(struct PvClient *c,
                              const char *group,
                              const char *content_json,
                              const char *op_id,
                              char **err);

/**
 * Версия журнала группы на устройстве (0 — журнала нет или id битый).
 */
uint64_t pv_client_group_version(const struct PvClient *c,
                                 const char *group);

/**
 * D-03: версия журнала группы, от которой отстаём; −1 — не отстаём.
 */
int64_t pv_client_group_behind(const struct PvClient *c,
                               const char *group);

/**
 * Забыть журнал группы (запись отвергнута сервером — перечитать с начала).
 */
void pv_client_group_forget(struct PvClient *c,
                            const char *group);

/**
 * Группы, журнал которых известен устройству — JSON-массив hex id.
 */
char *pv_client_group_list(const struct PvClient *c);

/**
 * Сведения группы по журналу (JSON: участники, роли, права, эпоха, ссылки).
 */
char *pv_client_group_info(const struct PvClient *c,
                           const char *group,
                           char **err);

/**
 * FR-028 (T080): участники без подтверждённой записи журнала.
 * `claimed_json` — адреса по данным сервера (JSON-массив, можно пустой).
 */
char *pv_client_group_unconfirmed(const struct PvClient *c,
                                  const char *group,
                                  const char *claimed_json,
                                  char **err);

/**
 * Новая ссылка-приглашение → JSON `{"request","url","linkId"}`.
 */
char *pv_client_group_invite_create(struct PvClient *c,
                                    const char *group,
                                    const char *title,
                                    int64_t expires_ms,
                                    uint32_t usage_limit,
                                    bool requires_approval,
                                    char **err);

/**
 * Вступить по ссылке v2 (журнал группы уже принят) → запрос `group.join` (JSON).
 */
char *pv_client_group_join(struct PvClient *c,
                           const char *url,
                           char **err);

/**
 * Разобрать ссылку-приглашение → `{"kind":"v2","domain","linkId"}` |
 * `{"kind":"legacy","token"}`; ошибка (в err) — не ссылка-приглашение.
 */
char *pv_parse_invite(const char *url, char **err);

/**
 * Устройства пользователя по журналу → JSON `{"v2":[…],"legacy":[…]}`.
 */
char *pv_client_log_devices(const struct PvClient *c,
                            const char *user);

/**
 * Опубликовать/сократить свой список v1-устройств (FR-058): JSON
 * `[{"deviceId","identity","signing"}]` → запрос `identity.device.log_append`.
 */
char *pv_client_legacy_devices_request(struct PvClient *c,
                                       const char *devices_json,
                                       char **err);

/**
 * Запрос `msg.deliver_legacy` (FR-054): v1 `SendPayload` (JSON) с копиями
 * для v1-устройств из подписанных списков.
 */
char *pv_client_legacy_deliver_request(const struct PvClient *c,
                                       const char *message_id,
                                       const char *send_payload_json,
                                       char **err);

/**
 * Запас слепых жетонов.
 */
uintptr_t pv_client_token_count(const struct PvClient *c);

/**
 * Пора получать суточную партию жетонов (FR-063: по расписанию, не перед тратой).
 */
bool pv_client_token_refill_due(const struct PvClient *c);

/**
 * Размер партии жетонов — вся суточная квота.
 */
uintptr_t pv_client_token_batch_size(const struct PvClient *c);

/**
 * Включить/выключить L2 в личном чате: запросы как у `pv_client_prepare_direct`
 * (операция `ChatMode` собеседнику и своим устройствам). `op_id` — id
 * служебного сообщения в UI (NULL — новый).
 */
char *pv_client_l2_set_direct(struct PvClient *c,
                              const char *peer,
                              bool enabled,
                              const char *op_id,
                              char **err);

/**
 * Состояние L2 личного чата:
 * `{"active","mine","enabledBy":[адреса],"pad","ephemeralAllowed"}`.
 */
char *pv_client_l2_direct(const struct PvClient *c, const char *peer);

/**
 * Состояние L2 группы (тот же JSON): политика журнала группы + личное
 * предпочтение устройства. Политику меняет `pv_client_group_change` с
 * `{"set_privacy_mode":{"l2":true}}`.
 */
char *pv_client_l2_group(const struct PvClient *c,
                         const char *group,
                         char **err);

/**
 * Личное предпочтение L2 в группе (свои исходящие выравниваются).
 */
bool pv_client_l2_set_group_pref(struct PvClient *c,
                                 const char *group,
                                 bool enabled);

/**
 * Чаты с активным L2: `{"direct":[адреса собеседников],"groups":[hex id]}`.
 */
char *pv_client_l2_active_chats(const struct PvClient *c);

/**
 * Публиковать ли своё присутствие: false, пока L2 активен хотя бы в одном чате.
 */
bool pv_client_presence_allowed(const struct PvClient *c);

bool pv_client_has_state_key(const struct PvClient *c);

/**
 * Создать ключ личного состояния, если его нет. true — создан сейчас
 * (состояние клиента нужно сохранить).
 */
bool pv_client_ensure_state_key(struct PvClient *c);

/**
 * Сессия журнала на текущем ключе; null — ключа нет.
 */
struct PvStateSession *pv_client_state_session(const struct PvClient *c);

void pv_state_free(struct PvStateSession *s);

/**
 * Тело `state.sync` от курсора сессии.
 */
struct PvBytes pv_state_sync_request(const struct PvStateSession *s);

/**
 * Ответ `state.sync` → `{"more","applied","rejected"}`.
 */
char *pv_state_ingest(struct PvStateSession *s, const uint8_t *resp, uintptr_t len, char **err);

/**
 * Сведённое состояние — proto3-JSON `state.v1.StateSnapshot`.
 */
char *pv_state_snapshot(const struct PvStateSession *s);

/**
 * Желаемое хостом состояние по видам (`kinds_json` — JSON-массив имён) →
 * JSON-массив base64 тел `state.append`.
 */
char *pv_state_diff(struct PvStateSession *s,
                    const char *desired_json,
                    const char *kinds_json,
                    char **err);

/**
 * Первый запуск: локальный снимок → JSON-массив base64 тел `state.append`.
 */
char *pv_state_migrate(struct PvStateSession *s,
                       const char *local_json,
                       char **err);

/**
 * Отложенные, которые отправляет это устройство (JSON `ScheduledMessage[]`).
 */
char *pv_state_claim_due(struct PvStateSession *s,
                         int64_t now_ms);

/**
 * Отметка «отложенное отправлено» → JSON-массив base64 тел `state.append`.
 */
char *pv_state_mark_sent(struct PvStateSession *s,
                         const char *op_id_b64,
                         char **err);

/**
 * Запись истории звонков (D-08: сервер её не ведёт): proto3-JSON
 * `parvane.state.v1.CallRecord` → JSON-массив base64 тел `state.append`.
 */
char *pv_state_call_set(struct PvStateSession *s, const char *record_json, char **err);

/**
 * Ссылка-приглашение группы v2 (T160): proto3-JSON
 * `parvane.state.v1.GroupInvite` → JSON-массив base64 тел `state.append`.
 */
char *pv_state_group_invite_set(struct PvStateSession *s, const char *invite_json, char **err);

/**
 * Ссылка-приглашение снята: `link_id` — base64 → JSON-массив base64 тел `state.append`.
 */
char *pv_state_group_invite_remove(struct PvStateSession *s,
                                   const char *link_id_b64,
                                   char **err);

/**
 * Чат очищен «у себя» до момента (T145): proto3-JSON
 * `parvane.state.v1.ChatCleared` → JSON-массив base64 тел `state.append`.
 */
char *pv_state_chat_cleared(struct PvStateSession *s, const char *cleared_json, char **err);

/**
 * Уже отправленные этим устройством отложенные (JSON-массив hex; хранит хост).
 */
char *pv_state_sent_guard(const struct PvStateSession *s);

void pv_state_load_sent_guard(struct PvStateSession *s, const char *ids_json);

uint64_t pv_client_log_version(const struct PvClient *c, const char *user);

void pv_client_set_peer_delivery_key(struct PvClient *c,
                                     const char *user,
                                     const uint8_t *key,
                                     uintptr_t len,
                                     uint64_t generation);

struct PvBytes pv_encode_hello(int32_t channel, const char *kind, const char *version);

struct PvBytes pv_encode_auth(const char *token);

struct PvBytes pv_encode_request(uint64_t id,
                                 const char *method,
                                 const uint8_t *body,
                                 uintptr_t len,
                                 uint32_t timeout_ms);

struct PvBytes pv_encode_ping(uint64_t nonce);

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

/**
 * Копия корня (`root` — 32 байта `rootSecret` из create_identity) под ключом
 * восстановления. Пустой буфер — ошибка (в `err`).
 */
struct PvBytes pv_client_export_root_backup(const struct PvClient *c,
                                            const uint8_t *root,
                                            uintptr_t root_len,
                                            const char *recovery_key,
                                            char **err);

/**
 * Копия корня для администратора сервера (`escrow_public` — 32 байта из
 * `server.describe`): страховка на случай потери устройств и ключа
 * восстановления. Пустой буфер — ошибка (в `err`).
 */
struct PvBytes pv_client_export_root_escrow(const struct PvClient *c,
                                            const uint8_t *root,
                                            uintptr_t root_len,
                                            const uint8_t *escrow_public,
                                            uintptr_t escrow_public_len,
                                            char **err);

/**
 * Корень (32 байта) из копии, сверенный с журналом устройств. Буфер
 * освобождать `parvane_protocol_bytes_free` (движок не обнуляет копию —
 * вызывающий обнуляет её сам до освобождения).
 */
struct PvBytes pv_client_import_root_backup(const struct PvClient *c,
                                            const uint8_t *blob,
                                            uintptr_t len,
                                            const char *recovery_key,
                                            char **err);

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

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* PARVANE_PROTOCOL_H */
