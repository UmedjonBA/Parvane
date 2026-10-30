/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "boxes/filters/edit_filter_links.h"

#include "boxes/peer_list_box.h"
#include "data/data_channel.h"
#include "data/data_chat.h"
#include "lang/lang_keys.h"
#include "ui/controls/invite_link_buttons.h"
#include "ui/vertical_list.h"
#include "ui/widgets/buttons.h"
#include "ui/wrap/vertical_layout.h"
#include "ui/painter.h"
#include "styles/style_layers.h"
#include "styles/style_settings.h"

namespace {

class ChatRow final : public PeerListRow {
public:
	ChatRow(not_null<PeerData*> peer, const QString &status, bool disabled);

	PaintRoundImageCallback generatePaintUserpicCallback(
		bool forceRound) override;

private:
	const bool _disabled = false;
	QImage _disabledFrame;
	InMemoryKey _userpicKey;
	int _paletteVersion = 0;

};

ChatRow::ChatRow(
	not_null<PeerData*> peer,
	const QString &status,
	bool disabled)
: PeerListRow(peer)
, _disabled(disabled) {
	if (!status.isEmpty()) {
		setCustomStatus(status);
	}
}

PaintRoundImageCallback ChatRow::generatePaintUserpicCallback(
		bool forceRound) {
	const auto peer = this->peer();
	const auto saved = peer->isSelf();
	const auto replies = peer->isRepliesChat();
	auto userpic = (saved || replies)
		? Ui::PeerUserpicView()
		: ensureUserpicView();
	auto paint = [=](
			Painter &p,
			int x,
			int y,
			int outerWidth,
			int size) mutable {
		using namespace Ui;
		if (forceRound && peer->isForum()) {
			ForceRoundUserpicCallback(peer)(p, x, y, outerWidth, size);
		} else if (saved) {
			EmptyUserpic::PaintSavedMessages(p, x, y, outerWidth, size);
		} else if (replies) {
			EmptyUserpic::PaintRepliesMessages(p, x, y, outerWidth, size);
		} else {
			peer->paintUserpicLeft(p, userpic, x, y, outerWidth, size);
		}
	};
	if (!_disabled) {
		return paint;
	}
	return [=](
			Painter &p,
			int x,
			int y,
			int outerWidth,
			int size) mutable {
		const auto wide = size + style::ConvertScale(3);
		const auto full = QSize(wide, wide) * style::DevicePixelRatio();
		auto repaint = false;
		if (_disabledFrame.size() != full) {
			repaint = true;
			_disabledFrame = QImage(
				full,
				QImage::Format_ARGB32_Premultiplied);
			_disabledFrame.setDevicePixelRatio(style::DevicePixelRatio());
		} else {
			repaint = (_paletteVersion != style::PaletteVersion())
				|| (!saved
					&& !replies
					&& (_userpicKey != peer->userpicUniqueKey(userpic)));
		}
		if (repaint) {
			_paletteVersion = style::PaletteVersion();
			_userpicKey = peer->userpicUniqueKey(userpic);

			_disabledFrame.fill(Qt::transparent);
			auto p = Painter(&_disabledFrame);
			paint(p, 0, 0, wide, size);

			auto hq = PainterHighQualityEnabler(p);
			p.setBrush(st::boxBg);
			p.setPen(Qt::NoPen);
			const auto two = style::ConvertScaleExact(2.5);
			const auto half = size / 2.;
			const auto rect = QRectF(half, half, half, half).translated(
				{ two, two });
			p.drawEllipse(rect);

			auto pen = st::windowSubTextFg->p;
			const auto width = style::ConvertScaleExact(1.5);
			const auto dash = 0.55;
			const auto dashWithCaps = dash + 1.;
			pen.setWidthF(width);
			// 11 parts = M_PI * half / ((dashWithCaps + space) * width)
			// 11 = M_PI * half / ((dashWithCaps + space) * width)
			// space = (M_PI * half / (11 * width)) - dashWithCaps
			const auto space = M_PI * half / (11 * width) - dashWithCaps;
			pen.setDashPattern(QVector<qreal>{ dash, space });
			pen.setDashOffset(1.);
			pen.setCapStyle(Qt::RoundCap);
			p.setBrush(Qt::NoBrush);
			p.setPen(pen);
			p.drawEllipse(rect.marginsRemoved({ two, two, two, two }));
		}
		p.drawImage(x, y, _disabledFrame);
	};
}

} // namespace

QString FilterChatStatusText(not_null<PeerData*> peer) {
	if (const auto chat = peer->asChat()) {
		if (const auto count = chat->count; count > 0) {
			return tr::lng_chat_status_members(tr::now, lt_count, count);
		}
	} else if (const auto channel = peer->asChannel()) {
		if (channel->membersCountKnown()) {
			return (channel->isBroadcast()
				? tr::lng_chat_status_subscribers
				: tr::lng_chat_status_members)(
					tr::now,
					lt_count_decimal,
					channel->membersCount());
		}
	}
	return QString();
}

void AddFilterSubtitleWithToggles(
		not_null<Ui::VerticalLayout*> container,
		rpl::producer<QString> text,
		int selectableCount,
		rpl::producer<int> selectedCount,
		Fn<void(bool select)> toggle) {
	using namespace rpl::mappers;

	const auto selectable = (selectableCount > 0);
	auto padding = st::filterLinkSubsectionTitlePadding;
	if (selectable) {
		const auto font = st::boxLinkButton.font;
		padding.setRight(padding.right() + font->spacew + std::max(
			font->width(tr::lng_filters_by_link_select(tr::now)),
			font->width(tr::lng_filters_by_link_deselect(tr::now))));
	}
	const auto title = Ui::AddSubsectionTitle(
		container,
		std::move(text),
		padding);
	if (!selectable) {
		return;
	}
	const auto link = Ui::CreateChild<Ui::LinkButton>(
		container.get(),
		tr::lng_filters_by_link_select(tr::now),
		st::boxLinkButton);
	const auto canSelect = link->lifetime().make_state<rpl::variable<bool>>(
		std::move(selectedCount) | rpl::map(_1 < selectableCount));
	canSelect->value(
	) | rpl::on_next([=](bool can) {
		link->setText(can
			? tr::lng_filters_by_link_select(tr::now)
			: tr::lng_filters_by_link_deselect(tr::now));
	}, link->lifetime());
	link->setClickedCallback([=] {
		toggle(canSelect->current());
	});

	rpl::combine(
		container->widthValue(),
		title->topValue(),
		link->widthValue()
	) | rpl::on_next([=](int outer, int y, int width) {
		link->move(outer - st::boxRowPadding.right() - width, y);
	}, link->lifetime());
}

std::unique_ptr<PeerListRow> MakeFilterChatRow(
		not_null<PeerData*> peer,
		const QString &status,
		bool disabled) {
	return std::make_unique<ChatRow>(peer, status, disabled);
}

