// Parvane fork: клиент Parvane внутри tdesktop. Владеет персистентным
// parvane::Transport+MessengerClient после логина, реестром пиров (address↔id)
// и зеркалит исходящие сообщения в шину (Фаза 3).
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

class PeerData;
class UserData;
class HistoryItem;
class DocumentData;
class QImage;
struct FilePrepareResult; // storage/localimageloader.h
struct TextWithEntities;   // ui/text/text_entity.h (форматирование)
struct PollData;           // data/data_poll.h (опросы)

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

// Результат identity.user.register (регистрация отделена от логина, Фаза 0).
struct RegisterResult {
	bool ok = false;
	QString error;
};

// БЛОКИРУЮЩИЙ запрос identity.user.register. Звать с воркер-потока.
[[nodiscard]] RegisterResult Register(const QString &user, const QString &password);

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

// Зеркалит исходящее текстовое сообщение (с форматированием) в шину. Адрес
// получателя — из реестра по userId пира; если неизвестен/нет сессии — no-op.
// Неблокирующая: публикация уходит на воркер-поток.
void MirrorOutgoing(
	PeerData *peer,
	const TextWithEntities &text,
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

// Пересылает сообщение (текст или медиа) пиру toPeer через шину. Медиа —
// повторной ссылкой на уже загруженный в cloud блоб (без пере-загрузки).
void MirrorForward(PeerData *toPeer, not_null<HistoryItem*> item);

// Зеркалит реакцию на сообщение (msg.chat.react). emoji пустой — снять свою.
// Вызывается из HistoryItem::toggleReaction после локального обновления.
void MirrorReact(not_null<HistoryItem*> item, const QString &emoji);

// Зеркалит закрепление/открепление сообщения (msg.chat.pin).
void MirrorPin(not_null<HistoryItem*> item, bool pin);

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

// Ставит СВОЙ аватар: грузит фото в cloud + identity.user.setavatar, показывает
// локально. selfPeer — свой UserData, image — выбранное фото.
void SetOwnAvatar(PeerData *selfPeer, const QImage &image);

// ── звонки (Фаза 4) ────────────────────────────────────────────────────────
// Инициировать звонок пиру (audio/video). Подтягивает pubkey собеседника
// (для проверки подписи) и публикует подписанный invite в шину.
void PlaceCall(const QString &peer, bool video);
// Принять текущий входящий звонок.
void AcceptCall();
// Завершить/отклонить текущий звонок.
void HangupCall();

// ── группы/каналы ────────────────────────────────────────────────────────────
// Тянет список групп пользователя и синтезирует их как чаты (появляются в
// списке диалогов). Звать после логина и при обновлениях.
void RefreshGroups();
// Создаёт группу (channel=false) или канал (channel=true) с участниками и
// синтезирует её локально.
void CreateGroup(const QString &name, const QStringList &members, bool channel);

// Админка групп: добавить/удалить участника, промоут/демоут (роль admin/member),
// выйти самому. groupId — адрес группы. Все зовут messenger (owner/admin проверка
// на бэкенде), потом RefreshGroups. Пустой ответ/нет прав — просто лог.
void AddMember(const QString &groupId, const QString &member);
void KickMember(const QString &groupId, const QString &member);
void SetMemberRole(const QString &groupId, const QString &member, bool admin);
void LeaveGroup(const QString &groupId);

// Адрес нашей группы по peer (Chat) — "" если это не наша группа. Для врезки
// нативного «выйти из группы» в меню.
[[nodiscard]] QString GroupIdForChat(not_null<PeerData*> peer);

// ── модерация групп и инвайт-ссылки (P2) ─────────────────────────────────────
// Бан/разбан участника (owner/admin; бэкенд сам гейтит права).
void BanMember(const QString &groupId, const QString &member, bool ban);
// Мьют на minutes минут (0 — снять). owner/admin.
void MuteMember(const QString &groupId, const QString &member, int minutes);
// Создать инвайт-ссылку: бокс со ссылкой + копия в буфер обмена.
void CreateInviteLink(const QString &groupId);
// Перехват клика по ссылке: parvane.invite/<token> → конфирм → вступление.
// true — ссылка наша (обработана), false — не наша.
[[nodiscard]] bool JoinByInviteLink(const QString &url);

// ── стикеры/GIF (паритет) ────────────────────────────────────────────────────
// Зеркалит отправку СУЩЕСТВУЮЩЕГО документа (стикер из панели / GIF из
// сохранённых): байты локального файла → cloud (E2E-блоб), content kind=
// sticker/gif. Прочие документы — no-op. Локальное эхо делает штатный
// SendExistingMedia. Вызывается из Api::SendExistingDocument.
void MirrorOutgoingSticker(PeerData *peer, DocumentData *document);

// Обмен стикер-паками «как в Telegram»: отправляемый стикер несёт pack_ref
// (весь набор один раз пакуется в cloud E2E-блобом); у получателя клик по
// стикеру предлагает установить набор.
// Есть ли у принятого стикера ссылка на пак (для клика в ленте).
[[nodiscard]] bool HasStickerPackRef(DocumentData *document);
// Показать конфирм-бокс и установить набор (скачать, распаковать, подхватить).
void InstallStickerPackFromDocument(DocumentData *document);

// ── опросы (паритет) ─────────────────────────────────────────────────────────
// Опрос едет ВНУТРИ E2E-контента (kind=poll), голоса — отдельными kind=poll_vote
// событиями; сервер их не видит, каждый клиент агрегирует сам. Все три —
// перехваты Api::Polls (create/sendVotes/close): true = обработано форком,
// MTProto звать не нужно; false = наш путь неприменим (нет сессии/не наш опрос).

// Создать опрос: шлёт poll-контент через шину и синтезирует локальное эхо.
bool MirrorPollCreate(PeerData *peer, const PollData &data);

// Проголосовать. options — байты выбранных вариантов ("0","1",…); пусто —
// отозвать голос. Локально применяется сразу, остальным уходит poll_vote.
bool MirrorPollVotes(std::uint64_t pollId, const std::vector<QByteArray> &options);

// Остановить опрос (только свой; UI сам гейтит по автору).
bool MirrorPollClose(std::uint64_t pollId);

// «Кто голосовал»: свой бокс результатов вместо нативной Info-секции
// (та ходит в MTProto). true — показано (наш опрос), false — не наш.
bool ShowPollResultsBox(PollData *poll);

// Пользователь задал таймер самоуничтожения (нативное меню Auto-Delete) — сохранить
// TTL чата у нас (peer->messagesTTL() уже выставлен вызывающим). Исходящие в этот
// чат получат ttl_secs → у получателя нативный ttl_period (авто-удаление).
void OnPeerTtlChanged(not_null<PeerData*> peer);

// Групповой звонок: инициировать mesh со всеми участниками группы groupId.
void StartGroupCall(const QString &groupId, bool video);
// Групповой звонок по чат-пиру (для кнопки звонка в шапке группы).
void StartGroupCallForChat(PeerData *chat, bool video);
// Выйти из текущего группового звонка.
void LeaveGroupCall();

// Вызывается в конце конструктора Main::Session. Запоминает сессию (weak),
// запускает первичный приём и debug-autosend (PARVANE_AUTOSEND=peer@server:текст).
void AfterSessionReady(not_null<Main::Session*> session);

// Один цикл приёма (Фаза 3c): sync с шины на воркере → инъекция НОВЫХ входящих
// сообщений в Data::Session активной сессии (на main). Дедуп по UUID. Безопасно
// звать с любого потока; если сессии нет — no-op. Триггерится onDelivered и при
// старте сессии.
void PumpReceive();

} // namespace Parvane
