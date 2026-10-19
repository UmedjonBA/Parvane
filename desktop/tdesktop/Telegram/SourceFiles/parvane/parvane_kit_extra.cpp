// Parvane fork: реализация parvane_kit.h, вторая часть — детали «Плана» (прогресс, галочка, метки, образцы
// цвета), поля ввода на Ui::InputField, шторка, меню на Ui::PopupMenu и ручка ширины панели.
#include "parvane/parvane_kit.h"

#include "parvane/parvane_kit_internal.h"

#include "base/event_filter.h"
#include "ui/effects/ripple_animation.h"
#include "ui/painter.h"
#include "ui/qt_object_factory.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/menu/menu.h"
#include "ui/widgets/menu/menu_item_base.h"
#include "ui/widgets/popup_menu.h"
#include "ui/widgets/scroll_area.h"
#include "ui/wrap/vertical_layout.h"
#include "styles/style_basic.h"
#include "styles/style_widgets.h"

#include <QtGui/QtEvents>
#include <QtGui/QAction>

namespace Parvane::Kit {

using namespace internal;

// ── полоса прогресса ─────────────────────────────────────────────────────────

Progress::Progress(QWidget *parent, Thickness thickness, Tone tone)
: RpWidget(parent)
, _thickness(thickness)
, _tone(tone) {
	RepaintOnTones(this);
	setAttribute(Qt::WA_TransparentForMouseEvents);
	const auto h = (_thickness == Thickness::Thin)
		? Rem(0.25)
		: (_thickness == Thickness::Thick)
		? Rem(0.5)
		: Rem(0.375);
	setNaturalWidth(-1);
	resize(width(), h);
}

void Progress::setValue(double value) {
	const auto clamped = std::clamp(value, 0., 1.);
	if (_value != clamped) {
		_value = clamped;
		update();
	}
}

void Progress::setTone(Tone tone) {
	_tone = tone;
	update();
}

void Progress::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto radius = height() / 2.;
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Line));
	p.drawRoundedRect(QRectF(rect()), radius, radius);
	if (_value > 0.) {
		p.setBrush(ToneColor(_tone));
		p.drawRoundedRect(QRectF(0, 0, width() * _value, height()), radius, radius);
	}
}

// ── круглая галочка ──────────────────────────────────────────────────────────

Check::Check(QWidget *parent, const QString &accessibleName, bool checked, bool isSmall, Tone tone)
: Button(parent)
, _small(isSmall)
, _tone(tone)
, _checked(checked) {
	setAccessibleName(accessibleName);
	const auto side = _small ? Rem(1.25) : Rem(1.375);
	setNaturalWidth(side);
	resize(side, side);
	setClickedCallback([=] { setChecked(!this->checked()); });
}

void Check::setChecked(bool checked) {
	if (_checked.current() != checked) {
		_checked = checked;
		accessibilityStateChanged({ .checked = true });
		update();
	}
}

bool Check::checked() const {
	return _checked.current();
}

rpl::producer<bool> Check::checkedChanges() const {
	return _checked.changes();
}

QAccessible::Role Check::accessibilityRole() {
	return QAccessible::CheckBox;
}

Ui::AccessibilityState Check::accessibilityState() const {
	return { .checkable = true, .checked = _checked.current(), .pressed = isDown() };
}

void Check::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto side = std::min(width(), height());
	const auto circle = QRectF((width() - side) / 2., (height() - side) / 2., side, side);
	const auto border = double(Rem(0.125));
	const auto on = _checked.current();
	if (on) {
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(_tone));
		p.drawEllipse(circle);
		// Галочка `--pv-accent-ink`: две стороны повёрнутого на −45° уголка
		auto pen = QPen(ToneColor(Tone::AccentInk));
		pen.setWidthF(border);
		pen.setCapStyle(Qt::RoundCap);
		pen.setJoinStyle(Qt::RoundJoin);
		p.setPen(pen);
		p.setBrush(Qt::NoBrush);
		const auto at = [&](double x, double y) {
			return QPointF(circle.x() + circle.width() * x, circle.y() + circle.height() * y);
		};
		const QPointF points[] = { at(0.29, 0.52), at(0.44, 0.66), at(0.72, 0.37) };
		p.drawPolyline(points, 3);
	} else {
		auto pen = QPen((isOver() || isDown()) ? ToneColor(Tone::Muted) : ToneColor(Tone::Line2));
		pen.setWidthF(border);
		p.setPen(pen);
		p.setBrush(Qt::NoBrush);
		const auto half = border / 2.;
		p.drawEllipse(circle.adjusted(half, half, -half, -half));
	}
	paintFocusRing(p, circle, side / 2.);
}

