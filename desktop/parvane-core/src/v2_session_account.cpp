// Parvane fork: жизненный цикл аккаунта в v2-сессии (spec 029) — порт web `v2/controller.ts`: удаление
// аккаунта и удалённые собеседники (spec 027), смена ника своя и собеседника (spec 026), выход и отзыв
// своих устройств (ENG-04), копия корня для администратора и жалобы (spec 024), ключ восстановления через
// Telegram и копия ключей аккаунта (spec 015). Методы *Locked — под engineMu_.
#include "parvane/v2_session.h"

#include "parvane/crypto.h"
#include "parvane/keybundle.h"
#include "parvane/storecrypt.h"
#include "parvane/v2_content.h"
#include "parvane/v2_control.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

#include <chrono>
#include <cstdio>
#include <thread>

namespace parvane::v2 {

namespace {

// Как web controller.ts
constexpr std::int64_t kRekeyAdminDelayMs = 30000;
constexpr std::int64_t kBundleFirstDelayMs = 8000;
constexpr std::int64_t kBundleRefreshMs = 60 * 1000;
constexpr std::size_t kBundleMaxBytes = 250000;
constexpr auto kTelegramCheckTtl = std::chrono::seconds(60);
constexpr auto kEscrowCheckTtl = std::chrono::seconds(60);
constexpr std::int64_t kLegacyBundleWaitMs = 45000;
constexpr std::int64_t kLegacyBundlePollMs = 3000;
constexpr std::int64_t kEpochRetryMsShared = 11000;

std::int64_t epochMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string codeOf(const std::exception &e) {
    if (const auto *v = dynamic_cast<const V2Error *>(&e)) return v->code();
    return e.what();
}

std::string trim(const std::string &s) {
    const auto first = s.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    return s.substr(first, s.find_last_not_of(" \t\r\n") - first + 1);
}

} // namespace

// ── собеседники: удалённые аккаунты и смена ника ───────────────────────────

bool Session::isDeletedLog(const std::string &resp) const {
    try {
        return decodeMethodResponse("identity.device.log_sync_anon", resp).value("deleted", false);
    } catch (const std::exception &) {
        return false;
    }
}

// Ответ log_sync собеседника (как web refreshPeerLog): удалён — событие peerDeleted; иначе принять;
// смена корня — KEY-1; ник сменён — перенос чата. false — журнала нет (удалён).
bool Session::absorbPeerLogLocked(const std::string &user, const std::string &resp) {
    if (isDeletedLog(resp)) {
        outbox_.push_back(json{{"type", "peerDeleted"}, {"user", user}});
        return false;
    }
    const auto verdict = client_->ingestLog(user, resp);
    if (verdict == "rootChanged") acceptPeerRootLocked(user);
    if (verdict == "moved" || verdict == "renamed") followPeerRenameLocked(user, verdict);
    rekeyAfterDeviceRemovalLocked();
    return true;
}

bool Session::checkPeerDeleted(const std::string &user) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (user == cfg_.self || !client_ || !ready_) return false;
        std::string resp;
        try {
            resp = call(true, "identity.device.log_sync_anon",
                encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                              json{{"user", {{"address", user}}}, {"after_version", std::to_string(client_->logVersion(user))}}),
                destOfUser(user));
        } catch (const std::exception &e) {
            log(std::string("проверка удалённого аккаунта не удалась: ") + e.what());
            return false;
        }
        if (!isDeletedLog(resp)) return false;
        outbox_.push_back(json{{"type", "peerDeleted"}, {"user", user}});
    }
    flushAsync();
    return true;
}

// spec 026: журнал собеседника закрыт сменой ника ('moved') — дочитать журнал нового адреса; журнал —
// продолжение прежнего адреса ('renamed') — перенести чат. Ключ безопасности прежний: предупреждения нет.
void Session::followPeerRenameLocked(const std::string &user, const std::string &verdict) {
    auto str = [](const json &v) { return v.is_string() ? v.get<std::string>() : std::string(); };
    std::string from = verdict == "renamed" ? str(client_->call("peerRenamedFrom", json{{"user", user}})) : user;
    const std::string to = verdict == "renamed" ? user : str(client_->call("peerRenamedTo", json{{"user", user}}));
    if (from.empty() || to.empty()) return;
    if (verdict == "moved") {
        const auto resp = call(true, "identity.device.log_sync_anon",
            encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                          json{{"user", {{"address", to}}}, {"after_version", std::to_string(client_->logVersion(to))}}),
            destOfUser(to));
        if (client_->ingestLog(to, resp) != "renamed") {
            // Перенос уже был (повторное чтение) либо журналы не связаны
            if (str(client_->call("peerRenamedFrom", json{{"user", to}})) != from) return;
        }
        if (const auto prev = str(client_->call("peerRenamedFrom", json{{"user", to}})); !prev.empty()) from = prev;
    }
    {
        std::lock_guard<std::mutex> lk(peersMu_);
        peers_.erase(from);
    }
    persistLocked();
    log("собеседник сменил ник (журнал v" + std::to_string(client_->logVersion(to)) + ")");
    outbox_.push_back(json{{"type", "peerRenamed"}, {"from", from}, {"to", to}});
}

