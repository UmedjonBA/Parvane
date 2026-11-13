// Parvane fork: клиентская сессия протокола v2 (см. v2_session.h).
#include "parvane/v2_session.h"

#include "parvane/blobcrypt.h"
#include "parvane/crypto.h"
#include "parvane/engine_host.h"
#include "parvane/engine_store.h"
#include "parvane/history_sync.h"
#include "parvane/keybundle.h"
#include "parvane/l2_ticker.h"
#include "parvane/storecrypt.h"
#include "parvane/v2_content.h"
#include "parvane/v2_control.h"
#include "parvane/v2_engine.h"
#include "parvane/test_counters.h"
#include "parvane/v2_link.h"
#include "parvane/state_model.h"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <sys/stat.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <regex>
#include <utility>

namespace parvane::v2 {

namespace {

constexpr auto kPeerPositiveTtl = std::chrono::seconds(15); // журнал устройств собеседника перечитывается
constexpr auto kPeerNegativeTtl = std::chrono::seconds(30);
constexpr int kNeedAttempts = 6;
// parvane.msg.v2.TypingAction
constexpr int kTypingTyping = 1;
constexpr int kTypingCancel = 2;
constexpr int kGroupSyncPages = 50;
// Смена эпохи — не чаще раза в 10 с (R8): повтор после отказа по частоте.
constexpr std::int64_t kEpochRetryMs = 11000;
// Проверка расписания партии жетонов (FR-063): срок задаёт движок, здесь — шаг.
constexpr std::int64_t kTokenCheckMs = 60 * 60 * 1000;
// Ключ личного состояния сменён другим устройством, его записей ещё нет: повтор подключения журнала
constexpr std::int64_t kStateRekeyRetryMs = 8000;
constexpr int kStateRekeyRetries = 15;
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
// Потолок кругов «запрос модели → ответ → новые запросы» одного шага и шагов переноса (spec 035)
constexpr int kModelRounds = 512;
constexpr int kUnavailableCode = 11;

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

// ── spec 036 T031: файлы каталога состояния — в хранилище движка (`HostFiles`, вид host-file) ─────────────────
// Каталог `<stateDir>/host`, ключ устройства — ключ storecrypt (тот же секрет ОС). Прежний файл storecrypt
// переносится при первом обращении к нему (отметка, сверка, `.migrated`); не перенёсся — работа с прежним файлом,
// как раньше (данные не теряются). Включает хост (`Session::useHostFiles`): desktop и android (spec 036 T036).
std::atomic<bool> g_hostFilesOn{false};
std::mutex g_hostFilesMu;
struct HostFilesDir {
    std::unique_ptr<engine_store::HostFiles> files;
    std::set<std::string> checked; // имена, для которых перенос уже решён в этом процессе
    std::set<std::string> legacy;  // перенос не удался — прежний файл
};
std::map<std::string, HostFilesDir> g_hostFiles;
std::function<void(const std::string &)> g_hostFilesLog;

// Хранилище файлов каталога и решение по имени: nullptr — работать с прежним файлом storecrypt.
engine_store::HostFiles *hostFilesFor(const std::string &stateDir, const std::string &name) {
    if (!g_hostFilesOn || stateDir.empty() || name.empty()) return nullptr;
    const auto key = storecrypt::currentKey();
    if (key.size() != 32) return nullptr;
    std::lock_guard<std::mutex> lk(g_hostFilesMu);
    auto &d = g_hostFiles[stateDir];
    const auto dir = stateDir + "/host";
    // Каталог стёрт (выход) или переехал (смена ника, выход устройства) — открыть заново
    if (d.files && !std::filesystem::exists(dir)) d = HostFilesDir{};
    if (!d.files) {
        mkdirs(stateDir);
        std::string err;
        d.files = engine_store::HostFiles::open(dir, key, &err);
        if (!d.files) {
            if (g_hostFilesLog) g_hostFilesLog("файлы хоста не открылись (прежние файлы): " + err);
            return nullptr;
        }
    }
    if (!d.checked.count(name)) {
        d.checked.insert(name);
        std::string err;
        using M = engine_store::HostFiles::Moved;
        switch (d.files->migrateFrom(name, stateDir + "/" + name, &err)) {
        case M::Moved:
            if (g_hostFilesLog) g_hostFilesLog("файл " + name + " перенесён в хранилище движка");
            break;
        case M::Quarantined:
            if (g_hostFilesLog) g_hostFilesLog("файл " + name + " не открылся — в карантине хранилища");
            break;
        case M::Failed:
            d.legacy.insert(name);
            if (g_hostFilesLog) g_hostFilesLog("файл " + name + " не перенесён (" + err + ") — прежний файл");
            break;
        default:
            break;
        }
    }
    return d.legacy.count(name) ? nullptr : d.files.get();
}

std::string readStateFileAt(const std::string &stateDir, const std::string &name) {
    if (auto *h = hostFilesFor(stateDir, name)) {
        const auto v = h->read(name);
        return v ? *v : std::string();
    }
    return storecrypt::readFile(stateDir + "/" + name);
}

bool writeStateFileAt(const std::string &stateDir, const std::string &name, const std::string &data) {
    if (auto *h = hostFilesFor(stateDir, name)) {
        if (storecrypt::writesBlocked()) return false; // ограда выхода (NAT-16)
        return h->write(name, data);
    }
    return storecrypt::writeFile(stateDir + "/" + name, data);
}

void removeStateFileAt(const std::string &stateDir, const std::string &name) {
    if (auto *h = hostFilesFor(stateDir, name)) h->remove(name);
    std::remove((stateDir + "/" + name).c_str());
}

} // namespace

void Session::useHostFiles(bool on, std::function<void(const std::string &)> log) {
    std::lock_guard<std::mutex> lk(g_hostFilesMu);
    g_hostFilesOn = on;
    g_hostFilesLog = std::move(log);
}

std::string Session::readStateFileIn(const std::string &stateDir, const std::string &name) {
    return readStateFileAt(stateDir, name);
}

bool Session::writeStateFileIn(const std::string &stateDir, const std::string &name, const std::string &data) {
    mkdirs(stateDir);
    return writeStateFileAt(stateDir, name, data);
}

void Session::removeStateFileIn(const std::string &stateDir, const std::string &name) {
    removeStateFileAt(stateDir, name);
}

std::string Session::deviceIdFor(const std::string &stateDir) {
    // Состояние движка уже есть — его устройство (запись `device` ставит сессия)
    if (const auto saved = readStateFileAt(stateDir, "device"); !saved.empty()) return saved;
    if (const auto id = readStateFileAt(stateDir, "device-id"); !id.empty()) return id;
    mkdirs(stateDir);
    const auto id = newUuidV7();
    if (!writeStateFileAt(stateDir, "device-id", id)) throw std::runtime_error("v2: id устройства не записан");
    return id;
}

json Session::sessionProofFor(const std::string &stateDir, std::int64_t tsMs) {
    const auto key = readStateFileAt(stateDir, "key");
    if (key.size() != 32) return nullptr;
    try {
        // Модель профиля (spec 035): клиент — в её хранилище; открывается только существующий профиль (без корня
        // хранилища модель создала бы новый)
        const auto storeDir = stateDir + "/store";
        if (std::filesystem::exists(storeDir)) {
            std::string err;
            auto st = store_fs::Store::open(storeDir, store_fs::posixFs(), &err);
            if (st && !st->read(store_fs::Reads{{"root"}}).empty()) {
                st.reset();
                const json cfg{{"user", "proof@local"},
                               {"device_id", readStateFileAt(stateDir, "device")},
                               {"domain", "local"},
                               {"now_ms", std::to_string(tsMs)},
                               {"device_key", toBase64(key)},
                               {"host_driven", true}};
                auto host = engine::Host::open(cfg, storeDir, &err);
                if (host) {
                    Client c(std::shared_ptr<engine::Host>(std::move(host)));
                    if (c.logVersion(c.call("selfAddress").get<std::string>()) > 0) {
                        return json{{"proof", c.call("sessionProof", json{{"tsMs", tsMs}})}, {"tsMs", tsMs}};
                    }
                }
            }
        }
        return nullptr;
    } catch (const std::exception &) {
        // Состояние не читается — вход как с нового устройства (сервер решит сам)
        return nullptr;
    }
}

Session::Session(SessionConfig cfg)
: cfg_(std::move(cfg)), backoff_(cfg_.reconnectBaseMs, cfg_.reconnectMaxMs) {}

Session::~Session() { stop(); }

std::shared_ptr<Connection> Session::idConnection() const {
    std::lock_guard<std::mutex> lk(idMu_);
    return id_;
}

std::string Session::domainNow() const {
    std::lock_guard<std::mutex> lk(idMu_);
    return domain_;
}

void Session::log(const std::string &m) const {
    if (cfg_.log) cfg_.log("v2: " + m);
}

std::string Session::readStateFile(const std::string &name) const {
    return readStateFileAt(cfg_.stateDir, name);
}

bool Session::writeStateFile(const std::string &name, const std::string &data) const {
    return writeStateFileAt(cfg_.stateDir, name, data);
}

void Session::removeStateFile(const std::string &name) const {
    removeStateFileAt(cfg_.stateDir, name);
}

// ── рабочий поток ──────────────────────────────────────────────────────────

void Session::start() {
    if (worker_.joinable()) return;
    stopping_ = false;
    if (!ticker_) {
        ticker_ = std::make_unique<L2Ticker>(L2Ticker::Deps{
            [this] { return l2Active_.load(); },
            [this](const std::string &method, const std::string &body, const std::string &dest) { return tickSend(method, body, dest); },
            [this] { return takeCover(); },
            [this](const std::string &m) { log(m); }});
    }
    ticker_->start();
    if (!watchdog_) {
        watchdog_ = std::make_unique<QueueWatchdog>(QueueWatchdog::Deps{
            [this](const std::string &, std::int64_t elapsedMs) {
                log("сторож очереди: задача рабочего потока идёт уже " + std::to_string(elapsedMs / 1000)
                    + " с — очередь сессии стоит");
            },
            cfg_.queueWatchdogMs});
    }
    watchdog_->start();
    worker_ = std::thread(&Session::workerLoop, this);
    post([this] { connectOnce(); });
}

void Session::stop() {
    // Такты — первыми: ждущие отправки записи уходят сразу
    l2Active_ = false;
    if (ticker_) ticker_->stop();
    {
        std::lock_guard<std::mutex> lk(tickMu_);
        for (auto &[id, c] : tickConns_) {
            if (c) c->close();
        }
        tickConns_.clear();
    }
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
    if (watchdog_) watchdog_->stop();
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    ready_ = false;
    std::shared_ptr<Connection> id;
    {
        std::lock_guard<std::mutex> idLock(idMu_);
        id = std::move(id_);
    }
    if (id) id->close(); // запрос с другого потока держит свою копию и получит UNAVAILABLE
    closeAllAnon();
    state_.reset();
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
        if (watchdog_) watchdog_->begin();
        try {
            t();
        } catch (const std::exception &e) {
            log(std::string("ошибка задачи: ") + e.what());
        }
        if (watchdog_) watchdog_->end();
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
    std::int64_t delayMs = 0;
    int attempt = 0;
    {
        std::lock_guard<std::mutex> lk(qMu_);
        if (reconnectScheduled_) return;
        reconnectScheduled_ = true;
        reconnectNow_ = false;
        delayMs = backoff_.next();
        attempt = backoff_.attempts();
    }
    log("соединение ID закрыто — переподключение через " + std::to_string(delayMs) + " мс (попытка "
        + std::to_string(attempt) + ")");
    post([this, delayMs] {
        // Пауза отката с выходом по stop() и reconnectNow().
        {
            std::unique_lock<std::mutex> lk(qMu_);
            qCv_.wait_for(lk, std::chrono::milliseconds(delayMs),
                          [&] { return stopping_.load() || reconnectNow_; });
            reconnectNow_ = false;
            reconnectScheduled_ = false;
        }
        if (!stopping_) connectOnce();
    });
}

void Session::reconnectNow() {
    {
        std::lock_guard<std::mutex> lk(qMu_);
        if (!reconnectScheduled_) return;
        reconnectNow_ = true;
    }
    qCv_.notify_all();
}

int Session::reconnectAttempts() {
    std::lock_guard<std::mutex> lk(qMu_);
    return backoff_.attempts();
}

void Session::connectOnce() {
    if (stopping_) return;
    if (needsLinking_) {
        // Устройство ждёт привязки, а соединение ID оборвалось (смена сети, сон телефона): без него не работают ни
        // ответ боту, ни ключ руками — переоткрываем его (состояние «нужна привязка» connectLocked выставит заново)
        bool isOpen = false;
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            if (id_ && id_->isOpen()) return;
            std::string error;
            (void)connectLocked(&error);
            isOpen = id_ && id_->isOpen();
            if (!isOpen) log("переподключение до привязки не удалось: " + error);
        }
        if (!isOpen && !stopping_) onIdClosed();
        return;
    }
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
            std::lock_guard<std::mutex> lk(qMu_);
            backoff_.reset();
        }
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
                // spec 036: журнал истории ведёт модель — ключ состояния есть (в т.ч. только что привязанное устройство):
                // догнать журнал сейчас, не ждать опроса
                if (cfg_.engineRows && host_) {
                    driveLocked(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "journal.history"}}));
                }
                try {
                    checkOwnDevicesLocked();
                } catch (const std::exception &e) {
                    log(std::string("журнал своих устройств: ") + e.what());
                }
                // Копия корня и ключ восстановления — на сервер и в Telegram, копия ключей аккаунта по таймеру
                startRecoveryUpkeepLocked();
                renameGroupsPending();
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
    if (error.find("ERROR_CODE_REVOKED") != std::string::npos) {
        // Сервер не принял JWT (истёк, отозван, подменён). Без соединения v1 это
        // единственное место, где отказ виден (E6-1): повторять тем же токеном
        // бессмысленно — хост снимает учётные данные и показывает экран входа.
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            outbox_.push_back(json{{"type", "authRejected"}});
        }
        flush();
        return;
    }
    onIdClosed();
}

