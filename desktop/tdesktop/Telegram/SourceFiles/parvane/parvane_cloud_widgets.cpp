// Parvane fork: значки и виджеты раздела «Облако» (spec 029, T064) — `PvIcon` web (контуры, которых нет в общем
// наборе ParvaneIcon), `.ib`, `.pill`, `.sortPill`, `.btn`, строки списка (`.row`/`.item`/`.plainRow`, флажок
// `.itemCheck`, полоса хода `.transferBar`) по `Cloud.module.scss` и `PvKit.module.scss`.
#include "parvane/parvane_cloud_internal.h"

#include "parvane/parvane_icons.h"
#include "ui/painter.h"
#include "ui/style/style_core.h"

#include <QtCore/QHash>
#include <QtGui/QMouseEvent>
#include <QtSvg/QSvgRenderer>

namespace Parvane::Cloud {
namespace {

using namespace Kit;

// Контуры web `notes/PvIcon.tsx` (поле 24): d — линия, c — круг (cx cy r, f — залитый), r — прямоугольник
const QHash<QString, QString> &Shapes() {
	static const auto result = QHash<QString, QString>{
		{ u"left"_q, u"<path d='M15 5l-7 7 7 7'/>"_q },
		{ u"up"_q, u"<path d='M6 15l6-6 6 6'/>"_q },
		{ u"down"_q, u"<path d='M6 9l6 6 6-6'/>"_q },
		{ u"x"_q, u"<path d='M6 6l12 12M18 6L6 18'/>"_q },
		{ u"edit"_q, u"<path d='M4 20h4L19 9l-4-4L4 16z'/>"_q },
		{ u"trash"_q, u"<path d='M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'/>"_q },
		{ u"move"_q, u"<path d='M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>"
			"<path d='M10 13h6M13 10l3 3-3 3'/>"_q },
		{ u"image"_q, u"<rect x='3' y='4' width='18' height='16' rx='2'/><circle cx='9' cy='10' r='2'/>"
			"<path d='M21 16l-5-5-8 9'/>"_q },
		{ u"upload"_q, u"<path d='M12 16V4M7 9l5-5 5 5M4 20h16'/>"_q },
		{ u"download"_q, u"<path d='M12 4v11M7 10l5 5 5-5M5 20h14'/>"_q },
		{ u"dots"_q, u"<circle cx='12' cy='5' r='1.4' fill='C'/><circle cx='12' cy='12' r='1.4' fill='C'/>"
			"<circle cx='12' cy='19' r='1.4' fill='C'/>"_q },
		{ u"eye"_q, u"<path d='M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'/><circle cx='12' cy='12' r='3'/>"_q },
		{ u"restore"_q, u"<path d='M4 12a8 8 0 1 0 2.4-5.7'/><path d='M4 4v4h4'/>"_q },
		{ u"lock"_q, u"<rect x='5' y='11' width='14' height='9' rx='2'/><path d='M8 11V8a4 4 0 0 1 8 0v3'/>"_q },
		{ u"copy"_q, u"<rect x='8' y='8' width='12' height='12' rx='2'/>"
			"<path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'/>"_q },
		{ u"file"_q, u"<path d='M6 3h9l4 4v14H6z'/><path d='M14 3v5h5M9 13h6M9 17h6'/>"_q },
		{ u"open"_q, u"<path d='M14 4h6v6M20 4l-9 9'/>"
			"<path d='M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/>"_q },
	};
	return result;
}

QImage RenderShape(const QString &name, const QColor &color, int size) {
	static auto cache = QHash<QString, QImage>();
	const auto ratio = style::DevicePixelRatio();
	const auto key = name + '/' + QString::number(color.rgba(), 16) + '/' + QString::number(size) + '/'
		+ QString::number(ratio);
	if (const auto i = cache.constFind(key); i != cache.constEnd()) {
		return *i;
	}
	const auto hex = color.name(QColor::HexRgb);
	auto body = Shapes().value(name);
	body.replace(u"fill='C'"_q, u"fill='"_q + hex + u"' stroke='none'"_q);
	const auto svg = (u"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='"_q + hex
		+ u"' stroke-opacity='"_q + QString::number(color.alphaF(), 'f', 3)
		+ u"' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>"_q + body + u"</svg>"_q).toUtf8();
	auto image = QImage(QSize(size, size) * ratio, QImage::Format_ARGB32_Premultiplied);
	image.fill(Qt::transparent);
	{
		auto renderer = QSvgRenderer(svg);
		auto p = QPainter(&image);
		renderer.render(&p, QRectF(0, 0, size * ratio, size * ratio));
	}
	image.setDevicePixelRatio(ratio);
	cache.insert(key, image);
	return image;
}

int Baseline(const style::font &font, int top, int height) {
	return top + (height - font->height) / 2 + font->ascent;
}

QColor Brighter(QColor color) {
	const auto channel = [](int value) {
		return std::min(255, int(std::round(value * 1.06)));
	};
	return QColor(channel(color.red()), channel(color.green()), channel(color.blue()), color.alpha());
}

void PaintDown(QPainter &p, const QRectF &rect, double radius) {
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(Mix(Tone::Fg, 0.08));
	p.drawRoundedRect(rect, radius, radius);
}

} // namespace

void PaintCloudIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size) {
	if (name.isEmpty()) {
		return;
	} else if (Shapes().contains(name)) {
		p.drawImage(x, y, RenderShape(name, color, size));
	} else if (HasIcon(name)) {
		PaintIcon(p, name, color, x, y, size);
	}
}

