// Parvane fork (spec 036 T027/T028, ENGINE-1): личное состояние desktop по видам — показ из объектов модели
// (`viewStateJson`), правка — `stateSet` с показанным (`base`), изменения модели — событием сессии `model`.
//  - ключи собеседников как у модели (`u:` / `g:<домен>:<hex>`), туда и обратно;
//  - перекладка объектов модели в снимок формы state.v1 для проекции tdesktop (значения как есть, отметки
//    «отправлено» и граница очистки);
//  - записи вида: не правленое относительно показанного не пишется, правленое — с base, пропавшее — удаляется,
//    объекты модели, которых хост не показывал, не трогаются;
//  - через модель в памяти: правка другого устройства, сведённая после показа, не откатывается устаревшей копией
//    хоста (гонка T124; без `base` движка — откатывалась);
//  - событие `model` несёт только показываемые изменения.
// Данные выдуманные.
#include "parvane/engine_host.h"
#include "parvane/state_model.h"
#include "parvane/v2_content.h"

#include <cstdio>
#include <string>

using nlohmann::json;
namespace sv = parvane::v2::stateview;

static int g_fail = 0;
static void check(bool c, const std::string &msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg.c_str());
    if (!c) ++g_fail;
}

static json folder(const std::string &title, std::initializer_list<const char *> peers) {
    auto list = json::array();
    for (const auto *p : peers) list.push_back(json{{"user", {{"address", p}}}});
    return json{{"id", 5}, {"title", title}, {"include_peers", list}};
}

static void testKeys() {
    check(sv::peerKeyOf(json{{"user", {{"address", "bob@local"}}}}) == "u:bob@local", "ключ собеседника");
    const auto g = json{{"group", {{"domain", "local"}, {"id", parvane::v2::hexToB64("00112233445566778899aabbccddeeff")}}}};
    check(sv::peerKeyOf(g) == "g:local:00112233445566778899aabbccddeeff", "ключ группы — hex, как у модели");
    check(sv::peerOfKey("g:local:00112233445566778899aabbccddeeff") == g, "группа из ключа");
    check(sv::peerOfKey("u:bob@local") == json{{"user", {{"address", "bob@local"}}}}, "собеседник из ключа");
    check(sv::peerOfKey("5").is_null() && sv::peerOfKey("g:local:zz").is_null(), "не ключ собеседника — null");
    check(sv::kindName("FOLDER") == "OBJECT_KIND_FOLDER" && sv::kindName("OBJECT_KIND_DRAFT") == "OBJECT_KIND_DRAFT",
          "полное имя вида");
}

static void testSnapshot() {
    const json view{{"objects", json::array({
        json{{"kind", "OBJECT_KIND_FOLDER"}, {"key", "5"}, {"value", folder("Работа", {"bob@local"})}},
        json{{"kind", "OBJECT_KIND_ARCHIVE"}, {"key", "u:carol@local"}, {"value", json::object()}},
        json{{"kind", "OBJECT_KIND_PIN_LIST"}, {"key", "1"}, {"value", {{"list", "PIN_LIST_MAIN"},
                                                                         {"peers", json::array({json{{"user", {{"address", "bob@local"}}}}})}}}},
        json{{"kind", "OBJECT_KIND_SCHEDULED"}, {"key", "0102"}, {"value", {{"send_at_ms", "9"}}},
             {"marks", json::array({json{{"field", 1}, {"value", "AQ=="}}})}},
        json{{"kind", "OBJECT_KIND_SCHEDULED"}, {"key", "0304"}, {"value", {{"send_at_ms", "10"}}}},
        json{{"kind", "OBJECT_KIND_CHAT_CLEARED"}, {"key", "u:bob@local"}, {"value", json::object()},
             {"marks", json::array({json{{"field", 2}, {"value", "AQI="}}})}},
        json{{"kind", "OBJECT_KIND_SAVED_GIF"}, {"key", "g:ab"}, {"value", {{"set_id", "g:ab"}}}},
        json{{"kind", "OBJECT_KIND_QUICK_REACTION"}, {"key", ""}, {"value", {{"emoji", "🔥"}}}},
    })}};
    const auto s = sv::snapshotOf(view);
    check(s["folders"].size() == 1 && s["folders"][0]["title"] == "Работа", "папка — значением модели");
    check(s["archived"] == json::array({json{{"user", {{"address", "carol@local"}}}}}), "архив — собеседник из ключа");
    check(s["pinned"][0]["list"] == "PIN_LIST_MAIN", "закреп — значением");
    check(s["scheduled"].size() == 1 && s["scheduled"][0]["send_at_ms"] == "10", "отправленное отложенное не в списке");
    check(s["scheduled_sent"] == json::array({"AQI="}), "отметка «отправлено» — op_id base64");
    check(s["cleared"][0]["cleared_until_ms"] == "258", "граница очистки из отметки (0x0102)");
    check(s["sticker_packs"].size() == 1, "GIF — в наборах");
    check(s["quick_reaction"]["emoji"] == "🔥", "быстрая реакция");
    check(s["drafts"] == json::array() && s["blocked"] == json::array(), "пустые списки — есть (снять пропавшее)");
    check(sv::objectsOf(view, "SCHEDULED").size() == 2 && sv::markValue(sv::objectsOf(view, "SCHEDULED")[0], 1) == 1,
          "объекты вида и отметка");
}

