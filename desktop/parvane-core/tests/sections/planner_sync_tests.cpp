// Parvane fork (spec 029, T029): «План» на сервере — склейка правок (1:1 с web plannerCoalesce.test.ts) и
// жизненный цикл контейнера (web planner.ts своих тестов не имеет — случаи по его коду) на поддельном транспорте.
#include <cstdio>
#include <string>

#include "fake_domain.h"
#include "parvane/sections/planner_sync.h"

using nlohmann::json;
using namespace parvane::sections::planner;
namespace d = parvane::sections::domain;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// Поддельный движок планировщика: контейнер, ключ, seq, подготовленные операции
struct Engine {
    bool attached = false;
    bool key = true;
    std::int64_t seq = 0;
    std::string id = "00112233445566778899aabbccddeeff";
    int prepared = 0;
    std::vector<json> preparedChanges;
    std::vector<std::string> applied;
    std::vector<json> syncReplies; // ответы plannerIngestSync по порядку; кончились — {applied:0, more:false}
    std::int64_t snapshotSeq = 0;  // plannerIngestSnapshot поднимает seq до него
    bool snapshotDue = false;

    void install(fake::Transport &t) {
        t.engineFns["plannerIsAttached"] = [this](const json &) { return json(attached); };
        t.engineFns["plannerHasKey"] = [this](const json &) { return json(key); };
        t.engineFns["plannerHeadSeq"] = [this](const json &) { return json(seq); };
        t.engineFns["plannerContainer"] = [this](const json &) {
            return attached ? json{{"domain", "local"}, {"id", id}} : json(nullptr);
        };
        t.engineFns["plannerAttach"] = [this](const json &) {
            attached = true;
            return json(nullptr);
        };
        t.engineFns["plannerCreate"] = [this](const json &) {
            attached = true;
            return fake::req("domain.container.create", "create");
        };
        t.engineFns["sharePlannerWithOwnDevices"] = [](const json &) {
            return json::array({fake::req("msg.deliver", "share")});
        };
        t.engineFns["plannerIngestGrants"] = [](const json &) { return json(0); };
        t.engineFns["plannerIngestSnapshot"] = [this](const json &) {
            seq = snapshotSeq;
            return json(seq);
        };
        t.engineFns["plannerIngestSync"] = [this](const json &) {
            if (syncReplies.empty()) {
                return json{{"applied", 0}, {"headSeq", seq}, {"more", false}, {"grantsBehind", false}, {"missingEpoch", nullptr}};
            }
            auto r = syncReplies.front();
            syncReplies.erase(syncReplies.begin());
            seq += r.value("applied", 0);
            return r;
        };
        t.engineFns["plannerPrepareLocal"] = [this](const json &a) {
            ++prepared;
            preparedChanges.push_back(a["changesJson"]["changes"]);
            char hex[33];
            std::snprintf(hex, sizeof hex, "%032x", prepared);
            return json{{"opId", hex}, {"op", d::toBase64("op" + std::to_string(prepared))}, {"applied", 1}};
        };
        t.engineFns["plannerApplyLocal"] = [this](const json &a) {
            applied.push_back(a["op"].get<std::string>());
            return json(1);
        };
        t.engineFns["plannerSeal"] = [](const json &a) {
            return fake::req("domain.op.append", "seal:" + a["opIdHex"].get<std::string>());
        };
        t.engineFns["plannerSnapshotRequest"] = [this](const json &) {
            if (!snapshotDue) return json(nullptr);
            snapshotDue = false;
            return fake::req("domain.snapshot.put", "snap");
        };
        t.engineFns["plannerStateJson"] = [](const json &) { return json{{"tasks", json::array()}}; };
        t.engineFns["plannerSize"] = [](const json &) { return json(123); };
        t.engineFns["plannerKeysExport"] = [this](const json &) {
            return attached ? json{{"container", id}} : json(nullptr);
        };
        t.engineFns["plannerKeysImport"] = [](const json &a) {
            if (!a["json"].is_object()) throw std::runtime_error("{\"error\":\"Malformed\"}");
            return json(nullptr);
        };
    }
};

