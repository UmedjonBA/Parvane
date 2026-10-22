// Parvane fork (spec 029, T064): файлы раздела «Облако» — загрузка с миниатюрой и проверкой места, скачивание,
// перенос между контейнерами, «Сделать общей» / «Закрыть доступ», ссылки (план, список, запись владельца) на
// поддельном транспорте и поддельном движке, который применяет операции к дереву. Случаи — по коду web
// `cloudDrive.ts` и тестам `cloudLinks.test.ts` (план и адрес).
#include <algorithm>
#include <cstdio>
#include <set>
#include <string>

#include "fake_domain.h"
#include "parvane/sections/cloud_files.h"

using nlohmann::json;
using namespace parvane::sections::cloud;
namespace d = parvane::sections::domain;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// Поддельный движок: контейнеры с деревьями, операции применяются сразу
struct Box {
    bool attached = true;
    std::string owner = "alice@local", role = "owner", name;
    std::vector<ContainerMember> members;
    json nodes = json::array();
};

static std::string sv(const json &o, const char *k) { return o.contains(k) && o[k].is_string() ? o[k].get<std::string>() : std::string(); }

static void applyOp(Box &b, const json &op) {
    const auto kind = sv(op, "op");
    const auto id = sv(op, "id");
    auto find = [&](const std::string &x) {
        return std::find_if(b.nodes.begin(), b.nodes.end(), [&](const json &n) { return sv(n, "id") == x; });
    };
    if (kind == "meta") {
        b.name = sv(op, "name");
    } else if (kind == "create") {
        json n{{"id", id}, {"kind", sv(op, "kind")}, {"name", sv(op, "name")}, {"trashed", false}, {"trashTop", false}};
        if (op.contains("parent")) n["parent"] = op["parent"];
        if (op.contains("mtime")) n["mtime"] = op["mtime"];
        if (op.contains("blob")) {
            n["blob"] = op["blob"];
            n["size"] = op["blob"].value("size", 0);
            n["mime"] = op["blob"].value("mime", std::string());
        }
        if (op.contains("thumb")) n["thumb"] = op["thumb"];
        b.nodes.push_back(n);
    } else if (kind == "move") {
        const auto it = find(id);
        if (it == b.nodes.end()) return;
        (*it)["name"] = op["name"];
        if (op.contains("parent")) (*it)["parent"] = op["parent"];
        else it->erase("parent");
    } else if (kind == "trash") {
        const auto it = find(id);
        if (it != b.nodes.end()) {
            (*it)["trashed"] = op["trashed"];
            (*it)["trashTop"] = op["trashed"];
        }
    } else if (kind == "purge") {
        std::set<std::string> gone{id};
        for (bool grew = true; grew;) {
            grew = false;
            for (const auto &n : b.nodes) {
                if (n.contains("parent") && gone.count(n["parent"].get<std::string>()) && !gone.count(sv(n, "id"))) {
                    gone.insert(sv(n, "id"));
                    grew = true;
                }
            }
        }
        json kept = json::array();
        for (const auto &n : b.nodes) {
            if (!gone.count(sv(n, "id"))) kept.push_back(n);
        }
        b.nodes = kept;
    }
}

struct Rig {
    fake::Transport t;
    std::map<std::string, Box> boxes;
    d::MemoryRecords records;
    std::vector<CloudStateEntry> entries;
    int created = 0, prepared = 0;
    std::vector<std::string> forgotten;
    json keys = json::array();
    CloudSync sync;

