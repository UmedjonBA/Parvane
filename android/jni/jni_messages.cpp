// Parvane Android (spec 031): переписка по v2 — отправка, медиа по секрету (CAP-1), мутации, прочтения,
// «печатает», пересылка, наборы стикеров (PACK-1/2), превью ссылок и тайлы карты (MAP-1).
#include "jni_internal.h"

#include <parvane/blobcrypt.h>
#include <parvane/chat_rules.h>
#include <parvane/history_sync.h>
#include <parvane/messenger.h>
#include <parvane/pack_archive.h>
#include <parvane/storecrypt.h>

#include <openssl/rand.h>
#include <openssl/sha.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <functional>
#include <fstream>
#include <thread>

namespace pvjni {

namespace {

// Отправить v1-содержимое (вид клиента) по v2 → id. Бросает (сессия не готова, вид не поддержан, отказ).
std::string sendV2(const std::string &to, const json &content, const std::string &replyTo,
                   const std::string &presetId = std::string()) {
    const auto s = v2ReadyForSend();
    if (!s) {
        if (v2NeedsLinking()) throw parvane::v2::V2Error("ERROR_CODE_NOT_LINKED");
        throw std::runtime_error("сессия v2 не готова");
    }
    const auto mapped = parvane::v2::toV2(content, replyTo);
    if (!mapped) throw std::runtime_error("вид " + parvane::contentKind(content) + " не поддержан v2");
    const auto id = presetId.empty() ? parvane::v2::newUuidV7() : presetId;
    s->sendContent(to, *mapped, id);
    return id;
}

// Своё отправленное → строка журнала истории (≤ 300 мс, сдвигает маркер чата) и событие шва (эхо движок своим не
// отдаёт).
void emitOwn(const std::string &id, const std::string &to, const json &content, const std::string &replyTo) {
    (void)markSeen(id);
    noteMessage(id, self(), to, content);
    const auto ms = nowMs();
    auto ev = json{{"type", "message"}, {"id", id}, {"from", self()}, {"to", to}, {"ts", ms / 1000},
                   {"text", textOrCaption(content)}, {"out", true},
                   {"kind", parvane::contentKind(content)}, {"read", false}, {"content", content},
                   {"reply_to", replyTo.empty() ? json() : json(replyTo)}, {"group", isGroupAddress(to)}, {"proto", 2}};
    (void)historyRecordMessageEvent(ev, /*own=*/true, ms);
    emit(ev);
}

// Своя правка/реакция/закреп → операция журнала истории с тем же op_id, что и мутация v2 собеседнику: свои
// устройства, получившие копию из инбокса, узнают её в журнале и не пишут второй раз.
void recordOwnMutation(const std::string &uuid, const std::string &opId,
                       const std::function<json(const json &peer, const json &stamp)> &build) {
    std::string chat;
    if (const auto st = historyState(uuid)) chat = parvane::v2::Session::historyAddress(st->value("chat", json()));
    if (chat.empty()) if (const auto row = messageRow(uuid)) chat = row->chat;
    const auto peer = historyPeerOf(chat);
    if (peer.is_null()) return;
    try {
        (void)historyRecordOwnOp(build(peer, parvane::history::stampOf(nowMs(), opId)));
    } catch (const std::exception &e) {
        LOGE("журнал истории: своя мутация %s не записана: %s", uuid.c_str(), e.what());
    }
}

// Мутация сообщения (правка/удаление/реакция/закреп) — содержимым v2 в чат сообщения, в фоне.
bool mutate(const std::string &uuid, const json &content, const std::string &opId = parvane::v2::newUuidV7()) {
    const auto row = messageRow(uuid);
    if (!row || row->chat.empty()) return false;
    runDetached([chat = row->chat, content, uuid, opId] {
        const auto s = v2ReadyForSend();
        if (!s) { LOGE("v2: мутация %s не отправлена — сессия не готова", uuid.c_str()); return; }
        try {
            s->sendContent(chat, content, opId);
            LOGI("v2 → %s для %s", parvane::v2::v2Kind(content).c_str(), uuid.c_str());
        } catch (const std::exception &e) {
            LOGE("v2: мутация %s не отправлена: %s", uuid.c_str(), e.what());
        }
    });
    return true;
}

std::string random32() {
    std::string s(32, '\0');
    if (RAND_bytes(reinterpret_cast<unsigned char *>(s.data()), 32) != 1) throw std::runtime_error("rand");
    return s;
}

// Шифртекст блоба вложения чата — по секрету (CAP-1): секрет едет внутри E2E-содержимого.
std::string uploadChatBlob(const std::string &ciphertext, json &target) {
    const auto s = v2ReadyForSend();
    if (!s) throw std::runtime_error("сессия v2 не готова — блоб не загружен");
    const auto capability = random32();
    const auto fileId = s->uploadBlob(ciphertext, capability);
    if (fileId.empty()) throw std::runtime_error("блоб не загрузился");
    target["capability"] = parvane::v2::toBase64(capability);
    rememberBlobCap(fileId, target["capability"].get<std::string>());
    return fileId;
}

// PACK-2: «<имя> <6 hex отпечатка>» — как desktop DistinctPackName.
std::string hashTag(const std::string &hashB64) {
    static const char *hex = "0123456789abcdef";
    const auto raw = parvane::v2::fromBase64Safe(hashB64).value_or(std::string());
    std::string out;
    for (std::size_t i = 0; i < raw.size() && out.size() < 6; ++i) {
        out.push_back(hex[(static_cast<unsigned char>(raw[i]) >> 4) & 0xF]);
        out.push_back(hex[static_cast<unsigned char>(raw[i]) & 0xF]);
    }
    return out.substr(0, 6);
}

std::string readFileBytes(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

// Отпечаток содержимого каталога набора ("" — пусто): те же записи, что уходят в архив PVPK1.
std::string packDirHash(const std::string &dir) {
    std::vector<parvane::pack::Entry> entries;
    std::error_code ec;
    for (const auto &e : std::filesystem::directory_iterator(dir, ec))
        if (e.is_regular_file() && parvane::pack::isAllowedExtension(e.path().filename().string()))
            entries.push_back({e.path().filename().string(), readFileBytes(e.path().string())});
    return entries.empty() ? std::string() : parvane::pack::archiveContentHashB64(parvane::pack::build(entries));
}

// PACK-2 (как desktop FindInstalledPackByHash): установленный набор с тем же отпечатком под любым именем.
std::string findInstalledPackByHash(const std::string &root, const std::string &hashB64) {
    if (hashB64.empty()) return {};
    std::error_code ec;
    std::vector<std::filesystem::path> dirs;
    for (const auto &e : std::filesystem::directory_iterator(root, ec)) if (e.is_directory()) dirs.push_back(e.path());
    std::sort(dirs.begin(), dirs.end());
    for (const auto &d : dirs) if (packDirHash(d.string()) == hashB64) return d.string();
    return {};
}

} // namespace

// Медиа: байты → blobcrypt → блоб по секрету → содержимое с file_id/file_key/file_nonce/capability → v2.
// Расшифрованная копия — в кэш (X покажет сразу). "" — ошибка (в логе).
std::string sendMediaBytes(const std::string &to, const std::string &plain, json content, const std::string &reply) {
    try {
        auto enc = parvane::blobcrypt::encrypt(plain);
        if (enc.ciphertext.empty()) throw std::runtime_error("blobcrypt");
        const auto fileId = uploadChatBlob(enc.ciphertext, content);
        content["file_id"] = fileId;
        content["size_bytes"] = plain.size();
        content["file_key"] = enc.keyB64;
        content["file_nonce"] = enc.nonceB64;
        content.erase("local_path");
        const auto id = sendV2(to, content, reply);
        writeMediaCache(fileId, plain);
        auto shown = content;
        shown["local_path"] = mediaWorkCopy(fileId, plain);
        emitOwn(id, to, shown, reply);
        LOGI("отправлено медиа %s", id.c_str());
        return id;
    } catch (const std::exception &e) {
        LOGE("sendMedia: %s", e.what());
        noteFederationFailure(e.what());
        emit(json{{"type", "send_failed"}, {"to", to}, {"error_code", errorCodeOf(e)}});
        return {};
    }
}

} // namespace pvjni

using namespace pvjni;

extern "C" {

// Содержимое любого вида (текст с ответом, опрос, геопозиция, карточки разделов, стикер по ссылке на пак).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSendContent(
        JNIEnv *env, jclass, jstring to, jstring contentJson, jstring replyTo) {
    const auto toStd = jstr(env, to);
    const auto reply = jstr(env, replyTo);
    try {
        const auto content = json::parse(jstr(env, contentJson), nullptr, false);
        if (!content.is_object()) throw std::runtime_error("битый content");
        const auto id = sendV2(toStd, content, reply);
        emitOwn(id, toStd, content, reply);
        LOGI("отправлено msg %s (%s)", id.c_str(), parvane::contentKind(content).c_str());
        return jout(env, id);
    } catch (const std::exception &e) {
        LOGE("sendContent: %s", e.what());
        noteFederationFailure(e.what());
        emit(json{{"type", "send_failed"}, {"to", toStd}, {"error_code", errorCodeOf(e)}});
        return jout(env, "");
    }
}

// content — {kind, mime, width, height, duration_secs, filename, caption[, forwarded_name, ttl_secs]}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSendMedia(
        JNIEnv *env, jclass, jstring to, jstring path, jstring contentJson, jstring replyTo) {
    try {
        const auto pathStd = jstr(env, path);
        auto content = json::parse(jstr(env, contentJson), nullptr, false);
        const auto plain = readFileBytes(pathStd);
        if (!content.is_object() || plain.empty()) {
            LOGE("sendMedia: битый content или файл не читается");
            return jout(env, "");
        }
        return jout(env, sendMediaBytes(jstr(env, to), plain, content, jstr(env, replyTo)));
    } catch (const std::exception &e) {
        LOGE("nativeSendMedia: %s", e.what());
        return jout(env, "");
    }
}

