// Parvane fork: строки задач, лента дня и день календаря «Плана» на desktop (spec 029, T061) — порт web
// PlannerTaskRow, PlannerDayFeed, PlannerDayPanel (`island` — правая панель календаря, `card` — карточка),
// PlannerName (ссылки `[[заметка]]`).
#pragma once

#include "parvane/parvane_planner_common.h"

namespace Ui {
class ScrollArea;
} // namespace Ui

namespace Parvane::PlannerViews {

// Холст «Плана»: строка задачи и лента дня рисуются им самим (области нажатия — его же)
class PlannerCanvas : public Canvas {
public:
	PlannerCanvas(QWidget *parent, Actions actions);

protected:
	struct RowOptions {
		bool contextAll = false; // строка в списках: дата и группа в подписи
		bool noProject = false;
		QString assignLabel; // кнопка справа (назначить день задаче без даты)
		Fn<void()> assign;
		Fn<void()> open; // нажатие на строку; по умолчанию — карточка задачи
	};
	// Строка задачи (`.row`): галочка, название, подпись, справа время и оценка. Возвращает высоту
	int drawTaskRow(QPainter *p, QRect line, const planner::State &state, const planner::Task &task,
		const std::string &today, const RowOptions &options);
	// Лента дня по времени (`.feed`); `onPanel` — фон блоков — панель острова. Возвращает высоту
	int drawFeed(QPainter *p, int x, int y, int width, const planner::State &state, const std::string &day,
		const std::string &today, const planner::Layers &layers, bool onPanel);
	// Кнопка `.btn` (и `.btnGhost`) со значком; возвращает ширину
	int drawButton(QPainter *p, QRect rect, const QString &text, const QString &icon, bool ghost, Fn<void()> click);
	[[nodiscard]] static int ButtonWidth(const QString &text, const QString &icon);
	// Пилюля `.pill` (2.125rem) — ширина по тексту; круглая кнопка `.ib` (2.25rem)
	[[nodiscard]] static int PillWidth(const QString &text);
	void drawPill(QPainter *p, QRect rect, const QString &text, Fn<void()> click);
	void drawIconButton(QPainter *p, QRect rect, const QString &icon, Fn<void()> click, bool accent = false);
	void linkArea(QRect rect, const std::string &note);

	const Actions _actions;

};

// Сводка, задачи без времени, лента и «Добавить на этот день» (web PlannerDayPanel без шапки)
class DayBody final : public PlannerCanvas {
public:
	enum class Variant {
		Island,
		Card,
	};
	DayBody(QWidget *parent, Actions actions, Variant variant);

	void setData(ViewPtr view, std::string day, std::string today, planner::Layers layers);

protected:
	int draw(QPainter *p, int width) override;

private:
	const Variant _variant;
	ViewPtr _view;
	std::string _day;
	std::string _today;
	planner::Layers _layers;
	bool _sleepHint = false;

};

// Правая панель календаря (`aside.side`): шапка дня со стрелками и тело дня в прокрутке
class DayIsland final : public Kit::Island {
public:
	DayIsland(QWidget *parent, Actions actions, Fn<void(int)> shiftDay);

	void setData(ViewPtr view, std::string day, std::string today, planner::Layers layers);

protected:
	void paintEvent(QPaintEvent *e) override;
	void resizeEvent(QResizeEvent *e) override;

private:
	void relayout();

	std::string _day;
	std::string _today;
	IconBtn *_prev = nullptr;
	IconBtn *_next = nullptr;
	Ui::ScrollArea *_scroll = nullptr;
	DayBody *_body = nullptr;

};

} // namespace Parvane::PlannerViews
