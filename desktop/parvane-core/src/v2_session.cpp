// Parvane fork: клиентская сессия протокола v2 (см. v2_session.h).
#include "parvane/v2_session.h"

#include "parvane/storecrypt.h"
#include "parvane/v2_content.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <sys/stat.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <regex>

namespace parvane::v2 {

namespace {

constexpr auto kPeerPositiveTtl = std::chrono::seconds(15); // журнал устройств собеседника перечитывается
constexpr auto kPeerNegativeTtl = std::chrono::seconds(30);
constexpr int kNeedAttempts = 6;
// parvane.msg.v2.TypingAction
constexpr int kTypingTyping = 1;
constexpr int kTypingCancel = 2;
constexpr int kMaxSyncPages = 1000;
constexpr int kGroupSyncPages = 50;
constexpr int kStateSyncPages = 1000;
// Смена эпохи — не чаще раза в 10 с (R8): повтор после отказа по частоте.
constexpr std::int64_t kEpochRetryMs = 11000;
// Проверка расписания партии жетонов (FR-063): срок задаёт движок, здесь — шаг.
constexpr std::int64_t kTokenCheckMs = 60 * 60 * 1000;
// Партия меньше суточной квоты: квота на аккаунт, её делят все его устройства.
constexpr std::size_t kTokenBatch = 20;
// Квота — на аккаунт и сутки: если партия целиком в остаток не влезает (его
// выбрали другие устройства аккаунта), сервер отвечает LIMIT на весь запрос —
// просим остаток партией поменьше, иначе устройство останется без жетонов.
constexpr std::size_t kTokenBatchSteps[] = {kTokenBatch, 10, 5, 2, 1};
constexpr int kEpochRetryAttempts = 6;
// Запас слепых жетонов перед раздачей ключей группы незнакомым участникам.
constexpr std::size_t kTokenReserve = 2;
constexpr int kGroupKindGroup = 1;
constexpr int kGroupKindChannel = 2;
constexpr int kRoleAdmin = 2;
constexpr int kRoleOwner = 3;
constexpr const char *kPinListMain = "PIN_LIST_MAIN";

std::string sha256(const std::string &data) {
    unsigned char h[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    if (EVP_Digest(data.data(), data.size(), h, &len, EVP_sha256(), nullptr) != 1 || len != 32) {
        throw std::runtime_error("v2: SHA-256");
    }
    return std::string(reinterpret_cast<const char *>(h), len);
}

bool isRateLimited(const std::exception &e) {
    const std::string w = e.what();
    return w.find("RateLimited") != std::string::npos || w.find("RATE_LIMITED") != std::string::npos;
}

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

// Права группы по умолчанию (как у новой группы Telegram); канал — только админы.
json defaultGroupPermissions() {
    return json{{"send_messages", true}, {"send_media", true}, {"send_stickers_gifs", true},
                {"send_polls", true}, {"embed_links", true}, {"invite_users", true},
                {"pin_messages", false}, {"change_info", false}};
}

std::string peerKey(const json &peer) {
    if (!peer.is_object()) return {};
    if (peer.contains("user") && peer["user"].is_object()) {
        return "u:" + peer["user"].value("address", std::string());
    }
    if (peer.contains("group") && peer["group"].is_object()) {
        return "g:" + peer["group"].value("domain", std::string()) + ":" + peer["group"].value("id", std::string());
    }
    return {};
}

bool isMainPinList(const json &list) {
    return (list.is_string() && list.get<std::string>() == kPinListMain)
        || (list.is_number_integer() && list.get<int>() == 1);
}

std::string hexToBytes(const std::string &hex) {
    std::string out;
    for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
        out.push_back(static_cast<char>(std::stoi(hex.substr(i, 2), nullptr, 16)));
    }
    return out;
}

void mkdirs(const std::string &dir) {
    std::string cur;
    for (std::size_t i = 0; i < dir.size(); ++i) {
        cur.push_back(dir[i]);
        if (dir[i] == '/' || i + 1 == dir.size()) {
            ::mkdir(cur.c_str(), 0700);
        }
    }
}

} // namespace

Session::Session(SessionConfig cfg) : cfg_(std::move(cfg)) {}

Session::~Session() { stop(); }

void Session::log(const std::string &m) const {
    if (cfg_.log) cfg_.log("v2: " + m);
}

std::string Session::readStateFile(const std::string &name) const {
    return storecrypt::readFile(cfg_.stateDir + "/" + name);
}

bool Session::writeStateFile(const std::string &name, const std::string &data) const {
    return storecrypt::writeFile(cfg_.stateDir + "/" + name, data);
}

// ── рабочий поток ──────────────────────────────────────────────────────────

void Session::start() {
    if (worker_.joinable()) return;
    stopping_ = false;
    worker_ = std::thread(&Session::workerLoop, this);
    post([this] { connectOnce(); });
}

void Session::stop() {
    stopping_ = true;
    {
        std::lock_guard<std::mutex> lk(qMu_);
        queue_.clear();
        delayed_.clear();
        rotateScheduled_.clear();
    }
    qCv_.notify_all();
    readyCv_.notify_all();
    if (worker_.joinable()) worker_.join();
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    ready_ = false;
    if (id_) id_->close();
    closeAllAnon();
    id_.reset();
    state_.reset();
    pendingAppends_.clear();
    outbox_.clear();
    client_.reset();
}

void Session::post(Task t) {
    {
        std::lock_guard<std::mutex> lk(qMu_);
        if (stopping_) return;
        queue_.push_back(std::move(t));
    }
    qCv_.notify_one();
}

void Session::postDelayed(std::int64_t delayMs, Task t) {
    {
        std::lock_guard<std::mutex> lk(qMu_);
        if (stopping_) return;
        delayed_.emplace(std::chrono::steady_clock::now() + std::chrono::milliseconds(delayMs), std::move(t));
    }
    qCv_.notify_one();
}

void Session::workerLoop() {
    while (!stopping_) {
        Task t;
        {
            std::unique_lock<std::mutex> lk(qMu_);
            for (;;) {
                if (stopping_) return;
                if (!queue_.empty()) {
                    t = std::move(queue_.front());
                    queue_.pop_front();
                    break;
                }
                if (!delayed_.empty() && delayed_.begin()->first <= std::chrono::steady_clock::now()) {
                    t = std::move(delayed_.begin()->second);
                    delayed_.erase(delayed_.begin());
                    break;
                }
                if (delayed_.empty()) {
                    qCv_.wait(lk);
                } else {
                    qCv_.wait_until(lk, delayed_.begin()->first);
                }
            }
        }
        try {
            t();
        } catch (const std::exception &e) {
            log(std::string("ошибка задачи: ") + e.what());
        }
    }
}

bool Session::waitReady(std::int64_t timeoutMs) {
    std::unique_lock<std::mutex> lk(readyMu_);
    return readyCv_.wait_for(lk, std::chrono::milliseconds(timeoutMs),
                             [&] { return ready_.load() || stopping_.load() || needsLinking_.load(); })
        && ready_;
}

void Session::onIdClosed() {
    ready_ = false;
    if (stopping_) return;
    log("соединение ID закрыто — переподключение");
    {
        std::lock_guard<std::mutex> lk(qMu_);
        if (reconnectScheduled_) return;
        reconnectScheduled_ = true;
    }
    post([this] {
        // Пауза с выходом по stop().
        {
            std::unique_lock<std::mutex> lk(qMu_);
            qCv_.wait_for(lk, std::chrono::milliseconds(cfg_.reconnectMs), [&] { return stopping_.load(); });
            reconnectScheduled_ = false;
        }
        if (!stopping_) connectOnce();
    });
}

void Session::connectOnce() {
    if (stopping_ || needsLinking_) return;
    std::vector<json> events;
    std::string error;
    bool ok = false;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        ok = connectLocked(&error);
        if (ok) {
            // Ключ личного состояния (T098): первое v2-устройство создаёт его;
            // связанное получает от своего устройства (StateKeyShare).
            try {
                const auto own = client_->logDevices(cfg_.self);
                const auto count = own.contains("v2") && own["v2"].is_array() ? own["v2"].size() : 0;
                if (!client_->hasStateKey() && count <= 1 && client_->ensureStateKey()) {
                    log("ключ личного состояния создан");
                    persistLocked();
                }
            } catch (const std::exception &e) {
                log(std::string("ключ личного состояния: ") + e.what());
            }
            // Группы v2 из состояния движка — в UI до разбора инбокса.
            for (const auto &hex : client_->groupList()) publishGroupLocked(hex);
            ready_ = true; // группы и мутации во время sync ходят через готовую сессию
            try {
                syncAllLocked(events);
            } catch (const std::exception &e) {
                log(std::string("sync при запуске: ") + e.what());
            }
            absorbLocked(std::move(events));
            events.clear();
            // «Печатает» по v2: каналы известных чатов (на новом соединении — заново).
            ensureEphemeralLocked(std::vector<std::string>(ephChats_.begin(), ephChats_.end()));
            noteL2StateLocked(/*force=*/true);
            // Приватность (T079, FR-040): несохранённая правка этого устройства
            // уходит на сервер, иначе читаем серверное значение — его могло
            // сменить другое устройство.
            try {
                if (privacySet_) {
                    pushPrivacyLocked();
                } else {
                    fetchPrivacyLocked();
                }
            } catch (const std::exception &) {
                // в логе; повтор — при следующей готовности или смене настройки
            }
        }
    }
    if (ok) {
        {
            std::lock_guard<std::mutex> lk(readyMu_);
            ready_ = true;
        }
        readyCv_.notify_all();
        log("готов");
        flush();
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            if (client_) {
                outbox_.push_back(json{{"type", "stateReady"}});
                try {
                    checkOwnDevicesLocked();
                } catch (const std::exception &e) {
                    log(std::string("журнал своих устройств: ") + e.what());
                }
                try {
                    uploadRootBackupLocked();
                } catch (const std::exception &e) {
                    log(std::string("копия корня на сервер не ушла: ") + e.what());
                }
                refillTokensLocked();
                if (!tokenCheckScheduled_) {
                    tokenCheckScheduled_ = true;
                    scheduleTokenCheck();
                }
            }
        }
        flush();
        return;
    }
    readyCv_.notify_all();
    if (needsLinking_) {
        // Клиент публикует оффер линковки, даже если история v1 уже есть.
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            outbox_.push_back(json{{"type", "needsLinking"}});
        }
        flush();
        return;
    }
    if (stopping_) return;
    log("запуск не удался: " + error);
    onIdClosed();
}