std::string Session::linkChallengeWrap(const std::string &deviceId, const std::string &commitment,
                                       const std::string &challengePub, const std::string &secret) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return {};
    try {
        const auto r = client_->call("linkChallengeWrap", json{{"deviceId", deviceId}, {"commitment", commitment},
                                                               {"challengePub", challengePub},
                                                               {"secret", toBase64(secret)}});
        return r.is_string() ? r.get<std::string>() : std::string();
    } catch (const std::exception &) {
        return {};
    }
}

std::string Session::linkChallengeUnwrap(const std::string &deviceId, const std::string &commitment,
                                         const std::string &challengePub, const std::string &wrapB64) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_ || wrapB64.empty()) return {};
    try {
        const auto r = client_->call("linkChallengeUnwrap", json{{"deviceId", deviceId}, {"commitment", commitment},
                                                                 {"challengePub", challengePub}, {"wrap", wrapB64}});
        return r.is_string() ? fromBase64(r.get<std::string>()) : std::string();
    } catch (const std::exception &) {
        return {};
    }
}

std::string Session::linkGrantMaterial() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return {};
    try {
        // Грант несёт журнал устройств: если другое своё устройство только что вышло само, без перечитки
        // новое записалось бы поверх его записи (отказ)
        checkOwnDevicesLocked();
    } catch (const std::exception &e) {
        log(std::string("журнал своих устройств: ") + e.what());
    }
    // Ключ копии ключей аккаунта (поле `bk`) и копия корня под ключом восстановления (поле `rb`): привязанное
    // устройство сможет обновлять копию и сменить SSK после отзыва другого (D-12)
    const auto material = buildGrantMaterialLocked();
    if (material.empty()) log("грант линковки недоступен");
    return material;
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
        std::shared_ptr<Connection> previous;
        {
            std::lock_guard<std::mutex> idLock(idMu_);
            previous = std::exchange(id_, std::make_shared<Connection>(cfg_.gatewayUrl));
        }
        if (previous) previous->close();
        const auto welcome = id_->open(kChannelIdentified, cfg_.clientVersion);
        const auto desc = verifyServerDescriptor(welcome.serverDescriptor);
        {
            std::lock_guard<std::mutex> idLock(idMu_);
            domain_ = desc.value("domain", std::string());
        }
        serverKey_ = hexToBytes(desc.value("serverKey", std::string()));
        const auto token = cfg_.token ? cfg_.token() : std::string();
        if (token.empty()) throw std::runtime_error("нет JWT");
        const auto auth = id_->auth(token);
        deviceId_ = auth.deviceId;
        id_->setEventHandler([this](const Event &ev) {
            if (ev.kind == "inbox.record") {
                // Запись — в свою очередь, разбор — рабочим потоком. Очередь отдельная от
                // задач: рабочий поток, ждущий встречный ключ звонка (acquirePeerKey), разбирает
                // записи сам, не дожидаясь своей же задачи (T185).
                {
                    std::lock_guard<std::mutex> lk(recordsMu_);
                    records_.push_back(ev.body);
                }
                post([this] {
                    openPendingRecords();
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
                            if (e.value("type", std::string()) == "presence") {
                                outbox_.push_back(json{{"type", "presence"}, {"from", e.value("from", std::string())},
                                                       {"online", e.value("online", false)}});
                                continue;
                            }
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
            if (!openHostLocked(auth.deviceId, error)) return false;
            if (hostHadProfile_ && savedDevice == auth.deviceId) {
                client_ = std::make_unique<Client>(host_);
                log("состояние устройства загружено");
                // spec 026: ник сменён на другом своём устройстве — перейти на новый адрес (как web start())
                if (const auto engineSelf = client_->call("selfAddress");
                    engineSelf.is_string() && engineSelf.get<std::string>() != cfg_.self
                    && !followOwnRename(engineSelf.get<std::string>())) {
                    ready_ = false;
                    client_.reset();
                    needsLinking_ = true;
                    if (error) *error = "нужна линковка";
                    return false;
                }
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
                if (hostHadProfile_) {
                    log("сохранённое состояние другого устройства (" + savedDevice + ") — не используется");
                }
                auto c = std::make_unique<Client>(host_);
                c->replaceNew();
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
                        // Полученную копию корня устройство на сервер не пишет: она могла устареть (копию
                        // перевыпустили), а запись другой копии стирает на сервере и копию ключей аккаунта
                        writeStateFile("root-backup-sent", toBase64(backup));
                        writeStateFile("root-backup-received", toBase64(backup));
                    }
                    // Ключ копии ключей аккаунта (spec 015): и это устройство обновляет копию
                    if (const auto bk = keybundle::readGrantBundleKey(linkMaterial_); !bk.empty()) {
                        if (const auto raw = crypto::b64decode(bk); raw && raw->size() == 32) writeStateFile("bundle-key", *raw);
                    }
                    justJoined_ = true;
                    // Хост заберёт всё из копии ключей аккаунта, когда стек поднимется (событие `joined`); отметка
                    // переживает перезапуск, пока хост не подтвердит (`ackJoined`)
                    writeStateFile("joined-unacked", "1");
                    persistLocked();
                    std::fill(linkMaterial_.begin(), linkMaterial_.end(), '\0');
                    linkMaterial_.clear();
                    runRequestsLocked(requests);
                    removeStateFile("publish");
                    log("устройство привязано грантом линковки");
                }
            }
            if (!client_) {
                auto c = std::make_unique<Client>(host_);
                c->replaceNew();
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
                    sealRootEscrowLocked(root);
                } else {
                    // Корень — в личное хранилище (storecrypt).
                    writeStateFile("root", root);
                }
                std::fill(root.begin(), root.end(), '\0');
                writeStateFile("publish", created.value("requests", json::array()).dump());
                writeStateFile("device", auth.deviceId);
                persistLocked();
                runRequestsLocked(created.value("requests", json::array()));
                removeStateFile("publish");
                if (!recoveryKey.empty()) {
                    // spec 015: ключ — владельцу в Telegram (окном — если туда не ушёл), копия ключей аккаунта
                    rememberBundleKeyLocked(recoveryKey);
                    queueRecoveryKeyLocked(recoveryKey);
                }
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
            removeStateFile("publish");
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

std::string Session::callAnon(const std::string &method, const std::string &body, const std::string &dest,
                              std::int64_t timeoutMs) {
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
            fresh->open(kChannelAnonymous, cfg_.clientVersion, std::min<std::int64_t>(timeoutMs, 10000));
        } catch (...) {
            anonConns_.erase(plan.conn);
            planner_->closed(plan.conn);
            throw;
        }
        c = fresh.get();
        anonConns_[plan.conn] = std::move(fresh);
    }
    try {
        auto resp = c->request(method, body, timeoutMs, dest);
        if (plan.closeAfter) closeAnon(plan.conn);
        return resp;
    } catch (...) {
        if (plan.closeAfter || !c->isOpen()) closeAnon(plan.conn);
        throw;
    }
}

std::string Session::destOfUser(const std::string &user) const {
    const auto at = user.rfind('@');
    if (at == std::string::npos) return {};
    auto d = user.substr(at + 1);
    std::transform(d.begin(), d.end(), d.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return d == domainNow() || d.empty() ? std::string() : d;
}

std::string Session::groupDomainLocked(const std::string &hex) {
    if (!client_ || hex.empty()) return domain_;
    // Группа другого сервера по ссылке, журнал которой ещё не принят
    if (const auto it = inviteDomains_.find(hex); it != inviteDomains_.end() && client_->groupVersion(hex) == 0) {
        return it->second;
    }
    try {
        const auto d = client_->call("groupDomain", json{{"group", hex}});
        if (d.is_string() && !d.get<std::string>().empty()) return d.get<std::string>();
    } catch (const std::exception &) {
    }
    return domain_;
}

std::string Session::groupDestLocked(const std::string &hex) {
    const auto d = groupDomainLocked(hex);
    return d == domain_ ? std::string() : d;
}

// Режим L2 (spec 025): кадры такта одной длины — личное, групповое, пустышка и адресаты неотличимы
namespace {
constexpr std::uint32_t kL2FramePad = 1024;
constexpr std::int64_t kL2PeerRefreshMs = 60000;
constexpr std::size_t kCoverPool = 3;
} // namespace

std::string Session::tickSend(const std::string &method, const std::string &body, const std::string &dest) {
    std::lock_guard<std::mutex> lk(tickMu_);
    if (!tickPlanner_) tickPlanner_ = std::make_unique<AnonPlanner>();
    const auto now = nowMs();
    for (const auto id : tickPlanner_->expired(now)) {
        if (const auto it = tickConns_.find(id); it != tickConns_.end()) {
            if (it->second) it->second->close();
            tickConns_.erase(it);
        }
        tickPlanner_->closed(id);
    }
    const auto plan = tickPlanner_->assign(method, body, now);
    Connection *c = nullptr;
    if (const auto it = tickConns_.find(plan.conn); it != tickConns_.end()) c = it->second.get();
    if (plan.open || !c || !c->isOpen()) {
        if (c) c->close();
        auto fresh = std::make_unique<Connection>(cfg_.gatewayUrl);
        fresh->open(kChannelAnonymous, cfg_.clientVersion);
        c = fresh.get();
        tickConns_[plan.conn] = std::move(fresh);
    }
    try {
        auto resp = c->request(method, body, 15000, dest, l2Active_ ? kL2FramePad : 0);
        if (plan.closeAfter) {
            c->close();
            tickConns_.erase(plan.conn);
            tickPlanner_->closed(plan.conn);
        }
        return resp;
    } catch (...) {
        if (plan.closeAfter || !c->isOpen()) {
            c->close();
            tickConns_.erase(plan.conn);
            tickPlanner_->closed(plan.conn);
        }
        throw;
    }
}

// Пустышка себе на пустой такт: запас готовится, когда движок свободен (вызывающий submit может держать его)
std::optional<std::pair<std::string, std::string>> Session::takeCover() {
    std::unique_lock<std::recursive_mutex> engine(engineMu_, std::try_to_lock);
    if (engine.owns_lock() && client_ && ready_) {
        std::lock_guard<std::mutex> lk(coverMu_);
        while (covers_.size() < kCoverPool) {
            try {
                const auto req = parseRequest(client_->call("prepareCover"));
                covers_.emplace_back(req.method, req.body);
            } catch (const std::exception &) {
                break;
            }
        }
    }
    std::lock_guard<std::mutex> lk(coverMu_);
    if (covers_.empty()) return std::nullopt;
    auto cover = covers_.front();
    covers_.pop_front();
    return cover;
}

// В L2 журналы всех собеседников перечитываются разом и по таймеру: по запросам не видно, чей чат открыт
void Session::scheduleL2PeerRefresh() {
    postDelayed(kL2PeerRefreshMs, [this] {
        if (!l2Active_) {
            l2PeerRefreshScheduled_ = false;
            return;
        }
        std::vector<std::string> known;
        {
            std::lock_guard<std::mutex> lk(peersMu_);
            for (const auto &[address, info] : peers_) {
                if (info.v2) known.push_back(address);
            }
        }
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            for (const auto &address : known) {
                try {
                    satisfyLocked(EngineError(json{{"need", {{"kind", "peerLog"}, {"user", address}}}}.dump()));
                } catch (const std::exception &) {
                }
            }
            persistLocked();
        }
        flush();
        scheduleL2PeerRefresh();
    });
}

std::string Session::call(bool anon, const std::string &method, const std::string &body, const std::string &destIn) {
    // Свой домен — обычный запрос (gateway обслуживает его и с dest, но без лишнего поля в кадре)
    const auto dest = destIn == domainNow() ? std::string() : destIn;
    // Режим L2: доставка записей — тактами
    if (anon && ticker_ && l2Active_ && L2Ticker::isTicked(method)) return ticker_->submit(method, body, dest);
    // Чтения identity (журналы, бандлы, жетоны) при кратком UNAVAILABLE сервера
    // (identity v2: «database is locked» под одновременной нагрузкой) — повтор,
    // иначе отправка падала целиком (verify_protocol_v2.sh, 29 сен 2026).
    const bool retriable = method.rfind("identity.", 0) == 0;
    for (int attempt = 0;; ++attempt) {
        try {
            if (anon) return callAnon(method, body, dest);
            // Копия: uploadBlob зовёт без engineMu_, а переподключение и stop() меняют id_ (NAT-07)
            const auto c = idConnection();
            if (!c || !c->isOpen()) throw V2Error("ERROR_CODE_UNAVAILABLE");
            return c->request(method, body, 15000, dest);
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
        call(req.anon, req.method, req.body, req.dest);
    }
}

// spec 035 T125: состояние клиента — в хранилище модели; сохранение — шаг `flush` (пачка только изменённого,
// fsync раньше запросов), без полного экспорта хостом.
void Session::persistLocked() {
    if (!host_) return;
    driveLocked(host_->step("flush", json::object()));
}

// Модель профиля (spec 035): каталог `store/` в каталоге состояния, ключ устройства — ключ состояния `key` (тот же
// 32-байтовый ключ, что прежде шифровал экспорт). Состояние другого устройства — в сторону (`store-<устройство>-<мс>`),
// прежнее состояние этого устройства (`state` без отметки «перенесено») — разовым переносом.
bool Session::openHostLocked(const std::string &deviceId, std::string *error, bool offline) {
    if (host_ && hostDevice_ == deviceId) return true;
    host_.reset();
    publishRowsHost(nullptr);
    hostHadProfile_ = false;
    const auto storeDir = cfg_.stateDir + "/store";
    const auto savedDevice = readStateFile("device");
    std::error_code ec;
    // Временный каталог прежней модели личного состояния (фаза 12) больше не нужен
    std::filesystem::remove_all(cfg_.stateDir + "/state-model", ec);
    if (!savedDevice.empty() && savedDevice != deviceId && std::filesystem::exists(storeDir, ec)) {
        const auto aside = cfg_.stateDir + "/store-" + savedDevice + "-" + std::to_string(nowMs());
        std::filesystem::rename(storeDir, aside, ec);
        log("хранилище модели другого устройства отложено: " + aside);
    }
    bool existed = false;
    {
        std::string err;
        if (std::filesystem::exists(storeDir, ec)) {
            auto st = store_fs::Store::open(storeDir, store_fs::posixFs(), &err);
            if (!st) {
                if (error) *error = "хранилище модели не открылось: " + err;
                return false;
            }
            existed = !st->read(store_fs::Reads{{"root"}}).empty();
        }
    }
    const json config0{{"user", cfg_.self},
                      {"device_id", deviceId},
                      {"domain", domain_},
                      {"now_ms", std::to_string(nowMs())},
                      {"device_key", toBase64(storageKey_)},
                      {"host_driven", true}};
    json config = config0;
    if (cfg_.engineRows) {
        // spec 036: строки показа в виде содержимого хоста (`MessageView.wire`), входящее и журнал истории — модель
        config["features"] = json::array({"wire_rows"});
        config["engine_rows"] = true;
        if (cfg_.historyBatchMinMs > 0) {
            config["history_batch_min_ms"] = cfg_.historyBatchMinMs;
            config["history_batch_max_ms"] = std::max(cfg_.historyBatchMinMs, cfg_.historyBatchMaxMs);
        }
    }
    std::string err;
    engine::Step opened;
    auto host = engine::Host::open(config, storeDir, &err, store_fs::posixFs(), &opened);
    if (!host) {
        if (error) *error = "модель не открылась: " + err;
        log("модель не открылась: " + err);
        return false;
    }
    host_ = std::shared_ptr<engine::Host>(std::move(host));
    hostDevice_ = deviceId;
    modelOpenState_.clear();
    noteOpenLocked(opened);
    if (offline && modelOpenState_ != "OPEN_STATE_READY") {
        // Без сети — только готовая модель: перенос (сеть) и прочее — при подключении
        host_.reset();
        hostDevice_.clear();
        if (error) *error = "модель без сети не открыта (" + modelOpenState_ + ")";
        return false;
    }
    if (modelOpenState_ == "OPEN_STATE_TOO_NEW") {
        // Хранилище записано более новой версией: писать нельзя (FR-026) — «обновите приложение»
        outbox_.push_back(json{{"type", "upgradeRequired"}, {"reason", "storeTooNew"}});
        if (error) *error = "ERROR_CODE_UPGRADE_REQUIRED";
        host_.reset();
        hostDevice_.clear();
        return false;
    }
    if (modelOpenState_ != "OPEN_STATE_READY") {
        if (error) *error = "модель не открылась (" + modelOpenState_ + ")";
        host_.reset();
        hostDevice_.clear();
        return false;
    }
    hostHadProfile_ = existed;
    // Чем открыта модель — для открытия без сети при следующем запуске (показ истории до подключения)
    if (!offline && !domain_.empty()) writeStateFile("model-open", json{{"device", deviceId}, {"domain", domain_}}.dump());
    publishRowsHost(host_);
    if (cfg_.engineRows) scheduleModelTick();
    // Запросы итога открытия (неотправленные записи личного состояния и исходящие до перезапуска) — в путь сразу.
    // Раньше итог открытия только читался (noteOpenLocked): модель считала их отправленными («в пути») и больше не
    // повторяла — правка личного состояния, сделанная без связи, не уходила никогда (spec 036, state_dirty). Без
    // связи запросы отказывают сразу, модель снимает «в пути» и повторит при подключении.
    if (!opened.requests.empty()) driveLocked(opened);
    return true;
}

void Session::publishRowsHost(std::shared_ptr<engine::Host> h) {
    std::lock_guard<std::mutex> lk(rowsHostMu_);
    rowsHost_ = std::move(h);
}

std::shared_ptr<engine::Host> Session::rowsModel() const {
    std::lock_guard<std::mutex> lk(rowsHostMu_);
    return rowsHost_;
}

bool Session::openModelOffline() {
    if (rowsModel()) return true;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (host_) return rowsModel() != nullptr;
    const auto saved = json::parse(readStateFile("model-open"), nullptr, false);
    const auto device = saved.is_object() ? saved.value("device", std::string()) : std::string();
    const auto domain = saved.is_object() ? saved.value("domain", std::string()) : std::string();
    if (device.empty() || domain.empty() || device != readStateFile("device")) return false;
    if (storageKey_.size() != 32) {
        const auto key = readStateFile("key");
        if (key.size() != 32) return false;
        storageKey_ = key;
    }
    {
        std::lock_guard<std::mutex> idLock(idMu_);
        if (domain_.empty()) domain_ = domain;
    }
    std::string err;
    if (!openHostLocked(device, &err, /*offline=*/true)) {
        log("модель без сети: " + err);
        return false;
    }
    log("модель профиля открыта без сети (строки истории до подключения)");
    return true;
}

void Session::noteOpenLocked(const engine::Step &st) {
    if (!st.open.is_object()) return;
    const auto state = st.open.value("state", json());
    if (state.is_string()) modelOpenState_ = state.get<std::string>();
}

// Итог шага модели: запросы — серверу по порядку, ответы — `ingest` (их итоги — тем же путём); события записей
// инбокса — наружу (events либо очередь outbox_), нужды клиента — добрать и повторить ждущие записи (`retry`;
// исчерпаны повторы — `skip`: запись без подтверждения, сервер отдаст её снова). Пачки уже зафиксированы шагом —
// подтверждение инбокса уходит только после них (SYNC-1, OPT-024).
bool Session::driveLocked(const engine::Step &first, std::vector<json> *events) {
    bool ok = true;
    lastDriveChangeKinds_.clear();
    std::vector<json> local;
    auto &out = events ? *events : local;
    std::deque<json> queue;
    std::vector<std::string> needs;
    std::uint64_t batches = 0;
    std::vector<json> shown; // изменения модели для показа хостом (spec 036, cfg_.modelEvents)
    auto absorb = [&](const engine::Step &st) {
        if (!st.ok()) {
            ok = false;
            log("модель: " + st.error);
        }
        noteOpenLocked(st);
        batches += st.batches;
        counters::get().persist += st.batches;
        if (cfg_.modelEvents) shown.insert(shown.end(), st.changes.begin(), st.changes.end());
        for (const auto &ch : st.changes) {
            if (ch.is_object() && !ch.empty()) lastDriveChangeKinds_.insert(ch.begin().key());
            if (ch.contains("notice") && ch["notice"].is_object()
                && ch["notice"].value("kind", std::string()) == "record_dropped") {
                log("запись инбокса отвергнута движком: " + ch["notice"].value("detail", std::string()));
            }
            if (ch.contains("notice") && ch["notice"].is_object()
                && ch["notice"].value("kind", std::string()) == "record_quiet"
                && !ch["notice"].value("detail", std::string()).empty()) {
                log("запись инбокса без событий: " + ch["notice"].value("detail", std::string()));
            }
            if (ch.contains("client_events") && ch["client_events"].is_object()) {
                const auto list = json::parse(ch["client_events"].value("json", std::string("[]")), nullptr, false);
                if (list.is_array()) {
                    for (const auto &e : list) {
                        out.push_back(e);
                        // spec 036 (`engine_rows`): строки и мутации записи модель уже применила (и поставит в журнал)
                        if (cfg_.engineRows && out.back().is_object()) out.back()["modelApplied"] = true;
                    }
                }
            }
            if (ch.contains("needs") && ch["needs"].is_object() && ch["needs"].value("kind", std::string()) == "client") {
                const auto d = ch["needs"].value("detail", std::string());
                if (!d.empty() && std::find(needs.begin(), needs.end(), d) == needs.end()) {
                    needs.push_back(d);
                    log("модель ждёт: " + d);
                }
            }
        }
        for (const auto &r : st.requests) queue.push_back(r);
    };
    absorb(first);
    for (int round = 0; round < kModelRounds; ++round) {
        if (queue.empty()) {
            if (needs.empty() || stopping_) break;
            bool all = true;
            for (const auto &d : needs) {
                const auto need = json::parse(d, nullptr, false);
                try {
                    all = satisfyLocked(EngineError(json{{"need", need}}.dump())) && all;
                } catch (const std::exception &e) {
                    log(std::string("добор данных не удался: ") + e.what());
                    all = false;
                }
            }
            needs.clear();
            const char *method = "retry";
            if (all) {
                needAttempts_ = 0;
            } else if (++needAttempts_ >= kNeedAttempts) {
                needAttempts_ = 0;
                method = "skip";
                log("запись не открыта — пропуск (сервер отдаст её снова)");
            }
            absorb(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", method}}));
            continue;
        }
        const auto r = std::move(queue.front());
        queue.pop_front();
        const auto method = r.value("method", std::string());
        int code = 0;
        std::string body;
        try {
            const bool anon = r.value("channel", std::string()) == "REQUEST_CHANNEL_ANON";
            if (method == "msg.inbox.ack") {
                statAcks_++;
                counters::get().inboxAck++;
                if (batches > 0) statPersistBeforeAck_++;
            }
            body = call(anon, method, fromBase64(r.value("body", std::string())), r.value("dest_domain", std::string()));
        } catch (const V2Error &e) {
            code = errorCodeNumber(e.code());
        } catch (const std::exception &) {
            code = kUnavailableCode;
        }
        if (code != 0) ok = false;
        absorb(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_RESPONSE"},
                                  {"method", method},
                                  {"req_id", r.contains("req_id") ? r["req_id"] : json("0")},
                                  {"body", toBase64(body)},
                                  {"error", code}}));
    }
    lastDriveBatches_ = batches;
    if (auto ev = stateview::modelEventOf(shown); !ev.is_null()) out.push_back(std::move(ev));
    if (!events && !local.empty()) absorbLocked(std::move(local));
    return ok;
}

Session::InboxStats Session::inboxStats() const {
    return InboxStats{statRecords_.load(), statPersists_.load(), statAcks_.load(), statPersistBeforeAck_.load()};
}

void Session::holdInboxForTest(bool hold) {
    inboxHeld_ = hold;
    if (!hold) {
        post([this] {
            openPendingRecords();
            flush();
        });
    }
}

std::size_t Session::pendingInboxForTest() {
    std::lock_guard<std::mutex> lk(recordsMu_);
    return records_.size();
}

bool Session::satisfyLocked(const std::exception &ex) {
    const auto *ee = dynamic_cast<const EngineError *>(&ex);
    if (!ee || !ee->isNeed() || !client_) return false;
    const auto need = ee->need();
    const auto kind = need.value("kind", std::string());
    const auto user = need.value("user", std::string());
    if (kind == "peerLog") {
        // Журнал собеседника — у его сервера (spec 028)
        const auto dest = destOfUser(user);
        const auto before = client_->logVersion(user);
        const auto resp = call(true, "identity.device.log_sync_anon",
            encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                          json{{"user", {{"address", user}}},
                               {"after_version", std::to_string(client_->logVersion(user))}}), dest);
        // spec 027: аккаунт удалён — журнала нет, повторять нечего
        if (isDeletedLog(resp)) {
            outbox_.push_back(json{{"type", "peerDeleted"}, {"user", user}});
            return false;
        }
        auto verdict = client_->ingestLog(user, resp);
        if (verdict == "replaced") {
            // Журнал на сервере начат заново (другой генезис) — перечитать целиком.
            verdict = client_->ingestLog(user, call(true, "identity.device.log_sync_anon",
                encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                              json{{"user", {{"address", user}}}, {"after_version", "0"}}), dest));
        }
        if (verdict == "rootChanged") return acceptPeerRootLocked(user);
        // spec 026: собеседник сменил ник — чат переезжает на новый адрес
        if (verdict == "moved" || verdict == "renamed") {
            followPeerRenameLocked(user, verdict);
            return true;
        }
        rekeyAfterDeviceRemovalLocked();
        // Журнал не продвинулся, а движок просит его снова: собеседник прямо
        // сейчас публикует первое устройство (корень записан, сертификат ещё
        // нет) — дать ему дописать, а не сжечь все попытки за миллисекунды.
        if (verdict != "replaced" && before > 0 && client_->logVersion(user) == before && !stopping_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(400));
        }
        return verdict != "replaced";
    }
    if (kind == "rootChanged") return acceptPeerRootLocked(user);
    if (kind == "bundle") {
        const auto resp = call(true, "identity.device.fetch_bundle_anon",
            encodeMessage("parvane.identity.v2.DeviceFetchBundleAnonRequest",
                          json{{"user", {{"address", user}}}}), destOfUser(user));
        client_->ingestBundle(user, resp);
        return true;
    }
    if (kind == "token") {
        // Жетоны для первого письма незнакомцу с другого сервера — от сервера адресата (свой запас на домен)
        if (const auto dest = destOfUser(user); !dest.empty()) {
            requestForeignTokensLocked(dest, kTokenBatch);
            return true;
        }
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

void Session::syncAllLocked(std::vector<json> &events) {
    if (!client_ || !host_) return;
    // Страницы журнала инбокса запрашивает модель (по одной, следующая — после разбора), записи открывает клиент
    // модели, подтверждение — после фиксации пачки с применённым (SYNC-1)
    counters::get().syncPages++;
    driveLocked(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "inbox.poll"}}), &events);
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
            // В L2 журналы перечитываются только по таймеру (по запросам видно, чей чат открыт)
            if (it->second.v2 && l2Active_) return true;
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
    // Чтение журнала могло принести события (смена ника, удаление, смена корня)
    flushAsync();
    return v2;
}

