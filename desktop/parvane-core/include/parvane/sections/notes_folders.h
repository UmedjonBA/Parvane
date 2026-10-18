// Parvane fork (spec 029, фаза 4): папки заметок «Знаний» — порт web `components/parvane/notes/notesFolders.ts`.
// Папки облака внутри хранилища. Чистые функции над деревом облака и списком заметок: перечень папок, проверка
// названия, содержимое папки, группы списка заметок. Тексты причин отказа — ключи строк web (`FOLDER_ERROR_KEYS`).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"

namespace parvane::sections::notes {

// `path` — названия папок от хранилища через «/»: то же значение, что `folder` у заметки
struct NoteFolder {
    std::string id;
    std::string path;
    std::string name;
    bool operator==(const NoteFolder &) const = default;
};

enum class FolderNameError { BadName, Taken };
// Причина отказа формы папки: ошибка названия либо сбой записи
enum class FolderSubmitError { BadName, Taken, Failed };
// Ключ строки web: KnowledgeFolderBadName | KnowledgeFolderTaken | KnowledgeFolderFailed
const char *folderErrorKey(FolderSubmitError error);

struct GroupedNote {
    // Чем строку узнаёт интерфейс (в web — сама запись заметки)
    std::string id;
    std::string title;
    std::string folder;
    bool isDaily = false;
    bool operator==(const GroupedNote &) const = default;
};

struct NoteGroup {
    std::string key;
    std::string folder;
    // Узел папки; у «Без папки» и у папки, которой в дереве уже нет, его нет
    std::optional<std::string> folderId;
    bool isDaily = false;
    std::vector<GroupedNote> items;
    // Сколько заметок дня не показано
    int hidden = 0;
};

struct FolderContents {
    std::vector<cloud::CloudNode> notes;
    std::vector<cloud::CloudNode> others;
};

struct NoteGroupsInput {
    std::vector<GroupedNote> notes;
    std::vector<NoteFolder> folders;
    // Названия папки заметок дня: пустая, она отдельной строкой не показывается
    std::vector<std::string> dailyFolders;
    bool isSearch = false;
    // Сколько заметок дня показать; не задано — все
    std::optional<int> dailyShown;
};

inline const std::string kRootFolder;
inline const std::string kDailyGroupKey = std::string("\0daily", 6);
inline constexpr int kFolderNameMax = 80;

/** Папки хранилища, вложенные тоже; папки в корзине не считаются. По пути, по алфавиту. */
std::vector<NoteFolder> listNoteFolders(const std::vector<cloud::CloudNode> &nodes, const std::string &vaultId);
/** Подпись папки в списке: вложенная — «А / Б». */
std::string folderCaption(const std::string &path);
/** Заметка лежит в папке либо глубже. */
bool isInFolder(const std::string &noteFolder, const std::string &path);
/** Годится ли название для папки рядом с `siblings` (регистр не различается). */
std::optional<FolderNameError> checkFolderName(const std::string &name, const std::vector<std::string> &siblings);
/** Живые файлы папки на любой глубине: заметки и всё остальное (холсты, загруженные файлы). */
FolderContents folderContents(const std::vector<cloud::CloudNode> &nodes, const std::string &folderId);
/** Группы списка заметок: «Без папки», папки по алфавиту (пустые тоже), заметки дня — в конце, свежие сверху.
 *  При поиске остаются только группы с найденным. */
std::vector<NoteGroup> buildNoteGroups(const NoteGroupsInput &input);

} // namespace parvane::sections::notes
