// Parvane fork: крипто авто-линковки истории (паритет с web linking.ts).
// Протокол v2 (P-03/P-48, правило LINK-1):
//   1. новое устройство публикует identity.link.offer с ОБЯЗАТЕЛЬСТВОМ
//      commitment = base64(SHA-256(raw eph_pub)) и своим signing_key;
//   2. старое устройство шлёт identity.link.challenge со своим эфемерным ключом;
//   3. новое раскрывает eph_pub (сервер сверяет с обязательством) и обе стороны
//      показывают SAS = 12 цифр от SHA-256("parvane-link-sas-v2"||new||old);
//   4. старое шифрует координаты экспорта и подписанный перенос владения в
//      «бокс» (ECDH → HKDF-SHA256(salt=32×0, info="parvane-link-v1") →
//      AES-256-GCM, iv 12 байт в начале бокса, без AAD) → identity.link.grant.
// Приватный Olm-аккаунт никуда не передаётся. Все base64 здесь — стандартные
// с padding (как btoa у веба).
#pragma once

#include <optional>
#include <string>

namespace parvane::linking {

// Эфемерная пара ECDH P-256. Приватная часть не покидает процесс.
class EphemeralKey {
public:
    static std::optional<EphemeralKey> generate();
    // Публичный ключ: несжатая точка 65 байт → base64 (padded).
    [[nodiscard]] std::string publicB64() const { return _pubB64; }
    // Приватный ключ (PKCS#8 DER, base64) — только для персиста в памяти процесса.
    [[nodiscard]] std::string privateDerB64() const { return _privB64; }
    static std::optional<EphemeralKey> fromPrivateDerB64(const std::string &privB64);

    // Запечатать plaintext для пира с публичным ключом peerPubB64 → бокс (base64).
    [[nodiscard]] std::optional<std::string> seal(const std::string &peerPubB64,
                                                  const std::string &plaintext) const;
    // Открыть бокс от пира. nullopt — чужой ключ/порча.
    [[nodiscard]] std::optional<std::string> open(const std::string &peerPubB64,
                                                  const std::string &boxB64) const;

private:
    std::string _pubB64;
    std::string _privB64;
};

// v2: обязательство на эфемерный ключ — base64(SHA-256(raw pub)).
[[nodiscard]] std::string commitment(const std::string &ephPubB64);
[[nodiscard]] bool commitmentMatches(const std::string &ephPubB64, const std::string &commitmentB64);
// v2: SAS от ПАРЫ ключей (новое, старое) — 12 цифр «dddd dddd dddd» (≈40 бит).
// "" — если хоть один ключ не base64.
[[nodiscard]] std::string sasCodeV2(const std::string &newPubB64, const std::string &oldPubB64);

// Стандартный base64 с padding (как btoa/atob).
[[nodiscard]] std::string b64encode(const std::string &raw);
[[nodiscard]] std::optional<std::string> b64decode(const std::string &b64);

// Случайные байты (OpenSSL RAND).
[[nodiscard]] std::string randomBytes(int n);

} // namespace parvane::linking
