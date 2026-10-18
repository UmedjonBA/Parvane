// Parvane fork: группы v2 в сессии (spec 029) — порт web `v2/controller.ts`: сведения одной записью,
// правка ссылок и вступившие по ним (spec 024), отозванные ссылки, общий список ссылок у ведущих
// приглашения, публичные группы и каналы (spec 023). Методы *Locked — под engineMu_.
#include "parvane/v2_session.h"

#include "parvane/v2_content.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

namespace parvane::v2 {

namespace {

constexpr std::int64_t kEpochRetryMsGroups = 11000;
constexpr int kRoleAdmin = 2;

std::string codeOf(const std::exception &e) {
    if (const auto *v = dynamic_cast<const V2Error *>(&e)) return v->code();
    return e.what();
}

std::int64_t toInt(const json &v) {
    if (v.is_number_integer()) return v.get<std::int64_t>();
    if (v.is_number()) return static_cast<std::int64_t>(v.get<double>());
    if (v.is_string()) return std::atoll(v.get<std::string>().c_str());
    return 0;
}

// base64 → base64url без дополнения (адрес ссылки без секрета)
std::string b64ToB64Url(std::string s) {
    for (auto &c : s) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    while (!s.empty() && s.back() == '=') s.pop_back();
    return s;
}

} // namespace

// Изменение группы записью журнала; смена состава/прав — новая эпоха (как web applyGroupChange).
bool Session::applyGroupChangeLocked(const std::string &hex, const json &change) {
    json reqJson;
    try {
        reqJson = client_->groupChange(hex, change);
    } catch (const std::exception &e) {
        log(std::string("изменение группы отклонено движком: ") + e.what());
        return false;
    }
    try {
        const auto req = parseRequest(reqJson);
        call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
    } catch (const std::exception &e) {
        log(std::string("изменение группы отклонено сервером: ") + e.what());
        resyncGroupLocked(hex);
        return false;
    }
    if (const auto g = client_->groupInfo(hex); g && g->value("epochStale", false) && canRotateLocked(hex)) {
        try {
            rotateEpochLocked(hex);
        } catch (const std::exception &e) {
            log(std::string("новая эпоха после изменения не начата: ") + e.what());
            scheduleRotate(hex, kEpochRetryMsGroups);
        }
    }
    persistLocked();
    publishGroupLocked(hex);
    return true;
}

bool Session::setGroupInfo(const std::string &address, const std::optional<std::string> &name,
                           const std::optional<std::string> &about, const std::optional<std::string> &avatarFileId) {
    if (!ready_ || !isGroupAddress(address)) return false;
    const auto hex = groupHex(address);
    bool ok = false;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return false;
        const auto current = client_->groupInfo(hex);
        if (!current) return false;
        const json next{{"name", name.value_or(current->value("name", std::string()))},
                        {"about", about.value_or(current->value("about", std::string()))},
                        {"avatar_file_id", avatarFileId.value_or(current->value("avatarFileId", std::string()))}};
        const bool same = next["name"] == current->value("name", std::string())
            && next["about"] == current->value("about", std::string())
            && next["avatar_file_id"] == current->value("avatarFileId", std::string());
        // Ничего не меняется — записи в журнале не будет
        ok = same || applyGroupChangeLocked(hex, json{{"set_info", next}});
    }
    flushAsync();
    return ok;
}

bool Session::editInvite(const std::string &address, const std::string &url, const std::string &title,
                         std::int64_t expiresAt, std::uint32_t usageLimit) {
    std::string linkId;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        const auto all = loadInvites();
        if (all.contains(address) && all[address].is_array()) {
            for (const auto &r : all[address]) {
                if (r.value("url", std::string()) == url) linkId = r.value("linkId", std::string());
            }
        }
    }
    if (linkId.empty()) return false;
    return changeGroup(address, json{{"invite_edit", {{"link_id", hexToB64(linkId)},
                                                      {"title", title},
                                                      {"expires_ms", std::to_string(expiresAt * 1000)},
                                                      {"usage_limit", usageLimit}}}});
}

json Session::listInviteJoins(const std::string &address, const std::string &linkId) {
    json out = json::array();
    if (!isGroupAddress(address)) return out;
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return out;
    const auto g = client_->groupInfo(groupHex(address));
    if (!g || !g->contains("invites") || !(*g)["invites"].is_array()) return out;
    for (const auto &meta : (*g)["invites"]) {
        if (meta.value("id", std::string()) != linkId || !meta.contains("joins") || !meta["joins"].is_array()) continue;
        for (auto it = meta["joins"].rbegin(); it != meta["joins"].rend(); ++it) {
            out.push_back(json{{"user", it->value("user", std::string())}, {"date", toInt(it->value("tsMs", json(0))) / 1000}});
        }
    }
    return out;
}

