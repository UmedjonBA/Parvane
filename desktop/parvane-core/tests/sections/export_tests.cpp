// Parvane fork (spec 029, фаза 4): тесты «Выгрузки данных» — порт web `export/exportModel.test.ts`,
// части `export/exportRun.test.ts` без браузера и `publicLink/zip.test.ts` (формат ZIP общий). Архив
// проверяется чтением: конец архива → центральный каталог → локальный заголовок → данные → дескриптор, CRC.
// не перенесено: проверка «stops with `canceled` when aborted before start» сводится к той же отмене (здесь —
// отдельная проверка с `canceled` = true с самого начала); `unzipSync` fflate заменён собственным читателем.
#include <chrono>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "parvane/sections/export_model.h"

using namespace parvane::sections::exportdata;
namespace cloud = parvane::sections::cloud;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static bool contains(const std::string &s, const std::string &part) { return s.find(part) != std::string::npos; }

// --- читатель ZIP по оглавлению, как распаковщики ---
struct ZipEntryRead {
    std::string name;
    std::string data;
    uint32_t crc = 0;
    uint16_t flags = 0;
    uint32_t attr = 0;
};

static uint32_t rd16(const std::string &b, size_t at) {
    return static_cast<unsigned char>(b[at]) | (static_cast<unsigned char>(b[at + 1]) << 8);
}
static uint32_t rd32(const std::string &b, size_t at) {
    return rd16(b, at) | (rd16(b, at + 2) << 16);
}

// nullopt — архив битый (подпись, дескриптор или CRC не сходятся)
static std::optional<std::vector<ZipEntryRead>> readZip(const std::string &bytes) {
    if (bytes.size() < 22) return std::nullopt;
    const size_t end = bytes.size() - 22;
    if (rd32(bytes, end) != 0x06054b50) return std::nullopt;
    const uint32_t count = rd16(bytes, end + 10);
    if (rd16(bytes, end + 8) != count) return std::nullopt;
    const uint32_t dirSize = rd32(bytes, end + 12);
    size_t at = rd32(bytes, end + 16);
    if (at + dirSize != end) return std::nullopt;
    std::vector<ZipEntryRead> out;
    for (uint32_t i = 0; i < count; ++i) {
        if (at + 46 > bytes.size() || rd32(bytes, at) != 0x02014b50) return std::nullopt;
        ZipEntryRead e;
        e.flags = static_cast<uint16_t>(rd16(bytes, at + 8));
        if (rd16(bytes, at + 10) != 0) return std::nullopt; // только STORE
        e.crc = rd32(bytes, at + 16);
        const uint32_t size = rd32(bytes, at + 20);
        if (rd32(bytes, at + 24) != size) return std::nullopt;
        const uint32_t nameLength = rd16(bytes, at + 28);
        e.attr = rd32(bytes, at + 38);
        const uint32_t local = rd32(bytes, at + 42);
        e.name = bytes.substr(at + 46, nameLength);
        if (rd32(bytes, local) != 0x04034b50) return std::nullopt;
        if (bytes.substr(local + 30, rd16(bytes, local + 26)) != e.name) return std::nullopt;
        const size_t dataStart = local + 30 + rd16(bytes, local + 26) + rd16(bytes, local + 28);
        e.data = bytes.substr(dataStart, size);
        // Дескриптор после данных повторяет CRC и размер
        if (rd32(bytes, dataStart + size) != 0x08074b50 || rd32(bytes, dataStart + size + 4) != e.crc
            || rd32(bytes, dataStart + size + 8) != size) {
            return std::nullopt;
        }
        if (crc32(e.data) != e.crc) return std::nullopt;
        out.push_back(std::move(e));
        at += 46 + nameLength;
    }
    return out;
}

static std::map<std::string, std::string> unzip(const std::string &bytes) {
    std::map<std::string, std::string> files;
    if (const auto entries = readZip(bytes)) {
        for (const auto &e : *entries) files[e.name] = e.data;
    }
    return files;
}

