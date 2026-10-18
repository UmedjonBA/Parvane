// Parvane fork (spec 029, фаза 4): файлы статьи в чат (ARTICLE-1) — порт web
// `components/parvane/article/articleMedia.ts`. Файл статьи по имени из текста (`![[имя]]`); путь с папками у
// отправителя — по последней части.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace parvane::sections::article {

// Файл статьи (web `ApiArticleMedia`, провод — `Article.media`)
struct ArticleMedia {
    std::string name;
    std::string fileId;
    std::string mimeType;
    int64_t size = 0;
};

// Указатель — в `media`; не нашлось — nullptr
const ArticleMedia *findMedia(const std::vector<ArticleMedia> &media, const std::string &name);

} // namespace parvane::sections::article