static void testSets() {
    const auto shown = json::array({json{{"key", "5"}, {"value", folder("Работа", {"bob@local"})}},
                                    json{{"key", "6"}, {"value", folder("Дом", {})}}});
    // 5 — не правлен, 6 — убран хостом, 7 — новый
    auto sets = sv::setsFor("FOLDER", json::array({json{{"key", "5"}, {"value", folder("Работа", {"bob@local"})}},
                                                   json{{"key", "7"}, {"value", folder("Учёба", {})}}}), shown);
    check(sets.size() == 2, "две записи: новый и удалённый (" + std::to_string(sets.size()) + ")");
    check(sets.size() == 2 && sets[0]["key"] == "7" && !sets[0].contains("base") && sets[0]["kind"] == "OBJECT_KIND_FOLDER",
          "новый объект — без base");
    check(sets.size() == 2 && sets[1]["key"] == "6" && sets[1].value("delete", false), "убранный показанный — удаление");
    sets = sv::setsFor("FOLDER", json::array({json{{"key", "5"}, {"value", folder("Работа", {"bob@local", "carol@local"})}}}),
                       json::array({shown[0]}));
    check(sets.size() == 1 && sets[0]["base"] == shown[0]["value"], "правленый — с показанным (base)");
}

static void testModelEvent() {
    check(sv::modelEventOf({json{{"notice", json::object()}}, json{{"needs", json::object()}}}).is_null(),
          "без показываемых изменений — события нет");
    const auto ev = sv::modelEventOf({json{{"state_changed", {{"object", {{"kind", 1}}}}}}, json{{"client_events", {}}},
                                      json{{"chat_upsert", json::object()}}});
    check(ev.value("type", std::string()) == "model" && ev["changes"].size() == 2, "событие model — только показываемое");
}

// Модель в памяти: показ, правка с base, гонка с другим устройством
static void testWithModel() {
    const json cfg{{"user", "alice@local"}, {"device_id", "d1"}, {"domain", "local"}, {"now_ms", "1800000000000"},
                   {"device_key", parvane::v2::toBase64(std::string(32, '\x05'))}, {"host_driven", true}};
    std::string err;
    auto h = parvane::engine::Host::openMemory(cfg, &err);
    check(h != nullptr, "модель в памяти: " + err);
    if (!h) return;
    const auto submit = [&](const json &desired, const json &shown) {
        bool ok = true;
        for (const auto &args : sv::setsFor("FOLDER", desired, shown)) {
            const auto st = h->step("stateSet", args);
            if (!st.ok()) {
                ok = false;
                std::printf("  stateSet: %s\n", st.error.c_str());
            }
        }
        return ok;
    };
    const auto view = [&] { return h->read("viewStateJson", json{{"kinds", json::array({"OBJECT_KIND_FOLDER"})}}); };
    check(submit(json::array({json{{"key", "5"}, {"value", folder("Работа", {"bob@local"})}}}), json::array()),
          "папка создана");
    const auto shown = sv::objectsOf(view(), "FOLDER");
    check(shown.size() == 1 && shown[0]["value"]["title"] == "Работа", "показ — значением модели");
    // Другое устройство переименовало папку (сведено моделью после показа)
    check(submit(json::array({json{{"key", "5"}, {"value", folder("Работа+дом", {"bob@local"})}}}), shown),
          "правка другого устройства");
    // Хост добавил carol по показанному — название другого устройства остаётся
    check(submit(json::array({json{{"key", "5"}, {"value", folder("Работа", {"bob@local", "carol@local"})}}}), shown),
          "правка хоста по показанному");
    const auto after = sv::objectsOf(view(), "FOLDER");
    check(after.size() == 1 && after[0]["value"]["title"] == "Работа+дом", "название другого устройства не откатано");
    check(after.size() == 1 && after[0]["value"]["include_peers"].size() == 2, "чат хоста добавлен");
    const auto snap = sv::snapshotOf(view());
    check(snap["folders"].size() == 1, "снимок для проекции из объектов модели");
    // Удаление показанного
    check(submit(json::array(), after), "папка удалена");
    check(sv::objectsOf(view(), "FOLDER").empty(), "после удаления объектов нет");
    // Признак без значения
    const auto st = h->step("stateSet", json{{"kind", "OBJECT_KIND_ARCHIVE"}, {"key", "u:bob@local"}, {"value", json::object()}});
    check(st.ok(), "архив — признак без значения");
    bool changed = false;
    for (const auto &ch : st.changes) changed = changed || ch.contains("state_changed");
    check(changed && !sv::modelEventOf(st.changes).is_null(), "правка — state_changed в событии model");
}

int main() {
    testKeys();
    testSnapshot();
    testSets();
    testModelEvent();
    testWithModel();
    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