// Пересылка в несколько чатов (как desktop MirrorForward): текст — тот же content; медиа — блоб из кэша или
// сети, перезаливается новым секретом для каждого получателя. → JSON {адрес: новый id | ""}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeForward(JNIEnv *env, jclass, jstring toJson, jstring uuid) {
    const auto id = jstr(env, uuid);
    auto targets = json::parse(jstr(env, toJson), nullptr, false);
    if (targets.is_string()) targets = json::array({targets});
    json out = json::object();
    const auto row = messageRow(id);
    if (!row || !targets.is_array()) {
        LOGE("forward: %s неизвестно", id.c_str());
        return jreply(env, out);
    }
    auto content = row->content;
    content.erase("local_path");
    if (!row->from.empty() && row->from != self()) content["forwarded_name"] = row->from.substr(0, row->from.find('@'));
    std::string plain;
    const auto fid = content.value("file_id", std::string());
    if (!fid.empty()) {
        if (const auto cached = readMediaCache(fid)) {
            plain = *cached;
        } else {
            const auto cap = parvane::chatrules::chatBlobCipherCap(parvane::contentKind(content), content.value("size_bytes", std::uint64_t(0)));
            const auto d = downloadChatBlob(fid, cap);
            if (!d.ok) { LOGE("forward %s: блоб: %s", id.c_str(), d.error.c_str()); return jreply(env, out); }
            const auto dec = parvane::blobcrypt::decrypt(d.bytes, content.value("file_key", std::string()), content.value("file_nonce", std::string()));
            if (!dec) { LOGE("forward %s: блоб не расшифровался", id.c_str()); return jreply(env, out); }
            plain = *dec;
        }
        for (const char *k : {"file_id", "file_key", "file_nonce", "size_bytes", "capability"}) content.erase(k);
    }
    for (const auto &t : targets) {
        if (!t.is_string()) continue;
        const auto to = t.get<std::string>();
        if (!plain.empty()) {
            out[to] = sendMediaBytes(to, plain, content, std::string());
            continue;
        }
        try {
            const auto nid = sendV2(to, content, std::string());
            emitOwn(nid, to, content, std::string());
            out[to] = nid;
        } catch (const std::exception &e) {
            LOGE("forward → чат: %s", e.what());
            out[to] = "";
        }
    }
    LOGI("переслано %s в %zu чатов", id.c_str(), targets.size());
    return jreply(env, out);
}

