// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesCanvasFiles.test.ts` и `notes/notesEmbeds.test.ts`.
#include "notes_test_util.h"
#include "parvane/sections/notes_canvas_files.h"
#include "parvane/sections/notes_embeds.h"

using namespace parvane::sections;
using namespace parvane::sections::notes;

static const std::vector<cloud::CloudNode> NODES = {
    cloudNode("docs", "Документы", std::nullopt, "folder"), cloudNode("sub", "Сканы", "docs", "folder"),
    cloudNode("scan", "паспорт.png", "sub"), cloudNode("root-file", "смета.xlsx"),
    cloudNode("old", "старое.txt", "docs", "file", true), cloudNode("bin", "Корзина", std::nullopt, "folder", true),
    cloudNode("bin-file", "в корзине.txt", "bin"), cloudNode("same", "Сканы", "docs"),
};

static std::string idOf(const cloud::CloudNode *node) { return node ? node->id : "<нет>"; }

static void testFiles() {
    std::printf("путь файла личного диска\n");
    check(drivePathOf(NODES, "scan") == "Документы/Сканы/паспорт.png", "путь от корня: вложенный файл");
    check(drivePathOf(NODES, "root-file") == "смета.xlsx", "путь от корня: файл в корне");
    check(drivePathOf(NODES, "нет").empty(), "путь от корня: нет узла — пусто");
    check(idOf(resolveDrivePath(NODES, "Документы/Сканы/паспорт.png")) == "scan", "файл по пути: вложенный");
    check(idOf(resolveDrivePath(NODES, "смета.xlsx")) == "root-file", "файл по пути: в корне");
    check(idOf(resolveDrivePath(NODES, "/Документы//Сканы/паспорт.png")) == "scan", "файл по пути: лишние «/»");
    check(idOf(resolveDrivePath(NODES, "Документы/Сканы")) == "same", "папка и файл с одним названием не путаются");
    check(!resolveDrivePath(NODES, "Документы/нет.png"), "нет файла — не найдено");
    check(!resolveDrivePath(NODES, "Документы/старое.txt"), "файл в корзине — не найдено");
    check(!resolveDrivePath(NODES, "Корзина/в корзине.txt"), "папка в корзине — не найдено");
    check(!resolveDrivePath(NODES, "Документы"), "папка вместо файла — не найдено");
    check(!resolveDrivePath(NODES, "паспорт.png"), "путь без папок ищется в корне");
    check(!resolveDrivePath(NODES, ""), "пустой путь — не найдено");

    check(noteTitleOfPath(std::string("Сервер X99.md")) == std::optional<std::string>("Сервер X99"), "название заметки по пути");
    check(noteTitleOfPath(std::string("Папка/Заметка.MD")) == std::optional<std::string>("Заметка"), "расширение в другом регистре");
    check(!noteTitleOfPath(std::string("схема.png")), "не заметка — нет названия");
    check(!noteTitleOfPath(std::string(".md")), "одно расширение — нет названия");
    check(!noteTitleOfPath(std::nullopt), "пути нет — нет названия");
    check(fileNameOfPath(std::string("Документы/Сканы/паспорт.png")) == "паспорт.png", "имя файла по пути");
    check(fileNameOfPath(std::nullopt).empty(), "имя файла без пути — пусто");

    check(formatCardSize(0) == "0 B", "размер файла: 0 B");
    check(formatCardSize(900) == "900 B", "размер файла: 900 B");
    check(formatCardSize(1536) == "1.5 KB", "размер файла: 1.5 KB");
    check(formatCardSize(2048) == "2 KB", "размер файла: 2 KB");
    check(formatCardSize(12.0 * 1024 * 1024) == "12 MB", "размер файла: 12 MB");
    check(formatCardSize(5.0 * 1024 * 1024 * 1024 * 1024) == "5120 GB", "размер файла: 5120 GB");
    // Сверх web: половина в `toFixed` округляется вверх (glibc округлил бы к чётному)
    check(formatCardSize(1280) == "1.3 KB", "размер файла: 1.25 KB → 1.3 KB, как toFixed");
}

