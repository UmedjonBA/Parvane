// Parvane fork: окна «Плана» (spec 029, T061/T062) — редакторы задачи и события (web PlannerTaskEditor,
// PlannerEventEditor, PlannerTaskForm), настройки «Плана» (PlannerSettings). Экраны видов (parvane_planner_*)
// открывают их отсюда; правки идут через Parvane::Sections::UpdatePlanner.
#pragma once

#include <string>

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::PlannerUi {

// Новая задача (taskId пусто; day — день по умолчанию YYYY-MM-DD либо пусто — без даты) или правка задачи
void OpenTaskEditor(
	not_null<Window::SessionController*> controller,
	const std::string &taskId,
	const std::string &day);

// Новое событие (eventId пусто) или правка; instanceDay — день экземпляра повторяющегося события (вопрос
// «Только это / Это и следующие / Все» — web PlannerSeriesPrompt)
void OpenEventEditor(
	not_null<Window::SessionController*> controller,
	const std::string &eventId,
	const std::string &day,
	const std::string &instanceDay);

void OpenPlannerSettings(not_null<Window::SessionController*> controller);

} // namespace Parvane::PlannerUi
