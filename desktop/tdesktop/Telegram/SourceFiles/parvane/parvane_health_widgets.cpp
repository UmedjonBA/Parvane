// Parvane fork: реализация parvane_health_widgets.h — детали экрана «Здоровье» (spec 029, T062).
#include "parvane/parvane_health_widgets.h"

#include "ui/painter.h"
#include "ui/qt_object_factory.h"
#include "ui/widgets/fields/input_field.h"

#include <QtGui/QPainterPath>
#include <QtGui/QtEvents>

#include <cmath>

namespace Parvane::Health {
namespace {

using Kit::Font;
using Kit::Px;
using Kit::Rem;

[[nodiscard]] int Baseline(const style::font &font, int top, int height) {
	return top + (height - font->height) / 2 + font->ascent;
}

} // namespace

Tone KindTone(Kind kind) {
	switch (kind) {
	case Kind::Event: return Tone::Blue;
	case Kind::Task: return Tone::Purple;
	case Kind::Food: return Tone::Orange;
	case Kind::Sleep: return Tone::Aqua;
	case Kind::Workout: return Tone::Green;
	case Kind::Note: return Tone::Yellow;
	case Kind::Metric: return Tone::Red;
	case Kind::Due: return Tone::Red;
	case Kind::Muted: return Tone::Muted;
	case Kind::Good: return Tone::Green;
	case Kind::Warn: return Tone::Yellow;
	}
	return Tone::Accent;
}

// ── карточка ─────────────────────────────────────────────────────────────────

Card::Card(QWidget *parent)
: RpWidget(parent) {
	Kit::RepaintOnTones(this);
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
}

not_null<Ui::VerticalLayout*> Card::column() const {
	return _column;
}

Ui::RpWidget *Card::addItem(object_ptr<Ui::RpWidget> child, int gap) {
	return PlannerForms::AddTo(_column, std::move(child), (gap < 0) ? Rem(0.875) : gap);
}

int Card::resizeGetHeight(int newWidth) {
	const auto pad = Rem(1);
	_column->resizeToWidth(std::max(newWidth - 2 * pad, 1));
	_column->moveToLeft(pad, pad, newWidth);
	return _column->height() + 2 * pad;
}

void Card::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Raised));
	p.drawRoundedRect(QRectF(rect()), Rem(0.75), Rem(0.75));
}

object_ptr<Line> MakeHead(QWidget *parent, const QString &title, const QString &note, bool group) {
	auto result = object_ptr<Line>(parent, Rem(0.5));
	const auto raw = result.data();
	// `.cardHead`: высота не меньше 2.25rem
	raw->add(object_ptr<Kit::Caps>(raw, title, group ? Kit::Caps::Kind::Caps : Kit::Caps::Kind::CardTitle));
	raw->addStretch();
	if (!note.isEmpty()) {
		raw->add(object_ptr<Kit::Label>(raw, note, Kit::Label::Style{ .px = 13, .tone = Tone::Muted }));
	}
	const auto spacer = raw->add(object_ptr<Ui::RpWidget>(raw));
	spacer->setNaturalWidth(0);
	spacer->resize(0, Rem(2.25));
	return result;
}

// ── крупное значение ─────────────────────────────────────────────────────────

BigValue::BigValue(QWidget *parent, const QString &value, Tone tone, const QString &suffix, bool clickable)
: Button(parent)
, _value(value)
, _tone(tone)
, _suffix(suffix)
, _clickable(clickable) {
	Kit::RepaintOnTones(this);
	setAccessibleName(value + ' ' + suffix);
	if (!_clickable) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
	}
	setNaturalWidth(-1);
}

int BigValue::resizeGetHeight(int newWidth) {
	// `.big`: 2.125rem, строка 1
	return Font(34, true, true)->height;
}