// ENG-06: у участника ушло устройство — группе нужна новая эпоха. Владелец — сразу, админы — позже.
void Session::rekeyAfterDeviceRemovalLocked() {
    if (!client_) return;
    json pending;
    try {
        pending = client_->call("groupsRekeyPending");
    } catch (const std::exception &) {
        return;
    }
    for (const auto &h : pending) {
        if (!h.is_string()) continue;
        const auto hex = h.get<std::string>();
        if (!canRotateLocked(hex)) continue;
        const auto g = client_->groupInfo(hex);
        scheduleRotate(hex, g && g->value("owner", std::string()) == cfg_.self ? 0 : kRekeyAdminDelayMs);
    }
}

// ── удаление аккаунта (spec 027) ───────────────────────────────────────────

json Session::deleteAccount(const std::string &password) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || !ready_) return json{{"result", "failed"}};
    try {
        call(false, "identity.session.reauth",
             encodeMessage("parvane.identity.v2.SessionReauthRequest", json{{"password", password}}));
    } catch (const std::exception &) {
        return json{{"result", "bad_password"}};
    }
    try {
        const auto resp = call(false, "identity.account.delete",
                               encodeMessage("parvane.identity.v2.AccountDeleteRequest", json::object()));
        const auto r = decodeMethodResponse("identity.account.delete", resp);
        const auto &at = r.contains("deletion_at_ms") ? r["deletion_at_ms"] : r.value("deletionAtMs", json(0));
        const auto ms = at.is_string() ? std::atoll(at.get<std::string>().c_str()) : at.is_number() ? at.get<long long>() : 0LL;
        log("аккаунт поставлен на удаление");
        return json{{"result", "ok"}, {"deletionAtMs", ms}};
    } catch (const std::exception &e) {
        log(std::string("удаление аккаунта не принято: ") + e.what());
        return json{{"result", "failed"}};
    }
}

// ── смена ника (spec 026) ──────────────────────────────────────────────────

json Session::renameAccount(const std::string &nick, const std::string &password, const std::string &recoveryKeyIn) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || !ready_) return json{{"result", "failed"}};
    const auto recoveryKey = trim(recoveryKeyIn);
    const auto newAddress = nick + "@" + domain_;
    try {
        call(false, "identity.session.reauth",
             encodeMessage("parvane.identity.v2.SessionReauthRequest", json{{"password", password}}));
    } catch (const std::exception &) {
        return json{{"result", "bad_password"}};
    }
    auto backup = readStateFile("root-backup");
    std::string serverBackup;
    const auto fetchServer = [&]() -> std::string {
        try {
            return fromBase64(fetchRootBackupStateLocked().value("backup", std::string()));
        } catch (const std::exception &) {
            return {};
        }
    };
    if (backup.empty()) backup = serverBackup = fetchServer();
    if (backup.empty()) return json{{"result", "no_backup"}};
    try {
        client_->call("importRootBackup", json{{"blob", toBase64(backup)}, {"recoveryKey", recoveryKey}});
    } catch (const std::exception &) {
        // Ключ мог быть выписан администратором заново: тогда копия под ним — на сервере
        if (serverBackup.empty()) serverBackup = fetchServer();
        if (serverBackup.empty() || serverBackup == backup) return json{{"result", "bad_key"}};
        try {
            client_->call("importRootBackup", json{{"blob", toBase64(serverBackup)}, {"recoveryKey", recoveryKey}});
        } catch (const std::exception &) {
            return json{{"result", "bad_key"}};
        }
    }
    json out;
    try {
        std::string body;
        try {
            body = fromBase64(client_->call("renamePrepare",
                json{{"newAddress", newAddress}, {"newLogin", nick}, {"recoveryKey", recoveryKey}}).get<std::string>());
        } catch (const std::exception &) {
            client_->call("forgetRoot");
            return json{{"result", "invalid"}};
        }
        std::string resp;
        try {
            resp = call(false, "identity.account.rename", body);
        } catch (const std::exception &e) {
            client_->call("forgetRoot");
            const auto code = codeOf(e);
            if (code.find("DUPLICATE") != std::string::npos) return json{{"result", "taken"}};
            if (code.find("INVALID") != std::string::npos) return json{{"result", "invalid"}};
            log("смена ника не принята: " + code);
            return json{{"result", "failed"}};
        }
        const auto r = decodeMessage("parvane.identity.v2.AccountRenameResponse", resp);
        client_->call("renameApply");
        // Копия корня под новым адресом уже на сервере (в том же запросе); ключ копии ключей аккаунта —
        // от нового адреса, копия отправится заново
        const auto sent = decodeMessage("parvane.identity.v2.AccountRenameRequest", body);
        if (const auto rb = sent.value("root_backup", sent.value("rootBackup", std::string())); !rb.empty()) {
            writeStateFile("root-backup", fromBase64(rb));
            writeStateFile("root-backup-sent", rb);
        }
        if (const auto key = keybundle::deriveBundleKey(recoveryKey, newAddress)) writeStateFile("bundle-key", *key);
        std::remove((cfg_.stateDir + "/bundle-sent").c_str());
        persistLocked();
        log("ник сменён");
        out = json{{"result", "ok"}, {"address", r.value("address", newAddress)}, {"token", r.value("token", std::string())}};
    } catch (const std::exception &e) {
        log(std::string("смена ника не удалась: ") + e.what());
        out = json{{"result", "failed"}};
    }
    try {
        client_->call("forgetRoot");
    } catch (const std::exception &) {
    }
    return out;
}