// Скачать вложение (кэш под storecrypt, иначе сеть) → путь открытой рабочей копии ("" — ошибка).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeDownloadFile(
        JNIEnv *env, jclass, jstring fileId, jstring key, jstring nonce, jstring kind, jlong sizeBytes) {
    const auto fid = jstr(env, fileId);
    if (!isSafeFileId(fid)) { LOGE("downloadFile: недопустимый file_id"); return jout(env, ""); } // NAT-04
    if (const auto cached = readMediaCache(fid)) return jout(env, mediaWorkCopy(fid, *cached));
    // Фото частной группы (A0089-5, GPHOTO-1): в `key` — секрет из журнала группы (base64), ключи PVB2 и capability
    // выводит ядро; расшифрованное кладётся в кэш как обычный аватар
    if (jstr(env, kind) == "group_photo") {
        const auto s = v2Ready();
        const auto plain = s ? s->downloadGroupPhoto(fid, jstr(env, key)) : std::nullopt;
        if (!plain) { LOGE("downloadFile %s: фото группы не получено", fid.c_str()); return jout(env, ""); }
        writeMediaCache(fid, *plain);
        return jout(env, mediaWorkCopy(fid, *plain));
    }
    const auto k = jstr(env, key), n = jstr(env, nonce);
    const auto cap = parvane::chatrules::chatBlobCipherCap(jstr(env, kind), std::uint64_t(std::max<jlong>(sizeBytes, 0)));
    const auto d = downloadChatBlob(fid, cap);
    if (!d.ok) { LOGE("downloadFile %s: %s", fid.c_str(), d.error.c_str()); return jout(env, ""); }
    std::string bytes = d.bytes;
    if (!k.empty()) {
        const auto dec = parvane::blobcrypt::decrypt(d.bytes, k, n);
        if (!dec) { LOGE("downloadFile %s: не расшифровался", fid.c_str()); return jout(env, ""); }
        bytes = *dec;
    }
    writeMediaCache(fid, bytes);
    LOGI("файл %s скачан (%zu байт)", fid.c_str(), bytes.size());
    return jout(env, mediaWorkCopy(fid, bytes));
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeSendTyping(JNIEnv *env, jclass, jstring to) {
    const auto chat = jstr(env, to);
    if (l2Active(chat)) return; // L2-1
    runDetached([chat] {
        if (const auto s = v2Ready()) {
            try { (void)s->sendTyping(chat); } catch (const std::exception &) {}
        }
    });
}

// Присутствие собеседников (их «в сети» и «печатает»): подписка на эфемерные каналы.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeWatchPeers(JNIEnv *env, jclass, jstring peersJson) {
    const auto arr = json::parse(jstr(env, peersJson), nullptr, false);
    std::vector<std::string> peers;
    if (arr.is_array()) for (const auto &p : arr) if (p.is_string() && !l2Active(p.get<std::string>())) peers.push_back(p);
    if (peers.empty()) return;
    runDetached([peers] {
        if (const auto s = v2ReadyForSend()) {
            try { s->watchPeers(peers); } catch (const std::exception &) {}
        }
    });
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeEdit(JNIEnv *env, jclass, jstring uuid, jstring contentJson) {
    try {
        const auto id = jstr(env, uuid);
        const auto content = json::parse(jstr(env, contentJson), nullptr, false);
        const auto row = messageRow(id);
        if (!row || !content.is_object() || row->from != self()) return JNI_FALSE;
        auto edit = json{{"target", parvane::v2::ref(id)}};
        if (parvane::contentKind(content) == "location") {
            if (const auto m = parvane::v2::toV2(content)) edit["location"] = (*m)["location"];
        } else {
            const auto text = parvane::contentKind(content) == "text" ? strOf(content, "text")
                                                                      : strOf(content, "caption");
            if (const auto m = parvane::v2::toV2(parvane::textContent(text, parvane::contentEntities(content)))) edit["text"] = (*m)["text"];
        }
        updateMessageContent(id, content);
        const auto opId = parvane::v2::newUuidV7();
        if (!mutate(id, json{{"edit", edit}}, opId)) return JNI_FALSE;
        recordOwnMutation(id, opId, [&](const json &peer, const json &stamp) {
            auto stored = content;
            stored.erase("local_path");
            return parvane::history::editOp(id, peer, stamp, json{{"content", stored}}, self());
        });
        emit(json{{"type", "edited"}, {"id", id}, {"content", content}, {"edit_date", nowSec()}});
        return JNI_TRUE;
    } catch (const std::exception &e) {
        LOGE("nativeEdit: %s", e.what());
        return JNI_FALSE;
    }
}

// Удаление (HIST-1): «у всех» — по праву движка (личный чат — любое сообщение, как Telegram; группа — своё либо
// админу с правом) мутация v2 собеседнику и надгробие everyone в журнале; «только у меня» — только надгробие me в
// журнале истории (собеседнику ничего, на всех своих устройствах сообщения нет).
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeDelete(JNIEnv *env, jclass, jstring uuid, jboolean forEveryone) {
    const auto id = jstr(env, uuid);
    std::string chat;
    bool everyone = false;
    if (!historyDelete(id, forEveryone == JNI_TRUE, &chat, &everyone)) return JNI_FALSE;
    const auto opId = parvane::v2::newUuidV7();
    if (everyone) (void)mutate(id, json{{"delete", {{"targets", json::array({parvane::v2::ref(id)})}, {"for_everyone", true}}}}, opId);
    forgetMessage(id);
    emit(json{{"type", "deleted"}, {"id", id}});
    historyRecordDelete(id, chat, everyone, opId);
    LOGI("удаление msg %s — %s", id.c_str(), everyone ? "у всех" : "только у меня");
    return JNI_TRUE;
}

// Реакция: повтор той же — снять; пустая — снять свою.
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativeReact(JNIEnv *env, jclass, jstring uuid, jstring emoji) {
    const auto id = jstr(env, uuid), em = jstr(env, emoji);
    const bool remove = em.empty() || ownReactionOf(id) == em;
    const auto opId = parvane::v2::newUuidV7();
    if (!mutate(id, json{{"reaction", {{"target", parvane::v2::ref(id)}, {"emoji", remove ? std::string() : em}, {"remove", remove}}}}, opId))
        return JNI_FALSE;
    recordOwnMutation(id, opId, [&](const json &peer, const json &stamp) {
        return parvane::history::reactOp(id, peer, self(), stamp, remove ? std::string() : em);
    });
    emit(metaEvent(id, std::make_pair(self(), remove ? std::string() : em), std::nullopt));
    return JNI_TRUE;
}

JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneCore_nativePin(JNIEnv *env, jclass, jstring uuid, jboolean pinned) {
    const auto id = jstr(env, uuid);
    const auto opId = parvane::v2::newUuidV7();
    if (!mutate(id, json{{"pin", {{"target", parvane::v2::ref(id)}, {"unpin", pinned != JNI_TRUE}}}}, opId)) return JNI_FALSE;
    recordOwnMutation(id, opId, [&](const json &peer, const json &stamp) {
        return parvane::history::pinOp(id, peer, stamp, pinned == JNI_TRUE);
    });
    emit(metaEvent(id, std::nullopt, pinned == JNI_TRUE));
    return JNI_TRUE;
}

// READ-2 / READ-1: показанные сообщения прочитаны — маркер «прочитано до» чата сдвигается (в журнал истории ≤ 1 с,
// другие свои устройства обнуляют счётчик), квитанции READ авторам — только о ставших прочитанными, с повтором.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeMarkRead(JNIEnv *env, jclass, jstring idsJson) {
    const auto arr = json::parse(jstr(env, idsJson), nullptr, false);
    std::vector<std::string> ids;
    if (arr.is_array()) for (const auto &v : arr) if (v.is_string()) ids.push_back(v.get<std::string>());
    try {
        historyMarkRead(ids);
    } catch (const std::exception &e) {
        LOGE("nativeMarkRead: %s", e.what());
    }
}

