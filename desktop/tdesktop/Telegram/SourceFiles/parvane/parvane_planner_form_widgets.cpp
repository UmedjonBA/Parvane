// Parvane fork: реализация parvane_planner_form_widgets.h — детали окон «Плана» (spec 029, T061/T062).
// Размеры — из web `Planner.module.scss` (в комментариях — исходные rem), цвета — тона `--pv-*`.
#include "parvane/parvane_planner_form_widgets.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_icons.h"
#include "parvane/parvane_sections_data.h"

#include <parvane/sections/planner_groups.h>

#include "lang/lang_keys.h"

#include <crl/crl_on_main.h>
#include "ui/ui_utility.h"
#include "ui/boxes/calendar_box.h"
#include "ui/layers/generic_box.h"
#include "ui/painter.h"
#include "ui/qt_object_factory.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/popup_menu.h"
#include "window/window_session_controller.h"
#include "styles/style_basic.h"
#include "styles/style_chat.h"
#include "styles/style_widgets.h"

#include <QtGui/QPainterPath>
#include <QtGui/QtEvents>

#include <cmath>
#include <random>

namespace Parvane::PlannerForms {
namespace {

using Kit::Font;
using Kit::Px;
using Kit::Rem;

// `--planner-radius-small`
[[nodiscard]] int RadiusSmall() {
	return Rem(0.5);
}

[[nodiscard]] int Baseline(const style::font &font, int top, int height) {
	return top + (height - font->height) / 2 + font->ascent;
}

[[nodiscard]] QString Capitalize(QString text) {
	if (!text.isEmpty()) {
		text[0] = text[0].toUpper();
	}
	return text;
}

// Множественная форма для «N дней»: one | few | many
[[nodiscard]] QString DaysText(int days) {
	const auto amount = QString::number(days);
	if (IsRussianUi()) {
		const auto mod10 = days % 10;
		const auto mod100 = days % 100;
		if (mod10 == 1 && mod100 != 11) {
			return tr::lng_parvane_planner_days_one(tr::now, lt_amount, amount);
		} else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
			return tr::lng_parvane_planner_days_few(tr::now, lt_amount, amount);
		}
		return tr::lng_parvane_planner_days_many(tr::now, lt_amount, amount);
	}
	return (days == 1)
		? tr::lng_parvane_planner_days_one(tr::now, lt_amount, amount)
		: tr::lng_parvane_planner_days_many(tr::now, lt_amount, amount);
}

// Круглая галочка `.check` (1.375rem, `.checkSmall` 1.25rem): рамка `--pv-line2`, отмечена — заливка тоном и
// галочка `--pv-accent-ink`
void PaintRoundCheck(QPainter &p, QRectF circle, bool checked, Tone tone) {
	PainterHighQualityEnabler hq(p);
	const auto border = double(Rem(0.125));
	if (checked) {
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(tone));
		p.drawEllipse(circle);
		auto pen = QPen(ToneColor(Tone::AccentInk));
		pen.setWidthF(border);
		pen.setCapStyle(Qt::RoundCap);
		pen.setJoinStyle(Qt::RoundJoin);
		p.setPen(pen);
		p.setBrush(Qt::NoBrush);
		const auto s = circle.width();
		auto path = QPainterPath();
		path.moveTo(circle.x() + s * 0.28, circle.y() + s * 0.52);
		path.lineTo(circle.x() + s * 0.44, circle.y() + s * 0.67);
		path.lineTo(circle.x() + s * 0.73, circle.y() + s * 0.36);
		p.drawPath(path);
	} else {
		auto pen = QPen(ToneColor(Tone::Line2));
		pen.setWidthF(border);
		p.setPen(pen);
		p.setBrush(Qt::NoBrush);
		p.drawEllipse(circle.adjusted(border / 2., border / 2., -border / 2., -border / 2.));
	}
}

} // namespace

// ── строки и подписи ─────────────────────────────────────────────────────────

QString Q(const std::string &text) {
	return QString::fromStdString(text);
}

std::string S(const QString &text) {
	return text.toStdString();
}

std::string TodayKey() {
	return KeyOf(QDate::currentDate());
}

QDate DateOf(const std::string &day) {
	return QDate::fromString(Q(day), Qt::ISODate);
}

std::string KeyOf(const QDate &date) {
	return S(date.toString(Qt::ISODate));
}

planner::IdGen NewId() {
	return [] { return planner::randomUuid(); };
}

QString FormatDay(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return Q(day);
	}
	return tr::lng_month_day(
		tr::now,
		lt_month,
		Lang::MonthDay(date.month())(tr::now),
		lt_day,
		QString::number(date.day()));
}

QString FormatDayShort(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return Q(day);
	}
	auto month = Lang::MonthSmall(date.month())(tr::now);
	if (month.endsWith('.')) {
		month.chop(1);
	}
	return tr::lng_month_day(tr::now, lt_month, month, lt_day, QString::number(date.day()));
}

QString FormatDayLabel(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return Q(day);
	}
	return Capitalize(Lang::Weekday(date.dayOfWeek())(tr::now)) + u", "_q + FormatDay(day);
}

QString FormatRelativeDay(const std::string &day, const std::string &today) {
	if (day == today) {
		return tr::lng_parvane_planner_today(tr::now);
	} else if (day == planner::addDays(today, 1)) {
		return tr::lng_parvane_planner_tomorrow(tr::now);
	} else if (day == planner::addDays(today, -1)) {
		return tr::lng_parvane_planner_yesterday(tr::now);
	}
	const auto date = DateOf(day);
	return date.isValid() ? Capitalize(Lang::WeekdayFull(date.dayOfWeek())(tr::now)) : Q(day);
}

QString FormatWeekday(int index, bool full) {
	const auto weekday = std::clamp(index, 0, 6) + 1; // 1 — понедельник
	return Capitalize(full ? Lang::WeekdayFull(weekday)(tr::now) : Lang::Weekday(weekday)(tr::now));
}

QString FormatNumber(double value, int digits) {
	if (!std::isfinite(value)) {
		return u"—"_q;
	}
	const auto factor = std::pow(10., digits);
	auto rounded = std::round(value * factor) / factor;
	if (rounded == 0.) {
		rounded = 0.; // без «-0»
	}
	auto text = QString::number(std::abs(rounded), 'f', digits);
	if (text.contains('.')) {
		while (text.endsWith('0')) {
			text.chop(1);
		}
		if (text.endsWith('.')) {
			text.chop(1);
		}
	}
	const auto russian = IsRussianUi();
	auto integer = text.section('.', 0, 0);
	const auto fraction = text.contains('.') ? text.section('.', 1) : QString();
	// Группы разрядов как у Intl: en — с 1 000, ru — с 10 000 (неразрывным пробелом)
	if (integer.size() > (russian ? 4 : 3)) {
		auto grouped = QString();
		const auto separator = russian ? QChar(0x00A0) : QChar(',');
		for (auto i = 0; i != integer.size(); ++i) {
			if (i && (integer.size() - i) % 3 == 0) {
				grouped += separator;
			}
			grouped += integer[i];
		}
		integer = grouped;
	}
	auto result = integer;
	if (!fraction.isEmpty()) {
		result += (russian ? QChar(',') : QChar('.')) + fraction;
	}
	return (rounded < 0 ? u"-"_q : QString()) + result;
}

QString FormatDuration(int minutes) {
	if (minutes < 60) {
		return tr::lng_parvane_planner_minutes_value(tr::now, lt_minutes, QString::number(minutes));
	}
	const auto hours = tr::lng_parvane_planner_hours_value(tr::now, lt_hours, QString::number(minutes / 60));
	return (minutes % 60)
		? hours + ' ' + tr::lng_parvane_planner_minutes_value(tr::now, lt_minutes, QString::number(minutes % 60))
		: hours;
}

QString FormatHours(double minutes) {
	return tr::lng_parvane_planner_hours_value(tr::now, lt_hours, FormatNumber(minutes / 60., 2));
}

QString FormatSpan(double minutes) {
	return Q(planner::formatSpan(minutes));
}

QString FormatRemind(int minutes) {
	if (!minutes) {
		return tr::lng_parvane_planner_remind_at_start(tr::now);
	}
	constexpr auto kDay = 24 * 60;
	const auto amount = (minutes % kDay == 0) ? DaysText(minutes / kDay) : FormatDuration(minutes);
	return tr::lng_parvane_planner_remind_before(tr::now, lt_amount, amount);
}

