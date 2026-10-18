// Parvane fork: реализация parvane_kit.h — основа, остров и шапка, кнопки, сегменты, чипы, строки, подписи,
// карточка. Прогресс, галочка, метки, образцы, поля, шторка, меню и ручка ширины — parvane_kit_extra.cpp.
// Размеры и тона — как в web PvKit.module.scss / Planner.module.scss (в комментариях — исходные rem).
#include "parvane/parvane_kit.h"

#include "parvane/parvane_icons.h"
#include "parvane/parvane_kit_internal.h"

#include "ui/painter.h"
#include "ui/qt_object_factory.h"
#include "ui/wrap/vertical_layout.h"
#include "base/algorithm.h"
#include "styles/style_basic.h"

#include <QtGui/QFontMetricsF>
#include <QtGui/QtEvents>

namespace Parvane::Kit {
namespace internal {

QColor Brighter(QColor color) {
	// `filter: brightness(1.06)`
	const auto channel = [](int value) {
		return std::min(255, int(std::round(value * 1.06)));
	};
	return QColor(channel(color.red()), channel(color.green()), channel(color.blue()), color.alpha());
}

void PaintIconOrFallback(QPainter &p, const QString &name, const QColor &color, int x, int y, int size) {
	if (name.isEmpty()) {
		return;
	} else if (HasIcon(name)) {
		PaintIcon(p, name, color, x, y, size);
		return;
	}
	// Значка закрытия в наборе ParvaneIcon нет — крест той же толщины линии (1.8 на 24)
	if (name == u"close"_q || name == u"x"_q) {
		PainterHighQualityEnabler hq(p);
		auto pen = QPen(color);
		pen.setWidthF(size * 1.8 / 24.);
		pen.setCapStyle(Qt::RoundCap);
		p.setPen(pen);
		const auto a = size * 6. / 24.;
		const auto b = size * 18. / 24.;
		p.drawLine(QPointF(x + a, y + a), QPointF(x + b, y + b));
		p.drawLine(QPointF(x + b, y + a), QPointF(x + a, y + b));
	}
}

int Baseline(const style::font &font, int top, int height) {
	return top + (height - font->height) / 2 + font->ascent;
}

void PaintDownOverlay(QPainter &p, const QRectF &rect, double radius) {
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(Mix(Tone::Fg, 0.08));
	p.drawRoundedRect(rect, radius, radius);
}

void PaintSoftShadow(QPainter &p, const QRectF &rect, double radius, int spread, double alpha, int dy) {
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	for (auto i = spread; i > 0; --i) {
		const auto share = alpha * (spread - i + 1) / double(spread * (spread + 1) / 2);
		p.setBrush(QColor(0, 0, 0, std::clamp(int(std::round(255 * share)), 0, 255)));
		const auto r = rect.adjusted(-i, -i + dy, i, i + dy);
		p.drawRoundedRect(r, radius + i, radius + i);
	}
}

} // namespace internal

using namespace internal;

// ── основа ───────────────────────────────────────────────────────────────────

int Px(int px) {
	return style::ConvertScale(px);
}

int Rem(double rem) {
	return int(std::round(style::ConvertScale(rem * 16.)));
}

style::font Font(int px, bool semibold, bool mono) {
	static auto cache = QHash<int, style::font>();
	const auto key = (px << 2) | (semibold ? 1 : 0) | (mono ? 2 : 0);
	const auto i = cache.find(key);
	if (i != cache.end()) {
		return i.value();
	}
	const auto flags = semibold ? style::FontFlags(style::FontFlag::Bold) : style::FontFlags();
	auto result = mono
		? style::font(Px(px), flags, u"JetBrains Mono"_q)
		: style::font(Px(px), flags, 0);
	cache.insert(key, result);
	return result;
}

QColor Mix(QColor color, double share) {
	color.setAlphaF(std::clamp(color.alphaF() * share, 0., 1.));
	return color;
}

QColor Mix(Tone tone, double share) {
	return Mix(ToneColor(tone), share);
}

void RepaintOnTones(not_null<Ui::RpWidget*> widget) {
	TonesChanges() | rpl::on_next([=] {
		widget->update();
	}, widget->lifetime());
}

void PaintDot(QPainter &p, QPoint center, QColor color, int size) {
	const auto side = size ? size : Rem(0.5);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(color);
	p.drawEllipse(QRectF(center.x() - side / 2., center.y() - side / 2., side, side));
}

int AvatarSide(AvatarSize size) {
	switch (size) {
	case AvatarSize::Medium: return Rem(2.25);
	case AvatarSize::Small: return Rem(2);
	case AvatarSize::Large: break;
	}
	return Rem(2.5);
}

void PaintAvatar(QPainter &p, QPoint topLeft, const Avatar &avatar) {
	const auto side = AvatarSide(avatar.size);
	const auto rect = QRectF(topLeft, QSizeF(side, side));
	const auto color = ToneColor(avatar.tone);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(Mix(color, 0.22));
	if (avatar.round) {
		p.drawEllipse(rect);
	} else {
		const auto radius = Rem(0.625);
		p.drawRoundedRect(rect, radius, radius);
	}
	const auto font = Font((avatar.size == AvatarSize::Small) ? 13 : 16, true, true);
	p.setFont(font->f);
	p.setPen(color);
	p.drawText(rect, Qt::AlignCenter, avatar.text);
}

// ── кнопка набора ────────────────────────────────────────────────────────────

Button::Button(QWidget *parent)
: AbstractButton(parent) {
	setFocusPolicy(Qt::TabFocus);
	RepaintOnTones(this);
}

void Button::setAccessibleName(const QString &name) {
	if (_accessibleName == name) {
		return;
	}
	_accessibleName = name;
	QWidget::setAccessibleName(name);
	accessibilityNameChanged();
}

QString Button::accessibilityName() {
	return _accessibleName;
}

void Button::onStateChanged(State was, StateChangeSource source) {
	update();
}

void Button::focusInEvent(QFocusEvent *e) {
	// `:focus-visible` — фокус пришёл не от мыши
	const auto reason = e->reason();
	if (reason != Qt::ActiveWindowFocusReason) {
		_focusVisible = (reason != Qt::MouseFocusReason) && (reason != Qt::PopupFocusReason);
	}
	AbstractButton::focusInEvent(e);
	update();
}

void Button::focusOutEvent(QFocusEvent *e) {
	if (e->reason() != Qt::ActiveWindowFocusReason) {
		_focusVisible = false;
	}
	AbstractButton::focusOutEvent(e);
	update();
}

void Button::paintFocusRing(QPainter &p, QRectF rect, double radius) const {
	if (!_focusVisible || !hasFocus()) {
		return;
	}
	PainterHighQualityEnabler hq(p);
	const auto stroke = double(Px(2));
	auto pen = QPen(ToneColor(Tone::Accent));
	pen.setWidthF(stroke);
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	const auto half = stroke / 2.;
	const auto inner = rect.adjusted(half, half, -half, -half);
	const auto r = std::max(radius - half, 0.);
	p.drawRoundedRect(inner, r, r);
}

// ── остров ───────────────────────────────────────────────────────────────────

Island::Island(QWidget *parent, int radius)
: RpWidget(parent)
, _radius(radius ? radius : Rem(1.5)) { // `--border-radius-island`
	RepaintOnTones(this);
}

QRect Island::innerRect() const {
	// Поле под тень `0 1px 4px #0000000D`
	const auto shadow = Px(2);
	return rect().marginsRemoved({ shadow, shadow, shadow, shadow + Px(1) });
}

void Island::setRadius(int radius) {
	_radius = radius;
	update();
}

void Island::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto inner = QRectF(innerRect());
	PaintSoftShadow(p, inner, _radius, Px(2), 0.05, Px(1));
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Panel));
	p.drawRoundedRect(inner, _radius, _radius);
}

