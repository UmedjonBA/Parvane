// Parvane fork: тесты CallSession — оркестрация звонка + АУТЕНТИФИКАЦИЯ
// сигналинга (подпись SDP). Медиа-движок — фейк, поэтому без libwebrtc/бэкенда.
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "parvane/call_session.h"
#include "parvane/crypto.h"

using namespace parvane;
using parvane::crypto::SigningKey;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

// Фейковый медиа-движок: отдаёт заранее заданные SDP синхронно, пишет вызовы.
class FakeMedia : public MediaBackend {
public:
    std::string offerSdp = "OFFER-SDP";
    std::string answerSdp = "ANSWER-SDP";
    std::string remoteOffer, remoteAnswer, lastRemoteIce;
    int closeCount = 0;

    void createOffer(std::function<void(std::string)> onOffer) override { onOffer(offerSdp); }
    void acceptOffer(const std::string &remoteSdp,
                     std::function<void(std::string)> onAnswer) override {
        remoteOffer = remoteSdp;
        onAnswer(answerSdp);
    }
    void setRemoteAnswer(const std::string &sdp) override { remoteAnswer = sdp; }
    void addRemoteIce(const std::string &c) override { lastRemoteIce = c; }
    void close() override { ++closeCount; }
    void emitLocalIce(const std::string &c) { if (onLocalIce) onLocalIce(c); }
    void emitConnected(bool v) { if (onConnectionChange) onConnectionChange(v); }
};

// Собирает исходящие сигналы; последний по типу — для ассертов.
struct Sink {
    std::vector<json> signals;
    void operator()(json s) { signals.push_back(std::move(s)); }
    const json *last(const std::string &type) const {
        for (auto it = signals.rbegin(); it != signals.rend(); ++it)
            if ((*it).value("type", std::string()) == type) return &*it;
        return nullptr;
    }
};