void BigValue::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto big = Font(34, true, true);
	const auto small = Font(Kit::kBodyPx);
	auto tone = ToneColor(_tone);
	auto muted = ToneColor(Tone::Muted);
	if (_clickable && (isOver() || isDown())) {
		// `filter: brightness(1.15)`
		tone = tone.lighter(115);
		muted = muted.lighter(115);
	}
	p.setFont(big->f);
	p.setPen(tone);
	const auto baseline = big->ascent;
	p.drawText(0, baseline, _value);
	const auto x = big->width(_value) + Rem(0.5);
	if (!_suffix.isEmpty()) {
		p.setFont(small->f);
		p.setPen(muted);
		p.drawText(x, baseline, small->elided(_suffix, std::max(width() - x, 0)));
	}
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, QRectF(rect()), Rem(0.25));
	}
}

// ── строки нутриентов и прогресса ────────────────────────────────────────────

MacroRow::MacroRow(QWidget *parent, const QString &label, const QString &value, const QString &goalPart, double fraction, Tone tone, bool red)
: RpWidget(parent)
, _label(label)
, _value(value)
, _goalPart(goalPart)
, _fraction(std::clamp(fraction, 0., 1.))
, _tone(tone)
, _red(red) {
	Kit::RepaintOnTones(this);
	setNaturalWidth(-1);
}

int MacroRow::resizeGetHeight(int newWidth) {
	return Font(14)->height + Px(2);
}

void MacroRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	// `grid-template-columns: 5.25rem 6.5rem 1fr; gap 0.625rem`, 0.875rem
	const auto font = Font(14);
	const auto mono = Font(14, false, true);
	const auto baseline = Baseline(font, 0, height());
	const auto first = Rem(5.25);
	const auto second = Rem(6.5);
	const auto gap = Rem(0.625);
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Muted));
	p.drawText(0, baseline, font->elided(_label, first));
	auto x = first + gap;
	p.setFont(mono->f);
	p.setPen(ToneColor(_red ? Tone::Red : Tone::Fg));
	p.drawText(x, baseline, _value);
	x += mono->width(_value);
	p.setPen(ToneColor(Tone::Muted));
	p.drawText(x, baseline, mono->elided(_goalPart, std::max(first + gap + second - x, 0)));
	const auto barLeft = first + gap + second + gap;
	const auto barWidth = std::max(width() - barLeft, 0);
	const auto barHeight = Rem(0.375);
	const auto bar = QRectF(barLeft, (height() - barHeight) / 2., barWidth, barHeight);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Line));
	p.drawRoundedRect(bar, barHeight / 2., barHeight / 2.);
	if (_fraction > 0.) {
		p.setBrush(ToneColor(_tone));
		p.drawRoundedRect(QRectF(bar.x(), bar.y(), bar.width() * _fraction, bar.height()), barHeight / 2., barHeight / 2.);
	}
}

ProgressRow::ProgressRow(QWidget *parent, const QString &label, const QString &value, const QString &goalPart, double fraction, Tone tone)
: RpWidget(parent)
, _label(label)
, _value(value)
, _goalPart(goalPart)
, _fraction(std::clamp(fraction, 0., 1.))
, _tone(tone) {
	Kit::RepaintOnTones(this);
	setNaturalWidth(-1);
}

int ProgressRow::resizeGetHeight(int newWidth) {
	// `.healthRowHead` (0.875rem, отступ 0.25rem) и `.progThick` 0.5rem
	return Font(14)->height + Rem(0.25) + Rem(0.5);
}

void ProgressRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto font = Font(14);
	const auto mono = Font(14, false, true);
	const auto monoBold = Font(14, true, true);
	const auto baseline = font->ascent;
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(0, baseline, _label);
	const auto goalWidth = mono->width(_goalPart);
	const auto valueWidth = monoBold->width(_value);
	auto x = width() - goalWidth - valueWidth;
	p.setFont(monoBold->f);
	p.setPen(ToneColor(_tone));
	p.drawText(x, baseline, _value);
	x += valueWidth;
	p.setFont(mono->f);
	p.setPen(ToneColor(Tone::Muted));
	p.drawText(x, baseline, _goalPart);
	const auto barHeight = Rem(0.5);
	const auto bar = QRectF(0, height() - barHeight, width(), barHeight);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Line));
	p.drawRoundedRect(bar, Rem(0.25), Rem(0.25));
	if (_fraction > 0.) {
		p.setBrush(ToneColor(_tone));
		p.drawRoundedRect(QRectF(0, bar.y(), bar.width() * _fraction, barHeight), Rem(0.25), Rem(0.25));
	}
}

