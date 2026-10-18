// Parvane fork (spec 029, фаза 4): файлы статьи в чат — порт web `article/articleMedia.ts`.
#include "parvane/sections/article_media.h"

#include "parvane/sections/markdown.h"

namespace parvane::sections::article {

const ArticleMedia *findMedia(const std::vector<ArticleMedia> &media, const std::string &name) {
    for (const auto &item : media) {
        if (item.name == name) return &item;
    }
    const auto base = markdown::embedBaseName(name);
    for (const auto &item : media) {
        if (item.name == base) return &item;
    }
    return nullptr;
}

} // namespace parvane::sections::article