QString FormatRepeat(const planner::Repeat &repeat) {
	const auto n = QString::number(repeat.interval);
	auto base = QString();
	if (repeat.kind == "daily") {
		base = (repeat.interval == 1)
			? tr::lng_parvane_planner_repeat_daily(tr::now)
			: tr::lng_parvane_planner_repeat_every_days(tr::now, lt_n, n);
	} else if (repeat.kind == "weekly") {
		auto weekdays = repeat.weekdays.value_or(std::vector<int>());
		ranges::sort(weekdays, [](int a, int b) { return ((a + 6) % 7) < ((b + 6) % 7); });
		auto days = QStringList();
		for (const auto weekday : weekdays) {
			days.push_back(FormatWeekday((weekday + 6) % 7));
		}
		const auto joined = days.join(u", "_q);
		base = (repeat.interval == 1)
			? tr::lng_parvane_planner_repeat_weekly(tr::now, lt_days, joined)
			: tr::lng_parvane_planner_repeat_every_weeks(tr::now, lt_n, n, lt_days, joined);
	} else if (repeat.kind == "monthly") {
		const auto start = DateOf(repeat.startDay);
		const auto day = QString::number((repeat.monthDay && *repeat.monthDay)
			? *repeat.monthDay
			: start.isValid() ? start.day() : 1);
		base = (repeat.interval == 1)
			? tr::lng_parvane_planner_repeat_monthly(tr::now, lt_day, day)
			: tr::lng_parvane_planner_repeat_every_months(tr::now, lt_n, n, lt_day, day);
	} else {
		const auto date = repeat.startDay.empty() ? QString() : FormatDay(repeat.startDay);
		base = (repeat.interval == 1)
			? tr::lng_parvane_planner_repeat_yearly(tr::now, lt_date, date)
			: tr::lng_parvane_planner_repeat_every_years(tr::now, lt_n, n, lt_date, date);
	}
	auto parts = QStringList{ base };
	if (repeat.endDay && !repeat.endDay->empty()) {
		parts.push_back(tr::lng_parvane_planner_repeat_until(tr::now, lt_date, FormatDay(*repeat.endDay)));
	}
	if (repeat.count && *repeat.count) {
		parts.push_back(tr::lng_parvane_planner_repeat_times(tr::now, lt_amount, QString::number(*repeat.count)));
	}
	return parts.join(u" · "_q);
}

QString FormatStatus(const std::string &status) {
	if (status == "active") {
		return tr::lng_parvane_planner_status_active(tr::now);
	} else if (status == "done") {
		return tr::lng_parvane_planner_status_done(tr::now);
	}
	return tr::lng_parvane_planner_status_queue(tr::now);
}

QString FormatProject(const std::string &project) {
	return project.empty() ? tr::lng_parvane_planner_no_list(tr::now) : Q(project);
}

QString RepeatErrorText(const std::string &code) {
	if (code == "interval") return tr::lng_parvane_planner_error_repeat_interval(tr::now);
	if (code == "weekdays") return tr::lng_parvane_planner_error_repeat_weekdays(tr::now);
	if (code == "monthDay") return tr::lng_parvane_planner_error_repeat_month_day(tr::now);
	if (code == "startDay") return tr::lng_parvane_planner_error_repeat_start(tr::now);
	if (code == "endDay") return tr::lng_parvane_planner_error_repeat_end(tr::now);
	if (code == "count") return tr::lng_parvane_planner_error_repeat_count(tr::now);
	return Q(code);
}

QString TaskErrorText(const std::string &code) {
	if (code == "name") return tr::lng_parvane_planner_error_name(tr::now);
	if (code == "minutes") return tr::lng_parvane_planner_error_minutes(tr::now);
	if (code == "startNeedsDayAndMinutes") return tr::lng_parvane_planner_error_start_needs(tr::now);
	if (code == "pastMidnight") return tr::lng_parvane_planner_error_past_midnight(tr::now);
	if (code == "dayAfterDue") return tr::lng_parvane_planner_error_day_after_due(tr::now);
	return RepeatErrorText(code);
}

QString EventErrorText(const std::string &code) {
	if (code == "name") return tr::lng_parvane_planner_error_name(tr::now);
	if (code == "time") return tr::lng_parvane_planner_error_event_time(tr::now);
	if (code == "repeat") return tr::lng_parvane_planner_error_event_repeat(tr::now);
	return RepeatErrorText(code);
}

QString SettingsErrorText(const std::string &code) {
	if (code == "window") return tr::lng_parvane_planner_error_settings_window(tr::now);
	if (code == "lunch") return tr::lng_parvane_planner_error_settings_lunch(tr::now);
	if (code == "margin") return tr::lng_parvane_planner_error_settings_margin(tr::now);
	return Q(code);
}

QColor ListColor(int color) {
	switch (color) {
	case 1: return st::historyPeer1NameFg->c;
	case 2: return st::historyPeer2NameFg->c;
	case 3: return st::historyPeer3NameFg->c;
	case 4: return st::historyPeer4NameFg->c;
	case 5: return st::historyPeer5NameFg->c;
	case 6: return st::historyPeer6NameFg->c;
	case 7: return st::historyPeer7NameFg->c;
	case 8: return st::historyPeer8NameFg->c;
	}
	return ToneColor(Tone::Muted);
}

void PaintGlyph(QPainter &p, const QString &name, const QColor &color, QRect rect) {
	const auto size = std::min(rect.width(), rect.height());
	const auto x = rect.x() + (rect.width() - size) / 2;
	const auto y = rect.y() + (rect.height() - size) / 2;
	// Значки мессенджера, у которых есть пара в наборе ParvaneIcon
	static const auto aliases = QHash<QString, QString>{
		{ u"edit"_q, u"pen"_q },
		{ u"add"_q, u"plus"_q },
		{ u"settings"_q, u"sliders"_q },
	};
	const auto alias = aliases.value(name, name);
	if (HasIcon(alias)) {
		PaintIcon(p, alias, color, x, y, size);
		return;
	}
	PainterHighQualityEnabler hq(p);
	const auto k = size / 24.;
	auto pen = QPen(color);
	pen.setWidthF(1.8 * k);
	pen.setCapStyle(Qt::RoundCap);
	pen.setJoinStyle(Qt::RoundJoin);
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	const auto pt = [&](double px, double py) {
		return QPointF(x + px * k, y + py * k);
	};
	auto path = QPainterPath();
	if (name == u"clock"_q || name == u"schedule"_q) {
		p.drawEllipse(pt(12, 12), 8.5 * k, 8.5 * k);
		path.moveTo(pt(12, 7.5));
		path.lineTo(pt(12, 12));
		path.lineTo(pt(15, 14));
	} else if (name == u"loop"_q) {
		const auto r = QRectF(pt(4, 4), pt(20, 20));
		path.arcMoveTo(r, 60);
		path.arcTo(r, 60, 280);
		p.drawPath(path);
		path = QPainterPath();
		const auto end = pt(12 + 8 * std::cos(M_PI / 3), 12 - 8 * std::sin(M_PI / 3));
		path.moveTo(end + QPointF(-3.5 * k, -1.5 * k));
		path.lineTo(end);
		path.lineTo(end + QPointF(-0.5 * k, 3.8 * k));
	} else if (name == u"info"_q) {
		p.drawEllipse(pt(12, 12), 8.5 * k, 8.5 * k);
		path.moveTo(pt(12, 11));
		path.lineTo(pt(12, 16.5));
		p.drawPath(path);
		p.setPen(Qt::NoPen);
		p.setBrush(color);
		p.drawEllipse(pt(12, 7.8), 1.2 * k, 1.2 * k);
		return;
	} else if (name == u"delete"_q) {
		path.moveTo(pt(4.5, 7));
		path.lineTo(pt(19.5, 7));
		path.moveTo(pt(9.5, 7));
		path.lineTo(pt(9.5, 4.5));
		path.lineTo(pt(14.5, 4.5));
		path.lineTo(pt(14.5, 7));
		path.moveTo(pt(6.5, 7));
		path.lineTo(pt(7.5, 19.5));
		path.lineTo(pt(16.5, 19.5));
		path.lineTo(pt(17.5, 7));
		path.moveTo(pt(10.5, 11));
		path.lineTo(pt(10.5, 16));
		path.moveTo(pt(13.5, 11));
		path.lineTo(pt(13.5, 16));
	} else if (name == u"close"_q) {
		path.moveTo(pt(6, 6));
		path.lineTo(pt(18, 18));
		path.moveTo(pt(18, 6));
		path.lineTo(pt(6, 18));
	} else if (name == u"down"_q) {
		path.moveTo(pt(7, 10));
		path.lineTo(pt(12, 15));
		path.lineTo(pt(17, 10));
	} else if (name == u"up"_q) {
		path.moveTo(pt(7, 14));
		path.lineTo(pt(12, 9));
		path.lineTo(pt(17, 14));
	} else if (name == u"previous"_q) {
		path.moveTo(pt(14.5, 6.5));
		path.lineTo(pt(9, 12));
		path.lineTo(pt(14.5, 17.5));
	} else if (name == u"next"_q) {
		path.moveTo(pt(9.5, 6.5));
		path.lineTo(pt(15, 12));
		path.lineTo(pt(9.5, 17.5));
	} else if (name == u"sport"_q) {
		path.moveTo(pt(8, 12));
		path.lineTo(pt(16, 12));
		path.addRoundedRect(QRectF(pt(5, 7.5), pt(8, 16.5)), k, k);
		path.addRoundedRect(QRectF(pt(16, 7.5), pt(19, 16.5)), k, k);
		path.moveTo(pt(3, 10));
		path.lineTo(pt(3, 14));
		path.moveTo(pt(21, 10));
		path.lineTo(pt(21, 14));
	} else {
		return;
	}
	p.drawPath(path);
}

void ShowError(not_null<Window::SessionController*> controller, const QString &text) {
	controller->showToast(text);
}

void UpdatePlannerWithResult(
		std::function<std::optional<std::string>(planner::State&)> mutate,
		const QString &notice,
		Fn<void(std::optional<std::string>)> done) {
	auto text = notice.isEmpty() ? std::optional<std::string>() : std::optional<std::string>(S(notice));
	Sections::Post([mutate = std::move(mutate), text = std::move(text), done = std::move(done)](
			Sections::Workers &w) {
		auto result = std::make_shared<std::optional<std::string>>();
		w.planner.update([&](planner::State &state) {
			*result = mutate(state);
		}, text, w.nowMs);
		Sections::PostMain([=] {
			done(*result);
		});
	});
}

// ── раскладка ────────────────────────────────────────────────────────────────

