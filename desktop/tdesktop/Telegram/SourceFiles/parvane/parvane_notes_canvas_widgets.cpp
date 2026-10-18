// Parvane fork: детали поля холста «Знаний» (spec 029, T063) — см. parvane_notes_canvas_widgets.h.
#include "parvane/parvane_notes_canvas_widgets.h"

#include "parvane/parvane_notes_canvas_look.h"

#include "base/event_filter.h"
#include "ui/painter.h"

#include <QtGui/QtEvents>
#include <QtWidgets/QToolTip>

namespace Parvane::NotesUi::CanvasWidgets {
namespace {

using namespace Kit;
using CanvasLook::Blend;
using CanvasLook::Fade;

// Поле под тень панели (`box-shadow: 0 0.5rem 1.5rem`)
[[nodiscard]] int ShadowRoom() {
	return Px(10);
}

void PaintShadow(QPainter &p, QRectF rect, double radius) {
	// Мягкая тень кольцами: `0 0.5rem 1.5rem rgb(0 0 0 / 30%)`
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	const auto rings = 5;
	for (auto i = rings; i > 0; --i) {
		p.setBrush(QColor(0, 0, 0, 10));
		const auto spread = i * Px(2) / 2.;
		p.drawRoundedRect(rect.adjusted(-spread, -spread + Px(3), spread, spread + Px(3)), radius + spread, radius + spread);
	}
}

void PaintFrame(QPainter &p, QRectF rect, double radius) {
	PaintShadow(p, rect, radius);
	PainterHighQualityEnabler hq(p);
	p.setPen(QPen(ToneColor(Tone::Line2), Px(1)));
	p.setBrush(ToneColor(Tone::Panel));
	p.drawRoundedRect(rect.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius);
}

void PaintSwatch(QPainter &p, QRectF rect, const std::optional<QColor> &color, bool on) {
	PainterHighQualityEnabler hq(p);
	const auto border = Px(2);
	if (color) {
		p.setPen(Qt::NoPen);
		p.setBrush(*color);
		p.drawEllipse(rect);
	}
	// `.canvasSwatchNone`: пустой кружок в рамке; `.canvasSwatchOn`: рамка цвета текста
	if (!color || on) {
		p.setPen(QPen(on ? ToneColor(Tone::Fg) : ToneColor(Tone::Line2), border));
		p.setBrush(Qt::NoBrush);
		p.drawEllipse(rect.adjusted(border / 2., border / 2., -border / 2., -border / 2.));
	}
}

} // namespace

// ── кнопка панели инструментов ─────────────────────────────────────────────

ToolButton::ToolButton(QWidget *parent, const QString &icon, const QString &label)
: Button(parent)
, _icon(icon) {
	setAccessibleName(label);
	setToolTip(label);
	resize(Rem(2.375), Rem(2.375));
	RepaintOnTones(this);
}

void ToolButton::setIcon(const QString &icon) {
	_icon = icon;
	update();
}

void ToolButton::setOn(bool on) {
	if (_on != on) {
		_on = on;
		update();
	}
}

void ToolButton::setLabel(const QString &label) {
	setAccessibleName(label);
	setToolTip(label);
}

void ToolButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto rect = QRectF(this->rect()).adjusted(0.5, 0.5, -0.5, -0.5);
	const auto radius = double(Rem(0.625));
	const auto enabled = isEnabled();
	if (!enabled) {
		p.setOpacity(0.4);
	}
	if (_on) {
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Accent));
	} else {
		p.setPen(QPen(ToneColor(Tone::Line2), Px(1)));
		p.setBrush((enabled && isOver()) ? ToneColor(Tone::Hover) : ToneColor(Tone::Panel));
	}
	p.drawRoundedRect(rect, radius, radius);
	const auto size = Rem(1.125);
	CanvasLook::PaintIcon(
		p,
		_icon,
		ToneColor(_on ? Tone::AccentInk : Tone::Fg),
		QRectF((width() - size) / 2., (height() - size) / 2., size, size));
	if (focusVisible()) {
		paintFocusRing(p, rect, radius);
	}
}

// ── чип холста ─────────────────────────────────────────────────────────────

Chip::Chip(QWidget *parent, const QString &icon, const QString &text, const QString &label)
: Button(parent)
, _icon(icon)
, _text(text) {
	setAccessibleName(label.isEmpty() ? text : label);
	if (!label.isEmpty()) {
		setToolTip(label);
	}
	RepaintOnTones(this);
	refreshSize();
}

void Chip::setText(const QString &text) {
	_text = text;
	refreshSize();
	update();
}

