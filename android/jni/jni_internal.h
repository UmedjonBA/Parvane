// Parvane Android (spec 031): общее состояние JNI-фасада над parvane-core — только протокол v2
// (v1 удалён, как в desktop spec 029). Модули: jni_main (события, хранилище, журнал истории),
// jni_session (вход, сессия, события движка), jni_history (журнал истории аккаунта, spec 033), jni_messages (переписка, медиа), jni_groups, jni_account
// (устройства, привязка, ключи, аккаунт, журнал состояния). Одна сессия на процесс, один аккаунт.
//
// Потоки и замки (NAT-06): g_mu — учётные данные и карты сообщений (никогда не держится во время сети);
// g_v2Mu — указатели на сессию/управление; сеть — без них. События в Kotlin — только через очередь emit()
// (отдельный поток, по порядку), кроме реплея журнала истории (emitNow, синхронно).
#pragma once

#include <jni.h>
#include <android/log.h>

#include <parvane/v2_account.h>
#include <parvane/v2_content.h>
#include <parvane/v2_control.h>
#include <parvane/v2_link.h>
#include <parvane/v2_session.h>

#include <nlohmann/json.hpp>

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "jni_utf.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "parvane", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "parvane", __VA_ARGS__)

namespace pvjni {
// Поле строкой либо пусто: `json::value(k, std::string())` бросает type_error, если поле есть, но null/не строка.
// Строки истории и сообщения других клиентов несут `"caption": null` — 5 ноя 2026 это роняло X (SIGABRT на parvane-io).
inline std::string strOf(const nlohmann::json &o, const char *key) {
    if (!o.is_object()) return {};
    const auto it = o.find(key);
    return (it != o.end() && it->is_string()) ? it->get<std::string>() : std::string();
}
// Текст сообщения для списка и уведомлений: `text`, иначе подпись медиа
inline std::string textOrCaption(const nlohmann::json &content) {
    auto t = strOf(content, "text");
    return t.empty() ? strOf(content, "caption") : t;
}

// Фоновая задача JNI: исключение из ядра не уходит в std::terminate (SIGABRT всего приложения), а пишется в журнал.
template <typename F> void runDetached(F &&fn) {
    std::thread([fn = std::forward<F>(fn)]() mutable {
        try {
            fn();
        } catch (const std::exception &e) {
            LOGE("фоновая задача: %s", e.what());
        } catch (...) {
            LOGE("фоновая задача: исключение не std::exception");
        }
    }).detach();
}
} // namespace pvjni