template <typename F> static std::optional<ExportErrorCode> errorOf(F &&f) {
    try {
        f();
    } catch (const ExportError &e) {
        return e.code();
    } catch (...) {
        return std::nullopt;
    }
    return std::nullopt;
}

static ExportSourceMessage msg(const std::string &uuid, const std::string &from, const std::string &fromName,
    bool out, int64_t ts, const char *content) {
    ExportSourceMessage m;
    m.uuid = uuid;
    m.from = from;
    m.fromName = fromName;
    m.isOutgoing = out;
    m.ts = ts;
    m.content = json::parse(content);
    return m;
}

static ExportSourceChat makeChat() {
    ExportSourceChat chat;
    chat.address = "kestrel@example.test";
    chat.kind = "user";
    chat.title = "Kestrel <Fox>";
    chat.messages.push_back(msg("u1", "kestrel@example.test", "Kestrel", false, 1700000000,
        R"({"kind":"text","text":"hi <b>there</b> & \"you\""})"));
    auto u2 = msg("u2", "owl@example.test", "Owl", true, 1700000060,
        R"({"kind":"photo","file_id":"f-photo","mime":"image/jpeg","caption":"a pond","width":640,"height":480})");
    u2.replyTo = "u1";
    u2.edited = true;
    u2.editedAt = 1700000100;
    u2.reactions = std::vector<ExportReaction>{{"👍", 2}};
    chat.messages.push_back(u2);
    chat.messages.push_back(msg("u3", "owl@example.test", "Owl", true, 1700000070,
        R"({"kind":"poll_vote","poll":"p1","options":[0]})"));
    chat.messages.push_back(msg("u4", "kestrel@example.test", "Kestrel", false, 1700000080,
        R"({"kind":"file","file_id":"f-doc","mime":"application/pdf","filename":"../../secret/plan?.pdf"})"));
    chat.messages.push_back(msg("u5", "kestrel@example.test", "Kestrel", false, 1700000090,
        R"({"kind":"poll","question":"Tea or coffee?","options":["Tea","Coffee"]})"));
    chat.messages.push_back(msg("u6", "kestrel@example.test", "Kestrel", false, 1700000095,
        R"({"kind":"chat_mode","l2":true})"));
    return chat;
}

static cloud::CloudNode cnode(const std::string &id, const std::string &name, std::optional<std::string> parent = {},
    const std::string &kind = "file", bool trashed = false) {
    cloud::CloudNode n;
    n.id = id;
    n.name = name;
    n.parent = parent;
    n.kind = kind;
    n.size = 3;
    n.mime = "text/plain";
    n.mtime = 1700000000000;
    n.trashed = trashed;
    if (kind != "folder") n.blob = json{{"fileId", "b-" + id}, {"size", 3}, {"mime", "text/plain"}};
    return n;
}

static ZipWriter::ChunkSource bytesSource(std::string data) {
    auto done = std::make_shared<bool>(false);
    return [data = std::move(data), done](std::string &chunk) {
        if (*done) return false;
        *done = true;
        chunk = data;
        return true;
    };
}

using V = std::vector<std::string>;

