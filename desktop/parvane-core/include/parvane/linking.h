// Parvane fork: крипто авто-линковки истории (паритет с web linking.ts).
// Новое устройство публикует эфемерный ECDH P-256 ключ (identity.link.offer),
// старое — шифрует координаты перенесённого экспорта в «бокс»
// (ECDH → HKDF-SHA256(salt=32×0, info="parvane-link-v1") → AES-256-GCM, iv 12 байт
// в начале бокса, без AAD) и отдаёт identity.link.grant. 6-значный SAS — от
// SHA-256 сырых байт эфемерного ключа нового устройства (защита от вора пароля).
// Все base64 здесь — стандартные С padding (как btoa у веба).
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

// 6-значный SAS-код из эфемерного публичного ключа (base64).
[[nodiscard]] std::string sasCode(const std::string &ephPubB64);

// Стандартный base64 с padding (как btoa/atob).
[[nodiscard]] std::string b64encode(const std::string &raw);
[[nodiscard]] std::optional<std::string> b64decode(const std::string &b64);

// Случайные байты (OpenSSL RAND).
[[nodiscard]] std::string randomBytes(int n);

} // namespace parvane::linking
