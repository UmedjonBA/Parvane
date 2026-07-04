// Parvane fork: реализация нативного экрана звонка (parvane_call_panel.h).
// Собран из родных виджетов tdesktop: Calls::Userpic (аватар как в Telegram),
// Ui::CallButton (кнопки mute/hangup со стилями calls.style), Ui::FlatLabel
// (имя/статус). Видео пока рисуем ARGB-кадром в теле панели (следующий шаг —
// нативный Calls::VideoBubble через Webrtc::VideoTrack).
#include "parvane/parvane_call_panel.h"

#include "ui/rp_widget.h"
#include "ui/gl/gl_window.h"          // Ui::GL::Window — независимое окно как у Calls::Panel
#include "ui/widgets/rp_window.h"     // Ui::RpWindow
#include "ui/widgets/call_button.h"
#include "ui/widgets/labels.h"
#include "calls/calls_userpic.h"
#include "calls/calls_video_bubble.h" // нативный рендер видео-трека
#include "parvane/parvane_call_video.h" // общие видео-треки звонка
#include "webrtc/webrtc_video_track.h"
#include "data/data_peer.h"
#include "base/debug_log.h"
#include "base/event_filter.h"        // close → hangup
#include "styles/style_calls.h"

#include <QtGui/QWindow>
#include <QtCore/QEvent>

#include <crl/crl_on_main.h>
#include <rpl/rpl.h>
#include <rpl/variable.h>
#include <QtGui/QPainter>
#include <QtCore/QTimer>
#include <QtCore/QDateTime>
#include <memory>

namespace Parvane {

// Управление текущим звонком из кнопок (определены в parvane_client.cpp).
void HangupCall();
void AcceptCall();
void ToggleMute(bool muted);

namespace {

class CallPanel final {
public:
	CallPanel(not_null<PeerData*> peer, bool video, bool incoming);

	void setConnected();
	void setSas(const QString &sas);

private:
	void layout();
	void paintBody(QPainter &p);
	void refreshStatus();
	void switchToActive(); // входящий → активный (после «Ответить»/соединения)

