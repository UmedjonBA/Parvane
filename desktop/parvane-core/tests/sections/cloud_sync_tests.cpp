// Parvane fork (spec 029, T033/T034): «Облако» на сервере — жизненный цикл контейнеров (web cloud.ts), провайдер
// раздела (cloudDrive.ts: запись/чтение текстов, состояние, место) и построители операций (cloudStore.ts) на
// поддельном транспорте. Своих тестов у этих модулей web нет (cloudDrive.test.ts проверяет кэши миниатюр,
// просмотра и серии соединений — здесь не перенесено), случаи — по коду web.
#include <cstdio>
#include <string>

#include "fake_domain.h"
#include "parvane/sections/cloud_sync.h"

using nlohmann::json;
using namespace parvane::sections::cloud;
namespace d = parvane::sections::domain;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static const std::int64_t kDay = 24LL * 60 * 60 * 1000;

// Поддельный движок облака: контейнеры по id
struct Box {
    bool attached = false;
    bool attachFails = false; // движок отвергает подключение (автор генезиса не опознан)
    bool key = true;
    std::int64_t seq = 0, grantVersion = 0, epoch = 1;
    std::string owner = "alice@local", role = "owner", name, domainName;
    std::vector<ContainerMember> members;
    json nodes = json::array();
    json purged = json::array();
    std::vector<json> preparedOps;
    std::vector<json> syncReplies;
    std::vector<json> grantChanges; // по одному на cloudIngestGrants: {grantVersion?, members?}
    std::int64_t snapshotSeq = 0;
};

struct Engine {
    std::map<std::string, Box> boxes;
    int created = 0;
    int prepared = 0;
    std::vector<std::string> forgotten;
    std::vector<std::pair<std::string, std::string>> applied;

    void install(fake::Transport &t) {
        auto box = [this](const json &a) -> Box & { return boxes[a["id"].get<std::string>()]; };
        t.engineFns["cloudContainers"] = [this](const json &) {
            json list = json::array();
            for (auto &[id, b] : boxes) {
                if (!b.attached) continue;
                json members = json::array();
                for (const auto &m : b.members) members.push_back(json{{"user", m.user}, {"role", m.role}});
                json c{{"id", id}, {"owner", b.owner}, {"name", b.name}, {"hasKey", b.key}, {"headSeq", b.seq},
                       {"epoch", b.epoch}, {"grantVersion", b.grantVersion}, {"members", members}};
                if (!b.role.empty()) c["role"] = b.role;
                list.push_back(c);
            }
            return list;
        };
        t.engineFns["cloudDomain"] = [this](const json &a) {
            const auto it = boxes.find(a["id"].get<std::string>());
            return json(it == boxes.end() ? std::string() : it->second.domainName);
        };
        t.engineFns["cloudIsAttached"] = [this](const json &a) {
            const auto it = boxes.find(a["id"].get<std::string>());
            return json(it != boxes.end() && it->second.attached);
        };
        t.engineFns["cloudHasKey"] = [box](const json &a) { return json(box(a).key); };
        t.engineFns["cloudHeadSeq"] = [box](const json &a) { return json(box(a).seq); };
        t.engineFns["cloudGrantVersion"] = [box](const json &a) { return json(box(a).grantVersion); };
        t.engineFns["cloudStateJson"] = [this](const json &a) {
            const auto it = boxes.find(a["id"].get<std::string>());
            if (it == boxes.end() || !it->second.attached) return json(nullptr);
            return json{{"name", it->second.name}, {"count", it->second.nodes.size()}, {"nodes", it->second.nodes},
                        {"purgedBlobs", it->second.purged}};
        };
        t.engineFns["cloudCreate"] = [this](const json &) {
            ++created;
            char id[33];
            std::snprintf(id, sizeof id, "c%031d", created);
            auto &b = boxes[id];
            b.attached = true;
            return json{{"id", id}, {"request", fake::req("domain.container.create", id)}};
        };
        t.engineFns["cloudAttach"] = [this](const json &a) {
            // Поддельный кодек: тело ответа container.get — JSON с id
            const auto got = json::parse(d::fromBase64(a["getResponse"].get<std::string>()));
            const auto id = got.value("id", std::string());
            if (boxes[id].attachFails) throw std::runtime_error("Proto(Forbidden)");
            boxes[id].attached = true;
            return json(id);
        };
        t.engineFns["cloudForget"] = [this](const json &a) {
            const auto id = a["id"].get<std::string>();
            forgotten.push_back(id);
            boxes[id].attached = false;
            return json(nullptr);
        };
        t.engineFns["cloudIngestGrants"] = [box](const json &a) {
            auto &b = box(a);
            if (!b.grantChanges.empty()) {
                const auto ch = b.grantChanges.front();
                b.grantChanges.erase(b.grantChanges.begin());
                if (ch.contains("grantVersion")) b.grantVersion = ch["grantVersion"].get<std::int64_t>();
                if (ch.contains("members")) {
                    b.members.clear();
                    for (const auto &m : ch["members"]) b.members.push_back({m.get<std::string>(), "editor"});
                }
                if (ch.contains("key")) b.key = ch["key"].get<bool>();
            }
            return json(0);
        };
        t.engineFns["cloudIngestSnapshot"] = [box](const json &a) {
            auto &b = box(a);
            b.seq = b.snapshotSeq;
            return json(b.snapshotSeq);
        };
        t.engineFns["cloudIngestSync"] = [box](const json &a) {
            auto &b = box(a);
            if (b.syncReplies.empty()) return json{{"applied", 0}, {"more", false}, {"grantsBehind", false}, {"authorsBehind", false}};
            auto r = b.syncReplies.front();
            b.syncReplies.erase(b.syncReplies.begin());
            r["strictSeen"] = a["strict"];
            b.seq += r.value("applied", 0);
            return r;
        };
        t.engineFns["cloudPrepareLocal"] = [this, box](const json &a) {
            auto &b = box(a);
            b.preparedOps.push_back(a["opsJson"]["ops"]);
            ++prepared;
            char hex[33];
            std::snprintf(hex, sizeof hex, "%032x", prepared);
            return json{{"opId", hex}, {"op", d::toBase64("op" + std::to_string(prepared))}, {"applied", 1}};
        };
        t.engineFns["cloudApplyLocal"] = [this](const json &a) {
            applied.emplace_back(a["id"].get<std::string>(), a["op"].get<std::string>());
            return json(1);
        };
        t.engineFns["cloudSeal"] = [](const json &a) {
            return fake::req("domain.op.append", "seal:" + a["opIdHex"].get<std::string>());
        };
        t.engineFns["cloudSnapshotRequest"] = [](const json &) { return json(nullptr); };
        t.engineFns["cloudShareWithOwnDevices"] = [](const json &) { return json::array({fake::req("msg.deliver", "own")}); };
        t.engineFns["cloudGrant"] = [](const json &a) {
            return json::array({fake::req("domain.grant.set", a.dump())});
        };
        t.engineFns["cloudRevoke"] = [](const json &a) {
            return json::array({fake::req("domain.grant.revoke", a["user"].get<std::string>())});
        };
        t.engineFns["cloudRotate"] = [](const json &) { return json::array({fake::req("domain.key.rotate", "rot")}); };
        t.engineFns["cloudLeave"] = [](const json &) { return fake::req("domain.grant.leave", "leave"); };
        t.engineFns["cloudKeysExport"] = [](const json &) { return json::array(); };
    }
};

