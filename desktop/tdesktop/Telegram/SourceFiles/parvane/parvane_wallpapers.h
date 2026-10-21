// Parvane fork: фоны чата как в web (spec 030, `api/parvane/wallpaperCombo.ts`, `wallpapers.ts`): сочетание
// градиента и одного из десяти рисунков пользователя, выбираемых раздельно; фон по умолчанию — рисунок
// science-mix в тонах текущей цветовой схемы (перерисовывается при смене схемы и дня/ночи); своя картинка —
// штатный путь tdesktop (`BackgroundPreviewBox`, с размытием). Обои с серверов Telegram не используются.
//
// Выбор хранится в `tdata/parvane-background`: "default:<схема>:<d|n>", "custom" или "combo-<градиент>_<рисунок>"
// (тот же вид, что slug web). Готовая картинка сочетания ставится как своя картинка (`Data::CustomWallPaper`),
// её сохраняет сам tdesktop (`Local::writeBackground`).
#pragma once

#include "base/object_ptr.h"

#include <QtCore/QString>
#include <QtGui/QImage>

#include <functional>

class QWidget;

namespace Ui {
class RpWidget;
} // namespace Ui

namespace Parvane::Wallpapers {

// Картинка фона по умолчанию (science-mix в тонах схемы).
[[nodiscard]] QImage RenderDefault();
// tdesktop поставил свою картинку пользователя (не наше сочетание и не фон по умолчанию).
void NoteCustomApplied();
// На время восстановления сохранённого фона (`Local::readBackground` — запуск, смена схемы или ночного режима):
// это не выбор пользователя, «своя картинка» не отмечается — иначе фон по умолчанию после первого же перезапуска
// переставал следовать за схемой.
class RestoreScope final {
public:
	RestoreScope();
	~RestoreScope();
};
// Подписка на смену палитры: фон по умолчанию перерисовывается под новую схему/режим. Звать после подъёма окна.
void Start();
// Поставить фон по умолчанию. window_theme.cpp зовёт вместо фона по умолчанию/пустого фона темы Telegram.
void ApplyDefault();

// Выбор фона (вместо галереи обоев Telegram в окне «Фон для чатов»).
[[nodiscard]] object_ptr<Ui::RpWidget> CreatePicker(QWidget *parent);

} // namespace Parvane::Wallpapers