    Rig()
    : sync(t, records, CloudHooks{
          [this] { return entries; },
          [this](const CloudStateEntry &e) {
              auto it = std::find_if(entries.begin(), entries.end(), [&](const CloudStateEntry &x) { return x.id == e.id; });
              if (it == entries.end()) entries.push_back(e);
              else *it = e;
          },
          [](const std::string &) {},
          [](const std::string &) {},
          [] {}}) {
        auto box = [this](const json &a) -> Box & { return boxes[a["id"].get<std::string>()]; };
        t.engineFns["cloudContainers"] = [this](const json &) {
            json list = json::array();
            for (auto &[id, b] : boxes) {
                if (!b.attached) continue;
                json members = json::array();
                for (const auto &m : b.members) members.push_back(json{{"user", m.user}, {"role", m.role}});
                list.push_back(json{{"id", id}, {"owner", b.owner}, {"name", b.name}, {"hasKey", true}, {"headSeq", 0},
                                    {"epoch", 1}, {"grantVersion", 0}, {"members", members}, {"role", b.role}});
            }
            return list;
        };
        t.engineFns["cloudDomain"] = [](const json &) { return json(std::string()); };
        t.engineFns["cloudIsAttached"] = [this](const json &a) {
            const auto it = boxes.find(a["id"].get<std::string>());
            return json(it != boxes.end() && it->second.attached);
        };
        t.engineFns["cloudHasKey"] = [](const json &) { return json(true); };
        t.engineFns["cloudHeadSeq"] = [](const json &) { return json(0); };
        t.engineFns["cloudGrantVersion"] = [](const json &) { return json(0); };
        t.engineFns["cloudStateJson"] = [this](const json &a) {
            const auto it = boxes.find(a["id"].get<std::string>());
            if (it == boxes.end() || !it->second.attached) return json(nullptr);
            return json{{"name", it->second.name}, {"count", it->second.nodes.size()}, {"nodes", it->second.nodes},
                        {"purgedBlobs", json::array()}};
        };
        t.engineFns["cloudCreate"] = [this](const json &) {
            ++created;
            const auto id = "s" + std::to_string(created);
            boxes[id].attached = true;
            return json{{"id", id}, {"request", fake::req("domain.container.create", id)}};
        };
        t.engineFns["cloudForget"] = [this](const json &a) {
            const auto id = a["id"].get<std::string>();
            forgotten.push_back(id);
            boxes[id].attached = false;
            return json(nullptr);
        };
        t.engineFns["cloudPrepareLocal"] = [this, box](const json &a) {
            auto &b = box(a);
            for (const auto &op : a["opsJson"]["ops"]) applyOp(b, op);
            ++prepared;
            char hex[33];
            std::snprintf(hex, sizeof hex, "%032x", prepared);
            return json{{"opId", hex}, {"op", d::toBase64("op" + std::to_string(prepared))}, {"applied", 1}};
        };
        t.engineFns["cloudSeal"] = [](const json &a) {
            return fake::req("domain.op.append", "seal:" + a["opIdHex"].get<std::string>());
        };
        t.engineFns["cloudShareWithOwnDevices"] = [](const json &) { return json::array(); };
        t.engineFns["cloudRevoke"] = [](const json &a) {
            return json::array({fake::req("domain.grant.revoke", a["user"].get<std::string>())});
        };
        t.engineFns["cloudKeysExport"] = [this](const json &) { return keys; };
        entries.push_back({"root1", "local", "root", "", false, ""});
        boxes["root1"];
    }
    json &nodes(const std::string &id) { return boxes[id].nodes; }
    json node(const std::string &container, const std::string &name) {
        for (const auto &n : boxes[container].nodes) {
            if (sv(n, "name") == name) return n;
        }
        return nullptr;
    }
};