// TTL: забыть сообщение — строку в памяти, кэш медиа и рабочую копию.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeForget(JNIEnv *env, jclass, jstring uuidJ, jstring fileIdJ) {
    const auto uuid = jstr(env, uuidJ), fid = jstr(env, fileIdJ);
    forgetMessage(uuid);
    historyForget(uuid);
    if (isSafeFileId(fid)) {
        std::error_code ec;
        std::filesystem::remove(storeDir() + "/media-cache/" + fid, ec);
        if (const auto dir = tempDir("media"); !dir.empty()) std::filesystem::remove(dir + "/" + fid, ec);
    }
}

// «Удалить чат у себя» (T145): граница очистки — в журнал личного состояния; локально сообщения чата прочь.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeClearChat(JNIEnv *env, jclass, jstring address, jlong untilMs, jstring idsJson) {
    const auto chat = jstr(env, address);
    std::set<std::string> ids;
    const auto arr = json::parse(jstr(env, idsJson), nullptr, false);
    if (arr.is_array()) for (const auto &v : arr) if (v.is_string()) ids.insert(v.get<std::string>());
    for (const auto &id : ids) forgetMessage(id);
    historyClearChat(chat, static_cast<std::int64_t>(untilMs), ids);
    runDetached([chat, untilMs] {
        if (const auto s = v2ReadyForSend()) {
            try { s->stateChatCleared(chat, static_cast<std::int64_t>(untilMs)); } catch (const std::exception &e) { LOGE("очистка чата: %s", e.what()); }
        }
    });
}