// ── метки ────────────────────────────────────────────────────────────────────

Tag::Tag(QWidget *parent, Descriptor descriptor)
: Button(parent)
, _descriptor(std::move(descriptor)) {
	setAccessibleName(_descriptor.text);
	if (!_descriptor.clickable) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
		setFocusPolicy(Qt::NoFocus);
		setPointerCursor(false);
	}
	refreshSize();
}

void Tag::setText(const QString &text) {
	_descriptor.text = text;
	setAccessibleName(text);
	refreshSize();
}

void Tag::setDone(bool done) {
	_descriptor.done = done;
	update();
}

int Tag::fontPx() const {
	return (_descriptor.kind == Kind::Small) ? 12 : 13;
}

int Tag::iconSize() const {
	switch (_descriptor.kind) {
	case Kind::Small: return Rem(0.8125);
	case Kind::Large: return Rem(0.875);
	case Kind::TypePill: return Rem(1);
	}
	return Rem(1);
}

QMargins Tag::padding() const {
	switch (_descriptor.kind) {
	case Kind::Small: return { Rem(0.375), Rem(0.0625), Rem(0.375), Rem(0.0625) };
	case Kind::Large: return { Rem(0.625), Rem(0.25), Rem(0.625), Rem(0.25) };
	case Kind::TypePill: return { Rem(0.75), 0, Rem(0.75), 0 };
	}
	return {};
}

void Tag::refreshSize() {
	const auto font = Font(fontPx(), _descriptor.kind == Kind::TypePill);
	const auto pad = padding();
	const auto gap = (_descriptor.kind == Kind::TypePill) ? Rem(0.375) : Rem(0.25);
	auto w = pad.left() + pad.right() + font->width(_descriptor.text);
	if (!_descriptor.icon.isEmpty()) {
		w += iconSize() + (_descriptor.text.isEmpty() ? 0 : gap);
	}
	// line-height 1.125rem; `.typePill` — высота 1.75rem
	const auto h = (_descriptor.kind == Kind::TypePill)
		? Rem(1.75)
		: (pad.top() + pad.bottom() + std::max(Rem(1.125), font->height));
	setNaturalWidth(w);
	resize(w, h);
	update();
}

void Tag::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	if (_descriptor.done) {
		p.setOpacity(0.6);
	}
	const auto r = QRectF(rect());
	const auto radius = (_descriptor.kind == Kind::Small)
		? double(Rem(0.3125))
		: std::min(height() / 2., double(Rem(0.875)));
	const auto tone = ToneColor(_descriptor.tone);
	const auto hover = _descriptor.clickable && (isOver() || isDown());
	const auto share = hover ? 0.30 : (_descriptor.kind == Kind::TypePill) ? 0.20 : 0.18;
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(Mix(tone, share));
		p.drawRoundedRect(r, radius, radius);
	}
	const auto pad = padding();
	const auto gap = (_descriptor.kind == Kind::TypePill) ? Rem(0.375) : Rem(0.25);
	auto x = pad.left();
	if (!_descriptor.icon.isEmpty()) {
		const auto icon = iconSize();
		PaintIconOrFallback(p, _descriptor.icon, tone, x, (height() - icon) / 2, icon);
		x += icon + gap;
	}
	const auto font = Font(fontPx(), _descriptor.kind == Kind::TypePill);
	p.setFont(font->f);
	p.setPen(tone);
	p.drawText(x, Baseline(font, 0, height()), font->elided(_descriptor.text, width() - x - pad.right()));
	p.setOpacity(1.);
	paintFocusRing(p, r, radius);
}