Line::Line(QWidget *parent, int gap, bool alignTop)
: RpWidget(parent)
, _gap(gap)
, _alignTop(alignTop) {
}

Ui::RpWidget *Line::addItem(object_ptr<Ui::RpWidget> child, bool stretch) {
	const auto raw = child.release();
	raw->setParent(this);
	raw->show();
	_items.push_back({ raw, stretch });
	raw->heightValue() | rpl::skip(1) | rpl::on_next([=] {
		// Смена высоты ребёнка — пересчёт раскладки ПОСЛЕ текущего прохода и один на пачку: синхронный
		// пересчёт из сигнала высоты зацикливался (карточка ↔ сетка), съедая процессор и память
		if (_inResize || _relayoutScheduled) {
			return;
		}
		_relayoutScheduled = true;
		crl::on_main(this, [=] {
			_relayoutScheduled = false;
			if (width() > 0) {
				resizeToWidth(width());
			}
		});
	}, raw->lifetime());
	return raw;
}

void Line::addStretch() {
	_items.push_back({ nullptr, true });
}

void Line::setAlignBottom(bool bottom) {
	_alignBottom = bottom;
}

int Line::resizeGetHeight(int newWidth) {
	_inResize = true;
	auto fixed = 0;
	auto stretches = 0;
	auto visible = 0;
	for (const auto &item : _items) {
		if (item.widget && item.widget->isHidden()) {
			continue;
		}
		++visible;
		if (item.stretch) {
			++stretches;
		} else {
			const auto natural = item.widget->naturalWidth();
			if (natural >= 0) {
				item.widget->resizeToWidth(natural);
			}
			fixed += item.widget->width();
		}
	}
	const auto gaps = _gap * std::max(visible - 1, 0);
	const auto free = std::max(newWidth - fixed - gaps, 0);
	auto height = 0;
	for (const auto &item : _items) {
		if (item.widget && item.stretch && !item.widget->isHidden()) {
			item.widget->resizeToWidth(stretches ? free / stretches : 0);
		}
		if (item.widget && !item.widget->isHidden()) {
			height = std::max(height, item.widget->height());
		}
	}
	auto x = 0;
	for (const auto &item : _items) {
		if (item.widget && item.widget->isHidden()) {
			continue;
		}
		if (!item.widget) {
			x += (stretches ? free / stretches : 0) + _gap;
			continue;
		}
		const auto top = _alignTop
			? 0
			: _alignBottom
			? (height - item.widget->height())
			: (height - item.widget->height()) / 2;
		item.widget->moveToLeft(x, top, newWidth);
		x += item.widget->width() + _gap;
	}
	_inResize = false;
	return height;
}

FieldsGrid::FieldsGrid(QWidget *parent, bool three)
: RpWidget(parent)
, _three(three) {
}

Ui::RpWidget *FieldsGrid::addItem(object_ptr<Ui::RpWidget> child) {
	const auto raw = child.release();
	raw->setParent(this);
	raw->show();
	_items.push_back(raw);
	raw->heightValue() | rpl::skip(1) | rpl::on_next([=] {
		// Смена высоты ребёнка — пересчёт раскладки ПОСЛЕ текущего прохода и один на пачку: синхронный
		// пересчёт из сигнала высоты зацикливался (карточка ↔ сетка), съедая процессор и память
		if (_inResize || _relayoutScheduled) {
			return;
		}
		_relayoutScheduled = true;
		crl::on_main(this, [=] {
			_relayoutScheduled = false;
			if (width() > 0) {
				resizeToWidth(width());
			}
		});
	}, raw->lifetime());
	return raw;
}

int FieldsGrid::resizeGetHeight(int newWidth) {
	_inResize = true;
	auto items = std::vector<Ui::RpWidget*>();
	for (const auto item : _items) {
		if (!item->isHidden()) {
			items.push_back(item);
		}
	}
	const auto gap = Rem(0.625);
	auto y = 0;
	if (_three && items.size() == 3 && newWidth > Rem(30)) {
		// `minmax(0, 1.4fr) repeat(2, minmax(0, 1fr))`
		const auto free = newWidth - 2 * gap;
		const auto first = int(std::round(free * 1.4 / 3.4));
		const auto rest = (free - first) / 2;
		const auto widths = std::array{ first, rest, free - first - rest };
		auto x = 0;
		auto height = 0;
		for (auto i = 0; i != 3; ++i) {
			items[i]->resizeToWidth(widths[i]);
			items[i]->moveToLeft(x, 0, newWidth);
			x += widths[i] + gap;
			height = std::max(height, items[i]->height());
		}
		_inResize = false;
		return height;
	}
	auto index = 0;
	if (_three && items.size() == 3) {
		// Узкая карточка: первое поле — на всю строку
		items[0]->resizeToWidth(newWidth);
		items[0]->moveToLeft(0, 0, newWidth);
		y = items[0]->height() + gap;
		index = 1;
	}
	const auto columns = (newWidth <= Rem(23)) ? 1 : 2;
	const auto cell = (newWidth - gap * (columns - 1)) / columns;
	while (index < int(items.size())) {
		auto height = 0;
		for (auto c = 0; c != columns && index < int(items.size()); ++c, ++index) {
			items[index]->resizeToWidth(cell);
			items[index]->moveToLeft(c * (cell + gap), y, newWidth);
			height = std::max(height, items[index]->height());
		}
		y += height + gap;
	}
	_inResize = false;
	return std::max(y - gap, 0);
}

object_ptr<Kit::Label> SmallText(QWidget *parent, const QString &text, Tone tone, int px) {
	auto st = Kit::Label::Style{ .px = px, .tone = tone, .multiline = true };
	return object_ptr<Kit::Label>(parent, text, st);
}

// ── поля ─────────────────────────────────────────────────────────────────────

struct TextInput::Styles {
	Styles()
	: textBg(ToneColor(Tone::Panel))
	, textFg(ToneColor(Tone::Fg))
	, placeholderFg(ToneColor(Tone::Faint))
	, borderFg(ToneColor(Tone::Line2))
	, borderFgActive(ToneColor(Tone::Accent))
	, borderFgError(ToneColor(Tone::Red))
	, text(st::defaultTextStyle)
	, st(st::defaultInputField) {
	}

	style::owned_color textBg;
	style::owned_color textFg;
	style::owned_color placeholderFg;
	style::owned_color borderFg;
	style::owned_color borderFgActive;
	style::owned_color borderFgError;
	style::TextStyle text;
	style::InputField st;
};

TextInput::TextInput(QWidget *parent, Kind kind, const QString &placeholder, const QString &value, int maxLength, int minHeight)
: RpWidget(parent)
, _kind(kind)
, _styles(std::make_unique<Styles>()) {
	const auto title = (_kind == Kind::Title);
	auto &st = _styles->st;
	auto &text = _styles->text;
	text.font = title ? Font(20, true) : Font(Kit::kBodyPx);
	text.lineHeight = title ? Rem(1.5) : int(std::round(Px(15) * 1.45));
	st.style = text;
	st.textBg = _styles->textBg.color();
	st.textBgActive = _styles->textBg.color();
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
	if (title) {
		// `.cardTitleInput`: поля 0.25rem 0 0.5rem, линия снизу `--pv-line2`, в фокусе — акцент
		st.borderRadius = 0;
		st.textMargins = style::margins(0, Rem(0.25), 0, Rem(0.5));
		st.heightMin = Rem(0.25) + Rem(1.5) + Rem(0.5);
		st.heightMax = st.heightMin;
	} else {
		st.borderRadius = Rem(0.5);
		const auto pad = Rem(0.625);
		st.textMargins = style::margins(Rem(0.75), pad, Rem(0.75), pad);
		st.heightMin = minHeight ? minHeight : Rem(6.5);
		st.heightMax = Rem(30);
	}
	refreshColors();
	_input.create(
		this,
		_styles->st,
		title ? Ui::InputField::Mode::SingleLine : Ui::InputField::Mode::MultiLine,
		rpl::single(placeholder),
		value);
	if (maxLength > 0) {
		_input->setMaxLength(maxLength);
	}
	if (!title) {
		_input->setSubmitSettings(Ui::InputField::SubmitSettings::CtrlEnter);
	}
	_input->heightValue() | rpl::on_next([=](int h) {
		resize(width(), h);
	}, lifetime());
	sizeValue() | rpl::on_next([=](QSize size) {
		_input->resizeToWidth(size.width());
	}, lifetime());
	TonesChanges() | rpl::on_next([=] {
		refreshColors();
	}, lifetime());
	style::PaletteChanged() | rpl::on_next([=] {
		refreshColors();
	}, lifetime());
	setNaturalWidth(-1);
	resize(width(), _input->height());
}

TextInput::~TextInput() {
	_input.destroy();
}

void TextInput::refreshColors() {
	const auto title = (_kind == Kind::Title);
	_styles->textBg.update(title ? Kit::Mix(Tone::Panel, 0.) : ToneColor(Tone::Panel));
	_styles->textFg.update(ToneColor(Tone::Fg));
	_styles->placeholderFg.update(ToneColor(Tone::Faint));
	_styles->borderFg.update(ToneColor(Tone::Line2));
	_styles->borderFgActive.update(ToneColor(Tone::Accent));
	_styles->borderFgError.update(ToneColor(Tone::Red));
	if (_input) {
		_input->update();
	}
}

not_null<Ui::InputField*> TextInput::input() const {
	return _input.data();
}

QString TextInput::text() const {
	return _input->getLastText();
}

