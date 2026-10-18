// Parvane fork (spec 029, фаза 4): справка Parvane — порт web `notes/notesGuide.ts`.
#include "parvane/sections/notes_guide.h"

#include <algorithm>
#include <cstdio>
#include <map>

#include "notes_guide_texts.h"
#include "notes_text.h"
#include "parvane/sections/notes_model.h"

namespace parvane::sections::notes {

namespace {

constexpr size_t kNodeIdBytes = 16;
// Прежняя единственная заметка о разделе: её след значит, что хранилище у аккаунта уже заводили
const std::string kLegacyWelcomeNodeId = "70617276616e652d77656c636f6d652d";
const std::string kNoteExtension = ".md";
const std::vector<GuideLang> kGuideLangs = {"ru", "en"};

const guide::GuideSet &setOf(const GuideLang &lang) { return lang == "ru" ? guide::ruSet() : guide::enSet(); }

// Идентификатор узла из 16 знаков ASCII: читается в дереве и одинаков на всех устройствах
std::string nodeIdOf(const std::string &tag) {
    if (tag.size() != kNodeIdBytes) return {};
    std::string out;
    char buf[4];
    for (const unsigned char c : tag) {
        std::snprintf(buf, sizeof buf, "%02x", c);
        out += buf;
    }
    return out;
}

std::optional<std::string> parentOf(const cloud::CloudNode &node) {
    if (!node.parent || node.parent->empty()) return std::nullopt;
    return node.parent;
}

bool isVaultFolder(const cloud::CloudNode &node, const std::vector<std::string> &vaultNames) {
    return node.isFolder() && !parentOf(node)
        && std::find(vaultNames.begin(), vaultNames.end(), node.name) != vaultNames.end();
}

bool isUnder(const std::map<std::string, const cloud::CloudNode *> &byId, const cloud::CloudNode &node,
             const std::string &ancestorId) {
    auto parent = parentOf(node);
    for (size_t depth = 0; parent && depth <= byId.size(); ++depth) {
        if (*parent == ancestorId) return true;
        const auto it = byId.find(*parent);
        parent = it == byId.end() ? std::nullopt : parentOf(*it->second);
    }
    return false;
}

} // namespace

const std::string &guideFolderNodeId() {
    static const std::string id = nodeIdOf("parvane-guide-fo");
    return id;
}

const std::string &guideMarkerNodeId() {
    static const std::string id = nodeIdOf("parvane-guide-mk");
    return id;
}

GuideLang getGuideLang(const std::optional<std::string> &code) {
    return code && text::startsWith(text::toLower(*code), "ru") ? "ru" : "en";
}

std::string guideNoteNodeId(int slot) {
    char buf[8];
    std::snprintf(buf, sizeof buf, "%02d", slot);
    return nodeIdOf(std::string("parvane-guide-") + buf);
}

Guide buildGuide(const GuideLang &lang) {
    const auto &set = setOf(lang);
    Guide guide;
    guide.lang = lang;
    guide.folderName = set.folderName;
    for (const auto &source : set.notes) {
        guide.notes.push_back({source.key, guideNoteNodeId(source.slot), source.title, source.text});
        if (source.key == "overview") guide.overviewTitle = source.title;
    }
    guide.datedSamples = set.datedSamples;
    for (const auto &sample : set.quickSamples) guide.quickSamples.push_back({sample.text, sample.kind});
    return guide;
}

std::string buildGuideMarker(const GuideLang &lang, int64_t createdAt) {
    return "{\"version\":" + std::to_string(kGuideVersion) + ",\"createdAt\":" + std::to_string(createdAt)
        + ",\"lang\":" + text::jsonQuote(lang) + "}\n";
}

bool hasGuideMarker(const std::vector<cloud::CloudNode> &nodes, const std::vector<std::string> &vaultNames) {
    std::vector<std::string> vaultIds;
    for (const auto &node : nodes) {
        if (isVaultFolder(node, vaultNames)) vaultIds.push_back(node.id);
    }
    return std::any_of(nodes.begin(), nodes.end(), [&](const cloud::CloudNode &node) {
        const auto parent = parentOf(node);
        return node.id == guideMarkerNodeId()
            || (node.kind == "file" && node.name == kGuideMarkerName && parent
                && std::find(vaultIds.begin(), vaultIds.end(), *parent) != vaultIds.end());
    });
}

std::optional<size_t> findGuideOverview(const std::vector<GuideNoteRef> &notes) {
    int slot = 0;
    for (const auto &source : guide::ruSet().notes) {
        if (source.key == "overview") slot = source.slot;
    }
    const auto nodeId = guideNoteNodeId(slot);
    std::vector<std::string> titles;
    for (const auto &lang : kGuideLangs) titles.push_back(normalizeNoteTitle(buildGuide(lang).overviewTitle));
    for (size_t i = 0; i < notes.size(); ++i) {
        if (notes[i].id == nodeId) return i;
    }
    for (size_t i = 0; i < notes.size(); ++i) {
        if (std::find(titles.begin(), titles.end(), normalizeNoteTitle(notes[i].title)) != titles.end()) return i;
    }
    return std::nullopt;
}

GuidePlan planGuide(const GuidePlanInput &input) {
    GuidePlan plan;
    const auto skip = [&](GuideSkipReason reason) {
        GuidePlan result;
        result.reason = reason;
        return result;
    };
    if (input.drive == GuideDrive::Unknown) return skip(GuideSkipReason::DriveUnknown);
    const bool isAuto = input.mode == GuideMode::Auto;
    const bool hasMarker = hasGuideMarker(input.nodes, input.vaultNames);
    if (isAuto && hasMarker) return skip(GuideSkipReason::HasMarker);

    const auto guide = buildGuide(input.lang);
    std::map<std::string, const cloud::CloudNode *> byId;
    for (const auto &node : input.nodes) byId.emplace(node.id, &node);
    const cloud::CloudNode *vault = nullptr;
    for (const auto &node : input.nodes) {
        if (isVaultFolder(node, input.vaultNames) && !node.trashed) {
            vault = &node;
            break;
        }
    }
    // Хранилище в корзине (либо остался след прежней первой заметки): его убрал сам пользователь
    const bool hasVaultTrace = std::any_of(input.nodes.begin(), input.nodes.end(), [&](const cloud::CloudNode &node) {
        return isVaultFolder(node, input.vaultNames) || node.id == kVaultNodeId || node.id == kLegacyWelcomeNodeId
            || node.id == guideFolderNodeId();
    });
    if (isAuto && !vault && hasVaultTrace) return skip(GuideSkipReason::VaultTrashed);

    plan.isWrite = true;
    plan.vaultId = vault ? vault->id : (isAuto ? kVaultNodeId : input.makeId());
    if (!vault) plan.folders.push_back({plan.vaultId, input.vaultName, std::nullopt});
    const auto isInVault = [&](const cloud::CloudNode &node) { return isUnder(byId, node, plan.vaultId); };

    const auto fixed = byId.find(guideFolderNodeId());
    const cloud::CloudNode *fixedFolder = fixed == byId.end() ? nullptr : fixed->second;
    if (isAuto && fixedFolder && fixedFolder->trashed) {
        // Папку справки удалили раньше, чем легла отметка: остаётся только поставить её
        GuidePlan marker;
        marker.isWrite = true;
        marker.vaultId = plan.vaultId;
        marker.folderId = fixedFolder->id;
        marker.hasMarkerWrite = true;
        return marker;
    }
    std::vector<std::string> folderNames;
    for (const auto &lang : kGuideLangs) folderNames.push_back(setOf(lang).folderName);
    const cloud::CloudNode *liveFolder = nullptr;
    if (fixedFolder && !fixedFolder->trashed && (isAuto || isInVault(*fixedFolder))) {
        liveFolder = fixedFolder;
    } else if (!isAuto) {
        for (const auto &node : input.nodes) {
            if (node.isFolder() && !node.trashed && parentOf(node) == std::optional<std::string>(plan.vaultId)
                && std::find(folderNames.begin(), folderNames.end(), node.name) != folderNames.end()) {
                liveFolder = &node;
                break;
            }
        }
    }
    plan.folderId = liveFolder ? liveFolder->id : (isAuto ? guideFolderNodeId() : input.makeId());
    if (!liveFolder) {
        std::vector<std::string> taken;
        for (const auto &node : input.nodes) {
            if (!node.trashed && parentOf(node) == std::optional<std::string>(plan.vaultId)) taken.push_back(node.name);
        }
        plan.folders.push_back({plan.folderId, cloud::freeName(taken, guide.folderName), plan.vaultId});
    }

    // Названия живых заметок хранилища: заметку пользователя с тем же названием справка не трогает
    std::map<std::string, std::string> takenTitles;
    for (const auto &node : input.nodes) {
        if (node.kind != "file" || node.trashed || !text::endsWith(node.name, kNoteExtension) || !isInVault(node)) continue;
        takenTitles[normalizeNoteTitle(node.name.substr(0, node.name.size() - kNoteExtension.size()))] = node.id;
    }
    for (const auto &note : guide.notes) {
        // Узел с постоянным идентификатором уже создавали (он может лежать в корзине) — второй раз не создаётся
        const bool isKnown = isAuto && byId.count(note.nodeId);
        if (isKnown || takenTitles.count(normalizeNoteTitle(note.title))) {
            plan.skipped.push_back(note.key);
            continue;
        }
        plan.notes.push_back({note.key, note.title, note.text, isAuto ? std::optional<std::string>(note.nodeId) : std::nullopt});
    }

    if (!isAuto && plan.notes.empty() && plan.folders.empty() && hasMarker) return skip(GuideSkipReason::Complete);
    plan.isFreshVault = !vault && isAuto;
    plan.hasMarkerWrite = !hasMarker;
    return plan;
}

} // namespace parvane::sections::notes