// ── образец цвета ────────────────────────────────────────────────────────────

Swatch::Swatch(QWidget *parent, std::optional<Tone> tone, const QString &accessibleName)
: Button(parent)
, _tone(tone) {
	setAccessibleName(accessibleName);
	// Круг 1.75rem и поле 0.125rem под обводку выбранного (`outline` рисуется снаружи круга)
	const auto side = Rem(1.75) + 2 * Rem(0.125);
	setNaturalWidth(side);
	resize(side, side);
}

void Swatch::setActive(bool active) {
	if (_active != active) {
		_active = active;
		accessibilityStateChanged({ .selected = true });
		update();
	}
}

Ui::AccessibilityState Swatch::accessibilityState() const {
	return { .pressed = isDown(), .selected = _active };
}

void Swatch::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto outline = double(Rem(0.125));
	const auto circle = QRectF(rect()).adjusted(outline, outline, -outline, -outline);
	p.setPen(Qt::NoPen);
	if (_active || (focusVisible() && hasFocus())) {
		p.setBrush(ToneColor(Tone::Accent));
		p.drawEllipse(QRectF(rect()));
	}
	// Кольцо `--pv-panel` 0.1875rem, внутри — цвет списка
	p.setBrush(ToneColor(Tone::Panel));
	p.drawEllipse(circle);
	if (_tone) {
		const auto ring = double(Rem(0.1875));
		p.setBrush(ToneColor(*_tone));
		p.drawEllipse(circle.adjusted(ring, ring, -ring, -ring));
	} else {
		// `.swatchNone`: `inset 0 0 0 1px --pv-line2`
		auto pen = QPen(ToneColor(Tone::Line2));
		const auto line = double(Px(1));
		pen.setWidthF(line);
		p.setPen(pen);
		p.setBrush(Qt::NoBrush);
		p.drawEllipse(circle.adjusted(line / 2., line / 2., -line / 2., -line / 2.));
	}
	if (isOver() || isDown()) {
		p.setPen(Qt::NoPen);
		p.setBrush(Mix(Tone::Fg, isDown() ? 0.12 : 0.06));
		p.drawEllipse(circle);
	}
}

// ── поле ввода ───────────────────────────────────────────────────────────────

struct Field::Styles {
	Styles()
	: textBg(ToneColor(Tone::Panel))
	, textBgActive(ToneColor(Tone::Panel))
	, textFg(ToneColor(Tone::Fg))
	, placeholderFg(ToneColor(Tone::Faint))
	, borderFg(ToneColor(Tone::Line2))
	, borderFgActive(ToneColor(Tone::Accent))
	, borderFgError(ToneColor(Tone::Red))
	, text(st::defaultTextStyle)
	, st(st::defaultInputField) {
	}

	style::owned_color textBg;
	style::owned_color textBgActive;
	style::owned_color textFg;
	style::owned_color placeholderFg;
	style::owned_color borderFg;
	style::owned_color borderFgActive;
	style::owned_color borderFgError;
	style::TextStyle text;
	style::InputField st;
};

namespace {

[[nodiscard]] int FieldHeight(Field::Kind kind) {
	switch (kind) {
	case Field::Kind::HeaderSearch: return Rem(2.25); // `.hdrSearchInput`
	case Field::Kind::Textarea: return Rem(7.5); // `.textarea` min-height
	case Field::Kind::Input:
	case Field::Kind::Search: break;
	}
	return Rem(2.625); // `.input`, `.searchInput`
}

[[nodiscard]] bool IsSearch(Field::Kind kind) {
	return (kind == Field::Kind::Search) || (kind == Field::Kind::HeaderSearch);
}

} // namespace