// Блобы в памяти с поддельной «криптографией»: запечатанное — «seal|ключ|nonce|текст»
struct Blobs : CloudBlobs {
    std::map<std::string, std::string> store;
    int uploads = 0;
    int random = 0;
    json usageReply = json::parse(R"({"buckets":[{"bucket":"BLOB_BUCKET_DRIVE","used":"100","quota":"100000","max_file":"5000"}]})");
    json upload(const std::string &bytes, const std::string &mime) override {
        const auto id = "blob" + std::to_string(++uploads);
        store[id] = bytes;
        return json{{"fileId", id}, {"key", d::toBase64("K-" + id)}, {"nonce", "n"}, {"capability", "c"},
                    {"size", bytes.size()}, {"chunks", 1}};
    }
    std::int64_t lastMaxBytes = -1; // поле kBlobMaxBytesKey последнего скачивания (нет — 0)
    std::optional<std::string> download(const json &blob) override {
        lastMaxBytes = blob.value(kBlobMaxBytesKey, std::int64_t(0));
        const auto it = store.find(blob.value("fileId", std::string()));
        if (it == store.end()) return std::nullopt;
        // Миниатюра хранится запечатанной: вскрыть ключом и nonce из описания
        const auto opened = openWithKey(it->second, blob.value("key", std::string()), blob.value("nonce", std::string()));
        return opened ? opened : std::optional<std::string>(it->second);
    }
    json usage() override { return usageReply; }
    std::string randomBytes(std::size_t n) override {
        auto s = std::to_string(++random);
        s.resize(n, 'r');
        return s;
    }
    std::string sha256(const std::string &bytes) override {
        auto s = "H" + bytes;
        s.resize(32, '#');
        return s;
    }
    std::string sealWithKey(const std::string &plain, const std::string &keyRaw, const std::string &nonceRaw) override {
        return "seal|" + d::toBase64(keyRaw) + "|" + d::toBase64(nonceRaw) + "|" + plain;
    }
    std::optional<std::string> openWithKey(const std::string &cipher, const std::string &keyB64,
                                           const std::string &nonceB64) override {
        const auto prefix = "seal|" + keyB64 + "|" + nonceB64 + "|";
        if (cipher.rfind(prefix, 0) != 0) return std::nullopt;
        return cipher.substr(prefix.size());
    }
    std::string uploadCipher(const std::string &cipher, const std::string &) override {
        const auto id = "raw" + std::to_string(++uploads);
        store[id] = cipher;
        return id;
    }
};

static void sizeTests() {
    std::printf("-- размеры PVB2 (cloudBlobs.ts)\n");
    check(cloudCipherSize(0) == 8 + 16 && cloudCipherSize(10) == 8 + 10 + 16, "пустой и малый файл — один чанк");
    check(cloudCipherSize(256 * 1024 + 1) == 8 + 256 * 1024 + 1 + 32, "чанк и байт — два тега");
    check(cloudPlainSize(cloudCipherSize(1'000'000)) == 1'000'000 && cloudPlainSize(cloudCipherSize(0)) == 0,
          "открытый размер — обратное к шифртексту");
}

