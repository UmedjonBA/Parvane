// Parvane fork: реализация parvane_mascot.h. Рисунок кадров — построчный порт `web/dev/gen_mascot.mjs` (сетка 24,
// палитра P, покачивание BOB/SWAY, ручки по очереди, подол волной, моргание на кадре 13, контур по 4 соседям);
// поменял рисунок в web — поменяй и здесь.
#include "parvane/parvane_mascot.h"

#include "parvane/parvane_kit.h"

#include "lang/lang_keys.h"
#include "ui/effects/animation_value.h"

#include <QtGui/QImage>
#include <QtGui/QPainter>

#include <array>
#include <cmath>

namespace Parvane {
namespace {

constexpr auto kGrid = 24;
constexpr auto kFrames = 16;
constexpr auto kFrameMs = crl::time(125); // `animation: mascot-play 2s steps(16)`

// Палитра листа web (`P` в gen_mascot.mjs)
constexpr auto kBody = QRgb(0xFFF6F2FF);
constexpr auto kLight = QRgb(0xFFFFFFFF);
constexpr auto kShade = QRgb(0xFFD6CCF7);
constexpr auto kLine = QRgb(0xFF5A48B8);
constexpr auto kEye = QRgb(0xFF2A2150);
constexpr auto kBlush = QRgb(0xFFF2A1C4);

constexpr auto kBob = std::array{ 0, -1, -1, 0, 0, 1, 1, 0 };
constexpr auto kSway = std::array{ -1, -1, 0, 1, 1, 1, 0, -1 };

using Grid = std::array<std::array<QRgb, kGrid>, kGrid>; // 0 — пусто (прозрачно)

[[nodiscard]] QImage DrawFrame(int frame) {
	auto g = Grid{};
	const auto put = [&](int x, int y, QRgb c) {
		if (x >= 0 && x < kGrid && y >= 0 && y < kGrid) {
			g[y][x] = c;
		}
	};
	const auto rect = [&](int x, int y, int w, int h, QRgb c) {
		for (auto j = 0; j < h; ++j) {
			for (auto i = 0; i < w; ++i) {
				put(x + i, y + j, c);
			}
		}
	};
	const auto f = frame % 8;
	const auto cx = 12 + kSway[f];
	const auto top = 4 + kBob[f];
	const auto half = 7;
	const auto height = 13;
	// Ручки: по очереди вверх
	rect(cx - 9, top + 8 + (f < 4 ? -2 : 0), 2, 2, kBody);
	rect(cx + 8, top + 8 + (f < 4 ? 0 : -2), 2, 2, kShade);
	// Купол
	const auto radius = half + 0.5;
	for (auto y = 0; y < height; ++y) {
		auto w = half;
		if (y < radius) {
			const auto dy = radius - y - 0.5;
			w = int(std::floor(std::sqrt(std::max(0., radius * radius - dy * dy))));
		}
		for (auto x = -w; x <= w; ++x) {
			put(cx + x, top + y, (x >= w - 1) ? kShade : kBody);
		}
	}
	// Блик слева сверху
	put(cx - 4, top + 2, kLight);
	put(cx - 5, top + 3, kLight);
	put(cx - 5, top + 4, kLight);
	// Подол волной
	for (auto x = -half; x <= half; ++x) {
		const auto len = (((x + half + frame) % 4) < 2) ? 2 : 1;
		for (auto k = 0; k < len; ++k) {
			put(cx + x, top + height + k, (x >= half - 1) ? kShade : kBody);
		}
	}
	// Лицо: моргание один раз за два круга
	const auto isBlink = (frame == 13);
	for (const auto dx : { -3, 2 }) {
		if (isBlink) {
			rect(cx + dx, top + 6, 2, 1, kEye);
		} else {
			rect(cx + dx, top + 5, 2, 3, kEye);
			put(cx + dx, top + 5, kLight);
		}
	}
	put(cx - 5, top + 8, kBlush);
	put(cx + 5, top + 8, kBlush);
	put(cx - 1, top + 9, kEye);
	put(cx, top + 9, kEye);
	// Контур: пустая клетка рядом с закрашенной
	const auto filled = [&](int x, int y) {
		return x >= 0 && x < kGrid && y >= 0 && y < kGrid && g[y][x] != 0;
	};
	auto result = QImage(kGrid, kGrid, QImage::Format_ARGB32_Premultiplied);
	result.fill(Qt::transparent);
	for (auto y = 0; y < kGrid; ++y) {
		for (auto x = 0; x < kGrid; ++x) {
			if (g[y][x]) {
				result.setPixel(x, y, g[y][x]);
			} else if (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1)) {
				result.setPixel(x, y, kLine);
			}
		}
	}
	return result;
}

[[nodiscard]] const std::array<QImage, kFrames> &Frames() {
	static const auto result = [] {
		auto frames = std::array<QImage, kFrames>();
		for (auto i = 0; i != kFrames; ++i) {
			frames[i] = DrawFrame(i);
		}
		return frames;
	}();
	return result;
}

[[nodiscard]] int CurrentFrame() {
	// Кадр — от общих часов: все маскоты на экране идут в такт, как один лист в web
	return anim::Disabled() ? 0 : int((crl::now() / kFrameMs) % kFrames);
}

} // namespace

Mascot::Mascot(QWidget *parent, int height)
: RpWidget(parent)
, _height(height)
, _timer([=] { update(); }) {
	setAttribute(Qt::WA_TransparentForMouseEvents);
	resize(Side(), height ? height : Side());
}

int Mascot::Side() {
	// 3rem, округлённое до целого числа клеток кадра
	return std::max(int(std::round(Kit::Rem(3) / double(kGrid))), 1) * kGrid;
}

void Mascot::setNaturalHeight(int height) {
	if (_height == height) {
		return;
	}
	_height = height;
	resizeToWidth(width());
}

int Mascot::resizeGetHeight(int newWidth) {
	return std::max(_height, Side());
}

void Mascot::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.setRenderHint(QPainter::SmoothPixmapTransform, false); // `image-rendering: pixelated`
	const auto side = Side();
	const auto target = QRect((width() - side) / 2, (height() - side) / 2, side, side);
	p.drawImage(target, Frames()[CurrentFrame()]);
}

void Mascot::restartTimer() {
	if (isVisible() && !anim::Disabled()) {
		if (!_timer.isActive()) {
			_timer.callEach(kFrameMs);
		}
	} else {
		_timer.cancel();
	}
}

void Mascot::showEvent(QShowEvent *e) {
	RpWidget::showEvent(e);
	restartTimer();
}

void Mascot::hideEvent(QHideEvent *e) {
	RpWidget::hideEvent(e);
	restartTimer();
}

QAccessible::Role Mascot::accessibilityRole() {
	return QAccessible::Role::ProgressBar; // web: role="progressbar" aria-busy
}

QString Mascot::accessibilityName() {
	return tr::lng_contacts_loading(tr::now);
}

} // namespace Parvane