void Chip::setOn(bool on) {
	if (_on != on) {
		_on = on;
		update();
	}
}

void Chip::refreshSize() {
	// `.chip`: высота 1.875rem, поля 0 0.75rem, промежуток 0.375rem, значок 1.125rem, текст 0.8125rem
	const auto font = Font(13);
	auto width = Rem(0.75) * 2 + Rem(1.125);
	if (!_text.isEmpty()) {
		width += Rem(0.375) + font->width(_text);
	}
	resize(width, Rem(1.875));
}

void Chip::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto rect = QRectF(this->rect()).adjusted(0.5, 0.5, -0.5, -0.5);
	const auto radius = rect.height() / 2.;
	const auto enabled = isEnabled();
	if (!enabled) {
		p.setOpacity(0.5);
	}
	const auto accent = ToneColor(Tone::Accent);
	const auto panel = ToneColor(Tone::Panel);
	if (_on) {
		p.setPen(Qt::NoPen);
		p.setBrush(Blend(accent, panel, 0.22));
	} else {
		p.setPen(QPen(ToneColor(Tone::Line2), Px(1)));
		p.setBrush((enabled && isOver()) ? Blend(ToneColor(Tone::Hover), panel, 1.) : panel);
	}
	p.drawRoundedRect(rect, radius, radius);
	const auto color = _on ? accent : ToneColor(Tone::Muted);
	const auto icon = Rem(1.125);
	auto x = Rem(0.75);
	CanvasLook::PaintIcon(p, _icon, color, QRectF(x, (height() - icon) / 2., icon, icon));
	x += icon + Rem(0.375);
	if (!_text.isEmpty()) {
		const auto font = Font(13);
		p.setFont(font->f);
		p.setPen(color);
		p.drawText(QRect(x, 0, width() - x, height()), Qt::AlignLeft | Qt::AlignVCenter, _text);
	}
	if (focusVisible()) {
		paintFocusRing(p, rect, radius);
	}
}

// ── панель с ячейками ──────────────────────────────────────────────────────

Panel::Panel(QWidget *parent)
: RpWidget(parent) {
	setMouseTracking(true);
	RepaintOnTones(this);
}

int Panel::cellAt(QPoint point) const {
	const auto shifted = point + QPoint(0, _scroll);
	for (auto i = 0; i != int(_cells.size()); ++i) {
		if (_cells[i].rect.contains(shifted)) {
			return i;
		}
	}
	return -1;
}

void Panel::paintCell(QPainter &p, const Cell &cell, bool over) const {
	const auto rect = QRectF(cell.rect);
	switch (cell.type) {
	case Cell::Type::Button: {
		if (over) {
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(rect, Rem(0.5), Rem(0.5));
		}
		if (cell.swatchInButton) {
			const auto side = Rem(1.25);
			PaintSwatch(p, QRectF(rect.center().x() - side / 2., rect.center().y() - side / 2., side, side), cell.color, false);
		} else {
			const auto size = Rem(1.125);
			CanvasLook::PaintIcon(
				p,
				cell.icon,
				ToneColor(Tone::Fg),
				QRectF(rect.center().x() - size / 2., rect.center().y() - size / 2., size, size));
		}
	} break;
	case Cell::Type::Swatch:
		PaintSwatch(p, rect, cell.color, cell.on);
		break;
	case Cell::Type::Item: {
		if (over) {
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(rect, Rem(0.5), Rem(0.5));
		}
		const auto color = ToneColor(cell.danger ? Tone::Red : Tone::Fg);
		const auto size = Rem(1.125);
		const auto left = rect.x() + Rem(0.625);
		CanvasLook::PaintIcon(p, cell.icon, color, QRectF(left, rect.center().y() - size / 2., size, size));
		const auto font = Font(14);
		p.setFont(font->f);
		p.setPen(color);
		const auto textLeft = int(left) + size + Rem(0.625);
		p.drawText(
			QRect(textLeft, cell.rect.y(), cell.rect.right() - textLeft - Rem(0.625), cell.rect.height()),
			Qt::AlignLeft | Qt::AlignVCenter,
			font->elided(cell.label, cell.rect.right() - textLeft - Rem(0.625)));
	} break;
	}
}

void Panel::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto room = ShadowRoom();
	const auto frame = QRectF(rect()).adjusted(room, room, -room, -room);
	PaintFrame(p, frame, Rem(0.75));
	p.save();
	p.setClipRect(frame.adjusted(1, 1, -1, -1));
	p.translate(0, -_scroll);
	for (const auto &line : _lines) {
		p.fillRect(line, ToneColor(Tone::Line));
	}
	for (auto i = 0; i != int(_cells.size()); ++i) {
		paintCell(p, _cells[i], i == _over);
	}
	p.restore();
}