namespace {

// Ключей новой эпохи группы ещё нет у этого участника (смена эпохи админом — не чаще раза в 10 с).
bool isGroupKeysNeed(const std::exception &e) {
    const auto *ee = dynamic_cast<const EngineError *>(&e);
    return ee && ee->isNeed() && ee->need().value("kind", std::string()) == "groupKeys";
}

// Сколько ждать ключи эпохи и шаг ожидания (как web `GROUP_KEYS_WAIT_MS`/`GROUP_KEYS_RETRY_MS`).
constexpr std::int64_t kGroupKeysWaitMs = 20000;
constexpr std::int64_t kGroupKeysRetryMs = 1000;

} // namespace

void Session::sendContent(const std::string &peer, const json &content, const std::string &opId) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kGroupKeysWaitMs);
    for (;;) {
        try {
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
            break;
        } catch (const std::exception &e) {
            // Вступили только что: ключи эпохи придут от админа записью инбокса — ждём без мьютекса движка
            if (!isGroupKeysNeed(e) || stopping_ || std::chrono::steady_clock::now() >= deadline) throw;
            log("отправка в группу ждёт ключи новой эпохи");
            std::this_thread::sleep_for(std::chrono::milliseconds(kGroupKeysRetryMs));
        }
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

std::string Session::rootKeyOf(const std::string &user) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return {};
    return client_->logDevices(user).value("root", std::string());
}

