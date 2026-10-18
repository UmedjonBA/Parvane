// Parvane fork (spec 029, T034): источник «Выгрузки данных» поверх провайдера (web `export/exportSource.ts`). Своих
// тестов у exportSource в web нет (exportRun.test.ts проверяет сборку архива на подставном источнике — она уже
// перенесена в export_tests.cpp), поэтому здесь — проверки на поддельном провайдере: снимок, заметки хранилища
// пачками, ожидание готовности «Плана» и облака, файлы облака по контейнерам, отмена скачивания.
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "parvane/sections/export_source.h"

using nlohmann::json;
using namespace parvane::sections::exportdata;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

namespace {

json node(const std::string &id, const std::string &kind, const std::string &name, const std::string &parent = {},
          bool trashed = false) {
    json n{{"id", id}, {"kind", kind}, {"name", name}, {"size", 5}, {"mime", ""}, {"mtime", 7},
           {"trashed", trashed}, {"trashTop", trashed}, {"trashedAt", 0}};
    if (!parent.empty()) n["parent"] = parent;
    if (kind == "file") n["blob"] = json{{"fileId", id + "-b"}};
    return n;
}

class Fake : public ExportHost {
public:
    int64_t clock = 0;
    int sleeps = 0;
    std::map<std::string, int> calls;
    std::vector<json> readTexts;
    json cloud;
    int cloudLoadingFor = 0; // столько первых ответов `parvaneCloudState` — `loading`
    json planner = json{{"status", "ready"}, {"raw", "{\"tasks\":[]}"}};
    json cachedPlanner;
    bool blobThrows = false;
    std::vector<json> cancels;

    std::optional<json> callParvane(const std::string &method, const json &args) override {
        ++calls[method];
        if (method == "parvaneCloudState") {
            if (cloudLoadingFor > 0) {
                --cloudLoadingFor;
                return json{{"status", "loading"}};
            }
            return cloud;
        }
        if (method == "parvaneCloudReadTexts") {
            readTexts.push_back(args);
            json out = json::array();
            for (const auto &n : args["nodes"]) {
                const auto id = n["id"].get<std::string>();
                if (id == "unreadable") out.push_back(json{{"id", id}, {"error", "not-found"}});
                else out.push_back(json{{"id", id}, {"text", "текст " + id}, {"fileId", id + "-b"}});
            }
            return out;
        }
        if (method == "parvanePlannerState") return planner;
        if (method == "parvanePlannerCachedState") return cachedPlanner;
        if (method == "parvaneExportSnapshot") {
            return json{{"self", "a@x"}, {"selfName", "А"},
                        {"chats", json::array({{{"address", "b@x"}, {"kind", "user"}, {"title", "Б"},
                                                {"messages", json::array({{{"uuid", "u1"}, {"from", "b@x"}, {"fromName", "Б"},
                                                                           {"isOutgoing", false}, {"ts", 100},
                                                                           {"replyTo", "u0"}, {"edited", true},
                                                                           {"content", {{"kind", "text"}, {"text", "привет"}}},
                                                                           {"reactions", json::array({{{"emoji", "👍"}, {"count", 2}}})}}})}}})},
                        {"contacts", json::array({{{"address", "b@x"}, {"name", "Б"}, {"isExplicit", true}}})}};
        }
        if (method == "parvaneCloudCancelDownload") {
            cancels.push_back(args);
            return json();
        }
        return json();
    }
    std::optional<parvane::sections::exportdata::ZipWriter::ChunkSource> blob(const std::string &method, const json &args) override {
        ++calls[method];
        if (blobThrows) throw std::runtime_error("оборвано");
        auto sent = std::make_shared<bool>(false);
        const auto data = method + ":" + args.dump();
        return [sent, data](std::string &chunk) {
            if (*sent) return false;
            *sent = true;
            chunk = data;
            return true;
        };
    }
    int64_t nowMs() override { return clock; }
    void sleepMs(int64_t ms) override {
        ++sleeps;
        clock += ms;
    }
};

json driveState(int notes) {
    json nodes = json::array({node("v", "folder", "Знания"), node("f", "folder", "Проекты", "v"),
                              node("pic", "file", "фото.png", "v"), node("old", "file", "старое.md", "v", true),
                              node("out", "file", "вне.md"), node("c1", "file", "Доска.canvas", "f"),
                              node("unreadable", "file", "битая.md", "v")});
    for (int i = 0; i < notes; ++i) nodes.push_back(node("n" + std::to_string(i), "file", "Заметка " + std::to_string(i) + ".MD", "v"));
    return json{{"status", "ready"}, {"rootId", "drive"},
                {"containers", json::array({{{"id", "drive"}, {"kind", "root"}, {"name", ""}, {"hasKey", true}},
                                            {{"id", "shared"}, {"kind", "shared"}, {"name", "Общая"}, {"hasKey", true}},
                                            {{"id", "inv"}, {"kind", "invite"}, {"name", "Приглашение"}, {"hasKey", true}},
                                            {{"id", "nokey"}, {"kind", "owned"}, {"name", "Без ключа"}, {"hasKey", false}}})},
                {"trees", {{"drive", {{"name", "", }, {"count", nodes.size()}, {"nodes", nodes}}},
                           {"shared", {{"name", "Общая"}, {"count", 1}, {"nodes", json::array({node("s1", "file", "отчёт.pdf")})}}},
                           {"inv", {{"name", "x"}, {"count", 1}, {"nodes", json::array({node("i1", "file", "чужое.pdf")})}}},
                           {"nokey", {{"name", "y"}, {"count", 1}, {"nodes", json::array({node("k1", "file", "закрытое.pdf")})}}}}}};
}

std::string drain(const parvane::sections::exportdata::ZipWriter::ChunkSource &next) {
    std::string out, chunk;
    while (next(chunk)) out += chunk;
    return out;
}

} // namespace