std::string Session::linkGrantMaterial() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return {};
    try {
        const auto material = client_->linkGrantMaterial();
        // Копия корня под ключом восстановления — вместе с грантом (поле `rb`):
        // привязанное устройство сможет сменить SSK после отзыва другого (D-12).
        const auto backup = readStateFile("root-backup");
        return backup.empty() ? material : grantWithRootBackup(material, backup);
    } catch (const std::exception &e) {
        log(std::string("грант линковки недоступен: ") + e.what());
        return {};
    }
}

void Session::joinWithGrant(std::string material) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!needsLinking_ || ready_ || material.empty()) return;
        linkMaterial_ = std::move(material);
    }
    needsLinking_ = false;
    post([this] {
        if (!stopping_) connectOnce();
    });
}

// ── подключение и устройство ───────────────────────────────────────────────

bool Session::connectLocked(std::string *error) {
    try {
        ready_ = false;
        closeAllAnon();
        planner_ = std::make_unique<AnonPlanner>();
        if (id_) id_->close();
        id_ = std::make_unique<Connection>(cfg_.gatewayUrl);
        const auto welcome = id_->open(kChannelIdentified, cfg_.clientVersion);
        const auto desc = verifyServerDescriptor(welcome.serverDescriptor);
        domain_ = desc.value("domain", std::string());
        serverKey_ = hexToBytes(desc.value("serverKey", std::string()));
        const auto token = cfg_.token ? cfg_.token() : std::string();
        if (token.empty()) throw std::runtime_error("нет JWT");
        const auto auth = id_->auth(token);
        deviceId_ = auth.deviceId;
        id_->setEventHandler([this](const Event &ev) {
            if (ev.kind == "inbox.record") {
                auto body = ev.body;
                post([this, body] {
                    std::vector<json> events;
                    {
                        std::lock_guard<std::recursive_mutex> lk(engineMu_);
                        if (!client_) return;
                        openRecordLocked(body, events);
                        log("запись инбокса: событий " + std::to_string(events.size()));
                        absorbLocked(std::move(events));
                        // Сначала на диск (сессии Olm продвинулись), потом ack: процесс,
                        // убитый между ними, иначе терял входящую сессию навсегда.
                        persistLocked();
                        try {
                            const auto ack = parseRequest(client_->ackRequest());
                            call(ack.anon, ack.method, ack.body);
                        } catch (const std::exception &) {
                        }
                    }
                    flush();
                });
            } else if (ev.kind == "ephemeral") {
                // «Печатает» по эфемерному каналу (T127): автор и чат проверены движком.
                auto body = ev.body;
                post([this, body] {
                    {
                        std::lock_guard<std::recursive_mutex> lk(engineMu_);
                        if (!client_) return;
                        for (const auto &e : client_->ephOpen(body)) {
                            if (e.value("type", std::string()) != "typing" || e.value("action", 0) == kTypingCancel) continue;
                            const auto from = e.value("from", std::string());
                            const auto group = e.contains("group") && e["group"].is_string()
                                ? groupAddress(e["group"].get<std::string>()) : std::string();
                            outbox_.push_back(json{{"type", "typing"}, {"chat", group.empty() ? from : group}, {"from", from}});
                        }
                    }
                    flush();
                });
            } else if (ev.kind == "session.revoked") {
                log("сессия отозвана");
            } else {
                log("событие подписки без обработчика: " + ev.kind);
            }
        });
        id_->setClosedHandler([this] { onIdClosed(); });

        if (!client_) {
            mkdirs(cfg_.stateDir);
            storageKey_ = readStateFile("key");
            if (storageKey_.size() != 32) {
                storageKey_.assign(32, '\0');
                if (RAND_bytes(reinterpret_cast<unsigned char *>(storageKey_.data()), 32) != 1) {
                    throw std::runtime_error("RAND_bytes");
                }
                if (!writeStateFile("key", storageKey_)) {
                    throw std::runtime_error("ключ состояния не записан");
                }
            }
            const auto savedDevice = readStateFile("device");
            const auto saved = readStateFile("state");
            if (!saved.empty() && savedDevice == auth.deviceId) {
                client_ = Client::import(saved, storageKey_);
                log("состояние устройства загружено");
                // Пока устройство было выключено, личность аккаунта могли сбросить
                // (новый корень и журнал, T130): тогда оно вне неё — только линковка.
                try {
                    const auto own = call(false, "identity.device.log_sync",
                        encodeMessage("parvane.identity.v2.DeviceLogSyncRequest",
                                      json{{"user", {{"address", cfg_.self}}},
                                           {"after_version", std::to_string(client_->logVersion(cfg_.self))}}));
                    if (client_->ingestLog(cfg_.self, own) == "replaced") {
                        dropIdentityLocked();
                        outbox_.pop_back(); // событие needsLinking отдаст connectOnce
                        if (error) *error = "нужна линковка";
                        return false;
                    }
                } catch (const V2Error &) {
                    // сеть — свой журнал перечитается после готовности
                }
            } else {
                if (!saved.empty()) {
                    log("сохранённое состояние другого устройства (" + savedDevice + ") — не используется");
                }
                auto c = Client::create(cfg_.self, auth.deviceId, domain_);
                // Первое v2-устройство пользователя — корень и журнал устройств.
                // Если журнал уже есть (другое устройство на v2) — нужна
                // линковка этого устройства (LINK-1 v2); до неё — только v1.
                const auto ownLog = call(true, "identity.device.log_sync_anon",
                    encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                                  json{{"user", {{"address", cfg_.self}}}, {"after_version", "0"}}));
                if (deviceLogEntries(ownLog) > 0 && linkMaterial_.empty()) {
                    log("у аккаунта уже есть журнал устройств — нужна линковка этого устройства");
                    needsLinking_ = true;
                    if (error) *error = "нужна линковка";
                    return false;
                }
                if (!linkMaterial_.empty()) {
                    // Грант от своего устройства (LINK-1 v2): SSK, журнал, ключ
                    // доставки и ключ личного состояния — устройство сертифицирует
                    // себя записью журнала (D-11). Порядок «диск → сеть» — как у
                    // первого устройства: прерванную публикацию досылает `publish`.
                    json requests;
                    try {
                        requests = c->joinWithGrant(linkMaterial_, cfg_.otkCount);
                    } catch (const std::exception &) {
                        // Негодный грант не повторяем: снова ждём линковку.
                        linkMaterial_.clear();
                        needsLinking_ = true;
                        throw;
                    }
                    client_ = std::move(c);
                    writeStateFile("publish", requests.dump());
                    writeStateFile("device", auth.deviceId);
                    if (const auto backup = grantRootBackup(linkMaterial_); !backup.empty()) {
                        writeStateFile("root-backup", backup);
                    }
                    persistLocked();
                    std::fill(linkMaterial_.begin(), linkMaterial_.end(), '\0');
                    linkMaterial_.clear();
                    runRequestsLocked(requests);
                    std::remove((cfg_.stateDir + "/publish").c_str());
                    log("устройство привязано грантом линковки");
                }
            }
            if (!client_) {
                auto c = Client::create(cfg_.self, auth.deviceId, domain_);
                const auto created = c->createIdentity(cfg_.otkCount);
                client_ = std::move(c);
                // Сначала — на диск (корень/копия, устройство, состояние, запросы
                // публикации), потом — в сеть: процесс, убитый между публикацией
                // журнала и сохранением, иначе навсегда видел «журнал уже есть →
                // нужна линковка» (найдено сценарием X в эмуляторе, 29 сен 2026).
                auto root = fromBase64(created.value("rootSecret", std::string()));
                std::string recoveryKey;
                if (cfg_.onRecoveryKey) {
                    // C1-06 / D-12: корень на устройстве не лежит — только
                    // копия под ключом восстановления; ключ — пользователю.
                    recoveryKey = generateRecoveryKey();
                    writeStateFile("root-backup", client_->exportRootBackup(root, recoveryKey));
                } else {
                    // Корень — в личное хранилище (storecrypt).
                    writeStateFile("root", root);
                }
                std::fill(root.begin(), root.end(), '\0');
                writeStateFile("publish", created.value("requests", json::array()).dump());
                writeStateFile("device", auth.deviceId);
                persistLocked();
                runRequestsLocked(created.value("requests", json::array()));
                std::remove((cfg_.stateDir + "/publish").c_str());
                if (!recoveryKey.empty()) cfg_.onRecoveryKey(recoveryKey);
                log("устройство создано (журнал устройств опубликован)");
            }
        }
        // Публикация нового устройства прервалась (обрыв сети или процесс убит
        // между сохранением и публикацией) — дослать до подписки.
        if (const auto pending = json::parse(readStateFile("publish"), nullptr, false); pending.is_array()) {
            try {
                runRequestsLocked(pending);
                log("публикация устройства дослана");
            } catch (const V2Error &e) {
                if (e.code() == "ERROR_CODE_UNAVAILABLE") throw; // сеть — повторим при переподключении
                // сервер отверг (в т.ч. повтор уже принятой записи) — не зацикливаемся
                log(std::string("публикация устройства не дослана: ") + e.what());
            }
            std::remove((cfg_.stateDir + "/publish").c_str());
        }
        id_->request("msg.inbox.subscribe", std::string());
        // Подписки на эфемерные каналы жили в прежнем соединении — заново.
        client_->ephReset();
        return true;
    } catch (const std::exception &e) {
        if (error) *error = e.what();
        return false;
    }
}

// C2-01 (D-05): соединение анонимного канала выбирает планировщик движка —
// одно соединение на получателя в серии ≤ 60 с, публичные запросы — в
// одноразовом соединении (как web controller.ts callAnon).
void Session::closeAnon(std::uint64_t conn) {
    const auto it = anonConns_.find(conn);
    if (it != anonConns_.end()) {
        auto c = std::move(it->second);
        anonConns_.erase(it);
        if (c) c->close();
    }
    if (planner_) planner_->closed(conn);
}

void Session::closeAllAnon() {
    while (!anonConns_.empty()) closeAnon(anonConns_.begin()->first);
}

std::string Session::callAnon(const std::string &method, const std::string &body) {
    if (!planner_) planner_ = std::make_unique<AnonPlanner>();
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch()).count();
    for (const auto id : planner_->expired(now)) closeAnon(id);
    const auto plan = planner_->assign(method, body, now);
    Connection *c = nullptr;
    if (const auto it = anonConns_.find(plan.conn); it != anonConns_.end()) c = it->second.get();
    if (plan.open || !c || !c->isOpen()) {
        if (c) c->close();
        auto fresh = std::make_unique<Connection>(cfg_.gatewayUrl);
        try {
            fresh->open(kChannelAnonymous, cfg_.clientVersion);
        } catch (...) {
            anonConns_.erase(plan.conn);
            planner_->closed(plan.conn);
            throw;
        }
        c = fresh.get();
        anonConns_[plan.conn] = std::move(fresh);
    }
    try {
        auto resp = c->request(method, body);
        if (plan.closeAfter) closeAnon(plan.conn);
        return resp;
    } catch (...) {
        if (plan.closeAfter || !c->isOpen()) closeAnon(plan.conn);
        throw;
    }
}

