// Parvane fork: клиентская сессия протокола v2 (spec 007, T062/T063) —
// порт web `src/api/parvane/v2/controller.ts`. Двойной стек на переходный
// период: v1-стек (parvane-e2e, JSON) обслуживает v1-собеседников, эта
// сессия — собеседников с журналом устройств v2. Формат выбирается по
// подписанному журналу собеседника (D-13), не по флагам сервера.
//
// Два отдельных соединения с gateway: ID (Hello + Auth JWT; инбокс, sync,
// ack, личные методы) и ANON (анонимная sealed-доставка, журналы и бандлы
// собеседников — без токена и адреса). Всё, что касается протокола, делает
// движок (v2_engine.h); сессия — ввод-вывод, добор данных по его «need» и
// хранение состояния устройства (pv_client_export, ключ 32 байта; оба файла
// дополнительно шифрует storecrypt, если клиент установил ключ хранилища).
//
// Потоки: операции с движком сериализованы мьютексом; события инбокса
// разбираются на собственном рабочем потоке сессии, обработчик onEvent
// зовётся на нём же — не на потоке чтения соединения и не на потоке
// вызывающего публичный метод (в т.ч. для событий, порождённых публичными
// методами), всегда вне мьютекса движка и по порядку.
//
// Кроме событий движка (host.rs event_json: "direct", "group", …) onEvent
// получает события сессии (как колбэки web controller.ts):
//   {"type":"groupUpdated","address":"v2g:<hex>","isNew":bool,"info":{…}}
//       — группа v2 появилась/изменилась (info — сведения журнала, groupInfo);
//   {"type":"groupLeft","address"} — нас исключили/забанили, группа удалена;
//   {"type":"groupUnconfirmed","address","members":[…]} — FR-028 (T080):
//       участники без подтверждённой записи администратора;
//   {"type":"ownDevicesAdded","devices":[…]} — T119: в своём журнале
//       устройств появились новые устройства (первая проверка — без события);
//   {"type":"stateReady"} — журнал личного состояния можно подключать
//       (после запуска и после смены ключа состояния);
//   {"type":"groupL2","address","enabled":bool,"by":адрес,"id":uuid,"tsMs"}
//       — политика «усиленная приватность» (L2) группы изменилась по журналу
//       (или мы вошли в L2-группу): клиент показывает служебное сообщение
//       чата (содержимое v2_content.h chatModeContent) от имени `by`.
//   {"type":"l2State","chats":[адреса чатов с активным L2: собеседник или
//       "v2g:<hex>"],"mine":[личные чаты из chats, где режим включён мной],
//       "presenceAllowed":bool} — при готовности сессии и при
//       каждом изменении набора: клиент держит по нему свой кэш «не слать
//       typing/presence» (чтобы не звать сессию с UI-потока — её методы
//       ждут мьютекс движка, который занят на время сетевых операций).
// Смена режима личного чата приходит обычным событием "direct" с
// содержимым chat_mode (interpretDirect → Message c kind "chat_mode").
// "groupChanged"/"deviceAdded"/"stateKeyRotated" движка сессия обрабатывает
// сама и наружу не отдаёт.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::v2 {

using nlohmann::json;

class AnonPlanner;
class Client;
class Connection;
class StateSession;

struct SessionConfig {
    // ws://…/ws, wss://…/ws или host:port (TCP с преамбулой PVN2).
    std::string gatewayUrl;
    std::string self; // user@domain
    // Текущий JWT (claim dev обязателен) — зовётся при каждом (пере)подключении.
    std::function<std::string()> token;
    // Каталог состояния устройства v2 (создаётся).
    std::string stateDir;
    std::string clientVersion = "desktop";
    // Число одноразовых ключей при создании устройства.
    std::size_t otkCount = 50;
    std::function<void(const std::string &)> log;
    // Событие движка (proto3-JSON, см. host.rs event_json) — на рабочем потоке.
    std::function<void(const json &event)> onEvent;
    // Пауза переподключения после обрыва.
    std::int64_t reconnectMs = 3000;
    // C1-06 / D-12: задан — корень нового устройства НЕ хранится на диске:
    // только его копия под ключом восстановления (файл root-backup), ключ
    // отдаётся сюда один раз для показа пользователю (на рабочем потоке).
    // Не задан — прежнее поведение (корень в файле root под storecrypt).
    std::function<void(const std::string &recoveryKey)> onRecoveryKey;
};

class Session {
public:
    explicit Session(SessionConfig cfg);
    ~Session();
    Session(const Session &) = delete;
    Session &operator=(const Session &) = delete;

