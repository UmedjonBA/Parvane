// Parvane Android (spec 031): вход (ID-01: доказательство ключа устройства), регистрация, 2FA, сессия v2 и
// разбор её событий в события шва — только протокол v2, как desktop parvane_client_auth.cpp / HandleV2Event.
#include "jni_internal.h"
#include "v2_bridge.h"

#include <parvane/gateway_ws_transport.h>
#include <parvane/local_files.h>
#include <parvane/messenger.h>
#include <parvane/storecrypt.h>
#include <parvane/v2_engine.h>

#include <chrono>
#include <thread>

namespace pvjni {

std::mutex g_v2Mu;
std::shared_ptr<parvane::v2::Session> g_v2;
std::shared_ptr<parvane::v2::Control> g_control;

std::shared_ptr<parvane::v2::Session> v2Any() {
    std::lock_guard<std::mutex> lk(g_v2Mu);
    return g_v2;
}

std::shared_ptr<parvane::v2::Session> v2Ready() {
    std::lock_guard<std::mutex> lk(g_v2Mu);
    return (g_v2 && g_v2->isReady()) ? g_v2 : nullptr;
}

// Пока сессия поднимается (вход, рестарт), отправка ждёт исхода запуска.
std::shared_ptr<parvane::v2::Session> v2ReadyForSend() {
    const auto s = v2Any();
    if (!s) return nullptr;
    if (!s->isReady() && !s->needsLinking()) s->waitReady(10000);
    return s->isReady() ? s : nullptr;
}

std::shared_ptr<parvane::v2::Session> v2NeedsLinking() {
    std::lock_guard<std::mutex> lk(g_v2Mu);
    return (g_v2 && g_v2->needsLinking()) ? g_v2 : nullptr;
}

std::shared_ptr<parvane::v2::Session> v2AwaitNeedsLinking() {
    const auto s = v2Any();
    if (!s) return nullptr;
    if (!s->isReady() && !s->needsLinking()) s->waitReady(15000);
    return s->needsLinking() ? s : nullptr;
}

std::shared_ptr<parvane::v2::Control> control() {
    std::lock_guard<std::mutex> lk(g_v2Mu);
    return g_control;
}

std::string v2StateDir(const std::string &address) { return storeDir() + "/v2-" + safePart(address); }

namespace {

std::string gatewayUrl() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_gatewayUrl;
}

void saveSession(const std::string &address, const std::string &token) {
    parvane::storecrypt::writeFile(storeDir() + "/session.json", json{{"self", address}, {"token", token}}.dump());
}

// Секрет доверия 2FA: устройство, однажды подтверждённое в Telegram, входит без подтверждения.
std::string trustPath(const std::string &address) { return storeDir() + "/trust-" + safePart(address) + ".txt"; }
std::string readTrust(const std::string &address) {
    auto s = parvane::storecrypt::readFile(trustPath(address));
    if (const auto nl = s.find('\n'); nl != std::string::npos) s.resize(nl);
    return s;
}
void writeTrust(const std::string &address, const std::string &secret) {
    if (!address.empty() && !secret.empty()) parvane::storecrypt::writeFile(trustPath(address), secret);
}

// Владелец каталога: вход другим адресом не получает данных прежнего (один аккаунт на процесс; ревью 21 окт).
std::string ownerPath() { return storeDir() + "/account-owner"; }
void adoptAccount(const std::string &address) {
    const auto owner = parvane::storecrypt::readFile(ownerPath());
    if (!owner.empty() && owner != address) wipeAccountData("вход другим аккаунтом");
    parvane::storecrypt::allowWrites();
    parvane::storecrypt::writeFile(ownerPath(), address);
}

std::string canonicalAddress(std::string input, const std::string &domain) {
    for (auto &c : input) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    while (!input.empty() && std::isspace(static_cast<unsigned char>(input.back()))) input.pop_back();
    while (!input.empty() && std::isspace(static_cast<unsigned char>(input.front()))) input.erase(input.begin());
    if (input.empty() || input.find('@') != std::string::npos) return input;
    return input + "@" + domain;
}

std::string serverDomainOr(const std::string &fallback) {
    try {
        const auto info = parvane::v2::account::describeServer(gatewayUrl(), "android");
        if (!info.domain.empty()) return info.domain;
    } catch (const std::exception &e) {
        LOGE("server.describe: %s", e.what());
    }
    return fallback;
}

std::shared_ptr<parvane::v2::Control> makeControl() {
    parvane::v2::ControlConfig cfg;
    cfg.gatewayUrl = gatewayUrl();
    cfg.clientVersion = "android";
    cfg.token = [] {
        std::lock_guard<std::mutex> lk(g_mu);
        return g_token;
    };
    cfg.log = [](const std::string &line) { LOGI("%s", line.c_str()); };
    return std::make_shared<parvane::v2::Control>(std::move(cfg));
}

// ── события сессии v2 ────────────────────────────────────────────────────────

std::mutex g_reactMu;
std::map<std::string, std::map<std::string, std::string>> g_reactions; // uuid → автор → эмодзи
std::map<std::string, bool> g_pinned;

json reactionsLocked(const std::string &uuid, const std::string &me) {
    std::map<std::string, json> by;
    for (const auto &[author, emoji] : g_reactions[uuid]) {
        auto &r = by[emoji];
        if (r.is_null()) r = json{{"emoji", emoji}, {"count", 0}, {"mine", false}};
        r["count"] = r["count"].get<int>() + 1;
        if (author == me) r["mine"] = true;
    }
    auto arr = json::array();
    for (auto &[e, r] : by) arr.push_back(r);
    return arr;
}

bool handleSessionEvent(const json &ev);

} // namespace

