// Parvane fork (spec 029, T061): тесты словаря правок ввода текстом — перенос случаев web
// `plannerQuickLearn.test.ts` (длительность, тип, данные «Плана», потолок слов). Случаи хранилища устройства
// (localStorage) и вливания записи устройства не перенесены: на desktop этого запасного пути нет.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_quick_learn.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static QuickContext ctx() {
    QuickContext c;
    c.today = "2026-10-08";
    c.nowMinutes = 12 * 60;
    c.dayStart = 9 * 60;
    c.dayEnd = 21 * 60;
    return c;
}

struct User {
    std::optional<std::string> kind;
    std::optional<std::vector<std::string>> skip;
    std::optional<std::string> lang;
};

// Добавить строку так, как это делает окно: `user` — выбор пользователя (тип, снятые чипы)
static LearnResult add(const LearnStore &store, const std::string &text, const User &user = {}) {
    auto base = ctx();
    if (user.lang) base.lang = user.lang;
    const auto autoDraft = parseQuickInput(text, base);
    auto withUser = base;
    withUser.learned = learnedDefaults(store);
    withUser.kind = user.kind;
    withUser.skip = user.skip;
    return recordCorrection(store, autoDraft, parseQuickInput(text, withUser));
}

static LearnStore addTimes(LearnStore store, int times, const std::string &text, const User &user = {}) {
    for (int i = 0; i < times; ++i) store = add(store, text, user).store;
    return store;
}

static QuickDraft parseWith(const std::string &text, const LearnStore &store) {
    auto c = ctx();
    c.learned = learnedDefaults(store);
    return parseQuickInput(text, c);
}

static bool hasMinutes(const LearnStore &store, const std::string &head, double value, int count) {
    const auto it = store.heads.find(head);
    return it != store.heads.end() && it->second.minutes && it->second.minutes->value == value
        && it->second.minutes->count == count;
}

static bool hasKind(const LearnStore &store, const std::string &head, const std::string &value, int count) {
    const auto it = store.heads.find(head);
    return it != store.heads.end() && it->second.kind && it->second.kind->value == value
        && it->second.kind->count == count;
}

static bool learnedIs(const LearnStore &store, const std::string &head, std::optional<std::string> kind,
                      std::optional<double> minutes, size_t size = 1) {
    const auto defaults = learnedDefaults(store);
    const auto it = defaults.find(head);
    return defaults.size() == size && it != defaults.end() && it->second.kind == kind
        && it->second.minutes == minutes;
}

static void durations() {
    std::printf("словарь правок: длительность\n");
    {
        auto store = addTimes({}, kLearnThreshold - 1, "летучка завтра 10:00 20 мин");
        check(hasMinutes(store, "летучка", 20, 2), "две правки — счётчик 2");
        check(learnedDefaults(store).empty(), "до порога умолчаний нет");
        check(parseWith("летучка завтра 11:00", store).end == "12:00", "до порога — обычная длительность");
        store = add(store, "Летучка отдела пт 15:00-15:20").store;
        check(learnedIs(store, "летучка", std::nullopt, 20), "третья правка диапазоном — выучено 20 мин");
        const auto fourth = parseWith("летучка завтра 11:00", store);
        check(fourth.start == "11:00" && fourth.end == "11:20" && fourth.learned
                  && *fourth.learned == std::vector<std::string>{"minutes"},
              "выученная длительность подставляется");
    }
    {
        const auto learned = addTimes({}, kLearnThreshold, "летучка завтра 10:00 20 мин");
        check(!add(learned, "летучка завтра 11:00").changed, "принятое выученное — без изменений");
        const LearnStore empty;
        check(!add(empty, "летучка завтра 11:00").changed, "запись без правки — без изменений");
        check(!add(empty, "летучка завтра 11:00 1 ч").changed, "названа обычная длительность");
        check(!add(empty, "пара завтра 9:00 1 ч 45 мин").changed, "обычная длительность «пары»");
        check(!add(empty, "задача летучка завтра 11:00 20 мин").changed, "задача — не правка");
        check(!add(empty, "завтра 11:00 20 мин").changed, "без названия — не правка");
        check(!add(empty, "обед 520 ккал").changed, "еда — не правка");
    }
    {
        const auto store = addTimes({}, kLearnMaxCount + 3, "летучка завтра 10:00 20 мин");
        check(hasMinutes(store, "летучка", 20, kLearnMaxCount), "счётчик упирается в потолок");
    }
    {
        auto store = addTimes({}, kLearnThreshold, "летучка завтра 10:00 20 мин");
        store = add(store, "летучка завтра 10:00 40 мин").store;
        check(hasMinutes(store, "летучка", 20, 2) && learnedDefaults(store).empty(), "правка в другую сторону −1");
        store = add(store, "летучка завтра 10:00 40 мин").store;
        check(hasMinutes(store, "летучка", 20, 1), "ещё −1");
        store = add(store, "летучка завтра 10:00 40 мин").store;
        check(hasMinutes(store, "летучка", 40, 1), "на нуле значение заменяется");
        store = add(store, "летучка завтра 10:00 60 мин").store;
        check(!store.heads.count("летучка"), "обычная длительность на нуле — слово забыто");
    }
    {
        const auto learned = addTimes({}, kLearnThreshold, "летучка завтра 10:00 20 мин");
        const auto store = add(learned, "летучка завтра 11:00", User{std::nullopt, std::vector<std::string>{"minutes"}})
                               .store;
        check(hasMinutes(store, "летучка", 20, kLearnThreshold - 1), "снятый чип уменьшает счётчик");
        check(!add(store, "летучка завтра 11:00").changed, "пока не выучено — без изменений");
    }
    {
        const auto store = addTimes({}, kLearnThreshold, "пара завтра 9:00 1,5 ч");
        check(learnedIs(store, "пара", std::nullopt, 90), "«пара» учится от 1 ч 45 мин");
        check(parseWith("пара вт 15:00", store).end == "16:30", "выученная длительность «пары»");
    }
}