void TextInput::setText(const QString &text) {
	_input->setText(text);
}

rpl::producer<QString> TextInput::textChanges() const {
	const auto input = _input.data();
	return input->changes() | rpl::map([=] {
		return input->getLastText();
	});
}

int TextInput::resizeGetHeight(int newWidth) {
	_input->resizeToWidth(newWidth);
	return _input->height();
}

FormField::FormField(
	QWidget *parent,
	Window::SessionController *controller,
	const QString &label,
	Type type,
	const std::string &value,
	const QString &placeholder,
	int maxLength)
: RpWidget(parent)
, _controller(controller)
, _type(type)
, _value(value) {
	// `.fieldLabel`: 0.75rem `--pv-muted`, отступ 0.25rem
	_label = Ui::CreateChild<Kit::Label>(this, label, Kit::Label::Style{ .px = 12, .tone = Tone::Muted });
	auto hint = placeholder;
	if (hint.isEmpty() && _type == Type::Date) {
		hint = tr::lng_parvane_planner_day_placeholder(tr::now);
	} else if (hint.isEmpty() && _type == Type::Time) {
		hint = tr::lng_parvane_planner_time_placeholder(tr::now);
	}
	_field = Ui::CreateChild<Kit::Field>(this, Kit::Field::Kind::Input, rpl::single(hint), shown(value));
	if (maxLength > 0) {
		_field->input()->setMaxLength(maxLength);
	}
	if (_type == Type::Date && _controller) {
		_calendar = Ui::CreateChild<Kit::IconButton>(
			_field,
			u"calendar"_q,
			tr::lng_parvane_planner_pick_date(tr::now),
			Kit::IconButton::Kind::Small);
		_calendar->setClickedCallback([=] { pickDate(); });
		_field->sizeValue() | rpl::on_next([=](QSize size) {
			_calendar->move(size.width() - _calendar->width() - Rem(0.375), (size.height() - _calendar->height()) / 2);
		}, _calendar->lifetime());
	}
	_field->textChanges() | rpl::on_next([=](QString text) {
		if (_settingText) {
			return;
		}
		if (_onInput) {
			_onInput(this->value());
		}
	}, lifetime());
	_field->submits() | rpl::on_next([=] {
		commit();
	}, lifetime());
	_field->input()->focusedChanges() | rpl::on_next([=](bool focused) {
		if (!focused) {
			commit();
		}
	}, lifetime());
	setNaturalWidth(-1);
}

QString FormField::shown(const std::string &value) const {
	return (_type == Type::Date) ? Q(planner::formatDayInput(value)) : Q(value);
}

std::optional<std::string> FormField::parse(const QString &raw) const {
	switch (_type) {
	case Type::Date: return planner::parseDayInput(S(raw));
	case Type::Time: return planner::parseTimeInput(S(raw));
	case Type::Number: return S(raw.trimmed());
	case Type::Text: break;
	}
	return S(raw);
}

void FormField::setOnCommit(Fn<bool(std::string)> callback) {
	_onCommit = std::move(callback);
}

void FormField::setOnInput(Fn<void(std::string)> callback) {
	_onInput = std::move(callback);
}

void FormField::setValue(const std::string &value, bool force) {
	if (!force && hasFocus()) {
		return;
	}
	_value = value;
	const auto text = shown(value);
	if (_field->text() != text) {
		_settingText = true;
		_field->setText(text);
		_settingText = false;
	}
}

std::string FormField::value() const {
	return parse(_field->text()).value_or(std::string());
}

QString FormField::raw() const {
	return _field->text();
}

bool FormField::hasFocus() const {
	return _field->input()->hasFocus();
}

void FormField::setFocusFast() {
	_field->setFocusFast();
}

rpl::producer<> FormField::submits() const {
	return _field->submits();
}

void FormField::commit() {
	const auto parsed = parse(_field->text());
	if (!parsed) {
		// Не дата и не время: прежнее значение возвращается в поле
		if (_controller) {
			ShowError(
				_controller,
				(_type == Type::Date)
					? tr::lng_parvane_planner_error_day(tr::now)
					: tr::lng_parvane_planner_error_time(tr::now));
		}
		setValue(_value, true);
		return;
	}
	if (*parsed == _value) {
		setValue(_value, true); // «5.1.26» → «05.01.2026»
		return;
	}
	if (!_onCommit) {
		_value = *parsed;
		setValue(_value, true);
		return;
	}
	const auto previous = _value;
	if (_onCommit(*parsed) == false) {
		setValue(previous, true);
		return;
	}
	_value = *parsed;
	setValue(_value, true);
}

void FormField::pickDate() {
	if (!_controller) {
		return;
	}
	const auto current = DateOf(value());
	const auto highlighted = current.isValid() ? current : QDate::currentDate();
	const auto weak = QPointer<FormField>(this);
	_controller->show(Box<Ui::CalendarBox>(Ui::CalendarBoxArgs{
		.month = highlighted,
		.highlighted = highlighted,
		.callback = [=](QDate date, Fn<void()> close) {
			close();
			if (const auto strong = weak.data()) {
				strong->_settingText = true;
				strong->_field->setText(strong->shown(KeyOf(date)));
				strong->_settingText = false;
				if (strong->_onInput) {
					strong->_onInput(KeyOf(date));
				}
				strong->commit();
			}
		},
	}));
}

int FormField::resizeGetHeight(int newWidth) {
	_label->resizeToWidth(newWidth);
	_label->moveToLeft(0, 0, newWidth);
	const auto top = _label->height() + Rem(0.25);
	_field->resizeToWidth(newWidth);
	_field->moveToLeft(0, top, newWidth);
	return top + _field->height();
}

FormSelect::FormSelect(QWidget *parent, const QString &label, std::vector<Option> options, const QString &value)
: Button(parent)
, _label(label)
, _options(std::move(options))
, _value(value) {
	setAccessibleName(label);
	Kit::RepaintOnTones(this);
	setClickedCallback([=] { showMenu(); });
	setNaturalWidth(-1);
	resize(width(), resizeGetHeight(width()));
}

void FormSelect::setOptions(std::vector<Option> options) {
	_options = std::move(options);
	update();
}

void FormSelect::setValue(const QString &value) {
	if (_value != value) {
		_value = value;
		update();
	}
}

QString FormSelect::value() const {
	return _value;
}

void FormSelect::setOnChange(Fn<void(QString)> callback) {
	_onChange = std::move(callback);
}

QString FormSelect::currentText() const {
	for (const auto &option : _options) {
		if (option.value == _value) {
			return option.text;
		}
	}
	return QString();
}

void FormSelect::showMenu() {
	_menu = Kit::CreateMenu(this);
	for (const auto &option : _options) {
		const auto value = option.value;
		Kit::AddMenuAction(_menu.get(), option.text, [=] {
			const auto changed = (_value != value);
			_value = value;
			update();
			if (changed && _onChange) {
				_onChange(value);
			}
		}, (value == _value) ? u"check"_q : QString());
	}
	const auto label = Font(12)->height + Rem(0.25);
	_menu->popup(mapToGlobal(QPoint(0, label + Rem(2.625))));
}

int FormSelect::resizeGetHeight(int newWidth) {
	return Font(12)->height + Rem(0.25) + Rem(2.625);
}

void FormSelect::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto labelFont = Font(12);
	p.setFont(labelFont->f);
	p.setPen(ToneColor(Tone::Muted));
	p.drawText(0, labelFont->ascent, labelFont->elided(_label, width()));
	const auto top = labelFont->height + Rem(0.25);
	const auto box = QRectF(0, top, width(), Rem(2.625));
	const auto radius = double(RadiusSmall());
	{
		PainterHighQualityEnabler hq(p);
		auto pen = QPen((isOver() || isDown()) ? ToneColor(Tone::Accent) : ToneColor(Tone::Line2));
		pen.setWidthF(Px(1));
		p.setPen(pen);
		p.setBrush(ToneColor(Tone::Panel));
		const auto half = Px(1) / 2.;
		p.drawRoundedRect(box.adjusted(half, half, -half, -half), radius, radius);
	}
	const auto font = Font(Kit::kBodyPx);
	const auto icon = Rem(1.125);
	const auto pad = Rem(0.75);
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(
		pad,
		Baseline(font, int(box.y()), int(box.height())),
		font->elided(currentText(), std::max(width() - 2 * pad - icon - Rem(0.25), 0)));
	PaintGlyph(
		p,
		u"down"_q,
		ToneColor(Tone::Muted),
		QRect(width() - pad - icon, int(box.y()) + (int(box.height()) - icon) / 2, icon, icon));
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, box, radius);
	}
}

TickBox::TickBox(QWidget *parent, const QString &text, bool checked)
: Button(parent)
, _text(text)
, _checked(checked) {
	setAccessibleName(text);
	Kit::RepaintOnTones(this);
	const auto font = Font(Kit::kBodyPx);
	const auto w = Rem(1.125) + Rem(0.625) + font->width(_text) + Px(2);
	setNaturalWidth(w);
	resize(w, Rem(2.25));
	setClickedCallback([=] {
		setChecked(!_checked);
		if (_onChange) {
			_onChange(_checked);
		}
	});
}

void TickBox::setChecked(bool checked) {
	if (_checked != checked) {
		_checked = checked;
		accessibilityStateChanged({ .checked = true });
		update();
	}
}

bool TickBox::checked() const {
	return _checked;
}

void TickBox::setOnChange(Fn<void(bool)> callback) {
	_onChange = std::move(callback);
}

QAccessible::Role TickBox::accessibilityRole() {
	return QAccessible::CheckBox;
}

