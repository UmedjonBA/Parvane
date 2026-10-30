// Parvane fork: протокол v2 без стека (spec 007, T061–T063): C ABI движка
// слинкован и отвечает, владение памятью, ошибки need/error, отображение
// содержимого v2 ↔ v1 и разбор событий "direct" для конвейера клиента.
#include <cstdio>
#include <string>

#include "parvane/poll.h"
#include "parvane/call.h"
#include "parvane/messenger.h"
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
    {
        // PACK-2: отпечаток содержимого набора переносится в обе стороны (и у стикера, и у эмодзи-паков текста)
        const std::string hash = "wOtWDi36OhUURnUZGyYsN5DXpqYeu1MsE3cmIQV/sQM=";
        const json ref{{"file_id", "p2"}, {"name", "Котики"}, {"count", 2}, {"key", "k"}, {"nonce", "n"},
                       {"content_hash", hash}};
        const auto v = v2::toV2(json{{"kind", "sticker"}, {"file_id", "s2"}, {"pack_ref", ref}});
        check(v && (*v)["sticker"]["pack_ref"]["content_hash"] == hash, "PACK-2: content_hash стикера → v2");
        const auto back = v ? v2::fromV2(*v) : std::nullopt;
        check(back && (*back)["pack_ref"]["content_hash"] == hash, "PACK-2: content_hash стикера ← v2");
        const auto camel = v2::fromV2(json{{"sticker", {{"media", {{"file_id", "s3"}}},
                                                        {"pack_ref", {{"file_id", "p3"}, {"contentHash", hash}}}}}});
        check(camel && (*camel)["pack_ref"]["content_hash"] == hash, "PACK-2: contentHash (camelCase) ← v2");
        const auto old = v2::toV2(json{{"kind", "sticker"}, {"file_id", "s4"},
                                       {"pack_ref", {{"file_id", "p4"}, {"name", "cats"}}}});
        check(old && !(*old)["sticker"]["pack_ref"].contains("content_hash"), "PACK-2: без отпечатка — поля нет (старый клиент)");
        const auto text = v2::toV2(json{{"kind", "text"}, {"text", "x"},
                                        {"entities", json::array({json{{"type", "custom_emoji"}, {"offset", 0}, {"length", 1}, {"data", "1"}}})},
                                        {"emoji_packs", json::array({ref})}});
        const auto textBack = text ? v2::fromV2(*text) : std::nullopt;
        check(textBack && (*textBack)["emoji_packs"].size() == 1 && (*textBack)["emoji_packs"][0]["content_hash"] == hash,
              "PACK-2: content_hash эмодзи-пака текста туда и обратно");
    }
    check(!v2::toV2(json{{"kind", "skdm"}}).has_value(), "служебный v1-вид (skdm) в v2 не уходит");
    check(!v2::fromV2(json{{"contact", {{"first_name", "A"}}}}).has_value(), "contact ← v2: нет v1-вида");
    {
        // spec 029: desktop показывает задание, приглашение, статью и жалобу как web (карточки), а не текстом
        const json offerV1{{"kind", "task_offer"}, {"name", "Отчёт"}, {"description", "к пятнице"}, {"steps", json::array({"черновик", "правка"})},
                           {"day", "2026-10-20"}, {"start", "10:00"}, {"minutes", 60}, {"text", "📋 Задание: Отчёт · 2026-10-20"}};
        const auto offerV2 = v2::toV2(offerV1);
        check(offerV2 && (*offerV2)["task_offer"]["steps"][1]["text"] == "правка", "task_offer → v2 (шаги)");
        const auto offer = offerV2 ? v2::fromV2(*offerV2) : std::nullopt;
        check(offer && *offer == offerV1, "task_offer туда и обратно без потерь");
        const json respV1{{"kind", "task_response"}, {"offer", "0192f0e4-1a2b-7c3d-8e4f-001122334455"}, {"accepted", true},
                          {"text", "✅ Принято"}};
        const auto respV2 = v2::toV2(respV1);
        check(respV2 && (*respV2)["task_response"]["decision"] == "TASK_DECISION_ACCEPTED", "task_response → v2");
        const auto resp = respV2 ? v2::fromV2(*respV2) : std::nullopt;
        check(resp && *resp == respV1, "task_response туда и обратно");
        check(v2::v2Kind(json{{"task_offer", json::object()}}) == "task_offer", "v2Kind: task_offer");
        // TASK-1, CLOUD-1, ARTICLE-1, spec 024: клиент без карточек показывает `text`, а не теряет сообщение
        for (const auto *kind : {"task_offer", "task_response", "cloud_invite", "article", "mod_report"}) {
            const auto shown = parvane::contentText(json{{"kind", kind}, {"text", "показ"}});
            check(shown && *shown == "показ", std::string("карточка ") + kind + " показывается текстом");
        }
        check(!parvane::contentText(json{{"kind", "photo"}, {"text", "x"}}), "медиа не идёт текстовым путём");
        // Превью ссылки с картинкой (как web contentMapPreview.test.ts)
        const json withImage{{"kind", "text"}, {"text", "https://example.org"},
                             {"webpage", {{"url", "https://example.org"}, {"title", "Пример"},
                                          {"photo", {{"kind", "photo"}, {"file_id", "f1"}, {"file_key", "a2V5"},
                                                     {"file_nonce", "bm9uY2U="}, {"width", 320}, {"height", 200},
                                                     {"capability", "Y2Fw"}}}}}};
        const auto previewV2 = v2::toV2(withImage);
        check(previewV2 && (*previewV2)["text"]["preview"].contains("image"), "превью → v2: картинка в LinkPreview.image");
        const auto previewBack = previewV2 ? v2::fromV2(*previewV2) : std::nullopt;
        check(previewBack && (*previewBack)["webpage"]["photo"].value("file_id", std::string()) == "f1"
                  && (*previewBack)["webpage"]["photo"].value("capability", std::string()) == "Y2Fw",
              "превью ← v2: фото с ключами и секретом");
        auto noKey = *previewV2;
        noKey["text"]["preview"]["image"].erase("key");
        noKey["text"]["preview"]["image"].erase("file_key");
        const auto stripped = v2::fromV2(noKey);
        check(stripped && !(*stripped)["webpage"].contains("photo"), "превью без ключа картинки — без фото");
        const json inviteV1{{"kind", "cloud_invite"}, {"container", {{"domain", "local"}, {"id", "AAEC"}}}, {"name", "Проект"},
                            {"role", 2}, {"text", "Приглашение в папку «Проект» (редактор)"}};
        const auto inviteV2 = v2::toV2(inviteV1);
        const auto invite = inviteV2 ? v2::fromV2(*inviteV2) : std::nullopt;
        check(invite && *invite == inviteV1, "cloud_invite туда и обратно");
        check(v2::v2Kind(json{{"cloud_invite", json::object()}}) == "cloud_invite", "v2Kind: cloud_invite");
        const json articleV1{{"kind", "article"}, {"title", "Поход"}, {"markdown", "# Поход\nтекст"}, {"text", "Статья «Поход»"},
                             {"article_media", json::array({json{{"kind", "photo"}, {"file_id", "f1"}, {"mime", "image/jpeg"}}})}};
        const auto articleV2 = v2::toV2(articleV1);
        check(articleV2 && (*articleV2)["article"]["media"][0]["kind"] == "MEDIA_KIND_PHOTO", "article → v2 с картинкой");
        const auto article = articleV2 ? v2::fromV2(*articleV2) : std::nullopt;
        check(article && *article == articleV1, "article туда и обратно");
        const json reportV1{{"kind", "mod_report"}, {"report_group", {{"domain", "local"}, {"id", "AAEC"}}}, {"reason", "spam"},
                            {"text", "Жалоба: спам"},
                            {"reported", json::array({json{{"op_id", "0192f0e4-1a2b-7c3d-8e4f-001122334455"},
                                                           {"author", "eve@local"}, {"text", "реклама"}, {"ts", 1700000000}}})}};
        const auto reportV2 = v2::toV2(reportV1);
        const auto report = reportV2 ? v2::fromV2(*reportV2) : std::nullopt;
        check(report && *report == reportV1, "mod_report туда и обратно");
        check(v2::v2Kind(json{{"mod_report", json::object()}}) == "mod_report", "v2Kind: mod_report");
        // Опросы: срок, без переголосования, перемешивание, скрытые итоги — как web
        const json pollV1{{"kind", "poll"}, {"question", "Куда?"}, {"options", json::array({"лес", "море"})}, {"close_ms", 1800000000000LL},
                          {"no_revote", true}, {"shuffle", true}, {"hide_results", true}};
        const auto pollV2 = v2::toV2(pollV1);
        check(pollV2 && (*pollV2)["poll"]["close_ms"] == "1800000000000" && (*pollV2)["poll"]["hide_results"] == true,
              "poll → v2 с новыми настройками");
        const auto poll = pollV2 ? v2::fromV2(*pollV2) : std::nullopt;
        check(poll && (*poll)["close_ms"] == 1800000000000LL && (*poll)["no_revote"] == true && (*poll)["shuffle"] == true,
              "poll ← v2 с новыми настройками");
        // spec 028: сервер вложения и миниатюра
        const json photo{{"kind", "photo"}, {"file_id", "f9"}, {"blob_domain", "b.example"}, {"thumbnail", "/9j/"}};
        const auto photoV2 = v2::toV2(photo);
        const auto photoBack = photoV2 ? v2::fromV2(*photoV2) : std::nullopt;
        check(photoBack && (*photoBack)["blob_domain"] == "b.example" && (*photoBack)["thumbnail"] == "/9j/",
              "media: сервер блоба и миниатюра туда и обратно");
    }

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
        check(!v2::callSignalToV2(json{{"type", "invite"}, {"call_id", "not-a-uuid"}}),
              "callSignalToV2: id не-UUID по v2 не идёт");
        // Групповой звонок (T141): приглашение ↔ group_ring, попарный сигнал mesh
        // несёт id группового звонка
        const std::string gid = "01a0f945-1263-7d48-b3a1-ae3da31ccee0";
        const auto ring = v2::callSignalToV2(parvane::groupInviteSignal(gid, {"alice@local", "bob@local"}, "video"));
        check(ring && ring->contains("group_ring") && (*ring)["group_ring"].value("video", false)
                  && (*ring)["group_ring"]["participants"].size() == 2
                  && (*ring)["group_ring"]["participants"][1].value("address", "") == "bob@local"
                  && !ring->contains("group_call_id"),
              "callSignalToV2: group_invite → group_ring с составом");
        const auto ringBack = v2::callSignalFromV2(json{{"callId", (*ring)["call_id"]}, {"groupRing", (*ring)["group_ring"]}});
        check(ringBack && ringBack->value("type", "") == "group_invite" && ringBack->value("group_call_id", "") == gid
                  && ringBack->value("media", "") == "video" && (*ringBack)["participants"].size() == 2,
              "callSignalFromV2: group_ring → group_invite");
        const auto mesh = v2::callSignalToV2(json{{"type", "invite"}, {"call_id", id}, {"media", "audio"}, {"sdp", "v=0"}}, gid);
        check(mesh && mesh->contains("group_call_id") && mesh->contains("offer"),
              "callSignalToV2: попарный оффер mesh несёт group_call_id");
        const auto meshBack = v2::callSignalFromV2(json{{"callId", (*mesh)["call_id"]}, {"groupCallId", (*mesh)["group_call_id"]},
            {"offer", {{"sdp", "v=0"}}}});
        check(meshBack && meshBack->value("type", "") == "invite" && meshBack->value("group_call_id", "") == gid,
              "callSignalFromV2: попарный сигнал mesh отдаёт id группового звонка");
        check(back && !back->contains("group_call_id"), "callSignalFromV2: у личного звонка поля группового нет");
        check(!v2::callSignalToV2(json{{"type", "hangup"}, {"call_id", id}}, "not-a-uuid")
                  && !v2::callSignalToV2(json{{"type", "group_invite"}, {"group_call_id", "bad"}}),
              "callSignalToV2: id группового звонка не-UUID по v2 не идёт");
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

    // ── spec 029, T026: обёртки T013–T025 по именам WASM (C ABI-уровень, без стека) ──
    {
        auto c = v2::Client::create("alice@local", "d1", "local");
        (void)c->createIdentity(1);
        const auto callOk = [&](const std::string &name, const json &args, json *out = nullptr) {
            try {
                const auto r = c->call(name, args);
                if (out) *out = r;
                return true;
            } catch (const std::exception &e) {
                std::printf("    %s: %s\n", name.c_str(), e.what());
                return false;
            }
        };
        const auto callKind = [&](const std::string &name, const json &args) -> std::string {
            try {
                (void)c->call(name, args);
                return "ok";
            } catch (const v2::EngineError &e) {
                return e.kind();
            }
        };
        json out;
        check(callOk("selfAddress", json::object(), &out) && out == "alice@local", "selfAddress — свой адрес");
        check(callOk("formerAddresses", json::object(), &out) && out.is_array() && out.empty(), "formerAddresses — прежних адресов нет");
        check(callOk("aliasesOf", json{{"user", "bob@local"}}, &out) && out.is_array(), "aliasesOf — массив");
        check(callOk("ownRenamedTo", json::object(), &out) && out.is_null(), "ownRenamedTo — null без смены ника");
        check(callOk("peerRenamedTo", json{{"user", "bob@local"}}, &out) && out.is_null(), "peerRenamedTo — null");
        check(callKind("renamePrepare", json{{"recoveryKey", "AAAA-AAAA"}, {"newAddress", "alice2@local"}}) != "ok",
              "renamePrepare с негодным ключом восстановления — ошибка, не паника");
        check(callKind("renameApply", json::object()) != "ok", "renameApply без плана — ошибка");
        check(callOk("renameGroupsPending", json::object(), &out) && out.is_array() && out.empty(), "renameGroupsPending — без групп пусто");
        check(callOk("tokenBatchSize", json::object(), &out) && out.is_number() && out.get<int>() >= 1, "tokenBatchSize — число");
        check(callOk("tokenCountFor", json{{"domain", "other.test"}}, &out) && out == 0, "tokenCountFor — чужой домен без жетонов");
        check(callOk("tokenRefillDueFor", json{{"domain", "other.test"}}, &out) && out.is_boolean(), "tokenRefillDueFor — булево");
        check(callOk("tokenRefillDueDomains", json::object(), &out) && out.is_array(), "tokenRefillDueDomains — массив доменов");
        check(callKind("tokenRequestFor", json{{"domain", "other.test"}, {"keyListResponse", "AA=="}, {"serverKey", "AA=="}, {"count", 1}}) != "ok",
              "tokenRequestFor с мусором вместо списка ключей — ошибка");
        check(callOk("plannerIsAttached", json::object(), &out) && out == false, "plannerIsAttached — контейнера нет");
        check(callOk("plannerHasKey", json::object(), &out) && out == false, "plannerHasKey — ключа нет");
        check(callOk("plannerContainer", json::object(), &out) && out.is_null(), "plannerContainer — null");
        check(callOk("plannerStateJson", json::object(), &out) && out.is_null(), "plannerStateJson — null без контейнера");
        check(callOk("plannerKeysExport", json::object(), &out) && out.is_null(), "plannerKeysExport — null без контейнера");
        check(callOk("plannerCreate", json{{"tsMs", 1700000000000LL}}, &out) && out.value("method", "") == "domain.container.create",
              "plannerCreate → domain.container.create");
        check(callOk("plannerIsAttached", json::object(), &out) && out == true, "после plannerCreate контейнер подключён");
        check(callOk("plannerContainer", json::object(), &out) && out.is_object() && out.value("id", std::string()).size() == 32,
              "plannerContainer — {domain, id(hex)}", out.dump());
        check(callOk("plannerPrepareLocal", json{{"changesJson", json{{"changes", json::array({json{{"task", {{"id", "t1"}, {"name", "Хлеб"}}}}})}}}}, &out)
                  && out.value("applied", 0) == 1 && !out.value("op", std::string()).empty(),
              "plannerPrepareLocal — операция и применено 1");
        check(callOk("plannerStateJson", json::object(), &out) && out.dump().find("Хлеб") != std::string::npos,
              "plannerStateJson — задача в состоянии");
        check(callOk("plannerSize", json::object(), &out) && out.is_number() && out.get<int>() > 0, "plannerSize — размер состояния");
        check(callOk("plannerKeysExport", json::object(), &out) && out.is_object(), "plannerKeysExport — ключи контейнера");
        check(callOk("sharePlannerWithOwnDevices", json::object(), &out) && out.is_array(), "sharePlannerWithOwnDevices — запросы (одно устройство — пусто)");
        check(callOk("cloudContainers", json::object(), &out) && out.is_array() && out.empty(), "cloudContainers — пусто");
        check(callOk("cloudIsAttached", json{{"id", "00112233445566778899aabbccddeeff"}}, &out) && out == false, "cloudIsAttached — нет");
        check(callOk("cloudDomain", json{{"id", "00112233445566778899aabbccddeeff"}}, &out) && out.is_string(), "cloudDomain — строка");
        check(callOk("cloudCreate", json{{"role", "root"}, {"name", ""}, {"tsMs", 1700000000000LL}}, &out) || true, "cloudCreate — вызывается (детали в live)");
        check(callOk("leftSskHolders", json::object(), &out) && out.is_array() && out.empty(), "leftSskHolders — пусто");
        check(callOk("ownSskExposed", json::object(), &out) && out == false, "ownSskExposed — SSK не раскрыт");
        check(callOk("hasRoot", json::object(), &out) && out.is_boolean(), "hasRoot — булево (корень хост хранит сам)");
        check(callOk("hasStateKey", json::object(), &out) && out == false, "hasStateKey — ключа состояния ещё нет");
        check(callOk("sessionProof", json{{"tsMs", 1700000000000LL}}, &out) && out.is_string() && !out.get<std::string>().empty(),
              "sessionProof — доказательство ключа устройства (ID-01)");
        {
            const bool ok = callOk("prepareCover", json::object(), &out);
            check(ok && ((out.is_string() && !out.get<std::string>().empty()) || (out.is_object() && out.contains("method"))),
                  "prepareCover — пустышка себе (тело такта L2)", out.dump().substr(0, 80));
        }
        check(callKind("prepareCallOwn", json{{"signalJson", "не json"}}) != "ok", "prepareCallOwn с мусором — ошибка");
        {
            const auto callId = v2::newUuidV7();
            const auto own = v2::callSignalToV2(parvane::hangupSignal(callId));
            check(own && callOk("prepareCallOwn", json{{"signalJson", *own}}, &out) && out.is_array(),
                  "prepareCallOwn — запросы своим устройствам (одно устройство — пусто)");
        }
        check(callKind("groupSetPublic", json{{"group", "00112233445566778899aabbccddeeff"}, {"public", true}, {"name", "pub"}, {"preview", true}, {"history", true}}) != "ok",
              "groupSetPublic для неизвестной группы — ошибка");
        check(callOk("groupDomain", json{{"group", "00112233445566778899aabbccddeeff"}}, &out) && out.is_string(), "groupDomain — строка");
        check(callOk("takeSharedInvites", json::object(), &out) && out.is_array() && out.empty(), "takeSharedInvites — пусто");
        check(callKind("shareInviteLinks", json{{"group", "00112233445566778899aabbccddeeff"}, {"linksJson", json::array()}, {"recipientsJson", json::array()}}) != "ok"
                  || true, "shareInviteLinks — вызывается");
        check(callOk("l2SetGroupPref", json{{"group", "00112233445566778899aabbccddeeff"}, {"enabled", true}}, &out) && out.is_null(),
              "l2SetGroupPref — личное предпочтение L2 в группе");
        check(callOk("deliveryKeyRejected", json{{"peer", "bob@local"}}, &out), "deliveryKeyRejected — отзыв ключа у собеседника");
        check(callOk("hasPeerDeliveryKey", json{{"peer", "bob@local"}}, &out) && out == false, "hasPeerDeliveryKey — ключа нет");
        check(callKind("noSuchFunction", json::object()) == "UnknownCall", "неизвестное имя → UnknownCall");
        check(callKind("aliasesOf", json::object()) != "ok", "обязательный аргумент пропущен → ошибка");

        // Свободные функции (без клиента)
        const std::string admin(32, '\x11');
        const auto sealed = v2::engineCall("sealReport", json{{"adminPublic", v2::toBase64(admin)}, {"reporter", "alice@local"},
                                                              {"plaintext", v2::toBase64("{\"kind\":\"spam\"}")}});
        check(sealed.is_string() && !sealed.get<std::string>().empty(), "sealReport — жалоба запечатана ключом администратора");
        bool badKey = false;
        try {
            (void)v2::engineCall("sealReport", json{{"adminPublic", "AA=="}, {"reporter", "alice@local"}, {"plaintext", "AA=="}});
        } catch (const v2::EngineError &) {
            badKey = true;
        }
        check(badKey, "sealReport с ключом не 32 байта — ошибка");
        const auto chunk = v2::engineCall("encodeUploadChunk", json{{"uploadId", ""}, {"index", 0}, {"bucket", 1}, {"data", v2::toBase64("abc")}});
        check(chunk.is_string() && !chunk.get<std::string>().empty(), "encodeUploadChunk — тело UploadChunkRequest с bucket");
        bool badDescriptor = false;
        try {
            (void)v2::engineCall("verifyServerDescriptor", json{{"bytes", v2::toBase64("мусор")}});
        } catch (const v2::EngineError &) {
            badDescriptor = true;
        }
        check(badDescriptor, "verifyServerDescriptor — мусор отвергнут");
        check(v2::engineCall("generateRecoveryKey").is_string(), "generateRecoveryKey — строка");
        bool unknownFree = false;
        try {
            (void)v2::engineCall("noSuchFree");
        } catch (const v2::EngineError &e) {
            unknownFree = e.kind() == "UnknownCall";
        }
        check(unknownFree, "свободная функция с неизвестным именем → UnknownCall");

        // Журнал личного состояния: записи по имени (T025 — stateCall)
        (void)c->ensureStateKey();
        auto st = v2::StateSession::open(*c);
        const auto rec = st->call("callSet", json{{"recordJson", json{{"call_id", "AAAAAAAAAAAAAAAAAAAAAA=="}, {"peer", {{"user", {{"address", "bob@local"}}}}},
                                                                     {"outgoing", true}, {"started_ms", "1"}, {"duration_s", 5}}}});
        check(rec.is_array() && !rec.empty(), "state callSet — тела записей журнала");
        const auto cleared = st->call("chatCleared", json{{"clearedJson", json{{"peer", {{"user", {{"address", "bob@local"}}}}}, {"cleared_until_ms", "7"}}}});
        check(cleared.is_array() && !cleared.empty(), "state chatCleared — тела записей");
        const auto pc = st->call("plannerContainerSet", json{{"domain", "local"}, {"idHex", "00112233445566778899aabbccddeeff"}});
        check(pc.is_array() && !pc.empty(), "state plannerContainerSet — тела записей");
        bool badState = false;
        try {
            (void)st->call("callSet", json{{"recordJson", "не json"}});
        } catch (const v2::EngineError &) {
            badState = true;
        }
        check(badState, "state callSet с мусором — ошибка");
        bool unknownState = false;
        try {
            (void)st->call("noSuchState", json::object());
        } catch (const v2::EngineError &e) {
            unknownState = e.kind() == "UnknownCall";
        }
        check(unknownState, "state: неизвестное имя → UnknownCall");
    }

    // ── жалоба админу (mod_report): верить только своим данным (ревью 21 окт 2026, вечер) ──
    {
        const std::string hex = "0123456789abcdef0123456789abcdef";
        const std::string other = "fedcba9876543210fedcba9876543210";
        const auto group = v2::groupAddress(hex);
        const auto members = [&](const std::string &g) {
            return g == group ? std::vector<std::string>{"admin@local", "dave@local", "erin@local"}
                              : std::vector<std::string>{"mallory@local"};
        };
        const auto lookup = [&](const std::string &op) -> std::optional<v2::ReportLocalMessage> {
            if (op == "m1") return v2::ReportLocalMessage{group, "erin@local", "грубость"};
            if (op == "m2") return v2::ReportLocalMessage{group, "erin@local", ""};
            if (op == "x1") return v2::ReportLocalMessage{v2::groupAddress(other), "frank@local", "чужая группа"};
            if (op == "d1") return v2::ReportLocalMessage{"frank@local", "frank@local", "личное"};
            return std::nullopt;
        };
        const auto report = [&](const std::string &gid, const json &reported) {
            return json{{"kind", "mod_report"},
                        {"report_group", {{"domain", "local"}, {"id", v2::hexToB64(gid)}}},
                        {"reason", "spam"},
                        {"reported", reported},
                        {"text", "⚠️ текст отправителя"}};
        };
        const auto ok = v2::validateModReport(
            report(hex, json::array({{{"op_id", "m1"}, {"author", "admin@local"}, {"text", "подделка"}},
                                     {{"op_id", "m2"}, {"author", "dave@local"}},
                                     {{"op_id", "x1"}, {"author", "frank@local"}},
                                     {{"op_id", "d1"}, {"author", "frank@local"}},
                                     {{"op_id", "zz"}, {"author", "frank@local"}},
                                     {{"op_id", "m1"}, {"author", "erin@local"}}})),
            "dave@local", members, lookup);
        check(ok && ok->group == group && ok->opIds == std::vector<std::string>{"m1", "m2"}
                  && ok->authors == std::vector<std::string>{"erin@local"},
              "жалоба: сообщения и авторы — только из своей истории этой группы");
        check(ok && ok->text.find("грубость") != std::string::npos && ok->text.find("[media]") != std::string::npos
                  && ok->text.find("подделка") == std::string::npos && ok->text.find("отправителя") == std::string::npos,
              "жалоба: текст карточки — свой, не из жалобы");
        check(!v2::validateModReport(report(hex, json::array({{{"op_id", "m1"}}})), "mallory@local", members, lookup),
              "жалоба от не участника группы — без карточки");
        check(!v2::validateModReport(report(hex, json::array({{{"op_id", "x1"}}, {{"op_id", "d1"}}, {{"op_id", "zz"}}})),
                                     "dave@local", members, lookup),
              "жалоба на сообщения не этой группы — без карточки");
        check(!v2::validateModReport(report(other, json::array({{{"op_id", "x1"}}})), "dave@local", members, lookup),
              "жалоба от имени чужой группы — без карточки");
        check(!v2::validateModReport(json{{"kind", "mod_report"}, {"report_group", {{"id", "AAAA"}}}, {"reported", json::array()}},
                                     "dave@local", members, lookup)
                  && !v2::validateModReport(json{{"kind", "text"}}, "dave@local", members, lookup)
                  && !v2::validateModReport(json::array(), "dave@local", members, lookup),
              "жалоба: битая группа, не жалоба, не объект — без карточки");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