Field::Field(QWidget *parent, Kind kind, rpl::producer<QString> placeholder, const QString &value)
: RpWidget(parent)
, _kind(kind)
, _styles(std::make_unique<Styles>()) {
	// Цвета обновляем раньше Ui::InputField: его перекраска текста идёт по тому же PaletteChanged
	style::PaletteChanged() | rpl::on_next([=] {
		refreshColors();
	}, lifetime());

	const auto textarea = (_kind == Kind::Textarea);
	const auto height = FieldHeight(_kind);
	auto &st = _styles->st;
	auto &text = _styles->text;
	text.font = textarea ? Font(14, false, true) : Font(kBodyPx);
	text.lineHeight = textarea ? int(std::round(Px(14) * 1.6)) : 0;
	st.style = text;
	st.textBg = _styles->textBg.color();
	st.textBgActive = _styles->textBgActive.color();
	st.textFg = _styles->textFg.color();
	st.placeholderFg = _styles->placeholderFg.color();
	st.placeholderFgActive = _styles->placeholderFg.color();
	st.placeholderFgError = _styles->placeholderFg.color();
	st.borderFg = _styles->borderFg.color();
	st.borderFgActive = _styles->borderFgActive.color();
	st.borderFgError = _styles->borderFgError.color();
	st.placeholderFont = text.font;
	st.placeholderScale = 0.;
	st.placeholderShift = 0;
	st.placeholderMargins = style::margins();
	st.border = Px(1);
	st.borderActive = Px(1);
	st.borderDenominator = 1;
	st.borderRadius = textarea
		? Rem(0.5)
		: IsSearch(_kind)
		? (height / 2) // пилюля
		: Rem(0.5);
	const auto left = IsSearch(_kind) ? Rem(2.5) : textarea ? Rem(0.75) : Rem(0.75);
	const auto right = IsSearch(_kind) ? Rem(0.875) : Rem(0.75);
	if (textarea) {
		const auto pad = Rem(0.75);
		st.textMargins = style::margins(pad, pad, pad, pad);
		st.heightMin = height;
		st.heightMax = Rem(30);
	} else {
		const auto lineHeight = text.font->height;
		const auto top = std::max((height - lineHeight) / 2, 0);
		st.textMargins = style::margins(left, top, right, std::max(height - top - lineHeight, 0));
		st.heightMin = height;
		st.heightMax = height;
	}
	refreshColors();

	_input.create(
		this,
		_styles->st,
		textarea ? Ui::InputField::Mode::MultiLine : Ui::InputField::Mode::SingleLine,
		std::move(placeholder),
		value);
	if (textarea) {
		_input->setSubmitSettings(Ui::InputField::SubmitSettings::CtrlEnter);
	}
	_input->heightValue() | rpl::on_next([=](int h) {
		resize(width(), h);
	}, lifetime());
	sizeValue() | rpl::on_next([=](QSize size) {
		_input->resizeToWidth(size.width());
	}, lifetime());
	_input->focusedChanges() | rpl::on_next([=] {
		update();
	}, lifetime());

	if (IsSearch(_kind)) {
		// Лупа поверх поля (`.searchIcon`), мышь проходит в поле
		const auto icon = Ui::CreateChild<Ui::RpWidget>(this);
		icon->setAttribute(Qt::WA_TransparentForMouseEvents);
		const auto size = Rem(1.125);
		icon->resize(size, size);
		rpl::combine(
			sizeValue(),
			rpl::single(rpl::empty) | rpl::then(TonesChanges())
		) | rpl::on_next([=](QSize outer, auto) {
			icon->move(searchIconLeft(), (outer.height() - size) / 2);
			icon->update();
		}, icon->lifetime());
		icon->paintRequest() | rpl::on_next([=] {
			auto p = QPainter(icon);
			PaintIconOrFallback(p, u"search"_q, ToneColor(Tone::Muted), 0, 0, size);
		}, icon->lifetime());
	}

	TonesChanges() | rpl::on_next([=] {
		refreshColors();
	}, lifetime());

	setNaturalWidth(-1);
	resize(width(), _input->height());
}

Field::~Field() {
	// Ui::InputField держит ссылку на стиль: удалить его раньше _styles (object_ptr ребёнка сам не удаляет)
	_input.destroy();
}

int Field::searchIconLeft() const {
	return Rem(0.75);
}