object_ptr<Kit::Progress> MakeProgress(QWidget *parent, double fraction, Tone tone, bool thick) {
	auto result = object_ptr<Kit::Progress>(
		parent,
		thick ? Kit::Progress::Thickness::Thick : Kit::Progress::Thickness::Normal,
		tone);
	result->setValue(fraction);
	return result;
}

// ── строки записей ───────────────────────────────────────────────────────────

EntryRow::EntryRow(QWidget *parent, Descriptor descriptor, Fn<void()> remove)
: RpWidget(parent)
, _descriptor(std::move(descriptor)) {
	Kit::RepaintOnTones(this);
	_remove = Ui::CreateChild<PlannerForms::GlyphButton>(this, u"close"_q, _descriptor.deleteName, true);
	_remove->setClickedCallback(std::move(remove));
	setNaturalWidth(-1);
	setMouseTracking(true);
}

int EntryRow::leftWidth() const {
	// `.healthTime` 2.875rem; `.rowIcon` 1.75rem
	return _descriptor.icon.isEmpty() ? Rem(2.875) : Rem(1.75);
}

int EntryRow::resizeGetHeight(int newWidth) {
	const auto h = std::max(Rem(2.75), Font(Kit::kBodyPx)->height + Font(13)->height + 2 * Rem(0.375));
	_remove->moveToLeft(newWidth - Rem(0.625) - _remove->width(), (h - _remove->height()) / 2, newWidth);
	return h;
}

void EntryRow::enterEventHook(QEnterEvent *e) {
	_over = true;
	update();
}

void EntryRow::leaveEventHook(QEvent *e) {
	_over = false;
	update();
}

void EntryRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	if (_over) {
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawRoundedRect(QRectF(rect()), Rem(0.5), Rem(0.5));
	}
	// `.row`: поля 0.375rem 0.625rem, промежуток 0.75rem
	const auto pad = Rem(0.625);
	const auto gap = Rem(0.75);
	auto x = pad;
	if (!_descriptor.icon.isEmpty()) {
		const auto side = Rem(1.75);
		const auto rect = QRect(x, (height() - side) / 2, side, side);
		{
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(Kit::Mix(_descriptor.iconTone, 0.22));
			p.drawRoundedRect(QRectF(rect), Rem(0.5), Rem(0.5));
		}
		const auto icon = Rem(1.125);
		PlannerForms::PaintGlyph(
			p,
			_descriptor.icon,
			ToneColor(_descriptor.iconTone),
			QRect(rect.x() + (side - icon) / 2, rect.y() + (side - icon) / 2, icon, icon));
	} else {
		const auto mono = Font(13, false, true);
		p.setFont(mono->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(x, Baseline(mono, 0, height()), _descriptor.time);
	}
	x += leftWidth() + gap;
	const auto metaFont = Font(13, false, true);
	const auto metaWidth = metaFont->width(_descriptor.meta);
	const auto right = _remove->x() - gap;
	const auto bodyWidth = std::max(right - (metaWidth ? metaWidth + gap : 0) - x, 1);
	const auto title = Font(Kit::kBodyPx);
	const auto sub = Font(13, false, _descriptor.subtitleMono);
	const auto total = title->height + (_descriptor.subtitle.isEmpty() ? 0 : sub->height);
	auto y = (height() - total) / 2;
	p.setFont(title->f);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(x, y + title->ascent, title->elided(_descriptor.title, bodyWidth));
	if (!_descriptor.subtitle.isEmpty()) {
		y += title->height;
		p.setFont(sub->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(x, y + sub->ascent, sub->elided(_descriptor.subtitle, bodyWidth));
	}
	if (metaWidth) {
		p.setFont(metaFont->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(right - metaWidth, Baseline(metaFont, 0, height()), _descriptor.meta);
	}
}

// ── показатель тела ──────────────────────────────────────────────────────────

FactButton::FactButton(QWidget *parent, const QString &label, const QString &value, bool accent)
: Button(parent)
, _label(label)
, _value(value)
, _accent(accent) {
	setAccessibleName(label);
	Kit::RepaintOnTones(this);
	setNaturalWidth(-1);
}

int FactButton::resizeGetHeight(int newWidth) {
	// `.healthFact`: поля 0.625rem 0.75rem, промежуток 0.125rem
	return 2 * Rem(0.625) + Font(12)->height + Rem(0.125) + Font(Kit::kBodyPx, true, true)->height;
}

void FactButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Panel));
		p.drawRoundedRect(r, Rem(0.75), Rem(0.75));
	}
	const auto bright = isOver() || isDown();
	const auto label = Font(12);
	const auto value = Font(Kit::kBodyPx, true, true);
	const auto padX = Rem(0.75);
	const auto inner = std::max(width() - 2 * padX, 0);
	auto y = Rem(0.625);
	p.setFont(label->f);
	auto muted = ToneColor(Tone::Muted);
	p.setPen(bright ? muted.lighter(115) : muted);
	p.drawText(padX, y + label->ascent, label->elided(_label, inner));
	y += label->height + Rem(0.125);
	p.setFont(value->f);
	const auto known = !_value.isEmpty();
	auto color = !known ? ToneColor(Tone::Faint) : _accent ? ToneColor(Tone::Yellow) : ToneColor(Tone::Fg);
	p.setPen(bright ? color.lighter(115) : color);
	p.drawText(padX, y + value->ascent, value->elided(known ? _value : QString(QChar(0x2014)), inner));
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, r, Rem(0.75));
	}
}