struct Rig {
    fake::Transport t;
    Engine e;
    d::MemoryRecords records;
    int changed = 0;
    std::vector<ContainerRef> recorded;
    std::optional<ContainerRef> fromState;
    PlannerSync sync;

    Rig()
    : sync(t, records, PlannerHooks{
          [this] { return fromState; },
          [this](const ContainerRef &r) { recorded.push_back(r); },
          [this] { ++changed; }}) {
        e.install(t);
        // Пустой список контейнеров на сервере
        t.busFns["domain.container.list"] = [](const fake::Sent &) { return std::string(R"({"containers":[]})"); };
    }
    void advance(std::int64_t ms) {
        t.now += ms;
        sync.tick();
    }
};

static void coalesceTests() {
    std::printf("-- планировщик: склейка правок одной операции\n");
    check(coalesceChanges(json::parse(R"([
      { "task": { "id": "t1", "name": "а", "minutes": 30 } },
      { "event": { "id": "e1", "name": "б" } },
      { "task": { "id": "t1", "name": "в" } },
      { "settings": { "budget": 600 } },
      { "settings": { "budget": 480 } }
    ])")) == json::parse(R"([
      { "task": { "id": "t1", "name": "в", "minutes": 30 } },
      { "event": { "id": "e1", "name": "б" } },
      { "settings": { "budget": 480 } }
    ])"), "поздняя правка поля заменяет раннюю; порядок объектов сохраняется");

    check(coalesceChanges(json::parse(R"([
      { "nutritionDay": { "day": "2026-10-12", "entries": [{ "id": "f1", "name": "обед", "kcal": 500 }], "waterMl": null } },
      { "nutritionDay": { "day": "2026-10-12", "entries": [], "waterMl": 250 } },
      { "nutritionDay": { "day": "2026-10-12", "entries": [{ "id": "f1", "name": "обед", "kcal": 520 }, { "id": "f2", "deleted": true }] } },
      { "nutritionDay": { "day": "2026-10-12", "entries": [], "waterMl": 750 } },
      { "nutritionDay": { "day": "2026-10-13", "entries": [], "waterMl": 100 } }
    ])")) == json::parse(R"([
      { "nutritionDay": { "day": "2026-10-12",
          "entries": [{ "id": "f1", "name": "обед", "kcal": 520 }, { "id": "f2", "deleted": true }], "waterMl": 750 } },
      { "nutritionDay": { "day": "2026-10-13", "entries": [], "waterMl": 100 } }
    ])"), "день питания: вода после еды не теряется, записи сводятся по id");

    check(coalesceChanges(json::parse(R"([
      { "task": { "id": "t1", "occurrences": [{ "day": "2026-10-12", "done": false }] } },
      { "task": { "id": "t1", "occurrences": [{ "day": "2026-10-12", "done": true }, { "day": "2026-10-13", "done": true }] } },
      { "health": { "id": "h1", "kind": "weight", "value": 72.4 } },
      { "health": { "id": "h1", "kind": "weight", "value": 72.1 } },
      { "health": { "id": "h2", "kind": "pulse", "value": 64 } },
      { "health": { "id": "h2", "deleted": true } }
    ])")) == json::parse(R"([
      { "task": { "id": "t1", "occurrences": [{ "day": "2026-10-12", "done": true }, { "day": "2026-10-13", "done": true }] } },
      { "health": { "id": "h1", "kind": "weight", "value": 72.1 } },
      { "health": { "id": "h2", "deleted": true } }
    ])"), "экземпляры ряда сводятся по дню; удаление заменяет прежние правки");

    check(coalesceChanges(json::parse(R"([
      { "learned": { "id": "пара", "kind": "", "kindCount": 0, "minutes": 105, "minutesCount": 1, "touched": 1 } },
      { "task": { "id": "t1", "name": "а" } },
      { "learned": { "id": "пара", "minutes": 105, "minutesCount": 2, "touched": 2 } },
      { "learned": { "id": "созвон", "kind": "event", "kindCount": 1, "minutes": null, "minutesCount": 0, "touched": 3 } },
      { "learned": { "id": "пара", "kind": "event", "kindCount": 1, "touched": 4 } },
      { "learned": { "id": "зал", "kind": "event", "kindCount": 1, "minutes": null, "minutesCount": 0, "touched": 5 } },
      { "learned": { "id": "зал", "deleted": true } },
      { "learned": { "id": "урок", "deleted": true } },
      { "learned": { "id": "урок", "kind": "", "kindCount": 0, "minutes": 45, "minutesCount": 1, "touched": 6 } }
    ])")) == json::parse(R"([
      { "learned": { "id": "пара", "kind": "event", "kindCount": 1, "minutes": 105, "minutesCount": 2, "touched": 4 } },
      { "task": { "id": "t1", "name": "а" } },
      { "learned": { "id": "созвон", "kind": "event", "kindCount": 1, "minutes": null, "minutesCount": 0, "touched": 3 } },
      { "learned": { "id": "зал", "deleted": true } },
      { "learned": { "id": "урок", "kind": "", "kindCount": 0, "minutes": 45, "minutesCount": 1, "touched": 6 } }
    ])"), "словарь правок: несколько правок одного слова в пакете — одна, поздние поля побеждают");

    check(coalesceChanges(json::parse(R"([
      { "quickLine": { "id": "q1", "text": "созвон завтра 16:00", "count": 1, "touched": 1, "hidden": false } },
      { "task": { "id": "t1", "name": "созвон" } },
      { "quickLine": { "id": "q1", "text": "Созвон завтра 16:00", "count": 2, "touched": 2, "hidden": false } },
      { "quickLine": { "id": "q2", "text": "вес 72,4", "count": 1, "touched": 3, "hidden": false } },
      { "quickLine": { "id": "q2", "deleted": true } },
      { "quickLine": { "id": "q3", "deleted": true } },
      { "quickLine": { "id": "q3", "text": "зал 19:00", "count": 1, "touched": 4, "hidden": false } }
    ])")) == json::parse(R"([
      { "quickLine": { "id": "q1", "text": "Созвон завтра 16:00", "count": 2, "touched": 2, "hidden": false } },
      { "task": { "id": "t1", "name": "созвон" } },
      { "quickLine": { "id": "q2", "deleted": true } },
      { "quickLine": { "id": "q3", "text": "зал 19:00", "count": 1, "touched": 4, "hidden": false } }
    ])"), "история ввода текстом: поздняя запись строки заменяет раннюю, забытая и добавленная снова — остаётся");

    const auto same = json::parse(R"([{ "migration": { "count": 1 } }, { "migration": { "count": 2 } }, {}])");
    check(coalesceChanges(same) == same, "перенос данных и незнакомое остаются как есть");
}

static void lifecycleTests() {
    std::printf("-- планировщик: жизненный цикл контейнера (planner.ts)\n");
    {
        Rig r;
        r.sync.ensure();
        check(r.t.countSent("domain.container.list") == 1 && r.t.countSent("domain.container.create") == 0,
              "контейнера нет: список спрошен, без правок контейнер не создаётся");
        check(r.sync.status() == "ready" && r.changed == 1, "экрану «контейнера нет» сообщается один раз");
        r.sync.syncNow();
        check(r.changed == 1, "повторный опрос без контейнера экран не дёргает");
        check(r.sync.nextWakeMs() == r.t.now + kSyncIntervalMs, "опрос раз в 8 с, пока раздел нужен и окно видно");
    }
    {
        Rig r;
        r.sync.ensure();
        r.sync.apply(json::parse(R"([{"task":{"id":"t1","name":"а"}},{"task":{"id":"t1","name":"б"}}])"));
        check(r.records.load(kPendingRecord).has_value(), "непревращённые правки сразу в записи устройства");
        check(r.sync.nextWakeMs() == r.t.now, "первая правка без контейнера не ждёт тишины");
        r.sync.tick();
        check(r.t.countSent("domain.container.create") == 1 && r.recorded.size() == 1
                  && r.recorded[0].id == r.e.id,
              "первая правка создаёт контейнер и объявляет его в журнале состояния");
        check(r.t.countSent("msg.deliver") == 1, "ключ контейнера передан своим устройствам");
        check(r.e.preparedChanges.size() == 1
                  && r.e.preparedChanges[0] == json::parse(R"([{"task":{"id":"t1","name":"б"}}])"),
              "правки одного объекта ушли одной склеенной операцией");
        check(r.t.countSent("domain.op.append") == 1 && r.sync.outboxSize() == 0, "операция отправлена, очередь пуста");
        check(!r.records.load(kPendingRecord) && !r.records.load(kOutboxRecord), "записи очереди и правок сняты");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        const auto start = r.t.now;
        r.sync.apply(json::parse(R"([{"task":{"id":"t1","name":"а"}}])"));
        check(r.sync.nextWakeMs() == start + kFlushIdleMs, "правка уходит по тишине 1,5 с");
        for (int i = 0; i < 12; ++i) {
            r.advance(1000);
            r.sync.apply(json::parse(R"([{"task":{"id":"t1","name":"в"}}])"));
        }
        check(r.e.prepared == 1 && r.e.preparedChanges[0][0]["task"]["name"] == "в",
              "непрерывный ввод: пакет уходит по потолку 10 с");
        check(r.sync.hasPending(), "правки после пакета снова копятся");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        json many = json::array();
        for (int i = 0; i < 450; ++i) many.push_back(json{{"task", {{"id", "t" + std::to_string(i)}}}});
        r.sync.apply(many);
        check(r.sync.nextWakeMs() == r.t.now, "400 правок и больше — без ожидания тишины");
        r.sync.tick();
        check(r.e.prepared == 2 && r.e.preparedChanges[0].size() == 400 && r.e.preparedChanges[1].size() == 50,
              "больше 400 изменений — несколько операций");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        // Окно скрыто: опрос раз в 60 с, повтор через 15 с — раньше него
        r.sync.setVisible(false);
        r.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_UNAVAILABLE"); };
        r.sync.apply(json::parse(R"([{"task":{"id":"t1","name":"а"}}])"));
        r.sync.flush();
        check(r.sync.status() == "offline" && r.sync.outboxSize() == 1, "шард недоступен: офлайн, операция ждёт в очереди");
        check(r.records.load(kOutboxRecord).has_value(), "очередь отправки в записи устройства");
        check(r.sync.lastError() == std::string("v2: ERROR_CODE_UNAVAILABLE"), "ошибка видна экрану");
        r.t.busFns.erase("domain.op.append");
        const auto retryAt = r.t.now + kRetryOfflineMs;
        r.t.now = retryAt - 1;
        r.sync.tick();
        check(r.sync.outboxSize() == 1, "до повтора через 15 с не отправляется");
        r.t.now = retryAt;
        r.sync.tick();
        check(r.sync.outboxSize() == 0 && r.sync.status() == "ready", "повтор через 15 с досылает очередь");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        r.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_DUPLICATE"); };
        r.sync.apply(json::parse(R"([{"task":{"id":"t1"}}])"));
        r.sync.flush();
        check(r.sync.outboxSize() == 0, "DUPLICATE — операция уже принята до обрыва");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        int calls = 0;
        r.t.busFns["domain.op.append"] = [&calls](const fake::Sent &) -> std::string {
            if (++calls == 1) throw d::BusError("ERROR_CODE_EXPIRED");
            return "{}";
        };
        const int grantsBefore = r.t.countSent("domain.grant.list");
        r.sync.apply(json::parse(R"([{"task":{"id":"t1"}}])"));
        r.sync.flush();
        check(r.t.countSent("domain.grant.list") == grantsBefore + 1 && calls == 2 && r.sync.outboxSize() == 0,
              "EXPIRED: догнать гранты и запечатать заново");
        Rig k;
        k.e.attached = true;
        k.sync.ensure();
        k.t.busFns["domain.op.append"] = [](const fake::Sent &) -> std::string { throw d::BusError("ERROR_CODE_EXPIRED"); };
        k.t.engineFns["plannerIngestGrants"] = [&k](const json &) {
            k.e.key = false;
            return json(0);
        };
        k.sync.apply(json::parse(R"([{"task":{"id":"t1"}}])"));
        k.sync.flush();
        check(k.sync.status() == "no-key" && k.sync.outboxSize() == 1, "EXPIRED без нового ключа — no-key, очередь ждёт");
    }
    {
        // Очередь и правки переживают перезапуск
        fake::Transport t;
        Engine e;
        e.attached = true;
        e.install(t);
        d::MemoryRecords records;
        records.save(kOutboxRecord, json::array({json{{"opId", "aa"}, {"op", d::toBase64("old")}}}));
        records.save(kPendingRecord, json::parse(R"([{"task":{"id":"t9","name":"с прошлого раза"}}])"));
        PlannerSync s(t, records, PlannerHooks{});
        s.ensure();
        check(e.applied.size() == 1 && e.applied[0] == d::toBase64("old"),
              "операции очереди применяются заново после перезапуска");
        check(e.preparedChanges.size() == 1 && e.preparedChanges[0][0]["task"]["id"] == "t9",
              "правки из прошлой сессии превращаются в операцию");
        check(t.countSent("domain.op.append") == 2 && s.outboxSize() == 0, "обе операции отправлены");
    }
    {
        Rig r;
        r.fromState = ContainerRef{"local", "ffee"};
        r.e.id = "ffee";
        r.sync.ensure();
        check(r.t.countSent("domain.container.list") == 0 && r.t.countSent("domain.container.get") == 1,
              "контейнер из журнала личного состояния подключается без списка");
        const auto get = r.t.lastBody("domain.container.get");
        check(get["container"]["id"] == d::hexToB64("ffee") && get["container"]["domain"] == "local",
              "ссылка на контейнер — id base64");
        check(r.t.persists >= 1 && r.recorded.size() == 1, "подключение сохраняет движок и объявляет контейнер");
    }
    {
        Rig r;
        r.t.busFns["domain.container.list"] = [](const fake::Sent &) {
            return json{{"containers", json::array({json{{"ref", {{"domain", "local"}, {"id", d::hexToB64("abcd")}}}}})}}.dump();
        };
        r.e.id = "abcd";
        r.e.snapshotSeq = 7;
        r.e.syncReplies = {
            json{{"applied", 2}, {"more", true}, {"grantsBehind", false}, {"missingEpoch", nullptr}},
            json{{"applied", 0}, {"more", true}, {"grantsBehind", true}, {"missingEpoch", nullptr}},
            json{{"applied", 1}, {"more", false}, {"grantsBehind", false}, {"missingEpoch", nullptr}},
        };
        r.sync.ensure();
        check(r.t.countSent("domain.snapshot.get") == 1, "пустой журнал при ключе — сначала снимок");
        const auto syncBody = r.t.lastBody("domain.op.sync");
        check(r.t.countSent("domain.op.sync") == 3 && syncBody["after_seq"] == "9",
              "журнал страницами после снимка; after_seq — строкой");
        check(r.t.countSent("domain.grant.list") == 2, "отставшие гранты дочитываются посреди журнала");
        check(r.sync.status() == "ready", "журнал применён — ready");
    }
    {
        Rig r;
        r.e.attached = true;
        r.e.syncReplies = {json{{"applied", 0}, {"more", false}, {"grantsBehind", false}, {"missingEpoch", 3}}};
        r.sync.ensure();
        check(r.sync.status() == "no-key", "нет ключа эпохи журнала — no-key");
    }
    {
        Rig r;
        r.t.ready = false;
        r.t.linking = true;
        r.sync.ensure();
        check(r.sync.status() == "needs-linking" && r.t.sent.empty(), "непривязанное устройство в сеть не ходит");
        r.t.linking = false;
        check(r.sync.status() == "loading", "стек не поднят — loading");
    }
    {
        Rig r;
        r.e.attached = true;
        r.e.snapshotDue = true;
        r.sync.ensure();
        check(r.t.countSent("domain.snapshot.put") == 1, "снимок по порогу движка записывается");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        r.sync.setVisible(false);
        check(r.sync.nextWakeMs() == r.t.now + kSyncIdleMs, "окно скрыто — опрос раз в 60 с");
        r.sync.setVisible(true);
        check(r.sync.nextWakeMs() == r.t.now, "окно снова видно — догнать сразу");
        r.sync.tick();
        r.sync.setActive(false);
        check(r.sync.nextWakeMs() == r.t.now + kSyncIdleMs, "без потребителей — редкий опрос");
        r.sync.setActive(true);
        check(r.sync.nextWakeMs() == r.t.now, "первый потребитель — немедленный синк");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure(true);
        check(r.sync.nextWakeMs() == r.t.now + kSyncIdleMs, "фоновый запуск (напоминания) — редкий опрос");
        r.sync.ensure();
        check(r.sync.nextWakeMs() == r.t.now + kSyncIntervalMs, "вызов из UI возвращает частый опрос");
        r.sync.ensure(true);
        check(r.sync.nextWakeMs() == r.t.now + kSyncIntervalMs, "уже запущенный фоновый запуск не трогает");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.onEngineEvent();
        check(!r.sync.nextWakeMs(), "событие движка до запуска ничего не делает");
        r.sync.ensure();
        r.sync.onEngineEvent();
        check(r.sync.nextWakeMs() == r.t.now, "событие движка — синк сразу");
        check(r.sync.keysExport() == json{{"container", r.e.id}}, "ключи для экспорта линковки");
        r.sync.keysImport(json("bad"));
        check(!r.t.logs.empty() && r.t.logs.back().find("не приняты") != std::string::npos,
              "негодные ключи экспорта — в журнал, без исключения");
        check(r.sync.sizeBytes() == 123 && r.sync.stateJson().has_value(), "размер и состояние движка");
        r.sync.apply(json::parse(R"([{"task":{"id":"t1"}}])"));
        r.sync.reset();
        check(!r.sync.hasPending() && !r.sync.nextWakeMs() && !r.sync.isWanted(), "сброс снимает правки и сроки");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        r.sync.apply(json::parse(R"([{"task":{"id":"t1"}}])"));
        r.sync.pageHide();
        check(r.t.countSent("domain.op.append") == 1, "закрытие окна досылает накопленные правки");
    }
    {
        Rig r;
        r.e.attached = true;
        r.sync.ensure();
        r.t.engineFns["plannerPrepareLocal"] = [](const json &) -> json { throw std::runtime_error("{\"error\":\"InvalidField\"}"); };
        r.sync.apply(json::parse(R"([{"task":{"id":"t1"}}])"));
        r.sync.flush();
        check(!r.sync.hasPending() && r.sync.outboxSize() == 0 && r.sync.status() == "ready",
              "правка, отвергнутая движком, отбрасывается без офлайна");
    }
}

int main() {
    std::printf("=== parvane-core planner_sync tests (без стека) ===\n");
    coalesceTests();
    lifecycleTests();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
