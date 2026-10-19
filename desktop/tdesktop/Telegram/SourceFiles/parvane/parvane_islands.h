// Parvane fork: острова мессенджера «Пространство» (spec 029, T054/T057) — как web «Панели»: фон окна `--pv-bg`,
// колонки (список чатов, чат, сведения) скруглёнными островами с промежутками и лёгкой тенью
// (`--border-radius-island`, `--shadow-island`), шапка чата и композер — острова над плоским фоном чата.
// Штатные виджеты tdesktop не перерисовываются: колонки ставятся с отступами, а углы скругляют маленькие
// виджеты-уголки поверх них, закрашенные цветом того, что лежит снаружи дуги.
#pragma once

#include "base/unique_qptr.h"
#include "ui/rp_widget.h"

#include <QtGui/QColor>

#include <array>
#include <optional>
#include <vector>

class QPainter;

namespace Ui {
class ScrollArea;
class VerticalLayout;
} // namespace Ui

namespace Parvane::Islands {

// Промежуток между островами и до края окна (`.root` разделов: 0.5rem), 0 — острова выключены.
[[nodiscard]] int Gap();
// `--border-radius-island` (1.5rem), как у островов разделов.
[[nodiscard]] int Radius();
// Цвет плоского фона чата: одноцветные обои (у схем, кроме «Telegram», — `--pv-bg`); nullopt — узор/картинка.
[[nodiscard]] std::optional<QColor> FlatChatColor();

enum Corner {
	TopLeft = 0x01,
	TopRight = 0x02,
	BottomLeft = 0x04,
	BottomRight = 0x08,
	AllCorners = 0x0F,
};

// Четыре уголка radius×radius над соседями в родителе: снаружи дуги — цвет color(). Прозрачны для мыши.
class Corners final {
public:
	Corners(not_null<QWidget*> parent, Fn<QColor()> color);

	// rect — в координатах родителя; corners — какие углы скруглять; пустой rect — спрятать все
	void setGeometry(QRect rect, int corners = AllCorners);
	void setShown(bool shown);
	void raise();
	void repaint();

private:
	const not_null<QWidget*> _parent;
	const Fn<QColor()> _color;
	std::array<base::unique_qptr<Ui::RpWidget>, 4> _widgets;
	int _mask = AllCorners;
	bool _shown = true;
	QRect _rect;

};

// Острова колонок MainWidget: фон промежутков с тенями (paint из paintEvent родителя) и уголки поверх колонок.
class Frame final {
public:
	explicit Frame(not_null<Ui::RpWidget*> parent);

	void setIslands(std::vector<QRect> islands); // пусто — островов нет (одна колонка)
	void raise();
	void paint(QPainter &p, QRect clip) const;

	[[nodiscard]] bool active() const {
		return !_islands.empty();
	}

private:
	const not_null<Ui::RpWidget*> _parent;
	std::vector<QRect> _islands;
	std::vector<std::unique_ptr<Corners>> _corners;
	rpl::lifetime _lifetime;

};

// Шапка чата и композер островами: нижние углы шапки (с полосами над лентой) и верхние углы композера над
// плоским фоном чата. scroll — лента сообщений: шапка кончается у её верха, композер начинается у её низа.
class ChatCorners final {
public:
	ChatCorners(not_null<Ui::RpWidget*> parent, not_null<Ui::ScrollArea*> scroll);

	void refresh(); // после перестройки виджетов: поднять уголки наверх

private:
	void update();

	const not_null<Ui::RpWidget*> _parent;
	const not_null<Ui::ScrollArea*> _scroll;
	Corners _top;
	Corners _bottom;
	rpl::lifetime _lifetime;

};

// Профиль-хаб (T057): карточка — остров `--pv-panel` со скруглением 1rem и полями, внутри строки штатных
// кнопок настроек. Возвращает раскладку, куда добавлять строки; сама карточка добавлена в container.
[[nodiscard]] not_null<Ui::VerticalLayout*> AddCard(not_null<Ui::VerticalLayout*> container);
// Подпись над карточкой (`.caption`: 0.8125rem, `--pv-muted`, полужирная).
void AddCardCaption(not_null<Ui::VerticalLayout*> container, rpl::producer<QString> text);
// Фон страницы с карточками — `--pv-bg`.
void PaintPageBackground(not_null<Ui::RpWidget*> page);

} // namespace Parvane::Islands
