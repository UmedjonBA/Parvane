// Parvane fork (spec 029, T029): тесты состояния «Плана» для экранов — перенос web `planner/plannerStore.test.ts`.
// Адаптация: таймер уведомления — явное «сейчас»; ответ `parvanePlannerState` подаётся прямо в
// `applyEngineResult` (вместо `loadPlanner` с подменённым callApi); «тот же объект состояния» — `applyEngineResult`
// вернул false; запись устройства (localStorage) и сведение словаря/истории — у поддельного хоста (web
// `plannerQuickLearn`/`plannerQuickSuggest` в ядро не портированы — хост отдаёт результат их сведения из web-теста).
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "parvane/sections/planner_store.h"

using namespace parvane::sections::planner;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static json J(const char *text) { return json::parse(text); }

// Поддельный хост: правки копятся, записи устройства — по аккаунту
struct FakeHost : PlannerStoreHost {
    std::string user;
    std::vector<json> applied;
    std::map<std::string, std::vector<LearnedWord>> learnedMerged; // аккаунт → итог сведения
    std::map<std::string, std::vector<QuickLine>> historyMerged;
    void apply(const std::vector<PlannerChange> &changes) override {
        for (const auto &c : changes) applied.push_back(c);
    }
    bool hasLocalLearned() override { return learnedMerged.count(user) > 0; }
    std::vector<LearnedWord> mergeLocalLearned(const std::vector<LearnedWord> &) override { return learnedMerged[user]; }
    void resetLocalLearned() override { learnedMerged.erase(user); }
    bool hasLocalHistory() override { return historyMerged.count(user) > 0; }
    std::vector<QuickLine> mergeLocalHistory(const std::vector<QuickLine> &) override { return historyMerged[user]; }
    void resetLocalHistory() override { historyMerged.erase(user); }
};

static json taskJson(const std::string &id, const std::string &name) {
    return json{{"id", id}, {"name", name}, {"description", ""}, {"steps", json::array()}, {"status", "queue"},
                {"listId", ""}, {"rank", 1}, {"day", "2026-10-08"}, {"start", ""}, {"due", ""}, {"minutes", 30},
                {"repeat", nullptr}, {"occurrences", json::array()}, {"origin", nullptr}, {"source", nullptr}};
}

static json engineOf(const json &tasks) {
    return json{{"tasks", tasks}, {"events", json::array()}, {"lists", json::array()}, {"nutrition", json::array()},
                {"settings", nullptr}, {"goals", nullptr}, {"headSeq", 1}, {"sizeBytes", 10}};
}

static EngineStateResult answer(const std::string &status, std::optional<json> state, bool hasPending = false) {
    EngineStateResult r;
    r.status = status;
    r.state = std::move(state);
    r.hasPending = hasPending;
    r.sizeBytes = 10;
    return r;
}

static void load(PlannerStore &store, FakeHost &host, const std::string &user, const EngineStateResult &result) {
    host.user = user;
    store.setUser(user);
    store.applyEngineResult(result);
}

