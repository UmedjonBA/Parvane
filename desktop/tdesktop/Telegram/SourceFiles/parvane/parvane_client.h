// Parvane fork: клиент Parvane внутри tdesktop. Владеет персистентным
// parvane::Transport+MessengerClient после логина, реестром пиров (address↔id)
// и зеркалит исходящие сообщения в шину (Фаза 3).
#pragma once

#include <cstdint>

class PeerData;

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
void MirrorOutgoing(PeerData *peer, const QString &text);

// Вызывается в конце конструктора Main::Session. Точка для post-session хуков
// (сейчас — debug-autosend PARVANE_AUTOSEND=peer@server:текст для e2e Фазы 3b).
void AfterSessionReady(not_null<Main::Session*> session);

} // namespace Parvane
