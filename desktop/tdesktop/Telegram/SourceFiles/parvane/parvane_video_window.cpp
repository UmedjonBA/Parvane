// Parvane fork: реализация окна активного звонка (parvane_video_window.h).
// Таймер длительности, кнопки Заглушить/Завершить, удалённое видео + self-preview,
// SAS-код. Qt-only; webrtc-бэкенд шлёт готовые ARGB-кадры.
#include "parvane/parvane_video_window.h"

#include "base/debug_log.h"

#include <crl/crl_on_main.h>
#include <QtWidgets/QWidget>
#include <QtWidgets/QPushButton>
#include <QtGui/QPainter>
#include <QtGui/QImage>
#include <QtGui/QBrush>
#include <QtGui/QLinearGradient>
#include <QtCore/QTimer>
#include <QtCore/QDateTime>
#include <memory>

namespace Parvane {

// Определены в parvane_client.cpp — управление текущим звонком из кнопок окна.
void HangupCall();
void ToggleMute(bool muted);

namespace {

// Имя для показа: локальная часть адреса до '@'.
[[nodiscard]] QString displayName(const QString &peer) {
	if (peer.isEmpty()) {
		return QString::fromUtf8("Звонок");
	}
	const auto at = peer.indexOf('@');
	return (at > 0) ? peer.left(at) : peer;
}

// Стабильный цвет аватара по строке.
[[nodiscard]] QColor avatarColor(const QString &s) {
	static const QColor kPalette[] = {
		QColor(0xE1, 0x7C, 0x76), QColor(0xF2, 0xA8, 0x5D),
		QColor(0x7C, 0xB3, 0x42), QColor(0x53, 0xB0, 0xC6),
		QColor(0x5D, 0x8B, 0xD6), QColor(0x9B, 0x7E, 0xD6),
		QColor(0xD6, 0x7E, 0xB0),
	};
	uint h = 0;
	for (const auto ch : s) {
		h = h * 31 + ch.unicode();
	}
	return kPalette[h % (sizeof(kPalette) / sizeof(kPalette[0]))];
}

class CallWindow final : public QWidget {
public:
	CallWindow(QString peer, bool video) : _peer(std::move(peer)), _video(video) {
		setWindowTitle(QString::fromUtf8("Parvane — звонок"));
		resize(400, _video ? 600 : 460);
		setMinimumSize(320, 380);
		auto roundBtn = [](const QString &bg) {
			return QString::fromUtf8(
				"QPushButton{color:white;border:none;border-radius:26px;"
				"font-size:13px;background:%1;}"
				"QPushButton:hover{background:%2;}")
				.arg(bg, bg);
		};
		_mute = new QPushButton(QString::fromUtf8("🔇"), this);
		_hangup = new QPushButton(QString::fromUtf8("⛔"), this);
		_mute->setStyleSheet(roundBtn(QString::fromUtf8("#3a3a3f")));
		_hangup->setStyleSheet(roundBtn(QString::fromUtf8("#e0453a")));
		_mute->setCursor(Qt::PointingHandCursor);
		_hangup->setCursor(Qt::PointingHandCursor);
		connect(_mute, &QPushButton::clicked, this, [this] { toggleMute(); });
		connect(_hangup, &QPushButton::clicked, this, [] { Parvane::HangupCall(); });
		_start = QDateTime::currentSecsSinceEpoch();
		_timer = new QTimer(this);
		connect(_timer, &QTimer::timeout, this, [this] { update(); });
		_timer->start(1000);
		layoutButtons();
	}
	void setRemote(QImage img) { _remote = std::move(img); update(); }
	void setLocal(QImage img) { _local = std::move(img); update(); }
	void setSas(QString sas) { _sas = std::move(sas); update(); }
	void setConnected() { _connected = true; _start = QDateTime::currentSecsSinceEpoch(); update(); }

protected:
	void resizeEvent(QResizeEvent *) override { layoutButtons(); }
	void paintEvent(QPaintEvent *) override {
		QPainter p(this);
		p.setRenderHint(QPainter::Antialiasing);
		// Тёмный вертикальный градиент.
		QLinearGradient g(0, 0, 0, height());
		g.setColorAt(0, QColor(0x2b, 0x2f, 0x3a));
		g.setColorAt(1, QColor(0x14, 0x16, 0x1c));
		p.fillRect(rect(), g);

		const auto name = displayName(_peer);
		// Видео на весь экран, если есть удалённый кадр.
		if (_video && !_remote.isNull()) {
			p.drawImage(rect(), _remote);
			if (!_local.isNull()) {
				const int pw = width() / 4, ph = pw * 3 / 4;
				p.drawImage(QRect(width() - pw - 12, 12, pw, ph), _local);
			}
		} else {
			// Аватар-кружок с инициалом по центру сверху.
			const int d = 120;
			const int cx = width() / 2, cy = height() / 2 - 60;
			p.setBrush(avatarColor(_peer));
			p.setPen(Qt::NoPen);
			p.drawEllipse(QPoint(cx, cy), d / 2, d / 2);
			auto initF = p.font();
			initF.setPixelSize(52);
			p.setFont(initF);
			p.setPen(Qt::white);
			p.drawText(QRect(cx - d / 2, cy - d / 2, d, d), Qt::AlignCenter,
				name.left(1).toUpper());
		}

		// Имя.
		p.setPen(Qt::white);
		auto nameF = p.font();
		nameF.setPixelSize(22);
		nameF.setBold(true);
		p.setFont(nameF);
		const int nameY = _video ? 24 : (height() / 2 + 20);
		p.drawText(QRect(0, nameY, width(), 30), Qt::AlignHCenter | Qt::AlignTop,
			name);

		// Статус: «Вызов…» / таймер.
		auto statusF = p.font();
		statusF.setPixelSize(14);
		statusF.setBold(false);
		p.setFont(statusF);
		p.setPen(QColor(0xb8, 0xc0, 0xcc));
		QString status;
		if (_connected) {
			const auto secs = QDateTime::currentSecsSinceEpoch() - _start;
			status = QString::asprintf("%02lld:%02lld", secs / 60, secs % 60);
		} else {
			status = QString::fromUtf8("Вызов…");
		}
		p.drawText(QRect(0, nameY + 32, width(), 22),
			Qt::AlignHCenter | Qt::AlignTop, status);

		// SAS-код (сверка голосом).
		if (!_sas.isEmpty()) {
			p.drawText(QRect(0, nameY + 56, width(), 22),
				Qt::AlignHCenter | Qt::AlignTop,
				QString::fromUtf8("🔒 ") + _sas);
		}
	}

private:
	void layoutButtons() {
		const int d = 52, gap = 40, y = height() - d - 28;
		const int cx = width() / 2;
		_mute->setGeometry(cx - d - gap / 2, y, d, d);
		_hangup->setGeometry(cx + gap / 2, y, d, d);
	}
	void toggleMute() {
		_muted = !_muted;
		Parvane::ToggleMute(_muted);
		_mute->setText(_muted
			? QString::fromUtf8("🔈")
			: QString::fromUtf8("🔇"));
	}
	QString _peer, _sas;
	bool _video = false;
	bool _muted = false;
	bool _connected = false;
	QImage _remote, _local;
	QPushButton *_mute = nullptr;
	QPushButton *_hangup = nullptr;
	QTimer *_timer = nullptr;
	qint64 _start = 0;
};

std::unique_ptr<CallWindow> g_window;

// Гарантирует наличие окна (если бэкенд прислал кадр раньше OpenCallWindow).
CallWindow *ensureWindow(bool video) {
	if (!g_window) {
		g_window = std::make_unique<CallWindow>(QString(), video);
		g_window->show();
		LOG(("Parvane: окно звонка открыто"));
	}
	return g_window.get();
}

QImage frameToImage(int w, int h, const unsigned char *argb) {
	QImage img(reinterpret_cast<const uchar *>(argb), w, h,
		w * 4, QImage::Format_ARGB32);
	return img.copy();
}

} // namespace

void OpenCallWindow(const std::string &peer, bool video) {
	const auto p = QString::fromStdString(peer);
	crl::on_main([p, video] {
		if (!g_window) {
			g_window = std::make_unique<CallWindow>(p, video);
			g_window->show();
			LOG(("Parvane: окно звонка открыто (%1)").arg(p));
		}
	});
}

void ShowRemoteVideoFrame(int width, int height, const unsigned char *argb) {
	if (width <= 0 || height <= 0 || !argb) {
		return;
	}
	auto copy = frameToImage(width, height, argb);
	crl::on_main([copy = std::move(copy)]() mutable {
		ensureWindow(true)->setRemote(std::move(copy));
	});
}

void ShowLocalVideoFrame(int width, int height, const unsigned char *argb) {
	if (width <= 0 || height <= 0 || !argb) {
		return;
	}
	auto copy = frameToImage(width, height, argb);
	crl::on_main([copy = std::move(copy)]() mutable {
		if (g_window) {
			g_window->setLocal(std::move(copy));
		}
	});
}

void SetCallSasText(const std::string &sas) {
	const auto s = QString::fromStdString(sas);
	crl::on_main([s] {
		if (g_window) {
			g_window->setSas(s);
		}
	});
}

void SetCallConnected() {
	crl::on_main([] {
		if (g_window) {
			g_window->setConnected();
		}
	});
}

void CloseVideoWindow() {
	crl::on_main([] {
		if (g_window) {
			g_window->close();
			g_window.reset();
		}
	});
}

} // namespace Parvane