bool Session::followOwnRename(const std::string &engineSelf) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return false;
    try {
        const auto old = call(true, "identity.device.log_sync_anon",
            encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
                          json{{"user", {{"address", engineSelf}}}, {"after_version", std::to_string(client_->logVersion(engineSelf))}}),
            destOfUser(engineSelf));
        client_->ingestLog(engineSelf, old);
        const auto to = client_->call("ownRenamedTo");
        if (!to.is_string() || to.get<std::string>() != cfg_.self) {
            log("ник аккаунта сменён, но журнал прежнего адреса не ведёт на новый — нужна привязка");
            return false;
        }
        const auto fresh = call(false, "identity.device.log_sync",
            encodeMessage("parvane.identity.v2.DeviceLogSyncRequest", json{{"user", {{"address", cfg_.self}}}, {"after_version", "0"}}));
        runRequestsLocked(client_->call("renameFollow", json{{"logResponse", toBase64(fresh)}}));
        std::remove((cfg_.stateDir + "/bundle-sent").c_str());
        persistLocked();
        log("ник сменён на другом устройстве — устройство перешло на новый адрес");
        return true;
    } catch (const std::exception &e) {
        log(std::string("переход на новый ник не удался: ") + e.what());
        return false;
    }
}

void Session::renameGroupsPending() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || !ready_) return;
    try {
        if (client_->call("formerAddresses").empty()) return;
        const auto reqs = withNeedsJsonLocked([&] { return client_->call("renameGroupsPending"); });
        if (!reqs.is_array() || reqs.empty()) return;
        runRequestsLocked(reqs);
        persistLocked();
        log("участие в группах перенесено на новый ник (" + std::to_string(reqs.size()) + ")");
    } catch (const std::exception &e) {
        log(std::string("перенос ника в группах отложен: ") + e.what());
    }
}

// ── свои устройства: выход, отзыв, «украдено» ──────────────────────────────

bool Session::leave(std::int64_t timeoutMs) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return false;
    try {
        const auto reqs = client_->call("leave");
        if (!reqs.is_array() || reqs.empty()) throw std::runtime_error("движок не дал запись выхода");
        for (const auto &r : reqs) {
            const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  deadline - std::chrono::steady_clock::now()).count();
            if (left <= 0) throw V2Error("ERROR_CODE_UNAVAILABLE");
            // Повторов, как у call() для identity, здесь нет: срок выхода ограничен (NAT-16, WEB-11)
            const auto req = parseRequest(r);
            const auto dest = req.dest == domainNow() ? std::string() : req.dest;
            if (req.anon) {
                (void)callAnon(req.method, req.body, dest, left);
            } else {
                const auto c = idConnection();
                if (!c || !c->isOpen()) throw V2Error("ERROR_CODE_UNAVAILABLE");
                (void)c->request(req.method, req.body, left, dest);
            }
        }
        log("устройство вышло из журнала устройств");
        return true;
    } catch (const std::exception &e) {
        log(std::string("выход из журнала устройств не выполнен: ") + e.what());
        return false;
    }
}

bool Session::signOutDevice(const std::string &deviceId) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_ || deviceId.empty() || deviceId == deviceId_) return false;
        const auto own = client_->logDevices(cfg_.self);
        const auto v2 = own.contains("v2") && own["v2"].is_array() ? own["v2"] : json::array();
        if (std::find(v2.begin(), v2.end(), json(deviceId)) == v2.end()) return false;
        const auto outcome = client_->call("signOutDevice", json{{"deviceId", deviceId}});
        const auto requests = outcome.value("requests", json::array());
        if (requests.empty()) throw std::runtime_error("v2: выход без записи журнала");
        try {
            runRequestsLocked(json::array({requests[0]}));
        } catch (const std::exception &) {
            // Сервер запись не принял, а движок её уже применил — состояние заново из сохранённого
            client_.reset();
            state_.reset();
            if (id_) id_->close();
            throw;
        }
        persistLocked();
        log("устройство вышло по просьбе владельца (ключи прежние)");
        rekeyAfterDeviceRemovalLocked();
    }
    flushAsync();
    return true;
}

