// Parvane fork (spec 029, фаза 4): связь, проведённая на графе, — это ссылка `[[Название]]` в тексте заметки. Порт
// web `notes/notesLinkEdit.ts`: дописать ссылку туда, где заметка уже держит ссылки, и убрать ссылку, не переписывая
// прозу. Позиции (`from`/`to`) — в байтах UTF-8 текста заметки (в web — в единицах UTF-16).
#pragma once

#include <cstddef>
#include <string>

namespace parvane::sections::notes {

enum class AddLinkStatus { Added, Exists, Refused };

struct AddLinkResult {
    AddLinkStatus status = AddLinkStatus::Refused;
    std::string text;
    bool operator==(const AddLinkResult &) const = default;
};

enum class RemoveLinkStatus { Removed, None, Inline };

struct RemoveLinkResult {
    RemoveLinkStatus status = RemoveLinkStatus::None;
    std::string text;
    // Только для `Inline`: ссылка стоит внутри предложения, текст не тронут, `from`…`to` — её место в тексте
    size_t from = 0;
    size_t to = 0;
    bool operator==(const RemoveLinkResult &) const = default;
};

/** Можно ли сослаться на заметку с таким названием: в `[[…]]` не записать `[`, `]`, `|` и перенос строки */
bool canLinkTitle(const std::string &title);

/**
 * Дописывает ссылку `[[title]]`. Место: раздел со ссылками (заголовок «Связи», «См. также», «Links», «See also»…),
 * иначе — блок строк из одних ссылок в конце заметки, иначе — новая строка в конце после пустой. Ссылка, которая
 * уже есть (где угодно в тексте), второй раз не пишется; название, которое в ссылку не записать, — отказ.
 */
AddLinkResult addLinkToText(const std::string &text, const std::string &title);

/**
 * Убирает ссылку на `title`. Ссылка, стоящая отдельной строкой (или в строке из одних ссылок), убирается вместе с
 * опустевшей строкой. Если хоть одна такая ссылка стоит внутри предложения, текст не меняется вовсе —
 * возвращается место ссылки, чтобы показать его в правке.
 */
RemoveLinkResult removeLinkFromText(const std::string &text, const std::string &title);

} // namespace parvane::sections::notes
