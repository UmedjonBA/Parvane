// Parvane fork (spec 029, T034): источник «Выгрузки данных» поверх провайдера — порт web `export/exportSource.ts`.
#include "parvane/sections/export_source.h"

#include <map>
#include <memory>

namespace parvane::sections::exportdata {

namespace {

using nlohmann::json;

const std::vector<std::string> kVaultNames = {"Знания", "Knowledge"};

std::string lowerAscii(std::string s) {
    for (auto &c : s) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return s;
}

// /\.(md|canvas)$/i
bool isNoteFile(const std::string &name) {
    const auto lower = lowerAscii(name);
    const auto ends = [&](const std::string &suffix) {
        return lower.size() >= suffix.size() && lower.compare(lower.size() - suffix.size(), suffix.size(), suffix) == 0;
    };
    return ends(".md") || ends(".canvas");
}

// Ждать, пока значение не станет готовым (не дольше kReadyWaitMs); не дождались — последнее прочитанное
std::optional<json> waitFor(ExportHost &host, const std::string &method, const std::function<bool(const json &)> &isReady) {
    const auto deadline = host.nowMs() + kReadyWaitMs;
    std::optional<json> last;
    while (host.nowMs() < deadline) {
        last = host.callParvane(method, json::object());
        if (last && !last->is_null() && isReady(*last)) return last;
        host.sleepMs(kReadyPollMs);
    }
    if (last && last->is_null()) return std::nullopt;
    return last;
}

std::vector<cloud::CloudNode> nodesOf(const json &tree) {
    std::vector<cloud::CloudNode> nodes;
    if (tree.is_object() && tree.contains("nodes") && tree["nodes"].is_array()) {
        for (const auto &n : tree["nodes"]) nodes.push_back(n.get<cloud::CloudNode>());
    }
    return nodes;
}

int64_t asInt(const json &v) {
    if (v.is_number()) return v.get<int64_t>();
    if (v.is_string()) {
        try {
            return std::stoll(v.get<std::string>());
        } catch (...) {
        }
    }
    return 0;
}

} // namespace

ExportSnapshot snapshotFromJson(const json &j) {
    ExportSnapshot s;
    if (!j.is_object()) return s;
    s.self = j.value("self", std::string());
    s.selfName = j.value("selfName", std::string());
    for (const auto &c : j.value("chats", json::array())) {
        if (!c.is_object()) continue;
        ExportSourceChat chat;
        chat.address = c.value("address", std::string());
        chat.kind = c.value("kind", std::string());
        chat.title = c.value("title", std::string());
        for (const auto &m : c.value("messages", json::array())) {
            if (!m.is_object()) continue;
            ExportSourceMessage msg;
            msg.uuid = m.value("uuid", std::string());
            msg.from = m.value("from", std::string());
            msg.fromName = m.value("fromName", std::string());
            msg.isOutgoing = m.value("isOutgoing", false);
            msg.ts = asInt(m.value("ts", json(0)));
            if (m.contains("replyTo") && m["replyTo"].is_string()) msg.replyTo = m["replyTo"].get<std::string>();
            msg.edited = m.value("edited", false);
            if (m.contains("editedAt") && m["editedAt"].is_number()) msg.editedAt = asInt(m["editedAt"]);
            msg.pinned = m.value("pinned", false);
            if (m.contains("content") && m["content"].is_object()) msg.content = m["content"];
            if (m.contains("reactions") && m["reactions"].is_array()) {
                std::vector<ExportReaction> reactions;
                for (const auto &r : m["reactions"]) {
                    if (r.is_object()) reactions.push_back({r.value("emoji", std::string()), asInt(r.value("count", json(0)))});
                }
                msg.reactions = std::move(reactions);
            }
            chat.messages.push_back(std::move(msg));
        }
        s.chats.push_back(std::move(chat));
    }
    for (const auto &c : j.value("contacts", json::array())) {
        if (!c.is_object()) continue;
        s.contacts.push_back({c.value("address", std::string()), c.value("name", std::string()), c.value("isExplicit", false)});
    }
    return s;
}

ExportSource createProviderSource(ExportHost &host, ProviderNames names, std::function<bool()> canceled) {
    // Состояние облака: первый вызов запускает подключение, ждём не `loading` (без ключа/связи — что есть)
    auto cloudCache = std::make_shared<std::optional<std::optional<json>>>();
    auto cloudState = [&host, cloudCache]() -> std::optional<json> {
        if (!*cloudCache) {
            *cloudCache = waitFor(host, "parvaneCloudState",
                                  [](const json &s) { return s.is_object() && s.value("status", std::string()) != "loading"; });
        }
        return **cloudCache;
    };
    auto transferSeq = std::make_shared<int>(0);

    ExportSource source;
    source.snapshot = [&host]() -> std::optional<ExportSnapshot> {
        const auto r = host.callParvane("parvaneExportSnapshot", json::object());
        if (!r || !r->is_object()) return std::nullopt;
        return snapshotFromJson(*r);
    };
    source.media = [&host](const std::string &fileId) {
        return host.blob("parvaneExportMedia", json{{"fileId", fileId}});
    };
    source.planner = [&host]() -> std::optional<std::string> {
        const auto reply = waitFor(host, "parvanePlannerState", [](const json &s) {
            if (!s.is_object() || !s.contains("status") || !s["status"].is_string()) return false;
            const auto status = s["status"].get<std::string>();
            return !status.empty() && status != "loading";
        });
        if (reply && reply->is_object() && reply->value("status", std::string()) == "ready" && reply->contains("raw")
            && (*reply)["raw"].is_string() && !(*reply)["raw"].get<std::string>().empty()) {
            return (*reply)["raw"].get<std::string>();
        }
        // Движок не поднялся — последний сохранённый снимок «Плана» на устройстве
        const auto cached = host.callParvane("parvanePlannerCachedState", json::object());
        if (!cached || cached->is_null() || (cached->is_boolean() && !cached->get<bool>())) return std::nullopt;
        return cached->dump();
    };
    source.notes = [&host, cloudState]() {
        std::vector<ExportNote> out;
        const auto state = cloudState();
        if (!state || !state->is_object()) return out;
        const auto rootId = state->contains("rootId") && (*state)["rootId"].is_string()
            ? (*state)["rootId"].get<std::string>() : std::string();
        const auto trees = state->value("trees", json::object());
        if (rootId.empty() || !trees.is_object() || !trees.contains(rootId)) return out;
        const auto nodes = nodesOf(trees[rootId]);
        const cloud::CloudNode *vault = nullptr;
        for (const auto &n : nodes) {
            if (n.isFolder() && !(n.parent && !n.parent->empty()) && !n.trashed
                && std::find(kVaultNames.begin(), kVaultNames.end(), n.name) != kVaultNames.end()) {
                vault = &n;
                break;
            }
        }
        if (!vault) return out;
        const auto files = treeFilePaths(nodes, "", vault->id, [](const cloud::CloudNode &n) { return isNoteFile(n.name); });
        for (size_t i = 0; i < files.size(); i += kReadTextsBatch) {
            const auto end = std::min(files.size(), i + kReadTextsBatch);
            json list = json::array();
            for (size_t k = i; k < end; ++k) {
                list.push_back(json{{"id", files[k].node.id}, {"blob", files[k].node.blob ? *files[k].node.blob : json()}});
            }
            // В web исключение вызова прерывает выгрузку — здесь так же
            const auto replies = host.callParvane("parvaneCloudReadTexts", json{{"container", rootId}, {"nodes", list}});
            if (!replies) throw ExportError(ExportErrorCode::Failed, "parvaneCloudReadTexts");
            std::map<std::string, std::string> textById;
            if (replies->is_array()) {
                for (const auto &r : *replies) {
                    if (r.is_object() && r.contains("text") && r["text"].is_string()) {
                        textById[r.value("id", std::string())] = r["text"].get<std::string>();
                    }
                }
            }
            for (size_t k = i; k < end; ++k) {
                const auto it = textById.find(files[k].node.id);
                if (it == textById.end()) continue;
                ExportNote note{files[k].path, it->second, std::nullopt};
                if (files[k].node.mtime) note.mtime = files[k].node.mtime;
                out.push_back(std::move(note));
            }
        }
        return out;
    };
    source.cloudFiles = [cloudState, names]() {
        std::vector<ExportCloudTree> trees;
        const auto state = cloudState();
        if (!state || !state->is_object()) return std::vector<ExportCloudFile>();
        const auto allTrees = state->value("trees", json::object());
        for (const auto &c : state->value("containers", json::array())) {
            if (!c.is_object()) continue;
            const auto id = c.value("id", std::string());
            if (c.value("kind", std::string()) == "invite" || !c.value("hasKey", false) || !allTrees.is_object()
                || !allTrees.contains(id)) {
                continue;
            }
            const auto &tree = allTrees[id];
            std::string name = c.value("kind", std::string()) == "root" ? names.drive : c.value("name", std::string());
            if (name.empty()) name = tree.value("name", std::string());
            trees.push_back({id, name, nodesOf(tree)});
        }
        return cloudExportFiles(trees, names.drive);
    };
    source.cloudBlob = [&host, transferSeq, canceled](const ExportCloudFile &file) -> std::optional<ZipWriter::ChunkSource> {
        const auto transferId = "export-" + std::to_string(host.nowMs()) + "-" + std::to_string(++*transferSeq);
        try {
            return host.blob("parvaneCloudExportBlob",
                             json{{"container", file.container}, {"node", file.node}, {"transferId", transferId}});
        } catch (...) {
            if (canceled && canceled()) {
                host.callParvane("parvaneCloudCancelDownload", json{{"transferId", transferId}});
                throw ExportError(ExportErrorCode::Canceled);
            }
            throw;
        }
    };
    return source;
}

} // namespace parvane::sections::exportdata