// ── шапка ────────────────────────────────────────────────────────────────────

Header::Header(QWidget *parent, const QString &title, TitleSize size)
: RpWidget(parent)
, _title(title)
, _titleSize(size) {
	RepaintOnTones(this);
	resize(width(), Rem(3.75));
}

style::font Header::titleFont() const {
	return (_titleSize == TitleSize::Large)
		? Font(20, true) // `.hdrTitle` 1.25rem
		: Font(16, true); // `.hdrSmall` 1rem
}

void Header::setTitle(const QString &title) {
	_title = title;
	relayout();
}

void Header::setTitleSize(TitleSize size) {
	_titleSize = size;
	relayout();
}

int Header::titleWidth() const {
	return _title.isEmpty() ? 0 : titleFont()->width(_title);
}

Ui::RpWidget *Header::addItem(object_ptr<Ui::RpWidget> child, int basis, int minWidth) {
	const auto raw = child.release();
	raw->setParent(this);
	raw->show();
	_items.push_back({ raw, basis, minWidth });
	if (!basis) {
		raw->widthValue() | rpl::skip(1) | rpl::on_next([=] {
			relayout();
		}, raw->lifetime());
	}
	raw->heightValue() | rpl::skip(1) | rpl::on_next([=] {
		relayout();
	}, raw->lifetime());
	relayout();
	return raw;
}

void Header::addStretch() {
	_items.push_back({ nullptr, 0, 0 });
	relayout();
}

void Header::relayout() {
	if (width() > 0) {
		const auto h = resizeGetHeight(width());
		if (h != height()) {
			resize(width(), h);
		}
	}
	update();
}

int Header::resizeGetHeight(int newWidth) {
	const auto padX = Rem(1.125);
	const auto padY = Rem(0.75);
	const auto gap = Rem(0.875);
	const auto font = titleFont();
	const auto titleLine = int(std::round(font->f.pixelSize() * 1.45));

	// Ширины: название, элементы со своей шириной, сжимаемые (от basis до minWidth), растяжки
	const auto hasTitle = !_title.isEmpty();
	auto count = int(_items.size()) + (hasTitle ? 1 : 0);
	auto used = std::max(count - 1, 0) * gap;
	auto stretches = 0;
	auto shrinkTotal = 0;
	for (const auto &item : _items) {
		if (!item.widget) {
			++stretches;
		} else if (item.basis) {
			used += item.basis;
			shrinkTotal += std::max(item.basis - item.minWidth, 0);
		} else {
			used += item.widget->width();
		}
	}
	const auto available = std::max(newWidth - 2 * padX, 0);
	auto title = hasTitle ? titleWidth() : 0;
	auto extra = available - used - title;
	auto shrink = 0.;
	if (extra < 0 && shrinkTotal > 0) {
		shrink = std::min(1., -extra / double(shrinkTotal));
		extra = std::min(0, extra + int(std::round(shrinkTotal * shrink)));
	}
	if (extra < 0 && hasTitle) {
		title = std::max(title + extra, 0); // название сокращается многоточием
		extra = 0;
	}
	const auto stretch = (stretches && extra > 0) ? (extra / stretches) : 0;

	auto contentHeight = hasTitle ? titleLine : 0;
	for (const auto &item : _items) {
		if (item.widget && item.basis) {
			const auto w = item.basis
				- int(std::round(std::max(item.basis - item.minWidth, 0) * shrink));
			if (item.widget->width() != w) {
				item.widget->resizeToWidth(w);
			}
		}
		if (item.widget) {
			contentHeight = std::max(contentHeight, item.widget->height());
		}
	}
	const auto result = std::max(Rem(3.75), contentHeight + 2 * padY);

	auto x = padX;
	if (hasTitle) {
		x += title + gap;
	}
	for (const auto &item : _items) {
		if (!item.widget) {
			x += stretch + gap;
			continue;
		}
		item.widget->move(x, (result - item.widget->height()) / 2);
		x += item.widget->width() + gap;
	}
	return result;
}