struct Rig {
    fake::Transport t;
    Engine e;
    d::MemoryRecords records;
    std::vector<CloudStateEntry> entries;
    std::vector<CloudStateEntry> recorded;
    std::vector<std::string> deleted;
    std::vector<std::string> refreshed;
    std::map<std::string, std::string> deleteErrors;
    // Список на сервере по домену: [{id(hex), owner}]
    std::map<std::string, std::vector<std::pair<std::string, std::string>>> listed;
    std::set<std::string> listFails;
    int changed = 0;
    CloudSync sync;

    Rig()
    : sync(t, records, CloudHooks{
          [this] { return entries; },
          [this](const CloudStateEntry &e) {
              recorded.push_back(e);
              auto it = std::find_if(entries.begin(), entries.end(), [&](const CloudStateEntry &x) { return x.id == e.id; });
              if (it == entries.end()) entries.push_back(e);
              else *it = e;
          },
          [this](const std::string &f) {
              if (deleteErrors.count(f)) throw d::BusError(deleteErrors[f]);
              deleted.push_back(f);
          },
          [this](const std::string &u) { refreshed.push_back(u); },
          [this] { ++changed; }}) {
        e.install(t);
        t.busFns["domain.container.list"] = [this](const fake::Sent &s) -> std::string {
            const auto dname = s.dest.empty() ? t.domainName : s.dest;
            if (listFails.count(dname)) throw d::BusError("ERROR_CODE_UNAVAILABLE");
            json list = json::array();
            for (const auto &[id, owner] : listed[dname]) {
                list.push_back(json{{"ref", {{"domain", dname}, {"id", d::hexToB64(id)}}}, {"owner", {{"address", owner}}}});
            }
            return json{{"containers", list}}.dump();
        };
        t.busFns["domain.container.get"] = [](const fake::Sent &s) {
            const auto body = json::parse(s.body);
            return json{{"id", d::b64ToHex(body["container"]["id"].get<std::string>())}}.dump();
        };
    }
    void advance(std::int64_t ms) {
        t.now += ms;
        sync.tick();
    }
    // Контейнер на сервере (ещё не подключён)
    Box &server(const std::string &id, const std::string &owner, const std::string &dname = "local") {
        listed[dname].push_back({id, owner});
        auto &b = e.boxes[id];
        b.owner = owner;
        b.role = owner == t.me ? "owner" : "editor";
        b.domainName = dname == "local" ? "" : dname;
        return b;
    }
};

