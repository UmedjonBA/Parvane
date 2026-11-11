// Parvane fork: C++-обёртка над C ABI движка протокола v2 (spec 007,
// backend/protocol/ffi → parvane_protocol.h). Кадры, тела запросов, записи
// журнала и конверты собирает и разбирает ТОЛЬКО движок; здесь — владение
// памятью (строки/буферы движка освобождаются сразу), исключения вместо
// char** err и байты как std::string. Своего protobuf в C++ нет.
//
// Ошибки движка — JSON: {"need":{"kind":"peerLog"|"bundle"|"token"|…,…}}
// (добрать данные и повторить) или {"error":"<вид ProtoError>"}.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

struct PvAnonPlanner;

namespace parvane::engine {
class Host;
}

namespace parvane::v2 {

using nlohmann::json;

// Каналы Hello (parvane.core.v2.Channel).
inline constexpr int kChannelIdentified = 1;
inline constexpr int kChannelAnonymous = 2;

class EngineError : public std::runtime_error {
public:
    explicit EngineError(const std::string &raw);
    // Разобранный JSON ошибки ({} — не JSON).
    [[nodiscard]] const json &details() const { return details_; }
    // Движку не хватает данных (журнал/бандл/жетоны) — details()["need"].
    [[nodiscard]] bool isNeed() const;
    [[nodiscard]] json need() const;
    // Вид ошибки ("Malformed", "InvalidField", …) или вид need.
    [[nodiscard]] std::string kind() const;

private:
    json details_;
};

// Версия движка и мажорная версия протокола.
[[nodiscard]] std::string engineVersion();
[[nodiscard]] std::uint32_t protocolMajor();

// ── кадры ───────────────────────────────────────────────────────────────────
[[nodiscard]] std::string encodeHello(int channel, const std::string &clientKind,
                                      const std::string &clientVersion);
[[nodiscard]] std::string encodeAuth(const std::string &token);
[[nodiscard]] std::string encodeRequest(std::uint64_t id, const std::string &method,
                                        const std::string &body, std::uint32_t timeoutMs);
// Запрос объекту сервера `dest` (spec 028, FED-1; пусто — свой сервер); `padTo` > 0 — дополнить кадр до
// кратного этой длине (spec 025, L2).
[[nodiscard]] std::string encodeRequestTo(std::uint64_t id, const std::string &method, const std::string &body,
                                          std::uint32_t timeoutMs, const std::string &dest, std::uint32_t padTo = 0);
// spec 029: функция движка без клиента по имени WASM-обвязки (`encodeHello`, `parseInvite`, …): аргументы —
// объект (байты — base64), результат — значение JSON. Бросает EngineError.
[[nodiscard]] json engineCall(const std::string &name, const json &args = json::object());
// Кадр сервера → JSON {"kind":"welcome"|"authOk"|"response"|"event"|"chunk"|
// "ping"|"pong"|"unknown", …}; тела — base64. Бросает EngineError.
[[nodiscard]] json decodeFrame(const std::string &bytes);
// Подписанный описатель сервера → {"domain","serverKey"(hex)}. Бросает.
[[nodiscard]] json verifyServerDescriptor(const std::string &bytes);
// Страница msg.inbox.sync → {"records":[base64…],"more":bool}. Бросает.
[[nodiscard]] json splitSyncResponse(const std::string &bytes);
// Тело запроса из proto3-JSON по полному имени типа. Бросает.
[[nodiscard]] std::string encodeMessage(const std::string &typeName, const json &value);
// Число записей журнала устройств в ответе identity.device.log_sync_anon.
[[nodiscard]] std::int64_t deviceLogEntries(const std::string &bytes);
// base64 → байты (тела из JSON-ответов движка). Бросает.
[[nodiscard]] std::string fromBase64(const std::string &b64);
// Байты ответа → proto3-JSON по полному имени типа. Бросает.
[[nodiscard]] json decodeMessage(const std::string &typeName, const std::string &bytes);
// Любой метод реестра (T161): proto3-JSON запроса → тело, тело ответа →
// proto3-JSON. Бросают при незнакомом методе и негодном JSON/байтах.
[[nodiscard]] std::string encodeMethodRequest(const std::string &method, const json &request);
[[nodiscard]] json decodeMethodResponse(const std::string &method, const std::string &bytes);
// Ссылка-приглашение → {"kind":"v2","domain","linkId"(hex)} |
// {"kind":"legacy","token"}; nullopt — не ссылка-приглашение.
[[nodiscard]] std::optional<json> parseInvite(const std::string &url);

// Запрос, который движок просит выполнить: канал "id"/"anon", метод реестра,
// тело (уже байты).
struct OutRequest {
    bool anon = false;
    std::string method;
    std::string body;
    // Домен сервера объекта (spec 028, FED-1; `dest` запроса движка); пусто — свой сервер.
    std::string dest;
};
[[nodiscard]] OutRequest parseRequest(const json &r);

// C1-06: новый ключ восстановления (≥ 128 бит) — показать пользователю один раз.
[[nodiscard]] std::string generateRecoveryKey();
// Материал гранта линковки + копия корня под ключом восстановления (поле `rb`);
// исходный материал при сбое.
[[nodiscard]] std::string grantWithRootBackup(const std::string &material, const std::string &backup);
// T130: корень (32 байта) из копии под ключом восстановления на устройстве
// без журнала. Бросает EngineError (неверный ключ/копия).
[[nodiscard]] std::string importRootBackupFor(const std::string &user, const std::string &blob,
                                              const std::string &recoveryKey);
// Копия корня из материала гранта ("" — гранта без копии).
[[nodiscard]] std::string grantRootBackup(const std::string &material);

// C2-01 (D-05): планировщик соединений анонимного канала (sans-IO, движок).
// Соединение — одному получателю (пользователь/группа) и в серии ≤ 60 с с
// открытия; публичные запросы (журналы, бандлы, ключи жетонов) — всегда
// новое одноразовое соединение. Не потокобезопасен.
class AnonPlanner {
public:
    struct Assignment {
        std::uint64_t conn = 0;
        bool open = false;       // открыть новое соединение под номером conn
        bool closeAfter = false; // закрыть сразу после ответа
    };
    AnonPlanner();
    ~AnonPlanner();
    AnonPlanner(const AnonPlanner &) = delete;
    AnonPlanner &operator=(const AnonPlanner &) = delete;
    // Бросает EngineError (битое тело доставки).
    [[nodiscard]] Assignment assign(const std::string &method, const std::string &body,
                                    std::int64_t nowMs);
    // Соединения, серия которых истекла, — закрыть.
    [[nodiscard]] std::vector<std::uint64_t> expired(std::int64_t nowMs);
    void closed(std::uint64_t conn);
    [[nodiscard]] std::size_t openCount() const;

private:
    PvAnonPlanner *p_ = nullptr;
};

// Клиентское ядро устройства (ключи, журналы устройств и групп, эпохи, сессии, курсор инбокса) — в модели движка
// (spec 035 T125, contracts/engine-api.md): каждый вызов — `clientCall` модели `engine::Host` теми же именами и
// аргументами, что единая точка входа `host::call` (web `EngineClient`; android — то же ядро). Состояние клиента
// лежит в хранилище модели (`store_fs`) и уходит на диск следующим шагом модели (`flush`) — своего экспорта у хоста
// нет. Каждый вызов атомарен (мьютекс модели); составные действия сериализует вызывающий.
class Client {
public:
    explicit Client(std::shared_ptr<engine::Host> host);
    ~Client();
    Client(const Client &) = delete;
    Client &operator=(const Client &) = delete;