json Session::listRevokedInvites(const std::string &address) {
    json out = json::array();
    if (!ready_ || !isGroupAddress(address)) return out;
    const auto hex = groupHex(address);
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return out;
    try {
        const auto gdomain = groupDomainLocked(hex);
        const auto resp = call(false, "group.invite.list",
            encodeMethodRequest("group.invite.list", json{{"group", {{"domain", gdomain}, {"id", hexToB64(hex)}}}}), gdomain);
        const auto list = decodeMethodResponse("group.invite.list", resp);
        const auto known = loadInvites();
        const auto mine = known.contains(address) && known[address].is_array() ? known[address] : json::array();
        for (const auto &item : list.value("invites", json::array())) {
            if (!item.value("revoked", false) || item.value("link_id", std::string()).empty()) continue;
            const auto lid = b64ToHex(item.value("link_id", std::string()));
            json local;
            for (const auto &r : mine) {
                if (r.value("linkId", std::string()) == lid) local = r;
            }
            json rec{{"url", local.is_object() ? local.value("url", std::string())
                                               : "https://" + domain_ + "/join/" + b64ToB64Url(item.value("link_id", std::string()))},
                     {"linkId", lid},
                     {"date", local.is_object() ? local.value("date", 0LL) : 0LL}};
            const auto title = item.value("title", local.is_object() ? local.value("title", std::string()) : std::string());
            if (!title.empty()) rec["title"] = title;
            if (const auto ms = toInt(item.value("expires_ms", json(0))); ms > 0) rec["expiresAt"] = ms / 1000;
            if (const auto lim = item.value("usage_limit", 0); lim > 0) rec["usageLimit"] = lim;
            if (const auto used = item.value("usage_count", 0); used > 0) rec["usage"] = used;
            if (item.value("requires_approval", false)) rec["isRequestNeeded"] = true;
            out.push_back(rec);
        }
    } catch (const std::exception &e) {
        log("список отозванных ссылок группы " + hex + " не получен: " + e.what());
    }
    return out;
}

bool Session::deleteRevokedInvite(const std::string &address, const std::string &linkId) {
    if (!ready_ || !isGroupAddress(address)) return false;
    const auto hex = groupHex(address);
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    try {
        const auto gdomain = groupDomainLocked(hex);
        call(false, "group.invite.delete",
             encodeMethodRequest("group.invite.delete",
                                 json{{"group", {{"domain", gdomain}, {"id", hexToB64(hex)}}}, {"link_id", hexToB64(linkId)}}),
             gdomain);
    } catch (const std::exception &e) {
        log(std::string("отозванная ссылка не удалена: ") + e.what());
        return false;
    }
    auto all = loadInvites();
    if (all.contains(address) && all[address].is_array()) {
        json kept = json::array();
        for (const auto &r : all[address]) {
            if (r.value("linkId", std::string()) != linkId) kept.push_back(r);
        }
        all[address] = kept;
        writeStateFile("invites", all.dump());
    }
    return true;
}