void Header::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto line = Px(1);
	p.fillRect(0, height() - line, width(), line, ToneColor(Tone::Line));
	if (_title.isEmpty()) {
		return;
	}
	const auto padX = Rem(1.125);
	auto available = width() - 2 * padX;
	const auto gap = Rem(0.875);
	auto others = 0;
	for (const auto &item : _items) {
		others += (item.widget ? item.widget->width() : 0) + gap;
	}
	const auto font = titleFont();
	const auto text = font->elided(_title, std::max(available - others, 0));
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(padX, Baseline(font, 0, height() - line), text);
}

// ── кнопка со значком ────────────────────────────────────────────────────────

IconButton::IconButton(QWidget *parent, const QString &icon, const QString &accessibleName, Kind kind)
: Button(parent)
, _icon(icon)
, _kind(kind) {
	setAccessibleName(accessibleName);
	const auto side = (_kind == Kind::Small) ? Rem(1.75) : Rem(2.25);
	setNaturalWidth(side);
	resize(side, side);
}

void IconButton::setIcon(const QString &icon) {
	_icon = icon;
	update();
}

void IconButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto side = std::min(width(), height());
	const auto circle = QRectF((width() - side) / 2., (height() - side) / 2., side, side);
	const auto active = !isDisabled() && (isOver() || isDown());
	if (isDisabled()) {
		p.setOpacity(0.4);
	}
	auto fg = ToneColor(active ? Tone::Fg : Tone::Muted);
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		if (_kind == Kind::Accent) {
			p.setBrush(ToneColor(Tone::Accent));
			p.drawEllipse(circle);
			fg = ToneColor(Tone::AccentInk);
		} else if (active) {
			p.setBrush(ToneColor(Tone::Hover));
			p.drawEllipse(circle);
		}
	}
	if (isDown()) {
		PaintDownOverlay(p, circle, side / 2.);
	}
	// `.ib` — значок 1.375rem; `.ibSmall` — font-size 1rem
	const auto icon = (_kind == Kind::Small) ? Rem(1) : Rem(1.375);
	PaintIconOrFallback(p, _icon, fg, (width() - icon) / 2, (height() - icon) / 2, icon);
	p.setOpacity(1.);
	paintFocusRing(p, circle, side / 2.);
}

// ── пилюля ───────────────────────────────────────────────────────────────────

Pill::Pill(QWidget *parent, const QString &text, const QString &icon, bool accent)
: Button(parent)
, _text(text)
, _icon(icon)
, _accent(accent) {
	setAccessibleName(text);
	refreshSize();
}

void Pill::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	refreshSize();
}

void Pill::setIcon(const QString &icon) {
	_icon = icon;
	refreshSize();
}

void Pill::refreshSize() {
	const auto font = Font(14, _accent);
	const auto icon = _icon.isEmpty() ? 0 : (Rem(1.125) + (_text.isEmpty() ? 0 : Rem(0.375)));
	const auto w = 2 * Rem(0.875) + icon + font->width(_text);
	const auto h = Rem(2.125);
	setNaturalWidth(w);
	resize(w, h);
	update();
}

void Pill::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = height() / 2.;
	const auto over = isOver() || isDown();
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(_accent
			? (over ? Brighter(ToneColor(Tone::Accent)) : ToneColor(Tone::Accent))
			: ToneColor(over ? Tone::Hover : Tone::Raised));
		p.drawRoundedRect(r, radius, radius);
	}
	if (isDown()) {
		PaintDownOverlay(p, r, radius);
	}
	const auto fg = ToneColor(_accent ? Tone::AccentInk : Tone::Fg);
	auto x = Rem(0.875);
	if (!_icon.isEmpty()) {
		const auto icon = Rem(1.125);
		PaintIconOrFallback(p, _icon, fg, x, (height() - icon) / 2, icon);
		x += icon + Rem(0.375);
	}
	const auto font = Font(14, _accent);
	p.setFont(font->f);
	p.setPen(fg);
	p.drawText(x, Baseline(font, 0, height()), font->elided(_text, width() - x - Rem(0.875)));
	paintFocusRing(p, r, radius);
}

// ── кнопка ───────────────────────────────────────────────────────────────────

PushButton::PushButton(QWidget *parent, const QString &text, Kind kind, const QString &icon)
: Button(parent)
, _text(text)
, _icon(icon)
, _kind(kind) {
	setAccessibleName(text);
	refreshSize();
}

void PushButton::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	refreshSize();
}

void PushButton::setIcon(const QString &icon) {
	_icon = icon;
	refreshSize();
}