    // Клиент в модели без профиля (хранилище в памяти): тесты и разовые проверки. Бросают EngineError.
    [[nodiscard]] static std::unique_ptr<Client> create(const std::string &user,
                                                        const std::string &deviceId,
                                                        const std::string &domain);
    // Экспорт прежнего клиента (под ключом 32 байта) — импортом в модель в памяти.
    [[nodiscard]] static std::unique_ptr<Client> import(const std::string &blob,
                                                        const std::string &key32);
    // Сменить клиента модели: новое устройство (пользователь, устройство и домен модели) либо импорт экспорта.
    // Бросают EngineError.
    void replaceNew();
    void replaceImport(const std::string &blob, const std::string &key32);
    // Экспорт состояния клиента под ключом (копия ключей аккаунта, линковка) — чтение модели.
    [[nodiscard]] std::string exportState(const std::string &key32) const;
    [[nodiscard]] const std::shared_ptr<engine::Host> &host() const { return host_; }

    // Любая функция клиента по имени единой точки входа (`plannerSeal`, `groupInfo`, `renamePrepare`, …) с тем же
    // смыслом, что в web `controller.ts`: аргументы — объект (байты — base64), результат — значение JSON (запросы —
    // {chan, method, body, dest?}). Бросает EngineError (need — добрать и повторить).
    json call(const std::string &name, const json &args = json::object()) const;