std::vector<std::pair<std::string, std::int64_t>> Session::readers(const std::string &uuid) {
    std::vector<std::pair<std::string, std::int64_t>> out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return out;
    try {
        for (const auto &r : client_->readers(uuid)) {
            const auto user = r.value("user", std::string());
            if (!user.empty()) out.emplace_back(user, r.value("tsMs", std::int64_t(0)) / 1000);
        }
    } catch (const std::exception &e) {
        log(std::string("прочитавшие: ") + e.what());
    }
    return out;
}

// Участники моих групп v2 (кроме меня).
std::set<std::string> Session::coMembersLocked(bool includePublic) {
    std::set<std::string> out;
    if (!client_) return out;
    for (const auto &hex : client_->groupList()) {
        const auto g = client_->groupInfo(hex);
        if (!g || g->value("deleted", false) || !g->contains("members")) continue;
        if (!includePublic && g->contains("publicName") && !(*g)["publicName"].is_null()) continue;
        bool mine = false;
        for (const auto &m : (*g)["members"]) mine = mine || m.value("user", std::string()) == cfg_.self;
        if (!mine) continue;
        for (const auto &m : (*g)["members"]) {
            const auto user = m.value("user", std::string());
            if (!user.empty() && user != cfg_.self) out.insert(user);
        }
    }
    return out;
}

// Групповой звонок участнику, с которым не было переписки (T185): сигнал звонка
// сервер принимает только по ключу доступа адресата. Раздаём свой ключ (обычным
// сообщением — по жетону) и ждём встречный: клиент участника общей группы
// отвечает своим сам (`reciprocateKeysLocked`). Без v1 иначе он не зазвонит.
bool Session::acquirePeerKey(const std::string &peer) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return false;
        if (client_->hasPeerDeliveryKey(peer)) return true;
        if (!coMembersLocked().count(peer)) return false;
        try {
            runRequestsLocked(withNeedsLocked([&] { return client_->shareDeliveryKey(peer); }));
            persistLocked();
        } catch (const std::exception &e) {
            log(std::string("ключ доступа участнику звонка не роздан: ") + e.what());
            return false;
        }
    }
    // Ждём без мьютекса движка: встречный ключ приносит запись инбокса. Сигналы
    // группового звонка шлются и из обработчика событий — то есть с рабочего потока,
    // который сам разбирает записи: тогда разбираем их здесь, иначе ключ, пришедший
    // через секунду, ждал бы в очереди до конца ожидания (bob → carol в verify_group_call).
    const bool onWorker = std::this_thread::get_id() == worker_.get_id();
    for (int i = 0; i < 27 && !stopping_; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        if (onWorker) openPendingRecords();
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (client_ && client_->hasPeerDeliveryKey(peer)) return true;
    }
    log("встречный ключ доступа участника звонка не пришёл");
    return false;
}

// Разобрать накопленные записи инбокса по порядку прихода. Только рабочий поток:
// задача обработчика `inbox.record` либо ожидание встречного ключа (acquirePeerKey).
// События уходят в outbox_; onEvent здесь не зовётся — отдаёт их flush вызывающего.
void Session::openPendingRecords() {
    for (;;) {
        if (inboxHeld_) return;
        // OPT-024: всё, что накопилось к этому моменту, — одной пачкой: один шаг модели (`inbox.records`), одна
        // фиксация хранилища и один ack после неё
        std::deque<std::string> batch;
        {
            std::lock_guard<std::mutex> lk(recordsMu_);
            if (records_.empty()) return;
            batch.swap(records_);
        }
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_ || !host_) {
            // Сессия закрыта — записи без ack сервер отдаст заново
            std::lock_guard<std::mutex> rl(recordsMu_);
            records_.clear();
            return;
        }
        json records = json::array();
        for (const auto &body : batch) {
            try {
                records.push_back(decodeMessage("parvane.msg.v2.InboxRecord", body));
            } catch (const std::exception &e) {
                log(std::string("запись инбокса не разобрана: ") + e.what());
            }
        }
        std::string body;
        try {
            body = encodeMessage("parvane.msg.v2.InboxSyncResponse", json{{"records", records}});
        } catch (const std::exception &e) {
            log(std::string("пачка записей инбокса не собрана: ") + e.what());
            continue;
        }
        std::vector<json> events;
        const auto st = host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "inbox.records"}, {"body", toBase64(body)}});
        driveLocked(st, &events);
        const auto total = events.size();
        absorbLocked(std::move(events));
        counters::get().inboxRecords += batch.size();
        counters::get().inboxPersist += lastDriveBatches_;
        statRecords_ += batch.size();
        statPersists_ += lastDriveBatches_;
        std::string kinds;
        if (total == 0) {
            for (const auto &k : lastDriveChangeKinds_) kinds += (kinds.empty() ? " (изменения: " : ", ") + k;
            if (!kinds.empty()) kinds += ")";
        }
        log("записи инбокса: " + std::to_string(batch.size()) + ", событий " + std::to_string(total) + kinds);
        reciprocateKeysLocked(); // T185: записи могли принести ключ участника группы
    }
}

// Участник общей группы прислал свой ключ доступа (собирается звонить) — отвечаем
// своим: жетона это не стоит (его ключ у нас уже есть), делается один раз.
void Session::reciprocateKeysLocked() {
    if (!ready_ || !client_) return;
    bool shared = false;
    // Встречно отвечаем ключом только участникам закрытых групп: в публичной группе «соучастником» может быть любой
    // вступивший, и ключ доступа автоматически уходил бы незнакомцам (A0072-2)
    for (const auto &member : coMembersLocked(false)) {
        if (reciprocated_.count(member) || !client_->hasPeerDeliveryKey(member)) continue;
        reciprocated_.insert(member);
        try {
            const auto requests = withNeedsLocked([&] { return client_->shareDeliveryKey(member); });
            if (requests.is_array() && requests.empty()) continue;
            runRequestsLocked(requests);
            shared = true;
        } catch (const std::exception &e) {
            log(std::string("встречная раздача ключа доступа: ") + e.what());
        }
    }
    if (shared) persistLocked();
}

bool Session::sendCallSignal(const std::string &peer, const json &signal, const std::string &groupCallId,
                             std::string *error) {
    if (error) error->clear();
    if (isGroupAddress(peer) || !isV2Peer(peer)) return false;
    const bool group = !groupCallId.empty() || signal.value("type", std::string()) == "group_invite";
    // Участнику группового звонка без известного ключа доступа — сперва обмен
    // ключами (T185); не вышло — прежним путём (v1-инбокс, пока v1 жив)
    if (group && !acquirePeerKey(peer)) return false;
    const auto v2Signal = callSignalToV2(signal, groupCallId, domainNow());
    if (!v2Signal) {
        if (group) return false;
        log("сигнал звонка по v2 не выражается — не отправлен (D-13)");
        return true;
    }
    for (int attempt = 0;; ++attempt) try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
        // Сигнал звонка сервер принимает только по ключу доступа адресата:
        // участнику группового звонка без него — прежним путём
        if (group && !client_->hasPeerDeliveryKey(peer)) return false;
        runDirectLocked(peer, [&] { return client_->prepareCall(peer, *v2Signal); });
        persistLocked();
        break;
    } catch (const std::exception &e) {
        const bool rateLimited = std::string(e.what()).find("RATE_LIMITED") != std::string::npos;
        // T189: вызов (invite) упёрся в потолок вызовов адресату шарда call — повтор бесполезен
        if (rateLimited && !group && signal.value("type", std::string()) == "invite") {
            log("сигнал звонка не отправлен: потолок вызовов адресату");
            if (error) *error = "rate_limited";
            break;
        }
        // Лимит частоты gateway — не повод терять сигнал: пауза (без мьютекса) и повтор
        if (attempt < 4 && rateLimited) {
            std::this_thread::sleep_for(std::chrono::milliseconds(700 * (attempt + 1)));
            continue;
        }
        log(std::string("сигнал звонка не отправлен: ") + e.what());
        // Личный звонок по v1 не понижается (D-13); групповой — идёт v1-инбоксом
        if (group) return false;
        if (error) {
            const std::string what = e.what();
            *error = (what.find("orbidden") != std::string::npos || what.find("FORBIDDEN") != std::string::npos)
                ? "forbidden" : "failed";
        }
        break;
    }
    return true;
}

bool Session::sendCallSignalOwn(const json &signal) {
    const auto v2Signal = callSignalToV2(signal);
    if (!v2Signal || !v2Signal->contains("hangup")) return false;
    try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return false;
        runRequestsLocked(client_->call("prepareCallOwn", json{{"signalJson", *v2Signal}}));
        persistLocked();
        return true;
    } catch (const std::exception &e) {
        log(std::string("сигнал звонка своим устройствам не отправлен: ") + e.what());
        return false;
    }
}

// ── разделы (spec 029): точки входа слоя данных parvane::sections ────────────

json Session::engineCall(const std::string &name, const json &args, bool withNeeds) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    if (withNeeds) return withNeedsJsonLocked([&] { return client_->call(name, args); });
    return client_->call(name, args);
}

std::string Session::busRequest(bool anon, const std::string &method, const std::string &body,
                                const std::string &dest) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    return call(anon, method, body, dest);
}

void Session::persistEngine() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    persistLocked();
}

json Session::stateSnapshot() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return nullptr;
    return state_->snapshot();
}

void Session::refreshPeerLog(const std::string &user) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return;
    satisfyLocked(EngineError(json{{"need", {{"kind", "peerLog"}, {"user", user}}}}.dump()));
    persistLocked();
}

// ── блобы вложений по capability (T131, FR-062, D-08) ──────────────────────