// Общий список ссылок у ведущих приглашения (владелец и админы с правом приглашать): секреты своих
// ссылок — тем, кому ещё не передавали (как web shareInvites). Передаёт движок служебной раздачей.
void Session::shareInvitesLocked(const std::string &hex) {
    if (!client_ || !ready_) return;
    const auto g = client_->groupInfo(hex);
    if (!g || g->value("deleted", false) || !g->contains("members")) return;
    const auto owner = g->value("owner", std::string());
    const auto canInvite = [&](const json &m) {
        return m.value("user", std::string()) == owner
            || (m.value("role", 0) == kRoleAdmin && m.contains("rights") && m["rights"].is_object()
                && m["rights"].value("invite_users", false));
    };
    bool mine = false;
    for (const auto &m : (*g)["members"]) {
        if (m.value("user", std::string()) == cfg_.self) mine = canInvite(m);
    }
    if (!mine) return;
    const auto address = groupAddress(hex);
    std::set<std::string> active;
    for (const auto &meta : g->value("invites", json::array())) active.insert(meta.value("id", std::string()));
    const auto all = loadInvites();
    json own = json::array();
    if (all.contains(address) && all[address].is_array()) {
        for (const auto &r : all[address]) {
            if (active.count(r.value("linkId", std::string()))) own.push_back(r);
        }
    }
    if (own.empty()) return;
    auto shared = json::parse(readStateFile("invites-shared"), nullptr, false);
    if (!shared.is_object()) shared = json::object();
    auto given = shared.contains(address) && shared[address].is_object() ? shared[address] : json::object();
    bool changed = false;
    for (const auto &m : (*g)["members"]) {
        const auto manager = m.value("user", std::string());
        if (manager == cfg_.self || !canInvite(m)) continue;
        const auto had = given.contains(manager) && given[manager].is_array() ? given[manager] : json::array();
        json missingUrls = json::array(), missingIds = json::array();
        for (const auto &r : own) {
            if (std::find(had.begin(), had.end(), json(r.value("linkId", std::string()))) == had.end()) {
                missingUrls.push_back(r.value("url", std::string()));
                missingIds.push_back(r.value("linkId", std::string()));
            }
        }
        if (missingUrls.empty()) continue;
        try {
            const auto requests = withNeedsJsonLocked([&] {
                return client_->call("shareInviteLinks", json{{"group", hex}, {"linksJson", missingUrls},
                                                              {"recipientsJson", json::array({manager})}});
            });
            if (!requests.is_array() || requests.empty()) continue;
            runRequestsLocked(requests);
            auto next = had;
            for (const auto &id : missingIds) next.push_back(id);
            given[manager] = next;
            changed = true;
        } catch (const std::exception &e) {
            // Не ушло (нет ключа доступа, сеть) — повторится при следующем изменении группы
            log("секрет ссылки-приглашения не передан " + manager + ": " + e.what());
        }
    }
    if (!changed) return;
    shared[address] = given;
    writeStateFile("invites-shared", shared.dump());
    persistLocked();
    log("ссылки-приглашения переданы ведущим приглашения группы " + hex);
}

void Session::absorbSharedInvitesLocked() {
    if (!client_) return;
    json taken;
    try {
        taken = client_->call("takeSharedInvites");
    } catch (const std::exception &) {
        return;
    }
    if (!taken.is_array() || taken.empty()) return;
    auto all = loadInvites();
    std::set<std::string> touched;
    int added = 0;
    for (const auto &item : taken) {
        const auto url = item.value("url", std::string());
        const auto parsed = parseInvite(url);
        if (!parsed || parsed->value("kind", std::string()) != "v2") continue;
        const auto address = groupAddress(item.value("group", std::string()));
        const auto linkId = parsed->value("linkId", std::string());
        if (!all.contains(address) || !all[address].is_array()) all[address] = json::array();
        bool known = false;
        for (const auto &r : all[address]) known = known || r.value("linkId", std::string()) == linkId;
        if (known) continue;
        all[address].push_back(json{{"url", url}, {"linkId", linkId}, {"date", 0}});
        touched.insert(address);
        ++added;
    }
    if (!added) return;
    writeStateFile("invites", all.dump());
    log("ссылки-приглашения от других ведущих приглашения: " + std::to_string(added));
    for (const auto &address : touched) publishGroupLocked(groupHex(address));
}

// ── публичные группы (spec 023) ────────────────────────────────────────────

json Session::publicCallLocked(const std::string &method, const json &request) {
    if (!ready_ || !client_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    return decodeMethodResponse(method, call(false, method, encodeMethodRequest(method, request)));
}

json Session::checkPublicName(const std::string &name) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return publicCallLocked("group.public.check_name", json{{"name", name}});
}

json Session::searchPublic(const std::string &query) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    return publicCallLocked("group.public.search", json{{"query", query}, {"limit", 20}}).value("groups", json::array());
}

json Session::resolvePublic(const std::string &name) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    try {
        const auto r = publicCallLocked("group.public.resolve", json{{"name", name}});
        const auto card = r.value("card", json::object());
        const auto id = card.contains("group") && card["group"].is_object() ? card["group"].value("id", std::string()) : std::string();
        if (id.empty() || r.value("secret", std::string()).empty()) return nullptr;
        return json{{"card", card}, {"hex", b64ToHex(id)}, {"secretHex", b64ToHex(r.value("secret", std::string()))}};
    } catch (const V2Error &e) {
        if (e.code() == "ERROR_CODE_NOT_FOUND") return nullptr;
        throw;
    }
}

