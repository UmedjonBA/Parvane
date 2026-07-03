// Parvane fork: клиент Parvane внутри tdesktop. Владеет персистентным
// parvane::Transport+MessengerClient после логина, реестром пиров (address↔id)
// и зеркалит исходящие сообщения в шину (Фаза 3).
#pragma once

#include <cstdint>
#include <memory>

class PeerData;
class UserData;
struct FilePrepareResult; // storage/localimageloader.h

namespace Main {
class Session;
} // namespace Main

namespace Parvane {

// URL шины из PARVANE_NATS_URL (или дефолт). Реального соединения не открывает.
[[nodiscard]] QString NatsUrl();

// Логирует факт линковки транспорта и целевой NATS-URL (ранний sanity-check).
void LogStartup();

// Результат identity.token.issue.
struct IssueResult {
	bool ok = false;
	QString token;
	QString error;
};

// БЛОКИРУЮЩИЙ запрос identity.token.issue. Звать с воркер-потока (crl::async).
[[nodiscard]] IssueResult Issue(const QString &user, const QString &password);

// JWT текущей сессии (хранится в процессе).
void SetToken(const QString &token);
[[nodiscard]] QString Token();

// ── identity/peer ────────────────────────────────────────────────────────────
// Детерминированный 48-бит UserId из адреса user@server (FNV-1a, ненулевой).
// Один и тот же адрес → один и тот же id между запусками. Используется и при
// синтезе self в intro, и в реестре пиров — поэтому единая точка.
[[nodiscard]] std::uint64_t IdForAddress(const QString &address);

// Запомнить адрес пира (заполняет обратный поиск id→address). Идемпотентно.
void RegisterPeer(const QString &address);

// Адрес по UserId (bare). "" если неизвестен.
[[nodiscard]] QString AddressForId(std::uint64_t userId);

// ── сессия ───────────────────────────────────────────────────────────────────
// Запомнить себя (адрес + JWT) после успешного логина.
void SetSelf(const QString &address, const QString &token);
[[nodiscard]] QString SelfAddress();

// Открыть/переиспользовать персистентное соединение с шиной (по SelfAddress/Token).
// Идемпотентно: если сессия уже активна — no-op, true. БЛОКИРУЮЩАЯ (connect),
// для нормального логина звать с воркер-потока; быстрый локальный connect.
bool StartSession();
[[nodiscard]] bool SessionActive();
void StopSession();

// Зеркалит исходящее текстовое сообщение в шину (msg.chat.send). Адрес получателя
// — из реестра по userId пира; если неизвестен или нет сессии — no-op (лог).
// Неблокирующая: публикация уходит на воркер-поток.
void MirrorOutgoing(
	PeerData *peer,
	const QString &text,
	std::int64_t replyToMsgId = 0);

// Зеркалит исходящее МЕДИА-сообщение (Фаза 4). Грузит байты файла в cloud-шард
// (CloudClient, чанками), затем публикует msg.chat.send с медиа-MessageContent
// (file_id + метаданные). Вызывается из Api::SendConfirmedFile — локальное
// отображение у отправителя делает штатный tdesktop, мы лишь дублируем в шину.
// Неблокирующая: upload+publish уходят на воркер-поток. Адрес пира — из реестра.
void MirrorOutgoingFile(
	not_null<Main::Session*> session,
	const std::shared_ptr<FilePrepareResult> &file);

// Привязывает локальный файл к СВОЕМУ (исходящему) медиа, чтобы отправитель
// видел фото inline / файл как скачанный. Нужно потому, что в форке штатный
// uploader пропущен (иначе вечная крутилка) и DocumentData/PhotoData остаются
// без локальных данных. Звать на main после создания локального сообщения.
void AttachLocalOutgoingMedia(
	not_null<Main::Session*> session,
	const std::shared_ptr<FilePrepareResult> &file);

// Зеркалит «печатает…» в шину (msg.typing.<id получателя>, fire-and-forget).
// Вызывается из SendProgressManager при вводе. Адрес пира — из реестра.
void MirrorTyping(PeerData *peer);

// Удаляет СВОЁ сообщение «у всех» (msg.chat.delete). msgId — локальный
// синтетический id; uuid ищется в обратной карте. Чужое/неизвестное — no-op.
void MirrorDelete(std::int64_t msgId);

// Правит текст СВОЕГО сообщения (msg.chat.edit). Аналогично MirrorDelete.
void MirrorEdit(std::int64_t msgId, const QString &newText);

// Отмечает прочитанными непрочитанные входящие от пира (msg.chat.read → ✓✓ у
// отправителя). peerId — локальный id пира (bare). Вызывается из readInbox.
void MirrorRead(std::int64_t peerId);

// Синтезирует (идемпотентно) пира по адресу и возвращает его UserData — чтобы
// начать чат по адресу. Используется в поиске (PeerSearch) вместо MTProto.
[[nodiscard]] not_null<UserData*> EnsurePeer(
	not_null<Main::Session*> session,
	const QString &address);

// Поиск пользователей в каталоге identity (identity.user.search). Асинхронно:
// запрос на воркере, callback с найденными адресами — на main-потоке.
void SearchUsers(const QString &query, Fn<void(QStringList)> callback);

// Задаёт СВОЁ отображаемое имя (identity.user.setname) + кладёт в локальный кэш.
void SetDisplayName(const QString &name);

// Вызывается в конце конструктора Main::Session. Запоминает сессию (weak),
// запускает первичный приём и debug-autosend (PARVANE_AUTOSEND=peer@server:текст).
void AfterSessionReady(not_null<Main::Session*> session);

// Один цикл приёма (Фаза 3c): sync с шины на воркере → инъекция НОВЫХ входящих
// сообщений в Data::Session активной сессии (на main). Дедуп по UUID. Безопасно
// звать с любого потока; если сессии нет — no-op. Триггерится onDelivered и при
// старте сессии.
void PumpReceive();

} // namespace Parvane