static void testPreview() {
    std::printf("превью ссылки\n");
    check(hostOf("https://www.example.com/a/b?c=1") == "example.com", "узел сайта без www.");
    check(hostOf("https://docs.example.com") == "docs.example.com", "поддомен остаётся");
    check(hostOf("не адрес") == "не адрес", "не адрес — он сам");
    check(hostOf("https://user:pw@Example.COM:8080/x") == "example.com", "сверх web: учётные данные и порт, регистр");
    {
        LinkPreviewSource src;
        src.title = "  Заголовок \n страницы ";
        src.description = "";
        src.siteName = "Example.com";
        src.imageBase64 = "AAAA";
        src.imageMime = "image/PNG";
        const auto preview = buildLinkPreview("https://example.com/page", src);
        LinkPreview want;
        want.host = "example.com";
        want.title = "Заголовок страницы";
        want.imageBase64 = "AAAA";
        want.imageMime = "image/png";
        check(preview == want, "сведения чистятся, название-узел не повторяется");
        check(hasPreviewContent(preview), "в превью есть содержимое");
        LinkPreviewSource same;
        same.title = "example.com";
        check(!buildLinkPreview("https://example.com", same).title, "название, совпавшее с узлом, не показывается");
        LinkPreviewSource longText;
        std::string ya;
        for (int i = 0; i < 900; ++i) ya += "я";
        longText.description = ya;
        const auto cut = buildLinkPreview("https://example.com", longText).description;
        check(cut && cut->size() == 800, "длинное описание обрезается до 400 знаков");
    }
    {
        LinkPreviewSource svg;
        svg.imageBase64 = "AAAA";
        svg.imageMime = "image/svg+xml";
        check(!buildLinkPreview("https://example.com", svg).imageBase64, "нерастровая картинка не показывается");
        LinkPreviewSource bare;
        bare.imageBase64 = "AAAA";
        check(!buildLinkPreview("https://example.com", bare).imageBase64, "картинка без типа не показывается");
    }
    {
        const auto preview = buildLinkPreview("https://example.com/page");
        check(preview.host == "example.com" && !hasPreviewContent(preview), "превью недоступно — только узел сайта");
    }
}

static void testEmbeds() {
    std::printf("встроенные файлы заметки\n");
    const std::vector<cloud::CloudNode> nodes = {
        cloudNode("vault", "Знания", std::nullopt, "folder"), cloudNode("trips", "Походы", "vault", "folder"),
        cloudNode("note", "Поход.md", "trips"), cloudNode("near", "фото.jpg", "trips"), cloudNode("root-photo", "фото.jpg"),
        cloudNode("deep", "карта.png", "trips"), cloudNode("top", "карта.png", "vault"),
        cloudNode("gone", "старое.png", "vault", "file", true),
    };
    check(idOf(resolveEmbed(nodes, "фото.jpg", std::string("note"))) == "near", "имя без папок: рядом с заметкой");
    check(idOf(resolveEmbed(nodes, "фото.jpg")) == "root-photo", "имя без папок: без заметки — ближе к корню");
    check(idOf(resolveEmbed(nodes, "карта.png", std::string("note"))) == "deep", "имя без папок: рядом важнее глубины");
    check(!resolveEmbed(nodes, "старое.png", std::string("note")), "корзина не считается");
    check(idOf(resolveEmbed(nodes, "Походы/карта.png")) == "deep", "путь с папками — по концу пути");
    check(idOf(resolveEmbed(nodes, "Знания/карта.png")) == "top", "путь с папками — короче путь раньше");
    check(!resolveEmbed(nodes, "Нет/карта.png"), "путь с папками: нет такого");
}

int main() {
    testFiles();
    testPreview();
    testEmbeds();
    return finish();
}