static void kinds() {
    std::printf("словарь правок: тип\n");
    const User asTask{std::string("task")};
    const User asEvent{std::string("event")};
    {
        auto store = addTimes({}, kLearnThreshold - 1, "купить хлеб 18:00", asTask);
        check(learnedDefaults(store).empty(), "до порога типа нет");
        store = add(store, "Купить сыр завтра 19:00", asTask).store;
        check(learnedIs(store, "купить", std::string("task"), std::nullopt), "три переключения — тип выучен");
        const auto fourth = parseWith("купить молоко 18:00", store);
        check(fourth.kind == "task" && fourth.start == "18:00" && fourth.learned
                  && *fourth.learned == std::vector<std::string>{"kind"},
              "выученный тип подставляется");
        check(!add(store, "купить молоко 18:00").changed, "принятый выученный тип — без изменений");
        check(!add(store, "купить молоко").changed, "разбор и сам выбрал бы этот тип");
    }
    {
        const auto store = addTimes({}, kLearnThreshold, "др Маши завтра", asEvent);
        const auto parsed = parseWith("др Пети 20.10", store);
        check(parsed.kind == "event" && parsed.isAllDay.value_or(false) && parsed.day == "2026-10-20"
                  && parsed.learned && *parsed.learned == std::vector<std::string>{"kind"},
              "«др» учится как событие");
    }
    {
        const LearnStore empty;
        check(!add(empty, "купить хлеб 18:00", asEvent).changed, "выбор разбора — не правка");
        check(!add(empty, "задача купить хлеб 18:00").changed, "слово-тип — не правка");
        check(!add(empty, "купить хлеб 18:00", User{std::string("food")}).changed, "тип еды — не правка");
    }
    {
        const auto learned = addTimes({}, kLearnThreshold, "купить хлеб 18:00", asTask);
        auto store = add(learned, "купить хлеб 18:00", User{std::nullopt, std::vector<std::string>{"kind"}}).store;
        check(hasKind(store, "купить", "task", 2), "снятый чип типа −1");
        check(!add(store, "купить хлеб 18:00").changed, "не выучено — событие без правки");
        store = add(learned, "купить хлеб 18:00", asEvent).store;
        check(hasKind(store, "купить", "task", 2), "обратное переключение −1");
        store = add(learned, "купить хлеб", asEvent).store;
        check(hasKind(store, "купить", "task", 2), "обратная правка там, где разбор выбрал бы выученное");
    }
    {
        auto store = addTimes({}, kLearnThreshold, "летучка завтра 10:00 20 мин");
        store = addTimes(store, kLearnThreshold, "летучка завтра", asEvent);
        check(learnedIs(store, "летучка", std::string("event"), 20), "тип и длительность учатся отдельно");
        store = addTimes(store, kLearnThreshold, "летучка завтра 10:00 1 ч");
        check(learnedIs(store, "летучка", std::string("event"), std::nullopt), "длительность разучивается");
    }
    {
        const auto store = addTimes({}, kLearnThreshold, "constructor tomorrow 10:00 20 min",
                                    User{std::nullopt, std::nullopt, std::string("en")});
        check(learnedIs(store, "constructor", std::nullopt, 20) && store.heads.size() == 1,
              "слово с именем свойства объекта — обычное слово");
    }
}

