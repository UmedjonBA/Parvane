// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesFolders.test.ts`.
#include <algorithm>
#include <tuple>

#include "notes_test_util.h"
#include "parvane/sections/notes_folders.h"

using namespace parvane::sections;
using namespace parvane::sections::notes;

static cloud::CloudNode folder(const std::string &id, const std::string &name,
                               const std::optional<std::string> &parent = std::nullopt, bool trashed = false) {
    return cloudNode(id, name, parent, "folder", trashed);
}
static cloud::CloudNode file(const std::string &id, const std::string &name,
                             const std::optional<std::string> &parent = std::nullopt, bool trashed = false) {
    return cloudNode(id, name, parent, "file", trashed);
}
static GroupedNote note(const std::string &title, const std::string &folderPath = "", bool isDaily = false) {
    return {title, title, folderPath, isDaily};
}

static const std::vector<cloud::CloudNode> TREE = {
    folder("v", "Знания"), folder("work", "Работа", "v"), folder("deep", "Сервер", "work"), folder("empty", "Идеи", "v"),
    folder("gone", "Старое", "v", true), folder("out", "Фото"), file("n1", "План.md", "work"),
    file("n2", "Железо.md", "deep"), file("n3", "Удалено.md", "work", true), file("img", "схема.png", "deep"),
    file("n4", "Свободная.md", "v"),
};

static std::vector<std::string> idsOf(const std::vector<cloud::CloudNode> &nodes) {
    std::vector<std::string> out;
    for (const auto &n : nodes) out.push_back(n.id);
    return out;
}
static std::vector<std::string> keysOf(const std::vector<NoteGroup> &groups) {
    std::vector<std::string> out;
    for (const auto &g : groups) out.push_back(g.key);
    return out;
}

int main() {
    std::printf("папки заметок\n");
    check(listNoteFolders(TREE, "v") == std::vector<NoteFolder>{{"empty", "Идеи", "Идеи"}, {"work", "Работа", "Работа"},
                                                               {"deep", "Работа/Сервер", "Сервер"}},
          "перечень: папки хранилища с путями, вложенные тоже, без корзины и без чужих");
    check(listNoteFolders(TREE, "missing").empty(), "перечень: хранилища нет — папок нет");

    check(folderCaption("Работа/Сервер") == "Работа / Сервер", "подпись вложенной папки");
    check(folderCaption("Идеи") == "Идеи", "подпись папки верхнего уровня");
    check(isInFolder("Работа/Сервер", "Работа"), "заметка вложенной папки лежит в папке");
    check(isInFolder("Работа", "Работа"), "заметка самой папки лежит в папке");
    check(!isInFolder("Работа 2", "Работа"), "папка с тем же началом — другая");

    check(!checkFolderName("Проекты", {"Работа"}), "название папки: годное");
    check(checkFolderName("", {}) == FolderNameError::BadName, "название папки: пустое");
    check(checkFolderName("  ", {}) == FolderNameError::BadName, "название папки: из пробелов");
    check(checkFolderName(" Проекты", {}) == FolderNameError::BadName, "название папки: пробел в начале");
    check(checkFolderName("а/б", {}) == FolderNameError::BadName, "название папки: запрещённый знак");
    check(checkFolderName("..", {}) == FolderNameError::BadName, "название папки: служебное");
    check(checkFolderName("работа", {"Работа"}) == FolderNameError::Taken, "название папки: занято (регистр не важен)");
    check(std::string(folderErrorKey(FolderSubmitError::Failed)) == "KnowledgeFolderFailed", "ключ строки отказа");

    {
        const auto work = folderContents(TREE, "work");
        check(idsOf(work.notes) == std::vector<std::string>{"n1", "n2"}, "содержимое папки: живые заметки на любой глубине");
        check(idsOf(work.others) == std::vector<std::string>{"img"}, "содержимое папки: прочие файлы");
        const auto empty = folderContents(TREE, "empty");
        check(empty.notes.empty() && empty.others.empty(), "содержимое пустой папки");
        auto reversed = TREE;
        std::reverse(reversed.begin(), reversed.end());
        auto ids = idsOf(folderContents(reversed, "work").notes);
        std::sort(ids.begin(), ids.end());
        check(ids == std::vector<std::string>{"n1", "n2"}, "вложенная папка, стоящая в дереве раньше родителя, тоже находится");
    }
    {
        auto folders = listNoteFolders(TREE, "v");
        folders.push_back({"d", "Ежедневные", "Ежедневные"});
        NoteGroupsInput in;
        in.notes = {note("План", "Работа"), note("Железо", "Работа/Сервер"), note("Свободная"),
                    note("2026-10-11", "Ежедневные", true), note("2026-10-12", "Ежедневные", true)};
        in.folders = folders;
        in.dailyFolders = {"Ежедневные", "Daily"};
        in.dailyShown = 1;
        const auto groups = buildNoteGroups(in);
        bool ok = groups.size() == 5;
        const std::vector<std::tuple<std::string, std::optional<std::string>, size_t>> want = {
            {"", std::nullopt, 1}, {"Идеи", std::string("empty"), 0}, {"Работа", std::string("work"), 1},
            {"Работа/Сервер", std::string("deep"), 1}, {kDailyGroupKey, std::string("d"), 1}};
        for (size_t i = 0; ok && i < want.size(); ++i) {
            ok = groups[i].key == std::get<0>(want[i]) && groups[i].folderId == std::get<1>(want[i])
                && groups[i].items.size() == std::get<2>(want[i]);
        }
        check(ok, "группы списка: «Без папки», папки по алфавиту с пустыми, заметки дня в конце");
        const auto &daily = groups.back();
        check(daily.isDaily && daily.folder == "Ежедневные" && daily.hidden == 1, "группа заметок дня: папка и скрытые");
        check(daily.items[0].title == "2026-10-12", "заметки дня — свежие сверху");
    }
    {
        const auto folders = listNoteFolders(TREE, "v");
        check(keysOf(buildNoteGroups({{}, folders, {}, false, std::nullopt}))
                  == std::vector<std::string>{"", "Идеи", "Работа", "Работа/Сервер"},
              "группы списка: «Без папки» видна пустой, пока есть папки");
        check(buildNoteGroups({}).empty(), "без папок и заметок групп нет");
        check(keysOf(buildNoteGroups({{}, {{"d", "Daily", "Daily"}}, {"Daily"}, false, std::nullopt}))
                  == std::vector<std::string>{""},
              "пустая папка заметок дня отдельной строкой не показывается");
    }
    {
        NoteGroupsInput in;
        in.notes = {note("Железо", "Работа/Сервер"), note("2026-10-11", "Daily", true), note("2026-10-12", "Daily", true)};
        in.folders = listNoteFolders(TREE, "v");
        in.dailyFolders = {"Daily"};
        in.isSearch = true;
        in.dailyShown = 1;
        const auto groups = buildNoteGroups(in);
        check(groups.size() == 2 && groups[0].key == "Работа/Сервер" && groups[0].items.size() == 1 && groups[0].hidden == 0
                  && groups[1].key == kDailyGroupKey && groups[1].items.size() == 2 && groups[1].hidden == 0,
              "группы списка при поиске: только найденное, заметки дня все");
    }
    {
        const auto groups = buildNoteGroups({{note("2026-10-12", "Работа")}, {}, {}, false, std::nullopt});
        check(groups.size() == 1 && groups[0].key == "Работа" && !groups[0].isDaily,
              "заметка с названием-датой вне заметок дня остаётся в своей папке");
    }
    return finish();
}
