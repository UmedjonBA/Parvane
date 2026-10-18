// Parvane fork: реализация parvane_planner_common.h — подписи (web plannerFormat.ts), цвета, холст, метки, название.
#include "parvane/parvane_planner_common.h"

#include "parvane/parvane_icons.h"

#include "lang/lang_keys.h"
#include "base/algorithm.h"
#include "ui/painter.h"
#include "styles/palette.h"

#include <parvane/sections/planner_links.h>

#include <QtCore/QDateTime>
#include <QtCore/QLocale>
#include <QtSvg/QSvgRenderer>
#include <QtGui/QtEvents>

namespace Parvane {
[[nodiscard]] bool IsRussianUi(); // parvane_client.cpp
} // namespace Parvane

namespace Parvane::PlannerViews {
namespace {

constexpr auto kMinutesInHour = 60;
constexpr auto kMinutesInDay = 24 * 60;
constexpr auto kDragDistance = 6;

const QLocale &Locale() {
	static const auto ru = QLocale(QLocale::Russian, QLocale::Russia);
	static const auto en = QLocale(QLocale::English, QLocale::UnitedStates);
	return IsRussianUi() ? ru : en;
}

QString Capitalize(QString text) {
	if (!text.isEmpty()) {
		text[0] = text[0].toUpper();
	}
	return text;
}

QString StripDot(QString text) {
	if (text.endsWith(u'.')) {
		text.chop(1);
	}
	return text;
}

// «5 окт.» / «Oct 5» (с годом — «5 окт. 2026» / «Oct 5, 2026»), как Intl `{ day, month: 'short', year }`
QString ShortWithYear(const QDate &date, bool withYear) {
	const auto &locale = Locale();
	if (IsRussianUi()) {
		auto result = QString::number(date.day()) + u' ' + locale.monthName(date.month(), QLocale::ShortFormat);
		return withYear ? (result + u' ' + QString::number(date.year())) : result;
	}
	auto result = locale.monthName(date.month(), QLocale::ShortFormat) + u' ' + QString::number(date.day());
	return withYear ? (result + u", "_q + QString::number(date.year())) : result;
}

} // namespace

// ── подписи ──────────────────────────────────────────────────────────────────

QDate DateOf(const std::string &day) {
	return QDate::fromString(QString::fromStdString(day), u"yyyy-MM-dd"_q);
}

std::string DayKey(const QDate &date) {
	return date.toString(u"yyyy-MM-dd"_q).toStdString();
}

std::string TodayKey() {
	return DayKey(QDate::currentDate());
}

int NowMinutes() {
	const auto now = QTime::currentTime();
	return now.hour() * kMinutesInHour + now.minute();
}

QString Q(const std::string &text) {
	return QString::fromStdString(text);
}

std::string S(const QString &text) {
	return text.toStdString();
}

QString FormatDay(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return QString();
	}
	return IsRussianUi()
		? (QString::number(date.day()) + u' ' + Locale().monthName(date.month(), QLocale::LongFormat))
		: (Locale().monthName(date.month(), QLocale::LongFormat) + u' ' + QString::number(date.day()));
}

QString FormatDayShort(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return QString();
	}
	return StripDot(ShortWithYear(date, false));
}

QString FormatDayLong(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return QString();
	}
	return Capitalize(Locale().dayName(date.dayOfWeek(), QLocale::LongFormat) + u", "_q + FormatDay(day));
}

QString FormatDayLabel(const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return QString();
	}
	return Capitalize(StripDot(Locale().dayName(date.dayOfWeek(), QLocale::ShortFormat)) + u", "_q + FormatDay(day));
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
	return date.isValid() ? Capitalize(Locale().dayName(date.dayOfWeek(), QLocale::LongFormat)) : QString();
}

QString FormatMonth(int year, int month) {
	return Capitalize(Locale().standaloneMonthName(month, QLocale::LongFormat)) + u' ' + QString::number(year);
}

