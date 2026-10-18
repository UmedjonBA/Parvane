// Parvane fork (spec 029, фаза 4): web `article/articleMedia.ts` своих тестов не имеет — проверки поведения
// `findMedia` (сверх web).
#include "notes_test_util.h"
#include "parvane/sections/article_media.h"

using namespace parvane::sections::article;

int main() {
    std::printf("статья: файлы по имени из текста\n");
    const std::vector<ArticleMedia> media = {{"фото.jpg", "f1", "image/jpeg", 10}, {"карта.png", "f2", "image/png", 20},
                                             {"Походы/карта.png", "f3", "image/png", 30}};
    const auto idOf = [](const ArticleMedia *m) { return m ? m->fileId : std::string("<нет>"); };
    check(idOf(findMedia(media, "фото.jpg")) == "f1", "имя совпало — этот файл");
    check(idOf(findMedia(media, "Походы/карта.png")) == "f3", "точное имя с папками важнее последней части");
    check(idOf(findMedia(media, "Знания/фото.jpg")) == "f1", "путь с папками у отправителя — по последней части");
    check(idOf(findMedia(media, "/фото.jpg/")) == "f1", "лишние «/» не мешают");
    check(!findMedia(media, "нет.png") && !findMedia({}, "фото.jpg"), "нет файла — не найдено");
    return finish();
}