// Реакция/закреп: своя правка или пришедшая — событие meta (с авторами — переживает рестарт через журнал).
json metaEvent(const std::string &uuid, const std::optional<std::pair<std::string, std::string>> &reaction,
               std::optional<bool> pinned) {
    const auto me = self();
    std::lock_guard<std::mutex> lk(g_reactMu);
    if (reaction) {
        if (reaction->second.empty()) g_reactions[uuid].erase(reaction->first);
        else g_reactions[uuid][reaction->first] = reaction->second;
    }
    if (pinned) g_pinned[uuid] = *pinned;
    json by = json::object();
    for (const auto &[a, e] : g_reactions[uuid]) by[a] = e;
    return json{{"type", "meta"}, {"id", uuid}, {"reactions", reactionsLocked(uuid, me)}, {"by", by}, {"pinned", g_pinned[uuid]}};
}

std::string ownReactionOf(const std::string &uuid) {
    const auto me = self();
    std::lock_guard<std::mutex> lk(g_reactMu);
    const auto it = g_reactions.find(uuid);
    if (it == g_reactions.end()) return {};
    const auto r = it->second.find(me);
    return r == it->second.end() ? std::string() : r->second;
}

// Из журнала после рестарта: авторы реакций и закреп.
void restoreMeta(const std::string &uuid, const json &by, bool pinned) {
    std::lock_guard<std::mutex> lk(g_reactMu);
    if (by.is_object()) for (auto it = by.begin(); it != by.end(); ++it) if (it.value().is_string()) g_reactions[uuid][it.key()] = it.value();
    if (pinned) g_pinned[uuid] = true;
}

void resetReactions() {
    std::lock_guard<std::mutex> lk(g_reactMu);
    g_reactions.clear();
    g_pinned.clear();
}