void Field::refreshColors() {
	const auto search = IsSearch(_kind);
	const auto bg = ToneColor(search ? Tone::Raised : Tone::Panel);
	_styles->textBg.update(bg);
	_styles->textBgActive.update(bg);
	_styles->textFg.update(ToneColor(Tone::Fg));
	_styles->placeholderFg.update(ToneColor(Tone::Faint));
	const auto red = ToneColor(Tone::Red);
	_styles->borderFg.update(_error
		? red
		: search
		? Mix(bg, 0.) // `border: 1px solid transparent`
		: ToneColor(Tone::Line2));
	_styles->borderFgActive.update(_error ? red : ToneColor(Tone::Accent));
	_styles->borderFgError.update(red);
	if (_input) {
		_input->update();
	}
	update();
}

not_null<Ui::InputField*> Field::input() const {
	return _input.data();
}

QString Field::text() const {
	return _input->getLastText();
}

void Field::setText(const QString &text) {
	_input->setText(text);
}

void Field::setError(bool error) {
	if (_error != error) {
		_error = error;
		refreshColors();
	}
}

void Field::setFocusFast() {
	_input->setFocusFast();
}

rpl::producer<QString> Field::textChanges() const {
	const auto input = _input.data();
	return input->changes() | rpl::map([=] {
		return input->getLastText();
	});
}

rpl::producer<> Field::submits() const {
	return _input->submits() | rpl::to_empty;
}

rpl::producer<> Field::cancels() const {
	return _input->cancelled();
}

int Field::resizeGetHeight(int newWidth) {
	_input->resizeToWidth(newWidth);
	return _input->height();
}

void Field::paintEvent(QPaintEvent *e) {
	// Поле рисует себя само (фон, рамка, скругление); под ним ничего нет
}

// ── шторка ───────────────────────────────────────────────────────────────────

Sheet::Sheet(not_null<QWidget*> parent, Descriptor descriptor)
: RpWidget(parent)
, _descriptor(std::move(descriptor)) {
	RepaintOnTones(this);
	setFocusPolicy(Qt::StrongFocus);

	if (!_descriptor.closeName.isEmpty()) {
		_close = Ui::CreateChild<IconButton>(this, u"close"_q, _descriptor.closeName);
		_close->setClickedCallback([=] { requestClose(); });
	}
	_scroll = Ui::CreateChild<Ui::ScrollArea>(this);
	_content = _scroll->setOwnedWidget(object_ptr<Ui::VerticalLayout>(_scroll)).data();
	_content->heightValue() | rpl::on_next([=] {
		relayout();
	}, lifetime());

	setGeometry(QRect(QPoint(), parent->size()));
	base::install_event_filter(this, parent, [=](not_null<QEvent*> e) {
		if (e->type() == QEvent::Resize) {
			setGeometry(QRect(QPoint(), parentWidget()->size()));
		}
		return base::EventFilterResult::Continue;
	});
	sizeValue() | rpl::on_next([=] {
		relayout();
	}, lifetime());
}

Sheet::~Sheet() = default;

not_null<Sheet*> Sheet::Show(not_null<QWidget*> parent, Descriptor descriptor) {
	const auto result = Ui::CreateChild<Sheet>(parent.get(), std::move(descriptor));
	result->showSheet();
	return result;
}

void Sheet::setTitle(const QString &title) {
	_descriptor.title = title;
	update();
}

Ui::RpWidget *Sheet::addItem(object_ptr<Ui::RpWidget> child) {
	// `.modal-content`: промежуток 0.875rem (`.sheetTight` — 0.125rem)
	const auto gap = _content->count() ? (_descriptor.tight ? Rem(0.125) : Rem(0.875)) : 0;
	return _content->add(std::move(child), style::margins(0, gap, 0, 0));
}

not_null<Flow*> Sheet::addButtons() {
	return add(object_ptr<Flow>(_content, Rem(0.5)));
}

not_null<Ui::VerticalLayout*> Sheet::content() const {
	return _content;
}

int Sheet::headHeight() const {
	// `.sheetHead`: поля 0.875rem сверху, 0.25rem снизу; название 1.125rem × 1.45 или кнопка закрытия
	const auto title = int(std::round(Font(18, true)->f.pixelSize() * 1.45));
	const auto line = std::max(title, _close ? _close->height() : 0);
	return Rem(0.875) + line + Rem(0.25);
}