std::string Session::call(bool anon, const std::string &method, const std::string &body) {
    // Чтения identity (журналы, бандлы, жетоны) при кратком UNAVAILABLE сервера
    // (identity v2: «database is locked» под одновременной нагрузкой) — повтор,
    // иначе отправка падала целиком (verify_protocol_v2.sh, 29 сен 2026).
    const bool retriable = method.rfind("identity.", 0) == 0;
    for (int attempt = 0;; ++attempt) {
        try {
            if (anon) return callAnon(method, body);
            Connection *c = id_.get();
            if (!c || !c->isOpen()) throw V2Error("ERROR_CODE_UNAVAILABLE");
            return c->request(method, body);
        } catch (const V2Error &e) {
            if (!retriable || attempt >= 2 || e.code() != "ERROR_CODE_UNAVAILABLE" || stopping_) throw;
            log(method + ": сервер недоступен — повтор");
            std::this_thread::sleep_for(std::chrono::milliseconds(300 * (attempt + 1)));
        }
    }
}

void Session::runRequestsLocked(const json &reqs) {
    if (!reqs.is_array()) return;
    for (const auto &r : reqs) {
        const auto req = parseRequest(r);
        call(req.anon, req.method, req.body);
    }
}

void Session::persistLocked() {
    if (!client_ || storageKey_.size() != 32) return;
    try {
        writeStateFile("state", client_->exportState(storageKey_));
    } catch (const std::exception &e) {
        log(std::string("состояние не сохранено: ") + e.what());
    }
}

bool Session::satisfyLocked(const std::exception &ex) {
    const auto *ee = dynamic_cast<const EngineError *>(&ex);
    if (!ee || !ee->isNeed() || !client_) return false;
    const auto need = ee->need();
    const auto kind = need.value("kind", std::string());
    const auto user = need.value("user", std::string());
    if (kind == "peerLog") {
        const auto resp = call(true, "identity.device.log_sync_anon",
            encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                          json{{"user", {{"address", user}}},
                               {"after_version", std::to_string(client_->logVersion(user))}}));
        auto verdict = client_->ingestLog(user, resp);
        if (verdict == "replaced") {
            // Журнал на сервере начат заново (другой генезис) — перечитать целиком.
            verdict = client_->ingestLog(user, call(true, "identity.device.log_sync_anon",
                encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                              json{{"user", {{"address", user}}}, {"after_version", "0"}})));
        }
        if (verdict == "rootChanged") return acceptPeerRootLocked(user);
        return verdict != "replaced";
    }
    if (kind == "rootChanged") return acceptPeerRootLocked(user);
    if (kind == "bundle") {
        const auto resp = call(true, "identity.device.fetch_bundle_anon",
            encodeMessage("parvane.identity.v2.DeviceFetchBundleAnonRequest",
                          json{{"user", {{"address", user}}}}));
        client_->ingestBundle(user, resp);
        return true;
    }
    if (kind == "token") {
        if (serverKey_.empty()) return false;
        requestTokensLocked(kTokenBatch);
        return true;
    }
    if (kind == "groupLog") {
        const auto hex = need.value("group", std::string());
        if (hex.empty() || syncingGroups_.count(hex)) return false;
        const auto before = client_->groupVersion(hex);
        syncGroupLocked(hex);
        // Сервер не отдал новых записей — повтор не поможет (удержание хвоста, D-03).
        return client_->groupVersion(hex) != before || client_->groupBehind(hex) < 0;
    }
    if (kind == "groupKeys") {
        // Ключей эпохи нет: админ начинает новую эпоху сам, участник ждёт её.
        const auto hex = need.value("group", std::string());
        if (hex.empty() || !canRotateLocked(hex)) return false;
        rotateEpochLocked(hex);
        return true;
    }
    return false;
}

// ── приём ───────────────────────────────────────────────────────────────────

void Session::openRecordLocked(const std::string &bytes, std::vector<json> &events) {
    if (!client_) return;
    json got;
    bool opened = false;
    for (int i = 0; i < kNeedAttempts && !opened; ++i) {
        try {
            got = client_->openRecord(bytes);
            opened = true;
        } catch (const std::exception &e) {
            bool more = false;
            try {
                more = satisfyLocked(e);
            } catch (const std::exception &inner) {
                log(std::string("добор данных не удался: ") + inner.what());
            }
            if (!more) {
                log(std::string("запись не открыта: ") + e.what());
                return;
            }
        }
    }
    if (got.is_array()) {
        for (auto &ev : got) events.push_back(std::move(ev));
    }
    const auto err = client_->lastError();
    if (!err.empty()) log("ошибка записи: " + err);
}

void Session::syncAllLocked(std::vector<json> &events) {
    if (!client_) return;
    for (int page = 0; page < kMaxSyncPages; ++page) {
        const auto req = parseRequest(client_->syncRequest());
        const auto resp = call(req.anon, req.method, req.body);
        const auto batch = splitSyncResponse(resp);
        const auto &records = batch.contains("records") ? batch["records"] : json::array();
        for (const auto &r : records) {
            if (r.is_string()) openRecordLocked(fromBase64(r.get<std::string>()), events);
        }
        if (!batch.value("more", false) || records.empty()) break;
    }
    persistLocked(); // до ack — см. обработчик inbox.record
    try {
        const auto ack = parseRequest(client_->ackRequest());
        call(ack.anon, ack.method, ack.body);
    } catch (const std::exception &) {
    }
}

void Session::syncNow() {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return;
        std::vector<json> events;
        syncAllLocked(events);
        absorbLocked(std::move(events));
    }
    flushAsync();
}

void Session::deliver(const std::vector<json> &events) {
    if (!cfg_.onEvent) return;
    for (const auto &ev : events) {
        try {
            cfg_.onEvent(ev);
        } catch (const std::exception &e) {
            log(std::string("обработчик события: ") + e.what());
        }
    }
}

// ── маршрутизация и отправка ───────────────────────────────────────────────

bool Session::isV2Peer(const std::string &address) {
    if (!ready_ || address.empty() || address == cfg_.self || isGroupAddress(address)) return false;
    const auto now = std::chrono::steady_clock::now();
    {
        std::lock_guard<std::mutex> lk(peersMu_);
        const auto it = peers_.find(address);
        if (it != peers_.end()) {
            const auto ttl = it->second.v2 ? std::chrono::steady_clock::duration(kPeerPositiveTtl)
                                           : std::chrono::steady_clock::duration(kPeerNegativeTtl);
            if (now - it->second.at < ttl) return it->second.v2;
        }
    }
    bool v2 = false;
    try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return false;
        // Журнал собеседника перечитывается по TTL кэша (как каталог устройств v1),
        // а не один раз: иначе его новое устройство не получало сообщений, пока
        // само не напишет. Запрос — «после известной версии», обычно пустой.
        const auto before = client_->logVersion(address);
        try {
            satisfyLocked(EngineError(json{{"need", {{"kind", "peerLog"}, {"user", address}}}}.dump()));
        } catch (const std::exception &e) {
            if (before == 0) throw;
            log("журнал " + address + " не обновлён: " + e.what());
        }
        v2 = client_->logVersion(address) > 0;
        if (client_->logVersion(address) != before) persistLocked();
    } catch (const std::exception &e) {
        log("журнал " + address + " не получен: " + e.what());
        return false;
    }
    {
        std::lock_guard<std::mutex> lk(peersMu_);
        peers_[address] = PeerInfo{v2, now};
    }
    if (v2) {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        ensureEphemeralLocked({address});
    }
    return v2;
}

void Session::sendContent(const std::string &peer, const json &content, const std::string &opId) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
        json reqs;
        if (isGroupAddress(peer)) {
            const auto hex = groupHex(peer);
            ensureTokensLocked(groupMembersLocked(hex).size());
            reqs = withNeedsLocked([&] { return client_->prepareGroup(hex, content, opId); });
            runRequestsLocked(reqs);
        } else {
            runDirectLocked(peer, [&] { return client_->prepareDirect(peer, content, opId); });
        }
        persistLocked();
    }
    flushAsync();
}

void Session::runDirectLocked(const std::string &peer, const std::function<json()> &prepare) {
    try {
        runRequestsLocked(withNeedsLocked(prepare));
    } catch (const std::exception &e) {
        // Ключ доступа собеседника отвергнут (он сменил ключ: отзыв устройства,
        // восстановление, сброс личности) — повтор со слепым жетоном.
        const std::string w = e.what();
        const bool forbidden = w.find("FORBIDDEN") != std::string::npos || w.find("Forbidden") != std::string::npos;
        if (!forbidden || !client_ || !client_->deliveryKeyRejected(peer)) throw;
        log("ключ доступа собеседника отвергнут — повтор со слепым жетоном");
        runRequestsLocked(withNeedsLocked(prepare));
    }
}

// KEY-1 v2 (T129, FR-019): у собеседника сменился корень личности (журнал
// устройств начат заново). Как в v1: хост показывает «ключ безопасности
// изменился», новый журнал принимается, прежние сессии отбрасываются.
bool Session::acceptPeerRootLocked(const std::string &user) {
    if (!client_ || !client_->acceptRootChange(user)) return false;
    {
        std::lock_guard<std::mutex> lk(peersMu_);
        peers_.erase(user);
    }
    persistLocked();
    log("у " + user + " сменился корневой ключ — предупреждение, новый журнал принят");
    outbox_.push_back(json{{"type", "peerRootChanged"}, {"user", user}});
    return true;
}

bool Session::sendCallSignal(const std::string &peer, const json &signal) {
    if (isGroupAddress(peer) || !isV2Peer(peer)) return false;
    const auto v2Signal = callSignalToV2(signal);
    if (!v2Signal) {
        log("сигнал звонка по v2 не выражается — не отправлен (D-13)");
        return true;
    }
    try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
        runDirectLocked(peer, [&] { return client_->prepareCall(peer, *v2Signal); });
        persistLocked();
    } catch (const std::exception &e) {
        log(std::string("сигнал звонка не отправлен: ") + e.what());
    }
    return true;
}

// ── блобы вложений по capability (T131, FR-062, D-08) ──────────────────────

