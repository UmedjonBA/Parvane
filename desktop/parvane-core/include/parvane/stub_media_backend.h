// Parvane fork: заглушечный медиа-движок — реализует MediaBackend без реального
// WebRTC/звука. Отдаёт фиктивные SDP/ICE и синхронно «устанавливает» соединение.
// Нужен, чтобы прогонять весь путь сигналинга (кнопка звонка → сигналы в шину →
// у второго звонит → оба Active) БЕЗ libwebrtc и звука. Реальный движок (tg_owt)
// заменит его в Э3-b. См. desktop/CALLS-parvane.md.
#pragma once

#include <functional>
#include <string>

#include "parvane/call_session.h"

namespace parvane {

class StubMediaBackend : public MediaBackend {
public:
    void createOffer(std::function<void(std::string)> onOffer) override {
        onOffer("stub-offer-sdp");
        if (onLocalIce) onLocalIce("stub-cand-caller");
    }
    void acceptOffer(const std::string & /*remoteSdp*/,
                     std::function<void(std::string)> onAnswer) override {
        onAnswer("stub-answer-sdp");     // → сессия: Connecting + шлёт answer
        if (onLocalIce) onLocalIce("stub-cand-callee");
        if (onConnectionChange) onConnectionChange(true); // → Active
    }
    void setRemoteAnswer(const std::string & /*sdp*/) override {
        if (onConnectionChange) onConnectionChange(true); // инициатор → Active
    }
    void addRemoteIce(const std::string & /*candidate*/) override {}
    void close() override {}
};

} // namespace parvane