std::string Session::setGroupPublic(const std::string &address, bool isPublic, const std::string &name, bool preview,
                                    bool history) {
    if (!ready_ || !isGroupAddress(address)) return "failed";
    const auto hex = groupHex(address);
    std::string result = "ok";
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return "failed";
        json reqJson;
        try {
            reqJson = client_->call("groupSetPublic", json{{"group", hex}, {"public", isPublic}, {"name", name},
                                                           {"preview", preview}, {"history", history}});
        } catch (const std::exception &e) {
            log(std::string("публичность группы отклонена движком: ") + e.what());
            return "invalid";
        }
        try {
            const auto req = parseRequest(reqJson);
            call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
        } catch (const std::exception &e) {
            log(std::string("публичность группы отклонена сервером: ") + e.what());
            resyncGroupLocked(hex);
            const auto code = codeOf(e);
            if (code == "ERROR_CODE_DUPLICATE") return "taken";
            return code == "ERROR_CODE_INVALID" ? "invalid" : "failed";
        }
        // Новый секрет устаревает эпоху — ключи новой эпохи ложатся комплектом в журнал
        if (const auto g = client_->groupInfo(hex); g && g->value("epochStale", false) && canRotateLocked(hex)) {
            try {
                rotateEpochLocked(hex);
            } catch (const std::exception &e) {
                log(std::string("новая эпоха публичной группы не начата: ") + e.what());
                scheduleRotate(hex, kEpochRetryMsGroups);
            }
        }
        persistLocked();
        publishGroupLocked(hex);
    }
    flushAsync();
    return result;
}

json Session::loadPublicGroup(const std::string &hex) {
    std::lock_guard<std::recursive_mutex> lk(engineMu_);
    if (!client_) return nullptr;
    syncGroupLocked(hex);
    const auto g = client_->groupInfo(hex);
    return g ? *g : json(nullptr);
}

json Session::joinPublic(const std::string &hex, const std::string &secretHex) {
    json info;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!ready_ || !client_) return nullptr;
        syncGroupLocked(hex);
        const auto req = parseRequest(client_->call("groupJoinPublic", json{{"group", hex}, {"secretHex", secretHex}}));
        try {
            call(req.anon, req.method, req.body, req.dest.empty() ? groupDestLocked(hex) : req.dest);
        } catch (...) {
            resyncGroupLocked(hex);
            throw;
        }
        persistLocked();
        log("вступление в публичную группу " + hex);
        syncGroupLocked(hex);
        const auto g = client_->groupInfo(hex);
        info = g ? *g : json(nullptr);
    }
    flushAsync();
    return info;
}

json Session::publicHistory(const std::string &address, std::uint64_t beforeSeq) {
    if (!ready_ || !isGroupAddress(address)) return nullptr;
    const auto hex = groupHex(address);
    json out;
    {
        std::lock_guard<std::recursive_mutex> lk(engineMu_);
        if (!client_) return nullptr;
        const auto gdomain = groupDomainLocked(hex);
        const auto method = std::string("group.public.history");
        const auto resp = call(false, method,
            encodeMethodRequest(method, json{{"group", {{"domain", gdomain}, {"id", hexToB64(hex)}}},
                                             {"before_seq", std::to_string(beforeSeq)}, {"limit", 50}}), gdomain);
        const bool more = decodeMethodResponse(method, resp).value("more", false);
        const auto items = client_->call("publicHistoryItems", json{{"response", toBase64(resp)}});
        int opened = 0;
        std::uint64_t oldest = 0;
        std::vector<json> events;
        // Старые раньше: место сообщения задаёт время, но так меньше перестановок
        for (auto it = items.rbegin(); it != items.rend(); ++it) {
            const auto seq = static_cast<std::uint64_t>(toInt(it->value("seq", json(0))));
            oldest = oldest == 0 ? seq : std::min(oldest, seq);
            try {
                const auto evs = withNeedsJsonLocked([&] {
                    return client_->call("groupOpenEnvelope", json{{"envelope", it->value("envelope", std::string())}});
                });
                for (const auto &ev : evs) {
                    events.push_back(ev);
                    ++opened;
                }
            } catch (const std::exception &e) {
                log(std::string("сообщение истории публичной группы не открыто: ") + e.what());
            }
        }
        absorbLocked(std::move(events));
        out = json{{"opened", opened}, {"more", more}, {"oldest", oldest}};
    }
    flushAsync();
    return out;
}

} // namespace parvane::v2
