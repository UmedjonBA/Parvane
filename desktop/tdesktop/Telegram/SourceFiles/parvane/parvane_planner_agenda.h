// Parvane fork: вид «Список» «Плана» на desktop (spec 029, T061) — порт web PlannerAgenda (повестка на 30 дней от
// выбранного дня, пустые дни пропущены) и PlannerGroupBar (группы цветом с числом записей и часов, правка группы,
// «+ Группа», режим «Добавить в группу» с отметкой записей и «вместе с повторами»).
#pragma once

#include "parvane/parvane_planner_day.h"

#include <parvane/sections/planner_groups.h>

namespace Parvane::PlannerViews {

class AgendaView final : public Ui::RpWidget {
public:
	AgendaView(QWidget *parent, Actions actions);

	void setData(ViewPtr view, std::string day, std::string today);

	// Отмеченная запись: что добавить и как показать в предварительном списке
	struct Pick {
		planner::GroupPick pick;
		std::string name;
	};
	struct Shared;

protected:
	int resizeGetHeight(int newWidth) override;

private:
	class List;
	class Side;

	void relayout(int width);

	const Actions _actions;
	std::shared_ptr<Shared> _shared;
	List *_list = nullptr;
	Side *_side = nullptr;

};

} // namespace Parvane::PlannerViews