static void linkPureTests() {
    std::printf("-- ссылки: план, адрес, запись владельца (cloudLinks.ts)\n");
    const auto nodes = json::parse(R"J([
      {"id":"f","kind":"folder","name":"Отпуск"},
      {"id":"a","kind":"file","name":"b.jpg","parent":"f","blob":{"fileId":"x1","size":10,"key":"k","nonce":"n","capability":"c","chunks":1,"mime":"image/jpeg"}},
      {"id":"s","kind":"folder","name":"Видео","parent":"f"},
      {"id":"v","kind":"file","name":"clip.mp4","parent":"s","blob":{"fileId":"x2","size":20,"key":"k2","nonce":"n2","capability":"c2","chunks":1}},
      {"id":"m","kind":"file","name":".parvane-guide","parent":"f","blob":{"fileId":"x3","size":1}},
      {"id":"t","kind":"file","name":"старое.txt","parent":"f","trashed":true,"blob":{"fileId":"x4","size":1}},
      {"id":"r","kind":"file","name":"корень.txt","blob":{"fileId":"x5","size":3}}
    ])J");
    auto plan = buildLinkPlan(nodes, std::string("f"));
    check(plan.error.empty() && plan.kind == "folder" && plan.name == "Отпуск", "папка — план вида folder");
    check(plan.dirs == std::vector<std::string>{"Видео"} && plan.files.size() == 2 && plan.files[0].path == "b.jpg"
              && plan.files[1].path == "Видео/clip.mp4" && plan.bytes == 30,
          "пути от корня ссылки; корзина и служебные файлы не входят");
    plan = buildLinkPlan(nodes, std::string("a"));
    check(plan.kind == "file" && plan.files.size() == 1 && plan.files[0].path == "b.jpg" && plan.bytes == 10, "файл — один путь");
    check(buildLinkPlan(nodes, std::string("t")).error == "not-found" && buildLinkPlan(nodes, std::string("нет")).error == "not-found",
          "в корзине либо нет — not-found");
    plan = buildLinkPlan(nodes, std::nullopt, "Общая");
    check(plan.name == "Общая" && plan.files.size() == 3, "весь контейнер — под названием папки");
    check(buildLinkPlan(nodes, std::nullopt, "").error == "not-found", "без названия — not-found");
    json many = json::array({json{{"id", "f"}, {"kind", "folder"}, {"name", "F"}}});
    for (int i = 0; i < kLinkMaxFiles + 1; ++i) {
        many.push_back(json{{"id", "n" + std::to_string(i)}, {"kind", "file"}, {"name", "f" + std::to_string(i)},
                            {"parent", "f"}, {"blob", {{"fileId", "b"}, {"size", 1}}}});
    }
    check(buildLinkPlan(many, std::string("f")).error == "too-many", "больше 500 файлов — too-many");

    plan = buildLinkPlan(nodes, std::string("f"));
    std::map<std::string, LinkCopy> copies{{"a", {"c1", 50, 1, json{{"fileId", "t1"}, {"nonce", "tn"}, {"blobSize", 9}}}},
                                           {"v", {"c2", 60, 1, std::nullopt}}};
    const auto manifest = buildManifest(plan, copies, 77);
    check(manifest["v"] == 1 && manifest["created"] == 77 && manifest["items"].size() == 3
              && manifest["items"][0] == json{{"path", "Видео"}, {"dir", true}}
              && manifest["items"][1]["fileId"] == "c1" && manifest["items"][1]["key"] == "k"
              && manifest["items"][1]["thumb"]["fileId"] == "t1" && manifest["items"][2]["mime"] == "application/octet-stream",
          "список: папки, затем файлы с копиями, ключом исходного блоба и миниатюрой");
    bool threw = false;
    try {
        buildManifest(plan, {}, 1);
    } catch (const std::exception &) {
        threw = true;
    }
    check(threw, "файл без копии — исключение");

    check(buildLinkUrl("https://example.org:8443/", "AbC_-1234567890xyz", "KEY") == "https://example.org:8443/s/AbC_-1234567890xyz#k=KEY",
          "адрес ссылки: ключ во фрагменте");
    check(originOfGateway("wss://example.org:20443/ws") == "https://example.org:20443" && originOfGateway("ws://127.0.0.1:9222/ws") == "http://127.0.0.1:9222",
          "адрес web-клиента по адресу gateway");
    const std::string raw32(32, '\xfb');
    const auto url = toBase64Url(raw32);
    check(url.find('+') == std::string::npos && url.find('=') == std::string::npos && fromBase64Url(url) == raw32,
          "base64url туда и обратно");
    const auto rec = ownerRecordJson("Отпуск", "folder", url, 3, std::make_pair(std::string("c"), std::string("f")));
    const auto parsed = parseOwnerRecord(rec.dump());
    check(parsed && (*parsed)["name"] == "Отпуск" && (*parsed)["source"]["node"] == "f", "запись владельца: туда и обратно");
    auto bad = rec;
    bad["key"] = "короткий";
    check(!parseOwnerRecord(bad.dump()) && !parseOwnerRecord("{}") && !parseOwnerRecord("не json"),
          "запись с негодным ключом либо не по контракту — отвергается");
    const auto links = json::array({json{{"id", "1"}, {"state", "preparing"}, {"source", {{"container", "c"}, {"node", "f"}}}},
                                    json{{"id", "2"}, {"state", "active"}, {"source", {{"container", "c"}, {"node", "f"}}}}});
    check(linkOfSource(links, "c", "f").value()["id"] == "2" && !linkOfSource(links, "c", ""), "ссылка узла — готовая, не готовящаяся");
}