// Очистка чата «у себя», пришедшая журналом личного состояния с другого своего устройства: строки — прочь из
// хранилища истории и не принимаются из журнала (граница ChatCleared).
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneCore_nativeClearChatLocal(JNIEnv *env, jclass, jstring address, jlong untilMs) {
    const auto chat = jstr(env, address);
    historyClearChat(chat, static_cast<std::int64_t>(untilMs), {});
}

// ── наборы стикеров PVPK1 (PACK-1/2), превью, карта ──────────────────────────

// Скачать архив пака по ссылке провода и распаковать в packs/<имя>/ (+ .pvname). PACK-2: тот же отпечаток —
// тот же набор; имя занято другим набором — «<имя> <6 hex>». → {"ok","dir","files":[{name,size}],"error"}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePackFetch(JNIEnv *env, jclass, jstring refJson) {
    json out{{"ok", false}};
    try {
        const auto ref = json::parse(jstr(env, refJson), nullptr, false);
        if (!ref.is_object()) throw std::runtime_error("битая ссылка пака");
        rememberBlobCaps(ref);
        const auto fid = ref.value("file_id", std::string());
        const auto raw = ref.value("name", std::string("Pack"));
        const auto root = storeDir() + "/packs";
        auto dir = root + "/" + parvane::pack::sanitizeName(raw);
        std::error_code ec;
        const auto listFiles = [&](const std::string &d) {
            auto files = json::array();
            for (const auto &e : std::filesystem::directory_iterator(d, ec))
                if (e.is_regular_file() && parvane::pack::isAllowedExtension(e.path().filename().string()))
                    files.push_back({{"name", e.path().filename().string()}, {"size", e.file_size()}});
            return files;
        };
        auto files = std::filesystem::is_directory(dir, ec) ? listFiles(dir) : json::array();
        const auto wantHash = ref.contains("content_hash") && ref["content_hash"].is_string()
            ? ref["content_hash"].get<std::string>() : std::string();
        if (!files.empty() && !wantHash.empty() && packDirHash(dir) != wantHash) {
            // Тот же набор под другим именем — он и есть; иначе имя занято другим набором — отдельный каталог
            if (const auto found = findInstalledPackByHash(root, wantHash); !found.empty()) {
                dir = found;
                LOGI("пак уже установлен под другим именем (тот же отпечаток)");
            } else {
                dir = root + "/" + parvane::pack::sanitizeName(raw.substr(0, 25) + " " + hashTag(wantHash));
            }
            files = std::filesystem::is_directory(dir, ec) ? listFiles(dir) : json::array();
        } else if (files.empty() && !wantHash.empty()) {
            if (const auto found = findInstalledPackByHash(root, wantHash); !found.empty()) {
                dir = found;
                files = listFiles(dir);
                LOGI("пак уже установлен под другим именем (тот же отпечаток)");
            }
        }
        if (files.empty()) {
            if (fid.empty()) throw std::runtime_error("нет file_id");
            // предел шифртекста — размер архива PVPK1 с запасом: чужой pack_ref не заставит читать блоб целиком
            const auto d = downloadChatBlob(fid, parvane::blobcrypt::maxCipherSize(parvane::pack::kMaxBytes + (1u << 20)));
            if (!d.ok) throw std::runtime_error(d.error);
            const auto dec = parvane::blobcrypt::decrypt(d.bytes, ref.value("key", std::string()), ref.value("nonce", std::string()));
            if (!dec) throw std::runtime_error("архив не расшифровался");
            // PACK-2: архив обязан совпасть с заявленным отпечатком (иначе отправитель подменил содержимое набора)
            if (!wantHash.empty() && !parvane::pack::archiveMatchesContentHash(*dec, wantHash))
                throw std::runtime_error("PVPK1: отпечаток архива не совпал с заявленным");
            const auto entries = parvane::pack::parse(*dec);
            if (entries.empty()) throw std::runtime_error("PVPK1: архив пуст или битый");
            std::filesystem::create_directories(dir, ec);
            for (const auto &e : entries) {
                std::ofstream o(dir + "/" + e.name, std::ios::binary);
                o << e.bytes;
                files.push_back({{"name", e.name}, {"size", e.bytes.size()}});
            }
            std::ofstream nm(dir + "/.pvname", std::ios::binary | std::ios::trunc);
            nm << raw;
            LOGI("пак получен (%zu файлов)", entries.size());
        }
        out = json{{"ok", true}, {"dir", dir}, {"files", files}};
    } catch (const std::exception &e) {
        LOGE("packFetch: %s", e.what());
        out["error"] = e.what();
    }
    return jreply(env, out);
}

