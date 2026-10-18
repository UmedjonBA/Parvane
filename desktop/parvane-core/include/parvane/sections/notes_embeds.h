// Parvane fork (spec 029, фаза 4): встроенные файлы заметки (`![[имя]]`, `![](путь)`) — какой файл облака за ними
// стоит. Порт web `components/parvane/notes/notesEmbeds.ts`. Как в Obsidian: имя без папок ищется сначала рядом с
// заметкой, потом по всему личному диску (ближе к корню — раньше); путь с папками — по концу пути файла.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/cloud_model.h"

namespace parvane::sections::notes {

// Указатель — в `nodes`; не нашлось — nullptr
const cloud::CloudNode *resolveEmbed(const std::vector<cloud::CloudNode> &nodes, const std::string &name,
                                     const std::optional<std::string> &noteId = std::nullopt);

} // namespace parvane::sections::notes