std::string Session::uploadBlob(const std::string &bytes, const std::string &capability32, std::size_t chunkBytes) {
    if (capability32.size() != 32 || chunkBytes == 0) throw std::runtime_error("v2: capability/чанк");
    if (!ready_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    // Загрузка идёт ID-каналом (владелец блоба серверу известен — получатели нет).
    const auto total = std::max<std::size_t>(1, (bytes.size() + chunkBytes - 1) / chunkBytes);
    std::string uploadId;
    for (std::size_t index = 0; index < total; ++index) {
        const auto resp = decodeMessage("parvane.cloud.v1.UploadChunkResponse",
            call(false, "cloud.blob.upload_chunk",
                 encodeMessage("parvane.cloud.v1.UploadChunkRequest",
                               json{{"upload_id", uploadId},
                                    {"index", index},
                                    {"data", toBase64(bytes.substr(index * chunkBytes, chunkBytes))}})));
        const auto got = resp.value("uploadId", resp.value("upload_id", std::string()));
        if (!got.empty()) uploadId = got;
    }
    const auto done = decodeMessage("parvane.cloud.v1.UploadCompleteResponse",
        call(false, "cloud.blob.upload_complete",
             encodeMessage("parvane.cloud.v1.UploadCompleteRequest",
                           json{{"upload_id", uploadId},
                                {"chunks", total},
                                {"size", std::to_string(bytes.size())},
                                {"visibility", "VISIBILITY_PRIVATE"},
                                {"capability_hash", toBase64(sha256(capability32))}})));
    const auto fileId = done.value("fileId", done.value("file_id", std::string()));
    if (fileId.empty()) throw V2Error("ERROR_CODE_INVALID");
    return fileId;
}

std::string Session::downloadBlobCap(const std::string &fileId, const std::string &capability32) {
    if (capability32.size() != 32) throw std::runtime_error("v2: capability");
    if (!ready_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    constexpr std::uint32_t kBatch = 256;
    std::string out;
    std::uint32_t total = 0;
    for (std::uint32_t first = 0;; first += kBatch) {
        // Одноразовое анонимное соединение на запрос: серверу не связать
        // скачивание ни с аккаунтом, ни с другими запросами (D-05).
        Connection conn(cfg_.gatewayUrl);
        conn.open(kChannelAnonymous, cfg_.clientVersion);
        const auto got = conn.requestStream("cloud.blob.download_cap",
            encodeMessage("parvane.cloud.v1.DownloadCapRequest",
                          json{{"file_id", fileId},
                               {"capability", toBase64(capability32)},
                               {"first_chunk", first},
                               {"chunk_count", kBatch}}));
        conn.close();
        const auto meta = decodeMessage("parvane.cloud.v1.DownloadCapResponse", got.body);
        total = meta.value("chunks", std::uint32_t(0));
        for (std::uint32_t index = first; index < std::min(total, first + kBatch); ++index) {
            const auto it = got.chunks.find(index);
            if (it == got.chunks.end()) throw V2Error("ERROR_CODE_UNAVAILABLE");
            out += it->second;
        }
        if (first + kBatch >= total) break;
    }
    return out;
}

// ── новое устройство без других устройств (T130, FR-066) ───────────────────

void Session::dropIdentityLocked() {
    log("личность аккаунта сброшена другим устройством — нужна линковка этого устройства");
    ready_ = false;
    client_.reset();
    state_.reset();
    pendingAppends_.clear();
    for (const char *name : {"state", "root", "root-backup", "root-backup-sent", "own-devices", "state-migrated"}) {
        std::remove((cfg_.stateDir + "/" + name).c_str());
    }
    needsLinking_ = true;
    outbox_.push_back(json{{"type", "needsLinking"}});
}

void Session::uploadRootBackupLocked() {
    const auto backup = readStateFile("root-backup");
    if (backup.empty() || !client_) return;
    const auto mark = toBase64(backup);
    if (readStateFile("root-backup-sent") == mark) return;
    call(false, "identity.root.backup_set",
         encodeMessage("parvane.identity.v2.RootBackupSetRequest", json{{"backup", mark}}));
    writeStateFile("root-backup-sent", mark);
}

std::string Session::recoverWithKey(const std::string &recoveryKey) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (ready_ || !needsLinking_ || !id_ || storageKey_.size() != 32) return "failed";
        std::string backup;
        try {
            const auto resp = decodeMessage("parvane.identity.v2.RootBackupGetResponse",
                                            call(false, "identity.root.backup_get", std::string()));
            backup = fromBase64(resp.value("backup", std::string()));
        } catch (const std::exception &e) {
            log(std::string("копия корня не получена: ") + e.what());
            return "failed";
        }
        if (backup.empty()) return "no_backup";
        std::string root;
        try {
            root = importRootBackupFor(cfg_.self, backup, recoveryKey);
        } catch (const std::exception &) {
            return "bad_key";
        }
        try {
            auto c = Client::create(cfg_.self, deviceId_, domain_);
            const auto ownLog = call(false, "identity.device.log_sync",
                encodeMessage("parvane.identity.v2.DeviceLogSyncRequest",
                              json{{"user", {{"address", cfg_.self}}}, {"after_version", "0"}}));
            const auto requests = c->recoverWithRoot(root, ownLog, cfg_.otkCount);
            std::fill(root.begin(), root.end(), '\0');
            client_ = std::move(c);
            // Порядок «диск → сеть», как у первого устройства и линковки.
            writeStateFile("publish", requests.dump());
            writeStateFile("device", deviceId_);
            writeStateFile("root-backup", backup);
            persistLocked();
            runRequestsLocked(requests);
            std::remove((cfg_.stateDir + "/publish").c_str());
            needsLinking_ = false;
            log("устройство восстановлено ключом восстановления (прежние устройства отозваны)");
        } catch (const std::exception &e) {
            std::fill(root.begin(), root.end(), '\0');
            client_.reset();
            std::remove((cfg_.stateDir + "/publish").c_str());
            std::remove((cfg_.stateDir + "/state").c_str());
            log(std::string("восстановление по ключу не удалось: ") + e.what());
            return "failed";
        }
    }
    post([this] {
        if (!stopping_) connectOnce();
    });
    return "ok";
}

std::string Session::resetIdentity(const std::string &password) {
    std::string recoveryKey;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (ready_ || !needsLinking_ || !id_ || storageKey_.size() != 32) return "failed";
        try {
            call(false, "identity.session.reauth",
                 encodeMessage("parvane.identity.v2.SessionReauthRequest", json{{"password", password}}));
        } catch (const std::exception &) {
            return "bad_password";
        }
        try {
            auto c = Client::create(cfg_.self, deviceId_, domain_);
            const auto created = c->resetIdentity(cfg_.otkCount);
            // Первый запрос — замена журнала (нужна свежая переаутентификация):
            // здесь «сеть → диск», повтор после рестарта без пароля не прошёл бы.
            runRequestsLocked(created.value("requests", json::array()));
            client_ = std::move(c);
            auto root = fromBase64(created.value("rootSecret", std::string()));
            if (cfg_.onRecoveryKey) {
                recoveryKey = generateRecoveryKey();
                writeStateFile("root-backup", client_->exportRootBackup(root, recoveryKey));
                std::remove((cfg_.stateDir + "/root").c_str());
            } else {
                writeStateFile("root", root);
                std::remove((cfg_.stateDir + "/root-backup").c_str());
            }
            std::fill(root.begin(), root.end(), '\0');
            std::remove((cfg_.stateDir + "/root-backup-sent").c_str());
            writeStateFile("device", deviceId_);
            persistLocked();
            needsLinking_ = false;
            log("личность сброшена — новый корень и журнал устройств");
        } catch (const std::exception &e) {
            client_.reset();
            log(std::string("сброс личности не удался: ") + e.what());
            return "failed";
        }
    }
    if (!recoveryKey.empty()) cfg_.onRecoveryKey(recoveryKey);
    post([this] {
        if (!stopping_) connectOnce();
    });
    return "ok";
}

// ── отзыв своего устройства (T128, FR-066; D-11, D-12, D-16) ───────────────

bool Session::revokeContactAccess(const std::string &peer) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_ || peer.empty() || peer == cfg_.self) return false;
        const auto outcome = withNeedsLocked([&] { return client_->revokeContactAccess(peer); });
        const auto requests = outcome.value("requests", json::array());
        if (requests.empty()) return false; // ключа у собеседника не было
        try {
            runRequestsLocked(json::array({requests[0]})); // identity.delivery_key.set
        } catch (const std::exception &) {
            // Сервер новый ключ не принял, а движок уже сменил — состояние
            // поднимется заново из сохранённого при переподключении.
            client_.reset();
            state_.reset();
            if (id_) id_->close();
            throw;
        }
        for (std::size_t i = 1; i < requests.size(); ++i) {
            try {
                runRequestsLocked(json::array({requests[i]}));
            } catch (const std::exception &e) {
                log("раздача ключа доступа (" + requests[i].value("method", std::string()) + "): " + e.what());
            }
        }
        persistLocked();
        for (const auto &p : outcome.value("pendingKeyShares", json::array())) {
            if (!p.is_string()) continue;
            try {
                runRequestsLocked(withNeedsLocked([&] { return client_->shareDeliveryKey(p.get<std::string>()); }));
            } catch (const std::exception &e) {
                log("ключ доступа " + p.get<std::string>() + " не роздан: " + e.what());
            }
        }
        persistLocked();
        log("доступ собеседника отозван: ключ доступа сменён (раздач " + std::to_string(requests.size() - 1) + ")");
    }
    flushAsync();
    return true;
}

