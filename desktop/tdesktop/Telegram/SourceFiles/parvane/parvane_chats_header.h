// Parvane fork: шапка списка чатов «Пространство» (spec 029, T056) — как web LeftMainHeader `.left-header--chats`:
// слева заголовок «Чаты», поиск свёрнут в пилюлю, справа акцентная «Написать» с меню (новое сообщение, группа,
// канал, запись в план). По фокусу или запросу поиск разворачивается на всю шапку, заголовок и «Написать» прячутся.
// Поле поиска остаётся штатным (Dialogs::Widget), шапка лишь отдаёт ему место.
#pragma once

#include "base/unique_qptr.h"
#include "ui/rp_widget.h"

namespace Ui {
class PopupMenu;
} // namespace Ui

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

namespace Kit {
class Pill;
} // namespace Kit

class ChatsHeader final {
public:
	ChatsHeader(not_null<Ui::RpWidget*> parent, not_null<Window::SessionController*> controller);
	~ChatsHeader();

	// area — полоса поиска в родителе (от левого поля до правого), search — штатное место поля поиска по
	// вертикали. collapsed — поиск свёрнут в пилюлю. Возвращает прямоугольник для поля поиска.
	[[nodiscard]] QRect layout(QRect area, QRect search, bool collapsed);
	void raise();

private:
	void showComposeMenu();

	const not_null<Ui::RpWidget*> _parent;
	const not_null<Window::SessionController*> _controller;
	base::unique_qptr<Ui::RpWidget> _title;
	base::unique_qptr<Kit::Pill> _compose;
	base::unique_qptr<Ui::PopupMenu> _menu;
	bool _compact = false;

};

} // namespace Parvane