QRect Sheet::paneRect() const {
	const auto margin = Rem(1);
	const auto maxWidth = _descriptor.wide ? Rem(56) : Rem(35);
	const auto w = std::max(std::min(maxWidth, width() - 2 * margin), 0);
	const auto top = std::max(height() / 10, margin); // `padding: 10vh 1rem 1rem`
	const auto maxHeight = std::max(std::min(height() * 8 / 10, height() - top - margin), 0);
	const auto inner = _content->height();
	const auto h = std::min(headHeight() + Rem(0.5) + inner + Rem(1.25), maxHeight);
	return QRect((width() - w) / 2, top, w, h);
}

void Sheet::relayout() {
	const auto pane = paneRect();
	const auto padX = Rem(1.25);
	const auto head = headHeight();
	if (_close) {
		_close->move(pane.x() + pane.width() - Rem(1) - _close->width(), pane.y() + Rem(0.875));
	}
	const auto innerWidth = std::max(pane.width() - 2 * padX, 0);
	_content->resizeToWidth(innerWidth);
	// `.modal-content`: поля 0.5rem 1.25rem 1.25rem; прокрутка внутри окна
	_scroll->setGeometry(
		pane.x() + padX,
		pane.y() + head + Rem(0.5),
		innerWidth,
		std::max(pane.height() - head - Rem(0.5) - Rem(1.25), 0));
	update();
}

void Sheet::showSheet() {
	show();
	raise();
	setFocus(Qt::OtherFocusReason);
}

void Sheet::requestClose() {
	if (_closing) {
		return;
	}
	_closing = true;
	_closed.fire({});
	hide();
	deleteLater();
}

rpl::producer<> Sheet::closed() const {
	return _closed.events();
}

void Sheet::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.fillRect(e->rect(), QColor(0, 0, 0, 115)); // `rgb(0 0 0 / 45%)`
	const auto pane = QRectF(paneRect());
	const auto radius = double(Rem(1.125));
	// Тень `0 1.25rem 3.75rem rgb(0 0 0 / 40%)` — мягкими кольцами
	PaintSoftShadow(p, pane, radius, Rem(1), 0.4, Rem(0.5));
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Panel));
		p.drawRoundedRect(pane, radius, radius);
	}
	if (_descriptor.title.isEmpty()) {
		return;
	}
	const auto font = Font(18, true);
	const auto left = int(pane.x()) + Rem(1.25);
	const auto right = _close ? _close->x() - Rem(0.5) : int(pane.x() + pane.width()) - Rem(1);
	const auto top = int(pane.y()) + Rem(0.875);
	const auto line = headHeight() - Rem(0.875) - Rem(0.25);
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(left, Baseline(font, top, line), font->elided(_descriptor.title, std::max(right - left, 0)));
}

void Sheet::mousePressEvent(QMouseEvent *e) {
	if (_descriptor.closeByScrim && !paneRect().contains(e->pos())) {
		requestClose();
	}
}

void Sheet::keyPressEvent(QKeyEvent *e) {
	if (e->key() == Qt::Key_Escape) {
		requestClose();
		return;
	}
	RpWidget::keyPressEvent(e);
}

// ── меню ─────────────────────────────────────────────────────────────────────

namespace {

// Один стиль на все меню набора: цвета обновляются перед каждым показом (меню живут недолго)
struct MenuStyle {
	MenuStyle()
	: bg(ToneColor(Tone::Panel))
	, bgOver(ToneColor(Tone::Hover))
	, fg(ToneColor(Tone::Fg))
	, fgDisabled(ToneColor(Tone::Faint))
	, muted(ToneColor(Tone::Muted))
	, line(ToneColor(Tone::Line))
	, ripple(ToneColor(Tone::Hover))
	, popup(st::defaultPopupMenu) {
		auto &menu = popup.menu;
		menu.itemBg = bg.color();
		menu.itemBgOver = bgOver.color();
		menu.itemFg = fg.color();
		menu.itemFgOver = fg.color();
		menu.itemFgDisabled = fgDisabled.color();
		menu.itemFgShortcut = muted.color();
		menu.itemFgShortcutOver = muted.color();
		menu.itemFgShortcutDisabled = fgDisabled.color();
		menu.separator.fg = line.color();
		menu.ripple.color = ripple.color();
		menu.itemPadding = style::margins(Rem(0.875), Rem(0.5), Rem(0.875), Rem(0.5));
		popup.radius = Rem(0.75);
	}

