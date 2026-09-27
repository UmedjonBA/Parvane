// Parvane fork: тесты E2E-шифрования блобов (Фаза 3). Чистые, без backend.
#include "parvane/blobcrypt.h"

#include "parvane/crypto.h"

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

    // ── P-24 / BLOB-1: чанковый AEAD v2 ─────────────────────────────────────
    {
        const std::string big(700 * 1024 + 123, 'z'); // 3 чанка по 256 КиБ
        auto ev = encrypt(big);
        auto hdr = parseHeader(ev.ciphertext);
        check(hdr.has_value() && hdr->chunkSize == kDefaultChunkSize, "v2: заголовок PVB2 + chunkSize");
        check(chunkCount(ev.ciphertext.size(), *hdr) == 3, "v2: 3 чанка");
        check(plaintextSize(ev.ciphertext.size(), *hdr) == big.size(), "v2: размер plaintext из длины");
        auto dv = decrypt(ev.ciphertext, ev.keyB64, ev.nonceB64);
        check(dv.has_value() && *dv == big, "v2: decrypt целиком");

        // окно: только второй чанк
        const std::size_t full = kDefaultChunkSize + kTagLen;
        auto mid = decryptChunks(ev.ciphertext.substr(kHeaderLen + full, full), ev.keyB64, ev.nonceB64, *hdr, 1, 3);
        check(mid.has_value() && *mid == big.substr(kDefaultChunkSize, kDefaultChunkSize), "v2: окно одного чанка проверено и расшифровано");
        // подделка внутри чанка → nullopt именно для этого окна
        auto bad = ev.ciphertext;
        bad[kHeaderLen + full + 10] ^= 0x1;
        check(!decryptChunks(bad.substr(kHeaderLen + full, full), ev.keyB64, ev.nonceB64, *hdr, 1, 3).has_value(),
              "v2: бит-флип в окне → nullopt (тег чанка)");
        check(!decrypt(bad, ev.keyB64, ev.nonceB64).has_value(), "v2: бит-флип → decrypt целиком nullopt");
        // усечение (без последнего чанка) и перестановка чанков → nullopt (AAD: индекс и n)
        check(!decrypt(ev.ciphertext.substr(0, kHeaderLen + 2 * full), ev.keyB64, ev.nonceB64).has_value(),
              "v2: усечённый файл → nullopt");
        auto swapped = ev.ciphertext.substr(0, kHeaderLen) + ev.ciphertext.substr(kHeaderLen + full, full)
                       + ev.ciphertext.substr(kHeaderLen, full) + ev.ciphertext.substr(kHeaderLen + 2 * full);
        check(!decrypt(swapped, ev.keyB64, ev.nonceB64).has_value(), "v2: перестановка чанков → nullopt");
        check(!decryptChunks(ev.ciphertext.substr(kHeaderLen, full), ev.keyB64, ev.nonceB64, *hdr, 1, 3).has_value(),
              "v2: чанк под чужим индексом → nullopt");
        // пустой блоб v2
        auto e0 = encrypt("");
        auto d0 = decrypt(e0.ciphertext, e0.keyB64, e0.nonceB64);
        check(d0.has_value() && d0->empty() && parseHeader(e0.ciphertext).has_value(), "v2: пустой блоб round-trip");
    }
    // legacy v1 по-прежнему читается (вектор: ключ 32×0x01, nonce 12×0x02)
    {
        const std::string key(32, '\x01'), nonce(12, '\x02');
        const std::string keyB64 = parvane::crypto::b64encode(key), nonceB64 = parvane::crypto::b64encode(nonce);
        // v1 = ровно один GCM без AAD — получаем через приватную схему: v2 c chunkSize не подходит,
        // поэтому проверяем совместимость на векторе из conformance (BLOB-1.legacy).
        auto v1 = parvane::crypto::b64decode("d7e7Pys5pN2xoNOqfNHzVpFQwpooOo/gVIDan1UXaA==");
        check(v1.has_value(), "v1: вектор разобран");
        auto dv1 = v1 ? decrypt(*v1, keyB64, nonceB64) : std::nullopt;
        check(dv1.has_value() && *dv1 == "parvane blob v1", "v1: legacy-вектор расшифрован");
        // кросс-клиентский вектор v2 (BLOB-1.vector): chunkSize=1024, plaintext 1500 байт "a"
        const std::string plain(1500, 'a');
        const auto ct = encryptWithKey(plain, key, nonce, 1024);
        check(!ct.empty() && ct.size() == kHeaderLen + 1500 + 2 * kTagLen, "v2 vector: длина");
        std::printf("BLOB-1.vector sha-free head hex: ");
        for (std::size_t i = 0; i < 24; ++i) std::printf("%02x", static_cast<unsigned char>(ct[i]));
        std::printf("\nBLOB-1.vector tail hex: ");
        for (std::size_t i = ct.size() - 16; i < ct.size(); ++i) std::printf("%02x", static_cast<unsigned char>(ct[i]));
        std::printf("\n");
        auto back = decrypt(ct, keyB64, nonceB64);
        check(back.has_value() && *back == plain, "v2 vector: round-trip");
    }

    std::printf(g_fail ? "\nПРОВАЛЫ: %d\n" : "\nВСЕ ОК\n", g_fail);
    return g_fail ? 1 : 0;
}
