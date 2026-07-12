/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "menu/menu_ttl_validator.h"

#include "apiwrap.h"
#include "data/data_channel.h"
#include "data/data_chat.h"
#include "data/data_peer.h"
#include "data/data_user.h"
#include "lang/lang_keys.h"
#include "main/session/session_show.h"
#include "main/main_session.h"
#include "menu/menu_ttl.h"
#include "ui/layers/generic_box.h"
#include "ui/layers/show.h"
#include "ui/text/text_utilities.h"
#include "ui/toast/toast.h"
#include "ui/text/format_values.h"
#include "styles/style_chat.h"
#include "styles/style_menu_icons.h"
#include "parvane/parvane_client.h" // Parvane: TTL локально, без MTProto

namespace TTLMenu {
namespace {

constexpr auto kToastDuration = crl::time(3500);

void ShowAutoDeleteToast(
		std::shared_ptr<Ui::Show> show,
		not_null<PeerData*> peer) {
	const auto period = peer->messagesTTL();
	if (!period) {
		show->showToast(tr::lng_ttl_about_tooltip_off(tr::now));
		return;
	}

	const auto duration = (period == 5)
		? u"5 seconds"_q
		: Ui::FormatTTL(period);
	const auto text = peer->isBroadcast()
		? tr::lng_ttl_about_tooltip_channel(tr::now, lt_duration, duration)
		: tr::lng_ttl_about_tooltip(tr::now, lt_duration, duration);
	show->showToast(text, kToastDuration);
}

} // namespace

TTLValidator::TTLValidator(
	std::shared_ptr<Ui::Show> show,
	not_null<PeerData*> peer)
: _peer(peer)
, _show(std::move(show)) {
}

Args TTLValidator::createArgs() const {
	const auto peer = _peer;
	const auto show = _show;
	auto callback = [=](
			TimeId period,
			Fn<void()>) {
		// Parvane: MTProto заглушён — ставим TTL ЛОКАЛЬНО (peer->messagesTTL) и
		// сохраняем у себя; исходящие в этот чат понесут ttl_secs в E2E-content.
		peer->setMessagesTTL(period);
		Parvane::OnPeerTtlChanged(peer);
		ShowAutoDeleteToast(show, peer);
		show->hideLayer();
	};
	auto about1 = peer->isUser()
		? tr::lng_ttl_edit_about(lt_user, rpl::single(peer->shortName()))
		: peer->isBroadcast()
		? tr::lng_ttl_edit_about_channel()
		: tr::lng_ttl_edit_about_group();
	auto about2 = tr::lng_ttl_edit_about2(
		lt_link,
		tr::lng_ttl_edit_about2_link(
		) | rpl::map([=](const QString &s) {
			return tr::link(s, "tg://settings/auto_delete");
		}),
		tr::marked);
	auto about = rpl::combine(
		std::move(about1),
		std::move(about2)
	) | rpl::map([](const QString &s1, TextWithEntities &&s2) {
		return TextWithEntities{ s1 }.append(u"\n\n"_q).append(std::move(s2));
	});
	const auto ttl = peer->messagesTTL();
	return { std::move(show), ttl, std::move(about), std::move(callback) };
}

bool TTLValidator::can() const {
	return (_peer->isUser()
			&& !_peer->isSelf()
			&& !_peer->isNotificationsUser()
			&& !_peer->asUser()->isInaccessible()
			&& !_peer->asUser()->starsPerMessage()
			&& !_peer->asUser()->isVerifyCodes()
			&& (!_peer->asUser()->requiresPremiumToWrite()
				|| _peer->session().premium()))
		|| (_peer->isChat()
			&& _peer->asChat()->canEditInformation()
			&& _peer->asChat()->amIn())
		|| (_peer->isChannel()
			&& _peer->asChannel()->canEditInformation()
			&& _peer->asChannel()->amIn());
}

void TTLValidator::showToast() const {
	ShowAutoDeleteToast(_show, _peer);
}

const style::icon *TTLValidator::icon() const {
	return &st::menuIconTTL;
}

void TTLValidator::showBox() const {
	if (Main::MakeSessionShow(_show, &_peer->session())->showFrozenError()) {
		return;
	}
	_show->showBox(Box(TTLBox, createArgs()));
}

} // namespace TTLMenu