    // Первое v2-устройство: корень, журнал, сертификат, OTK.
    // → {"requests":[…], "rootSecret": base64}.
    [[nodiscard]] json createIdentity(std::size_t otk);
    // LINK-1 v2. Старое устройство (держатель SSK): материал гранта для своего
    // нового устройства — JSON {ssk, log, dk, gen[, sk, skv]} (формат общий с
    // web). Новое устройство: вступить по материалу → запросы публикации.
    // Бросают EngineError.
    [[nodiscard]] std::string linkGrantMaterial();
    [[nodiscard]] json joinWithGrant(const std::string &material, std::size_t otk);
    [[nodiscard]] json syncRequest();
    [[nodiscard]] json ackRequest();
    // Ответ identity.device.log_sync_anon → "new"|"known"|"rootChanged".
    [[nodiscard]] std::string ingestLog(const std::string &user, const std::string &resp);
    // Ответ identity.device.fetch_bundle_anon → число устройств.
    std::size_t ingestBundle(const std::string &user, const std::string &resp);
    [[nodiscard]] json tokenRequest(const std::string &keyList, const std::string &serverKey,
                                    std::size_t count);
    std::size_t tokenResponse(const std::string &resp);
    // Сигнал личного звонка (D-08): proto3-JSON parvane.call.v2.CallSignal →
    // массив запросов (оффер — call.ring_sealed, прочее — call.signal_sealed,
    // анонимный канал). Бросает (need — как prepareDirect).
    [[nodiscard]] json prepareCall(const std::string &peer, const json &signal);
    // content — proto3-JSON parvane.msg.v2.Content; opId — UUID ("" — новый).
    // → массив запросов. Бросает EngineError (в т.ч. need).
    [[nodiscard]] json prepareDirect(const std::string &peer, const json &content,
                                     const std::string &opId);
    // Запись журнала инбокса (байты InboxRecord) → массив событий. Сессия подаёт записи модели (`ingest`, режим хоста);
    // прямой вызов — тесты.
    [[nodiscard]] json openRecord(const std::string &record);
    [[nodiscard]] std::string lastError();
    [[nodiscard]] std::uint64_t logVersion(const std::string &user) const;
    // C1-06: копия корня (32 байта rootSecret из createIdentity) под ключом
    // восстановления (generateRecoveryKey) и обратно (сверка с журналом; открытый корень остаётся в памяти модели
    // до rotateSsk). Бросают EngineError.
    [[nodiscard]] std::string exportRootBackup(const std::string &root32,
                                               const std::string &recoveryKey) const;
    [[nodiscard]] std::string importRootBackup(const std::string &blob,
                                               const std::string &recoveryKey) const;