static std::vector<CloudNode> nodes(const json &list) {
    std::vector<CloudNode> out;
    for (const auto &n : list) out.push_back(n.get<CloudNode>());
    return out;
}

static void entryTests() {
    std::printf("-- журнал личного состояния: записи облака\n");
    const auto snap = json::parse(R"({"cloud_containers":[
      {"ref":{"domain":"local","id":")" + d::hexToB64("aa01") + R"("},"role":"CLOUD_CONTAINER_ROLE_ROOT"},
      {"ref":{"domain":"other.org","id":")" + d::hexToB64("bb02") + R"("},"role":3,"status":"CLOUD_SHARE_STATUS_ACCEPTED","owner":"bob@other.org"},
      {"ref":{"domain":"local","id":")" + d::hexToB64("cc03") + R"("},"role":"CLOUD_CONTAINER_ROLE_OWNED","removed":true},
      {"ref":{"domain":"local"},"role":"CLOUD_CONTAINER_ROLE_OWNED"},
      {"ref":{"domain":"local","id":")" + d::hexToB64("dd04") + R"("},"role":"?"}
    ]})");
    const auto entries = parseCloudEntries(snap);
    check(entries.size() == 3, "записи без id и с незнакомой ролью пропускаются");
    check(entries[0] == CloudStateEntry{"aa01", "local", "root", "", false, ""}
              && entries[1] == CloudStateEntry{"bb02", "other.org", "shared", "accepted", false, "bob@other.org"}
              && entries[2].isRemoved && entries[2].role == "owned",
          "роль и статус — именем либо числом; id — hex");
    const auto state = cloudEntryToState(entries[1]);
    check(state == json::parse(R"({"ref":{"domain":"other.org","id":")" + d::hexToB64("bb02")
                               + R"("},"role":"CLOUD_CONTAINER_ROLE_SHARED","status":"CLOUD_SHARE_STATUS_ACCEPTED","removed":false,"owner":"bob@other.org"})"),
          "запись → аргумент cloudContainerSet (как recordCloudEntry web)");
    check(!cloudEntryToState(entries[0]).contains("status"), "без статуса поле не пишется");
    check(parseCloudEntries(json{{"cloud_containers", json::array({cloudEntryToState(entries[1])})}})[0] == entries[1],
          "туда и обратно без потерь");
}

