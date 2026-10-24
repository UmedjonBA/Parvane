// Parvane fork (spec 029, T033/T034): «Облако» на сервере — порт web `cloud.ts`, части `cloudDrive.ts` и
// построителей операций `cloudStore.ts`. См. cloud_sync.h.
#include "parvane/sections/cloud_sync.h"

#include <algorithm>
#include <cctype>
#include <random>

namespace parvane::sections::cloud {

namespace d = parvane::sections::domain;

namespace {

std::string lower(std::string s) {
    for (auto &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

std::string shortId(const std::string &id) {
    return id.substr(0, 8) + "…";
}

bool isUnavailable(const std::exception &e) {
    const auto code = d::errorCode(e);
    return code && (*code == "ERROR_CODE_UNAVAILABLE" || *code == "ERROR_CODE_RATE_LIMITED");
}

bool hasCode(const std::exception &e, const char *code) {
    const auto c = d::errorCode(e);
    return c && *c == code;
}

std::string roleFrom(const json &v) {
    const std::string s = v.is_string() ? v.get<std::string>() : (v.is_number() ? std::to_string(v.get<int>()) : "");
    if (s == "CLOUD_CONTAINER_ROLE_ROOT" || s == "1") return "root";
    if (s == "CLOUD_CONTAINER_ROLE_OWNED" || s == "2") return "owned";
    if (s == "CLOUD_CONTAINER_ROLE_SHARED" || s == "3") return "shared";
    return {};
}

std::string statusFrom(const json &v) {
    const std::string s = v.is_string() ? v.get<std::string>() : (v.is_number() ? std::to_string(v.get<int>()) : "");
    if (s == "CLOUD_SHARE_STATUS_ACCEPTED" || s == "1") return "accepted";
    if (s == "CLOUD_SHARE_STATUS_DECLINED" || s == "2") return "declined";
    return {};
}

std::vector<CloudNode> nodesOf(const json &tree) {
    std::vector<CloudNode> out;
    if (!tree.is_object() || !tree.contains("nodes") || !tree["nodes"].is_array()) return out;
    for (const auto &n : tree["nodes"]) out.push_back(n.get<CloudNode>());
    return out;
}

} // namespace

// ── записи журнала состояния ──────────────────────────────────────────────────

std::vector<CloudStateEntry> parseCloudEntries(const json &snapshot) {
    std::vector<CloudStateEntry> out;
    if (!snapshot.is_object() || !snapshot.contains("cloud_containers") || !snapshot["cloud_containers"].is_array()) {
        return out;
    }
    for (const auto &c : snapshot["cloud_containers"]) {
        if (!c.is_object()) continue;
        const auto role = c.contains("role") ? roleFrom(c["role"]) : std::string();
        const json ref = c.value("ref", json::object());
        const auto id = ref.is_object() ? ref.value("id", std::string()) : std::string();
        if (id.empty() || role.empty()) continue;
        CloudStateEntry e;
        e.id = d::b64ToHex(id);
        e.domain = ref.value("domain", std::string());
        e.role = role;
        e.status = c.contains("status") ? statusFrom(c["status"]) : std::string();
        e.isRemoved = c.value("removed", false);
        e.owner = c.value("owner", std::string());
        out.push_back(e);
    }
    return out;
}

json cloudEntryToState(const CloudStateEntry &entry) {
    static const std::map<std::string, std::string> roles = {
        {"root", "CLOUD_CONTAINER_ROLE_ROOT"}, {"owned", "CLOUD_CONTAINER_ROLE_OWNED"},
        {"shared", "CLOUD_CONTAINER_ROLE_SHARED"}};
    json out{{"ref", {{"domain", entry.domain}, {"id", d::hexToB64(entry.id)}}},
             {"role", roles.count(entry.role) ? roles.at(entry.role) : entry.role},
             {"removed", entry.isRemoved},
             {"owner", entry.owner}};
    if (entry.status == "accepted") out["status"] = "CLOUD_SHARE_STATUS_ACCEPTED";
    else if (entry.status == "declined") out["status"] = "CLOUD_SHARE_STATUS_DECLINED";
    return out;
}

json toJson(const CloudContainerInfo &info) {
    json members = json::array();
    for (const auto &m : info.members) members.push_back(json{{"user", m.user}, {"role", m.role}});
    json out{{"id", info.id}, {"kind", info.kind}, {"owner", info.owner}, {"name", info.name},
             {"hasKey", info.hasKey}, {"members", members}};
    if (!info.role.empty()) out["role"] = info.role;
    return out;
}

// ── CloudSync ─────────────────────────────────────────────────────────────────

CloudSync::CloudSync(d::DomainTransport &transport, d::RecordStore &records, CloudHooks hooks)
: t_(transport), records_(records), hooks_(std::move(hooks)) {}

json CloudSync::engine(const std::string &name, const json &args) {
    return t_.engine(name, args);
}

json CloudSync::engineNeeds(const std::string &name, const json &args) {
    return t_.engineWithNeeds(name, args);
}

bool CloudSync::hasClient() {
    return t_.hasClient();
}

std::string CloudSync::call(const std::string &method, const std::string &body, const std::string &dest) {
    return t_.request(false, method, body, dest);
}

std::string CloudSync::encode(const std::string &method, const json &value) {
    return t_.encodeMethod(method, value);
}

void CloudSync::run(const json &reqs) {
    d::runRequests(t_, reqs);
}

void CloudSync::setStatus(const std::string &next) {
    if (status_ == next) return;
    status_ = next;
    if (hooks_.onChanged) hooks_.onChanged();
}

std::string CloudSync::domainOf(const std::string &id) {
    std::string fromEngine;
    if (hasClient()) {
        const auto v = engine("cloudDomain", json{{"id", id}});
        if (v.is_string()) fromEngine = v.get<std::string>();
    }
    if (!fromEngine.empty()) return fromEngine;
    return t_.serverDomain();
}

json CloudSync::refJson(const std::string &id) {
    return json{{"domain", domainOf(id)}, {"id", d::hexToB64(id)}};
}

std::vector<CloudSync::EngineContainer> CloudSync::engineContainers() {
    std::vector<EngineContainer> out;
    if (!hasClient()) return out;
    const auto list = engine("cloudContainers");
    if (!list.is_array()) return out;
    for (const auto &c : list) {
        EngineContainer e;
        e.id = c.value("id", std::string());
        e.owner = c.value("owner", std::string());
        e.role = c.contains("role") && c["role"].is_string() ? c["role"].get<std::string>() : std::string();
        e.name = c.value("name", std::string());
        e.hasKey = c.value("hasKey", false);
        e.headSeq = c.value("headSeq", std::int64_t{0});
        e.epoch = c.value("epoch", std::int64_t{0});
        e.grantVersion = c.value("grantVersion", std::int64_t{0});
        if (c.contains("members") && c["members"].is_array()) {
            for (const auto &m : c["members"]) e.members.push_back({m.value("user", std::string()), m.value("role", std::string())});
        }
        out.push_back(e);
    }
    return out;
}

std::optional<CloudSync::EngineContainer> CloudSync::findEngine(const std::string &id) {
    for (auto &c : engineContainers()) {
        if (c.id == id) return c;
    }
    return std::nullopt;
}

std::vector<CloudStateEntry> CloudSync::stateEntries() {
    return hooks_.stateEntries ? hooks_.stateEntries() : std::vector<CloudStateEntry>{};
}

std::vector<CloudStateEntry> CloudSync::liveEntries() {
    auto all = stateEntries();
    all.erase(std::remove_if(all.begin(), all.end(), [](const CloudStateEntry &e) { return e.isRemoved; }), all.end());
    return all;
}

bool CloudSync::isAttached(const std::string &id) {
    return hasClient() && engine("cloudIsAttached", json{{"id", id}}).get<bool>();
}

bool CloudSync::hasKey(const std::string &id) {
    return hasClient() && engine("cloudHasKey", json{{"id", id}}).get<bool>();
}

std::int64_t CloudSync::headSeq(const std::string &id) {
    const auto v = engine("cloudHeadSeq", json{{"id", id}});
    return v.is_number() ? v.get<std::int64_t>() : 0;
}

std::int64_t CloudSync::grantVersion(const std::string &id) {
    const auto v = engine("cloudGrantVersion", json{{"id", id}});
    return v.is_number() ? v.get<std::int64_t>() : 0;
}

void CloudSync::touch() {
    revision_ += 1;
    isDirty_ = true;
}

void CloudSync::persistIfDirty() {
    if (!isDirty_) return;
    isDirty_ = false;
    t_.persist();
}

std::optional<std::string> CloudSync::rootId() {
    std::vector<std::string> ids;
    for (const auto &e : stateEntries()) {
        if (!e.isRemoved && e.role == "root") ids.push_back(e.id);
    }
    if (ids.empty()) return std::nullopt;
    return *std::min_element(ids.begin(), ids.end());
}

// ── очередь отправки ──────────────────────────────────────────────────────────

std::vector<CloudSync::OutboxItem> &CloudSync::loadOutbox(const std::string &id) {
    const auto it = outboxes_.find(id);
    if (it != outboxes_.end()) return it->second;
    std::vector<OutboxItem> saved;
    try {
        if (const auto v = records_.load(kCloudOutboxRecord + id); v && v->is_array()) {
            for (const auto &item : *v) saved.push_back({item.value("opId", std::string()), item.value("op", std::string())});
        }
    } catch (const std::exception &) {
    }
    auto &stored = outboxes_[id] = saved;
    // Операции очереди уже применены локально до перезапуска — движок их не помнит: применить заново
    if (!saved.empty() && isAttached(id)) {
        for (const auto &item : saved) {
            try {
                engine("cloudApplyLocal", json{{"id", id}, {"op", item.op}});
            } catch (const std::exception &e) {
                t_.log(std::string("облако: операция из очереди не применена: ") + e.what());
            }
        }
        touch();
    }
    return stored;
}

void CloudSync::saveOutbox(const std::string &id) {
    const auto it = outboxes_.find(id);
    if (it != outboxes_.end() && !it->second.empty()) {
        json list = json::array();
        for (const auto &item : it->second) list.push_back(json{{"opId", item.opId}, {"op", item.op}});
        records_.save(kCloudOutboxRecord + id, list);
    } else {
        try {
            records_.remove(kCloudOutboxRecord + id);
        } catch (const std::exception &) {
        }
    }
}

// ── контейнеры ────────────────────────────────────────────────────────────────

bool CloudSync::attach(const std::string &id) {
    if (!hasClient()) return false;
    try {
        const auto dest = domainOf(id);
        const auto got = call("domain.container.get", encode("domain.container.get", json{{"container", refJson(id)}}), dest);
        const auto grants = call("domain.grant.list",
                                 encode("domain.grant.list", json{{"container", refJson(id)}, {"after_version", "0"}}), dest);
        engineNeeds("cloudAttach", json{{"getResponse", d::toBase64(got)}, {"grantsResponse", d::toBase64(grants)}});
    } catch (const std::exception &e) {
        if (hasCode(e, "ERROR_CODE_NOT_FOUND")) {
            dropContainer(id);
            return false;
        }
        throw;
    }
    snapshotTried_.erase(id);
    touch();
    loadOutbox(id);
    isDirty_ = false;
    t_.persist();
    t_.log("облако: контейнер подключён (" + shortId(id) + ")");
    return true;
}

void CloudSync::dropContainer(const std::string &id) {
    if (hasClient()) engine("cloudForget", json{{"id", id}});
    touch();
    outboxes_.erase(id);
    try {
        records_.remove(kCloudOutboxRecord + id);
    } catch (const std::exception &) {
    }
    lost_.insert(id);
    for (const auto &entry : liveEntries()) {
        if (entry.id == id && entry.role == "shared" && hooks_.recordEntry) {
            auto removed = entry;
            removed.isRemoved = true;
            hooks_.recordEntry(removed);
            break;
        }
    }
    t_.log("облако: доступа к контейнеру " + shortId(id) + " больше нет");
    // Папка исчезла — UI перечитает список
    if (hooks_.onChanged) hooks_.onChanged();
}

std::set<std::string> &CloudSync::loadRemoteDomains() {
    if (!remoteDomains_) {
        remoteDomains_.emplace();
        try {
            if (const auto v = records_.load(kCloudRemoteDomainsRecord); v && v->is_array()) {
                for (const auto &dname : *v) {
                    if (dname.is_string()) remoteDomains_->insert(dname.get<std::string>());
                }
            }
        } catch (const std::exception &) {
        }
    }
    return *remoteDomains_;
}

void CloudSync::noteRemoteDomain(const std::string &domainName) {
    const auto dname = lower(domainName);
    if (dname.empty() || dname == lower(t_.serverDomain())) return;
    auto &set = loadRemoteDomains();
    if (set.count(dname)) return;
    set.insert(dname);
    try {
        records_.save(kCloudRemoteDomainsRecord, json(std::vector<std::string>(set.begin(), set.end())));
    } catch (const std::exception &) {
    }
}

void CloudSync::discover() {
    if (!hasClient()) return;
    // Свой сервер и серверы чужих папок (spec 028): папка видна только в списке сервера владельца
    const auto own = lower(t_.serverDomain());
    // Порядок обхода — как у Set web: свой первым, дальше в порядке добавления
    std::vector<std::string> domains;
    auto add = [&domains](const std::string &dname) {
        if (std::find(domains.begin(), domains.end(), dname) == domains.end()) domains.push_back(dname);
    };
    add(own);
    for (const auto &dname : loadRemoteDomains()) add(dname);
    for (const auto &c : engineContainers()) add(lower(domainOf(c.id)));
    for (const auto &e : liveEntries()) {
        if (!e.domain.empty()) add(lower(e.domain));
    }
    std::vector<std::pair<std::string, std::string>> onServer; // id → владелец (порядок ответа)
    std::set<std::string> listed;
    for (const auto &dname : domains) {
        std::string resp;
        try {
            resp = call("domain.container.list", encode("domain.container.list", json{{"domain", kCloudDomain}}), dname);
        } catch (const std::exception &e) {
            // Свой сервер обязан ответить; недоступный чужой — папки его не считаем отозванными
            if (dname == own) throw;
            const auto code = d::errorCode(e);
            t_.log("облако: список папок сервера " + dname + " не получен (" + (code ? *code : "undefined") + ")");
            continue;
        }
        listed.insert(dname);
        const auto list = t_.decodeMethod("domain.container.list", resp);
        if (!list.is_object() || !list.contains("containers") || !list["containers"].is_array()) continue;
        for (const auto &c : list["containers"]) {
            const json ref = c.value("ref", json::object());
            const auto id = ref.is_object() ? ref.value("id", std::string()) : std::string();
            if (id.empty()) continue;
            const json owner = c.value("owner", json::object());
            const auto hex = d::b64ToHex(id);
            const auto address = owner.is_object() ? owner.value("address", std::string()) : std::string();
            auto it = std::find_if(onServer.begin(), onServer.end(), [&](const auto &p) { return p.first == hex; });
            if (it == onServer.end()) onServer.emplace_back(hex, address);
            else it->second = address;
        }
    }
    const auto self = t_.self();
    const auto entries = stateEntries();
    for (const auto &[id, owner] : onServer) {
        const auto entry = std::find_if(entries.begin(), entries.end(), [&](const CloudStateEntry &e) { return e.id == id; });
        // Отклонённое приглашение и удалённую свою папку не подключаем
        if (entry != entries.end() && (entry->isRemoved || entry->status == "declined")) continue;
        // Свой контейнер без записи состояния: другой свой клиент ещё не дописал журнал — подождём запись
        if (owner == self && entry == entries.end()) continue;
        if (!isAttached(id)) {
            lost_.erase(id);
            // Один не подключившийся контейнер не останавливает остальные (раньше исключение обрывало весь обход)
            try {
                attach(id);
            } catch (const std::exception &e) {
                t_.log("облако: контейнер " + shortId(id) + " не подключён: " + e.what());
            }
        }
    }
    // Подключённый чужой контейнер пропал из списка — доступ отозван
    for (const auto &c : engineContainers()) {
        const bool present = std::any_of(onServer.begin(), onServer.end(), [&](const auto &p) { return p.first == c.id; });
        if (c.owner != self && !present && listed.count(lower(domainOf(c.id)))) dropContainer(c.id);
    }
    int own_count = 0;
    for (const auto &p : onServer) own_count += p.second == self;
    ownOnServer_ = own_count;
    ownWithoutEntry_ = static_cast<int>(std::count_if(onServer.begin(), onServer.end(), [&](const auto &p) {
        return p.second == self && std::none_of(entries.begin(), entries.end(), [&](const CloudStateEntry &e) { return e.id == p.first; });
    }));
    isDiscovered_ = true;
}

void CloudSync::shareWithOwnDevices(const std::string &id) {
    if (!hasClient()) return;
    try {
        run(engineNeeds("cloudShareWithOwnDevices", json{{"id", id}}));
    } catch (const std::exception &e) {
        t_.log(std::string("облако: ключ своим устройствам не передан: ") + e.what());
    }
}

std::string CloudSync::createContainer(const std::string &role, const std::string &name) {
    if (!hasClient() || !t_.isReady()) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    const auto made = engine("cloudCreate", json{{"tsMs", t_.nowMs()}});
    const auto id = made.value("id", std::string());
    try {
        d::runRequest(t_, d::OutRequest::fromJson(made["request"]));
    } catch (...) {
        engine("cloudForget", json{{"id", id}});
        throw;
    }
    touch();
    outboxes_[id] = {};
    if (hooks_.recordEntry) hooks_.recordEntry(CloudStateEntry{id, t_.serverDomain(), role, "", false, ""});
    isDirty_ = false;
    t_.persist();
    t_.log("облако: контейнер создан (" + shortId(id) + ", " + role + ")");
    shareWithOwnDevices(id);
    if (!name.empty()) applyNow(id, json::array({json{{"op", "meta"}, {"name", name}}}));
    return id;
}

std::optional<std::string> CloudSync::ensureRoot(bool createIfMissing) {
    if (!hasClient() || !t_.isReady()) return std::nullopt;
    if (const auto known = rootId()) {
        if (isAttached(*known) || attach(*known)) return known;
        return std::nullopt;
    }
    if (!createIfMissing) return std::nullopt;
    // Новый диск — только когда его точно нет: свой контейнер без записи журнала состояния может оказаться диском,
    // запись которого ещё не дочитана. Второй диск с меньшим id подменил бы настоящий на всех устройствах
    discover();
    if (rootId()) return ensureRoot(false);
    if (ownWithoutEntry_ > 0) {
        t_.log("облако: личный диск не создан — на сервере есть свой контейнер без записи журнала состояния");
        throw d::BusError("ERROR_CODE_UNAVAILABLE");
    }
    return createContainer("root", "");
}

// ── журнал и снимок ───────────────────────────────────────────────────────────

void CloudSync::pullGrants(const std::string &id) {
    const auto resp = call("domain.grant.list",
                           encode("domain.grant.list", json{{"container", refJson(id)},
                                                            {"after_version", std::to_string(grantVersion(id))}}),
                           domainOf(id));
    engineNeeds("cloudIngestGrants", json{{"id", id}, {"grantsResponse", d::toBase64(resp)}});
}

void CloudSync::refreshAuthors(const std::string &id) {
    const auto container = findEngine(id);
    if (!container) return;
    const auto self = t_.self();
    std::vector<std::string> users{container->owner};
    for (const auto &m : container->members) users.push_back(m.user);
    for (const auto &user : users) {
        if (user == self || !hooks_.refreshPeerLog) continue;
        try {
            hooks_.refreshPeerLog(user);
        } catch (const std::exception &) {
        }
    }
}

bool CloudSync::pull(const std::string &id) {
    if (!isAttached(id)) return false;
    bool changed = false;
    const auto versionBefore = grantVersion(id);
    const auto before = findEngine(id);
    pullGrants(id);
    if (grantVersion(id) != versionBefore) {
        changed = true;
        touch();
        // Участник ушёл сам (состав уменьшился, эпоха прежняя): владелец меняет эпоху, чтобы ушедший не читал новое
        const auto after = findEngine(id);
        const bool hasLeft = before && after && after->role == "owner"
            && after->members.size() < before->members.size() && after->epoch == before->epoch;
        if (hasLeft && hasKey(id)) {
            try {
                run(engineNeeds("cloudRotate", json{{"id", id}, {"tsMs", t_.nowMs()}}));
                t_.log("облако: участник покинул папку " + shortId(id) + " — эпоха ключа сменена");
            } catch (const std::exception &e) {
                t_.log(std::string("облако: смена эпохи после выхода участника не удалась: ") + e.what());
            }
        }
    }
    if (!snapshotTried_.count(id) && headSeq(id) == 0 && hasKey(id)) {
        snapshotTried_.insert(id);
        const auto resp = call("domain.snapshot.get", encode("domain.snapshot.get", json{{"container", refJson(id)}}), domainOf(id));
        try {
            const auto r = engine("cloudIngestSnapshot", json{{"id", id}, {"snapshotResponse", d::toBase64(resp)}});
            if (!r.is_number() || r.get<std::int64_t>() != 0) {
                changed = true;
                touch();
                t_.log("облако: " + shortId(id) + " снимок принят (seq " + std::to_string(headSeq(id)) + ")");
                // Дерево из снимка — на экран сразу, догон журнала следом
                if (hooks_.onChanged) hooks_.onChanged();
            }
        } catch (const std::exception &e) {
            t_.log(std::string("облако: снимок не прочитан: ") + e.what());
        }
    }
    bool isStrict = true;
    for (int page = 0; page < kSyncPages; ++page) {
        const auto resp = call("domain.op.sync",
                               encode("domain.op.sync", json{{"container", refJson(id)},
                                                             {"after_seq", std::to_string(headSeq(id))},
                                                             {"max_bytes", 0}}),
                               domainOf(id));
        const auto r = engine("cloudIngestSync", json{{"id", id}, {"syncResponse", d::toBase64(resp)}, {"strict", isStrict}});
        const auto applied = r.value("applied", 0);
        if (applied) {
            changed = true;
            touch();
            t_.log("облако: " + shortId(id) + " догнано " + std::to_string(applied) + " операций (seq "
                   + std::to_string(headSeq(id)) + ")");
        }
        if (r.value("authorsBehind", false)) {
            // Ключ автора неизвестен: новое устройство участника — обновить журналы устройств и повторить;
            // что не опознано и после этого — пропускается
            refreshAuthors(id);
            isStrict = false;
            continue;
        }
        isStrict = true;
        if (r.value("grantsBehind", false)) {
            pullGrants(id);
            continue;
        }
        if (!r.value("more", false)) break;
    }
    return changed;
}

void CloudSync::maybeSnapshot(const std::string &id) {
    if (!hasKey(id)) return;
    try {
        const auto req = engine("cloudSnapshotRequest", json{{"id", id}, {"tsMs", t_.nowMs()}});
        if (req.is_null()) return;
        d::runRequest(t_, d::OutRequest::fromJson(req));
        // Движок запомнил seq снимка — в персист (дерево не менялось, ревизия прежняя)
        isDirty_ = true;
        t_.log("облако: снимок записан (" + shortId(id) + ", seq " + std::to_string(headSeq(id)) + ")");
    } catch (const std::exception &e) {
        t_.log(std::string("облако: снимок не записан: ") + e.what());
    }
}

int CloudSync::sendOutbox(const std::string &id) {
    if (!isAttached(id)) return 0;
    auto &outbox = loadOutbox(id);
    int rejected = 0;
    while (!outbox.empty()) {
        const auto item = outbox.front();
        if (!hasKey(id)) return rejected;
        try {
            const auto req = engine("cloudSeal", json{{"id", id}, {"op", item.op}, {"opIdHex", item.opId}, {"tsMs", t_.nowMs()}});
            d::runRequest(t_, d::OutRequest::fromJson(req));
        } catch (const std::exception &e) {
            const auto code = d::errorCode(e);
            if (code && *code == "ERROR_CODE_EXPIRED") {
                // Эпоха сменилась: догнать гранты, ключ придёт по E2E
                const auto before = grantVersion(id);
                pullGrants(id);
                if (grantVersion(id) == before || !hasKey(id)) return rejected;
                continue;
            }
            if (code && (*code == "ERROR_CODE_FORBIDDEN" || *code == "ERROR_CODE_NOT_FOUND" || *code == "ERROR_CODE_INVALID")) {
                // Права записи больше нет (роль понижена, доступ отозван): правка не будет принята
                t_.log("облако: правка отвергнута сервером (" + *code + ")");
                rejected += 1;
            } else if (!code || *code != "ERROR_CODE_DUPLICATE") {
                throw;
            }
        }
        outbox.erase(outbox.begin());
        saveOutbox(id);
    }
    return rejected;
}

void CloudSync::collectGarbage(const std::string &id) {
    const auto self = t_.self();
    if (!hasClient() || self.empty()) return;
    const auto state = engine("cloudStateJson", json{{"id", id}});
    if (!state.is_object()) return;
    const auto purged = state.value("purgedBlobs", json::array());
    if (!purged.is_array() || purged.empty()) return;
    if (!gcDone_) {
        gcDone_.emplace();
        try {
            if (const auto v = records_.load(kCloudGcRecord); v && v->is_array()) {
                for (const auto &f : *v) {
                    if (f.is_string()) gcDone_->push_back(f.get<std::string>());
                }
            }
        } catch (const std::exception &) {
        }
    }
    std::set<std::string> done(gcDone_->begin(), gcDone_->end());
    bool hasChanges = false;
    for (const auto &blob : purged) {
        const auto fileId = blob.value("fileId", std::string());
        if (blob.value("uploader", std::string()) != self || done.count(fileId)) continue;
        try {
            if (hooks_.deleteBlob) hooks_.deleteBlob(fileId);
        } catch (const std::exception &e) {
            if (!hasCode(e, "ERROR_CODE_NOT_FOUND")) continue;
        }
        gcDone_->push_back(fileId);
        done.insert(fileId);
        hasChanges = true;
    }
    if (!hasChanges) return;
    if (gcDone_->size() > kGcKeep) gcDone_->erase(gcDone_->begin(), gcDone_->end() - kGcKeep);
    records_.save(kCloudGcRecord, json(*gcDone_));
    // Место освободилось — UI перечитает показатель
    if (hooks_.onChanged) hooks_.onChanged();
}

bool CloudSync::purgeExpiredTrash(const std::string &id) {
    const auto container = findEngine(id);
    const bool isOwner = (container && container->role == "owner") || rootId() == id;
    if (!hasClient() || !container || !isOwner || !hasKey(id)) return false;
    const auto state = engine("cloudStateJson", json{{"id", id}});
    if (!state.is_object()) return false;
    const auto now = t_.nowMs();
    const auto expired = expiredTrashOf(nodesOf(state), now);
    if (expired.empty()) return false;
    t_.log("облако: срок корзины вышел у " + std::to_string(expired.size()) + " объектов — стираются");
    try {
        applyNow(id, purgeOps(expired, now));
    } catch (const std::exception &e) {
        // Движок правку не принял — синхронизация из-за этого останавливаться не должна
        t_.log(std::string("облако: корзина не очищена: ") + e.what());
        return false;
    }
    sendOutbox(id);
    return true;
}

bool CloudSync::syncContainer(const std::string &id) {
    try {
        sendOutbox(id);
        const bool changed = pull(id);
        // Срок корзины — раз в час и после журнала: восстановленное на другом устройстве уже не в корзине
        const auto now = t_.nowMs();
        const auto checked = trashCheckedAt_.count(id) ? trashCheckedAt_[id] : 0;
        const bool isTrashDue = now - checked >= kTrashCheckMs;
        if (isTrashDue) trashCheckedAt_[id] = now;
        const bool purged = isTrashDue ? purgeExpiredTrash(id) : false;
        maybeSnapshot(id);
        // Сборка блобов стёртых файлов — только когда дерево менялось (и один раз после запуска)
        if (changed || purged || !gcChecked_.count(id)) {
            gcChecked_.insert(id);
            collectGarbage(id);
        }
        return changed || purged;
    } catch (const std::exception &e) {
        if (hasCode(e, "ERROR_CODE_NOT_FOUND")) {
            dropContainer(id);
            return true;
        }
        throw;
    }
}

void CloudSync::scheduleRetry() {
    if (retryTimer_.armed()) return;
    retryTimer_.set(t_.nowMs() + kRetryOfflineMs);
}

void CloudSync::scheduleSync() {
    syncTimer_.clear();
    if (!isWanted_) return;
    syncTimer_.set(t_.nowMs() + d::pollDelay(kSyncActiveMs, kSyncIdleMs, isActive_ && isVisible_));
}

void CloudSync::syncNow(bool shouldDiscover) {
    syncSoon_.clear();
    shouldDiscover = shouldDiscover || discoverSoon_;
    discoverSoon_ = false;
    try {
        if (!hasClient() || !t_.isReady()) {
            setStatus(t_.needsLinking() ? "needs-linking" : "loading");
            scheduleSync();
            return;
        }
        if (shouldDiscover || !isDiscovered_ || isActive_) discover();
        ensureRoot(false);
        bool changed = false;
        // В фоне — только личный диск (нужен «Сохранить в облако»)
        const auto root = rootId();
        std::vector<std::string> ids;
        for (const auto &c : engineContainers()) {
            if (isActive_ || c.id == root) ids.push_back(c.id);
        }
        for (const auto &id : ids) {
            if (syncContainer(id)) changed = true;
        }
        persistIfDirty();
        const auto rootNow = rootId();
        bool hasMissingKey = false;
        for (const auto &c : engineContainers()) hasMissingKey = hasMissingKey || (rootNow == c.id && !c.hasKey);
        setStatus(hasMissingKey ? "no-key" : "ready");
        lastError_.reset();
        if (changed && hooks_.onChanged) hooks_.onChanged();
    } catch (const std::exception &e) {
        lastError_ = d::errorText(e);
        t_.log("облако: синхронизация: " + *lastError_);
        if (isUnavailable(e)) {
            setStatus("offline");
            scheduleRetry();
        }
    }
    scheduleSync();
}

// ── правки ────────────────────────────────────────────────────────────────────

void CloudSync::applyNow(const std::string &id, const json &ops) {
    if (!hasClient()) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    auto &outbox = loadOutbox(id);
    for (size_t i = 0; i < ops.size(); i += kMaxOpsPerBatch) {
        json chunk = json::array();
        for (size_t k = i; k < ops.size() && k < i + kMaxOpsPerBatch; ++k) chunk.push_back(ops[k]);
        const auto local = engine("cloudPrepareLocal", json{{"id", id}, {"opsJson", json{{"ops", chunk}}}});
        outbox.push_back({local.value("opId", std::string()), local.value("op", std::string())});
    }
    touch();
    saveOutbox(id);
    isDirty_ = false;
    t_.persist();
    if (hooks_.onChanged) hooks_.onChanged();
}

// ── API ───────────────────────────────────────────────────────────────────────

void CloudSync::ensure(bool active) {
    isWanted_ = true;
    if (active != isActive_) {
        isActive_ = active;
        scheduleSync();
    }
    syncNow(true);
}

void CloudSync::ensureSoon(bool active) {
    isWanted_ = true;
    if (active != isActive_) isActive_ = active;
    discoverSoon_ = true;
    syncSoon_.set(t_.nowMs());
}

void CloudSync::setActive(bool active) {
    // Открытый раздел — потребитель облака: после сброса сессии опрос иначе не возобновлялся
    if (active) isWanted_ = true;
    if (isActive_ == active) return;
    isActive_ = active;
    if (active && isVisible_) {
        discoverSoon_ = true;
        syncSoon_.set(t_.nowMs());
    } else {
        scheduleSync();
    }
}

void CloudSync::setVisible(bool visible) {
    isVisible_ = visible;
    if (!isWanted_) return;
    // Окно снова видно при открытом разделе: догнать сразу
    if (visible && isActive_) syncSoon_.set(t_.nowMs());
    else scheduleSync();
}

std::string CloudSync::apply(const std::string &container, const json &ops) {
    std::optional<std::string> id = container == "root" ? ensureRoot(true) : std::optional<std::string>(container);
    if (!id) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    applyNow(*id, ops);
    // Отправка очереди — «в фоне» (web `void serial(() => sendOutbox(id))`)
    if (std::find(sendQueue_.begin(), sendQueue_.end(), *id) == sendQueue_.end()) sendQueue_.push_back(*id);
    sendSoon_.set(t_.nowMs());
    return *id;
}

void CloudSync::sendSoonQueue() {
    auto ids = std::move(sendQueue_);
    sendQueue_.clear();
    for (const auto &id : ids) {
        try {
            sendOutbox(id);
        } catch (const std::exception &e) {
            lastError_ = d::errorText(e);
            if (isUnavailable(e)) {
                setStatus("offline");
                scheduleRetry();
            }
        }
    }
}

bool CloudSync::flush(const std::string &id) {
    const int rejected = sendOutbox(id);
    try {
        collectGarbage(id);
    } catch (const std::exception &) {
    }
    return !rejected && !hasPending(id);
}

bool CloudSync::hasPending(const std::string &id) const {
    const auto it = outboxes_.find(id);
    return it != outboxes_.end() && !it->second.empty();
}

std::string CloudSync::checkDrive() {
    if (!hasClient() || !t_.isReady() || t_.needsLinking() || status_ != "ready") return "unknown";
    try {
        const auto root = rootId();
        if (!root) {
            // Диск другого своего устройства виден в списке сервера раньше, чем доходит запись журнала состояния
            discover();
            return !rootId() && ownOnServer_ == 0 ? "none" : "unknown";
        }
        if (!isAttached(*root) || !hasKey(*root)) return "unknown";
        if (pull(*root) && hooks_.onChanged) hooks_.onChanged();
        return "synced";
    } catch (const std::exception &e) {
        t_.log(std::string("облако: сверка личного диска: ") + e.what());
        return "unknown";
    }
}

std::vector<CloudContainerInfo> CloudSync::containers() {
    const auto self = t_.self();
    const auto entries = stateEntries();
    const auto root = rootId();
    std::vector<CloudContainerInfo> out;
    for (const auto &c : engineContainers()) {
        if (lost_.count(c.id) || c.role.empty()) continue;
        const auto entry = std::find_if(entries.begin(), entries.end(), [&](const CloudStateEntry &e) { return e.id == c.id; });
        std::string kind = "owned";
        if (root == c.id) kind = "root";
        else if (c.owner != self) kind = entry != entries.end() && entry->status == "accepted" ? "shared" : "invite";
        out.push_back(CloudContainerInfo{c.id, kind, c.role, c.owner, c.name, c.hasKey, c.members});
    }
    return out;
}

std::optional<json> CloudSync::stateJson(const std::string &id) {
    if (!hasClient()) return std::nullopt;
    auto v = engine("cloudStateJson", json{{"id", id}});
    if (v.is_null()) return std::nullopt;
    return v;
}

std::string CloudSync::status() {
    if (!hasClient() || !t_.isReady()) return t_.needsLinking() ? "needs-linking" : "loading";
    return status_ == "loading" || status_ == "needs-linking" ? "ready" : status_;
}

std::string CloudSync::createFolder(const std::string &name) {
    return createContainer("owned", name);
}

void CloudSync::share(const std::string &id, const std::string &user, const std::string &role, const std::string &inviteText) {
    if (!hasClient()) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    const auto reqs = engineNeeds("cloudGrant", json{{"id", id}, {"user", user}, {"write", role == "editor"},
                                                    {"inviteText", inviteText}, {"tsMs", t_.nowMs()}});
    runGrantRequests(id, reqs);
}

void CloudSync::unshare(const std::string &id, const std::string &user) {
    if (!hasClient()) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    runGrantRequests(id, engineNeeds("cloudRevoke", json{{"id", id}, {"user", user}, {"tsMs", t_.nowMs()}}));
}

// Запись журнала грантов уже применена локально: при отказе сервера — перечитать журнал с сервера
void CloudSync::runGrantRequests(const std::string &id, const json &reqs) {
    touch();
    auto finish = [this] {
        isDirty_ = false;
        t_.persist();
        if (hooks_.onChanged) hooks_.onChanged();
    };
    try {
        run(reqs);
    } catch (...) {
        if (hasClient()) engine("cloudForget", json{{"id", id}});
        try {
            attach(id);
        } catch (const std::exception &) {
        }
        finish();
        throw;
    }
    finish();
}

void CloudSync::answerInvite(const std::string &id, bool accept) {
    const auto container = findEngine(id);
    CloudStateEntry entry{id, t_.serverDomain(), "shared", accept ? "accepted" : "declined", false,
                          container ? container->owner : std::string()};
    if (!accept) leaveNow(id);
    if (hooks_.recordEntry) hooks_.recordEntry(entry);
    if (hooks_.onChanged) hooks_.onChanged();
}

void CloudSync::leaveNow(const std::string &id) {
    if (!isAttached(id)) return;
    const auto req = engine("cloudLeave", json{{"id", id}, {"tsMs", t_.nowMs()}});
    touch();
    outboxes_.erase(id);
    lost_.insert(id);
    try {
        records_.remove(kCloudOutboxRecord + id);
    } catch (const std::exception &) {
    }
    try {
        d::runRequest(t_, d::OutRequest::fromJson(req));
    } catch (const std::exception &e) {
        if (!hasCode(e, "ERROR_CODE_NOT_FOUND")) throw;
    }
    isDirty_ = false;
    t_.persist();
}

void CloudSync::leave(const std::string &id) {
    // Покинуть можно только чужую папку: своя «покинутая» исчезла бы на всех своих устройствах (запись `removed`)
    if (const auto c = findEngine(id); c && c->owner == t_.self()) throw d::BusError("ERROR_CODE_INVALID");
    std::optional<CloudStateEntry> entry;
    for (const auto &e : liveEntries()) {
        if (e.id == id) entry = e;
    }
    leaveNow(id);
    if (hooks_.recordEntry) {
        hooks_.recordEntry(CloudStateEntry{id, t_.serverDomain(), "shared", entry ? entry->status : std::string(), true,
                                           entry ? entry->owner : std::string()});
    }
    if (hooks_.onChanged) hooks_.onChanged();
}

void CloudSync::removeFolder(const std::string &id) {
    if (!hasClient()) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    const auto container = findEngine(id);
    if (container) {
        for (const auto &member : container->members) {
            run(engineNeeds("cloudRevoke", json{{"id", id}, {"user", member.user}, {"tsMs", t_.nowMs()}}));
        }
    }
    try {
        sendOutbox(id);
    } catch (const std::exception &) {
    }
    try {
        collectGarbage(id);
    } catch (const std::exception &) {
    }
    engine("cloudForget", json{{"id", id}});
    touch();
    outboxes_.erase(id);
    lost_.insert(id);
    if (hooks_.recordEntry) hooks_.recordEntry(CloudStateEntry{id, t_.serverDomain(), "owned", "", true, ""});
    isDirty_ = false;
    t_.persist();
    if (hooks_.onChanged) hooks_.onChanged();
}

void CloudSync::rotate(const std::string &id) {
    if (!hasClient()) return;
    run(engineNeeds("cloudRotate", json{{"id", id}, {"tsMs", t_.nowMs()}}));
    touch();
    isDirty_ = false;
    t_.persist();
}

std::optional<json> CloudSync::keysExport() {
    if (!hasClient()) return std::nullopt;
    auto v = engine("cloudKeysExport");
    if (v.is_null()) return std::nullopt;
    return v;
}

void CloudSync::keysImport(const json &value) {
    if (!hasClient()) return;
    try {
        engine("cloudKeysImport", json{{"json", value}});
        touch();
    } catch (const std::exception &e) {
        t_.log(std::string("облако: ключи из экспорта не приняты: ") + e.what());
    }
}

void CloudSync::onEngineEvent(const std::string &id) {
    lost_.erase(id);
    // Приглашение приходит и при закрытом разделе: подключить контейнер сразу
    isWanted_ = true;
    if (std::find(eventQueue_.begin(), eventQueue_.end(), id) == eventQueue_.end()) eventQueue_.push_back(id);
    eventSoon_.set(t_.nowMs());
}

void CloudSync::runEngineEvent(const std::string &id) {
    if (!hasClient() || !t_.isReady()) return;
    // Ключ принят движком — дерево могло стать читаемым, экран перечитает
    bool changed = true;
    try {
        if (!isAttached(id)) attach(id);
        if (isAttached(id)) changed = syncContainer(id) || changed;
        persistIfDirty();
    } catch (const std::exception &e) {
        t_.log("облако: контейнер " + shortId(id) + " не подключён: " + e.what());
    }
    touch();
    isDirty_ = false;
    if (changed && hooks_.onChanged) hooks_.onChanged();
}

void CloudSync::tick() {
    const auto now = t_.nowMs();
    if (eventSoon_.fire(now)) {
        auto ids = std::move(eventQueue_);
        eventQueue_.clear();
        for (const auto &id : ids) runEngineEvent(id);
    }
    if (sendSoon_.fire(now)) sendSoonQueue();
    const bool syncDue = syncSoon_.fire(now) | syncTimer_.fire(now) | retryTimer_.fire(now);
    if (syncDue) syncNow(false);
}

std::optional<std::int64_t> CloudSync::nextWakeMs() const {
    return d::earliest({&eventSoon_, &sendSoon_, &syncSoon_, &syncTimer_, &retryTimer_});
}

void CloudSync::reset() {
    syncTimer_.clear();
    retryTimer_.clear();
    syncSoon_.clear();
    sendSoon_.clear();
    eventSoon_.clear();
    sendQueue_.clear();
    eventQueue_.clear();
    discoverSoon_ = false;
    status_ = "loading";
    outboxes_.clear();
    snapshotTried_.clear();
    lost_.clear();
    gcDone_.reset();
    gcChecked_.clear();
    trashCheckedAt_.clear();
    isWanted_ = false;
    isActive_ = false;
    isDiscovered_ = false;
    isDirty_ = false;
    revision_ += 1;
    ownOnServer_.reset();
    ownWithoutEntry_ = 0;
    lastError_.reset();
}

// ── провайдер раздела (cloudDrive.ts) ──────────────────────────────────────────

std::string newCloudNodeId() {
    static thread_local std::mt19937_64 gen{std::random_device{}()};
    static constexpr char digits[] = "0123456789abcdef";
    std::string out;
    for (int i = 0; i < 32; ++i) out += digits[gen() & 15];
    return out;
}

std::string errorOf(const std::exception &e) {
    const auto code = d::errorCode(e).value_or(std::string(e.what()));
    const auto has = [&code](const char *s) { return code.find(s) != std::string::npos; };
    if (code == "LINK_TOO_MANY") return "link-too-many";
    if (code == "LINK_LIMIT") return "link-limit";
    if (code == "LINK_DISABLED") return "link-disabled";
    if (has("FieldLimit")) return "too-many";
    if (has("LIMIT")) return "no-space";
    if (has("FORBIDDEN") || has("Forbidden")) return "forbidden";
    if (has("NOT_FOUND") || has("NotFound")) return "not-found";
    if (has("UNAVAILABLE") || has("RATE_LIMITED")) return "offline";
    return "rejected";
}

// По умолчанию крипто и сырых загрузок у блобов нет: файлы раздела (cloud_files.cpp) получат отказ
std::string CloudBlobs::randomBytes(std::size_t) { throw std::runtime_error("CloudBlobs: randomBytes unsupported"); }
std::string CloudBlobs::sha256(const std::string &) { throw std::runtime_error("CloudBlobs: sha256 unsupported"); }
std::string CloudBlobs::sealWithKey(const std::string &, const std::string &, const std::string &) {
    throw std::runtime_error("CloudBlobs: sealWithKey unsupported");
}
std::optional<std::string> CloudBlobs::openWithKey(const std::string &, const std::string &, const std::string &) {
    return std::nullopt;
}
std::string CloudBlobs::uploadCipher(const std::string &, const std::string &) {
    throw std::runtime_error("CloudBlobs: uploadCipher unsupported");
}

CloudDrive::CloudDrive(CloudSync &cloud, CloudBlobs &blobs, d::DomainTransport &transport,
                       std::function<std::string()> newNodeId)
: cloud_(cloud), blobs_(blobs), t_(transport), newNodeId_(newNodeId ? std::move(newNodeId) : newCloudNodeId) {}

template <typename F> json CloudDrive::result(F &&f) {
    try {
        return f();
    } catch (const std::exception &e) {
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

std::optional<json> CloudDrive::readTree(const std::string &container) {
    const auto revision = cloud_.revision();
    if (revision != treeCacheRevision_) {
        treeCache_.clear();
        treeCacheRevision_ = revision;
    }
    if (const auto it = treeCache_.find(container); it != treeCache_.end()) return it->second;
    auto tree = cloud_.stateJson(container);
    treeCache_[container] = tree;
    return tree;
}

std::optional<json> CloudDrive::findNode(const std::string &container, const std::string &node) {
    const auto tree = readTree(container);
    if (!tree || !tree->contains("nodes")) return std::nullopt;
    for (const auto &n : (*tree)["nodes"]) {
        if (n.value("id", std::string()) == node) return n;
    }
    return std::nullopt;
}

json CloudDrive::state() {
    const auto status = cloud_.status();
    if (status != "needs-linking" && status != "loading" && !isEnsureStarted_) {
        isEnsureStarted_ = true;
        // Частый опрос включает сам раздел (`parvaneCloudSetActive`)
        cloud_.ensureSoon(false);
    }
    json containers = json::array();
    json trees = json::object();
    for (const auto &c : cloud_.containers()) {
        containers.push_back(toJson(c));
        if (const auto tree = readTree(c.id)) trees[c.id] = *tree;
    }
    json out{{"status", status}, {"containers", containers}, {"trees", trees}};
    if (const auto root = cloud_.rootId()) out["rootId"] = *root;
    if (const auto err = cloud_.lastError()) out["error"] = *err;
    return out;
}

json CloudDrive::applyOps(const std::string &container, const json &ops) {
    try {
        return json{{"ok", true}, {"container", cloud_.apply(container, ops)}};
    } catch (const std::exception &e) {
        t_.log(std::string("облако: правка отвергнута: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

json CloudDrive::writeText(const json &args) {
    try {
        const auto container = args.value("container", std::string());
        const auto nodeArg = args.value("node", std::string());
        std::optional<json> existing;
        if (!nodeArg.empty()) existing = findNode(container, nodeArg);
        if (!nodeArg.empty() && !existing) return json{{"ok", false}, {"error", "not-found"}};
        const auto expected = args.value("expectedFileId", std::string());
        const auto mimeArg = args.value("mime", std::string());
        // Версия файла сменилась за время правки: вернуть текущий текст как конфликт
        if (existing && existing->contains("blob") && (*existing)["blob"].is_object() && !expected.empty()
            && (*existing)["blob"].value("fileId", std::string()) != expected) {
            const auto current = blobs_.download((*existing)["blob"]);
            if (!current) return json{{"ok", false}, {"error", "offline"}};
            return json{{"ok", true}, {"container", container}, {"node", nodeArg},
                        {"fileId", (*existing)["blob"].value("fileId", std::string())}, {"conflict", *current}};
        }
        const auto mime = mimeArg.empty() ? std::string("text/markdown") : mimeArg;
        const auto uploaded = blobs_.upload(args.value("text", std::string()), mime);
        json blob{{"fileId", uploaded.value("fileId", std::string())},
                  {"key", uploaded.value("key", std::string())},
                  {"nonce", uploaded.value("nonce", std::string())},
                  {"capability", uploaded.value("capability", std::string())},
                  {"size", uploaded.value("size", 0)},
                  {"chunks", uploaded.value("chunks", 1)},
                  {"mime", mime},
                  {"uploader", t_.self()}};
        std::string node = nodeArg;
        if (node.empty()) node = args.value("newNodeId", std::string());
        if (node.empty()) node = newNodeId_();
        const auto mtime = t_.nowMs();
        json ops = json::array();
        if (existing) {
            ops.push_back(json{{"op", "setBlob"}, {"id", node}, {"blob", blob}, {"mtime", mtime}});
        } else {
            json parent = args.contains("parent") && args["parent"].is_string() ? args["parent"] : json(nullptr);
            if (args.contains("newFolder") && args["newFolder"].is_object()) {
                const auto &folder = args["newFolder"];
                json create{{"op", "create"}, {"id", folder.value("id", std::string())}, {"kind", "folder"},
                            {"name", folder.value("name", std::string())}};
                if (!parent.is_null()) create["parent"] = parent;
                ops.push_back(create);
                parent = folder.value("id", std::string());
            }
            json create{{"op", "create"}, {"id", node}, {"kind", "file"}, {"name", args.value("name", std::string())},
                        {"mtime", mtime}, {"blob", blob}};
            if (!parent.is_null()) create["parent"] = parent;
            ops.push_back(create);
        }
        const auto id = cloud_.apply(container, ops);
        usage_.reset();
        return json{{"ok", true}, {"container", id}, {"node", node}, {"fileId", blob["fileId"]}};
    } catch (const std::exception &e) {
        t_.log(std::string("облако: текст не записан: ") + e.what());
        return json{{"ok", false}, {"error", errorOf(e)}};
    }
}

std::optional<json> CloudDrive::readText(const std::string &container, const std::string &node, const json &given) {
    json blob;
    if (given.is_object()) blob = given;
    else if (const auto found = findNode(container, node); found && found->contains("blob")) blob = (*found)["blob"];
    if (!blob.is_object()) return std::nullopt;
    try {
        const auto bytes = blobs_.download(blob);
        if (!bytes) return std::nullopt;
        return json{{"text", *bytes}, {"fileId", blob.value("fileId", std::string())}};
    } catch (const std::exception &e) {
        t_.log(std::string("облако: текст не прочитан: ") + e.what());
        return std::nullopt;
    }
}

json CloudDrive::readTexts(const std::string &container, const json &nodes) {
    json out = json::array();
    if (!nodes.is_array()) return out;
    for (const auto &n : nodes) {
        const auto id = n.value("id", std::string());
        json blob = n.contains("blob") && n["blob"].is_object() ? n["blob"] : json(nullptr);
        if (blob.is_null()) {
            if (const auto found = findNode(container, id); found && found->contains("blob")) blob = (*found)["blob"];
        }
        if (!blob.is_object()) {
            out.push_back(json{{"id", id}, {"error", "not-found"}});
            continue;
        }
        try {
            const auto bytes = blobs_.download(blob);
            if (!bytes) out.push_back(json{{"id", id}, {"error", "not-found"}});
            else out.push_back(json{{"id", id}, {"text", *bytes}, {"fileId", blob.value("fileId", std::string())}});
        } catch (const std::exception &e) {
            t_.log(std::string("облако: текст не прочитан: ") + e.what());
            out.push_back(json{{"id", id}, {"error", errorOf(e)}});
        }
    }
    return out;
}

std::optional<json> CloudDrive::usage(bool force) {
    const auto now = t_.nowMs();
    if (!force && usage_ && now - usage_->first < 1500) return usage_->second;
    try {
        const auto got = blobs_.usage();
        json drive;
        if (got.contains("buckets") && got["buckets"].is_array()) {
            for (const auto &b : got["buckets"]) {
                const auto &bucket = b.contains("bucket") ? b["bucket"] : json(nullptr);
                if (bucket == "BLOB_BUCKET_DRIVE" || bucket == 1) {
                    drive = b;
                    break;
                }
            }
        }
        const auto num = [](const json &obj, const char *a, const char *b = nullptr) -> std::int64_t {
            for (const char *k : {a, b}) {
                if (!k || !obj.is_object() || !obj.contains(k)) continue;
                const auto &v = obj[k];
                if (v.is_number()) return v.get<std::int64_t>();
                if (v.is_string() && !v.get<std::string>().empty()) return std::stoll(v.get<std::string>());
            }
            return 0;
        };
        json value{{"used", num(drive, "used")}, {"quota", num(drive, "quota")},
                   {"maxFile", num(drive, "maxFile", "max_file")}, {"linksBytes", num(got, "linksBytes", "links_bytes")}};
        usage_ = std::make_pair(now, value);
        return value;
    } catch (const std::exception &) {
        return std::nullopt;
    }
}

json CloudDrive::createShared(const std::string &name) {
    return result([&] { return json{{"ok", true}, {"container", cloud_.createFolder(name)}}; });
}

json CloudDrive::removeShared(const std::string &container) {
    return result([&] {
        json top = json::array();
        const auto at = t_.nowMs();
        if (const auto tree = readTree(container); tree && tree->contains("nodes")) {
            for (const auto &n : (*tree)["nodes"]) {
                if (!n.contains("parent") || n["parent"].is_null() || n["parent"] == "") {
                    top.push_back(json{{"op", "purge"}, {"id", n.value("id", std::string())}, {"at", at}});
                }
            }
        }
        if (!top.empty()) cloud_.apply(container, top);
        cloud_.removeFolder(container);
        usage_.reset();
        return json{{"ok", true}};
    });
}

std::optional<json> CloudDrive::handle(const std::string &method, const json &args) {
    const auto s = [&args](const char *k) { return args.is_object() ? args.value(k, std::string()) : std::string(); };
    if (method == "parvaneCloudState") return state();
    if (method == "parvaneCloudSetActive") {
        cloud_.setActive(args.value("isActive", false));
        return json(true);
    }
    if (method == "parvaneCloudSync") {
        cloud_.syncNow(true);
        return json(true);
    }
    if (method == "parvaneCloudApply") return applyOps(s("container"), args.value("ops", json::array()));
    if (method == "parvaneCloudWriteText") return writeText(args);
    if (method == "parvaneCloudCheckDrive") return json(cloud_.checkDrive());
    if (method == "parvaneCloudReadText") {
        const auto r = readText(s("container"), s("node"), args.value("blob", json(nullptr)));
        return r ? *r : json(nullptr);
    }
    if (method == "parvaneCloudReadTexts") return readTexts(s("container"), args.value("nodes", json::array()));
    if (method == "parvaneCloudUsage") return usage();
    if (method == "parvaneCloudCreateShared") return createShared(s("name"));
    if (method == "parvaneCloudShare") {
        // Адрес по id чата — забота вызывающего: здесь только `user`
        const auto user = s("user");
        if (user.empty()) return json{{"ok", false}, {"error", "not-found"}};
        return result([&] {
            cloud_.share(s("container"), user, s("role"), s("inviteText"));
            return json{{"ok", true}};
        });
    }
    if (method == "parvaneCloudUnshare") {
        return result([&] {
            cloud_.unshare(s("container"), s("user"));
            return json{{"ok", true}};
        });
    }
    if (method == "parvaneCloudAnswerInvite") {
        return result([&] {
            cloud_.answerInvite(s("container"), args.value("isAccepted", false));
            return json{{"ok", true}};
        });
    }
    if (method == "parvaneCloudLeave") {
        return result([&] {
            cloud_.leave(s("container"));
            return json{{"ok", true}};
        });
    }
    if (method == "parvaneCloudRemoveShared") return removeShared(s("container"));
    return std::nullopt;
}

// ── построители операций экрана (cloudStore.ts) ────────────────────────────────

namespace {

void putParent(json &op, const std::optional<std::string> &parent) {
    // `parent: undefined` web в JSON не попадает
    if (parent) op["parent"] = *parent;
}

std::optional<std::string> parentOf(const CloudNode &n) {
    if (!n.parent || n.parent->empty()) return std::nullopt;
    return n.parent;
}

} // namespace

json createFolderOps(const std::vector<CloudNode> &nodes, const std::optional<std::string> &parent,
                     const std::string &name, const std::string &newId) {
    json op{{"op", "create"}, {"id", newId}, {"kind", "folder"}, {"name", freeName(namesIn(nodes, parent), name)}};
    putParent(op, parent);
    return json::array({op});
}

json renameOps(const std::vector<CloudNode> &nodes, const CloudNode &node, const std::string &name) {
    if (name == node.name) return json::array();
    const auto parent = parentOf(node);
    json op{{"op", "move"}, {"id", node.id}, {"name", freeName(namesIn(nodes, parent, node.id), name)}};
    putParent(op, parent);
    return json::array({op});
}

json moveOps(const std::vector<CloudNode> &all, const std::vector<CloudNode> &moved,
             const std::optional<std::string> &target) {
    auto taken = namesIn(all, target);
    json ops = json::array();
    for (const auto &n : moved) {
        if (parentOf(n) == target) continue;
        const auto name = freeName(taken, n.name);
        taken.push_back(name);
        json op{{"op", "move"}, {"id", n.id}, {"name", name}};
        putParent(op, target);
        ops.push_back(op);
    }
    return ops;
}

json trashOps(const std::vector<CloudNode> &nodes, std::int64_t at) {
    json ops = json::array();
    for (const auto &n : nodes) ops.push_back(json{{"op", "trash"}, {"id", n.id}, {"trashed", true}, {"at", at}});
    return ops;
}

json restoreOps(const std::vector<CloudNode> &all, const std::vector<CloudNode> &nodes) {
    json ops = json::array();
    std::map<std::string, std::vector<std::string>> takenByParent;
    for (const auto &n : nodes) {
        std::optional<std::string> parent;
        if (const auto p = parentOf(n)) {
            const auto it = std::find_if(all.begin(), all.end(), [&](const CloudNode &x) { return x.id == *p; });
            if (it != all.end() && !it->trashed) parent = it->id;
        }
        const auto key = parent.value_or("");
        if (!takenByParent.count(key)) takenByParent[key] = namesIn(all, parent);
        auto &taken = takenByParent[key];
        const auto name = freeName(taken, n.name);
        taken.push_back(name);
        if (name != n.name || parent != parentOf(n)) {
            json op{{"op", "move"}, {"id", n.id}, {"name", name}};
            putParent(op, parent);
            ops.push_back(op);
        }
        ops.push_back(json{{"op", "trash"}, {"id", n.id}, {"trashed", false}, {"at", 0}});
    }
    return ops;
}

json purgeOps(const std::vector<CloudNode> &nodes, std::int64_t at) {
    json ops = json::array();
    for (const auto &n : nodes) ops.push_back(json{{"op", "purge"}, {"id", n.id}, {"at", at}});
    return ops;
}

bool canEditContainer(const std::optional<CloudContainerInfo> &container) {
    if (!container) return true;
    return container->role == "owner" || container->role == "editor";
}

std::vector<std::pair<std::string, CloudNode>> trashAcross(const std::vector<CloudContainerInfo> &containers,
    const std::map<std::string, std::vector<CloudNode>> &trees) {
    std::vector<std::pair<std::string, CloudNode>> out;
    for (const auto &c : containers) {
        if (c.kind == "invite" || (c.role != "owner" && c.role != "editor")) continue;
        const auto it = trees.find(c.id);
        if (it == trees.end()) continue;
        for (const auto &n : trashOf(it->second)) out.emplace_back(c.id, n);
    }
    return out;
}

} // namespace parvane::sections::cloud
