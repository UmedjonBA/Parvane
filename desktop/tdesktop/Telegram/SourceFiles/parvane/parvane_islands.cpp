// Parvane fork: реализация parvane_islands.h. Размеры — из web: промежуток 0.5rem (`.root` разделов),
// `--border-radius-island` 1.5rem, `--shadow-island` 0 1px 4px #0000000D; карточки «Профиля» — 0.75rem, поля 0.375rem.
#include "parvane/parvane_islands.h"

#include "parvane/parvane_kit.h"
#include "parvane/parvane_space.h"

#include "ui/painter.h"
#include "ui/widgets/scroll_area.h"
#include "ui/wrap/vertical_layout.h"
#include "window/themes/window_theme.h"
#include "styles/style_basic.h"

#include <QtGui/QPainterPath>

namespace Parvane::Islands {
namespace {

// Мягкая тень острова: несколько колец с убывающей непрозрачностью, сдвиг вниз на dy
void PaintShadow(QPainter &p, const QRectF &rect, double radius, int spread, double alpha, int dy) {
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	for (auto i = spread; i > 0; --i) {
		const auto share = alpha * (spread - i + 1) / double(spread * (spread + 1) / 2);
		p.setBrush(QColor(0, 0, 0, std::clamp(int(std::round(255 * share)), 0, 255)));
		const auto r = rect.adjusted(-i, -i + dy, i, i + dy);
		p.drawRoundedRect(r, radius + i, radius + i);
	}
}

// Уголок: квадрат radius×radius, закрашенный снаружи четверти круга
class CornerWidget final : public Ui::RpWidget {
public:
	CornerWidget(QWidget *parent, int corner, Fn<QColor()> color)
	: RpWidget(parent)
	, _corner(corner)
	, _color(std::move(color)) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
		setAttribute(Qt::WA_NoSystemBackground);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		const auto r = width();
		if (r <= 0) {
			return;
		}
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto center = [&] {
			switch (_corner) {
			case TopLeft: return QPointF(r, r);
			case TopRight: return QPointF(0, r);
			case BottomLeft: return QPointF(r, 0);
			}
			return QPointF(0, 0);
		}();
		auto outside = QPainterPath();
		outside.addRect(QRectF(0, 0, r, r));
		auto circle = QPainterPath();
		circle.addEllipse(center, r, r);
		p.fillPath(outside.subtracted(circle), _color());
	}

private:
	const int _corner;
	const Fn<QColor()> _color;

};

constexpr auto kCornerBits = std::array<int, 4>{ TopLeft, TopRight, BottomLeft, BottomRight };

} // namespace

int Gap() {
	return Kit::Rem(0.5);
}

int Radius() {
	return Kit::Rem(1.5);
}

std::optional<QColor> FlatChatColor() {
	return Window::Theme::Background()->colorForFill();
}

Corners::Corners(not_null<QWidget*> parent, Fn<QColor()> color)
: _parent(parent)
, _color(std::move(color)) {
	for (auto i = 0; i != 4; ++i) {
		_widgets[i] = base::make_unique_q<CornerWidget>(_parent, kCornerBits[i], _color);
		_widgets[i]->hide();
	}
}

void Corners::setGeometry(QRect rect, int corners) {
	_rect = rect;
	_mask = corners;
	const auto r = std::min({ Radius(), rect.width() / 2, rect.height() / 2 });
	for (auto i = 0; i != 4; ++i) {
		const auto widget = _widgets[i].get();
		const auto bit = kCornerBits[i];
		if (!_shown || rect.isEmpty() || r <= 0 || !(_mask & bit)) {
			widget->hide();
			continue;
		}
		const auto left = (bit == TopLeft || bit == BottomLeft);
		const auto top = (bit == TopLeft || bit == TopRight);
		widget->setGeometry(
			left ? rect.x() : (rect.x() + rect.width() - r),
			top ? rect.y() : (rect.y() + rect.height() - r),
			r,
			r);
		widget->show();
		widget->raise();
	}
}

void Corners::setShown(bool shown) {
	if (_shown != shown) {
		_shown = shown;
		setGeometry(_rect, _mask);
	}
}

void Corners::raise() {
	for (const auto &widget : _widgets) {
		if (!widget->isHidden()) {
			widget->raise();
		}
	}
}

void Corners::repaint() {
	for (const auto &widget : _widgets) {
		widget->update();
	}
}

Frame::Frame(not_null<Ui::RpWidget*> parent)
: _parent(parent) {
	TonesChanges() | rpl::on_next([=] {
		for (const auto &corners : _corners) {
			corners->repaint();
		}
		_parent->update();
	}, _lifetime);
}

void Frame::setIslands(std::vector<QRect> islands) {
	if (_islands == islands) {
		raise();
		return;
	}
	_islands = std::move(islands);
	while (_corners.size() < _islands.size()) {
		_corners.push_back(std::make_unique<Corners>(_parent, [] {
			return ToneColor(Tone::Bg);
		}));
	}
	for (auto i = 0; i != int(_corners.size()); ++i) {
		_corners[i]->setGeometry((i < int(_islands.size())) ? _islands[i] : QRect());
	}
	_parent->update();
}

void Frame::raise() {
	for (const auto &corners : _corners) {
		corners->raise();
	}
}