int main() {
    std::printf("=== parvane-core planner_store tests (без стека) ===\n");

    // ── Уведомление планировщика ──
    {
        FakeHost host;
        PlannerStore store(host);
        store.showNotice("Saved", 0);
        bool ok = store.notice(0) && store.notice(0)->text == "Saved";
        ok = ok && store.notice(2900) && store.notice(2900)->text == "Saved";
        ok = ok && !store.notice(3100);
        check(ok, "скрывается само через 3 секунды");
    }
    {
        FakeHost host;
        PlannerStore store(host);
        store.showNotice("First", 0);
        store.showNotice("Second", 2000);
        bool ok = store.notice(4000) && store.notice(4000)->text == "Second";
        ok = ok && !store.notice(5100);
        check(ok, "новое уведомление начинает отсчёт заново");
    }

    // ── Перечитка состояния движка без изменений не трогает состояние экранов (C1) ──
    {
        FakeHost host;
        PlannerStore store(host);
        auto a = answer("ready", engineOf(json::array({taskJson("t1", "Один"), taskJson("t2", "Два")})));
        a.raw = "A";
        load(store, host, "user-raw", a);
        const auto shown = json(store.state());
        bool ok = store.state().tasks.size() == 2 && store.state().tasks[0].id == "t1" && store.state().tasks[1].id == "t2";
        // Раздел открыт заново — перечитка
        ok = ok && !store.applyEngineResult(a) && json(store.state()) == shown;
        // Разобранный JSON мог бы отличаться, но строка та же — не перечитывается
        auto same = a;
        same.state = engineOf(json::array({taskJson("t1", "Другое")}));
        ok = ok && !store.applyEngineResult(same) && json(store.state()) == shown;
        auto b = answer("ready", engineOf(json::array({taskJson("t1", "Один"), taskJson("t2", "Два-2")})));
        b.raw = "B";
        ok = ok && store.applyEngineResult(b);
        ok = ok && json(store.state().tasks[0]) == shown["tasks"][0] && store.state().tasks[1].name == "Два-2";
        check(ok, "та же сырая строка — тот же объект состояния; другая — новое с прежними объектами записей");
    }
    {
        FakeHost host;
        PlannerStore store(host);
        auto a = answer("ready", engineOf(json::array({taskJson("t1", "Один")})));
        a.revision = 3;
        load(store, host, "user-rev", a);
        bool ok = !store.applyEngineResult(a);
        a.revision = 4;
        ok = ok && store.applyEngineResult(a);
        auto p = answer("ready", engineOf(json::array({taskJson("t1", "Один")})));
        load(store, host, "user-print", p);
        ok = ok && !store.applyEngineResult(answer("ready", engineOf(json::array({taskJson("t1", "Один")}))));
        ok = ok && store.applyEngineResult(answer("ready", engineOf(json::array({taskJson("t1", "Иное")}))))
            && store.state().tasks[0].name == "Иное";
        check(ok, "ревизия и отпечаток JSON — то же правило");
    }
    {
        FakeHost host;
        PlannerStore store(host);
        auto a = answer("ready", engineOf(json::array({taskJson("t1", "Один")})));
        a.raw = "A";
        load(store, host, "user-edit", a);
        store.update([](State &draft) { draft.tasks[0].name = "Правка"; }, std::nullopt, 0);
        bool ok = store.state().tasks[0].name == "Правка";
        ok = ok && host.applied == std::vector<json>{J(R"({"task":{"id":"t1","name":"Правка"}})")};
        // Движок правку отверг (строка прежняя) — экран возвращается к состоянию движка
        store.applyEngineResult(a);
        ok = ok && store.state().tasks[0].name == "Один";
        check(ok, "после своей правки ответ движка применяется, даже если строка та же");
    }

    // ── Словарь правок: перенос записи устройства в «План» ──
    // Сведение (web mergeLearnStores): «пара» у другого устройства выучена сильнее, «зал» — самым свежим
    const LearnedWord para{"пара", std::nullopt, 0, 105, 4, 9};
    const LearnedWord zal{"зал", "event", 3, std::nullopt, 0, 10};
    const auto engineLearned = [](const json &learned) {
        json e = engineOf(json::array());
        e["learned"] = learned;
        return e;
    };
    {
        FakeHost host;
        host.learnedMerged["user-a"] = {zal, para};
        PlannerStore store(host);
        load(store, host, "user-a", answer("ready", engineLearned(J(
            R"([{"id":"пара","kind":"","kindCount":0,"minutes":105,"minutesCount":4,"touched":9}])"))));
        bool ok = store.canSyncLearned();
        ok = ok && host.applied == std::vector<json>{J(
            R"({"learned":{"id":"зал","kind":"event","kindCount":3,"minutes":null,"minutesCount":0,"touched":10}})")};
        ok = ok && store.state().learned.size() == 2 && store.state().learned[0].id == "зал"
            && store.state().learned[1].id == "пара";
        ok = ok && !host.learnedMerged.count("user-a");
        // Повторная загрузка того же аккаунта ничего не пишет
        host.applied.clear();
        load(store, host, "user-a", answer("ready", engineLearned(J(
            R"([{"id":"пара","kind":"","kindCount":0,"minutes":105,"minutesCount":4,"touched":9}])"))));
        ok = ok && host.applied.empty();
        check(ok, "готовый «План» со словарём другого устройства: слова сводятся без двойного счёта, запись стирается");
    }
    {
        FakeHost host;
        host.learnedMerged["user-b"] = {zal, LearnedWord{"пара", std::nullopt, 0, 60, 2, 6}};
        PlannerStore store(host);
        load(store, host, "user-b", answer("ready", std::nullopt));
        bool ok = host.applied.size() == 2 && host.applied[0]["learned"]["id"] == "зал"
            && host.applied[1]["learned"]["id"] == "пара";
        ok = ok && host.learnedMerged.empty();
        check(ok, "новый аккаунт без контейнера: запись устройства уходит целиком");
    }
    {
        FakeHost host;
        PlannerStore store(host);
        load(store, host, "user-c", answer("ready", std::nullopt));
        check(host.applied.empty(), "пустая запись устройства — «План» не трогается");
    }
    {
        FakeHost host;
        host.learnedMerged["user-d"] = {zal};
        host.learnedMerged["user-e"] = {zal};
        PlannerStore store(host);
        load(store, host, "user-d", answer("needs-linking", std::nullopt));
        bool ok = !store.canSyncLearned() && store.needsLinkingPoll();
        load(store, host, "user-e", answer("no-key", std::nullopt));
        ok = ok && !store.canSyncLearned() && host.applied.empty();
        ok = ok && host.learnedMerged.count("user-d") && host.learnedMerged.count("user-e");
        check(ok, "устройство не привязано либо нет ключа: запись остаётся на устройстве");
    }
    {
        FakeHost host;
        host.learnedMerged["user-f"] = {zal};
        PlannerStore store(host);
        load(store, host, "user-f", answer("ready", engineLearned(json::array()), true));
        check(host.applied.empty() && host.learnedMerged.count("user-f"),
              "непревращённые правки у провайдера: перенос ждёт сведённого состояния");
    }

    // ── История ввода текстом: перенос записи устройства в «План» ──
    // id строк — как web `quickLineId` (не портирован): здесь условные
    const QuickLine cable{"id-купить-кабель", "купить кабель", 5, 40, std::nullopt};
    const QuickLine lunch{"id-обед-h", "обед", 0, 41, true};
    const QuickLine gym{"id-зал", "зал 19:00", 1, 41, std::nullopt};
    const auto engineLines = [](std::optional<json> lines) {
        json e = engineOf(json::array());
        if (lines) e["quickLines"] = *lines;
        return e;
    };
    {
        FakeHost host;
        host.historyMerged["hist-a"] = {cable, lunch, gym};
        PlannerStore store(host);
        load(store, host, "hist-a", answer("ready", engineLines(J(
            R"([{"id":"id-купить-кабель","text":"купить кабель","count":5,"touched":40,"hidden":false}])"))));
        bool ok = store.canSyncQuickHistory();
        ok = ok && json(host.applied) == J(R"([
            {"quickLine":{"id":"id-обед-h","text":"обед","count":0,"touched":41,"hidden":true}},
            {"quickLine":{"id":"id-зал","text":"зал 19:00","count":1,"touched":41,"hidden":false}}])");
        ok = ok && store.state().quickLines.size() == 3 && !host.historyMerged.count("hist-a");
        host.applied.clear();
        load(store, host, "hist-a", answer("ready", engineLines(J(
            R"([{"id":"id-купить-кабель","text":"купить кабель","count":5,"touched":40,"hidden":false}])"))));
        ok = ok && host.applied.empty();
        check(ok, "готовый «План» с историей другого устройства: строки объединяются, запись стирается");
    }
    {
        FakeHost host;
        host.historyMerged["hist-b"] = {gym};
        PlannerStore store(host);
        load(store, host, "hist-b", answer("ready", engineLines(std::nullopt)));
        bool ok = store.canSyncLearned() && !store.canSyncQuickHistory() && host.applied.empty()
            && host.historyMerged.count("hist-b");
        check(ok, "движок прежней сборки истории не знает: запись остаётся на устройстве и в «План» не пишется");
    }
    {
        FakeHost host;
        host.historyMerged["hist-c"] = {QuickLine{"a", "Купить кабель", 2, 3, std::nullopt}, gym, lunch};
        PlannerStore store(host);
        load(store, host, "hist-c", answer("ready", std::nullopt));
        bool ok = !store.canSyncQuickHistory() && host.applied.empty();
        // Контейнер появился (первая запись): следующая загрузка переносит историю целиком
        load(store, host, "hist-c", answer("ready", engineLines(json::array())));
        ok = ok && host.applied.size() == 3 && host.historyMerged.empty();
        check(ok, "новый аккаунт без контейнера: история ждёт на устройстве первого состояния движка");
    }
    {
        FakeHost host;
        host.historyMerged["hist-d"] = {gym};
        PlannerStore store(host);
        load(store, host, "hist-d", answer("needs-linking", std::nullopt));
        check(!store.canSyncQuickHistory() && host.applied.empty() && host.historyMerged.count("hist-d"),
              "устройство не привязано: история остаётся на устройстве");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
