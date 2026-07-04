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
void ToggleMute(bool muted);

namespace {

class CallPanel final {
public:
	CallPanel(not_null<PeerData*> peer, bool video);

	void setConnected();
	void setSas(const QString &sas);
	void setRemote(QImage img);
	void setLocal(QImage img);

private:
	void layout();
	void paintBody(QPainter &p);
	void refreshStatus();

	Ui::GL::Window _gl;
	Ui::FlatLabel _name;
	Ui::FlatLabel _status;
	Ui::FlatLabel _fingerprint;
	Ui::CallButton _mute;
	Ui::CallButton _hangup;
	std::unique_ptr<Calls::Userpic> _userpic;
	rpl::variable<bool> _muted = false;
	QTimer _timer;
	bool _video = false;
	bool _connected = false;
	qint64 _start = 0;
	QImage _remote, _local;
};

CallPanel::CallPanel(not_null<PeerData*> peer, bool video)
: _name(_gl.widget(), st::callName)
, _status(_gl.widget(), st::callStatus)
, _fingerprint(_gl.widget(), st::callStatus)
, _mute(_gl.widget(), st::callMicrophoneMute, &st::callMicrophoneUnmute)
, _hangup(_gl.widget(), st::callHangup)
, _video(video)
, _start(QDateTime::currentSecsSinceEpoch()) {
	const auto win = _gl.window();
	const auto body = _gl.widget();
	_userpic = std::make_unique<Calls::Userpic>(body, peer, _muted.value());

	win->setTitle(QString::fromUtf8("Parvane — звонок"));
	// Своё окно звонка — НИКОГДА не гасит приложение при закрытии (иначе закрылось
	// бы и главное окно). Закрытие крестиком = завершить звонок.
	win->setAttribute(Qt::WA_QuitOnClose, false);
	win->resize(400, _video ? 600 : 460);
	base::install_event_filter(win, [](not_null<QEvent*> e) {
		if (e->type() == QEvent::Close) {
			Parvane::HangupCall();
		}
		return base::EventFilterResult::Continue;
	});

	_name.setText(peer->name());
	_status.setText(QString::fromUtf8("Вызов…"));

	_mute.setClickedCallback([this] {
		_muted = !_muted.current();
		Parvane::ToggleMute(_muted.current());
	});
	_hangup.setClickedCallback([] { Parvane::HangupCall(); });

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
	const auto body = _gl.widget();
	p.fillRect(body->rect(), QColor(0x14, 0x16, 0x1c));
	// Видео (если есть удалённый кадр) — на всю верхнюю часть.
	if (_video && !_remote.isNull()) {
		p.drawImage(body->rect(), _remote);
		if (!_local.isNull()) {
			const int pw = body->width() / 4, ph = pw * 3 / 4;
			p.drawImage(QRect(body->width() - pw - 12, 12, pw, ph), _local);
		}
	}
}

void CallPanel::layout() {
	const auto w = _gl.widget()->width();
	const auto h = _gl.widget()->height();
	// Аватар по центру верхней трети.
	const int ups = 160;
	_userpic->setGeometry((w - ups) / 2, h / 6, ups);
	// Имя + статус под аватаром.
	_name.resizeToWidth(w);
	_name.move(0, h / 6 + ups + 12);
	_status.resizeToWidth(w);
	_status.move(0, h / 6 + ups + 12 + _name.height() + 6);
	_fingerprint.resizeToWidth(w);
	_fingerprint.move(0, _status.y() + _status.height() + 8);
	// Кнопки внизу по центру.
	const int by = h - _hangup.height() - 32;
	const int gap = 40;
	_mute.move(w / 2 - _mute.width() - gap / 2, by);
	_hangup.move(w / 2 + gap / 2, by);
}

void CallPanel::refreshStatus() {
	if (_connected) {
		const auto secs = QDateTime::currentSecsSinceEpoch() - _start;
		_status.setText(QString::asprintf("%02lld:%02lld", secs / 60, secs % 60));
	}
	_gl.widget()->update();
}

void CallPanel::setConnected() {
	_connected = true;
	_start = QDateTime::currentSecsSinceEpoch();
	refreshStatus();
}

void CallPanel::setSas(const QString &sas) {
	_fingerprint.setText(QString::fromUtf8("🔒 ") + sas);
	layout();
}

void CallPanel::setRemote(QImage img) {
	_remote = std::move(img);
	_gl.widget()->update();
}

void CallPanel::setLocal(QImage img) {
	_local = std::move(img);
	_gl.widget()->update();
}

std::unique_ptr<CallPanel> g_panel;

QImage frameToImage(int w, int h, const unsigned char *argb) {
	QImage img(reinterpret_cast<const uchar *>(argb), w, h,
		w * 4, QImage::Format_ARGB32);
	return img.copy();
}

} // namespace

void OpenNativeCallPanel(PeerData *peer, bool video) {
	if (!peer) {
		return;
	}
	const auto raw = peer;
	crl::on_main([raw, video] {
		if (!g_panel) {
			g_panel = std::make_unique<CallPanel>(raw, video);
			LOG(("Parvane: нативный экран звонка открыт"));
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

void NativeCallRemoteFrame(int width, int height, const unsigned char *argb) {
	if (width <= 0 || height <= 0 || !argb) {
		return;
	}
	auto copy = frameToImage(width, height, argb);
	crl::on_main([copy = std::move(copy)]() mutable {
		if (g_panel) g_panel->setRemote(std::move(copy));
	});
}

void NativeCallLocalFrame(int width, int height, const unsigned char *argb) {
	if (width <= 0 || height <= 0 || !argb) {
		return;
	}
	auto copy = frameToImage(width, height, argb);
	crl::on_main([copy = std::move(copy)]() mutable {
		if (g_panel) g_panel->setLocal(std::move(copy));
	});
}

void CloseNativeCallPanel() {
	crl::on_main([] { g_panel = nullptr; });
}

} // namespace Parvane