// ── столбики недели ──────────────────────────────────────────────────────────

Bars::Bars(QWidget *parent, Data data)
: RpWidget(parent)
, _data(std::move(data)) {
	Kit::RepaintOnTones(this);
	setNaturalWidth(-1);
}

int Bars::resizeGetHeight(int newWidth) {
	// `.bars`: 9.375rem + поле 1.125rem сверху; `.barsLabels`: отступ 0.375rem и строка 0.75rem
	return Rem(1.125) + Rem(9.375) + Rem(0.375) + Font(12)->height;
}

void Bars::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto count = int(_data.values.size());
	if (!count) {
		return;
	}
	// Столбики занимают 86 % высоты графика, над самым высоким — запас 15 %
	auto max = std::max(1., _data.goal.value_or(0.));
	for (const auto &value : _data.values) {
		max = std::max(max, value.value_or(0.));
	}
	max *= 1.15;
	const auto top = Rem(1.125);
	const auto content = Rem(9.375);
	const auto total = top + content;
	const auto gap = Rem(0.5);
	const auto column = std::max((width() - gap * (count - 1)) / double(count), 1.);
	const auto valueFont = Font(11, false, true);
	const auto tone = ToneColor(_data.tone);
	for (auto i = 0; i != count; ++i) {
		const auto x = i * (column + gap);
		const auto value = _data.values[i];
		const auto low = value && _data.isLow && _data.isLow(*value);
		const auto zero = value && *value == 0.;
		auto fillHeight = (value.value_or(0.) / max) * 0.86 * content;
		if (zero) {
			fillHeight = std::max(fillHeight, double(Rem(0.375))); // красная «свеча» дня с записанным нулём
		}
		const auto fillWidth = std::min(column, double(Rem(2.125)));
		const auto fill = QRectF(x + (column - fillWidth) / 2., total - fillHeight, fillWidth, fillHeight);
		if (fillHeight > 0.) {
			p.setPen(Qt::NoPen);
			p.setBrush((low || zero) ? ToneColor(Tone::Red) : tone);
			const auto radius = std::min(double(Rem(0.375)), fillHeight / 2.);
			p.drawRoundedRect(fill, radius, radius);
		}
		if (i < int(_data.current.size()) && _data.current[i]) {
			auto pen = QPen(ToneColor(Tone::Fg));
			pen.setWidthF(Px(2));
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			const auto ring = fill.adjusted(-Px(1), -Px(1), Px(1), Px(1));
			p.drawRoundedRect(ring, Rem(0.375), Rem(0.375));
		}
		// Записанный ноль — подпись есть; нет данных — прочерк
		const auto text = value ? _data.format(*value) : QString(QChar(0x2014));
		p.setFont(valueFont->f);
		p.setPen(ToneColor(Tone::Muted));
		const auto textY = total - fillHeight - Rem(0.25) - valueFont->descent;
		p.drawText(
			QRectF(x - gap / 2., textY - valueFont->ascent, column + gap, valueFont->height),
			Qt::AlignHCenter | Qt::AlignTop,
			text);
	}
	if (_data.goal && *_data.goal > 0.) {
		const auto y = total - (*_data.goal / max) * 0.86 * total;
		auto pen = QPen(ToneColor(Tone::Faint));
		pen.setWidthF(Px(1));
		pen.setStyle(Qt::DashLine);
		p.setPen(pen);
		p.drawLine(QPointF(0, y), QPointF(width(), y));
		const auto label = _data.format(*_data.goal);
		p.setFont(valueFont->f);
		p.setPen(ToneColor(Tone::Faint));
		p.drawText(int(width() - valueFont->width(label)), int(y - Rem(1) + valueFont->ascent), label);
	}
	const auto labelFont = Font(12);
	const auto labelBold = Font(12, true);
	const auto labelTop = total + Rem(0.375);
	for (auto i = 0; i != count && i < int(_data.labels.size()); ++i) {
		const auto x = i * (column + gap);
		const auto current = (i < int(_data.current.size()) && _data.current[i]);
		const auto font = current ? labelBold : labelFont;
		p.setFont(font->f);
		p.setPen(ToneColor(current ? Tone::Fg : Tone::Muted));
		p.drawText(QRectF(x, labelTop, column, font->height), Qt::AlignHCenter | Qt::AlignTop, _data.labels[i]);
	}
}