void Session::pollOwnDevices() {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return;
        try {
            checkOwnDevicesLocked();
        } catch (const std::exception &e) {
            log(std::string("журнал своих устройств: ") + e.what());
        }
    }
    flushAsync();
}

std::vector<std::string> Session::leftSskHolders() {
    std::vector<std::string> out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return out;
    for (const auto &id : client_->call("leftSskHolders")) {
        if (id.is_string()) out.push_back(id.get<std::string>());
    }
    return out;
}

// Запись отзыва в журнал устройств, затем ротации (отзыв и «украдено»), как web applyRevocation.
void Session::applyRevocationLocked(const json &outcome) {
    const auto requests = outcome.value("requests", json::array());
    if (requests.empty()) throw std::runtime_error("v2: отзыв без записи журнала");
    try {
        runRequestsLocked(json::array({requests[0]}));
    } catch (const std::exception &) {
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
    for (const auto &peer : outcome.value("pendingKeyShares", json::array())) {
        if (!peer.is_string()) continue;
        try {
            runRequestsLocked(withNeedsJsonLocked([&] { return client_->shareDeliveryKey(peer.get<std::string>()); }));
        } catch (const std::exception &e) {
            log("ключ доступа " + peer.get<std::string>() + " не роздан: " + e.what());
        }
    }
    for (const auto &h : outcome.value("pendingEpochs", json::array())) {
        if (h.is_string()) scheduleRotate(h.get<std::string>(), kEpochRetryMsShared);
    }
    persistLocked();
    if (outcome.contains("stateKeyVersion") && !outcome["stateKeyVersion"].is_null()) {
        state_.reset();
        pendingAppends_.clear();
        stateRekeyed_ = true;
        outbox_.push_back(json{{"type", "stateReady"}});
    }
    if (client_->ownSskExposed()) outbox_.push_back(json{{"type", "sskRotationNeeded"}});
    log("устройство отозвано (ротаций " + std::to_string(requests.size() - 1) + ")");
}

bool Session::reportDeviceStolen(const std::string &deviceId) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return false;
        // Запись отзыва — от текущей версии своего журнала
        checkOwnDevicesLocked();
        const auto left = client_->call("leftSskHolders");
        if (std::find(left.begin(), left.end(), json(deviceId)) == left.end()) return false;
        applyRevocationLocked(withNeedsJsonLocked([&] { return client_->call("reportDeviceStolen", json{{"deviceId", deviceId}}); }));
    }
    flushAsync();
    return true;
}

// ── описание сервера, копия корня для администратора, жалобы ───────────────

json Session::describeServerLocked() {
    if (!described_) described_ = preauth(cfg_.gatewayUrl, "server.describe", json::object(), cfg_.clientVersion);
    return *described_;
}

// Ключ администратора для копии корня: только если сервер объявил ровно закреплённый в сборке (как web
// pickEscrowKey); "" — страховки нет.
std::string Session::loadEscrowKeyLocked() {
    if (cfg_.pinnedEscrowKey.empty()) return {};
    try {
        const auto d = describeServerLocked();
        const auto announced = d.value("escrow_public_key", d.value("escrowPublicKey", std::string()));
        if (trim(announced) != trim(cfg_.pinnedEscrowKey)) return {};
        return fromBase64(trim(announced));
    } catch (const std::exception &e) {
        described_.reset();
        log(std::string("описание сервера не получено: ") + e.what());
        return {};
    }
}

void Session::sealRootEscrowLocked(const std::string &root32) {
    try {
        const auto key = loadEscrowKeyLocked();
        if (key.empty() || !client_) return;
        const auto escrow = client_->call("exportRootEscrow", json{{"escrowPublic", toBase64(key)}, {"rootSecret", toBase64(root32)}});
        writeStateFile("root-escrow", fromBase64(escrow.get<std::string>()));
    } catch (const std::exception &e) {
        log(std::string("копия корня для администратора не создана: ") + e.what());
    }
}

json Session::fetchRootBackupStateLocked() {
    return decodeMessage("parvane.identity.v2.RootBackupGetResponse", call(false, "identity.root.backup_get", std::string()));
}