std::string Session::uploadBlob(const std::string &bytes, const std::string &capability32, std::size_t chunkBytes,
                                const std::string &bucket) {
    if (capability32.size() != 32 || chunkBytes == 0) throw std::runtime_error("v2: capability/чанк");
    if (!ready_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    // Загрузка идёт ID-каналом (владелец блоба серверу известен — получатели нет).
    const auto total = std::max<std::size_t>(1, (bytes.size() + chunkBytes - 1) / chunkBytes);
    std::string uploadId;
    for (std::size_t index = 0; index < total; ++index) {
        const auto resp = decodeMessage("parvane.cloud.v1.UploadChunkResponse",
            call(false, "cloud.blob.upload_chunk",
                 encodeMessage("parvane.cloud.v1.UploadChunkRequest",
                               [&] {
                                   auto req = json{{"upload_id", uploadId},
                                                   {"index", index},
                                                   {"data", toBase64(bytes.substr(index * chunkBytes, chunkBytes))}};
                                   if (!bucket.empty()) req["bucket"] = bucket;
                                   return req;
                               }())));
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

std::string Session::downloadBlobCap(const std::string &fileId, const std::string &capability32, const std::string &domainIn,
                                     std::size_t maxBytes) {
    const auto domain = domainIn == domainNow() ? std::string() : domainIn;
    if (capability32.size() != 32) throw std::runtime_error("v2: capability");
    if (!ready_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    // Ревью 21 окт (2.2): с потолком — отказ по заявленному размеру до приёма чанков (downloadBlobChunks)
    return downloadBlobChunks("cloud.blob.download_cap", maxBytes,
        [&](const Connection::StreamLimits &limits) {
            // Одноразовое анонимное соединение на запрос: серверу не связать
            // скачивание ни с аккаунтом, ни с другими запросами (D-05).
            Connection conn(cfg_.gatewayUrl);
            conn.open(kChannelAnonymous, cfg_.clientVersion);
            auto got = conn.requestStream("cloud.blob.download_cap",
                encodeMessage("parvane.cloud.v1.DownloadCapRequest",
                              json{{"file_id", fileId},
                                   {"capability", toBase64(capability32)},
                                   {"first_chunk", limits.firstChunk},
                                   {"chunk_count", limits.chunkCount}}), 60000, domain, limits);
            conn.close();
            return got;
        });
}

// Потолок фото группы: аватар — картинка, а не файл (20 МиБ сырых байт)
static constexpr std::size_t kGroupPhotoMaxPlain = 20u << 20;

Session::GroupPhotoUpload Session::uploadGroupPhoto(const std::string &plain) {
    if (plain.empty() || plain.size() > kGroupPhotoMaxPlain) throw std::runtime_error("v2: фото группы пустое или слишком большое");
    const auto secret = blobcrypt::newGroupPhotoSecret();
    const auto keys = blobcrypt::deriveGroupPhotoKeys(secret);
    const auto cipher = blobcrypt::sealGroupPhoto(plain, secret);
    if (secret.empty() || !keys || cipher.empty()) throw std::runtime_error("v2: фото группы не зашифровано");
    return {uploadBlob(cipher, keys->capability), toBase64(secret)};
}

std::optional<std::string> Session::downloadGroupPhoto(const std::string &fileId, const std::string &secretB64,
                                                       const std::string &domain) {
    const auto secret = fromBase64Safe(secretB64);
    if (!secret) return std::nullopt;
    const auto keys = blobcrypt::deriveGroupPhotoKeys(*secret);
    if (!keys) return std::nullopt;
    const auto cipher = downloadBlobCap(fileId, keys->capability, domain, blobcrypt::maxCipherSize(kGroupPhotoMaxPlain));
    return blobcrypt::openGroupPhoto(cipher, *secret);
}

// ── новое устройство без других устройств (T130, FR-066) ───────────────────

void Session::dropIdentityLocked() {
    log("личность аккаунта сброшена другим устройством — нужна линковка этого устройства");
    ready_ = false;
    client_.reset();
    state_.reset();
    host_.reset(); // модель закрыта: её хранилище уходит в карантин целиком, следующее подключение — новое
    publishRowsHost(nullptr);
    writeStateFile("model-open", ""); // без сети прежняя модель больше не открывается
    hostDevice_.clear();
    hostHadProfile_ = false;
    // Вердикт «replaced» приходит голым ответом сервера без доказательства сброса (A0072-1): файлы личности не
    // стираются, а уходят в карантин `replaced-<мс>` рядом — настоящий сброс ничего не теряет, а подмену можно откатить
    const std::string quarantine = cfg_.stateDir + "/replaced-" + std::to_string(nowMs());
    const bool hasQuarantine = ::mkdir(quarantine.c_str(), 0700) == 0;
    for (const char *name : {"store", "state", "root", "root-backup", "root-backup-sent", "root-backup-received", "own-devices", "state-migrated"}) {
        // Файл в хранилище движка (spec 036 T031) — копией в карантин рядом, затем прочь из хранилища
        if (std::string(name) != "store") {
            if (const auto value = readStateFile(name); !value.empty() && hasQuarantine) {
                storecrypt::writeFile(quarantine + "/" + name, value);
            }
            removeStateFile(name);
        }
        const std::string from = cfg_.stateDir + "/" + name;
        if (!hasQuarantine || std::rename(from.c_str(), (quarantine + "/" + name).c_str()) != 0) {
            std::remove(from.c_str());
        }
    }
    needsLinking_ = true;
    outbox_.push_back(json{{"type", "needsLinking"}});
}

void Session::uploadRootBackupLocked() {
    const auto backup = readStateFile("root-backup");
    if (backup.empty() || !client_) return;
    const auto b64 = toBase64(backup);
    const auto escrow = readStateFile("root-escrow");
    // Без копии для администратора отметка — прежнего вида (сама копия корня)
    const auto mark = escrow.empty() ? b64 : b64 + "|" + toBase64(escrow);
    if (readStateFile("root-backup-sent") == mark) return;
    json req = json::object();
    // Полученная грантом копия корня не пишется (только страховка для администратора, если есть)
    if (readStateFile("root-backup-received") != b64) req["backup"] = b64;
    if (!escrow.empty()) req["escrow"] = toBase64(escrow);
    if (req.empty()) return;
    call(false, "identity.root.backup_set", encodeMessage("parvane.identity.v2.RootBackupSetRequest", req));
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
            if (!host_) throw std::runtime_error("модель не открыта");
            auto c = std::make_unique<Client>(host_);
            c->replaceNew();
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
            removeStateFile("publish");
            needsLinking_ = false;
            // Ключ в руках — копия ключей аккаунта под ним (spec 015)
            removeStateFile("bundle-sent");
        removeStateFile("bundle-seq");
            rememberBundleKeyLocked(recoveryKey);
            log("устройство восстановлено ключом восстановления (прежние устройства отозваны)");
        } catch (const std::exception &e) {
            std::fill(root.begin(), root.end(), '\0');
            client_.reset();
            removeStateFile("publish");
            // Недовосстановленный клиент модели не остаётся (на диск он не попадал)
            if (host_) {
                try {
                    Client(host_).replaceNew();
                } catch (const std::exception &) {
                }
            }
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
            if (!host_) throw std::runtime_error("модель не открыта");
            auto c = std::make_unique<Client>(host_);
            c->replaceNew();
            const auto created = c->resetIdentity(cfg_.otkCount);
            // Первый запрос — замена журнала (нужна свежая переаутентификация):
            // здесь «сеть → диск», повтор после рестарта без пароля не прошёл бы.
            runRequestsLocked(created.value("requests", json::array()));
            client_ = std::move(c);
            auto root = fromBase64(created.value("rootSecret", std::string()));
            if (cfg_.onRecoveryKey) {
                recoveryKey = generateRecoveryKey();
                writeStateFile("root-backup", client_->exportRootBackup(root, recoveryKey));
                removeStateFile("root-escrow");
                sealRootEscrowLocked(root);
                removeStateFile("root");
            } else {
                writeStateFile("root", root);
                removeStateFile("root-backup");
            }
            std::fill(root.begin(), root.end(), '\0');
            removeStateFile("root-backup-sent");
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
    if (!recoveryKey.empty()) {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        removeStateFile("bundle-sent");
        removeStateFile("bundle-seq");
        rememberBundleKeyLocked(recoveryKey);
        queueRecoveryKeyLocked(recoveryKey);
    }
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
        if (state_) carry = state_->objects();
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
                    stateRekeyed_ = true;
            stateCarry_ = std::move(carry);
            outbox_.push_back(json{{"type", "stateReady"}, {"rotated", true}});
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

json Session::deviceBackup() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_ || storageKey_.size() != 32) return nullptr;
    json out;
    try {
        out = json{{"key", toBase64(storageKey_)}, {"state", toBase64(client_->exportState(storageKey_))}};
    } catch (const std::exception &e) {
        log(std::string("копия ключей: состояние не выгружено: ") + e.what());
        return nullptr;
    }
    if (const auto backup = readStateFile("root-backup"); !backup.empty()) out["rootBackup"] = toBase64(backup);
    if (const auto invites = loadInvites(); !invites.empty()) out["invites"] = invites;
    return out;
}

std::string Session::rotateSsk(const std::string &recoveryKey) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return "failed";
    // Запись смены SSK — от текущей версии своего журнала (другое устройство могло выйти)
    try {
        checkOwnDevicesLocked();
    } catch (const std::exception &e) {
        log(std::string("журнал своих устройств: ") + e.what());
    }
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
            // Ключ мог быть выписан администратором заново: тогда копия под ним — на сервере
            std::string serverBackup;
            try {
                serverBackup = fromBase64(fetchRootBackupStateLocked().value("backup", std::string()));
            } catch (const std::exception &) {
            }
            if (serverBackup.empty() || serverBackup == backup) return "bad_key";
            try {
                root = client_->importRootBackup(serverBackup, recoveryKey);
            } catch (const std::exception &) {
                return "bad_key";
            }
            writeStateFile("root-backup", serverBackup);
            writeStateFile("root-backup-sent", toBase64(serverBackup));
        }
        sealRootEscrowLocked(root);
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
        if (!recoveryKey.empty()) {
            // Новый SSK — в копию ключей аккаунта (ключ восстановления сейчас в руках)
            rememberBundleKeyLocked(recoveryKey);
            // Сначала копия корня, потом копия ключей: запись другой копии корня стирает на сервере копию ключей
            try {
                uploadRootBackupLocked();
            } catch (const std::exception &e) {
                log(std::string("копия корня на сервер не ушла: ") + e.what());
            }
            refreshKeyBundleLocked(true);
        }
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

void Session::sendPresence(bool online) {
    try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return;
        runRequestsLocked(client_->ephPresence(online, nowMs()));
    } catch (const std::exception &e) {
        log(std::string("присутствие не отправлено: ") + e.what());
    }
}

void Session::watchPeers(const std::vector<std::string> &peers) {
    try {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return;
        ensureEphemeralLocked(peers);
    } catch (const std::exception &e) {
        log(std::string("подписка на присутствие: ") + e.what());
    }
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

json Session::withNeedsJsonLocked(const std::function<json()> &f) {
    return withNeedsLocked([&] { return f(); });
}

// ── события наружу ─────────────────────────────────────────────────────────

void Session::absorbLocked(std::vector<json> events) {
    // PV-005 (GPHOTO-1): секрет фото частной группы приходит отдельным конвертом GroupAvatarKey ПОСЛЕ записи SetInfo
    // (движок отдаёт его сменой группы без новой записи журнала) — сведения, отданные хосту по журналу, были ещё без
    // ключа: фото не открывалось. После разбора — сведения заново тем группам, у которых ключ сменился.
    // и группы, отданные хосту с частным фото без секрета, — секрет мог прийти путём без события группы
    std::set<std::string> avatarCheck(awaitingAvatarKey_.begin(), awaitingAvatarKey_.end());
    for (const auto &ev : events) {
        if (ev.is_object() && ev.value("type", std::string()) == "groupChanged" && ev.contains("group")
            && ev["group"].is_object()) {
            avatarCheck.insert(ev["group"].value("id", std::string()));
        }
    }
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
                continue;
            }
            // Уведомление без смены версии — заявка на вступление появилась или снята
            if (canDecideRequestsLocked(hex)) {
                const auto g = client_->groupInfo(hex);
                if (g && g->contains("inviteLinks") && !(*g)["inviteLinks"].empty()) {
                    listJoinRequestsLocked(hex);
                }
            } else if (pendingRequests_.erase(hex)) {
                publishGroupLocked(hex);
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
                    stateRekeyPeer_ = true;
            // rotated — журнал истории открывает сессию заново и пишет точку под новым ключом (HIST-2)
            outbox_.push_back(json{{"type", "stateReady"}, {"rotated", true}});
            continue;
        }
        if (type == "call") {
            // Сигнал звонка: отправителя и привязку к звонку проверил движок.
            const auto signal = ev.contains("signal") ? callSignalFromV2(ev["signal"]) : std::nullopt;
            if (signal) {
                // Приглашение в групповой звонок и попарные сигналы mesh — групповому менеджеру
                const bool group = signal->value("type", std::string()) == "group_invite"
                    || signal->contains("group_call_id");
                outbox_.push_back(json{{"type", "callSignal"}, {"from", ev.value("from", std::string())},
                                       {"signal", *signal}, {"group", group}});
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
    // Секреты ссылок от других ведущих приглашения (spec 024) — в своё хранилище
    absorbSharedInvitesLocked();
    // Секрет фото группы сменился без новой записи журнала (см. начало) — сведения группы хосту заново
    for (const auto &hex : avatarCheck) {
        if (hex.empty() || !client_) continue;
        const auto g = client_->groupInfo(hex);
        const auto key = g ? g->value("avatarKey", std::string()) : std::string();
        const auto known = publishedAvatarKeys_.find(hex);
        if (!key.empty() && (known == publishedAvatarKeys_.end() || known->second != key)) {
            log("ключ фото группы " + hex + " получен — сведения группы заново");
            publishGroupLocked(hex);
        }
    }
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

void Session::syncGroupLocked(const std::string &hex, const std::string &inviteUrl) {
    if (!client_) return;
    syncingGroups_.insert(hex);
    const auto startVersion = client_->groupVersion(hex);
    try {
        for (int page = 0; page < kGroupSyncPages; ++page) {
            const auto before = client_->groupVersion(hex);
            // Журнал группы — у её сервера (spec 028)
            const auto gdomain = groupDomainLocked(hex);
            std::string resp;
            if (!inviteUrl.empty()) {
                // spec 035 (PV-006): до вступления частная группа отдаёт журнал только с доказательством знания
                // секрета ссылки — подписью ключом ссылки над группой, своим адресом и временем
                const auto req = parseRequest(client_->groupSyncByLink(inviteUrl, gdomain, hex, before, nowMs()));
                resp = call(req.anon, req.method, req.body, gdomain);
            } else {
                const json req{{"group", {{"domain", gdomain}, {"id", hexToB64(hex)}}},
                               {"after_version", std::to_string(before)}};
                resp = call(false, "group.state.sync", encodeMessage("parvane.group.v2.StateSyncRequest", req), gdomain);
            }
            withNeedsLocked([&] { return client_->groupIngest(gdomain, hex, resp); });
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
    // Журнал догнан: записи инбокса, отложенные моделью до этой версии (конверт эпохи впереди журнала — секрет фото
    // группы после своей SetInfo), — заново. Без этого запись ждала до следующего добора, а записи за ней — в очереди
    // за ней (12 ноя 2026, e2e cross_client под нагрузкой: «секрета фото группы ещё нет» навсегда)
    if (host_ && client_->groupVersion(hex) != startVersion) {
        post([this] {
            {
                std::lock_guard<std::recursive_mutex> lk(engineMu_);
                if (!client_ || !host_) return;
                driveLocked(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "retry"}}), nullptr);
            }
            flush();
        });
    }
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
    const auto g = shownGroupInfoLocked(hex);
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
    auto info = *g;
    // Число заявок на вступление — только тому, кто вправе их решать (T143)
    if (const auto it = pendingRequests_.find(hex); it != pendingRequests_.end()) {
        info["pendingRequests"] = it->second;
    }
    publishedAvatarKeys_[hex] = g->value("avatarKey", std::string());
    if (!g->value("avatarKeyId", std::string()).empty() && g->value("avatarKey", std::string()).empty()) {
        awaitingAvatarKey_.insert(hex);
    } else {
        awaitingAvatarKey_.erase(hex);
    }
    outbox_.push_back(json{{"type", "groupUpdated"}, {"address", address}, {"isNew", isNew}, {"info", info}});
    // Новая ссылка, новый админ — секреты своих ссылок ведущим приглашения
    shareInvitesLocked(hex);
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
    const bool l2On = !client_->presenceAllowed();
    if (l2On != l2Active_.exchange(l2On)) {
        if (ticker_) ticker_->refresh();
        if (l2On && !l2PeerRefreshScheduled_) {
            l2PeerRefreshScheduled_ = true;
            scheduleL2PeerRefresh();
        }
        log(std::string("режим L2: такты ") + (l2On ? "включены" : "выключены"));
    }
    json ev{{"type", "l2State"}, {"chats", chats}, {"mine", mine},
            {"presenceAllowed", client_->presenceAllowed()}};
    const auto snapshot = ev.dump();
    if (!force && snapshot == l2Snapshot_) return;
    l2Snapshot_ = snapshot;
    outbox_.push_back(std::move(ev));
}

// ── приватность и режим L2 (T079) ──────────────────────────────────────────

namespace {
constexpr unsigned kPrivacyGroupAdd = 1;
constexpr unsigned kPrivacyStrangers = 2;
constexpr unsigned kPrivacyCalls = 4;
constexpr unsigned kPrivacyPresence = 8;
constexpr unsigned kPrivacyAll = kPrivacyGroupAdd | kPrivacyStrangers | kPrivacyCalls | kPrivacyPresence;

bool audienceNobody(const json &settings, const char *field) {
    return settings.value(field, std::string()) == "AUDIENCE_NOBODY";
}
const char *audienceName(bool nobody) {
    return nobody ? "AUDIENCE_NOBODY" : "AUDIENCE_EVERYBODY";
}
} // namespace

// Серверные настройки. false — ни разу не задавались (settings не тронут).
bool Session::readPrivacyLocked(json *settings) {
    const auto got = decodeMessage(
        "parvane.identity.v2.PrivacyGetResponse",
        call(false, "identity.privacy.get",
             encodeMessage("parvane.identity.v2.PrivacyGetRequest", json::object())));
    if (!got.is_object() || !got.value("is_set", false)) return false;
    *settings = got.value("settings", json::object());
    return true;
}

void Session::pushPrivacyLocked() {
    if (!privacySet_ || !ready_) return;
    try {
        // privacy.set заменяет все поля: те, что это устройство не правило,
        // берём с сервера — их могло задать другое устройство.
        if (privacyDirty_ != kPrivacyAll) {
            json remote;
            if (readPrivacyLocked(&remote)) {
                if (!(privacyDirty_ & kPrivacyGroupAdd)) privacyGroupAddNobody_ = audienceNobody(remote, "group_add");
                if (!(privacyDirty_ & kPrivacyStrangers)) privacyStrangers_ = remote.value("messages_from_strangers", false);
                if (!(privacyDirty_ & kPrivacyCalls)) privacyCallsNobody_ = audienceNobody(remote, "calls_from");
                if (!(privacyDirty_ & kPrivacyPresence)) privacyPresenceNobody_ = audienceNobody(remote, "presence_visibility");
            }
        }
        call(false, "identity.privacy.set",
             encodeMessage("parvane.identity.v2.PrivacySetRequest",
                           json{{"settings",
                                 {{"group_add", audienceName(privacyGroupAddNobody_)},
                                  {"messages_from_strangers", privacyStrangers_},
                                  {"calls_from", audienceName(privacyCallsNobody_)},
                                  {"presence_visibility", audienceName(privacyPresenceNobody_)}}}}));
        log(std::string("приватность сохранена: незнакомые ") + (privacyStrangers_ ? "да" : "нет")
            + ", добавление в группы " + (privacyGroupAddNobody_ ? "никто" : "все")
            + ", звонки " + (privacyCallsNobody_ ? "никто" : "все")
            + ", присутствие " + (privacyPresenceNobody_ ? "скрыто" : "видно"));
        privacySet_ = false; // правка на сервере; дальше источник истины — он
        privacyDirty_ = 0;
        outbox_.push_back(json{{"type", "privacySaved"}});
        // Итог целиком — хосту: недостающие поля могли прийти с сервера
        outbox_.push_back(json{{"type", "privacy"},
                               {"groupAddNobody", privacyGroupAddNobody_},
                               {"strangersAllowed", privacyStrangers_},
                               {"callsNobody", privacyCallsNobody_},
                               {"presenceNobody", privacyPresenceNobody_}});
    } catch (const std::exception &e) {
        log(std::string("приватность не сохранена: ") + e.what());
        throw;
    }
}

void Session::fetchPrivacyLocked() {
    try {
        json settings;
        if (!readPrivacyLocked(&settings)) return;
        privacyGroupAddNobody_ = audienceNobody(settings, "group_add");
        privacyStrangers_ = settings.value("messages_from_strangers", false);
        privacyCallsNobody_ = audienceNobody(settings, "calls_from");
        privacyPresenceNobody_ = audienceNobody(settings, "presence_visibility");
        outbox_.push_back(json{{"type", "privacy"},
                               {"groupAddNobody", privacyGroupAddNobody_},
                               {"strangersAllowed", privacyStrangers_},
                               {"callsNobody", privacyCallsNobody_},
                               {"presenceNobody", privacyPresenceNobody_}});
    } catch (const std::exception &e) {
        log(std::string("приватность не прочитана: ") + e.what());
        throw;
    }
}

bool Session::savePrivacyLocked() {
    privacySet_ = true;
    if (!ready_ || !client_) return false; // уйдёт при готовности сессии
    try {
        pushPrivacyLocked();
        flushAsync();
        return true;
    } catch (const std::exception &) {
        return false;
    }
}

bool Session::setPrivacy(bool groupAddNobody, bool strangersAllowed) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    privacyGroupAddNobody_ = groupAddNobody;
    privacyStrangers_ = strangersAllowed;
    privacyDirty_ |= kPrivacyGroupAdd | kPrivacyStrangers;
    return savePrivacyLocked();
}

bool Session::setCallsPresencePrivacy(bool callsNobody, bool presenceNobody) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    privacyCallsNobody_ = callsNobody;
    privacyPresenceNobody_ = presenceNobody;
    privacyDirty_ |= kPrivacyCalls | kPrivacyPresence;
    return savePrivacyLocked();
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

// Жетоны сервера другого домена (spec 028, как web `requestForeignTokens`): его описатель — через свой
// сервер, подпись проверяет движок; ключи жетонов — анонимно; выдача — от своего аккаунта через свой сервер.
void Session::requestForeignTokensLocked(const std::string &domain, std::size_t limit) {
    if (!client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    const auto described = preauth(cfg_.gatewayUrl, "server.describe", json::object(), cfg_.clientVersion, 15000, domain);
    const auto signedDesc = encodeMessage("parvane.core.v2.SignedServerDescriptor",
                                          described.contains("descriptor") ? described["descriptor"] : json::object());
    const auto desc = verifyServerDescriptor(signedDesc);
    auto got = desc.value("domain", std::string());
    std::transform(got.begin(), got.end(), got.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    if (got != domain) throw V2Error("ERROR_CODE_INVALID");
    const auto key = hexToBytes(desc.value("serverKey", std::string()));
    const auto list = call(true, "identity.tokens.key_list", std::string(), domain);
    std::vector<std::size_t> steps;
    for (const auto count : kTokenBatchSteps) {
        if (count <= limit) steps.push_back(count);
    }
    if (steps.empty()) steps.push_back(std::max<std::size_t>(1, limit));
    for (std::size_t i = 0; i < steps.size(); ++i) {
        try {
            const auto req = parseRequest(client_->call("tokenRequestFor",
                json{{"domain", domain}, {"keyListResponse", toBase64(list)}, {"serverKey", toBase64(key)},
                     {"count", steps[i]}}));
            const auto resp = call(req.anon, req.method, req.body, domain);
            client_->call("tokenResponseFor", json{{"domain", domain}, {"resp", toBase64(resp)}});
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
        call(publish.anon, publish.method, publish.body, publish.dest);
    } catch (...) {
        resyncGroupLocked(hex);
        throw;
    }
    for (std::size_t i = 1; i < reqs.size(); ++i) {
        try {
            const auto r = parseRequest(reqs[i]);
            call(r.anon, r.method, r.body, r.dest);
        } catch (const std::exception &e) {
            log(std::string("ключи эпохи не доставлены: ") + e.what());
        }
    }
    // spec 035 (PV-005): новые участники получают секрет фото частной группы только конвертом новой эпохи
    if (const auto info = client_->groupInfo(hex); info && !info->value("avatarKey", std::string()).empty()) {
        sendGroupPhotoKeyLocked(hex);
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

std::string Session::migratedGroup(const std::string &groupId) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || groupId.empty()) return {};
    for (const auto &hex : client_->groupList()) {
        const auto info = client_->groupInfo(hex);
        if (info && info->value("migratedFrom", std::string()) == groupId) return groupAddress(hex);
    }
    return {};
}

std::string Session::migrateGroup(const json &v1) {
    if (!ready_ || !client_ || !v1.is_object()) return {};
    const auto groupId = v1.value("group_id", std::string());
    if (groupId.empty() || v1.value("created_by", std::string()) != cfg_.self) return {};
    if (!migratedGroup(groupId).empty()) return {};
    std::vector<std::string> others;
    std::vector<json> admins;
    if (v1.contains("members") && v1["members"].is_array()) {
        for (const auto &m : v1["members"]) {
            const auto address = m.value("address", std::string());
            const auto role = m.value("role", std::string());
            if (address.empty() || role == "banned" || role == "left" || address == cfg_.self) continue;
            others.push_back(address);
            if (role == "admin") admins.push_back(m);
        }
    }
    for (const auto &member : others) {
        if (!isV2Peer(member)) return {};
    }
    const auto channel = v1.value("kind", std::string()) == "channel";
    const auto address = createGroup(v1.value("name", std::string()), others, channel, groupId,
                                     v1.value("default_permissions", json()));
    if (address.empty()) return {};
    log("группа v1 " + groupId + " переведена в " + address);
    // Доводка сведений: сбой записи перевод не отменяет — владелец поправит руками
    const auto step = [&](const std::string &what, const json &change) {
        try {
            if (!changeGroup(address, change)) log("перевод группы — " + what + " не перенесено");
        } catch (const std::exception &e) {
            log("перевод группы — " + what + " не перенесено: " + e.what());
        }
    };
    const auto about = v1.value("about", std::string());
    const auto avatar = v1.value("avatar", std::string());
    if (!about.empty() || !avatar.empty()) {
        auto patch = json::object();
        if (!about.empty()) patch["about"] = about;
        if (!avatar.empty()) patch["avatar_file_id"] = avatar;
        step("описание и фото", json{{"set_info_patch", patch}});
    }
    for (const auto &m : admins) {
        const auto rights = (m.contains("admin_rights") && m["admin_rights"].is_object())
            ? m["admin_rights"]
            : json{{"change_info", true}, {"delete_messages", true}, {"ban_users", true},
                   {"invite_users", true}, {"pin_messages", true}, {"add_admins", true}};
        step("админ " + m.value("address", std::string()),
             json{{"set_role", {{"member", {{"address", m.value("address", std::string())}}},
                                {"role", "ROLE_ADMIN"}, {"rights", rights}}}});
    }
    return address;
}

std::string Session::createGroup(const std::string &title, const std::vector<std::string> &members, bool channel,
                                 const std::string &migratedFrom, const json &permissions) {
    if (!ready_ || !client_) return {};
    for (const auto &m : members) {
        if (!isV2Peer(m)) return {};
    }
    std::string address;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return {};
        // Права переводимой группы v1 — сразу в запись генезиса: отдельная запись
        // `set_permissions` потребовала бы новой эпохи (не чаще раза в 10 с), и
        // первые сообщения после перевода не уходили бы (ERROR_CODE_EXPIRED)
        const auto perms = channel ? json::object()
            : permissions.is_object() ? permissions : defaultGroupPermissions();
        const auto before = client_->groupList();
        const auto created = client_->groupCreate(channel ? kGroupKindChannel : kGroupKindGroup, title, members, perms,
                                                  migratedFrom);
        std::string hex;
        for (const auto &id : client_->groupList()) {
            if (std::find(before.begin(), before.end(), id) == before.end()) hex = id;
        }
        if (hex.empty() && created.contains("group")) hex = created["group"].value("id", std::string());
        const auto req = parseRequest(created.value("request", json::object()));
        try {
            call(req.anon, req.method, req.body, req.dest);
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

namespace {

// Код отказа изменения группы — те же слова, что отдаёт v1-шард group.* (их
// ждут экраны управления): отказ движка (имя вида ошибки в тексте) либо сервера.
std::string groupErrorCode(const std::exception &e) {
    std::string text = e.what();
    if (const auto *v = dynamic_cast<const V2Error *>(&e)) text = v->code();
    const auto has = [&](const char *needle) { return text.find(needle) != std::string::npos; };
    if (has("FORBIDDEN") || has("Forbidden") || has("forbidden")) return "forbidden";
    if (has("NOT_FOUND") || has("NotFound")) return "not_found";
    if (has("RATE") || has("RateLimited")) return "rate_limited";
    if (has("INVALID") || has("LIMIT") || has("FieldLimit") || has("InvalidField") || has("Malformed")) {
        return "bad_request";
    }
    return "failed";
}

} // namespace

bool Session::changeGroup(const std::string &address, const json &change, std::string *errorCode) {
    if (errorCode) *errorCode = "failed";
    if (!ready_ || !isGroupAddress(address)) return false;
    const auto hex = groupHex(address);
    bool ok = false;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return false;
        // {"set_info_patch": {name?, about?, avatar_file_id?}} — правка сведений:
        // недостающие поля берутся из журнала ЗДЕСЬ, под мьютексом движка. Две
        // правки подряд (название и описание с одного экрана), собранные хостом
        // по снимку «до», откатывали друг друга.
        json resolved = change;
        if (change.is_object() && change.contains("set_info_patch")) {
            const auto g = client_->groupInfo(hex);
            if (!g) return false;
            const auto &p = change["set_info_patch"];
            const auto pick = [&](const char *key, const char *have) {
                return (p.is_object() && p.contains(key) && p[key].is_string())
                    ? p[key].get<std::string>() : g->value(have, std::string());
            };
            // spec 035 (PV-005): новое фото — своей записью с avatar_key_id и конвертом секрета участникам; ключ фото
            // частной группы (A0089-5) идёт со своим файлом: меняется файл — ключ из патча (нет — открытое фото)
            if (p.is_object() && p.contains("avatar_file_id") && p["avatar_file_id"].is_string()) {
                const auto nameChanged = pick("name", "name") != g->value("name", std::string())
                    || pick("about", "about") != g->value("about", std::string());
                if (nameChanged && !applyGroupChangeLocked(hex, setInfoKeepPhoto(*g, pick("name", "name"), pick("about", "about")))) {
                    if (errorCode) *errorCode = "failed";
                    return false;
                }
                const auto key = (p.contains("avatar_key") && p["avatar_key"].is_string()) ? p["avatar_key"].get<std::string>() : std::string();
                ok = setGroupPhotoLocked(hex, p["avatar_file_id"].get<std::string>(), key);
                if (ok && errorCode) errorCode->clear();
                flushAsync();
                return ok;
            }
            resolved = setInfoKeepPhoto(*g, pick("name", "name"), pick("about", "about"));
        }
        json reqJson;
        try {
            reqJson = client_->groupChange(hex, resolved);
        } catch (const std::exception &e) {
            log(std::string("изменение группы отклонено движком: ") + e.what());
            if (errorCode) *errorCode = groupErrorCode(e);
            return false;
        }
        try {
            const auto req = parseRequest(reqJson);
            call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
            ok = true;
        } catch (const std::exception &e) {
            log(std::string("изменение группы отклонено сервером: ") + e.what());
            if (errorCode) *errorCode = groupErrorCode(e);
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

std::optional<json> Session::shownGroupInfoLocked(const std::string &hex) {
    if (host_) {
        const auto v = host_->read("viewGroup", json{{"group", {{"domain", ""}, {"id", hexToB64(hex)}}}});
        if (v.is_object() && !v.contains("error")) {
            auto info = json::parse(v.value("info_json", std::string()), nullptr, false);
            if (info.is_object()) {
                json can = json::object();
                for (const char *k : {"can_manage_invites", "can_decide_requests", "can_rotate", "can_ban", "can_add_admins",
                                      "can_delete_messages"}) {
                    can[k + 4] = v.value(k, false);
                }
                info["can"] = std::move(can);
                return info;
            }
        }
    }
    if (!client_) return std::nullopt;
    return client_->groupInfo(hex);
}

json Session::groupInfo(const std::string &address) {
    if (!isGroupAddress(address)) return nullptr;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    const auto g = shownGroupInfoLocked(groupHex(address));
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
            call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
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
        shareInviteLocked(address, record);
    }
    flushAsync();
    return record;
}

void Session::shareInviteLocked(const std::string &address, const json &record) {
    if (!state_) return; // журнал не подключён — ссылка уйдёт при следующем сведении
    try {
        json invite{{"group_id", hexToB64(groupHex(address))},
                    {"link_id", hexToB64(record.value("linkId", std::string()))},
                    {"url", record.value("url", std::string())},
                    {"created_ms", std::to_string(record.value("date", std::int64_t(0)) * 1000)}};
        if (record.contains("title")) invite["title"] = record["title"];
        if (record.contains("expiresAt")) {
            invite["expires_ms"] = std::to_string(record.value("expiresAt", std::int64_t(0)) * 1000);
        }
        if (record.contains("usageLimit")) invite["usage_limit"] = record["usageLimit"];
        if (record.value("isRequestNeeded", false)) invite["requires_approval"] = true;
        if (!state_->set("GROUP_INVITE", record.value("linkId", std::string()), invite)) {
            log("журнал состояния: запись не дошла (ссылка-приглашение)");
        }
    } catch (const std::exception &e) {
        log(std::string("ссылка-приглашение в журнале состояния: ") + e.what());
    }
}

// Снимок журнала → локальный список ссылок (добавляются чужие); действующие
// ссылки этого устройства, которых в журнале нет (созданы до T160), дописываются.
void Session::mergeSharedInvitesLocked() {
    if (!state_ || !client_) return;
    try {
        const auto int64Of = [](const json &v) -> std::int64_t {
            if (v.is_string()) return std::strtoll(v.get<std::string>().c_str(), nullptr, 10);
            return v.is_number() ? v.get<std::int64_t>() : 0;
        };
        const auto snap = state_->snapshot();
        auto all = loadInvites();
        std::set<std::string> shared;
        int added = 0;
        if (snap.contains("invites") && snap["invites"].is_array()) {
            for (const auto &i : snap["invites"]) {
                const auto linkId = b64ToHex(i.value("link_id", std::string()));
                const auto hex = b64ToHex(i.value("group_id", std::string()));
                const auto url = i.value("url", std::string());
                if (linkId.empty() || hex.empty() || url.empty()) continue;
                shared.insert(linkId);
                const auto address = groupAddress(hex);
                if (!all.contains(address) || !all[address].is_array()) all[address] = json::array();
                bool known = false;
                for (const auto &r : all[address]) {
                    if (r.value("linkId", std::string()) == linkId) known = true;
                }
                if (known) continue;
                json record{{"url", url}, {"linkId", linkId},
                            {"date", int64Of(i.value("created_ms", json(0))) / 1000}};
                if (const auto title = i.value("title", std::string()); !title.empty()) record["title"] = title;
                if (const auto expires = int64Of(i.value("expires_ms", json(0))); expires > 0) {
                    record["expiresAt"] = expires / 1000;
                }
                if (const auto limit = i.value("usage_limit", 0u); limit > 0) record["usageLimit"] = limit;
                if (i.value("requires_approval", false)) record["isRequestNeeded"] = true;
                all[address].push_back(record);
                ++added;
            }
        }
        if (added > 0) {
            writeStateFile("invites", all.dump());
            log("ссылки-приглашения с других своих устройств: " + std::to_string(added));
        }
        for (auto it = all.begin(); it != all.end(); ++it) {
            if (!isGroupAddress(it.key()) || !it.value().is_array()) continue;
            std::set<std::string> active;
            if (const auto g = client_->groupInfo(groupHex(it.key())); g && g->contains("inviteLinks")) {
                for (const auto &id : (*g)["inviteLinks"]) {
                    if (id.is_string()) active.insert(id.get<std::string>());
                }
            }
            for (const auto &r : it.value()) {
                const auto linkId = r.value("linkId", std::string());
                if (active.count(linkId) && !shared.count(linkId)) shareInviteLocked(it.key(), r);
            }
        }
    } catch (const std::exception &e) {
        log(std::string("ссылки-приглашения из журнала состояния: ") + e.what());
    }
}

json Session::listInvites(const std::string &address) {
    json out = json::array();
    if (!isGroupAddress(address)) return out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return out;
    // Как web listInvites: метаданные (название, срок, лимит, число вступивших, режим) — из журнала группы,
    // одни у всех ведущих приглашения; секрет ссылки (url) — из своего хранилища
    std::map<std::string, json> known;
    const auto all = loadInvites();
    if (all.contains(address) && all[address].is_array()) {
        for (const auto &r : all[address]) known[r.value("linkId", std::string())] = r;
    }
    const auto toInt = [](const json &v) -> std::int64_t {
        if (v.is_number_integer()) return v.get<std::int64_t>();
        if (v.is_number()) return static_cast<std::int64_t>(v.get<double>());
        if (v.is_string()) return std::atoll(v.get<std::string>().c_str());
        return 0;
    };
    const auto g = client_->groupInfo(groupHex(address));
    if (!g || !g->contains("invites") || !(*g)["invites"].is_array()) return out;
    for (const auto &meta : (*g)["invites"]) {
        const auto id = meta.value("id", std::string());
        const auto it = known.find(id);
        if (it == known.end()) continue;
        json rec{{"url", it->second.value("url", std::string())},
                 {"linkId", id},
                 {"date", toInt(meta.value("createdMs", json(0))) / 1000},
                 {"title", meta.value("title", std::string())},
                 {"expiresAt", toInt(meta.value("expiresMs", json(0))) / 1000},
                 {"usageLimit", toInt(meta.value("usageLimit", json(0)))},
                 {"usage", toInt(meta.value("uses", json(0)))},
                 {"isRequestNeeded", meta.value("requiresApproval", false)},
                 {"creator", meta.value("creator", std::string())}};
        out.push_back(std::move(rec));
    }
    // Порядок один на всех своих устройствах (T160): по нему выбирается основная ссылка.
    std::sort(out.begin(), out.end(), [](const json &a, const json &b) {
        const auto da = a.value("date", std::int64_t(0)), db = b.value("date", std::int64_t(0));
        return da != db ? da < db : a.value("linkId", std::string()) < b.value("linkId", std::string());
    });
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
    if (!changeGroup(address, json{{"invite_key_revoke", {{"link_id", hexToB64(linkId)}}}})) return false;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (state_) {
        try {
            if (!state_->submit(json{{"state_delete", {{"object", {{"kind", "OBJECT_KIND_GROUP_INVITE"}, {"key", linkId}}}}}})) {
                log("снятие ссылки-приглашения в журнале состояния не дошло");
            }
        } catch (const std::exception &e) {
            log(std::string("снятие ссылки-приглашения в журнале состояния: ") + e.what());
        }
    }
    return true;
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

// Проверка ссылки — у сервера группы (домен из ссылки, spec 028); группа запоминает этот домен.
json Session::inviteGroupLocked(const std::string &linkIdHex, const std::string &domain) {
    const auto resp = call(false, "group.invite.check",
        encodeMessage("parvane.group.v2.InviteCheckRequest", json{{"link_id", hexToB64(linkIdHex)}}), domain);
    auto out = decodeMessage("parvane.group.v2.InviteCheckResponse", resp);
    const auto hex = b64ToHex(out.contains("group") ? out["group"].value("id", std::string()) : std::string());
    if (!hex.empty() && !domain.empty()) inviteDomains_[hex] = domain;
    return out;
}

// ── заявки на вступление (ссылка с одобрением, D-04; T143) ───────────────────
// Сервер держит список заявок и отдаёт его владельцу и админам с правом
// приглашать; одобрение — запись AddMember внутри group.request.decide. О новой
// заявке сервер сообщает уведомлением о группе без смены версии.

bool Session::canDecideRequestsLocked(const std::string &hex) {
    if (!client_) return false;
    const auto g = client_->groupInfo(hex);
    if (!g || g->value("deleted", false) || !g->contains("members")) return false;
    if (g->value("owner", std::string()) == cfg_.self) return true;
    for (const auto &m : (*g)["members"]) {
        if (m.value("user", std::string()) != cfg_.self) continue;
        return m.value("role", 0) == kRoleAdmin && m.contains("rights") && m["rights"].is_object()
            && m["rights"].value("invite_users", false);
    }
    return false;
}

json Session::listJoinRequestsLocked(const std::string &hex) {
    json out = json::array();
    if (!canDecideRequestsLocked(hex)) return out;
    try {
        const auto gdomain = groupDomainLocked(hex);
        const json req{{"group", {{"domain", gdomain}, {"id", hexToB64(hex)}}}};
        const auto resp = call(false, "group.request.list",
                               encodeMessage("parvane.group.v2.RequestListRequest", req), gdomain);
        const auto list = decodeMessage("parvane.group.v2.RequestListResponse", resp);
        if (list.contains("requests") && list["requests"].is_array()) {
            for (const auto &r : list["requests"]) {
                const auto user = r.contains("user") && r["user"].is_object()
                    ? r["user"].value("address", std::string()) : std::string();
                if (user.empty()) continue;
                // int64 в proto3-JSON — строка
                const auto &ms = r.contains("requested_ms") ? r["requested_ms"] : r.value("requestedMs", json(0));
                const auto at = ms.is_string() ? std::atoll(ms.get<std::string>().c_str())
                    : ms.is_number() ? ms.get<long long>() : 0LL;
                json rec{{"user", user}, {"date", at / 1000}};
                // spec 024: по какой ссылке «по заявке» пришла заявка — одобренный считается вступившим по ней
                const auto link = r.contains("link_id") ? r.value("link_id", std::string()) : r.value("linkId", std::string());
                if (!link.empty()) rec["linkId"] = b64ToHex(link);
                out.push_back(std::move(rec));
            }
        }
    } catch (const std::exception &e) {
        log("список заявок группы " + hex + " не получен: " + e.what());
        return nullptr;
    }
    const auto count = static_cast<int>(out.size());
    const auto it = pendingRequests_.find(hex);
    if (it == pendingRequests_.end() || it->second != count) {
        pendingRequests_[hex] = count;
        publishGroupLocked(hex);
    }
    return out;
}

json Session::listJoinRequests(const std::string &address) {
    if (!ready_ || !isGroupAddress(address)) return nullptr;
    json out;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return nullptr;
        out = listJoinRequestsLocked(groupHex(address));
    }
    flushAsync();
    return out;
}

bool Session::decideJoinRequest(const std::string &address, const std::string &user, bool approve, const std::string &linkId) {
    if (!ready_ || !isGroupAddress(address)) return false;
    const auto hex = groupHex(address);
    bool ok = false;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return false;
        json reqJson;
        try {
            // Одобренный по ссылке «по заявке» считается во вступивших по ней (spec 024)
            json args{{"group", hex}, {"user", user}, {"approve", approve}};
            if (!linkId.empty()) args["viaLinkHex"] = linkId;
            reqJson = client_->call("groupRequestDecide", args);
        } catch (const std::exception &e) {
            log(std::string("решение по заявке отклонено движком: ") + e.what());
            return false;
        }
        try {
            const auto req = parseRequest(reqJson);
            call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
            ok = true;
        } catch (const std::exception &e) {
            log(std::string("решение по заявке отклонено сервером: ") + e.what());
            if (approve) resyncGroupLocked(hex);
        }
        if (ok) {
            log("заявка " + user + " в группу " + hex + (approve ? " — одобрена" : " — отклонена"));
            // Новый участник — ключи прежней эпохи ему не отдаются, нужна новая.
            const auto g = client_->groupInfo(hex);
            if (approve && g && g->value("epochStale", false) && canRotateLocked(hex)) {
                try {
                    rotateEpochLocked(hex);
                } catch (const std::exception &e) {
                    log(std::string("новая эпоха после одобрения заявки не начата: ") + e.what());
                    scheduleRotate(hex, kEpochRetryMs);
                }
            }
            persistLocked();
            if (const auto it = pendingRequests_.find(hex); it != pendingRequests_.end() && it->second > 0) {
                --it->second;
            }
            publishGroupLocked(hex);
        }
    }
    flushAsync();
    return ok;
}

json Session::checkInvite(const std::string &url) {
    const auto parsed = parseInvite(url);
    if (!ready_ || !parsed || parsed->value("kind", std::string()) != "v2") return nullptr;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return nullptr;
    try {
        const auto check = inviteGroupLocked(parsed->value("linkId", std::string()), parsed->value("domain", std::string()));
        const auto hex = b64ToHex(check.contains("group") ? check["group"].value("id", std::string()) : std::string());
        bool isMember = false;
        for (const auto &m : groupMembersLocked(hex)) {
            if (m == cfg_.self) isMember = true;
        }
        const auto members = check.value("members", json(0));
        // Описание и фото (T159) — из подписанного журнала группы (сервер отдаёт
        // его по ссылке), а не со слов сервера; журнал не-участника не храним.
        std::string about, avatar, avatarKey;
        if (!isMember && !hex.empty()) {
            try {
                syncGroupLocked(hex, url);
                if (const auto info = client_->groupInfo(hex)) {
                    about = info->value("about", std::string());
                    avatar = info->value("avatarFileId", std::string());
                    avatarKey = info->value("avatarKey", std::string());
                }
            } catch (const std::exception &e) {
                log(std::string("превью ссылки: журнал группы не прочитан: ") + e.what());
            }
            client_->groupForget(hex);
        }
        return json{{"address", groupAddress(hex)},
                    {"name", check.value("name", std::string())},
                    {"about", about},
                    {"avatar", avatar},
                    {"avatarKey", avatarKey},
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
            const auto check = inviteGroupLocked(linkId, parsed->value("domain", std::string()));
            const auto hex = b64ToHex(check.contains("group") ? check["group"].value("id", std::string()) : std::string());
            if (hex.empty()) throw V2Error("ERROR_CODE_NOT_FOUND");
            syncGroupLocked(hex, url);
            const auto req = parseRequest(client_->groupJoin(url));
            std::string resp;
            try {
                resp = call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
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
    // Разовая пересылка групп всем своим устройствам (spec 030): прежние версии не пересылали публичную группу без
    // сообщений (ключей эпохи у движка ещё не было) — устройство, привязанное позже вступления, её не видело.
    if (readStateFile("groups-reshared-v1").empty()) {
        json others = json::array();
        for (const auto &id : current) {
            if (id.is_string() && id.get<std::string>() != deviceId_) others.push_back(id);
        }
        try {
            if (!others.empty()) {
                const auto reqs = withNeedsLocked([&] { return client_->shareGroupsWithOwnDevices(others); });
                runRequestsLocked(reqs);
                persistLocked();
                log("группы пересланы своим устройствам разово (записей " + std::to_string(reqs.size()) + ")");
            }
            writeStateFile("groups-reshared-v1", "1");
        } catch (const std::exception &e) {
            log(std::string("разовая пересылка групп своим устройствам не удалась: ") + e.what());
        }
    }
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

// ── журнал истории аккаунта (spec 033) ─────────────────────────────────────

std::unique_ptr<HistorySession> Session::openHistorySession() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || !ready_) return nullptr;
    return HistorySession::open(*client_);
}

json Session::historyPeer(const std::string &address) {
    if (address.empty()) return nullptr;
    if (isGroupAddress(address)) {
        const auto hex = groupHex(address);
        if (hex.size() != 32) return nullptr;
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        return json{{"group", {{"domain", groupDomainLocked(hex)}, {"id", hexToB64(hex)}}}};
    }
    if (address.find('@') == std::string::npos) return nullptr;
    return json{{"user", {{"address", address}}}};
}

std::string Session::historyAddress(const json &peer) {
    if (!peer.is_object()) return {};
    if (peer.contains("user") && peer["user"].is_object()) return peer["user"].value("address", std::string());
    if (peer.contains("group") && peer["group"].is_object()) {
        const auto raw = fromBase64Safe(peer["group"].value("id", std::string()));
        if (!raw || raw->size() != 16) return {};
        static const char *d = "0123456789abcdef";
        std::string hex;
        for (unsigned char c : *raw) {
            hex.push_back(d[c >> 4]);
            hex.push_back(d[c & 15]);
        }
        return groupAddress(hex);
    }
    return {};
}

// ── журнал личного состояния (T098; spec 035 — через модель движка, state.v2) ─────────────────────────────

bool Session::openStateLocked() {
    if (state_) return true;
    if (!client_ || !ready_) return false;
    if (!host_ || !client_->hasStateKey()) {
        log("журнал состояния: нет ключа личного состояния");
        return false;
    }
    // Та же модель, что держит клиентское ядро: ключи личного состояния не выходят из движка, курсор журнала и
    // сведённое — в её хранилище (переживают перезапуск)
    state_ = std::make_unique<StateModel>(host_, [this](const engine::Step &st) { return driveLocked(st); });
    return true;
}

bool Session::pullStateLocked() {
    return state_->sync();
}

bool Session::stateAvailable() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return client_ && client_->hasStateKey();
}

bool Session::attachStateLocked() {
    state_.reset();
    if (!openStateLocked()) {
        log("журнал состояния недоступен — нет ключа личного состояния");
        return false;
    }
    const bool readable = pullStateLocked();
    if (stateRekeyPeer_ && !readable && !stateRekeyed_ && ++stateRekeyPeerTries_ <= kStateRekeyRetries) {
        // Записей под новым ключом ещё нет: пустой показ стёр бы папки и блок-лист у хоста, а своё перебило бы
        // перенос сменившего ключ устройства — ждём его записей
        state_.reset();
        log("журнал состояния: ключ сменён другим устройством, его записей ещё нет — повтор через 8 с");
        postDelayed(kStateRekeyRetryMs, [this] {
            {
                std::lock_guard<std::recursive_mutex> relock(engineMu_);
                if (!stateRekeyPeer_) return;
                outbox_.push_back(json{{"type", "stateReady"}});
            }
            flush();
        });
        return false;
    }
    if (stateRekeyPeer_ && !readable) stateRekeyed_ = true; // никто не перенёс за 2 мин — своё (журнал под ключом пуст)
    stateRekeyPeer_ = false;
    stateRekeyPeerTries_ = 0;
    if (stateRekeyed_ && !readable) {
        // Ключ состояния сменён, записей под новым ключом ещё нет: переносим сведённое модели под новый ключ
        // (объекты целиком: прежние записи новым ключом не читаются)
        const auto carry = stateCarry_ ? *stateCarry_ : state_->objects();
        const bool ok = state_->rewrite(carry);
        log(std::string("журнал состояния перенесён под новый ключ") + (ok ? "" : " — не полностью"));
    }
    stateRekeyed_ = false;
    stateCarry_.reset();
    log("журнал состояния подключён");
    mergeSharedInvitesLocked();
    return true;
}

bool Session::stateScheduledSent(const std::string &opIdB64) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return false;
    pullStateLocked();
    const auto key = b64ToHex(opIdB64);
    for (const auto &o : stateview::objectsOf(state_->objects(), "SCHEDULED")) {
        if (o.value("key", std::string()) == key && stateview::markValue(o, 1) > 0) return true;
    }
    return false;
}

void Session::stateChatCleared(const std::string &address, std::int64_t untilMs) {
    if (address.empty() || untilMs <= 0) return;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return;
    const json peer = isGroupAddress(address)
        ? json{{"group", {{"domain", groupDomainLocked(groupHex(address))}, {"id", hexToB64(groupHex(address))}}}}
        : json{{"user", {{"address", address}}}};
    if (!state_->mark("CHAT_CLEARED", stateview::peerKeyOf(peer), 2, static_cast<std::uint64_t>(untilMs))) {
        log("журнал состояния: запись не дошла (очистка чата)");
    }
}

bool Session::stateCall(const std::string &name, const json &args) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return false;
    // Запись объекта журнала по имени прежней функции `PvState` — объект вида с ключом, как у модели
    const auto parse = [](json v) { return v.is_string() ? json::parse(v.get<std::string>(), nullptr, false) : v; };
    bool ok = false;
    if (name == "plannerContainerSet") {
        ok = state_->set("PLANNER_CONTAINER", "",
                         json{{"ref", {{"domain", args.value("domain", std::string())}, {"id", hexToB64(args.value("idHex", std::string()))}}}});
    } else if (name == "cloudContainerSet") {
        const auto c = parse(args.value("containerJson", json()));
        if (!c.is_object() || !c.contains("ref") || !c["ref"].is_object()) return false;
        ok = state_->set("CLOUD_CONTAINER", c["ref"].value("domain", std::string()) + ":" + b64ToHex(c["ref"].value("id", std::string())), c);
    } else if (name == "callSet") {
        const auto c = parse(args.value("recordJson", json()));
        if (!c.is_object()) return false;
        ok = state_->set("CALL", b64ToHex(c.value("call_id", std::string())), c);
    } else {
        log("запись журнала состояния (" + name + "): нет такой записи");
        return false;
    }
    if (!ok) log("запись журнала состояния (" + name + "): не дошла");
    return ok;
}

void Session::stateMarkSent(const std::string &opIdB64) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return;
    if (!state_->mark("SCHEDULED", b64ToHex(opIdB64), 1, 1)) log("журнал состояния: запись не дошла (отметка отправки отложенного)");
}

json Session::stateFavedStickers() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return json::array();
    return state_->favedStickers();
}

bool Session::stateFaveSticker(const std::string &setId, const std::string &stickerId, bool on) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return false;
    return state_->submit(json{{"fave_sticker", {{"set_id", setId}, {"sticker_id", stickerId}, {"on", on}}}});
}

bool Session::stateWriteBlocked() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return false;
    return state_->writeBlocked();
}

// ── spec 036 (ENGINE-1): личное состояние по видам, список чатов, страницы истории ─────────────────────────────

json Session::stateView(const std::vector<std::string> &kinds) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_) return nullptr;
    auto names = json::array();
    for (const auto &k : kinds) names.push_back(stateview::kindName(k));
    auto v = host_->read("viewStateJson", json{{"kinds", names}});
    if (!v.is_object() || v.contains("error")) {
        log("показ личного состояния: " + (v.is_object() ? v.value("error", std::string()) : std::string("сбой")));
        return nullptr;
    }
    return v;
}

