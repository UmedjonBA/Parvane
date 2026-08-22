// Parvane fork: тесты E2E-слоя (мультидевайс/подписи/верификация/линковка)
// на фейковом транспорте с in-memory identity. Без backend.
//
// Ограничение: e2e.cpp — процесс-глобальное состояние (одно устройство на
// процесс), поэтому «второе устройство» моделируется напрямую через FFI
// vodozemac как получатель копии.
#include "parvane/e2e.h"
#include "parvane/itransport.h"
#include "parvane/topics.h"
#include "parvane_e2e.h"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

using nlohmann::json;

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

static std::string take(char *p) {
    std::string s = p ? p : "";
    if (p) parvane_e2e_string_free(p);
    return s;
}

// Фейковое устройство (vodozemac напрямую) с бандлом для identity.
struct FakeDevice {
    ParvaneE2EAccount *acc = parvane_e2e_account_new();
    std::string identity = take(parvane_e2e_account_identity(acc));
    std::string signing = take(parvane_e2e_account_ed25519(acc));
    std::string fallback = take(parvane_e2e_account_gen_fallback(acc));
    json otks = json::parse(take(parvane_e2e_account_gen_otks(acc, 5, 1)));
    std::string device_id;
    std::map<std::string, ParvaneE2ESession *> sessions; // sender identity → сессия

    json bundle() {
        json d = {{"device_id", device_id}, {"signing_key", signing},
                  {"registration_id", 1}, {"identity_key", identity},
                  {"signed_prekey_id", 1}, {"signed_prekey", fallback},
                  {"signed_prekey_sig", ""}};
        if (!otks.empty()) {
            d["one_time_id"] = otks[0]["key_id"];
            d["one_time"] = otks[0]["public_key"];
            otks.erase(0);
        } else {
            d["one_time"] = nullptr;
        }
        return d;
    }
    // Расшифровать копию (prekey или обычную) от senderIdentity.
    std::string open(const std::string &senderIdentity, unsigned ctype, const std::string &ct) {
        if (ctype == 0) {
            char *pt = nullptr;
            auto *s = parvane_e2e_inbound(acc, senderIdentity.c_str(), 0, ct.c_str(), &pt);
            if (!s) return {};
            sessions[senderIdentity] = s;
            return take(pt);
        }
        auto it = sessions.find(senderIdentity);
        if (it == sessions.end()) return {};
        return take(parvane_e2e_decrypt(it->second, ctype, ct.c_str()));
    }
};

// In-memory identity: каталог устройств по адресу.
struct FakeTransport : parvane::ITransport {
    std::map<std::string, std::vector<FakeDevice *>> catalog;
    json lastPublish;
    int publishCount = 0;
    std::int64_t otkAvailable = 20;

    std::string request(const std::string &subject, const std::string &payload,
                        std::int64_t) override {
        const auto req = json::parse(payload);
        if (subject == parvane::topics::IdentityPrekeysPublish) {
            lastPublish = req;
            ++publishCount;
            return json{{"ok", true}}.dump();
        }
        if (subject == parvane::topics::IdentityDeviceList) {
            return json{{"ok", true},
                        {"devices", json::array({{{"device_id", lastPublish.value("device_id", "")},
                                                   {"signing_key", ""}, {"identity_key", ""},
                                                   {"updated_at", 0},
                                                   {"one_time_available", otkAvailable}}})}}.dump();
        }
        if (subject == parvane::topics::IdentityPrekeysFetch) {
            const auto user = req.value("user", "");
            auto it = catalog.find(user);
            if (it == catalog.end() || it->second.empty()) {
                return json{{"ok", false}, {"error", "нет ключей пользователя"}}.dump();
            }
            json devices = json::array();
            for (auto *d : it->second) {
                devices.push_back(d->bundle());
            }
            json r = devices[0];
            r["ok"] = true;
            r["devices"] = devices;
            return r.dump();
        }
        return "{}";
    }
    void publish(const std::string &, const std::string &) override {}
    void requestMany(const std::string &, const std::string &, const ReplyHandler &,
                     std::int64_t) override {}
    void subscribe(const std::string &, Handler) override {}
};

