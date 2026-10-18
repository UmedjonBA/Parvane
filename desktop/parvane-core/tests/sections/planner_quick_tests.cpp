// Parvane fork (spec 029, фаза 4): ввод текстом «Плана» — тесты 1:1 с web
// `components/parvane/planner/plannerQuick.test.ts` (вся таблица строк — главный сторож) и
// `plannerQuickRemind.test.ts`.
//
// Таблица перенесена из web генератором без правок: строка → ожидание (как `toMatchObject`: поля ожидания
// сверяются, массивы — поэлементно; `null` — «поля быть не должно», в web это `undefined`) → поправки контекста.
// Позиции участков — в единицах UTF-16, как в web.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <regex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/planner_quick.h"

using namespace parvane::sections::planner;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// 8 октября 2026 — четверг, полдень; окно дня 09:00–21:00
static json baseCtx(bool en) {
    json ctx = {{"today", "2026-10-08"}, {"nowMinutes", 12 * 60}, {"dayStart", 9 * 60}, {"dayEnd", 21 * 60}};
    if (en) ctx["lang"] = "en";
    return ctx;
}

static QuickDraft parse(const std::string &input, const json &over = json::object(), bool en = false) {
    json ctx = baseCtx(en);
    for (const auto &[key, value] : over.items()) ctx[key] = value;
    return parseQuickInput(input, quickContextFromJson(ctx));
}

// toMatchObject: ожидание — подмножество; null в ожидании — поле отсутствует
static bool matches(const json &actual, const json &expected, const std::string &path, std::string &why) {
    if (expected.is_null()) {
        if (!actual.is_null()) {
            why = path + ": ожидалось отсутствие, получено " + actual.dump();
            return false;
        }
        return true;
    }
    if (expected.is_object()) {
        if (!actual.is_object()) {
            why = path + ": ожидался объект, получено " + actual.dump();
            return false;
        }
        for (const auto &[key, value] : expected.items()) {
            const json got = actual.contains(key) ? actual[key] : json();
            if (!matches(got, value, path + "." + key, why)) return false;
        }
        return true;
    }
    if (expected.is_array()) {
        if (!actual.is_array() || actual.size() != expected.size()) {
            why = path + ": ожидалось " + expected.dump() + ", получено " + actual.dump();
            return false;
        }
        for (size_t i = 0; i < expected.size(); ++i) {
            if (!matches(actual[i], expected[i], path + "[" + std::to_string(i) + "]", why)) return false;
        }
        return true;
    }
    if (expected.is_number()) {
        if (!actual.is_number() || std::fabs(actual.get<double>() - expected.get<double>()) > 1e-9) {
            why = path + ": ожидалось " + expected.dump() + ", получено " + actual.dump();
            return false;
        }
        return true;
    }
    if (actual != expected) {
        why = path + ": ожидалось " + expected.dump() + ", получено " + actual.dump();
        return false;
    }
    return true;
}

struct Section {
    const char *name;
    bool en; // база — английский интерфейс (EN), иначе CTX
    const char *rows;
};