Ui::AccessibilityState TickBox::accessibilityState() const {
	return { .checkable = true, .checked = _checked };
}

void TickBox::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto side = Rem(1.125);
	const auto box = QRectF(Px(1), (height() - side) / 2., side, side);
	const auto radius = double(Rem(0.25));
	{
		PainterHighQualityEnabler hq(p);
		const auto border = double(Px(2));
		if (_checked) {
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Accent));
			p.drawRoundedRect(box, radius, radius);
			auto pen = QPen(ToneColor(Tone::AccentInk));
			pen.setWidthF(border);
			pen.setCapStyle(Qt::RoundCap);
			pen.setJoinStyle(Qt::RoundJoin);
			p.setPen(pen);
			auto path = QPainterPath();
			path.moveTo(box.x() + side * 0.24, box.y() + side * 0.52);
			path.lineTo(box.x() + side * 0.42, box.y() + side * 0.70);
			path.lineTo(box.x() + side * 0.78, box.y() + side * 0.32);
			p.setBrush(Qt::NoBrush);
			p.drawPath(path);
		} else {
			auto pen = QPen((isOver() || isDown()) ? ToneColor(Tone::Muted) : ToneColor(Tone::Line2));
			pen.setWidthF(border);
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			p.drawRoundedRect(box.adjusted(border / 2., border / 2., -border / 2., -border / 2.), radius, radius);
		}
	}
	const auto font = Font(Kit::kBodyPx);
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Fg));
	const auto left = int(box.x()) + side + Rem(0.625);
	p.drawText(left, Baseline(font, 0, height()), font->elided(_text, std::max(width() - left, 0)));
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, box.adjusted(-Px(2), -Px(2), Px(2), Px(2)), radius + Px(2));
	}
}

CheckRow::CheckRow(QWidget *parent, const QString &text, bool checked, bool isSmall, Tone tone, bool strike)
: Button(parent)
, _text(text)
, _checked(checked)
, _small(isSmall)
, _tone(tone)
, _strike(strike) {
	setAccessibleName(text);
	Kit::RepaintOnTones(this);
	setNaturalWidth(-1);
	setClickedCallback([=] {
		setChecked(!_checked);
		if (_onChange) {
			_onChange(_checked);
		}
	});
}

void CheckRow::setText(const QString &text) {
	_text = text;
	setAccessibleName(text);
	update();
}

void CheckRow::setChecked(bool checked) {
	if (_checked != checked) {
		_checked = checked;
		accessibilityStateChanged({ .checked = true });
		update();
	}
}

bool CheckRow::checked() const {
	return _checked;
}

void CheckRow::setOnChange(Fn<void(bool)> callback) {
	_onChange = std::move(callback);
}

QAccessible::Role CheckRow::accessibilityRole() {
	return QAccessible::CheckBox;
}

Ui::AccessibilityState CheckRow::accessibilityState() const {
	return { .checkable = true, .checked = _checked };
}

int CheckRow::resizeGetHeight(int newWidth) {
	// `.row` 2.75rem, `.rowStep` 2.25rem; длинная подпись — переносом
	const auto font = Font(Kit::kBodyPx);
	const auto side = _small ? Rem(1.25) : Rem(1.375);
	const auto textWidth = std::max(newWidth - 2 * Rem(0.625) - side - Rem(0.75), 1);
	const auto lines = std::clamp(int(std::ceil(font->width(_text) / double(textWidth))), 1, 3);
	const auto min = _small ? Rem(2.25) : Rem(2.75);
	return std::max(min, lines * font->height + 2 * Rem(0.375));
}

void CheckRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	const auto radius = double(RadiusSmall());
	if (isOver() || isDown()) {
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawRoundedRect(r, radius, radius);
	}
	const auto side = _small ? Rem(1.25) : Rem(1.375);
	const auto pad = Rem(0.625);
	PaintRoundCheck(p, QRectF(pad, (height() - side) / 2., side, side), _checked, _tone);
	const auto font = Font(Kit::kBodyPx);
	const auto left = pad + side + Rem(0.75);
	const auto done = _strike && _checked;
	auto f = font->f;
	f.setStrikeOut(done);
	p.setFont(f);
	p.setPen(ToneColor(done ? Tone::Faint : Tone::Fg));
	const auto textRect = QRect(left, Rem(0.375), std::max(width() - left - pad, 0), height() - 2 * Rem(0.375));
	p.drawText(textRect, Qt::AlignLeft | Qt::AlignVCenter | Qt::TextWordWrap, _text);
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, r, radius);
	}
}

GlyphButton::GlyphButton(QWidget *parent, const QString &icon, const QString &accessibleName, bool isSmall)
: Button(parent)
, _icon(icon)
, _small(isSmall) {
	setAccessibleName(accessibleName);
	Kit::RepaintOnTones(this);
	const auto side = _small ? Rem(1.75) : Rem(2.25);
	setNaturalWidth(side);
	resize(side, side);
}

void GlyphButton::setActive(bool active) {
	if (_active != active) {
		_active = active;
		update();
	}
}

void GlyphButton::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto r = QRectF(rect());
	if (isOver() || isDown()) {
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Hover));
		p.drawEllipse(r);
	}
	// `.ib` значок 1.375rem, `.ibSmall` — 1.125rem
	const auto icon = _small ? Rem(1.125) : Rem(1.375);
	const auto color = _active
		? ToneColor(Tone::Accent)
		: (isOver() || isDown())
		? ToneColor(Tone::Fg)
		: ToneColor(Tone::Muted);
	PaintGlyph(p, _icon, color, QRect((width() - icon) / 2, (height() - icon) / 2, icon, icon));
	if (focusVisible() && hasFocus()) {
		paintFocusRing(p, r, r.height() / 2.);
	}
}

CardRow::CardRow(QWidget *parent, const QString &icon)
: RpWidget(parent)
, _icon(icon) {
	Kit::RepaintOnTones(this);
	_body = Ui::CreateChild<Ui::VerticalLayout>(this);
	_body->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
}

not_null<Ui::VerticalLayout*> CardRow::body() const {
	return _body;
}

Ui::RpWidget *CardRow::addItem(object_ptr<Ui::RpWidget> child) {
	// `.cardRowBody`: промежуток 0.625rem
	return AddTo(_body, std::move(child), Rem(0.625));
}

void CardRow::setLast(bool last) {
	_last = last;
	update();
}

int CardRow::resizeGetHeight(int newWidth) {
	// `grid-template-columns: 1.25rem 1fr; gap 0.75rem; padding-block 0.5rem`
	const auto left = Rem(1.25) + Rem(0.75);
	_body->resizeToWidth(std::max(newWidth - left, 1));
	_body->moveToLeft(left, Rem(0.5), newWidth);
	return Rem(0.5) + _body->height() + Rem(0.5);
}

void CardRow::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	const auto icon = Rem(1.25);
	// `.cardRowIcon`: отступ 0.6875rem сверху — по середине первого поля
	PaintGlyph(p, _icon, ToneColor(Tone::Muted), QRect(0, Rem(0.5) + Rem(0.6875), icon, icon));
	if (!_last) {
		p.fillRect(0, height() - Px(1), width(), Px(1), ToneColor(Tone::Line));
	}
}

CardHead::CardHead(QWidget *parent, const QString &icon, const QString &kind)
: RpWidget(parent)
, _icon(icon)
, _kind(kind) {
	Kit::RepaintOnTones(this);
	setAccessibleName(_kind);
	resize(width(), Rem(1.875));
}

void CardHead::setDay(const QString &day) {
	_day = day;
	update();
}

int CardHead::resizeGetHeight(int newWidth) {
	return Rem(1.875);
}

void CardHead::paintEvent(QPaintEvent *e) {
	// `.cardKind`: пилюля 1.875rem, поля 0.625rem, значок 1rem, промежуток 0.375rem; `.cardDay` — через 0.75rem
	auto p = QPainter(this);
	const auto font = Font(13, true);
	const auto pad = Rem(0.625);
	const auto icon = Rem(1);
	const auto gap = Rem(0.375);
	const auto chip = std::min(pad + icon + gap + font->width(_kind) + pad, width());
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Raised));
		const auto radius = height() / 2.;
		p.drawRoundedRect(QRectF(0, 0, chip, height()), radius, radius);
	}
	PaintGlyph(p, _icon, ToneColor(Tone::Muted), QRect(pad, (height() - icon) / 2, icon, icon));
	p.setFont(font->f);
	p.setPen(ToneColor(Tone::Muted));
	const auto textLeft = pad + icon + gap;
	p.drawText(textLeft, Baseline(font, 0, height()), font->elided(_kind, std::max(chip - textLeft - pad, 0)));
	if (_day.isEmpty()) {
		return;
	}
	const auto dayFont = Font(13);
	const auto dayLeft = chip + Rem(0.75);
	p.setFont(dayFont->f);
	p.drawText(dayLeft, Baseline(dayFont, 0, height()), dayFont->elided(_day, std::max(width() - dayLeft, 0)));
}

