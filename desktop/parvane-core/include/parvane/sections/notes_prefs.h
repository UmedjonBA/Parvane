// Parvane fork (spec 029, фаза 4): настройки раздела «Знания» на этом устройстве — порт чистой части web
// `components/parvane/notes/notesPrefs.ts`: ключи, значения по умолчанию и разбор/запись значений. Само хранение
// (в web — localStorage) — дело интерфейса: здесь только строки, которые он кладёт и читает. Значение «нет» —
// nullopt (ключа нет либо хранилище недоступно).
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace parvane::sections::notes {

// Картинки карточек холста: сам файл (по умолчанию) либо миниатюра облака — экономия трафика
enum class CanvasImageQuality { Full, Thumb };

inline const std::string kKnowledgeCollapsedKey = "parvane:knowledge-collapsed";
inline const std::string kKnowledgeGuideSeenKey = "parvane:knowledge-guide-seen";
inline const std::string kKnowledgeGraphFoldersKey = "parvane:knowledge-graph-folders";
inline const std::string kKnowledgeCanvasImagesKey = "parvane:knowledge-canvas-images";
inline constexpr size_t kCollapsedFoldersMax = 200;

/** Ключи свёрнутых групп списка (пути папок) из сохранённой строки; негодное — пусто. */
std::vector<std::string> parseCollapsedFolders(const std::optional<std::string> &stored);
/** Строка для записи: не больше `kCollapsedFoldersMax` ключей. */
std::string serializeCollapsedFolders(const std::vector<std::string> &keys);
/** Папки, выбранные на графе (корень — пустая строка); nullopt — все папки. */
std::optional<std::vector<std::string>> parseGraphFolders(const std::optional<std::string> &stored);
/** Строка для записи; nullopt — ключ удаляется (все папки). */
std::optional<std::string> serializeGraphFolders(const std::optional<std::vector<std::string>> &paths);
/** Ключ отметки «справку уже показывали» для пользователя. */
std::string guideSeenKey(const std::optional<std::string> &userId);
bool isGuideSeenValue(const std::optional<std::string> &stored);
inline const std::string kGuideSeenValue = "1";
CanvasImageQuality parseCanvasImageQuality(const std::optional<std::string> &stored);
std::string canvasImageQualityValue(CanvasImageQuality quality);

} // namespace parvane::sections::notes