// ── таблица строк web (plannerQuick.test.ts, все `run([...])`) ───────────────
static const Section kSections[] = {
    {"ввод текстом: тип и название", false, R"PV([
        ["купить блок питания",{"kind":"task","name":"купить блок питания","day":null,"error":null}],
        ["Позвонить Маме",{"kind":"task","name":"Позвонить Маме"}],
        ["задача проверить работы",{"kind":"task","name":"проверить работы"}],
        ["Задача: проверить работы",{"kind":"task","name":"проверить работы"}],
        ["задачу проверить работы",{"kind":"task","name":"проверить работы"}],
        ["задачник по физике",{"kind":"task","name":"задачник по физике"}],
        ["событие педсовет",{"kind":"event","name":"педсовет","isAllDay":true,"day":"2026-10-08"}],
        ["созвон 16:00",{"kind":"event","name":"созвон","start":"16:00","end":"16:30"}],
        ["доклад 16:00",{"kind":"event","name":"доклад","start":"16:00","end":"17:00"}],
        ["задача созвон 16:00",{"kind":"task","name":"созвон","start":"16:00","minutes":30,"day":"2026-10-08"}],
        ["",{"kind":"task","name":"","error":"name"}],
        ["   ",{"kind":"task","name":"","error":"name"}],
        ["завтра 15:00",{"kind":"event","name":"","error":"name"}],
        ["созвон 16:00",{"kind":"task","name":"созвон","start":"16:00","minutes":30},{"kind":"task"}],
        ["отчёт",{"kind":"event","name":"отчёт","isAllDay":true},{"kind":"event"}],
        ["обед 520 ккал",{"kind":"task","name":"обед 520 ккал"},{"kinds":["task","event"]}],
        ["вода 500 мл",{"kind":"task","name":"вода 500 мл"},{"kinds":["task","event"]}]
    ])PV"},
    {"ввод текстом: время", false, R"PV([
        ["созвон 9:05",{"start":"09:05","end":"09:35","day":"2026-10-09","isDayAssumed":true}],
        ["созвон в 15:30",{"name":"созвон","start":"15:30","end":"16:00","day":"2026-10-08","isDayAssumed":true}],
        ["созвон в 15",{"name":"созвон","start":"15:00","end":"15:30"}],
        ["созвон в 5",{"name":"созвон","start":"17:00","end":"17:30"}],
        ["созвон в 9",{"name":"созвон","start":"09:00","day":"2026-10-09"}],
        ["созвон в 12",{"name":"созвон","start":"12:00","day":"2026-10-09"}],
        ["созвон в 5 вечера",{"name":"созвон","start":"17:00"}],
        ["созвон в 5 утра",{"name":"созвон","start":"05:00","day":"2026-10-09"}],
        ["созвон в 2 дня",{"name":"созвон","start":"14:00"}],
        ["созвон в 11 ночи",{"name":"созвон","start":"23:00","end":"23:30"}],
        ["доклад в 11 ночи",{"name":"доклад","start":"23:00","end":"23:59"}],
        ["созвон в 7:30 вечера",{"name":"созвон","start":"19:30","end":"20:00"}],
        ["созвон в 5",{"start":"05:00"},{"dayStart":240,"dayEnd":720}],
        ["пара с 10 до 12",{"kind":"event","name":"пара","start":"10:00","end":"12:00","minutes":120}],
        ["пара 10:00-11:30",{"name":"пара","start":"10:00","end":"11:30","minutes":90}],
        ["пара 10–12:30",{"name":"пара","start":"10:00","end":"12:30"}],
        ["пара 10:00 — 11:00",{"name":"пара","start":"10:00","end":"11:00"}],
        ["счёт 10-12",{"kind":"task","name":"счёт 10-12","start":null}],
        ["сон 23:40-07:30",{"kind":"event","error":"time"},{"kinds":["task","event"]}],
        ["созвон 23:30",{"start":"23:30","end":"23:59","error":null}],
        ["доклад 23:30",{"start":"23:30","end":null,"error":"time"}],
        ["созвон 23:00",{"start":"23:00","end":"23:30","error":null}],
        ["доклад 23:00",{"start":"23:00","end":"23:59","error":null}],
        ["созвон 25:00",{"kind":"task","name":"созвон 25:00"}],
        ["созвон 16:00 и 18:00",{"name":"созвон и 18:00","start":"16:00"}],
        ["версия 3.5",{"kind":"task","name":"версия 3.5","day":null}],
        ["встреча в 15.10",{"kind":"task","name":"встреча","day":"2026-10-15","start":null}]
    ])PV"},
    {"ввод текстом: длительность", false, R"PV([
        ["созвон 16:00 45 мин",{"name":"созвон","start":"16:00","end":"16:45","minutes":45}],
        ["созвон 16:00 1,5 ч",{"name":"созвон","end":"17:30","minutes":90}],
        ["созвон 16:00 2 часа",{"name":"созвон","end":"18:00"}],
        ["созвон 16:00 1 ч 30 мин",{"name":"созвон","end":"17:30","minutes":90}],
        ["созвон 16:00 полчаса",{"name":"созвон","end":"16:30"}],
        ["созвон 16:00 полтора часа",{"name":"созвон","end":"17:30"}],
        ["разобрать почту 20 минут",{"kind":"task","name":"разобрать почту","minutes":20,"day":null}],
        ["разобрать почту 45м",{"kind":"task","name":"разобрать почту","minutes":45}],
        ["задача отчёт завтра 18:00 40 мин",{"kind":"task","name":"отчёт","day":"2026-10-09","start":"18:00","minutes":40}],
        ["купить 5 метров кабеля",{"name":"купить 5 метров кабеля","minutes":null}],
        ["курс 5 мес",{"name":"курс 5 мес","minutes":null,"repeat":null}],
        ["созвон 23:00 2 часа",{"error":"time"}],
        ["задача уборка 23:30 60 мин",{"kind":"task","error":"pastMidnight"}]
    ])PV"},
    {"ввод текстом: дата и срок", false, R"PV([
        ["отчёт сегодня",{"kind":"task","name":"отчёт","day":"2026-10-08"}],
        ["отчёт завтра",{"name":"отчёт","day":"2026-10-09","isDayAssumed":null}],
        ["отчёт послезавтра",{"name":"отчёт","day":"2026-10-10"}],
        ["отчёт через 3 дня",{"name":"отчёт","day":"2026-10-11"}],
        ["отчёт через неделю",{"name":"отчёт","day":"2026-10-15"}],
        ["отчёт через 2 недели",{"name":"отчёт","day":"2026-10-22"}],
        ["отчёт на следующей неделе",{"name":"отчёт","day":"2026-10-12"}],
        ["отчёт в пт",{"name":"отчёт","day":"2026-10-09"}],
        ["отчёт в пятницу",{"name":"отчёт","day":"2026-10-09"}],
        ["отчёт в чт",{"name":"отчёт","day":"2026-10-15"}],
        ["отчёт во вторник",{"name":"отчёт","day":"2026-10-13"}],
        ["отчёт вс",{"name":"отчёт","day":"2026-10-11"}],
        ["отчёт в среду",{"name":"отчёт","day":"2026-10-14"}],
        ["отчёт 12.10",{"name":"отчёт","day":"2026-10-12"}],
        ["отчёт 05.03",{"name":"отчёт","day":"2027-03-05"}],
        ["отчёт 08.10",{"name":"отчёт","day":"2026-10-08"}],
        ["отчёт 12.10.2027",{"name":"отчёт","day":"2027-10-12"}],
        ["отчёт 31.02",{"name":"отчёт 31.02","day":null}],
        ["отчёт 12 октября",{"name":"отчёт","day":"2026-10-12"}],
        ["отчёт 1 мая",{"name":"отчёт","day":"2027-05-01"}],
        ["отчёт 3 марта",{"name":"отчёт","day":"2027-03-03"}],
        ["отчёт на завтра",{"name":"отчёт","day":"2026-10-09"}],
        ["созвон чт 16:00",{"kind":"event","name":"созвон","day":"2026-10-15","start":"16:00","end":"16:30"}],
        ["зал завтра 19:00 60 мин",{"kind":"event","name":"зал","day":"2026-10-09","start":"19:00","end":"20:00"}],
        ["задача проверить работы до пт",{"kind":"task","name":"проверить работы","due":"2026-10-09","day":null}],
        ["отчёт до 20.10",{"name":"отчёт","due":"2026-10-20"}],
        ["отчёт до завтра",{"name":"отчёт","due":"2026-10-09"}],
        ["отчёт до марта",{"name":"отчёт","due":"2027-03-01"}],
        ["отчёт завтра до пт",{"name":"отчёт","day":"2026-10-09","due":"2026-10-09"}],
        ["отчёт в пн до пт",{"name":"отчёт","day":"2026-10-12","due":"2026-10-09","error":"dayAfterDue"}],
        ["дойти до магазина",{"name":"дойти до магазина","due":null}],
        ["блок питания 1000 Вт",{"name":"блок питания 1000 Вт","day":null}],
        ["лампа 60 вт и провод",{"name":"лампа 60 вт и провод","day":null}],
        ["среди документов найти договор",{"name":"среди документов найти договор","day":null}],
        ["мартышка и очки",{"name":"мартышка и очки","day":null}],
        ["отчёт завтра и послезавтра",{"name":"отчёт и послезавтра","day":"2026-10-09"}],
        ["Сдать ОТЧЁТ Завтра",{"name":"Сдать ОТЧЁТ","day":"2026-10-09"}],
        ["ёлку купить завтра",{"name":"ёлку купить","day":"2026-10-09"}]
    ])PV"},
    {"ввод текстом: повтор", false, R"PV([
        ["урок вт 15:00 каждую неделю 5 мес",{"kind":"event","name":"урок","start":"15:00","end":"15:45","day":"2026-10-13","repeat":{"kind":"weekly","interval":1,"weekdays":[2],"startDay":"2026-10-13","endDay":"2027-03-13"},"error":null}],
        ["зарядка каждый день",{"kind":"task","name":"зарядка","repeat":{"kind":"daily","interval":1,"startDay":"2026-10-08"}}],
        ["зарядка ежедневно 8:00 15 мин",{"kind":"event","name":"зарядка","start":"08:00","end":"08:15","repeat":{"kind":"daily","startDay":"2026-10-08"}}],
        ["полив каждые 3 дня",{"name":"полив","repeat":{"kind":"daily","interval":3}}],
        ["отчёт каждую неделю",{"name":"отчёт","repeat":{"kind":"weekly","interval":1,"weekdays":[4],"startDay":"2026-10-08"}}],
        ["отчёт еженедельно",{"name":"отчёт","repeat":{"kind":"weekly","interval":1,"weekdays":[4]}}],
        ["отчёт каждые 2 недели",{"name":"отчёт","repeat":{"kind":"weekly","interval":2,"weekdays":[4]}}],
        ["отчёт раз в две недели",{"name":"отчёт","repeat":{"kind":"weekly","interval":2}}],
        ["отчёт раз в неделю",{"name":"отчёт","repeat":{"kind":"weekly","interval":1}}],
        ["аренда каждый месяц",{"name":"аренда","repeat":{"kind":"monthly","interval":1,"startDay":"2026-10-08"}}],
        ["аренда ежемесячно 20.10",{"name":"аренда","repeat":{"kind":"monthly","startDay":"2026-10-20"}}],
        ["страховка каждый год",{"name":"страховка","repeat":{"kind":"yearly","interval":1}}],
        ["страховка ежегодно",{"name":"страховка","repeat":{"kind":"yearly"}}],
        ["зал по будням 19:00",{"kind":"event","name":"зал","repeat":{"kind":"weekly","interval":1,"weekdays":[1,2,3,4,5],"startDay":"2026-10-08"}}],
        ["уборка по выходным",{"name":"уборка","repeat":{"kind":"weekly","interval":1,"weekdays":[0,6],"startDay":"2026-10-10"}}],
        ["зал по пн, ср и пт 19:00",{"name":"зал","start":"19:00","repeat":{"kind":"weekly","interval":1,"weekdays":[1,3,5],"startDay":"2026-10-09"}}],
        ["урок по вт и чт в 5 вечера 45 мин",{"kind":"event","name":"урок","start":"17:00","end":"17:45","repeat":{"kind":"weekly","interval":1,"weekdays":[2,4],"startDay":"2026-10-08"}}],
        ["урок по вторникам",{"name":"урок","repeat":{"kind":"weekly","interval":1,"weekdays":[2],"startDay":"2026-10-13"}}],
        ["урок каждый вторник 15:00",{"name":"урок","repeat":{"kind":"weekly","interval":1,"weekdays":[2]}}],
        ["урок каждую пятницу",{"name":"урок","repeat":{"kind":"weekly","interval":1,"weekdays":[5],"startDay":"2026-10-09"}}],
        ["урок каждую неделю до 20.12",{"name":"урок","repeat":{"kind":"weekly","interval":1,"endDay":"2026-12-20"},"due":null}],
        ["урок каждую неделю до марта",{"name":"урок","repeat":{"kind":"weekly","interval":1,"endDay":"2027-03-01"}}],
        ["Рисование(ауд. 12) по понидельникам с 17:00 до 18:30 каждую ниделю",{"kind":"event","name":"Рисование(ауд. 12)","start":"17:00","end":"18:30","repeat":{"kind":"weekly","interval":1,"weekdays":[1]}}],
        ["пара в суботу в 9:00 каждую ниделю",{"kind":"event","name":"пара","start":"09:00","end":"10:45","repeat":{"kind":"weekly","interval":1,"weekdays":[6]}}],
        ["урок завтра 9:00",{"kind":"event","name":"урок","start":"09:00","end":"09:45"}],
        ["ОГЭ по ИНформатике каждый пн в 18:30 пара",{"kind":"event","name":"ОГЭ по ИНформатике","start":"18:30","end":"20:15","repeat":{"kind":"weekly","interval":1,"weekdays":[1]}}],
        ["английский завтра 9:00 урок",{"kind":"event","name":"английский урок","start":"09:00","end":"10:00"}],
        ["английский завтра 9:00 60 мин пара",{"kind":"event","name":"английский пара","start":"09:00","end":"10:00"}],
        ["пара",{"kind":"task","name":"пара"}],
        ["купить пару носков завтра 9:00",{"kind":"event","name":"купить пару носков","start":"09:00","end":"10:00"}],
        ["урок завтра 9:00 60 мин",{"kind":"event","start":"09:00","end":"10:00"}],
        ["пара завтра с 9 до 10:30",{"kind":"event","start":"09:00","end":"10:30"}],
        ["сдать пару отчётов завтра 9:00",{"kind":"event","start":"09:00","end":"10:00"}],
        ["урок по понедльникам 15:00",{"kind":"event","name":"урок","repeat":{"kind":"weekly","interval":1,"weekdays":[1]}}],
        ["завтрак с мамой завтар 9:00",{"kind":"event","name":"завтрак с мамой","day":"2026-10-09"}],
        ["выходные задачи события",{"kind":"task","name":"выходные задачи события","repeat":null}],
        ["урок каждую неделю 10 раз",{"name":"урок","repeat":{"kind":"weekly","interval":1,"count":10}}],
        ["урок каждую неделю 6 недель",{"name":"урок","repeat":{"kind":"weekly","interval":1,"endDay":"2026-11-19"}}],
        ["урок каждый день 2 мес",{"name":"урок","repeat":{"kind":"daily","endDay":"2026-12-08"}}],
        ["урок по вт с 12.10",{"name":"урок с","repeat":{"kind":"weekly","interval":1,"weekdays":[2],"startDay":"2026-10-13"}}],
        ["повторить 10 раз упражнение",{"name":"повторить 10 раз упражнение","repeat":null}],
        ["поговорить по душам",{"name":"поговорить по душам","repeat":null}]
    ])PV"},
    {"ввод текстом: снятые значения остаются в названии", false, R"PV([
        ["созвон завтра 16:00",{"kind":"task","name":"созвон 16:00","day":"2026-10-09"},{"skip":["time"]}],
        ["созвон завтра 16:00",{"name":"созвон завтра","start":"16:00","day":"2026-10-08"},{"skip":["day"]}],
        ["отчёт до пт",{"name":"отчёт до","due":null,"day":"2026-10-09"},{"skip":["due"]}],
        ["урок каждую неделю",{"name":"урок каждую неделю","repeat":null},{"skip":["repeat"]}],
        ["разобрать почту 20 минут",{"name":"разобрать почту 20 минут","minutes":null},{"skip":["minutes"]}],
        ["задача отчёт",{"name":"задача отчёт"},{"skip":["kind"]}]
    ])PV"},
    {"ввод текстом: обычная длительность по первому слову названия", false, R"PV([
        ["вт 15:00 пара по английскому",{"kind":"event","name":"пара по английскому","description":null,"start":"15:00","end":"16:45"}],
        ["завтра в 9 урок",{"kind":"event","name":"урок","day":"2026-10-09","start":"09:00","end":"09:45"}],
        ["пара завтра 9:00",{"name":"пара","start":"09:00","end":"10:45"}],
        ["событие пара 10:00",{"kind":"event","name":"пара","start":"10:00","end":"11:45"}],
        ["сдать пару отчётов завтра 9:00",{"name":"сдать пару отчётов","start":"09:00","end":"10:00"}],
        ["подготовка к уроку завтра 9:00",{"name":"подготовка к уроку","end":"10:00"}],
        ["вт 15:00 пара по физике 2 часа",{"name":"пара по физике","end":"17:00"}],
        ["вт пара по физике 15:00-16:20",{"name":"пара по физике","end":"16:20"}],
        ["пара завтра 9:00 — принести тетрадь",{"name":"пара","description":"принести тетрадь","end":"10:45"}]
    ])PV"},
    {"ввод текстом: название и описание", false, R"PV([
        ["вт 15:00 пара по Английскому будет тест  лисининг",{"kind":"event","name":"пара по Английскому","description":"будет тест лисининг","day":"2026-10-13","start":"15:00","end":"16:45","error":null}],
        ["пара по Английскому вт 15:00 будет тест лисининг",{"kind":"event","name":"пара по Английскому","description":"будет тест лисининг","day":"2026-10-13","start":"15:00","end":"16:45","error":null}],
        ["пара по Английскому будет тест лисининг вт 15:00",{"kind":"event","name":"пара по Английскому","description":"будет тест лисининг","day":"2026-10-13","start":"15:00","end":"16:45","error":null}],
        ["пара по Английскому вт будет тест лисининг 15:00",{"kind":"event","name":"пара по Английскому","description":"будет тест лисининг","day":"2026-10-13","start":"15:00","end":"16:45","error":null}],
        ["пара по английскому — тест по лисенингу вт 15:00",{"name":"пара по английскому","description":"тест по лисенингу","day":"2026-10-13","end":"16:45"}],
        ["завтра созвон — обсудить бюджет в 16:00 45 мин",{"name":"созвон","description":"обсудить бюджет","day":"2026-10-09","start":"16:00","end":"16:45"}],
        ["созвон завтра 16:00 — обсудить бюджет",{"kind":"event","name":"созвон","description":"обсудить бюджет","day":"2026-10-09","start":"16:00","end":"16:30"}],
        ["созвон – обсудить бюджет",{"kind":"task","name":"созвон","description":"обсудить бюджет"}],
        ["купить молоко - 2 пакета",{"name":"купить молоко","description":"2 пакета"}],
        ["купить молоко -- 2 пакета",{"name":"купить молоко","description":"2 пакета"}],
        ["пара по английскому вт 15:00 -- тест по лисенингу",{"name":"пара по английскому","description":"тест по лисенингу","day":"2026-10-13","start":"15:00","end":"16:45"}],
        ["пара по английскому вт 15:00 - тест по лисенингу",{"name":"пара по английскому","description":"тест по лисенингу","day":"2026-10-13","start":"15:00","end":"16:45"}],
        ["встреча с Петей: бюджет, сроки",{"name":"встреча с Петей","description":"бюджет, сроки"}],
        ["купить подарок; маме нравятся серьги",{"name":"купить подарок","description":"маме нравятся серьги"}],
        ["Сдать отчёт. Приложить таблицу",{"name":"Сдать отчёт","description":"Приложить таблицу"}],
        ["стрижка сб 12:00 // мастер Аня",{"name":"стрижка","description":"мастер Аня","day":"2026-10-10","start":"12:00"}],
        ["созвон завтра\nобсудить бюджет\nи сроки",{"name":"созвон","description":"обсудить бюджет\nи сроки","day":"2026-10-09"}],
        ["отчёт: добавить графики",{"kind":"event","name":"отчёт","description":"добавить графики","isAllDay":true},{"kind":"event"}],
        ["Маме нужно позвонить — насчёт дачи",{"name":"Маме нужно позвонить","description":"насчёт дачи"}],
        ["встреча с куратором описание: обсудить диплом",{"name":"встреча с куратором","description":"обсудить диплом"}],
        ["встреча с куратором прим. взять зачётку",{"name":"встреча с куратором","description":"взять зачётку"}],
        ["встреча с куратором, заметка: взять зачётку",{"name":"встреча с куратором","description":"взять зачётку"}],
        ["встреча — примечание: взять паспорт",{"name":"встреча","description":"взять паспорт"}],
        ["пара по физике тема: оптика",{"name":"пара по физике","description":"тема: оптика"}],
        ["написать описание проекта",{"name":"написать описание проекта","description":null}],
        ["новая тема оформления",{"name":"новая тема оформления","description":null}],
        ["написать описание. Срочно",{"name":"написать описание","description":"Срочно"}],
        ["врач пт 10:30 нужно взять полис",{"kind":"event","name":"врач","description":"нужно взять полис","day":"2026-10-09","start":"10:30"}],
        ["собрание жильцов надо принести квитанции",{"name":"собрание жильцов","description":"надо принести квитанции"}],
        ["поездка в Казань не забыть зарядку",{"name":"поездка в Казань","description":"не забыть зарядку"}],
        ["бассейн взять шапочку",{"name":"бассейн","description":"взять шапочку"}],
        ["семинар принести ноутбук",{"name":"семинар","description":"принести ноутбук"}],
        ["контрольные будут сложные вопросы",{"name":"контрольные","description":"будут сложные вопросы"}],
        ["купить молоко, надо успеть до закрытия",{"name":"купить молоко","description":"надо успеть до закрытия"}],
        ["задача проверить работы до пт — классы 9Б и 10А",{"kind":"task","name":"проверить работы","due":"2026-10-09","description":"классы 9Б и 10А"}],
        ["отчёт до 20.10: добавить графики",{"name":"отчёт","due":"2026-10-20","description":"добавить графики"}],
        ["английский по вт и чт 18:00 — взять учебник",{"kind":"event","name":"английский","description":"взять учебник","repeat":{"kind":"weekly","interval":1,"weekdays":[2,4]}}],
        ["планёрка каждый день надо собрать статусы",{"kind":"task","name":"планёрка","description":"надо собрать статусы","repeat":{"kind":"daily","interval":1}}],
        ["пара по английскому во вторнек 15:00 будет тест",{"name":"пара по английскому","description":"будет тест","day":"2026-10-13","end":"16:45"}],
        ["отчёт послезавтро — приложить таблицу",{"name":"отчёт","description":"приложить таблицу","day":"2026-10-10"}],
        ["Рисование(ауд. 12) вт 15:00",{"name":"Рисование(ауд. 12)","description":null,"day":"2026-10-13"}],
        ["купить молоко, хлеб",{"name":"купить молоко, хлеб","description":null}],
        ["купить кое-что завтра",{"name":"купить кое-что","description":null}],
        ["пара 10:00 — 11:30",{"name":"пара","description":null,"end":"11:30"}],
        ["созвон 16:00 —",{"name":"созвон","description":null}],
        ["— купить хлеб",{"name":"купить хлеб","description":null}],
        ["1. купить хлеб",{"name":"1. купить хлеб","description":null}],
        ["зайти на ул. Ленина 5",{"name":"зайти на ул. Ленина 5","description":null}],
        ["доклад и т.д. завтра",{"name":"доклад и т.д.","description":null,"day":"2026-10-09"}],
        ["купить 2 кг. яблок",{"name":"купить 2 кг. яблок","description":null}],
        ["позвонить Иванову И. И. завтра",{"name":"позвонить Иванову И. И.","description":null}],
        ["у Пети будет день рождения",{"name":"у Пети будет день рождения","description":null}],
        ["презентация будет в 305 аудитории",{"name":"презентация","description":"будет в 305 аудитории"}],
        ["надо взять паспорт",{"name":"надо взять паспорт","description":null}],
        ["не забыть взять паспорт",{"name":"не забыть взять паспорт","description":null}],
        ["завтра надо купить молоко",{"name":"надо купить молоко","description":null,"day":"2026-10-09"}],
        ["мне надо купить молоко",{"name":"мне надо купить молоко","description":null}],
        ["в банке взять справку",{"name":"в банке взять справку","description":null}],
        ["встреча не будет долгой",{"name":"встреча не будет долгой","description":null}],
        ["тест будет в пятницу",{"name":"тест будет","description":null,"day":"2026-10-09"}],
        ["вт 15:00 пара по Английскому будет тест",{"name":"пара по Английскому будет тест","description":null,"end":"16:45"},{"skip":["description"]}],
        ["созвон завтра — обсудить бюджет",{"name":"созвон — обсудить бюджет","description":null},{"skip":["description"]}],
        ["обед гречка 13:00 650 ккал — вкусно",{"kind":"food","name":"гречка — вкусно","description":null}],
        ["бег 5 км 28 мин — парк",{"kind":"workout","description":null}],
        ["сон 23:40-07:30",{"kind":"sleep","description":null}]
    ])PV"},
    {"ввод текстом: еда и вода", false, R"PV([
        ["обед гречка 150г б30 ж10 у60 кл6 520 ккал",{"kind":"food","name":"гречка","meal":"lunch","grams":150,"nutrients":{"kcal":520,"protein":30,"fat":10,"carbs":60,"fiber":6},"day":"2026-10-08","error":null}],
        ["обед гречка 13:00 650 ккал",{"kind":"food","name":"гречка","meal":"lunch","nutrients":{"kcal":650}}],
        ["овсянка 9:00 300 ккал",{"kind":"food","name":"овсянка","meal":"breakfast"}],
        ["творог 200 ккал",{"kind":"food","name":"творог","meal":"lunch"}],
        ["творог 200 ккал",{"meal":"dinner"},{"nowMinutes":1140}],
        ["ужин 600 ккал",{"kind":"food","name":"ужин","meal":"dinner"}],
        ["перекус орехи 30 г 180 кал",{"kind":"food","name":"орехи","meal":"snack","grams":30}],
        ["курица белки 30 жиры 5 углеводы 0",{"kind":"food","name":"курица","nutrients":{"protein":30,"fat":5,"carbs":0,"kcal":165}}],
        ["сыр б 12,5 ж 15",{"kind":"food","name":"сыр","nutrients":{"protein":12.5,"fat":15,"kcal":185}}],
        ["520 ккал",{"kind":"food","error":"name"}],
        ["обед завтра 700 ккал",{"kind":"food","day":"2026-10-09","meal":"lunch"}],
        ["обед с Петей 13:00",{"kind":"event","name":"обед с Петей","start":"13:00"}],
        ["вода 500 мл",{"kind":"water","waterMl":500,"name":"","day":"2026-10-08"}],
        ["2 стакана",{"kind":"water","waterMl":500}],
        ["1,5 л",{"kind":"water","waterMl":1500}],
        ["вода 2 литра",{"kind":"water","waterMl":2000}],
        ["воды стакан",{"kind":"task","name":"воды стакан"}],
        ["купить молоко 2 л",{"kind":"task","name":"купить молоко 2 л","waterMl":null}],
        ["кефир",{"kind":"water","waterMl":null},{"kind":"water"}],
        ["гречка",{"kind":"food","name":"гречка","nutrients":{}},{"kind":"food"}]
    ])PV"},
    {"ввод текстом: здоровье (spec 020)", false, R"PV([
        ["сон 23:40-07:30",{"kind":"sleep","start":"23:40","end":"07:30","minutes":470,"day":"2026-10-08","error":null}],
        ["сон 00:50–07:36",{"kind":"sleep","start":"00:50","end":"07:36","minutes":406}],
        ["спал 7,5 ч",{"kind":"sleep","minutes":450,"start":null}],
        ["сегодня я спал с 4:00 до 12:00",{"kind":"sleep","start":"04:00","end":"12:00","minutes":480,"error":null}],
        ["спал с 4 до 12",{"kind":"sleep","start":"04:00","end":"12:00","minutes":480}],
        ["поспала с 23 до 7:30",{"kind":"sleep","start":"23:00","end":"07:30","minutes":510}],
        ["лёг в 1:30, встал в 9",{"kind":"sleep","start":"01:30","end":"09:00","minutes":450}],
        ["уснула в 23 и проснулась в 6:45",{"kind":"sleep","start":"23:00","end":"06:45","minutes":465}],
        ["спал с 11 до 7",{"kind":"sleep","start":"23:00","end":"07:00","minutes":480}],
        ["я спал 6 ч",{"kind":"sleep","minutes":360,"start":null}],
        ["я спал плохо",{"kind":"task","name":"я спал плохо"}],
        ["вчера спал с 5:00 до 15:00",{"kind":"sleep","start":"05:00","end":"15:00","minutes":600,"day":"2026-10-07"}],
        ["спал вчера 8 ч",{"kind":"sleep","minutes":480,"day":"2026-10-07"}],
        ["позавчера спала с 23 до 7",{"kind":"sleep","start":"23:00","end":"07:00","day":"2026-10-06"}],
        ["вчера лёг в 1 встал в 9",{"kind":"sleep","start":"01:00","end":"09:00","day":"2026-10-07"}],
        ["спал с 4 до 12",{"kind":"sleep","day":"2026-10-08"}],
        ["не спал",{"kind":"sleep","minutes":0,"day":"2026-10-08","error":null}],
        ["вчера я не спал",{"kind":"sleep","minutes":0,"day":"2026-10-07"}],
        ["я не спала вчера",{"kind":"sleep","minutes":0,"day":"2026-10-07"}],
        ["сегодня не спал",{"kind":"sleep","minutes":0,"day":"2026-10-08"}],
        ["не спал над отчётом",{"kind":"task","name":"не спал над отчётом"}],
        ["сон 7 ч 30 мин",{"kind":"sleep","minutes":450}],
        ["сон",{"kind":"sleep","error":"time"}],
        ["сон 25:00-07:00",{"kind":"sleep","error":"time"}],
        ["сонная лощина",{"kind":"task","name":"сонная лощина"}],
        ["вес 72,4",{"kind":"metric","metric":"weight","value":72.4,"day":"2026-10-08","error":null}],
        ["Вес 80 кг",{"kind":"metric","metric":"weight","value":80}],
        ["давление 120/80",{"kind":"metric","metric":"pressure","value":120,"value2":80}],
        ["давление 130 на 85",{"kind":"metric","metric":"pressure","value":130,"value2":85}],
        ["давление 120",{"kind":"metric","metric":"pressure","error":"name"}],
        ["пульс 64",{"kind":"metric","metric":"pulse","value":64}],
        ["шаги 9500",{"kind":"metric","metric":"steps","value":9500}],
        ["шаги 12 300",{"kind":"metric","metric":"steps","value":12300}],
        ["самочувствие 4",{"kind":"metric","metric":"mood","value":4}],
        ["самочувствие 7",{"kind":"metric","metric":"mood","error":"name"}],
        ["вес книги проверить",{"kind":"metric","error":"name"}],
        ["вес книги проверить",{"kind":"task","name":"вес книги проверить"},{"kind":"task"}],
        ["бег 5 км 28 мин",{"kind":"workout","name":"бег","distanceKm":5,"minutes":28,"day":"2026-10-08","error":null}],
        ["Бег 10,5 км",{"kind":"workout","name":"Бег","distanceKm":10.5,"minutes":null,"error":null}],
        ["зал присед 4x8x80, жим 3x10x60",{"kind":"workout","name":"зал","exercises":[{"name":"присед","sets":4,"reps":8,"weight":80},{"name":"жим","sets":3,"reps":10,"weight":60}],"error":null}],
        ["зал подтягивания 3х8",{"kind":"workout","exercises":[{"name":"подтягивания","sets":3,"reps":8}]}],
        ["зал 60 мин",{"kind":"workout","name":"зал","minutes":60,"start":null}],
        ["зал",{"kind":"workout","error":"minutes"}],
        ["йога вчера 40 мин",{"kind":"workout","name":"йога","day":"2026-10-07","minutes":40}],
        ["отчёт вчера",{"kind":"task","name":"отчёт","day":"2026-10-07"}],
        ["зал завтра 19:00 60 мин",{"kind":"event","name":"зал","day":"2026-10-09","start":"19:00","end":"20:00"}],
        ["зал 19:00",{"kind":"event","name":"зал","start":"19:00"}],
        ["бег по вт и чт 7:00",{"kind":"event","name":"бег"}],
        ["зал завтра",{"kind":"task","name":"зал","day":"2026-10-09"}],
        ["зал завтра 19:00 60 мин",{"kind":"workout","name":"зал","day":"2026-10-09","start":"19:00","minutes":60},{"kind":"workout"}],
        ["залить фундамент",{"kind":"task","name":"залить фундамент"}],
        ["обед гречка сахар 14 соль 0,5 520 ккал",{"kind":"food","name":"гречка","nutrients":{"kcal":520,"sugar":14,"salt":0.5}}],
        ["цель белок 140 вода 2,5л сон 8ч день с 8 до 22",{"kind":"goal","day":null,"goalChanges":{"goals":{"protein":140,"water":2500},"health":{"sleepMinutes":480},"dayStart":480,"dayEnd":1320},"error":null}],
        ["цель сон 23:30-07:00",{"kind":"goal","goalChanges":{"goals":{},"health":{"bedtime":1410,"wakeTime":420}},"error":null}],
        ["цель сон с 0:30 до 8:15 сон 7,5 ч",{"kind":"goal","goalChanges":{"goals":{},"health":{"bedtime":30,"wakeTime":495,"sleepMinutes":450}},"error":null}],
        ["цели ккал 2200 жиры 75 углеводы 260 клетчатка 30",{"kind":"goal","goalChanges":{"goals":{"kcal":2200,"fat":75,"carbs":260,"fiber":30},"health":{}}}],
        ["цель сахар 50 соль 5 вес 72 шаги 8000 бюджет 10 ч",{"kind":"goal","goalChanges":{"goals":{},"health":{"sugarMax":50,"saltMax":5,"weight":72,"steps":8000},"budget":600}}],
        ["цель вода 2000",{"kind":"goal","goalChanges":{"goals":{"water":2000},"health":{}}}],
        ["цель день с 22 до 8",{"kind":"goal","error":"time"}],
        ["цель выучить язык",{"kind":"goal","error":"name"}],
        ["цель выучить язык",{"kind":"task","name":"цель выучить язык"},{"kinds":["task","event"]}],
        ["целый день дома",{"kind":"task","name":"целый день дома"}]
    ])PV"},
    {"quick input (en): kind and name", true, R"PV([
        ["buy a power supply",{"kind":"task","name":"buy a power supply","day":null,"error":null}],
        ["Call Mom",{"kind":"task","name":"Call Mom"}],
        ["task check the papers",{"kind":"task","name":"check the papers"}],
        ["Task: check the papers",{"kind":"task","name":"check the papers"}],
        ["todo check the papers",{"kind":"task","name":"check the papers"}],
        ["tasks for the team",{"kind":"task","name":"tasks for the team"}],
        ["eventually fix it",{"kind":"task","name":"eventually fix it"}],
        ["event staff meeting",{"kind":"event","name":"staff meeting","isAllDay":true,"day":"2026-10-08"}],
        ["call 16:00",{"kind":"event","name":"call","start":"16:00","end":"16:30"}],
        ["talk 16:00",{"kind":"event","name":"talk","start":"16:00","end":"17:00"}],
        ["task call 16:00",{"kind":"task","name":"call","start":"16:00","minutes":30,"day":"2026-10-08"}],
        ["tomorrow 15:00",{"kind":"event","name":"","error":"name"}],
        ["call 16:00",{"kind":"task","name":"call","start":"16:00","minutes":30},{"kind":"task"}],
        ["report",{"kind":"event","name":"report","isAllDay":true},{"kind":"event"}],
        ["lunch 520 kcal",{"kind":"task","name":"lunch 520 kcal"},{"kinds":["task","event"]}],
        ["water 500 ml",{"kind":"task","name":"water 500 ml"},{"kinds":["task","event"]}]
    ])PV"},
    {"quick input (en): time", true, R"PV([
        ["call 9:05",{"start":"09:05","end":"09:35","day":"2026-10-09","isDayAssumed":true}],
        ["call at 15:30",{"name":"call","start":"15:30","end":"16:00","day":"2026-10-08","isDayAssumed":true}],
        ["call at 15",{"name":"call","start":"15:00","end":"15:30"}],
        ["call at 5",{"name":"call","start":"17:00","end":"17:30"}],
        ["call at 9",{"name":"call","start":"09:00","day":"2026-10-09"}],
        ["call at 5",{"start":"05:00"},{"dayStart":240,"dayEnd":720}],
        ["call 5pm",{"kind":"event","name":"call","start":"17:00"}],
        ["call 5 pm",{"name":"call","start":"17:00"}],
        ["call at 5 am",{"name":"call","start":"05:00","day":"2026-10-09"}],
        ["call at 12am",{"name":"call","start":"00:00","day":"2026-10-09"}],
        ["call 12pm",{"name":"call","start":"12:00"}],
        ["call at 7:30 pm",{"name":"call","start":"19:30","end":"20:00"}],
        ["call 7:30pm",{"name":"call","start":"19:30"}],
        ["call at 11 at night",{"name":"call","start":"23:00","end":"23:30"}],
        ["talk at 11 at night",{"name":"talk","start":"23:00","end":"23:59"}],
        ["call at 7 in the morning",{"name":"call","start":"07:00"}],
        ["standup at noon",{"kind":"event","name":"standup","start":"12:00"}],
        ["class from 10 to 12",{"kind":"event","name":"class","start":"10:00","end":"12:00","minutes":120}],
        ["class 10:00-11:30",{"name":"class","start":"10:00","end":"11:30","minutes":90}],
        ["class 10–12:30",{"name":"class","start":"10:00","end":"12:30"}],
        ["class 5-6pm",{"name":"class","start":"17:00","end":"18:00"}],
        ["class 10am-2pm",{"name":"class","start":"10:00","end":"14:00"}],
        ["class 11-1pm",{"name":"class","start":"11:00","end":"13:00"}],
        ["score 10-12",{"kind":"task","name":"score 10-12","start":null}],
        ["10 to 12 people",{"kind":"task","name":"10 to 12 people","start":null}],
        ["call 23:30",{"start":"23:30","end":"23:59","error":null}],
        ["talk 23:30",{"start":"23:30","end":null,"error":"time"}],
        ["call 25:00",{"kind":"task","name":"call 25:00"}],
        ["call 16:00 and 18:00",{"name":"call and 18:00","start":"16:00"}],
        ["version 3.5",{"kind":"task","name":"version 3.5","day":null}],
        ["meeting on 15.10",{"kind":"task","name":"meeting","day":"2026-10-15","start":null}]
    ])PV"},
    {"quick input (en): duration", true, R"PV([
        ["call 16:00 45 min",{"name":"call","start":"16:00","end":"16:45","minutes":45}],
        ["call 16:00 1.5 h",{"name":"call","end":"17:30","minutes":90}],
        ["call 16:00 2 hours",{"name":"call","end":"18:00"}],
        ["call 16:00 1 h 30 min",{"name":"call","end":"17:30","minutes":90}],
        ["call 16:00 1h 30m",{"name":"call","end":"17:30","minutes":90}],
        ["call 16:00 half an hour",{"name":"call","end":"16:30"}],
        ["call 16:00 an hour and a half",{"name":"call","end":"17:30"}],
        ["sort the mail 20 minutes",{"kind":"task","name":"sort the mail","minutes":20,"day":null}],
        ["sort the mail 45m",{"kind":"task","name":"sort the mail","minutes":45}],
        ["task report tomorrow 18:00 40 min",{"kind":"task","name":"report","day":"2026-10-09","start":"18:00","minutes":40}],
        ["buy 5 m of cable",{"name":"buy 5 m of cable","minutes":null}],
        ["course 5 months",{"name":"course 5 months","minutes":null,"repeat":null}],
        ["call 23:00 2 hours",{"error":"time"}]
    ])PV"},
    {"quick input (en): date and deadline", true, R"PV([
        ["report today",{"kind":"task","name":"report","day":"2026-10-08"}],
        ["report tomorrow",{"name":"report","day":"2026-10-09","isDayAssumed":null}],
        ["report the day after tomorrow",{"name":"report","day":"2026-10-10"}],
        ["report yesterday",{"name":"report","day":"2026-10-07"}],
        ["report in 3 days",{"name":"report","day":"2026-10-11"}],
        ["report in a week",{"name":"report","day":"2026-10-15"}],
        ["report in 2 weeks",{"name":"report","day":"2026-10-22"}],
        ["report in 2 months",{"name":"report","day":"2026-12-08"}],
        ["report next week",{"name":"report","day":"2026-10-12"}],
        ["report on fri",{"name":"report","day":"2026-10-09"}],
        ["report friday",{"name":"report","day":"2026-10-09"}],
        ["report thu",{"name":"report","day":"2026-10-15"}],
        ["report on Tuesday",{"name":"report","day":"2026-10-13"}],
        ["report next wednesday",{"name":"report","day":"2026-10-14"}],
        ["report sun",{"name":"report","day":"2026-10-11"}],
        ["report 12.10",{"name":"report","day":"2026-10-12"}],
        ["report 05.03",{"name":"report","day":"2027-03-05"}],
        ["report Oct 12",{"name":"report","day":"2026-10-12"}],
        ["report 12 Oct",{"name":"report","day":"2026-10-12"}],
        ["report October 12",{"name":"report","day":"2026-10-12"}],
        ["report 12th of October",{"name":"report","day":"2026-10-12"}],
        ["report May 1",{"name":"report","day":"2027-05-01"}],
        ["report 3 March",{"name":"report","day":"2027-03-03"}],
        ["report 31.02",{"name":"report 31.02","day":null}],
        ["report Feb 31",{"name":"report Feb 31","day":null}],
        ["report for tomorrow",{"name":"report","day":"2026-10-09"}],
        ["call thu 16:00",{"kind":"event","name":"call","day":"2026-10-15","start":"16:00","end":"16:30"}],
        ["call at 5 fri",{"kind":"event","name":"call","day":"2026-10-09","start":"17:00"}],
        ["task check the papers by fri",{"kind":"task","name":"check the papers","due":"2026-10-09","day":null}],
        ["report by 20.10",{"name":"report","due":"2026-10-20"}],
        ["report until tomorrow",{"name":"report","due":"2026-10-09"}],
        ["report by March",{"name":"report","due":"2027-03-01"}],
        ["report due Oct 20",{"name":"report","due":"2026-10-20"}],
        ["report on mon by fri",{"name":"report","day":"2026-10-12","due":"2026-10-09","error":"dayAfterDue"}],
        ["stand by me",{"name":"stand by me","due":null}],
        ["power supply 1000 W",{"name":"power supply 1000 W","day":null}],
        ["room 12 fri",{"name":"room 12 fri","day":null}],
        ["march of the penguins",{"name":"march of the penguins","day":null,"due":null}],
        ["may be later",{"name":"may be later","day":null}],
        ["sat down with the team",{"name":"sat down with the team","day":null}],
        ["sun cream and a hat",{"name":"sun cream and a hat","day":null}],
        ["wed planner review",{"name":"wed planner review","day":null}],
        ["satellite launch",{"name":"satellite launch","day":null}],
        ["monitor stand",{"name":"monitor stand","day":null}],
        ["meeting sat 15:00",{"kind":"event","name":"meeting","day":"2026-10-10","start":"15:00"}],
        ["party on sat",{"name":"party","day":"2026-10-10"}],
        ["dentist wed at 5",{"kind":"event","name":"dentist","day":"2026-10-14","start":"17:00"}],
        ["report tomorrow and friday",{"name":"report and friday","day":"2026-10-09"}],
        ["Submit REPORT Tomorrow",{"name":"Submit REPORT","day":"2026-10-09"}]
    ])PV"},
    {"quick input (en): repeat", true, R"PV([
        ["lesson tue 15:00 every week for 5 months",{"kind":"event","name":"lesson","start":"15:00","end":"15:45","day":"2026-10-13","repeat":{"kind":"weekly","interval":1,"weekdays":[2],"startDay":"2026-10-13","endDay":"2027-03-13"},"error":null}],
        ["exercise every day",{"kind":"task","name":"exercise","repeat":{"kind":"daily","interval":1,"startDay":"2026-10-08"}}],
        ["exercise daily 8:00 15 min",{"kind":"event","name":"exercise","start":"08:00","end":"08:15","repeat":{"kind":"daily","startDay":"2026-10-08"}}],
        ["watering every 3 days",{"name":"watering","repeat":{"kind":"daily","interval":3}}],
        ["watering every other day",{"name":"watering","repeat":{"kind":"daily","interval":2}}],
        ["report every week",{"name":"report","repeat":{"kind":"weekly","interval":1,"weekdays":[4],"startDay":"2026-10-08"}}],
        ["report weekly",{"name":"report","repeat":{"kind":"weekly","interval":1,"weekdays":[4]}}],
        ["report every 2 weeks",{"name":"report","repeat":{"kind":"weekly","interval":2,"weekdays":[4]}}],
        ["report once every two weeks",{"name":"report","repeat":{"kind":"weekly","interval":2}}],
        ["report once a week",{"name":"report","repeat":{"kind":"weekly","interval":1}}],
        ["rent every month",{"name":"rent","repeat":{"kind":"monthly","interval":1,"startDay":"2026-10-08"}}],
        ["rent monthly 20.10",{"name":"rent","repeat":{"kind":"monthly","startDay":"2026-10-20"}}],
        ["rent every 3 months",{"name":"rent","repeat":{"kind":"monthly","interval":3}}],
        ["insurance every year",{"name":"insurance","repeat":{"kind":"yearly","interval":1}}],
        ["insurance yearly",{"name":"insurance","repeat":{"kind":"yearly"}}],
        ["gym on weekdays 19:00",{"kind":"event","name":"gym","repeat":{"kind":"weekly","interval":1,"weekdays":[1,2,3,4,5],"startDay":"2026-10-08"}}],
        ["cleaning on weekends",{"name":"cleaning","repeat":{"kind":"weekly","interval":1,"weekdays":[0,6],"startDay":"2026-10-10"}}],
        ["gym on mon, wed and fri 19:00",{"name":"gym","start":"19:00","repeat":{"kind":"weekly","interval":1,"weekdays":[1,3,5],"startDay":"2026-10-09"}}],
        ["lesson on tue and thu at 5 pm 45 min",{"kind":"event","name":"lesson","start":"17:00","end":"17:45","repeat":{"kind":"weekly","interval":1,"weekdays":[2,4],"startDay":"2026-10-08"}}],
        ["lesson on tuesdays",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"weekdays":[2],"startDay":"2026-10-13"}}],
        ["lesson tuesdays 15:00",{"kind":"event","name":"lesson","repeat":{"kind":"weekly","interval":1,"weekdays":[2]}}],
        ["lesson every tuesday 15:00",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"weekdays":[2]}}],
        ["lesson every friday",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"weekdays":[5],"startDay":"2026-10-09"}}],
        ["lesson every week until 20.12",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"endDay":"2026-12-20"},"due":null}],
        ["lesson every week until March",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"endDay":"2027-03-01"}}],
        ["lesson every week 10 times",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"count":10}}],
        ["lesson every week for 6 weeks",{"name":"lesson","repeat":{"kind":"weekly","interval":1,"endDay":"2026-11-19"}}],
        ["lesson every day 2 months",{"name":"lesson","repeat":{"kind":"daily","endDay":"2026-12-08"}}],
        ["report on friday",{"name":"report","day":"2026-10-09","repeat":null}],
        ["repeat the exercise 10 times",{"name":"repeat the exercise 10 times","repeat":null}],
        ["weekend trip",{"name":"weekend trip","repeat":null}]
    ])PV"},
    {"quick input (en): removed values stay in the name", true, R"PV([
        ["call tomorrow 16:00",{"kind":"task","name":"call 16:00","day":"2026-10-09"},{"skip":["time"]}],
        ["call tomorrow 16:00",{"name":"call tomorrow","start":"16:00","day":"2026-10-08"},{"skip":["day"]}],
        ["report by fri",{"name":"report by","due":null,"day":"2026-10-09"},{"skip":["due"]}],
        ["lesson every week",{"name":"lesson every week","repeat":null},{"skip":["repeat"]}],
        ["sort the mail 20 minutes",{"name":"sort the mail 20 minutes","minutes":null},{"skip":["minutes"]}],
        ["task report",{"name":"task report"},{"skip":["kind"]}]
    ])PV"},
    {"quick input (en): usual duration by the head word of the name", true, R"PV([
        ["tue 15:00 lesson on English",{"kind":"event","name":"lesson on English","description":null,"start":"15:00","end":"15:45"}],
        ["tomorrow at 9 lesson",{"kind":"event","name":"lesson","day":"2026-10-09","start":"09:00","end":"09:45"}],
        ["event lessons 10:00",{"kind":"event","name":"lessons","start":"10:00","end":"10:45"}],
        ["prepare lessons tomorrow 9:00",{"name":"prepare lessons","start":"09:00","end":"10:00"}],
        ["English lesson tue 15:00",{"name":"English lesson","end":"16:00"}],
        ["tue 15:00 lesson on physics 2 hours",{"name":"lesson on physics","end":"17:00"}],
        ["tue lesson on physics 15:00-16:20",{"name":"lesson on physics","end":"16:20"}]
    ])PV"},
    {"quick input (en): name and description", true, R"PV([
        ["tue 15:00 lesson on English will be a listening test",{"kind":"event","name":"lesson on English","description":"will be a listening test","day":"2026-10-13","start":"15:00","end":"15:45","error":null}],
        ["lesson on English tue 15:00 will be a listening test",{"kind":"event","name":"lesson on English","description":"will be a listening test","day":"2026-10-13","start":"15:00","end":"15:45","error":null}],
        ["lesson on English will be a listening test tue 15:00",{"kind":"event","name":"lesson on English","description":"will be a listening test","day":"2026-10-13","start":"15:00","end":"15:45","error":null}],
        ["lesson on English — listening test tue 15:00",{"name":"lesson on English","description":"listening test","day":"2026-10-13","end":"15:45"}],
        ["call tomorrow 16:00 — discuss the budget",{"kind":"event","name":"call","description":"discuss the budget","day":"2026-10-09","start":"16:00","end":"16:30"}],
        ["call – discuss the budget",{"kind":"task","name":"call","description":"discuss the budget"}],
        ["buy milk - 2 cartons",{"name":"buy milk","description":"2 cartons"}],
        ["meeting with Pete: budget, deadlines",{"name":"meeting with Pete","description":"budget, deadlines"}],
        ["buy a gift; mom likes earrings",{"name":"buy a gift","description":"mom likes earrings"}],
        ["Send the report. Attach the table",{"name":"Send the report","description":"Attach the table"}],
        ["haircut sat 12:00 // ask for Anna",{"name":"haircut","description":"ask for Anna","day":"2026-10-10","start":"12:00"}],
        ["call tomorrow\ndiscuss the budget\nand deadlines",{"name":"call","description":"discuss the budget\nand deadlines","day":"2026-10-09"}],
        ["Mom needs a call — about the cottage",{"name":"Mom needs a call","description":"about the cottage"}],
        ["meeting with advisor note: check the draft",{"name":"meeting with advisor","description":"check the draft"}],
        ["meeting with advisor - description: check the draft",{"name":"meeting with advisor","description":"check the draft"}],
        ["physics class topic: optics",{"name":"physics class","description":"topic: optics"}],
        ["meeting notes - check the draft",{"name":"meeting notes","description":"check the draft"}],
        ["write description of the project",{"name":"write description of the project","description":null}],
        ["send note to John",{"name":"send note to John","description":null}],
        ["pick a topic for the talk",{"name":"pick a topic for the talk","description":null}],
        ["dentist fri 10:30 need to bring insurance card",{"kind":"event","name":"dentist","description":"need to bring insurance card","day":"2026-10-09","start":"10:30"}],
        ["trip to Boston don't forget the charger",{"name":"trip to Boston","description":"don't forget the charger"}],
        ["trip to Boston dont forget the charger",{"name":"trip to Boston","description":"dont forget the charger"}],
        ["seminar bring laptop",{"name":"seminar","description":"bring laptop"}],
        ["car service needs an oil change",{"name":"car service","description":"needs an oil change"}],
        ["task check the papers by fri — classes 9B and 10A",{"kind":"task","name":"check the papers","due":"2026-10-09","description":"classes 9B and 10A"}],
        ["English on tue and thu 18:00 — bring the textbook",{"kind":"event","name":"English","description":"bring the textbook","repeat":{"kind":"weekly","interval":1,"weekdays":[2,4]}}],
        ["standup daily: collect the statuses",{"kind":"task","name":"standup","description":"collect the statuses","repeat":{"kind":"daily","interval":1}}],
        ["lesson tomorow 9:00 — bring notebook",{"name":"lesson","description":"bring notebook","day":"2026-10-09","end":"09:45"}],
        ["Python from scratch(R212) tue 15:00",{"name":"Python from scratch(R212)","description":null,"day":"2026-10-13"}],
        ["buy milk, bread",{"name":"buy milk, bread","description":null}],
        ["buy a T-shirt tomorrow",{"name":"buy a T-shirt","description":null}],
        ["class 10:00 — 11:30",{"name":"class","description":null,"end":"11:30"}],
        ["meet Mr. Smith tomorrow",{"name":"meet Mr. Smith","description":null}],
        ["buy milk e.g. oat tomorrow",{"name":"buy milk e.g. oat","description":null}],
        ["buy 2 kg. of apples",{"name":"buy 2 kg. of apples","description":null}],
        ["U.S. visa interview fri 10:00",{"name":"U.S. visa interview","description":null}],
        ["need to bring passport",{"name":"need to bring passport","description":null}],
        ["don't forget to bring passport",{"name":"don't forget to bring passport","description":null}],
        ["I need to buy milk",{"name":"I need to buy milk","description":null}],
        ["at the bank bring the form",{"name":"at the bank bring the form","description":null}],
        ["remember to bring laptop",{"name":"remember to bring laptop","description":null}],
        ["test will be on friday",{"name":"test will be","description":null,"day":"2026-10-09"}],
        ["tue 15:00 lesson on English will be a test",{"name":"lesson on English will be a test","description":null,"end":"15:45"},{"skip":["description"]}],
        ["lunch buckwheat 13:00 650 kcal — tasty",{"kind":"food","description":null}],
        ["run 5 km 28 min - park",{"kind":"workout","description":null}]
    ])PV"},
    {"quick input (en): meal and water", true, R"PV([
        ["lunch buckwheat 150g p30 f10 c60 fiber 6 520 kcal",{"kind":"food","name":"buckwheat","meal":"lunch","grams":150,"nutrients":{"kcal":520,"protein":30,"fat":10,"carbs":60,"fiber":6},"day":"2026-10-08","error":null}],
        ["lunch buckwheat 13:00 650 kcal",{"kind":"food","name":"buckwheat","meal":"lunch","nutrients":{"kcal":650}}],
        ["oatmeal 9:00 300 kcal",{"kind":"food","name":"oatmeal","meal":"breakfast"}],
        ["cottage cheese 200 kcal",{"kind":"food","name":"cottage cheese","meal":"lunch"}],
        ["cottage cheese 200 kcal",{"meal":"dinner"},{"nowMinutes":1140}],
        ["dinner 600 kcal",{"kind":"food","name":"dinner","meal":"dinner"}],
        ["snack nuts 30 g 180 cal",{"kind":"food","name":"nuts","meal":"snack","grams":30}],
        ["chicken protein 30 fat 5 carbs 0",{"kind":"food","name":"chicken","nutrients":{"protein":30,"fat":5,"carbs":0,"kcal":165}}],
        ["cheese p 12.5 f 15",{"kind":"food","name":"cheese","nutrients":{"protein":12.5,"fat":15,"kcal":185}}],
        ["lunch buckwheat sugar 14 salt 0.5 520 kcal",{"kind":"food","name":"buckwheat","nutrients":{"kcal":520,"sugar":14,"salt":0.5}}],
        ["520 kcal",{"kind":"food","error":"name"}],
        ["lunch tomorrow 700 kcal",{"kind":"food","day":"2026-10-09","meal":"lunch"}],
        ["lunch with Pete 13:00",{"kind":"event","name":"lunch with Pete","start":"13:00"}],
        ["watch f1 race 15:00",{"kind":"event","name":"watch f1 race","start":"15:00"}],
        ["vitamin c 500",{"kind":"task","name":"vitamin c 500"}],
        ["water 500 ml",{"kind":"water","waterMl":500,"name":"","day":"2026-10-08"}],
        ["2 glasses",{"kind":"water","waterMl":500}],
        ["1.5 l",{"kind":"water","waterMl":1500}],
        ["water 2 liters",{"kind":"water","waterMl":2000}],
        ["glass of water",{"kind":"task","name":"glass of water"}],
        ["buy milk 2 l",{"kind":"task","name":"buy milk 2 l","waterMl":null}],
        ["waterproof jacket 2 l",{"kind":"task","name":"waterproof jacket 2 l","waterMl":null}],
        ["kefir",{"kind":"water","waterMl":null},{"kind":"water"}],
        ["buckwheat",{"kind":"food","name":"buckwheat","nutrients":{}},{"kind":"food"}]
    ])PV"},
    {"quick input (en): health", true, R"PV([
        ["sleep 23:40-07:30",{"kind":"sleep","start":"23:40","end":"07:30","minutes":470,"day":"2026-10-08","error":null}],
        ["slept 7.5 h",{"kind":"sleep","minutes":450,"start":null}],
        ["today i slept from 4:00 to 12:00",{"kind":"sleep","start":"04:00","end":"12:00","minutes":480}],
        ["slept from 11 to 7",{"kind":"sleep","start":"23:00","end":"07:00","minutes":480}],
        ["yesterday slept from 5:00 to 15:00",{"kind":"sleep","start":"05:00","end":"15:00","day":"2026-10-07"}],
        ["didn't sleep yesterday",{"kind":"sleep","minutes":0,"day":"2026-10-07"}],
        ["went to bed at 1:30, woke up at 9",{"kind":"sleep","start":"01:30","end":"09:00","minutes":450}],
        ["sleep 7 hours 30 min",{"kind":"sleep","minutes":450}],
        ["slept",{"kind":"sleep","error":"time"}],
        ["sleep 25:00-07:00",{"kind":"sleep","error":"time"},{"kind":"sleep"}],
        ["sleepy hollow",{"kind":"task","name":"sleepy hollow"}],
        ["weight 72.4",{"kind":"metric","metric":"weight","value":72.4,"day":"2026-10-08","error":null}],
        ["Weight 80 kg",{"kind":"metric","metric":"weight","value":80}],
        ["bp 120/80",{"kind":"metric","metric":"pressure","value":120,"value2":80}],
        ["blood pressure 130 over 85",{"kind":"metric","metric":"pressure","value":130,"value2":85}],
        ["bp 120",{"kind":"metric","metric":"pressure","error":"name"}],
        ["pulse 64",{"kind":"metric","metric":"pulse","value":64}],
        ["hr 64 bpm",{"kind":"metric","metric":"pulse","value":64}],
        ["steps 9500",{"kind":"metric","metric":"steps","value":9500}],
        ["steps 12 300",{"kind":"metric","metric":"steps","value":12300}],
        ["mood 4",{"kind":"metric","metric":"mood","value":4}],
        ["mood 7",{"kind":"metric","metric":"mood","error":"name"},{"kind":"metric"}],
        ["weight of the book",{"kind":"task","name":"weight of the book"}],
        ["weight of the book",{"kind":"metric","error":"name"},{"kind":"metric"}],
        ["steps to reproduce the bug",{"kind":"task","name":"steps to reproduce the bug"}],
        ["run tests",{"kind":"task","name":"run tests"}],
        ["walk the dog",{"kind":"task","name":"walk the dog"}],
        ["running late",{"kind":"task","name":"running late"}],
        ["goal learn the language",{"kind":"task","name":"goal learn the language"}],
        ["goal learn the language",{"kind":"goal","error":"name"},{"kind":"goal"}],
        ["run 5 km 28 min",{"kind":"workout","name":"run","distanceKm":5,"minutes":28,"day":"2026-10-08","error":null}],
        ["Run 10.5 km",{"kind":"workout","name":"Run","distanceKm":10.5,"minutes":null,"error":null}],
        ["run 5k",{"kind":"workout","name":"run","distanceKm":5}],
        ["run 3 mi 30 min",{"kind":"workout","name":"run","distanceKm":4.83,"minutes":30}],
        ["gym squat 4x8x80, bench press 3x10x60",{"kind":"workout","name":"gym","exercises":[{"name":"squat","sets":4,"reps":8,"weight":80},{"name":"bench press","sets":3,"reps":10,"weight":60}],"error":null}],
        ["gym pullups 3x8",{"kind":"workout","exercises":[{"name":"pullups","sets":3,"reps":8}]}],
        ["gym 60 min",{"kind":"workout","name":"gym","minutes":60,"start":null}],
        ["gym",{"kind":"workout","error":"minutes"}],
        ["yoga yesterday 40 min",{"kind":"workout","name":"yoga","day":"2026-10-07","minutes":40}],
        ["gym tomorrow 19:00 60 min",{"kind":"event","name":"gym","day":"2026-10-09","start":"19:00","end":"20:00"}],
        ["gym 7pm",{"kind":"event","name":"gym","start":"19:00"}],
        ["run on tue and thu 7:00",{"kind":"event","name":"run"}],
        ["gym tomorrow",{"kind":"task","name":"gym","day":"2026-10-09"}],
        ["gym tomorrow 19:00 60 min",{"kind":"workout","name":"gym","day":"2026-10-09","start":"19:00","minutes":60},{"kind":"workout"}],
        ["goal protein 140 water 2.5l sleep 8h day from 8 to 22",{"kind":"goal","day":null,"goalChanges":{"goals":{"protein":140,"water":2500},"health":{"sleepMinutes":480},"dayStart":480,"dayEnd":1320},"error":null}],
        ["goal sleep 23:30-07:00 sleep 8h",{"kind":"goal","goalChanges":{"goals":{},"health":{"bedtime":1410,"wakeTime":420,"sleepMinutes":480}},"error":null}],
        ["goals kcal 2200 fat 75 carbs 260 fiber 30",{"kind":"goal","goalChanges":{"goals":{"kcal":2200,"fat":75,"carbs":260,"fiber":30},"health":{}}}],
        ["goal sugar 50 salt 5 weight 72 steps 8000 budget 10 h",{"kind":"goal","goalChanges":{"goals":{},"health":{"sugarMax":50,"saltMax":5,"weight":72,"steps":8000},"budget":600}}],
        ["goal water 2000",{"kind":"goal","goalChanges":{"goals":{"water":2000},"health":{}}}],
        ["goal day from 22 to 8",{"kind":"goal","error":"time"}],
        ["protein 140 water 2.5l",{"kind":"goal","goalChanges":{"goals":{"protein":140,"water":2500}}},{"kind":"goal"}]
    ])PV"},
    {"ввод текстом: язык словаря", false, R"PV([
        ["call tomorrow 5pm",{"kind":"event","name":"call","day":"2026-10-09","start":"17:00"}],
        ["weight 72.4",{"kind":"metric","metric":"weight","value":72.4}],
        ["созвон tomorrow 16:00",{"kind":"event","name":"созвон","day":"2026-10-09","start":"16:00"}],
        ["созвон Zoom завтра 16:00",{"kind":"event","name":"созвон Zoom","day":"2026-10-09","start":"16:00"}],
        ["зал squat 4x8x80",{"kind":"workout","name":"зал","exercises":[{"name":"squat","sets":4,"reps":8}]}],
        ["MacBook завтра",{"kind":"task","name":"MacBook","day":"2026-10-09"}],
        ["обед sat down",{"kind":"task","name":"обед sat down","day":null}],
        ["белок 140 вода 2,5л",{"kind":"goal","goalChanges":{"goals":{"protein":140,"water":2500}}},{"kind":"goal"}]
    ])PV"},
    {"ввод текстом: язык словаря", true, R"PV([
        ["созвон завтра в 5",{"kind":"event","name":"созвон","day":"2026-10-09","start":"17:00"}],
        ["вес 72,4",{"kind":"metric","metric":"weight","value":72.4}],
        ["созвон tomorrow 16:00 ",{"kind":"event","name":"созвон","day":"2026-10-09","start":"16:00"}],
        ["call завтра 16:00",{"kind":"event","name":"call","day":"2026-10-09","start":"16:00"}],
        ["зал присед 4x8x80, жим 3x10x60",{"kind":"workout","name":"зал","error":null}],
        ["созвон Zoom 16:00",{"kind":"event","name":"созвон Zoom","start":"16:00"}]
    ])PV"},
    {"ввод текстом: числительные словами", false, R"PV([
        ["созвон в пять",{"kind":"event","name":"созвон","start":"17:00","end":"17:30"}],
        ["созвон в семь вечера",{"name":"созвон","start":"19:00"}],
        ["созвон в семь утра",{"name":"созвон","start":"07:00","day":"2026-10-09"}],
        ["созвон в десять тридцать",{"name":"созвон","start":"10:30","day":"2026-10-09"}],
        ["созвон в семь ноль пять вечера",{"name":"созвон","start":"19:05"}],
        ["созвон в двадцать один тридцать",{"name":"созвон","start":"21:30","error":null}],
        ["Созвон В Пять",{"name":"Созвон","start":"17:00"}],
        ["пара завтра в девять",{"name":"пара","day":"2026-10-09","start":"09:00","end":"10:45"}],
        ["пара с десяти до двенадцати",{"name":"пара","start":"10:00","end":"12:00","minutes":120}],
        ["встреча в час",{"name":"встреча","start":"13:00"}],
        ["встреча в час дня",{"name":"встреча","start":"13:00"}],
        ["объезд в час пик",{"kind":"task","name":"объезд в час пик","start":null}],
        ["отчёт через два дня",{"kind":"task","name":"отчёт","day":"2026-10-10"}],
        ["отчёт через три недели",{"name":"отчёт","day":"2026-10-29"}],
        ["зарядка три раза каждые две недели",{"name":"зарядка","repeat":{"kind":"weekly","interval":2,"count":3}}],
        ["отчёт раз в 2 недели",{"kind":"task","name":"отчёт","repeat":{"kind":"weekly","interval":2},"start":null}],
        ["отчёт каждые три дня",{"name":"отчёт","repeat":{"kind":"daily","interval":3}}],
        ["созвон 16:00 на час",{"name":"созвон","minutes":60,"end":"17:00"}],
        ["созвон 16:00 два часа",{"name":"созвон","minutes":120,"end":"18:00"}],
        ["созвон 16:00 два с половиной часа",{"name":"созвон","minutes":150,"end":"18:30"}],
        ["созвон 16:00 двадцать пять минут",{"name":"созвон","minutes":25,"end":"16:25"}],
        ["классный час завтра 9:00",{"name":"классный час","start":"09:00","end":"10:00","minutes":null}],
        ["встреча полтретьего",{"kind":"event","name":"встреча","start":"14:30","end":"15:30"}],
        ["встреча пол третьего",{"name":"встреча","start":"14:30"}],
        ["встреча пол-третьего",{"name":"встреча","start":"14:30"}],
        ["встреча в половине третьего",{"name":"встреча","start":"14:30"}],
        ["встреча половина десятого",{"name":"встреча","start":"09:30","day":"2026-10-09"}],
        ["встреча полпервого",{"name":"встреча","start":"12:30","day":"2026-10-08"}],
        ["встреча в половине седьмого утра",{"name":"встреча","start":"06:30"}],
        ["встреча полтретьего",{"start":"02:30"},{"dayStart":0,"dayEnd":720}],
        ["встреча без пятнадцати пять",{"name":"встреча","start":"16:45"}],
        ["встреча без четверти пять",{"name":"встреча","start":"16:45"}],
        ["встреча без пяти минут час",{"name":"встреча","start":"12:55"}],
        ["встреча без двадцати пяти десять",{"name":"встреча","start":"09:35","day":"2026-10-09"}],
        ["встреча четверть шестого",{"name":"встреча","start":"17:15"}],
        ["встреча пять минут шестого",{"name":"встреча","start":"17:05"}],
        ["обед в полдень",{"kind":"event","name":"обед","start":"12:00"},{"kinds":["task","event"]}],
        ["смена в полночь",{"kind":"event","name":"смена","start":"00:00","day":"2026-10-09"}],
        ["отчёт за полдня",{"kind":"task","name":"отчёт за полдня","start":null}],
        ["созвон в 7 вечером",{"name":"созвон","start":"19:00"}],
        ["вечером в семь созвон",{"name":"созвон","start":"19:00"}],
        ["завтра утром в 7:30 зарядка",{"name":"зарядка","day":"2026-10-09","start":"07:30"}],
        ["созвон днём в 2",{"name":"созвон","start":"14:00"}],
        ["смена ночью в 11",{"name":"смена","start":"23:00"}],
        ["позвонить маме вечером",{"kind":"task","name":"позвонить маме вечером","start":null,"day":null}],
        ["утром зарядка",{"kind":"task","name":"утром зарядка","start":null}],
        ["купить пять яблок",{"kind":"task","name":"купить пять яблок","day":null}],
        ["Купить Три Литра молока",{"kind":"task","name":"Купить Три Литра молока"}],
        ["пара отчётов и сорок страниц",{"kind":"task","name":"пара отчётов и сорок страниц"}],
        ["помыть полы на третьем этаже",{"kind":"task","name":"помыть полы на третьем этаже"}],
        ["один дома завтра",{"kind":"task","name":"один дома","day":"2026-10-09"}],
        ["созвон в пять",{"kind":"task","name":"созвон в пять","start":null},{"skip":["time"]}],
        ["встреча полтретьего",{"kind":"task","name":"встреча полтретьего"},{"skip":["time"]}],
        ["созвон 16:00 на час",{"name":"созвон на час","end":"16:30","minutes":null},{"skip":["minutes"]}],
        ["сон семь часов",{"kind":"sleep","minutes":420}],
        ["бег пять км двадцать восемь минут",{"kind":"workout","name":"бег","distanceKm":5,"minutes":28}],
        ["зал три подхода 60 мин",{"kind":"workout","name":"зал три подхода","minutes":60}]
    ])PV"},
    {"quick input (en): numerals in words", true, R"PV([
        ["call at five",{"kind":"event","name":"call","start":"17:00","end":"17:30"}],
        ["call at seven pm",{"name":"call","start":"19:00"}],
        ["call at seven am",{"name":"call","start":"07:00","day":"2026-10-09"}],
        ["call at ten thirty",{"name":"call","start":"10:30","day":"2026-10-09"}],
        ["call at five thirty pm",{"name":"call","start":"17:30"}],
        ["call at seven oh five pm",{"name":"call","start":"19:05"}],
        ["call at five o'clock",{"name":"call","start":"17:00"}],
        ["Call At Five",{"name":"Call","start":"17:00"}],
        ["call from nine to eleven am",{"name":"call","start":"09:00","end":"11:00"}],
        ["call half past two",{"kind":"event","name":"call","start":"14:30"}],
        ["call at half past twelve",{"name":"call","start":"12:30","day":"2026-10-08"}],
        ["call quarter to five",{"name":"call","start":"16:45"}],
        ["call a quarter to five",{"name":"call","start":"16:45"}],
        ["call quarter past five",{"name":"call","start":"17:15"}],
        ["call ten past five",{"name":"call","start":"17:10"}],
        ["call ten minutes to five",{"name":"call","start":"16:50"}],
        ["call half past two",{"start":"02:30"},{"dayStart":0,"dayEnd":720}],
        ["call 4pm half an hour",{"name":"call","minutes":30,"end":"16:30"}],
        ["call 4pm an hour and a half",{"name":"call","minutes":90,"end":"17:30"}],
        ["call 4pm two and a half hours",{"name":"call","minutes":150,"end":"18:30"}],
        ["call 4pm for an hour",{"name":"call","minutes":60,"end":"17:00"}],
        ["call 4pm twenty-five minutes",{"name":"call","minutes":25,"end":"16:25"}],
        ["report in two days",{"kind":"task","name":"report","day":"2026-10-10"}],
        ["report in three weeks",{"name":"report","day":"2026-10-29"}],
        ["gym every two weeks three times",{"name":"gym","repeat":{"kind":"weekly","interval":2,"count":3}}],
        ["report once in 2 weeks",{"kind":"task","name":"report","repeat":{"kind":"weekly","interval":2},"start":null}],
        ["lunch at noon",{"kind":"event","name":"lunch","start":"12:00"},{"kinds":["task","event"]}],
        ["shift at midnight",{"name":"shift","start":"00:00"}],
        ["call tomorrow morning at seven",{"name":"call","day":"2026-10-09","start":"07:00"}],
        ["call this evening at 7",{"name":"call","start":"19:00"}],
        ["call tonight at 8",{"name":"call","start":"20:00"}],
        ["call at 8 tonight",{"name":"call","start":"20:00"}],
        ["call mom this evening",{"kind":"task","name":"call mom this evening","start":null}],
        ["morning run plan",{"kind":"task","name":"morning run plan","start":null},{"kinds":["task","event"]}],
        ["buy five apples",{"kind":"task","name":"buy five apples","day":null}],
        ["Buy Twenty-Five Bricks",{"kind":"task","name":"Buy Twenty-Five Bricks"}],
        ["one more thing tomorrow",{"kind":"task","name":"one more thing","day":"2026-10-09"}],
        ["one on one with Ann 5pm",{"kind":"event","name":"one on one with Ann","start":"17:00"}],
        ["call at five",{"kind":"task","name":"call at five","start":null},{"skip":["time"]}],
        ["call half past two",{"kind":"task","name":"call half past two"},{"skip":["time"]}],
        ["sleep seven hours",{"kind":"sleep","minutes":420}],
        ["run five km twenty eight min",{"kind":"workout","name":"run","distanceKm":5,"minutes":28}]
    ])PV"},
    {"ввод текстом: явные метки", false, R"PV([
        ["купить молоко #дом",{"kind":"task","name":"купить молоко","list":"дом"}],
        ["#Работа сдать отчёт до пт",{"name":"сдать отчёт","list":"Работа","due":"2026-10-09"}],
        ["купить молоко #мой_дом, хлеб",{"name":"купить молоко, хлеб","list":"мой дом"}],
        ["отчёт #пт",{"name":"отчёт","list":"пт","day":null}],
        ["отчёт #работа #дом",{"name":"отчёт #дом","list":"работа"}],
        ["созвон 16:00 #работа",{"kind":"event","name":"созвон","list":"работа"}],
        ["купить молоко #дом",{"name":"купить молоко #дом","list":null},{"skip":["list"]}],
        ["пара вт 15:00 @301ГК",{"kind":"event","name":"пара","place":"301ГК","start":"15:00"}],
        ["@Ашан купить молоко",{"kind":"task","name":"купить молоко","place":"Ашан"}],
        ["пара вт 15:00 @301ГК — взять тетрадь",{"name":"пара","place":"301ГК","description":"взять тетрадь"}],
        ["пара @301ГК",{"name":"пара @301ГК","place":null},{"skip":["place"]}],
        ["созвон @5 завтра",{"name":"созвон","place":"5","start":null,"day":"2026-10-09"}],
        ["сдать отчёт !",{"kind":"task","name":"сдать отчёт","isImportant":true}],
        ["сдать отчёт!",{"name":"сдать отчёт","isImportant":true}],
        ["! сдать отчёт завтра",{"name":"сдать отчёт","isImportant":true,"day":"2026-10-09"}],
        ["сдать отчёт ! до пт",{"name":"сдать отчёт","isImportant":true,"due":"2026-10-09"}],
        ["сдать отчёт!\nне забыть подпись",{"name":"сдать отчёт","description":"не забыть подпись","isImportant":true}],
        ["сдать отчёт !",{"name":"сдать отчёт !","isImportant":null},{"skip":["important"]}],
        ["созвон 16:00 !",{"kind":"event","name":"созвон !","isImportant":null}],
        ["созвон 16:00!",{"kind":"event","name":"созвон !","isImportant":null}],
        ["купить молоко #дом @Ашан !",{"name":"купить молоко","list":"дом","place":"Ашан","isImportant":true}],
        ["Ура! купить торт",{"name":"Ура! купить торт","isImportant":null}],
        ["купить торт!!!",{"name":"купить торт!!!","isImportant":null}],
        ["точно сдать?!",{"name":"точно сдать?!","isImportant":null}],
        ["сдать отчёт\nсрочно!",{"name":"сдать отчёт","description":"срочно!","isImportant":null}],
        ["изучить C# и F#",{"name":"изучить C# и F#","list":null}],
        ["пункт #1 плана",{"name":"пункт #1 плана","list":null}],
        ["заказ №5 #",{"name":"заказ №5 #","list":null}],
        ["написать a@b.ru",{"name":"написать a@b.ru","place":null}],
        ["написать на почту @ 5",{"name":"написать на почту @ 5","place":null}],
        ["открыть https://site.ru/#top и t.me/@name",{"name":"открыть https://site.ru/#top и t.me/@name","list":null,"place":null}],
        ["цена 5#шт и #тег/путь",{"name":"цена 5#шт и #тег/путь","list":null}],
        ["обед гречка 520 ккал #дом !",{"kind":"food","name":"гречка #дом !","list":null,"isImportant":null}],
        ["зал 60 мин @клуб",{"kind":"workout","name":"зал @клуб","place":null}]
    ])PV"},
    {"quick input (en): explicit markers", true, R"PV([
        ["buy milk #home",{"kind":"task","name":"buy milk","list":"home"}],
        ["#Work send the report by fri",{"name":"send the report","list":"Work","due":"2026-10-09"}],
        ["report #fri",{"name":"report","list":"fri","day":null}],
        ["call 4pm #work",{"kind":"event","name":"call","list":"work"}],
        ["lesson tue 3pm @room-301",{"kind":"event","name":"lesson","place":"room-301","start":"15:00"}],
        ["@Mall buy milk",{"kind":"task","name":"buy milk","place":"Mall"}],
        ["send the report !",{"kind":"task","name":"send the report","isImportant":true}],
        ["send the report!",{"name":"send the report","isImportant":true}],
        ["call 4pm !",{"kind":"event","name":"call !","isImportant":null}],
        ["buy milk #home @Mall !",{"name":"buy milk","list":"home","place":"Mall","isImportant":true}],
        ["Wow! buy a cake",{"name":"Wow! buy a cake","isImportant":null}],
        ["buy a cake!!!",{"name":"buy a cake!!!","isImportant":null}],
        ["learn C# and F#",{"name":"learn C# and F#","list":null}],
        ["item #1 of the plan",{"name":"item #1 of the plan","list":null}],
        ["mail to a@b.com",{"name":"mail to a@b.com","place":null}],
        ["open https://site.com/#top",{"name":"open https://site.com/#top","list":null}],
        ["lunch rice 520 kcal #home",{"kind":"food","name":"rice #home","list":null}]
    ])PV"},
    {"ввод текстом: обычная длительность и выученное по правкам", false, R"PV([
        ["созвон завтра 10:00",{"end":"10:30","usualMinutes":30,"head":"созвон","learned":null}],
        ["созвоны завтра 10:00",{"end":"10:30","usualMinutes":30,"head":"созвоны"}],
        ["встреча завтра 10:00",{"end":"11:00","usualMinutes":60}],
        ["летучка завтра 10:00",{"end":"11:00","usualMinutes":60,"head":"летучка","learned":null}],
        ["летучка завтра 10:00",{"kind":"event","end":"10:20","minutes":null,"usualMinutes":60,"learned":["minutes"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["Летучка завтра 10:00",{"end":"10:20","learned":["minutes"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["завтра в 10 летучка отдела",{"name":"летучка отдела","end":"10:20","learned":["minutes"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["пара завтра 9:00",{"end":"10:30","usualMinutes":105,"learned":["minutes"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["созвон завтра 10:00",{"end":"10:30","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["летучка завтра 10:00 45 мин",{"end":"10:45","minutes":45,"learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["летучка завтра 10:00-10:50",{"end":"10:50","minutes":50,"learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["летучка завтра 10:00",{"end":"11:00","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}},"skip":["minutes"]}],
        ["большая летучка завтра 10:00",{"end":"11:00","head":"большая","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["задача летучка завтра 10:00",{"kind":"task","minutes":30,"head":"летучка","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["летучка завтра",{"kind":"task","minutes":null,"learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["купить молоко 18:00",{"kind":"event","head":"купить","learned":null}],
        ["купить молоко 18:00",{"kind":"task","name":"купить молоко","start":"18:00","minutes":30,"learned":["kind"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["купить молоко",{"kind":"task","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["др Маши завтра",{"kind":"event","isAllDay":true,"day":"2026-10-09","head":"др","learned":["kind"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["др Маши завтра",{"kind":"task","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}},"kind":"task"}],
        ["задача др Маши завтра",{"kind":"task","head":"др","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["др Маши завтра",{"kind":"task","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}},"skip":["kind"]}],
        ["купить молоко 18:00",{"kind":"event","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}},"kinds":["event"]}],
        ["в банке взять справку",{"head":"банке"}],
        ["мне купить молоко 18:00",{"kind":"task","head":"купить","learned":["kind"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["#дом купить молоко 18:00",{"kind":"task","head":"купить","list":"дом","learned":["kind"]},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["5 отчётов",{"head":"отчетов"}],
        ["Ёлку купить",{"head":"елку","learned":null},{"learned":{"летучка":{"minutes":20},"пара":{"minutes":90},"созвон":{"minutes":30},"купить":{"kind":"task"},"др":{"kind":"event"}}}],
        ["2026",{"head":null}],
        ["обед 520 ккал",{"kind":"food","head":null}]
    ])PV"},
    {"ввод текстом: обычная длительность и выученное по правкам", true, R"PV([
        ["call tomorrow 10:00",{"end":"10:30","usualMinutes":30,"head":"call"}],
        ["meeting tomorrow 10:00",{"end":"11:00","usualMinutes":60}],
        ["standup tomorrow 10:00",{"end":"10:15","usualMinutes":15}],
        ["stand-up tomorrow 10:00",{"name":"stand-up","end":"10:15","head":"stand"}],
        ["lesson tomorrow 10:00",{"end":"10:45","usualMinutes":45}],
        ["sync tomorrow 10:00",{"end":"11:00","learned":null}],
        ["sync tomorrow 10:00",{"end":"10:25","learned":["minutes"]},{"learned":{"sync":{"minutes":25}}}],
        ["sync tomorrow 10:00 40 min",{"end":"10:40","learned":null},{"learned":{"sync":{"minutes":25}}}],
        ["buy milk 6pm",{"kind":"task","start":"18:00","learned":["kind"]},{"learned":{"buy":{"kind":"task"}}}],
        ["the buy list",{"head":"buy"}],
        ["constructor tomorrow 10:00",{"kind":"event","head":"constructor","end":"11:00","learned":null},{"learned":{"sync":{"minutes":25}}}]
    ])PV"},
    {"ввод текстом: выбор кандидатов и другие чтения", false, R"PV([
        ["пара 10:00-11:30",{"name":"пара","start":"10:00","end":"11:30","alternatives":[{"field":"kind","pick":"task"}]}],
        ["пара с 10:00 до 11:30 45 мин",{"name":"пара","start":"10:00","end":"11:30","minutes":90}],
        ["созвон 16:00 1 ч 30 мин",{"name":"созвон","minutes":90,"end":"17:30"}],
        ["созвон 16:00 1 ч и 30 мин",{"name":"созвон и 30 мин","minutes":60,"end":"17:00"}],
        ["созвон в 7 вечера",{"name":"созвон","start":"19:00","alternatives":[{"field":"kind","pick":"task"}]}],
        ["отчёт до пт",{"name":"отчёт","due":"2026-10-09","day":null,"alternatives":null}],
        ["отчёт по вт, чт и пт",{"name":"отчёт","day":"2026-10-08","repeat":{"kind":"weekly","weekdays":[2,4,5]}}],
        ["отчёт раз в 2 недели",{"name":"отчёт","repeat":{"kind":"weekly","interval":2},"start":null}],
        ["обед 150г б30 ж10",{"kind":"food","grams":150,"nutrients":{"protein":30,"fat":10}}],
        ["созвон в 7",{"start":"19:00","day":"2026-10-08","alternatives":[{"field":"time","pick":"07:00"},{"field":"kind","pick":"task"}]}],
        ["созвон в 7",{"start":"07:00","day":"2026-10-09","alternatives":[{"field":"time","pick":"19:00"},{"field":"kind","pick":"task"}]},{"pick":{"time":"07:00"}}],
        ["созвон в семь",{"start":"07:00"},{"pick":{"time":"07:00"}}],
        ["созвон в 10",{"start":"10:00","alternatives":[{"field":"time","pick":"22:00"},{"field":"kind","pick":"task"}]}],
        ["созвон в 12",{"start":"12:00","alternatives":[{"field":"kind","pick":"task"}]}],
        ["созвон в 15",{"start":"15:00","alternatives":[{"field":"kind","pick":"task"}]}],
        ["созвон в 7:30",{"start":"07:30","alternatives":[{"field":"kind","pick":"task"}]}],
        ["встреча полтретьего",{"start":"14:30","alternatives":[{"field":"time","pick":"02:30"},{"field":"kind","pick":"task"}]}],
        ["встреча полтретьего",{"start":"02:30","alternatives":[{"field":"time","pick":"14:30"},{"field":"kind","pick":"task"}]},{"pick":{"time":"02:30"}}],
        ["созвон 16:00 или 18:00",{"name":"созвон или 18:00","start":"16:00","alternatives":[{"field":"time","pick":"18:00"},{"field":"kind","pick":"task"}]}],
        ["созвон 16:00 или 18:00",{"name":"созвон 16:00 или","start":"18:00","end":"18:30","alternatives":[{"field":"time","pick":"16:00"},{"field":"kind","pick":"task"}]},{"pick":{"time":"18:00"}}],
        ["созвон 16:00 или с 18:00 до 19:00",{"name":"созвон 16:00 или","start":"18:00","end":"19:00","alternatives":[{"field":"time","pick":"16:00"},{"field":"kind","pick":"task"}]}],
        ["созвон 16:00 или с 18:00 до 19:00",{"name":"созвон или с 18:00 до 19:00","start":"16:00","end":"16:30","alternatives":[{"field":"time","pick":"18:00-19:00"},{"field":"kind","pick":"task"}]},{"pick":{"time":"16:00"}}],
        ["отчёт пн",{"day":"2026-10-19","alternatives":[{"field":"day","pick":"2026-10-12"},{"field":"kind","pick":"event"}]},{"today":"2026-10-12"}],
        ["отчёт пн",{"day":"2026-10-12","alternatives":[{"field":"day","pick":"2026-10-19"},{"field":"kind","pick":"event"}]},{"today":"2026-10-12","pick":{"day":"2026-10-12"}}],
        ["отчёт вт",{"day":"2026-10-13","alternatives":[{"field":"kind","pick":"event"}]},{"today":"2026-10-12"}],
        ["отчёт до пн",{"due":"2026-10-19","alternatives":[{"field":"due","pick":"2026-10-12"}]},{"today":"2026-10-12"}],
        ["отчёт до пн",{"due":"2026-10-12"},{"today":"2026-10-12","pick":{"due":"2026-10-12"}}],
        ["отчёт 5 октября",{"day":"2027-10-05","alternatives":[{"field":"day","pick":"2026-10-05"},{"field":"kind","pick":"event"}]}],
        ["отчёт 5 октября",{"day":"2026-10-05"},{"pick":{"day":"2026-10-05"}}],
        ["отчёт 05.10",{"day":"2027-10-05","alternatives":[{"field":"day","pick":"2026-10-05"},{"field":"kind","pick":"event"}]}],
        ["отчёт 05.10.2026",{"day":"2026-10-05","alternatives":[{"field":"kind","pick":"event"}]}],
        ["отчёт 20 октября",{"day":"2026-10-20","alternatives":[{"field":"kind","pick":"event"}]}],
        ["отчёт до 5 октября",{"due":"2027-10-05","alternatives":[{"field":"due","pick":"2026-10-05"}]}],
        ["отчёт завтра или в сб",{"name":"отчёт или в сб","day":"2026-10-09","alternatives":[{"field":"day","pick":"2026-10-10"},{"field":"kind","pick":"event"}]}],
        ["отчёт завтра или в сб",{"name":"отчёт завтра или","day":"2026-10-10"},{"pick":{"day":"2026-10-10"}}],
        ["отчёт каждую неделю до 20.12",{"name":"отчёт","repeat":{"kind":"weekly","endDay":"2026-12-20"},"alternatives":[{"field":"repeat","pick":"open"},{"field":"kind","pick":"event"}]}],
        ["отчёт каждую неделю до 20.12",{"name":"отчёт до 20.12","repeat":{"kind":"weekly","endDay":null},"due":null,"alternatives":[{"field":"repeat","pick":"end","day":"2026-12-20"},{"field":"kind","pick":"event"}]},{"pick":{"repeat":"open"}}],
        ["отчёт до 20.12",{"name":"отчёт","due":"2026-12-20","alternatives":null},{"pick":{"repeat":"open"}}],
        ["купить молоко 18:00",{"kind":"event","alternatives":[{"field":"kind","pick":"task"}]}],
        ["купить молоко завтра",{"kind":"task","alternatives":[{"field":"kind","pick":"event"}]}],
        ["купить молоко каждую неделю",{"kind":"task","alternatives":[{"field":"kind","pick":"event"}]}],
        ["купить молоко",{"kind":"task","alternatives":null}],
        ["купить молоко 18:00",{"kind":"task","alternatives":null},{"kind":"task"}],
        ["задача купить молоко 18:00",{"kind":"task","alternatives":null}],
        ["купить молоко 18:00",{"kind":"event","alternatives":null},{"kinds":["event"]}],
        ["бег 28 мин",{"kind":"workout","minutes":28,"alternatives":[{"field":"kind","pick":"task"}]}],
        ["бег 28 мин",{"kind":"task","name":"бег","minutes":28,"alternatives":null},{"kind":"task"}],
        ["бег 28 мин",{"kind":"workout","alternatives":null},{"kind":"workout"}],
        ["бег 28 мин",{"kind":"workout","alternatives":null},{"kinds":["workout"]}],
        ["созвон в 7",{"start":"19:00"},{"pick":{"time":"09:00","day":"2026-10-20","due":"2026-10-20"}}],
        ["созвон 16:00",{"start":"16:00","alternatives":[{"field":"kind","pick":"task"}]},{"pick":{"time":"18:00"}}],
        ["созвон в 7",{"kind":"task","name":"созвон в 7","alternatives":null},{"skip":["time"]}]
    ])PV"},
    {"ввод текстом: выбор кандидатов и другие чтения", true, R"PV([
        ["call at 7",{"start":"19:00","alternatives":[{"field":"time","pick":"07:00"},{"field":"kind","pick":"task"}]}],
        ["call at 7",{"start":"07:00","day":"2026-10-09"},{"pick":{"time":"07:00"}}],
        ["call at 7 pm",{"start":"19:00","alternatives":[{"field":"kind","pick":"task"}]}],
        ["call half past two",{"start":"14:30","alternatives":[{"field":"time","pick":"02:30"},{"field":"kind","pick":"task"}]}],
        ["call 16:00 or 18:00",{"name":"call or 18:00","start":"16:00","alternatives":[{"field":"time","pick":"18:00"},{"field":"kind","pick":"task"}]}],
        ["call 16:00 or 18:00",{"name":"call 16:00 or","start":"18:00"},{"pick":{"time":"18:00"}}],
        ["report mon",{"day":"2026-10-19","alternatives":[{"field":"day","pick":"2026-10-12"},{"field":"kind","pick":"event"}]},{"today":"2026-10-12"}],
        ["report mon",{"day":"2026-10-12"},{"today":"2026-10-12","pick":{"day":"2026-10-12"}}],
        ["report by mon",{"due":"2026-10-19","alternatives":[{"field":"due","pick":"2026-10-12"}]},{"today":"2026-10-12"}],
        ["report Oct 5",{"day":"2027-10-05","alternatives":[{"field":"day","pick":"2026-10-05"},{"field":"kind","pick":"event"}]}],
        ["report Oct 5",{"day":"2026-10-05"},{"pick":{"day":"2026-10-05"}}],
        ["report every week until 20.12",{"name":"report","repeat":{"kind":"weekly","endDay":"2026-12-20"},"alternatives":[{"field":"repeat","pick":"open"},{"field":"kind","pick":"event"}]}],
        ["report every week until 20.12",{"name":"report until 20.12","repeat":{"kind":"weekly","endDay":null},"alternatives":[{"field":"repeat","pick":"end","day":"2026-12-20"},{"field":"kind","pick":"event"}]},{"pick":{"repeat":"open"}}],
        ["buy milk 6pm",{"kind":"event","alternatives":[{"field":"kind","pick":"task"}]}],
        ["buy milk tomorrow",{"kind":"task","alternatives":[{"field":"kind","pick":"event"}]}],
        ["run 28 min",{"kind":"workout","minutes":28,"alternatives":[{"field":"kind","pick":"task"}]}],
        ["run 28 min",{"kind":"task","name":"run","minutes":28},{"kind":"task"}]
    ])PV"},
    {"ввод текстом: ссылки на заметки", false, R"PV([
        ["[[Встреча завтра]] сб 15:00",{"kind":"event","name":"[[Встреча завтра]]","day":"2026-10-10","start":"15:00"}],
        ["[[Сервер X99]] созвон завтра 16:00",{"kind":"event","name":"[[Сервер X99]] созвон","day":"2026-10-09","start":"16:00","end":"16:30","head":"созвон"}],
        ["[[План на 2027 год]] ",{"kind":"task","name":"[[План на 2027 год]]","day":null,"error":null}],
        ["[[Отчёт: черновик|отчёт]] до пятницы",{"kind":"task","name":"[[Отчёт: черновик|отчёт]]","due":"2026-10-09"}],
        ["купить [[Блок питания 750 Вт]] и [[Кабель #2]] завтра",{"kind":"task","name":"купить [[Блок питания 750 Вт]] и [[Кабель #2]]","day":"2026-10-09","list":null}],
        ["[[Поездка]] — взять [[Паспорт завтра]]",{"kind":"task","name":"[[Поездка]]","description":"взять [[Паспорт завтра]]","day":null}],
        ["[[Roadmap 2027]] call tomorrow 4pm",{"kind":"event","name":"[[Roadmap 2027]] call","day":"2026-10-09","start":"16:00"},{"lang":"en"}],
        ["[[Заметка]] call tomorrow 4pm",{"kind":"event","name":"[[Заметка]] call","day":"2026-10-09","start":"16:00"}],
        ["[[]] завтра",{"name":"[[]]","day":"2026-10-09"}]
    ])PV"},
};

// Длина и подстрока в единицах UTF-16 (для участков)
static std::u16string W(const std::string &s) {
    std::u16string out;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = s[i];
        char32_t cp;
        int len;
        if (c < 0x80) { cp = c; len = 1; }
        else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
        else { cp = c & 0x07; len = 4; }
        for (int k = 1; k < len && i + k < s.size(); ++k) cp = (cp << 6) | (s[i + k] & 0x3F);
        i += len;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out += char16_t(0xD800 + (cp >> 10));
            out += char16_t(0xDC00 + (cp & 0x3FF));
        } else {
            out += char16_t(cp);
        }
    }
    return out;
}

static std::string U8(const std::u16string &s) {
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        char32_t cp = s[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < s.size()) cp = 0x10000 + ((cp - 0xD800) << 10) + (s[++i] - 0xDC00);
        if (cp < 0x80) out += char(cp);
        else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
        else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    }
    return out;
}

using Pairs = std::vector<std::pair<std::string, std::string>>;

// Участки как [поле, текст]
static Pairs spanTexts(const std::string &text, const QuickDraft &draft) {
    const auto wide = W(text);
    Pairs out;
    for (const auto &span : draft.spans) out.push_back({span.field, U8(wide.substr(size_t(span.from), size_t(span.to - span.from)))});
    return out;
}

static std::vector<std::string> splitExamples(const std::string &value) {
    std::vector<std::string> out;
    // split(/\s*\|\s*/)
    static const std::regex sep("\\s*\\|\\s*");
    std::sregex_token_iterator it(value.begin(), value.end(), sep, -1), end;
    for (; it != end; ++it) out.push_back(*it);
    return out;
}

// Строки локализации web (web/telegram-tt/src/assets/localization): примеры и подсказки экранов «Плана».
// Копия — ради проверки разбора; при правке строк web обновить и здесь
struct Strings {
    const char *lang;
    const char *healthExamples;
    const char *quickPlaceholder;
    const char *goalsPlaceholder;
    const char *quickExamples;
    const char *quickHint;
};
static const Strings kStrings[] = {
    {"en",
     "lunch buckwheat 150g p30 f10 c60 fiber 6 520 kcal | water 500 ml | weight 72.4 | bp 120/80 | steps 9500 | "
     "mood 4 | sleep 23:40-07:30 | run 5 km 28 min | goal protein 140 water 2.5l",
     "call tomorrow 16:00 45 min",
     "protein 140 water 2.5l sleep 8h day from 8 to 22",
     "call tomorrow 16:00 45 min | English lesson tue 15:00 -- listening test | task check the papers by fri | "
     "lunch buckwheat 13:00 650 kcal | sleep 23:40-07:30 | run 5 km 28 min | weight 72.4 | water 500 ml | slept "
     "from 14 to 15 | didn't sleep yesterday | gym squat 4x8x80, bench 3x10x60 | yoga 40 min | breakfast oatmeal "
     "350 kcal | snack apple 80 kcal | water 300 ml | pressure 120/80 | pulse 64 | mood 4 | steps 9500",
     "Type as you would in a note: date, time, duration, deadline and repeat are recognised. Put a description "
     "after “--”: “English lesson tue 15:00 -- listening test”. Numbers can be words (“at five pm”). Markers "
     "#group, @place and a final ! set the group (task or event), the place and “in progress” (task)."},
    {"ru",
     "обед гречка 150г б30 ж10 у60 кл6 520 ккал | вода 500 мл | вес 72,4 | давление 120/80 | шаги 9500 | "
     "самочувствие 4 | сон 23:40-07:30 | бег 5 км 28 мин | цель белок 140 вода 2,5л",
     "созвон завтра 16:00 45 мин",
     "белок 140 вода 2,5л сон 8ч день с 8 до 22",
     "созвон завтра 16:00 45 мин | пара по английскому вт 15:00 -- тест по лисенингу | задача проверить работы до "
     "пт | обед гречка 13:00 650 ккал | сон 23:40-07:30 | бег 5 км 28 мин | вес 72,4 | вода 500 мл | спал с 14 до "
     "15 | вчера не спал | зал присед 4x8x80, жим 3x10x60 | йога 40 мин | завтрак овсянка 350 ккал | перекус "
     "яблоко 80 ккал | вода 300 мл | давление 120/80 | пульс 64 | самочувствие 4 | шаги 9500",
     "Пишите как в заметке: дата, время, длительность, срок и повтор распознаются сами. Описание пишите после "
     "«--»: «пара по английскому вт 15:00 -- тест по лисенингу». Числа можно словами («в пять вечера»). Метки "
     "#группа, @место и ! в конце — группа (у задачи и события), место и «в работе» (у задачи)."},
};

// ── «любая строка разбирается» ───────────────────────────────────────────────

// Генератор с зерном, как в web: набор строк один и тот же при каждом запуске
struct Seeded {
    double state;
    double operator()() {
        state = std::fmod(state * 1664525 + 1013904223, 4294967296.0);
        return state / 4294967296.0;
    }
};

static const std::vector<std::u16string> &pieces() {
    static const std::vector<std::u16string> v = [] {
        std::vector<std::u16string> out;
        for (const char *p : {"созвон", "call", "в", "at", "до", "by", "по", "on", "каждые", "every", "пт", "fri",
                              "завтра", "tomorrow", "пять", "five", "полтретьего", "half past", "без", "мин", "min",
                              "ч", "h", "ккал", "kcal", "вода", "water", "сон", "sleep", "цель", "goal", "зал", "gym",
                              "вес", "weight", "16:00", "25:99", "10-12", "31.02", "00.00", "99.99.9999", "1e9", "0",
                              "7", "24", "999999999999999999999", "-", "—", ":", ";", ".", ",", "!", "!!!", "?!", "#",
                              "@", "#дом", "@x", "(", ")", "[[", "]]", "/", "\\", "*", "+", "$", "^", "|", "\n", "\t",
                              "\r"}) {
            out.push_back(W(p));
        }
        out.push_back(std::u16string(1, u'\0'));
        // \x1b, неразрывный пробел, пробел нулевой ширины, U+202E, U+FEFF, эмодзи
        for (const char *p : {"\x1b", "\u00a0", "\u200b", "\u202e", "\ufeff", "\U0001F642",
                              "\U0001F468\u200d\U0001F469\u200d\U0001F467", "\U0001F1F7\U0001F1FA"}) {
            out.push_back(W(p));
        }
        out.push_back(std::u16string(1, char16_t(0xD83D))); // одиночный суррогат
        for (const char *p : {"שלום", "مرحبا", "日本語", "İ", "ß", "ǅ", "e\u0301", "Ё", "ё", "constructor", "__proto__",
                              "toString", "undefined", "NaN", " ", "  "}) {
            out.push_back(W(p));
        }
        return out;
    }();
    return v;
}

static const std::vector<json> &contexts() {
    static const std::vector<json> v = {
        json::object(), {{"lang", "en"}}, {{"kinds", {"task", "event"}}}, {{"kind", "task"}}, {{"kind", "event"}},
        {{"kind", "food"}}, {{"kind", "water"}}, {{"kind", "sleep"}}, {{"kind", "workout"}}, {{"kind", "metric"}},
        {{"kind", "goal"}},
        {{"skip", {"time", "day", "kind", "minutes", "due", "repeat", "description", "list", "place", "important"}}},
        {{"pick", {{"time", "07:00"}, {"day", "2026-10-12"}, {"due", "2026-10-12"}, {"repeat", "open"}}}},
        {{"learned", {{"созвон", {{"kind", "task"}, {"minutes", 20}}}, {"call", {{"kind", "event"}, {"minutes", 1440}}}}}},
        {{"today", "2026-12-31"}, {"nowMinutes", 1439}, {"dayStart", 0}, {"dayEnd", 1440}},
        {{"today", "2028-02-29"}, {"nowMinutes", 0}},
    };
    return v;
}

// Строки с одиночными суррогатами идут в разбор как WTF-8 (так их хранит ядро)
static std::string wtf8(const std::u16string &s) {
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        char32_t cp = s[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] < 0xE000) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (s[++i] - 0xDC00);
        }
        if (cp < 0x80) out += char(cp);
        else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
        else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    }
    return out;
}

static bool isTime(const std::string &s) { return std::regex_match(s, std::regex("^([01]\\d|2[0-3]):[0-5]\\d$")); }
static bool isDay(const std::string &s) { return std::regex_match(s, std::regex("^\\d{4}-\\d{2}-\\d{2}$")); }

// Проверка черновика любой строки: вид известен, участки внутри строки, запись без ошибки пригодна к добавлению
static bool sane(const std::u16string &line, const json &ctx, std::string &why) {
    const auto draft = parse(wtf8(line), ctx);
    if (std::find(kQuickKinds.begin(), kQuickKinds.end(), draft.kind) == kQuickKinds.end()) {
        why = "вид " + draft.kind;
        return false;
    }
    for (const auto &span : draft.spans) {
        if (!(span.from >= 0 && span.from <= span.to && size_t(span.to) <= line.size())) {
            why = "участок " + std::to_string(span.from) + "–" + std::to_string(span.to) + " в строке длины "
                + std::to_string(line.size());
            return false;
        }
    }
    if (!draft.error && (draft.kind == "task" || draft.kind == "event")) {
        const auto name = W(draft.name);
        bool blank = true;
        for (const char16_t c : name) blank = blank && (c == u' ' || c == u'\t' || c == u'\n' || c == u'\r');
        if (blank) {
            why = "пустое название без ошибки";
            return false;
        }
        if ((draft.start && !isTime(*draft.start)) || (draft.end && !isTime(*draft.end)) || (draft.day && !isDay(*draft.day))) {
            why = "неверный вид времени либо дня";
            return false;
        }
    }
    return true;
}

int main() {
    std::printf("=== parvane-core planner quick tests ===\n");

    // ── таблица строк ───────────────────────────────────────────────────────
    for (const auto &section : kSections) {
        const json rows = json::parse(section.rows);
        for (const auto &row : rows) {
            const std::string input = row[0].get<std::string>();
            const json over = row.size() > 2 ? row[2] : json::object();
            const auto draft = parse(input, over, section.en);
            std::string why;
            const bool ok = matches(toJson(draft), row[1], "", why);
            std::string name = std::string(section.name) + ": «" + input + "»";
            if (!over.empty()) name += " " + over.dump();
            check(ok, ok ? name : name + " — " + why);
        }
    }

    // ── отдельные случаи plannerQuick.test.ts ───────────────────────────────
    {
        const std::string text = "Созвон завтра 16:00 — обсудить бюджет";
        check(spanTexts(text, parse(text)) == Pairs{{"day", "завтра"}, {"time", "16:00"}, {"description", "обсудить бюджет"}},
              "название и описание: помечает участок описания");
    }
    {
        const std::string text = "Созвон завтра 16:00 45 мин";
        check(spanTexts(text, parse(text)) == Pairs{{"day", "завтра"}, {"time", "16:00"}, {"minutes", "45 мин"}},
              "участки: помечает распознанное и не трогает название");
    }
    check(getQuickLang(std::string("ru")) == "ru" && getQuickLang(std::string("ru-RU")) == "ru"
              && getQuickLang(std::string("en")) == "en" && getQuickLang(std::string("de")) == "en"
              && getQuickLang(std::nullopt) == "en",
          "язык словаря: язык словаря по языку интерфейса");
    for (const auto &strings : kStrings) {
        // Примеры и подсказки экранов: каждый обязан разбираться своим словарём
        const json lang = {{"lang", strings.lang}};
        auto examples = splitExamples(strings.healthExamples);
        bool ok = examples.size() == 9;
        examples.push_back(strings.quickPlaceholder);
        std::string why;
        for (const auto &line : examples) {
            const auto draft = parse(line, lang);
            if (draft.error || (draft.kind == "task" && draft.spans.empty())) {
                ok = false;
                why = line;
            }
        }
        json goalCtx = lang;
        goalCtx["kind"] = "goal";
        const auto goals = parse(strings.goalsPlaceholder, goalCtx);
        std::string goalWhy;
        ok = ok && goals.goalChanges
            && matches(toJson(goals)["goalChanges"],
                       json::parse(R"({"goals":{"protein":140,"water":2500},"health":{"sleepMinutes":480},"dayStart":480,"dayEnd":1320})"),
                       "", goalWhy);
        check(ok, std::string("язык словаря: примеры из ") + strings.lang + " разбираются" + (why.empty() ? "" : " — " + why + goalWhy));
    }
    for (const auto &strings : kStrings) {
        // Примеры окна ввода: каждый разбирается без ошибки, один показывает описание
        const json lang = {{"lang", strings.lang}};
        const auto examples = splitExamples(strings.quickExamples);
        bool ok = true;
        std::vector<QuickDraft> described;
        for (const auto &line : examples) {
            const auto draft = parse(line, lang);
            ok = ok && !draft.error;
            if (draft.description && !draft.description->empty()) described.push_back(draft);
        }
        ok = ok && described.size() == 1 && described[0].kind == "event" && described[0].day == "2026-10-13"
            && described[0].start == "15:00"
            && (described[0].name == "пара по английскому" || described[0].name == "English lesson");
        // Подсказка окна приводит тот же пример; точка с запятой в значении обрывает строку у сборщика языка
        const std::string hint = strings.quickHint;
        ok = ok && examples.size() > 1 && hint.find(examples[1]) != std::string::npos && hint.find(';') == std::string::npos;
        check(ok, std::string("язык словаря: примеры окна из ") + strings.lang);
    }
    {
        const std::string text = "Call tomorrow 16:00 45 min";
        check(spanTexts(text, parse(text, json::object(), true))
                  == Pairs{{"day", "tomorrow"}, {"time", "16:00"}, {"minutes", "45 min"}},
              "язык словаря: помечает участки английской строки");
    }
    {
        const std::string text = "Пара в десять тридцать завтра — взять пять тетрадей";
        const auto draft = parse(text);
        const bool ok = draft.name == "Пара" && draft.description == "взять пять тетрадей" && draft.start == "10:30"
            && spanTexts(text, draft)
                == Pairs{{"time", "в десять тридцать"}, {"day", "завтра"}, {"description", "взять пять тетрадей"}};
        check(ok, "числительные словами: участки и описание — в позициях слов пользователя");
    }

    // ── любая строка разбирается ────────────────────────────────────────────
    {
        Seeded random{20261012};
        bool ok = true;
        std::string why;
        for (int i = 0; i < 3000 && ok; ++i) {
            const int count = 1 + int(random() * 8);
            std::u16string line;
            for (int j = 0; j < count; ++j) {
                line += pieces()[size_t(random() * pieces().size())];
                if (random() < 0.7) line += u' ';
            }
            ok = sane(line, contexts()[size_t(i) % contexts().size()], why);
            if (!ok) why = "«" + U8(line) + "»: " + why;
        }
        check(ok, "любая строка: случайные строки из смешанного набора не роняют разбор" + (ok ? "" : " — " + why));
    }
    {
        Seeded random{7};
        const auto letters = [] {
            std::vector<std::u16string> out;
            const auto alphabet = W("абвёяabcxyz0123456789 :.,;-—–!?#@/\\()[]{}<>«»\"'`~*+=%$^&|_\n\t\r");
            for (const char16_t c : alphabet) out.push_back(std::u16string(1, c));
            out.push_back(std::u16string(1, u'\0'));
            for (const char *p : {"\u00a0", "\u200d", "\u202e", "\U0001F642", "ש", "ל", "ם"}) out.push_back(W(p));
            return out;
        }();
        bool ok = true;
        std::string why;
        for (int i = 0; i < 1500 && ok; ++i) {
            const int length = int(random() * 40);
            std::u16string line;
            for (int j = 0; j < length; ++j) line += letters[size_t(random() * letters.size())];
            ok = sane(line, contexts()[size_t(i) % contexts().size()], why);
            if (!ok) why = "«" + U8(line) + "»: " + why;
        }
        const auto rep = [](const std::string &s, int n) {
            std::u16string out;
            const auto w = W(s);
            for (int k = 0; k < n; ++k) out += w;
            return out;
        };
        const std::vector<std::u16string> longLines = {
            rep("созвон завтра в пять 16:00 45 мин до пт каждую неделю #дом @офис ! ", 300),
            rep("a", 20000), rep("1", 20000), rep(" ", 20000), rep("10:00-", 3000), rep("пн ", 5000),
            rep("полтретьего ", 1500), rep("🙂", 5000), rep("в 5 ", 2000) + u"\n" + rep("до пт ", 2000),
        };
        for (const auto &line : longLines) {
            for (size_t k = 0; k < 3 && ok; ++k) {
                ok = sane(line, contexts()[k], why);
                if (!ok) why = "длинная строка: " + why;
            }
        }
        check(ok, "любая строка: случайные символы и очень длинные строки" + (ok ? "" : " — " + why));
    }
    {
        const std::string line = "созвон с командой завтра в пять вечера 45 мин каждую неделю до 20.12 #работа @Zoom — "
                                 "обсудить бюджет, план на квартал, найм двух инженеров и переезд офиса в ноябре, не "
                                 "забыть про отчёт до пт !";
        const auto wide = W(line);
        const std::string mixed = U8(wide.substr(0, 150)) + " call tomorrow at 5pm for 45 min every week";
        const int rounds = 200;
        for (int i = 0; i < 20; ++i) parse(line);
        const auto started = std::chrono::steady_clock::now();
        for (int i = 0; i < rounds; ++i) {
            parse(line);
            parse(mixed);
        }
        const double perLine =
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count() / (rounds * 2);
        // Обычно доли миллисекунды; запас — на загруженную машину
        check(wide.size() > 180 && perLine < 10,
              "любая строка: разбор строки в 200 символов укладывается в миллисекунды (" + std::to_string(perLine) + " мс)");
    }

    // ── plannerQuickRemind.test.ts ──────────────────────────────────────────
    {
        struct RemindRow {
            const char *line;
            const char *name;
            double minutes;
            const char *lang;
        };
        const RemindRow rows[] = {
            {"созвон завтра 16:00 напомнить за 15 мин", "созвон", 15, "ru"},
            {"отчёт пт напомни мне за час", "отчёт", 60, "ru"},
            {"встреча 18:00 напоминание за 2 часа", "встреча", 120, "ru"},
            {"врач 12.10 10:30 напомнить за день", "врач", 1440, "ru"},
            {"полить цветы завтра напомнить", "полить цветы", 0, "ru"},
            {"call tomorrow 4pm remind me 10 min before", "call", 10, "en"},
            {"dentist friday 9am reminder 1 day before", "dentist", 1440, "en"},
        };
        for (const auto &row : rows) {
            const auto draft = parse(row.line, {{"lang", row.lang}});
            bool hasSpan = false;
            for (const auto &span : draft.spans) hasSpan = hasSpan || span.field == "remind";
            check(draft.name == row.name && draft.remind == row.minutes && hasSpan,
                  std::string("напоминание: «") + row.line + "»");
        }
        const auto none = parse("созвон завтра 16:00 за 15 мин");
        const auto skipped = parse("созвон завтра 16:00 напомнить за 15 мин", {{"skip", {"remind"}}});
        check(!none.remind && !skipped.remind && skipped.name.find("напомнить") != std::string::npos,
              "напоминание: без слова «напомнить» напоминания нет; снятый чип возвращает слова в название");
    }

    // ── описание записи из черновика (quickDescription) ─────────────────────
    {
        QuickDraft draft;
        draft.place = "офис";
        draft.description = "взять паспорт";
        QuickDraft empty;
        check(quickDescription(draft) == "@офис\nвзять паспорт" && !quickDescription(empty),
              "описание записи: место первой строкой, за ним описание");
        check(quickUsualMinutes("пара по английскому", "ru") == 105 && quickUsualMinutes("[[Сервер]] созвон", "ru") == 30
                  && quickUsualMinutes("standup", "en") == 15 && quickUsualMinutes("отчёт", "ru") == 60,
              "обычная длительность по первому слову названия");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