std::string Session::submitReport(const json &report) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return "failed";
    std::string key;
    try {
        const auto d = describeServerLocked();
        key = d.value("report_public_key", d.value("reportPublicKey", std::string()));
    } catch (const std::exception &) {
        described_.reset();
        return "failed";
    }
    if (key.empty()) return "unavailable";
    try {
        const auto sealed = engineCall("sealReport", json{{"adminPublic", key}, {"reporter", cfg_.self},
                                                          {"plaintext", toBase64(report.dump())}});
        call(false, "identity.report.submit", encodeMethodRequest("identity.report.submit", json{{"sealed", sealed}}));
        return "sent";
    } catch (const std::exception &e) {
        log(std::string("жалоба не отправлена: ") + e.what());
        return codeOf(e).find("UNAVAILABLE") != std::string::npos ? "unavailable" : "failed";
    }
}

bool Session::isEscrowCopyMissing() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || readStateFile("root-backup").empty() || loadEscrowKeyLocked().empty()) return false;
    const auto now = std::chrono::steady_clock::now();
    if (now - escrowCheckAt_ < kEscrowCheckTtl) return escrowMissing_;
    try {
        escrowMissing_ = !fetchRootBackupStateLocked().value("has_escrow", false);
        escrowCheckAt_ = now;
        return escrowMissing_;
    } catch (const std::exception &) {
        return false;
    }
}

std::string Session::storeEscrowCopy(const std::string &recoveryKey) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_ || !ready_) return "failed";
    const auto backup = readStateFile("root-backup");
    if (backup.empty()) return "no_backup";
    std::string root;
    try {
        root = fromBase64(client_->call("importRootBackup", json{{"blob", toBase64(backup)}, {"recoveryKey", trim(recoveryKey)}})
                              .get<std::string>());
    } catch (const std::exception &) {
        return "bad_key";
    }
    std::string result = "failed";
    try {
        sealRootEscrowLocked(root);
        uploadRootBackupLocked();
        escrowCheckAt_ = {};
        result = fetchRootBackupStateLocked().value("has_escrow", false) ? "ok" : "failed";
    } catch (const std::exception &e) {
        log(std::string("копия корня для администратора не отправлена: ") + e.what());
    }
    std::fill(root.begin(), root.end(), '\0');
    client_->call("forgetRoot");
    return result;
}

// ── копия ключей аккаунта (spec 015) ───────────────────────────────────────

void Session::rememberBundleKeyLocked(const std::string &recoveryKey) {
    if (const auto key = keybundle::deriveBundleKey(recoveryKey, cfg_.self)) {
        writeStateFile("bundle-key", *key);
    } else {
        log("ключ копии ключей аккаунта не получен");
    }
}

std::string Session::buildGrantMaterialLocked() {
    if (!client_) return {};
    std::string material;
    try {
        material = client_->linkGrantMaterial();
    } catch (const std::exception &) {
        return {};
    }
    // Ключ копии ключей аккаунта — вместе с грантом (поле `bk`), копия корня — поле `rb`
    if (const auto bk = readStateFile("bundle-key"); bk.size() == 32) {
        material = keybundle::withBundleKey(material, toBase64(bk));
    }
    const auto backup = readStateFile("root-backup");
    return backup.empty() ? material : grantWithRootBackup(material, backup);
}

