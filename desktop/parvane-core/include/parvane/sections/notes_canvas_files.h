// Parvane fork (spec 029, фаза 4): карточки файлов и ссылок на холсте «Знаний» — порт web
// `components/parvane/notes/notesCanvasFiles.ts`. Путь файла личного диска и обратно, сведения превью страницы,
// размер файла для карточки. Чистые функции: в файл `.canvas` попадает только путь либо адрес.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"

namespace parvane::sections::notes {

struct LinkPreviewSource {
    std::optional<std::string> url;
    std::optional<std::string> siteName;
    std::optional<std::string> title;
    std::optional<std::string> description;
    std::optional<std::string> imageBase64;
    std::optional<std::string> imageMime;
};

struct LinkPreview {
    std::string host;
    std::optional<std::string> title;
    std::optional<std::string> description;
    std::optional<std::string> siteName;
    std::optional<std::string> imageBase64;
    std::optional<std::string> imageMime;
    bool operator==(const LinkPreview &) const = default;
};

// Путь файла от корня личного диска: названия папок и файла через «/». Нет узла — пусто
std::string drivePathOf(const std::vector<cloud::CloudNode> &nodes, const std::string &id);
// Файл личного диска по пути карточки. Файлы и папки в корзине не считаются; путь без папок ищется в корне диска.
// Указатель — в `nodes`
const cloud::CloudNode *resolveDrivePath(const std::vector<cloud::CloudNode> &nodes, const std::string &path);
// Название заметки по пути карточки: последняя часть пути без `.md` (регистр расширения не важен). Не `.md` — nullopt
std::optional<std::string> noteTitleOfPath(const std::optional<std::string> &path);
std::string fileNameOfPath(const std::optional<std::string> &path);
// Узел сайта для подписи карточки-ссылки (без `www.`); адрес не разобрать — он сам. Разбор адреса — упрощённый
// WHATWG URL: без перевода международных имён в punycode и без разбора %-кодов в узле
std::string hostOf(const std::string &url);
// Сведения превью для показа: пустые строки убраны, длинные обрезаны, название, совпавшее с узлом сайта, не
// повторяется, картинка — только растровая. `source` нет — превью недоступно, остаётся узел сайта
LinkPreview buildLinkPreview(const std::string &url, const std::optional<LinkPreviewSource> &source = std::nullopt);
// Есть ли в превью что-то кроме узла сайта
bool hasPreviewContent(const LinkPreview &preview);
// Размер файла для карточки: «0 B», «1.5 KB», «12 MB»
std::string formatCardSize(double bytes);

} // namespace parvane::sections::notes