// ── график веса ──────────────────────────────────────────────────────────────

WeightSpark::WeightSpark(QWidget *parent, std::vector<std::optional<double>> series, std::optional<double> goal, QString goalLabel)
: RpWidget(parent)
, _series(std::move(series))
, _goal(goal)
, _goalLabel(std::move(goalLabel)) {
	Kit::RepaintOnTones(this);
	setNaturalWidth(-1);
}

int WeightSpark::resizeGetHeight(int newWidth) {
	// `viewBox 0 0 300 90`, ширина 100 %
	return int(std::round(newWidth * 90. / 300.));
}

void WeightSpark::paintEvent(QPaintEvent *e) {
	constexpr auto kWidth = 300.;
	constexpr auto kHeight = 90.;
	constexpr auto kPad = 6.;
	constexpr auto kDot = 4.;
	constexpr auto kPadKg = 0.5;
	auto known = std::vector<std::pair<int, double>>();
	for (auto i = 0; i != int(_series.size()); ++i) {
		if (_series[i]) {
			known.emplace_back(i, *_series[i]);
		}
	}
	if (known.empty()) {
		return;
	}
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto s = width() / kWidth;
	auto low = known.front().second;
	auto high = low;
	for (const auto &[index, value] : known) {
		low = std::min(low, value);
		high = std::max(high, value);
	}
	if (_goal) {
		low = std::min(low, *_goal);
		high = std::max(high, *_goal);
	}
	low -= kPadKg;
	high += kPadKg;
	const auto days = std::max(int(_series.size()) - 1, 1);
	const auto x = [&](int index) {
		return s * (kPad + (index * (kWidth - kPad * 2)) / days);
	};
	const auto y = [&](double value) {
		return s * (kHeight - kPad - ((value - low) / (high - low)) * (kHeight - kPad * 2));
	};
	if (_goal) {
		auto pen = QPen(ToneColor(Tone::Faint));
		pen.setWidthF(s);
		pen.setDashPattern({ 4., 4. });
		p.setPen(pen);
		p.drawLine(QPointF(0, y(*_goal)), QPointF(width(), y(*_goal)));
		auto font = Font(11, false, true)->f;
		font.setPixelSize(std::max(int(std::round(Px(11) * s)), 1));
		p.setFont(font);
		p.setPen(ToneColor(Tone::Faint));
		const auto metrics = QFontMetrics(font);
		p.drawText(
			QPointF(s * (kWidth - kPad) - metrics.horizontalAdvance(_goalLabel), y(*_goal) - s * kPad),
			_goalLabel);
	}
	auto pen = QPen(ToneColor(Tone::Green));
	pen.setWidthF(2. * s);
	pen.setJoinStyle(Qt::RoundJoin);
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	auto path = QPainterPath();
	for (auto i = 0; i != int(known.size()); ++i) {
		const auto point = QPointF(x(known[i].first), y(known[i].second));
		if (!i) {
			path.moveTo(point);
		} else {
			path.lineTo(point);
		}
	}
	p.drawPath(path);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Green));
	const auto &last = known.back();
	p.drawEllipse(QPointF(x(last.first), y(last.second)), kDot * s, kDot * s);
}