QString FormatMonthShort(int month) {
	return Capitalize(StripDot(Locale().standaloneMonthName(month, QLocale::ShortFormat)));
}

QString FormatMonthName(int month) {
	return Capitalize(Locale().standaloneMonthName(month, QLocale::LongFormat));
}

QString FormatWeekday(int index, bool isLong) {
	// QLocale: 1 — понедельник
	return Capitalize(StripDot(Locale().dayName(
		(index % 7) + 1,
		isLong ? QLocale::LongFormat : QLocale::ShortFormat)));
}

int MondayIndex(const std::string &day) {
	return (planner::weekdayOf(day) + 6) % 7;
}

QString FormatWeekRange(const std::string &day) {
	const auto days = planner::getWeekKeys(day);
	return FormatDayShort(days.front()) + u" – "_q + FormatDayShort(days.back());
}

QString FormatPeriod(const std::string &view, const std::string &day) {
	const auto date = DateOf(day);
	if (!date.isValid()) {
		return QString();
	}
	if (view == "year") {
		return QString::number(date.year());
	} else if (view == "month") {
		return FormatMonth(date.year(), date.month());
	} else if (view == "day") {
		return FormatDayLong(day);
	}
	const auto from = (view == "week") ? DateOf(planner::getWeekKeys(day).front()) : date;
	const auto to = (view == "week")
		? DateOf(planner::getWeekKeys(day).back())
		: DateOf(planner::addDays(day, planner::kAgendaDays - 1));
	return ShortWithYear(from, from.year() != to.year()) + u" – "_q + ShortWithYear(to, true);
}

QString FormatNumber(double value, int maximumFractionDigits) {
	const auto factor = std::pow(10., maximumFractionDigits);
	const auto rounded = std::round(value * factor) / factor;
	auto result = Locale().toString(rounded, 'f', maximumFractionDigits);
	const auto point = Locale().decimalPoint();
	if (maximumFractionDigits > 0 && result.contains(point)) {
		while (result.endsWith(u'0')) {
			result.chop(1);
		}
		if (result.endsWith(point)) {
			result.chop(point.size());
		}
	}
	return result;
}

QString FormatInt(long long value) {
	return Locale().toString(value);
}

QString FormatHours(double minutes) {
	return tr::lng_parvane_planner_hours_value(tr::now, lt_hours, FormatNumber(minutes / 60., 2));
}

QString FormatHoursNumber(double minutes) {
	return FormatNumber(minutes / 60., 1);
}

QString FormatDuration(int minutes) {
	if (minutes < kMinutesInHour) {
		return tr::lng_parvane_planner_minutes_value(tr::now, lt_minutes, QString::number(minutes));
	}
	const auto hours = tr::lng_parvane_planner_hours_value(
		tr::now,
		lt_hours,
		QString::number(minutes / kMinutesInHour));
	return (minutes % kMinutesInHour)
		? (hours + u' ' + tr::lng_parvane_planner_minutes_value(
			tr::now,
			lt_minutes,
			QString::number(minutes % kMinutesInHour)))
		: hours;
}

QString FormatSpan(double minutes) {
	return Q(planner::formatSpan(minutes));
}

QString FormatRemind(int minutes) {
	if (!minutes) {
		return tr::lng_parvane_planner_remind_at_start(tr::now);
	}
	const auto amount = (minutes % kMinutesInDay == 0)
		? tr::lng_parvane_planner_days_value(tr::now, lt_days, QString::number(minutes / kMinutesInDay))
		: FormatDuration(minutes);
	return tr::lng_parvane_planner_remind_before(tr::now, lt_amount, amount);
}

