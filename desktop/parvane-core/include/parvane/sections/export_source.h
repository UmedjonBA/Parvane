// Parvane fork (spec 029, T034): источник данных «Выгрузки данных» — порт web `components/parvane/export/exportSource.ts`.
// Всё берётся на устройстве методами провайдера: снимок переписки (`parvaneExportSnapshot`), вложения
// (`parvaneExportMedia`), «План» (`parvanePlannerState`, запасной — `parvanePlannerCachedState`), заметки «Знаний»
// (`parvaneCloudState` + `parvaneCloudReadTexts` пачками по 40), файлы облака (`parvaneCloudExportBlob`). Сборка
// архива — `runDataExport` (export_model.h).
//
// Отличия от web по устройству: ожидание готовности («План», облако — до 30 с, опрос раз в 0,5 с) идёт на явных
// часах хоста (`nowMs`/`sleepMs`); байты блобов (в web — `Blob`) хост отдаёт кусками (`ZipWriter::ChunkSource`);
// отмена — функция `canceled` вместо AbortSignal: если скачивание блоба бросило при поднятой отмене, источник шлёт
// `parvaneCloudCancelDownload` и бросает `ExportError(canceled)`. Диаг-задержка e2e (`parvane:e2e:exportDelayMs`)
// не перенесена — только для сценариев web.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "parvane/sections/export_model.h"

namespace parvane::sections::exportdata {

inline constexpr int kReadTextsBatch = 40;
inline constexpr int64_t kReadyWaitMs = 30000;
inline constexpr int64_t kReadyPollMs = 500;

class ExportHost {
public:
    virtual ~ExportHost() = default;
    // Вызов провайдера по имени web; nullopt — вызов не удался (исключение web), ответ `undefined` — json null
    virtual std::optional<nlohmann::json> callParvane(const std::string &method, const nlohmann::json &args) = 0;
    // Байты блоба по методу провайдера (`parvaneExportMedia {fileId}`, `parvaneCloudExportBlob {container, node,
    // transferId}`) кусками; nullopt — недоступно. Сбой — исключение
    virtual std::optional<ZipWriter::ChunkSource> blob(const std::string &method, const nlohmann::json &args) = 0;
    virtual int64_t nowMs() = 0;
    // Пауза ожидания готовности (поток вызывающего)
    virtual void sleepMs(int64_t ms) {}
};

struct ProviderNames {
    std::string drive = "Drive"; // название личного диска в архиве
};

// Снимок провайдера (web `ExportSnapshot`, JSON) → структура ядра
ExportSnapshot snapshotFromJson(const nlohmann::json &j);

// Источник поверх провайдера (web `createProviderSource`). Хост должен жить дольше источника
ExportSource createProviderSource(ExportHost &host, ProviderNames names, std::function<bool()> canceled = {});

} // namespace parvane::sections::exportdata