SeriesPrompt::SeriesPrompt(QWidget *parent, const QString &mode, Fn<void(QString)> choose, Fn<void()> cancel)
: RpWidget(parent) {
	Kit::RepaintOnTones(this);
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	const auto title = (mode == u"delete"_q)
		? tr::lng_parvane_planner_series_delete_title(tr::now)
		: (mode == u"rule"_q)
		? tr::lng_parvane_planner_series_rule_title(tr::now)
		: (mode == u"stop"_q)
		? tr::lng_parvane_planner_series_stop_title(tr::now)
		: tr::lng_parvane_planner_series_edit_title(tr::now);
	AddTo(_column, SmallText(_column, title, Tone::Muted, 14), Rem(0.5));
	const auto scopes = (mode == u"rule"_q)
		? QStringList{ u"following"_q, u"all"_q }
		: (mode == u"stop"_q)
		? QStringList{ u"stop"_q, u"one"_q }
		: (mode == u"copy"_q)
		? QStringList{ u"one"_q, u"all"_q }
		: QStringList{ u"one"_q, u"following"_q, u"all"_q };
	for (const auto &scope : scopes) {
		const auto text = (mode == u"stop"_q && scope == u"one"_q)
			? tr::lng_parvane_planner_series_only_this_day(tr::now)
			: (scope == u"one"_q)
			? tr::lng_parvane_planner_series_only_this(tr::now)
			: (scope == u"following"_q)
			? tr::lng_parvane_planner_series_following(tr::now)
			: (scope == u"all"_q)
			? tr::lng_parvane_planner_series_all(tr::now)
			: tr::lng_parvane_planner_series_stop(tr::now);
		const auto button = AddTo(
			_column,
			object_ptr<Kit::PushButton>(_column, text),
			Rem(0.5));
		button->setWide(true, true);
		button->setClickedCallback([=] { choose(scope); });
	}
	const auto line = AddTo(_column, object_ptr<Line>(_column), Rem(0.5));
	const auto cancelButton = line->add(object_ptr<Kit::PushButton>(
		line,
		tr::lng_parvane_planner_cancel(tr::now),
		Kit::PushButton::Kind::Ghost));
	line->addStretch();
	cancelButton->setClickedCallback([=] { cancel(); });
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
}

int SeriesPrompt::resizeGetHeight(int newWidth) {
	// `.seriesPrompt`: поля 0.75rem
	const auto pad = Rem(0.75);
	_column->resizeToWidth(std::max(newWidth - 2 * pad, 1));
	_column->moveToLeft(pad, pad, newWidth);
	return _column->height() + 2 * pad;
}

void SeriesPrompt::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Raised));
	p.drawRoundedRect(QRectF(rect()), Rem(0.75), Rem(0.75));
}

// ── правило повтора ──────────────────────────────────────────────────────────

RepeatFields::RepeatFields(
	QWidget *parent,
	Window::SessionController *controller,
	std::shared_ptr<rpl::variable<planner::RepeatDraft>> draft)
: RpWidget(parent)
, _controller(controller)
, _draft(std::move(draft)) {
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	rebuild();
}

void RepeatFields::set(Fn<void(planner::RepeatDraft&)> change, bool structural) {
	auto next = _draft->current();
	change(next);
	*_draft = next;
	if (structural) {
		// Состав полей меняется после этого кадра: пункт меню ещё держит свой виджет
		crl::on_main(this, [=] { rebuild(); });
	} else {
		refreshSummary();
	}
}

void RepeatFields::refreshSummary() {
	if (!_summary) {
		return;
	}
	const auto repeat = planner::draftToRepeat(_draft->current());
	const auto valid = repeat && !planner::validateRepeat(*repeat);
	_summary->entity()->setText(valid ? FormatRepeat(*repeat) : QString());
	_summary->toggle(valid, anim::type::instant);
}

void RepeatFields::rebuild() {
	Kit::ClearLayout(_column);
	_summary = nullptr;
	const auto draft = _draft->current();
	const auto gap = Rem(0.5); // `.repeat`
	auto kinds = std::vector<FormSelect::Option>{
		{ u"none"_q, tr::lng_parvane_planner_repeat_kind_none(tr::now) },
		{ u"daily"_q, tr::lng_parvane_planner_repeat_kind_daily(tr::now) },
		{ u"weekly"_q, tr::lng_parvane_planner_repeat_kind_weekly(tr::now) },
		{ u"monthly"_q, tr::lng_parvane_planner_repeat_kind_monthly(tr::now) },
		{ u"yearly"_q, tr::lng_parvane_planner_repeat_kind_yearly(tr::now) },
	};
	const auto kind = AddTo(_column, object_ptr<FormSelect>(
		_column,
		tr::lng_parvane_planner_repeat_label(tr::now),
		std::move(kinds),
		Q(draft.kind)), gap);
	kind->setOnChange([=](QString value) {
		set([=](planner::RepeatDraft &d) { d.kind = S(value); }, true);
	});
	if (draft.kind == "none") {
		return;
	}
	const auto grid = AddTo(_column, object_ptr<FieldsGrid>(_column, false), gap);
	const auto intervalLabel = (draft.kind == "weekly")
		? tr::lng_parvane_planner_repeat_interval_weeks(tr::now)
		: (draft.kind == "monthly")
		? tr::lng_parvane_planner_repeat_interval_months(tr::now)
		: (draft.kind == "yearly")
		? tr::lng_parvane_planner_repeat_interval_years(tr::now)
		: tr::lng_parvane_planner_repeat_interval_days(tr::now);
	const auto interval = grid->add(object_ptr<FormField>(
		grid, _controller, intervalLabel, FormField::Type::Number, draft.interval));
	interval->setOnInput([=](std::string value) {
		set([=](planner::RepeatDraft &d) { d.interval = value; }, false);
	});
	if (draft.kind == "monthly") {
		const auto monthDay = grid->add(object_ptr<FormField>(
			grid,
			_controller,
			tr::lng_parvane_planner_repeat_month_day(tr::now),
			FormField::Type::Number,
			draft.monthDay,
			tr::lng_parvane_planner_repeat_month_day_from_start(tr::now)));
		monthDay->setOnInput([=](std::string value) {
			set([=](planner::RepeatDraft &d) { d.monthDay = value; }, false);
		});
	}
	const auto start = grid->add(object_ptr<FormField>(
		grid,
		_controller,
		tr::lng_parvane_planner_repeat_start(tr::now),
		FormField::Type::Date,
		draft.startDay));
	start->setOnInput([=](std::string value) {
		set([=](planner::RepeatDraft &d) { d.startDay = value; }, false);
	});
	if (draft.kind == "weekly") {
		// `.weekdays`: понедельник первым, промежуток 0 0.5rem
		const auto flow = AddTo(_column, object_ptr<Kit::Flow>(_column, Rem(0.5)), gap);
		for (const auto weekday : { 1, 2, 3, 4, 5, 6, 0 }) {
			const auto checked = ranges::contains(draft.weekdays, weekday);
			const auto box = flow->add(object_ptr<TickBox>(flow, FormatWeekday((weekday + 6) % 7), checked));
			box->setOnChange([=](bool on) {
				set([=](planner::RepeatDraft &d) {
					auto rest = std::vector<int>();
					for (const auto day : d.weekdays) {
						if (day != weekday) {
							rest.push_back(day);
						}
					}
					if (on) {
						rest.push_back(weekday);
					}
					d.weekdays = rest;
				}, false);
			});
		}
	}
	const auto endGrid = AddTo(_column, object_ptr<FieldsGrid>(_column, false), gap);
	auto ends = std::vector<FormSelect::Option>{
		{ u"never"_q, tr::lng_parvane_planner_repeat_end_never(tr::now) },
		{ u"until"_q, tr::lng_parvane_planner_repeat_end_until(tr::now) },
		{ u"count"_q, tr::lng_parvane_planner_repeat_end_count(tr::now) },
	};
	const auto endKind = endGrid->add(object_ptr<FormSelect>(
		endGrid,
		tr::lng_parvane_planner_repeat_end(tr::now),
		std::move(ends),
		Q(draft.endKind)));
	endKind->setOnChange([=](QString value) {
		set([=](planner::RepeatDraft &d) { d.endKind = S(value); }, true);
	});
	if (draft.endKind == "until") {
		const auto endDay = endGrid->add(object_ptr<FormField>(
			endGrid,
			_controller,
			tr::lng_parvane_planner_repeat_end_date(tr::now),
			FormField::Type::Date,
			draft.endDay));
		endDay->setOnInput([=](std::string value) {
			set([=](planner::RepeatDraft &d) { d.endDay = value; }, false);
		});
	} else if (draft.endKind == "count") {
		const auto count = endGrid->add(object_ptr<FormField>(
			endGrid,
			_controller,
			tr::lng_parvane_planner_repeat_count(tr::now),
			FormField::Type::Number,
			draft.count));
		count->setOnInput([=](std::string value) {
			set([=](planner::RepeatDraft &d) { d.count = value; }, false);
		});
	}
	_summary = AddFold(_column, SmallText(_column, QString()), gap, false);
	refreshSummary();
	if (width() > 0) {
		_column->resizeToWidth(width());
	}
}

int RepeatFields::resizeGetHeight(int newWidth) {
	_column->resizeToWidth(newWidth);
	_column->moveToLeft(0, 0, newWidth);
	return _column->height();
}

RepeatRow::RepeatRow(
	QWidget *parent,
	Window::SessionController *controller,
	std::shared_ptr<rpl::variable<planner::RepeatDraft>> draft)