void PushButton::setKind(Kind kind) {
	_kind = kind;
	refreshSize();
}

void PushButton::setWide(bool wide, bool alignStart) {
	_wide = wide;
	_alignStart = alignStart;
	refreshSize();
}

int PushButton::contentWidth() const {
	const auto font = Font(14, _kind == Kind::Accent);
	const auto icon = _icon.isEmpty() ? 0 : (Rem(1.125) + (_text.isEmpty() ? 0 : Rem(0.375)));
	return 2 * Rem(0.875) + icon + font->width(_text);
}

int PushButton::resizeGetHeight(int newWidth) {
	// `.btn` 2.25rem; вариант во всю ширину «Плана» — 2.875rem
	return (_wide && _alignStart) ? Rem(2.875) : Rem(2.25);
}

void PushButton::refreshSize() {
	const auto h = resizeGetHeight(width());
	if (_wide) {
		setNaturalWidth(-1);
		resize(std::max(width(), contentWidth()), h);
	} else {
		const auto w = contentWidth();
		setNaturalWidth(w);
		resize(w, h);
	}
	update();
}

void PushButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = double(Rem(0.5));
	const auto over = !isDisabled() && (isOver() || isDown());
	if (isDisabled()) {
		p.setOpacity(0.5);
	}
	auto bg = QColor(0, 0, 0, 0);
	auto fg = ToneColor(Tone::Fg);
	switch (_kind) {
	case Kind::Normal:
		bg = ToneColor(over ? Tone::Line2 : Tone::Hover);
		break;
	case Kind::Accent:
		bg = over ? Brighter(ToneColor(Tone::Accent)) : ToneColor(Tone::Accent);
		fg = ToneColor(Tone::AccentInk);
		break;
	case Kind::Ghost:
		if (over) {
			bg = ToneColor(Tone::Hover);
		} else {
			fg = ToneColor(Tone::Muted);
		}
		break;
	case Kind::Danger:
		fg = ToneColor(Tone::Red);
		if (over) {
			bg = Mix(Tone::Red, 0.14);
		}
		break;
	}
	if (bg.alpha() > 0) {
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(bg);
		p.drawRoundedRect(r, radius, radius);
	}
	if (isDown()) {
		PaintDownOverlay(p, r, radius);
	}
	const auto font = Font(14, _kind == Kind::Accent);
	const auto icon = _icon.isEmpty() ? 0 : Rem(1.125);
	const auto iconGap = (icon && !_text.isEmpty()) ? Rem(0.375) : 0;
	const auto pad = Rem(0.875);
	const auto textWidth = std::min(font->width(_text), std::max(width() - 2 * pad - icon - iconGap, 0));
	const auto content = icon + iconGap + textWidth;
	auto x = (_wide && !_alignStart) ? std::max((width() - content) / 2, pad) : pad;
	if (icon) {
		PaintIconOrFallback(p, _icon, fg, x, (height() - icon) / 2, icon);
		x += icon + iconGap;
	}
	p.setFont(font->f);
	p.setPen(fg);
	p.drawText(x, Baseline(font, 0, height()), font->elided(_text, textWidth));
	p.setOpacity(1.);
	paintFocusRing(p, r, radius);
}

// ── кнопка-ссылка ────────────────────────────────────────────────────────────

LinkButton::LinkButton(QWidget *parent, const QString &text, int fontPx)
: Button(parent)
, _fontPx(fontPx) {
	setText(text);
}

void LinkButton::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	const auto font = Font(_fontPx);
	const auto w = font->width(_text);
	setNaturalWidth(w);
	resize(w, font->height);
	update();
}

void LinkButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	auto font = Font(_fontPx)->f;
	font.setUnderline(true);
	p.setFont(font);
	auto color = ToneColor(Tone::Purple);
	if (isOver() || isDown()) {
		color = Brighter(color);
	}
	p.setPen(color);
	p.drawText(rect(), Qt::AlignLeft | Qt::AlignVCenter, _text);
	paintFocusRing(p, QRectF(rect()), Px(4));
}

// ── вкладки-сегменты ─────────────────────────────────────────────────────────

class Segments::Item final : public Button {
public:
	Item(not_null<Segments*> parent, int index, const QString &text)
	: Button(parent)
	, _segments(parent)
	, _index(index) {
		setText(text);
	}

	void setText(const QString &text) {
		_text = text;
		setAccessibleName(text);
		const auto w = 2 * Rem(0.875) + Font(14)->width(_text);
		setNaturalWidth(w);
		resize(w, Rem(1.875));
		update();
	}

	void setOn(bool on) {
		if (_on != on) {
			_on = on;
			accessibilityStateChanged({ .selected = true });
			update();
		}
	}

	QAccessible::Role accessibilityRole() override {
		return QAccessible::PageTab;
	}

	Ui::AccessibilityState accessibilityState() const override {
		return { .pressed = isDown(), .selected = _on };
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto r = QRectF(rect());
		const auto radius = height() / 2.;
		if (_on) {
			// `.segItemOn`: `--pv-panel` и тень `0 1px 3px rgb(0 0 0 / 25%)`
			PaintSoftShadow(p, r, radius, Px(2), 0.25, Px(1));
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Panel));
			p.drawRoundedRect(r, radius, radius);
		}
		if (isDown()) {
			PaintDownOverlay(p, r, radius);
		}
		const auto font = Font(14);
		p.setFont(font->f);
		p.setPen(ToneColor((_on || isOver()) ? Tone::Fg : Tone::Muted));
		p.drawText(r, Qt::AlignCenter, _text);
		paintFocusRing(p, r, radius);
	}

	void keyPressEvent(QKeyEvent *e) override {
		const auto key = e->key();
		const auto rtl = (layoutDirection() == Qt::RightToLeft);
		const auto next = (key == Qt::Key_Right) ? !rtl : (key == Qt::Key_Left) ? rtl : false;
		if (key == Qt::Key_Right || key == Qt::Key_Left) {
			_segments->choose(_index + (next ? 1 : -1));
			return;
		}
		Button::keyPressEvent(e);
	}