static void uploadTests() {
    std::printf("-- загрузка и скачивание (runUpload, parvaneCloudDownload, parvaneCloudThumb)\n");
    Rig r;
    Blobs blobs;
    int ids = 0;
    CloudDrive drive(r.sync, blobs, r.t, [&ids] { return "d" + std::to_string(++ids); });
    CloudFiles files(drive, [&ids] { return "n" + std::to_string(++ids); });
    UploadRequest up{"root", std::string("p1"), "фото.jpg", "image/jpeg", 123, "IMG", UploadThumb{"JPEG", 32, 24}};
    auto res = files.upload(up);
    const auto n = r.node("root1", "фото.jpg");
    check(res["ok"] == true && res["container"] == "root1" && n.is_object() && n["parent"] == "p1" && n["mtime"] == 123,
          "файл загружен и встал в папку");
    check(n["blob"]["mime"] == "image/jpeg" && n["blob"]["uploader"] == r.t.me && n["blob"]["fileId"] == "blob1",
          "описание блоба: тип и автор");
    check(n.contains("thumb") && n["thumb"]["width"] == 32 && blobs.store[n["thumb"]["fileId"].get<std::string>()].rfind("seal|", 0) == 0,
          "миниатюра запечатана ключом файла и загружена отдельно");
    const auto thumb = files.thumb(n);
    check(thumb && *thumb == "JPEG", "миниатюра вскрывается ключом файла и своим nonce");
    // Ревью 21 окт 2026 (2.2): миниатюру указывает любой редактор совместной папки — скачивание с потолком
    check(blobs.lastMaxBytes == cipherCeiling(kThumbMaxBytes) && blobs.lastMaxBytes < 3 * 1024 * 1024,
          "миниатюра: потолок шифртекста ~2 МБ уходит реализации блобов");
    (void)files.open(n, 1000);
    check(blobs.lastMaxBytes == cipherCeiling(1000), "просмотр: потолок содержимого уходит реализации блобов");
    (void)files.open(n);
    check(blobs.lastMaxBytes == 0, "открыть без потолка — поля нет (общий потолок сессии)");
    check(cipherCeiling(0) == 0 && cipherCeiling(-5) == 0 && cipherCeiling(1) == 1 + 8 + 16
              && cipherCeiling(300000) >= cloudCipherSize(300000),
          "cipherCeiling: не меньше шифртекста PVB2 web");
    const auto got = files.download("root1", n["id"].get<std::string>());
    check(got.ok && got.bytes == "IMG" && got.name == "фото.jpg", "скачивание: байты и имя");
    check(!files.download("root1", "нет").ok && files.download("root1", "нет").error == "not-found", "нет узла — not-found");
    up.thumb.reset();
    up.bytes = std::string(6000, 'x');
    res = files.upload(up);
    check(res == json{{"ok", false}, {"error", "too-large"}}, "крупнее предела файла — too-large до начала");
    blobs.usageReply = json::parse(R"({"buckets":[{"bucket":"BLOB_BUCKET_DRIVE","used":"99990","quota":"100000","max_file":"0"}]})");
    up.bytes = "abc";
    res = files.upload(up);
    check(res == json{{"ok", false}, {"error", "no-space"}}, "не хватает места — no-space до начала");
}