static void words() {
    std::printf("словарь правок: данные «Плана»\n");
    {
        auto store = addTimes({}, kLearnThreshold, "летучка завтра 10:00 20 мин");
        store = addTimes(store, 2, "др мамы 12 октября", User{std::string("event")});
        const auto list = learnStoreToWords(store);
        check(list.size() == 2 && list[0].id == "др" && list[0].kind == "event" && list[0].kindCount == 2
                  && !list[0].minutes && list[0].minutesCount == 0 && list[0].touched == 5
                  && list[1].id == "летучка" && !list[1].kind && list[1].kindCount == 0 && list[1].minutes == 20
                  && list[1].minutesCount == 3 && list[1].touched == 3,
              "словарь → слова «Плана»");
        const auto back = learnStoreFromWords(list);
        check(back == store, "слова → словарь без потерь");
        check(learnedIs(back, "летучка", std::nullopt, 20), "умолчания из слов");
    }
    {
        LearnStore store;
        store.tick = 4;
        std::string longHead;
        for (int i = 0; i < 33; ++i) longHead += "я";
        store.heads[longHead] = LearnHead{LearnCounted<std::string>{"event", 3}, std::nullopt, 1};
        store.heads["миг"] = LearnHead{std::nullopt, LearnCounted<double>{2, 3}, 2};
        store.heads["зал"] = LearnHead{LearnCounted<std::string>{"event", 1}, LearnCounted<double>{3, 2}, 3};
        store.heads["урок"] = LearnHead{std::nullopt, LearnCounted<double>{45, 3}, 4};
        const auto list = learnStoreToWords(store);
        check(list.size() == 2 && list[0].id == "зал" && !list[0].minutes && list[1].id == "урок"
                  && list[1].minutes == 45,
              "негодное движку в «План» не уходит");
        LearnedWord emptyWord;
        emptyWord.id = "пусто";
        emptyWord.touched = 9;
        LearnedWord para;
        para.id = "пара";
        para.minutes = 105;
        para.minutesCount = 9;
        para.touched = 2;
        const auto read = learnStoreFromWords({emptyWord, para});
        check(read.tick == 2 && read.heads.size() == 1 && read.heads.at("пара").minutes
                  && read.heads.at("пара").minutes->value == 105
                  && read.heads.at("пара").minutes->count == kLearnMaxCount,
              "негодное из «Плана» пропускается");
    }
    {
        const auto draft = [](const std::string &text, const std::vector<LearnedWord> &list) {
            auto c = ctx();
            c.learned = learnedDefaults(learnStoreFromWords(list));
            return std::make_pair(parseQuickInput(text, ctx()), parseQuickInput(text, c));
        };
        auto [a0, f0] = draft("летучка завтра 11:00", {});
        check(!correctWords({}, a0, f0), "писать нечего — nullopt");
        auto [a1, f1] = draft("летучка завтра 10:00 20 мин", {});
        const auto first = correctWords({}, a1, f1);
        check(first && first->size() == 1 && (*first)[0].id == "летучка" && (*first)[0].minutes == 20
                  && (*first)[0].minutesCount == 1 && (*first)[0].touched == 1,
              "первая правка — одно слово");
        auto [a2, f2] = draft("летучка завтра 10:00 20 мин", *first);
        const auto second = correctWords(*first, a2, f2);
        check(second && (*second)[0].minutesCount == 2 && (*second)[0].touched == 2, "вторая правка растит счётчик");
    }
    {
        std::vector<LearnedWord> full;
        for (size_t index = 0; index < kLearnMaxHeads; ++index) {
            LearnedWord word;
            std::u16string tail{char16_t(1072 + (index % 26)), char16_t(1072 + index / 26)};
            std::string tailUtf8;
            for (const char16_t c : tail) {
                tailUtf8.push_back(char(0xC0 | (c >> 6)));
                tailUtf8.push_back(char(0x80 | (c & 0x3F)));
            }
            word.id = "слово" + tailUtf8;
            word.minutes = 20;
            word.minutesCount = 1;
            word.touched = double(index + 1);
            full.push_back(word);
        }
        const auto oldest = full[0].id;
        const std::string text = "летучка завтра 10:00 20 мин";
        const auto next = correctWords(full, parseQuickInput(text, ctx()), parseQuickInput(text, ctx()));
        bool hasOldest = false;
        bool newTouched = false;
        if (next) {
            for (const auto &word : *next) {
                if (word.id == oldest) hasOldest = true;
                if (word.id == "летучка" && word.touched == double(kLearnMaxHeads + 1)) newTouched = true;
            }
        }
        check(next && next->size() == kLearnMaxHeads && !hasOldest && newTouched,
              "потолок слов: самое старое вытеснено");
    }
}

int main() {
    std::printf("=== parvane-core planner quick learn tests (без стека) ===\n");
    durations();
    kinds();
    words();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