private:
	const not_null<Segments*> _segments;
	const int _index = 0;
	QString _text;
	bool _on = false;

};

Segments::Segments(QWidget *parent, std::vector<QString> labels, int active)
: RpWidget(parent) {
	RepaintOnTones(this);
	_active = active;
	rebuild(std::move(labels));
}

void Segments::setLabels(std::vector<QString> labels) {
	rebuild(std::move(labels));
}

void Segments::rebuild(std::vector<QString> labels) {
	if (labels.size() == _items.size()) {
		for (auto i = 0, count = int(labels.size()); i != count; ++i) {
			_items[i]->setText(labels[i]);
		}
		relayout();
		return;
	}
	for (const auto item : _items) {
		delete item;
	}
	_items.clear();
	for (auto i = 0, count = int(labels.size()); i != count; ++i) {
		const auto item = Ui::CreateChild<Item>(this, i, labels[i]);
		item->setClickedCallback([=] { choose(i); });
		item->show();
		_items.push_back(item);
	}
	if (_active.current() >= int(_items.size())) {
		_active = 0;
	}
	relayout();
}

void Segments::relayout() {
	const auto pad = Rem(0.1875);
	auto x = pad;
	for (auto i = 0, count = int(_items.size()); i != count; ++i) {
		_items[i]->setOn(i == _active.current());
		_items[i]->move(x, pad);
		x += _items[i]->width();
	}
	const auto w = x + pad;
	const auto h = Rem(1.875) + 2 * pad;
	setNaturalWidth(w);
	resize(w, h);
	update();
}

void Segments::setActive(int index) {
	if (index < 0 || index >= int(_items.size())) {
		return;
	}
	_active = index;
	relayout();
}

int Segments::active() const {
	return _active.current();
}

rpl::producer<int> Segments::activeValue() const {
	return _active.value();
}

rpl::producer<int> Segments::activated() const {
	return _activated.events();
}

void Segments::choose(int index) {
	if (index < 0 || index >= int(_items.size())) {
		return;
	}
	const auto keyboard = _items[_active.current()]->hasFocus();
	setActive(index);
	if (keyboard) {
		_items[index]->setFocus(Qt::TabFocusReason);
	}
	_activated.fire_copy(index);
}

void Segments::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Raised));
	const auto radius = Rem(1.125);
	p.drawRoundedRect(QRectF(rect()), radius, radius);
}

// ── чип ──────────────────────────────────────────────────────────────────────

Chip::Chip(QWidget *parent, Descriptor descriptor)
: Button(parent)
, _descriptor(std::move(descriptor)) {
	setAccessibleName(_descriptor.text);
	if (_descriptor.toggleOnClick) {
		setClickedCallback([=] { setOn(!isOn()); });
	}
	refreshSize();
}

void Chip::setText(const QString &text) {
	_descriptor.text = text;
	setAccessibleName(text);
	refreshSize();
}

void Chip::setOn(bool on) {
	if (_on.current() != on) {
		_on = on;
		accessibilityStateChanged({ .checked = true });
		update();
	}
}

bool Chip::isOn() const {
	return _on.current();
}

rpl::producer<bool> Chip::onValue() const {
	return _on.value();
}

QAccessible::Role Chip::accessibilityRole() {
	return _descriptor.toggleOnClick ? QAccessible::CheckBox : QAccessible::Button;
}

Ui::AccessibilityState Chip::accessibilityState() const {
	return {
		.checkable = _descriptor.toggleOnClick,
		.checked = _descriptor.toggleOnClick && _on.current(),
		.pressed = isDown(),
		.selected = !_descriptor.toggleOnClick && _on.current(),
	};
}

QColor Chip::toneColor() const {
	return ToneColor(_descriptor.tone.value_or(Tone::Accent));
}

void Chip::refreshSize() {
	const auto font = Font(13);
	const auto gap = Rem(0.375);
	auto w = 2 * Rem(0.75) + font->width(_descriptor.text);
	if (_descriptor.dot) {
		w += Rem(0.5) + gap;
	}
	if (!_descriptor.icon.isEmpty()) {
		w += Rem(1) + gap;
	}
	setNaturalWidth(w);
	resize(w, Rem(1.875));
	update();
}

