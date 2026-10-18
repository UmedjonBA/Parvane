// Parvane fork (spec 029, фаза 4): тексты справки Parvane (внутренний заголовок notes_guide.cpp) — зеркало web
// `notes/guide/types.ts`.
#pragma once

#include <string>
#include <vector>

namespace parvane::sections::notes::guide {

struct GuideSource {
    // Постоянное имя заметки: по нему совпадают языки и строится идентификатор узла
    std::string key;
    // Номер заметки в идентификаторе узла: не меняется при перестановке и переводе
    int slot = 0;
    std::string title;
    std::string text;
};

// Пример строки для окна ввода текстом, стоящий в справке кодом, и то, чем он обязан стать
struct GuideQuickSample {
    std::string text;
    std::string kind;
};

struct GuideSet {
    std::string folderName;
    std::vector<GuideSource> notes;
    // Примеры пунктов с датой (без `- [ ] `): в тексте стоят кодом, каждый обязан разбираться как задача
    std::vector<std::string> datedSamples;
    std::vector<GuideQuickSample> quickSamples;
};

const GuideSet &ruSet();
const GuideSet &enSet();

} // namespace parvane::sections::notes::guide
