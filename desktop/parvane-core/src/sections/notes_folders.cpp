// Parvane fork (spec 029, фаза 4): папки заметок «Знаний» — порт web `notes/notesFolders.ts`.
#include "parvane/sections/notes_folders.h"

#include <algorithm>
#include <map>
#include <set>

#include "notes_text.h"
#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

namespace {

const std::string kNoteExtension = ".md";

std::optional<std::string> parentOf(const cloud::CloudNode &node) {
    if (!node.parent || node.parent->empty()) return std::nullopt;
    return node.parent;
}

bool isDayKey(const std::string &title) {
    if (title.size() != 10) return false;
    for (size_t i = 0; i < 10; ++i) {
        const char c = title[i];
        if (i == 4 || i == 7) {
            if (c != '-') return false;
        } else if (c < '0' || c > '9') {
            return false;
        }
    }
    return true;
}

bool pathLess(const std::string &a, const std::string &b) { return canvasjs::utf16Less(a, b); }

} // namespace

const char *folderErrorKey(FolderSubmitError error) {
    switch (error) {
    case FolderSubmitError::BadName: return "KnowledgeFolderBadName";
    case FolderSubmitError::Taken: return "KnowledgeFolderTaken";
    case FolderSubmitError::Failed: return "KnowledgeFolderFailed";
    }
    return "KnowledgeFolderFailed";
}

std::vector<NoteFolder> listNoteFolders(const std::vector<cloud::CloudNode> &nodes, const std::string &vaultId) {
    std::map<std::string, const cloud::CloudNode *> byId;
    for (const auto &node : nodes) byId.emplace(node.id, &node);
    auto find = [&](const std::optional<std::string> &id) -> const cloud::CloudNode * {
        if (!id) return nullptr;
        const auto it = byId.find(*id);
        return it == byId.end() ? nullptr : it->second;
    };
    std::vector<NoteFolder> result;
    for (const auto &node : nodes) {
        if (!node.isFolder() || node.trashed || node.id == vaultId) continue;
        std::vector<std::string> names{node.name};
        const cloud::CloudNode *parent = find(parentOf(node));
        for (size_t depth = 0; parent && parent->id != vaultId && depth <= nodes.size(); ++depth) {
            names.insert(names.begin(), parent->name);
            parent = find(parentOf(*parent));
        }
        // Папка вне хранилища к заметкам не относится
        if (parent) result.push_back({node.id, text::join(names, "/"), node.name});
    }
    std::stable_sort(result.begin(), result.end(),
                     [](const NoteFolder &a, const NoteFolder &b) { return pathLess(a.path, b.path); });
    return result;
}

std::string folderCaption(const std::string &path) { return text::join(text::split(path, '/'), " / "); }

bool isInFolder(const std::string &noteFolder, const std::string &path) {
    return noteFolder == path || text::startsWith(noteFolder, path + "/");
}

std::optional<FolderNameError> checkFolderName(const std::string &name, const std::vector<std::string> &siblings) {
    if (name != text::trim(name) || cloud::validateName(name)) return FolderNameError::BadName;
    const auto key = text::toLower(name);
    for (const auto &sibling : siblings) {
        if (text::toLower(sibling) == key) return FolderNameError::Taken;
    }
    return std::nullopt;
}

FolderContents folderContents(const std::vector<cloud::CloudNode> &nodes, const std::string &folderId) {
    std::set<std::string> inside{folderId};
    // Дерево не упорядочено: проходы повторяются, пока находятся новые вложенные папки
    for (bool hasMore = true; hasMore;) {
        hasMore = false;
        for (const auto &node : nodes) {
            if (!node.isFolder() || node.trashed || inside.count(node.id)) continue;
            const auto parent = parentOf(node);
            if (!parent || !inside.count(*parent)) continue;
            inside.insert(node.id);
            hasMore = true;
        }
    }
    FolderContents result;
    for (const auto &node : nodes) {
        const auto parent = parentOf(node);
        if (node.kind != "file" || node.trashed || !parent || !inside.count(*parent)) continue;
        (text::endsWith(node.name, kNoteExtension) ? result.notes : result.others).push_back(node);
    }
    return result;
}

std::vector<NoteGroup> buildNoteGroups(const NoteGroupsInput &input) {
    // Порядок вставки не важен: группы сортируются по ключу
    std::map<std::string, std::vector<GroupedNote>> byFolder;
    std::vector<GroupedNote> daily;
    for (const auto &note : input.notes) {
        if (note.isDaily && isDayKey(note.title)) daily.push_back(note);
        else byFolder[note.folder].push_back(note);
    }
    if (!input.isSearch) {
        for (const auto &folder : input.folders) {
            const bool isDailyFolder = std::find(input.dailyFolders.begin(), input.dailyFolders.end(), folder.path)
                != input.dailyFolders.end();
            if (!byFolder.count(folder.path) && !isDailyFolder) byFolder[folder.path];
        }
        // «Без папки» видна, пока есть папки: в неё переносят заметки и в ней создают новые
        if (!input.folders.empty() && !byFolder.count(kRootFolder)) byFolder[kRootFolder];
    }
    auto idOf = [&](const std::string &path) -> std::optional<std::string> {
        for (const auto &folder : input.folders) {
            if (folder.path == path) return folder.id;
        }
        return std::nullopt;
    };
    std::vector<std::pair<std::string, std::vector<GroupedNote>>> entries(byFolder.begin(), byFolder.end());
    std::stable_sort(entries.begin(), entries.end(),
                     [](const auto &a, const auto &b) { return pathLess(a.first, b.first); });
    std::vector<NoteGroup> result;
    for (auto &[folder, items] : entries) {
        result.push_back({folder, folder, idOf(folder), false, std::move(items), 0});
    }
    if (!daily.empty()) {
        std::stable_sort(daily.begin(), daily.end(),
                         [](const GroupedNote &a, const GroupedNote &b) { return pathLess(b.title, a.title); });
        const size_t total = daily.size();
        const auto folder = daily[0].folder;
        if (!input.isSearch && input.dailyShown) {
            daily.resize(std::min(total, static_cast<size_t>(std::max(0, *input.dailyShown))));
        }
        NoteGroup group{kDailyGroupKey, folder, idOf(folder), true, std::move(daily), 0};
        group.hidden = static_cast<int>(total - group.items.size());
        result.push_back(std::move(group));
    }
    return result;
}

} // namespace parvane::sections::notes
