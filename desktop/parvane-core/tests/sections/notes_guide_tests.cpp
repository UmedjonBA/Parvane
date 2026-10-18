// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesGuide.test.ts`.
#include <algorithm>
#include <memory>
#include <set>

#include "notes_test_util.h"
#include "parvane/sections/notes_guide.h"
#include "parvane/sections/notes_model.h"
#include "parvane/sections/notes_tasks.h"
#include "parvane/sections/planner_quick.h"

using namespace parvane::sections;
using namespace parvane::sections::notes;

// Понедельник, 12 октября 2026
static planner::QuickContext ctx() {
    planner::QuickContext c;
    c.today = "2026-10-12";
    c.nowMinutes = 9 * 60;
    c.dayStart = 8 * 60;
    c.dayEnd = 22 * 60;
    return c;
}
static const std::vector<GuideLang> LANGS = {"ru", "en"};
static const std::vector<std::string> VAULT_NAMES = {"Знания", "Knowledge"};
static constexpr size_t BODY_MAX_CHARS = 4200;
static constexpr size_t BODY_MAX_LINES = 48;
// Заметки, которые обязаны ссылаться на все остальные
static const std::vector<std::string> HUBS = {"overview", "connections"};

static cloud::CloudNode folder(const std::string &id, const std::string &name,
                               const std::optional<std::string> &parent = std::nullopt, bool trashed = false) {
    return cloudNode(id, name, parent, "folder", trashed);
}
static cloud::CloudNode file(const std::string &id, const std::string &name,
                             const std::optional<std::string> &parent = std::nullopt, bool trashed = false) {
    return cloudNode(id, name, parent, "file", trashed);
}

struct PlanPatch {
    std::optional<GuideDrive> drive;
    std::optional<GuideLang> lang;
    std::optional<std::string> vaultName;
    std::optional<GuideMode> mode;
    std::function<std::string()> makeId;
};

static PlanPatch onDrive(GuideDrive drive) {
    PlanPatch patch;
    patch.drive = drive;
    return patch;
}

static GuidePlan plan(const std::vector<cloud::CloudNode> &nodes, const PlanPatch &patch = {}) {
    auto seq = std::make_shared<int>(0);
    GuidePlanInput in;
    in.drive = patch.drive.value_or(GuideDrive::Synced);
    in.nodes = nodes;
    in.lang = patch.lang.value_or("ru");
    in.vaultName = patch.vaultName.value_or("Знания");
    in.vaultNames = VAULT_NAMES;
    in.mode = patch.mode.value_or(GuideMode::Auto);
    in.makeId = patch.makeId ? patch.makeId : std::function<std::string()>([seq] { return "random-" + std::to_string(++*seq); });
    return planGuide(in);
}

static std::vector<std::string> splitLines(const std::string &s) {
    std::vector<std::string> out;
    size_t start = 0;
    while (true) {
        const size_t at = s.find('\n', start);
        if (at == std::string::npos) {
            out.push_back(s.substr(start));
            return out;
        }
        out.push_back(s.substr(start, at - start));
        start = at + 1;
    }
}

static size_t utf16Length(const std::string &s) {
    size_t n = 0;
    for (size_t i = 0; i < s.size(); ++i) {
        const auto c = static_cast<unsigned char>(s[i]);
        if ((c & 0xC0) == 0x80) continue;
        n += (c >= 0xF0) ? 2 : 1;
    }
    return n;
}

static bool hasStr(const std::vector<std::string> &v, const std::string &s) { return std::find(v.begin(), v.end(), s) != v.end(); }

static std::vector<std::string> keysOf(const std::vector<GuideNoteWrite> &notes) {
    std::vector<std::string> out;
    for (const auto &n : notes) out.push_back(n.key);
    return out;
}