void Panel::mouseMoveEvent(QMouseEvent *e) {
	const auto over = cellAt(e->pos());
	if (over != _over) {
		_over = over;
		setCursor((over >= 0) ? style::cur_pointer : style::cur_default);
		update();
	}
}

void Panel::mousePressEvent(QMouseEvent *e) {
	_down = (e->button() == Qt::LeftButton) ? cellAt(e->pos()) : -1;
}

void Panel::mouseReleaseEvent(QMouseEvent *e) {
	const auto down = std::exchange(_down, -1);
	if (down >= 0 && down == cellAt(e->pos()) && down < int(_cells.size())) {
		if (const auto click = _cells[down].click) {
			click();
		}
	}
}

void Panel::leaveEventHook(QEvent *e) {
	if (_over >= 0) {
		_over = -1;
		update();
	}
}

bool Panel::eventHook(QEvent *e) {
	if (e->type() == QEvent::ToolTip) {
		const auto help = static_cast<QHelpEvent*>(e);
		const auto index = cellAt(help->pos());
		if (index >= 0 && _cells[index].type != Cell::Type::Item && !_cells[index].label.isEmpty()) {
			QToolTip::showText(help->globalPos(), _cells[index].label, this);
		} else {
			QToolTip::hideText();
		}
		return true;
	}
	return RpWidget::eventHook(e);
}

// ── панель у выделенного ───────────────────────────────────────────────────

SelectionBar::SelectionBar(QWidget *parent, Labels labels)
: Panel(parent)
, _labels(std::move(labels)) {
	base::install_event_filter(this, parent, [=](not_null<QEvent*> e) {
		if (e->type() == QEvent::Resize) {
			relayout();
		}
		return base::EventFilterResult::Continue;
	});
}

void SelectionBar::setDescriptor(Descriptor descriptor) {
	_descriptor = std::move(descriptor);
	rebuild();
}

void SelectionBar::setPlace(std::optional<QPoint> place) {
	if (_place != place) {
		_place = place;
		relayout();
	}
}

rpl::producer<QString> SelectionBar::actions() const {
	return _actions.events();
}

rpl::producer<std::optional<std::string>> SelectionBar::colors() const {
	return _colors.events();
}

rpl::producer<QPoint> SelectionBar::moreRequests() const {
	return _more.events();
}

void SelectionBar::rebuild() {
	_cells.clear();
	_lines.clear();
	const auto room = ShadowRoom();
	const auto pad = Rem(0.25);
	const auto button = Rem(2);
	const auto gap = Rem(0.125);
	auto top = room + pad;
	if (_paletteOpen) {
		// `.canvasBarColors`: поля 0.25rem 0.375rem, промежуток 0.375rem, образцы 1.25rem
		const auto side = Rem(1.25);
		auto x = room + pad + Rem(0.375);
		const auto y = top + Rem(0.25);
		for (const auto &preset : notes::kCanvasPresetColors) {
			const auto value = std::optional<std::string>(preset);
			_cells.push_back({
				.type = Cell::Type::Swatch,
				.rect = QRect(x, y, side, side),
				.label = _labels.color + ' ' + QString::fromStdString(preset),
				.on = (_descriptor.color == value),
				.color = CanvasLook::PresetColor(value),
				.click = [=] {
					_paletteOpen = false;
					rebuild();
					_colors.fire_copy(value);
				},
			});
			x += side + Rem(0.375);
		}
		_cells.push_back({
			.type = Cell::Type::Swatch,
			.rect = QRect(x, y, side, side),
			.label = _labels.noColor,
			.on = !CanvasLook::PresetColor(_descriptor.color).has_value(),
			.click = [=] {
				_paletteOpen = false;
				rebuild();
				_colors.fire(std::nullopt);
			},
		});
		top = y + side + Rem(0.25) + Rem(0.25);
	}
	auto x = room + pad;
	const auto add = [&](const QString &name, const QString &icon, const QString &label) {
		_cells.push_back({
			.type = Cell::Type::Button,
			.rect = QRect(x, top, button, button),
			.icon = icon,
			.label = label,
			.click = [=] { _actions.fire_copy(name); },
		});
		x += button + gap;
	};
	_cells.push_back({
		.type = Cell::Type::Button,
		.rect = QRect(x, top, button, button),
		.label = _labels.color,
		.color = CanvasLook::PresetColor(_descriptor.color),
		.swatchInButton = true,
		.click = [=] {
			_paletteOpen = !_paletteOpen;
			rebuild();
		},
	});
	x += button + gap;
	if (_descriptor.canEdit) {
		add(u"edit"_q, _descriptor.editIcon, _descriptor.editLabel.isEmpty() ? _labels.edit : _descriptor.editLabel);
	}
	if (_descriptor.canOpen) {
		add(u"open"_q, u"open"_q, _labels.open);
	}
	if (_descriptor.canTurn) {
		add(u"direction"_q, u"arrow"_q, _labels.direction);
	}
	if (_descriptor.canDuplicate) {
		add(u"duplicate"_q, u"copy"_q, _labels.duplicate);
	}
	if (_descriptor.canWrap) {
		add(u"wrap"_q, u"group"_q, _labels.wrap);
	}
	if (_descriptor.canFit) {
		add(u"fit"_q, u"fit"_q, _labels.fit);
	}
	add(u"remove"_q, u"trash"_q, _labels.remove);
	const auto moreRect = QRect(x, top, button, button);
	_cells.push_back({
		.type = Cell::Type::Button,
		.rect = moreRect,
		.icon = u"dots"_q,
		.label = _labels.more,
		.click = [=] {
			_more.fire(mapToParent(QPoint(moreRect.x(), moreRect.bottom() + Rem(0.375))));
		},
	});
	x += button;
	auto width = x + pad + room;
	if (_paletteOpen) {
		width = std::max(width, room + pad + Rem(0.375) * 2 + int(notes::kCanvasPresetColors.size() + 1)
			* (Rem(1.25) + Rem(0.375)) + pad + room);
	}
	resize(width, top + button + pad + room);
	relayout();
	update();
}