bool Session::stateSubmit(const std::string &kind, const json &desired, const json &shown) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_) return false;
    bool ok = true;
    for (const auto &args : stateview::setsFor(kind, desired, shown)) {
        const auto st = host_->step("stateSet", args);
        if (!st.ok()) {
            ok = false;
            log("личное состояние: запись " + args.value("kind", std::string()) + " отвергнута: " + st.error);
            continue;
        }
        // Нет связи — запись остаётся в модели неотправленной и уходит при подключении (stateConnect)
        driveLocked(st);
    }
    return ok;
}

bool Session::stateMark(const std::string &kind, const std::string &key, std::uint32_t field, std::uint64_t value) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_ || value == 0) return false;
    std::string be;
    for (int i = 7; i >= 0; --i) {
        const auto b = static_cast<char>((value >> (8 * i)) & 0xFF);
        if (be.empty() && b == 0) continue;
        be.push_back(b);
    }
    const auto st = host_->step("stateMark", json{{"kind", stateview::kindName(kind)}, {"key", key}, {"field", field},
                                                  {"value", toBase64(be)}});
    if (!st.ok()) {
        log("личное состояние: отметка " + kind + " отвергнута: " + st.error);
        return false;
    }
    driveLocked(st);
    return true;
}

bool Session::stateConnect() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return attachStateLocked();
}