void Chip::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = height() / 2.;
	const auto on = _on.current();
	const auto tone = toneColor();
	{
		PainterHighQualityEnabler hq(p);
		if (on) {
			p.setPen(Qt::NoPen);
			p.setBrush(Mix(tone, 0.22));
			p.drawRoundedRect(r, radius, radius);
		} else {
			const auto line = double(Px(1));
			auto pen = QPen(ToneColor(Tone::Line2));
			pen.setWidthF(line);
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			const auto half = line / 2.;
			p.drawRoundedRect(r.adjusted(half, half, -half, -half), radius - half, radius - half);
		}
	}
	if (isDown()) {
		PaintDownOverlay(p, r, radius);
	}
	const auto fg = on ? tone : ToneColor(isOver() ? Tone::Fg : Tone::Muted);
	const auto gap = Rem(0.375);
	auto x = Rem(0.75);
	if (_descriptor.dot) {
		const auto dot = Rem(0.5);
		PaintDot(p, QPoint(x + dot / 2, height() / 2), tone, dot);
		x += dot + gap;
	}
	if (!_descriptor.icon.isEmpty()) {
		const auto icon = Rem(1);
		PaintIconOrFallback(p, _descriptor.icon, fg, x, (height() - icon) / 2, icon);
		x += icon + gap;
	}
	const auto font = Font(13);
	p.setFont(font->f);
	p.setPen(fg);
	p.drawText(x, Baseline(font, 0, height()), font->elided(_descriptor.text, width() - x - Rem(0.75)));
	paintFocusRing(p, r, radius);
}

// ── ряд с переносом ──────────────────────────────────────────────────────────

Flow::Flow(QWidget *parent, int gap)
: RpWidget(parent)
, _gap(gap ? gap : Rem(0.375)) {
}

Ui::RpWidget *Flow::addItem(object_ptr<Ui::RpWidget> child) {
	const auto raw = child.release();
	raw->setParent(this);
	raw->show();
	_items.push_back(raw);
	rpl::merge(
		raw->widthValue() | rpl::skip(1) | rpl::to_empty,
		raw->heightValue() | rpl::skip(1) | rpl::to_empty
	) | rpl::on_next([=] {
		resizeToWidth(width());
	}, raw->lifetime());
	raw->events() | rpl::filter([](not_null<QEvent*> e) {
		return e->type() == QEvent::ShowToParent || e->type() == QEvent::HideToParent;
	}) | rpl::on_next([=] {
		resizeToWidth(width());
	}, raw->lifetime());
	resizeToWidth(width());
	return raw;
}

void Flow::clear() {
	for (const auto item : base::take(_items)) {
		delete item;
	}
	resizeToWidth(width());
}

int Flow::resizeGetHeight(int newWidth) {
	if (_inResize) {
		return height();
	}
	_inResize = true;
	auto x = 0;
	auto y = 0;
	auto line = 0;
	for (const auto item : _items) {
		if (item->isHidden()) {
			continue;
		}
		const auto natural = item->naturalWidth();
		auto w = (natural >= 0) ? natural : item->width();
		if (newWidth > 0 && w > newWidth) {
			w = newWidth;
		}
		if (item->width() != w) {
			item->resizeToWidth(w);
		}
		if (x > 0 && x + w > newWidth) {
			x = 0;
			y += line + _gap;
			line = 0;
		}
		item->moveToLeft(x, y, newWidth);
		x += w + _gap;
		line = std::max(line, item->height());
	}
	_inResize = false;
	return y + line;
}

// ── строка списка ────────────────────────────────────────────────────────────

Row::Row(QWidget *parent, Descriptor descriptor)
: Button(parent)
, _descriptor(std::move(descriptor)) {
	setDescriptor(_descriptor);
}

void Row::setDescriptor(Descriptor descriptor) {
	_descriptor = std::move(descriptor);
	setAccessibleName(_descriptor.subtitle.isEmpty()
		? _descriptor.title
		: (_descriptor.title + u", "_q + _descriptor.subtitle));
	setNaturalWidth(-1);
	resize(width(), resizeGetHeight(width()));
	update();
}

void Row::setSelected(bool selected) {
	if (_selected != selected) {
		_selected = selected;
		accessibilityStateChanged({ .selected = true });
		update();
	}
}

int Row::resizeGetHeight(int newWidth) {
	const auto padY = Rem(0.375);
	auto text = Font(kBodyPx)->height;
	if (!_descriptor.subtitle.isEmpty()) {
		text += Font(13)->height;
	}
	auto leading = 0;
	if (_descriptor.avatar) {
		leading = AvatarSide(_descriptor.avatar->size);
	} else if (!_descriptor.icon.isEmpty()) {
		leading = Rem(1.375);
	}
	return std::max(Rem(2.75), std::max(text, leading) + 2 * padY);
}

void Row::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = double(Rem(0.5));
	if (isDisabled()) {
		p.setOpacity(0.45);
	}
	const auto highlighted = _selected
		|| (!isDisabled() && (isOver() || isDown()))
		|| (focusVisible() && hasFocus());
	if (highlighted) {
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawRoundedRect(r, radius, radius);
	}
	if (isDown()) {
		PaintDownOverlay(p, r, radius);
	}
	const auto padX = Rem(0.625);
	const auto gap = Rem(0.75);
	const auto fg = ToneColor(_descriptor.danger ? Tone::Red : Tone::Fg);
	auto left = padX;
	auto right = width() - padX;

	if (_descriptor.avatar) {
		const auto side = AvatarSide(_descriptor.avatar->size);
		PaintAvatar(p, QPoint(left, (height() - side) / 2), *_descriptor.avatar);
		left += side + gap;
	} else if (!_descriptor.icon.isEmpty()) {
		const auto icon = Rem(1.375);
		const auto color = _descriptor.danger ? fg : ToneColor(Tone::Muted);
		PaintIconOrFallback(p, _descriptor.icon, color, left, (height() - icon) / 2, icon);
		left += icon + gap;
	}
	if (!_descriptor.trailingIcon.isEmpty()) {
		const auto icon = Rem(1.125);
		right -= icon;
		PaintIconOrFallback(p, _descriptor.trailingIcon, ToneColor(Tone::Muted), right, (height() - icon) / 2, icon);
		right -= gap;
	}
	if (!_descriptor.meta.isEmpty()) {
		// `.meta`: моноширинный 0.8125rem `--pv-muted`
		const auto font = Font(13, false, true);
		const auto w = std::min(font->width(_descriptor.meta), std::max(right - left, 0) / 2);
		right -= w;
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(right, Baseline(font, 0, height()), font->elided(_descriptor.meta, w));
		right -= gap;
	}
	const auto available = std::max(right - left, 0);
	const auto title = Font(kBodyPx);
	const auto sub = Font(13);
	const auto hasSub = !_descriptor.subtitle.isEmpty();
	const auto block = title->height + (hasSub ? sub->height : 0);
	const auto top = (height() - block) / 2;
	p.setFont(title->f);
	p.setPen(fg);
	p.drawText(left, top + title->ascent, title->elided(_descriptor.title, available));
	if (hasSub) {
		p.setFont(sub->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(left, top + title->height + sub->ascent, sub->elided(_descriptor.subtitle, available));
	}
	p.setOpacity(1.);
	paintFocusRing(p, r, radius);
}