	Ui::GL::Window _gl;
	Ui::FlatLabel _name;
	Ui::FlatLabel _status;
	Ui::FlatLabel _fingerprint;
	Ui::CallButton _mute;
	Ui::CallButton _hangup;
	Ui::CallButton _answer;   // входящий: «Ответить» (зелёная)
	Ui::CallButton _decline;  // входящий: «Отклонить» (красная)
	std::unique_ptr<Calls::Userpic> _userpic;
	std::unique_ptr<Calls::VideoBubble> _remoteVideo; // видео собеседника (нативно)
	std::unique_ptr<Calls::VideoBubble> _localVideo;  // своя камера (self-preview)
	rpl::variable<bool> _muted = false;
	QTimer _timer;
	bool _video = false;
	bool _incoming = false;
	bool _connected = false;
	qint64 _start = 0;
};

CallPanel::CallPanel(not_null<PeerData*> peer, bool video, bool incoming)
: _name(_gl.widget(), st::callName)
, _status(_gl.widget(), st::callStatus)
, _fingerprint(_gl.widget(), st::callStatus)
, _mute(_gl.widget(), st::callMicrophoneMute, &st::callMicrophoneUnmute)
, _hangup(_gl.widget(), st::callHangup)
, _answer(_gl.widget(), st::callAnswer)
, _decline(_gl.widget(), st::callHangup)
, _video(video)
, _incoming(incoming)
, _start(QDateTime::currentSecsSinceEpoch()) {
	const auto win = _gl.window();
	const auto body = _gl.widget();
	_userpic = std::make_unique<Calls::Userpic>(body, peer, _muted.value());

	win->setTitle(QString::fromUtf8("Parvane — звонок"));
	// Своё окно звонка — НИКОГДА не гасит приложение при закрытии (иначе закрылось
	// бы и главное окно). Закрытие крестиком = завершить звонок.
	win->setAttribute(Qt::WA_QuitOnClose, false);
	// Размер как у родной панели звонка Telegram (calls.style).
	win->resize(st::callWidth, st::callHeight);
	base::install_event_filter(win, [](not_null<QEvent*> e) {
		if (e->type() == QEvent::Close) {
			Parvane::HangupCall();
			Parvane::CloseNativeCallPanel();
		}
		return base::EventFilterResult::Continue;
	});

	_name.setText(peer->name());
	_status.setText(_incoming
		? (_video ? QString::fromUtf8("Входящий видеозвонок")
			: QString::fromUtf8("Входящий звонок"))
		: QString::fromUtf8("Вызов…"));

	// Активные кнопки (mute/hangup) и входящие (answer/decline) — показываем нужную
	// пару по режиму.
	_mute.setVisible(!_incoming);
	_hangup.setVisible(!_incoming);
	_answer.setVisible(_incoming);
	_decline.setVisible(_incoming);

	_mute.setClickedCallback([this] {
		_muted = !_muted.current();
		Parvane::ToggleMute(_muted.current());
	});
	// Отбой/отклонение: завершаем звонок И сразу закрываем окно (не ждём Ended —
	// если звонок так и не соединился, состояние могло застрять). CloseNativeCallPanel
	// отложен через crl::on_main, поэтому безопасно звать из обработчика кнопки.
	const auto endAndClose = [] {
		Parvane::HangupCall();
		Parvane::CloseNativeCallPanel();
	};
	_hangup.setClickedCallback(endAndClose);
	_decline.setClickedCallback(endAndClose);
	_answer.setClickedCallback([this] {
		Parvane::AcceptCall();
		switchToActive();
	});

	// Видео — нативный Calls::VideoBubble поверх общих видео-треков звонка (кадры
	// туда кладёт webrtc-бэкенд). Треки уже созданы в OpenNativeCallPanel.
	if (_video) {
		if (const auto rt = Parvane::CallRemoteVideoTrack()) {
			_remoteVideo = std::make_unique<Calls::VideoBubble>(body, rt);
		}
		if (const auto lt = Parvane::CallLocalVideoTrack()) {
			_localVideo = std::make_unique<Calls::VideoBubble>(body, lt);
		}
	}

	body->paintRequest() | rpl::on_next([this, body](QRect) {
		QPainter p(body);
		paintBody(p);
	}, body->lifetime());
	body->sizeValue() | rpl::on_next([this](QSize) {
		layout();
	}, body->lifetime());

	_timer.callOnTimeout([this] { refreshStatus(); });
	_timer.start(1000);

	layout();
	win->show();
	win->raise();
	win->activateWindow();
}

void CallPanel::paintBody(QPainter &p) {
	// Фон; аватар и видео (Calls::Userpic/VideoBubble) — самостоятельные виджеты.
	p.fillRect(_gl.widget()->rect(), QColor(0x14, 0x16, 0x1c));
}

void CallPanel::layout() {
	const auto w = _gl.widget()->width();
	const auto h = _gl.widget()->height();
	// Позиции берём из общего стиля родной панели звонка (calls.style).
	const auto &body = st::callBodyLayout;
	// Область кнопок снизу; тело (аватар/имя/статус) центрируем над ней.
	const int buttonsArea = 128;
	const int available = std::max(0, h - buttonsArea);
	const int bodyTop = std::max(0, (available - body.height) / 2);

	// Есть ли реально удалённое видео (иначе — аватар даже в видеозвонке).
	const auto remoteVideo = _remoteVideo
		&& Parvane::CallRemoteVideoTrack()
		&& (Parvane::CallRemoteVideoTrack()->state()
			!= Webrtc::VideoState::Inactive);
	if (remoteVideo) {
		// Видео собеседника — на всё окно; элементы поверх.
		_userpic->setVisible(false);
		_remoteVideo->updateGeometry(
			Calls::VideoBubble::DragMode::None,
			QRect(0, 0, w, h));
	} else {
		_userpic->setVisible(true);
		_userpic->setGeometry(
			(w - body.photoSize) / 2,
			bodyTop + body.photoTop,
			body.photoSize);
		_userpic->setMuteLayout(
			body.mutePosition,
			body.muteSize,
			body.muteStroke);
	}
	// Своя камера — небольшая врезка снизу справа (self-preview).
	if (_localVideo) {
		const int pw = w / 5, ph = pw * 3 / 4;
		_localVideo->updateGeometry(
			Calls::VideoBubble::DragMode::None,
			QRect(w - pw - 16, h - buttonsArea - ph - 16, pw, ph));
	}
	// Имя + статус — на тех же вертикалях, что в оригинале (nameTop/statusTop).
	_name.resizeToWidth(w);
	_name.move(0, bodyTop + body.nameTop);
	_status.resizeToWidth(w);
	_status.move(0, bodyTop + body.statusTop);
	// SAS-код (сверка) — верхняя часть панели.
	_fingerprint.resizeToWidth(w);
	_fingerprint.move(0, 16);
	// Кнопки в ряд по центру снизу: активные (mute|hangup) или входящие
	// (decline|answer) — родные CallButton со стилями calls.style.
	auto *const left = _incoming
		? static_cast<Ui::CallButton*>(&_decline)
		: static_cast<Ui::CallButton*>(&_mute);
	auto *const right = _incoming
		? static_cast<Ui::CallButton*>(&_answer)
		: static_cast<Ui::CallButton*>(&_hangup);
	const int by = h - right->height() - 40;
	const int gap = 56;
	left->move(w / 2 - left->width() - gap / 2, by);
	right->move(w / 2 + gap / 2, by);
}

void CallPanel::switchToActive() {
	if (!_incoming) {
		return;
	}
	_incoming = false;
	_answer.setVisible(false);
	_decline.setVisible(false);
	_mute.setVisible(true);
	_hangup.setVisible(true);
	_status.setText(QString::fromUtf8("Соединение…"));
	layout();
}

void CallPanel::refreshStatus() {
	if (_connected) {
		const auto secs = QDateTime::currentSecsSinceEpoch() - _start;
		_status.setText(QString::asprintf("%02lld:%02lld", secs / 60, secs % 60));
	}
	_gl.widget()->update();
}

void CallPanel::setConnected() {
	switchToActive();
	_connected = true;
	_start = QDateTime::currentSecsSinceEpoch();
	refreshStatus();
}

void CallPanel::setSas(const QString &sas) {
	_fingerprint.setText(sas); // ряд эмодзи для сверки (как отпечаток в оригинале)
	layout();
}

std::unique_ptr<CallPanel> g_panel;

} // namespace

void OpenNativeCallPanel(PeerData *peer, bool video, bool incoming) {
	if (!peer) {
		return;
	}
	const auto raw = peer;
	crl::on_main([raw, video, incoming] {
		if (!g_panel) {
			Parvane::CreateCallVideoTracks(); // до панели — VideoBubble берёт треки
			g_panel = std::make_unique<CallPanel>(raw, video, incoming);
			LOG(("Parvane: нативный экран звонка открыт (%1)")
				.arg(incoming ? "входящий" : "исходящий"));
		}
	});
}

void NativeCallConnected() {
	crl::on_main([] { if (g_panel) g_panel->setConnected(); });
}

void NativeCallSas(const std::string &sas) {
	const auto s = QString::fromStdString(sas);
	crl::on_main([s] { if (g_panel) g_panel->setSas(s); });
}

void CloseNativeCallPanel() {
	crl::on_main([] {
		g_panel = nullptr;
		Parvane::ResetCallVideoTracks(); // после панели (VideoBubble уже разрушен)
	});
}

} // namespace Parvane
