// Parvane fork: блобы владельца через мост v2 (spec 029): свой либо открытый блоб (аватар, фото группы,
// блоб линковки своему устройству) — методами `cloud.blob.*` управляющего соединения моста. Вложения
// сообщений идут по capability через v2-сессию (Session::uploadBlob/downloadBlobCap), не здесь.
//
// Потокобезопасность: методы блокирующие — звать из worker-потока, не из main/UI.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "parvane/itransport.h"

namespace parvane {

class CloudClient {
public:
    explicit CloudClient(ITransport &transport) : _t(transport) {}

    // Загрузить блоб владельца (recipients — только сам владелец либо пусто; грантов получателям в v2
    // нет). Возвращает file_id. Бросает std::runtime_error при отказе и если транспорт — не мост v2.
    std::string upload(const std::string &from, const std::string &token,
                       const std::string &filename, const std::string &mime,
                       const std::string &bytes,
                       const std::vector<std::string> &recipients = {},
                       bool publicAccess = false,
                       std::size_t chunkSize = 256 * 1024, int timeoutMs = 5000);

    struct Downloaded {
        bool ok = false;
        std::string filename;
        std::string mime;
        std::string bytes;
        std::string error; // при ok=false
    };

    // Скачать свой, открытый либо выданный блоб (имени и MIME в ответе v2 нет).
    Downloaded download(const std::string &from, const std::string &token,
                        const std::string &fileId, int timeoutMs = 5000);

private:
    ITransport &_t;
};

} // namespace parvane