int main() {
    std::printf("=== parvane-core call_session tests ===\n");

    // ── 1. Исходящий: offer подписывается, invite уходит ──────────────────────
    {
        auto key = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        auto fakeOwner = std::make_unique<FakeMedia>();
        CallSession s("alice@l", "bob@l", &key, std::move(fakeOwner),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [] { return std::string(); }, nullptr});
        s.start("audio");
        check(s.state() == CallState::Outgoing, "start → состояние Outgoing");
        const json *inv = sink->last("invite");
        check(inv != nullptr, "start → отправлен invite");
        if (inv) {
            check(inv->value("sdp", "") == "OFFER-SDP", "invite несёт offer движка");
            check(!inv->value("sig", "").empty(), "invite подписан (sig непуст)");
            check(crypto::verify(key.publicB64(),
                                 callSignedData(s.callId(), "OFFER-SDP"),
                                 inv->value("sig", "")),
                  "подпись invite валидна нашим публичным ключом");
        }
    }

    // ── 2. Входящий: проверяем подпись, принимаем, подписываем answer ─────────
    {
        auto caller = SigningKey::generate();
        auto callee = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        auto *fake = new FakeMedia();
        CallSession s("bob@l", "alice@l", &callee,
                      std::unique_ptr<FakeMedia>(fake),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [&] { return caller.publicB64(); }, nullptr});
        const std::string sig = caller.sign(callSignedData("c1", "OFFER"));
        s.onSignal(CallSignalIn::fromJson(inviteSignal("c1", "audio", "OFFER", sig)));
        check(s.state() == CallState::Incoming, "валидный invite → Incoming");
        check(s.peerAuth() == PeerAuth::Verified, "подпись собеседника проверена → Verified");
        s.accept();
        check(fake->remoteOffer == "OFFER", "accept → offer передан движку");
        const json *ans = sink->last("answer");
        check(ans != nullptr && ans->value("sdp", "") == "ANSWER-SDP",
              "accept → отправлен answer с SDP движка");
        if (ans)
            check(crypto::verify(callee.publicB64(),
                                 callSignedData("c1", "ANSWER-SDP"),
                                 ans->value("sig", "")),
                  "answer подписан нашим ключом");
        check(s.state() == CallState::Connecting, "после accept → Connecting");
    }

    // ── 3. БЕЗОПАСНОСТЬ: MITM подменил SDP в invite → отбой ────────────────────
    {
        auto caller = SigningKey::generate();
        auto callee = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        auto *fake = new FakeMedia();
        CallSession s("bob@l", "alice@l", &callee, std::unique_ptr<FakeMedia>(fake),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [&] { return caller.publicB64(); }, nullptr});
        // Подпись сделана над честным "OFFER", а шард подменил SDP на "EVIL".
        const std::string sig = caller.sign(callSignedData("c1", "OFFER"));
        s.onSignal(CallSignalIn::fromJson(inviteSignal("c1", "audio", "EVIL", sig)));
        check(s.peerAuth() == PeerAuth::Failed, "подменённый SDP → PeerAuth::Failed");
        check(s.state() == CallState::Ended, "MITM invite → звонок завершён (отбой)");
        check(sink->last("reject") != nullptr, "на MITM отправлен reject");
        check(fake->remoteOffer.empty(), "движок НЕ получил подменённый offer");
    }

    // ── 4. БЕЗОПАСНОСТЬ: подпись срезана, но ключ известен → отбой ─────────────
    {
        auto caller = SigningKey::generate();
        auto callee = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        CallSession s("bob@l", "alice@l", &callee, std::make_unique<FakeMedia>(),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [&] { return caller.publicB64(); }, nullptr});
        // sig="" (MITM срезал подпись), но у собеседника есть ключ → требуем подпись.
        s.onSignal(CallSignalIn::fromJson(inviteSignal("c1", "audio", "OFFER", "")));
        check(s.peerAuth() == PeerAuth::Failed, "срезанная подпись при известном ключе → Failed");
        check(s.state() == CallState::Ended, "срезанная подпись → отбой");
    }

    // ── 5. У собеседника нет ключа → пропускаем, но помечаем Unverified ────────
    {
        auto callee = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        CallSession s("bob@l", "alice@l", &callee, std::make_unique<FakeMedia>(),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [] { return std::string(); }, nullptr});
        s.onSignal(CallSignalIn::fromJson(inviteSignal("c1", "audio", "OFFER", "")));
        check(s.state() == CallState::Incoming, "нет ключа собеседника → всё равно Incoming");
        check(s.peerAuth() == PeerAuth::Unverified, "нет ключа → Unverified (не Failed)");
    }

    // ── 6. БЕЗОПАСНОСТЬ: невалидная подпись answer → инициатор кладёт трубку ────
    {
        auto caller = SigningKey::generate();
        auto callee = SigningKey::generate();
        auto attacker = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        auto *fake = new FakeMedia();
        CallSession s("alice@l", "bob@l", &caller, std::unique_ptr<FakeMedia>(fake),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [&] { return callee.publicB64(); }, nullptr});
        s.start("audio"); // Outgoing
        // answer подписан ЧУЖИМ (attacker) ключом — не совпадёт с callee.pub.
        const std::string badSig = attacker.sign(callSignedData(s.callId(), "ANSWER"));
        s.onSignal(CallSignalIn::fromJson(answerSignal(s.callId(), "ANSWER", badSig)));
        check(s.state() == CallState::Ended, "подставной answer → инициатор завершает");
        check(fake->remoteAnswer.empty(), "движок НЕ получил подставной answer");
        check(fake->closeCount > 0, "медиа закрыто");
    }

    // ── 7. ICE в обе стороны + установление соединения + hangup ───────────────
    {
        auto caller = SigningKey::generate();
        auto callee = SigningKey::generate();
        auto sink = std::make_shared<Sink>();
        auto *fake = new FakeMedia();
        CallSession s("alice@l", "bob@l", &caller, std::unique_ptr<FakeMedia>(fake),
                      {[sink](json j) { (*sink)(std::move(j)); },
                       [&] { return callee.publicB64(); }, nullptr});
        s.start("audio");
        // Локальный ICE движка → уходит в шину.
        fake->emitLocalIce("cand-local");
        const json *ice = sink->last("ice");
        check(ice != nullptr && ice->value("candidate", "") == "cand-local",
              "локальный ICE движка → отправлен собеседнику");
        // Удалённый ICE из шины → в движок.
        s.onSignal(CallSignalIn::fromJson(iceSignal(s.callId(), "cand-remote")));
        check(fake->lastRemoteIce == "cand-remote", "удалённый ICE → передан движку");
        // Соединение установлено.
        fake->emitConnected(true);
        check(s.state() == CallState::Active, "onConnectionChange(true) → Active");
        // Кладём трубку.
        s.hangup();
        check(sink->last("hangup") != nullptr, "hangup → сигнал hangup");
        check(s.state() == CallState::Ended && fake->closeCount > 0,
              "hangup → Ended + медиа закрыто");
    }

    // ── 8. Второе устройство: свой ключ звонков в identity не принят → подпись
    //       ключом устройства (Callbacks::sign); собеседник находит его среди
    //       ключей устройств (peerPubkeys), а ключ из identity — чужой ──────────
    {
        auto callKey = SigningKey::generate();   // локальный ключ звонков (не опубликован)
        auto deviceKey = SigningKey::generate(); // signing-ключ устройства из каталога
        auto firstDevice = SigningKey::generate(); // ключ первого устройства в identity
        auto sink = std::make_shared<Sink>();
        CallSession::Callbacks cb;
        cb.sendSignal = [sink](json j) { (*sink)(std::move(j)); };
        cb.peerPubkey = [] { return std::string(); };
        cb.sign = [&](const std::string &data) { return deviceKey.sign(data); };
        CallSession s("bob@l", "alice@l", &callKey, std::make_unique<FakeMedia>(),
                      std::move(cb));
        s.start("audio");
        const json *inv = sink->last("invite");
        check(inv != nullptr, "sign-колбэк: invite отправлен");
        if (inv) {
            const auto data = callSignedData(s.callId(), "OFFER-SDP");
            check(crypto::verify(deviceKey.publicB64(), data, inv->value("sig", "")),
                  "sign-колбэк: invite подписан ключом устройства");
            check(!crypto::verify(callKey.publicB64(), data, inv->value("sig", "")),
                  "sign-колбэк: ключ звонков не использован");
            // Принимающая сторона: в identity ключ первого устройства, ключ
            // второго — только среди устройств → подпись принята.
            auto sink2 = std::make_shared<Sink>();
            CallSession::Callbacks rcb;
            rcb.sendSignal = [sink2](json j) { (*sink2)(std::move(j)); };
            rcb.peerPubkey = [&] { return firstDevice.publicB64(); };
            rcb.peerPubkeys = [&] {
                return std::vector<std::string>{deviceKey.publicB64()};
            };
            auto peerKey = SigningKey::generate();
            CallSession r("alice@l", "bob@l", &peerKey, std::make_unique<FakeMedia>(),
                          std::move(rcb));
            r.onSignal(CallSignalIn::fromJson(*inv));
            check(r.state() == CallState::Incoming && r.peerAuth() == PeerAuth::Verified,
                  "подпись второго устройства принята по ключу из списка устройств");
        }
        // Пустой ответ колбэка → подписывает key (первое устройство, обычный путь).
        auto sink3 = std::make_shared<Sink>();
        CallSession::Callbacks cb3;
        cb3.sendSignal = [sink3](json j) { (*sink3)(std::move(j)); };
        cb3.sign = [](const std::string &) { return std::string(); };
        CallSession s3("bob@l", "alice@l", &callKey, std::make_unique<FakeMedia>(),
                       std::move(cb3));
        s3.start("audio");
        const json *inv3 = sink3->last("invite");
        check(inv3 && crypto::verify(callKey.publicB64(),
                                     callSignedData(s3.callId(), "OFFER-SDP"),
                                     inv3->value("sig", "")),
              "пустой sign-колбэк → подпись ключом звонков");
    }

    {
        // CALL-1: один формат ICE-кандидата для всех клиентов, приём прежних видов.
        const parvane::IceCandidate c{"candidate:1 1 udp 2122260223 127.0.0.1 5000 typ host", "0", 0};
        const auto j = json::parse(parvane::iceCandidateJson(c));
        check(j.value("candidate", "") == c.sdp && j.value("sdp_mid", "") == "0" && j.value("sdp_mline_index", -1) == 0,
              "CALL-1: канонические поля candidate/sdp_mid/sdp_mline_index");
        check(j.value("sdpMid", "") == "0" && j.value("sdpMLineIndex", -1) == 0 && j.value("sdp", "") == c.sdp
                  && j.value("mid", "") == "0" && j.value("idx", -1) == 0,
              "CALL-1: прежние имена web и desktop рядом");
        const auto web = parvane::parseIceCandidate(
            R"({"candidate":"candidate:w","sdpMid":"audio","sdpMLineIndex":1,"usernameFragment":"ab"})");
        check(web && web->sdp == "candidate:w" && web->mid == "audio" && web->mlineIndex == 1, "CALL-1: разбор вида web");
        const auto old = parvane::parseIceCandidate(R"({"sdp":"candidate:d","mid":"0","idx":0})");
        check(old && old->sdp == "candidate:d" && old->mid == "0" && old->mlineIndex == 0, "CALL-1: разбор прежнего вида desktop");
        const auto canon = parvane::parseIceCandidate(R"({"candidate":"candidate:c","sdp_mid":"1","sdp_mline_index":2})");
        check(canon && canon->mid == "1" && canon->mlineIndex == 2, "CALL-1: разбор канонического вида");
        check(!parvane::parseIceCandidate("cand-plain") && !parvane::parseIceCandidate(R"({"sdpMid":"0"})"),
              "CALL-1: не JSON и объект без кандидата отвергаются");
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
