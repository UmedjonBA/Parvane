// Parvane fork: тесты E2E-шифрования блобов (Фаза 3). Чистые, без backend.
#include "parvane/blobcrypt.h"

#include <cstdio>
#include <string>

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

int main() {
    using namespace parvane::blobcrypt;

    // round-trip (с бинарными байтами через явную конструкцию — литерал с \x00
    // оборвался бы)
    std::string plain = "секретный блоб бинарные байты";
    plain.push_back('\x00');
    plain.push_back('\x01');
    plain.push_back('\xff');
    plain += "хвост";
    auto e = encrypt(plain);
    check(!e.ciphertext.empty() && !e.keyB64.empty() && !e.nonceB64.empty(),
          "encrypt дал ciphertext+key+nonce");
    check(e.ciphertext.find(plain) == std::string::npos, "ciphertext != plaintext");
    auto d = decrypt(e.ciphertext, e.keyB64, e.nonceB64);
    check(d.has_value() && *d == plain, "decrypt восстановил байты");

    // подделка ciphertext → tag не сойдётся
    auto tampered = e.ciphertext;
    tampered[0] ^= 0x1;
    check(!decrypt(tampered, e.keyB64, e.nonceB64).has_value(),
          "подделка ciphertext → nullopt (GCM tag)");

    // чужой ключ → nullopt
    auto e2 = encrypt("другое");
    check(!decrypt(e.ciphertext, e2.keyB64, e.nonceB64).has_value(),
          "чужой ключ → nullopt");

    // пустой блоб round-trip
    auto ee = encrypt("");
    auto dd = decrypt(ee.ciphertext, ee.keyB64, ee.nonceB64);
    check(dd.has_value() && dd->empty(), "пустой блоб round-trip");

    // разные ключи каждый раз
    check(encrypt(plain).keyB64 != encrypt(plain).keyB64, "ключ случаен на каждый блоб");

    std::printf(g_fail ? "\nПРОВАЛЫ: %d\n" : "\nВСЕ ОК\n", g_fail);
    return g_fail ? 1 : 0;
}
