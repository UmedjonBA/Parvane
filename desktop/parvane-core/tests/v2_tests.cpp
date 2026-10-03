// Parvane fork: протокол v2 без стека (spec 007, T061–T063): C ABI движка
// слинкован и отвечает, владение памятью, ошибки need/error, отображение
// содержимого v2 ↔ v1 и разбор событий "direct" для конвейера клиента.
#include <cstdio>
#include <string>

#include "parvane/poll.h"
#include "parvane/call.h"
#include "parvane/v2_content.h"
#include "parvane/v2_engine.h"

using nlohmann::json;
namespace v2 = parvane::v2;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
}

int main() {
    std::printf("=== parvane-core v2 tests (движок %s) ===\n", v2::engineVersion().c_str());

    // ── движок ─────────────────────────────────────────────────────────────
    check(v2::protocolMajor() == 2, "мажорная версия протокола = 2");
    check(!v2::encodeHello(v2::kChannelIdentified, "desktop", "test").empty(), "Hello собран движком");
    check(!v2::encodeRequest(1, "msg.inbox.sync", std::string(), 1000).empty(), "Request собран движком");
    {
        // Кадр клиента не принимается как кадр сервера (направление).
        bool threw = false;
        try {
            (void)v2::decodeFrame(v2::encodeHello(v2::kChannelIdentified, "desktop", "test"));
        } catch (const v2::EngineError &e) {
            threw = !e.isNeed() && !e.kind().empty();
        }
        check(threw, "decodeFrame: кадр клиента отвергнут (EngineError)");
        threw = false;
        try {
            (void)v2::decodeFrame(std::string("\xff\xff\xff", 3));
        } catch (const v2::EngineError &) {
            threw = true;
        }
        check(threw, "decodeFrame: мусор отвергнут");
    }
    check(v2::fromBase64("aGk=") == "hi", "base64 движка");
    {
        auto c = v2::Client::create("alice@local", "dev1", "local");
        const auto id = c->createIdentity(3);
        const auto &reqs = id.value("requests", json::array());
        bool hasLog = false;
        for (const auto &r : reqs) {
            const auto req = v2::parseRequest(r);
            if (req.method == "identity.device.log_append" && !req.body.empty()) hasLog = true;
        }
        check(hasLog, "createIdentity: запрос identity.device.log_append с телом");
        check(!id.value("rootSecret", std::string()).empty(), "createIdentity: корень выдан");
        const std::string key(32, '\x07');
        const auto blob = c->exportState(key);
        check(!blob.empty(), "exportState: состояние не пусто");
        auto c2 = v2::Client::import(blob, key);
        check(c2 != nullptr, "import: состояние читается тем же ключом");
        bool wrongKey = false;
        try {
            (void)v2::Client::import(blob, std::string(32, '\x08'));
        } catch (const v2::EngineError &) {
            wrongKey = true;
        }
        check(wrongKey, "import: чужой ключ отвергнут");
        // Без журнала собеседника — need peerLog (движок просит добрать).
        bool need = false;
        try {
            (void)c2->prepareDirect("bob@local", json{{"text", {{"text", "hi"}}}}, "");
        } catch (const v2::EngineError &e) {
            need = e.isNeed() && e.kind() == "peerLog" && e.need().value("user", "") == "bob@local";
        }
        check(need, "prepareDirect без журнала → need peerLog");
        check(c2->logVersion("bob@local") == 0, "logVersion неизвестного = 0");
        const auto sync = v2::parseRequest(c2->syncRequest());
        check(sync.method == "msg.inbox.sync" && !sync.anon, "syncRequest → msg.inbox.sync по ID");
        const auto body = v2::encodeMessage("parvane.identity.v2.DeviceLogSyncAnonRequest",
            json{{"user", {{"address", "bob@local"}}}, {"after_version", "0"}});
        check(!body.empty(), "encodeMessage: тело из proto3-JSON");
        bool unknownType = false;
        try {
            (void)v2::encodeMessage("parvane.nope.Nope", json::object());
        } catch (const v2::EngineError &) {
            unknownType = true;
        }
        check(unknownType, "encodeMessage: неизвестный тип отвергнут");
    }
    // ── C1-06: копия корня под ключом восстановления ──────────────────────
    {
        auto c = v2::Client::create("alice@local", "dev1", "local");
        const auto id = c->createIdentity(1);
        const auto root = v2::fromBase64(id.value("rootSecret", std::string()));
        const auto key = v2::generateRecoveryKey();
        check(root.size() == 32 && key.size() >= 16, "ключ восстановления выдан движком");
        const auto backup = c->exportRootBackup(root, key);
        check(!backup.empty() && backup.find(root) == std::string::npos, "exportRootBackup: копия без корня в открытом виде");
        check(c->importRootBackup(backup, key) == root, "importRootBackup: корень восстановлен тем же ключом");
        bool wrong = false;
        try {
            (void)c->importRootBackup(backup, v2::generateRecoveryKey());
        } catch (const v2::EngineError &) {
            wrong = true;
        }
        check(wrong, "importRootBackup: чужой ключ отвергнут");
    }
    // ── C2-01: планировщик анонимных соединений ───────────────────────────
    {
        v2::AnonPlanner p;
        const auto a = p.assign("identity.device.fetch_bundle_anon", std::string(), 1000);
        const auto b = p.assign("identity.device.log_sync_anon", std::string(), 1000);
        check(a.open && a.closeAfter && b.open && b.conn != a.conn, "публичные запросы — каждый в новом одноразовом соединении");
        check(p.openCount() == 0, "публичное соединение не держится");
        bool threw = false;
        try {
            (void)p.assign("msg.deliver_sealed", std::string("\xff\xff\xff", 3), 1000);
        } catch (const v2::EngineError &) {
            threw = true;
        }
        check(threw, "битое тело доставки → EngineError");
        check(p.expired(1000 + 61000).empty(), "нет серий — нечего закрывать");
    }

    // ── UUID ───────────────────────────────────────────────────────────────
    {
        const std::string u = "0192f0e4-1a2b-7c3d-8e4f-001122334455";
        const auto b = v2::uuidToB64(u);
        check(b.size() == 24 && v2::b64ToUuid(b).value_or("") == u, "UUID ↔ base64", b);
        const auto n = v2::newUuidV7();
        check(n.size() == 36 && n[14] == '7', "UUIDv7", n);
        check(!v2::b64ToUuid("AAAA").has_value(), "base64 не 16 байт → нет UUID");
    }

    // ── содержимое v1 → v2 → v1 ────────────────────────────────────────────
    {
        const json text = {
            {"kind", "text"}, {"text", "hi bold"},
            {"entities", json::array({json{{"type", "bold"}, {"offset", 3}, {"length", 4}},
                                      json{{"type", "text_url"}, {"offset", 0}, {"length", 2}, {"data", "https://a.b"}}})},
            {"webpage", {{"url", "https://a.b"}, {"title", "T"}}},
            {"ttl_secs", 30},
        };
        const auto v = v2::toV2(text, "0192f0e4-1a2b-7c3d-8e4f-001122334455");
        check(v && (*v)["text"]["text"] == "hi bold", "text → v2");
        check(v && (*v)["text"]["entities"][0]["type"] == "ENTITY_TYPE_BOLD", "entity bold → ENTITY_TYPE_BOLD");
        check(v && (*v)["text"]["entities"][1]["url"] == "https://a.b", "text_url → url");
        check(v && (*v)["text"]["preview"]["url"] == "https://a.b", "webpage → preview");
        check(v && (*v)["reply_to"]["op_id"].is_string(), "reply_to → MessageRef");
        const auto back = v2::fromV2(*v);
        check(back && (*back)["kind"] == "text" && (*back)["text"] == "hi bold", "text ← v2");
        check(back && (*back)["entities"][1]["data"] == "https://a.b", "entities ← v2 (data)");
        check(back && (*back)["webpage"]["title"] == "T", "webpage ← v2");
        check(back && (*back)["ttl_secs"] == 30, "ttl_secs сохранён");
    }
    {
        const json photo = {{"kind", "photo"}, {"file_id", "f1"}, {"width", 10}, {"height", 20},
                            {"mime", "image/jpeg"}, {"size_bytes", 1234}, {"caption", nullptr},
                            {"file_key", "a2V5"}, {"file_nonce", "bm9u"}};
        const auto v = v2::toV2(photo);
        check(v && (*v)["media"]["kind"] == "MEDIA_KIND_PHOTO" && (*v)["media"]["size"] == "1234",
              "photo → media (size строкой)");
        check(v && !(*v)["media"].contains("caption"), "пустая подпись не уходит");
        const auto back = v2::fromV2(*v);
        check(back && (*back)["kind"] == "photo" && (*back)["size_bytes"] == 1234
                  && (*back)["file_key"] == "a2V5" && (*back)["width"] == 10,
              "photo ← media");
        const json voice = {{"kind", "voice"}, {"file_id", "f2"}, {"duration_secs", 3},
                            {"waveform", json::array({0, 5, 31})}};
        const auto vv = v2::toV2(voice);
        check(vv && (*vv)["media"]["duration_ms"] == 3000 && (*vv)["media"]["waveform"].is_string(),
              "voice → duration_ms и waveform base64");
        const auto vb = v2::fromV2(*vv);
        check(vb && (*vb)["kind"] == "voice" && (*vb)["duration_secs"] == 3
                  && (*vb)["waveform"] == json::array({0, 5, 31}),
              "voice ← media");
        const json audio = {{"kind", "file"}, {"file_id", "f3"}, {"mime", "audio/mpeg"}, {"filename", "a.mp3"}};
        const auto va = v2::toV2(audio);
        check(va && (*va)["media"]["kind"] == "MEDIA_KIND_AUDIO" && (*va)["media"]["name"] == "a.mp3",
              "аудиофайл → MEDIA_KIND_AUDIO");
    }
    {
        const json loc = {{"kind", "location"}, {"lat", 55.75}, {"long", 37.61}, {"live_period", 60}};
        const auto v = v2::toV2(loc);
        check(v && (*v)["location"]["latitude"] == 55.75 && (*v)["location"]["live_period_s"] == 60,
              "location → v2");
        const auto back = v2::fromV2(*v);
        check(back && (*back)["lat"] == 55.75 && (*back)["live_period"] == 60, "location ← v2");
    }
    {
        // Формат опроса десктопа (answers/public/multiple) — через normalize.
        const json poll = {{"kind", "poll"}, {"question", "Q?"}, {"answers", json::array({"a", "b"})},
                           {"public", true}, {"multiple", false}};
        const auto v = v2::toV2(poll);
        check(v && (*v)["poll"]["options"][1]["text"] == "b" && (*v)["poll"]["is_public"] == true,
              "poll (формат десктопа) → v2");
        const auto back = v2::fromV2(*v);
        check(back && (*back)["answers"] == json::array({"a", "b"}) && (*back)["public"] == true,
              "poll ← v2 (оба набора имён)");
        const json vote = {{"kind", "poll_vote"}, {"poll", "0192f0e4-1a2b-7c3d-8e4f-001122334455"},
                           {"options", json::array({1})}};
        const auto vv = v2::toV2(vote);
        const auto vb = v2::fromV2(*vv);
        check(vb && (*vb)["poll"] == "0192f0e4-1a2b-7c3d-8e4f-001122334455" && (*vb)["options"] == json::array({1}),
              "poll_vote туда и обратно");
    }
    {
        const json sticker = {{"kind", "sticker"}, {"file_id", "s1"}, {"filename", "😀"},
                              {"pack_ref", {{"file_id", "p1"}, {"name", "cats"}, {"count", 3}, {"key", "k"}, {"nonce", "n"}}}};
        const auto v = v2::toV2(sticker);
        check(v && (*v)["sticker"]["emoji"] == "😀" && (*v)["sticker"]["pack"] == "cats", "sticker → v2");
        const auto back = v2::fromV2(*v);
        check(back && (*back)["kind"] == "sticker" && (*back)["pack_ref"]["name"] == "cats"
                  && (*back)["file_id"] == "s1",
              "sticker ← v2");
    }
    check(!v2::toV2(json{{"kind", "skdm"}}).has_value(), "служебный v1-вид (skdm) в v2 не уходит");
    check(!v2::fromV2(json{{"contact", {{"first_name", "A"}}}}).has_value(), "contact ← v2: нет v1-вида");

    // ── события "direct" ───────────────────────────────────────────────────
    {
        const std::string self = "bob@local";
        const std::string op = "0192f0e4-1a2b-7c3d-8e4f-001122334455";
        const std::string tgt = "0192f0e4-1a2b-7c3d-8e4f-00112233aaaa";
        const auto ev = [&](const json &content, const std::string &disp = "show") {
            return json{{"type", "direct"}, {"seq", 1}, {"chat", "alice@local"}, {"from", "alice@local"},
                        {"device", "d"}, {"opId", op}, {"tsMs", 1700000000123LL}, {"content", content},
                        {"disposition", disp}};
        };
        auto in = v2::interpretDirect(ev(json{{"text", {{"text", "hello"}}}, {"reply_to", v2::ref(tgt)}}), self);
        check(in.kind == v2::Incoming::Kind::Message && in.content["text"] == "hello" && in.to == self
                  && in.ts == 1700000000 && in.replyTo == tgt,
              "direct text → Message (to=self, ts в секундах, reply)");
        in = v2::interpretDirect(ev(json{{"text", {{"text", "x"}}}}, "stub"), self);
        check(in.kind == v2::Incoming::Kind::Stub && in.content["kind"] == "unsupported", "disposition stub → Stub");
        in = v2::interpretDirect(ev(json{{"contact", {{"first_name", "A"}}}}), self);
        check(in.kind == v2::Incoming::Kind::Stub, "неизвестный клиенту вид → Stub");
        in = v2::interpretDirect(ev(json::object()), self);
        check(in.kind == v2::Incoming::Kind::Stub, "пустое содержимое → Stub");
        in = v2::interpretDirect(ev(json{{"edit", {{"target", v2::ref(tgt)}, {"text", {{"text", "new"}}}}}}), self);
        check(in.kind == v2::Incoming::Kind::Edit && in.targets == std::vector<std::string>{tgt}
                  && in.content["text"] == "new",
              "edit → Edit с новым текстом");
        in = v2::interpretDirect(ev(json{{"delete", {{"targets", json::array({v2::ref(tgt)})}, {"for_everyone", true}}}}), self);
        check(in.kind == v2::Incoming::Kind::Delete && in.targets.size() == 1, "delete → Delete");
        in = v2::interpretDirect(ev(json{{"reaction", {{"target", v2::ref(tgt)}, {"emoji", "👍"}}}}), self);
        check(in.kind == v2::Incoming::Kind::Reaction && in.emoji == "👍" && !in.remove, "reaction → Reaction");
        in = v2::interpretDirect(ev(json{{"reaction", {{"target", v2::ref(tgt)}, {"remove", true}}}}), self);
        check(in.kind == v2::Incoming::Kind::Reaction && in.remove, "reaction remove");
        in = v2::interpretDirect(ev(json{{"pin", {{"target", v2::ref(tgt)}, {"unpin", true}}}}), self);
        check(in.kind == v2::Incoming::Kind::Pin && in.unpin, "pin → Pin (unpin)");
        in = v2::interpretDirect(ev(json{{"receipt", {{"kind", "RECEIPT_KIND_READ"}, {"messages", json::array({v2::ref(tgt)})}}}}), self);
        check(in.kind == v2::Incoming::Kind::Read && in.targets.size() == 1, "receipt READ → Read");
        in = v2::interpretDirect(ev(json{{"receipt", {{"kind", "RECEIPT_KIND_DELIVERED"}}}}), self);
        check(in.kind == v2::Incoming::Kind::None, "receipt DELIVERED → None");
        in = v2::interpretDirect(ev(json{{"delivery_key", {{"generation", "1"}}}}), self);
        check(in.kind == v2::Incoming::Kind::None, "служебный delivery_key → None");
        auto own = ev(json{{"text", {{"text", "mine"}}}});
        own["from"] = self;
        own["chat"] = "alice@local";
        in = v2::interpretDirect(own, self);
        check(in.kind == v2::Incoming::Kind::Message && in.to == "alice@local", "своё с другого устройства → to=собеседник");
        in = v2::interpretDirect(json{{"type", "legacyV1"}, {"seq", 2}, {"json", "{}"}}, self);
        check(in.kind == v2::Incoming::Kind::None, "legacyV1 → None (история v1 идёт v1-стеком)");

        // Группа v2: сообщение — в чат "v2g:<hex>", автор — из подписи.
        auto gev = json{{"type", "group"}, {"seq", 5}, {"group", {{"domain", "local"}, {"id", "00ff"}}},
                        {"from", "carol@local"}, {"device", "d"}, {"opId", tgt}, {"tsMs", 1000},
                        {"content", {{"text", {{"text", "всем"}}}}}, {"disposition", "show"}};
        in = v2::interpretDirect(gev, self);
        check(in.kind == v2::Incoming::Kind::Message && in.group && in.chat == "v2g:00ff" && in.to == "v2g:00ff"
                  && in.from == "carol@local" && in.content["text"] == "всем",
              "group → Message в чате v2g:<hex>");
        gev["content"] = json{{"reaction", {{"target", v2::ref(tgt)}, {"emoji", "🔥"}}}};
        in = v2::interpretDirect(gev, self);
        check(in.kind == v2::Incoming::Kind::Reaction && in.chat == "v2g:00ff", "group reaction → Reaction");
    }

    // ── адреса групп и ссылки v2 ─────────────────────────────────────────────
    check(v2::isGroupAddress("v2g:ab") && !v2::isGroupAddress("bob@local") && v2::groupHex("v2g:ab") == "ab",
          "адрес группы v2g:<hex>");
    check(v2::hexToB64("00ff10") == "AP8Q" && v2::b64ToHex("AP8Q") == "00ff10", "hex ↔ base64");
    {
        const auto p = v2::parseInvite("https://parvane.invite/0123456789abcdef0123456789abcdef");
        check(p && p->value("kind", std::string()) == "legacy", "parseInvite: v1-ссылка → legacy");
        check(!v2::parseInvite("hello"), "parseInvite: не ссылка → nullopt");
    }
    {
        // Группа через C ABI без сети: создание, сведения, ссылка, разбор ссылки.
        auto c = v2::Client::create("alice@local", "d1", "local");
        (void)c->createIdentity(1);
        const auto created = c->groupCreate(1, "Команда", {}, json{{"send_messages", true}});
        const auto list = c->groupList();
        check(list.size() == 1 && created.contains("request"), "groupCreate → запрос и группа в списке");
        const auto info = list.empty() ? std::nullopt : c->groupInfo(list[0]);
        check(info && info->value("name", std::string()) == "Команда" && info->value("owner", std::string()) == "alice@local",
              "groupInfo: имя и владелец из журнала");
        check(!list.empty() && c->groupUnconfirmed(list[0], {"alice@local", "eve@local"}) == std::vector<std::string>{"eve@local"},
              "groupUnconfirmed (T080): участник без записи журнала");
        if (!list.empty()) {
            const auto inv = c->groupInviteCreate(list[0], "", 0, 0, false);
            const auto url = inv.value("url", std::string());
            const auto p = v2::parseInvite(url);
            check(p && p->value("kind", std::string()) == "v2" && p->value("linkId", std::string()) == inv.value("linkId", std::string()),
                  "ссылка v2: создана и разобрана", url);
        }
        // Режим «усиленная приватность» (L2, T079) через C ABI.
        check(c->presenceAllowed(), "L2: присутствие разрешено, пока режим нигде не активен");
        const auto idle = c->l2Direct("bob@local");
        check(!idle.value("active", true) && idle.value("ephemeralAllowed", false) && !idle.value("pad", true),
              "L2: личный чат по умолчанию в обычном режиме", idle.dump());
        {
            bool need = false;
            try {
                (void)c->l2SetDirect("bob@local", true, std::string());
            } catch (const v2::EngineError &e) {
                need = e.isNeed();
            }
            check(need && !c->l2Direct("bob@local").value("active", true),
                  "L2: собеседник без журнала → need, состояние не меняется");
        }
        if (!list.empty()) {
            const auto before = c->l2Group(list[0]);
            check(!before.value("active", true) && before.value("ephemeralAllowed", false), "L2: группа в обычном режиме");
            c->l2SetGroupPref(list[0], true);
            const auto own = c->l2Group(list[0]);
            check(!own.value("active", true) && own.value("pad", false) && own.value("mine", false)
                      && own.value("ephemeralAllowed", false) && c->presenceAllowed(),
                  "L2: личное предпочтение в группе — только свои исходящие", own.dump());
            c->l2SetGroupPref(list[0], false);
            const auto req = c->groupChange(list[0], json{{"set_privacy_mode", {{"l2", true}}}});
            const auto on = c->l2Group(list[0]);
            check(req.value("method", std::string()) == "group.state.append" && on.value("active", false)
                      && on.value("pad", false) && !on.value("ephemeralAllowed", true)
                      && on.value("enabledBy", json::array()) == json::array({"alice@local"}),
                  "L2: политика группы записью журнала", on.dump());
            const auto l2info = c->groupInfo(list[0]);
            check(l2info && l2info->value("l2", false) && l2info->value("l2By", std::string()) == "alice@local",
                  "L2: groupInfo несёт l2/l2By");
            check(!c->presenceAllowed(), "L2: присутствие не публикуется, пока режим активен");
            (void)c->groupChange(list[0], json{{"set_privacy_mode", {{"l2", false}}}});
            check(!c->l2Group(list[0]).value("active", true) && c->presenceAllowed(), "L2: политика снята");
        }
        {
            // Содержимое chat_mode → служебное сообщение чата (класс «сообщение»).
            const auto on = v2::fromV2(json{{"chat_mode", {{"l2", true}}}});
            const auto off = v2::fromV2(json{{"chat_mode", json::object()}});
            check(on && (*on)["kind"] == "chat_mode" && (*on)["l2"] == true && off && (*off)["l2"] == false,
                  "chat_mode ← v2: содержимое UI");
            const auto in = v2::interpretDirect(
                json{{"type", "direct"}, {"opId", "0192f0e4-1a2b-7c3d-8e4f-001122334455"}, {"from", "bob@local"},
                     {"chat", "bob@local"}, {"tsMs", 1700000000000LL}, {"disposition", "show"},
                     {"content", {{"chat_mode", {{"l2", true}}}}}},
                "alice@local");
            check(in.kind == v2::Incoming::Kind::Message && in.content == v2::chatModeContent(true)
                      && in.chat == "bob@local" && in.from == "bob@local",
                  "событие direct с chat_mode → Message для конвейера клиента");
        }
        check(!c->hasStateKey() && c->ensureStateKey() && c->hasStateKey(), "ключ личного состояния создан");
        auto st = v2::StateSession::open(*c);
        check(st != nullptr, "сессия журнала состояния открыта");
        if (st) {
            const auto bodies = st->migrate(json{{"folders", json::array({json{{"id", 3}, {"title", "Семья"}}})}});
            check(bodies.size() == 1 && st->snapshot().dump().find("Семья") != std::string::npos,
                  "миграция локальных папок в журнал");
            const auto none = st->diff(json{{"folders", json::array({json{{"id", 3}, {"title", "Семья"}}})}}, {"folders"});
            check(none.empty(), "diff без изменений — нет записей");
        }
    }

    {
        // Линковка второго устройства (LINK-1 v2) через C ABI: грант первого
        // устройства несёт ключ личного состояния, второе по нему вступает.
        auto first = v2::Client::create("alice@local", "d1", "local");
        (void)first->createIdentity(1);
        (void)first->ensureStateKey();
        auto material = first->linkGrantMaterial();
        check(material.find("\"ssk\"") != std::string::npos && material.find("\"sk\"") != std::string::npos,
              "linkGrantMaterial: SSK и ключ личного состояния в материале");
        auto second = v2::Client::create("alice@local", "d2", "local");
        const auto reqs = second->joinWithGrant(material, 1);
        bool publishes = false;
        for (const auto &r : reqs) {
            if (r.value("method", std::string()) == "identity.device.publish_certificate") publishes = true;
        }
        check(reqs.is_array() && publishes, "joinWithGrant → запрос публикации сертификата");
        check(second->hasStateKey(), "ключ личного состояния пришёл грантом");
        const auto devs = second->logDevices("alice@local");
        check(devs.contains("v2") && devs["v2"].size() == 2, "журнал устройств: оба устройства", devs.dump());
        auto fresh = v2::Client::create("alice@local", "d3", "local");
        bool refused = false;
        try {
            (void)fresh->linkGrantMaterial();
        } catch (const std::exception &) {
            refused = true;
        }
        check(refused, "устройство без SSK грант не выдаёт");
    }

    {
        // Сигнал звонка v1 ↔ v2 (D-08) и сам запечатанный сигнал через C ABI.
        const std::string id = "01a0f945-1263-7d48-b3a1-ae3da31ccea9";
        const auto offer = v2::callSignalToV2(json{{"type", "invite"}, {"call_id", id}, {"media", "video"}, {"sdp", "v=0"}, {"sig", "x"}});
        check(offer && (*offer)["offer"].value("video", false) && (*offer)["offer"].value("sdp", "") == "v=0"
                  && !offer->dump().empty() && offer->dump().find("sig") == std::string::npos,
              "callSignalToV2: invite → offer, подпись SDP не переносится");
        const auto back = v2::callSignalFromV2(json{{"callId", (*offer)["call_id"]}, {"offer", {{"sdp", "v=0"}, {"video", true}}}});
        check(back && back->value("type", "") == "invite" && back->value("call_id", "") == id && back->value("media", "") == "video",
              "callSignalFromV2: offer → invite с тем же id");
        const auto ice = v2::callSignalToV2(json{{"type", "ice"}, {"call_id", id},
            {"candidate", R"({"candidate":"candidate:w","sdpMid":"0","sdpMLineIndex":0})"}});
        check(ice && (*ice)["ice"].value("candidate", "") == "candidate:w" && (*ice)["ice"].value("sdp_mid", "") == "0",
              "callSignalToV2: кандидат вида web → IceCandidate");
        const auto iceBack = v2::callSignalFromV2(json{{"callId", (*offer)["call_id"]},
            {"ice", {{"candidate", "candidate:w"}, {"sdpMid", "0"}, {"sdpMlineIndex", 0}}}});
        const auto parsed = iceBack ? parvane::parseIceCandidate(iceBack->value("candidate", "")) : std::nullopt;
        check(parsed && parsed->sdp == "candidate:w" && parsed->mid == "0", "callSignalFromV2: IceCandidate → кандидат CALL-1");
        const auto busy = v2::callSignalFromV2(json{{"callId", (*offer)["call_id"]}, {"hangup", {{"reason", "HANGUP_REASON_BUSY"}}}});
        const auto bye = v2::callSignalFromV2(json{{"callId", (*offer)["call_id"]}, {"hangup", {{"reason", 1}}}});
        check(busy && busy->value("type", "") == "reject" && busy->value("reason", "") == "busy"
                  && bye && bye->value("type", "") == "hangup",
              "callSignalFromV2: причина завершения → reject/hangup");
        check(!v2::callSignalToV2(json{{"type", "group_invite"}, {"call_id", id}})
                  && !v2::callSignalToV2(json{{"type", "invite"}, {"call_id", "not-a-uuid"}}),
              "callSignalToV2: групповой сигнал и id не-UUID по v2 не идут");
        auto c = v2::Client::create("alice@local", "d1", "local");
        (void)c->createIdentity(1);
        bool refused = false;
        try {
            (void)c->prepareCall("bob@local", *offer); // журнал bob неизвестен → need
        } catch (const std::exception &) {
            refused = true;
        }
        check(refused, "prepareCall без журнала собеседника → need (как prepareDirect)");
    }

    // ── v1-устройства в переходный период (FR-054/FR-058) ──
    {
        auto c = v2::Client::create("alice@local", "d1", "local");
        (void)c->createIdentity(1);
        const auto before = c->logDevices("alice@local");
        check(!before.value("legacySet", true) && before.value("legacyKeys", json::array()).empty(),
              "legacy: до публикации списка v1-устройств нет");
        const std::string key(43, 'A'); // 32 нулевых байта в base64 без дополнения
        const auto req = c->legacyDevicesRequest(json::array({json{{"deviceId", "old"}, {"identity", key}, {"signing", key}}}));
        check(req.value("method", "") == "identity.device.log_append", "legacy: список v1-устройств → identity.device.log_append");
        check(!c->logDevices("alice@local").value("legacySet", true),
              "legacy: свой журнал не меняется до подтверждения сервера");
        bool refused = false;
        try {
            (void)c->legacyDevicesRequest(json::array({json{{"deviceId", "old"}, {"identity", "!"}, {"signing", key}}}));
        } catch (const std::exception &) {
            refused = true;
        }
        check(refused, "legacy: кривой ключ устройства отклонён");
        const auto deliver = c->legacyDeliverRequest("0199b6a0-0000-7000-8000-000000000001", R"({"to":"bob@local"})");
        check(deliver.value("method", "") == "msg.deliver_legacy", "legacy: копии v1-устройствам → msg.deliver_legacy");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