: RpWidget(parent) {
	_row = Ui::CreateChild<CardRow>(this, u"loop"_q);
	// `.cardRowButton`: правило словами и стрелка; рамка `--pv-line2`, при наведении — акцент
	class Toggle final : public Kit::Button {
	public:
		Toggle(QWidget *parent, std::shared_ptr<rpl::variable<planner::RepeatDraft>> draft, Fn<bool()> open)
		: Button(parent)
		, _open(std::move(open)) {
			Kit::RepaintOnTones(this);
			setNaturalWidth(-1);
			resize(width(), Rem(2.625));
			draft->value() | rpl::on_next([=](const planner::RepeatDraft &value) {
				const auto repeat = planner::draftToRepeat(value);
				_text = repeat
					? FormatRepeat(*repeat)
					: tr::lng_parvane_planner_repeat_kind_none(tr::now);
				setAccessibleName(_text);
				update();
			}, lifetime());
		}

	protected:
		int resizeGetHeight(int newWidth) override {
			return Rem(2.625);
		}
		void paintEvent(QPaintEvent *e) override {
			auto p = QPainter(this);
			const auto r = QRectF(rect());
			const auto radius = double(Rem(0.5));
			{
				PainterHighQualityEnabler hq(p);
				auto pen = QPen((isOver() || isDown()) ? ToneColor(Tone::Accent) : ToneColor(Tone::Line2));
				pen.setWidthF(Px(1));
				p.setPen(pen);
				p.setBrush(ToneColor(Tone::Panel));
				const auto half = Px(1) / 2.;
				p.drawRoundedRect(r.adjusted(half, half, -half, -half), radius, radius);
			}
			const auto font = Font(Kit::kBodyPx);
			const auto pad = Rem(0.75);
			const auto icon = Rem(1.125);
			p.setFont(font->f);
			p.setPen(ToneColor(Tone::Fg));
			p.drawText(
				pad,
				Baseline(font, 0, height()),
				font->elided(_text, std::max(width() - 2 * pad - icon - Rem(0.5), 0)));
			PaintGlyph(
				p,
				_open() ? u"up"_q : u"down"_q,
				ToneColor(Tone::Muted),
				QRect(width() - pad - icon, (height() - icon) / 2, icon, icon));
			if (focusVisible() && hasFocus()) {
				paintFocusRing(p, r, radius);
			}
		}

	private:
		Fn<bool()> _open;
		QString _text;

	};
	const auto toggleButton = _row->add(object_ptr<Toggle>(_row->body(), draft, [=] { return _open; }));
	toggleButton->setClickedCallback([=] {
		toggle();
		toggleButton->update();
	});
	// Поля и «Сохранить правило» видны только раскрытыми и в свёрнутом виде места не занимают (spec 030)
	_fields = AddFold(_row->body(), object_ptr<RepeatFields>(_row->body(), controller, draft), Rem(0.625), false);
	_extra = AddFold(_row->body(), object_ptr<Ui::VerticalLayout>(_row->body()), Rem(0.625), false);
	_row->heightValue() | rpl::on_next([=](int h) {
		resize(width(), h);
	}, lifetime());
}

not_null<Ui::VerticalLayout*> RepeatRow::extra() const {
	return _extra->entity();
}

not_null<CardRow*> RepeatRow::row() const {
	return _row;
}

void RepeatRow::setOpen(bool open) {
	if (_open != open) {
		toggle();
	}
}

void RepeatRow::toggle() {
	_open = !_open;
	_fields->toggle(_open, anim::type::instant);
	_extra->toggle(_open, anim::type::instant);
	_row->resizeToWidth(width());
}

int RepeatRow::resizeGetHeight(int newWidth) {
	_row->resizeToWidth(newWidth);
	_row->moveToLeft(0, 0, newWidth);
	return _row->height();
}

// ── цвет и список ────────────────────────────────────────────────────────────

ColorSwatches::ColorSwatches(QWidget *parent, int value, Fn<void(int)> change)
: RpWidget(parent)
, _value(value) {
	// `.swatch`: круг 1.75rem цвета списка в кольце `--pv-panel` 0.1875rem; `.swatchNone`; `.swatchActive`
	class ListSwatch final : public Kit::Button {
	public:
		ListSwatch(QWidget *parent, int color, Fn<bool()> active)
		: Button(parent)
		, _color(color)
		, _active(std::move(active)) {
			Kit::RepaintOnTones(this);
			setAccessibleName(color
				? tr::lng_parvane_planner_list_color_n(tr::now, lt_n, QString::number(color))
				: tr::lng_parvane_planner_list_color_none(tr::now));
			const auto side = Rem(1.75) + 2 * Rem(0.125);
			setNaturalWidth(side);
			resize(side, side);
		}

	protected:
		void paintEvent(QPaintEvent *e) override {
			auto p = QPainter(this);
			PainterHighQualityEnabler hq(p);
			const auto outline = double(Rem(0.125));
			const auto circle = QRectF(rect()).adjusted(outline, outline, -outline, -outline);
			p.setPen(Qt::NoPen);
			if (_active() || (focusVisible() && hasFocus())) {
				p.setBrush(ToneColor(Tone::Accent));
				p.drawEllipse(QRectF(rect()));
			}
			p.setBrush(ToneColor(Tone::Panel));
			p.drawEllipse(circle);
			if (_color) {
				const auto ring = double(Rem(0.1875));
				p.setBrush(ListColor(_color));
				p.drawEllipse(circle.adjusted(ring, ring, -ring, -ring));
			} else {
				auto pen = QPen(ToneColor(Tone::Line2));
				pen.setWidthF(Px(1));
				p.setPen(pen);
				p.setBrush(Qt::NoBrush);
				const auto half = Px(1) / 2.;
				p.drawEllipse(circle.adjusted(half, half, -half, -half));
			}
			if (isOver() || isDown()) {
				p.setPen(Qt::NoPen);
				p.setBrush(Kit::Mix(Tone::Fg, isDown() ? 0.12 : 0.06));
				p.drawEllipse(circle);
			}
		}

	private:
		int _color = 0;
		Fn<bool()> _active;

	};
	_flow = Ui::CreateChild<Kit::Flow>(this, Rem(0.375));
	for (auto color = 0; color <= planner::kListColorCount; ++color) {
		const auto item = _flow->add(object_ptr<ListSwatch>(_flow, color, [=] { return _value == color; }));
		item->setClickedCallback([=] {
			setValue(color);
			change(color);
		});
		_items.push_back(item);
	}
	_flow->heightValue() | rpl::on_next([=](int h) {
		resize(width(), h);
	}, lifetime());
	setNaturalWidth(-1);
}

void ColorSwatches::setValue(int value) {
	_value = value;
	for (const auto item : _items) {
		item->update();
	}
}

int ColorSwatches::resizeGetHeight(int newWidth) {
	_flow->resizeToWidth(newWidth);
	_flow->moveToLeft(0, 0, newWidth);
	return _flow->height();
}

ListPicker::ListPicker(
	QWidget *parent,
	Window::SessionController *controller,
	const planner::State &state,
	const std::string &value,
	Fn<void(std::string)> change)
: RpWidget(parent)
, _controller(controller)
, _projects(state.projects)
, _value(value)
, _change(std::move(change)) {
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	showSelect();
}

void ListPicker::setState(const planner::State &state, const std::string &value) {
	_projects = state.projects;
	_value = value;
	refreshOptions();
}

void ListPicker::refreshOptions() {
	if (_creating || !_select) {
		return;
	}
	// Только что созданный список попадает в состояние позже — его пункт нужен сразу
	auto projects = _projects;
	if (!ranges::contains(projects, _value)) {
		projects.push_back(_value);
	}
	auto options = std::vector<FormSelect::Option>();
	static const auto kNone = QString(QChar(0)) + u"none"_q;
	static const auto kNew = QString(QChar(0)) + u"new"_q;
	for (const auto &item : projects) {
		options.push_back({ item.empty() ? kNone : Q(item), FormatProject(item) });
	}
	options.push_back({ kNew, tr::lng_parvane_planner_create_list_option(tr::now) });
	_select->setOptions(std::move(options));
	_select->setValue(_value.empty() ? kNone : Q(_value));
}

void ListPicker::showSelect() {
	_creating = false;
	Kit::ClearLayout(_column);
	static const auto kNone = QString(QChar(0)) + u"none"_q;
	static const auto kNew = QString(QChar(0)) + u"new"_q;
	_select = AddTo(_column, object_ptr<FormSelect>(
		_column,
		tr::lng_parvane_planner_field_list(tr::now),
		std::vector<FormSelect::Option>(),
		QString()), 0);
	_select->setOnChange([=](QString value) {
		if (value == kNew) {
			crl::on_main(this, [=] { showCreate(); });
			return;
		}
		_value = (value == kNone) ? std::string() : S(value);
		_change(_value);
	});
	refreshOptions();
	if (width() > 0) {
		_column->resizeToWidth(width());
	}
}

