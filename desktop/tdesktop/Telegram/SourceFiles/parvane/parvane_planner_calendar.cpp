// Parvane fork: реализация parvane_planner_calendar.h — неделя, месяц, год. Размеры — из web Planner.module.scss
// (`.week*`, `.month*`, `.year*`), в комментариях — rem.
#include "parvane/parvane_planner_calendar.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/scroll_area.h"

#include <parvane/sections/planner_health.h>
#include <parvane/sections/planner_links.h>

#include <QtCore/QTimer>

namespace Parvane::PlannerViews {
namespace {

constexpr auto kMinutesInHour = 60;
constexpr auto kHoursInDay = 24;
constexpr auto kAllDayFill = 0.14;
constexpr auto kScrollLeadHours = 0.3;
constexpr auto kNowLeadHours = 2;
constexpr auto kCreateStep = 30;
constexpr auto kCreateMinutes = 60;
constexpr auto kPreviewCount = 2;
constexpr auto kMaxLoadTint = 85;

// Заливка событий на весь день: несколько событий делят ширину поровну
void PaintAllDayFill(QPainter &p, QRect rect, const planner::State &state, const std::vector<planner::Event> &events) {
	if (events.empty()) {
		return;
	}
	const auto share = double(rect.width()) / events.size();
	for (auto i = 0; i != int(events.size()); ++i) {
		const auto &event = events[i];
		const auto list = ListColor(planner::getEventColor(state, event));
		const auto color = list.isValid()
			? list
			: KindColor(event.isHoliday.value_or(false) ? Kind::Due : Kind::Event);
		const auto left = rect.x() + int(std::round(i * share));
		const auto right = rect.x() + int(std::round((i + 1) * share));
		p.fillRect(QRect(left, rect.y(), right - left, rect.height()), Kit::Mix(color, kAllDayFill));
	}
}

} // namespace

// ── неделя ───────────────────────────────────────────────────────────────────

struct WeekView::Column {
	std::string day;
	std::vector<planner::TimedLayout> layout;
	std::vector<planner::Event> allDay;
	std::vector<planner::Task> untimed;
	std::vector<planner::Task> deadlines;
	std::vector<planner::FoodEntry> meals;
	long long kcal = 0;
	std::optional<planner::HealthRecord> sleep;
	std::optional<int> wake;
	std::optional<int> bedtime;
	bool isShort = false;
	bool isHoliday = false;
	int load = 0;
	double budget = 0;
};

struct WeekView::Grid {
	ViewPtr view;
	std::string picked;
	std::string today;
	planner::Layers layers;
	std::vector<Column> columns;
	int firstHour = 0;
	int hours = 0;
	int gridStart = 0;
	int gridMinutes = 0;
	int dayStart = 0;
	int dayEnd = 0;