	void refresh() {
		bg.update(ToneColor(Tone::Panel));
		bgOver.update(ToneColor(Tone::Hover));
		fg.update(ToneColor(Tone::Fg));
		fgDisabled.update(ToneColor(Tone::Faint));
		muted.update(ToneColor(Tone::Muted));
		line.update(ToneColor(Tone::Line));
		ripple.update(ToneColor(Tone::Hover));
	}

	style::owned_color bg;
	style::owned_color bgOver;
	style::owned_color fg;
	style::owned_color fgDisabled;
	style::owned_color muted;
	style::owned_color line;
	style::owned_color ripple;
	style::PopupMenu popup;
};

[[nodiscard]] MenuStyle &SharedMenuStyle() {
	static auto result = MenuStyle();
	return result;
}

// Пункт меню: значок ParvaneIcon 1.125rem, подпись 0.875rem; опасный — красным
class MenuItem final : public Ui::Menu::ItemBase {
public:
	MenuItem(
		not_null<Ui::Menu::Menu*> parent,
		const style::Menu &st,
		const QString &text,
		const QString &icon,
		bool danger)
	: ItemBase(parent, st)
	, _st(st)
	, _action(Ui::CreateChild<QAction>(parent.get()))
	, _text(text)
	, _icon(icon)
	, _danger(danger) {
		_action->setText(text);
		const auto font = Font(14);
		const auto pad = _st.itemPadding;
		_height = pad.top() + std::max(font->height, Rem(1.125)) + pad.bottom();
		const auto iconPart = _icon.isEmpty() ? 0 : (Rem(1.125) + Rem(0.75));
		setMinWidth(std::clamp(
			pad.left() + iconPart + font->width(_text) + pad.right(),
			_st.widthMin,
			_st.widthMax));
		fitToMenuWidth();
		enableMouseSelecting();
		paintRequest() | rpl::on_next([=] {
			auto p = QPainter(this);
			paint(p);
		}, lifetime());
	}

	QAccessible::Role accessibilityRole() override {
		return QAccessible::MenuItem;
	}
	QString accessibilityName() override {
		return _text;
	}

	bool isEnabled() const override {
		return true;
	}
	not_null<QAction*> action() const override {
		return _action;
	}

	void handleKeyPress(not_null<QKeyEvent*> e) override {
		if (!isSelected()) {
			return;
		}
		const auto key = e->key();
		if (key == Qt::Key_Enter || key == Qt::Key_Return || key == Qt::Key_Space) {
			setClicked(Ui::Menu::TriggeredSource::Keyboard);
		}
	}

protected:
	QPoint prepareRippleStartPosition() const override {
		return mapFromGlobal(QCursor::pos());
	}
	QImage prepareRippleMask() const override {
		return Ui::RippleAnimation::RectMask(size());
	}
	int contentHeight() const override {
		return _height;
	}

private:
	void paint(QPainter &p) {
		const auto selected = isSelected();
		p.fillRect(0, 0, width(), _height, selected ? _st.itemBgOver : _st.itemBg);
		paintRipple(p, 0, 0);
		const auto fg = _danger ? ToneColor(Tone::Red) : ToneColor(Tone::Fg);
		const auto pad = _st.itemPadding;
		auto x = pad.left();
		if (!_icon.isEmpty()) {
			const auto icon = Rem(1.125);
			const auto color = _danger ? fg : ToneColor(Tone::Muted);
			PaintIconOrFallback(p, _icon, color, x, (_height - icon) / 2, icon);
			x += icon + Rem(0.75);
		}
		const auto font = Font(14);
		p.setFont(font->f);
		p.setPen(fg);
		p.drawText(x, Baseline(font, 0, _height), font->elided(_text, width() - x - pad.right()));
	}

