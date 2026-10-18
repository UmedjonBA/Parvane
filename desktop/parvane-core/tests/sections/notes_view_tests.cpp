// Parvane fork (spec 029, T063): чистая часть экранов «Знаний» (notes_view.h) — поведение, которое в web живёт в
// компонентах Knowledge / NoteView / NoteLinks / NotesGraph.
#include "notes_test_util.h"
#include "parvane/sections/notes_view.h"

#include <cmath>

using namespace parvane::sections;
using namespace parvane::sections::notes;

static PlannedItem item(const std::string &key, const std::optional<std::string> &day) {
    PlannedItem result;
    result.key = key;
    result.kind = "task";
    result.name = key;
    result.day = day;
    return result;
}

static std::vector<std::string> keys(const std::vector<PlannedItem> &items) {
    std::vector<std::string> result;
    for (const auto &i : items) result.push_back(i.key);
    return result;
}

static void testPlanned() {
    std::printf("заметка: «Запланировано»\n");
    const std::string today = "2026-10-18";
    const auto shown = shownPlanned({item("a", "2026-10-01"), item("b", "2026-10-05"), item("c", "2026-10-10"),
                                     item("d", "2026-10-17"), item("e", "2026-10-18"), item("f", std::nullopt),
                                     item("g", "2026-11-01")},
                                    today);
    check(keys(shown) == std::vector<std::string>{"b", "c", "d", "e", "f", "g"},
          "прошедших — три последних, сегодняшние, без дня и будущие — все");
    check(keys(shownPlanned({item("x", "2026-10-20")}, today)) == std::vector<std::string>{"x"}, "без прошедших — как есть");
}

static void testMarker() {
    std::printf("заметка: метка пункта\n");
    check(splitTaskMarker("позвонить ^t7f3a") == TaskMarkerSplit{"позвонить", std::string("t7f3a")},
          "метка в конце убирается");
    check(splitTaskMarker("позвонить ^t7f3a  ") == TaskMarkerSplit{"позвонить", std::string("t7f3a")},
          "пробелы после метки — тоже");
    check(splitTaskMarker("позвонить ^t12") == TaskMarkerSplit{"позвонить ^t12", std::nullopt}, "короткая — не метка");
    check(splitTaskMarker("позвонить^t7f3a") == TaskMarkerSplit{"позвонить^t7f3a", std::nullopt},
          "без пробела перед ^ — не метка");
    check(splitTaskMarker("x ^tabcdefghijklmn") == TaskMarkerSplit{"x ^tabcdefghijklmn", std::nullopt},
          "длиннее 12 знаков — не метка");
    check(splitTaskMarker("") == TaskMarkerSplit{"", std::nullopt}, "пустая строка");
}

static void testRecords() {
    std::printf("граф: записи «Плана»\n");
    check(titleLinks("Созвон [[Сервер X99|сервер]] и [[ Курс ]] [[]]") == std::vector<std::string>{"Сервер X99", "Курс"},
          "ссылки в названии записи: без подписи и пробелов, пустая — не ссылка");
    planner::State state;
    planner::Event event;
    event.id = "1";
    event.name = "Встреча по [[Проект]]";
    state.events.push_back(event);
    planner::Task task;
    task.id = "2";
    task.name = "Купить хлеб";
    state.tasks.push_back(task);
    const auto records = graphRecordsOf(state);
    check(records.size() == 2 && records[0].id == "e1" && records[0].links == std::vector<std::string>{"Проект"}
              && records[0].type == std::optional<std::string>("event") && records[1].id == "t2"
              && records[1].links.empty() && records[1].type == std::optional<std::string>("task"),
          "события и задачи с префиксами id и типом");
    check(recordLabel("Встреча  по [[Проект]] сегодня") == "Встреча по сегодня", "подпись без ссылок, пробелы схлопнуты");
    check(recordLabel("[[Проект]]") == "[[Проект]]", "ничего не осталось — название целиком");
    check(shortenLabel("Очень длинное название", 10) == "Очень дли…" && shortenLabel("Коротко", 10) == "Коротко",
          "подпись обрезается по знакам");
}

static void testSearch() {
    std::printf("граф: поиск и папки\n");
    check(graphQueryText("  Ёлка ") == "елка", "запрос: без пробелов, регистра и ё");
    check(isGraphFound("ёлк", "Новогодняя Елка", "x") && isGraphFound("abc", "zzz", "xABCx") && !isGraphFound(" ", "a", "a")
              && !isGraphFound("q", "a", "b"),
          "найдено по подписи либо названию; пустой запрос — ничего");
    check(nextFoundIndex({}, std::nullopt) == std::nullopt, "находок нет");
    check(nextFoundIndex({"a", "b", "c"}, std::nullopt) == std::optional<size_t>(0)
              && nextFoundIndex({"a", "b", "c"}, std::string("b")) == std::optional<size_t>(2)
              && nextFoundIndex({"a", "b", "c"}, std::string("c")) == std::optional<size_t>(0)
              && nextFoundIndex({"a", "b"}, std::string("z")) == std::optional<size_t>(0),
          "следующая находка по кругу");
    check(toggleGraphFolder(std::nullopt, "Дом") == std::vector<std::string>{"Дом"}, "из «всех папок» — одна");
    check(toggleGraphFolder(std::vector<std::string>{"Дом"}, "") == std::vector<std::string>{"Дом", ""}
              && toggleGraphFolder(std::vector<std::string>{"Дом", ""}, "Дом") == std::vector<std::string>{""},
          "дальше папки добавляются и убираются");
}

static void testMini() {
    std::printf("связи: малый граф и новая заметка\n");
    const auto one = miniGraphPlaces(1);
    check(one.size() == 1 && std::abs(one[0].x - 160) < 1e-9 && std::abs(one[0].y - 40) < 1e-9, "одна точка — сверху");
    const auto four = miniGraphPlaces(4);
    check(four.size() == 4 && std::abs(four[1].x - 252) < 1e-9 && std::abs(four[1].y - 120) < 1e-9,
          "по часовой: вторая из четырёх — справа");
    check(miniGraphPlaces(20).size() == size_t(kMiniGraphMaxPoints), "не больше восьми точек");
    check(newNoteFolder({std::string("Работа"), false, std::string("Справка")}) == std::optional<std::string>("Работа"),
          "в папку открытой заметки");
    check(!newNoteFolder({std::string("Справка"), false, std::string("Справка")}), "из справки — без папки");
    check(!newNoteFolder({std::string("Ежедневные"), true, std::nullopt}), "из заметки дня — без папки");
    check(!newNoteFolder({std::nullopt, false, std::nullopt}) && !newNoteFolder({std::string(""), false, std::nullopt}),
          "без открытой заметки и из корня — без папки");
}

int main() {
    testPlanned();
    testMarker();
    testRecords();
    testSearch();
    testMini();
    return finish();
}