static void lifecycleTests() {
    std::printf("-- облако: контейнеры (cloud.ts)\n");
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.server("aa01", r.t.me);
        r.server("bb02", "bob@local").name = "Проект";
        r.server("ee05", r.t.me); // свой без записи состояния — ждём запись
        r.sync.ensure(true);
        check(r.e.boxes["aa01"].attached && r.e.boxes["bb02"].attached && !r.e.boxes["ee05"].attached,
              "список сервера: подключены диск и чужая папка; свой без записи журнала ждёт");
        auto list = r.sync.containers();
        check(list.size() == 2 && list[0].kind == "root" && list[1].kind == "invite" && list[1].name == "Проект",
              "виды контейнеров: личный диск и приглашение");
        r.entries.push_back({"bb02", "local", "shared", "accepted", false, "bob@local"});
        list = r.sync.containers();
        check(list[1].kind == "shared", "принятое приглашение — совместная папка");
        check(r.sync.status() == "ready" && r.sync.rootId() == std::string("aa01"), "статус ready, корень из журнала");
        check(r.sync.nextWakeMs() == r.t.now + kSyncActiveMs, "открытый раздел — опрос раз в 8 с");
        // Доступ отозван: чужая папка пропала из списка
        r.listed["local"].erase(r.listed["local"].begin() + 1);
        r.sync.syncNow();
        check(std::count(r.e.forgotten.begin(), r.e.forgotten.end(), "bb02") == 1, "пропавшая из списка чужая папка забыта");
        check(!r.recorded.empty() && r.recorded.back().id == "bb02" && r.recorded.back().isRemoved,
              "запись состояния совместной папки снята");
        check(r.sync.containers().size() == 1, "забытая папка экрану не показывается");
    }
    {
        // Своя общая папка удалена на другом устройстве: запись журнала снята, контейнер на сервере остался
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.entries.push_back({"ff06", "local", "owned", "", false, ""});
        r.server("aa01", r.t.me);
        r.server("ff06", r.t.me).name = "Общая";
        r.sync.ensure(true);
        auto list = r.sync.containers();
        check(list.size() == 2 && list[1].kind == "owned", "своя общая папка показывается");
        r.entries[1].isRemoved = true;
        check(r.sync.containers().size() == 1, "снятая запись журнала — папка не показывается сразу");
        r.sync.syncNow();
        check(std::count(r.e.forgotten.begin(), r.e.forgotten.end(), "ff06") == 1, "удалённая на другом устройстве папка забыта");
        r.sync.syncNow();
        check(!r.e.boxes["ff06"].attached || std::count(r.e.forgotten.begin(), r.e.forgotten.end(), "ff06") == 1,
              "и не подключается заново");
    }
    {
        Rig r;
        r.sync.ensure(false);
        check(r.e.created == 0 && !r.sync.rootId(), "без правок личный диск не создаётся");
        const auto id = r.sync.apply("root", json::array({json{{"op", "create"}, {"id", "n1"}, {"kind", "folder"}, {"name", "Документы"}}}));
        check(r.e.created == 1 && r.recorded.size() == 1 && r.recorded[0].role == "root" && r.recorded[0].id == id,
              "первая правка создаёт личный диск и записывает его в журнал состояния");
        check(r.t.countSent("msg.deliver") == 1, "ключ нового контейнера передан своим устройствам");
        check(r.e.boxes[id].preparedOps.size() == 1 && r.sync.hasPending(id), "правка применена локально и ждёт отправки");
        check(r.records.load(std::string(kCloudOutboxRecord) + id).has_value(), "очередь — в записи устройства");
        check(r.sync.nextWakeMs() == r.t.now, "отправка очереди — сразу после правки");
        r.sync.tick();
        check(!r.sync.hasPending(id) && r.t.countSent("domain.op.append") == 1, "очередь отправлена");
    }
    {
        // Прод, 24 окт 2026: личный диск не подключался, и исключение обрывало обход — остальное облако не синхронизировалось
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.entries.push_back({"bb02", "local", "owned", "", false, ""});
        r.server("aa01", r.t.me).attachFails = true;
        r.server("bb02", r.t.me);
        r.sync.ensure(true);
        check(!r.e.boxes["aa01"].attached && r.e.boxes["bb02"].attached, "не подключившийся контейнер не останавливает обход");
    }
    {
        // Свой контейнер на сервере без записи журнала — может оказаться диском: второй диск не заводится
        Rig r;
        r.server("ee05", r.t.me);
        bool threw = false;
        try {
            r.sync.apply("root", json::array({json{{"op", "create"}, {"id", "n1"}, {"kind", "folder"}, {"name", "x"}}}));
        } catch (const d::BusError &e) {
            threw = e.code() == "ERROR_CODE_UNAVAILABLE";
        }
        check(threw && r.e.created == 0 && r.recorded.empty(), "при своём контейнере без записи личный диск не создаётся");
        bool left = false;
        try {
            r.entries.push_back({"ee05", "local", "owned", "", false, ""});
            r.sync.ensure(true);
            r.sync.leave("ee05");
        } catch (const d::BusError &e) {
            left = e.code() == "ERROR_CODE_INVALID";
        }
        check(left && r.recorded.empty(), "свою папку «покинуть» нельзя");
    }
    {
        Rig r;
        r.t.ready = false;
        r.t.linking = true;
        bool threw = false;
        try {
            r.sync.apply("root", json::array());
        } catch (const d::BusError &e) {
            threw = e.code() == "ERROR_CODE_UNAVAILABLE";
        }
        check(threw && r.e.created == 0, "непривязанное устройство диск не создаёт");
        r.sync.ensure(true);
        check(r.sync.status() == "needs-linking" && r.t.sent.empty(), "needs-linking, в сеть не ходит");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.server("aa01", r.t.me);
        r.sync.ensure(true);
        r.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_FORBIDDEN"); };
        r.sync.apply("aa01", json::array({json{{"op", "meta"}, {"name", "x"}}}));
        check(!r.sync.flush("aa01") && !r.sync.hasPending("aa01"), "правка без права записи отвергнута и снята с очереди");
        r.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_DUPLICATE"); };
        r.sync.apply("aa01", json::array({json{{"op", "meta"}, {"name", "y"}}}));
        check(r.sync.flush("aa01"), "DUPLICATE — принято до обрыва");
        r.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_EXPIRED"); };
        r.sync.apply("aa01", json::array({json{{"op", "meta"}, {"name", "z"}}}));
        check(!r.sync.flush("aa01") && r.sync.hasPending("aa01"), "EXPIRED без новой версии грантов — очередь ждёт");
        r.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_UNAVAILABLE"); };
        r.sync.setVisible(false);
        r.sync.syncNow();
        check(r.sync.status() == "offline" && r.sync.lastError() == std::string("v2: ERROR_CODE_UNAVAILABLE"),
              "шард недоступен — офлайн");
        r.t.busFns.erase("domain.op.append");
        r.t.now += kRetryOfflineMs;
        r.sync.tick();
        check(r.sync.status() == "ready" && !r.sync.hasPending("aa01"), "повтор через 15 с досылает очередь");
    }
    {
        // Очередь переживает перезапуск
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.server("aa01", r.t.me);
        r.records.save(std::string(kCloudOutboxRecord) + "aa01", json::array({json{{"opId", "01"}, {"op", d::toBase64("old")}}}));
        r.sync.ensure(true);
        check(r.e.applied.size() == 1 && r.e.applied[0].second == d::toBase64("old"),
              "операции очереди применяются заново после перезапуска");
        check(r.t.countSent("domain.op.append") == 1 && !r.sync.hasPending("aa01"), "и уходят при синхронизации");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        auto &b = r.server("aa01", r.t.me);
        b.members = {{"bob@local", "editor"}};
        b.snapshotSeq = 5;
        b.syncReplies = {
            json{{"applied", 0}, {"more", true}, {"authorsBehind", true}},
            json{{"applied", 2}, {"more", true}, {"grantsBehind", true}},
            json{{"applied", 1}, {"more", false}},
        };
        r.sync.ensure(true);
        auto &box = r.e.boxes["aa01"];
        check(r.t.countSent("domain.snapshot.get") == 1, "пустой журнал при ключе — снимок");
        check(r.refreshed == std::vector<std::string>{"bob@local"}, "неизвестный автор — журналы устройств участников");
        check(r.t.lastEngine("cloudIngestSync")["strict"] == true && box.seq == 8, "после повтора — снова строго; журнал догнан");
        bool lax = false;
        for (const auto &c : r.t.engineCalls) lax = lax || (c.first == "cloudIngestSync" && c.second["strict"] == false);
        check(lax, "повтор после обновления журналов — нестрого (неопознанное пропускается)");
        const auto syncBody = r.t.lastBody("domain.op.sync");
        check(syncBody["after_seq"] == "7" && syncBody["container"]["id"] == d::hexToB64("aa01"), "after_seq строкой");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.entries.push_back({"ff06", "local", "owned", "", false, ""});
        r.server("aa01", r.t.me);
        auto &f = r.server("ff06", r.t.me);
        f.members = {{"bob@local", "editor"}, {"carol@local", "reader"}};
        r.sync.ensure(true);
        r.e.boxes["ff06"].grantChanges = {json{{"grantVersion", 3}, {"members", json::array({"bob@local"})}}};
        r.sync.syncNow();
        check(r.t.countSent("domain.key.rotate") == 1, "участник ушёл сам — владелец меняет эпоху");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        auto &b = r.server("aa01", r.t.me);
        const auto now = r.t.now;
        b.nodes = json::array({
            json{{"id", "old"}, {"kind", "file"}, {"name", "a.txt"}, {"trashed", true}, {"trashTop", true}, {"trashedAt", now - 31 * kDay}},
            json{{"id", "new"}, {"kind", "file"}, {"name", "b.txt"}, {"trashed", true}, {"trashTop", true}, {"trashedAt", now - kDay}},
        });
        b.purged = json::array({json{{"fileId", "f1"}, {"uploader", r.t.me}}, json{{"fileId", "f2"}, {"uploader", "bob@local"}},
                                json{{"fileId", "f3"}, {"uploader", r.t.me}}, json{{"fileId", "f4"}, {"uploader", r.t.me}}});
        r.deleteErrors["f3"] = "ERROR_CODE_NOT_FOUND";
        r.deleteErrors["f4"] = "ERROR_CODE_UNAVAILABLE";
        r.sync.ensure(true);
        const auto &ops = r.e.boxes["aa01"].preparedOps;
        check(ops.size() == 1 && ops[0] == json::array({json{{"op", "purge"}, {"id", "old"}, {"at", now}}}),
              "корзина: пролежавшее дольше 30 дней стирается устройством владельца");
        check(r.deleted == std::vector<std::string>{"f1"}, "сборка блобов: только свои, чужие не трогаются");
        const auto gc = r.records.load(kCloudGcRecord);
        check(gc && *gc == json::array({"f1", "f3"}), "стёртое и уже отсутствующее (NOT_FOUND) — в записи; сбой — повтор позже");
        r.sync.syncNow();
        check(r.e.boxes["aa01"].preparedOps.size() == 1 && r.deleted.size() == 1,
              "срок корзины — раз в час; без изменений дерева сборка не повторяется");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.server("aa01", r.t.me);
        r.server("ab07", "bob@other.org", "other.org");
        r.sync.noteRemoteDomain("Other.ORG");
        r.sync.noteRemoteDomain("local");
        check(r.records.load(kCloudRemoteDomainsRecord) == json::array({"other.org"}), "сервер чужой папки запоминается строчными");
        r.sync.ensure(true);
        check(r.e.boxes["ab07"].attached, "папка другого сервера найдена в его списке");
        bool toRemote = false;
        for (const auto &s : r.t.sent) toRemote = toRemote || (s.method == "domain.container.get" && s.dest == "other.org");
        check(toRemote, "запросы к папке — серверу владельца (dest)");
        r.listFails.insert("other.org");
        r.sync.syncNow();
        check(r.e.boxes["ab07"].attached && r.sync.status() == "ready",
              "недоступный чужой сервер — его папки не считаются отозванными");
        r.listFails.insert("local");
        r.sync.syncNow();
        check(r.sync.status() == "offline", "свой сервер обязан ответить");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.t.busFns["domain.container.get"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_NOT_FOUND"); };
        r.sync.ensure(true);
        check(r.e.forgotten.size() == 1 && r.changed > 0, "контейнер не найден сервером — забыт");
    }
    {
        Rig r;
        check(r.sync.checkDrive() == "unknown", "сверка до синхронизации — unknown");
        r.sync.ensure(false);
        check(r.sync.checkDrive() == "none", "у аккаунта на сервере ни одного своего контейнера — none");
        r.listed["local"].push_back({"aa01", r.t.me});
        check(r.sync.checkDrive() == "unknown", "свой контейнер на сервере без записи журнала — unknown");
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.e.boxes["aa01"].owner = r.t.me;
        r.sync.syncNow();
        check(r.sync.checkDrive() == "synced", "диск подключён и дочитан — synced");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.server("aa01", r.t.me);
        r.server("bb02", "bob@local");
        r.sync.ensure(true);
        r.sync.answerInvite("bb02", false);
        check(r.t.countSent("domain.grant.leave") == 1 && r.recorded.back().status == "declined"
                  && r.recorded.back().owner == "bob@local",
              "отклонить приглашение — выйти и записать отказ");
        r.sync.syncNow();
        check(r.t.countSent("domain.container.get") == 2, "отклонённое не подключается снова");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.server("aa01", r.t.me);
        r.sync.ensure(true);
        const auto id = r.sync.createFolder("Отпуск");
        check(r.recorded.back().role == "owned" && r.e.boxes[id].preparedOps[0] == json::array({json{{"op", "meta"}, {"name", "Отпуск"}}}),
              "новая совместная папка: запись owned и название первой операцией");
        r.sync.share(id, "bob@local", "editor", "Папка «Отпуск»");
        const auto grant = r.t.lastBody("domain.grant.set");
        check(grant["write"] == true && grant["user"] == "bob@local" && grant["inviteText"] == "Папка «Отпуск»",
              "доступ редактора — запись журнала грантов");
        r.t.busFns["domain.grant.set"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_FORBIDDEN"); };
        bool threw = false;
        try {
            r.sync.share(id, "carol@local", "reader", "");
        } catch (const d::BusError &) {
            threw = true;
        }
        check(threw && r.e.forgotten.back() == id, "отказ сервера — журнал грантов перечитывается с сервера");
        r.e.boxes[id].members = {{"bob@local", "editor"}};
        r.e.boxes[id].attached = true;
        r.sync.removeFolder(id);
        check(r.t.countSent("domain.grant.revoke") == 1 && r.recorded.back().isRemoved && r.recorded.back().role == "owned",
              "удаление своей папки: участники убраны, запись снята");
    }
    {
        Rig r;
        r.entries.push_back({"aa01", "local", "root", "", false, ""});
        r.entries.push_back({"ff06", "local", "owned", "", false, ""});
        r.server("aa01", r.t.me);
        r.server("ff06", r.t.me);
        r.sync.ensure(false);
        const int before = r.t.countSent("domain.op.sync");
        r.sync.syncNow();
        check(r.t.countSent("domain.op.sync") == before + 1, "в фоне синхронизируется только личный диск");
        check(r.sync.nextWakeMs() == r.t.now + kSyncIdleMs, "раздел закрыт — опрос раз в 60 с");
        r.sync.setActive(true);
        check(r.sync.nextWakeMs() == r.t.now, "раздел открыт — синхронизация сразу");
        r.sync.tick();
        check(r.t.countSent("domain.op.sync") == before + 3, "открытый раздел — все контейнеры");
        r.e.boxes["bb02"].owner = "bob@local";
        r.e.boxes["bb02"].role = "reader";
        r.listed["local"].push_back({"bb02", "bob@local"});
        r.sync.onEngineEvent("bb02");
        check(r.sync.nextWakeMs() == r.t.now, "событие движка — сразу");
        r.sync.tick();
        check(r.e.boxes["bb02"].attached, "приглашение подключено по событию движка");
        r.sync.reset();
        check(!r.sync.nextWakeMs() && r.sync.status() == "ready", "сброс снимает сроки");
    }
}

// Блобы в памяти
struct Blobs : CloudBlobs {
    std::map<std::string, std::string> store;
    int uploads = 0;
    bool fail = false;
    json usageReply = json::parse(R"({"buckets":[{"bucket":"BLOB_BUCKET_UNSPECIFIED","used":"9"},{"bucket":"BLOB_BUCKET_DRIVE","used":"100","quota":"1000","max_file":"50"}],"links_bytes":"7"})");
    json upload(const std::string &bytes, const std::string &mime) override {
        if (fail) throw d::BusError("ERROR_CODE_LIMIT");
        const auto id = "blob" + std::to_string(++uploads);
        store[id] = bytes;
        return json{{"fileId", id}, {"key", "k"}, {"nonce", "n"}, {"capability", "c"}, {"size", bytes.size()}, {"chunks", 1}};
    }
    std::optional<std::string> download(const json &blob) override {
        const auto it = store.find(blob.value("fileId", std::string()));
        if (it == store.end()) return std::nullopt;
        return it->second;
    }
    json usage() override { return usageReply; }
};

static void driveTests() {
    std::printf("-- провайдер раздела (cloudDrive.ts)\n");
    Rig r;
    Blobs blobs;
    int ids = 0;
    CloudDrive drive(r.sync, blobs, r.t, [&ids] { return "node" + std::to_string(++ids); });
    r.entries.push_back({"aa01", "local", "root", "", false, ""});
    r.server("aa01", r.t.me);
    auto st = drive.state();
    check(st["status"] == "ready" && r.sync.nextWakeMs() == r.t.now, "первое чтение состояния запускает синхронизацию в фоне");
    r.sync.tick();
    st = drive.state();
    check(st["rootId"] == "aa01" && st["containers"].size() == 1 && st["trees"].contains("aa01"), "состояние: диск и его дерево");

    auto w = drive.handle("parvaneCloudWriteText", json{{"container", "aa01"}, {"parent", "p1"}, {"name", "Заметка.md"},
                                                       {"text", "# привет"}, {"newFolder", {{"id", "f9"}, {"name", "Знания"}}}});
    const auto &ops = r.e.boxes["aa01"].preparedOps.back();
    check(w && (*w)["ok"] == true && (*w)["node"] == "node1" && (*w)["fileId"] == "blob1", "новый текст: блоб загружен, узел создан");
    check(ops.size() == 2 && ops[0]["kind"] == "folder" && ops[0]["parent"] == "p1" && ops[1]["parent"] == "f9"
              && ops[1]["blob"]["mime"] == "text/markdown" && ops[1]["blob"]["uploader"] == r.t.me,
          "папка той же правкой; файл ложится в неё; mime и автор блоба");
    // Узел есть в дереве — запись новой версии
    r.e.boxes["aa01"].nodes = json::array({json{{"id", "node1"}, {"kind", "file"}, {"name", "Заметка.md"},
                                               {"blob", {{"fileId", "blob1"}}}, {"mime", "text/markdown"}}});
    r.sync.apply("aa01", json::array()); // ревизия дерева в движке сменилась
    w = drive.writeText(json{{"container", "aa01"}, {"node", "node1"}, {"name", "Заметка.md"}, {"text", "v2"}, {"expectedFileId", "blob1"}});
    check((*w)["ok"] == true && r.e.boxes["aa01"].preparedOps.back()[0]["op"] == "setBlob", "та же версия — новая запись блоба");
    w = drive.writeText(json{{"container", "aa01"}, {"node", "node1"}, {"text", "v3"}, {"expectedFileId", "старый"}});
    check((*w)["ok"] == true && (*w)["conflict"] == "# привет" && (*w)["fileId"] == "blob1",
          "версия сменилась за время правки — конфликт с текущим текстом");
    w = drive.writeText(json{{"container", "aa01"}, {"node", "нет"}, {"text", "x"}});
    check(*w == json{{"ok", false}, {"error", "not-found"}}, "узла нет — not-found");
    blobs.fail = true;
    w = drive.writeText(json{{"container", "aa01"}, {"name", "x.md"}, {"text", "x"}});
    check(*w == json{{"ok", false}, {"error", "no-space"}}, "квота — no-space");
    blobs.fail = false;
    const auto one = drive.handle("parvaneCloudReadText", json{{"container", "aa01"}, {"node", "node1"}});
    check(one && *one == json{{"text", "# привет"}, {"fileId", "blob1"}}, "текст файла и id его версии");
    const auto many = drive.readTexts("aa01", json::array({json{{"id", "node1"}}, json{{"id", "нет"}},
                                                           json{{"id", "x"}, {"blob", {{"fileId", "blob2"}}}}}));
    check(many.size() == 3 && many[0]["text"] == "# привет" && many[1]["error"] == "not-found" && many[2]["fileId"] == "blob2",
          "тексты пакетом: порядок запроса, неизвестный узел — not-found");
    const auto u = drive.usage();
    check(u && *u == json{{"used", 100}, {"quota", 1000}, {"maxFile", 50}, {"linksBytes", 7}}, "занятое место: bucket DRIVE, u64 строками");
    blobs.usageReply = json::object();
    check(drive.usage() == u, "место кэшируется на 1,5 с");
    check(drive.handle("parvaneCloudApply", json{{"container", "aa01"}, {"ops", json::array()}}).value()["ok"] == true,
          "parvaneCloudApply → {ok, container}");
    check(drive.handle("parvaneCloudShare", json{{"container", "aa01"}, {"chatId", "1"}}).value()
              == json{{"ok", false}, {"error", "not-found"}},
          "доступ по id чата без адреса — not-found");
    check(!drive.handle("parvaneCloudThumb", json::object()), "не перенесённый метод — nullopt");
    // web проверяет «LIMIT» раньше «RATE_LIMITED» — частота запросов показывается как no-space (перенесено как есть)
    check(errorOf(d::BusError("ERROR_CODE_RATE_LIMITED")) == "no-space" && errorOf(d::BusError("ERROR_CODE_UNAVAILABLE")) == "offline" && errorOf(d::BusError("ERROR_CODE_FORBIDDEN")) == "forbidden"
              && errorOf(std::runtime_error("{\"error\":\"FieldLimit\"}")) == "too-many" && errorOf(d::BusError("LINK_LIMIT")) == "link-limit"
              && errorOf(std::runtime_error("x")) == "rejected",
          "коды ошибок для экрана — как errorOf web");
}

static void storeTests() {
    std::printf("-- построители операций (cloudStore.ts)\n");
    const auto all = nodes(json::parse(R"J([
      {"id":"d1","kind":"folder","name":"Документы"},
      {"id":"a","kind":"file","name":"отчёт.pdf","parent":"d1"},
      {"id":"b","kind":"file","name":"отчёт.pdf"},
      {"id":"c","kind":"file","name":"фото.jpg"},
      {"id":"t1","kind":"folder","name":"Старое","trashed":true,"trashTop":true,"trashedAt":5},
      {"id":"t2","kind":"file","name":"отчёт.pdf","parent":"t1","trashed":true,"trashTop":true,"trashedAt":9},
      {"id":"t3","kind":"file","name":"x.txt","parent":"d1","trashed":true,"trashTop":true,"trashedAt":7}
    ])J"));
    check(createFolderOps(all, std::nullopt, "Документы", "n1")
              == json::parse(R"J([{"op":"create","id":"n1","kind":"folder","name":"Документы (2)"}])J"),
          "новая папка — свободное имя, в корне без parent");
    check(renameOps(all, all[2], "отчёт.pdf").empty(), "то же имя — переименования нет");
    check(renameOps(all, all[2], "фото.jpg") == json::parse(R"J([{"op":"move","id":"b","name":"фото (2).jpg"}])J"),
          "занятое имя — с номером");
    check(moveOps(all, {all[1], all[2], all[3]}, std::string("d1"))
              == json::parse(R"J([{"op":"move","id":"b","parent":"d1","name":"отчёт (2).pdf"},{"op":"move","id":"c","parent":"d1","name":"фото.jpg"}])J"),
          "перенос: лежащее там же пропускается, имена — свободные по ходу");
    check(trashOps({all[3]}, 42) == json::parse(R"J([{"op":"trash","id":"c","trashed":true,"at":42}])J"), "в корзину — с моментом");
    check(restoreOps(all, {all[5], all[6]}) == json::parse(R"J([
            {"op":"move","id":"t2","name":"отчёт (2).pdf"},{"op":"trash","id":"t2","trashed":false,"at":0},
            {"op":"trash","id":"t3","trashed":false,"at":0}])J"),
          "восстановление: папка в корзине — в корень с номером; живая папка — на место");
    check(purgeOps({all[4]}, 3) == json::parse(R"J([{"op":"purge","id":"t1","at":3}])J"), "окончательно — purge");
    std::vector<CloudContainerInfo> containers{{"r", "root", "owner", "me", "", true, {}},
                                               {"s", "shared", "reader", "bob", "", true, {}},
                                               {"i", "invite", "editor", "bob", "", true, {}}};
    std::map<std::string, std::vector<CloudNode>> trees{{"r", all}, {"s", all}, {"i", all}};
    const auto trash = trashAcross(containers, trees);
    check(trash.size() == 3 && trash[0].first == "r" && trash[0].second.id == "t2",
          "корзина всех контейнеров: только где можно стирать, свежие первыми");
    check(canEditContainer(std::nullopt) && !canEditContainer(containers[1]) && canEditContainer(containers[0]),
          "правка: диск и свой/редактор — да, читатель — нет");
}

int main() {
    std::printf("=== parvane-core cloud_sync tests (без стека) ===\n");
    entryTests();
    lifecycleTests();
    driveTests();
    storeTests();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