void SelectionBar::relayout() {
	const auto parent = parentWidget();
	if (!parent) {
		return;
	}
	const auto room = ShadowRoom();
	if (!_place) {
		// `.canvasBarDocked`: прижата к низу поля, слева от кнопок масштаба
		move(Rem(0.625) - room, parent->height() - Rem(0.625) - height() + room);
		return;
	}
	// `top: clamp(7rem, --by, 100% - 0.5rem); left: clamp(9.5rem, --bx, 100% - 9.5rem)`, `translate(-50%, -100%)`
	const auto bx = std::clamp(_place->x(), Rem(9.5), std::max(Rem(9.5), parent->width() - Rem(9.5)));
	const auto by = std::clamp(_place->y(), Rem(7), std::max(Rem(7), parent->height() - Rem(0.5)));
	move(bx - width() / 2, by - (height() - room) - room + room);
}

// ── меню ───────────────────────────────────────────────────────────────────

ContextMenu::ContextMenu(QWidget *parent, Descriptor descriptor, Labels labels)
: Panel(parent)
, _descriptor(std::move(descriptor))
, _labels(std::move(labels)) {
	rebuild();
	base::install_event_filter(this, parent, [=](not_null<QEvent*> e) {
		if (e->type() == QEvent::Resize) {
			relayout();
		}
		return base::EventFilterResult::Continue;
	});
}

rpl::producer<QString> ContextMenu::commands() const {
	return _commands.events();
}

rpl::producer<std::optional<std::string>> ContextMenu::colors() const {
	return _colors.events();
}

rpl::producer<notes::CanvasAlign> ContextMenu::aligns() const {
	return _aligns.events();
}

rpl::producer<notes::CanvasAxis> ContextMenu::distributes() const {
	return _distributes.events();
}