int main() {
    namespace e2e = parvane::e2e;
    const auto dir = std::filesystem::temp_directory_path() / "parvane-e2e-tests";
    std::filesystem::remove_all(dir);

    FakeTransport t;
    FakeDevice bob1, bob2;
    bob1.device_id = "";
    bob2.device_id = "bob-dev-2";
    t.catalog["bob@local"] = {&bob1, &bob2};

    e2e::initDevice(t, "alice@local", "tok", dir.string());
    check(e2e::ready(), "initDevice");
    check(!e2e::deviceId().empty(), "свежая установка получила device_id");
    check(t.publishCount == 1 && t.lastPublish.value("device_id", "x") == e2e::deviceId(),
          "бандл опубликован с device_id");
    check(t.lastPublish.value("signing_key", "") == e2e::signingKey() && !e2e::signingKey().empty(),
          "бандл несёт signing_key (Ed25519 аккаунта)");
    check(t.lastPublish["one_time"].size() == 20 && t.lastPublish["one_time"][0]["key_id"] == 1,
          "20 one-time с key_id от 1");
    check(t.lastPublish.value("signed_prekey", "") != e2e::myIdentity()
              && t.lastPublish.value("signed_prekey_sig", "") != "olm",
          "signed_prekey — настоящий fallback с подписью");

    // Fan-out: оба устройства bob получают копии, контент несёт signing key.
    const std::string content = R"({"kind":"text","text":"hi"})";
    auto sealed = e2e::sealForAddress("bob@local", content, t, "tok");
    check(sealed.has_value(), "sealForAddress");
    check(sealed->content.value("kind", "") == "encrypted"
              && sealed->content.value("sender_signing_key", "") == e2e::signingKey(),
          "конверт kind=encrypted + sender_signing_key");
    check(sealed->copies.size() == 2, "2 копии (по устройству bob)");
    int opened = 0;
    for (const auto &c : sealed->copies) {
        FakeDevice *d = c.device_id.empty() ? &bob1 : &bob2;
        const auto pt = d->open(sealed->content["sender_identity"], c.ctype, c.ciphertext);
        if (!pt.empty()) ++opened;
        check(c.recipient == "bob@local", "копия адресована bob");
    }
    check(opened == 2, "обе копии расшифровались своим устройством");
    // primary = устройство '' (legacy)
    check(sealed->content["ciphertext"] == sealed->copies[0].ciphertext
              || sealed->content["ciphertext"] == sealed->copies[1].ciphertext,
          "primary ciphertext совпадает с одной из копий");

    // Второе сообщение — обычные (ctype 1) сообщения, сессии переиспользуются.
    auto sealed2 = e2e::sealForAddress("bob@local", content, t, "tok");
    check(sealed2 && sealed2->copies.size() == 2, "повторная отправка — 2 копии");

    // Подпись sync-строки проверяется ключом устройства.
    const auto sig = e2e::sign("sync:0:0");
    check(parvane_e2e_ed25519_verify(e2e::signingKey().c_str(), "sync:0:0", sig.c_str()) == 1,
          "sign/verify Ed25519");
    check(parvane_e2e_ed25519_verify(e2e::signingKey().c_str(), "sync:0:1", sig.c_str()) == 0,
          "подпись другой строки не проходит");

    // Верификация отправителя: identity bob2 принадлежит bob; ключ alice — нет.
    check(e2e::verifySender("bob@local", bob2.identity, t, "tok") == e2e::Verdict::Ok,
          "verifySender: устройство bob → Ok");
    check(e2e::verifySender("bob@local", e2e::myIdentity(), t, "tok") == e2e::Verdict::Spoofed,
          "verifySender: мой ключ под именем bob → Spoofed");
    check(e2e::verifySender("alice@local", e2e::myIdentity(), t, "tok") == e2e::Verdict::Ok,
          "verifySender: мой ключ под своим именем → Ok");
    FakeDevice mallory;
    check(e2e::verifySender("bob@local", mallory.identity, t, "tok") == e2e::Verdict::Spoofed,
          "verifySender: чужой ключ под именем bob → Spoofed (каталог есть)");
    check(e2e::verifySender("nobody@local", mallory.identity, t, "tok") == e2e::Verdict::Unknown,
          "verifySender: нет каталога → Unknown");

    // pickOwnCopy: подстановка копии по device_id + signing_key.
    json copies = json::array({{{"recipient", ""}, {"signing_key", e2e::signingKey()},
                                {"device_id", e2e::deviceId()}, {"ciphertext", "MINE"}, {"ctype", 1}},
                               {{"recipient", "alice@local"}, {"device_id", "other"},
                                {"ciphertext", "OTHER"}, {"ctype", 0}}});
    json env = {{"kind", "encrypted"}, {"ciphertext", "PRIMARY"}, {"ctype", 0}};
    check(e2e::pickOwnCopy(env, copies, "alice@local").value("ciphertext", "") == "MINE",
          "pickOwnCopy берёт self-копию по signing_key");

    // Группы: конверт несёт sender_signing_key; входящий ключ и экспорт/импорт.
    const auto skey = e2e::groupSessionKey("g1");
    const auto epoch = e2e::groupEpoch("g1");
    const auto genc = json::parse(e2e::groupSeal("g1", content, epoch));
    check(genc.value("sender_signing_key", "") == e2e::signingKey(), "group_encrypted + signing key");
    e2e::groupAcceptKey("g1", bob2.identity, skey, 7); // чужая входящая (тот же ключ — для теста)
    check(!e2e::groupOpen("g1", bob2.identity, genc["ciphertext"]).empty(),
          "groupOpen по принятому ключу");

    // Линковка: экспорт → слияние в «другое устройство» (эмулируем: экспорт
    // содержит legacy-аккаунт = наш; import в себя же даёт dup → 0 legacy).
    const auto exported = e2e::exportStateJson(json{{"u1", {{"from", "bob@local"}}}});
    const auto st = json::parse(exported);
    check(st.value("version", 0) == 2 && st.contains("account") && st["groupIn"].contains("g1|" + bob2.identity),
          "exportStateJson: версия 2, account (libolm), groupIn exported");
    check(!e2e::needsHistoryLink(true), "needsHistoryLink=false — есть сессии");
    int dec = 0;
    const bool imported = e2e::importLinkedHistory(exported, [&](const std::string &id, const json &) {
        dec += (id == "u1");
    });
    check(imported && dec == 1, "importLinkedHistory: decCache через колбэк");
    check(e2e::extraSignatures("sync:0:0").empty(), "свой аккаунт не становится legacy");

    // Чужой аккаунт как legacy-подписант (libolm-pickle под pickleKey экспорта).
    FakeDevice old;
    json st2 = st;
    st2["account"] = take(parvane_e2e_account_to_libolm_pickle(old.acc, st.value("pickleKey", "").c_str()));
    st2["groupIn"] = json::object();
    check(e2e::importLinkedHistory(st2.dump(), nullptr), "импорт с чужим аккаунтом");
    const auto extra = e2e::extraSignatures("sync:0:0");
    check(extra.size() == 1 && extra[0].first == old.signing
              && parvane_e2e_ed25519_verify(old.signing.c_str(), "sync:0:0", extra[0].second.c_str()) == 1,
          "extraSignatures: подпись legacy-ключом прежнего устройства");

    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
