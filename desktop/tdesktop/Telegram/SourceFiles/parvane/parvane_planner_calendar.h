// Parvane fork: виды календаря «Плана» на desktop (spec 029, T061) — неделя по часам (web PlannerWeek), месяц
// (PlannerMonth) и год (PlannerYear). Данные — снимок «Плана»; нажатия уходят оболочке раздела через Actions.
#pragma once

#include "parvane/parvane_planner_day.h"

namespace Ui {
class ScrollArea;
} // namespace Ui

namespace Parvane::PlannerViews {

// Неделя: шапки дней и строка «весь день» стоят на месте, сетка часов листается сама
class WeekView final : public Ui::RpWidget {
public:
	WeekView(QWidget *parent, Actions actions);

	void setData(ViewPtr view, std::string picked, std::string today, planner::Layers layers);

	struct Column;
	struct Grid;

protected:
	void resizeEvent(QResizeEvent *e) override;
	void paintEvent(QPaintEvent *e) override;

private:
	class Head;
	class Hours;

	void relayout();
	void scrollToStart();

	const Actions _actions;
	std::shared_ptr<Grid> _grid;
	Head *_head = nullptr;
	Ui::ScrollArea *_scroll = nullptr;
	Hours *_hours = nullptr;
	std::string _firstDay;

};

// Месяц: полные недели, в клетке — число, часы, сон и первые дела; перетаскивание задачи на другой день
class MonthView final : public PlannerCanvas {
public:
	MonthView(QWidget *parent, Actions actions);

	void setData(ViewPtr view, std::string picked, std::string today, planner::Layers layers);

protected:
	int draw(QPainter *p, int width) override;
	void dropped(const QString &key, QPoint point) override;

private:
	ViewPtr _view;
	std::string _picked;
	std::string _today;
	planner::Layers _layers;
	std::vector<std::pair<QRect, std::string>> _cells;

};

// Год: двенадцать месяцев, насыщенность клетки — загрузка дня; нажатие открывает месяц
class YearView final : public PlannerCanvas {
public:
	YearView(QWidget *parent, Actions actions);

	void setData(ViewPtr view, std::string picked, std::string today);

protected:
	int draw(QPainter *p, int width) override;

private:
	ViewPtr _view;
	std::string _picked;
	std::string _today;
	planner::DayIndex _index;
	int _year = 0;

};

} // namespace Parvane::PlannerViews
