// Parvane fork: ввод текстом «Плана» на desktop (spec 029, T061) — порт web PlannerQuickInput (строка → черновик
// записи, распознанное — чипами под полем, другие чтения, вид записи, подсказки из истории, данных «Плана» и
// примеров) и PlannerQuickHost (окно поверх другого раздела). Логика — ядро: planner_quick (разбор),
// planner_quick_apply (запись черновика), planner_quick_learn (словарь правок), planner_quick_suggest (подсказки).
#pragma once

#include "parvane/parvane_planner_common.h"

namespace Parvane::PlannerViews {

struct QuickArgs {
	QString initialText; // начало строки («задача сегодня ») либо пример вида («бег 5 км 30 мин»)
	std::string today;
	Fn<void(std::string day)> created; // день добавленной записи ("" — без дня)
	Fn<void()> more; // полная форма; пусто — кнопки «Подробнее» нет
};

// Открыть окно ввода текстом поверх `host`
void OpenQuickInput(not_null<QWidget*> host, QuickArgs args);

} // namespace Parvane::PlannerViews