    // Запустить рабочий поток: подключение, устройство, подписка, sync.
    // Повторы при обрыве — сами. Не блокирует.
    void start();
    void stop();
    [[nodiscard]] bool isReady() const { return ready_; }
    // Дождаться готовности (для тестов/хуков). false — таймаут/остановлено.
    bool waitReady(std::int64_t timeoutMs);
    // Устройство не создано: у аккаунта уже есть журнал v2 — этому
    // устройству нужна линковка (до неё — только v1).
    [[nodiscard]] bool needsLinking() const { return needsLinking_; }
    // LINK-1 v2. Старое устройство: материал гранта движка для своего нового
    // устройства (пусто — сессия не готова или у устройства нет SSK). Блокирующий.
    [[nodiscard]] std::string linkGrantMaterial();
    // Новое устройство (needsLinking): принять материал гранта, записать себя в
    // журнал устройств и поднять сессию. Не блокирует; исход — событие готовности
    // или снова needsLinking (событие `needsLinking`).
    void joinWithGrant(std::string material);

    // Собеседник на v2 (есть журнал устройств)? Блокирующий (сеть при промахе
    // кэша). Кэш: да — 10 мин, нет — 30 с. Не готово/self — false.
    bool isV2Peer(const std::string &address);
    // Отправить содержимое (proto3-JSON parvane.msg.v2.Content) собеседнику.
    // opId — UUID операции ("" — новый). Бросает при неудаче.
    void sendContent(const std::string &peer, const json &content, const std::string &opId);

    // Синхронизировать инбокс сейчас (блокирующий; на потоке вызывающего).
    void syncNow();

    // ── группы v2 (R8, T056/T073/T125) — адрес в клиентах "v2g:<hex>" ──
    // Создать группу, если сессия готова и ВСЕ участники на v2; "" — идти по
    // v1. Бросает при сбое создания v2-группы.
    std::string createGroup(const std::string &title, const std::vector<std::string> &members,
                            bool channel);
    // Изменение группы записью журнала (proto3-JSON group.v2.GroupChange:
    // {"remove_member":{"member":{"address":…}}}, {"ban":…}, {"set_info":…},
    // …). Смена состава/прав → новая эпоха. false — отклонено.
    bool changeGroup(const std::string &address, const json &change);
    // Сведения группы по журналу (JSON движка) или null.
    json groupInfo(const std::string &address);
    // Адреса известных групп v2.
    std::vector<std::string> groupAddresses();
    // FR-028: сверить состав по данным сервера (claimed) с журналом.
    void reportUnconfirmed(const std::string &address, const std::vector<std::string> &claimed);

    // Ссылки-приглашения v2 (D-04): https://<domain>/join/<link_id>#<seed>.
    // Запись: {"url","linkId","date","title","expiresAt","usageLimit",
    // "isRequestNeeded"} (секрет — только в url, хранится на устройстве).
    json createInvite(const std::string &address, const std::string &title, std::int64_t expireDate,
                      std::uint32_t usageLimit, bool requestNeeded);
    json listInvites(const std::string &address);
    bool revokeInvite(const std::string &address, const std::string &url);
    // Превью до вступления: null — не v2-ссылка/сессия не готова;
    // {"address","name","membersCount","isRequestNeeded","isChannel","isMember"}
    // либо {"error":"invalid"|"banned"|"expired"|"rateLimited"|"failed"}.
    json checkInvite(const std::string &url);
    // Вступить: null — не v2; {"status":"ok","address"} | {"status":"requested"}
    // | {"status":"error","code"}.
    json joinByInvite(const std::string &url);
    [[nodiscard]] static bool isInviteUrl(const std::string &url);

    // ── приватность (T079, FR-040) ──
    // identity.privacy.set перезаписывает ВСЕ поля — настройки уходят целиком:
    // groupAddNobody — «никто не может добавлять меня в группы»,
    // strangersAllowed — сообщения от незнакомых (по анонимным жетонам).
    // Значения запоминаются и досылаются при каждой готовности сессии
    // (запуск, переподключение). true — отправлено сейчас.
    bool setPrivacy(bool groupAddNobody, bool strangersAllowed);

    // ── режим «усиленная приватность» (L2, T079; правило L2-1) ──
    // Включить/выключить своё предпочтение в личном чате: операция ChatMode
    // собеседнику и своим устройствам. opId — id служебного сообщения в UI
    // ("" — новый). Своё сообщение клиент показывает сам (эхо не приходит).
    // Бросает при неудаче (в т.ч. собеседник не на v2).
    void setDirectL2(const std::string &peer, bool enabled, const std::string &opId);
    // Политика группы (запись журнала set_privacy_mode; право — как у
    // изменения сведений). false — отклонено. Событие "groupL2" — всем.
    bool setGroupL2(const std::string &address, bool enabled);
    // Состояние чата (собеседник или "v2g:<hex>"):
    // {"active","mine","enabledBy":[адреса],"pad","ephemeralAllowed"};
    // сессии нет/чат не v2 — режим выключен.
    json l2State(const std::string &chat);
    // typing/presence в этом чате разрешены (не v2 — да).
    bool ephemeralAllowed(const std::string &chat);
    // Публиковать ли своё присутствие: нет, пока L2 активен хоть в одном чате.
    bool presenceAllowed();