namespace pvjni {

using json = nlohmann::json;

// ── окружение ────────────────────────────────────────────────────────────────
extern JavaVM *g_vm;
extern std::mutex g_mu;
extern std::string g_gatewayUrl; // под g_mu
extern std::string g_storeDir;   // под g_dirMu (задаётся один раз в init) — читать storeDir()
extern std::string g_self;       // под g_mu
extern std::string g_token;      // под g_mu
extern std::string g_storeKey;   // 32 байта ключа хранилища (для повторной установки после стирания)
extern bool g_debugBuild;        // debug-сборка (dev-хуки, логи содержимого)

[[nodiscard]] std::string jstr(JNIEnv *env, jstring s);
[[nodiscard]] jstring jout(JNIEnv *env, const std::string &s);
[[nodiscard]] jstring jreply(JNIEnv *env, const json &j);
[[nodiscard]] json jfail(const std::string &code, const std::string &text = std::string());
[[nodiscard]] std::int64_t nowSec();
[[nodiscard]] std::int64_t nowMs();
[[nodiscard]] std::int64_t steadyMs();
[[nodiscard]] std::string self();
[[nodiscard]] std::string storeDir();
[[nodiscard]] std::string safePart(const std::string &address);
// Код отказа v2 (ERROR_CODE_*) либо "failed" — Kotlin подставляет текст (SeamText).
[[nodiscard]] std::string errorCodeOf(const std::exception &e);

// ── события в Kotlin ─────────────────────────────────────────────────────────
void emit(const json &event);    // через очередь
void emitNow(const json &event); // синхронно (реплей журнала)
// FED-1: отказ федерации (код в тексте ошибки) → событие federation_error{reason} (disabled|blocked|refused|unreachable|
// key_changed); остальные ошибки — ничего. Как desktop NoteFederationFailure / web federationReason.
void noteFederationFailure(const std::string &error);

// ── журнал истории аккаунта (spec 033, jni_history.cpp; ядро parvane::history::HistorySync) ─────────────
// Строки RowState (FileRowStore ядра), маркеры «прочитано до», события шва message/edited/meta/deleted/read_state.
void historyStart();   // рабочий поток журнала (после старта сессии v2)
void historyReset();   // выход, смена аккаунта, смена ника: остановить и забыть
void historySessionEvent(const json &ev); // {"type":"journal","journal":"history"} | stateReady
// Домен группы для Peer строк журнала; authoritative = false (из строк журнала) — только если ещё не известен.
void historyNoteGroupDomain(const std::string &address, const std::string &domain, bool authoritative = true);
void historyNoteGroupInfo(const std::string &address, const json &info); // кто в группе удаляет чужое
[[nodiscard]] bool historyGroupCanDelete(const std::string &group, const std::string &user);
[[nodiscard]] json historyPeerOf(const std::string &chatAddress); // state.v1.Peer; null — не чат
// Событие "message" (своё — own, иначе входящее) → строка журнала; событие дополняется по сведённой строке (правки,
// реакции, закреп, пришедшие раньше, прочитано). false — сообщение удалено раньше прихода: не показывать.
bool historyRecordMessageEvent(json &event, bool own, std::int64_t tsMs = 0);
json historyRecordOwnOp(const json &op); // своя правка/реакция/закреп → журнал ≤ 300 мс
[[nodiscard]] std::optional<json> historyState(const std::string &id);
void historyApplyIncomingMutation(const parvane::v2::Incoming &in); // Edit/Delete/Reaction/Pin/Read
// Удаление: чат сообщения и «у всех» ли (право — historyCanDelete движка). false — сообщение неизвестно.
bool historyDelete(const std::string &id, bool forEveryone, std::string *chatOut, bool *everyoneOut);
void historyRecordDelete(const std::string &id, const std::string &chat, bool everyone, const std::string &opId);
void historyMarkRead(const std::vector<std::string> &ids); // маркер + квитанции о ставших прочитанными, с повтором
void historyEmitReadState(const std::string &chat);
[[nodiscard]] std::vector<json> historyRows(); // видимые строки событиями "message", порядок ORDER-1
void historyReplay(); // в Kotlin по первому LoadChats: строки + счётчики от маркера
void historyClearChat(const std::string &chat, std::int64_t untilMs, const std::set<std::string> &ids);
void historyForget(const std::string &id);
void historyMoveFiles(const std::string &oldAddress, const std::string &newAddress);

// ── сообщения в памяти (из журнала и живых событий) ──────────────────────────
struct MsgRow {
    std::string from;
    std::string chat; // собеседник либо "v2g:<hex>"
    json content;
    std::string proof; // core.v2.MessageProof (base64): подпись автора полученного сообщения для жалобы (A0008-2)
};
void noteMessage(const std::string &id, const std::string &from, const std::string &chat, const json &content,
                 const std::string &proof = std::string());
[[nodiscard]] std::optional<MsgRow> messageRow(const std::string &id);
void updateMessageContent(const std::string &id, const json &content);
void forgetMessage(const std::string &id);
[[nodiscard]] bool markSeen(const std::string &id); // false — уже было
void resetMessages();

// Блобы вложений по секрету (CAP-1): file_id → секрет base64 из содержимого.
void rememberBlobCaps(const json &content);
void rememberBlobCap(const std::string &fileId, const std::string &capB64);
[[nodiscard]] std::string blobCapOf(const std::string &fileId);

// ── сессия v2 и управление ───────────────────────────────────────────────────
extern std::mutex g_v2Mu;
extern std::shared_ptr<parvane::v2::Session> g_v2; // под g_v2Mu
extern std::shared_ptr<parvane::v2::Control> g_control; // под g_v2Mu
[[nodiscard]] std::shared_ptr<parvane::v2::Session> v2Any();
[[nodiscard]] std::shared_ptr<parvane::v2::Session> v2Ready();
[[nodiscard]] std::shared_ptr<parvane::v2::Session> v2ReadyForSend(); // ждёт подъёма ≤ 10 с
[[nodiscard]] std::shared_ptr<parvane::v2::Session> v2NeedsLinking();
[[nodiscard]] std::shared_ptr<parvane::v2::Session> v2AwaitNeedsLinking();
[[nodiscard]] std::shared_ptr<parvane::v2::Control> control();
[[nodiscard]] std::string v2StateDir(const std::string &address);
void handleV2Event(const json &ev);
// Реакции и закреп сообщений: событие meta (с авторами — переживает рестарт через журнал).
[[nodiscard]] json metaEvent(const std::string &uuid, const std::optional<std::pair<std::string, std::string>> &reaction,
                             std::optional<bool> pinned);
[[nodiscard]] std::string ownReactionOf(const std::string &uuid);
void replaceMeta(const std::string &uuid, const json &by, bool pinned); // авторы реакций и закреп — из строки журнала
void resetReactions();
void startSession(); // без g_mu
void stopSession();

// ── группы ───────────────────────────────────────────────────────────────────
[[nodiscard]] bool isGroupAddress(const std::string &address);
void noteGroupMembers(const std::string &address, const std::vector<std::string> &members);
void forgetGroup(const std::string &address);
[[nodiscard]] std::vector<std::string> groupMembers(const std::string &address);
[[nodiscard]] bool groupKnown(const std::string &address);
void cacheGroupInfo(const std::string &address, const json *info);
[[nodiscard]] json groupListJson();
void flushLinkedGroupRows(const std::string &address);
void deferLinkedGroupRow(const std::string &address, json event);
void resetGroups();

// ── режим L2 (кэш для горячих путей typing/presence) ─────────────────────────
[[nodiscard]] bool l2Active(const std::string &chat);
void l2Store(const json &state, bool save);
void l2Load();
void l2Forget();
[[nodiscard]] bool presenceAllowed();

// ── блобы, медиа ─────────────────────────────────────────────────────────────
struct BlobDownload {
    bool ok = false;
    std::string bytes;
    std::string error;
};
// Секрет известен — анонимным каналом v2; иначе свой/открытый блоб — соединением управления.
[[nodiscard]] BlobDownload downloadChatBlob(const std::string &fileId, std::size_t maxBytes = 0);
[[nodiscard]] bool isSafeFileId(const std::string &fileId);
// Расшифрованное вложение: кэш под storecrypt (P-13) + открытая рабочая копия во временном каталоге
// (стирается при старте и выходе) — путь для X. "" — нет.
[[nodiscard]] std::string mediaWorkCopy(const std::string &fileId, const std::string &bytes);
[[nodiscard]] std::optional<std::string> readMediaCache(const std::string &fileId);
void writeMediaCache(const std::string &fileId, const std::string &bytes);
[[nodiscard]] std::string tempDir(const std::string &kind);

// ── привязка устройства и копия ключей ───────────────────────────────────────
void startLinkOffer();
void startLinkingWorkers();
void resetLinking();
void syncFromKeyBundle();
void completeKeyJoin(parvane::v2::KeyJoinOutcome outcome);
void completeJoin(); // событие сессии `joined`: всё из копии ключей аккаунта, отзыв оффера

// ── звонки ───────────────────────────────────────────────────────────────────
void handleCallSignal(const std::string &from, bool group, const json &signal);
void resetCalls();

// ── разделы ──────────────────────────────────────────────────────────────────
void sectionsEngineEvent(const std::string &domainName, const std::string &id);
void sectionsSessionChanged();
void sectionsDomainKeys(); // ключи доменов из копии ключей аккаунта (`domain-keys.json`) — применить разделам
void sectionsAccountReset();

// ── выход и стирание (NAT-16) ────────────────────────────────────────────────
void wipeAccountData(const char *why);
[[nodiscard]] bool prepareForLogin();

} // namespace pvjni
