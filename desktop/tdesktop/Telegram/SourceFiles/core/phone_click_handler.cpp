/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "core/phone_click_handler.h"

#include "boxes/add_contact_box.h"
#include "core/click_handler_types.h"
#include "data/data_session.h"
#include "data/data_user.h"
#include "info/profile/info_profile_values.h"
#include "lang/lang_keys.h"
#include "main/main_session.h"
#include "mainwidget.h"
#include "mtproto/sender.h"
#include "ui/effects/ripple_animation.h"
#include "ui/painter.h"
#include "ui/rect.h"
#include "ui/widgets/menu/menu_item_base.h"
#include "ui/widgets/popup_menu.h"
#include "window/window_controller.h"
#include "window/window_session_controller.h"
#include "styles/style_calls.h"
#include "styles/style_chat.h" // popupMenuExpandedSeparator.
#include "styles/style_menu_icons.h"

PhoneClickHandler::PhoneClickHandler(
	not_null<Main::Session*> session,
	QString text)
: _session(session)
, _text(text) {
	setProperty(kPhoneNumberLinkProperty, _text);
}

void PhoneClickHandler::onClick(ClickContext context) const {
	if (context.button != Qt::LeftButton) {
		return;
	}
	const auto my = context.other.value<ClickHandlerContext>();
	const auto controller = my.sessionWindow.get();
	const auto pos = QCursor::pos();
	if (!controller) {
		return;
	}
	const auto menu = Ui::CreateChild<Ui::PopupMenu>(
		controller->content(),
		st::popupMenuWithIcons);

	const auto phone = _text;

	menu->addAction(tr::lng_profile_copy_phone(tr::now), [=] {
		TextUtilities::SetClipboardText(
			TextForMimeData::Simple(phone.trimmed()));
	}, &st::menuIconCopy);

	// Parvane: поиск аккаунта по номеру (contacts.resolvePhone) и «Добавить в контакты» по номеру — MTProto,
	// аккаунты Parvane адресуются ником. Остаётся «Копировать номер».
	menu->popup(pos);
}

auto PhoneClickHandler::getTextEntity() const -> TextEntity {
	return { EntityType::Phone };
}

QString PhoneClickHandler::tooltip() const {
	return _text;
}