// ── подписи ──────────────────────────────────────────────────────────────────

Label::Label(QWidget *parent, const QString &text, Style st)
: RpWidget(parent)
, _st(st) {
	RepaintOnTones(this);
	setAttribute(Qt::WA_TransparentForMouseEvents);
	setText(text);
}

Label::Label(QWidget *parent, const QString &text)
: Label(parent, text, Style()) {
}

Label::Style Label::Muted() {
	return { .tone = Tone::Muted };
}

Label::Style Label::Faint() {
	return { .tone = Tone::Faint };
}

Label::Style Label::Small() {
	return { .px = 13, .tone = Tone::Muted };
}

Label::Style Label::Mono() {
	return { .mono = true };
}

Label::Style Label::Error() {
	return { .px = 13, .tone = Tone::Red, .multiline = true };
}

Label::Style Label::CardText() {
	return { .px = 14, .tone = Tone::Muted, .multiline = true };
}

Label::Style Label::Title() {
	return { .px = 20, .semibold = true };
}

Label::Style Label::SmallTitle() {
	return { .px = 16, .semibold = true };
}

style::font Label::font() const {
	return Font(_st.px, _st.semibold, _st.mono);
}

void Label::setText(const QString &text) {
	_text = text;
	accessibilityNameChanged();
	if (_st.multiline) {
		setNaturalWidth(-1);
	} else {
		const auto w = font()->width(_text);
		setNaturalWidth(w);
		if (!externalWidthWasSet()) {
			resize(w, font()->height);
		}
	}
	resize(width(), resizeGetHeight(width()));
	update();
}

void Label::setTone(Tone tone) {
	_st.tone = tone;
	update();
}

int Label::resizeGetHeight(int newWidth) {
	const auto f = font();
	if (!_st.multiline || _text.isEmpty() || newWidth <= 0) {
		return f->height;
	}
	const auto metrics = QFontMetrics(f->f);
	const auto bounds = metrics.boundingRect(
		QRect(0, 0, newWidth, QWIDGETSIZE_MAX),
		_st.align.toInt() | Qt::TextWordWrap,
		_text);
	return std::max(bounds.height(), f->height);
}

void Label::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto f = font();
	p.setFont(f->f);
	p.setPen(ToneColor(_st.tone));
	if (_st.multiline) {
		p.drawText(rect(), _st.align.toInt() | Qt::TextWordWrap, _text);
	} else {
		p.drawText(rect(), (_st.align | Qt::AlignVCenter).toInt(), f->elided(_text, width()));
	}
}

// Заглавные моноширинные

Caps::Caps(QWidget *parent, const QString &text, Kind kind)
: RpWidget(parent)
, _kind(kind) {
	RepaintOnTones(this);
	setAttribute(Qt::WA_TransparentForMouseEvents);
	setText(text);
}

QFont Caps::capsFont(bool semibold) const {
	const auto px = (_kind == Kind::CardTitle) ? 13 : 12;
	auto result = Font(px, semibold, true)->f;
	result.setCapitalization(QFont::AllUppercase);
	result.setLetterSpacing(QFont::AbsoluteSpacing, Px(px) * 0.06);
	return result;
}

QMargins Caps::padding() const {
	return (_kind == Kind::Group)
		? QMargins(Rem(0.25), Rem(0.75), Rem(0.25), Rem(0.25))
		: QMargins();
}

void Caps::setText(const QString &text) {
	_text = text;
	accessibilityNameChanged();
	const auto pad = padding();
	auto w = pad.left() + pad.right() + int(std::ceil(QFontMetricsF(capsFont(true)).horizontalAdvance(_text)));
	if (!_count.isEmpty()) {
		w += Rem(0.375) + int(std::ceil(QFontMetricsF(capsFont(false)).horizontalAdvance(_count)));
	}
	setNaturalWidth(w);
	if (!externalWidthWasSet()) {
		resize(w, resizeGetHeight(w));
	} else {
		resize(width(), resizeGetHeight(width()));
	}
	update();
}

void Caps::setCount(const QString &count) {
	_count = count;
	setText(_text);
}

int Caps::resizeGetHeight(int newWidth) {
	const auto px = (_kind == Kind::CardTitle) ? 13 : 12;
	const auto pad = padding();
	// line-height 1.45 (в «Плане» — 1.125rem)
	return pad.top() + pad.bottom() + std::max(int(std::round(Px(px) * 1.45)), QFontMetrics(capsFont(true)).height());
}

