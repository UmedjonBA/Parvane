// Parvane fork (spec 029, фаза 4): карточка заметки на холсте «Знаний» — порт web
// `components/parvane/notes/notesCanvasNote.ts`. Что делает нажатие по карточке, правила названия, клавиши поля
// правки, начало текста для показа, место карточки у конца брошенной стрелки, перенос карточек на новую заметку.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

enum class NoteCardState { Found, Missing, Loading };
// Куда пришлось действие: шапка с названием, текст карточки либо команда («Изменить» панели и меню)
enum class NoteCardPart { Title, Body, Command };
enum class NoteCardAction { EditBody, EditTitle, Create, None };
enum class CanvasInlineKind { Node, Edge, Note, Title };
enum class CanvasInlineAction { Save, Cancel };

struct CanvasInlineKey {
    std::string key;
    bool shiftKey = false;
    bool ctrlKey = false;
    bool metaKey = false;
    bool isComposing = false;
};

inline constexpr int kNoteTitleMax = 120;

// Действие с карточкой заметки. Найденная заметка правится на месте: текст — по тексту карточки и по команде,
// название — по шапке (у заметки дня название — дата, оно не меняется). Заметки нет — команда предлагает её
// создать. Хранилище ещё читается — ничего: пустое поле затёрло бы заметку
NoteCardAction noteCardAction(NoteCardState state, NoteCardPart part, bool isDaily = false);
// Новое название из поля: без пробелов по краям. Пустое и прежнее — отказ (nullopt)
std::optional<std::string> nextNoteTitle(const std::string &value, const std::string &current);
// Клавиша в поле правки на месте. Escape отменяет. Enter сохраняет однострочное и текст карточки (там новая
// строка — Shift+Enter); в тексте заметки Enter — новая строка, сохраняет Ctrl/Cmd+Enter
std::optional<CanvasInlineAction> inlineKeyAction(CanvasInlineKind kind, const CanvasInlineKey &e);
// Начало текста заметки для карточки, без разметки: заголовок с названием и метки пунктов не показываются, пункты
// списка идут с точкой. `body` — текст заметки без блока свойств
std::vector<std::string> notePreviewLines(const std::string &body, const std::string &title, int max);
// Место карточки у конца стрелки, брошенной в точке `point`: карточка встаёт за точкой по ходу стрелки
CanvasPoint droppedCardPlace(CanvasPoint point, CanvasSide side, double width, double height, double grid);
// Заметку `fromId` удалили, её текст лёг в новую заметку `toId` под названием `toTitle`: карточки прежней заметки —
// по идентификатору и по названию в пути — указывают на новую. Нечего менять — прежний документ
CanvasDoc relinkNoteCards(const CanvasDoc &doc, const std::string &fromId, const std::string &fromTitle,
                          const std::string &toId, const std::string &toTitle);

} // namespace parvane::sections::notes