void Session::refreshKeyBundleLocked(bool force) {
    const auto bundleKey = readStateFile("bundle-key");
    if (!ready_ || !client_ || bundleKey.size() != 32) return;
    try {
        const auto material = buildGrantMaterialLocked();
        if (material.empty()) return;
        auto previous = json::parse(readStateFile("bundle-history"), nullptr, false);
        if (!previous.is_object()) previous = nullptr;
        json history = previous;
        if (cfg_.bundleHistory) {
            try {
                history = cfg_.bundleHistory(previous, force);
            } catch (const std::exception &) {
                history = previous;
            }
        }
        json payload{{"grant", toBase64(material)}};
        if (const auto p = client_->call("plannerKeysExport"); !p.is_null()) payload["planner"] = p.dump();
        payload["cloud"] = client_->call("cloudKeysExport").dump();
        if (history.is_object()) payload["history"] = history;
        // Ключи групп (spec 032): устройство, вошедшее ключом восстановления, видит группы сразу
        if (const auto g = client_->call("groupKeysExport"); g.is_array() && !g.empty()) payload["groups"] = g.dump();
        const auto mark = keybundle::digestHex(payload.dump());
        if (!force && readStateFile("bundle-sent") == mark) return;
        // Своё — поверх серверного, а не вместо: устройство, ещё не получившее «План», «Облако», группы или полную
        // историю (только что вошло), не должно стирать их из копии для следующих устройств
        json server;
        try {
            const auto current = fetchRootBackupStateLocked().value("key_bundle", std::string());
            if (!current.empty()) {
                if (const auto opened = keybundle::open(bundleKey, cfg_.self, fromBase64(current))) server = *opened;
            }
        } catch (const std::exception &e) {
            log(std::string("копия ключей аккаунта: серверная не прочитана: ") + e.what());
            return; // без серверной копии не пишем — иначе могли бы её обеднить
        }
        if (server.is_object()) {
            const auto ownGroups = payload.value("groups", std::string("[]"));
            payload = keybundle::mergeWithServer(payload, server);
            if (const auto sg = server.value("groups", std::string()); !sg.empty()) {
                try {
                    const auto groups = client_->call("groupKeysMerge", json{{"own", ownGroups}, {"server", sg}});
                    if (groups.is_array() && !groups.empty()) payload["groups"] = groups.dump();
                } catch (const std::exception &e) {
                    log(std::string("копия ключей аккаунта: ключи групп не сведены: ") + e.what());
                }
            }
        }
        auto sealed = keybundle::seal(bundleKey, cfg_.self, payload);
        if (sealed.size() > kBundleMaxBytes && payload.contains("groups")) {
            // Групп слишком много — без них (их перешлёт другое своё устройство, T142)
            log("ключи групп не помещаются в копию ключей аккаунта — копия без них");
            payload.erase("groups");
            sealed = keybundle::seal(bundleKey, cfg_.self, payload);
        }
        if (sealed.empty()) return;
        if (sealed.size() > kBundleMaxBytes) {
            log("копия ключей аккаунта слишком велика (" + std::to_string(sealed.size()) + " байт) — не отправлена");
            return;
        }
        call(false, "identity.root.backup_set",
             encodeMessage("parvane.identity.v2.RootBackupSetRequest", json{{"key_bundle", toBase64(sealed)}}));
        writeStateFile("bundle-sent", mark);
        if (history.is_object()) writeStateFile("bundle-history", history.dump());
        log("копия ключей аккаунта обновлена на сервере");
    } catch (const std::exception &e) {
        log(std::string("копия ключей аккаунта не обновлена: ") + e.what());
    }
}

json Session::fetchKeyBundle() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    const auto key = readStateFile("bundle-key");
    if (!ready_ || key.size() != 32) return nullptr;
    try {
        const auto bundle = fetchRootBackupStateLocked().value("key_bundle", std::string());
        if (bundle.empty()) return nullptr;
        const auto opened = keybundle::open(key, cfg_.self, fromBase64(bundle));
        return opened ? *opened : json(nullptr);
    } catch (const std::exception &) {
        return nullptr;
    }
}

// Ключи групп из копии ключей аккаунта (spec 032): движок принимает их как пересылку своего устройства, журналы
// незнакомых групп дочитываются сразу (`groupChanged` → syncGroupLocked) — группы появляются, не дожидаясь, пока
// другое своё устройство выйдет в сеть и перешлёт их (T142).
void Session::applyBundleGroups(const std::string &groupsJson) {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return;
        applyBundleGroupsLocked(groupsJson);
    }
    flushAsync();
}

void Session::applyBundleGroupsLocked(const std::string &groupsJson) {
    try {
        const auto events = client_->call("groupKeysImport", json{{"json", groupsJson}});
        std::vector<json> pending;
        std::size_t groups = 0;
        if (events.is_array()) {
            for (const auto &ev : events) {
                if (ev.is_object() && ev.value("type", std::string()) == "groupChanged") ++groups;
                pending.push_back(ev);
            }
        }
        absorbLocked(std::move(pending));
        persistLocked();
        log("ключи групп из копии ключей аккаунта применены (групп " + std::to_string(groups) + ")");
    } catch (const std::exception &e) {
        log(std::string("ключи групп из копии ключей аккаунта не применены: ") + e.what());
    }
}

// ── ключ восстановления через Telegram (spec 015) ──────────────────────────

std::string Session::sendKeyToTelegram(const std::string &recoveryKey) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!ready_ || !client_) return "failed";
    try {
        call(false, "identity.recovery.tg_send",
             encodeMessage("parvane.identity.v2.RecoveryTgSendRequest", json{{"recovery_key", trim(recoveryKey)}}));
        // Ключ в руках — заодно заводим копию ключей аккаунта (аккаунт до spec 015)
        if (readStateFile("bundle-key").size() != 32) {
            rememberBundleKeyLocked(recoveryKey);
            refreshKeyBundleLocked(true);
        }
        return "ok";
    } catch (const std::exception &e) {
        const auto code = codeOf(e);
        if (code == "ERROR_CODE_NOT_FOUND") return "no_telegram";
        if (code == "ERROR_CODE_INVALID") return "bad_key";
        log("ключ восстановления в Telegram не отправлен: " + code);
        return "failed";
    }
}

