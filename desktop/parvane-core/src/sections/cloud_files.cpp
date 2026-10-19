// Parvane fork (spec 029, T064): реализация cloud_files.h — порт web `cloudDrive.ts` (runUpload, parvaneCloudDownload,
// parvaneCloudThumb, moveNodes, shareFolder/unshareFolder, ссылки) и `cloudLinks.ts`.
#include "parvane/sections/cloud_files.h"

#include <algorithm>
#include <cctype>
#include <set>

namespace parvane::sections::cloud {
namespace d = parvane::sections::domain;

namespace {

constexpr const char *kDriveBucket = "BLOB_BUCKET_DRIVE";
constexpr std::size_t kCapabilityBytes = 32;
constexpr std::size_t kNonceBytes = 12;
constexpr std::size_t kMoveChunkFiles = 20;
constexpr std::int64_t kMoveChunkBytes = 64LL * 1024 * 1024;
constexpr int kLinkAddRounds = 6;
constexpr int kManifestVersion = 1;
constexpr const char *kManifestNonceLabel = "parvane-link-manifest";
constexpr const char *kOwnerNonceLabel = "parvane-link-owner";
constexpr const char *kServicePrefix = ".parvane-";

// Отмена пользователем (web CloudAbortError)
struct Aborted : std::runtime_error {
    Aborted() : std::runtime_error("cloud: canceled") {}
};

std::string str(const json &obj, const char *a, const char *b = nullptr) {
    for (const char *k : {a, b}) {
        if (!k || !obj.is_object() || !obj.contains(k)) continue;
        const auto &v = obj[k];
        if (v.is_string()) return v.get<std::string>();
    }
    return {};
}

std::int64_t num(const json &obj, const char *a, const char *b = nullptr) {
    for (const char *k : {a, b}) {
        if (!k || !obj.is_object() || !obj.contains(k)) continue;
        const auto &v = obj[k];
        if (v.is_number()) return v.get<std::int64_t>();
        if (v.is_string() && !v.get<std::string>().empty()) {
            try {
                return std::stoll(v.get<std::string>());
            } catch (const std::exception &) {
                return 0;
            }
        }
    }
    return 0;
}

std::optional<std::string> parentOf(const json &node) {
    if (!node.contains("parent") || !node["parent"].is_string()) return std::nullopt;
    const auto p = node["parent"].get<std::string>();
    if (p.empty()) return std::nullopt;
    return p;
}

bool flag(const json &node, const char *key) {
    return node.contains(key) && node[key].is_boolean() && node[key].get<bool>();
}

std::string u32be(std::uint32_t v) {
    std::string out(4, '\0');
    out[0] = char((v >> 24) & 0xFF);
    out[1] = char((v >> 16) & 0xFF);
    out[2] = char((v >> 8) & 0xFF);
    out[3] = char(v & 0xFF);
    return out;
}

std::uint32_t readU32be(const std::string &s) {
    return (std::uint32_t(std::uint8_t(s[0])) << 24) | (std::uint32_t(std::uint8_t(s[1])) << 16)
        | (std::uint32_t(std::uint8_t(s[2])) << 8) | std::uint32_t(std::uint8_t(s[3]));
}

void check(const CloudFiles::Cancelled &cancelled) {
    if (cancelled && cancelled()) throw Aborted();
}

std::string linkState(const json &reply) {
    if (!reply.contains("state")) return "preparing";
    const auto &v = reply["state"];
    const auto s = v.is_string() ? v.get<std::string>() : (v.is_number() ? std::to_string(v.get<int>()) : std::string());
    if (s == "LINK_STATE_ACTIVE" || s == "2") return "active";
    if (s == "LINK_STATE_EXPIRED" || s == "3") return "expired";
    return "preparing";
}

} // namespace

// ── размеры ─────────────────────────────────────────────────────────────────────

std::int64_t cloudCipherSize(std::int64_t size) {
    const auto total = size == 0 ? 1 : (size + kBlobChunkBytes - 1) / kBlobChunkBytes;
    return kBlobHeaderBytes + size + total * kBlobTagBytes;
}

std::int64_t cloudPlainSize(std::int64_t cipherSize) {
    const auto body = std::max<std::int64_t>(0, cipherSize - kBlobHeaderBytes);
    const auto step = kBlobChunkBytes + kBlobTagBytes;
    const auto total = std::max<std::int64_t>(1, (body + step - 1) / step);
    return std::max<std::int64_t>(0, body - total * kBlobTagBytes);
}

// ── ссылки: чистая часть ─────────────────────────────────────────────────────────

LinkPlan buildLinkPlan(const json &nodes, const std::optional<std::string> &nodeId, const std::string &rootName) {
    LinkPlan plan;
    json top;
    if (nodeId) {
        for (const auto &n : nodes) {
            if (str(n, "id") == *nodeId) {
                top = n;
                break;
            }
        }
    } else {
        top = json{{"id", ""}, {"kind", "folder"}, {"name", rootName}, {"size", 0}, {"mime", ""}, {"trashed", false}};
    }
    if (!top.is_object() || flag(top, "trashed") || str(top, "name").empty()) {
        plan.error = "not-found";
        return plan;
    }
    plan.name = str(top, "name");
    if (str(top, "kind") == "file") {
        if (!top.contains("blob") || !top["blob"].is_object()) {
            plan = LinkPlan();
            plan.error = "not-found";
            return plan;
        }
        plan.kind = "file";
        plan.files.push_back({plan.name, top});
        plan.bytes = num(top["blob"], "size");
        return plan;
    }
    plan.kind = "folder";
    // Верхний уровень контейнера лежит под ключом "" — это и есть «узел» всей папки
    std::map<std::string, std::vector<json>> children;
    for (const auto &n : nodes) {
        if (flag(n, "trashed")) continue;
        children[parentOf(n).value_or("")].push_back(n);
    }
    struct Step {
        std::string id;
        std::string prefix;
    };
    std::vector<Step> queue{{str(top, "id"), ""}};
    std::set<std::string> seen{str(top, "id")};
    for (std::size_t i = 0; i < queue.size(); ++i) {
        const auto step = queue[i];
        auto list = children[step.id];
        // Как web `a.name.localeCompare(b.name)` — без числового режима (T037: «отчёт 10» раньше «отчёт 2»)
        std::stable_sort(list.begin(), list.end(), [](const json &a, const json &b) {
            return compareNames(str(a, "name"), str(b, "name"), false) < 0;
        });
        for (const auto &child : list) {
            const auto id = str(child, "id");
            if (seen.count(id)) continue;
            seen.insert(id);
            const auto path = step.prefix + str(child, "name");
            if (str(child, "kind") == "folder") {
                plan.dirs.push_back(path);
                queue.push_back({id, path + "/"});
            } else if (child.contains("blob") && child["blob"].is_object()
                       && str(child, "name").rfind(kServicePrefix, 0) != 0) {
                plan.files.push_back({path, child});
                if (int(plan.files.size()) > kLinkMaxFiles) {
                    plan = LinkPlan();
                    plan.error = "too-many";
                    return plan;
                }
            }
        }
    }
    for (const auto &f : plan.files) plan.bytes += num(f.node["blob"], "size");
    return plan;
}

json buildManifest(const LinkPlan &plan, const std::map<std::string, LinkCopy> &copies, std::int64_t createdSec) {
    json items = json::array();
    for (const auto &path : plan.dirs) items.push_back(json{{"path", path}, {"dir", true}});
    for (const auto &f : plan.files) {
        const auto it = copies.find(str(f.node, "id"));
        if (it == copies.end() || !f.node.contains("blob")) throw std::runtime_error("cloud link: file without a copy");
        const auto &blob = f.node["blob"];
        auto mime = str(f.node, "mime");
        if (mime.empty()) mime = str(blob, "mime");
        if (mime.empty()) mime = "application/octet-stream";
        json item{{"path", f.path}, {"size", num(blob, "size")}, {"mime", mime}, {"fileId", it->second.fileId},
                  {"key", str(blob, "key")}, {"nonce", str(blob, "nonce")}, {"chunks", it->second.chunks},
                  {"blobSize", it->second.blobSize}};
        if (it->second.thumb) item["thumb"] = *it->second.thumb;
        items.push_back(item);
    }
    return json{{"v", kManifestVersion}, {"name", plan.name}, {"kind", plan.kind}, {"created", createdSec},
                {"items", items}};
}

std::string toBase64Url(const std::string &bytes) {
    auto s = d::toBase64(bytes);
    for (auto &c : s) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    while (!s.empty() && s.back() == '=') s.pop_back();
    return s;
}

std::optional<std::string> fromBase64Url(const std::string &text) {
    auto s = text;
    for (auto &c : s) {
        if (c == '-') c = '+';
        else if (c == '_') c = '/';
        else if (!std::isalnum(static_cast<unsigned char>(c)) && c != '+' && c != '/' && c != '=') return std::nullopt;
    }
    while (s.size() % 4) s.push_back('=');
    try {
        return d::fromBase64(s);
    } catch (const std::exception &) {
        return std::nullopt;
    }
}

std::string buildLinkUrl(const std::string &origin, const std::string &linkId, const std::string &keyB64Url) {
    auto base = origin;
    while (!base.empty() && base.back() == '/') base.pop_back();
    return base + "/s/" + linkId + "#k=" + keyB64Url;
}

std::string originOfGateway(const std::string &gatewayUrl) {
    auto rest = gatewayUrl;
    std::string scheme = "https";
    if (rest.rfind("wss://", 0) == 0) {
        rest = rest.substr(6);
    } else if (rest.rfind("ws://", 0) == 0) {
        rest = rest.substr(5);
        scheme = "http";
    } else if (rest.rfind("https://", 0) == 0) {
        rest = rest.substr(8);
    } else if (rest.rfind("http://", 0) == 0) {
        rest = rest.substr(7);
        scheme = "http";
    }
    const auto slash = rest.find('/');
    if (slash != std::string::npos) rest = rest.substr(0, slash);
    return rest.empty() ? std::string() : scheme + "://" + rest;
}

json ownerRecordJson(const std::string &name, const std::string &kind, const std::string &keyB64Url, std::int64_t epoch,
                     const std::optional<std::pair<std::string, std::string>> &source) {
    json out{{"v", kManifestVersion}, {"name", name}, {"kind", kind}, {"key", keyB64Url}, {"epoch", epoch}};
    if (source) out["source"] = json{{"container", source->first}, {"node", source->second}};
    return out;
}

std::optional<json> parseOwnerRecord(const std::string &plain) {
    json raw;
    try {
        raw = json::parse(plain);
    } catch (const std::exception &) {
        return std::nullopt;
    }
    if (!raw.is_object() || !raw.contains("v") || raw["v"] != kManifestVersion) return std::nullopt;
    if (!raw.contains("name") || !raw["name"].is_string() || !raw.contains("key") || !raw["key"].is_string()) {
        return std::nullopt;
    }
    const auto kind = str(raw, "kind");
    if (kind != "file" && kind != "folder") return std::nullopt;
    const auto key = fromBase64Url(raw["key"].get<std::string>());
    if (!key || key->size() != kLinkKeyBytes) return std::nullopt;
    json out{{"name", raw["name"]}, {"kind", kind}, {"key", raw["key"]}};
    if (raw.contains("source") && raw["source"].is_object() && raw["source"].contains("container")
        && raw["source"]["container"].is_string() && raw["source"].contains("node") && raw["source"]["node"].is_string()) {
        out["source"] = json{{"container", raw["source"]["container"]}, {"node", raw["source"]["node"]}};
    }
    return out;
}

std::optional<json> linkOfSource(const json &links, const std::string &container, const std::string &node) {
    if (!links.is_array()) return std::nullopt;
    for (const auto &l : links) {
        if (str(l, "state") == "preparing" || !l.contains("source") || !l["source"].is_object()) continue;
        if (str(l["source"], "container") == container && str(l["source"], "node") == node) return l;
    }
    return std::nullopt;
}

// ── операции ────────────────────────────────────────────────────────────────────

CloudFiles::CloudFiles(CloudDrive &drive, std::function<std::string()> newNodeId)
: drive_(drive), newNodeId_(newNodeId ? std::move(newNodeId) : newCloudNodeId) {}

json CloudFiles::call(const std::string &method, const json &body) {
    auto &t = drive_.transport();
    return t.decodeMethod(method, t.request(false, method, t.encodeMethod(method, body), {}));
}

json CloudFiles::nodesOf(const std::string &container) {
    const auto tree = drive_.readTree(container);
    if (!tree || !tree->contains("nodes") || !(*tree)["nodes"].is_array()) return json::array();
    return (*tree)["nodes"];
}

std::optional<json> CloudFiles::findNode(const std::string &container, const std::string &node) {
    for (const auto &n : nodesOf(container)) {
        if (str(n, "id") == node) return n;
    }
    return std::nullopt;
}

json CloudFiles::withDomain(json blob) {
    // Файл загрузившего с другого сервера качается с его сервера (spec 028, web noteBlobServer)
    const auto uploader = str(blob, "uploader");
    const auto at = uploader.rfind('@');
    if (at != std::string::npos && at > 0 && !blob.contains("domain")) {
        const auto domain = uploader.substr(at + 1);
        if (domain != drive_.transport().serverDomain()) blob["domain"] = domain;
    }
    return blob;
}

json CloudFiles::upload(const UploadRequest &request) {
    auto &t = drive_.transport();
    auto &blobs = drive_.blobs();
    try {
        const auto total = cloudCipherSize(std::int64_t(request.bytes.size()));
        // Отказ до начала: предел файла и свободное место (FR-022)
        if (const auto limits = drive_.usage(true)) {
            const auto maxFile = num(*limits, "maxFile");
            const auto quota = num(*limits, "quota");
            if (maxFile && total > maxFile) return json{{"ok", false}, {"error", "too-large"}};
            if (quota && num(*limits, "used") + total > quota) return json{{"ok", false}, {"error", "no-space"}};
        }
        const auto mime = request.mime.empty() ? std::string("application/octet-stream") : request.mime;
        const auto uploaded = blobs.upload(request.bytes, mime);
        std::optional<json> thumb;
        if (request.thumb && !request.thumb->jpeg.empty()) {
            try {
                const auto nonce = blobs.randomBytes(kNonceBytes);
                const auto cipher = blobs.sealWithKey(request.thumb->jpeg, d::fromBase64(str(uploaded, "key")), nonce);
                const auto capability = blobs.randomBytes(kCapabilityBytes);
                const auto fileId = blobs.uploadCipher(cipher, capability);
                thumb = json{{"fileId", fileId}, {"nonce", d::toBase64(nonce)}, {"capability", d::toBase64(capability)},
                             {"width", request.thumb->width}, {"height", request.thumb->height}};
            } catch (const std::exception &e) {
                t.log(std::string("облако: миниатюра не загружена: ") + e.what());
            }
        }
        const auto node = newNodeId_();
        json create{{"op", "create"}, {"id", node}, {"kind", "file"}, {"name", request.name},
                    {"mtime", request.mtime ? request.mtime : t.nowMs()},
                    {"blob", {{"fileId", str(uploaded, "fileId")}, {"key", str(uploaded, "key")},
                              {"nonce", str(uploaded, "nonce")}, {"capability", str(uploaded, "capability")},
                              {"size", num(uploaded, "size")}, {"chunks", std::max<std::int64_t>(1, num(uploaded, "chunks"))},
                              {"mime", mime}, {"uploader", t.self()}}}};
        if (request.parent) create["parent"] = *request.parent;
        if (thumb) create["thumb"] = *thumb;
        const auto container = drive_.sync().apply(request.container, json::array({create}));
        drive_.forgetUsage();
        return json{{"ok", true}, {"container", container}, {"node", node}};
    } catch (const std::exception &e) {
        t.log(std::string("облако: загрузка не удалась: ") + e.what());
        const auto code = d::errorCode(e);
        return json{{"ok", false}, {"error", code && *code == "TOO_LARGE" ? std::string("too-large") : errorOf(e)}};
    }
}

DownloadResult CloudFiles::download(const std::string &container, const std::string &node) {
    DownloadResult result;
    const auto found = findNode(container, node);
    if (!found || !found->contains("blob") || !(*found)["blob"].is_object()) {
        result.error = "not-found";
        return result;
    }
    result.name = str(*found, "name");
    try {
        const auto bytes = drive_.blobs().download(withDomain((*found)["blob"]));
        if (!bytes) {
            result.error = "not-found";
            return result;
        }
        result.ok = true;
        result.bytes = *bytes;
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: файл не скачан: ") + e.what());
        result.error = errorOf(e);
    }
    return result;
}

std::optional<std::string> CloudFiles::open(const json &node) {
    if (!node.contains("blob") || !node["blob"].is_object()) return std::nullopt;
    try {
        return drive_.blobs().download(withDomain(node["blob"]));
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: файл для просмотра не скачан: ") + e.what());
        return std::nullopt;
    }
}

std::optional<std::string> CloudFiles::thumb(const json &node) {
    if (!node.contains("blob") || !node["blob"].is_object() || !node.contains("thumb") || !node["thumb"].is_object()) {
        return std::nullopt;
    }
    const auto &blob = node["blob"];
    const auto &th = node["thumb"];
    // Миниатюра зашифрована ключом файла со своим nonce
    json ref{{"fileId", str(th, "fileId")}, {"capability", str(th, "capability")}, {"key", str(blob, "key")},
             {"nonce", str(th, "nonce")}, {"uploader", str(blob, "uploader")}};
    try {
        return drive_.blobs().download(withDomain(ref));
    } catch (const std::exception &) {
        return std::nullopt;
    }
}

// ── перенос между контейнерами ──────────────────────────────────────────────────

std::pair<std::string, std::string> CloudFiles::copyDriveBlob(const std::string &fileId, const std::string &capability) {
    auto &blobs = drive_.blobs();
    const auto fresh = blobs.randomBytes(kCapabilityBytes);
    const auto copy = call("cloud.blob.copy", json{{"file_id", fileId}, {"capability", capability},
                                                   {"bucket", kDriveBucket},
                                                   {"capability_hash", d::toBase64(blobs.sha256(fresh))}});
    const auto copyId = str(copy, "fileId", "file_id");
    if (copyId.empty()) throw d::BusError("ERROR_CODE_INVALID");
    return {copyId, d::toBase64(fresh)};
}

void CloudFiles::dropBlobs(const std::vector<std::string> &ids) {
    for (const auto &id : ids) {
        try {
            call("cloud.blob.delete", json{{"file_id", id}});
        } catch (const std::exception &) {
        }
    }
}

std::int64_t CloudFiles::moveNodes(const std::string &from, const std::vector<MoveItem> &items, const std::string &to,
                                   const std::optional<std::string> &parent, const std::optional<std::string> &wrapper,
                                   const Progress &progress, const Cancelled &cancelled) {
    auto &cloud = drive_.sync();
    auto &t = drive_.transport();
    const auto source = nodesOf(from);
    std::map<std::string, json> byId;
    for (const auto &n : source) byId[str(n, "id")] = n;
    const auto childrenOf = [&](const std::string &id) {
        std::vector<json> out;
        for (const auto &n : source) {
            if (parentOf(n) == id) out.push_back(n);
        }
        return out;
    };
    std::map<std::string, std::string> newIds;
    std::map<std::string, std::string> names;
    for (const auto &i : items) names[i.id] = i.name;
    std::vector<json> folders, files, rescued;
    // Лежащее в корзине остаётся в источнике: поднимается в корень, чтобы не стереться с папкой
    if (wrapper) {
        for (const auto &n : childrenOf(*wrapper)) {
            if (flag(n, "trashTop")) rescued.push_back(n);
        }
    }
    std::vector<json> queue;
    std::set<std::string> tops;
    for (const auto &i : items) {
        const auto it = byId.find(i.id);
        if (it == byId.end() || flag(it->second, "trashed")) continue;
        queue.push_back(it->second);
        tops.insert(i.id);
    }
    for (std::size_t i = 0; i < queue.size(); ++i) {
        const auto node = queue[i];
        const auto id = str(node, "id");
        newIds[id] = newNodeId_();
        if (str(node, "kind") == "file") {
            if (node.contains("blob") && node["blob"].is_object()) files.push_back(node);
            continue;
        }
        folders.push_back(node);
        for (const auto &child : childrenOf(id)) {
            if (!flag(child, "trashed")) queue.push_back(child);
            else if (flag(child, "trashTop")) rescued.push_back(child);
        }
    }
    if (int(nodesOf(to).size() + folders.size() + files.size()) > kMaxNodes) throw d::BusError("FieldLimit");
    const auto place = [&](json op, const json &node) {
        const auto id = str(node, "id");
        op["id"] = newIds[id];
        if (tops.count(id)) {
            if (parent) op["parent"] = *parent;
        } else if (const auto p = parentOf(node)) {
            op["parent"] = newIds[*p];
        }
        const auto named = names.find(id);
        op["name"] = named != names.end() ? named->second : str(node, "name");
        return op;
    };
    if (!folders.empty()) {
        json ops = json::array();
        for (const auto &n : folders) {
            json op{{"op", "create"}, {"kind", "folder"}};
            if (num(n, "mtime")) op["mtime"] = num(n, "mtime");
            ops.push_back(place(op, n));
        }
        cloud.apply(to, ops);
    }
    std::int64_t total = 0;
    for (const auto &n : files) total += num(n, "size");
    std::int64_t done = 0;
    if (progress) progress(0, total);
    const auto self = t.self();
    for (std::size_t start = 0; start < files.size();) {
        json creates = json::array();
        json purges = json::array();
        std::vector<std::string> copied;
        std::int64_t bytes = 0;
        try {
            while (start < files.size() && creates.size() < kMoveChunkFiles && bytes < kMoveChunkBytes) {
                check(cancelled);
                const auto &node = files[start];
                auto blob = node["blob"];
                const auto copy = copyDriveBlob(str(blob, "fileId"), str(blob, "capability"));
                copied.push_back(copy.first);
                std::optional<json> thumb;
                if (node.contains("thumb") && node["thumb"].is_object()) {
                    try {
                        const auto thumbCopy = copyDriveBlob(str(node["thumb"], "fileId"), str(node["thumb"], "capability"));
                        copied.push_back(thumbCopy.first);
                        thumb = node["thumb"];
                        (*thumb)["fileId"] = thumbCopy.first;
                        (*thumb)["capability"] = thumbCopy.second;
                    } catch (const Aborted &) {
                        throw;
                    } catch (const std::exception &e) {
                        t.log(std::string("облако: миниатюра не перенесена: ") + e.what());
                    }
                }
                blob["fileId"] = copy.first;
                blob["capability"] = copy.second;
                blob["uploader"] = self;
                json op{{"op", "create"}, {"kind", "file"}, {"mtime", num(node, "mtime")}, {"blob", blob}};
                if (thumb) op["thumb"] = *thumb;
                creates.push_back(place(op, node));
                purges.push_back(json{{"op", "purge"}, {"id", str(node, "id")}, {"at", t.nowMs()}});
                bytes += num(node, "size");
                start += 1;
            }
            cloud.apply(to, creates);
        } catch (...) {
            // Скопированное, но не попавшее в дерево, место занимать не должно
            dropBlobs(copied);
            throw;
        }
        // Источник стирается только после того, как сервер принял узлы назначения
        if (!cloud.flush(to)) throw d::BusError("ERROR_CODE_FORBIDDEN");
        cloud.apply(from, purges);
        cloud.flush(from);
        drive_.forgetUsage();
        done += bytes;
        if (progress) progress(done, total);
    }
    const auto at = t.nowMs();
    json tail = json::array();
    for (const auto &n : rescued) tail.push_back(json{{"op", "move"}, {"id", str(n, "id")}, {"name", str(n, "name")}});
    for (const auto &n : folders) {
        if (tops.count(str(n, "id"))) tail.push_back(json{{"op", "purge"}, {"id", str(n, "id")}, {"at", at}});
    }
    if (wrapper) tail.push_back(json{{"op", "purge"}, {"id", *wrapper}, {"at", at}});
    if (!tail.empty()) {
        cloud.apply(from, tail);
        cloud.flush(from);
    }
    return total;
}

json CloudFiles::move(const std::string &from, const std::vector<MoveItem> &items, const std::string &to,
                      const std::optional<std::string> &parent, Progress progress, Cancelled cancelled) {
    try {
        moveNodes(from, items, to, parent, std::nullopt, progress, cancelled);
        drive_.forgetUsage();
        return json{{"ok", true}};
    } catch (const Aborted &) {
        return json{{"ok", false}, {"error", "rejected"}, {"canceled", true}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: перенос не удался: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

json CloudFiles::shareFolder(const std::string &container, const std::string &node, Progress progress,
                             Cancelled cancelled) {
    const auto folder = findNode(container, node);
    if (!folder || str(*folder, "kind") != "folder" || flag(*folder, "trashed")) {
        return json{{"ok", false}, {"error", "not-found"}};
    }
    try {
        const auto created = drive_.sync().createFolder(str(*folder, "name"));
        std::vector<MoveItem> items;
        for (const auto &n : nodesOf(container)) {
            if (parentOf(n) == node && !flag(n, "trashed")) items.push_back({str(n, "id"), str(n, "name")});
        }
        moveNodes(container, items, created, std::nullopt, node, progress, cancelled);
        drive_.forgetUsage();
        return json{{"ok", true}, {"container", created}};
    } catch (const Aborted &) {
        return json{{"ok", false}, {"error", "rejected"}, {"canceled", true}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: папка не стала общей: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

void CloudFiles::removeShared(const std::string &container) {
    json top = json::array();
    const auto at = drive_.transport().nowMs();
    for (const auto &n : nodesOf(container)) {
        if (!parentOf(n)) top.push_back(json{{"op", "purge"}, {"id", str(n, "id")}, {"at", at}});
    }
    if (!top.empty()) drive_.sync().apply(container, top);
    drive_.sync().removeFolder(container);
    drive_.forgetUsage();
}

json CloudFiles::unshareFolder(const std::string &container, const std::string &name, Progress progress,
                               Cancelled cancelled) {
    try {
        const auto folder = newNodeId_();
        const auto root = drive_.sync().apply("root", json::array({json{{"op", "create"}, {"id", folder},
                                                                        {"kind", "folder"}, {"name", name}}}));
        std::vector<MoveItem> items;
        for (const auto &n : nodesOf(container)) {
            if (!parentOf(n) && !flag(n, "trashed")) items.push_back({str(n, "id"), str(n, "name")});
        }
        moveNodes(container, items, root, folder, std::nullopt, progress, cancelled);
        removeShared(container);
        return json{{"ok", true}};
    } catch (const Aborted &) {
        return json{{"ok", false}, {"error", "rejected"}, {"canceled", true}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: доступ не закрыт: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

// ── ссылки ──────────────────────────────────────────────────────────────────────

std::map<std::int64_t, std::string> CloudFiles::driveKeys() {
    std::map<std::int64_t, std::string> out;
    auto exported = drive_.sync().keysExport();
    const auto root = drive_.sync().rootId();
    if (!exported || !root) return out;
    json list = *exported;
    if (list.is_string()) {
        try {
            list = json::parse(list.get<std::string>());
        } catch (const std::exception &) {
            return out;
        }
    }
    if (!list.is_array()) return out;
    for (const auto &c : list) {
        if (str(c, "id") != *root || !c.contains("keys") || !c["keys"].is_array()) continue;
        for (const auto &pair : c["keys"]) {
            if (pair.is_array() && pair.size() == 2 && pair[0].is_number() && pair[1].is_string()) {
                out[pair[0].get<std::int64_t>()] = pair[1].get<std::string>();
            }
        }
    }
    return out;
}

std::string CloudFiles::labelNonce(const std::string &label, const std::string &linkId) {
    return drive_.blobs().sha256(label + linkId).substr(0, kNonceBytes);
}

std::optional<json> CloudFiles::readLink(const json &reply, const std::map<std::int64_t, std::string> &keys,
                                         const std::string &origin) {
    const auto id = str(reply, "linkId", "link_id");
    if (id.empty()) return std::nullopt;
    json info{{"id", id}, {"state", linkState(reply)}, {"createdAt", num(reply, "createdAt", "created_at")},
              {"expiresAt", num(reply, "expiresAt", "expires_at")}, {"bytes", num(reply, "bytes")},
              {"files", num(reply, "files")}};
    const auto wireB64 = str(reply, "ownerRecord", "owner_record");
    if (wireB64.empty()) return info;
    std::string wire;
    try {
        wire = d::fromBase64(wireB64);
    } catch (const std::exception &) {
        return info;
    }
    if (wire.size() <= 4) return info;
    const auto key = keys.find(readU32be(wire));
    if (key == keys.end()) return info;
    const auto plain = drive_.blobs().openWithKey(wire.substr(4), key->second,
                                                  d::toBase64(labelNonce(kOwnerNonceLabel, id)));
    if (!plain) return info;
    const auto record = parseOwnerRecord(*plain);
    if (!record) return info;
    info["name"] = (*record)["name"];
    info["kind"] = (*record)["kind"];
    if (record->contains("source")) info["source"] = (*record)["source"];
    info["url"] = buildLinkUrl(origin, id, (*record)["key"].get<std::string>());
    return info;
}

json CloudFiles::links(const std::string &origin) {
    try {
        const auto got = call("cloud.link.list", json::object());
        const auto keys = driveKeys();
        json list = json::array();
        if (got.contains("links") && got["links"].is_array()) {
            for (const auto &reply : got["links"]) {
                if (const auto info = readLink(reply, keys, origin)) list.push_back(*info);
            }
        }
        std::stable_sort(list.begin(), list.end(), [](const json &a, const json &b) {
            return a["createdAt"].get<std::int64_t>() > b["createdAt"].get<std::int64_t>();
        });
        return json{{"ok", true}, {"links", list}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: список ссылок не получен: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

json CloudFiles::createLink(const std::string &container, const std::optional<std::string> &node,
                            const std::string &name, int ttlDays, const std::string &origin, const Progress &progress,
                            const Cancelled &cancelled) {
    auto &blobs = drive_.blobs();
    auto &t = drive_.transport();
    const auto plan = buildLinkPlan(nodesOf(container), node, name);
    if (!plan.error.empty()) throw d::BusError(plan.error == "too-many" ? "LINK_TOO_MANY" : "ERROR_CODE_NOT_FOUND");
    // Отказ до начала: места должно хватить на все копии
    std::int64_t copyBytes = 0;
    for (const auto &f : plan.files) copyBytes += cloudCipherSize(num(f.node["blob"], "size"));
    if (const auto limits = drive_.usage(true)) {
        const auto quota = num(*limits, "quota");
        if (quota && num(*limits, "used") + copyBytes > quota) throw d::BusError("ERROR_CODE_LIMIT");
    }
    const auto keys = driveKeys();
    // Запись владельца шифруется ключом личного диска: без него ссылку потом не показать
    if (keys.empty()) throw d::BusError("ERROR_CODE_INVALID");
    const auto epoch = keys.rbegin()->first;
    const auto driveKey = keys.rbegin()->second;

    // Запрос без повтора: он не идемпотентен. LIMIT — предел числа ссылок, FORBIDDEN — ссылки выключены
    json created;
    try {
        created = call("cloud.link.create", json{{"ttl_days", ttlDays}});
    } catch (const std::exception &e) {
        const auto code = d::errorCode(e);
        if (code && *code == "ERROR_CODE_LIMIT") throw d::BusError("LINK_LIMIT");
        if (code && *code == "ERROR_CODE_FORBIDDEN") throw d::BusError("LINK_DISABLED");
        throw;
    }
    const auto linkId = str(created, "linkId", "link_id");
    if (linkId.empty()) throw d::BusError("ERROR_CODE_INVALID");
    try {
        std::map<std::string, LinkCopy> copies;
        // Миниатюры — копиями в том же пределе блобов ссылки, сколько останется после самих файлов
        std::set<std::string> thumbIds;
        const auto thumbLimit = std::min<int>(kLinkMaxThumbs, kLinkMaxFiles - int(plan.files.size()));
        for (const auto &f : plan.files) {
            if (int(thumbIds.size()) >= thumbLimit) break;
            if (f.node.contains("thumb") && f.node["thumb"].is_object()) thumbIds.insert(str(f.node, "id"));
        }
        const auto addCopy = [&](const std::string &fileId, const std::string &capability) {
            // Метод идемпотентен: повтор с тем же источником отдаёт уже сделанную копию
            for (int round = 1;; ++round) {
                check(cancelled);
                try {
                    const auto copy = call("cloud.link.add", json{{"link_id", linkId}, {"file_id", fileId},
                                                                  {"capability", capability}});
                    const auto copyId = str(copy, "fileId", "file_id");
                    if (copyId.empty()) throw d::BusError("ERROR_CODE_INVALID");
                    return std::make_tuple(copyId, num(copy, "size"), num(copy, "chunks"));
                } catch (const Aborted &) {
                    throw;
                } catch (const std::exception &e) {
                    const auto code = d::errorCode(e);
                    const bool stillCopying = code && *code == "ERROR_CODE_UNAVAILABLE";
                    if (!stillCopying || round >= kLinkAddRounds) throw;
                }
            }
        };
        std::int64_t done = 0;
        const auto all = std::int64_t(plan.files.size());
        if (progress) progress(0, all);
        for (const auto &f : plan.files) {
            const auto &blob = f.node["blob"];
            const auto [copyId, size, chunks] = addCopy(str(blob, "fileId"), str(blob, "capability"));
            LinkCopy copy{copyId, size ? size : cloudCipherSize(num(blob, "size")),
                          chunks ? chunks : std::max<std::int64_t>(1, num(blob, "chunks")), std::nullopt};
            if (thumbIds.count(str(f.node, "id"))) {
                // Миниатюра необязательна: не скопировалась — файл в ссылке без неё
                try {
                    const auto &th = f.node["thumb"];
                    const auto [thumbId, thumbSize, thumbChunks] = addCopy(str(th, "fileId"), str(th, "capability"));
                    (void)thumbChunks;
                    if (thumbSize) copy.thumb = json{{"fileId", thumbId}, {"nonce", str(th, "nonce")}, {"blobSize", thumbSize}};
                } catch (const Aborted &) {
                    throw;
                } catch (const std::exception &) {
                }
            }
            copies[str(f.node, "id")] = copy;
            done += 1;
            if (progress) progress(done, all);
        }
        check(cancelled);

        const auto linkKey = blobs.randomBytes(kLinkKeyBytes);
        const auto createdAt = t.nowMs() / 1000;
        const auto manifest = blobs.sealWithKey(buildManifest(plan, copies, createdAt).dump(), linkKey,
                                                labelNonce(kManifestNonceLabel, linkId));
        if (manifest.size() > kLinkManifestMaxBytes) throw d::BusError("LINK_TOO_MANY");
        const auto key = toBase64Url(linkKey);
        const std::pair<std::string, std::string> source{container, node.value_or("")};
        const auto ownerPlain = ownerRecordJson(plan.name, plan.kind, key, epoch, source).dump();
        const auto ownerRecord = u32be(std::uint32_t(epoch))
            + blobs.sealWithKey(ownerPlain, d::fromBase64(driveKey), labelNonce(kOwnerNonceLabel, linkId));
        if (ownerRecord.size() > kLinkOwnerRecordMaxBytes) throw d::BusError("ERROR_CODE_INVALID");
        const auto published = call("cloud.link.publish", json{{"link_id", linkId}, {"manifest", d::toBase64(manifest)},
                                                               {"owner_record", d::toBase64(ownerRecord)}});
        drive_.forgetUsage();
        std::int64_t bytes = 0;
        for (const auto &[id, c] : copies) bytes += c.blobSize;
        return json{{"id", linkId}, {"state", "active"}, {"createdAt", createdAt},
                    {"expiresAt", num(published, "expiresAt", "expires_at")}, {"bytes", bytes},
                    {"files", all}, {"name", plan.name}, {"kind", plan.kind},
                    {"source", {{"container", source.first}, {"node", source.second}}},
                    {"url", buildLinkUrl(origin, linkId, key)}};
    } catch (...) {
        // Недоделанная ссылка не должна занимать место: её копии убирает отзыв
        try {
            call("cloud.link.revoke", json{{"link_id", linkId}});
        } catch (const std::exception &e) {
            t.log(std::string("облако: недоделанная ссылка не отозвана: ") + e.what());
        }
        throw;
    }
}

json CloudFiles::linkCreate(const std::string &container, const std::optional<std::string> &node,
                            const std::string &name, int ttlDays, const std::string &origin, Progress progress,
                            Cancelled cancelled) {
    try {
        return json{{"ok", true}, {"link", createLink(container, node, name, ttlDays, origin, progress, cancelled)}};
    } catch (const Aborted &) {
        return json{{"ok", false}, {"error", "rejected"}, {"canceled", true}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: ссылка не создана: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

json CloudFiles::linkRevoke(const std::string &linkId) {
    try {
        call("cloud.link.revoke", json{{"link_id", linkId}});
        drive_.forgetUsage();
        return json{{"ok", true}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: ссылка не отозвана: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

json CloudFiles::linkExtend(const std::string &linkId, int ttlDays) {
    try {
        const auto got = call("cloud.link.extend", json{{"link_id", linkId}, {"ttl_days", ttlDays}});
        return json{{"ok", true}, {"expiresAt", num(got, "expiresAt", "expires_at")}};
    } catch (const std::exception &e) {
        drive_.transport().log(std::string("облако: срок ссылки не изменён: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

} // namespace parvane::sections::cloud