QString FormatRepeat(const planner::Repeat &repeat) {
	const auto n = QString::number(repeat.interval);
	const auto single = (repeat.interval == 1);
	auto base = QString();
	if (repeat.kind == "daily") {
		base = single
			? tr::lng_parvane_planner_repeat_daily(tr::now)
			: tr::lng_parvane_planner_repeat_every_days(tr::now, lt_n, n);
	} else if (repeat.kind == "weekly") {
		auto weekdays = repeat.weekdays.value_or(std::vector<int>());
		std::sort(weekdays.begin(), weekdays.end(), [](int a, int b) {
			return (a + 6) % 7 < (b + 6) % 7;
		});
		auto list = QStringList();
		for (const auto weekday : weekdays) {
			list.push_back(FormatWeekday((weekday + 6) % 7));
		}
		const auto days = list.join(u", "_q);
		base = single
			? tr::lng_parvane_planner_repeat_weekly(tr::now, lt_days, days)
			: tr::lng_parvane_planner_repeat_every_weeks(tr::now, lt_n, n, lt_days, days);
	} else if (repeat.kind == "monthly") {
		const auto day = QString::number(repeat.monthDay
			? *repeat.monthDay
			: (!repeat.startDay.empty() ? DateOf(repeat.startDay).day() : 1));
		base = single
			? tr::lng_parvane_planner_repeat_monthly(tr::now, lt_day, day)
			: tr::lng_parvane_planner_repeat_every_months(tr::now, lt_n, n, lt_day, day);
	} else {
		const auto date = repeat.startDay.empty() ? QString() : FormatDay(repeat.startDay);
		base = single
			? tr::lng_parvane_planner_repeat_yearly(tr::now, lt_date, date)
			: tr::lng_parvane_planner_repeat_every_years(tr::now, lt_n, n, lt_date, date);
	}
	auto parts = QStringList{ base };
	if (repeat.endDay) {
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

QString FormatMeal(const std::string &meal) {
	if (meal == "breakfast") {
		return tr::lng_parvane_planner_meal_breakfast(tr::now);
	} else if (meal == "lunch") {
		return tr::lng_parvane_planner_meal_lunch(tr::now);
	} else if (meal == "dinner") {
		return tr::lng_parvane_planner_meal_dinner(tr::now);
	} else if (meal == "snack") {
		return tr::lng_parvane_planner_meal_snack(tr::now);
	}
	return tr::lng_parvane_planner_meal_other(tr::now);
}

QString PlainName(const std::string &name) {
	return Q(planner::formatPlainName(name));
}

// ── цвета ────────────────────────────────────────────────────────────────────

QColor KindColor(Kind kind) {
	switch (kind) {
	case Kind::Event: return ToneColor(Tone::Blue);
	case Kind::Task: return ToneColor(Tone::Purple);
	case Kind::Food: return ToneColor(Tone::Orange);
	case Kind::Sleep: return ToneColor(Tone::Aqua);
	case Kind::Workout: return ToneColor(Tone::Green);
	case Kind::Due: return ToneColor(Tone::Red);
	case Kind::Muted: return ToneColor(Tone::Muted);
	case Kind::Metric: return ToneColor(Tone::Red);
	}
	return ToneColor(Tone::Accent);
}

QColor ListColor(int color) {
	if (color <= 0) {
		return QColor();
	}
	// Палитра собеседников web (`--color-peer-0…6`: красный, оранжевый, фиолетовый, зелёный, бирюзовый, синий,
	// розовый) — те же цвета имён tdesktop (ColorIndexToPaletteIndex)
	static const int map[] = { 0, 7, 4, 1, 6, 3, 5 };
	const style::color *colors[] = {
		&st::historyPeer1NameFg,
		&st::historyPeer2NameFg,
		&st::historyPeer3NameFg,
		&st::historyPeer4NameFg,
		&st::historyPeer5NameFg,
		&st::historyPeer6NameFg,
		&st::historyPeer7NameFg,
		&st::historyPeer8NameFg,
	};
	return (*colors[map[(color - 1) % 7]])->c;
}

QColor EntryColor(int listColor, Kind kind) {
	const auto list = ListColor(listColor);
	return list.isValid() ? list : KindColor(kind);
}

QColor MixOver(QColor color, double share, QColor base) {
	const auto mix = [&](int a, int b) {
		return int(std::round(a * share + b * (1. - share)));
	};
	const auto alpha = color.alphaF() * share + base.alphaF() * (1. - share);
	auto result = QColor(
		mix(color.red(), base.red()),
		mix(color.green(), base.green()),
		mix(color.blue(), base.blue()));
	result.setAlphaF(std::clamp(alpha, 0., 1.));
	return result;
}

// ── холст ────────────────────────────────────────────────────────────────────

Canvas::Canvas(QWidget *parent)
: RpWidget(parent) {
	setMouseTracking(true);
	Kit::RepaintOnTones(this);
}

void Canvas::refresh() {
	if (width() > 0) {
		resizeToWidth(width());
	}
	update();
}

void Canvas::area(QRect rect, Fn<void()> click, Fn<void()> doubleClick, const QString &drag) {
	_areas.push_back({ rect, std::move(click), std::move(doubleClick), drag });
}

bool Canvas::over(QRect rect) const {
	return _mouse && rect.contains(*_mouse);
}

int Canvas::resizeGetHeight(int newWidth) {
	_areas.clear();
	return draw(nullptr, newWidth);
}

void Canvas::paintEvent(QPaintEvent *e) {
	auto p = Painter(this);
	PainterHighQualityEnabler hq(p);
	_areas.clear();
	draw(&p, width());
	const auto index = _mouse ? areaAt(*_mouse) : -1;
	setCursor((index >= 0 && (_areas[index].click || !_areas[index].drag.isEmpty()))
		? style::cur_pointer
		: style::cur_default);
}

int Canvas::areaAt(QPoint point) const {
	for (auto i = int(_areas.size()) - 1; i >= 0; --i) {
		if (_areas[i].rect.contains(point)) {
			return i;
		}
	}
	return -1;
}

void Canvas::mouseMoveEvent(QMouseEvent *e) {
	_mouse = e->pos();
	if (_pressAt && !_pressDrag.isEmpty()
		&& (e->pos() - *_pressAt).manhattanLength() > kDragDistance) {
		_dragging = true;
	}
	update();
}

void Canvas::mousePressEvent(QMouseEvent *e) {
	if (e->button() != Qt::LeftButton) {
		return;
	}
	_pressAt = e->pos();
	const auto index = areaAt(e->pos());
	_pressDrag = (index >= 0) ? _areas[index].drag : QString();
	_dragging = false;
}

void Canvas::mouseReleaseEvent(QMouseEvent *e) {
	if (e->button() != Qt::LeftButton || !_pressAt) {
		return;
	}
	const auto pressAt = *_pressAt;
	_pressAt.reset();
	if (_dragging) {
		_dragging = false;
		const auto key = base::take(_pressDrag);
		dropped(key, e->pos());
		return;
	}
	_pressDrag = QString();
	const auto index = areaAt(e->pos());
	if (index < 0 || areaAt(pressAt) != index) {
		return;
	}
	if (const auto callback = _areas[index].click) {
		callback();
	}
}

void Canvas::mouseDoubleClickEvent(QMouseEvent *e) {
	const auto index = areaAt(e->pos());
	if (index >= 0) {
		if (const auto callback = _areas[index].doubleClick) {
			callback();
			return;
		}
	}
	mousePressEvent(e);
}

void Canvas::leaveEventHook(QEvent *e) {
	_mouse.reset();
	update();
}

// ── рисование ────────────────────────────────────────────────────────────────

int DrawElided(QPainter *p, const style::font &font, QColor color, int x, int baseline, const QString &text, int maxWidth) {
	if (maxWidth <= 0 || text.isEmpty()) {
		return 0;
	}
	const auto shown = (font->width(text) > maxWidth) ? font->elided(text, maxWidth) : text;
	if (p) {
		p->setFont(font);
		p->setPen(color);
		p->drawText(x, baseline, shown);
	}
	return font->width(shown);
}

int DrawWrapped(QPainter *p, const style::font &font, QColor color, QRect rect, const QString &text, int maxLines,
		int lineHeight) {
	const auto line = lineHeight ? lineHeight : font->height;
	if (text.isEmpty() || rect.width() <= 0) {
		return 0;
	}
	// Перенос по словам; слово шире строки режется
	auto lines = QStringList();
	const auto words = text.split(u' ');
	auto current = QString();
	for (const auto &word : words) {
		const auto candidate = current.isEmpty() ? word : (current + u' ' + word);
		if (font->width(candidate) <= rect.width() || current.isEmpty()) {
			current = candidate;
		} else {
			lines.push_back(current);
			current = word;
		}
	}
	if (!current.isEmpty()) {
		lines.push_back(current);
	}
	auto shown = int(lines.size());
	if (maxLines > 0 && shown > maxLines) {
		shown = maxLines;
		auto tail = QStringList(lines.mid(maxLines - 1)).join(u' ');
		lines[maxLines - 1] = font->elided(tail, rect.width());
	}
	if (p) {
		p->setFont(font);
		p->setPen(color);
		for (auto i = 0; i != shown; ++i) {
			const auto top = rect.y() + i * line + (line - font->height) / 2;
			p->drawText(rect.x(), top + font->ascent, font->elided(lines[i], rect.width()));
		}
	}
	return shown * line;
}

int DrawCaps(QPainter *p, int px, QColor color, int x, int baseline, const QString &text, int maxWidth,
		bool semibold) {
	auto font = QFont(Kit::Font(px, semibold, true)->f);
	font.setLetterSpacing(QFont::AbsoluteSpacing, Kit::Px(px) * 0.06);
	const auto metrics = QFontMetrics(font);
	const auto upper = text.toUpper();
	const auto shown = metrics.horizontalAdvance(upper) > maxWidth
		? metrics.elidedText(upper, Qt::ElideRight, maxWidth)
		: upper;
	if (p) {
		p->setFont(font);
		p->setPen(color);
		p->drawText(x, baseline, shown);
	}
	return metrics.horizontalAdvance(shown);
}

namespace {

int TagFontPx(const TagLook &look) {
	return look.large ? 13 : 12;
}

QMargins TagPadding(const TagLook &look) {
	return look.large
		? QMargins(Kit::Px(10), Kit::Px(4), Kit::Px(10), Kit::Px(4))
		: QMargins(Kit::Px(6), Kit::Px(1), Kit::Px(6), Kit::Px(1));
}

} // namespace

QSize TagSize(const TagLook &look, const QString &text, int maxWidth) {
	const auto font = Kit::Font(TagFontPx(look));
	const auto padding = TagPadding(look);
	const auto icon = look.icon.isEmpty() ? 0 : (Kit::Px(13) + Kit::Px(4));
	auto width = padding.left() + icon + font->width(text) + padding.right();
	if (maxWidth > 0) {
		width = std::min(width, maxWidth);
	}
	return QSize(width, padding.top() + Kit::Px(18) + padding.bottom());
}

void DrawTag(QPainter &p, QRect rect, const TagLook &look, const QString &text, bool hovered) {
	const auto font = Kit::Font(TagFontPx(look));
	const auto padding = TagPadding(look);
	const auto radius = look.large ? Kit::Px(14) : Kit::Px(5);
	p.save();
	if (look.done) {
		p.setOpacity(0.6);
	}
	p.setPen(Qt::NoPen);
	p.setBrush(Kit::Mix(look.color, hovered ? 0.30 : look.share));
	p.drawRoundedRect(rect, std::min(radius, rect.height() / 2), std::min(radius, rect.height() / 2));
	auto x = rect.x() + padding.left();
	if (!look.icon.isEmpty()) {
		const auto size = Kit::Px(13);
		PaintPlannerIcon(p, look.icon, look.color, x, rect.y() + (rect.height() - size) / 2, size);
		x += size + Kit::Px(4);
	}
	const auto baseline = rect.y() + (rect.height() - font->height) / 2 + font->ascent;
	DrawElided(&p, font, look.color, x, baseline, text, rect.x() + rect.width() - padding.right() - x);
	p.restore();
}

int DrawName(QPainter *p, const NameLook &look, int x, int baseline, int maxWidth, const std::string &name,
		const Fn<void(QRect, std::string)> &linkArea, bool onlyLinks) {
	auto used = 0;
	const auto parts = planner::splitNameLinks(name);
	const auto &font = look.font;
	for (const auto &part : parts) {
		if (onlyLinks && !part.note) {
			continue;
		}
		if (onlyLinks && used > 0) {
			used += font->spacew;
		}
		const auto text = Q(part.text);
		const auto left = maxWidth - used;
		if (left <= 0) {
			break;
		}
		const auto color = part.note ? ToneColor(Tone::Purple) : look.color;
		const auto width = DrawElided(p, font, color, x + used, baseline, text, left);
		if (p && look.strike) {
			p->setPen(QPen(color, 1));
			const auto y = baseline - font->ascent / 3;
			p->drawLine(x + used, y, x + used + width, y);
		}
		if (part.note && linkArea) {
			linkArea(QRect(x + used, baseline - font->ascent, width, font->height), *part.note);
		}
		used += width;
		if (font->width(text) > left) {
			break;
		}
	}
	return used;
}

namespace {

QStringList OwnIconPaths(const QString &name) {
	static const auto paths = QHash<QString, QStringList>{
		{ u"previous"_q, { u"M15 6l-6 6 6 6"_q } },
		{ u"next"_q, { u"M9 6l6 6-6 6"_q } },
		{ u"close"_q, { u"M6 6l12 12M18 6L6 18"_q } },
		{ u"flag"_q, { u"M5 21V4"_q, u"M5 4h12l-2 4 2 4H5"_q } },
		{ u"loop"_q, {
			u"M17 2l3 3-3 3"_q,
			u"M4 11V9a4 4 0 0 1 4-4h12"_q,
			u"M7 22l-3-3 3-3"_q,
			u"M20 13v2a4 4 0 0 1-4 4H4"_q,
		} },
		{ u"darkmode"_q, { u"M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"_q } },
		{ u"eats"_q, { u"M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10"_q, u"M17 3c-2 2-2 6 0 8v10"_q } },
		{ u"clock"_q, { u"M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z"_q, u"M12 7v5l3 2"_q } },
		{ u"archive"_q, { u"M3 5h18v4H3z"_q, u"M5 9v10h14V9"_q, u"M10 13h4"_q } },
		{ u"sport"_q, { u"M6 8v8M3 10v4M18 8v8M21 10v4M6 12h12"_q } },
		{ u"down"_q, { u"M6 9l6 6 6-6"_q } },
		{ u"up"_q, { u"M6 15l6-6 6 6"_q } },
	};
	return paths.value(name);
}

QString IconAlias(const QString &name) {
	if (name == u"add"_q) {
		return u"plus"_q;
	} else if (name == u"settings"_q) {
		return u"sliders"_q;
	} else if (name == u"edit"_q) {
		return u"pen"_q;
	} else if (name == u"heart-outline"_q) {
		return u"heart"_q;
	}
	return name;
}

} // namespace

void PaintPlannerIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size) {
	const auto alias = IconAlias(name);
	if (HasIcon(alias)) {
		PaintIcon(p, alias, color, x, y, size);
		return;
	}
	const auto paths = OwnIconPaths(name);
	if (paths.isEmpty()) {
		return;
	}
	static auto cache = QHash<QString, QImage>();
	const auto ratio = style::DevicePixelRatio();
	const auto key = name + u'/' + QString::number(color.rgba(), 16) + u'/' + QString::number(size)
		+ u'/' + QString::number(ratio);
	auto i = cache.find(key);
	if (i == cache.end()) {
		auto svg = QByteArray(
			"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"");
		svg += color.name(QColor::HexRgb).toLatin1();
		svg += "\" stroke-opacity=\"" + QByteArray::number(color.alphaF(), 'f', 3);
		svg += "\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">";
		for (const auto &d : paths) {
			svg += "<path d=\"" + d.toLatin1() + "\"/>";
		}
		svg += "</svg>";
		auto image = QImage(QSize(size, size) * ratio, QImage::Format_ARGB32_Premultiplied);
		image.fill(Qt::transparent);
		{
			auto renderer = QSvgRenderer(svg);
			auto q = QPainter(&image);
			renderer.render(&q, QRectF(0, 0, size * ratio, size * ratio));
		}
		image.setDevicePixelRatio(ratio);
		i = cache.insert(key, image);
	}
	p.drawImage(x, y, *i);
}

IconBtn::IconBtn(QWidget *parent, const QString &icon, const QString &accessibleName, bool accent)
: Button(parent)
, _icon(icon)
, _accent(accent) {
	setAccessibleName(accessibleName);
	const auto side = Kit::Rem(2.25);
	resize(side, side);
	Kit::RepaintOnTones(this);
}

void IconBtn::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto r = QRectF(rect());
	const auto over = isOver() || isDown();
	if (_accent || over) {
		p.setPen(Qt::NoPen);
		p.setBrush(_accent ? ToneColor(Tone::Accent) : ToneColor(Tone::Hover));
		p.drawEllipse(r);
	}
	const auto color = _accent
		? ToneColor(Tone::AccentInk)
		: over ? ToneColor(Tone::Fg) : ToneColor(Tone::Muted);
	const auto size = Kit::Px(22); // font-size: 1.375rem
	PaintPlannerIcon(p, _icon, color, (width() - size) / 2, (height() - size) / 2, size);
	if (focusVisible()) {
		paintFocusRing(p, r, r.height() / 2.);
	}
}

void DrawCheck(QPainter &p, QRect rect, bool checked, QColor tone, bool hovered) {
	PainterHighQualityEnabler hq(p);
	const auto border = Kit::Px(2);
	const auto inner = QRectF(rect).adjusted(border / 2., border / 2., -border / 2., -border / 2.);
	if (checked) {
		p.setPen(QPen(tone, border));
		p.setBrush(tone);
		p.drawEllipse(inner);
		auto pen = QPen(ToneColor(Tone::AccentInk), border);
		pen.setCapStyle(Qt::RoundCap);
		pen.setJoinStyle(Qt::RoundJoin);
		p.setPen(pen);
		const auto w = rect.width();
		const auto path = QPolygonF{
			QPointF(rect.x() + w * 0.28, rect.y() + w * 0.52),
			QPointF(rect.x() + w * 0.44, rect.y() + w * 0.67),
			QPointF(rect.x() + w * 0.72, rect.y() + w * 0.36),
		};
		p.setBrush(Qt::NoBrush);
		p.drawPolyline(path);
	} else {
		p.setPen(QPen(hovered ? ToneColor(Tone::Muted) : ToneColor(Tone::Line2), border));
		p.setBrush(Qt::NoBrush);
		p.drawEllipse(inner);
	}
}

void ToggleTaskDone(const planner::Task &task, bool done) {
	const auto name = Q(task.name);
	Sections::UpdatePlanner([task, done](planner::State &state) {
		planner::setTaskDone(state, task, done);
	}, done
		? tr::lng_parvane_planner_notice_done(tr::now, lt_name, name)
		: tr::lng_parvane_planner_notice_reopened(tr::now, lt_name, name));
}

} // namespace Parvane::PlannerViews