// Ссылка на архив пака (PVPK1 → blobcrypt → блоб по секрету): кэш по отпечатку содержимого (PACK-2).
// → pack_ref {"file_id","name","count","key","nonce","capability","content_hash"} или {"error"}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePackRefFor(JNIEnv *env, jclass, jstring dirJ, jstring rawNameJ) {
    json out;
    try {
        const auto dir = jstr(env, dirJ), raw = jstr(env, rawNameJ);
        std::vector<parvane::pack::Entry> entries;
        std::error_code ec;
        std::vector<std::filesystem::path> paths;
        for (const auto &e : std::filesystem::directory_iterator(dir, ec)) if (e.is_regular_file()) paths.push_back(e.path());
        std::sort(paths.begin(), paths.end());
        for (const auto &p : paths) {
            if (!parvane::pack::isAllowedExtension(p.filename().string())) continue;
            entries.push_back({p.filename().string(), readFileBytes(p.string())});
        }
        const auto archive = parvane::pack::build(entries);
        if (archive.empty()) throw std::runtime_error("пак пуст");
        const auto hash = parvane::pack::archiveContentHashB64(archive);
        const auto cachePath = storeDir() + "/packrefs.json";
        auto cache = json::parse(parvane::storecrypt::readFile(cachePath), nullptr, false);
        if (!cache.is_object()) cache = json::object();
        if (cache.contains(hash) && cache[hash].is_object()) {
            out = cache[hash];
            rememberBlobCaps(out);
        } else {
            auto enc = parvane::blobcrypt::encrypt(archive);
            if (enc.ciphertext.empty()) throw std::runtime_error("blobcrypt");
            out = json{{"name", raw}, {"key", enc.keyB64}, {"nonce", enc.nonceB64}, {"content_hash", hash}};
            out["file_id"] = uploadChatBlob(enc.ciphertext, out);
            std::size_t count = 0;
            for (const auto &e : entries) if (parvane::pack::isAllowedExtension(e.name) && !e.bytes.empty()) ++count;
            out["count"] = count;
            cache[hash] = out;
            while (cache.size() > 32) cache.erase(cache.begin());
            parvane::storecrypt::writeFile(cachePath, cache.dump());
            LOGI("пак загружен (%s)", out.value("file_id", std::string()).c_str());
        }
    } catch (const std::exception &e) {
        LOGE("packRefFor: %s", e.what());
        out = json{{"error", e.what()}};
    }
    return jreply(env, out);
}

