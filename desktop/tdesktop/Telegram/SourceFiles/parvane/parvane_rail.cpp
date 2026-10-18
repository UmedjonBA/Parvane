// Parvane fork: реализация parvane_rail.h — размеры и тона как web FoldersSidebar.module.scss
// (плитка 62 px, значок 22, подпись 11 px, скругление 12, активный — `--pv-raised` и акцент).
#include "parvane/parvane_rail.h"

#include "parvane/parvane_icons.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_space.h"

#include "core/shortcuts.h"
#include "data/data_session.h"
#include "data/data_unread_value.h"
#include "dialogs/dialogs_main_list.h"
#include "lang/lang_keys.h"
#include "main/main_session.h"
#include "ui/painter.h"
#include "window/window_session_controller.h"
#include "styles/style_basic.h"

namespace Parvane {
namespace {

// Размеры web в px; на экране — с масштабом интерфейса (Kit::Px)
constexpr auto kItemWidthPx = 62;
constexpr auto kIconSizePx = 22;
constexpr auto kRadiusPx = 12;
constexpr auto kSections = 5; // Чаты, Календарь, Здоровье, Знания, Облако; дальше — Поиск, Профиль

[[nodiscard]] Section SectionAt(int index) {
	switch (index) {
	case 1: return Section::Calendar;
	case 2: return Section::Health;
	case 3: return Section::Knowledge;
	case 4: return Section::Files;
	}
	return Section::Chats;
}

[[nodiscard]] style::font TitleFont() {
	return Kit::Font(11);
}

[[nodiscard]] style::font LogoFont() {
	return Kit::Font(13, true, true);
}

[[nodiscard]] style::font BadgeFont() {
	return Kit::Font(11, true, true);
}

} // namespace

SectionRail::SectionRail(QWidget *parent, not_null<Window::SessionController*> controller)
: RpWidget(parent)
, _controller(controller) {
	setMouseTracking(true);
	refreshTitles();
	// Первый запуск: схема по умолчанию, как web (gruvbox)
	crl::on_main(this, [] { EnsureSchemeApplied(); });

	sizeValue() | rpl::on_next([=] {
		layoutItems();
	}, lifetime());

	rpl::merge(
		SectionValue() | rpl::to_empty,
		TonesChanges()
	) | rpl::on_next([=] {
		update();
	}, lifetime());

	Lang::Updated() | rpl::on_next([=] {
		refreshTitles();
		update();
	}, lifetime());

	// Счётчик непрочитанных у «Чатов» — как у кнопки «Все чаты» папок
	Data::UnreadStateValue(
		&controller->session(),
		FilterId()
	) | rpl::on_next([=](const Dialogs::UnreadState &state) {
		const auto muted = state.chatsMuted + state.marksMuted;
		_unread = std::max(state.chats + state.marks - muted, 0);
		update();
	}, lifetime());
}

void SectionRail::refreshTitles() {
	_items = {
		{ u"chat"_q, tr::lng_parvane_rail_chats(tr::now) },
		{ u"calendar"_q, tr::lng_parvane_rail_calendar(tr::now) },
		{ u"heart"_q, tr::lng_parvane_rail_health(tr::now) },
		{ u"book"_q, tr::lng_parvane_rail_knowledge(tr::now) },
		{ u"cloud"_q, tr::lng_parvane_rail_cloud(tr::now) },
		{ u"search"_q, tr::lng_parvane_rail_search(tr::now) },
		{ u"user"_q, tr::lng_parvane_rail_profile(tr::now) },
	};
	layoutItems();
}

void SectionRail::layoutItems() {
	const auto itemHeight = Kit::Px(8) + Kit::Px(kIconSizePx) + Kit::Px(3) + TitleFont()->height + Kit::Px(6);
	const auto left = (width() - Kit::Px(kItemWidthPx)) / 2;
	auto top = Kit::Px(12) + LogoFont()->height + Kit::Px(14);
	for (auto i = 0; i != kSections; ++i) {
		_items[i].rect = QRect(left, top, Kit::Px(kItemWidthPx), itemHeight);
		top += itemHeight + Kit::Px(4);
	}
	// Поиск и Профиль — прижаты к низу
	auto bottom = height() - Kit::Px(12);
	for (auto i = int(_items.size()) - 1; i >= kSections; --i) {
		bottom -= itemHeight;
		_items[i].rect = QRect(left, std::max(bottom, top), Kit::Px(kItemWidthPx), itemHeight);
		bottom -= Kit::Px(4);
	}
}

int SectionRail::itemAt(QPoint point) const {
	for (auto i = 0, count = int(_items.size()); i != count; ++i) {
		if (_items[i].rect.contains(point)) {
			return i;
		}
	}
	return -1;
}

bool SectionRail::isActive(int index) const {
	return (index < kSections) && (CurrentSection() == SectionAt(index));
}

void SectionRail::activate(int index) {
	if (index < 0) {
		return;
	} else if (index < kSections) {
		ShowSection(SectionAt(index));
	} else if (index == kSections) {
		// Общий поиск: палитра Ctrl+K появится с разделами, пока — поиск по чатам
		ShowSection(Section::Chats);
		Shortcuts::Launch(Shortcuts::Command::Search);
	} else {
		ShowSection(Section::Chats);
		_controller->showSettings();
	}
}

void SectionRail::paintEvent(QPaintEvent *e) {
	auto p = Painter(this);
	PainterHighQualityEnabler hq(p);
	p.fillRect(e->rect(), ToneColor(Tone::Bg));

	p.setFont(LogoFont());
	p.setPen(ToneColor(Tone::Accent));
	p.drawText(QRect(0, Kit::Px(12), width(), LogoFont()->height), u"parvane"_q, style::al_center);

	for (auto i = 0, count = int(_items.size()); i != count; ++i) {
		const auto &item = _items[i];
		const auto active = isActive(i);
		const auto over = (i == _over);
		if (active || over) {
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(active ? Tone::Raised : Tone::Hover));
			p.drawRoundedRect(item.rect, Kit::Px(kRadiusPx), Kit::Px(kRadiusPx));
		}
		const auto color = ToneColor(active ? Tone::Accent : over ? Tone::Fg : Tone::Muted);
		const auto iconLeft = item.rect.x() + (item.rect.width() - Kit::Px(kIconSizePx)) / 2;
		const auto iconTop = item.rect.y() + Kit::Px(8);
		PaintIcon(p, item.icon, color, iconLeft, iconTop, Kit::Px(kIconSizePx));

		p.setFont(TitleFont());
		p.setPen(color);
		const auto title = TitleFont()->elided(item.title, item.rect.width() - 4);
		p.drawText(
			QRect(item.rect.x(), iconTop + Kit::Px(kIconSizePx) + Kit::Px(3), item.rect.width(), TitleFont()->height),
			title,
			style::al_center);

		// Счётчик непрочитанных у «Чатов» — справа сверху от значка
		if (i == 0 && _unread > 0) {
			const auto text = (_unread > 99) ? u"99+"_q : QString::number(_unread);
			const auto h = Kit::Px(18);
			const auto w = std::max(h, BadgeFont()->width(text) + Kit::Px(10));
			const auto rect = QRect(item.rect.x() + item.rect.width() / 2 + Kit::Px(6), item.rect.y() + Kit::Px(2), w, h);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Blue));
			p.drawRoundedRect(rect, h / 2., h / 2.);
			p.setFont(BadgeFont());
			p.setPen(ToneColor(Tone::AccentInk));
			p.drawText(rect, text, style::al_center);
		}
	}
}

void SectionRail::mouseMoveEvent(QMouseEvent *e) {
	const auto over = itemAt(e->pos());
	if (_over != over) {
		_over = over;
		setCursor((_over >= 0) ? style::cur_pointer : style::cur_default);
		update();
	}
}

void SectionRail::mousePressEvent(QMouseEvent *e) {
	if (e->button() == Qt::LeftButton) {
		_pressed = itemAt(e->pos());
	}
}

void SectionRail::mouseReleaseEvent(QMouseEvent *e) {
	const auto pressed = std::exchange(_pressed, -1);
	if (e->button() == Qt::LeftButton && pressed >= 0 && pressed == itemAt(e->pos())) {
		activate(pressed);
	}
}

void SectionRail::leaveEventHook(QEvent *e) {
	if (_over >= 0) {
		_over = -1;
		setCursor(style::cur_default);
		update();
	}
}

} // namespace Parvane