void ContextMenu::rebuild() {
	_cells.clear();
	_lines.clear();
	const auto room = ShadowRoom();
	const auto pad = Rem(0.25);
	const auto width = Rem(15);
	const auto inner = width - 2 * pad;
	auto top = room + pad;
	const auto stripLeft = room + pad + Rem(0.375);
	const auto stripRight = room + pad + inner - Rem(0.375);
	// `.canvasMenuStrip`: поля 0.25rem 0.375rem, промежуток 0.375rem, перенос; линия снизу
	const auto strip = [&](auto &&fill) {
		auto x = stripLeft;
		auto y = top + Rem(0.25);
		auto rowHeight = 0;
		const auto place = [&](int w, int h) {
			if (x + w > stripRight && x > stripLeft) {
				x = stripLeft;
				y += rowHeight + Rem(0.375);
				rowHeight = 0;
			}
			const auto result = QRect(x, y, w, h);
			x += w + Rem(0.375);
			rowHeight = std::max(rowHeight, h);
			return result;
		};
		fill(place);
		top = y + rowHeight + Rem(0.25);
		_lines.push_back(QRect(room + pad, top, inner, Px(1)));
		top += Px(1);
	};
	if (_descriptor.hasColors) {
		strip([&](auto &&place) {
			const auto side = Rem(1.25);
			for (const auto &preset : notes::kCanvasPresetColors) {
				const auto value = std::optional<std::string>(preset);
				const auto rect = place(side, side);
				_cells.push_back({
					.type = Cell::Type::Swatch,
					.rect = rect,
					.label = _labels.color + ' ' + QString::fromStdString(preset),
					.on = (_descriptor.color == value),
					.color = CanvasLook::PresetColor(value),
					.click = [=] { _colors.fire_copy(value); },
				});
			}
			_cells.push_back({
				.type = Cell::Type::Swatch,
				.rect = place(side, side),
				.label = _labels.noColor,
				.on = !CanvasLook::PresetColor(_descriptor.color).has_value(),
				.click = [=] { _colors.fire(std::nullopt); },
			});
		});
	}
	if (_descriptor.canAlign) {
		strip([&](auto &&place) {
			const auto button = Rem(2);
			const auto align = [&](notes::CanvasAlign value, const QString &icon, const QString &label) {
				_cells.push_back({
					.type = Cell::Type::Button,
					.rect = place(button, button),
					.icon = icon,
					.label = label,
					.click = [=] { _aligns.fire_copy(value); },
				});
			};
			using A = notes::CanvasAlign;
			align(A::Left, u"alignLeft"_q, _labels.alignLeft);
			align(A::Center, u"alignCenter"_q, _labels.alignCenter);
			align(A::Right, u"alignRight"_q, _labels.alignRight);
			align(A::Top, u"alignTop"_q, _labels.alignTop);
			align(A::Middle, u"alignMiddle"_q, _labels.alignMiddle);
			align(A::Bottom, u"alignBottom"_q, _labels.alignBottom);
			if (_descriptor.canDistribute) {
				_cells.push_back({
					.type = Cell::Type::Button,
					.rect = place(button, button),
					.icon = u"spreadX"_q,
					.label = _labels.distributeX,
					.click = [=] { _distributes.fire(notes::CanvasAxis::X); },
				});
				_cells.push_back({
					.type = Cell::Type::Button,
					.rect = place(button, button),
					.icon = u"spreadY"_q,
					.label = _labels.distributeY,
					.click = [=] { _distributes.fire(notes::CanvasAxis::Y); },
				});
			}
		});
	}
	// `.canvasMenuItem`: поля 0.4375rem 0.625rem, 0.875rem текста
	const auto itemHeight = Rem(0.4375) * 2 + std::max(Font(14)->height, Rem(1.125));
	for (const auto &item : _descriptor.items) {
		const auto command = item.command;
		_cells.push_back({
			.type = Cell::Type::Item,
			.rect = QRect(room + pad, top, inner, itemHeight),
			.icon = item.icon,
			.label = item.label,
			.danger = item.danger,
			.click = [=] { _commands.fire_copy(command); },
		});
		top += itemHeight;
	}
	_contentHeight = top + pad + room;
	resize(width + 2 * room, _contentHeight);
	relayout();
}

void ContextMenu::relayout() {
	const auto parent = parentWidget();
	if (!parent) {
		return;
	}
	const auto room = ShadowRoom();
	// `max-height: calc(100% - 1rem)`, листается
	const auto maxHeight = std::max(parent->height() - Rem(1), Rem(4)) + 2 * room;
	resize(width(), std::min(_contentHeight, maxHeight));
	_scroll = std::clamp(_scroll, 0, std::max(0, _contentHeight - height()));
	// `top: clamp(0.5rem, --my, 100% - 24rem); left: clamp(0.5rem, --mx, 100% - 15.5rem)`
	const auto x = std::clamp(_descriptor.at.x(), Rem(0.5), std::max(Rem(0.5), parent->width() - Rem(15.5)));
	const auto y = std::clamp(_descriptor.at.y(), Rem(0.5), std::max(Rem(0.5), parent->height() - Rem(24)));
	const auto bottomFit = std::min(y, std::max(Rem(0.5), parent->height() - (height() - 2 * room) - Rem(0.5)));
	move(x - room, bottomFit - room);
}

void ContextMenu::wheelEvent(QWheelEvent *e) {
	const auto max = std::max(0, _contentHeight - height());
	if (max <= 0) {
		e->accept();
		return;
	}
	_scroll = std::clamp(_scroll - e->angleDelta().y() / 3, 0, max);
	update();
	e->accept();
}

} // namespace Parvane::NotesUi::CanvasWidgets