// Ключ нового корня уходит владельцу в Telegram после готовности; окно с ключом — только если туда он не
// ушёл (сервер без бота — окно сразу).
void Session::queueRecoveryKeyLocked(const std::string &recoveryKey) {
    recoveryKeyShown_ = false;
    bool bot = false;
    try {
        const auto d = describeServerLocked();
        bot = !d.value("telegram_bot", d.value("telegramBot", std::string())).empty();
    } catch (const std::exception &) {
        described_.reset();
    }
    if (!bot) {
        recoveryKeyShown_ = true;
        if (cfg_.onRecoveryKey) cfg_.onRecoveryKey(recoveryKey);
        return;
    }
    telegramKey_ = recoveryKey;
    writeStateFile("pending-recovery-key", recoveryKey);
}

void Session::flushTelegramKeyLocked() {
    if (telegramKey_.empty()) telegramKey_ = readStateFile("pending-recovery-key");
    if (telegramKey_.empty()) return;
    const auto key = telegramKey_;
    const auto result = sendKeyToTelegram(key);
    if (result == "ok") {
        telegramKey_.clear();
        std::remove((cfg_.stateDir + "/pending-recovery-key").c_str());
        log("ключ восстановления отправлен владельцу в Telegram");
        return;
    }
    // В Telegram ключ не ушёл — показываем окном, иначе он пропал бы; при сбое связи отправку повторим
    if (!recoveryKeyShown_) {
        recoveryKeyShown_ = true;
        if (cfg_.onRecoveryKey) cfg_.onRecoveryKey(key);
    }
    if (result != "failed") {
        telegramKey_.clear();
        std::remove((cfg_.stateDir + "/pending-recovery-key").c_str());
    }
}

bool Session::hasTelegram() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    const auto now = std::chrono::steady_clock::now();
    if (now - telegramCheckAt_ < kTelegramCheckTtl) return telegramLinked_;
    try {
        telegramLinked_ = fetchRootBackupStateLocked().value("telegram", false);
        telegramCheckAt_ = now;
        return telegramLinked_;
    } catch (const std::exception &) {
        return false;
    }
}

bool Session::canSendKeyToTelegram() {
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || readStateFile("root-backup").empty() || readStateFile("bundle-key").size() == 32) return false;
    }
    return hasTelegram();
}

// Устройство без копии ключей (аккаунт до spec 015): владелец ответил боту ключом — заводим копию.
void Session::adoptTelegramKeyLocked() {
    const auto backup = readStateFile("root-backup");
    if (!ready_ || !client_ || readStateFile("bundle-key").size() == 32 || backup.empty()) return;
    if (!hasTelegram()) return;
    const auto polled = pollTelegramKey(false);
    const auto key = polled.is_object() ? polled.value("recovery_key", std::string()) : std::string();
    if (key.empty()) return;
    try {
        client_->call("importRootBackup", json{{"blob", toBase64(backup)}, {"recoveryKey", key}});
    } catch (const std::exception &) {
        client_->call("forgetRoot");
        return;
    }
    client_->call("forgetRoot");
    rememberBundleKeyLocked(key);
    log("ключ восстановления получен из ответа владельца боту — заводим копию ключей аккаунта");
    refreshKeyBundleLocked(true);
}

std::string Session::requestTelegramKey(bool again) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!needsLinking_ || ready_ || !id_) return "failed";
    try {
        call(false, "identity.recovery.tg_request",
             encodeMessage("parvane.identity.v2.RecoveryTgRequestRequest",
                           json{{"client", cfg_.deviceDescription}, {"again", again}}));
        return "sent";
    } catch (const std::exception &e) {
        const auto code = codeOf(e);
        if (code == "ERROR_CODE_NOT_FOUND") return "no_telegram";
        if (code == "ERROR_CODE_RATE_LIMITED") return "limit";
        log("запрос ключа через Telegram не отправлен: " + code);
        return "failed";
    }
}

json Session::pollTelegramKey(bool done) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!id_) return nullptr;
    try {
        return decodeMessage("parvane.identity.v2.RecoveryTgPollResponse",
            call(false, "identity.recovery.tg_poll", encodeMessage("parvane.identity.v2.RecoveryTgPollRequest", json{{"done", done}})));
    } catch (const std::exception &) {
        return nullptr;
    }
}