bool Session::stateRefresh() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!openStateLocked()) return false;
    pullStateLocked();
    // Ссылки-приглашения, записанные другими своими устройствами (T160), — в свои (как прежний stateSync)
    mergeSharedInvitesLocked();
    return true;
}

json Session::chatList(const json &args) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_) return nullptr;
    auto r = host_->read("chatList", args.is_object() ? args : json::object());
    return (r.is_object() && !r.contains("error")) ? r : json();
}

json Session::historyPage(const json &args) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_) return nullptr;
    auto r = host_->read("historyPage", args.is_object() ? args : json::object());
    return (r.is_object() && !r.contains("error")) ? r : json();
}

bool Session::readTo(const json &mark) {
    if (!mark.is_object() || !mark.contains("chat")) return false;
    const auto id = history::b64OfUuid(mark.value("up_to_id", std::string()));
    const auto &ts = mark.contains("up_to_ts_ms") ? mark["up_to_ts_ms"] : json("0");
    if (id.empty()) return false;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_) return false;
    const auto st = host_->submit(json{{"read", {{"chat", mark["chat"]}, {"up_to", {{"ts_ms", ts.is_string() ? ts : json(ts.dump())}, {"id", id}}}}}});
    if (!st.ok()) {
        // Строки маркера нет в модели (ещё не пришла) — маркер операцией журнала: сведёт модель, квитанций нет
        const auto op = host_->step("rowsApply", json{{"ops_json", json::array({json{{"read", mark}}}).dump()},
                                                      {"now_ms", std::to_string(nowMs())},
                                                      {"journal", true}});
        if (!op.ok()) {
            log("прочтение моделью не принято: " + st.error + " / " + op.error);
            return false;
        }
        driveLocked(op);
        return true;
    }
    driveLocked(st);
    return true;
}