// Отпечаток содержимого установленного набора (PACK-2: тот же набор от другого отправителя — один набор).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePackHash(JNIEnv *env, jclass, jstring dirJ) {
    return jout(env, packDirHash(jstr(env, dirJ)));
}

// GIF-1: сохранённый GIF — файл по ссылке (поля PackRef: file_id, key/nonce, capability, blob_domain, size_bytes):
// кэш устройства, иначе блоб по секрету (CAP-1, домен блоба — FED-1). sha256 содержимого (hex); wantHex непуст и не
// совпал — отказ, в кэш не кладётся. → {"ok","path","sha256","size"} | {"ok":false,"error"}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGifFetch(JNIEnv *env, jclass, jstring refJson, jstring wantHexJ) {
    json out{{"ok", false}};
    try {
        const auto ref = json::parse(jstr(env, refJson), nullptr, false);
        if (!ref.is_object()) throw std::runtime_error("битая ссылка GIF");
        const auto str = [&](const char *k) {
            return ref.contains(k) && ref[k].is_string() ? ref[k].get<std::string>() : std::string();
        };
        const auto fid = str("file_id");
        if (!isSafeFileId(fid)) throw std::runtime_error("недопустимый file_id"); // NAT-04
        rememberBlobCaps(ref);
        std::string plain;
        bool fromCache = false;
        if (const auto cached = readMediaCache(fid)) {
            plain = *cached;
            fromCache = true;
        } else {
            const std::int64_t declared = ref.contains("size_bytes") && ref["size_bytes"].is_number_integer()
                ? ref["size_bytes"].get<std::int64_t>() : 0;
            const auto cap = parvane::chatrules::chatBlobCipherCap("gif", declared);
            std::string cipher;
            const auto capB64 = str("capability"), domain = str("blob_domain");
            if (!capB64.empty() && !domain.empty()) {
                const auto s = v2Ready();
                if (!s) throw std::runtime_error("нет сессии");
                const auto secret = parvane::v2::fromBase64Safe(capB64);
                if (!secret) throw std::runtime_error("секрет блоба не base64");
                cipher = s->downloadBlobCap(fid, *secret, domain, cap);
            } else {
                const auto d = downloadChatBlob(fid, cap);
                if (!d.ok) throw std::runtime_error(d.error);
                cipher = d.bytes;
            }
            const auto k = str("key");
            if (!k.empty()) {
                const auto dec = parvane::blobcrypt::decrypt(cipher, k, str("nonce"));
                if (!dec) throw std::runtime_error("GIF не расшифровался");
                plain = *dec;
            } else {
                plain = std::move(cipher);
            }
        }
        if (plain.empty()) throw std::runtime_error("GIF пуст");
        unsigned char md[SHA256_DIGEST_LENGTH];
        SHA256(reinterpret_cast<const unsigned char *>(plain.data()), plain.size(), md);
        static const char *hexd = "0123456789abcdef";
        std::string hex;
        hex.reserve(SHA256_DIGEST_LENGTH * 2);
        for (unsigned char b : md) { hex.push_back(hexd[b >> 4]); hex.push_back(hexd[b & 15]); }
        auto want = jstr(env, wantHexJ);
        std::transform(want.begin(), want.end(), want.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        if (!want.empty() && want != hex) throw std::runtime_error("sha256 GIF не совпал с записью журнала");
        if (!fromCache) writeMediaCache(fid, plain);
        const auto path = mediaWorkCopy(fid, plain);
        if (path.empty()) throw std::runtime_error("рабочая копия не записана");
        out = json{{"ok", true}, {"path", path}, {"sha256", hex}, {"size", plain.size()}};
    } catch (const std::exception &e) {
        LOGE("gifFetch: %s", e.what());
        out["error"] = e.what();
    }
    return jreply(env, out);
}