// ── график режима сна ────────────────────────────────────────────────────────

RoutineChart::RoutineChart(QWidget *parent, Data data, Fn<void(std::string)> pick)
: RpWidget(parent)
, _data(std::move(data))
, _pick(std::move(pick)) {
	Kit::RepaintOnTones(this);
	setMouseTracking(true);
	setNaturalWidth(-1);
}

int RoutineChart::resizeGetHeight(int newWidth) {
	return Rem(13);
}

QRect RoutineChart::plot() const {
	// `--routine-gutter: 3rem; --routine-days: 1.5rem; --routine-top: 0.5rem`
	return QRect(0, Rem(0.5), std::max(width() - Rem(3), 1), std::max(height() - Rem(0.5) - Rem(1.5), 1));
}

double RoutineChart::yOf(double value) const {
	const auto area = plot();
	const auto span = std::max(_data.axis.high - _data.axis.low, 1);
	return area.y() + ((value - _data.axis.low) / span) * area.height();
}

int RoutineChart::columnAt(QPoint point) const {
	const auto count = int(_data.columns.size());
	const auto area = plot();
	if (!count || point.x() < 0 || point.x() >= area.width() || point.y() < 0 || point.y() >= height()) {
		return -1;
	}
	return std::clamp(int(point.x() / (area.width() / double(count))), 0, count - 1);
}

void RoutineChart::mouseMoveEvent(QMouseEvent *e) {
	const auto over = columnAt(e->pos());
	if (_over != over) {
		_over = over;
		setCursor((_over >= 0) ? style::cur_pointer : style::cur_default);
		update();
	}
}

void RoutineChart::mousePressEvent(QMouseEvent *e) {
	const auto index = columnAt(e->pos());
	if (index >= 0 && _pick) {
		_data.selected = _data.columns[index].day;
		update();
		_pick(_data.columns[index].day);
	}
}

void RoutineChart::leaveEventHook(QEvent *e) {
	_over = -1;
	update();
}

void RoutineChart::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto area = plot();
	const auto count = int(_data.columns.size());
	const auto mono = Font(11, false, true);
	const auto monoBold = Font(11, true, true);
	// Сетка часов: полночь — темнее
	for (const auto tick : _data.axis.ticks) {
		const auto y = yOf(tick);
		const auto midnight = (int(planner::wrapClock(tick)) == 0);
		p.fillRect(QRectF(area.x(), y, area.width(), Px(1)), ToneColor(midnight ? Tone::Muted : Tone::Line));
	}
	// Подписи часов справа
	p.setFont(mono->f);
	p.setPen(ToneColor(Tone::Muted));
	for (const auto tick : _data.axis.ticks) {
		const auto text = PlannerForms::Q(planner::toTime(int(planner::wrapClock(tick))));
		const auto y = yOf(tick);
		p.drawText(int(width() - mono->width(text)), int(y - mono->height / 2. + mono->ascent), text);
	}
	if (count) {
		const auto column = area.width() / double(count);
		for (auto i = 0; i != count; ++i) {
			const auto &item = _data.columns[i];
			const auto x = i * column;
			if (i == _over || item.day == _data.selected) {
				p.setPen(Qt::NoPen);
				p.setBrush(ToneColor(Tone::Hover));
				p.drawRoundedRect(QRectF(x, 0, column, height()), Rem(0.375), Rem(0.375));
			}
			const auto inset = column * 0.22;
			for (const auto &bar : item.bars) {
				const auto top = yOf(bar.from);
				const auto bottom = std::max(yOf(bar.to), top + Rem(0.125));
				auto color = ToneColor(bar.tone);
				p.setOpacity(bar.isMain ? 1. : 0.5);
				p.setPen(Qt::NoPen);
				p.setBrush(color);
				p.drawRoundedRect(QRectF(x + inset, top, column - 2 * inset, bottom - top), Rem(0.125), Rem(0.125));
			}
			p.setOpacity(1.);
			if (item.untimed) {
				const auto side = Rem(0.375);
				p.setPen(Qt::NoPen);
				p.setBrush(ToneColor(Tone::Faint));
				p.drawEllipse(QPointF(x + column / 2., area.y() + area.height() / 2.), side / 2., side / 2.);
			}
			const auto font = item.isScreenDay ? monoBold : mono;
			p.setFont(font->f);
			p.setPen(ToneColor(item.isScreenDay ? Tone::Fg : Tone::Muted));
			p.drawText(
				QRectF(x, height() - Rem(1.5), column, Rem(1.5)),
				Qt::AlignCenter,
				item.number);
		}
	}
	// Цель — пунктир, среднее — сплошная линия
	for (const auto value : _data.goals) {
		auto pen = QPen(ToneColor(Tone::Green));
		pen.setWidthF(Px(1));
		pen.setStyle(Qt::DashLine);
		p.setPen(pen);
		p.drawLine(QPointF(area.x(), yOf(value)), QPointF(area.x() + area.width(), yOf(value)));
	}
	for (const auto value : _data.means) {
		auto pen = QPen(ToneColor(Tone::Fg));
		pen.setWidthF(Px(1));
		p.setPen(pen);
		p.setOpacity(0.6);
		p.drawLine(QPointF(area.x(), yOf(value)), QPointF(area.x() + area.width(), yOf(value)));
		p.setOpacity(1.);
	}
}