void handleV2Event(const json &ev) {
    if (handleSessionEvent(ev)) return;
    const auto me = self();
    const auto in = parvane::v2::interpretDirect(ev, me);
    using Kind = parvane::v2::Incoming::Kind;
    if (in.kind == Kind::None) return;
    if (in.kind == Kind::Message || in.kind == Kind::Stub) {
        if (!markSeen(in.id)) return; // повтор
        noteMessage(in.id, in.from, in.chat, in.content);
        // P-46: в logcat — только id и вид
        LOGI("v2 ← %s msg %s (%s)", in.from == me ? "своё" : "входящее", in.id.c_str(),
             parvane::contentKind(in.content).c_str());
        auto msg = parvane::android_v2::messageEvent(in, me, nowSec());
        if (in.group && !groupKnown(in.chat)) {
            // Группа ещё не прочитана из журнала (первое сообщение обогнало список групп): Kotlin подтянет её
            // по флагу group; событие — сразу (шов объявит чат после syncGroups)
        }
        emit(msg);
        return;
    }
    if (in.kind == Kind::Read && in.from == me) {
        // Я прочитал на другом своём устройстве → входящие прочитаны
        if (!in.targets.empty()) emit(json{{"type", "read"}, {"ids", in.targets}});
        return;
    }
    for (const auto &uuid : in.targets) {
        const auto row = messageRow(uuid);
        if (!row) { LOGI("v2: мутация для неизвестного %s — пропуск", uuid.c_str()); continue; }
        switch (in.kind) {
        case Kind::Edit: {
            if (row->from != in.from || !in.content.is_object()) continue; // править можно только своё
            auto content = row->content;
            const auto nk = parvane::contentKind(in.content);
            if (nk == "location") {
                for (auto f = in.content.begin(); f != in.content.end(); ++f) content[f.key()] = f.value();
            } else if (parvane::contentKind(content) == "text") {
                content["text"] = in.content.value("text", std::string());
                content["entities"] = in.content.contains("entities") ? in.content["entities"] : json::array();
            } else {
                content["caption"] = in.content.value("text", std::string());
                content["entities"] = in.content.contains("entities") ? in.content["entities"] : json::array();
            }
            updateMessageContent(uuid, content);
            emit(json{{"type", "edited"}, {"id", uuid}, {"content", content}, {"edit_date", nowSec()}});
        } break;
        case Kind::Delete:
            if (row->from != in.from) continue; // удалить у всех можно только своё
            forgetMessage(uuid);
            emit(json{{"type", "deleted"}, {"id", uuid}});
            break;
        case Kind::Reaction:
            emit(metaEvent(uuid, std::make_pair(in.from, in.remove ? std::string() : in.emoji), std::nullopt));
            break;
        case Kind::Pin:
            emit(metaEvent(uuid, std::nullopt, !in.unpin));
            break;
        case Kind::Read:
            if (row->from != me) continue; // квитанция собеседника о МОЁМ сообщении
            emit(json{{"type", "outbox_read"}, {"id", uuid}, {"by", in.from}, {"at", in.ts ? in.ts : nowSec()}});
            break;
        default:
            break;
        }
    }
}

