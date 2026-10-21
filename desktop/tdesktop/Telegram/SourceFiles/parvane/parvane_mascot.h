// Parvane fork: маскот Parvane — пиксельный дух вместо кружка загрузки (spec 030, AUDIT «Загрузка»; порт web
// `components/ui/ParvaneMascot.tsx` + `ui/Loading.tsx`). Кадры web берёт из листа `mascot-ghost.png`, который рисует
// `web/dev/gen_mascot.mjs`; здесь тот же рисунок строится в коде: 16 кадров 24×24, 2 с на круг, пиксели без
// сглаживания, сторона 3rem. Цвета — палитра листа web (дух одинаков во всех схемах и режимах, как в web).
// «Отключить анимацию» tdesktop (`anim::Disabled()`, аналог `prefers-reduced-motion`) — стоит на первом кадре.
#pragma once

#include "ui/rp_widget.h"
#include "base/timer.h"

namespace Parvane {

// Индикатор загрузки (web `.Loading`): маскот по центру своего прямоугольника, мышь проходит насквозь.
// Высота для раскладок (resizeToWidth) — `height`, по умолчанию сторона маскота.
class Mascot final : public Ui::RpWidget {
public:
	explicit Mascot(QWidget *parent, int height = 0);

	// Сторона маскота: 3rem (`--mascot-size`), кратная сетке кадра 24, чтобы пиксели были ровными
	[[nodiscard]] static int Side();

	void setNaturalHeight(int height);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	void showEvent(QShowEvent *e) override;
	void hideEvent(QHideEvent *e) override;
	QAccessible::Role accessibilityRole() override;
	QString accessibilityName() override;

private:
	void restartTimer();

	int _height = 0;
	base::Timer _timer;

};

} // namespace Parvane
