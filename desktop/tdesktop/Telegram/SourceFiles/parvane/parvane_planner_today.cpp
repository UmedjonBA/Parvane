// Parvane fork: реализация parvane_planner_today.h — «Сегодня», шапка дня, заметка дня, задачи без даты. Размеры —
// из web Planner.module.scss (`.dateNav*`, `.todayGrid`, `.stats`, `.stat*`, `.card*`, `.daily*`, `.groupTitle`).
#include "parvane/parvane_planner_today.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/wrap/vertical_layout.h"

#include <QtCore/QPointer>

#include <parvane/sections/notes_look.h>
#include <parvane/sections/notes_model.h>
#include <parvane/sections/planner_health.h>

namespace Parvane::PlannerViews {
namespace {

namespace notes = parvane::sections::notes;

// Сколько задач без даты показывать прямо в карточке «Задачи»
constexpr auto kUndatedShown = 5;
constexpr auto kPreviewLines = 6;
// Ширина правой колонки «Сегодня» (`--pv-panel-planner-today` 21.25rem) и порог одной колонки
constexpr auto kSideRem = 21.25;
constexpr auto kTwoColumnsMinRem = 48.;

double Share(double value, std::optional<double> goal) {
	return (goal && *goal > 0) ? std::min(1., value / *goal) : 0.;
}

// Карточка `.card`: фон `--pv-raised`, скругление 0.75rem
void PaintCard(QPainter *p, QRect rect, bool hovered = false) {
	if (!p) {
		return;
	}
	p->setPen(Qt::NoPen);
	p->setBrush(hovered ? ToneColor(Tone::Hover) : ToneColor(Tone::Raised));
	p->drawRoundedRect(rect, Kit::Rem(0.75), Kit::Rem(0.75));
}

// Задачи без даты по группам, «в работе» сверху группы; кнопка справа назначает день (web PlannerUndated)
class UndatedList final : public PlannerCanvas {
public:
	UndatedList(QWidget *parent, Actions actions, Fn<void()> close)
	: PlannerCanvas(parent, std::move(actions))
	, _close(std::move(close)) {
		Sections::PlannerValue() | rpl::on_next([=](ViewPtr view) {
			_view = std::move(view);
			refresh();
		}, lifetime());
	}