void Caps::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto pad = padding();
	const auto inner = rect().marginsRemoved(pad);
	const auto bold = capsFont(true);
	const auto metrics = QFontMetricsF(bold);
	p.setPen(ToneColor(Tone::Muted));
	p.setFont(bold);
	const auto countWidth = _count.isEmpty()
		? 0.
		: (Rem(0.375) + QFontMetricsF(capsFont(false)).horizontalAdvance(_count));
	const auto text = metrics.elidedText(_text, Qt::ElideRight, std::max(inner.width() - countWidth, 0.));
	p.drawText(inner, Qt::AlignLeft | Qt::AlignVCenter, text);
	if (!_count.isEmpty()) {
		const auto x = inner.x() + metrics.horizontalAdvance(text) + Rem(0.375);
		p.setFont(capsFont(false));
		p.drawText(QRectF(x, inner.y(), inner.right() - x + 1, inner.height()), Qt::AlignLeft | Qt::AlignVCenter, _count);
	}
}

// Пустое состояние

Empty::Empty(QWidget *parent, const QString &text)
: RpWidget(parent) {
	RepaintOnTones(this);
	setAttribute(Qt::WA_TransparentForMouseEvents);
	setText(text);
}

void Empty::setText(const QString &text) {
	_text = text;
	accessibilityNameChanged();
	setNaturalWidth(-1);
	resize(width(), resizeGetHeight(width()));
	update();
}

QRect Empty::textRect(int width) const {
	const auto font = Font(kBodyPx);
	const auto max = 36 * font->width(QChar('0')); // 36ch
	const auto w = std::max(std::min(width, max), 1);
	const auto bounds = QFontMetrics(font->f).boundingRect(
		QRect(0, 0, w, QWIDGETSIZE_MAX),
		Qt::AlignHCenter | Qt::TextWordWrap,
		_text);
	return QRect((width - w) / 2, Rem(2.5), w, std::max(bounds.height(), font->height));
}

int Empty::resizeGetHeight(int newWidth) {
	return textRect(newWidth).height() + 2 * Rem(2.5);
}

void Empty::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.setFont(Font(kBodyPx)->f);
	p.setPen(ToneColor(Tone::Muted));
	p.drawText(textRect(width()), Qt::AlignHCenter | Qt::TextWordWrap, _text);
}

// ── карточка ─────────────────────────────────────────────────────────────────

Card::Card(QWidget *parent, const QString &title, const QString &note)
: RpWidget(parent)
, _body(Ui::CreateChild<Ui::VerticalLayout>(this)) {
	RepaintOnTones(this);
	if (!title.isEmpty()) {
		_title = Ui::CreateChild<Caps>(this, title, Caps::Kind::CardTitle);
	}
	if (!note.isEmpty()) {
		_note = Ui::CreateChild<Label>(this, note, Label::Small());
	}
	_body->heightValue() | rpl::skip(1) | rpl::on_next([=] {
		resizeToWidth(width());
	}, lifetime());
	setNaturalWidth(-1);
}

not_null<Ui::VerticalLayout*> Card::body() const {
	return _body;
}

Ui::RpWidget *Card::addItem(object_ptr<Ui::RpWidget> child) {
	// `.stack`: промежуток 0.875rem
	const auto top = _body->count() ? Rem(0.875) : 0;
	return _body->add(std::move(child), style::margins(0, top, 0, 0));
}

void Card::setHeadWidget(object_ptr<Ui::RpWidget> widget) {
	if (_note) {
		delete base::take(_note);
	}
	delete base::take(_headWidget);
	_headWidget = widget.release();
	if (_headWidget) {
		_headWidget->setParent(this);
		_headWidget->show();
	}
	resizeToWidth(width());
}

int Card::headHeight() const {
	if (!_title && !_note && !_headWidget) {
		return 0;
	}
	// `.cardHead` (мин. 2.25rem в «Плане») + отступ 0.625rem
	auto h = Rem(2.25);
	if (_headWidget) {
		h = std::max(h, _headWidget->height());
	}
	return h + Rem(0.625);
}

int Card::resizeGetHeight(int newWidth) {
	const auto pad = Rem(1);
	const auto inner = std::max(newWidth - 2 * pad, 0);
	const auto head = headHeight();
	if (head) {
		const auto line = head - Rem(0.625);
		auto right = pad + inner;
		if (_headWidget) {
			right -= _headWidget->width();
			_headWidget->moveToLeft(right, pad + (line - _headWidget->height()) / 2, newWidth);
			right -= Rem(0.5);
		} else if (_note) {
			const auto w = std::min(_note->naturalWidth(), inner / 2);
			_note->resizeToWidth(w);
			right -= w;
			_note->moveToLeft(right, pad + (line - _note->height()) / 2, newWidth);
			right -= Rem(0.5);
		}
		if (_title) {
			const auto w = std::max(std::min(_title->naturalWidth(), right - pad), 0);
			_title->resizeToWidth(w);
			_title->moveToLeft(pad, pad + (line - _title->height()) / 2, newWidth);
		}
	}
	_body->resizeToWidth(inner);
	_body->moveToLeft(pad, pad + head, newWidth);
	return pad + head + _body->height() + pad;
}

void Card::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Raised));
	const auto radius = Rem(0.75);
	p.drawRoundedRect(QRectF(rect()), radius, radius);
}

} // namespace Parvane::Kit
