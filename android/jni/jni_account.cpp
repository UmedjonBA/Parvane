// Parvane Android (spec 031): аккаунт и устройство — устройства и отзыв (REVOKE-1), привязка в обе роли
// (LINK-1), ключ восстановления через Telegram и вход нового устройства без других (RECOVER-2), сброс личности
// и смена SSK (RECOVER-1), копия ключей формата 2, копия ключей аккаунта (снимок истории), смена ника
// (RENAME-1), удаление аккаунта (DELETE-1), профиль, поиск (FED-1), журнал личного состояния (STATE-1/2),
// приватность и режим L2. Порт desktop parvane_client_{linking,devices}.cpp и parvane_client.cpp.
#include "jni_internal.h"
#include "v2_bridge.h"

#include <parvane/blobcrypt.h>
#include <parvane/keybackup.h>
#include <parvane/keybundle.h>
#include <parvane/linking.h>
#include <parvane/local_files.h>
#include <parvane/messenger.h>
#include <parvane/storecrypt.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <thread>

namespace pvjni {

namespace {

constexpr std::int64_t kLinkOfferLifetimeMs = 10 * 60 * 1000;
constexpr std::size_t kV2HistoryLimit = 20000;

// Новое устройство: оффер привязки (пока ждём грант).
std::mutex g_linkMu;
std::optional<parvane::linking::EphemeralKey> g_linkEph;
std::string g_linkCommitment;
std::string g_linkChallenge;
std::string g_linkCode;
std::int64_t g_linkStartedMs = 0;
bool g_linkActive = false;
json g_linkPendingGrant;
// Старое устройство: свой эфемерный ключ на каждый challenge и офферы, уже показанные пользователю.
std::map<std::string, parvane::linking::EphemeralKey> g_linkChallenges;
std::map<std::string, std::string> g_linkOffersShown;
std::map<std::string, std::string> g_linkOfferEph; // device_id → раскрытый ключ (для гранта по подтверждению)
std::atomic<int> g_linkWorkerGen{0}; // поколение идущего опроса (0 — нет): старый после сброса не мешает новому
std::atomic<int> g_linkGeneration{0};

// Ключ восстановления через Telegram (новое устройство).
std::mutex g_tgMu;
std::string g_tgState = "idle"; // idle|waiting|joining|done|failed|expired|unavailable|limit
int g_tgGeneration = 0;
constexpr std::int64_t kTelegramKeyWaitMs = 30 * 60 * 1000;

void setTelegramState(const std::string &state) {
    {
        std::lock_guard<std::mutex> lk(g_tgMu);
        g_tgState = state;
    }
    emit(json{{"type", "recovery"}, {"state", state}});
}

bool historyRowOk(const json &row) {
    if (!row.is_object() || !row.contains("content") || !row["content"].is_object()) return false;
    for (const auto *key : {"id", "from", "to"})
        if (!row.contains(key) || !row[key].is_string() || row[key].get<std::string>().empty()) return false;
    if (!row.contains("ts") || !row["ts"].is_number()) return false;
    if (row.value("deleted", false)) return false;
    const auto kind = parvane::contentKind(row["content"]);
    if (kind.empty() || kind == "encrypted" || kind == "group_encrypted") return false;
    return row["content"].value("ttl_secs", 0) == 0; // эфемерное не переносится
}

std::string downloadDecrypt(const json &coords, const char *id, const char *key, const char *nonce) {
    const auto d = downloadChatBlob(coords.value(id, std::string()));
    if (!d.ok) throw std::runtime_error("блоб не скачался: " + d.error);
    const auto plain = parvane::blobcrypt::decrypt(d.bytes, coords.value(key, std::string()), coords.value(nonce, std::string()));
    if (!plain) throw std::runtime_error("блоб не расшифровался");
    return *plain;
}

std::string markPath() { return storeDir() + "/bundle-history-mark.txt"; }

// Ключи «Плана» и «Облака» из копии ключей аккаунта: файл (переживает перезапуск до подключения разделов) и сразу
// разделам — без этого «План» появлялся, только когда другое своё устройство присылало ключ само
void noteDomainKeys(const std::string &plannerIn, const std::string &cloudIn) {
    const auto isEmpty = [](const std::string &v) { return v.empty() || v == "[]" || v == "null"; };
    if (isEmpty(plannerIn) && isEmpty(cloudIn)) return;
    // Непустое не заменяем пустым: копия без «Плана» (записанная до исправления) не стирает ключ, уже полученный
    auto planner = plannerIn;
    auto cloud = cloudIn;
    const auto saved = json::parse(parvane::storecrypt::readFile(storeDir() + "/domain-keys.json"), nullptr, false);
    if (saved.is_object() && saved.value("owner", std::string()) == self()) {
        if (isEmpty(planner)) planner = saved.value("planner", std::string());
        if (isEmpty(cloud)) cloud = saved.value("cloud", std::string());
    }
    parvane::storecrypt::writeFile(storeDir() + "/domain-keys.json",
                                   json{{"owner", self()}, {"planner", planner}, {"cloud", cloud}}.dump());
    sectionsDomainKeys();
    emit(json{{"type", "sections"}, {"domain", "keys"}});
}

void applyBundleHistory(const json &history) {
    if (!history.is_object()) return;
    const auto mark = history.value("mark", std::string());
    if (!mark.empty() && parvane::storecrypt::readFile(markPath()) == mark) return;
    try {
        importV2History(downloadDecrypt(history, "fileId", "fileKey", "fileNonce"));
        if (!mark.empty()) parvane::storecrypt::writeFile(markPath(), mark);
        LOGI("копия ключей: снимок истории применён");
    } catch (const std::exception &e) {
        LOGE("копия ключей: история не применена: %s", e.what());
    }
}

// ── новое устройство: оффер и грант ─────────────────────────────────────────

void retractLinkOffer() {
    {
        std::lock_guard<std::mutex> lk(g_linkMu);
        g_linkActive = false;
        g_linkPendingGrant = nullptr;
        g_linkEph.reset();
        g_linkCommitment.clear();
        g_linkChallenge.clear();
        g_linkCode.clear();
    }
    if (const auto c = control()) {
        try { parvane::v2::account::linkOffer(*c, std::string(), std::string(), std::string(), true); } catch (const std::exception &) {}
    }
}

// true — привязка завершена (успех/стоп), false — ждём дальше.
bool pollLinkGrantOnce() {
    std::optional<parvane::linking::EphemeralKey> eph;
    std::string commitment, challenge;
    std::int64_t started = 0;
    {
        std::lock_guard<std::mutex> lk(g_linkMu);
        if (!g_linkActive) return true;
        eph = g_linkEph;
        commitment = g_linkCommitment;
        challenge = g_linkChallenge;
        started = g_linkStartedMs;
    }
    const auto c = control();
    if (!c || !eph) return true;
    if (steadyMs() - started > kLinkOfferLifetimeMs) {
        LOGI("привязка: оффер истёк (10 мин) — отзываю");
        retractLinkOffer();
        emit(json{{"type", "link"}, {"state", "expired"}});
        return true;
    }
    if (!v2NeedsLinking()) {
        LOGI("привязка: устройство уже в журнале устройств — отзываю оффер");
        retractLinkOffer();
        return true;
    }
    json grant;
    std::string newChallenge;
    try {
        const auto resp = parvane::v2::account::linkPoll(*c);
        newChallenge = resp.challenge;
        if (resp.grant) {
            grant = json{{"box_payload", resp.grant->boxPayload}, {"eph_pub", resp.grant->ephPub}};
        } else {
            std::lock_guard<std::mutex> lk(g_linkMu);
            if (g_linkPendingGrant.is_object()) grant = g_linkPendingGrant;
        }
    } catch (const std::exception &) {
        return false;
    }
    if (challenge.empty() && !newChallenge.empty()) {
        try {
            parvane::v2::account::linkOffer(*c, eph->publicB64(), commitment, std::string(), false);
        } catch (const std::exception &) {
            LOGE("привязка: раскрытие ключа отклонено");
            return false;
        }
        const auto code = parvane::linking::sasCodeV2(eph->publicB64(), newChallenge);
        {
            std::lock_guard<std::mutex> lk(g_linkMu);
            if (!g_linkActive) return true;
            g_linkChallenge = newChallenge;
            g_linkCode = code;
        }
        challenge = newChallenge;
        LOGI("привязка: ключ раскрыт, код сверки готов"); // сам код в лог не пишем (P-46)
        emit(json{{"type", "link"}, {"state", "code"}, {"code", code}});
    }
    if (grant.is_null()) return false;
    if (challenge.empty() || grant.value("eph_pub", std::string()) != challenge) {
        LOGE("привязка: грант под чужой эфемерный ключ — отклонён");
        return false;
    }
    {
        std::lock_guard<std::mutex> lk(g_linkMu);
        g_linkActive = false;
    }
    const auto plain = eph->open(grant.value("eph_pub", std::string()), grant.value("box_payload", std::string()));
    if (!plain) { LOGE("привязка: бокс не расшифровался"); emit(json{{"type", "link"}, {"state", "failed"}}); return true; }
    const auto box = json::parse(*plain, nullptr, false);
    if (!box.is_object()) return true;
    if (box.contains("v2") && box["v2"].is_object()) {
        if (const auto s = v2AwaitNeedsLinking()) {
            try {
                auto material = downloadDecrypt(box["v2"], "file_id", "file_key", "file_nonce");
                LOGI("привязка: грант v2 получен — устройство вступает в журнал устройств");
                s->joinWithGrant(std::move(material));
            } catch (const std::exception &e) {
                LOGE("привязка: грант v2: %s", e.what());
            }
        }
    }
    try {
        importV2History(downloadDecrypt(box, "file_id", "file_key", "file_nonce")); // LINK-1 п. 8
        emit(json{{"type", "link"}, {"state", "imported"}});
    } catch (const std::exception &e) {
        LOGE("привязка: экспорт: %s", e.what());
    }
    return true;
}

// ── старое устройство: офферы чужих устройств ───────────────────────────────

void pollLinkOffersOnce() {
    const auto c = control();
    if (!c || !v2Ready()) return;
    std::vector<parvane::v2::account::LinkOffer> offers;
    try {
        const auto resp = parvane::v2::account::linkPoll(*c);
        if (resp.grant) {
            // Свой грант пришёл в опросе чужих офферов — оставляем опросу своего оффера
            std::lock_guard<std::mutex> lk(g_linkMu);
            if (g_linkActive) g_linkPendingGrant = json{{"box_payload", resp.grant->boxPayload}, {"eph_pub", resp.grant->ephPub}};
        }
        offers = resp.offers;
    } catch (const std::exception &) {
        return;
    }
    // Уже вошедшие в журнал своих устройств (ключом восстановления, грантом другого устройства) — не запрос:
    // их оффер мог остаться на сервере, а окно «Новое устройство просит привязку» для них только путает
    std::set<std::string> joined;
    if (!offers.empty()) {
        if (const auto s = v2Ready()) {
            try {
                s->refreshPeerLog(self());
            } catch (const std::exception &) {
            }
            for (auto &id : s->ownDevices()) joined.insert(std::move(id));
        }
    }
    std::vector<std::string> gone;
    {
        std::set<std::string> live;
        for (const auto &o : offers) if (!joined.count(o.deviceId)) live.insert(o.deviceId);
        std::lock_guard<std::mutex> lk(g_linkMu);
        for (auto it = g_linkChallenges.begin(); it != g_linkChallenges.end();)
            it = live.count(it->first) ? std::next(it) : g_linkChallenges.erase(it);
        // Запрос исчез (устройство вошло иным путём, отозвало оффер, истёк срок) — его окно закрывается
        for (auto it = g_linkOffersShown.begin(); it != g_linkOffersShown.end();) {
            if (live.count(it->first)) { ++it; continue; }
            gone.push_back(it->first);
            g_linkOfferEph.erase(it->first);
            it = g_linkOffersShown.erase(it);
        }
    }
    for (const auto &id : gone) emit(json{{"type", "link_request_gone"}, {"device_id", id}});
    for (const auto &o : offers) {
        if (o.deviceId.empty() || o.commitment.empty() || joined.count(o.deviceId)) continue;
        std::optional<parvane::linking::EphemeralKey> own;
        {
            std::lock_guard<std::mutex> lk(g_linkMu);
            if (const auto it = g_linkChallenges.find(o.deviceId); it != g_linkChallenges.end()) own = it->second;
        }
        if (!own && !o.challengePub.empty()) continue; // challenge выставило другое наше устройство
        if (!own || o.challengePub.empty()) {
            auto key = own ? own : parvane::linking::EphemeralKey::generate();
            if (!key) continue;
            try { parvane::v2::account::linkChallenge(*c, o.deviceId, key->publicB64()); } catch (const std::exception &) { continue; }
            std::lock_guard<std::mutex> lk(g_linkMu);
            g_linkChallenges.insert_or_assign(o.deviceId, *key);
            continue;
        }
        if (o.challengePub != own->publicB64() || o.ephPub.empty()) continue;
        if (!parvane::linking::commitmentMatches(o.ephPub, o.commitment)) {
            LOGE("привязка: ключ оффера не соответствует обязательству");
            continue;
        }
        {
            std::lock_guard<std::mutex> lk(g_linkMu);
            if (g_linkOffersShown[o.deviceId] == o.ephPub) continue;
            g_linkOffersShown[o.deviceId] = o.ephPub;
            g_linkOfferEph[o.deviceId] = o.ephPub;
        }
        const auto code = parvane::linking::sasCodeV2(o.ephPub, own->publicB64());
        LOGI("привязка: запрос от нового устройства, код готов");
        emit(json{{"type", "link_request"}, {"device_id", o.deviceId}, {"code", code}});
    }
}

bool grantLink(const std::string &deviceId) {
    const auto c = control();
    std::optional<parvane::linking::EphemeralKey> own;
    std::string ephPub;
    {
        std::lock_guard<std::mutex> lk(g_linkMu);
        if (const auto it = g_linkChallenges.find(deviceId); it != g_linkChallenges.end()) own = it->second;
        ephPub = g_linkOfferEph[deviceId];
    }
    if (!c || !own || ephPub.empty()) {
        LOGE("привязка: нет своего challenge для устройства");
        return false;
    }
    try {
        // Экспорт привязки — формат web 2: история v2 (LINK-1 п. 8), ключи — грантом движка
        auto exported = json{{"linkVersion", 2}};
        if (auto rows = collectV2HistoryRows(); !rows.empty()) exported["v2History"] = std::move(rows);
        auto enc = parvane::blobcrypt::encrypt(exported.dump());
        const auto fileId = c->uploadBlob(enc.ciphertext);
        json boxPlain{{"file_id", fileId}, {"file_key", enc.keyB64}, {"file_nonce", enc.nonceB64}};
        if (const auto s = v2Ready()) {
            auto material = s->linkGrantMaterial();
            if (!material.empty()) {
                auto encV2 = parvane::blobcrypt::encrypt(material);
                std::fill(material.begin(), material.end(), '\0');
                boxPlain["v2"] = {{"file_id", c->uploadBlob(encV2.ciphertext)}, {"file_key", encV2.keyB64}, {"file_nonce", encV2.nonceB64}};
            }
        }
        const auto box = own->seal(ephPub, boxPlain.dump());
        if (!box) return false;
        parvane::v2::account::linkGrant(*c, deviceId, *box, own->publicB64());
        LOGI("привязка: грант выдан");
        {
            std::lock_guard<std::mutex> lk(g_linkMu);
            g_linkChallenges.erase(deviceId);
        }
        // окно подтверждения закрывается, каким бы путём ни выдан грант (кнопка окна, экран устройств, хук)
        emit(json{{"type", "link_granted"}, {"device_id", deviceId}});
        return true;
    } catch (const std::exception &e) {
        LOGE("привязка: грант не удался: %s", e.what());
        return false;
    }
}

void linkWorkerLoop(int generation) {
    auto lastOffers = std::int64_t(0);
    while (g_linkGeneration == generation) {
        bool active = false;
        {
            std::lock_guard<std::mutex> lk(g_linkMu);
            active = g_linkActive;
        }
        if (active) (void)pollLinkGrantOnce();
        if (steadyMs() - lastOffers >= 10000) {
            lastOffers = steadyMs();
            pollLinkOffersOnce();
        }
        for (int i = 0; i < 50 && g_linkGeneration == generation; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

// ── Telegram-восстановление ──────────────────────────────────────────────────

void pollTelegramLoop(int generation) {
    const auto started = steadyMs();
    auto delay = 3000;
    for (;;) {
        std::this_thread::sleep_for(std::chrono::milliseconds(delay));
        delay = std::min(15000, delay * 3 / 2);
        {
            std::lock_guard<std::mutex> lk(g_tgMu);
            if (g_tgGeneration != generation || g_tgState != "waiting") return;
        }
        const auto s = v2NeedsLinking();
        if (!s) { setTelegramState("idle"); return; }
        if (steadyMs() - started > kTelegramKeyWaitMs) { setTelegramState("expired"); return; }
        const auto reply = s->pollTelegramKey(false);
        if (!reply.is_object()) continue;
        const auto key = reply.value("recovery_key", std::string());
        if (key.empty()) {
            if (!reply.value("pending", false)) (void)s->requestTelegramKey(false);
            continue;
        }
        setTelegramState("joining");
        LOGI("ключ восстановления: получен ответ владельца из Telegram");
        auto outcome = s->joinWithRecoveryKey(key, true);
        if (outcome.result != "ok") {
            LOGE("ключ восстановления: вход не удался (%s)", outcome.result.c_str());
            setTelegramState("failed");
            return;
        }
        (void)s->pollTelegramKey(true);
        setTelegramState("done");
        completeKeyJoin(std::move(outcome));
        return;
    }
}

} // namespace

// ── публичные для модулей ────────────────────────────────────────────────────

json collectV2HistoryRows() {
    auto rows = json::array();
    for (auto &m : journalFold()) {
        json row{{"id", m.value("id", std::string())}, {"from", m.value("from", std::string())},
                 {"to", m.value("to", std::string())}, {"ts", m.value("ts", std::int64_t(0))},
                 {"content", m.value("content", json::object())}, {"read", m.value("read", false)},
                 {"edited", m.value("edited", false)}, {"pinned", m.value("pinned", false)}};
        if (m.contains("reply_to") && m["reply_to"].is_string()) row["reply_to"] = m["reply_to"];
        row["content"].erase("local_path");
        if (historyRowOk(row)) rows.push_back(std::move(row));
    }
    if (rows.size() > kV2HistoryLimit) rows.erase(rows.begin(), rows.begin() + std::ptrdiff_t(rows.size() - kV2HistoryLimit));
    return rows;
}

// Привезённая история (экспорт привязки, копия ключей, снимок копии ключей аккаунта) — по времени отправки
// (ORDER-1: строки снимка web идут не по порядку); строки групп ждут появления группы.
void importV2History(const std::string &stateJson) {
    const auto state = json::parse(stateJson, nullptr, false);
    if (!state.is_object() || !state.contains("v2History") || !state["v2History"].is_array()) return;
    const auto me = self();
    std::vector<json> rows;
    for (const auto &row : state["v2History"]) {
        if (rows.size() >= kV2HistoryLimit) break;
        if (historyRowOk(row)) rows.push_back(row);
    }
    std::stable_sort(rows.begin(), rows.end(), [](const json &a, const json &b) { return a.value("ts", std::int64_t(0)) < b.value("ts", std::int64_t(0)); });
    int taken = 0;
    for (const auto &row : rows) {
        parvane::v2::Incoming in;
        in.kind = parvane::v2::Incoming::Kind::Message;
        in.id = row["id"].get<std::string>();
        in.from = row["from"].get<std::string>();
        const auto to = row["to"].get<std::string>();
        const bool out = in.from == me;
        in.group = isGroupAddress(to);
        in.chat = in.group ? to : (out ? to : in.from);
        in.to = in.group ? to : (out ? to : me);
        in.ts = row["ts"].get<std::int64_t>();
        in.content = row["content"];
        if (row.contains("reply_to") && row["reply_to"].is_string()) in.replyTo = row["reply_to"].get<std::string>();
        if (!markSeen(in.id)) continue;
        noteMessage(in.id, in.from, in.chat, in.content);
        auto ev = parvane::android_v2::messageEvent(in, me, nowSec());
        ev["read"] = out ? row.value("read", false) : true; // история, а не новые входящие
        ev["edited"] = row.value("edited", false);
        ev["pinned"] = row.value("pinned", false);
        ++taken;
        if (in.group && !groupKnown(to)) {
            deferLinkedGroupRow(to, std::move(ev));
            continue;
        }
        emit(ev);
    }
    if (taken) LOGI("история v2 перенесена (%d сообщений)", taken);
}

void startLinkOffer() {
    {
        std::lock_guard<std::mutex> lk(g_linkMu);
        if (g_linkActive) return;
    }
    const auto c = control();
    auto eph = parvane::linking::EphemeralKey::generate();
    if (!c || !eph) return;
    const auto commitment = parvane::linking::commitment(eph->publicB64());
    try {
        parvane::v2::account::linkOffer(*c, std::string(), commitment, std::string(), false);
    } catch (const std::exception &e) {
        LOGE("привязка: оффер не опубликован: %s", e.what());
        return;
    }
    {
        std::lock_guard<std::mutex> lk(g_linkMu);
        g_linkEph = std::move(eph);
        g_linkCommitment = commitment;
        g_linkPendingGrant = nullptr;
        g_linkChallenge.clear();
        g_linkCode.clear();
        g_linkStartedMs = steadyMs();
        g_linkActive = true;
    }
    LOGI("привязка: оффер опубликован — подтвердите на другом устройстве");
    emit(json{{"type", "link"}, {"state", "offered"}});
    startLinkingWorkers();
}

void startLinkingWorkers() {
    // уже идёт опрос текущего поколения — второй не нужен; опрос прежнего (до resetLinking) сам завершится
    const int current = g_linkGeneration;
    if (current != 0 && g_linkWorkerGen == current) return;
    const int generation = ++g_linkGeneration;
    g_linkWorkerGen = generation;
    runDetached([generation] {
        linkWorkerLoop(generation);
        int expected = generation;
        g_linkWorkerGen.compare_exchange_strong(expected, 0);
    });
}

void resetLinking() {
    ++g_linkGeneration;
    std::lock_guard<std::mutex> lk(g_linkMu);
    g_linkEph.reset();
    g_linkCommitment.clear();
    g_linkChallenge.clear();
    g_linkCode.clear();
    g_linkStartedMs = 0;
    g_linkActive = false;
    g_linkPendingGrant = json();
    g_linkChallenges.clear();
    g_linkOffersShown.clear();
    g_linkOfferEph.clear();
    std::lock_guard<std::mutex> tk(g_tgMu);
    ++g_tgGeneration;
    g_tgState = "idle";
}

// Снимок истории для копии ключей аккаунта (зовёт сессия на своём потоке).
json bundleHistory(const json &previous, bool force) {
    constexpr std::int64_t kSmallBytes = 256 * 1024;
    constexpr std::int64_t kMinMs = 6 * 60 * 60 * 1000;
    const auto size = previous.is_object() ? previous.value("size", std::int64_t(0)) : 0;
    const auto at = previous.is_object() ? previous.value("at", std::int64_t(0)) : 0;
    if (previous.is_object() && !force && size > kSmallBytes && nowMs() - at < kMinMs) return previous;
    auto rows = collectV2HistoryRows();
    if (rows.empty()) return previous;
    const auto exportJson = json{{"linkVersion", 2}, {"v2History", std::move(rows)}}.dump();
    const auto mark = parvane::keybundle::digestHex(exportJson);
    if (previous.is_object() && previous.value("mark", std::string()) == mark) return previous;
    const auto c = control();
    if (!c) return previous;
    try {
        auto enc = parvane::blobcrypt::encrypt(exportJson);
        const auto fileId = c->uploadBlob(enc.ciphertext);
        if (fileId.empty()) return previous;
        parvane::storecrypt::writeFile(markPath(), mark);
        return json{{"fileId", fileId}, {"fileKey", enc.keyB64}, {"fileNonce", enc.nonceB64}, {"at", nowMs()},
                    {"mark", mark}, {"size", std::int64_t(exportJson.size())}};
    } catch (const std::exception &e) {
        LOGE("копия ключей: снимок истории не загружен: %s", e.what());
        return previous;
    }
}

void syncFromKeyBundle() {
    const auto s = v2Ready();
    if (!s) return;
    try {
        const auto bundle = s->fetchKeyBundle();
        if (!bundle.is_object()) return;
        noteDomainKeys(bundle.value("planner", std::string()),
                       bundle.contains("cloud") ? (bundle["cloud"].is_string() ? bundle["cloud"].get<std::string>() : bundle["cloud"].dump()) : std::string());
        // Группы — и здесь, а не только при «успешном» ответе входа по ключу: вход мог завершиться повтором в фоне
        if (const auto groups = bundle.value("groups", std::string()); !groups.empty()) s->applyBundleGroups(groups);
        applyBundleHistory(bundle.value("history", json()));
    } catch (const std::exception &e) {
        LOGE("копия ключей аккаунта: %s", e.what());
    }
}

// Устройство вошло в журнал — любым путём (ключ через бота, ключ руками, подтверждение с другого устройства, повтор
// после обрыва; событие сессии `joined`): оффер привязки отзываем сразу, ключ у бота отмечаем забранным, из копии
// ключей аккаунта забираем всё. Раньше это делал только «успешный» ответ входа по ключу — при временной ошибке
// группы и «План» приходили через минуты, от другого своего устройства, а экран писал «привязка не удалась»
void completeJoin() {
    const auto s = v2Ready();
    if (!s) return;
    retractLinkOffer();
    std::string state;
    {
        std::lock_guard<std::mutex> lk(g_tgMu);
        state = g_tgState;
    }
    if (state != "idle" && state != "unavailable" && state != "done") setTelegramState("done");
    (void)s->pollTelegramKey(true);
    syncFromKeyBundle();
    emit(json{{"type", "link"}, {"state", "joined"}});
    s->ackJoined();
    LOGI("вход: всё из копии ключей аккаунта забрано");
}

void completeKeyJoin(parvane::v2::KeyJoinOutcome outcome) {
    noteDomainKeys(outcome.planner, outcome.cloud);
    applyBundleHistory(outcome.history);
    emit(json{{"type", "link"}, {"state", "joined"}});
    runDetached([] {
        for (const int delaySec : {20, 60, 180}) {
            std::this_thread::sleep_for(std::chrono::seconds(delaySec));
            syncFromKeyBundle();
        }
    });
}

} // namespace pvjni

using namespace pvjni;

extern "C" {

// ── устройства (REVOKE-1) ────────────────────────────────────────────────────

// [{device_id, client_kind, last_seen_ms, created_ms, current, in_log}] + extras.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeListDevices(JNIEnv *env, jclass) {
    json out{{"devices", json::array()}};
    // До входа (X спрашивает сеансы рано) — пусто: id устройства заводится только в каталоге вошедшего аккаунта
    if (self().empty()) return jreply(env, out);
    const auto c = control();
    try {
        const auto mine = parvane::v2::Session::deviceIdFor(v2StateDir(self()));
        std::set<std::string> inLog;
        const auto s = v2Ready();
        if (s) {
            s->pollOwnDevices();
            for (const auto &id : s->ownDevices()) inLog.insert(id);
            out["rotation_needed"] = s->sskState().value("rotationNeeded", false);
            out["escrow_missing"] = s->isEscrowCopyMissing();
            out["can_send_telegram"] = s->canSendKeyToTelegram();
            out["left_devices"] = s->leftSskHolders();
        }
        if (c) {
            for (const auto &d : parvane::v2::account::listDevices(*c)) {
                out["devices"].push_back(json{{"device_id", d.deviceId}, {"client_kind", d.clientKind},
                                              {"last_seen_ms", d.lastSeenMs}, {"created_ms", d.createdMs},
                                              {"current", d.deviceId == mine}, {"in_log", inLog.count(d.deviceId) > 0}});
                inLog.erase(d.deviceId);
            }
        }
        for (const auto &id : inLog)
            out["devices"].push_back(json{{"device_id", id}, {"client_kind", ""}, {"last_seen_ms", 0}, {"created_ms", 0},
                                          {"current", id == mine}, {"in_log", true}});
    } catch (const std::exception &e) {
        LOGE("devices: %s", e.what());
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

// Выйти на устройстве: rotate=false — обычный выход (без смены ключей), true — отзыв со сменой ключей (пароль).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRevokeDevice(
        JNIEnv *env, jclass, jstring deviceId, jstring password, jboolean rotate) {
    const auto dev = jstr(env, deviceId);
    const auto s = v2Ready();
    const auto c = control();
    if (!s || !c) return jreply(env, jfail("failed"));
    if (dev == parvane::v2::Session::deviceIdFor(v2StateDir(self()))) return jreply(env, jfail("bad_request"));
    try {
        if (rotate != JNI_TRUE) {
            if (s->signOutDevice(dev)) return jreply(env, json{{"ok", true}});
        }
        // Пароль проверяет сервер (session.reauth); устройство журнала снимает подписанная запись
        try {
            parvane::v2::account::revokeDevice(*c, dev, jstr(env, password));
        } catch (const parvane::v2::V2Error &e) {
            if (e.code() != "ERROR_CODE_INVALID") throw;
        }
        const bool ok = s->revokeDevice(dev);
        return jreply(env, ok ? json{{"ok", true}} : jfail("not_found"));
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeReportDeviceStolen(JNIEnv *env, jclass, jstring deviceId) {
    const auto s = v2Ready();
    try { return s && s->reportDeviceStolen(jstr(env, deviceId)) ? JNI_TRUE : JNI_FALSE; } catch (const std::exception &) { return JNI_FALSE; }
}

// ── привязка (LINK-1) ────────────────────────────────────────────────────────

// Старое устройство: подтвердить запрос нового (код сверен пользователем).
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeLinkGrant(JNIEnv *env, jclass, jstring deviceId) {
    return grantLink(jstr(env, deviceId)) ? JNI_TRUE : JNI_FALSE;
}

// Новое устройство: опубликовать оффер снова (после истечения).
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeLinkOffer(JNIEnv *, jclass) {
    runDetached([] { startLinkOffer(); });
}

// ── ключ восстановления (RECOVER-1/2) ────────────────────────────────────────

// Новое устройство: бот попросит владельца ответить ключом. again — «прислать ещё раз».
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeTelegramRecovery(JNIEnv *, jclass, jboolean again) {
    runDetached([again] {
        const auto s = v2NeedsLinking();
        if (!s) return;
        int generation = 0;
        {
            std::lock_guard<std::mutex> lk(g_tgMu);
            if (g_tgState == "joining" || (g_tgState == "waiting" && again != JNI_TRUE)) return;
            generation = ++g_tgGeneration;
        }
        const auto requested = s->requestTelegramKey(again == JNI_TRUE);
        if (requested != "sent") {
            setTelegramState(requested == "no_telegram" ? "unavailable" : requested == "limit" ? "limit" : "failed");
            return;
        }
        setTelegramState("waiting");
        pollTelegramLoop(generation);
    });
}

// Вход по ключу восстановления, введённому вручную: "ok" | "bad_key" | "no_backup" | "failed".
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRecoverWithKey(JNIEnv *env, jclass, jstring key) {
    try {
        const auto s = v2NeedsLinking();
        if (!s) return jout(env, "failed");
        auto outcome = s->joinWithRecoveryKey(parvane::keybundle::pickRecoveryKey(jstr(env, key)), false);
        if (outcome.result == "ok") completeKeyJoin(outcome);
        return jout(env, outcome.result);
    } catch (const std::exception &e) {
        LOGE("nativeRecoverWithKey: %s", e.what());
        return jout(env, "failed");
    }
}

// Сброс личности (других устройств нет, ключа нет): "ok" | "bad_password" | "failed".
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeResetIdentity(JNIEnv *env, jclass, jstring password) {
    try {
        const auto s = v2NeedsLinking();
        return jout(env, s ? s->resetIdentity(jstr(env, password)) : std::string("failed"));
    } catch (const std::exception &e) {
        LOGE("nativeResetIdentity: %s", e.what());
        return jout(env, "failed");
    }
}

// Смена SSK ключом восстановления (после отзыва устройства-держателя).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRotateSsk(JNIEnv *env, jclass, jstring key) {
    try {
        const auto s = v2Ready();
        return jout(env, s ? s->rotateSsk(parvane::keybundle::pickRecoveryKey(jstr(env, key))) : std::string("failed"));
    } catch (const std::exception &e) {
        LOGE("nativeRotateSsk: %s", e.what());
        return jout(env, "failed");
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSendKeyToTelegram(JNIEnv *env, jclass, jstring key) {
    try {
        const auto s = v2Ready();
        return jout(env, s ? s->sendKeyToTelegram(parvane::keybundle::pickRecoveryKey(jstr(env, key))) : std::string("failed"));
    } catch (const std::exception &e) {
        LOGE("nativeSendKeyToTelegram: %s", e.what());
        return jout(env, "failed");
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeStoreEscrowCopy(JNIEnv *env, jclass, jstring key) {
    try {
        const auto s = v2Ready();
        return jout(env, s ? s->storeEscrowCopy(parvane::keybundle::pickRecoveryKey(jstr(env, key))) : std::string("failed"));
    } catch (const std::exception &e) {
        LOGE("nativeStoreEscrowCopy: %s", e.what());
        return jout(env, "failed");
    }
}

// {"rotationNeeded","hasRoot","hasBackup","needsLinking","telegram":state}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRecoveryState(JNIEnv *env, jclass) {
    try {
        json out = json::object();
        const auto s = v2Any();
        out["needsLinking"] = s && s->needsLinking();
        if (s && s->isReady()) out.update(s->sskState());
        {
            std::lock_guard<std::mutex> lk(g_tgMu);
            out["telegram"] = g_tgState;
        }
        return jreply(env, out);
    } catch (const std::exception &e) {
        LOGE("nativeRecoveryState: %s", e.what());
        return jreply(env, json::object());
    }
}

// ── копия ключей формата 2 (вручную) ─────────────────────────────────────────

// {deviceId, v2: устройство движка, v2History} под паролем → файл (JSON); "" — нет.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeExportKeys(JNIEnv *env, jclass, jstring password) {
    const auto s = v2Ready();
    if (!s) return jout(env, "");
    try {
        json payload{{"deviceId", parvane::v2::Session::deviceIdFor(v2StateDir(self()))}};
        if (auto device = s->deviceBackup(); device.is_object()) payload["v2"] = std::move(device);
        if (auto rows = collectV2HistoryRows(); !rows.empty()) payload["v2History"] = std::move(rows);
        if (!payload.contains("v2")) return jout(env, "");
        return jout(env, parvane::keybackup::exportEncrypted(payload.dump(), jstr(env, password)));
    } catch (const std::exception &e) {
        LOGE("exportKeys: %s", e.what());
        return jout(env, "");
    }
}

// 1 — история перенесена; −1 — неверный пароль/битый файл; −2 — копия не формата 2.
JNIEXPORT jint JNICALL Java_org_parvane_core_ParvaneCore_nativeImportKeys(JNIEnv *env, jclass, jstring fileJson, jstring password) {
    try {
        const auto state = parvane::keybackup::importEncrypted(jstr(env, fileJson), jstr(env, password));
        if (!state) return -1;
        const auto parsed = json::parse(*state, nullptr, false);
        if (!parsed.is_object() || !parsed.contains("v2")) return -2;
        if (parsed.contains("v2History")) importV2History(json{{"v2History", parsed["v2History"]}}.dump());
        return 1;
    } catch (const std::exception &e) {
        LOGE("nativeImportKeys: %s", e.what());
        return -1;
    }
}

// ── аккаунт (RENAME-1, DELETE-1) ─────────────────────────────────────────────

// {"result":"ok"|"bad_password"|"no_backup"|"bad_key"|"taken"|"invalid"|"failed","address"}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeRenameAccount(
        JNIEnv *env, jclass, jstring nick, jstring password, jstring recoveryKey) {
    try {
        const auto s = v2Ready();
        if (!s) return jreply(env, json{{"result", "failed"}});
        const auto oldAddress = self();
        auto out = s->renameAccount(jstr(env, nick), jstr(env, password), parvane::keybundle::pickRecoveryKey(jstr(env, recoveryKey)));
        if (out.value("result", std::string()) != "ok") return jreply(env, out);
        const auto newAddress = out.value("address", std::string());
        if (!parvane::accountfiles::isValidAddress(newAddress)) return jreply(env, json{{"result", "failed"}});
        const auto token = out.value("token", std::string());
        // Сессия — под новым адресом: каталог состояния переезжает, журнал истории — свои строки нового адреса
        stopSession();
        std::error_code ec;
        std::filesystem::rename(v2StateDir(oldAddress), v2StateDir(newAddress), ec);
        journalTransform([&](std::vector<json> &msgs) {
            for (auto &m : msgs)
                for (const auto *k : {"from", "to"})
                    if (m.value(k, std::string()) == oldAddress) m[k] = newAddress;
        });
        {
            std::lock_guard<std::mutex> lk(g_mu);
            g_self = newAddress;
            if (!token.empty()) g_token = token;
            parvane::storecrypt::writeFile(storeDir() + "/session.json", json{{"self", g_self}, {"token", g_token}}.dump());
            parvane::storecrypt::writeFile(storeDir() + "/account-owner", g_self);
        }
        startSession();
        emit(json{{"type", "renamed"}, {"from", oldAddress}, {"to", newAddress}});
        out.erase("token");
        return jreply(env, out);
    } catch (const std::exception &e) {
        LOGE("nativeRenameAccount: %s", e.what());
        return jreply(env, json{{"result", "failed"}});
    }
}

// {"result":"ok"|"bad_password"|"failed","deletionAtMs"}
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeDeleteAccount(JNIEnv *env, jclass, jstring password) {
    try {
        const auto s = v2Ready();
        if (!s) return jreply(env, json{{"result", "failed"}});
        return jreply(env, s->deleteAccount(jstr(env, password)));
    } catch (const std::exception &e) {
        LOGE("nativeDeleteAccount: %s", e.what());
        return jreply(env, json{{"result", "failed"}});
    }
}

// ── профиль, поиск (FED-1) ───────────────────────────────────────────────────

// [{username, display_name, avatar, bio, birthday, …}] — адреса чужих серверов у их серверов.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeResolve(JNIEnv *env, jclass, jstring addressesJson) {
    json out{{"users", json::array()}};
    const auto c = control();
    const auto arr = json::parse(jstr(env, addressesJson), nullptr, false);
    if (!c || !arr.is_array()) return jreply(env, out);
    std::vector<std::string> addresses;
    for (const auto &a : arr) if (a.is_string()) addresses.push_back(a.get<std::string>());
    try {
        std::string federationError;
        for (const auto &p : parvane::v2::account::resolveProfiles(*c, addresses, &federationError)) out["users"].push_back(p.toJson());
        if (!federationError.empty()) {
            out["federation_error"] = federationError;
            noteFederationFailure(federationError);
        }
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSearch(JNIEnv *env, jclass, jstring query) {
    json out{{"users", json::array()}};
    const auto c = control();
    if (!c) return jreply(env, out);
    try {
        for (const auto &p : parvane::v2::account::searchDirectory(*c, jstr(env, query))) out["users"].push_back(p.toJson());
    } catch (const std::exception &e) {
        out["error_code"] = errorCodeOf(e);
    }
    return jreply(env, out);
}

// Профиль: {display_name, bio?, birthday?, personal_channel?, phone?, name_color?}
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeSetProfile(JNIEnv *env, jclass, jstring fieldsJson) {
    const auto c = control();
    const auto f = json::parse(jstr(env, fieldsJson), nullptr, false);
    if (!c || !f.is_object()) return JNI_FALSE;
    try {
        parvane::v2::account::ProfilePatch p;
        p.displayName = f.value("display_name", std::string());
        if (f.contains("bio") && f["bio"].is_string()) p.bio = f["bio"].get<std::string>();
        if (f.contains("birthday") && f["birthday"].is_string()) p.birthday = f["birthday"].get<std::string>();
        if (f.contains("personal_channel") && f["personal_channel"].is_string()) p.personalChannel = f["personal_channel"].get<std::string>();
        if (f.contains("phone") && f["phone"].is_string()) p.phone = f["phone"].get<std::string>();
        if (f.contains("name_color") && f["name_color"].is_number_integer()) p.nameColor = f["name_color"].get<int>();
        parvane::v2::account::setProfile(*c, p);
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("setProfile: %s", e.what());
        return JNI_FALSE;
    }
}

// Аватар: открытый блоб → identity; копия в кэш. → file_id ("" — ошибка).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSetAvatar(JNIEnv *env, jclass, jstring path) {
    const auto c = control();
    if (!c) return jout(env, "");
    try {
        std::ifstream f(jstr(env, path), std::ios::binary);
        if (!f) throw std::runtime_error("файл не читается");
        const std::string bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        const auto fileId = c->uploadBlob(bytes, /*isPublic=*/true);
        parvane::v2::account::setAvatar(*c, fileId);
        writeMediaCache(fileId, bytes);
        return jout(env, fileId);
    } catch (const std::exception &e) {
        LOGE("setAvatar: %s", e.what());
        return jout(env, "");
    }
}

// «Ключ безопасности» (отпечаток корня по проверенному журналу): "" — нет.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeFingerprint(JNIEnv *env, jclass, jstring user) {
    const auto s = v2Ready();
    if (!s) return jout(env, "");
    try { return jout(env, parvane::v2::fingerprintOf(s->rootKeyOf(jstr(env, user)))); } catch (const std::exception &) { return jout(env, ""); }
}

// Профиль не нашёлся — не удалён ли аккаунт собеседника (событие peer_deleted).
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeCheckPeerDeleted(JNIEnv *env, jclass, jstring user) {
    const auto s = v2Ready();
    try { return s && s->checkPeerDeleted(jstr(env, user)) ? JNI_TRUE : JNI_FALSE; } catch (const std::exception &) { return JNI_FALSE; }
}

// ── журнал личного состояния (STATE-1/2) ─────────────────────────────────────

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeStateAttach(JNIEnv *env, jclass, jstring localJson) {
    const auto s = v2Ready();
    if (!s) return jout(env, "");
    try {
        const auto local = json::parse(jstr(env, localJson), nullptr, false);
        const auto snap = s->stateAttach(local.is_object() ? local : json::object());
        return jout(env, snap.is_object() ? snap.dump() : std::string());
    } catch (const std::exception &e) {
        LOGE("журнал состояния: %s", e.what());
        return jout(env, "");
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeStateSync(JNIEnv *env, jclass, jstring desiredJson, jstring kindsJson) {
    const auto s = v2Ready();
    if (!s) return jout(env, "");
    try {
        const auto desired = json::parse(jstr(env, desiredJson), nullptr, false);
        const auto kindsJ = json::parse(jstr(env, kindsJson), nullptr, false);
        std::vector<std::string> kinds;
        if (kindsJ.is_array()) for (const auto &k : kindsJ) if (k.is_string()) kinds.push_back(k.get<std::string>());
        const auto r = s->stateSync(desired.is_object() ? desired : json(), kinds);
        return jout(env, r.is_object() ? r.dump() : std::string());
    } catch (const std::exception &e) {
        LOGE("синк журнала состояния: %s", e.what());
        return jout(env, "");
    }
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeStateScheduledSent(JNIEnv *env, jclass, jstring opIdB64) {
    const auto s = v2Ready();
    try { return s && s->stateScheduledSent(jstr(env, opIdB64)) ? JNI_TRUE : JNI_FALSE; } catch (const std::exception &) { return JNI_FALSE; }
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeStateMarkSent(JNIEnv *env, jclass, jstring opIdB64) {
    if (const auto s = v2Ready()) s->stateMarkSent(jstr(env, opIdB64));
}

// Любая запись журнала по имени (`callSet` — история звонков, …): true — ушла.
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeStateCall(JNIEnv *env, jclass, jstring name, jstring argsJson) {
    const auto s = v2Ready();
    const auto args = json::parse(jstr(env, argsJson), nullptr, false);
    try { return s && s->stateCall(jstr(env, name), args.is_null() ? json::object() : args) ? JNI_TRUE : JNI_FALSE; }
    catch (const std::exception &) { return JNI_FALSE; }
}

// Блокировка → отзыв доступа к доставке у собеседника (ACCESS-1). Блокирующий (сеть).
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeRevokeContactAccess(JNIEnv *env, jclass, jstring peer) {
    const auto s = v2ReadyForSend();
    try { return s && s->revokeContactAccess(jstr(env, peer)) ? JNI_TRUE : JNI_FALSE; }
    catch (const std::exception &e) { LOGE("отзыв доступа: %s", e.what()); return JNI_FALSE; }
}

// ── приватность (FR-040) и L2 ────────────────────────────────────────────────

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeSetPrivacy(
        JNIEnv *, jclass, jboolean groupAddNobody, jboolean strangersAllowed) {
    const auto s = v2Any();
    try { return s && s->setPrivacy(groupAddNobody == JNI_TRUE, strangersAllowed == JNI_TRUE) ? JNI_TRUE : JNI_FALSE; }
    catch (const std::exception &) { return JNI_FALSE; }
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeSetCallsPresencePrivacy(
        JNIEnv *, jclass, jboolean callsNobody, jboolean presenceNobody) {
    const auto s = v2Any();
    try { return s && s->setCallsPresencePrivacy(callsNobody == JNI_TRUE, presenceNobody == JNI_TRUE) ? JNI_TRUE : JNI_FALSE; }
    catch (const std::exception &) { return JNI_FALSE; }
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeL2Available(JNIEnv *env, jclass, jstring chat) {
    const auto c = jstr(env, chat);
    const auto s = v2Ready();
    if (!s || c.empty()) return JNI_FALSE;
    try {
        if (isGroupAddress(c)) return s->groupInfo(c).is_object() ? JNI_TRUE : JNI_FALSE;
        return s->isV2Peer(c) ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &) {
        return JNI_FALSE;
    }
}

// {"ok","id"?,"error_code"}. Личный чат — своё предпочтение (своё служебное сообщение показываем сами).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSetL2(JNIEnv *env, jclass, jstring chat, jboolean enabled) {
    const auto c = jstr(env, chat);
    const bool on = enabled == JNI_TRUE;
    const auto s = v2Ready();
    if (!s || c.empty()) return jreply(env, jfail("unavailable"));
    try {
        if (isGroupAddress(c)) {
            const bool ok = s->setGroupL2(c, on);
            return jreply(env, ok ? json{{"ok", true}} : jfail("forbidden"));
        }
        const auto opId = parvane::v2::newUuidV7();
        s->setDirectL2(c, on, opId);
        (void)markSeen(opId);
        auto msg = parvane::android_v2::ownChatModeEvent(self(), c, on, opId, nowSec());
        noteMessage(opId, self(), c, msg["content"]);
        emit(msg);
        return jreply(env, json{{"ok", true}, {"id", opId}});
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

} // extern "C"
