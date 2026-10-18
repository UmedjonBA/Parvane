// Parvane fork: шапка календаря «Плана» на desktop (spec 029, T061) — порт web PlannerPeriodBar (заголовок-кнопка
// периода с выбором месяца и года, стрелки, «Текущая дата», слои, переключатель вида «Сегодня / Неделя / Месяц /
// Год / Список», настройки и «+ Запись») и PlannerLayerChips (слои сон / еда / дела).
#pragma once

#include "parvane/parvane_planner_common.h"

namespace Parvane::PlannerViews {

class PeriodBar final : public Ui::RpWidget {
public:
	struct Callbacks {
		Fn<void()> prev;
		Fn<void()> next;
		Fn<void()> today;
		Fn<void(std::string)> pickDay;
		Fn<void(QString)> segment; // today | week | month | year | agenda
		Fn<void(QString)> toggleLayer; // sleep | food | work
		Fn<void()> settings;
		Fn<void()> add;
	};
	PeriodBar(QWidget *parent, Callbacks callbacks);

	struct State {
		bool isToday = false; // экран без периода: вместо заголовка, стрелок и слоёв — название экрана
		QString title;
		QString prevLabel;
		QString nextLabel;
		std::string picked;
		std::string today;
		QString segment;
		planner::Layers layers;
	};
	void setState(State state);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	class TitleButton;

	void relayout(int width);
	void openPicker();

	const Callbacks _callbacks;
	State _state;
	TitleButton *_title = nullptr;
	IconBtn *_prev = nullptr;
	IconBtn *_next = nullptr;
	Kit::Pill *_jump = nullptr;
	std::vector<Kit::Chip*> _layers;
	Kit::Segments *_segments = nullptr;
	IconBtn *_settings = nullptr;
	IconBtn *_add = nullptr;
	std::vector<QString> _segmentValues;

};

} // namespace Parvane::PlannerViews