int main() {
    std::printf("=== export_source: источник выгрузки поверх провайдера ===\n");
    {
        Fake fake;
        const auto source = createProviderSource(fake, {"Диск"});
        const auto snap = source.snapshot();
        bool ok = snap && snap->self == "a@x" && snap->chats.size() == 1 && snap->contacts.size() == 1;
        if (ok) {
            const auto &m = snap->chats[0].messages.at(0);
            ok = m.uuid == "u1" && m.ts == 100 && m.replyTo == std::optional<std::string>("u0") && m.edited
                && m.content["text"] == "привет" && m.reactions && m.reactions->at(0).count == 2
                && snap->contacts[0].isExplicit;
        }
        check(ok, "снимок провайдера разбирается в структуру ядра");
    }
    {
        Fake fake;
        fake.cloud = driveState(45);
        const auto source = createProviderSource(fake, {"Диск"});
        const auto notes = source.notes();
        bool ok = fake.readTexts.size() == 2 && fake.readTexts[0]["nodes"].size() == 40
            && fake.readTexts[1]["nodes"].size() == 7 && fake.readTexts[0]["container"] == "drive";
        // Заметки и холсты хранилища, без корзины, без файлов вне хранилища, без непрочитанного
        ok = ok && notes.size() == 46;
        bool hasCanvas = false, hasOut = false, hasPic = false;
        for (const auto &n : notes) {
            hasCanvas = hasCanvas || (n.path == "Проекты/Доска.canvas" && n.text == "текст c1" && n.mtime == 7);
            hasOut = hasOut || n.path.find("вне") != std::string::npos;
            hasPic = hasPic || n.path.find("фото") != std::string::npos;
        }
        check(ok && hasCanvas && !hasOut && !hasPic, "заметки хранилища: пачками по 40, пути папок, холсты, без корзины и чужого");
        source.cloudFiles();
        check(fake.calls["parvaneCloudState"] == 1, "состояние облака читается один раз на выгрузку");
    }
    {
        Fake fake;
        fake.cloud = driveState(0);
        fake.cloudLoadingFor = 3;
        const auto source = createProviderSource(fake, {"Диск"});
        const auto files = source.cloudFiles();
        bool ok = fake.sleeps == 3 && fake.calls["parvaneCloudState"] == 4;
        std::vector<std::string> containers;
        for (const auto &f : files) containers.push_back(f.container);
        ok = ok && std::find(containers.begin(), containers.end(), "inv") == containers.end()
            && std::find(containers.begin(), containers.end(), "nokey") == containers.end()
            && std::find(containers.begin(), containers.end(), "shared") != containers.end();
        bool driveNamed = false;
        for (const auto &f : files) driveNamed = driveNamed || (f.container == "drive" && f.path.rfind("cloud/Диск/", 0) == 0);
        check(ok && driveNamed, "файлы облака: ждём готовности, без приглашений и без ключа, личный диск — под своим названием");
    }
    {
        Fake fake;
        fake.cloud = json{{"status", "ready"}, {"containers", json::array()}, {"trees", json::object()}};
        const auto source = createProviderSource(fake, {"Диск"});
        check(source.notes().empty() && source.cloudFiles().empty(), "личного диска нет — заметок и файлов нет");
    }
    {
        Fake fake;
        const auto source = createProviderSource(fake, {"Диск"});
        check(source.planner() == std::optional<std::string>("{\"tasks\":[]}") && fake.sleeps == 0, "«План» готов — его сырой JSON");
    }
    {
        Fake fake;
        fake.planner = json{{"status", "loading"}};
        fake.cachedPlanner = json{{"tasks", json::array()}};
        const auto source = createProviderSource(fake, {"Диск"});
        const auto raw = source.planner();
        check(raw == std::optional<std::string>("{\"tasks\":[]}") && fake.sleeps == 60 && fake.clock == 30000,
              "движок «Плана» не поднялся за 30 с — последний сохранённый снимок");
    }
    {
        Fake fake;
        fake.planner = json{{"status", "no-key"}};
        const auto source = createProviderSource(fake, {"Диск"});
        check(!source.planner() && fake.calls["parvanePlannerCachedState"] == 1, "«План» без ключа и без снимка — нет данных");
    }
    {
        Fake fake;
        const auto source = createProviderSource(fake, {"Диск"});
        const auto media = source.media("f1");
        const auto blob = source.cloudBlob(ExportCloudFile{"drive", "n1", "cloud/Диск/a", 1, std::nullopt});
        check(media && drain(*media) == "parvaneExportMedia:{\"fileId\":\"f1\"}" && blob
                  && drain(*blob).find("\"transferId\":\"export-0-1\"") != std::string::npos,
              "вложение и файл облака — методами провайдера, у скачивания свой transferId");
    }
    {
        Fake fake;
        fake.blobThrows = true;
        bool isCanceled = false;
        const auto source = createProviderSource(fake, {"Диск"}, [] { return true; });
        try {
            source.cloudBlob(ExportCloudFile{"drive", "n1", "p", 1, std::nullopt});
        } catch (const ExportError &e) {
            isCanceled = e.code() == ExportErrorCode::Canceled;
        }
        check(isCanceled && fake.cancels.size() == 1 && fake.cancels[0]["transferId"] == "export-0-1",
              "отмена посреди скачивания: провайдеру — отмена передачи, выгрузке — canceled");
    }
    {
        Fake fake;
        fake.blobThrows = true;
        bool isOther = false;
        const auto source = createProviderSource(fake, {"Диск"});
        try {
            source.cloudBlob(ExportCloudFile{"drive", "n1", "p", 1, std::nullopt});
        } catch (const ExportError &) {
        } catch (const std::runtime_error &) {
            isOther = true;
        }
        check(isOther && fake.cancels.empty(), "сбой без отмены — исходная ошибка, отмены передачи нет");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
