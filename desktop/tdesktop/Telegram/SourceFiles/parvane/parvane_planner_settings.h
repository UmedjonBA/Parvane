// Parvane fork: настройки «Плана» (spec 029, T061) — порт web `planner/PlannerSettings.tsx`: окна и бюджет дня,
// сброс, «Сбросить выученное», расписание на неделю текстом, «Очистить план». Каждое поле сохраняется само по
// завершении ввода; негодное значение не применяется и объясняется подсказкой.
#pragma once

#include "base/object_ptr.h"

class QWidget;

namespace Ui {
class RpWidget;
} // namespace Ui

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::PlannerForms {

[[nodiscard]] object_ptr<Ui::RpWidget> MakePlannerSettings(
	QWidget *parent,
	not_null<Window::SessionController*> controller);

} // namespace Parvane::PlannerForms
