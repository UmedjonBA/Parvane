// Parvane fork: тесты крипто линковки (ECDH P-256 → HKDF → AES-GCM, SAS v2, commitment).
#include "parvane/linking.h"

#include <cstdio>
#include <string>

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

int main() {
    using namespace parvane::linking;

    // base64 padded round-trip (совместимость с btoa/atob)
    check(b64encode("hi") == "aGk=", "b64encode padded");
    check(b64decode("aGk=").value_or("") == "hi", "b64decode padded");
    check(b64decode("aGk").value_or("") == "hi", "b64decode unpadded тоже читается");

    auto a = EphemeralKey::generate();
    auto b = EphemeralKey::generate();
    check(a && b, "generate");
    const auto rawPub = b64decode(a->publicB64());
    check(rawPub && rawPub->size() == 65 && (unsigned char)(*rawPub)[0] == 0x04,
          "публичный ключ — несжатая точка 65 байт");

    const std::string plain = R"({"file_id":"f1","file_key":"k","file_nonce":"n"})";
    const auto box = a->seal(b->publicB64(), plain);
    check(box.has_value(), "seal");
    const auto opened = b->open(a->publicB64(), *box);
    check(opened && *opened == plain, "open тем же секретом (ECDH симметричен)");

    auto c = EphemeralKey::generate();
    check(!c->open(a->publicB64(), *box).has_value(), "чужой приватный ключ → nullopt");
    auto tampered = *box;
    tampered[tampered.size() / 2] = (tampered[tampered.size() / 2] == 'A') ? 'B' : 'A';
    check(!b->open(a->publicB64(), tampered).has_value(), "порча бокса → nullopt");

    // Восстановление приватного ключа из DER
    auto a2 = EphemeralKey::fromPrivateDerB64(a->privateDerB64());
    check(a2 && a2->publicB64() == a->publicB64(), "fromPrivateDerB64 даёт тот же pub");
    check(a2->open(b->publicB64(), *b->seal(a->publicB64(), "x")).value_or("") == "x",
          "восстановленный ключ открывает бокс");

    // LINK-1 / P-03: обязательство на ключ — base64(SHA-256(raw pub)).
    // Кросс-клиентский вектор (тот же в web linking.test.ts): pub = 65 нулевых байт.
    const std::string zeros(65, '\0');
    const std::string newB64 = b64encode(zeros);
    check(commitment(newB64) == "mM5C3u9R1AJp1UL1MUvvLHRo1AGtXYUWi/q0wBCPdfc=",
          "commitment: вектор 65x00 совпадает с web");
    check(commitmentMatches(a->publicB64(), commitment(a->publicB64())), "commitmentMatches: свой ключ");
    check(!commitmentMatches(b->publicB64(), commitment(a->publicB64())), "commitmentMatches: чужой ключ");
    check(!commitmentMatches("", commitment(a->publicB64())) && !commitmentMatches(a->publicB64(), ""),
          "commitmentMatches: пустые строки → false");

    // LINK-1 / P-03: SAS v2 от ПАРЫ ключей, 12 цифр «dddd dddd dddd».
    // Вектор: new = 65x00, old = 0x04 || 64x01 → 5659 7031 8371 (см. web-тест).
    std::string oldRaw(65, '\x01');
    oldRaw[0] = '\x04';
    const std::string oldB64 = b64encode(oldRaw);
    const auto sas = sasCodeV2(newB64, oldB64);
    check(sas == "5659 7031 8371", ("sasCodeV2: кросс-клиентский вектор (" + sas + ")").c_str());
    check(sas.size() == 14 && sas[4] == ' ' && sas[9] == ' ', "sasCodeV2: формат 4-4-4");
    check(sasCodeV2(oldB64, newB64) != sas, "sasCodeV2: порядок (new, old) фиксирован");
    check(sasCodeV2(a->publicB64(), b->publicB64()) == sasCodeV2(a->publicB64(), b->publicB64()),
          "sasCodeV2 детерминирован");
    check(sasCodeV2(a->publicB64(), b->publicB64()) != sasCodeV2(a->publicB64(), c->publicB64()),
          "sasCodeV2: другой ключ старого устройства → другой код");
    check(sasCodeV2("не-base64!", oldB64).empty(), "sasCodeV2: мусор → пусто");

    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
