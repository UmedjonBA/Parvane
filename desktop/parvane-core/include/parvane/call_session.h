// Parvane fork: оркестрация одного звонка 1-на-1 — стейт-машина + маппинг наших
// сигналов (invite/answer/ice/reject/hangup) на медиа-движок + АУТЕНТИФИКАЦИЯ
// сигналинга (подпись SDP ключом идентичности). Медиа-движок абстрагирован
// интерфейсом MediaBackend: реальный — libwebrtc/tg_owt (Э3-b), в тестах —
// фейк. Так вся security-логика тестируется без libwebrtc. См. CALLS-parvane.md.
#pragma once

#include <functional>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "parvane/call.h"
#include "parvane/crypto.h"

namespace parvane {

using nlohmann::json;

// Абстракция медиа-движка (WebRTC PeerConnection). Все методы асинхронные:
// результат приходит через переданный колбэк или через onLocalIce/
// onConnectionChange. Реализация НЕ занимается сигналингом/крипто — только медиа.
class MediaBackend {
public:
    virtual ~MediaBackend() = default;

    // Caller: создать SDP-offer.
    virtual void createOffer(std::function<void(std::string sdp)> onOffer) = 0;
    // Callee: принять удалённый offer, вернуть локальный answer.
    virtual void acceptOffer(const std::string &remoteSdp,
                             std::function<void(std::string answerSdp)> onAnswer) = 0;
    // Caller: применить удалённый answer.
    virtual void setRemoteAnswer(const std::string &sdp) = 0;
    // Обе стороны: добавить удалённый ICE-кандидат.
    virtual void addRemoteIce(const std::string &candidate) = 0;
    // Завершить (освободить ресурсы).
    virtual void close() = 0;

    // Включить видео (камера + видео-трансивер). Звать ДО createOffer/acceptOffer.
    // По умолчанию no-op (аудио-движки/заглушка игнорируют).
    virtual void setWantVideo(bool /*on*/) {}

    // Движок → сессия: локальный ICE-кандидат (переслать собеседнику).
    std::function<void(std::string candidate)> onLocalIce;
    // Движок → сессия: P2P-соединение установлено/разорвано.
    std::function<void(bool connected)> onConnectionChange;
};

enum class CallState {
    Idle,        // ещё не начат
    Outgoing,    // мы позвонили, ждём ответа
    Incoming,    // нам звонят, ждём accept пользователя
    Connecting,  // обмен состоялся, устанавливается медиа
    Active,      // разговор идёт
    Ended,       // завершён/отклонён
};

// Была ли аутентифицирована подпись собеседника.
enum class PeerAuth {
    Unknown,        // ещё не проверяли
    Verified,       // подпись валидна ключом из каталога
    Unverified,     // у собеседника нет зарегистрированного ключа (проверить нечем)
    Failed,         // подпись невалидна/отсутствует при известном ключе → отбой
};

class CallSession {
public:
    struct Callbacks {
        // Отправить сигнал (готовый JSON CallSignalPayload::signal) собеседнику.
        std::function<void(json signal)> sendSignal;
        // Публичный ключ собеседника (base64) для verify; "" — ключа нет.
        std::function<std::string()> peerPubkey;
        // Смена состояния звонка (для UI).
        std::function<void(CallState)> onState;
    };

    // key — наш ключ подписи (может быть nullptr: тогда шлём без подписи).
    CallSession(std::string selfAddr, std::string peerAddr,
                const crypto::SigningKey *key,
                std::unique_ptr<MediaBackend> media, Callbacks cb);

    // Исходящий звонок: создать offer, подписать, послать invite. media="audio"|"video".
    void start(const std::string &media);
    // Входящий сигнал из шины.
    void onSignal(const CallSignalIn &sig);
    // Пользователь принял входящий → сформировать и послать (подписанный) answer.
    void accept();
    // Завершить/отклонить (шлёт hangup или reject в зависимости от фазы).
    void hangup();

    [[nodiscard]] CallState state() const { return state_; }
    [[nodiscard]] PeerAuth peerAuth() const { return peerAuth_; }
    [[nodiscard]] const std::string &callId() const { return callId_; }
    [[nodiscard]] const std::string &media() const { return media_; }

private:
    void setState(CallState s);
    // Проверить подпись входящего SDP; false → зафиксировать Failed и отбить.
    [[nodiscard]] bool authenticateSdp(const std::string &sdp, const std::string &sig);
    [[nodiscard]] std::string signSdp(const std::string &sdp) const;
    void wireMedia();

    std::string self_;
    std::string peer_;
    const crypto::SigningKey *key_;
    std::unique_ptr<MediaBackend> media_engine_;
    Callbacks cb_;

    CallState state_ = CallState::Idle;
    PeerAuth peerAuth_ = PeerAuth::Unknown;
    std::string callId_;
    std::string media_ = "audio";
    std::string remoteOffer_; // сохранённый offer до accept()
};

} // namespace parvane