void ListPicker::showCreate() {
	_creating = true;
	_select = nullptr;
	Kit::ClearLayout(_column);
	struct Draft {
		int color = 0;
	};
	const auto draft = std::make_shared<Draft>();
	const auto gap = Rem(0.5); // `.listCreate`
	const auto name = AddTo(_column, object_ptr<FormField>(
		_column,
		_controller,
		tr::lng_parvane_planner_new_list(tr::now),
		FormField::Type::Text,
		std::string(),
		QString(),
		int(planner::kGroupNameMaxLength)), gap);
	AddTo(_column, object_ptr<ColorSwatches>(_column, 0, [=](int color) {
		draft->color = color;
	}), gap);
	const auto error = AddFold(_column, SmallText(_column, QString(), Tone::Red), gap, false);
	const auto actions = AddTo(_column, object_ptr<Kit::Flow>(_column, Rem(0.5)), gap);
	const auto create = actions->add(object_ptr<Kit::PushButton>(
		actions,
		tr::lng_parvane_planner_create_list(tr::now),
		Kit::PushButton::Kind::Accent));
	const auto cancel = actions->add(object_ptr<Kit::PushButton>(
		actions,
		tr::lng_parvane_planner_cancel(tr::now),
		Kit::PushButton::Kind::Ghost));
	const auto submit = [=] {
		const auto listName = S(name->raw().trimmed());
		if (listName.empty()) {
			error->entity()->setText(tr::lng_parvane_planner_error_list_name(tr::now));
			error->toggle(true, anim::type::instant);
			_column->resizeToWidth(width());
			return;
		}
		if (!ranges::contains(_projects, listName)) {
			const auto color = draft->color;
			Sections::UpdatePlanner([=](planner::State &state) {
				const auto list = planner::ensureList(state, listName, NewId());
				if (list && color) {
					list->color = color;
				}
			}, tr::lng_parvane_planner_notice_list_created(tr::now, lt_name, Q(listName)));
			_projects.push_back(listName);
		}
		_value = listName;
		_change(listName);
		crl::on_main(this, [=] { showSelect(); });
	};
	create->setClickedCallback(submit);
	name->submits() | rpl::on_next(submit, name->lifetime());
	cancel->setClickedCallback([=] {
		crl::on_main(this, [=] { showSelect(); });
	});
	if (width() > 0) {
		_column->resizeToWidth(width());
	}
	name->setFocusFast();
}

int ListPicker::resizeGetHeight(int newWidth) {
	_column->resizeToWidth(newWidth);
	_column->moveToLeft(0, 0, newWidth);
	return _column->height();
}

// ── «Напомнить», статус ──────────────────────────────────────────────────────

namespace {

const auto kRemindNone = u"none"_q;

[[nodiscard]] std::vector<FormSelect::Option> RemindOptions(std::optional<int> value) {
	auto result = std::vector<FormSelect::Option>{
		{ kRemindNone, tr::lng_parvane_planner_remind_none(tr::now) },
	};
	for (const auto minutes : planner::remindOptions(value)) {
		result.push_back({ QString::number(minutes), FormatRemind(minutes) });
	}
	return result;
}

} // namespace

object_ptr<FormSelect> MakeRemindSelect(QWidget *parent, std::optional<int> value, Fn<void(std::optional<int>)> change) {
	auto result = object_ptr<FormSelect>(
		parent,
		tr::lng_parvane_planner_remind(tr::now),
		RemindOptions(value),
		value ? QString::number(*value) : kRemindNone);
	result->setOnChange([=](QString raw) {
		change((raw == kRemindNone) ? std::nullopt : std::optional<int>(raw.toInt()));
	});
	return result;
}

void SetRemindValue(not_null<FormSelect*> select, std::optional<int> value) {
	select->setOptions(RemindOptions(value));
	select->setValue(value ? QString::number(*value) : kRemindNone);
}

object_ptr<FormSelect> MakeStatusSelect(QWidget *parent, const std::string &value, Fn<void(std::string)> change) {
	auto options = std::vector<FormSelect::Option>();
	for (const auto &status : planner::kStatuses) {
		options.push_back({ Q(status), FormatStatus(status) });
	}
	auto result = object_ptr<FormSelect>(
		parent,
		tr::lng_parvane_planner_field_status(tr::now),
		std::move(options),
		Q(value));
	result->setOnChange([=](QString raw) {
		change(S(raw));
	});
	return result;
}

// ── описание ряда, «Повтор и детали», переключатель вида ─────────────────────

DescriptionScopeBox::DescriptionScopeBox(
	QWidget *parent,
	planner::DescriptionScope scope,
	bool confirmAll,
	Fn<void(planner::DescriptionScope)> change)
: RpWidget(parent)
, _confirmAll(confirmAll)
, _change(std::move(change)) {
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	_check = AddTo(_column, object_ptr<TickBox>(
		_column,
		tr::lng_parvane_planner_description_scope(tr::now),
		scope == planner::DescriptionScope::All), 0);
	_check->setOnChange([=](bool checked) {
		if (checked && _confirmAll) {
			// Галочка встаёт только после «Сделать общим»
			_check->setChecked(false);
			ask(true);
			return;
		}
		ask(false);
		_change(checked ? planner::DescriptionScope::All : planner::DescriptionScope::One);
	});
}

void DescriptionScopeBox::setScope(planner::DescriptionScope scope) {
	_check->setChecked(scope == planner::DescriptionScope::All);
}

void DescriptionScopeBox::ask(bool asking) {
	if (_prompt) {
		const auto old = _prompt;
		_prompt = nullptr;
		crl::on_main(this, [=] {
			delete old;
			_column->resizeToWidth(width());
		});
	}
	if (!asking) {
		return;
	}
	class Prompt final : public Ui::RpWidget {
	public:
		Prompt(QWidget *parent, Fn<void()> confirm, Fn<void()> cancel)
		: RpWidget(parent) {
			Kit::RepaintOnTones(this);
			_column = Ui::CreateChild<Ui::VerticalLayout>(this);
			const auto gap = Rem(0.5);
			AddTo(_column, SmallText(
				_column,
				tr::lng_parvane_planner_description_share_title(tr::now),
				Tone::Muted,
				14), gap);
			const auto share = AddTo(_column, object_ptr<Kit::PushButton>(
				_column,
				tr::lng_parvane_planner_description_share(tr::now)), gap);
			share->setWide(true, true);
			share->setClickedCallback(confirm);
			const auto line = AddTo(_column, object_ptr<Line>(_column), gap);
			line->add(object_ptr<Kit::PushButton>(
				line,
				tr::lng_parvane_planner_cancel(tr::now),
				Kit::PushButton::Kind::Ghost))->setClickedCallback(cancel);
			line->addStretch();
			_column->heightValue() | rpl::on_next([=] {
				if (width() > 0) {
					resizeToWidth(width());
				}
			}, lifetime());
		}

	protected:
		int resizeGetHeight(int newWidth) override {
			const auto pad = Rem(0.75);
			_column->resizeToWidth(std::max(newWidth - 2 * pad, 1));
			_column->moveToLeft(pad, pad, newWidth);
			return _column->height() + 2 * pad;
		}
		void paintEvent(QPaintEvent *e) override {
			auto p = QPainter(this);
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Raised));
			p.drawRoundedRect(QRectF(rect()), Rem(0.75), Rem(0.75));
		}

	private:
		Ui::VerticalLayout *_column = nullptr;

	};
	_prompt = AddTo(_column, object_ptr<Prompt>(_column, [=] {
		_check->setChecked(true);
		ask(false);
		_change(planner::DescriptionScope::All);
	}, [=] {
		ask(false);
	}), Rem(0.5));
	_column->resizeToWidth(width());
}

int DescriptionScopeBox::resizeGetHeight(int newWidth) {
	_column->resizeToWidth(newWidth);
	_column->moveToLeft(0, 0, newWidth);
	return _column->height();
}

KindSwitch::KindSwitch(QWidget *parent, std::vector<QString> labels, int active, Fn<void(int)> change)
: RpWidget(parent)
, _active(active)
, _change(std::move(change)) {
	Kit::RepaintOnTones(this);
	// `.kindSwitch`: подложка `--pv-bg`, поля 0.1875rem, промежуток 0.25rem; кнопка 2rem, поля 0 1rem
	class Item final : public Kit::Button {
	public:
		Item(QWidget *parent, const QString &text, Fn<bool()> active)
		: Button(parent)
		, _text(text)
		, _active(std::move(active)) {
			setAccessibleName(text);
			Kit::RepaintOnTones(this);
			const auto w = Font(14)->width(text) + 2 * Rem(1);
			setNaturalWidth(w);
			resize(w, Rem(2));
		}

		QAccessible::Role accessibilityRole() override {
			return QAccessible::RadioButton;
		}

	protected:
		void paintEvent(QPaintEvent *e) override {
			auto p = QPainter(this);
			const auto on = _active();
			if (on) {
				PainterHighQualityEnabler hq(p);
				p.setPen(Qt::NoPen);
				p.setBrush(ToneColor(Tone::Panel));
				p.drawRoundedRect(QRectF(rect()), height() / 2., height() / 2.);
			}
			const auto font = Font(14);
			p.setFont(font->f);
			p.setPen(ToneColor(on || isOver() ? Tone::Fg : Tone::Muted));
			p.drawText(QRect(0, 0, width(), height()), Qt::AlignCenter, _text);
			if (focusVisible() && hasFocus()) {
				paintFocusRing(p, QRectF(rect()), height() / 2.);
			}
		}

	private:
		QString _text;
		Fn<bool()> _active;

	};
	const auto pad = Rem(0.1875);
	auto x = pad;
	for (auto i = 0; i != int(labels.size()); ++i) {
		const auto item = Ui::CreateChild<Item>(this, labels[i], [=] { return _active == i; });
		item->move(x, pad);
		x += item->width() + Rem(0.25);
		item->setClickedCallback([=] {
			if (_active != i) {
				setActive(i);
				_change(i);
			}
		});
		_items.push_back(item);
	}
	const auto w = x - Rem(0.25) + pad;
	setNaturalWidth(w);
	resize(w, Rem(2) + 2 * pad);
}

void KindSwitch::setActive(int index) {
	_active = index;
	for (const auto item : _items) {
		item->update();
	}
}

void KindSwitch::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	p.setPen(Qt::NoPen);
	p.setBrush(ToneColor(Tone::Bg));
	p.drawRoundedRect(QRectF(rect()), Rem(1.25), Rem(1.25));
}

} // namespace Parvane::PlannerForms