KeyJoinOutcome Session::joinWithRecoveryKey(const std::string &recoveryKeyIn, bool viaTelegram) {
    const auto recoveryKey = keybundle::pickRecoveryKey(recoveryKeyIn);
    json payload;
    std::string bundleKey;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (ready_ || !needsLinking_ || !id_ || storageKey_.size() != 32) return {"failed", {}, {}, nullptr};
        json state;
        try {
            state = fetchRootBackupStateLocked();
        } catch (const std::exception &e) {
            log(std::string("копия корня не получена: ") + e.what());
            return {"failed", {}, {}, nullptr};
        }
        const auto backup = state.value("backup", std::string());
        if (backup.empty()) return {"no_backup", {}, {}, nullptr};
        try {
            (void)importRootBackupFor(cfg_.self, fromBase64(backup), recoveryKey);
        } catch (const std::exception &) {
            return {"bad_key", {}, {}, nullptr};
        }
        if (const auto key = keybundle::deriveBundleKey(recoveryKey, cfg_.self)) bundleKey = *key;
        if (!bundleKey.empty() && !state.value("key_bundle", std::string()).empty()) {
            if (const auto opened = keybundle::open(bundleKey, cfg_.self, fromBase64(state.value("key_bundle", std::string())))) {
                payload = *opened;
            } else {
                // Копия есть, но не открылась (испорчена, другой формат): «восстановление корнем» отозвало бы все
                // прежние устройства — это не то, о чём просили
                log("копия ключей аккаунта на сервере не открылась — вход по ней невозможен");
                return {"failed", {}, {}, nullptr};
            }
        }
    }
    // Ключ пришёл ответом боту: действующее устройство аккаунта без копии заведёт её само — ждём
    if (!bundleKey.empty() && payload.is_null() && viaTelegram) {
        log("копии ключей аккаунта на сервере нет — ждём, заведёт ли её другое устройство");
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kLegacyBundleWaitMs);
        while (payload.is_null() && std::chrono::steady_clock::now() < deadline && !stopping_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(kLegacyBundlePollMs));
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            try {
                const auto bundle = fetchRootBackupStateLocked().value("key_bundle", std::string());
                if (!bundle.empty()) {
                    if (const auto opened = keybundle::open(bundleKey, cfg_.self, fromBase64(bundle))) payload = *opened;
                }
            } catch (const std::exception &) {
            }
        }
    }
    if (bundleKey.empty() || payload.is_null()) {
        log("копии ключей аккаунта на сервере нет — восстановление корнем");
        return {recoverWithKey(recoveryKey), {}, {}, nullptr};
    }
    std::string material;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        try {
            const auto ownLog = call(false, "identity.device.log_sync",
                encodeMessage("parvane.identity.v2.DeviceLogSyncRequest", json{{"user", {{"address", cfg_.self}}}, {"after_version", "0"}}));
            material = keybundle::withBundleKey(keybundle::withFreshLog(fromBase64(payload.value("grant", std::string())), ownLog),
                                                toBase64(bundleKey));
        } catch (const std::exception &e) {
            log(std::string("вход по ключу восстановления не удался: ") + e.what());
            return {"failed", {}, {}, nullptr};
        }
    }
    joinWithGrant(material);
    // Запись в журнал прошла, а подъём сорвался на временной ошибке — сессия повторяет сама; «не удалось» тут было
    // бы неправдой (устройство входило в фоне, а группы и «План» из копии не применялись)
    if (!waitReady(60000) && (needsLinking_ || stopping_ || !waitReady(120000))) return {"failed", {}, {}, nullptr};
    log("устройство привязано ключом восстановления (прежние устройства остались)");
    if (const auto groups = payload.value("groups", std::string()); !groups.empty()) applyBundleGroups(groups);
    return {"ok", payload.value("planner", std::string()), payload.value("cloud", std::string()),
            payload.contains("history") ? payload["history"] : json(nullptr)};
}

// После запуска: копия корня на сервер, ключ восстановления — в Telegram, копия ключей аккаунта — сразу и
// по таймеру (как web startRecoveryUpkeep).
void Session::ackJoined() {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    std::remove((cfg_.stateDir + "/joined-unacked").c_str());
}

void Session::startRecoveryUpkeepLocked() {
    // Устройство вошло в журнал (ключом восстановления, грантом другого устройства, повтором после обрыва): хосту —
    // забрать из копии ключей аккаунта группы, «План», «Облако», историю и отозвать оффер привязки
    if (!readStateFile("joined-unacked").empty()) outbox_.push_back(json{{"type", "joined"}});
    try {
        uploadRootBackupLocked();
    } catch (const std::exception &e) {
        log(std::string("копия корня на сервер не ушла: ") + e.what());
    }
    flushTelegramKeyLocked();
    if (!recoveryUpkeepScheduled_) {
        recoveryUpkeepScheduled_ = true;
        scheduleRecoveryUpkeep();
    }
    // Только что привязанное устройство сначала забирает историю из копии
    if (justJoined_) {
        justJoined_ = false;
        return;
    }
    postDelayed(kBundleFirstDelayMs, [this] {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        refreshKeyBundleLocked(false);
    });
}

void Session::scheduleRecoveryUpkeep() {
    postDelayed(kBundleRefreshMs, [this] {
        {
            std::lock_guard<std::recursive_mutex> lk(engineMu_);
            if (ready_ && client_) {
                flushTelegramKeyLocked();
                refreshKeyBundleLocked(false);
                adoptTelegramKeyLocked();
            }
        }
        scheduleRecoveryUpkeep();
    });
}

} // namespace parvane::v2