void Frame::paint(QPainter &p, QRect clip) const {
	if (_islands.empty()) {
		return;
	}
	p.fillRect(clip, ToneColor(Tone::Bg));
	const auto radius = Radius();
	for (const auto &island : _islands) {
		if (!island.isEmpty()) {
			// `--shadow-island`: 0 1px 4px #0000000D
			PaintShadow(p, QRectF(island), radius, Kit::Px(3), 0.05, Kit::Px(1));
		}
	}
}

ChatCorners::ChatCorners(not_null<Ui::RpWidget*> parent, not_null<Ui::ScrollArea*> scroll)
: _parent(parent)
, _scroll(scroll)
, _top(parent, [] { return FlatChatColor().value_or(ToneColor(Tone::Bg)); })
, _bottom(parent, [] { return FlatChatColor().value_or(ToneColor(Tone::Bg)); }) {
	rpl::merge(
		_scroll->geometryValue() | rpl::to_empty,
		_scroll->shownValue() | rpl::to_empty,
		_parent->sizeValue() | rpl::to_empty
	) | rpl::on_next([=] {
		update();
	}, _lifetime);

	Window::Theme::Background()->updates(
	) | rpl::to_empty | rpl::on_next([=] {
		update();
		_top.repaint();
		_bottom.repaint();
	}, _lifetime);
}

void ChatCorners::refresh() {
	update();
}

void ChatCorners::update() {
	// Острова шапки и композера — только над одноцветным фоном: уголки закрашены его цветом
	const auto shown = !_scroll->isHidden() && FlatChatColor().has_value();
	_top.setShown(shown);
	_bottom.setShown(shown);
	if (!shown) {
		return;
	}
	const auto r = Radius();
	const auto width = _parent->width();
	const auto top = _scroll->y();
	const auto bottom = _scroll->y() + _scroll->height();
	_top.setGeometry(
		(top >= r) ? QRect(0, 0, width, top) : QRect(),
		BottomLeft | BottomRight);
	_bottom.setGeometry(
		(_parent->height() - bottom >= r)
			? QRect(0, bottom, width, _parent->height() - bottom)
			: QRect(),
		TopLeft | TopRight);
}

namespace {

// Карточка «Профиля»: `--pv-panel` на фоне `--pv-bg`, скругление 0.75rem, поля 0.375rem. Поля не меньше
// 0.3 радиуса — углы строк (они заливают фон прямоугольником) не выходят за скругление.
class Card final : public Ui::RpWidget {
public:
	explicit Card(QWidget *parent)
	: RpWidget(parent)
	, _inner(this) {
		Kit::RepaintOnTones(this);
		_inner->heightValue() | rpl::on_next([=](int height) {
			resize(width(), height + 2 * padding());
		}, lifetime());
	}

	[[nodiscard]] not_null<Ui::VerticalLayout*> inner() const {
		return _inner.data();
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto p = padding();
		_inner->resizeToWidth(std::max(newWidth - 2 * p, 0));
		_inner->moveToLeft(p, p, newWidth);
		return _inner->height() + 2 * p;
	}

	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Panel));
		const auto radius = Kit::Rem(0.75);
		p.drawRoundedRect(rect(), radius, radius);
	}

private:
	[[nodiscard]] static int padding() {
		return Kit::Rem(0.375);
	}

	object_ptr<Ui::VerticalLayout> _inner;

};

// `.caption`
class Caption final : public Ui::RpWidget {
public:
	Caption(QWidget *parent, rpl::producer<QString> text)
	: RpWidget(parent) {
		Kit::RepaintOnTones(this);
		std::move(text) | rpl::on_next([=](const QString &value) {
			_text = value;
			update();
		}, lifetime());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		return Kit::Rem(1.25);
	}

	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto font = Kit::Font(13);
		p.setFont(font);
		p.setPen(ToneColor(Tone::Muted));
		const auto available = width() - 2 * Kit::Rem(0.25);
		p.drawText(
			Kit::Rem(0.25),
			(height() - font->height) / 2 + font->ascent,
			font->elided(_text, std::max(available, 0)));
	}

private:
	QString _text;

};

} // namespace

not_null<Ui::VerticalLayout*> AddCard(not_null<Ui::VerticalLayout*> container) {
	// `.content`: поля 1rem, промежуток между карточками 0.75rem
	const auto side = Kit::Rem(1.);
	const auto card = container->add(
		object_ptr<Card>(container),
		QMargins(side, Kit::Rem(0.375), side, Kit::Rem(0.375)));
	return card->inner();
}

void AddCardCaption(not_null<Ui::VerticalLayout*> container, rpl::producer<QString> text) {
	const auto side = Kit::Rem(1.);
	container->add(
		object_ptr<Caption>(container, std::move(text)),
		QMargins(side, Kit::Rem(0.5), side, 0));
}

void PaintPageBackground(not_null<Ui::RpWidget*> page) {
	page->paintRequest() | rpl::on_next([=](QRect clip) {
		auto p = QPainter(page);
		p.fillRect(clip, ToneColor(Tone::Bg));
	}, page->lifetime());
	TonesChanges() | rpl::on_next([=] {
		page->update();
	}, page->lifetime());
}

} // namespace Parvane::Islands