bool Session::revokeDevice(const std::string &deviceId) {
    bool sskExposed = false;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_ || deviceId.empty() || deviceId == deviceId_) return false;
        const auto own = client_->logDevices(cfg_.self);
        const auto v2 = own.contains("v2") && own["v2"].is_array() ? own["v2"] : json::array();
        if (std::find(v2.begin(), v2.end(), json(deviceId)) == v2.end()) return false;
        // Сведённое состояние — до смены ключа: потом старые записи не прочитать.
        std::optional<json> carry;
        if (state_) carry = state_->snapshot();
        const auto outcome = withNeedsLocked([&] { return client_->revokeDevice(deviceId); });
        const auto requests = outcome.value("requests", json::array());
        if (requests.empty()) throw std::runtime_error("v2: отзыв без записи журнала");
        try {
            runRequestsLocked(json::array({requests[0]}));
        } catch (const std::exception &) {
            // Сервер запись не принял, а движок её уже применил — состояние
            // поднимется заново из сохранённого при переподключении.
            client_.reset();
            state_.reset();
            if (id_) id_->close();
            throw;
        }
        for (std::size_t i = 1; i < requests.size(); ++i) {
            try {
                runRequestsLocked(json::array({requests[i]}));
            } catch (const std::exception &e) {
                log("ротация после отзыва (" + requests[i].value("method", std::string()) + "): " + e.what());
            }
        }
        persistLocked();
        // Отложенное: собеседники без нового ключа доступа и группы без новой эпохи.
        for (const auto &peer : outcome.value("pendingKeyShares", json::array())) {
            if (!peer.is_string()) continue;
            try {
                runRequestsLocked(withNeedsLocked([&] { return client_->shareDeliveryKey(peer.get<std::string>()); }));
            } catch (const std::exception &e) {
                log("ключ доступа " + peer.get<std::string>() + " не роздан: " + e.what());
            }
        }
        // (scheduleRotate ждёт «устаревшую» эпоху журнала — отзыв устройства
        // журнал группы не меняет, поэтому повтор — напрямую.)
        for (const auto &h : outcome.value("pendingEpochs", json::array())) {
            if (!h.is_string()) continue;
            postDelayed(kEpochRetryMs, [this, hex = h.get<std::string>()] {
                {
                    std::lock_guard<std::recursive_mutex> lk2(engineMu_);
                    if (!client_ || !ready_) return;
                    try {
                        rotateEpochLocked(hex);
                        publishGroupLocked(hex);
                    } catch (const std::exception &e) {
                        log("новая эпоха группы " + hex + " после отзыва не начата: " + e.what());
                    }
                }
                flush();
            });
        }
        persistLocked();
        if (outcome.contains("stateKeyVersion") && !outcome["stateKeyVersion"].is_null()) {
            state_.reset();
            pendingAppends_.clear();
            stateRekeyed_ = true;
            stateCarry_ = std::move(carry);
            outbox_.push_back(json{{"type", "stateReady"}});
        }
        sskExposed = client_->ownSskExposed();
        if (sskExposed) outbox_.push_back(json{{"type", "sskRotationNeeded"}});
        log("устройство отозвано (ротаций " + std::to_string(requests.size() - 1) + ")");
    }
    flushAsync();
    // Корень лежит на устройстве (первое устройство без ключа восстановления) —
    // SSK меняется сразу, пользователя не спрашиваем.
    if (sskExposed && !readStateFile("root").empty()) rotateSsk(std::string());
    return true;
}

std::vector<std::string> Session::ownDevices() {
    std::vector<std::string> out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return out;
    const auto own = client_->logDevices(cfg_.self);
    if (!own.contains("v2") || !own["v2"].is_array()) return out;
    for (const auto &id : own["v2"]) {
        if (id.is_string()) out.push_back(id.get<std::string>());
    }
    return out;
}

json Session::sskState() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return json{{"rotationNeeded", ready_ && client_ && client_->ownSskExposed()},
                {"hasRoot", !readStateFile("root").empty()},
                {"hasBackup", !readStateFile("root-backup").empty()}};
}

std::string Session::rotateSsk(const std::string &recoveryKey) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return "failed";
    std::string root;
    if (recoveryKey.empty()) {
        root = readStateFile("root");
        if (root.empty()) return "no_backup";
    } else {
        const auto backup = readStateFile("root-backup");
        if (backup.empty()) return "no_backup";
        try {
            root = client_->importRootBackup(backup, recoveryKey);
        } catch (const std::exception &) {
            return "bad_key";
        }
    }
    std::string result = "ok";
    try {
        const auto reqs = client_->rotateSsk(root);
        try {
            runRequestsLocked(reqs);
        } catch (const std::exception &) {
            client_.reset();
            state_.reset();
            if (id_) id_->close();
            throw;
        }
        persistLocked();
        log("SSK сменён корнем");
    } catch (const std::exception &e) {
        log(std::string("смена SSK не удалась: ") + e.what());
        result = "failed";
    }
    std::fill(root.begin(), root.end(), '\0');
    return result;
}

// ── эфемерные каналы: «печатает» (T127, FR-013/FR-064) ─────────────────────

void Session::ensureEphemeralLocked(const std::vector<std::string> &chats) {
    json peers = json::array(), groups = json::array();
    for (const auto &chat : chats) {
        if (chat.empty() || chat == cfg_.self) continue;
        ephChats_.insert(chat);
        if (isGroupAddress(chat)) groups.push_back(groupHex(chat));
        else peers.push_back(chat);
    }
    if (!ready_ || !client_ || (peers.empty() && groups.empty())) return;
    try {
        runRequestsLocked(client_->ephSubscribe(json{{"peers", peers}, {"groups", groups}}));
    } catch (const std::exception &e) {
        log(std::string("подписка на «печатает»: ") + e.what());
    }
}

bool Session::sendTyping(const std::string &chat) {
    const bool group = isGroupAddress(chat);
    if (!group && !isV2Peer(chat)) return false;
    try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return true; // чат v2: по v1 не понижаем
        ensureEphemeralLocked({chat});
        runRequestsLocked(client_->ephTyping(group ? groupHex(chat) : chat, kTypingTyping));
    } catch (const std::exception &e) {
        log(std::string("«печатает» не отправлено: ") + e.what());
    }
    return true;
}

// ── переходный период: v1-устройства (FR-054/FR-058) ───────────────────────

namespace {

std::string stripPadding(std::string s) {
    while (!s.empty() && s.back() == '=') s.pop_back();
    return s;
}

} // namespace

std::map<std::string, std::string> Session::legacyDevices(const std::string &user) {
    std::map<std::string, std::string> out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return out;
    const auto devices = client_->logDevices(user);
    if (!devices.contains("legacyKeys") || !devices["legacyKeys"].is_array()) return out;
    for (const auto &d : devices["legacyKeys"]) {
        if (!d.is_object()) continue;
        out[d.value("deviceId", std::string())] = d.value("identity", std::string());
    }
    return out;
}

void Session::syncLegacySet(const json &catalog) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_ || !catalog.is_array()) return;
    const auto own = client_->logDevices(cfg_.self);
    const auto v2 = own.contains("v2") && own["v2"].is_array() ? own["v2"] : json::array();
    if (v2.empty()) return;
    // Кандидаты: устройства каталога v1, которых нет в журнале v2.
    json candidates = json::array();
    for (const auto &d : catalog) {
        if (!d.is_object()) continue;
        const auto id = d.value("deviceId", std::string());
        const auto identity = stripPadding(d.value("identity", std::string()));
        const auto signing = stripPadding(d.value("signing", std::string()));
        if (id.empty() || identity.empty() || signing.empty()) continue;
        if (std::find(v2.begin(), v2.end(), json(id)) != v2.end()) continue;
        candidates.push_back(json{{"deviceId", id}, {"identity", identity}, {"signing", signing}});
    }
    json next = json::array();
    if (!own.value("legacySet", false)) {
        if (candidates.empty()) return;
        next = candidates;
    } else {
        const auto keys = own.contains("legacyKeys") && own["legacyKeys"].is_array() ? own["legacyKeys"] : json::array();
        for (const auto &k : keys) {
            const auto found = std::any_of(candidates.begin(), candidates.end(), [&](const json &d) {
                return d["deviceId"] == k.value("deviceId", std::string())
                    && d["identity"] == k.value("identity", std::string());
            });
            if (found) next.push_back(k);
        }
        if (next.size() == keys.size()) return;
    }
    try {
        runRequestsLocked(json::array({client_->legacyDevicesRequest(next)}));
        // Запись попадает в свой журнал синком — после подтверждения сервера.
        checkOwnDevicesLocked();
        log("список v1-устройств опубликован (" + std::to_string(next.size()) + ")");
    } catch (const std::exception &e) {
        // Нет SSK на этом устройстве либо журнал ушёл вперёд — догонит другое.
        log(std::string("список v1-устройств не опубликован: ") + e.what());
    }
}

void Session::deliverLegacy(const std::string &messageId, const json &sendPayload) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    runRequestsLocked(json::array({client_->legacyDeliverRequest(messageId, sendPayload.dump())}));
}

template <typename F>
auto Session::withNeedsLocked(F &&f) -> decltype(f()) {
    for (int i = 0; i < kNeedAttempts; ++i) {
        try {
            return f();
        } catch (const std::exception &e) {
            if (!satisfyLocked(e)) throw;
        }
    }
    throw std::runtime_error("v2: данные не сошлись");
}

// ── события наружу ─────────────────────────────────────────────────────────

void Session::absorbLocked(std::vector<json> events) {
    for (auto &ev : events) {
        const auto type = ev.is_object() ? ev.value("type", std::string()) : std::string();
        if (type == "groupChanged") {
            const auto hex = ev.contains("group") && ev["group"].is_object()
                ? ev["group"].value("id", std::string()) : std::string();
            if (hex.empty() || syncingGroups_.count(hex)) continue;
            try {
                syncGroupLocked(hex);
            } catch (const std::exception &e) {
                log("журнал группы " + hex + " не прочитан: " + e.what());
                // Журнал больше не отдают (нас исключили/забанили, группа удалена):
                // сервер не пустит дальше — группа снимается у клиента.
                const auto *v = dynamic_cast<const V2Error *>(&e);
                if (v && (v->code() == "ERROR_CODE_FORBIDDEN" || v->code() == "ERROR_CODE_NOT_FOUND")) {
                    const auto address = groupAddress(hex);
                    client_->groupForget(hex);
                    persistLocked();
                    if (publishedGroups_.erase(address)) {
                        outbox_.push_back(json{{"type", "groupLeft"}, {"address", address}});
                    }
                }
            }
            continue;
        }
        if (type == "deviceAdded" || type == "deviceRevoked") {
            // Отзыв делает другое своё устройство (оно же раздаёт новые ключи) —
            // здесь только свой журнал заново.
            try {
                checkOwnDevicesLocked();
            } catch (const std::exception &e) {
                log(std::string("журнал своих устройств: ") + e.what());
            }
            if (type == "deviceRevoked" && client_ && client_->ownSskExposed()) {
                outbox_.push_back(json{{"type", "sskRotationNeeded"}});
            }
            continue;
        }
        if (type == "stateKeyRotated") {
            // Своё устройство передало (новый) ключ личного состояния — журнал заново.
            state_.reset();
            pendingAppends_.clear();
            stateRekeyed_ = true;
            outbox_.push_back(json{{"type", "stateReady"}});
            continue;
        }
        if (type == "call") {
            // Сигнал звонка: отправителя и привязку к звонку проверил движок.
            const auto signal = ev.contains("signal") ? callSignalFromV2(ev["signal"]) : std::nullopt;
            if (signal) {
                outbox_.push_back(json{{"type", "callSignal"}, {"from", ev.value("from", std::string())}, {"signal", *signal}});
            }
            continue;
        }
        if (type == "internal" || type == "skipped") continue;
        // Ключ доставки собеседника / ключи эпохи могли прийти только что —
        // канал «печатает» этого чата.
        if (type == "direct") {
            ensureEphemeralLocked({ev.value("chat", std::string())});
        } else if (type == "group" && ev.contains("group") && ev["group"].is_object()) {
            ensureEphemeralLocked({groupAddress(ev["group"].value("id", std::string()))});
        }
        outbox_.push_back(std::move(ev));
    }
    // Входящая смена режима личного чата (chat_mode) уже в состоянии движка.
    noteL2StateLocked();
}

