// Parvane fork: экран «Здоровье» (spec 029, T062) — порт web `planner/PlannerHealth.tsx` с шапкой раздела
// (`Planner.tsx`: «Здоровье», настройки, «+ Запись») и строкой даты (`PlannerDateNav.tsx`). Питание, вода и тело,
// сон и режим сна, активность, калории недели; всё вводится текстом. Регистрация экрана в месте разделов —
// `Parvane::RegisterPlannerHealth()` (parvane_sections_host.h).
#pragma once

#include <QtCore/QString>

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::Health {

// Ввод текстом (строка → запись «Здоровья», цели и настройки): окно с готовым текстом, например примером
void OpenQuickEntry(not_null<Window::SessionController*> controller, const QString &text);

// «Настройки здоровья» (шестерёнка экрана): цели и их правка текстом
void OpenGoals(not_null<Window::SessionController*> controller);

} // namespace Parvane::Health