static void moveTests() {
    std::printf("-- перенос между контейнерами (moveNodes)\n");
    Rig r;
    Blobs blobs;
    int ids = 0;
    CloudDrive drive(r.sync, blobs, r.t);
    CloudFiles files(drive, [&ids] { return "n" + std::to_string(++ids); });
    r.nodes("root1") = json::parse(R"J([
      {"id":"f","kind":"folder","name":"Проект","mtime":5},
      {"id":"a","kind":"file","name":"a.txt","parent":"f","size":4,"mtime":6,"blob":{"fileId":"A","capability":"capA","size":4,"key":"k","nonce":"n"},"thumb":{"fileId":"TA","capability":"capT","nonce":"tn"}},
      {"id":"g","kind":"folder","name":"Вложенная","parent":"f"},
      {"id":"b","kind":"file","name":"b.txt","parent":"g","size":2,"blob":{"fileId":"B","capability":"capB","size":2}},
      {"id":"t","kind":"file","name":"удалённое.txt","parent":"f","trashed":true,"trashTop":true,"blob":{"fileId":"T","capability":"capX","size":1}}
    ])J");
    int copyN = 0;
    r.t.busFns["cloud.blob.copy"] = [&copyN](const fake::Sent &s) {
        const auto body = json::parse(s.body);
        return json{{"file_id", "copy-" + body["file_id"].get<std::string>()}, {"size", "1"}}.dump();
    };
    (void)copyN;
    std::vector<std::pair<std::int64_t, std::int64_t>> steps;
    // «Сделать общей»: содержимое папки — в новый контейнер, сама папка стирается, корзина поднимается в корень
    auto res = files.shareFolder("root1", "f", [&](std::int64_t done, std::int64_t total) { steps.push_back({done, total}); });
    const auto shared = res.value("container", std::string());
    check(res["ok"] == true && shared == "s1" && r.boxes["s1"].name == "Проект", "новая совместная папка с названием папки");
    const auto copied = r.node("s1", "a.txt");
    check(copied.is_object() && copied["blob"]["fileId"] == "copy-A" && copied["blob"]["uploader"] == r.t.me
              && copied["thumb"]["fileId"] == "copy-TA" && !copied.contains("parent") && copied["mtime"] == 6,
          "файл — копией блоба на сервере, миниатюра тоже; верхний уровень — в корне назначения");
    const auto nested = r.node("s1", "b.txt");
    const auto folder = r.node("s1", "Вложенная");
    check(folder.is_object() && nested.is_object() && nested["parent"] == folder["id"], "вложенное — под новыми id");
    const auto body = r.t.lastBody("cloud.blob.copy");
    check(body["bucket"] == "BLOB_BUCKET_DRIVE" && body["capability"] == "capB" && body.contains("capability_hash"),
          "копия: bucket диска, исходный секрет и хеш нового");
    check(r.node("root1", "Проект").is_null() && r.node("root1", "a.txt").is_null(), "источник стёрт после принятия назначения");
    const auto rescued = r.node("root1", "удалённое.txt");
    check(rescued.is_object() && !rescued.contains("parent"), "лежавшее в корзине остаётся в источнике, в корне");
    check(!steps.empty() && steps.front() == std::make_pair<std::int64_t, std::int64_t>(0, 6) && steps.back().first == 6,
          "ход переноса — по байтам файлов");

    // Обратно: «Закрыть доступ» — в новую папку личного диска, контейнер удаляется
    r.boxes["s1"].members.push_back({"bob@local", "reader"});
    res = files.unshareFolder("s1", "Проект");
    const auto back = r.node("root1", "Проект");
    check(res["ok"] == true && back.is_object() && r.node("root1", "a.txt")["parent"] == back["id"], "содержимое — в папку диска");
    check(std::find(r.forgotten.begin(), r.forgotten.end(), "s1") != r.forgotten.end() && r.t.countSent("domain.grant.revoke") == 1,
          "совместная папка удалена, участник лишён доступа");

    // Отмена между файлами: скопированное до отмены не остаётся занимать место
    r.nodes("root1") = json::parse(R"J([
      {"id":"x","kind":"file","name":"x","size":1,"blob":{"fileId":"X","capability":"c","size":1}},
      {"id":"y","kind":"file","name":"y","size":1,"blob":{"fileId":"Y","capability":"c","size":1}}])J");
    r.boxes["s9"].attached = true;
    int asked = 0;
    res = files.move("root1", {{"x", "x"}, {"y", "y"}}, "s9", std::nullopt, {}, [&asked] { return ++asked > 1; });
    check(res["ok"] == false && res["canceled"] == true && r.t.countSent("cloud.blob.delete") == 1 && r.boxes["s9"].nodes.empty(),
          "отмена: копия стёрта, назначение не тронуто");
    r.t.busFns["cloud.blob.copy"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_LIMIT"); };
    res = files.move("root1", {{"x", "x"}}, "s9", std::nullopt);
    check(res == json{{"ok", false}, {"error", "no-space"}} && r.node("root1", "x").is_object(), "отказ сервера — источник цел");
}

