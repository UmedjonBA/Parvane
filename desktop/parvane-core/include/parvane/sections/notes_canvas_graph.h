// Parvane fork (spec 029, фаза 4): холст из графа связей «Знаний» — порт web
// `components/parvane/notes/notesCanvasGraph.ts` (кроме `findFreeSpot` — он в notes_canvas_edit.h).
// `canvasFromGraph` — карточка на каждую заметку, стрелка на каждую ссылку `[[…]]` между существующими заметками,
// места карточек — раскладка графа, растянутая до размера настоящих карточек; заметки одной папки стоят вместе и
// обведены группой с названием папки. `refreshCanvasFromGraph` — сверка открытого холста с заметками: недостающие
// карточки и стрелки добавляются, свои стрелки исчезнувших ссылок убираются, сделанное руками не трогается. Холст
// может помнить свой набор заметок (поле `pvGraphScope` файла). Результат — обычный документ JSON Canvas.
//
// Отличие от web: «тот же объект документа» (`toBe`) здесь — равенство значений; у сверки есть флаг `changed`.
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_graph.h"

namespace parvane::sections::notes {

// Набор заметок холста из графа: папки (точный путь, корень — пустая строка; не заданы — все) и заметки дней
// (`false` — без них). Заметок дней выбор папок не касается — как на графе
struct GraphCanvasScope {
    std::optional<std::vector<std::string>> folders;
    std::optional<bool> days;
    bool operator==(const GraphCanvasScope &) const = default;
};

struct GraphCanvasOptions {
    // Какие заметки брать; не задан — все. Сужающий набор записывается в холст и действует при обновлении
    std::optional<GraphCanvasScope> scope;
    // Подпись группы папки по её пути; не задана — `folderCaption`
    std::function<std::string(const std::string &)> folderLabel;
    std::optional<double> cardWidth;
    std::optional<double> cardHeight;
    // Просвет между карточками
    std::optional<double> gap;
    std::optional<double> seed;
    CanvasMakeId makeId;
};

// Итог сверки холста с заметками: списки идентификаторов. `doc` — прежний, если менять нечего (`changed` ложно)
struct GraphRefreshResult {
    CanvasDoc doc;
    bool changed = false;
    std::vector<std::string> addedCards;
    std::vector<std::string> addedEdges;
    std::vector<std::string> removedEdges;
    // Карточки, перенацеленные на переименованную заметку
    std::vector<std::string> renamedCards;
    // Карточки заметок, которых больше нет: остаются на месте
    std::vector<std::string> missingCards;
};

inline constexpr double kGraphCanvasCardHeight = 140;
inline constexpr double kGraphCanvasGap = 60;
// Стрелка, поставленная по ссылке (а не нарисованная руками), узнаётся по началу идентификатора
inline const std::string kGraphEdgePrefix = "graph-";
// Поле карточки заметки: идентификатор заметки. По нему карточка находит заметку после переименования
inline const std::string kGraphNoteField = "pvNote";
// Поле группы: путь папки, чьи заметки она обводит
inline const std::string kGraphFolderField = "pvFolder";
// Поле файла холста (верхний уровень): набор заметок, из которого холст собран
inline const std::string kGraphScopeField = "pvGraphScope";
// Место над рамкой группы под её шапку с названием
inline constexpr double kGraphGroupHead = 40;

// Набор заметок, записанный в холсте; у обычного холста и у холста из всех заметок его нет
std::optional<GraphCanvasScope> scopeOfCanvas(const CanvasDoc &doc);
// Заметка входит в набор холста
bool isInCanvasScope(const std::string &folder, bool isDaily, const std::optional<GraphCanvasScope> &scope);
// Холст из заметок и ссылок между ними (правила — в web `canvasFromGraph`)
CanvasDoc canvasFromGraph(const std::vector<GraphNoteInput> &notes, const GraphCanvasOptions &options = {});
// Стрелка поставлена по ссылке (холстом из графа либо обновлением), а не нарисована руками
bool isGraphEdge(const CanvasEdge &edge);
// Стрелку правили: подпись, цвет, сторона, иной вид концов либо любое другое поле сверх концов
bool isCustomizedEdge(const CanvasEdge &edge);
// Карточки заметки `oldTitle` указывают на `newTitle` (папки в пути остаются). Нечего менять — прежний документ
CanvasDoc renameCanvasNote(const CanvasDoc &doc, const std::string &oldTitle, const std::string &newTitle);
// Переименованная папка `oldPath` → `newPath`: путь в наборе заметок холста и у групп папки и её подпапок; подпись
// группы меняется, только если это прежнее название папки. Нечего менять — прежний документ
CanvasDoc renameCanvasFolder(const CanvasDoc &doc, const std::string &oldPath, const std::string &newPath);
// Сверка холста с заметками и ссылками между ними (правила 1–5 — в web `refreshCanvasFromGraph`)
GraphRefreshResult refreshCanvasFromGraph(const CanvasDoc &doc, const std::vector<GraphNoteInput> &notes,
                                          const GraphCanvasOptions &options = {});
// Свободное название холста: `base`, затем «base 2», «base 3»… (без учёта регистра)
std::string freeCanvasTitle(const std::string &base, const std::vector<std::string> &taken);

} // namespace parvane::sections::notes
