// Parvane fork (spec 029, T061/T062): тесты planner_forms.h — черновик правила повтора (поведение web
// `PlannerRepeatFields.tsx`), варианты «Напомнить», ранг новой задачи, разбор дат и времени из поля.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/planner_forms.h"
#include "parvane/sections/planner_model.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static void repeatDraftTests() {
    std::printf("черновик повтора\n");
    const auto empty = emptyRepeatDraft("2026-10-18");
    check(empty.kind == "none" && empty.interval == "1" && empty.startDay == "2026-10-18"
              && empty.endKind == "never" && empty.weekdays.empty(),
          "пустой черновик — не повторяется, шаг 1, начало — переданный день");
    check(!draftToRepeat(empty), "«Не повторяется» → разовое дело");
    check(repeatToDraft(std::nullopt, "2026-01-05") == emptyRepeatDraft("2026-01-05"),
          "без правила — пустой черновик с днём начала");

    Repeat weekly;
    weekly.kind = "weekly";
    weekly.interval = 2;
    weekly.weekdays = std::vector<int>{1, 3};
    weekly.startDay = "2026-10-12";
    weekly.endDay = "2026-12-31";
    const auto draft = repeatToDraft(weekly);
    check(draft.kind == "weekly" && draft.interval == "2" && draft.weekdays == std::vector<int>({1, 3})
              && draft.endKind == "until" && draft.endDay == "2026-12-31" && draft.count.empty(),
          "еженедельное правило с датой конца → черновик");
    const auto back = draftToRepeat(draft);
    check(back && back->kind == "weekly" && back->interval == 2 && back->weekdays == weekly.weekdays
              && back->endDay == weekly.endDay && !back->count && !back->monthDay,
          "черновик → то же правило");

    Repeat counted;
    counted.kind = "monthly";
    counted.interval = 1;
    counted.monthDay = 15;
    counted.startDay = "2026-10-01";
    counted.count = 10;
    const auto countDraft = repeatToDraft(counted);
    check(countDraft.endKind == "count" && countDraft.count == "10" && countDraft.monthDay == "15",
          "число повторов и число месяца — строками");

    auto edit = countDraft;
    edit.kind = "daily";
    const auto daily = draftToRepeat(edit);
    check(daily && !daily->monthDay && !daily->weekdays && daily->count == 10,
          "смена вида: число месяца и дни недели не уходят в правило");
    edit.interval = "";
    check(draftToRepeat(edit)->interval == 1, "пустой шаг — 1");
    edit.interval = "abc";
    const auto bad = draftToRepeat(edit);
    check(bad->interval == 0 && validateRepeat(*bad) == std::optional<std::string>("interval"),
          "негодный шаг отклоняет проверка правила");
    edit.interval = "3";
    edit.endKind = "until";
    edit.endDay = "";
    const auto noEnd = draftToRepeat(edit);
    check(!noEnd->endDay && !noEnd->count, "«До даты» без даты — без конца");
    edit.endKind = "never";
    edit.count = "5";
    check(!draftToRepeat(edit)->count, "число повторов без «после числа повторов» не пишется");

    auto weeklyDraft = emptyRepeatDraft("");
    weeklyDraft.kind = "weekly";
    const auto noDays = draftToRepeat(weeklyDraft);
    check(noDays && noDays->weekdays && noDays->weekdays->empty()
              && validateRepeat(*noDays) == std::optional<std::string>("weekdays"),
          "еженедельный без дней — ошибка weekdays");
}

static void remindTests() {
    std::printf("напомнить\n");
    check(remindOptions(std::nullopt) == kRemindOptions, "без значения — общий список");
    check(remindOptions(30) == kRemindOptions, "значение из списка — общий список");
    const auto custom = remindOptions(45);
    check(custom.size() == kRemindOptions.size() + 1 && custom[5] == 45 && custom[4] == 30 && custom[6] == 60,
          "своё значение встаёт по порядку");
}

static void rankTests() {
    std::printf("ранг новой задачи\n");
    auto state = createEmptyState();
    check(newTaskRank(state) == -1, "пустой план — −1");
    Task a;
    a.rank = 5;
    Task b;
    b.rank = -3;
    state.tasks = {a, b};
    check(newTaskRank(state) == -4, "на единицу меньше самого малого");
    state.tasks = {a};
    check(newTaskRank(state) == -1, "только положительные ранги — −1");
}

static void inputTests() {
    std::printf("даты и время из поля\n");
    check(parseDayInput("") == std::optional<std::string>(""), "пустая дата — очищено");
    check(parseDayInput(" 2026-10-18 ") == std::optional<std::string>("2026-10-18"), "ГГГГ-ММ-ДД");
    check(parseDayInput("18.10.2026") == std::optional<std::string>("2026-10-18"), "ДД.ММ.ГГГГ");
    check(parseDayInput("5.1.2026") == std::optional<std::string>("2026-01-05"), "Д.М.ГГГГ");
    check(parseDayInput("05.01.26") == std::optional<std::string>("2026-01-05"), "ДД.ММ.ГГ");
    check(parseDayInput("5/1/2026") == std::optional<std::string>("2026-01-05"), "Д/М/ГГГГ");
    check(!parseDayInput("31.02.2026"), "несуществующий день");
    check(parseDayInput("29.02.2028") == std::optional<std::string>("2028-02-29"), "29 февраля високосного");
    check(!parseDayInput("29.02.2027"), "29 февраля невисокосного");
    check(!parseDayInput("завтра") && !parseDayInput("2026-1-5x") && !parseDayInput("1.2.345"),
          "не дата");
    check(parseTimeInput("") == std::optional<std::string>(""), "пустое время — очищено");
    check(parseTimeInput("9:05") == std::optional<std::string>("09:05"), "Ч:ММ");
    check(parseTimeInput("23.40") == std::optional<std::string>("23:40"), "ЧЧ.ММ");
    check(parseTimeInput("0730") == std::optional<std::string>("07:30"), "ЧЧММ");
    check(parseTimeInput("930") == std::optional<std::string>("09:30"), "ЧММ");
    check(parseTimeInput("18") == std::optional<std::string>("18:00"), "ровный час");
    check(!parseTimeInput("24:00") && !parseTimeInput("12:60") && !parseTimeInput("12:5") && !parseTimeInput("ab"),
          "не время");
    check(formatDayInput("2026-10-18") == "18.10.2026" && formatDayInput("") == "", "дата в поле");
}

int main() {
    repeatDraftTests();
    remindTests();
    rankTests();
    inputTests();
    std::printf("\nпланировщик, окна: %d/%d\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