    // ── группы v2 (журнал состояния группы, эпохи, ссылки) ──
    // kind: 1 — группа, 2 — канал; members — адреса без себя; perms —
    // proto3-JSON group.v2.Permissions. → {"group":{"domain","id"},"request"}.
    // migratedFrom — прежний group_id группы v1, из которой эта переведена (T180).
    [[nodiscard]] json groupCreate(int kind, const std::string &name,
                                   const std::vector<std::string> &members, const json &perms,
                                   const std::string &migratedFrom = std::string());
    // Ответ group.state.sync → версия журнала после применения. Бросает (need).
    std::uint64_t groupIngest(const std::string &domain, const std::string &groupHex,
                              const std::string &resp);
    // Изменение группы (proto3-JSON group.v2.GroupChange) → запрос. Бросает.
    [[nodiscard]] json groupChange(const std::string &groupHex, const json &change);
    // Решение по заявке на вступление → запрос group.request.decide
    // (одобрение — запись AddMember, локальный журнал продвинут). Бросает.
    [[nodiscard]] json groupRequestDecide(const std::string &groupHex, const std::string &user,
                                          bool approve);
    // Новая эпоха → [publish, …ключи участникам]. Бросает (need).
    [[nodiscard]] json groupRotateEpoch(const std::string &groupHex);
    // Групповое сообщение → массив запросов. Бросает (need).
    [[nodiscard]] json prepareGroup(const std::string &groupHex, const json &content,
                                    const std::string &opId);
    // События, ждавшие журнала/ключей группы (после groupIngest/новой эпохи).
    [[nodiscard]] json drainReady();
    [[nodiscard]] std::uint64_t groupVersion(const std::string &groupHex) const;
    // Версия, от которой отстаём; -1 — не отстаём (D-03).
    [[nodiscard]] std::int64_t groupBehind(const std::string &groupHex) const;
    void groupForget(const std::string &groupHex);
    // hex id известных групп.
    [[nodiscard]] std::vector<std::string> groupList() const;
    // Сведения группы (участники, роли, права, эпоха); nullopt — журнала нет.
    [[nodiscard]] std::optional<json> groupInfo(const std::string &groupHex) const;
    // FR-028: участники без подтверждённой записи администратора.
    [[nodiscard]] std::vector<std::string> groupUnconfirmed(
        const std::string &groupHex, const std::vector<std::string> &claimed) const;
    // Новая ссылка → {"request","url","linkId"}. Бросает.
    [[nodiscard]] json groupInviteCreate(const std::string &groupHex, const std::string &title,
                                         std::int64_t expiresMs, std::uint32_t usageLimit,
                                         bool requiresApproval);
    // Вступление по ссылке v2 → запрос group.join. Бросает.
    [[nodiscard]] json groupJoin(const std::string &url);
    // spec 035 (PV-006): журнал частной группы по ссылке до вступления — запрос group.state.sync с доказательством
    // знания секрета ссылки (url — ссылка целиком). Бросает.
    [[nodiscard]] json groupSyncByLink(const std::string &url, const std::string &domain, const std::string &groupHex,
                                       std::uint64_t afterVersion, std::int64_t tsMs);
    // spec 035 (PV-005): новое фото группы → запрос SetInfo с avatar_key_id (keyB64 "" — открытое фото, fileId "" —
    // снять фото). Бросает.
    [[nodiscard]] json groupSetPhoto(const std::string &groupHex, const std::string &fileId,
                                     const std::string &avatarDomain, const std::string &keyB64);
    // После смены фото (журнал перечитан) и новой эпохи → {"content": GroupAvatarKey | null, "requests": [...]}.
    [[nodiscard]] json groupPhotoFollowups(const std::string &groupHex, const std::vector<std::string> &links);
    // Устройства пользователя по журналу → {"v2":[…], "root"?} (списка v1-устройств нет с T096).
    [[nodiscard]] json logDevices(const std::string &user) const;
    // Сервер отверг ключ доступа собеседника (FORBIDDEN на доставке): дальше —
    // слепым жетоном. true — ключ был и сброшен (отправку стоит повторить).
    bool deliveryKeyRejected(const std::string &peer);
    // Известен ли ключ доступа собеседника (сигнал звонка сервер принимает
    // только с ним — слепой жетон для звонков не годится).
    [[nodiscard]] bool hasPeerDeliveryKey(const std::string &peer) const;
    // Кто прочитал своё сообщение (по E2E-квитанциям): [{"user","tsMs"}].
    [[nodiscard]] json readers(const std::string &opId) const;
    // KEY-1 v2 (T129): принять смену корня собеседника (после предупреждения).
    bool acceptRootChange(const std::string &user);
    // T130: восстановление на новом устройстве по корню (32 байта) и ответу
    // identity.device.log_sync с версии 0 → запросы. Бросает.
    [[nodiscard]] json recoverWithRoot(const std::string &root32, const std::string &logResp, std::size_t otk);
    // T130: сброс личности → {"requests":[…],"rootSecret":base64}; первый
    // запрос — identity.root.rotate. Бросает.
    [[nodiscard]] json resetIdentity(std::size_t otk);

    // ── отзыв своего устройства (T128; D-11, D-12, D-16) ──
    // Запись отзыва в журнале + ротации → {"requests":[…],"pendingKeyShares":
    // [адрес…],"pendingEpochs":[hex…],"epochsNeedAdmin":[hex…],
    // "sskRotationRequired":bool,"stateKeyVersion":n|null}. Первый запрос —
    // запись журнала (обязателен). Бросает (в т.ч. need — добор данных).
    [[nodiscard]] json revokeDevice(const std::string &deviceId);
    // Отозвать ключ доступа у собеседника (FR-033; блокировка): новый ключ всем,
    // кроме него → {"requests":[…],"pendingKeyShares":[…]}; пустой requests —
    // ключа у собеседника не было. Бросает (в т.ч. need).
    [[nodiscard]] json revokeContactAccess(const std::string &peer);
    // Раздать текущий ключ доступа собеседнику (отложенное после отзыва).
    [[nodiscard]] json shareDeliveryKey(const std::string &peer);
    // T142: группы v2 — своим новым устройствам (JSON-массив запросов).
    [[nodiscard]] json shareGroupsWithOwnDevices(const json &devices);
    // Сменить SSK корнем (32 байта секрета; пусто — корень, уже открытый в модели) → запросы. Бросает.
    [[nodiscard]] json rotateSsk(const std::string &root32);
    // Свой SSK раскрыт отзывом державшего его устройства и ещё не сменён.
    [[nodiscard]] bool ownSskExposed() const;