// Публичные методы зовутся с чужих потоков (UI, пул) — события отдаёт рабочий
// поток сессии, как и события инбокса: обработчик onEvent никогда не зовётся
// на потоке вызывающего (он может держать свои мьютексы).
void Session::flushAsync() {
    if (std::this_thread::get_id() == worker_.get_id()) {
        flush();
    } else {
        post([this] { flush(); });
    }
}

void Session::flush() {
    std::lock_guard<std::recursive_mutex> order(flushMu_);
    for (;;) {
        std::vector<json> batch;
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            batch.swap(outbox_);
        }
        if (batch.empty()) return;
        deliver(batch);
    }
}

// ── группы v2 ──────────────────────────────────────────────────────────────

std::vector<std::string> Session::groupMembersLocked(const std::string &hex) {
    std::vector<std::string> out;
    if (!client_) return out;
    if (const auto g = client_->groupInfo(hex); g && g->contains("members") && (*g)["members"].is_array()) {
        for (const auto &m : (*g)["members"]) out.push_back(m.value("user", std::string()));
    }
    return out;
}

void Session::syncGroupLocked(const std::string &hex, const std::string &linkId) {
    if (!client_) return;
    syncingGroups_.insert(hex);
    try {
        for (int page = 0; page < kGroupSyncPages; ++page) {
            const auto before = client_->groupVersion(hex);
            json req{{"group", {{"domain", domain_}, {"id", hexToB64(hex)}}},
                     {"after_version", std::to_string(before)}};
            if (!linkId.empty()) req["invite_link_id"] = hexToB64(linkId);
            const auto resp = call(false, "group.state.sync", encodeMessage("parvane.group.v2.StateSyncRequest", req));
            withNeedsLocked([&] { return client_->groupIngest(domain_, hex, resp); });
            if (client_->groupVersion(hex) == before) break;
        }
    } catch (...) {
        syncingGroups_.erase(hex);
        throw;
    }
    syncingGroups_.erase(hex);
    // Чат группы — до отложенных сообщений (иначе они легли бы не в тот чат).
    publishGroupLocked(hex);
    std::vector<json> pending;
    const auto ready = client_->drainReady();
    if (ready.is_array()) {
        for (const auto &ev : ready) pending.push_back(ev);
    }
    absorbLocked(std::move(pending));
    persistLocked();
}

void Session::resyncGroupLocked(const std::string &hex) {
    if (!client_) return;
    client_->groupForget(hex);
    try {
        syncGroupLocked(hex);
    } catch (const std::exception &e) {
        log("журнал группы " + hex + " не перечитан: " + e.what());
    }
}

void Session::publishGroupLocked(const std::string &hex) {
    if (!client_) return;
    const auto g = client_->groupInfo(hex);
    if (!g) return;
    const auto address = groupAddress(hex);
    bool isMember = false;
    if (g->contains("members") && (*g)["members"].is_array()) {
        for (const auto &m : (*g)["members"]) {
            if (m.value("user", std::string()) == cfg_.self) isMember = true;
        }
    }
    if (!isMember || g->value("deleted", false)) {
        if (publishedGroups_.erase(address)) {
            outbox_.push_back(json{{"type", "groupLeft"}, {"address", address}});
        }
        return;
    }
    const bool isNew = publishedGroups_.insert(address).second;
    // Канал «печатает» выводится из ключа эпохи — после смены эпохи он новый.
    ensureEphemeralLocked({address});
    outbox_.push_back(json{{"type", "groupUpdated"}, {"address", address}, {"isNew", isNew}, {"info", *g}});
    noteGroupL2Locked(hex, *g);
    reportUnconfirmedLocked(hex, {});
    // Новую эпоху начинает владелец (или админ, сделавший изменение, — сразу).
    if (g->value("epochStale", false) && g->value("owner", std::string()) == cfg_.self) {
        scheduleRotate(hex, 0);
    }
}

// Политика L2 группы изменилась (или мы вошли в L2-группу) — событие наружу
// один раз: последнее известное значение хранится на устройстве (файл
// group-l2), иначе каждый запуск повторял бы служебное сообщение.
void Session::noteGroupL2Locked(const std::string &hex, const json &info) {
    const bool l2 = info.value("l2", false);
    auto known = json::parse(readStateFile("group-l2"), nullptr, false);
    if (!known.is_object()) known = json::object();
    const bool had = known.contains(hex) && known[hex].is_boolean();
    if (had && known[hex].get<bool>() == l2) return;
    known[hex] = l2;
    writeStateFile("group-l2", known.dump());
    noteL2StateLocked();
    if (!had && !l2) return; // новая для нас группа в обычном режиме
    outbox_.push_back(json{{"type", "groupL2"}, {"address", groupAddress(hex)}, {"enabled", l2},
                           {"by", info.value("l2By", std::string())}, {"id", newUuidV7()},
                           {"tsMs", nowMs()}});
}

// Набор чатов с активным L2 изменился — событие l2State наружу (кэш клиента).
void Session::noteL2StateLocked(bool force) {
    if (!client_) return;
    const auto active = client_->l2ActiveChats();
    auto chats = json::array();
    auto mine = json::array(); // личные чаты, где режим включён мной
    if (active.contains("direct") && active["direct"].is_array()) {
        for (const auto &p : active["direct"]) {
            if (!p.is_string()) continue;
            chats.push_back(p);
            if (client_->l2Direct(p.get<std::string>()).value("mine", false)) mine.push_back(p);
        }
    }
    if (active.contains("groups") && active["groups"].is_array()) {
        for (const auto &g : active["groups"]) {
            if (g.is_string()) chats.push_back(groupAddress(g.get<std::string>()));
        }
    }
    json ev{{"type", "l2State"}, {"chats", chats}, {"mine", mine},
            {"presenceAllowed", client_->presenceAllowed()}};
    const auto snapshot = ev.dump();
    if (!force && snapshot == l2Snapshot_) return;
    l2Snapshot_ = snapshot;
    outbox_.push_back(std::move(ev));
}

// ── приватность и режим L2 (T079) ──────────────────────────────────────────

void Session::pushPrivacyLocked() {
    if (!privacySet_ || !ready_) return;
    try {
        call(false, "identity.privacy.set",
             encodeMessage("parvane.identity.v2.PrivacySetRequest",
                           json{{"settings",
                                 {{"group_add", privacyGroupAddNobody_ ? "AUDIENCE_NOBODY" : "AUDIENCE_EVERYBODY"},
                                  {"messages_from_strangers", privacyStrangers_}}}}));
        log(std::string("приватность сохранена: незнакомые ") + (privacyStrangers_ ? "да" : "нет")
            + ", добавление в группы " + (privacyGroupAddNobody_ ? "никто" : "все"));
        privacySet_ = false; // правка на сервере; дальше источник истины — он
        outbox_.push_back(json{{"type", "privacySaved"}});
    } catch (const std::exception &e) {
        log(std::string("приватность не сохранена: ") + e.what());
        throw;
    }
}

void Session::fetchPrivacyLocked() {
    try {
        const auto got = decodeMessage(
            "parvane.identity.v2.PrivacyGetResponse",
            call(false, "identity.privacy.get",
                 encodeMessage("parvane.identity.v2.PrivacyGetRequest", json::object())));
        if (!got.is_object() || !got.value("is_set", false)) return;
        const auto settings = got.value("settings", json::object());
        privacyGroupAddNobody_ = (settings.value("group_add", std::string()) == "AUDIENCE_NOBODY");
        privacyStrangers_ = settings.value("messages_from_strangers", false);
        outbox_.push_back(json{{"type", "privacy"},
                               {"groupAddNobody", privacyGroupAddNobody_},
                               {"strangersAllowed", privacyStrangers_}});
    } catch (const std::exception &e) {
        log(std::string("приватность не прочитана: ") + e.what());
        throw;
    }
}

bool Session::setPrivacy(bool groupAddNobody, bool strangersAllowed) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    privacySet_ = true;
    privacyGroupAddNobody_ = groupAddNobody;
    privacyStrangers_ = strangersAllowed;
    if (!ready_ || !client_) return false; // уйдёт при готовности сессии
    try {
        pushPrivacyLocked();
        flushAsync();
        return true;
    } catch (const std::exception &) {
        return false;
    }
}

void Session::setDirectL2(const std::string &peer, bool enabled, const std::string &opId) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_ || isGroupAddress(peer)) throw V2Error("ERROR_CODE_UNAVAILABLE");
        const auto reqs = withNeedsLocked([&] { return client_->l2SetDirect(peer, enabled, opId); });
        // Предпочтение уже в состоянии движка — на диск до сети (как у отправки).
        persistLocked();
        runRequestsLocked(reqs);
        persistLocked();
        noteL2StateLocked();
        log(std::string("режим L2 чата ") + peer + (enabled ? ": включён" : ": выключен"));
    }
    flushAsync();
}

bool Session::setGroupL2(const std::string &address, bool enabled) {
    return changeGroup(address, json{{"set_privacy_mode", {{"l2", enabled}}}});
}

json Session::l2State(const std::string &chat) {
    static const auto idle = [] {
        return json{{"active", false}, {"mine", false}, {"enabledBy", json::array()}, {"pad", false},
                    {"ephemeralAllowed", true}};
    };
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || chat.empty()) return idle();
    return isGroupAddress(chat) ? client_->l2Group(groupHex(chat)) : client_->l2Direct(chat);
}

bool Session::ephemeralAllowed(const std::string &chat) {
    return l2State(chat).value("ephemeralAllowed", true);
}

bool Session::presenceAllowed() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return !client_ || client_->presenceAllowed();
}

void Session::reportUnconfirmedLocked(const std::string &hex, const std::vector<std::string> &claimed) {
    if (!client_) return;
    json fresh = json::array();
    for (const auto &member : client_->groupUnconfirmed(hex, claimed)) {
        if (warnedUnconfirmed_.insert(hex + ":" + member).second) fresh.push_back(member);
    }
    if (fresh.empty()) return;
    log("в группе " + hex + " участники без подтверждённой записи администратора: " + fresh.dump());
    outbox_.push_back(json{{"type", "groupUnconfirmed"}, {"address", groupAddress(hex)}, {"members", fresh}});
}

bool Session::canRotateLocked(const std::string &hex) {
    if (!client_) return false;
    const auto g = client_->groupInfo(hex);
    if (!g || g->value("deleted", false) || !g->contains("members")) return false;
    for (const auto &m : (*g)["members"]) {
        if (m.value("user", std::string()) != cfg_.self) continue;
        const auto role = m.value("role", 0);
        return role == kRoleAdmin || role == kRoleOwner;
    }
    return false;
}