namespace {

bool handleSessionEvent(const json &ev) {
    const auto type = ev.value("type", std::string());
    const auto address = ev.value("address", std::string());
    if (type == "groupUpdated") {
        const auto info = ev.value("info", json::object());
        cacheGroupInfo(address, &info);
        std::vector<std::string> mem;
        for (const auto &m : info.value("members", json::array())) mem.push_back(m.value("user", std::string()));
        noteGroupMembers(address, mem);
        LOGI("группа v2 %s %s (v%llu)", address.c_str(), ev.value("isNew", false) ? "появилась" : "обновлена",
             static_cast<unsigned long long>(info.value("version", std::uint64_t(0))));
        emit(json{{"type", "group"}, {"group_id", address}, {"change", "v2"}, {"version", info.value("version", std::uint64_t(0))}});
        flushLinkedGroupRows(address);
        return true;
    }
    if (type == "groupLeft") {
        cacheGroupInfo(address, nullptr);
        forgetGroup(address);
        LOGI("группа v2 %s снята (исключены или удалена)", address.c_str());
        emit(json{{"type", "group"}, {"group_id", address}, {"change", "removed"}});
        return true;
    }
    if (type == "groupUnconfirmed") {
        emit(json{{"type", "group_unconfirmed"}, {"group_id", address}, {"members", ev.value("members", json::array())}});
        return true;
    }
    if (type == "peerRenamed") {
        // RENAME-1: собеседник сменил ник — тот же чат, служебное сообщение
        emit(json{{"type", "peer_renamed"}, {"from", ev.value("from", std::string())}, {"to", ev.value("to", std::string())}});
        return true;
    }
    if (type == "peerDeleted") {
        emit(json{{"type", "peer_deleted"}, {"user", ev.value("user", std::string())}});
        return true;
    }
    if (type == "peerRootChanged") {
        // KEY-1 v2 / NAT-10: предупреждение «ключ безопасности изменился» в чате
        LOGI("v2: у собеседника сменился корневой ключ");
        emit(json{{"type", "peer_root_changed"}, {"user", ev.value("user", std::string())}});
        return true;
    }
    if (type == "sskRotationNeeded") {
        std::thread([] {
            const auto s = v2Ready();
            if (!s) return;
            const auto state = s->sskState();
            if (!state.value("rotationNeeded", false)) return;
            if (state.value("hasRoot", false)) {
                LOGI("v2: смена SSK корнем: %s", s->rotateSsk(std::string()).c_str());
            } else {
                emit(json{{"type", "ssk_rotation_needed"}, {"has_backup", state.value("hasBackup", false)}});
            }
        }).detach();
        return true;
    }
    if (type == "privacy" || type == "privacySaved") {
        emit(json{{"type", type == "privacy" ? "privacy" : "privacy_saved"},
                  {"group_add_nobody", ev.value("groupAddNobody", false)},
                  {"strangers_allowed", ev.value("strangersAllowed", true)},
                  {"calls_nobody", ev.value("callsNobody", false)},
                  {"presence_nobody", ev.value("presenceNobody", false)}});
        return true;
    }
    if (type == "presence") {
        const auto from = ev.value("from", std::string());
        if (!from.empty() && !l2Active(from)) emit(json{{"type", "presence"}, {"from", from}, {"online", ev.value("online", false)}});
        return true;
    }
    if (type == "typing") {
        const auto chat = ev.value("chat", std::string());
        if (l2Active(chat)) return true;
        emit(json{{"type", "typing"}, {"from", ev.value("from", std::string())}, {"to", isGroupAddress(chat) ? chat : self()}});
        return true;
    }
    if (type == "ownDevicesAdded") {
        LOGI("v2: новое своё устройство (%zu)", ev.value("devices", json::array()).size());
        emit(json{{"type", "new_device"}, {"count", ev.value("devices", json::array()).size()}});
        return true;
    }
    if (type == "stateReady") {
        sectionsSessionChanged(); // «План», «Облако»: журнал состояния подключён
        emit(json{{"type", "state_ready"}});
        std::thread([] {
            startLinkingWorkers(); // роль «старого» устройства: опрос чужих офферов
            syncFromKeyBundle();   // снимок истории свежее применённого — с другого своего устройства
        }).detach();
        return true;
    }
    if (type == "authRejected") {
        // JWT не принят: экран входа (учётные данные сняты, данные — нет; повторный вход продолжит историю)
        LOGE("v2: отказ авторизации");
        emit(json{{"type", "session"}, {"state", "failed"}, {"reason", "auth"}});
        return true;
    }
    if (type == "needsLinking") {
        LOGI("v2: устройству нужна привязка");
        emit(json{{"type", "needs_linking"}});
        std::thread([] { startLinkOffer(); }).detach();
        return true;
    }
    if (type == "l2State") {
        const auto state = parvane::android_v2::l2StateEvent(ev);
        l2Store(state, /*save=*/true);
        emit(state);
        return true;
    }
    if (type == "groupL2") {
        const auto msg = parvane::android_v2::groupL2Event(ev, self(), nowSec());
        const auto id = msg.value("id", std::string());
        if (id.empty() || !markSeen(id)) return true;
        noteMessage(id, msg.value("from", std::string()), address, msg.value("content", json::object()));
        emit(msg);
        return true;
    }
    if (type == "callSignal") {
        // Сигнал звонка (отправитель проверен движком) — менеджеру звонков (jni_calls)
        handleCallSignal(ev.value("from", std::string()), ev.value("group", false), ev.value("signal", json::object()));
        return true;
    }
    if (type == "plannerChanged" || type == "cloudChanged") {
        sectionsEngineEvent(type == "plannerChanged" ? "planner" : "cloud", ev.value("id", std::string()));
        return true;
    }
    if (type == "legacyV1") return true; // v1 удалён
    return false;
}

std::atomic<bool> g_presenceRunning{false};

void presenceLoop() {
    while (g_presenceRunning) {
        if (presenceAllowed()) {
            if (const auto s = v2Ready()) {
                try { s->sendPresence(true); } catch (const std::exception &) {}
            }
        }
        for (int i = 0; i < 300 && g_presenceRunning; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

} // namespace

// Сессия v2 текущего аккаунта (адрес и JWT уже есть). Звать БЕЗ g_mu: сессия берёт JWT колбэком под ним.
void startSession() {
    std::string gw, me;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        gw = g_gatewayUrl;
        me = g_self;
    }
    if (me.empty()) return;
    {
        std::lock_guard<std::mutex> lk(g_v2Mu);
        if (g_v2) return;
        g_control = makeControl();
    }
    l2Load();
    parvane::v2::SessionConfig cfg;
    cfg.gatewayUrl = gw;
    cfg.self = me;
    cfg.token = [] {
        std::lock_guard<std::mutex> lk(g_mu);
        return g_token;
    };
    cfg.stateDir = v2StateDir(me);
    cfg.clientVersion = "android";
    cfg.deviceDescription = "Parvane Android";
    cfg.log = [](const std::string &m) { LOGI("%s", m.c_str()); };
    cfg.onEvent = [owner = me](const json &ev) {
        if (self() == owner) handleV2Event(ev); // событие прежнего аккаунта после выхода — мимо
    };
    cfg.bundleHistory = [](const json &previous, bool force) { return bundleHistory(previous, force); };
    cfg.onRecoveryKey = [](const std::string &key) {
        LOGI("v2: ключ восстановления выдан — показ пользователю");
        emit(json{{"type", "recovery_key"}, {"key", key}});
    };
    auto s = std::make_shared<parvane::v2::Session>(std::move(cfg));
    {
        std::lock_guard<std::mutex> lk(g_v2Mu);
        g_v2 = s;
    }
    s->start();
    if (!g_presenceRunning.exchange(true)) std::thread(presenceLoop).detach();
    LOGI("v2: сессия запускается (движок %s)", parvane::v2::engineVersion().c_str());
}

void stopSession() {
    g_presenceRunning = false;
    std::shared_ptr<parvane::v2::Session> s;
    std::shared_ptr<parvane::v2::Control> c;
    {
        std::lock_guard<std::mutex> lk(g_v2Mu);
        s = std::move(g_v2);
        c = std::move(g_control);
    }
    if (s) s->stop();
    if (c) c->close();
}

namespace {

// Память аккаунта — прочь (выход, вход другим): следующий не получает ничего прежнего.
void resetAccountMemory() {
    sectionsAccountReset();
    resetCalls();
    resetMessages();
    resetReactions();
    resetGroups();
    resetLinking();
    l2Forget();
}

} // namespace

} // namespace pvjni

using namespace pvjni;

extern "C" {

// server.describe → {domain, confirm ("telegram"|"email"|"none"), telegram_bot, registration:[…]}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeServerInfo(JNIEnv *env, jclass) {
    json out{{"domain", ""}, {"confirm", ""}, {"telegram_bot", ""}};
    try {
        std::string gw;
        { std::lock_guard<std::mutex> lk(g_mu); gw = g_gatewayUrl; }
        const auto info = parvane::v2::account::describeServer(gw, "android");
        out["domain"] = info.domain;
        out["confirm"] = info.confirm == "none" ? std::string() : info.confirm;
        out["telegram_bot"] = info.telegramBot;
        out["email_required"] = info.emailRequired;
        out["registration"] = info.registration;
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeServerDomain(JNIEnv *env, jclass) {
    return jout(env, serverDomainOr(std::string()));
}

// identity.session.issue → {ok, address, error_code, twofa_required, login_token, telegram_bot, confirm_required,
// deletion_at_ms}. loginToken — подтверждённый в Telegram токен второго фактора; cancelDeletion — восстановить
// аккаунт, ждущий удаления (spec 027).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeLogin(
        JNIEnv *env, jclass, jstring user, jstring password, jstring loginToken, jboolean cancelDeletion) {
    json out{{"ok", false}};
    try {
        (void)prepareForLogin();
        const auto address = canonicalAddress(jstr(env, user), serverDomainOr("local"));
        if (!parvane::accountfiles::isValidAddress(address)) {
            out["error_code"] = "ERROR_CODE_INVALID";
            return jreply(env, out);
        }
        parvane::v2::account::IssueRequest req;
        req.user = address;
        req.password = jstr(env, password);
        req.clientKind = "android";
        const auto stateDir = v2StateDir(address);
        req.deviceId = parvane::v2::Session::deviceIdFor(stateDir);
        // ID-01: устройство, уже привязанное к журналу, доказывает ключ по сохранённому состоянию движка
        req.deviceProof = parvane::v2::Session::sessionProofFor(stateDir, nowMs());
        req.loginToken = jstr(env, loginToken);
        req.trustSecret = readTrust(address);
        req.cancelDeletion = cancelDeletion == JNI_TRUE;
        std::string gw;
        { std::lock_guard<std::mutex> lk(g_mu); gw = g_gatewayUrl; }
        const auto r = parvane::v2::account::issueSession(gw, req, "android");
        writeTrust(address, r.trustSecret);
        out["address"] = r.address.empty() ? address : r.address;
        if (!r.errorCode.empty()) out["error_code"] = r.errorCode;
        if (r.twofaRequired) {
            out["twofa_required"] = true;
            out["login_token"] = r.loginToken;
            out["telegram_bot"] = r.telegramBot;
        }
        if (r.confirmRequired) out["confirm_required"] = true;
        if (r.deletionAtMs) out["deletion_at_ms"] = r.deletionAtMs;
        if (r.ok && !r.token.empty()) {
            const auto finalAddress = r.address.empty() ? address : r.address;
            adoptAccount(finalAddress);
            {
                std::lock_guard<std::mutex> lk(g_mu);
                g_self = finalAddress;
                g_token = r.token;
            }
            saveSession(finalAddress, r.token);
            out["ok"] = true;
        }
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
        LOGE("login: %s", e.what());
    }
    return jreply(env, out);
}

// identity.account.register → {ok, address, confirm_required, telegram_token, email_required, error_code}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRegister(
        JNIEnv *env, jclass, jstring user, jstring password, jstring email) {
    json out{{"ok", false}};
    try {
        (void)prepareForLogin();
        const auto address = canonicalAddress(jstr(env, user), serverDomainOr("local"));
        out["address"] = address;
        if (!parvane::accountfiles::isValidAddress(address)) {
            out["error_code"] = "ERROR_CODE_INVALID";
            return jreply(env, out);
        }
        std::string gw;
        { std::lock_guard<std::mutex> lk(g_mu); gw = g_gatewayUrl; }
        const auto r = parvane::v2::account::registerAccount(gw, address, jstr(env, password), jstr(env, email),
                                                             std::string(), "android");
        out["ok"] = r.ok;
        out["confirm_required"] = r.confirmRequired;
        out["telegram_token"] = r.telegramToken;
        out["email_required"] = r.emailRequired;
        if (!r.errorCode.empty()) out["error_code"] = r.errorCode;
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeRegisterStatus(JNIEnv *env, jclass, jstring user, jstring token) {
    try {
        std::string gw;
        { std::lock_guard<std::mutex> lk(g_mu); gw = g_gatewayUrl; }
        return parvane::v2::account::registerStatus(gw, jstr(env, user), jstr(env, token), "android") ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) {
        LOGE("register.status: %s", e.what());
        return JNI_FALSE;
    }
}

// identity.account.confirm_email → {ok, error_code}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeConfirmEmail(JNIEnv *env, jclass, jstring user, jstring code) {
    json out{{"ok", false}};
    try {
        std::string gw;
        { std::lock_guard<std::mutex> lk(g_mu); gw = g_gatewayUrl; }
        const auto err = parvane::v2::account::confirmEmail(gw, jstr(env, user), jstr(env, code), "android");
        out["ok"] = err.empty();
        if (!err.empty()) out["error_code"] = err;
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

// 2FA: enabled < 0 — прочитать; иначе включить/выключить (свежий пароль). → {ok, enabled, telegram_linked, error_code}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeTwoFactor(JNIEnv *env, jclass, jint enabled, jstring password) {
    json out{{"ok", false}};
    const auto c = control();
    if (!c) return jreply(env, jfail("failed"));
    try {
        const auto r = enabled < 0 ? parvane::v2::account::getTwoFactor(*c)
                                   : parvane::v2::account::setTwoFactor(*c, enabled > 0, jstr(env, password));
        writeTrust(self(), r.trustSecret);
        out = json{{"ok", true}, {"enabled", r.enabled}, {"telegram_linked", r.telegramLinked}, {"telegram_bot", r.telegramBot}};
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeChangePassword(JNIEnv *env, jclass, jstring oldPw, jstring newPw) {
    const auto c = control();
    if (!c) return jreply(env, jfail("failed"));
    try {
        parvane::v2::account::changePassword(*c, jstr(env, oldPw), jstr(env, newPw));
        return jreply(env, json{{"ok", true}});
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e)));
    }
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeStartSession(JNIEnv *, jclass) {
    std::string me;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_self.empty() || g_token.empty()) return JNI_FALSE;
        me = g_self;
    }
    try {
        startSession();
        emit(json{{"type", "session"}, {"state", "ready"}, {"self", me}});
        LOGI("сессия поднята");
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("startSession: %s", e.what());
        emit(json{{"type", "session"}, {"state", "failed"}, {"error_code", errorCodeOf(e)}});
        return JNI_FALSE;
    }
}

// Сеть вернулась (ConnectivityManager): ждущее переподключение — сразу.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeNetworkAvailable(JNIEnv *, jclass) {
    if (const auto s = v2Any()) s->reconnectNow();
}