	const style::Menu &_st;
	const not_null<QAction*> _action;
	const QString _text;
	const QString _icon;
	const bool _danger = false;
	int _height = 0;

};

} // namespace

base::unique_qptr<Ui::PopupMenu> CreateMenu(QWidget *parent) {
	auto &shared = SharedMenuStyle();
	shared.refresh();
	return base::make_unique_q<Ui::PopupMenu>(parent, shared.popup);
}

void AddMenuAction(
		not_null<Ui::PopupMenu*> menu,
		const QString &text,
		Fn<void()> callback,
		const QString &icon,
		bool danger) {
	auto item = base::make_unique_q<MenuItem>(
		menu->menu(),
		menu->menu()->st(),
		text,
		icon,
		danger);
	item->setActionTriggered(std::move(callback));
	menu->addAction(std::move(item));
}

// ── ручка ширины панели ──────────────────────────────────────────────────────

Resizer::Resizer(QWidget *parent, const QString &accessibleName)
: RpWidget(parent)
, _accessibleName(accessibleName) {
	RepaintOnTones(this);
	setFocusPolicy(Qt::TabFocus);
	setMouseTracking(true);
	setCursor(Qt::SizeHorCursor);
	QWidget::setAccessibleName(accessibleName);
	const auto w = Rem(0.625);
	setNaturalWidth(w);
	resize(w, height());
}

rpl::producer<int> Resizer::moves() const {
	return _moves.events();
}

rpl::producer<> Resizer::finished() const {
	return _finished.events();
}

QAccessible::Role Resizer::accessibilityRole() {
	return QAccessible::Separator;
}

QString Resizer::accessibilityName() {
	return _accessibleName;
}

void Resizer::paintEvent(QPaintEvent *e) {
	if (!_over && !_pressX && !_focused) {
		return;
	}
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto line = double(Rem(0.125));
	p.setPen(Qt::NoPen);
	p.setBrush(Mix(Tone::Accent, 0.7));
	p.drawRoundedRect(QRectF((width() - line) / 2., 0, line, height()), line / 2., line / 2.);
}

void Resizer::enterEventHook(QEnterEvent *e) {
	_over = true;
	update();
}

void Resizer::leaveEventHook(QEvent *e) {
	_over = false;
	update();
}

void Resizer::mousePressEvent(QMouseEvent *e) {
	if (e->button() == Qt::LeftButton) {
		_pressX = e->globalPosition().toPoint().x();
		update();
	}
}

void Resizer::mouseMoveEvent(QMouseEvent *e) {
	if (_pressX) {
		_moves.fire(e->globalPosition().toPoint().x() - *_pressX);
	}
}

void Resizer::mouseReleaseEvent(QMouseEvent *e) {
	if (_pressX && e->button() == Qt::LeftButton) {
		_moves.fire(e->globalPosition().toPoint().x() - *_pressX);
		_pressX = std::nullopt;
		_finished.fire({});
		update();
	}
}

void Resizer::keyPressEvent(QKeyEvent *e) {
	const auto key = e->key();
	if (key == Qt::Key_Left || key == Qt::Key_Right) {
		_moves.fire((key == Qt::Key_Left) ? -Rem(1) : Rem(1));
		_finished.fire({});
		return;
	}
	RpWidget::keyPressEvent(e);
}

void Resizer::focusInEvent(QFocusEvent *e) {
	_focused = (e->reason() != Qt::MouseFocusReason);
	RpWidget::focusInEvent(e);
	update();
}

void Resizer::focusOutEvent(QFocusEvent *e) {
	_focused = false;
	RpWidget::focusOutEvent(e);
	update();
}

void ClearLayout(not_null<Ui::VerticalLayout*> layout) {
	auto widgets = std::vector<QPointer<QWidget>>();
	widgets.reserve(layout->count());
	for (auto i = 0, count = layout->count(); i != count; ++i) {
		widgets.push_back(layout->widgetAt(i).get());
	}
	// Удаление строки раскладка видит сама (конец её сигнала высоты) и убирает строку из себя
	for (const auto &widget : widgets) {
		delete widget.data();
	}
}

} // namespace Parvane::Kit