json Session::groupView(const std::string &address) {
    const auto peer = historyPeer(address);
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_ || !peer.is_object() || !peer.contains("group")) return nullptr;
    auto r = host_->read("viewGroup", json{{"group", peer["group"]}});
    return (r.is_object() && !r.contains("error")) ? r : json();
}

// Такт модели (spec 036 `engine_rows`): пачка журнала истории по сроку, контрольная точка, страховочный опрос
// журналов, повтор ожидавших исходящих. Шаг — не длиннее окна пачки журнала (сценарии сужают его до секунд).
void Session::scheduleModelTick() {
    if (modelTickScheduled_.exchange(true)) return;
    const auto window = cfg_.historyBatchMinMs > 0 ? cfg_.historyBatchMinMs : std::int64_t(5000);
    const auto every = std::clamp<std::int64_t>(window, 1000, 5000);
    postDelayed(every, [this] {
        modelTickScheduled_ = false;
        if (stopping_) return;
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            if (!host_) return; // модель закрыта (выход) — следующее открытие запустит такт снова
            driveLocked(host_->tick(nowMs()));
        }
        scheduleModelTick();
    });
}

json Session::capabilities(const std::string &chat) {
    const auto peer = historyPeer(chat);
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_ || peer.is_null()) return nullptr;
    auto c = host_->read("capabilities", json{{"chat", peer}});
    if (!c.is_object() || c.contains("error")) return nullptr;
    // proto3-JSON: ложные поля опущены; имена — как в схеме (snake_case), принимаем и camelCase
    json out = json::object();
    for (const char *k : {"send_text", "send_media", "send_stickers", "send_polls", "send_links", "delete_everyone", "pin",
                          "edit", "react", "forward", "reply"}) {
        std::string camel;
        for (std::size_t i = 0; k[i]; ++i) {
            if (k[i] == '_' && k[i + 1]) camel.push_back(char(std::toupper(static_cast<unsigned char>(k[++i]))));
            else camel.push_back(k[i]);
        }
        out[k] = c.value(k, c.value(camel, false));
    }
    return out;
}

bool Session::contentHidden(const std::string &chat, const std::string &from, const json &wire) {
    if (!isGroupAddress(chat) || !wire.is_object()) return false;
    const auto peer = historyPeer(chat);
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!host_ || peer.is_null()) return false;
    const auto r = host_->raw("contentHidden", json{{"chat", peer}, {"from", from}, {"wire", wire}});
    return r.is_object() && r.value("hidden", false);
}

std::optional<bool> Session::canSendContent(const std::string &chat, const json &wire) {
    const auto caps = capabilities(chat);
    if (!caps.is_object()) return std::nullopt;
    if (!caps.value("send_text", false)) return false;
    return !contentHidden(chat, cfg_.self, wire);
}

} // namespace parvane::v2
