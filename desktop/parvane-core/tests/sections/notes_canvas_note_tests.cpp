// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesCanvasNote.test.ts`.
#include "notes_test_util.h"
#include "parvane/sections/notes_canvas_graph.h"
#include "parvane/sections/notes_canvas_note.h"

using namespace parvane::sections::notes;

using S = NoteCardState;
using P = NoteCardPart;
using A = NoteCardAction;
using K = CanvasInlineKind;

static std::optional<CanvasInlineAction> key(K kind, const std::string &k, bool shift = false, bool ctrl = false,
                                             bool meta = false, bool composing = false) {
    return inlineKeyAction(kind, {k, shift, ctrl, meta, composing});
}

static CanvasNode node(const std::string &id, const std::string &type, double h, const CanvasJson &fields) {
    CanvasNode n;
    n.id = id;
    n.type = type;
    n.width = 250;
    n.height = h;
    for (auto it = fields.begin(); it != fields.end(); ++it) n.set(it.key(), it.value());
    return n;
}

int main() {
    std::printf("noteCardAction\n");
    check(noteCardAction(S::Found, P::Body) == A::EditBody && noteCardAction(S::Found, P::Command) == A::EditBody,
          "текст найденной заметки правится по тексту карточки и по команде");
    check(noteCardAction(S::Found, P::Title) == A::EditTitle, "шапка найденной заметки правит название");
    check(noteCardAction(S::Found, P::Title, true) == A::None && noteCardAction(S::Found, P::Body, true) == A::EditBody,
          "название заметки дня не меняется, текст правится");
    check(noteCardAction(S::Missing, P::Body) == A::None && noteCardAction(S::Missing, P::Title) == A::None
              && noteCardAction(S::Missing, P::Command) == A::Create,
          "карточка заметки, которой нет, не правится, команда предлагает создать");
    check(noteCardAction(S::Loading, P::Body) == A::None && noteCardAction(S::Loading, P::Title) == A::None
              && noteCardAction(S::Loading, P::Command) == A::None,
          "пока хранилище читается, карточка не правится и заметка не создаётся");

    std::printf("nextNoteTitle\n");
    check(nextNoteTitle("  Сервер  ", "Старое") == std::optional<std::string>("Сервер"), "убирает пробелы по краям");
    check(!nextNoteTitle("", "Старое") && !nextNoteTitle("   ", "Старое"), "пустое название отклоняется");
    check(!nextNoteTitle("Старое", "Старое") && !nextNoteTitle(" Старое ", "Старое"), "прежнее название — не переименование");
    check(nextNoteTitle("старое", "Старое") == std::optional<std::string>("старое"), "смена регистра — переименование");

    std::printf("inlineKeyAction\n");
    const auto save = std::optional(CanvasInlineAction::Save);
    const auto cancel = std::optional(CanvasInlineAction::Cancel);
    check(key(K::Note, "Escape") == cancel && key(K::Title, "Escape") == cancel && key(K::Node, "Escape") == cancel,
          "Escape отменяет любую правку");
    check(!key(K::Note, "Enter") && !key(K::Note, "Enter", true) && key(K::Note, "Enter", false, true) == save
              && key(K::Note, "Enter", false, false, true) == save,
          "в тексте заметки Enter — новая строка, сохраняет Ctrl+Enter и Cmd+Enter");
    check(key(K::Title, "Enter") == save && key(K::Edge, "Enter") == save && key(K::Node, "Enter") == save
              && !key(K::Node, "Enter", true),
          "название и текст карточки сохраняет Enter, Shift+Enter — новая строка");
    check(!key(K::Title, "Enter", false, false, false, true) && !key(K::Note, "Enter", false, true, false, true),
          "Enter при наборе иероглифов ничего не сохраняет");
    check(!key(K::Note, "z", false, true) && !key(K::Title, "a"), "прочие клавиши — обычный ввод");

    std::printf("notePreviewLines\n");
    check(notePreviewLines("# Сервер\n\nБюджетный сервер. См. [[Курс]]\n\n- [ ] заказать блок ^tab12cd\n- проверить GPU\n## Итог",
                           "Сервер", 7)
              == std::vector<std::string>{"Бюджетный сервер. См. [[Курс]]", "• заказать блок", "• проверить GPU", "Итог"},
          "прячет заголовок с названием, пустые строки и метки пунктов");
    check(notePreviewLines("а\nб\nв\nг", "Заметка", 2) == std::vector<std::string>{"а", "б"},
          "показывает не больше заданного числа строк");
    check(notePreviewLines("# Заметка\n\n", "заметка", 7).empty(), "пустой текст — пустой список");

    std::printf("droppedCardPlace\n");
    const CanvasPoint at{400, 300};
    check(droppedCardPlace(at, CanvasSide::Right, 250, 140, 20) == CanvasPoint{400, 240}
              && droppedCardPlace(at, CanvasSide::Left, 250, 140, 20) == CanvasPoint{160, 240}
              && droppedCardPlace(at, CanvasSide::Bottom, 250, 140, 20) == CanvasPoint{280, 300}
              && droppedCardPlace(at, CanvasSide::Top, 250, 140, 20) == CanvasPoint{280, 160},
          "карточка встаёт за концом стрелки по её ходу, на сетке");

    std::printf("relinkNoteCards\n");
    CanvasDoc doc;
    doc.nodes = {node("a", "file", 140, {{"file", "Идея.md"}, {"pvNote", "n1"}}),
                 node("b", "file", 140, {{"file", "Проекты/идея.md"}}),
                 node("c", "file", 140, {{"file", "План.md"}, {"pvNote", "n2"}}),
                 node("t", "text", 60, {{"text", "Идея"}})};
    {
        const auto next = relinkNoteCards(doc, "n1", "Идея", "n9", "Идея 2");
        std::vector<std::pair<std::string, std::string>> got;
        for (const auto &n : next.nodes) got.emplace_back(n.str("file").value_or("-"), n.str("pvNote").value_or("-"));
        check(got == std::vector<std::pair<std::string, std::string>>{{"Идея 2.md", "n9"}, {"Проекты/Идея 2.md", "n9"},
                                                                      {"План.md", "n2"}, {"-", "-"}},
              "карточки удалённой заметки указывают на новую: идентификатор и название в пути");
    }
    {
        const auto next = relinkNoteCards(doc, "n1", "Идея", "n9", "Идея");
        check(next.nodes[0].str("file") == std::optional<std::string>("Идея.md")
                  && next.nodes[0].str("pvNote") == std::optional<std::string>("n9") && next.nodes[2] == doc.nodes[2],
              "название прежнее — путь не меняется, идентификатор новый");
    }
    check(relinkNoteCards(doc, "n5", "Другое", "n9", "Другое") == doc, "карточек заметки нет — прежний документ");
    return finish();
}
