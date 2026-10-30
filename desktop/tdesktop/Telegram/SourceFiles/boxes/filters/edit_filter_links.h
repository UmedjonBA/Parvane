/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#pragma once

#include "base/object_ptr.h"

class PeerListRow;

namespace Ui {
class Show;
class BoxContent;
class VerticalLayout;
} // namespace Ui

namespace Data {
class ChatFilter;
struct ChatFilterLink;
} // namespace Data

namespace Window {
class SessionController;
} // namespace Window

[[nodiscard]] QString FilterChatStatusText(not_null<PeerData*> peer);

void AddFilterSubtitleWithToggles(
	not_null<Ui::VerticalLayout*> container,
	rpl::producer<QString> text,
	int selectableCount,
	rpl::producer<int> selectedCount,
	Fn<void(bool select)> toggle);

[[nodiscard]] std::unique_ptr<PeerListRow> MakeFilterChatRow(
	not_null<PeerData*> peer,
	const QString &status,
	bool disabled);