    // ── журнал личного состояния (R10, T098; сведение STATE-1 — в движке) ──
    [[nodiscard]] bool stateAvailable();
    // Прочитать журнал; при первом запуске (файла state-migrated нет)
    // перенести локальный снимок local (proto3-JSON StateSnapshot).
    // → сведённый снимок; null — журнал недоступен (нет ключа).
    json stateAttach(const json &local);
    // Своя правка (desired — поля видов kinds в StateSnapshot) → записи
    // журнала, затем чужие записи. → {"changed":bool,"snapshot":{…}};
    // null — журнал недоступен.
    json stateSync(const json &desired, const std::vector<std::string> &kinds);
    // Отложенное (op_id base64) уже отправлено каким-то устройством? (синк журнала)
    bool stateScheduledSent(const std::string &opIdB64);
    void stateMarkSent(const std::string &opIdB64);

private:
    using Task = std::function<void()>;
    void post(Task t);
    void postDelayed(std::int64_t delayMs, Task t);
    void workerLoop();
    void connectOnce();
    bool connectLocked(std::string *error);
    void onIdClosed();

    std::string call(bool anon, const std::string &method, const std::string &body);
    // C2-01: анонимный запрос в соединении, выбранном планировщиком движка.
    std::string callAnon(const std::string &method, const std::string &body);
    void closeAnon(std::uint64_t conn);
    void closeAllAnon();
    // Добрать данные по ошибке движка; false — нельзя (не need или неизвестный need).
    bool satisfyLocked(const std::exception &e);
    void runRequestsLocked(const json &reqs);
    void persistLocked();
    void openRecordLocked(const std::string &bytes, std::vector<json> &events);
    void syncAllLocked(std::vector<json> &events);
    void deliver(const std::vector<json> &events);
    // Разобрать события движка (группы, свои устройства, ключ состояния) и
    // поставить в очередь наружу; flush — отдать onEvent вне мьютекса.
    void absorbLocked(std::vector<json> events);
    void flush();
    void flushAsync();
    template <typename F> auto withNeedsLocked(F &&f) -> decltype(f());
    // Группы.
    void syncGroupLocked(const std::string &hex, const std::string &linkId = std::string());
    void resyncGroupLocked(const std::string &hex);
    void publishGroupLocked(const std::string &hex);
    void noteGroupL2Locked(const std::string &hex, const json &info);
    void noteL2StateLocked(bool force = false);
    void pushPrivacyLocked();
    void reportUnconfirmedLocked(const std::string &hex, const std::vector<std::string> &claimed);
    bool canRotateLocked(const std::string &hex);
    void ensureTokensLocked(std::size_t recipients);
    void rotateEpochLocked(const std::string &hex);
    void rotateEpochOnceLocked(const std::string &hex);
    void scheduleRotate(const std::string &hex, std::int64_t delayMs, int attempt = 0);
    std::vector<std::string> groupMembersLocked(const std::string &hex);
    json inviteGroupLocked(const std::string &linkIdHex);
    json loadInvites() const;
    // Свои устройства (T119).
    void checkOwnDevicesLocked();
    // Журнал состояния.
    bool openStateLocked();
    bool pullStateLocked();
    void pushAppendsLocked();
    void log(const std::string &m) const;
    std::string readStateFile(const std::string &name) const;
    bool writeStateFile(const std::string &name, const std::string &data) const;

    SessionConfig cfg_;
    std::recursive_mutex engineMu_;
    std::unique_ptr<Client> client_;
    std::unique_ptr<Connection> id_;
    std::unique_ptr<AnonPlanner> planner_;
    std::map<std::uint64_t, std::unique_ptr<Connection>> anonConns_;
    std::string storageKey_;
    std::string serverKey_;
    std::string domain_;
    std::string deviceId_;
    std::vector<json> outbox_;       // под engineMu_: события наружу по порядку
    std::recursive_mutex flushMu_;   // один отдающий за раз (порядок onEvent)
    std::set<std::string> publishedGroups_;
    std::set<std::string> warnedUnconfirmed_;
    std::set<std::string> syncingGroups_;
    // Приватность, заданная клиентом (под engineMu_): {groupAddNobody, strangers}.
    std::string l2Snapshot_; // последнее отданное событие l2State (под engineMu_)
    bool privacySet_ = false;
    bool privacyGroupAddNobody_ = false;
    bool privacyStrangers_ = true;
    std::unique_ptr<StateSession> state_;
    std::deque<std::string> pendingAppends_;
    std::atomic<bool> ready_{false};
    std::atomic<bool> needsLinking_{false};
    std::string linkMaterial_; // под engineMu_: грант линковки до вступления
    std::atomic<bool> stopping_{false};

    std::mutex readyMu_;
    std::condition_variable readyCv_;

    std::mutex qMu_;
    std::condition_variable qCv_;
    std::deque<Task> queue_;
    std::multimap<std::chrono::steady_clock::time_point, Task> delayed_;
    std::set<std::string> rotateScheduled_; // под qMu_
    std::thread worker_;
    bool reconnectScheduled_ = false;

    std::mutex peersMu_;
    struct PeerInfo {
        bool v2 = false;
        std::chrono::steady_clock::time_point at;
    };
    std::map<std::string, PeerInfo> peers_;
};

} // namespace parvane::v2