static void testTexts() {
    std::printf("справка: тексты\n");
    check(getGuideLang(std::string("ru")) == "ru" && getGuideLang(std::string("ru-RU")) == "ru"
              && getGuideLang(std::string("en")) == "en" && getGuideLang(std::string("de")) == "en"
              && getGuideLang(std::nullopt) == "en",
          "язык справки — по языку интерфейса");
    {
        std::vector<std::string> ids = {kVaultNodeId, guideFolderNodeId(), guideMarkerNodeId()};
        for (const auto &n : buildGuide("ru").notes) ids.push_back(n.nodeId);
        bool hexes = true;
        for (const auto &id : ids) {
            hexes = hexes && id.size() == 32
                && std::all_of(id.begin(), id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
        }
        check(hexes, "идентификаторы узлов — по 16 байт шестнадцатеричными цифрами");
        check(std::set<std::string>(ids.begin(), ids.end()).size() == ids.size(), "идентификаторы узлов разные");
        check(guideNoteNodeId(1) == buildGuide("en").notes[0].nodeId, "узел заметки — по номеру");
    }
    {
        const auto ru = buildGuide("ru");
        const auto en = buildGuide("en");
        bool same = ru.notes.size() == en.notes.size();
        for (size_t i = 0; same && i < ru.notes.size(); ++i) {
            same = ru.notes[i].key == en.notes[i].key && ru.notes[i].nodeId == en.notes[i].nodeId;
        }
        check(same && ru.notes.size() >= 9 && ru.folderName != en.folderName,
              "наборы на двух языках совпадают по составу, порядку и узлам");
    }
    for (const auto &lang : LANGS) {
        std::printf(" %s\n", lang.c_str());
        const auto guide = buildGuide(lang);
        std::vector<std::string> titles;
        std::vector<NoteSource> sources;
        for (const auto &n : guide.notes) {
            titles.push_back(n.title);
            sources.push_back({n.nodeId, n.title, guide.folderName, n.text, 0});
        }
        const NotesIndex index(sources);
        const auto titleOf = [&](const std::string &key) {
            for (const auto &n : guide.notes) {
                if (n.key == key) return n.title;
            }
            return std::string();
        };
        {
            std::set<std::string> lower;
            bool fileSafe = true;
            for (const auto &t : titles) {
                lower.insert(normalizeNoteTitle(t));
                fileSafe = fileSafe && t.find_first_of("\\/:*?\"<>|") == std::string::npos;
                fileSafe = fileSafe && !t.empty() && t.front() != ' ' && t.back() != ' ';
            }
            check(lower.size() == titles.size() && fileSafe && guide.overviewTitle == titleOf("overview"),
                  lang + ": названия разные и годятся в имена файлов");
        }
        {
            bool ok = true;
            for (const auto &n : guide.notes) {
                const auto lines = splitLines(n.text);
                ok = ok && lines[0] == "# " + n.title && lines.size() <= BODY_MAX_LINES && utf16Length(n.text) <= BODY_MAX_CHARS
                    && !n.text.empty() && n.text.back() == '\n';
                if (!ok) {
                    std::printf("    — %s\n", n.title.c_str());
                    break;
                }
            }
            check(ok, lang + ": каждая заметка начинается заголовком с названием и умещается на экран-два");
        }
        {
            bool ok = index.unresolved().empty();
            for (const auto &n : guide.notes) {
                for (const auto &link : parseNote(n.text).links) ok = ok && hasStr(titles, link);
            }
            check(ok, lang + ": каждая ссылка ведёт на заметку справки того же языка");
        }
        {
            const auto overview = titleOf("overview");
            bool ok = true;
            for (const auto &n : guide.notes) {
                if (n.key != "overview") ok = ok && hasStr(parseNote(n.text).links, overview);
            }
            for (const auto &hub : HUBS) {
                std::vector<std::string> links;
                for (const auto &n : guide.notes) {
                    if (n.key == hub) links = parseNote(n.text).links;
                }
                for (const auto &t : titles) {
                    if (t != titleOf(hub)) ok = ok && hasStr(links, t);
                }
            }
            for (const auto &n : index.notes()) ok = ok && !n.linkedIds.empty() && !index.backlinks(n.id).empty();
            check(ok, lang + ": каждая заметка ссылается на «Обзор», а «Обзор» и «Связи» — на все остальные");
        }
        {
            bool ok = true;
            bool anyTasks = false;
            for (const auto &n : guide.notes) {
                const auto parsed = parseNote(n.text);
                ok = ok && parsed.tags.size() == 1;
                for (const auto &t : parsed.tasks) ok = ok && !t.isDone && !t.marker;
                anyTasks = anyTasks || !parsed.tasks.empty();
            }
            check(ok && anyTasks, lang + ": у каждой заметки один тег; пункты с галочками — без меток");
        }
        {
            bool ok = true;
            for (const auto &n : guide.notes) {
                const auto planned = planNoteTasks(n.text, ctx());
                ok = ok && planned.tasks.empty() && planned.text == n.text;
            }
            check(ok, lang + ": не заводит задач в «Плане»: сохранение текста ничего не планирует и не меняет");
        }
        std::string all;
        for (const auto &n : guide.notes) all += n.text + "\n";
        {
            bool ok = true;
            for (const auto &sample : guide.datedSamples) {
                ok = ok && all.find("`- [ ] " + sample + "`") != std::string::npos;
                const auto planned = planNoteTasks("- [ ] " + sample, ctx(), [] { return std::string("abcde"); });
                ok = ok && planned.tasks.size() == 1 && (planned.tasks[0].day || planned.tasks[0].due);
            }
            check(ok, lang + ": примеры пунктов с датой стоят в тексте кодом и разбираются как задачи");
        }
        {
            for (const auto &sample : guide.quickSamples) {
                auto c = ctx();
                c.lang = lang;
                const auto draft = planner::parseQuickInput(sample.text, c);
                check(all.find("`" + sample.text + "`") != std::string::npos && draft.kind == sample.kind && !draft.error,
                      lang + ": пример ввода «" + sample.text + "» → " + sample.kind + " (получено " + draft.kind + ")");
            }
        }
    }
}

static void testPlan() {
    std::printf("справка: решение о создании\n");
    const auto guide = buildGuide("ru");
    std::vector<std::string> keys;
    for (const auto &n : guide.notes) keys.push_back(n.key);

    check(!plan({}, onDrive(GuideDrive::Unknown)).isWrite && plan({}, onDrive(GuideDrive::Unknown)).reason == GuideSkipReason::DriveUnknown,
          "диск не сверен с сервером — ничего не создаётся");
    {
        PlanPatch p;
        p.drive = GuideDrive::Unknown;
        p.mode = GuideMode::Restore;
        const auto r = plan({folder("v", "Знания")}, p);
        check(!r.isWrite && r.reason == GuideSkipReason::DriveUnknown, "диск не сверен — и восстановление не делается");
    }
    const std::vector<GuidePlan> fresh = {plan({}, onDrive(GuideDrive::None)), plan({file("other", "отчёт.pdf")})};
    for (const auto &r : fresh) {
        bool ok = r.isWrite && r.isFreshVault && r.vaultId == kVaultNodeId && r.folderId == guideFolderNodeId()
            && r.skipped.empty() && r.hasMarkerWrite;
        ok = ok && r.folders == std::vector<GuideFolderWrite>{{kVaultNodeId, "Знания", std::nullopt},
                                                             {guideFolderNodeId(), guide.folderName, kVaultNodeId}};
        bool notes = r.notes.size() == guide.notes.size();
        for (size_t i = 0; notes && i < r.notes.size(); ++i) {
            notes = r.notes[i].key == guide.notes[i].key && r.notes[i].nodeId == guide.notes[i].nodeId;
        }
        check(ok && notes, "новое хранилище: папка хранилища, папка справки, все заметки и отметка — с постоянными узлами");
    }
    {
        PlanPatch a;
        a.drive = GuideDrive::None;
        a.makeId = [] { return std::string("a"); };
        PlanPatch b;
        b.drive = GuideDrive::None;
        b.makeId = [] { return std::string("b"); };
        b.lang = "en";
        b.vaultName = "Knowledge";
        const auto first = plan({}, a);
        const auto second = plan({}, b);
        bool ok = first.folders.size() == second.folders.size() && first.notes.size() == second.notes.size();
        for (size_t i = 0; ok && i < first.folders.size(); ++i) {
            ok = first.folders[i].id == second.folders[i].id && first.folders[i].parent == second.folders[i].parent;
        }
        for (size_t i = 0; ok && i < first.notes.size(); ++i) ok = first.notes[i].nodeId == second.notes[i].nodeId;
        check(ok, "два устройства в один момент планируют одни и те же узлы");
    }
    {
        const auto r = plan({folder("v", "Knowledge"), file("n1", "Сервер.md", "v"), folder("d", "Daily", "v")});
        check(r.isWrite && !r.isFreshVault && r.vaultId == "v" && r.folderId == guideFolderNodeId() && r.skipped.empty()
                  && r.hasMarkerWrite
                  && r.folders == std::vector<GuideFolderWrite>{{guideFolderNodeId(), guide.folderName, std::string("v")}}
                  && r.notes.size() == guide.notes.size(),
              "хранилище с заметками и без отметки: справка создаётся в нём один раз");
    }
    {
        const std::vector<cloud::CloudNode> marked = {folder("v", "Знания"), file(guideMarkerNodeId(), kGuideMarkerName, "v")};
        const auto r = plan(marked);
        check(!r.isWrite && r.reason == GuideSkipReason::HasMarker, "отметка есть — сама справка больше не создаётся");
        auto withTrash = marked;
        withTrash.push_back(folder(guideFolderNodeId(), guide.folderName, "v", true));
        check(plan(withTrash).reason == GuideSkipReason::HasMarker && !plan(withTrash).isWrite,
              "папка справки в корзине, отметка на месте — не создаётся");
        check(!plan({folder("v", "Знания"), file(guideMarkerNodeId(), kGuideMarkerName, "v", true)}).isWrite,
              "отметка в корзине — тоже «уже была»");
        check(!plan({folder("v", "Знания"), file("m2", kGuideMarkerName, "v")}).isWrite,
              "отметка под другим узлом — тоже «уже была»");
        check(!hasGuideMarker({folder("x", "Прочее"), file("m2", kGuideMarkerName, "x")}, VAULT_NAMES),
              "отметка вне хранилища не считается");
    }
    {
        const auto a = plan({folder("v", "Знания", std::nullopt, true)});
        const auto b = plan({folder(kVaultNodeId, "Архив", std::nullopt, true)});
        check(!a.isWrite && a.reason == GuideSkipReason::VaultTrashed && !b.isWrite && b.reason == GuideSkipReason::VaultTrashed,
              "хранилище убрано в корзину — справка сама не создаёт новое");
    }
    {
        const auto r = plan({folder("v", "Знания"), folder("f", "Работа", "v"), file("mine", "обзор.md", "f")});
        std::vector<std::string> rest;
        for (const auto &k : keys) {
            if (k != "overview") rest.push_back(k);
        }
        check(r.skipped == std::vector<std::string>{"overview"} && keysOf(r.notes) == rest,
              "заметка пользователя с названием из справки не перезаписывается");
        const auto free = plan({folder("v", "Знания"), file("gone", "Обзор.md", "v", true), file("out", "Чаты.md")});
        check(free.skipped.empty(), "заметка с тем же названием в корзине либо вне хранилища не мешает");
    }
    {
        const auto r = plan({folder("v", "Знания"), folder("mine", guide.folderName, "v")});
        check(r.folders == std::vector<GuideFolderWrite>{{guideFolderNodeId(), guide.folderName + " (2)", std::string("v")}},
              "папка пользователя с названием справки не сливается с ней");
    }
    {
        const auto &first = guide.notes[0];
        const auto &second = guide.notes[1];
        const auto r = plan({folder("v", "Знания"), folder(guideFolderNodeId(), guide.folderName, "v"),
                             file(first.nodeId, first.title + ".md", guideFolderNodeId()),
                             file(second.nodeId, second.title + ".md", guideFolderNodeId(), true)});
        check(r.folders.empty() && r.skipped == std::vector<std::string>{first.key, second.key}
                  && r.notes.size() == guide.notes.size() - 2 && r.hasMarkerWrite,
              "прерванное создание продолжается: дописывается только недостающее");
    }
    {
        const auto r = plan({folder("v", "Знания"), folder(guideFolderNodeId(), guide.folderName, "v", true)});
        check(r.isWrite && r.folders.empty() && r.notes.empty() && r.hasMarkerWrite, "папку справки удалили до отметки — ставится только отметка");
    }
    {
        const auto marker = file(guideMarkerNodeId(), kGuideMarkerName, "v");
        const auto &overview = guide.notes[0];
        PlanPatch restore;
        restore.mode = GuideMode::Restore;
        const auto deleted = plan({folder("v", "Знания"), marker, folder(guideFolderNodeId(), guide.folderName, "v", true),
                                   file(overview.nodeId, overview.title + ".md", guideFolderNodeId(), true),
                                   file("mine", "Чаты.md", "v")},
                                  restore);
        bool noIds = true;
        for (const auto &n : deleted.notes) noIds = noIds && !n.nodeId;
        check(deleted.isWrite && !deleted.isFreshVault && deleted.folderId == "random-1" && !deleted.hasMarkerWrite
                  && deleted.skipped == std::vector<std::string>{"chats"}
                  && deleted.folders == std::vector<GuideFolderWrite>{{"random-1", guide.folderName, std::string("v")}}
                  && noIds && deleted.notes.size() == guide.notes.size() - 1,
              "восстановление по кнопке: новая папка и недостающие заметки, существующие не трогаются");

        std::vector<cloud::CloudNode> partialNodes = {folder("v", "Знания"), marker, folder(guideFolderNodeId(), "Моя справка", "v")};
        for (size_t i = 1; i < guide.notes.size(); ++i) {
            partialNodes.push_back(file(guide.notes[i].nodeId, guide.notes[i].title + ".md", guideFolderNodeId()));
        }
        const auto partial = plan(partialNodes, restore);
        check(partial.folderId == guideFolderNodeId() && partial.folders.empty() && !partial.hasMarkerWrite
                  && keysOf(partial.notes) == std::vector<std::string>{"overview"},
              "папка на месте, удалена одна заметка — дописывается она одна, в ту же папку");

        std::vector<cloud::CloudNode> fullNodes = {folder("v", "Знания"), marker, folder(guideFolderNodeId(), guide.folderName, "v")};
        for (const auto &n : guide.notes) fullNodes.push_back(file(n.nodeId, n.title + ".md", guideFolderNodeId()));
        const auto full = plan(fullNodes, restore);
        check(!full.isWrite && full.reason == GuideSkipReason::Complete, "всё на месте — делать нечего");
    }
    {
        PlanPatch restore;
        restore.mode = GuideMode::Restore;
        const auto r = plan({folder("old", "Знания", std::nullopt, true)}, restore);
        check(r.folders == std::vector<GuideFolderWrite>{{"random-1", "Знания", std::nullopt},
                                                        {"random-2", guide.folderName, std::string("random-1")}}
                  && !r.isFreshVault && r.hasMarkerWrite && r.notes.size() == guide.notes.size(),
              "восстановление без хранилища заводит его заново");
    }
    {
        const auto marker = nlohmann::json::parse(buildGuideMarker("ru", 1760000000000));
        check(marker == nlohmann::json{{"version", kGuideVersion}, {"createdAt", 1760000000000LL}, {"lang", "ru"}}
                  && buildGuideMarker("ru", 1).back() == '\n',
              "отметка — JSON с версией, временем и языком");
        check(kGuideMarkerName.size() < 3 || kGuideMarkerName.substr(kGuideMarkerName.size() - 3) != ".md", "отметка — не заметка");
    }
    {
        const auto &overview = guide.notes[0];
        const std::vector<GuideNoteRef> byNode = {{"x", "Сервер"}, {overview.nodeId, "Переименовано"}};
        const std::vector<GuideNoteRef> byTitle = {{"x", "overview"}};
        const std::vector<GuideNoteRef> none = {{"x", "Сервер"}};
        check(findGuideOverview(byNode) == std::optional<size_t>(1),
              "«Обзор» находится по постоянному узлу");
        check(findGuideOverview(byTitle) == std::optional<size_t>(0), "«Обзор» находится по названию на любом языке");
        check(!findGuideOverview(none), "«Обзора» нет — не найдено");
    }
}

int main() {
    testTexts();
    testPlan();
    return finish();
}
