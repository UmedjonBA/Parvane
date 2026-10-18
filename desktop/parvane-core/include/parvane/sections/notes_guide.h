// Parvane fork (spec 029, фаза 4): справка Parvane — папка связанных заметок о продукте в хранилище «Знаний». Порт
// web `components/parvane/notes/notesGuide.ts` (тексты — `notes/guide/ru.ts`, `en.ts`). Создаётся один раз на
// аккаунт: в новом хранилище и в хранилище, где её ещё не было. «Была ли» хранит файл-отметка в корне хранилища
// (не заметка: в список и на граф не попадает) — он общий для устройств аккаунта и переживает удаление самой
// справки. Здесь только чистая логика: тексты, идентификаторы узлов и решение, что записать.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"

namespace parvane::sections::notes {

// Язык справки: "ru" | "en". Постоянные имена заметок (`GuideNote::key`): overview, chats, calendar, input, health,
// notes, boards, files, connections, security, appearance, shortcuts
using GuideLang = std::string;

// Сверка личного диска с сервером: без неё судить «ещё нет» нельзя
enum class GuideDrive { Unknown, None, Synced };
// `Auto` — один раз на аккаунт, узлы с постоянными идентификаторами; `Restore` — по кнопке, только недостающее
enum class GuideMode { Auto, Restore };
enum class GuideSkipReason { DriveUnknown, HasMarker, VaultTrashed, Complete };

struct GuideNote {
    std::string key;
    std::string nodeId;
    std::string title;
    std::string text;
};

struct GuideQuickSample {
    std::string text;
    std::string kind;
};

struct Guide {
    GuideLang lang;
    std::string folderName;
    std::string overviewTitle;
    std::vector<GuideNote> notes;
    std::vector<std::string> datedSamples;
    std::vector<GuideQuickSample> quickSamples;
};

struct GuideFolderWrite {
    std::string id;
    std::string name;
    std::optional<std::string> parent;
    bool operator==(const GuideFolderWrite &) const = default;
};

// `nodeId` не задан — узел получает случайный идентификатор
struct GuideNoteWrite {
    std::string key;
    std::string title;
    std::string text;
    std::optional<std::string> nodeId;
};

struct GuidePlan {
    bool isWrite = false;
    // При `isWrite == false` — почему ничего не делать
    GuideSkipReason reason = GuideSkipReason::Complete;
    // Хранилища ещё не было: оно создаётся вместе со справкой
    bool isFreshVault = false;
    std::string vaultId;
    // Папка справки: существующая либо создаваемая этой же правкой
    std::string folderId;
    // Папки одной правкой, от корня вглубь
    std::vector<GuideFolderWrite> folders;
    std::vector<GuideNoteWrite> notes;
    // Заметки справки, которых не будет: название занято заметкой пользователя либо узел уже существует
    std::vector<std::string> skipped;
    bool hasMarkerWrite = false;
};

struct GuidePlanInput {
    GuideDrive drive = GuideDrive::Unknown;
    std::vector<cloud::CloudNode> nodes;
    GuideLang lang = "ru";
    // Название новой папки хранилища и все названия, под которыми она бывает
    std::string vaultName;
    std::vector<std::string> vaultNames;
    GuideMode mode = GuideMode::Auto;
    // Идентификатор новой папки, когда постоянный не годится
    std::function<std::string()> makeId;
};

// Заметка для поиска «Обзора»
struct GuideNoteRef {
    std::string id;
    std::string title;
};

inline constexpr int kGuideVersion = 1;
inline const std::string kGuideMarkerName = ".parvane-guide.json";
inline const std::string kGuideMarkerMime = "application/json";
// Постоянные идентификаторы: два устройства, создающие справку одновременно, дают одни и те же узлы
inline const std::string kVaultNodeId = "70617276616e652d6b6e6f776c656467";
const std::string &guideFolderNodeId();
const std::string &guideMarkerNodeId();

/** Язык справки по коду языка интерфейса. */
GuideLang getGuideLang(const std::optional<std::string> &code);
std::string guideNoteNodeId(int slot);
Guide buildGuide(const GuideLang &lang);
/** Содержимое файла-отметки. */
std::string buildGuideMarker(const GuideLang &lang, int64_t createdAt);
/** Справку этому аккаунту уже создавали: отметка есть в хранилище, пусть и в корзине. */
bool hasGuideMarker(const std::vector<cloud::CloudNode> &nodes, const std::vector<std::string> &vaultNames);
/** «Обзор» справки среди заметок: по постоянному узлу либо по названию на любом из языков. Индекс в `notes`. */
std::optional<size_t> findGuideOverview(const std::vector<GuideNoteRef> &notes);
/** Что записать, чтобы справка появилась, — либо причина ничего не делать. */
GuidePlan planGuide(const GuidePlanInput &input);

} // namespace parvane::sections::notes