static void linkTests() {
    std::printf("-- ссылки на сервере (createLink, parvaneCloudLinks, revoke, extend)\n");
    Rig r;
    Blobs blobs;
    CloudDrive drive(r.sync, blobs, r.t);
    CloudFiles files(drive);
    r.nodes("root1") = json::parse(R"J([
      {"id":"f","kind":"folder","name":"Отпуск"},
      {"id":"a","kind":"file","name":"a.jpg","parent":"f","size":4,"blob":{"fileId":"A","capability":"capA","size":4,"key":"ka","nonce":"na","chunks":1},"thumb":{"fileId":"TA","capability":"capT","nonce":"tn"}}
    ])J");
    const auto driveKey = d::toBase64(std::string(32, 'D'));
    r.keys = json::array({json{{"id", "root1"}, {"keys", json::array({json::array({1, d::toBase64("old")}), json::array({2, driveKey})})}}});
    r.t.busFns["cloud.link.create"] = [](const fake::Sent &) { return json{{"link_id", "Link1234567890abcd"}}.dump(); };
    int adds = 0;
    r.t.busFns["cloud.link.add"] = [&adds](const fake::Sent &s) -> std::string {
        // Первая копия «ещё идёт» — повтор
        if (++adds == 1) throw d::BusError("ERROR_CODE_UNAVAILABLE");
        const auto body = json::parse(s.body);
        return json{{"fileId", "L-" + body["file_id"].get<std::string>()}, {"size", "40"}, {"chunks", 1}}.dump();
    };
    json published;
    r.t.busFns["cloud.link.publish"] = [&published](const fake::Sent &s) {
        published = json::parse(s.body);
        return json{{"expires_at", "999"}}.dump();
    };
    std::vector<std::int64_t> done;
    auto res = files.linkCreate("root1", std::string("f"), "", 7, "https://srv.example",
                                [&](std::int64_t n, std::int64_t) { done.push_back(n); });
    const auto link = res["link"];
    check(res["ok"] == true && link["id"] == "Link1234567890abcd" && link["expiresAt"] == 999 && link["files"] == 1
              && link["kind"] == "folder" && link["source"]["node"] == "f",
          "ссылка создана: срок, число файлов, источник");
    check(r.t.lastBody("cloud.link.create")["ttl_days"] == 7 && adds == 3 && done == std::vector<std::int64_t>{0, 1},
          "срок в запросе; копия «ещё идёт» — повтор; ход по файлам");
    const auto url = link["url"].get<std::string>();
    check(url.rfind("https://srv.example/s/Link1234567890abcd#k=", 0) == 0, "полный адрес с ключом во фрагменте");
    // Список ссылки вскрывается ключом из адреса, запись владельца — ключом диска последней эпохи
    const auto key = fromBase64Url(url.substr(url.find("#k=") + 3)).value();
    const auto manifestCipher = d::fromBase64(published["manifest"].get<std::string>());
    const auto nonce = blobs.sha256("parvane-link-manifestLink1234567890abcd").substr(0, 12);
    const auto manifest = json::parse(blobs.openWithKey(manifestCipher, d::toBase64(key), d::toBase64(nonce)).value());
    check(manifest["items"].size() == 1 && manifest["items"][0]["fileId"] == "L-A" && manifest["items"][0]["thumb"]["fileId"] == "L-TA"
              && manifest["items"][0]["key"] == "ka" && manifest["name"] == "Отпуск",
          "список ссылки: копии файла и миниатюры, ключ исходного блоба");
    const auto owner = d::fromBase64(published["owner_record"].get<std::string>());
    check(owner.size() > 4 && owner[3] == 2 && owner[0] == 0, "запись владельца: эпоха ключа диска впереди (u32 BE)");

    // Список своих ссылок: название и адрес — из записи владельца
    r.t.busFns["cloud.link.list"] = [&published](const fake::Sent &) {
        return json{{"links", json::array({
            json{{"link_id", "Old0000000000000000"}, {"state", "LINK_STATE_EXPIRED"}, {"created_at", "5"}},
            json{{"linkId", "Link1234567890abcd"}, {"state", 2}, {"createdAt", "10"}, {"expiresAt", "999"},
                 {"bytes", "80"}, {"files", 1}, {"ownerRecord", published["owner_record"]}}})}}.dump();
    };
    const auto list = files.links("https://srv.example");
    check(list["ok"] == true && list["links"].size() == 2 && list["links"][0]["id"] == "Link1234567890abcd"
              && list["links"][0]["state"] == "active" && list["links"][0]["name"] == "Отпуск" && list["links"][0]["url"] == url
              && list["links"][0]["bytes"] == 80,
          "свои ссылки: свежие первыми, название и адрес из записи владельца");
    check(list["links"][1]["state"] == "expired" && !list["links"][1].contains("url"), "без записи владельца — без адреса");
    r.keys = json::array();
    check(!files.links("x")["links"][0].contains("name"), "ключа диска нет — название не читается");

    // Отказы при создании
    r.keys = json::array({json{{"id", "root1"}, {"keys", json::array({json::array({2, driveKey})})}}});
    r.t.busFns["cloud.link.create"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_LIMIT"); };
    check(files.linkCreate("root1", std::string("a"), "", 1, "o")["error"] == "link-limit", "предел ссылок аккаунта — link-limit");
    r.t.busFns["cloud.link.create"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_FORBIDDEN"); };
    check(files.linkCreate("root1", std::string("a"), "", 1, "o")["error"] == "link-disabled", "ссылки выключены — link-disabled");
    r.t.busFns["cloud.link.create"] = [](const fake::Sent &) { return json{{"link_id", "Bad00000000000000"}}.dump(); };
    r.t.busFns["cloud.link.add"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_NOT_FOUND"); };
    const auto revokes = r.t.countSent("cloud.link.revoke");
    check(files.linkCreate("root1", std::string("a"), "", 1, "o")["error"] == "not-found"
              && r.t.countSent("cloud.link.revoke") == revokes + 1 && r.t.lastBody("cloud.link.revoke")["link_id"] == "Bad00000000000000",
          "сбой копии — недоделанная ссылка отозвана");
    check(files.linkCreate("root1", std::string("нет"), "", 1, "o")["error"] == "not-found", "нет узла — not-found до сервера");

    check(files.linkRevoke("L1")["ok"] == true && r.t.lastBody("cloud.link.revoke")["link_id"] == "L1", "отзыв");
    r.t.busFns["cloud.link.extend"] = [](const fake::Sent &s) {
        return json{{"expiresAt", json::parse(s.body)["ttl_days"] == 0 ? "0" : "5000"}}.dump();
    };
    check(files.linkExtend("L1", 30) == json{{"ok", true}, {"expiresAt", 5000}} && files.linkExtend("L1", 0)["expiresAt"] == 0,
          "продление: новый срок, 0 — без срока");
}

int main() {
    std::printf("=== parvane-core cloud_files tests (без стека) ===\n");
    sizeTests();
    linkPureTests();
    uploadTests();
    moveTests();
    linkTests();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