// Состояние: {"ready","needsLinking","engine","self"} — диагностика и экраны входа.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeStatus(JNIEnv *env, jclass) {
    const auto s = v2Any();
    return jreply(env, json{{"ready", s && s->isReady()}, {"needsLinking", s && s->needsLinking()},
                            {"engine", parvane::v2::engineVersion()}, {"self", self()},
                            {"reconnectAttempts", s ? s->reconnectAttempts() : 0}});
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSelf(JNIEnv *env, jclass) { return jout(env, self()); }

// FAIL-1: истёкшая/отозванная сессия — снять только учётные данные; данные остаются (тот же аккаунт войдёт снова).
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeSessionExpired(JNIEnv *, jclass) {
    stopSession();
    std::lock_guard<std::mutex> lk(g_mu);
    g_token.clear();
    std::remove((storeDir() + "/session.json").c_str());
    LOGI("сессия истекла — учётные данные сняты, данные сохранены");
}

// Выход (NAT-16, как web/desktop): устройство уходит из журнала устройств (≤ 5 с), данные устройства стираются.
// Блокирующий — звать не с UI-потока.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeLogout(JNIEnv *, jclass) {
    const auto dir = storeDir();
    parvane::localfiles::setLogoutPending(dir);
    std::shared_ptr<parvane::v2::Session> s;
    std::shared_ptr<parvane::v2::Control> c;
    {
        std::lock_guard<std::mutex> lk(g_v2Mu);
        s = std::move(g_v2);
        c = std::move(g_control);
    }
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_self.clear();
        g_token.clear();
    }
    std::remove((dir + "/session.json").c_str());
    resetAccountMemory();
    if (s && s->isReady()) {
        const bool left = s->leave(5000);
        LOGI("выход — устройство %s журнала устройств", left ? "вышло из" : "не вышло (нет связи или отказ) из");
    }
    wipeAccountData("выход");
    if (s) s->stop();
    if (c) c->close();
    parvane::logpriv::forget();
    parvane::storecrypt::allowWrites();
}

} // extern "C"
