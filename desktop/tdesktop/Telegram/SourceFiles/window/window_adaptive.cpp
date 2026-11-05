/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "window/window_adaptive.h"

#include "history/history_item.h"
#include "data/data_media_types.h"
#include "data/data_session.h"
#include "core/application.h"
#include "core/core_settings.h"

namespace Window {

Adaptive::Adaptive() = default;

void Adaptive::setWindowLayout(WindowLayout value) {
	_layout = value;
}

void Adaptive::setChatLayout(ChatLayout value) {
	_chatLayout = value;
}

rpl::producer<> Adaptive::value() const {
	return rpl::merge(
		Core::App().settings().adaptiveForWideValue() | rpl::to_empty,
		_chatLayout.changes() | rpl::to_empty,
		_layout.changes() | rpl::to_empty);
}

rpl::producer<> Adaptive::changes() const {
	return rpl::merge(
		Core::App().settings().adaptiveForWideChanges() | rpl::to_empty,
		_chatLayout.changes() | rpl::to_empty,
		_layout.changes() | rpl::to_empty);
}

rpl::producer<bool> Adaptive::oneColumnValue() const {
	return _layout.value(
	) | rpl::map([=] {
		return isOneColumn();
	});
}

rpl::producer<Adaptive::ChatLayout> Adaptive::chatLayoutValue() const {
	return _chatLayout.value();
}

bool Adaptive::isOneColumn() const {
	return _layout.current() == WindowLayout::OneColumn;
}

bool Adaptive::isNormal() const {
	return _layout.current() == WindowLayout::Normal;
}

bool Adaptive::isThreeColumn() const {
	return _layout.current() == WindowLayout::ThreeColumn;
}

// Parvane fork (5 ноя 2026): широкой раскладки чата нет, как в web — свои сообщения справа, чужие слева при любой
// ширине окна. Широкий режим tdesktop рисует все сообщения слева с аватарками и не сдвигает свои вправо
// (`Message::countGeometry`), поэтому в широком окне «всё слева» — отзыв пользователя.
rpl::producer<bool> Adaptive::chatWideValue() const {
	return rpl::single(false);
}

bool Adaptive::isChatWide() const {
	return false;
}

} // namespace Window
