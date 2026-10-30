// Parvane fork (spec 029, фаза 4): тесты карточки «задание в чат» — перенос web `taskOffer/taskOffer.test.ts`
// (по проверке на `it`, имена — как в web). Строку карточки собирает здесь тестовый «UI» с английскими названиями
// дней и месяцев и ключами вместо текстов — как `lang`-заглушка web, — и сверяет с ожиданием web буква в букву.
#include <cstdio>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "parvane/sections/planner_model.h"
#include "parvane/sections/task_offer.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// `toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' })`
static std::string enDate(const std::string &day) {
    static const char *weekdays[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
    static const char *months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    const int month = std::stoi(day.substr(5, 2));
    const int date = std::stoi(day.substr(8, 2));
    return std::string(weekdays[weekdayOf(day)]) + ", " + months[month - 1] + " " + std::to_string(date);
}

static std::string render(const std::vector<OfferWhenPart> &parts) {
    std::string out;
    for (const auto &part : parts) {
        std::string text;
        switch (part.kind) {
        case OfferWhenPart::Kind::Day:
            text = part.isToday ? "WeekdayToday, " + enDate(part.day) : enDate(part.day);
            break;
        case OfferWhenPart::Kind::Start:
            text = part.start;
            break;
        case OfferWhenPart::Kind::Duration:
            if (part.duration.hours) text = "PlannerHoursValue(" + std::to_string(*part.duration.hours) + ")";
            if (part.duration.minutes) {
                text += (text.empty() ? "" : " ") + std::string("PlannerMinutesValue(")
                    + std::to_string(*part.duration.minutes) + ")";
            }
            break;
        case OfferWhenPart::Kind::Due:
            text = "PlannerDueValue(" + (part.isToday ? "WeekdayToday, " + enDate(part.day) : enDate(part.day)) + ")";
            break;
        }
        out += (out.empty() ? "" : " · ") + text;
    }
    return out;
}

static void card() {
    const std::string today = "2026-10-12";
    check(render(offerWhenParts({"2026-10-12", "10:00", 45, std::nullopt}, today))
                  == "WeekdayToday, Mon, Oct 12 · 10:00 · PlannerMinutesValue(45)"
              && render(offerWhenParts({"2026-10-20", std::nullopt, 90, "2026-10-21"}, today))
                  == "Tue, Oct 20 · PlannerHoursValue(1) PlannerMinutesValue(30) · PlannerDueValue(Wed, Oct 21)"
              && offerWhenParts({std::nullopt, "10:00", std::nullopt, std::nullopt}, today).empty()
              && offerWhenParts({}, today).empty(),
          "строка под названием: день, начало, длительность, срок");
    check(offerPlannerView("event") == "calendar" && offerPlannerView("task") == "today"
              && durationParts(120) == DurationParts{2, std::nullopt},
          "«открыть»: задание — «Сегодня», событие — «Календарь» (выбор экрана)");
    // не перенесено: запрос дня и переключение раздела в «открыть» (`openOfferInPlan`, сигналы UI web)
}

static void planKey() {
    const std::string UUID = "0190c5b0-1234-7abc-8def-0123456789ab";
    const std::string OP_ID = "0190c5b012347abc8def0123456789ab";
    auto task = [](const std::string &id, std::optional<std::string> opId = std::nullopt,
                   std::optional<std::string> day = std::nullopt) {
        Task t;
        t.id = id;
        t.name = id;
        t.day = day;
        if (opId) t.source = Source{"c1", *opId};
        return t;
    };
    auto event = [](const std::string &id, std::optional<std::string> day = std::nullopt) {
        Event e;
        e.id = id;
        e.name = id;
        e.start = "10:00";
        e.end = "11:00";
        e.day = day;
        return e;
    };
    auto st = [](std::vector<Task> tasks, std::vector<Event> events) {
        auto s = createEmptyState();
        s.tasks = std::move(tasks);
        s.events = std::move(events);
        return s;
    };
    const std::vector<State> states = {
        createEmptyState(),
        st({task("t0"), task("t1", OP_ID, "2026-10-20")}, {}),
        st({task("t1", OP_ID)}, {}),
        st({task("a", OP_ID, "2026-10-01"), task("b", OP_ID, "2026-10-02")}, {}),
        st({}, {event("e0"), event(UUID, "2026-10-21")}),
        st({task("t1", OP_ID, "2026-10-20")}, {event(UUID, "2026-10-21")}),
        st({task("t1", std::string("ffff"))}, {event("other")}),
    };
    bool same = true;
    for (const auto &s : states) same = same && parseOfferInPlanKey(offerInPlanKey(&s, UUID)) == findOfferInPlan(&s, UUID);
    const auto first = findOfferInPlan(&states[3], UUID);
    const auto ev = findOfferInPlan(&states[4], UUID);
    check(same && !offerInPlanKey(nullptr, UUID) && first && first->id == "a" && first->day == "2026-10-01" && ev
              && ev->kind == "event" && ev->id == UUID && !findOfferInPlan(&states[6], UUID)
              && !findOfferInPlan(&states[2], UUID)->day,
          "совпадает с findOfferInPlan на таблице состояний");
    const auto &a = states[1];
    const State b = a;
    check(offerInPlanKey(&a, UUID) == offerInPlanKey(&b, UUID) && offerInPlanKey(&a, UUID) == offerInPlanKey(&a, UUID),
          "ключ — одна и та же строка для одной записи в разных объектах состояния");
}


// ── «Принять» / «Отклонить» (web `taskOffers.ts`, `addTaskOfferToPlan`) ─────────────────────────────────────
static void respond() {
    using nlohmann::json;
    const auto content = json{{"kind", "task_offer"}, {"name", "Созвон по проекту"}, {"day", "2026-10-21"},
                              {"start", "14:30"}, {"minutes", 45}, {"text", "📅 …"}};
    const auto event = OfferFields::fromContent(content);
    check(offerKind(event) == "event", "день и время без шагов и срока — событие");
    auto task = event;
    task.steps = {"Подготовить вопросы"};
    check(offerKind(task) == "task", "с шагами — задание");
    auto due = event;
    due.due = "2026-10-25";
    check(offerKind(due) == "task", "со сроком — задание");
    auto badTime = event;
    badTime.start = "25:00";
    check(offerKind(badTime) == "task", "негодное время — задание");
    check(offerEventEnd("14:30", 45) == "15:15" && offerEventEnd("14:30", std::nullopt) == "15:30"
              && offerEventEnd("23:30", 120) == "23:59" && offerEventEnd("09:00", 0) == "10:00",
          "конец события: длительность, час по умолчанию, не позже 23:59");

    const auto UUID = std::string("0a1b2c3d-0000-4000-8000-00000000abcd");
    const auto ev = offerPlanChange(UUID, "bob@local", event, "unused");
    check(ev.contains("event") && ev["event"]["id"] == UUID && ev["event"]["end"] == "15:15"
              && ev["event"]["day"] == "2026-10-21" && ev["event"]["repeat"].is_null() && ev["event"]["color"] == 0,
          "событие: id карточки, конец, день, без повтора");
    const auto tk = offerPlanChange(UUID, "bob@local", task, "t-new");
    check(tk.contains("task") && tk["task"]["id"] == "t-new" && tk["task"]["source"]["chat"] == "bob@local"
              && tk["task"]["source"]["opId"] == "0a1b2c3d00004000800000000000abcd"
              && tk["task"]["steps"][0]["text"] == "Подготовить вопросы" && tk["task"]["steps"][0]["isDone"] == false
              && tk["task"]["minutes"] == 45 && tk["task"]["status"] == "queue",
          "задание: source с uuid без дефисов, шаги, оценка");
    auto bare = OfferFields::fromContent(json{{"name", "Прочитать главу"}});
    const auto bt = offerPlanChange(UUID, "bob@local", bare, "t2");
    check(bt["task"]["minutes"].is_null() && bt["task"]["day"] == "" && bt["task"]["due"] == "",
          "без оценки — null, без дня и срока — пустые строки");
    check(taskResponseText("Созвон", true, "event") == "✅ Принято: событие «Созвон»"
              && taskResponseText("Отчёт", false, "task") == "❌ Отклонено: задание «Отчёт»",
          "текст ответа как в web");
    check(OfferFields::fromContent(json{{"name", "x"}, {"minutes", 0}}).minutes == std::nullopt
              && OfferFields::fromContent(json::array()).name.empty(),
          "нулевая оценка — нет оценки; не объект — пусто");
}

// Ревью безопасности 21 окт 2026 (2.3): длительность от собеседника — до int(value) проверка диапазона
static void minutesRange() {
    const auto of = [](nlohmann::json v) { return OfferFields::fromContent(nlohmann::json{{"name", "x"}, {"minutes", v}}).minutes; };
    check(of(90) == 90 && of(kOfferMaxMinutes) == kOfferMaxMinutes, "минуты в пределах — как есть");
    check(!of(4294967295u) && !of(2147483648.0) && !of(1e300) && !of(kOfferMaxMinutes + 1),
          "uint32 4294967295, 2^31, 1e300, больше недели — нет длительности (без переполнения int)");
    {
        const auto bad = OfferFields::fromContent(nlohmann::json{{"name", "x"}, {"day", "завтра"}, {"start", std::string(400, '9')},
                                                                  {"due", "2026-13-45x"}});
        const auto good = OfferFields::fromContent(nlohmann::json{{"name", "x"}, {"day", "2026-10-21"}, {"start", "14:30"},
                                                                   {"due", "2026-10-25"}});
        check(!bad.day && !bad.start && !bad.due && good.day && good.start && good.due,
              "день, время и срок вне формата отбрасываются (движок такое отвергает)");
    }
    check(!of(0) && !of(-5) && !of(std::numeric_limits<double>::quiet_NaN()), "0, отрицательное, NaN — нет");
    check(offerEventEnd("10:00", 2147483647) == "23:59" && offerEventEnd("bad", 30) == "00:30",
          "конец события: без переполнения и исключения при негодном начале");
}

int main() {
    std::printf("=== parvane-core task offer tests (без стека) ===\n");
    minutesRange();
    card();
    planKey();
    respond();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