	[[nodiscard]] int hourPx() const {
		return Kit::Rem(3); // `--planner-hour` 3rem
	}
	[[nodiscard]] double offset(double minutes) const {
		return (std::clamp(minutes - gridStart, 0., double(gridMinutes)) / kMinutesInHour) * hourPx();
	}
	[[nodiscard]] int hoursWidth() const {
		return Kit::Rem(3.25);
	}
	[[nodiscard]] QRect columnRect(int index, int width, int top, int height) const {
		const auto count = std::max(int(columns.size()), 1);
		const auto available = std::max(width - hoursWidth(), 0);
		const auto left = hoursWidth() + (available * index) / count;
		const auto right = hoursWidth() + (available * (index + 1)) / count;
		return QRect(left, top, right - left, height);
	}
};

// Шапки дней и строка «весь день» (`.weekHead`)
class WeekView::Head final : public PlannerCanvas {
public:
	Head(QWidget *parent, Actions actions, std::shared_ptr<Grid> grid)
	: PlannerCanvas(parent, std::move(actions))
	, _grid(std::move(grid)) {
	}

protected:
	int draw(QPainter *p, int width) override;

private:
	const std::shared_ptr<Grid> _grid;

};

int WeekView::Head::draw(QPainter *p, int width) {
	const auto &grid = *_grid;
	if (!grid.view || grid.columns.empty()) {
		return 0;
	}
	const auto &state = grid.view->state;
	const auto nameFont = Kit::Font(12);
	const auto numberFont = Kit::Font(18, true, true);
	const auto loadFont = Kit::Font(11, false, true);
	const auto pad = Kit::Rem(0.5);
	const auto progHeight = Kit::Rem(0.25);
	const auto dayHeight = pad + nameFont->height + numberFont->height + Kit::Rem(0.375) + progHeight + Kit::Rem(0.375);
	const auto line = ToneColor(Tone::Line);
	const auto muted = ToneColor(Tone::Muted);
	const auto actions = _actions;

	// Шапки дней
	for (auto i = 0; i != int(grid.columns.size()); ++i) {
		const auto &column = grid.columns[i];
		const auto rect = grid.columnRect(i, width, 0, dayHeight);
		if (p) {
			if (over(rect)) {
				p->fillRect(rect, ToneColor(Tone::Hover));
			}
			p->fillRect(QRect(rect.x(), rect.y(), 1, rect.height()), line);
			const auto date = DateOf(column.day);
			const auto inner = rect.marginsRemoved({ pad, pad, pad, Kit::Rem(0.375) });
			auto name = FormatWeekday(MondayIndex(column.day)).toUpper();
			DrawElided(p, nameFont, column.isHoliday ? ToneColor(Tone::Red) : muted, inner.x(),
				inner.y() + nameFont->ascent, name, inner.width());
			const auto rowTop = inner.y() + nameFont->height;
			const auto number = QString::number(date.day());
			const auto numberWidth = DrawElided(p, numberFont,
				column.day == grid.today ? ToneColor(Tone::Accent) : ToneColor(Tone::Fg), inner.x(),
				rowTop + numberFont->ascent, number, inner.width());
			const auto isOver = column.load > column.budget;
			const auto load = FormatHoursNumber(column.load) + u'/' + FormatHours(column.budget);
			const auto loadWidth = std::min(loadFont->width(load), std::max(inner.width() - numberWidth - Kit::Rem(0.5), 0));
			DrawElided(p, loadFont, isOver ? ToneColor(Tone::Red) : muted, inner.right() + 1 - loadWidth,
				rowTop + numberFont->ascent, load, loadWidth);
			const auto prog = QRect(inner.x(), rowTop + numberFont->height + Kit::Rem(0.375), inner.width(), progHeight);
			p->setPen(Qt::NoPen);
			p->setBrush(ToneColor(Tone::Line));
			p->drawRoundedRect(prog, progHeight / 2., progHeight / 2.);
			const auto fraction = column.budget > 0 ? std::min(1., column.load / column.budget) : 0.;
			if (fraction > 0) {
				p->setBrush(KindColor(isOver ? Kind::Due : Kind::Event));
				p->drawRoundedRect(QRect(prog.x(), prog.y(), int(prog.width() * fraction), progHeight),
					progHeight / 2., progHeight / 2.);
			}
			if (column.day == grid.picked) {
				p->fillRect(QRect(rect.x(), rect.bottom() - Kit::Px(2) + 1, rect.width(), Kit::Px(2)),
					ToneColor(Tone::Accent));
			}
		}
		area(rect, [actions, day = column.day] {
			if (actions.pickDay) {
				actions.pickDay(day);
			}
		});
	}

	// Строка «весь день»: сон, калории, события на весь день, задачи без времени, сроки
	const auto cellPad = Kit::Rem(0.25);
	const auto gap = Kit::Rem(0.1875);
	struct Item {
		QString text;
		TagLook look;
		Fn<void()> click;
		std::string name; // название с ссылками
	};
	auto rowHeight = Kit::Rem(1.75);
	auto items = std::vector<std::vector<Item>>(grid.columns.size());
	for (auto i = 0; i != int(grid.columns.size()); ++i) {
		const auto &column = grid.columns[i];
		auto &list = items[i];
		if (column.sleep) {
			list.push_back({ FormatSpan(column.sleep->value),
				TagLook{ .color = KindColor(column.isShort ? Kind::Due : Kind::Sleep), .icon = u"darkmode"_q },
				[actions, day = column.day] {
					if (actions.openSleep) {
						actions.openSleep(day);
					}
				} });
		}
		if (column.kcal) {
			list.push_back({ FormatInt(column.kcal), TagLook{ .color = KindColor(Kind::Food), .icon = u"eats"_q } });
		}
		for (const auto &event : column.allDay) {
			const auto holiday = event.isHoliday.value_or(false);
			list.push_back({ PlainName(event.name),
				TagLook{
					.color = EntryColor(planner::getEventColor(state, event), holiday ? Kind::Due : Kind::Event),
					.icon = holiday ? u"star"_q : QString(),
				},
				[actions, id = event.id, day = column.day] {
					if (actions.openEvent) {
						actions.openEvent(id, day);
					}
				}, event.name });
		}
		for (const auto &task : column.untimed) {
			const auto done = (task.status == "done");
			list.push_back({ PlainName(task.name),
				TagLook{
					.color = EntryColor(planner::getListColor(state, task.project), Kind::Task),
					.done = done,
					.icon = done ? u"check"_q : QString(),
				},
				[actions, id = task.id, day = column.day] {
					if (actions.openTask) {
						actions.openTask(id, day);
					}
				}, task.name });
		}
		for (const auto &task : column.deadlines) {
			list.push_back({ tr::lng_parvane_planner_deadline_preview(tr::now, lt_name, PlainName(task.name)),
				TagLook{ .color = KindColor(Kind::Due), .icon = u"flag"_q },
				[actions, id = task.id] {
					if (actions.openTask) {
						actions.openTask(id, std::string());
					}
				} });
		}
		auto height = cellPad * 2;
		for (auto k = 0; k != int(list.size()); ++k) {
			height += TagSize(list[k].look, list[k].text).height() + (k ? gap : 0);
		}
		rowHeight = std::max(rowHeight, height);
	}
	const auto top = dayHeight;
	if (p) {
		const auto labelFont = Kit::Font(11);
		p->fillRect(QRect(0, top, width, 1), line);
		const auto label = tr::lng_parvane_planner_all_day_short(tr::now);
		const auto labelWidth = std::min(labelFont->width(label), grid.hoursWidth() - Kit::Rem(0.5));
		DrawElided(p, labelFont, muted, grid.hoursWidth() - Kit::Rem(0.5) - labelWidth,
			top + Kit::Rem(0.375) + labelFont->ascent, label, labelWidth);
	}
	for (auto i = 0; i != int(grid.columns.size()); ++i) {
		const auto &column = grid.columns[i];
		const auto rect = grid.columnRect(i, width, top, rowHeight);
		if (p) {
			if (!column.allDay.empty()) {
				PaintAllDayFill(*p, rect, state, column.allDay);
			} else if (column.sleep && column.wake && *column.wake > grid.gridStart) {
				p->fillRect(rect, Kit::Mix(Tone::Aqua, 0.10));
			}
			p->fillRect(QRect(rect.x(), rect.y(), rect.width(), 1), line);
			p->fillRect(QRect(rect.x(), rect.y(), 1, rect.height()), line);
		}
		auto y = rect.y() + cellPad;
		const auto innerWidth = std::max(rect.width() - 2 * cellPad, 0);
		for (const auto &item : items[i]) {
			const auto size = TagSize(item.look, item.text);
			const auto tag = QRect(rect.x() + cellPad, y, innerWidth, size.height());
			if (p) {
				DrawTag(*p, tag, item.look, item.text, item.click && over(tag));
			}
			if (item.click) {
				area(tag, item.click);
			}
			y += size.height() + gap;
		}
	}
	return top + rowHeight;
}

// Сетка часов (`.weekGrid`)
class WeekView::Hours final : public PlannerCanvas {
public:
	Hours(QWidget *parent, Actions actions, std::shared_ptr<Grid> grid)
	: PlannerCanvas(parent, std::move(actions))
	, _grid(std::move(grid)) {
		const auto timer = new QTimer(this);
		timer->setInterval(60 * 1000);
		QObject::connect(timer, &QTimer::timeout, [=] { update(); });
		timer->start();
	}

protected:
	int draw(QPainter *p, int width) override;

private:
	const std::shared_ptr<Grid> _grid;

};

int WeekView::Hours::draw(QPainter *p, int width) {
	const auto &grid = *_grid;
	if (!grid.view || grid.columns.empty()) {
		return 0;
	}
	const auto &state = grid.view->state;
	const auto hourPx = grid.hourPx();
	const auto height = grid.hours * hourPx;
	if (!p) {
		return height;
	}
	const auto line = ToneColor(Tone::Line);
	const auto actions = _actions;
	const auto offset = [&](double minutes) {
		return int(std::round(grid.offset(minutes)));
	};

	// Подписи часов (первая скрыта — её обрезал бы край сетки)
	const auto hourFont = Kit::Font(11, false, true);
	for (auto i = 1; i < grid.hours; ++i) {
		const auto label = Q(planner::toTime((grid.firstHour + i) * kMinutesInHour));
		const auto labelWidth = hourFont->width(label);
		DrawElided(p, hourFont, ToneColor(Tone::Faint), grid.hoursWidth() - Kit::Rem(0.5) - labelWidth,
			i * hourPx - hourFont->height / 2 + hourFont->ascent, label, labelWidth);
	}

	const auto nameFont = Kit::Font(13, true);
	const auto timeFont = Kit::Font(11, false, true);
	const auto noteFont = Kit::Font(11);
	const auto nowMinutes = NowMinutes();
	for (auto i = 0; i != int(grid.columns.size()); ++i) {
		const auto &column = grid.columns[i];
		const auto rect = grid.columnRect(i, width, 0, height);
		const auto day = column.day;
		// Нажатие на свободное время: новое дело с этого получаса на час
		const auto gridStart = grid.gridStart;
		const auto gridMinutes = grid.gridMinutes;
		area(rect, [=] {
			if (!actions.createAt) {
				return;
			}
			const auto point = mouse();
			const auto y = point ? point->y() : 0;
			const auto minutes = gridStart + (double(y) / std::max(height, 1)) * gridMinutes;
			const auto start = int(std::floor(minutes / kCreateStep)) * kCreateStep;
			actions.createAt(day, std::max(0, std::min(start, gridStart + gridMinutes - kCreateMinutes)));
		});
		if (column.day == grid.today) {
			p->fillRect(rect, Kit::Mix(Tone::Accent, 0.04));
		}
		for (auto h = 1; h <= grid.hours; ++h) {
			p->fillRect(QRect(rect.x(), h * hourPx - 1, rect.width(), 1), line);
		}
		p->fillRect(QRect(rect.x(), 0, 1, height), line);
		if (!column.allDay.empty()) {
			PaintAllDayFill(*p, rect, state, column.allDay);
		}
		// Время вне дня не затемняется там, где день залит событием или сном
		const auto off = Kit::Mix(Tone::Bg, 0.35);
		const auto offTop = (column.wake && *column.wake > grid.gridStart) ? offset(*column.wake) : 0;
		if (column.allDay.empty() && offTop < offset(grid.dayStart)) {
			p->fillRect(QRect(rect.x(), offTop, rect.width(), offset(grid.dayStart) - offTop), off);
		}
		if (column.allDay.empty() && (!column.bedtime || *column.bedtime > grid.dayEnd)) {
			const auto bottom = column.bedtime ? offset(*column.bedtime) : height;
			p->fillRect(QRect(rect.x(), offset(grid.dayEnd), rect.width(), std::max(bottom - offset(grid.dayEnd), 0)), off);
		}
		const auto sleepFill = Kit::Mix(Tone::Aqua, 0.10);
		auto dashed = QPen(Kit::Mix(Tone::Aqua, 0.5), 1, Qt::DashLine);
		if (column.wake && *column.wake > grid.gridStart) {
			const auto bottom = offset(*column.wake);
			p->fillRect(QRect(rect.x(), 0, rect.width(), bottom), sleepFill);
			p->setPen(dashed);
			p->drawLine(rect.x(), bottom, rect.right(), bottom);
		}
		if (column.bedtime) {
			const auto top = offset(*column.bedtime);
			p->fillRect(QRect(rect.x(), top, rect.width(), height - top), sleepFill);
			p->setPen(dashed);
			p->drawLine(rect.x(), top, rect.right(), top);
		}

		// Блоки дел: колонки пересечения, блок тянется вправо до чужого заголовка (`layoutTimed`)
		for (const auto &item : column.layout) {
			const auto start = planner::toMinutes(item.item.start);
			const auto end = planner::toMinutes(item.item.end);
			const auto top = int(std::round(double(start - grid.gridStart) / kMinutesInHour * hourPx));
			const auto blockHeight = std::max(Kit::Rem(1.5), int(std::round(double(end - start) / kMinutesInHour * hourPx)));
			const auto lanes = std::max(item.lanes, 1);
			const auto left = rect.x() + (rect.width() * item.lane) / lanes;
			const auto right = rect.x() + (rect.width() * item.right) / lanes;
			const auto block = QRect(left, top + 1, right - left, blockHeight - 1);
			const auto isTask = item.item.task.has_value();
			const auto done = isTask && item.item.task->status == "done";
			const auto color = isTask
				? EntryColor(planner::getListColor(state, item.item.task->project), Kind::Task)
				: EntryColor(planner::getEventColor(state, *item.item.event), Kind::Event);
			const auto hovered = over(block);
			p->save();
			if (done) {
				p->setOpacity(0.55);
			}
			p->setPen(QPen(ToneColor(Tone::Panel), 1));
			p->setBrush(MixOver(color, hovered ? 0.32 : 0.20, ToneColor(Tone::Panel)));
			p->drawRoundedRect(QRectF(block).adjusted(0.5, 0.5, -0.5, -0.5), Kit::Rem(0.375), Kit::Rem(0.375));
			p->setPen(Qt::NoPen);
			p->setBrush(color);
			p->drawRoundedRect(QRect(block.x(), block.y(), Kit::Rem(0.1875) + Kit::Px(2), block.height()),
				Kit::Px(2), Kit::Px(2));
			p->setClipRect(block.adjusted(Kit::Rem(0.1875), 0, 0, 0));
			const auto textLeft = block.x() + Kit::Rem(0.1875) + Kit::Rem(0.4375);
			const auto textWidth = std::max(block.right() - Kit::Rem(0.4375) - textLeft, 0);
			auto y = block.y() + Kit::Rem(0.1875);
			const auto nameLine = Kit::Px(17);
			DrawName(p, { nameFont, ToneColor(Tone::Fg), done }, textLeft, y + (nameLine - nameFont->height) / 2
				+ nameFont->ascent, textWidth, item.item.name, nullptr);
			y += nameLine;
			const auto time = Q(item.item.start) + QChar(0x2013) + Q(item.item.end);
			if (y + timeFont->height <= block.bottom() + timeFont->height / 2) {
				DrawElided(p, timeFont, ToneColor(Tone::Muted), textLeft, y + timeFont->ascent, time, textWidth);
			}
			y += timeFont->height;
			const auto note = Q(planner::formatDescriptionLine(isTask
				? std::optional<std::string>(item.item.task->description)
				: item.item.event->description));
			if (!note.isEmpty() && y + noteFont->height <= block.bottom()) {
				DrawElided(p, noteFont, ToneColor(Tone::Muted), textLeft, y + noteFont->ascent, note, textWidth);
			}
			p->restore();
			if (isTask) {
				area(block, [actions, id = item.item.task->id, day] {
					if (actions.openTask) {
						actions.openTask(id, day);
					}
				});
			} else {
				area(block, [actions, id = item.item.event->id, day] {
					if (actions.openEvent) {
						actions.openEvent(id, day);
					}
				});
			}
		}

		// Отметки приёмов пищи
		const auto mealFont = Kit::Font(11, false, true);
		for (const auto &meal : column.meals) {
			const auto value = FormatInt(std::llround(meal.kcal));
			const auto icon = Kit::Px(12);
			const auto pillWidth = Kit::Rem(0.4375) * 2 + icon + Kit::Rem(0.1875) + mealFont->width(value);
			const auto pillHeight = Kit::Rem(1.25);
			const auto center = offset(planner::toMinutes(*meal.time));
			const auto pill = QRect(rect.right() - Kit::Rem(0.1875) - pillWidth, center - pillHeight / 2, pillWidth,
				pillHeight);
			p->setPen(Qt::NoPen);
			p->setBrush(ToneColor(Tone::Orange));
			p->drawRoundedRect(pill, pillHeight / 2., pillHeight / 2.);
			PaintPlannerIcon(*p, u"eats"_q, ToneColor(Tone::AccentInk), pill.x() + Kit::Rem(0.4375),
				pill.y() + (pillHeight - icon) / 2, icon);
			DrawElided(p, mealFont, ToneColor(Tone::AccentInk), pill.x() + Kit::Rem(0.4375) + icon + Kit::Rem(0.1875),
				pill.y() + (pillHeight - mealFont->height) / 2 + mealFont->ascent, value, mealFont->width(value));
		}

		// Черта «сейчас»
		if (column.day == grid.today && nowMinutes >= grid.gridStart && nowMinutes <= grid.gridStart + grid.gridMinutes) {
			const auto y = offset(nowMinutes);
			p->setPen(Qt::NoPen);
			p->setBrush(ToneColor(Tone::Red));
			p->drawRect(QRect(rect.x(), y, rect.width(), Kit::Px(2)));
			const auto dot = Kit::Rem(0.5);
			p->drawEllipse(QRect(rect.x() - Kit::Rem(0.25), y - Kit::Rem(0.1875), dot, dot));
		}
	}
	return height;
}

WeekView::WeekView(QWidget *parent, Actions actions)
: RpWidget(parent)
, _actions(std::move(actions))
, _grid(std::make_shared<Grid>()) {
	_head = Ui::CreateChild<Head>(this, _actions, _grid);
	_scroll = Ui::CreateChild<Ui::ScrollArea>(this);
	_hours = _scroll->setOwnedWidget(object_ptr<Hours>(_scroll, _actions, _grid)).data();
	Kit::RepaintOnTones(this);
}

void WeekView::setData(ViewPtr view, std::string picked, std::string today, planner::Layers layers) {
	auto &grid = *_grid;
	const auto &state = view->state;
	const auto days = planner::getWeekKeys(picked);
	const auto index = planner::getDayRange(state, days.front(), days.back());
	grid.view = view;
	grid.picked = picked;
	grid.today = today;
	grid.layers = layers;
	grid.columns.clear();
	grid.dayStart = state.settings.dayStart;
	grid.dayEnd = state.settings.dayEnd;
	auto starts = std::vector<int>{ grid.dayStart - kMinutesInHour };
	auto ends = std::vector<int>{ grid.dayEnd + kMinutesInHour };
	for (const auto &day : days) {
		auto column = Column();
		column.day = day;
		const auto i = index.find(day);
		const auto entry = (i != index.end()) ? i->second : planner::DayIndexEntry();
		if (layers.sleep) {
			column.sleep = planner::getDailyRecord(state, "sleep", day);
			const auto next = planner::getDailyRecord(state, "sleep", planner::addDays(day, 1));
			// Лёг до полуночи — вечер этого дня тоже сон
			if (next && next->time && next->endTime && *next->time > *next->endTime) {
				column.bedtime = planner::toMinutes(*next->time);
			}
		}
		if (layers.work) {
			column.layout = planner::layoutTimed(entry.timed);
			column.allDay = entry.allDay;
			column.untimed = entry.untimed;
			column.deadlines = entry.deadlines;
		}
		if (layers.food) {
			if (const auto n = state.nutrition.find(day); n != state.nutrition.end()) {
				for (const auto &meal : n->second.entries) {
					if (meal.time && !meal.time->empty()) {
						column.meals.push_back(meal);
					}
				}
			}
			column.kcal = std::llround(planner::getNutrientTotal(state, day, "kcal").value);
		}
		if (column.sleep && column.sleep->endTime && !column.sleep->endTime->empty()) {
			column.wake = planner::toMinutes(*column.sleep->endTime);
		}
		column.isShort = planner::isShortSleep(state, day);
		column.isHoliday = entry.isHoliday;
		column.load = entry.minutes;
		column.budget = planner::getDayBudget(state, day);
		// Сетка начинается за час до начала дня и покрывает всё, что выходит за окна дня
		for (const auto &item : column.layout) {
			starts.push_back(planner::toMinutes(item.item.start));
			ends.push_back(planner::toMinutes(item.item.end));
		}
		for (const auto &meal : column.meals) {
			starts.push_back(planner::toMinutes(*meal.time));
			ends.push_back(planner::toMinutes(*meal.time) + kMinutesInHour);
		}
		if (column.wake) {
			starts.push_back(*column.wake - kMinutesInHour);
		}
		if (column.bedtime) {
			ends.push_back(planner::kMinutesInDay);
		}
		grid.columns.push_back(std::move(column));
	}
	const auto minStart = *std::min_element(starts.begin(), starts.end());
	const auto maxEnd = *std::max_element(ends.begin(), ends.end());
	grid.firstHour = std::max(0, int(std::floor(double(minStart) / kMinutesInHour)));
	const auto lastHour = std::min(kHoursInDay, int(std::ceil(double(maxEnd) / kMinutesInHour)));
	grid.hours = std::max(lastHour - grid.firstHour, 1);
	grid.gridStart = grid.firstHour * kMinutesInHour;
	grid.gridMinutes = grid.hours * kMinutesInHour;

	const auto weekChanged = (days.front() != _firstDay);
	_firstDay = days.front();
	relayout();
	_head->refresh();
	_hours->refresh();
	if (weekChanged) {
		scrollToStart();
	}
}

void WeekView::scrollToStart() {
	// Неделя открывается на начале дня, а текущая — за пару часов до «сейчас»
	const auto &grid = *_grid;
	const auto hasToday = std::any_of(grid.columns.begin(), grid.columns.end(), [&](const Column &column) {
		return column.day == grid.today;
	});
	const auto hour = hasToday
		? std::min(double(grid.dayStart), double(NowMinutes() - kNowLeadHours * kMinutesInHour)) / kMinutesInHour
		: double(grid.dayStart) / kMinutesInHour;
	const auto top = std::max(0., (hour - grid.firstHour - kScrollLeadHours) * grid.hourPx());
	_scroll->scrollToY(int(std::round(top)));
}

void WeekView::resizeEvent(QResizeEvent *e) {
	relayout();
}

void WeekView::relayout() {
	_head->resizeToWidth(width());
	_head->move(0, 0);
	_scroll->setGeometry(0, _head->height(), width(), std::max(height() - _head->height(), 0));
	_hours->resizeToWidth(width());
}

void WeekView::paintEvent(QPaintEvent *e) {
}

// ── месяц ────────────────────────────────────────────────────────────────────

MonthView::MonthView(QWidget *parent, Actions actions)
: PlannerCanvas(parent, std::move(actions)) {
}

void MonthView::setData(ViewPtr view, std::string picked, std::string today, planner::Layers layers) {
	_view = std::move(view);
	_picked = std::move(picked);
	_today = std::move(today);
	_layers = layers;
	refresh();
}

void MonthView::dropped(const QString &key, QPoint point) {
	for (const auto &[rect, day] : _cells) {
		if (rect.contains(point)) {
			if (_actions.moveTask) {
				_actions.moveTask(S(key), day);
			}
			return;
		}
	}
}

int MonthView::draw(QPainter *p, int width) {
	if (!_view) {
		return 0;
	}
	const auto &state = _view->state;
	const auto date = DateOf(_picked);
	const auto days = planner::getMonthGridKeys(date.year(), date.month());
	const auto index = planner::getDayRange(state, days.front(), days.back());
	const auto monthPrefix = _picked.substr(0, 7);
	const auto gap = Kit::Rem(0.375);
	const auto colWidth = std::max((width - 6 * gap) / 7, 1);
	const auto actions = _actions;
	_cells.clear();

	// Дни недели
	const auto weekdayFont = Kit::Font(12);
	for (auto i = 0; i != 7; ++i) {
		const auto x = i * (colWidth + gap);
		DrawElided(p, weekdayFont, ToneColor(Tone::Muted), x + Kit::Rem(0.375), weekdayFont->ascent,
			FormatWeekday(i).toUpper(), colWidth - Kit::Rem(0.375));
	}
	auto y = weekdayFont->height + gap;

	struct Entry {
		std::string key;
		std::string taskKey; // пусто — не задача
		QString label;
		Kind kind = Kind::Event;
		int color = 0;
		std::string order;
	};
	const auto pad = Kit::Rem(0.5);
	const auto itemLine = Kit::Px(18);
	const auto itemGap = Kit::Rem(0.1875);
	const auto numberFont = Kit::Font(Kit::kBodyPx, true, true);
	const auto hoursFont = Kit::Font(11, false, true);
	const auto itemFont = Kit::Font(12);
	const auto headHeight = std::max(numberFont->height, hoursFont->height);

	const auto rows = int(days.size()) / 7;
	for (auto row = 0; row != rows; ++row) {
		// Высота недели — по самой полной клетке, не меньше 6.5rem
		auto rowHeight = Kit::Rem(6.5);
		struct Cell {
			std::string day;
			planner::DayIndexEntry entry;
			std::vector<Entry> entries;
			std::optional<planner::HealthRecord> sleep;
			bool isShort = false;
			double budget = 0;
		};
		auto cells = std::vector<Cell>();
		for (auto col = 0; col != 7; ++col) {
			auto cell = Cell();
			cell.day = days[row * 7 + col];
			const auto i = index.find(cell.day);
			cell.entry = (i != index.end()) ? i->second : planner::DayIndexEntry();
			cell.sleep = _layers.sleep ? planner::getDailyRecord(state, "sleep", cell.day) : std::nullopt;
			cell.isShort = planner::isShortSleep(state, cell.day);
			cell.budget = planner::getDayBudget(state, cell.day);
			if (_layers.work) {
				// События на весь день — первыми, дальше дела по времени начала, сроки — в конце
				auto list = std::vector<Entry>();
				for (const auto &event : cell.entry.events) {
					const auto color = planner::getEventColor(state, event);
					list.push_back({
						"event" + planner::instanceKey(event),
						std::string(),
						PlainName(event.name),
						(event.isHoliday.value_or(false) && !color) ? Kind::Due : Kind::Event,
						color,
						event.isAllDay.value_or(false) ? std::string() : event.start,
					});
				}
				for (const auto &task : cell.entry.tasks) {
					list.push_back({
						"task" + planner::instanceKey(task),
						planner::instanceKey(task),
						PlainName(task.name),
						Kind::Task,
						planner::getListColor(state, task.project),
						task.start.value_or("00:00"),
					});
				}
				std::stable_sort(list.begin(), list.end(), [](const Entry &a, const Entry &b) {
					return a.order < b.order;
				});
				for (const auto &task : cell.entry.deadlines) {
					list.push_back({
						"due" + task.id,
						task.id,
						tr::lng_parvane_planner_deadline_preview(tr::now, lt_name, PlainName(task.name)),
						Kind::Due,
						0,
						std::string(),
					});
				}
				cell.entries = std::move(list);
			}
			const auto shown = std::min(int(cell.entries.size()), kPreviewCount)
				+ (int(cell.entries.size()) > kPreviewCount ? 1 : 0)
				+ (cell.sleep ? 1 : 0);
			rowHeight = std::max(rowHeight, pad * 2 + headHeight + shown * (itemLine + itemGap));
			cells.push_back(std::move(cell));
		}
		for (auto col = 0; col != 7; ++col) {
			const auto &cell = cells[col];
			const auto rect = QRect(col * (colWidth + gap), y, colWidth, rowHeight);
			_cells.emplace_back(rect, cell.day);
			const auto day = cell.day;
			area(rect, [actions, day] {
				if (actions.pickDay) {
					actions.pickDay(day);
				}
			}, [actions, day] {
				if (actions.createForDay) {
					actions.createForDay(day);
				}
			});
			if (!p) {
				continue;
			}
			const auto outside = (cell.day.substr(0, 7) != monthPrefix);
			p->save();
			if (outside) {
				p->setOpacity(0.4);
			}
			auto bg = over(rect) ? ToneColor(Tone::Hover) : ToneColor(Tone::Raised);
			if (cell.entry.holiday) {
				const auto list = ListColor(cell.entry.holiday->color.value_or(0));
				bg = MixOver(list.isValid() ? list : ToneColor(Tone::Red), 0.14, ToneColor(Tone::Raised));
			}
			p->setPen(Qt::NoPen);
			p->setBrush(bg);
			p->drawRoundedRect(rect, Kit::Rem(0.5), Kit::Rem(0.5));
			if (cell.day == _picked) {
				p->setPen(QPen(ToneColor(Tone::Accent), Kit::Px(2)));
				p->setBrush(Qt::NoBrush);
				p->drawRoundedRect(QRectF(rect).adjusted(-1, -1, 1, 1), Kit::Rem(0.5) + 1, Kit::Rem(0.5) + 1);
			}
			const auto inner = rect.marginsRemoved({ pad, pad, pad, pad });
			// Число (сегодня — пилюлей акцента) и занятые часы
			const auto number = QString::number(DateOf(cell.day).day());
			const auto baseline = inner.y() + (headHeight - numberFont->height) / 2 + numberFont->ascent;
			auto numberRight = inner.x();
			if (cell.day == _today) {
				const auto pill = QRect(inner.x(), inner.y(), numberFont->width(number) + Kit::Rem(0.375) * 2, headHeight);
				p->setPen(Qt::NoPen);
				p->setBrush(ToneColor(Tone::Accent));
				p->drawRoundedRect(pill, Kit::Rem(0.625), Kit::Rem(0.625));
				DrawElided(p, numberFont, ToneColor(Tone::AccentInk), pill.x() + Kit::Rem(0.375), baseline, number,
					pill.width());
				numberRight = pill.right();
			} else {
				numberRight += DrawElided(p, numberFont, ToneColor(Tone::Fg), inner.x(), baseline, number, inner.width());
			}
			if (cell.entry.minutes) {
				const auto hours = (cell.entry.conflicts ? u"! "_q : QString()) + FormatHours(cell.entry.minutes);
				const auto hoursWidth = std::min(hoursFont->width(hours),
					std::max(inner.right() - numberRight - Kit::Rem(0.375), 0));
				DrawElided(p, hoursFont, cell.entry.minutes > cell.budget ? ToneColor(Tone::Red) : ToneColor(Tone::Muted),
					inner.right() + 1 - hoursWidth, baseline, hours, hoursWidth);
			}
			auto itemTop = inner.y() + headHeight + itemGap;
			const auto drawItem = [&](const QString &label, QColor dot, QColor color, bool underline) {
				const auto dotSize = Kit::Rem(0.375);
				const auto center = itemTop + itemLine / 2;
				Kit::PaintDot(*p, QPoint(inner.x() + dotSize / 2, center), dot, dotSize);
				const auto font = underline ? itemFont->underline() : itemFont;
				DrawElided(p, font, color, inner.x() + dotSize + Kit::Rem(0.3125),
					itemTop + (itemLine - itemFont->height) / 2 + itemFont->ascent, label,
					inner.width() - dotSize - Kit::Rem(0.3125));
			};
			if (cell.sleep) {
				drawItem(tr::lng_parvane_planner_month_sleep(tr::now, lt_value, FormatSpan(cell.sleep->value)),
					KindColor(cell.isShort ? Kind::Due : Kind::Sleep), ToneColor(Tone::Muted), false);
				itemTop += itemLine + itemGap;
			}
			for (auto k = 0; k < std::min(int(cell.entries.size()), kPreviewCount); ++k) {
				const auto &entry = cell.entries[k];
				const auto itemRect = QRect(inner.x(), itemTop, inner.width(), itemLine);
				const auto isTask = !entry.taskKey.empty();
				drawItem(entry.label, EntryColor(entry.color, entry.kind), ToneColor(Tone::Fg), isTask && over(itemRect));
				if (isTask) {
					const auto taskId = entry.taskKey.substr(0, entry.taskKey.find('@'));
					area(itemRect, [actions, taskId, day] {
						if (actions.openTask) {
							actions.openTask(taskId, day);
						}
					}, nullptr, Q(entry.taskKey));
				}
				itemTop += itemLine + itemGap;
			}
			if (int(cell.entries.size()) > kPreviewCount) {
				DrawElided(p, itemFont, ToneColor(Tone::Muted), inner.x(),
					itemTop + (itemLine - itemFont->height) / 2 + itemFont->ascent,
					u"+"_q + QString::number(cell.entries.size() - kPreviewCount), inner.width());
			}
			p->restore();
		}
		y += rowHeight + gap;
	}
	return y - gap;
}

// ── год ──────────────────────────────────────────────────────────────────────

YearView::YearView(QWidget *parent, Actions actions)
: PlannerCanvas(parent, std::move(actions)) {
}

void YearView::setData(ViewPtr view, std::string picked, std::string today) {
	_view = std::move(view);
	_picked = std::move(picked);
	_today = std::move(today);
	_year = DateOf(_picked).year();
	const auto year = std::to_string(_year);
	_index = planner::getDayIndex(_view->state, year + "-01-01", year + "-12-31");
	refresh();
}

int YearView::draw(QPainter *p, int width) {
	if (!_view) {
		return 0;
	}
	const auto &state = _view->state;
	const auto gap = Kit::Rem(1.125);
	const auto minWidth = Kit::Rem(13.75);
	const auto columns = std::max(1, (width + gap) / (minWidth + gap));
	const auto monthWidth = (width - (columns - 1) * gap) / columns;
	const auto cellGap = Kit::Rem(0.125);
	const auto cell = std::max((monthWidth - 6 * cellGap) / 7, 1);
	const auto titleFont = Kit::Font(Kit::kBodyPx, true);
	const auto letterFont = Kit::Font(10);
	const auto dayFont = Kit::Font(11, false, true);
	const auto dayHoliday = Kit::Font(11, true, true);
	const auto titleHeight = Kit::Px(22);
	const auto letters = letterFont->height;
	const auto todayMonth = _today.substr(0, 7);
	const auto actions = _actions;

	auto y = 0;
	for (auto first = 1; first <= 12; first += columns) {
		auto rowHeight = 0;
		for (auto c = 0; c != columns && first + c <= 12; ++c) {
			const auto month = first + c;
			const auto days = planner::getMonthGridKeys(_year, month);
			const auto x = c * (monthWidth + gap);
			const auto prefix = DayKey(QDate(_year, month, 1)).substr(0, 7);
			const auto weeks = int(days.size()) / 7;
			const auto height = titleHeight + Kit::Rem(0.375) + letters + cellGap + weeks * (cell + cellGap);
			rowHeight = std::max(rowHeight, height);

			// Название месяца — кнопка
			const auto title = FormatMonthName(month);
			const auto titleRect = QRect(x, y, std::min(titleFont->width(title), monthWidth), titleHeight);
			const auto target = (prefix == _picked.substr(0, 7)) ? _picked : DayKey(QDate(_year, month, 1));
			area(titleRect, [actions, target] {
				if (actions.openMonth) {
					actions.openMonth(target);
				}
			});
			if (p) {
				const auto font = over(titleRect) ? titleFont->underline() : titleFont;
				DrawElided(p, font, (prefix == todayMonth) ? ToneColor(Tone::Accent) : ToneColor(Tone::Fg), x,
					y + (titleHeight - titleFont->height) / 2 + titleFont->ascent, title, monthWidth);
				for (auto w = 0; w != 7; ++w) {
					const auto letter = FormatWeekday(w).left(1);
					const auto lx = x + w * (cell + cellGap);
					const auto lw = letterFont->width(letter);
					DrawElided(p, letterFont, ToneColor(Tone::Faint), lx + (cell - lw) / 2,
						y + titleHeight + Kit::Rem(0.375) + letterFont->ascent, letter, cell);
				}
			}
			const auto gridTop = y + titleHeight + Kit::Rem(0.375) + letters + cellGap;
			for (auto i = 0; i != int(days.size()); ++i) {
				const auto &day = days[i];
				if (day.substr(0, 7) != prefix) {
					continue;
				}
				const auto rect = QRect(x + (i % 7) * (cell + cellGap), gridTop + (i / 7) * (cell + cellGap), cell, cell);
				area(rect, [actions, day] {
					if (actions.openMonth) {
						actions.openMonth(day);
					}
				});
				if (!p) {
					continue;
				}
				const auto it = _index.find(day);
				const auto entry = (it != _index.end()) ? &it->second : nullptr;
				const auto tint = (entry && state.budget)
					? std::min(kMaxLoadTint, int(std::round(double(entry->minutes) / state.budget * kMaxLoadTint)))
					: 0;
				p->setPen(Qt::NoPen);
				p->setBrush(MixOver(ToneColor(Tone::Blue), tint / 100., ToneColor(Tone::Raised)));
				p->drawRoundedRect(rect, Kit::Rem(0.3125), Kit::Rem(0.3125));
				const auto holiday = entry && entry->isHoliday;
				const auto number = QString::number(DateOf(day).day());
				const auto &font = holiday ? dayHoliday : dayFont;
				const auto nw = font->width(number);
				DrawElided(p, font, holiday ? ToneColor(Tone::Red) : ToneColor(Tone::Fg), rect.x() + (cell - nw) / 2,
					rect.y() + (cell - font->height) / 2 + font->ascent, number, cell);
				if (entry && !entry->deadlines.empty()) {
					const auto dot = Kit::Rem(0.25);
					Kit::PaintDot(*p, QPoint(rect.right() - Kit::Rem(0.125) - dot / 2, rect.y() + Kit::Rem(0.125) + dot / 2),
						ToneColor(Tone::Red), dot);
				}
				const auto outline = [&](QColor color, int widthPx) {
					p->setPen(QPen(color, widthPx));
					p->setBrush(Qt::NoBrush);
					const auto inset = widthPx / 2.;
					p->drawRoundedRect(QRectF(rect).adjusted(inset, inset, -inset, -inset), Kit::Rem(0.3125), Kit::Rem(0.3125));
				};
				if (day == _today) {
					outline(ToneColor(Tone::Accent), Kit::Px(2));
				} else if (day == _picked) {
					outline(ToneColor(Tone::Muted), 1);
				} else if (over(rect)) {
					outline(ToneColor(Tone::Line2), 1);
				}
			}
		}
		y += rowHeight + gap;
	}
	y -= gap;
	// Подпись
	y += Kit::Rem(0.875);
	const auto legendFont = Kit::Font(13);
	y += DrawWrapped(p, legendFont, ToneColor(Tone::Muted), QRect(0, y, width, 0),
		tr::lng_parvane_planner_year_legend(tr::now), 0);
	return y;
}

} // namespace Parvane::PlannerViews
