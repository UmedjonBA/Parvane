// Parvane fork: окна аккаунта поверх штатных виджетов tdesktop (как web «Устройства», spec 015/029):
// привязка нового устройства (ответ боту в Telegram ключом восстановления, код сверки с другим устройством,
// вход по ключу, сброс личности), ключ восстановления, выбор способа завершить сеанс, блоки экрана
// «Устройства» (ключ подписи устройств, вышедшие устройства, страховочная копия, ключ в Telegram).
#pragma once

#include "base/basic_types.h"

class QString;

namespace Ui {
class VerticalLayout;
} // namespace Ui

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

// Окно «Подтвердите вход»: открывается, когда устройству нужна привязка; закрывается само после привязки.
void ShowLinkingBox();

// Ключ восстановления, который не ушёл в Telegram: показывается один раз.
void ShowRecoveryKeyBox(const QString &key);

// Пароль и способ завершить сеанс(ы) другого своего устройства: «просто выйти» или «выйти и сменить ключи».
void AskSignOutPassword(
	bool many,
	Fn<void(QString password, bool rotateKeys)> done,
	Fn<void()> cancelled);

// Смена ника (spec 026): новый ник, пароль, ключ восстановления.
void ShowRenameBox(not_null<Window::SessionController*> controller);

// Удаление аккаунта (spec 027): 7 дней отсрочки, затем выход на экран входа.
void ShowDeleteAccountBox(not_null<Window::SessionController*> controller);

// Блоки над списком устройств экрана «Устройства».
void AddDevicesExtras(
	not_null<Ui::VerticalLayout*> container,
	not_null<Window::SessionController*> controller);

} // namespace Parvane
