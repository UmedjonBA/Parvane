// Parvane fork: выбор цветовой схемы (spec 029, T057) — web ColorSchemePicker: сетка карточек, каждая нарисована
// цветами самой схемы в текущем режиме (фон — её панель, подпись — её текст, рамка выбранной — её акцент),
// сверху — четыре образца. Выбор — Parvane::SetScheme (встроенная тема схемы).
#pragma once

#include "ui/rp_widget.h"

namespace Ui {
class VerticalLayout;
} // namespace Ui

namespace Parvane {

// Подраздел «Цветовая схема» с подсказкой — в настройки «Оформление»
void SetupSchemePicker(not_null<Ui::VerticalLayout*> container);

} // namespace Parvane
