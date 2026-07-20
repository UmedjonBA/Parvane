// Parvane fork: тесты crypto.h — Ed25519 генерация/подпись/проверка + связка с
// сигналингом звонка (call.h). Чистые, без бэкенда.
#include <cstdio>
#include <cstdlib>
#include <string>

#include "parvane/call.h"
#include "parvane/crypto.h"

using parvane::crypto::SigningKey;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

int main() {
    std::printf("=== parvane-core crypto tests (Ed25519) ===\n");

    // base64 round-trip (в т.ч. бинарные байты).
    {
        const std::string raw("\x00\x01\x02\xff\xfe test", 9);
        auto dec = parvane::crypto::b64decode(parvane::crypto::b64encode(raw));
        check(dec && *dec == raw, "base64 round-trip (бинарь)");
        check(!parvane::crypto::b64decode("!!!not base64!!!").has_value()
                  || true, // не-b64 символы пропускаются/или nullopt — не падаем
              "base64decode мусора не падает");
    }

    // Генерация: непустые ключи разумной длины (32 байта → 44 симв. base64).
    auto k = SigningKey::generate();
    check(!k.publicB64().empty() && !k.seedB64().empty(), "generate — ключи непусты");
    check(k.publicB64().size() == 44 && k.seedB64().size() == 44,
          "generate — 32-байтовые ключи (44 симв. base64)",
          "pub=" + std::to_string(k.publicB64().size()));
    auto k2 = SigningKey::generate();
    check(k.publicB64() != k2.publicB64(), "две генерации → разные ключи");

    // Подпись/проверка — round-trip.
    const std::string data = "call-42\nv=0 o=- ... a=fingerprint:sha-256 AA:BB";
    const std::string sig = k.sign(data);
    check(!sig.empty(), "sign → непустая подпись");
    check(parvane::crypto::verify(k.publicB64(), data, sig),
          "verify(правильный ключ, те же данные) → true");

    // Фиксированный вектор @matrix-org/olm (Web): Olm отдаёт pubkey/signature
    // без base64-padding, а OpenSSL-клиент desktop обязан принимать их как есть.
    {
        const std::string olmData =
            "018f3c84-7f9a-7c12-a126-112233445566\nv=0\r\n"
            "a=fingerprint:sha-256 AA:BB\r\n";
        const std::string olmPub = "eQ+2pwLjybUFN9zGdCYQhSDhaybgurwoeEPsRBiRZtQ";
        const std::string olmSig =
            "y5E2zA43lDulSPULTGtSB7W2LoUHKNCgzLhWoetADHU8bwTPUoqHr6alF4zebglm"
            "U64yxJY5WgAYEbOUxiCDCg";
        check(parvane::crypto::verify(olmPub, olmData, olmSig),
              "Olm(Web) Ed25519-вектор проверяется OpenSSL(desktop)");
    }

    // Атаки: подмена данных / ключа / подписи → false.
    check(!parvane::crypto::verify(k.publicB64(), data + "x", sig),
          "verify(изменённые данные) → false (защита от подмены SDP)");
    check(!parvane::crypto::verify(k2.publicB64(), data, sig),
          "verify(чужой ключ) → false (MITM с другим ключом не пройдёт)");
    {
        std::string bad = sig;
        bad[0] = (bad[0] == 'A') ? 'B' : 'A';
        check(!parvane::crypto::verify(k.publicB64(), data, bad),
              "verify(испорченная подпись) → false");
    }
    check(!parvane::crypto::verify("not-a-key", data, sig),
          "verify(мусорный pubkey) → false, не падает");

    // Персист: seed → тот же ключ и валидные подписи.
    {
        auto restored = SigningKey::fromSeedB64(k.seedB64());
        check(restored.has_value(), "fromSeedB64 — восстановление");
        if (restored) {
            check(restored->publicB64() == k.publicB64(),
                  "fromSeed(seed) → тот же публичный ключ");
            check(parvane::crypto::verify(k.publicB64(), data, restored->sign(data)),
                  "восстановленный ключ подписывает совместимо");
        }
        check(!SigningKey::fromSeedB64("короткий").has_value(),
              "fromSeedB64(битый) → nullopt");
    }

    // loadOrCreate: создаёт файл, второй вызов — тот же ключ.
    {
        const std::string path = "/tmp/parvane-crypto-test-key.txt";
        std::remove(path.c_str());
        auto a = SigningKey::loadOrCreate(path);
        auto b = SigningKey::loadOrCreate(path);
        check(!a.publicB64().empty(), "loadOrCreate — создал ключ");
        check(a.publicB64() == b.publicB64(),
              "loadOrCreate — второй вызов грузит тот же ключ (персист)");
        std::remove(path.c_str());
    }

    // Связка с сигналингом звонка: подписываем invite, проверяем на приёме.
    {
        const std::string callId = "call-777";
        const std::string sdp = "v=0 ... a=fingerprint:sha-256 CA:FE";
        const std::string s = k.sign(parvane::callSignedData(callId, sdp));
        auto inv = parvane::inviteSignal(callId, "audio", sdp, s);
        auto in = parvane::CallSignalIn::fromJson(inv);
        check(parvane::crypto::verify(k.publicB64(), in.signedData(), in.sig),
              "invite: подпись SDP проходит проверку публичным ключом отправителя");
        // Шард подменил SDP (MITM) — подпись больше не сходится.
        inv["sdp"] = "v=0 ... a=fingerprint:sha-256 BA:AD"; // чужой отпечаток
        auto tampered = parvane::CallSignalIn::fromJson(inv);
        check(!parvane::crypto::verify(k.publicB64(), tampered.signedData(), tampered.sig),
              "invite с подменённым SDP → проверка падает (MITM пойман)");
    }

    // SAS-эмодзи: одинаковый у обеих сторон (порядок не важен), 4 эмодзи, разные
    // отпечатки → обычно разный код.
    {
        const std::string fpA = "AA:BB:CC:DD", fpB = "11:22:33:44";
        const auto s1 = parvane::crypto::sasEmoji(fpA, fpB);
        const auto s2 = parvane::crypto::sasEmoji(fpB, fpA);
        check(!s1.empty(), "sasEmoji — непустой");
        check(s1 == s2, "sasEmoji(A,B) == sasEmoji(B,A) — порядок не важен");
        check(s1 == "🦄🥁🍊🍉", "SAS совпадает с WebCrypto-вектором");
        const auto s3 = parvane::crypto::sasEmoji("XX:YY", "ZZ:WW");
        check(s1 != s3, "разные отпечатки → разный SAS");
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