// Партия жетонов не больше limit; при исчерпанной квоте аккаунта — остаток.
void Session::requestTokensLocked(std::size_t limit) {
    const auto list = call(true, "identity.tokens.key_list", std::string());
    std::vector<std::size_t> steps;
    for (const auto count : kTokenBatchSteps) {
        if (count <= limit) steps.push_back(count);
    }
    if (steps.empty()) steps.push_back(std::max<std::size_t>(1, limit));
    for (std::size_t i = 0; i < steps.size(); ++i) {
        try {
            const auto req = parseRequest(client_->tokenRequest(list, serverKey_, steps[i]));
            client_->tokenResponse(call(req.anon, req.method, req.body));
            return;
        } catch (const V2Error &e) {
            if (e.code() != "ERROR_CODE_LIMIT" || i + 1 == steps.size()) throw;
        }
    }
}

void Session::refillTokensLocked() {
    if (!client_ || serverKey_.empty() || !client_->tokenRefillDue()) return;
    try {
        requestTokensLocked(std::min(kTokenBatch, client_->tokenBatchSize()));
        persistLocked();
        log("жетоны: партия по расписанию получена (запас " + std::to_string(client_->tokenCount()) + ")");
    } catch (const std::exception &e) {
        // Срок следующей партии движок уже сдвинул — «дозапроса» не будет (D-06).
        persistLocked();
        log(std::string("жетоны: партия по расписанию не получена: ") + e.what());
    }
}

void Session::scheduleTokenCheck() {
    postDelayed(kTokenCheckMs, [this] {
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            if (ready_ && client_) refillTokensLocked();
        }
        scheduleTokenCheck();
    });
}

void Session::ensureTokensLocked(std::size_t recipients) {
    if (!client_ || serverKey_.empty() || client_->tokenCount() >= recipients + kTokenReserve) return;
    try {
        satisfyLocked(EngineError(json{{"need", {{"kind", "token"}}}}.dump()));
    } catch (const std::exception &e) {
        log(std::string("жетоны не получены: ") + e.what());
    }
}

void Session::rotateEpochLocked(const std::string &hex) {
    try {
        rotateEpochOnceLocked(hex);
    } catch (const std::exception &e) {
        // Эпоха не чаще раза в 10 с (часы движка и сервера): подождать и
        // повторить один раз — отправка сразу после бана/вступления иначе упала бы.
        if (!isRateLimited(e)) throw;
        std::this_thread::sleep_for(std::chrono::milliseconds(kEpochRetryMs));
        rotateEpochOnceLocked(hex);
    }
}

void Session::rotateEpochOnceLocked(const std::string &hex) {
    ensureTokensLocked(groupMembersLocked(hex).size());
    const auto reqs = withNeedsLocked([&] { return client_->groupRotateEpoch(hex); });
    if (!reqs.is_array() || reqs.empty()) return;
    const auto publish = parseRequest(reqs[0]);
    try {
        call(publish.anon, publish.method, publish.body);
    } catch (...) {
        resyncGroupLocked(hex);
        throw;
    }
    for (std::size_t i = 1; i < reqs.size(); ++i) {
        try {
            const auto r = parseRequest(reqs[i]);
            call(r.anon, r.method, r.body);
        } catch (const std::exception &e) {
            log(std::string("ключи эпохи не доставлены: ") + e.what());
        }
    }
    persistLocked();
    const auto g = client_->groupInfo(hex);
    log("новая эпоха группы " + hex + ": " + (g ? std::to_string(g->value("epoch", 0ull)) : std::string("?")));
}

void Session::scheduleRotate(const std::string &hex, std::int64_t delayMs, int attempt) {
    {
        std::lock_guard<std::mutex> lk(qMu_);
        if (!rotateScheduled_.insert(hex).second) return;
    }
    postDelayed(delayMs, [this, hex, attempt] {
        {
            std::lock_guard<std::mutex> lk(qMu_);
            rotateScheduled_.erase(hex);
        }
        bool retry = false;
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            if (!client_ || !ready_) return;
            const auto g = client_->groupInfo(hex);
            if (!g || !g->value("epochStale", false) || !canRotateLocked(hex)) return;
            try {
                rotateEpochLocked(hex);
                publishGroupLocked(hex);
            } catch (const std::exception &e) {
                log("новая эпоха группы " + hex + " не начата: " + e.what());
                retry = attempt < kEpochRetryAttempts;
            }
        }
        flush();
        if (retry) scheduleRotate(hex, kEpochRetryMs, attempt + 1);
    });
}

std::string Session::createGroup(const std::string &title, const std::vector<std::string> &members, bool channel) {
    if (!ready_ || !client_) return {};
    for (const auto &m : members) {
        if (!isV2Peer(m)) return {};
    }
    std::string address;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return {};
        const auto perms = channel ? json::object() : defaultGroupPermissions();
        const auto before = client_->groupList();
        const auto created = client_->groupCreate(channel ? kGroupKindChannel : kGroupKindGroup, title, members, perms);
        std::string hex;
        for (const auto &id : client_->groupList()) {
            if (std::find(before.begin(), before.end(), id) == before.end()) hex = id;
        }
        if (hex.empty() && created.contains("group")) hex = created["group"].value("id", std::string());
        const auto req = parseRequest(created.value("request", json::object()));
        try {
            call(req.anon, req.method, req.body);
        } catch (...) {
            client_->groupForget(hex);
            throw;
        }
        try {
            rotateEpochLocked(hex);
        } catch (const std::exception &e) {
            log(std::string("первая эпоха группы не начата: ") + e.what());
            scheduleRotate(hex, kEpochRetryMs);
        }
        persistLocked();
        log("группа создана " + hex + " (" + std::to_string(members.size() + 1) + " участников)");
        publishGroupLocked(hex);
        address = groupAddress(hex);
    }
    flushAsync();
    return address;
}

bool Session::changeGroup(const std::string &address, const json &change) {
    if (!ready_ || !isGroupAddress(address)) return false;
    const auto hex = groupHex(address);
    bool ok = false;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return false;
        json reqJson;
        try {
            reqJson = client_->groupChange(hex, change);
        } catch (const std::exception &e) {
            log(std::string("изменение группы отклонено движком: ") + e.what());
            return false;
        }
        try {
            const auto req = parseRequest(reqJson);
            call(req.anon, req.method, req.body);
            ok = true;
        } catch (const std::exception &e) {
            log(std::string("изменение группы отклонено сервером: ") + e.what());
            resyncGroupLocked(hex);
        }
        if (ok) {
            // Состав/права изменились — ключи прежней эпохи мог держать исключённый.
            const auto g = client_->groupInfo(hex);
            if (g && g->value("epochStale", false) && canRotateLocked(hex)) {
                try {
                    rotateEpochLocked(hex);
                } catch (const std::exception &e) {
                    log(std::string("новая эпоха после изменения не начата: ") + e.what());
                    scheduleRotate(hex, kEpochRetryMs);
                }
            }
            persistLocked();
            publishGroupLocked(hex);
        }
    }
    flushAsync();
    return ok;
}

json Session::groupInfo(const std::string &address) {
    if (!isGroupAddress(address)) return nullptr;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return nullptr;
    const auto g = client_->groupInfo(groupHex(address));
    return g ? *g : json(nullptr);
}

std::vector<std::string> Session::groupAddresses() {
    std::vector<std::string> out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return out;
    for (const auto &hex : client_->groupList()) out.push_back(groupAddress(hex));
    return out;
}

void Session::reportUnconfirmed(const std::string &address, const std::vector<std::string> &claimed) {
    if (!isGroupAddress(address)) return;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        reportUnconfirmedLocked(groupHex(address), claimed);
    }
    flushAsync();
}

// ── ссылки-приглашения v2 (D-04, T084/T125) ─────────────────────────────────

json Session::loadInvites() const {
    auto all = json::parse(readStateFile("invites"), nullptr, false);
    return all.is_object() ? all : json::object();
}

json Session::createInvite(const std::string &address, const std::string &title, std::int64_t expireDate,
                           std::uint32_t usageLimit, bool requestNeeded) {
    if (!ready_ || !isGroupAddress(address)) return nullptr;
    const auto hex = groupHex(address);
    json record;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return nullptr;
        json created;
        try {
            created = client_->groupInviteCreate(hex, title, expireDate * 1000, usageLimit, requestNeeded);
        } catch (const std::exception &e) {
            log(std::string("ссылка не создана движком: ") + e.what());
            return nullptr;
        }
        try {
            const auto req = parseRequest(created.value("request", json::object()));
            call(req.anon, req.method, req.body);
        } catch (const std::exception &e) {
            log(std::string("ссылка не принята сервером: ") + e.what());
            resyncGroupLocked(hex);
            flushAsync();
            return nullptr;
        }
        record = json{{"url", created.value("url", std::string())},
                      {"linkId", created.value("linkId", std::string())},
                      {"date", nowMs() / 1000}};
        if (!title.empty()) record["title"] = title;
        if (expireDate > 0) record["expiresAt"] = expireDate;
        if (usageLimit > 0) record["usageLimit"] = usageLimit;
        if (requestNeeded) record["isRequestNeeded"] = true;
        auto all = loadInvites();
        if (!all.contains(address) || !all[address].is_array()) all[address] = json::array();
        all[address].push_back(record);
        writeStateFile("invites", all.dump());
        persistLocked();
        publishGroupLocked(hex);
    }
    flushAsync();
    return record;
}

json Session::listInvites(const std::string &address) {
    json out = json::array();
    if (!isGroupAddress(address)) return out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return out;
    std::set<std::string> active;
    if (const auto g = client_->groupInfo(groupHex(address)); g && g->contains("inviteLinks")) {
        for (const auto &id : (*g)["inviteLinks"]) {
            if (id.is_string()) active.insert(id.get<std::string>());
        }
    }
    const auto all = loadInvites();
    if (all.contains(address) && all[address].is_array()) {
        for (const auto &r : all[address]) {
            if (active.count(r.value("linkId", std::string()))) out.push_back(r);
        }
    }
    return out;
}

bool Session::revokeInvite(const std::string &address, const std::string &url) {
    std::string linkId;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        const auto all = loadInvites();
        if (all.contains(address) && all[address].is_array()) {
            for (const auto &r : all[address]) {
                if (r.value("url", std::string()) == url) linkId = r.value("linkId", std::string());
            }
        }
    }
    if (linkId.empty()) return false;
    return changeGroup(address, json{{"invite_key_revoke", {{"link_id", hexToB64(linkId)}}}});
}