int main() {
    std::printf("=== parvane-core sections: export ===\n");

    // ===== ZIP «Скачать всё» (publicLink/zip.test.ts) =====
    check(crc32("123456789") == 0xcbf43926U && crc32("vane", crc32("Par")) == crc32("Parvane"),
        "CRC-32 по стандартному вектору");
    {
        std::string archive;
        ZipWriter zip([&](const uint8_t *d, size_t n) { archive.append(reinterpret_cast<const char *>(d), n); },
            ZipTime{2026, 10, 15, 12, 30, 10});
        zip.beginFile("Отчёты/итог.txt");
        zip.write("при");
        zip.write("вет");
        zip.closeFile();
        zip.addDir("Отчёты/Пустая");
        zip.beginFile("ноль.bin");
        zip.closeFile();
        zip.finish();
        const auto entries = readZip(archive);
        bool flags = entries.has_value();
        V names;
        if (entries) {
            for (const auto &e : *entries) {
                names.push_back(e.name);
                if (e.flags != 0x0808) flags = false;
            }
        }
        check(entries && names == V{"Отчёты/итог.txt", "Отчёты/Пустая/", "ноль.bin"} && (*entries)[0].data == "привет"
                && (*entries)[0].crc == crc32("привет") && (*entries)[2].data.empty() && flags
                && (*entries)[1].attr == 0x10 && zip.bytes() == archive.size() && zip.count() == 3,
            "файлы потоком кусками, папка, кириллица в именах");
        // DOS-время: 12:30:10, 15.10.2026 — в локальном заголовке первого файла
        const uint32_t time = rd16(archive, 10), date = rd16(archive, 12);
        check(time == ((12u << 11) | (30u << 5) | 5u) && date == (((2026u - 1980u) << 9) | (10u << 5) | 15u),
            "дата и время элемента — в формате DOS");
    }
    {
        ZipWriter zip([](const uint8_t *, size_t) {});
        zip.beginFile("a");
        check(errorOf([&] { zip.beginFile("b"); }) == ExportErrorCode::Failed,
            "следующий файл не начинается, пока прежний не закрыт");
    }
    {
        std::vector<ZipSizedEntry> many;
        for (int i = 0; i < 70000; ++i) many.push_back({std::to_string(i), 0});
        const std::vector<ZipSizedEntry> small = {{"a", 1024}}, huge = {{"a", 1ULL << 32}};
        check(canZip(small) && !canZip(huge) && !canZip(many),
            "предел без ZIP64: 4 ГиБ и 65 535 элементов");
    }
    check(archiveFileName("Отчёты за квартал") == "Отчёты за квартал.zip",
        "название ссылки — имя архива, кириллица и пробелы остаются");
    check(archiveFileName("a/b\\c:d*e?f\"g<h>i|j") == "a b c d e f g h i j.zip"
            && archiveFileName("строка\nвторая\tтретья") == "строка вторая третья.zip",
        "знаки, запрещённые в именах файлов, и управляющие — пробелом");
    check(archiveFileName("Архив.ZIP") == "Архив.zip" && archiveFileName("  ..скрытая.. ") == "скрытая.zip"
            && archiveFileName("") == "parvane.zip" && archiveFileName("///") == "parvane.zip"
            && archiveFileName("..") == "parvane.zip",
        "без второго .zip, без точек и пробелов по краям, пустое — parvane.zip");
    {
        std::string smiles;
        for (int i = 0; i < 200; ++i) smiles += "😀";
        const auto name = archiveFileName(smiles);
        std::string expected;
        for (int i = 0; i < 120; ++i) expected += "😀";
        check(name == expected + ".zip", "длинное название обрезается по знакам, а не по половинкам суррогатных пар");
    }

    // ===== exportModel.test.ts: export file names =====
    {
        const auto longName = sanitizeFileName(std::string(200, 'a') + ".jpeg");
        check(sanitizeFileName("../../etc/passwd") == "_etc_passwd"
                && sanitizeFileName("a:b*c?d\"e<f>g|h") == "a_b_c_d_e_f_g_h" && sanitizeFileName("   ") == "file"
                && sanitizeFileName("CON.txt", "x") == "x" && sanitizeFileName("Привет мир") == "Привет мир"
                && longName.size() <= 80 && longName.size() >= 5
                && longName.compare(longName.size() - 5, 5, ".jpeg") == 0,
            "cleans unsafe names");
    }
    {
        std::set<std::string> taken;
        const auto a = uniqueName(taken, "a.jpg");
        const auto b = uniqueName(taken, "A.jpg");
        const auto c = uniqueName(taken, "a.jpg");
        check(a == "a.jpg" && b == "A (2).jpg" && c == "a (3).jpg", "makes names unique case-insensitively");
    }
    check(exportArchiveName("owl@example.test", CivilTime{2026, 1, 5, 12, 0, 0}) == "parvane-export-owl-2026-01-05.zip",
        "names the archive after the nick and the day");
    check(hrefOf("chats/001-Чат #1/messages.html") == "chats/001-%D0%A7%D0%B0%D1%82%20%231/messages.html",
        "encodes link paths per segment");

    // ===== export messages =====
    const auto chat = makeChat();
    {
        const auto messages = buildChatMessages(chat, true);
        V uuids;
        for (const auto &m : messages) uuids.push_back(m.uuid);
        check(uuids == V{"u1", "u2", "u4", "u5", "u6"} && messages[1].replyToId == 1 && messages[1].media
                && messages[1].media->path == "media/00002-photo-2.jpg"
                && messages[1].media->status == ExportMediaStatus::Included && messages[1].text == "a pond"
                && messages[2].media && messages[2].media->path == "media/00003-_secret_plan_.pdf"
                && messages[3].poll && messages[3].poll->question == "Tea or coffee?"
                && messages[3].poll->options == V{"Tea", "Coffee"} && messages[4].type == "service"
                && messages[4].action == "privacy_on",
            "numbers messages, maps replies and media paths, drops protocol rows");
    }
    {
        const auto messages = buildChatMessages(chat, false);
        check(messages[1].media && messages[1].media->status == ExportMediaStatus::NotIncluded,
            "marks media as not included when media are off");
    }
    const ExportLabels labels;
    {
        const auto exported = assignChatDirs({chat}, labels, true)[0];
        const auto j = json::parse(renderChatJson(exported));
        const auto &m0 = j["messages"][0];
        const auto &m1 = j["messages"][1];
        check(exported.dir == "chats/001-Kestrel _Fox_" && j["name"] == "Kestrel <Fox>" && m0["id"] == 1
                && m0["date"] == "2023-11-14T22:13:20.000Z" && m0["date_unixtime"] == "1700000000"
                && m0["from"] == "Kestrel" && m0["text"] == "hi <b>there</b> & \"you\""
                && m1["reply_to_message_id"] == 1 && m1["outgoing"] == true && m1["media"]["kind"] == "photo"
                && m1["media"]["file"] == "media/00002-photo-2.jpg" && m1["media"]["status"] == "included"
                && m1["media"]["mime_type"] == "image/jpeg" && m1["reactions"][0]["emoji"] == "👍"
                && m1["reactions"][0]["count"] == 2 && m1["edited"] == "2023-11-14T22:15:00.000Z",
            "renders JSON with dates, replies and media files");
        // Порядок полей и отступ — как JSON.stringify(…, 2)
        const auto text = renderChatJson(exported);
        check(text.rfind("{\n  \"name\": \"Kestrel <Fox>\",\n  \"type\": \"user\",\n  \"id\": ", 0) == 0
                && contains(text, "\"width\": 640,\n        \"height\": 480"),
            "JSON чата: порядок полей и отступ как в web");
    }
    {
        const auto exported = assignChatDirs({chat}, labels, true)[0];
        const auto html = renderChatHtml(exported, labels);
        const auto index = renderIndexHtml({"owl@example.test", "Owl <3"}, {exported},
            ExportIndexSections{std::nullopt, std::nullopt, std::string("contacts.json"), std::nullopt}, labels,
            1767571200);
        check(contains(html, "hi &lt;b&gt;there&lt;/b&gt; &amp; &quot;you&quot;") && !contains(html, "<b>there</b>")
                && contains(html, "<title>Kestrel &lt;Fox&gt;</title>") && contains(html, "href=\"#message-1\"")
                && contains(html, "<img src=\"media/00002-photo-2.jpg\"") && contains(index, "Owl &lt;3")
                && contains(index, "href=\"chats/001-Kestrel%20_Fox_/messages.html\"")
                && contains(index, "Kestrel &lt;Fox&gt;"),
            "escapes HTML in chat pages and index");
        // Местное время — функцией: UTC+3 сдвигает подпись времени
        const auto msk = renderChatHtml(exported, labels, [](int64_t ts) { return utcCivil(ts + 3 * 3600); });
        check(contains(html, "2023-11-14 22:13") && contains(msk, "2023-11-15 01:13"),
            "время сообщения — по функции местного времени (по умолчанию UTC)");
    }
    {
        auto exported = assignChatDirs({chat}, labels, true)[0];
        exported.messages[1].media->status = ExportMediaStatus::Unavailable;
        const auto html = renderChatHtml(exported, labels);
        check(contains(html, labels.mediaUnavailable)
                && !json::parse(renderChatJson(exported))["messages"][1]["media"].contains("file"),
            "shows a placeholder for media that failed");
    }
    check(escapeHtml("<a href='x'>&\"</a>") == "&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;",
        "escapes all special characters");
    {
        auto saved = chat;
        saved.kind = "saved";
        saved.title = "owl";
        const auto out = assignChatDirs({saved}, labels, false)[0];
        check(out.title == "Saved Messages" && out.dir == "chats/001-Saved Messages", "titles Saved Messages with the label");
    }

    // ===== exportRun.test.ts: runDataExport (без браузера) =====
    const std::string PHOTO = std::string("\xff\xd8\xff\x01\x02\x03\x04\x05", 8);
    ExportSnapshot snapshot;
    snapshot.self = "owl@example.test";
    snapshot.selfName = "Owl";
    {
        ExportSourceChat saved{"owl@example.test", "saved", "owl", {}};
        saved.messages.push_back(msg("s1", "owl@example.test", "Owl", true, 1700000000,
            R"({"kind":"text","text":"note to self"})"));
        ExportSourceChat k{"kestrel@example.test", "user", "Kestrel", {}};
        k.messages.push_back(msg("k1", "kestrel@example.test", "Kestrel", false, 1700000100,
            R"({"kind":"text","text":"hello from the meadow"})"));
        k.messages.push_back(msg("k2", "owl@example.test", "Owl", true, 1700000200,
            R"({"kind":"photo","file_id":"photo-1","mime":"image/jpeg"})"));
        k.messages.push_back(msg("k3", "kestrel@example.test", "Kestrel", false, 1700000300,
            R"({"kind":"file","file_id":"gone-1","mime":"application/pdf","filename":"map.pdf"})"));
        snapshot.chats = {saved, k};
        snapshot.contacts = {{"kestrel@example.test", "Kestrel", true}};
    }
    auto mediaCalls = std::make_shared<V>();
    auto fakeSource = [&]() {
        ExportSource s;
        s.snapshot = [&] { return std::optional<ExportSnapshot>(snapshot); };
        s.media = [&, mediaCalls](const std::string &fileId) -> std::optional<ZipWriter::ChunkSource> {
            mediaCalls->push_back(fileId);
            if (fileId == "photo-1") return bytesSource(PHOTO);
            return std::nullopt;
        };
        s.planner = [] { return std::optional<std::string>(R"({"tasks":[{"name":"Water the plants"}]})"); };
        s.notes = [] { return std::vector<ExportNote>{{"Garden/Seeds.md", "# Seeds\n- basil", std::nullopt}}; };
        s.cloudFiles = [] {
            return std::vector<ExportCloudFile>{{"root", "n1", "cloud/My files/readme.txt", 3, std::nullopt}};
        };
        s.cloudBlob = [](const ExportCloudFile &) -> std::optional<ZipWriter::ChunkSource> {
            return bytesSource("abc");
        };
        return s;
    };
    {
        mediaCalls->clear();
        std::string archive;
        V stages;
        ExportRunArgs args;
        args.source = fakeSource();
        args.options = {true, false};
        args.sink = [&](const uint8_t *d, size_t n) { archive.append(reinterpret_cast<const char *>(d), n); };
        args.onProgress = [&](const ExportProgress &p) {
            if (stages.empty() || stages.back() != p.stage) stages.push_back(p.stage);
        };
        args.nowUnixMs = 1772539200LL * 1000; // 2026-03-03 12:00 UTC
        const auto result = runDataExport(args);
        const auto files = unzip(archive);
        V names;
        for (const auto &[name, data] : files) names.push_back(name);
        const auto chatJson = json::parse(files.count("chats/002-Kestrel/messages.json")
                ? files.at("chats/002-Kestrel/messages.json") : "{}");
        V texts;
        if (chatJson.contains("messages")) {
            for (const auto &m : chatJson["messages"]) texts.push_back(m["text"]);
        }
        check(result.fileName == "parvane-export-owl-2026-03-03.zip" && result.chats == 2 && result.messages == 4
                && result.media == 1 && result.mediaFailed == 1 && result.notes == 1 && result.cloudFiles == 0
                && result.bytes == archive.size(),
            "builds one archive: имя и счётчики");
        check(stages == V{"prepare", "chats", "planner", "notes", "contacts", "finishing"}, "builds one archive: этапы");
        check(readZip(archive).has_value()
                && names == V{"chats/001-Saved Messages/messages.html", "chats/001-Saved Messages/messages.json",
                       "chats/002-Kestrel/media/00002-photo-2.jpg", "chats/002-Kestrel/messages.html",
                       "chats/002-Kestrel/messages.json", "contacts.json", "index.html", "notes/Garden/Seeds.md",
                       "planner/planner.json"},
            "builds one archive with chats, media, planner, notes, contacts and index");
        check(files.count("chats/002-Kestrel/media/00002-photo-2.jpg")
                && files.at("chats/002-Kestrel/media/00002-photo-2.jpg") == PHOTO
                && texts == V{"hello from the meadow", "", ""}
                && chatJson["messages"][1]["media"]["file"] == "media/00002-photo-2.jpg"
                && chatJson["messages"][2]["media"]["status"] == "unavailable"
                && json::parse(files.at("planner/planner.json"))["tasks"][0]["name"] == "Water the plants"
                && json::parse(files.at("contacts.json"))["contacts"][0]["address"] == "kestrel@example.test"
                && contains(files.at("index.html"), "chats/002-Kestrel/messages.html")
                && files.at("notes/Garden/Seeds.md") == "# Seeds\n- basil",
            "builds one archive: содержимое файлов");
    }
    {
        mediaCalls->clear();
        std::string archive;
        ExportRunArgs args;
        args.source = fakeSource();
        args.options = {false, true};
        args.sink = [&](const uint8_t *d, size_t n) { archive.append(reinterpret_cast<const char *>(d), n); };
        runDataExport(args);
        const auto files = unzip(archive);
        bool anyMedia = false;
        for (const auto &[name, data] : files) {
            if (contains(name, "/media/")) anyMedia = true;
        }
        check(mediaCalls->empty() && files.count("cloud/My files/readme.txt")
                && files.at("cloud/My files/readme.txt") == "abc" && !anyMedia
                && contains(files.at("index.html"), "cloud/My%20files/readme.txt"),
            "skips media downloads when media are off and adds cloud files when asked");
    }
    {
        bool aborted = false;
        ExportRunArgs args;
        args.source = fakeSource();
        args.source.media = [&](const std::string &) -> std::optional<ZipWriter::ChunkSource> {
            aborted = true;
            return bytesSource(PHOTO);
        };
        args.options = {true, false};
        args.canceled = [&] { return aborted; };
        args.sink = [](const uint8_t *, size_t) {};
        check(errorOf([&] { runDataExport(args); }) == ExportErrorCode::Canceled,
            "stops with `canceled` when aborted mid-way");
    }
    {
        ExportRunArgs args;
        args.source = fakeSource();
        args.options = {true, true};
        args.canceled = [] { return true; };
        args.sink = [](const uint8_t *, size_t) {};
        check(errorOf([&] { runDataExport(args); }) == ExportErrorCode::Canceled,
            "stops with `canceled` when aborted before start");
    }
    {
        ExportRunArgs args;
        args.source = fakeSource();
        args.source.snapshot = [] { return std::optional<ExportSnapshot>(); };
        args.sink = [](const uint8_t *, size_t) {};
        check(errorOf([&] { runDataExport(args); }) == ExportErrorCode::Failed, "fails without a snapshot");
    }

    // ===== zip writer (exportRun.test.ts) =====
    {
        bool aborted = false;
        int pulls = 0;
        ZipWriter writer([](const uint8_t *, size_t) {}, {}, [&] { return aborted; });
        const auto code = errorOf([&] {
            writer.addChunks("big.bin", [&](std::string &chunk) {
                ++pulls;
                if (pulls == 2) aborted = true;
                chunk.assign(1024, '\0');
                return pulls <= 4;
            });
        });
        check(code == ExportErrorCode::Canceled, "cancels while streaming a file");
    }
    {
        ZipWriter writer([](const uint8_t *, size_t) {});
        writer.addBytes("a.txt", "one");
        check(errorOf([&] { writer.addBytes("a.txt", "two"); }) == ExportErrorCode::Failed, "rejects duplicate paths");
    }

    // ===== cloud paths =====
    const std::vector<cloud::CloudNode> nodes = {
        cnode("f1", "Знания", std::nullopt, "folder"),
        cnode("n1", "Plan.md", "f1"),
        cnode("n2", "plan.md", "f1"),
        cnode("n3", "photo.jpg", "f1"),
        cnode("n4", "old.md", "f1", "file", true),
        cnode("n5", ".parvane-guide", "f1"),
        cnode("d1", "Sub/dir", "f1", "folder"),
        cnode("n6", "Deep.md", "d1"),
        cnode("r1", "top.txt"),
    };
    {
        V paths;
        for (const auto &f : treeFilePaths(nodes, "", "f1", [](const cloud::CloudNode &n) {
                 return n.name.size() >= 3 && n.name.compare(n.name.size() - 3, 3, ".md") == 0;
             })) {
            paths.push_back(f.path);
        }
        check(paths == V{"Plan.md", "Sub_dir/Deep.md", "plan (2).md"}, "walks a folder, skipping trash and service files");
    }
    // Ревью 21 окт 2026: цепочка 30 000 папок (редактор совместной папки) — без переполнения стека и квадрата
    {
        std::vector<cloud::CloudNode> chain;
        chain.push_back(cnode("c0", "a", "", "folder"));
        for (int i = 1; i < 30000; ++i) {
            chain.push_back(cnode("c" + std::to_string(i), "a", "c" + std::to_string(i - 1), "folder"));
        }
        chain.push_back(cnode("shallow", "s.txt", "c2"));
        chain.push_back(cnode("deep", "d.txt", "c29999"));
        const auto t0 = std::chrono::steady_clock::now();
        const auto files = treeFilePaths(chain, "", std::nullopt, nullptr);
        const auto seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        check(seconds < 1.0 && files.size() == 1 && files[0].path == "a/a/a/s.txt",
              "chain of 30000 folders: fast, deeper than kExportMaxDepth skipped");
    }
    {
        V paths;
        for (const auto &f : cloudExportFiles({{"root", "My files", nodes}, {"c2", "My files", {cnode("x", "x.txt")}}},
                 "Drive")) {
            paths.push_back(f.path);
        }
        check(paths == V{"cloud/My files/top.txt", "cloud/My files/Знания/Plan.md", "cloud/My files/Знания/Sub_dir/Deep.md",
                           "cloud/My files/Знания/photo.jpg", "cloud/My files/Знания/plan (2).md", "cloud/My files (2)/x.txt"},
            "puts each container in its own folder");
    }

    // Дополнительно: свой архив читается, порча байта данных ловится проверкой CRC
    {
        std::string archive;
        ZipWriter zip([&](const uint8_t *d, size_t n) { archive.append(reinterpret_cast<const char *>(d), n); });
        zip.addBytes("a.txt", "hello");
        zip.finish();
        auto broken = archive;
        broken[30 + 5] ^= 0x01; // первый байт данных a.txt
        check(readZip(archive).has_value() && !readZip(broken).has_value(), "читатель архива проверяет CRC");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