void PaintTile(QPainter &p, QPoint topLeft, const Tile &tile) {
	const auto side = AvatarSide(tile.size);
	const auto rect = QRectF(topLeft, QSizeF(side, side));
	const auto radius = tile.round ? side / 2. : double(Rem(0.625));
	PainterHighQualityEnabler hq(p);
	if (!tile.thumb.isNull()) {
		// `.itemThumb`: `object-fit: cover` со скруглением плитки
		auto path = QPainterPath();
		path.addRoundedRect(rect, radius, radius);
		p.save();
		p.setClipPath(path);
		const auto ratio = style::DevicePixelRatio();
		const auto scaled = tile.thumb.scaled(
			QSize(side, side) * ratio,
			Qt::KeepAspectRatioByExpanding,
			Qt::SmoothTransformation);
		const auto sx = (scaled.width() - side * ratio) / 2;
		const auto sy = (scaled.height() - side * ratio) / 2;
		auto part = scaled.copy(sx, sy, side * ratio, side * ratio);
		part.setDevicePixelRatio(ratio);
		p.drawImage(rect.topLeft(), part);
		p.restore();
		return;
	}
	p.setPen(Qt::NoPen);
	p.setBrush(Mix(tile.color, 0.22));
	p.drawRoundedRect(rect, radius, radius);
	if (!tile.letter.isEmpty()) {
		const auto font = Font((tile.size == AvatarSize::Small) ? 13 : 16, true, true);
		p.setFont(font->f);
		p.setPen(tile.color);
		p.drawText(rect, Qt::AlignCenter, tile.letter);
	} else if (!tile.icon.isEmpty()) {
		// `.iconS` в плитке — 1.125rem
		const auto icon = Rem(1.125);
		PaintCloudIcon(p, tile.icon, tile.color, int(rect.x()) + (side - icon) / 2, int(rect.y()) + (side - icon) / 2, icon);
	}
}

// ── `.ib` ────────────────────────────────────────────────────────────────────

IconBtn::IconBtn(QWidget *parent, const QString &icon, const QString &name, bool small, std::optional<Tone> tone)
: Button(parent)
, _icon(icon)
, _small(small)
, _tone(tone) {
	setAccessibleName(name);
	const auto side = _small ? Rem(1.75) : Rem(2.25);
	setNaturalWidth(side);
	resize(side, side);
}

void IconBtn::setIcon(const QString &icon) {
	_icon = icon;
	update();
}

void IconBtn::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto side = std::min(width(), height());
	const auto circle = QRectF((width() - side) / 2., (height() - side) / 2., side, side);
	const auto active = !isDisabled() && (isOver() || isDown());
	if (isDisabled()) {
		p.setOpacity(0.4);
	}
	const auto fg = _tone ? ToneColor(*_tone) : ToneColor(active ? Tone::Fg : Tone::Muted);
	if (active) {
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawEllipse(circle);
	}
	if (isDown()) {
		PaintDown(p, circle, side / 2.);
	}
	const auto icon = _small ? Rem(1) : Rem(1.375);
	PaintCloudIcon(p, _icon, fg, (width() - icon) / 2, (height() - icon) / 2, icon);
	p.setOpacity(1.);
	paintFocusRing(p, circle, side / 2.);
}

// ── `.pill` ──────────────────────────────────────────────────────────────────

