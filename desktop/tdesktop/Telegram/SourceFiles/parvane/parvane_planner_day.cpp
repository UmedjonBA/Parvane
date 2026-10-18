// Parvane fork: реализация parvane_planner_day.h — строка задачи, лента дня, день календаря. Размеры — из web
// Planner.module.scss (`.row`, `.feed*`, `.sumRow`, `.sleepHint`, `.side`, `.hdr`), в комментариях — rem.
#include "parvane/parvane_planner_day.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/scroll_area.h"

#include <parvane/sections/planner_health.h>
#include <parvane/sections/planner_links.h>

#include <QtCore/QTimer>

namespace Parvane::PlannerViews {
namespace {

constexpr auto kDueSoonDays = 2;

struct FeedRow {
	double minutes = 0;
	Fn<int(QPainter*, int, int, int)> draw; // (p, x, y, width) → высота
};

} // namespace

PlannerCanvas::PlannerCanvas(QWidget *parent, Actions actions)
: Canvas(parent)
, _actions(std::move(actions)) {
}

void PlannerCanvas::linkArea(QRect rect, const std::string &note) {
	const auto open = _actions.openNote;
	area(rect, [=] {
		if (open) {
			open(Q(note));
		}
	});
}

int PlannerCanvas::ButtonWidth(const QString &text, const QString &icon) {
	const auto font = Kit::Font(14);
	return Kit::Rem(0.875) * 2 + font->width(text) + (icon.isEmpty() ? 0 : (Kit::Px(18) + Kit::Rem(0.375)));
}

int PlannerCanvas::drawButton(QPainter *p, QRect rect, const QString &text, const QString &icon, bool ghost,
		Fn<void()> click) {
	if (p) {
		const auto hovered = over(rect);
		const auto bg = ghost
			? (hovered ? ToneColor(Tone::Hover) : QColor(0, 0, 0, 0))
			: (hovered ? ToneColor(Tone::Line2) : ToneColor(Tone::Hover));
		const auto fg = ghost && !hovered ? ToneColor(Tone::Muted) : ToneColor(Tone::Fg);
		p->setPen(Qt::NoPen);
		p->setBrush(bg);
		p->drawRoundedRect(rect, Kit::Rem(0.5), Kit::Rem(0.5));
		auto x = rect.x() + Kit::Rem(0.875);
		if (!icon.isEmpty()) {
			const auto size = Kit::Px(18);
			PaintPlannerIcon(*p, icon, fg, x, rect.y() + (rect.height() - size) / 2, size);
			x += size + Kit::Rem(0.375);
		}
		const auto font = Kit::Font(14);
		DrawElided(p, font, fg, x, rect.y() + (rect.height() - font->height) / 2 + font->ascent, text,
			rect.right() - x);
	}
	area(rect, std::move(click));
	return rect.width();
}

int PlannerCanvas::PillWidth(const QString &text) {
	return Kit::Rem(0.875) * 2 + Kit::Font(14)->width(text);
}

void PlannerCanvas::drawPill(QPainter *p, QRect rect, const QString &text, Fn<void()> click) {
	if (p) {
		p->setPen(Qt::NoPen);
		p->setBrush(over(rect) ? ToneColor(Tone::Hover) : ToneColor(Tone::Raised));
		p->drawRoundedRect(rect, rect.height() / 2., rect.height() / 2.);
		const auto font = Kit::Font(14);
		DrawElided(p, font, ToneColor(Tone::Fg), rect.x() + Kit::Rem(0.875),
			rect.y() + (rect.height() - font->height) / 2 + font->ascent, text, rect.width() - 2 * Kit::Rem(0.875));
	}
	area(rect, std::move(click));
}

void PlannerCanvas::drawIconButton(QPainter *p, QRect rect, const QString &icon, Fn<void()> click, bool accent) {
	if (p) {
		const auto hovered = over(rect);
		if (accent || hovered) {
			p->setPen(Qt::NoPen);
			p->setBrush(accent ? ToneColor(Tone::Accent) : ToneColor(Tone::Hover));
			p->drawEllipse(rect);
		}
		const auto size = Kit::Px(22);
		const auto color = accent
			? ToneColor(Tone::AccentInk)
			: hovered ? ToneColor(Tone::Fg) : ToneColor(Tone::Muted);
		PaintPlannerIcon(*p, icon, color, rect.x() + (rect.width() - size) / 2, rect.y() + (rect.height() - size) / 2,
			size);
	}
	area(rect, std::move(click));
}

int PlannerCanvas::drawTaskRow(QPainter *p, QRect line, const planner::State &state, const planner::Task &task,
		const std::string &today, const RowOptions &options) {
	const auto padX = Kit::Rem(0.625);
	const auto padY = Kit::Rem(0.375);
	const auto gap = Kit::Rem(0.75);
	const auto check = Kit::Rem(1.375);
	const auto titleFont = Kit::Font(Kit::kBodyPx);
	const auto titleLine = Kit::Px(22); // 0.9375rem × 1.45
	const auto subFont = Kit::Font(13);
	const auto subLine = Kit::Px(19);
	const auto metaFont = Kit::Font(13, false, true);
	const auto isDone = (task.status == "done");

	// Подпись строки: группа, день, срок, шаги, повтор, заметки из описания
	const auto hasDue = task.due && !task.due->empty() && !isDone;
	auto dueLabel = QString();
	if (hasDue) {
		const auto &due = *task.due;
		dueLabel = (due < today) ? tr::lng_parvane_planner_due_passed(tr::now)
			: (due == today) ? tr::lng_parvane_planner_due_today(tr::now)
			: (due == planner::addDays(today, 1)) ? tr::lng_parvane_planner_due_tomorrow(tr::now)
			: tr::lng_parvane_planner_due_value(tr::now, lt_date, FormatDayShort(due));
	}
	const auto isDueSoon = hasDue && *task.due <= planner::addDays(today, kDueSoonDays);
	auto doneSteps = 0;
	for (const auto &step : task.steps) {
		doneSteps += step.isDone ? 1 : 0;
	}
	const auto isListShown = options.contextAll && !options.noProject && !task.project.empty();
	const auto isDayShown = options.contextAll && task.day && !task.day->empty();
	const auto hasNotes = task.description.find("[[") != std::string::npos;
	const auto hasSub = isListShown || isDayShown || hasDue || !task.steps.empty() || task.repeat || hasNotes;
	auto metaParts = QStringList();
	if (task.start && !task.start->empty()) {
		metaParts.push_back(Q(*task.start));
	}
	if (task.minutes) {
		metaParts.push_back(tr::lng_parvane_planner_minutes_short(tr::now, lt_minutes, QString::number(*task.minutes)));
	}
	const auto meta = metaParts.join(u" · "_q);

	const auto height = std::max(Kit::Rem(2.75), padY * 2 + titleLine + (hasSub ? subLine : 0));
	const auto row = QRect(line.x(), line.y(), line.width(), height);
	if (!p) {
		return height;
	}
	const auto open = options.open
		? options.open
		: Fn<void()>([actions = _actions, id = task.id, day = task.instanceDay.value_or(std::string())] {
			if (actions.openTask) {
				actions.openTask(id, day);
			}
		});
	const auto hovered = over(row);
	if (hovered) {
		p->setPen(Qt::NoPen);
		p->setBrush(ToneColor(Tone::Hover));
		p->drawRoundedRect(row, Kit::Rem(0.5), Kit::Rem(0.5));
	}
	area(row, open);

	// Галочка
	const auto checkRect = QRect(row.x() + padX, row.y() + (height - check) / 2, check, check);
	DrawCheck(*p, checkRect, isDone, ToneColor(Tone::Purple), over(checkRect));
	area(checkRect.marginsAdded({ 4, 4, 4, 4 }), [task, isDone] {
		ToggleTaskDone(task, !isDone);
	});

	auto right = row.right() - padX;
	// Кнопка назначения дня
	if (!options.assignLabel.isEmpty()) {
		const auto width = ButtonWidth(options.assignLabel, QString());
		const auto button = QRect(right - width, row.y() + (height - Kit::Rem(2.25)) / 2, width, Kit::Rem(2.25));
		drawButton(p, button, options.assignLabel, QString(), true, options.assign);
		right = button.x() - gap;
	}
	if (!meta.isEmpty()) {
		const auto width = metaFont->width(meta);
		DrawElided(p, metaFont, ToneColor(Tone::Muted), right - width,
			row.y() + (height - metaFont->height) / 2 + metaFont->ascent, meta, width);
		right -= width + gap;
	}

	const auto left = checkRect.right() + 1 + gap;
	const auto bodyWidth = std::max(right - left, 0);
	auto y = row.y() + padY;
	const auto fg = isDone ? ToneColor(Tone::Faint) : ToneColor(Tone::Fg);
	auto x = left;
	const auto baseline = y + (titleLine - titleFont->height) / 2 + titleFont->ascent;
	x += DrawName(p, { titleFont, fg, isDone }, x, baseline, bodyWidth, task.name, [&](QRect rect, std::string note) {
		linkArea(rect, note);
	});
	if (options.contextAll && task.status == "active") {
		const auto label = FormatStatus("active");
		const auto look = TagLook{ .color = ToneColor(Tone::Accent) };
		const auto size = TagSize(look, label);
		if (x + Kit::Px(6) + size.width() <= left + bodyWidth) {
			DrawTag(*p, QRect(QPoint(x + Kit::Px(6), y + (titleLine - size.height()) / 2), size), look, label);
		}
	}
	y += titleLine;
	if (hasSub) {
		const auto muted = ToneColor(Tone::Muted);
		const auto subBase = y + (subLine - subFont->height) / 2 + subFont->ascent;
		auto sx = left;
		const auto limit = left + bodyWidth;
		const auto gapSub = Kit::Rem(0.625);
		const auto icon = Kit::Px(14);
		const auto text = [&](const QString &value, QColor color) {
			if (sx >= limit) {
				return;
			}
			sx += DrawElided(p, subFont, color, sx, subBase, value, limit - sx) + gapSub;
		};
		if (isListShown) {
			const auto mark = Kit::Rem(0.625);
			const auto color = ListColor(planner::getListColor(state, task.project));
			p->setPen(Qt::NoPen);
			p->setBrush(color.isValid() ? color : ToneColor(Tone::Faint));
			p->drawRoundedRect(QRect(sx, y + (subLine - mark) / 2, mark, mark), Kit::Px(3), Kit::Px(3));
			sx += mark + Kit::Px(4);
			text(FormatProject(task.project), muted);
		}
		if (isDayShown) {
			text(FormatDayShort(*task.day), muted);
		}
		if (hasDue && sx < limit) {
			const auto color = isDueSoon ? ToneColor(Tone::Red) : muted;
			PaintPlannerIcon(*p, u"flag"_q, color, sx, y + (subLine - icon) / 2, icon);
			sx += icon + Kit::Px(4);
			text(dueLabel, color);
		}
		if (!task.steps.empty()) {
			text(tr::lng_parvane_planner_steps_count(
				tr::now,
				lt_done,
				QString::number(doneSteps),
				lt_total,
				QString::number(task.steps.size())), muted);
		}
		if (task.repeat && sx + icon <= limit) {
			PaintPlannerIcon(*p, u"loop"_q, muted, sx, y + (subLine - icon) / 2, icon);
			sx += icon + gapSub;
		}
		if (hasNotes && sx < limit) {
			DrawName(p, { subFont, muted }, sx, subBase, limit - sx, task.description, [&](QRect rect, std::string note) {
				linkArea(rect, note);
			}, true);
		}
	}
	return height;
}

int PlannerCanvas::drawFeed(QPainter *p, int x, int y, int width, const planner::State &state,
		const std::string &day, const std::string &today, const planner::Layers &layers, bool onPanel) {
	const auto entry = planner::getDayEntry(state, day);
	const auto isToday = (day == today);
	const auto timeWidth = Kit::Rem(3);
	const auto gap = Kit::Rem(0.625);
	const auto lineGap = Kit::Rem(0.25);
	const auto linePad = Kit::Rem(0.1875);
	const auto timeFont = Kit::Font(13, false, true);
	const auto muted = ToneColor(Tone::Muted);
	const auto base = onPanel ? ToneColor(Tone::Panel) : ToneColor(Tone::Raised);
	const auto actions = _actions;

	// Строка ленты со временем слева
	const auto timeLabel = [&](QPainter *q, int top, int height, const QString &label, QColor color, bool bold) {
		if (!q) {
			return;
		}
		const auto font = Kit::Font(13, bold, true);
		DrawElided(q, font, color, x, top + (height - font->height) / 2 + font->ascent, label, timeWidth);
	};
	const auto bodyX = x + timeWidth + gap;
	const auto bodyWidth = std::max(width - timeWidth - gap, 0);

	// Отметка (`.feedMark`): подъём, приём пищи
	const auto mark = [&](QPainter *q, int top, const QString &time, Kind kind, const QString &icon,
			const QString &label, const QString &value, Fn<void()> click) {
		const auto font = Kit::Font(14);
		const auto inner = std::max(Kit::Px(18), font->height) + 2 * Kit::Rem(0.25);
		const auto height = inner + 2 * linePad;
		if (q) {
			timeLabel(q, top, height, time, muted, false);
			const auto rect = QRect(bodyX, top + linePad, bodyWidth, inner);
			const auto color = KindColor(kind);
			const auto size = Kit::Px(18);
			PaintPlannerIcon(*q, icon, color, rect.x(), rect.y() + (rect.height() - size) / 2, size);
			auto valueWidth = 0;
			const auto valueFont = Kit::Font(13, false, true);
			if (!value.isEmpty()) {
				valueWidth = valueFont->width(value);
				DrawElided(q, valueFont, muted, rect.right() - valueWidth,
					rect.y() + (rect.height() - valueFont->height) / 2 + valueFont->ascent, value, valueWidth);
			}
			const auto textX = rect.x() + size + Kit::Rem(0.5);
			DrawElided(q, font, ToneColor(Tone::Fg), textX, rect.y() + (rect.height() - font->height) / 2 + font->ascent,
				label, rect.right() - textX - (valueWidth ? valueWidth + Kit::Rem(0.5) : 0));
			if (click) {
				area(rect, click);
			}
		}
		return height;
	};

	// Блок дела (`.feedBlock`)
	struct Block {
		QString name;
		std::string rawName;
		QString sub;
		QString note;
		QColor color;
		bool done = false;
		std::optional<planner::Task> check;
		std::string descriptionLinks;
		Fn<void()> open;
	};
	const auto block = [&](QPainter *q, int top, const QString &time, QColor timeColor, const Block &b) {
		const auto padX = Kit::Rem(0.625);
		const auto padY = Kit::Rem(0.375);
		const auto nameFont = Kit::Font(Kit::kBodyPx, true);
		const auto subFont = Kit::Font(12, false, true);
		const auto noteFont = Kit::Font(13);
		const auto nameLine = Kit::Px(22);
		const auto subLine = Kit::Px(18);
		const auto noteLine = Kit::Px(19);
		const auto inner = padY * 2 + nameLine + subLine + (b.note.isEmpty() ? 0 : noteLine);
		const auto height = inner + 2 * linePad;
		if (!q) {
			return height;
		}
		timeLabel(q, top, height, time, timeColor, false);
		const auto rect = QRect(bodyX, top + linePad, bodyWidth, inner);
		const auto hovered = over(rect);
		q->setPen(Qt::NoPen);
		q->setBrush(MixOver(b.color, hovered ? 0.26 : 0.16, base));
		q->drawRoundedRect(rect, Kit::Rem(0.375), Kit::Rem(0.375));
		q->setBrush(b.color);
		q->drawRoundedRect(QRect(rect.x(), rect.y(), Kit::Rem(0.375), rect.height()), Kit::Px(2), Kit::Px(2));
		q->fillRect(QRect(rect.x() + Kit::Px(3), rect.y(), Kit::Rem(0.375) - Kit::Px(3), rect.height()),
			MixOver(b.color, hovered ? 0.26 : 0.16, base));
		area(rect, b.open);
		auto left = rect.x() + Kit::Px(3) + padX;
		if (b.check) {
			const auto side = Kit::Rem(1.25);
			const auto checkRect = QRect(left, rect.y() + (rect.height() - side) / 2, side, side);
			DrawCheck(*q, checkRect, b.done, ToneColor(Tone::Purple), over(checkRect));
			const auto task = *b.check;
			const auto done = b.done;
			area(checkRect.marginsAdded({ 3, 3, 3, 3 }), [task, done] {
				ToggleTaskDone(task, !done);
			});
			left += side + Kit::Rem(0.5);
		}
		const auto textWidth = std::max(rect.right() - padX - left, 0);
		auto ty = rect.y() + padY;
		DrawName(q, { nameFont, b.done ? ToneColor(Tone::Faint) : ToneColor(Tone::Fg), b.done }, left,
			ty + (nameLine - nameFont->height) / 2 + nameFont->ascent, textWidth, b.rawName, [&](QRect r, std::string note) {
				linkArea(r, note);
			});
		ty += nameLine;
		const auto subWidth = DrawElided(q, subFont, muted, left, ty + (subLine - subFont->height) / 2 + subFont->ascent,
			b.sub, textWidth);
		if (!b.descriptionLinks.empty()) {
			DrawName(q, { Kit::Font(12), muted }, left + subWidth + Kit::Rem(0.5),
				ty + (subLine - subFont->height) / 2 + subFont->ascent, textWidth - subWidth - Kit::Rem(0.5),
				b.descriptionLinks, [&](QRect r, std::string note) { linkArea(r, note); }, true);
		}
		ty += subLine;
		if (!b.note.isEmpty()) {
			DrawElided(q, noteFont, muted, left, ty + (noteLine - noteFont->height) / 2 + noteFont->ascent, b.note,
				textWidth);
		}
		return height;
	};

	auto rows = std::vector<FeedRow>();
	const auto allDay = layers.work ? entry.allDay : std::vector<planner::Event>();

	const auto sleep = layers.sleep ? planner::getDailyRecord(state, "sleep", day) : std::nullopt;
	if (sleep && sleep->endTime && !sleep->endTime->empty()) {
		const auto endTime = Q(*sleep->endTime);
		const auto label = tr::lng_parvane_planner_feed_wake(tr::now, lt_sleep, FormatSpan(sleep->value));
		const auto kind = planner::isShortSleep(state, day) ? Kind::Due : Kind::Sleep;
		const auto open = Fn<void()>([actions, day] {
			if (actions.openSleep) {
				actions.openSleep(day);
			}
		});
		rows.push_back({
			// Подъём стоит раньше дела, начавшегося в ту же минуту
			planner::toMinutes(*sleep->endTime) - 0.5,
			[=](QPainter *q, int, int top, int) {
				return mark(q, top, endTime, kind, u"darkmode"_q, label, QString(), open);
			},
		});
	}

	if (layers.food) {
		if (const auto i = state.nutrition.find(day); i != state.nutrition.end()) {
			for (const auto &meal : i->second.entries) {
				if (!meal.time || meal.time->empty()) {
					continue;
				}
				const auto time = Q(*meal.time);
				const auto label = FormatMeal(meal.meal) + u": "_q + Q(meal.name);
				const auto value = FormatInt(std::llround(meal.kcal));
				rows.push_back({
					double(planner::toMinutes(*meal.time)),
					[=](QPainter *q, int, int top, int) {
						return mark(q, top, time, Kind::Food, u"eats"_q, label, value, nullptr);
					},
				});
			}
		}
	}

	if (layers.work) {
		for (const auto &item : entry.timed) {
			auto b = Block();
			b.rawName = item.name;
			b.sub = Q(item.start) + QChar(0x2013) + Q(item.end);
			if (item.task) {
				const auto &task = *item.task;
				b.color = EntryColor(planner::getListColor(state, task.project), Kind::Task);
				b.done = (task.status == "done");
				b.check = task;
				b.note = Q(planner::formatDescriptionLine(task.description));
				if (task.description.find("[[") != std::string::npos) {
					b.descriptionLinks = task.description;
				}
				b.open = [actions, id = task.id, day] {
					if (actions.openTask) {
						actions.openTask(id, day);
					}
				};
			} else {
				const auto &event = *item.event;
				b.color = EntryColor(planner::getEventColor(state, event), Kind::Event);
				b.note = Q(planner::formatDescriptionLine(event.description));
				b.open = [actions, id = event.id, day] {
					if (actions.openEvent) {
						actions.openEvent(id, day);
					}
				};
			}
			const auto time = Q(item.start);
			rows.push_back({
				double(planner::toMinutes(item.start)),
				[=](QPainter *q, int, int top, int) {
					return block(q, top, time, muted, b);
				},
			});
		}
		for (const auto &record : planner::getWorkouts(state, { day })) {
			if (!record.time || record.time->empty()) {
				continue;
			}
			const auto start = planner::toMinutes(*record.time);
			auto b = Block();
			b.rawName = record.name.value_or(std::string());
			b.color = KindColor(Kind::Workout);
			b.sub = record.value
				? (Q(*record.time) + QChar(0x2013) + Q(planner::toTime(start + int(record.value)))
					+ u" · "_q + FormatDuration(int(record.value)))
				: Q(*record.time);
			const auto time = Q(*record.time);
			rows.push_back({
				double(start),
				[=](QPainter *q, int, int top, int) {
					return block(q, top, time, muted, b);
				},
			});
		}
	}

	std::stable_sort(rows.begin(), rows.end(), [](const FeedRow &a, const FeedRow &b) {
		return a.minutes < b.minutes;
	});
	const auto nowMinutes = NowMinutes();
	auto nowIndex = -1;
	if (isToday) {
		nowIndex = 0;
		for (const auto &row : rows) {
			nowIndex += (row.minutes <= nowMinutes) ? 1 : 0;
		}
	}

	auto top = y;
	if (rows.empty() && allDay.empty() && !isToday) {
		const auto font = Kit::Font(Kit::kBodyPx);
		const auto height = Kit::Px(22);
		if (p) {
			DrawElided(p, font, muted, x, top + (height - font->height) / 2 + font->ascent,
				tr::lng_parvane_planner_free(tr::now), width);
		}
		return height;
	}
	auto first = true;
	const auto advance = [&](int height) {
		top += height + lineGap;
		first = false;
	};
	for (const auto &event : allDay) {
		auto b = Block();
		b.rawName = event.name;
		const auto holiday = event.isHoliday.value_or(false);
		b.color = EntryColor(planner::getEventColor(state, event), holiday ? Kind::Due : Kind::Event);
		b.sub = holiday ? tr::lng_parvane_planner_holiday(tr::now) : tr::lng_parvane_planner_all_day(tr::now);
		b.note = event.description ? Q(planner::formatDescriptionLine(event.description)) : QString();
		b.open = [actions, id = event.id, day] {
			if (actions.openEvent) {
				actions.openEvent(id, day);
			}
		};
		advance(block(p, top, tr::lng_parvane_planner_all_day_tiny(tr::now), muted, b));
	}
	const auto drawNow = [&] {
		const auto font = Kit::Font(13, true, true);
		const auto height = std::max(font->height, Kit::Px(19));
		if (p) {
			timeLabel(p, top, height, Q(planner::toTime(nowMinutes)), ToneColor(Tone::Red), true);
			p->setPen(Qt::NoPen);
			p->setBrush(ToneColor(Tone::Red));
			p->drawRoundedRect(QRect(bodyX, top + (height - Kit::Px(2)) / 2, bodyWidth, Kit::Px(2)), 1, 1);
		}
		advance(height);
	};
	for (auto i = 0; i != int(rows.size()); ++i) {
		if (i == nowIndex) {
			drawNow();
		}
		advance(rows[i].draw(p, x, top, width));
	}
	if (nowIndex == int(rows.size())) {
		drawNow();
	}
	return first ? 0 : (top - y - lineGap);
}

// ── DayBody ──────────────────────────────────────────────────────────────────

DayBody::DayBody(QWidget *parent, Actions actions, Variant variant)
: PlannerCanvas(parent, std::move(actions))
, _variant(variant) {
	// Черта «сейчас» идёт по минутам
	const auto timer = new QTimer(this);
	timer->setInterval(60 * 1000);
	QObject::connect(timer, &QTimer::timeout, [=] {
		if (_day == _today) {
			update();
		}
	});
	timer->start();
}

void DayBody::setData(ViewPtr view, std::string day, std::string today, planner::Layers layers) {
	if (day != _day) {
		_sleepHint = false;
	}
	_view = std::move(view);
	_day = std::move(day);
	_today = std::move(today);
	_layers = layers;
	refresh();
}

int DayBody::draw(QPainter *p, int width) {
	if (!_view || _day.empty()) {
		return 0;
	}
	const auto &state = _view->state;
	const auto entry = planner::getDayEntry(state, _day);
	const auto load = entry.minutes;
	const auto budget = planner::getDayBudget(state, _day);
	const auto sleep = planner::getDailyRecord(state, "sleep", _day);
	const auto isShort = planner::isShortSleep(state, _day);
	const auto kcal = std::llround(planner::getNutrientTotal(state, _day, "kcal").value);
	const auto stack = Kit::Rem(0.875);
	auto y = 0;

	// Сводка плашками (`.sumRow`)
	struct Chip {
		QString text;
		TagLook look;
		Fn<void()> click;
	};
	auto chips = std::vector<Chip>();
	chips.push_back({
		tr::lng_parvane_planner_day_plan(
			tr::now,
			lt_planned,
			FormatHoursNumber(load),
			lt_budget,
			FormatHours(budget)),
		TagLook{ .color = KindColor(load > budget ? Kind::Due : Kind::Event), .large = true },
	});
	if (entry.unrated) {
		chips.push_back({
			tr::lng_parvane_planner_day_unrated(tr::now, lt_amount, QString::number(entry.unrated)),
			TagLook{ .color = KindColor(Kind::Muted), .large = true },
		});
	}
	if (_layers.sleep && sleep && isShort) {
		chips.push_back({
			FormatSpan(sleep->value),
			TagLook{ .color = KindColor(Kind::Due), .large = true, .icon = u"darkmode"_q },
			[=] {
				_sleepHint = !_sleepHint;
				refresh();
			},
		});
	}
	if (_layers.food && kcal) {
		chips.push_back({
			tr::lng_parvane_planner_health_kcal(tr::now, lt_value, FormatInt(kcal)),
			TagLook{ .color = KindColor(Kind::Food), .large = true, .icon = u"eats"_q },
		});
	}
	if (_layers.work) {
		for (const auto &task : entry.deadlines) {
			const auto actions = _actions;
			chips.push_back({
				tr::lng_parvane_planner_deadline_preview(tr::now, lt_name, PlainName(task.name)),
				TagLook{ .color = KindColor(Kind::Due), .large = true, .icon = u"flag"_q },
				[actions, id = task.id] {
					if (actions.openTask) {
						actions.openTask(id, std::string());
					}
				},
			});
		}
	}
	{
		const auto gap = Kit::Rem(0.5);
		auto x = 0;
		auto rowHeight = 0;
		for (const auto &chip : chips) {
			const auto size = TagSize(chip.look, chip.text, width);
			if (x > 0 && x + size.width() > width) {
				x = 0;
				y += rowHeight + gap;
				rowHeight = 0;
			}
			const auto rect = QRect(QPoint(x, y), size);
			if (p) {
				DrawTag(*p, rect, chip.look, chip.text, chip.click && over(rect));
			}
			if (chip.click) {
				area(rect, chip.click);
			}
			x += size.width() + gap;
			rowHeight = std::max(rowHeight, size.height());
		}
		y += rowHeight;
	}
	if (isShort && _sleepHint && sleep) {
		y += stack;
		const auto font = Kit::Font(13);
		const auto text = tr::lng_parvane_planner_sleep_warn(
			tr::now,
			lt_sleep,
			FormatSpan(sleep->value),
			lt_budget,
			FormatHours(budget));
		const auto padX = Kit::Rem(0.625);
		const auto padY = Kit::Rem(0.375);
		const auto inner = width - 2 * padX;
		const auto textHeight = DrawWrapped(nullptr, font, QColor(), QRect(0, 0, inner, 0), text, 0);
		const auto rect = QRect(0, y, width, textHeight + 2 * padY);
		if (p) {
			p->setPen(Qt::NoPen);
			p->setBrush(Kit::Mix(Tone::Red, 0.14));
			p->drawRoundedRect(rect, Kit::Rem(0.5), Kit::Rem(0.5));
			DrawWrapped(p, font, ToneColor(Tone::Red), QRect(padX, y + padY, inner, textHeight), text, 0);
		}
		y += rect.height();
	}

	// Задачи без времени
	const auto untimed = _layers.work ? entry.untimed : std::vector<planner::Task>();
	if (!untimed.empty()) {
		y += stack;
		for (const auto &task : untimed) {
			y += drawTaskRow(p, QRect(0, y, width, 0), state, task, _today, {});
		}
	}

	// Лента дня
	{
		y += stack;
		y += drawFeed(p, 0, y, width, state, _day, _today, _layers, _variant == Variant::Island);
	}

	// «Добавить на этот день»
	{
		y += stack;
		const auto text = tr::lng_parvane_planner_add_for_day(tr::now);
		const auto rect = QRect(0, y, std::min(ButtonWidth(text, u"add"_q), width), Kit::Rem(2.25));
		const auto actions = _actions;
		const auto day = _day;
		drawButton(p, rect, text, u"add"_q, false, [actions, day] {
			if (actions.createForDay) {
				actions.createForDay(day);
			}
		});
		y += rect.height();
	}
	return y;
}

// ── DayIsland ────────────────────────────────────────────────────────────────

DayIsland::DayIsland(QWidget *parent, Actions actions, Fn<void(int)> shiftDay)
: Island(parent, Kit::Rem(1.125)) {
	_prev = Ui::CreateChild<IconBtn>(this, u"previous"_q, tr::lng_parvane_planner_prev_day(tr::now));
	_next = Ui::CreateChild<IconBtn>(this, u"next"_q, tr::lng_parvane_planner_next_day(tr::now));
	_prev->setClickedCallback([=] { shiftDay(-1); });
	_next->setClickedCallback([=] { shiftDay(1); });
	_scroll = Ui::CreateChild<Ui::ScrollArea>(this);
	_body = _scroll->setOwnedWidget(object_ptr<DayBody>(_scroll, std::move(actions), DayBody::Variant::Island)).data();
}

void DayIsland::setData(ViewPtr view, std::string day, std::string today, planner::Layers layers) {
	_day = day;
	_today = today;
	_body->setData(std::move(view), std::move(day), std::move(today), layers);
	relayout();
	update();
}

void DayIsland::resizeEvent(QResizeEvent *e) {
	relayout();
}

void DayIsland::relayout() {
	const auto inner = innerRect();
	const auto head = Kit::Rem(3.75);
	const auto padX = Kit::Rem(1.125);
	const auto gap = Kit::Rem(0.875);
	const auto top = inner.y() + (head - _next->height()) / 2;
	_next->move(inner.right() - padX - _next->width() + 1, top);
	_prev->move(_next->x() - Kit::Rem(0.5) - _prev->width(), top);
	(void)gap;
	const auto pad = Kit::Rem(1.25);
	_scroll->setGeometry(inner.x(), inner.y() + head + 1, inner.width(), std::max(inner.height() - head - 1, 0));
	_body->resizeToWidth(std::max(inner.width() - 2 * pad, 0));
	_body->move(pad, pad);
	// Поле снизу — у содержимого прокрутки
	_body->setContentsMargins(0, 0, 0, 0);
}

void DayIsland::paintEvent(QPaintEvent *e) {
	Island::paintEvent(e);
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	const auto inner = innerRect();
	const auto head = Kit::Rem(3.75);
	const auto padX = Kit::Rem(1.125);
	p.fillRect(QRect(inner.x(), inner.y() + head, inner.width(), 1), ToneColor(Tone::Line));
	const auto over = Kit::Font(13);
	const auto title = Kit::Font(18, true);
	const auto textWidth = std::max(_prev->x() - Kit::Rem(0.875) - inner.x() - padX, 0);
	const auto total = over->height + Kit::Px(24);
	const auto top = inner.y() + (head - total) / 2;
	DrawElided(&p, over, ToneColor(Tone::Muted), inner.x() + padX, top + over->ascent,
		FormatRelativeDay(_day, _today), textWidth);
	DrawElided(&p, title, ToneColor(Tone::Fg), inner.x() + padX,
		top + over->height + (Kit::Px(24) - title->height) / 2 + title->ascent, FormatDay(_day), textWidth);
}

} // namespace Parvane::PlannerViews
