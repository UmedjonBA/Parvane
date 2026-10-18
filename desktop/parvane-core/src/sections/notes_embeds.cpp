// Parvane fork (spec 029, фаза 4): встроенные файлы заметки — порт web `notes/notesEmbeds.ts`.
#include "parvane/sections/notes_embeds.h"

#include <algorithm>

#include "notes_text.h"
#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_canvas_files.h"

namespace parvane::sections::notes {

namespace {

std::optional<std::string> parentOf(const cloud::CloudNode &node) {
    if (!node.parent || node.parent->empty()) return std::nullopt;
    return node.parent;
}

} // namespace

const cloud::CloudNode *resolveEmbed(const std::vector<cloud::CloudNode> &nodes, const std::string &name,
                                     const std::optional<std::string> &noteId) {
    std::string target = text::trim(name);
    target.erase(0, target.find_first_not_of('/') == std::string::npos ? target.size() : target.find_first_not_of('/'));
    if (target.empty()) return nullptr;
    std::vector<const cloud::CloudNode *> files;
    for (const auto &node : nodes) {
        if (node.kind == "file" && !node.trashed) files.push_back(&node);
    }
    std::optional<std::string> parent;
    if (noteId && !noteId->empty()) {
        for (const auto &node : nodes) {
            if (node.id == *noteId) {
                parent = parentOf(node);
                break;
            }
        }
    }
    struct Match {
        const cloud::CloudNode *node;
        std::size_t rank;
    };
    std::vector<Match> matches;
    if (target.find('/') != std::string::npos) {
        for (const auto *node : files) {
            const auto path = drivePathOf(nodes, node->id);
            if (path == target || text::endsWith(path, "/" + target)) {
                matches.push_back({node, canvasjs::utf16Length(path)});
            }
        }
    } else {
        std::vector<const cloud::CloudNode *> named;
        for (const auto *node : files) {
            if (node->name == target) named.push_back(node);
        }
        if (named.empty()) return nullptr;
        for (const auto *node : named) {
            if (parentOf(*node) == parent) return node;
        }
        for (const auto *node : named) {
            matches.push_back({node, text::split(drivePathOf(nodes, node->id), '/').size()});
        }
    }
    if (matches.empty()) return nullptr;
    std::stable_sort(matches.begin(), matches.end(), [](const Match &a, const Match &b) { return a.rank < b.rank; });
    return matches[0].node;
}

} // namespace parvane::sections::notes