	void setDay(std::string day, std::string today) {
		_day = std::move(day);
		_today = std::move(today);
		refresh();
	}

protected:
	int draw(QPainter *p, int width) override;

private:
	const Fn<void()> _close;
	ViewPtr _view;
	std::string _day;
	std::string _today;
	bool _completedOpen = false;

};

int UndatedList::draw(QPainter *p, int width) {
	if (!_view) {
		return 0;
	}
	const auto &state = _view->state;
	const auto tasks = planner::getUndatedTasks(state);
	const auto hintFont = Kit::Font(13);
	auto y = DrawWrapped(p, hintFont, ToneColor(Tone::Muted), QRect(0, 0, width, 0),
		tr::lng_parvane_planner_undated_hint(tr::now), 0);
	y += Kit::Rem(0.375);
	if (tasks.empty()) {
		const auto font = Kit::Font(Kit::kBodyPx);
		y += Kit::Rem(0.5);
		DrawElided(p, font, ToneColor(Tone::Muted), 0, y + font->ascent, tr::lng_parvane_planner_undated_empty(tr::now),
			width);
		y += font->height;
	}
	const auto dayLabel = FormatDay(_day);
	const auto assignLabel = (_day == _today) ? tr::lng_parvane_planner_today(tr::now) : FormatDayShort(_day);
	const auto actions = _actions;
	const auto close = _close;
	const auto rowsWidth = width + Kit::Rem(1.25);
	for (const auto &project : state.projects) {
		auto projectTasks = std::vector<planner::Task>();
		for (const auto &task : tasks) {
			if (task.project == project) {
				projectTasks.push_back(task);
			}
		}
		if (projectTasks.empty()) {
			continue;
		}
		// Заголовок группы: квадрат цвета, имя, число
		y += Kit::Rem(0.75);
		const auto line = Kit::Px(18);
		const auto mark = Kit::Rem(0.625);
		const auto color = ListColor(planner::getListColor(state, project));
		if (p) {
			p->setPen(Qt::NoPen);
			p->setBrush(color.isValid() ? color : ToneColor(Tone::Faint));
			p->drawRoundedRect(QRect(0, y + (line - mark) / 2, mark, mark), Kit::Px(3), Kit::Px(3));
		}
		const auto capsFont = Kit::Font(12, true, true);
		const auto baseline = y + (line - capsFont->height) / 2 + capsFont->ascent;
		const auto titleWidth = DrawCaps(p, 12, ToneColor(Tone::Muted), mark + Kit::Rem(0.375), baseline,
			FormatProject(project), width - mark - Kit::Rem(3));
		DrawCaps(p, 12, ToneColor(Tone::Muted), mark + Kit::Rem(0.375) + titleWidth + Kit::Rem(0.375), baseline,
			QString::number(projectTasks.size()), Kit::Rem(3), false);
		y += line + Kit::Rem(0.125);
		for (const auto &task : projectTasks) {
			auto options = RowOptions();
			options.contextAll = true;
			options.noProject = true;
			options.assignLabel = assignLabel;
			options.assign = [task, day = _day, dayLabel] {
				Sections::UpdatePlanner([id = task.id, day](planner::State &state) {
					if (const auto found = planner::findTask(state, id)) {
						found->day = day;
					}
				}, tr::lng_parvane_planner_notice_moved(tr::now, lt_date, dayLabel, lt_name, Q(task.name)));
			};
			options.open = [actions, close, id = task.id] {
				close();
				if (actions.openTask) {
					actions.openTask(id, std::string());
				}
			};
			y += drawTaskRow(p, QRect(-Kit::Rem(0.625), y, rowsWidth, 0), state, task, _today, options);
		}
	}
	const auto completed = planner::getCompletedTasks(state);
	if (!completed.empty()) {
		y += Kit::Rem(0.75);
		const auto font = Kit::Font(13);
		const auto label = (_completedOpen ? u"▾ "_q : u"▸ "_q)
			+ tr::lng_parvane_planner_completed(tr::now, lt_amount, QString::number(completed.size()));
		const auto rect = QRect(0, y, std::min(font->width(label), width), font->height);
		DrawElided(p, font, over(rect) ? ToneColor(Tone::Fg) : ToneColor(Tone::Muted), 0, y + font->ascent, label, width);
		area(rect, [=] {
			_completedOpen = !_completedOpen;
			refresh();
		});
		y += font->height;
		if (_completedOpen) {
			for (const auto &task : completed) {
				auto options = RowOptions();
				options.contextAll = true;
				options.open = [actions, close, id = task.id] {
					close();
					if (actions.openTask) {
						actions.openTask(id, std::string());
					}
				};
				y += drawTaskRow(p, QRect(-Kit::Rem(0.625), y, rowsWidth, 0), state, task, _today, options);
			}
		}
	}
	return y;
}

} // namespace

TodayView::TodayView(QWidget *parent, Actions actions, Fn<void(int)> shiftDay, Fn<void()> jumpToday)
: PlannerCanvas(parent, std::move(actions))
, _shiftDay(std::move(shiftDay))
, _jumpToday(std::move(jumpToday)) {
	// Правка заметок и дерева облака — текст заметки дня перечитывается
	Sections::NotesValue() | rpl::on_next([=](std::shared_ptr<const Sections::NotesView>) {
		if (!_day.empty()) {
			requestNote();
		}
	}, lifetime());
}

void TodayView::setScrollTo(Fn<void(int)> scrollTo) {
	_scrollTo = std::move(scrollTo);
}

void TodayView::setData(ViewPtr view, std::string day, std::string today) {
	const auto dayChanged = (day != _day);
	_view = std::move(view);
	_day = std::move(day);
	_today = std::move(today);
	if (dayChanged) {
		requestNote();
	}
	refresh();
}

void TodayView::requestNote() {
	const auto day = _day;
	if (_note.day != day) {
		_note = NotePeek{ day };
	}
	// Хранилище «Знаний» ради карточки не открывается: читается один файл по дереву облака
	const auto weak = QPointer<TodayView>(this);
	Sections::Ask<std::optional<std::optional<std::string>>>([day](Sections::Workers &w) {
		return w.notes.readDailyNote(day);
	}, [=](std::optional<std::optional<std::string>> result) {
		if (!weak || _day != day || !result) {
			return;
		}
		_note = NotePeek{ day, true, *result };
		refresh();
	});
}

void TodayView::openUndated() {
	const auto host = _actions.sheetHost ? _actions.sheetHost() : nullptr;
	if (!host || !_view) {
		return;
	}
	const auto count = planner::getUndatedTasks(_view->state).size();
	const auto sheet = Kit::Sheet::Show(host, {
		.title = tr::lng_parvane_planner_undated(tr::now, lt_amount, QString::number(count)),
		.closeName = tr::lng_parvane_planner_close(tr::now),
	});
	const auto weakSheet = QPointer<Kit::Sheet>(sheet.get());
	const auto list = sheet->add(object_ptr<UndatedList>(sheet->content(), _actions, [=] {
		if (weakSheet) {
			weakSheet->requestClose();
		}
	}));
	list->setDay(_day, _today);
}

int TodayView::drawDateNav(QPainter *p, int width) {
	// `.dateNav`: «Сегодня / Завтра / день недели», крупная дата и стрелки дней
	const auto overFont = Kit::Font(14);
	const auto bigFont = Kit::Font(26, true, true);
	const auto height = overFont->height + bigFont->height;
	const auto ib = Kit::Rem(2.25);
	const auto gap = Kit::Rem(0.625);
	auto right = width;
	const auto next = QRect(right - ib, (height - ib) / 2, ib, ib);
	right = next.x() - gap;
	const auto prev = QRect(right - ib, (height - ib) / 2, ib, ib);
	right = prev.x() - gap;
	const auto shift = _shiftDay;
	drawIconButton(p, next, u"next"_q, [shift] { shift(1); });
	drawIconButton(p, prev, u"previous"_q, [shift] { shift(-1); });
	if (_day != _today) {
		const auto text = tr::lng_parvane_planner_jump_today(tr::now);
		const auto pill = QRect(right - PillWidth(text), (height - Kit::Rem(2.125)) / 2, PillWidth(text), Kit::Rem(2.125));
		drawPill(p, pill, text, _jumpToday);
		right = pill.x() - gap;
	}
	DrawElided(p, overFont, ToneColor(Tone::Muted), 0, overFont->ascent, FormatRelativeDay(_day, _today), right);
	DrawElided(p, bigFont, ToneColor(Tone::Fg), 0, overFont->height + bigFont->ascent, FormatDay(_day), right);
	return std::max(height, ib);
}

int TodayView::drawStats(QPainter *p, int x, int y, int width) {
	const auto &state = _view->state;
	const auto entry = planner::getDayEntry(state, _day);
	auto tasks = entry.tasks;
	auto doneCount = 0;
	for (const auto &task : tasks) {
		doneCount += (task.status == "done") ? 1 : 0;
	}
	const auto leftCount = int(tasks.size()) - doneCount;
	const auto load = entry.minutes;
	const auto budget = planner::getDayBudget(state, _day);
	const auto isOver = load > budget;
	const auto isShort = planner::isShortSleep(state, _day);
	const auto sleep = planner::getDailyRecord(state, "sleep", _day);
	const auto sleepGoal = state.healthGoals.sleepMinutes;
	const auto routine = planner::getSleepRoutine(state, _day);
	auto routineHint = QString();
	if ((routine.level == "drifting" || routine.level == "broken") && routine.spread) {
		const auto value = tr::lng_parvane_planner_minutes_value(tr::now, lt_minutes, QString::number(*routine.spread));
		routineHint = (routine.level == "drifting")
			? tr::lng_parvane_planner_sleep_routine_drifting(tr::now, lt_value, value)
			: tr::lng_parvane_planner_sleep_routine_broken(tr::now, lt_value, value);
	}
	const auto kcal = std::llround(planner::getNutrientTotal(state, _day, "kcal").value);
	const auto goals = planner::getGoalsForDay(state, _day, _today);
	const auto goal = goals.find("kcal");
	const auto kcalGoal = (goal != goals.end() && goal->second.target > 0)
		? std::optional<double>(goal->second.target)
		: std::nullopt;

	struct Stat {
		Kind kind;
		QString label;
		QString value;
		QString unit;
		double fraction = 0;
		QString sub;
		Fn<void()> click;
	};
	const auto actions = _actions;
	auto sleepSub = QString();
	if (!sleep) {
		sleepSub = tr::lng_parvane_planner_health_sleep_none(tr::now);
	} else if (!routineHint.isEmpty()) {
		sleepSub = routineHint;
	} else if (sleep->time && sleep->endTime && sleepGoal) {
		sleepSub = tr::lng_parvane_planner_health_sleep_goal(
			tr::now,
			lt_from,
			Q(*sleep->time),
			lt_to,
			Q(*sleep->endTime),
			lt_goal,
			FormatSpan(*sleepGoal));
	} else if (sleepGoal) {
		sleepSub = tr::lng_parvane_planner_health_goal_value(tr::now, lt_value, FormatSpan(*sleepGoal));
	}
	auto kcalSub = QString();
	if (kcalGoal) {
		kcalSub = (kcal > *kcalGoal)
			? tr::lng_parvane_planner_health_kcal_over(tr::now, lt_value, FormatInt(std::llround(kcal - *kcalGoal)))
			: tr::lng_parvane_planner_kcal_left_of(
				tr::now,
				lt_left,
				FormatInt(std::llround(*kcalGoal - kcal)),
				lt_goal,
				FormatInt(std::llround(*kcalGoal)));
	}
	const auto kcalUnit = tr::lng_parvane_planner_health_kcal(tr::now, lt_value, QString()).trimmed();
	const auto openHealth = Fn<void()>([actions] {
		if (actions.openHealth) {
			actions.openHealth();
		}
	});
	const auto scrollTo = _scrollTo;
	const auto stats = std::vector<Stat>{
		{
			isShort ? Kind::Due : Kind::Sleep,
			tr::lng_parvane_planner_health_sleep(tr::now),
			sleep ? FormatSpan(sleep->value) : u"—"_q,
			QString(),
			sleep ? Share(sleep->value, sleepGoal) : 0.,
			sleepSub,
			openHealth,
		},
		{
			Kind::Food,
			tr::lng_parvane_planner_health_food(tr::now),
			FormatInt(kcal),
			u" "_q + kcalUnit,
			Share(double(kcal), kcalGoal),
			kcalSub,
			openHealth,
		},
		{
			Kind::Task,
			tr::lng_parvane_planner_view_tasks(tr::now),
			QString::number(doneCount),
			u" / "_q + QString::number(tasks.size()),
			Share(doneCount, tasks.empty() ? std::nullopt : std::optional<double>(tasks.size())),
			tasks.empty() ? tr::lng_parvane_planner_today_no_tasks(tr::now)
				: leftCount ? tr::lng_parvane_planner_today_left(tr::now, lt_amount, QString::number(leftCount))
				: tr::lng_parvane_planner_today_all_done(tr::now),
			[=] {
				if (scrollTo) {
					scrollTo(_tasksTop);
				}
			},
		},
		{
			isOver ? Kind::Due : Kind::Event,
			tr::lng_parvane_planner_section_title(tr::now),
			FormatHoursNumber(load),
			u" / "_q + FormatHours(budget),
			Share(load, budget),
			isOver ? tr::lng_parvane_planner_today_over(tr::now)
				: isShort ? tr::lng_parvane_planner_health_budget_reduced(tr::now)
				: tr::lng_parvane_planner_today_load(tr::now),
			[actions] {
				if (actions.openCalendar) {
					actions.openCalendar();
				}
			},
		},
	};

	// Четыре карточки в ряд, на узком месте — по две
	const auto columns = (width >= Kit::Rem(36)) ? 4 : 2;
	const auto gap = Kit::Rem(0.625);
	const auto cardWidth = (width - (columns - 1) * gap) / columns;
	const auto pad = Kit::Rem(1);
	const auto labelFont = Kit::Font(12, true, true);
	const auto valueFont = Kit::Font(24, true, true);
	const auto unitFont = Kit::Font(14, false, true);
	const auto subFont = Kit::Font(12);
	const auto inner = Kit::Rem(0.375);
	const auto subLine = std::max(Kit::Rem(1.125), subFont->height);
	const auto cardHeight = pad * 2 + labelFont->height + inner + valueFont->height + inner + Kit::Rem(0.375) + inner
		+ subLine;
	const auto rows = (int(stats.size()) + columns - 1) / columns;
	for (auto i = 0; i != int(stats.size()); ++i) {
		const auto &stat = stats[i];
		const auto rect = QRect(x + (i % columns) * (cardWidth + gap), y + (i / columns) * (cardHeight + gap), cardWidth,
			cardHeight);
		area(rect, stat.click);
		if (!p) {
			continue;
		}
		PaintCard(p, rect, over(rect));
		const auto color = KindColor(stat.kind);
		auto top = rect.y() + pad;
		const auto innerWidth = rect.width() - 2 * pad;
		DrawCaps(p, 12, color, rect.x() + pad, top + labelFont->ascent, stat.label, innerWidth);
		top += labelFont->height + inner;
		const auto valueWidth = DrawElided(p, valueFont, ToneColor(Tone::Fg), rect.x() + pad, top + valueFont->ascent,
			stat.value, innerWidth);
		if (!stat.unit.isEmpty()) {
			DrawElided(p, unitFont, ToneColor(Tone::Muted), rect.x() + pad + valueWidth, top + valueFont->ascent,
				stat.unit, innerWidth - valueWidth);
		}
		top += valueFont->height + inner;
		const auto prog = QRect(rect.x() + pad, top, innerWidth, Kit::Rem(0.375));
		p->setPen(Qt::NoPen);
		p->setBrush(ToneColor(Tone::Line));
		p->drawRoundedRect(prog, prog.height() / 2., prog.height() / 2.);
		if (stat.fraction > 0) {
			p->setBrush(color);
			p->drawRoundedRect(QRect(prog.x(), prog.y(), int(prog.width() * stat.fraction), prog.height()),
				prog.height() / 2., prog.height() / 2.);
		}
		top += prog.height() + inner;
		DrawElided(p, subFont, ToneColor(Tone::Muted), rect.x() + pad, top + (subLine - subFont->height) / 2
			+ subFont->ascent, stat.sub, innerWidth);
	}
	return rows * cardHeight + (rows - 1) * gap;
}

int TodayView::drawTasks(QPainter *p, int x, int y, int width) {
	const auto &state = _view->state;
	const auto entry = planner::getDayEntry(state, _day);
	// Несделанные — первыми, дальше по времени начала; без времени — в конце
	auto tasks = entry.tasks;
	std::stable_sort(tasks.begin(), tasks.end(), [](const planner::Task &a, const planner::Task &b) {
		const auto da = (a.status == "done");
		const auto db = (b.status == "done");
		if (da != db) {
			return db;
		}
		return a.start.value_or("99") < b.start.value_or("99");
	});
	const auto undated = planner::getUndatedTasks(state);
	auto active = std::vector<planner::Task>();
	auto queued = std::vector<planner::Task>();
	for (const auto &task : undated) {
		if (task.status == "active") {
			active.push_back(task);
		} else if (task.status == "queue") {
			queued.push_back(task);
		}
	}
	if (int(queued.size()) > kUndatedShown) {
		queued.resize(kUndatedShown);
	}

	const auto pad = Kit::Rem(1);
	const auto inner = QRect(x + pad, y + pad, width - 2 * pad, 0);
	auto top = inner.y();
	// Шапка карточки: «Задачи» и «+»
	const auto headHeight = Kit::Rem(2.25);
	const auto capsFont = Kit::Font(13, true, true);
	if (p) {
		DrawCaps(p, 13, ToneColor(Tone::Muted), inner.x(), top + (headHeight - capsFont->height) / 2 + capsFont->ascent,
			tr::lng_parvane_planner_view_tasks(tr::now), inner.width() - headHeight);
	}
	const auto actions = _actions;
	const auto day = _day;
	const auto today = _today;
	drawIconButton(p, QRect(inner.right() + 1 - headHeight, top, headHeight, headHeight), u"add"_q, [=] {
		// Задача на показанный день: без даты в строке она ушла бы в «Без даты»
		const auto date = DateOf(day);
		const auto dayWord = (day == today)
			? tr::lng_parvane_planner_today(tr::now).toLower()
			: (QString::number(date.day()).rightJustified(2, u'0') + u'.' + QString::number(date.month()).rightJustified(2, u'0'));
		if (actions.quick) {
			actions.quick(tr::lng_parvane_planner_kind_task(tr::now).toLower() + u' ' + dayWord + u' ');
		}
	});
	top += headHeight;
	const auto rowsLine = QRect(inner.x() - Kit::Rem(0.625), 0, inner.width() + Kit::Rem(1.25), 0);
	if (tasks.empty() && active.empty() && queued.empty()) {
		const auto font = Kit::Font(Kit::kBodyPx);
		DrawElided(p, font, ToneColor(Tone::Muted), inner.x(), top + font->ascent,
			tr::lng_parvane_planner_today_no_tasks(tr::now), inner.width());
		top += font->height;
	}
	for (const auto &task : tasks) {
		top += drawTaskRow(p, rowsLine.translated(0, top), state, task, _today, {});
	}
	const auto groupTitle = [&](const QString &text) {
		top += Kit::Rem(0.75);
		const auto line = Kit::Px(18);
		const auto font = Kit::Font(12, true, true);
		DrawCaps(p, 12, ToneColor(Tone::Muted), inner.x(), top + (line - font->height) / 2 + font->ascent, text,
			inner.width());
		top += line + Kit::Rem(0.125);
	};
	if (!active.empty()) {
		groupTitle(FormatStatus("active"));
		for (const auto &task : active) {
			top += drawTaskRow(p, rowsLine.translated(0, top), state, task, _today, {});
		}
	}
	if (!queued.empty()) {
		groupTitle(tr::lng_parvane_planner_undated_short(tr::now));
		for (const auto &task : queued) {
			top += drawTaskRow(p, rowsLine.translated(0, top), state, task, _today, {});
		}
	}
	if (!undated.empty()) {
		// «Все без даты» (`.rowUndated`): пунктир сверху, значок, число и стрелка
		top += Kit::Rem(0.375);
		const auto row = QRect(rowsLine.x(), top, rowsLine.width(), Kit::Rem(2.75));
		if (p) {
			if (over(row)) {
				p->setPen(Qt::NoPen);
				p->setBrush(ToneColor(Tone::Hover));
				p->drawRoundedRect(row, Kit::Rem(0.5), Kit::Rem(0.5));
			}
			p->setPen(QPen(ToneColor(Tone::Line2), 1, Qt::DashLine));
			p->drawLine(row.x(), row.y(), row.right(), row.y());
			const auto icon = Kit::Px(18);
			const auto padX = Kit::Rem(0.625);
			PaintPlannerIcon(*p, u"archive"_q, ToneColor(Tone::Muted), row.x() + padX, row.y() + (row.height() - icon) / 2,
				icon);
			PaintPlannerIcon(*p, u"next"_q, ToneColor(Tone::Muted), row.right() - padX - icon,
				row.y() + (row.height() - icon) / 2, icon);
			const auto metaFont = Kit::Font(13, false, true);
			const auto meta = QString::number(undated.size());
			const auto metaWidth = metaFont->width(meta);
			const auto metaX = row.right() - padX - icon - Kit::Rem(0.75) - metaWidth;
			DrawElided(p, metaFont, ToneColor(Tone::Muted), metaX, row.y() + (row.height() - metaFont->height) / 2
				+ metaFont->ascent, meta, metaWidth);
			const auto font = Kit::Font(Kit::kBodyPx);
			const auto textX = row.x() + padX + icon + Kit::Rem(0.75);
			DrawElided(p, font, ToneColor(Tone::Fg), textX, row.y() + (row.height() - font->height) / 2 + font->ascent,
				tr::lng_parvane_planner_undated_all(tr::now), metaX - Kit::Rem(0.75) - textX);
		}
		area(row, [=] { openUndated(); });
		top += row.height();
	}
	const auto height = top - y + pad;
	if (p) {
		// Фон карточки — под содержимым: рисуется первым проходом ниже
	}
	return height;
}

int TodayView::drawNote(QPainter *p, int x, int y, int width) {
	const auto pad = Kit::Rem(1);
	const auto inner = QRect(x + pad, y + pad, width - 2 * pad, 0);
	auto top = inner.y();
	const auto headHeight = Kit::Rem(2.25);
	const auto capsFont = Kit::Font(13, true, true);
	const auto title = notes::dailyNoteTitle(_day);
	const auto actions = _actions;
	const auto open = Fn<void()>([actions, title] {
		if (actions.openNote) {
			actions.openNote(Q(title));
		}
	});
	DrawCaps(p, 13, ToneColor(Tone::Muted), inner.x(), top + (headHeight - capsFont->height) / 2 + capsFont->ascent,
		tr::lng_parvane_planner_daily_note(tr::now), inner.width() / 2);
	// «Изменить» — правка заметки в «Знаниях» (правки на месте, как в web, на desktop нет)
	if (_note.known) {
		const auto text = tr::lng_parvane_planner_edit(tr::now);
		const auto widthButton = ButtonWidth(text, u"edit"_q);
		drawButton(p, QRect(inner.right() + 1 - widthButton, top, widthButton, headHeight), text, u"edit"_q, true, open);
	}
	top += headHeight;
	const auto font = Kit::Font(Kit::kBodyPx);
	if (_note.known && _note.text) {
		const auto preview = notes::previewLines(title, *_note.text, kPreviewLines);
		if (!preview.lines.empty()) {
			const auto lineHeight = Kit::Px(22);
			const auto gap = Kit::Rem(0.25);
			const auto start = top;
			for (const auto &line : preview.lines) {
				auto textX = inner.x();
				const auto markKind = line.mark.value_or(std::string());
				if (!markKind.empty() && markKind != "heading" && p) {
					if (markKind == "bullet") {
						const auto dot = Kit::Rem(0.375);
						Kit::PaintDot(*p, QPoint(inner.x() + Kit::Rem(0.25) + dot / 2, top + Kit::Rem(0.5) + dot / 2),
							ToneColor(Tone::Faint), dot);
					} else {
						const auto side = Kit::Rem(0.875);
						const auto circle = QRectF(inner.x() + 1, top + Kit::Rem(0.25) + 1, side - 2, side - 2);
						if (markKind == "done") {
							p->setPen(QPen(ToneColor(Tone::Accent), Kit::Px(2)));
							p->setBrush(ToneColor(Tone::Accent));
						} else {
							p->setPen(QPen(ToneColor(Tone::Line2), Kit::Px(2)));
							p->setBrush(Qt::NoBrush);
						}
						p->drawEllipse(circle);
					}
				}
				if (!markKind.empty() && markKind != "heading") {
					textX += Kit::Rem(0.875) + Kit::Rem(0.5);
				}
				const auto isDone = (markKind == "done");
				const auto lineFont = (markKind == "heading") ? Kit::Font(Kit::kBodyPx, true) : font;
				const auto color = isDone ? ToneColor(Tone::Faint) : ToneColor(Tone::Fg);
				const auto baseline = top + (lineHeight - lineFont->height) / 2 + lineFont->ascent;
				const auto widthText = DrawElided(p, lineFont, color, textX, baseline, Q(line.text), inner.right() - textX);
				if (p && isDone) {
					p->setPen(QPen(color, 1));
					p->drawLine(textX, baseline - lineFont->ascent / 3, textX + widthText, baseline - lineFont->ascent / 3);
				}
				top += lineHeight + gap;
			}
			if (preview.hasMore) {
				DrawElided(p, font, ToneColor(Tone::Faint), inner.x(), top + font->ascent, u"…"_q, inner.width());
				top += Kit::Rem(1);
			}
			area(QRect(inner.x(), start, inner.width(), top - start), open);
		}
	} else if (_note.known) {
		const auto text = tr::lng_parvane_planner_daily_note_write(tr::now);
		const auto rect = QRect(inner.x(), top, std::min(font->width(text), inner.width()), font->height);
		DrawElided(p, font, over(rect) ? ToneColor(Tone::Fg) : ToneColor(Tone::Muted), inner.x(), top + font->ascent,
			text, inner.width());
		area(rect, open);
		top += font->height;
	} else {
		top += DrawWrapped(p, font, ToneColor(Tone::Muted), QRect(inner.x(), top, inner.width(), 0),
			tr::lng_parvane_planner_daily_note_hint(tr::now), 0);
	}
	return top - y + pad;
}

int TodayView::drawSchedule(QPainter *p, int x, int y, int width) {
	const auto pad = Kit::Rem(1);
	const auto inner = QRect(x + pad, y + pad, width - 2 * pad, 0);
	auto top = inner.y();
	const auto headHeight = Kit::Rem(2.25);
	const auto capsFont = Kit::Font(13, true, true);
	DrawCaps(p, 13, ToneColor(Tone::Muted), inner.x(), top + (headHeight - capsFont->height) / 2 + capsFont->ascent,
		tr::lng_parvane_planner_schedule(tr::now), inner.width() / 2);
	const auto text = tr::lng_parvane_planner_health_food(tr::now);
	const auto buttonWidth = ButtonWidth(text, u"eats"_q);
	const auto actions = _actions;
	drawButton(p, QRect(inner.right() + 1 - buttonWidth, top, buttonWidth, headHeight), text, u"eats"_q, true, [actions] {
		if (actions.quick) {
			actions.quick(tr::lng_parvane_planner_meal_lunch(tr::now).toLower() + u' ');
		}
	});
	top += headHeight + Kit::Rem(0.5);
	top += drawFeed(p, inner.x(), top, inner.width(), _view->state, _day, _today, planner::Layers(), false);
	return top - y + pad;
}

int TodayView::draw(QPainter *p, int width) {
	if (!_view || _day.empty()) {
		return 0;
	}
	auto y = drawDateNav(p, width) + Kit::Rem(1);
	const auto gap = Kit::Rem(1);
	const auto stack = Kit::Rem(0.875);
	const auto twoColumns = (width >= Kit::Rem(kTwoColumnsMinRem));
	const auto sideWidth = twoColumns ? Kit::Rem(kSideRem) : 0;
	const auto mainWidth = twoColumns ? (width - sideWidth - gap) : width;

	// Левая колонка: сводка, задачи, заметка дня. Карточки меряются, затем рисуются по своему фону
	const auto card = [&](int top, int cardWidth, int x, auto drawer) {
		const auto height = (this->*drawer)(nullptr, x, top, cardWidth);
		if (p) {
			PaintCard(p, QRect(x, top, cardWidth, height));
			(this->*drawer)(p, x, top, cardWidth);
		} else {
			(this->*drawer)(nullptr, x, top, cardWidth);
		}
		return height;
	};
	const auto start = y;
	y += drawStats(p, 0, y, mainWidth) + stack;
	_tasksTop = y;
	y += card(y, mainWidth, 0, &TodayView::drawTasks) + stack;
	y += card(y, mainWidth, 0, &TodayView::drawNote);
	if (twoColumns) {
		const auto side = card(start, sideWidth, mainWidth + gap, &TodayView::drawSchedule);
		y = std::max(y, start + side);
	} else {
		y += stack;
		y += card(y, mainWidth, 0, &TodayView::drawSchedule);
	}
	return y;
}

} // namespace Parvane::PlannerViews
