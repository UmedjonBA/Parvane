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
#include <optional>
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
    [[nodiscard]] const std::string &self() const { return cfg_.self; }
    // Строка в лог сессии (для обвязок вокруг неё).
    void logLine(const std::string &m) const { log(m); }
    // Дождаться готовности (для тестов/хуков). false — таймаут/остановлено.
    bool waitReady(std::int64_t timeoutMs);
    // Устройство не создано: у аккаунта уже есть журнал v2 — этому
    // устройству нужна линковка (до неё — только v1).
    [[nodiscard]] bool needsLinking() const { return needsLinking_; }
    // Сигнал личного звонка (v1 JSON CallSignal) v2-собеседнику — запечатанным
    // конвертом по анонимному каналу (D-08). false — не v2 (идти v1-путём шарда
    // call); true — сигнал взят на себя v2 (при сбое отправки по v1 НЕ понижаем,
    // D-13: ошибка — в логе). Блокирующий. Входящие — событие
    // {"type":"callSignal","from":…,"signal":<v1 JSON>} (отправитель проверен движком).
    bool sendCallSignal(const std::string &peer, const json &signal);

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

    // ── блобы вложений по capability (T131, FR-062, D-08) ──
    // Блоб сообщения v2-чата грузится без per-recipient гранта: сервер хранит
    // SHA-256 секрета, сам секрет (32 байта) едет внутри E2E-содержимого.
    // Загрузить шифртекст → file_id. Бросает. Блокирующий (сеть).
    std::string uploadBlob(const std::string &bytes, const std::string &capability32,
                           std::size_t chunkBytes = 192 * 1024);
    // Скачать блоб целиком по секрету: анонимный канал, одноразовое соединение
    // на запрос (≤ 256 чанков). Бросает.
    std::string downloadBlobCap(const std::string &fileId, const std::string &capability32);

    // ── новое устройство без других устройств (T130, FR-066) ──
    // Сессия ждёт линковку (needsLinking), а других устройств аккаунта нет.
    // Вход по ключу восстановления: корень — из копии на сервере, новый SSK,
    // прежние устройства отзываются. "ok" | "bad_key" | "no_backup" | "failed".
    std::string recoverWithKey(const std::string &recoveryKey);
    // Сброс личности: новый корень и журнал взамен прежних (нужен пароль —
    // переаутентификация). Собеседники увидят смену ключа безопасности.
    // "ok" | "bad_password" | "failed".
    std::string resetIdentity(const std::string &password);

    // ── отзыв своего устройства (T128, FR-066; D-11, D-12, D-16) ──
    // Запись отзыва в журнале устройств + ротации: ключ доступа к доставке
    // (сервер, свои устройства, собеседники), ключ личного состояния, новые
    // эпохи групп, где мы админ. false — устройство не в журнале v2. Бросает,
    // если запись журнала не принята. Блокирующий (сеть).
    bool revokeDevice(const std::string &deviceId);
    // Отзыв доступа у одного собеседника (T133, FR-033) — звать при блокировке:
    // сама блокировка ключ доступа к доставке не отнимает. Новый ключ уходит на
    // сервер, своим устройствам и остальным собеседникам; заблокированный дальше
    // пишет только как незнакомый (жетоны), а при запрете незнакомых — никак.
    // false — ключа у собеседника не было (или сессия не готова). Бросает, если
    // сервер не принял новый ключ. Блокирующий (сеть).
    bool revokeContactAccess(const std::string &peer);
    // Свои устройства по журналу v2 (id). У аккаунта на v2 новое устройство в
    // каталог v1 не попадает (T048) — список устройств клиента дополняется этим.
    [[nodiscard]] std::vector<std::string> ownDevices();
    // {"rotationNeeded":bool,"hasRoot":bool,"hasBackup":bool}: SSK раскрыт
    // отзывом и не сменён; корень лежит на устройстве (первое устройство без
    // ключа восстановления) / есть копия корня под ключом восстановления.
    [[nodiscard]] json sskState();
    // Сменить SSK корнем (D-12). recoveryKey пуст — корень из файла `root`;
    // иначе из копии под ключом восстановления. "ok" | "bad_key" |
    // "no_backup" | "failed". Блокирующий.
    std::string rotateSsk(const std::string &recoveryKey);

    // «Печатает» в чате (собеседник либо группа v2) эфемерным каналом v2
    // (T127): секретный id канала, шифртекст — сервер не видит {from, to}.
    // false — чат не v2 (идти по v1); true — по v1 НЕ слать, даже если сигнал
    // не ушёл (канала ещё нет, L2). Блокирующий (сеть). Входящие — событие
    // {"type":"typing","chat":<адрес чата>,"from":<кто>}.
    bool sendTyping(const std::string &chat);

    // ── переходный период: v1-устройства (FR-054/FR-058) ──
    // Подписанный список v1-устройств пользователя: device_id → identity-ключ
    // (base64 без дополнения). Свой — по своему журналу, чужой — по кэшу
    // журнала собеседника (после isV2Peer).
    [[nodiscard]] std::map<std::string, std::string> legacyDevices(const std::string &user);
    // Опубликовать (первое v2-устройство) или сократить свой список по каталогу
    // v1 `[{deviceId, identity, signing}]`. Список только сокращается.
    void syncLegacySet(const json &catalog);
    // v1 SendPayload с копиями для v1-устройств — `msg.deliver_legacy`. Бросает.
    void deliverLegacy(const std::string &messageId, const json &sendPayload);

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
    // Правка, не ушедшая сейчас (сессия не готова), досылается при готовности;
    // после успеха — событие `privacySaved`. Без несохранённой правки сессия при
    // готовности читает серверное значение (identity.privacy.get) и отдаёт
    // событие `privacy{groupAddNobody,strangersAllowed}`. true — отправлено сейчас.
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
    void fetchPrivacyLocked();
    void reportUnconfirmedLocked(const std::string &hex, const std::vector<std::string> &claimed);
    bool canRotateLocked(const std::string &hex);
    void ensureTokensLocked(std::size_t recipients);
    // FR-063: партия жетонов по расписанию движка (при готовности и раз в час).
    void refillTokensLocked();
    void requestTokensLocked(std::size_t limit);
    void scheduleTokenCheck();
    bool tokenCheckScheduled_ = false;
    void rotateEpochLocked(const std::string &hex);
    void rotateEpochOnceLocked(const std::string &hex);
    void scheduleRotate(const std::string &hex, std::int64_t delayMs, int attempt = 0);
    std::vector<std::string> groupMembersLocked(const std::string &hex);
    json inviteGroupLocked(const std::string &linkIdHex);
    json loadInvites() const;
    // Свои устройства (T119).
    void checkOwnDevicesLocked();
    // Запросы личного чата; при отказе по ключу доступа собеседника (он сменил
    // ключ) — повтор со слепым жетоном.
    void runDirectLocked(const std::string &peer, const std::function<json()> &prepare);
    // KEY-1 v2: принять смену корня собеседника и сообщить хосту.
    bool acceptPeerRootLocked(const std::string &user);
    // Личность аккаунта сброшена другим устройством: это — вне неё.
    void dropIdentityLocked();
    // Копия корня под ключом восстановления — на сервер (FR-066).
    void uploadRootBackupLocked();
    // Подписаться на эфемерные каналы чатов (движок отдаёт только новые).
    void ensureEphemeralLocked(const std::vector<std::string> &chats);
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
    // Чаты, на эфемерные каналы которых подписываемся (переживает переподключение).
    std::set<std::string> ephChats_;
    std::set<std::string> warnedUnconfirmed_;
    std::set<std::string> syncingGroups_;
    // Приватность, заданная клиентом (под engineMu_): {groupAddNobody, strangers}.
    std::string l2Snapshot_; // последнее отданное событие l2State (под engineMu_)
    bool privacySet_ = false;
    bool privacyGroupAddNobody_ = false;
    bool privacyStrangers_ = true;
    std::unique_ptr<StateSession> state_;
    // Ключ личного состояния сменён (D-16): старые записи новым ключом не
    // читаются. stateRekeyed_ — следующий stateAttach не отдаёт хосту пустой
    // снимок, а переносит состояние под новый ключ: stateCarry_ (сведённое до
    // смены, если ключ менял это устройство) либо локальное состояние хоста.
    bool stateRekeyed_ = false;
    std::optional<json> stateCarry_;
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