PillBtn::PillBtn(QWidget *parent, const QString &text, const QString &icon, bool accent, bool sortPill)
: Button(parent)
, _text(text)
, _icon(icon)
, _accent(accent)
, _sort(sortPill) {
	setAccessibleName(text);
	refreshSize();
}

void PillBtn::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	refreshSize();
}

void PillBtn::setIcon(const QString &icon) {
	_icon = icon;
	refreshSize();
}

void PillBtn::refreshSize() {
	const auto font = Font(_sort ? kBodyPx : 14, _accent);
	const auto icon = _icon.isEmpty() ? 0 : (Rem(1.125) + (_text.isEmpty() ? 0 : Rem(0.375)));
	const auto w = _sort
		? (Rem(1) + font->width(_text) + icon + Rem(0.75))
		: (2 * Rem(0.875) + icon + font->width(_text));
	const auto h = _sort ? Rem(2.625) : Rem(2.125);
	setNaturalWidth(w);
	resize(w, h);
	update();
}

void PillBtn::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = height() / 2.;
	const auto over = isOver() || isDown();
	{
		PainterHighQualityEnabler hq(p);
		if (_sort) {
			// `.sortPill`: рамка `--pv-line2`, фон `--pv-panel`, наведение `--pv-hover`
			auto pen = QPen(ToneColor(Tone::Line2));
			pen.setWidthF(Px(1));
			p.setPen(pen);
			p.setBrush(ToneColor(over ? Tone::Hover : Tone::Panel));
			p.drawRoundedRect(r.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius);
		} else {
			p.setPen(Qt::NoPen);
			p.setBrush(_accent
				? (over ? Brighter(ToneColor(Tone::Accent)) : ToneColor(Tone::Accent))
				: ToneColor(over ? Tone::Hover : Tone::Raised));
			p.drawRoundedRect(r, radius, radius);
		}
	}
	if (isDown()) {
		PaintDown(p, r, radius);
	}
	const auto fg = ToneColor(_accent ? Tone::AccentInk : Tone::Fg);
	const auto font = Font(_sort ? kBodyPx : 14, _accent);
	const auto icon = Rem(1.125);
	auto x = _sort ? Rem(1) : Rem(0.875);
	if (!_sort && !_icon.isEmpty()) {
		PaintCloudIcon(p, _icon, fg, x, (height() - icon) / 2, icon);
		x += icon + Rem(0.375);
	}
	p.setFont(font->f);
	p.setPen(fg);
	const auto textWidth = std::min(font->width(_text), std::max(width() - x - Rem(0.875) - (_sort ? icon : 0), 0));
	p.drawText(x, Baseline(font, 0, height()), font->elided(_text, textWidth));
	if (_sort && !_icon.isEmpty()) {
		PaintCloudIcon(p, _icon, fg, x + textWidth + Rem(0.375), (height() - icon) / 2, icon);
	}
	paintFocusRing(p, r, radius);
}

// ── `.btn` ───────────────────────────────────────────────────────────────────

Btn::Btn(QWidget *parent, const QString &text, Kind kind, const QString &icon)
: Button(parent)
, _text(text)
, _icon(icon)
, _kind(kind) {
	setAccessibleName(text);
	refreshSize();
}

void Btn::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	refreshSize();
}

void Btn::setIcon(const QString &icon) {
	_icon = icon;
	refreshSize();
}

void Btn::setKind(Kind kind) {
	_kind = kind;
	refreshSize();
}

void Btn::refreshSize() {
	const auto font = Font(14, _kind == Kind::Accent);
	const auto icon = _icon.isEmpty() ? 0 : (Rem(1.125) + (_text.isEmpty() ? 0 : Rem(0.375)));
	const auto w = 2 * Rem(0.875) + icon + font->width(_text);
	setNaturalWidth(w);
	resize(w, Rem(2.25));
	update();
}

void Btn::paintEvent(QPaintEvent *e) {
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
		PaintDown(p, r, radius);
	}
	const auto font = Font(14, _kind == Kind::Accent);
	const auto icon = _icon.isEmpty() ? 0 : Rem(1.125);
	const auto gap = (icon && !_text.isEmpty()) ? Rem(0.375) : 0;
	const auto pad = Rem(0.875);
	const auto textWidth = std::min(font->width(_text), std::max(width() - 2 * pad - icon - gap, 0));
	auto x = std::max((width() - icon - gap - textWidth) / 2, pad);
	if (icon) {
		PaintCloudIcon(p, _icon, fg, x, (height() - icon) / 2, icon);
		x += icon + gap;
	}
	p.setFont(font->f);
	p.setPen(fg);
	p.drawText(x, Baseline(font, 0, height()), font->elided(_text, textWidth));
	p.setOpacity(1.);
	paintFocusRing(p, r, radius);
}

