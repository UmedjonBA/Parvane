// Parvane fork: высокоуровневый cloud-клиент поверх Transport. Инкапсулирует
// разбиение блоба на чанки, base64, сборку конверта ParvaneEvent<T> и (де)-
// сериализацию file.* пейлоадов. Используется glue-слоем tdesktop (Фаза 4:
// отправка/приём медиа) и тестами.
//
// Потокобезопасность: методы блокирующие (request/requestMany транспорта).
// Звать upload/download из worker-потока, не из main/UI.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "parvane/cloud.h"
#include "parvane/transport.h"

namespace parvane {

class CloudClient {
public:
    explicit CloudClient(ITransport &transport) : _t(transport) {}

    // Загружает `bytes` в облако: разбивает на чанки по chunkSize, каждый чанк —
    // request/reply (ждём ack сохранения от шарда), затем file.upload.complete.
    // Возвращает сгенерированный file_id (uuid v7). Бросает TransportError при
    // таймауте/сетевой ошибке; std::runtime_error — если шард отверг чанк/файл.
    std::string upload(const std::string &from, const std::string &token,
                       const std::string &filename, const std::string &mime,
                       const std::string &bytes,
                       const std::vector<std::string> &recipients = {},
                       bool publicAccess = false,
                       std::size_t chunkSize = 256 * 1024, int timeoutMs = 5000);

    // Результат скачивания: собранные байты + метаданные.
    struct Downloaded {
        bool ok = false;
        std::string filename;
        std::string mime;
        std::string bytes;   // склеенные по порядку чанки
        std::string error;   // при ok=false
    };

    // Скачивает файл по fileId: собирает N чанков с reply-инбокса (см.
    // Transport::requestMany), декодирует base64 и склеивает по chunk_index.
    Downloaded download(const std::string &from, const std::string &token,
                        const std::string &fileId, int timeoutMs = 5000);

    // Список файлов владельца (request/reply на file.list.request).
    std::vector<FileEntry> list(const std::string &from, const std::string &token,
                                int timeoutMs = 3000);

private:
    ITransport &_t;
};

} // namespace parvane