// ── строка ввода с кнопкой ───────────────────────────────────────────────────

TextForm::TextForm(QWidget *parent, const QString &placeholder, const QString &buttonText, bool accent, Fn<bool(QString)> submit)
: RpWidget(parent)
, _submit(std::move(submit)) {
	_field = Ui::CreateChild<Kit::Field>(this, Kit::Field::Kind::Input, rpl::single(placeholder));
	_button = Ui::CreateChild<Kit::PushButton>(
		this,
		buttonText,
		accent ? Kit::PushButton::Kind::Accent : Kit::PushButton::Kind::Normal);
	_button->setClickedCallback([=] { this->submit(); });
	_field->submits() | rpl::on_next([=] { this->submit(); }, lifetime());
	_field->textChanges() | rpl::on_next([=] { refreshButton(); }, lifetime());
	_button->widthValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	refreshButton();
	setNaturalWidth(-1);
}

void TextForm::fill(const QString &text) {
	_field->setText(text);
	_field->setFocusFast();
	_field->input()->setCursorPosition(text.size());
	refreshButton();
}

QString TextForm::text() const {
	return _field->text();
}

bool TextForm::hasFocus() const {
	return _field->input()->hasFocus();
}

void TextForm::restore(const QString &text, bool focus) {
	_field->setText(text);
	if (focus) {
		_field->setFocusFast();
		_field->input()->setCursorPosition(text.size());
	}
	refreshButton();
}

void TextForm::setButtonText(const QString &text) {
	_button->setText(text);
}

void TextForm::refreshButton() {
	_button->setDisabled(_field->text().trimmed().isEmpty());
	_button->update();
}

void TextForm::submit() {
	const auto text = _field->text();
	if (text.trimmed().isEmpty()) {
		return;
	}
	if (_submit(text)) {
		_field->setText(QString());
		refreshButton();
	}
}

int TextForm::resizeGetHeight(int newWidth) {
	// `.healthGoalForm`: промежуток 0.5rem, поле растягивается
	const auto gap = Rem(0.5);
	const auto fieldWidth = std::max(newWidth - _button->width() - gap, 1);
	_field->resizeToWidth(fieldWidth);
	_field->moveToLeft(0, 0, newWidth);
	const auto h = std::max(_field->height(), _button->height());
	_field->moveToLeft(0, (h - _field->height()) / 2, newWidth);
	_button->moveToLeft(fieldWidth + gap, (h - _button->height()) / 2, newWidth);
	return h;
}

} // namespace Parvane::Health
