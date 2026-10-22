// Parvane fork (spec 029, фаза 4): тесты раздела «Облако» — порт web `cloud/cloudModel.test.ts` 1:1.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"

using namespace parvane::sections::cloud;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static CloudNode node(const std::string &id, const std::string &kind, const std::string &name,
    std::optional<std::string> parent = {}, const std::function<void(CloudNode &)> &extra = {}) {
    CloudNode n;
    n.id = id;
    n.kind = kind;
    n.name = name;
    n.parent = parent;
    n.size = kind == "file" ? 10 : 0;
    if (extra) extra(n);
    return n;
}

static std::vector<std::string> ids(const std::vector<CloudNode> &nodes) {
    std::vector<std::string> out;
    for (const auto &n : nodes) out.push_back(n.id);
    return out;
}

static std::vector<std::string> names(const std::vector<CloudNode> &nodes) {
    std::vector<std::string> out;
    for (const auto &n : nodes) out.push_back(n.name);
    return out;
}

using V = std::vector<std::string>;
constexpr int64_t DAY = 24LL * 60 * 60 * 1000;

int main() {
    std::printf("=== parvane-core sections: cloud model ===\n");

    const std::vector<CloudNode> TREE = {
        node("a", "folder", "Документы"),
        node("b", "folder", "Архив", "a"),
        node("c", "file", "отчёт.pdf", "b", [](CloudNode &n) { n.size = 300; n.mtime = 5; }),
        node("d", "file", "Фото 10.jpg", {}, [](CloudNode &n) { n.size = 20; n.mtime = 9; }),
        node("e", "file", "фото 2.jpg", {}, [](CloudNode &n) { n.size = 50; n.mtime = 1; }),
        node("f", "folder", "Старое", {}, [](CloudNode &n) { n.trashed = true; n.trashTop = true; n.trashedAt = 7; }),
        node("g", "file", "черновик.txt", "f", [](CloudNode &n) { n.trashed = true; n.size = 7; }),
        node("h", "file", "удалённый.txt", "a",
            [](CloudNode &n) { n.trashed = true; n.trashTop = true; n.trashedAt = 9; n.size = 3; }),
    };

    // облако: модель дерева
    {
        std::string ya127, ya128;
        for (int i = 0; i < 127; ++i) ya127 += "я";
        ya128 = ya127 + "я";
        check(!validateName("отчёт.pdf") && validateName("   ") == NameError::Empty
                && validateName("a/b") == NameError::BadChars && validateName("a\\b") == NameError::BadChars
                && validateName("a\x01" "b") == NameError::BadChars && validateName("..") == NameError::Reserved
                && validateName(ya128) == NameError::TooLong && !validateName(ya127),
            "проверка имени совпадает с движком");
        check(nameErrorName(NameError::TooLong) == std::string("too-long"), "код ошибки имени — как в web");
    }
    check(freeName({}, "отчёт.pdf") == "отчёт.pdf" && freeName({"отчёт.pdf"}, "отчёт.pdf") == "отчёт (2).pdf"
            && freeName({"отчёт.pdf", "отчёт (2).pdf"}, "отчёт.pdf") == "отчёт (3).pdf"
            && freeName({"Папка"}, "Папка") == "Папка (2)" && freeName({".profile"}, ".profile") == ".profile (2)",
        "свободное имя получает номер перед расширением");
    {
        auto tree = TREE;
        tree.push_back(node("s", "file", ".parvane-guide", "a", [](CloudNode &n) { n.size = 4; }));
        const auto stats = folderStats(tree);
        bool same = true;
        for (const auto &folder : tree) {
            if (!folder.isFolder()) continue;
            const FolderStats expected{static_cast<int>(childrenOf(listedNodes(tree), folder.id).size()),
                sizeOf(tree, folder.id)};
            const auto it = stats.find(folder.id);
            const FolderStats got = it != stats.end() ? it->second : FolderStats{};
            if (!(got == expected)) same = false;
        }
        check(same && stats.at("a") == FolderStats{1, 307} && stats.at("b") == FolderStats{1, 300}
                && stats.at("f") == FolderStats{0, 7},
            "счётчики папок одним проходом совпадают с подсчётом по каждой");
    }
    {
        auto sub = ids(subtreeOf(TREE, "a"));
        std::sort(sub.begin(), sub.end());
        check(ids(childrenOf(TREE)) == V{"a", "d", "e"} && ids(childrenOf(TREE, "a")) == V{"b"}
                && namesIn(TREE, std::nullopt, "d") == V{"Документы", "фото 2.jpg"}
                && names(pathOf(TREE, "c")) == V{"Документы", "Архив", "отчёт.pdf"} && pathOf(TREE).empty()
                && sub == V{"a", "b", "c", "h"} && sizeOf(TREE, "a") == 303,
            "содержимое папки, путь и поддерево без корзины");
    }
    check(!canMoveInto(TREE, {"a"}, "a") && !canMoveInto(TREE, {"a"}, "b") && !canMoveInto(TREE, {"d"}, "c")
            && !canMoveInto(TREE, {"d"}, "f") && canMoveInto(TREE, {"d", "e"}, "b") && canMoveInto(TREE, {"b"}),
        "перемещение: не в себя, не во вложенную, не в файл и не в корзину");
    {
        const auto root = childrenOf(TREE);
        check(names(sortNodes(root, {SortKey::Name, false})) == V{"Документы", "фото 2.jpg", "Фото 10.jpg"}
                && ids(sortNodes(root, {SortKey::Name, true})) == V{"a", "d", "e"}
                && ids(sortNodes(root, {SortKey::Size, true})) == V{"a", "e", "d"}
                && ids(sortNodes(root, {SortKey::Date, false})) == V{"a", "e", "d"},
            "сортировка держит папки выше файлов и считает числа в именах");
        // Дополнительно (приближение Intl.Collator): регистр слабее букв, строчная раньше прописной
        check(compareNames("б", "А") > 0 && compareNames("а", "А") < 0 && compareNames("ёлка", "елка") > 0
                && compareNames("елка", "ёж") > 0 && compareNames("файл 9", "файл 10") < 0,
            "сравнение имён: буквы важнее регистра и «ё», числа по значению");
    }
    check(ids(searchNodes(TREE, "ФОТО")) == V{"d", "e"} && ids(searchNodes(TREE, "отч")) == V{"c"}
            && searchNodes(TREE, "черновик").empty() && searchNodes(TREE, "  ").empty(),
        "поиск идёт по всему диску без учёта регистра и мимо корзины");
    check(ids(trashOf(TREE)) == V{"h", "f"} && usageOf(TREE) == Usage{380, 10},
        "корзина показывает положенное явно, место считает с вложенным");
    {
        const int64_t now = 100 * DAY;
        auto trashed = [](int64_t at, bool top = true) {
            return [=](CloudNode &n) { n.trashed = true; n.trashTop = top; n.trashedAt = at; };
        };
        const std::vector<CloudNode> tree = {
            node("live", "file", "живой.txt"),
            node("old", "folder", "Старая", {}, trashed(now - 31 * DAY)),
            node("inside", "file", "внутри.txt", "old", trashed(now - 31 * DAY, false)),
            node("edge", "file", "ровно.txt", {}, trashed(now - 30 * DAY)),
            node("fresh", "file", "свежий.txt", {}, trashed(now - 29 * DAY)),
            node("later", "file", "часы вперёд.txt", {}, trashed(now + DAY)),
            node("unknown", "file", "без времени.txt", {}, trashed(0)),
            node("back", "file", "восстановлен.txt", {}, [&](CloudNode &n) { n.trashedAt = now - 40 * DAY; }),
        };
        check(ids(expiredTrashOf(tree, now)) == V{"old", "edge"} && ids(expiredTrashOf(tree, now - DAY)) == V{"old"}
                && ids(expiredTrashOf(tree, now, DAY)) == V{"old", "edge", "fresh"} && kTrashLifetimeMs == 30 * DAY,
            "срок корзины: стирается пролежавшее 30 дней, вложенное — вместе с папкой");
    }
    {
        const int64_t now = 100 * DAY;
        auto ago = [&](int64_t ms) {
            return node("x", "file", "x", {}, [&](CloudNode &n) {
                n.trashed = true;
                n.trashTop = true;
                n.trashedAt = now - ms;
            });
        };
        const auto noTime = node("y", "file", "y", {}, [](CloudNode &n) { n.trashed = true; n.trashTop = true; });
        check(trashDaysLeft(ago(0), now) == 30 && trashDaysLeft(ago(1), now) == 30
                && trashDaysLeft(ago(DAY), now) == 29 && trashDaysLeft(ago(29 * DAY + 1), now) == 1
                && trashDaysLeft(ago(30 * DAY), now) == 0 && trashDaysLeft(ago(45 * DAY), now) == 0
                && trashDaysLeft(ago(-2 * DAY), now) == 30 && trashDaysLeft(noTime, now) == 30,
            "срок корзины: сколько дней осталось");
    }
    check(kindOfFile("image/png", "a") == FileKind::Photo && kindOfFile("", "снимок.JPG") == FileKind::Photo
            && kindOfFile("image/svg+xml", "a.svg") == FileKind::Text && kindOfFile("video/mp4", "a") == FileKind::Video
            && kindOfFile("application/octet-stream", "a.mp3") == FileKind::Audio
            && kindOfFile("application/pdf", "a") == FileKind::Pdf && kindOfFile("", "a.PDF") == FileKind::Pdf
            && kindOfFile("application/zip", "a.zip") == FileKind::Other,
        "вид файла по типу и расширению");
    {
        bool allText = true;
        for (const char *name : {"заметка.txt", "Как пользоваться.md", "Граф связей.canvas", "data.JSON",
                 "таблица.csv", "server.log", "main.rs", "app.tsx", "config.yaml", "run.sh"}) {
            if (kindOfFile("", name) != FileKind::Text) allText = false;
        }
        bool allOther = true;
        for (const char *name : {"деталь.3mf", "a.stl", "a.docx", "a.xlsx", "a.bin", "без расширения"}) {
            if (kindOfFile("application/octet-stream", name) != FileKind::Other) allOther = false;
        }
        check(allText && kindOfFile("text/plain", "README") == FileKind::Text
                && kindOfFile("text/x-python; charset=utf-8", "script") == FileKind::Text
                && kindOfFile("application/json", "ответ") == FileKind::Text
                && kindOfFile("video/mp2t", "index.ts") == FileKind::Text
                && kindOfFile("text/plain", "a.png") == FileKind::Photo
                && kindOfFile("text/plain", "a.pdf") == FileKind::Pdf && allOther,
            "текстовые файлы: заметки, данные и код — по расширению либо типу");
        check(fileKindName(FileKind::Pdf) == std::string("pdf"), "имя вида файла — как в web");
    }
    check(fileTypeLabel("деталь.3mf") == "3MF" && fileTypeLabel("архив.tar.gz") == "GZ"
            && fileTypeLabel("схема.чертёж") == "ЧЕРТЁЖ" && fileTypeLabel("без расширения").empty()
            && fileTypeLabel(".скрытый").empty() && fileTypeLabel("a.слишкомдлинное").empty()
            && fileTypeLabel("a.b c").empty(),
        "подпись типа файла — расширение прописными");
    {
        auto bytes = [](std::initializer_list<int> list) {
            std::string s;
            for (const int b : list) s.push_back(static_cast<char>(b));
            return s;
        };
        const std::string utf8 = "Привет, мир\n- [ ] пункт";
        check(decodeTextPreview(utf8) == utf8 && decodeTextPreview(bytes({0xef, 0xbb, 0xbf, 0x41})) == "A"
                && decodeTextPreview(bytes({0xff, 0xfe, 0x1f, 0x04, 0x40, 0x04})) == "Пр"
                && decodeTextPreview(bytes({0xfe, 0xff, 0x04, 0x1f})) == "П"
                && decodeTextPreview(bytes({0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2})) == "Привет"
                && !decodeTextPreview(bytes({0x50, 0x4b, 0x03, 0x04, 0x00, 0x00}))
                && decodeTextPreview(std::string()) == "",
            "текст для просмотра: UTF-8, UTF-16 с меткой, windows-1251; двоичное — нет");
    }

    // облако: служебные файлы Parvane
    const std::vector<CloudNode> VAULT = {
        node("v", "folder", "Знания"),
        node("m", "file", ".parvane-guide.json", "v", [](CloudNode &n) { n.size = 40; }),
        node("n", "file", "Идея.md", "v"),
        node("p", "folder", ".parvane-папка", "v"),
        node("q", "file", ".PARVANE-other.json"),
        node("r", "file", "parvane-заметки.txt"),
        node("t", "file", ".parvane-old.json", "v",
            [](CloudNode &n) { n.trashed = true; n.trashTop = true; n.trashedAt = 3; n.size = 5; }),
    };
    {
        std::vector<CloudNode> service;
        for (const auto &n : VAULT) {
            if (isServiceNode(n)) service.push_back(n);
        }
        check(ids(service) == V{"m", "q", "t"}, "служебный — файл с именем на `.parvane-`; папка и обычное имя — нет");
    }
    {
        const auto listed = listedNodes(VAULT);
        check(ids(childrenOf(listed, "v")) == V{"n", "p"} && ids(childrenOf(listed)) == V{"v", "r"}
                && ids(searchNodes(listed, "parvane")) == V{"p", "r"} && searchNodes(listed, "guide").empty(),
            "в списке папки, поиске и счётчике служебных файлов нет");
    }
    {
        const auto taken = namesIn(VAULT, "v");
        check(ids(trashOf(VAULT)) == V{"t"} && usageOf(VAULT) == Usage{75, 5}
                && std::find(taken.begin(), taken.end(), ".parvane-guide.json") != taken.end(),
            "корзина, квота и занятые имена считают служебные файлы как обычные");
    }
    // В web — тот же массив (проверка идентичности); в C++ — копия с тем же содержимым
    check(ids(listedNodes(TREE)) == ids(TREE), "без служебных файлов список возвращается тем же массивом");

    // JSON узла — как у движка/web
    {
        const auto j = nlohmann::json::parse(R"({"id":"n1","kind":"file","parent":"","name":"a.txt","size":3,
            "mime":"text/plain","mtime":1700000000000,"trashed":false,"trashTop":false,"trashedAt":0,
            "blob":{"fileId":"b1","size":3}})");
        const auto n = j.get<CloudNode>();
        const nlohmann::json back = n;
        check(n.id == "n1" && !n.parent && n.mtime == 1700000000000 && n.blob && (*n.blob)["fileId"] == "b1"
                && !back.contains("parent") && back["trashTop"] == false && back["blob"]["size"] == 3,
            "узел читается из JSON движка и пишется обратно (пустой parent — корень)");
    }

    // Ревью безопасности 21 окт 2026: дерево совместной папки правит любой редактор — цепочка и цикл из 30 000
    // папок не вешают показ (прежде размер поднимался по всей цепочке предков — квадрат)
    {
        constexpr int kDeep = 30000;
        std::vector<CloudNode> chain;
        for (int i = 0; i < kDeep; ++i) {
            CloudNode n;
            n.id = "f" + std::to_string(i);
            n.kind = "folder";
            if (i) n.parent = "f" + std::to_string(i - 1);
            n.name = "п";
            chain.push_back(n);
        }
        CloudNode leaf;
        leaf.id = "leaf";
        leaf.parent = "f" + std::to_string(kDeep - 1);
        leaf.name = "x.bin";
        leaf.size = 7;
        chain.push_back(leaf);
        auto cycle = chain;
        cycle[0].parent = "f" + std::to_string(kDeep - 1); // f0 → … → f29999 → f0
        const auto t0 = std::chrono::steady_clock::now();
        const auto stats = folderStats(chain);
        const auto path = pathOf(chain, std::string("leaf"));
        const auto cycleStats = folderStats(cycle);
        const auto cyclePath = pathOf(cycle, std::string("leaf"));
        const auto seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::printf("       цепочка и цикл 30 000 папок: %.3f с\n", seconds);
        check(seconds < 1.0, "цепочка и цикл 30 000 папок — меньше секунды");
        check(stats.at("f0").size == 7 && stats.at("f0").count == 1 && stats.at("f29999").size == 7,
              "цепочка: размер листа виден у каждого предка");
        check(path.size() == std::size_t(kDeep) + 1 && path.front().id == "f0" && path.back().id == "leaf",
              "цепочка: путь от корня до файла");
        check(cyclePath.size() == std::size_t(kDeep) + 1 && cycleStats.size() <= std::size_t(kDeep) + 1,
              "цикл родителей: путь обрывается на повторе");
    }

    // Ревью безопасности 21 окт 2026 (2.3): чужой файл система откроет по расширению
    {
        check(safeToOpenExternally("image/png", "x.png") && safeToOpenExternally("image/jpeg", "Фото.JPG")
                  && safeToOpenExternally("video/mp4", "v.mp4") && safeToOpenExternally("audio/ogg; codecs=opus", "a.ogg")
                  && safeToOpenExternally("", "x.webp"),
              "открыть системой: картинка, видео, звук с совпадающими mime и расширением");
        check(!safeToOpenExternally("image/png", "x.desktop") && !safeToOpenExternally("image/png", "x.png.desktop")
                  && !safeToOpenExternally("image/png", "x.sh") && !safeToOpenExternally("image/png", "x.exe")
                  && !safeToOpenExternally("image/png", "x"),
              "x.desktop / .sh / .exe / без расширения при image/png — нет («Сохранить как»)");
        check(!safeToOpenExternally("video/mp4", "x.png") && !safeToOpenExternally("image/svg+xml", "x.png")
                  && !safeToOpenExternally("application/octet-stream", "x.png") && !safeToOpenExternally("text/html", "x.mp3")
                  && !safeToOpenExternally("image/png", "x.svg") && !safeToOpenExternally("image/png", "x.html"),
              "вид по mime и по расширению различаются — нет");
        check(!safeToOpenExternally("image/png", "x.png ") && !safeToOpenExternally("image/png", ".png"),
              "хвостовой пробел, только расширение — нет");
    }
    {
        check(safeLocalName("фото.jpg") == "фото.jpg", "обычное имя — как есть");
        check(safeLocalName("../../.bashrc") == "___.._.bashrc" && safeLocalName("a/b\\c") == "a_b_c",
              "разделители путей и ведущие точки заменены");
        check(safeLocalName("") == "file" && safeLocalName(".") == "file" && safeLocalName("..") == "file"
                  && safeLocalName("/") == "file",
              "пустое, «.», «..», «/» — file");
        check(safeLocalName(std::string("a\x01\nb.png")) == "a__b.png", "управляющие знаки заменены");
        std::string longName;
        for (int i = 0; i < 300; ++i) longName += "ж";
        longName += ".png";
        const auto cut = safeLocalName(longName);
        bool utf8 = true;
        for (std::size_t i = 0; i + 4 < cut.size(); i += 2) {
            utf8 = utf8 && static_cast<unsigned char>(cut[i]) == 0xD0;
        }
        check(cut.size() <= kLocalNameMaxBytes && cut.size() > 190 && cut.substr(cut.size() - 4) == ".png" && utf8,
              "длинное имя — до 200 байт по границе знака, расширение на месте");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
