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
#include <QtCore/QTimer>
#include <QtCore/QDateTime>
#include <memory>

namespace Parvane {

// Определены в parvane_client.cpp — управление текущим звонком из кнопок окна.
void HangupCall();
void ToggleMute(bool muted);

namespace {

class CallWindow final : public QWidget {
public:
	CallWindow(QString peer, bool video) : _peer(std::move(peer)), _video(video) {
		setWindowTitle(QString::fromUtf8("Parvane — звонок"));
		resize(_video ? 720 : 360, _video ? 560 : 180);
		_mute = new QPushButton(QString::fromUtf8("Заглушить"), this);
		_hangup = new QPushButton(QString::fromUtf8("Завершить"), this);
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

protected:
	void resizeEvent(QResizeEvent *) override { layoutButtons(); }
	void paintEvent(QPaintEvent *) override {
		QPainter p(this);
		p.fillRect(rect(), QColor(24, 24, 24));
		const QRect videoArea(0, 0, width(), height() - 48);
		if (_video && !_remote.isNull()) {
			p.drawImage(videoArea, _remote);
		}
		// self-preview (своя камера) — маленькая врезка снизу справа
		if (_video && !_local.isNull()) {
			const int pw = width() / 4;
			const int ph = pw * 3 / 4;
			p.drawImage(QRect(width() - pw - 10, videoArea.bottom() - ph - 10,
				pw, ph), _local);
		}
		// Оверлей: собеседник + таймер + SAS
		const auto secs = QDateTime::currentSecsSinceEpoch() - _start;
		auto title = (_peer.isEmpty() ? QString::fromUtf8("Звонок") : _peer)
			+ QString::asprintf("   %02lld:%02lld", secs / 60, secs % 60);
		if (!_sas.isEmpty()) {
			title += QString::fromUtf8("\nКод сверки: ") + _sas;
		}
		p.setPen(Qt::white);
		p.drawText(videoArea.adjusted(10, 8, -10, -8),
			Qt::AlignTop | Qt::AlignLeft, title);
	}

private:
	void layoutButtons() {
		const int bw = 150, bh = 32, y = height() - 40;
		_mute->setGeometry(width() / 2 - bw - 6, y, bw, bh);
		_hangup->setGeometry(width() / 2 + 6, y, bw, bh);
	}
	void toggleMute() {
		_muted = !_muted;
		Parvane::ToggleMute(_muted);
		_mute->setText(_muted
			? QString::fromUtf8("Включить")
			: QString::fromUtf8("Заглушить"));
	}
	QString _peer, _sas;
	bool _video = false;
	bool _muted = false;
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

void CloseVideoWindow() {
	crl::on_main([] {
		if (g_window) {
			g_window->close();
			g_window.reset();
		}
	});
}

} // namespace Parvane
