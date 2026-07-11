// Probe: доказать C++↔Rust FFI parvane-e2e (round-trip через vodozemac) до
// врезки в tdesktop. Линкуется напрямую с libparvane_e2e.a. Без внешних
// зависимостей (crude-парсинг JSON и известный base64).
#include "parvane_e2e.h"

#include <cstdio>
#include <cstring>
#include <string>

// Вытащить значение "public_key":"..." из JSON-массива otks (crude, для probe).
static std::string firstPublicKey(const char *json) {
    std::string s = json ? json : "";
    const std::string key = "\"public_key\":\"";
    auto p = s.find(key);
    if (p == std::string::npos) return {};
    p += key.size();
    auto e = s.find('"', p);
    return s.substr(p, e - p);
}

int main() {
    bool pass = true;
    auto check = [&](bool c, const char *msg) {
        std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
        if (!c) pass = false;
    };

    // Bob публикует бандл.
    auto *bob = parvane_e2e_account_new();
    char *otks = parvane_e2e_account_gen_otks(bob, 1, 1);
    const std::string otk = firstPublicKey(otks);
    char *bobId = parvane_e2e_account_identity(bob);
    check(otks && !otk.empty() && bobId, "bob: identity + one-time сгенерированы");

    // Alice: исходящая сессия по бандлу + шифр "hi" (base64 "aGk=").
    auto *alice = parvane_e2e_account_new();
    char *aliceId = parvane_e2e_account_identity(alice);
    auto *asess = parvane_e2e_outbound(alice, bobId, otk.c_str());
    check(asess != nullptr, "alice: исходящая сессия (X3DH)");

    uint32_t mtype = 99;
    char *ct = asess ? parvane_e2e_encrypt(asess, "aGk", &mtype) : nullptr;
    check(ct != nullptr && mtype == 0, "alice: шифр (pre-key, type=0)");

    // Bob: входящая сессия + расшифровка первого сообщения.
    char *outPt = nullptr;
    auto *bsess = ct ? parvane_e2e_inbound(bob, aliceId, mtype, ct, &outPt) : nullptr;
    check(bsess != nullptr && outPt != nullptr, "bob: входящая сессия");
    check(outPt && std::strcmp(outPt, "aGk") == 0, "bob: расшифровал hi (unpadded aGk)");

    // Ratchet: второе сообщение "ok" (base64 "b2s=").
    uint32_t t2 = 99;
    char *ct2 = asess ? parvane_e2e_encrypt(asess, "b2s", &t2) : nullptr;
    char *pt2 = (bsess && ct2) ? parvane_e2e_decrypt(bsess, t2, ct2) : nullptr;
    check(pt2 && std::strcmp(pt2, "b2s") == 0, "ratchet: 2-е сообщение расшифровано");

    // Cleanup.
    parvane_e2e_string_free(otks);
    parvane_e2e_string_free(bobId);
    parvane_e2e_string_free(aliceId);
    parvane_e2e_string_free(ct);
    parvane_e2e_string_free(outPt);
    parvane_e2e_string_free(ct2);
    parvane_e2e_string_free(pt2);
    parvane_e2e_session_free(asess);
    parvane_e2e_session_free(bsess);
    parvane_e2e_account_free(alice);
    parvane_e2e_account_free(bob);

    std::printf(pass ? "PASS: C++ FFI E2E работает\n" : "FAIL\n");
    return pass ? 0 : 1;
}