bool Session::isInviteUrl(const std::string &url) {
    if (const auto p = parseInvite(url); p && p->value("kind", std::string()) == "v2") return true;
    static const std::regex re(R"(^https://[^/\s]+/join/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$)");
    return std::regex_match(url, re);
}

namespace {

std::string inviteErrorCode(const std::exception &e) {
    const auto *v = dynamic_cast<const V2Error *>(&e);
    const std::string code = v ? v->code() : std::string(e.what());
    if (code.find("NOT_FOUND") != std::string::npos || code.find("FORBIDDEN") != std::string::npos) return "invalid";
    if (code.find("BANNED") != std::string::npos) return "banned";
    if (code.find("EXPIRED") != std::string::npos) return "expired";
    if (code.find("RATE") != std::string::npos) return "rateLimited";
    return "failed";
}

} // namespace

json Session::inviteGroupLocked(const std::string &linkIdHex) {
    const auto resp = call(false, "group.invite.check",
        encodeMessage("parvane.group.v2.InviteCheckRequest", json{{"link_id", hexToB64(linkIdHex)}}));
    return decodeMessage("parvane.group.v2.InviteCheckResponse", resp);
}

json Session::checkInvite(const std::string &url) {
    const auto parsed = parseInvite(url);
    if (!ready_ || !parsed || parsed->value("kind", std::string()) != "v2") return nullptr;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return nullptr;
    try {
        const auto check = inviteGroupLocked(parsed->value("linkId", std::string()));
        const auto hex = b64ToHex(check.contains("group") ? check["group"].value("id", std::string()) : std::string());
        bool isMember = false;
        for (const auto &m : groupMembersLocked(hex)) {
            if (m == cfg_.self) isMember = true;
        }
        const auto members = check.value("members", json(0));
        return json{{"address", groupAddress(hex)},
                    {"name", check.value("name", std::string())},
                    {"membersCount", members.is_number() ? members.get<std::int64_t>() : 0},
                    {"isRequestNeeded", check.value("requires_approval", false)},
                    {"isChannel", check.value("kind", std::string()) == "GROUP_KIND_CHANNEL"},
                    {"isMember", isMember}};
    } catch (const std::exception &e) {
        log(std::string("проверка ссылки: ") + e.what());
        return json{{"error", inviteErrorCode(e)}};
    }
}

json Session::joinByInvite(const std::string &url) {
    const auto parsed = parseInvite(url);
    if (!ready_ || !parsed || parsed->value("kind", std::string()) != "v2") return nullptr;
    json result;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return nullptr;
        try {
            const auto linkId = parsed->value("linkId", std::string());
            const auto check = inviteGroupLocked(linkId);
            const auto hex = b64ToHex(check.contains("group") ? check["group"].value("id", std::string()) : std::string());
            if (hex.empty()) throw V2Error("ERROR_CODE_NOT_FOUND");
            syncGroupLocked(hex, linkId);
            const auto req = parseRequest(client_->groupJoin(url));
            std::string resp;
            try {
                resp = call(req.anon, req.method, req.body);
            } catch (...) {
                resyncGroupLocked(hex);
                throw;
            }
            const auto join = decodeMessage("parvane.group.v2.JoinResponse", resp);
            if (join.value("pending", false)) {
                client_->groupForget(hex);
                result = json{{"status", "requested"}};
            } else {
                persistLocked();
                log("вступление в группу " + hex + " по ссылке");
                // Журнал уже с нашей записью вступления — дочитать и показать.
                syncGroupLocked(hex);
                result = json{{"status", "ok"}, {"address", groupAddress(hex)}};
            }
        } catch (const std::exception &e) {
            log(std::string("вступление по ссылке не удалось: ") + e.what());
            result = json{{"status", "error"}, {"code", inviteErrorCode(e)}};
        }
    }
    flushAsync();
    return result;
}

// ── свои устройства (T119) ─────────────────────────────────────────────────
// Свой журнал устройств — источник истины; живое событие deviceAdded лишь
// ускоряет проверку; устройство, бывшее офлайн, узнаёт при следующем запуске.
void Session::checkOwnDevicesLocked() {
    if (!client_) return;
    const auto resp = call(false, "identity.device.log_sync",
        encodeMessage("parvane.identity.v2.DeviceLogSyncRequest",
                      json{{"user", {{"address", cfg_.self}}},
                           {"after_version", std::to_string(client_->logVersion(cfg_.self))}}));
    if (client_->ingestLog(cfg_.self, resp) == "replaced") {
        dropIdentityLocked();
        return;
    }
    const auto devices = client_->logDevices(cfg_.self);
    const auto current = devices.contains("v2") ? devices["v2"] : json::array();
    const auto known = json::parse(readStateFile("own-devices"), nullptr, false);
    writeStateFile("own-devices", current.dump());
    persistLocked();
    // Первая проверка на этом устройстве — запоминаем, не уведомляем.
    if (!known.is_array()) return;
    json added = json::array();
    for (const auto &id : current) {
        if (!id.is_string() || id.get<std::string>() == deviceId_) continue;
        if (std::find(known.begin(), known.end(), id) == known.end()) added.push_back(id);
    }
    if (added.empty()) return;
    log("новые свои устройства: " + added.dump());
    outbox_.push_back(json{{"type", "ownDevicesAdded"}, {"devices", added}});
    // T142: грант линковки несёт только ключи устройства — группы v2 новому
    // своему устройству пересылает то, что в них уже состоит (ключи текущей
    // эпохи и входящие сессии Megolm участников).
    try {
        const auto reqs = withNeedsLocked([&] { return client_->shareGroupsWithOwnDevices(added); });
        runRequestsLocked(reqs);
        persistLocked();
        if (!reqs.empty()) log("группы пересланы новому своему устройству (записей " + std::to_string(reqs.size()) + ")");
    } catch (const std::exception &e) {
        log(std::string("группы новому своему устройству не пересланы: ") + e.what());
    }
}

// ── журнал личного состояния (T098) ────────────────────────────────────────

bool Session::openStateLocked() {
    if (state_) return true;
    if (!client_ || !ready_) return false;
    state_ = StateSession::open(*client_);
    return state_ != nullptr;
}

bool Session::pullStateLocked() {
    std::int64_t applied = 0;
    for (int page = 0; page < kStateSyncPages; ++page) {
        const auto resp = call(false, "state.sync", state_->syncRequest());
        const auto r = state_->ingest(resp);
        applied += r.value("applied", 0);
        if (!r.value("more", false)) break;
    }
    return applied > 0;
}

void Session::pushAppendsLocked() {
    while (!pendingAppends_.empty()) {
        call(false, "state.append", pendingAppends_.front());
        pendingAppends_.pop_front();
    }
}

bool Session::stateAvailable() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return client_ && client_->hasStateKey();
}

json Session::stateAttach(const json &local) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    state_.reset();
    pendingAppends_.clear();
    if (!openStateLocked()) {
        log("журнал состояния недоступен — нет ключа личного состояния");
        return nullptr;
    }
    const bool readable = pullStateLocked();
    if (stateRekeyed_ && !readable) {
        // Ключ состояния сменён, записей под новым ключом ещё нет: пустой снимок
        // стёр бы папки и блок-лист у хоста — переносим состояние под новый ключ.
        const auto carry = stateCarry_ ? *stateCarry_ : (local.is_object() ? local : json::object());
        const auto bodies = state_->migrate(carry);
        for (const auto &b : bodies) pendingAppends_.push_back(b);
        pushAppendsLocked();
        log("журнал состояния перенесён под новый ключ (" + std::to_string(bodies.size()) + " записей)");
    }
    stateRekeyed_ = false;
    stateCarry_.reset();
    if (readStateFile("state-migrated").empty()) {
        // Первый запуск на v2: локальные данные — начальными записями журнала.
        const auto bodies = state_->migrate(local.is_object() ? local : json::object());
        for (const auto &b : bodies) pendingAppends_.push_back(b);
        pushAppendsLocked();
        writeStateFile("state-migrated", "1");
        log("локальное состояние перенесено в журнал (" + std::to_string(bodies.size()) + " записей)");
    }
    log("журнал состояния подключён");
    return state_->snapshot();
}

json Session::stateSync(const json &desired, const std::vector<std::string> &kinds) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return nullptr;
    if (desired.is_object() && !kinds.empty()) {
        // Желаемое = сведённое + поля управляемых видов хоста; время блокировки
        // и чужие списки закрепа сохраняются (как web buildDesired).
        const auto current = state_->snapshot();
        json full = current;
        for (auto it = desired.begin(); it != desired.end(); ++it) full[it.key()] = it.value();
        if (full.contains("blocked") && full["blocked"].is_array()) {
            std::map<std::string, json> at;
            if (current.contains("blocked") && current["blocked"].is_array()) {
                for (const auto &b : current["blocked"]) {
                    at[peerKey(b.value("peer", json()))] = b.value("blocked_at_ms", json(nullptr));
                }
            }
            for (auto &b : full["blocked"]) {
                if (b.contains("blocked_at_ms") && !b["blocked_at_ms"].is_null()) continue;
                const auto hit = at.find(peerKey(b.value("peer", json())));
                b["blocked_at_ms"] = (hit != at.end() && !hit->second.is_null()) ? hit->second : json(std::to_string(nowMs()));
            }
        }
        if (desired.contains("pinned") && current.contains("pinned") && current["pinned"].is_array()) {
            for (const auto &p : current["pinned"]) {
                if (!isMainPinList(p.value("list", json()))) full["pinned"].push_back(p);
            }
        }
        const auto bodies = state_->diff(full, kinds);
        for (const auto &b : bodies) pendingAppends_.push_back(b);
    }
    // Своя правка — сначала в журнал, затем чужие записи (иначе снимок откатит её).
    pushAppendsLocked();
    const bool changed = pullStateLocked();
    return json{{"changed", changed}, {"snapshot", state_->snapshot()}};
}

bool Session::stateScheduledSent(const std::string &opIdB64) {
    const auto r = stateSync(json(), {});
    if (!r.is_object()) return false;
    const auto &snap = r["snapshot"];
    if (!snap.contains("scheduled_sent") || !snap["scheduled_sent"].is_array()) return false;
    for (const auto &id : snap["scheduled_sent"]) {
        if (id.is_string() && id.get<std::string>() == opIdB64) return true;
    }
    return false;
}

void Session::stateMarkSent(const std::string &opIdB64) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return;
    try {
        for (const auto &b : state_->markSent(opIdB64)) pendingAppends_.push_back(b);
        pushAppendsLocked();
    } catch (const std::exception &e) {
        log(std::string("отметка отправки отложенного: ") + e.what());
    }
}

} // namespace parvane::v2