// ── строка списка ────────────────────────────────────────────────────────────

ListRow::ListRow(QWidget *parent, Descriptor descriptor)
: Button(parent)
, _d(std::move(descriptor)) {
	setDescriptor(_d);
	setClickedCallback([=] {
		if (_pressOnTile && _toggle) {
			_toggle();
		} else if (_open) {
			_open();
		}
	});
	widthValue() | rpl::on_next([=] {
		relayout();
	}, lifetime());
}

void ListRow::setDescriptor(Descriptor descriptor) {
	_d = std::move(descriptor);
	setAccessibleName(_d.sub.isEmpty() ? _d.title : (_d.title + u", "_q + _d.sub));
	setNaturalWidth(-1);
	resize(width(), resizeGetHeight(width()));
	relayout();
	update();
}

void ListRow::setCallbacks(Fn<void()> open, Fn<void()> toggle) {
	_open = std::move(open);
	_toggle = std::move(toggle);
}

Ui::RpWidget *ListRow::addRightItem(object_ptr<Ui::RpWidget> child) {
	const auto raw = child.release();
	raw->setParent(this);
	raw->show();
	_right.push_back(raw);
	raw->widthValue() | rpl::on_next([=] {
		relayout();
	}, raw->lifetime());
	relayout();
	return raw;
}

int ListRow::resizeGetHeight(int newWidth) {
	const auto padY = Rem(0.375);
	auto text = Font(kBodyPx)->height;
	if (!_d.sub.isEmpty() || !_d.subAccent.isEmpty()) {
		text += Font(13)->height;
	}
	if (_d.progress) {
		text += Rem(0.75); // `.transferBar` с полями
	}
	const auto lead = AvatarSide(_d.tile.size);
	const auto minimal = _d.compact ? Rem(2.75) : Rem(3.25);
	return std::max(minimal, std::max(text, lead) + 2 * padY);
}

QRect ListRow::tileRect() const {
	const auto side = AvatarSide(_d.tile.size);
	return QRect(Rem(0.625) + _d.indent, (height() - side) / 2, side, side);
}

void ListRow::relayout() {
	auto right = width() - Rem(0.625);
	for (auto i = int(_right.size()); i > 0; --i) {
		const auto w = _right[i - 1];
		right -= w->width();
		w->move(right, (height() - w->height()) / 2);
		right -= Rem(0.375);
	}
}

void ListRow::mousePressEvent(QMouseEvent *e) {
	// Флажок выделения поверх плитки: нажатие на плитку выделяет, а не открывает
	_pressOnTile = _d.selectable && _toggle && tileRect().contains(e->pos());
	Button::mousePressEvent(e);
}

void ListRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = double(Rem(0.5));
	if (isDisabled()) {
		p.setOpacity(0.45);
	}
	const auto over = !isDisabled() && (isOver() || isDown());
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		if (_d.background) {
			p.setBrush(*_d.background);
			p.drawRoundedRect(r, radius, radius);
		}
		if (_d.selected || (!_d.plain && (over || (focusVisible() && hasFocus())))) {
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(r, radius, radius);
		}
	}
	if (!_d.plain && isDown()) {
		PaintDown(p, r, radius);
	}
	const auto gap = Rem(0.75);
	const auto tile = tileRect();
	PaintTile(p, tile.topLeft(), _d.tile);
	// Флажок `.itemCheck`: под курсором, пока идёт выделение, либо отмечен
	if (_d.selectable && (_d.selected || _d.selecting || over)) {
		PainterHighQualityEnabler hq(p);
		const auto tileR = QRectF(tile);
		const auto tileRadius = double(Rem(0.625));
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(_d.selected ? Tone::Accent : Tone::Raised));
		p.drawRoundedRect(tileR, tileRadius, tileRadius);
		if (_d.selected) {
			const auto icon = Rem(1.125);
			PaintCloudIcon(p, u"check"_q, ToneColor(Tone::AccentInk), tile.x() + (tile.width() - icon) / 2, tile.y() + (tile.height() - icon) / 2, icon);
		} else {
			const auto ring = Rem(1.375);
			auto pen = QPen(ToneColor(Tone::Line2));
			pen.setWidthF(Px(2));
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			p.drawEllipse(QRectF(tile.x() + (tile.width() - ring) / 2. + Px(1), tile.y() + (tile.height() - ring) / 2. + Px(1), ring - Px(2), ring - Px(2)));
		}
	}
	const auto left = tile.x() + tile.width() + gap;
	auto right = width() - Rem(0.625);
	if (!_right.empty()) {
		right = _right.front()->x() - gap;
	}
	if (_d.checkMark) {
		const auto icon = Rem(1.125);
		right -= icon;
		PaintCloudIcon(p, u"check"_q, ToneColor(Tone::Accent), right, (height() - icon) / 2, icon);
		right -= gap;
	}
	if (!_d.note.isEmpty()) {
		const auto font = Font(13);
		const auto w = std::min(font->width(_d.note), std::max(right - left, 0) / 2);
		right -= w;
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(right, Baseline(font, 0, height()), font->elided(_d.note, w));
		right -= gap;
	}
	const auto available = std::max(right - left, 0);
	const auto title = Font(kBodyPx);
	const auto sub = Font(13);
	const auto hasSub = !_d.sub.isEmpty() || !_d.subAccent.isEmpty();
	const auto bar = _d.progress ? Rem(0.75) : 0;
	const auto block = title->height + bar + (hasSub ? sub->height : 0);
	auto y = (height() - block) / 2;
	p.setFont(title->f);
	p.setPen(ToneColor(_d.danger ? Tone::Red : Tone::Fg));
	p.drawText(left, y + title->ascent, title->elided(_d.title, available));
	y += title->height;
	if (_d.progress) {
		// `.transferBar`: 0.25rem, поля 0.3125rem сверху и 0.1875rem снизу
		const auto barRect = QRectF(left, y + Rem(0.3125), available, Rem(0.25));
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Raised));
		p.drawRoundedRect(barRect, Rem(0.125), Rem(0.125));
		auto fill = barRect;
		fill.setWidth(barRect.width() * std::clamp(*_d.progress, 0., 1.));
		p.setBrush(ToneColor(Tone::Blue));
		p.drawRect(fill);
		y += bar;
	}
	if (hasSub) {
		p.setFont(sub->f);
		p.setPen(ToneColor(_d.subError ? Tone::Red : Tone::Muted));
		auto text = _d.sub;
		if (!_d.subAccent.isEmpty()) {
			text = sub->elided(text, available);
			p.drawText(left, y + sub->ascent, text);
			const auto used = sub->width(text);
			p.setPen(ToneColor(Tone::Purple));
			p.drawText(left + used, y + sub->ascent, sub->elided(_d.subAccent, std::max(available - used, 0)));
		} else {
			p.drawText(left, y + sub->ascent, sub->elided(text, available));
		}
	}
	p.setOpacity(1.);
	paintFocusRing(p, r, radius);
}

// ── ряд ──────────────────────────────────────────────────────────────────────

object_ptr<Kit::Label> Text(QWidget *parent, const QString &text, Kit::Label::Style st) {
	return object_ptr<Kit::Label>(parent, text, st);
}

HRow::HRow(QWidget *parent, int gap)
: RpWidget(parent)
, _gap(gap) {
}

Ui::RpWidget *HRow::addItem(object_ptr<Ui::RpWidget> child, bool stretch) {
	const auto raw = child.release();
	raw->setParent(this);
	raw->show();
	_items.push_back({ raw, stretch });
	raw->heightValue() | rpl::on_next([=] {
		if (!_inResize) {
			resizeToWidth(width());
		}
	}, raw->lifetime());
	if (!stretch) {
		raw->widthValue() | rpl::on_next([=] {
			if (!_inResize) {
				resizeToWidth(width());
			}
		}, raw->lifetime());
	}
	return raw;
}

int HRow::resizeGetHeight(int newWidth) {
	_inResize = true;
	auto fixed = 0;
	auto stretches = 0;
	for (const auto &item : _items) {
		if (item.stretch) {
			++stretches;
		} else {
			fixed += item.widget->width();
		}
	}
	const auto gaps = _items.empty() ? 0 : _gap * int(_items.size() - 1);
	const auto free = std::max(newWidth - fixed - gaps, 0);
	auto height = 0;
	for (const auto &item : _items) {
		if (item.stretch) {
			item.widget->resizeToWidth(stretches ? free / stretches : 0);
		}
		height = std::max(height, item.widget->height());
	}
	auto x = 0;
	for (const auto &item : _items) {
		item.widget->move(x, (height - item.widget->height()) / 2);
		x += item.widget->width() + _gap;
	}
	_inResize = false;
	return height;
}

} // namespace Parvane::Cloud
