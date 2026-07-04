// Parvane fork: реализация parvane_video_window.h (Qt-отрисовка удалённого видео).
#include "parvane/parvane_video_window.h"

#include "base/debug_log.h"

#include <crl/crl_on_main.h>
#include <QtWidgets/QWidget>
#include <QtGui/QPainter>
#include <QtGui/QImage>
#include <memory>

namespace Parvane {
namespace {

class VideoWindow final : public QWidget {
public:
	VideoWindow() {
		setWindowTitle(QString::fromUtf8("Parvane — видео"));
		resize(640, 480);
	}
	void showFrame(QImage img) {
		_img = std::move(img);
		update();
	}

protected:
	void paintEvent(QPaintEvent *) override {
		QPainter p(this);
		if (_img.isNull()) {
			p.fillRect(rect(), Qt::black);
			return;
		}
		p.drawImage(rect(), _img);
	}

private:
	QImage _img;
};

std::unique_ptr<VideoWindow> g_window;

} // namespace

void ShowRemoteVideoFrame(int width, int height, const unsigned char *argb) {
	if (width <= 0 || height <= 0 || !argb) {
		return;
	}
	// Глубокая копия байтов в QImage на этом (webrtc) потоке; отрисовка — на main.
	QImage img(reinterpret_cast<const uchar *>(argb), width, height,
		width * 4, QImage::Format_ARGB32);
	auto copy = img.copy();
	crl::on_main([copy = std::move(copy)]() mutable {
		if (!g_window) {
			g_window = std::make_unique<VideoWindow>();
			g_window->show();
			LOG(("Parvane: окно удалённого видео открыто"));
		}
		g_window->showFrame(std::move(copy));
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