// Превью ссылки — только через шард preview; картинка превью (если есть) — вложением по секрету при отправке.
// Сбой/таймаут → {"url","site_name": host}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePreviewFetch(JNIEnv *env, jclass, jstring urlJ, jint timeoutMs) {
    const auto url = jstr(env, urlJ);
    json result;
    if (const auto c = control()) {
        try {
            result = parvane::v2::account::previewLink(*c, url).toJson();
        } catch (const std::exception &e) {
            LOGI("превью: нет (%s)", e.what());
        }
    }
    (void)timeoutMs;
    if (!result.is_object() || result.value("url", std::string()).empty()) {
        std::string host = url;
        if (const auto p = host.find("://"); p != std::string::npos) host = host.substr(p + 3);
        host = host.substr(0, host.find('/'));
        result = json{{"url", url}, {"site_name", host}};
    }
    return jreply(env, result);
}

// Тайл карты z/x/y — только preview.map.tile (MAP-1). PNG байтами; null — нет.
JNIEXPORT jbyteArray JNICALL Java_org_parvane_core_ParvaneCore_nativeMapTile(JNIEnv *env, jclass, jint z, jint x, jint y) {
    std::string png;
    if (const auto c = control()) {
        try {
            png = parvane::v2::account::mapTile(*c, std::uint32_t(z), std::uint32_t(x), std::uint32_t(y));
        } catch (const std::exception &e) {
            LOGE("mapTile %d/%d/%d: %s", z, x, y, e.what());
        }
    }
    if (png.empty()) return nullptr;
    LOGI("тайл %d/%d/%d через preview %zu байт", z, x, y, png.size()); // MAP-1: тайлы — только шардом preview
    jbyteArray arr = env->NewByteArray(static_cast<jsize>(png.size()));
    env->SetByteArrayRegion(arr, 0, static_cast<jsize>(png.size()), reinterpret_cast<const jbyte *>(png.data()));
    return arr;
}

} // extern "C"