    // ── эфемерные каналы: «печатает» и присутствие (T127) ──
    // Подписка на каналы чатов {"peers":[адрес…],"groups":[hex…]} → запросы
    // ephemeral.subscribe (только новые каналы).
    [[nodiscard]] json ephSubscribe(const json &chats);
    // Соединение пересоздано — подписок больше нет.
    void ephReset();
    // «Печатает»: chat — адрес собеседника либо hex группы; action — номер
    // TypingAction. Запросы (пусто — канала нет или чат в L2).
    [[nodiscard]] json ephTyping(const std::string &chat, int action) const;
    // Своё присутствие. Запросы (пусто — пока L2 активен хоть в одном чате).
    [[nodiscard]] json ephPresence(bool online, std::int64_t lastSeenMs) const;
    // Событие подписки ephemeral → события typing/presence (см. host.rs).
    [[nodiscard]] json ephOpen(const std::string &body) const;
    [[nodiscard]] std::size_t tokenCount() const;
    // FR-063: пора получать суточную партию жетонов (хост проверяет таймером, не
    // перед тратой) и её размер — вся суточная квота.
    [[nodiscard]] bool tokenRefillDue() const;
    [[nodiscard]] std::size_t tokenBatchSize() const;

    // ── режим «усиленная приватность» (L2, T079) ──
    // Включить/выключить L2 в личном чате: операция ChatMode собеседнику и
    // своим устройствам → массив запросов (как prepareDirect). Бросает (need).
    [[nodiscard]] json l2SetDirect(const std::string &peer, bool enabled, const std::string &opId);
    // Состояние L2 личного чата / группы:
    // {"active","mine","enabledBy":[адреса],"pad","ephemeralAllowed"}.
    // Политику группы меняет groupChange с {"set_privacy_mode":{"l2":bool}}.
    [[nodiscard]] json l2Direct(const std::string &peer) const;
    [[nodiscard]] json l2Group(const std::string &groupHex) const;
    // Личное предпочтение в группе (свои исходящие выравниваются).
    void l2SetGroupPref(const std::string &groupHex, bool enabled);
    // Чаты с активным L2: {"direct":[адреса],"groups":[hex id]}.
    [[nodiscard]] json l2ActiveChats() const;
    // Публиковать ли своё присутствие (L2 не активен ни в одном чате).
    [[nodiscard]] bool presenceAllowed() const;

    // ── журнал личного состояния (T098) ──
    [[nodiscard]] bool hasStateKey() const;
    // Создать ключ, если его нет; true — создан (сохранить состояние).
    bool ensureStateKey();

private:
    std::shared_ptr<engine::Host> host_;
};

// Сессия журнала истории аккаунта (spec 033, HIST-1/HIST-2/READ-2): шифрование и разбор записей — в движке
// (`historyCall` модели: ключ истории выводится из текущего и прежних ключей личного состояния клиента модели и
// обновляется после их смены). Курсор, голову журнала и строки хранит хост (`parvane::history::HistorySync`).
class HistorySession {
public:
    // nullptr — у клиента нет ключа личного состояния.
    [[nodiscard]] static std::unique_ptr<HistorySession> open(const Client &client);
    ~HistorySession();
    HistorySession(const HistorySession &) = delete;
    HistorySession &operator=(const HistorySession &) = delete;
    // Функция сессии по имени WASM `PvHistory.call` (`syncRequest`, `ingest`, `seal`, …; статические `history*` —
    // тоже). Бросает EngineError.
    json call(const std::string &name, const json &args = json::object());

private:
    explicit HistorySession(std::shared_ptr<engine::Host> host) : host_(std::move(host)) {}
    std::shared_ptr<engine::Host> host_;
};

} // namespace parvane::v2
