// Parvane fork: вид «Сегодня» «Плана» на desktop (spec 029, T061) — порт web PlannerToday (сводка четырьмя
// карточками, задачи дня и «в работе», расписание), PlannerDateNav (шапка дня), PlannerDailyNote (заметка дня —
// только чтение начала текста) и PlannerUndated (задачи без даты — шторкой).
#pragma once

#include "parvane/parvane_planner_day.h"

namespace Parvane::PlannerViews {

class TodayView final : public PlannerCanvas {
public:
	// `shiftDay` — стрелки дней, `jumpToday` — «Текущая дата»
	TodayView(QWidget *parent, Actions actions, Fn<void(int)> shiftDay, Fn<void()> jumpToday);

	void setData(ViewPtr view, std::string day, std::string today);
	// Прокрутка раздела к точке вида (карточка «Задачи» по нажатию на сводку)
	void setScrollTo(Fn<void(int)> scrollTo);

protected:
	int draw(QPainter *p, int width) override;

private:
	struct NotePeek {
		std::string day;
		bool known = false; // ответ пришёл
		std::optional<std::string> text; // нет — заметки на этот день ещё нет
	};

	int drawDateNav(QPainter *p, int width);
	int drawStats(QPainter *p, int x, int y, int width);
	int drawTasks(QPainter *p, int x, int y, int width);
	int drawNote(QPainter *p, int x, int y, int width);
	int drawSchedule(QPainter *p, int x, int y, int width);
	void requestNote();
	void openUndated();

	const Fn<void(int)> _shiftDay;
	const Fn<void()> _jumpToday;
	Fn<void(int)> _scrollTo;
	ViewPtr _view;
	std::string _day;
	std::string _today;
	NotePeek _note;
	int _tasksTop = 0;
	rpl::lifetime _noteLifetime;

};

} // namespace Parvane::PlannerViews
