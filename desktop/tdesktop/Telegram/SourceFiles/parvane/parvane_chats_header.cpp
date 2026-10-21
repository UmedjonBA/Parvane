// Parvane fork: реализация parvane_chats_header.h. Размеры — web LeftMainHeader.scss: заголовок 1.25rem полужирный
// (`.left-header-title`), пилюля поиска 5.75rem (`.SearchInput--pill`), «Написать» 2.125rem (`.left-header-compose`),
// промежуток 0.5rem; в узкой колонке от «Написать» остаётся значок.
#include "parvane/parvane_chats_header.h"

#include "parvane/parvane_health.h"
#include "parvane/parvane_icons.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_space.h"

#include "boxes/peer_list_controllers.h"
#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/popup_menu.h"
#include "window/window_session_controller.h"
#include "styles/style_menu_icons.h"
#include "styles/style_widgets.h"

namespace Parvane {
namespace {

// «Написать» теряет подпись, только если иначе заголовку «Чаты» не остаётся места (web `.left-header--compact`
// в узкой колонке); spec 030 — раньше подпись пропадала уже при колонке уже 300 px
constexpr auto kTitleMinRem = 3.25;
constexpr auto kPillMinRem = 4.75;
constexpr auto kSearchIconPx = 16;

// Значок лупы в свёрнутой пилюле поиска (web `.SearchInput--pill` со значком)
class SearchIcon final : public Ui::RpWidget {
public:
	explicit SearchIcon(QWidget *parent)
	: RpWidget(parent) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
		Kit::RepaintOnTones(this);
		resize(Kit::Px(kSearchIconPx), Kit::Px(kSearchIconPx));
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PaintIcon(p, u"search"_q, ToneColor(Tone::Muted), 0, 0, width());
	}

};

class Title final : public Ui::RpWidget {
public:
	explicit Title(QWidget *parent)
	: RpWidget(parent) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
		Kit::RepaintOnTones(this);
		tr::lng_parvane_rail_chats() | rpl::on_next([=](const QString &text) {
			_text = text;
			update();
		}, lifetime());
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto font = Kit::Font(20, true);
		p.setFont(font);
		p.setPen(ToneColor(Tone::Fg));
		p.drawText(
			0,
			(height() - font->height) / 2 + font->ascent,
			font->elided(_text, width()));
	}

private:
	QString _text;

};

} // namespace

ChatsHeader::ChatsHeader(
	not_null<Ui::RpWidget*> parent,
	not_null<Window::SessionController*> controller)
: _parent(parent)
, _controller(controller)
, _title(base::make_unique_q<Title>(parent))
, _compose(base::make_unique_q<Kit::Pill>(
	parent,
	tr::lng_parvane_compose(tr::now),
	u"pen"_q,
	true))
, _searchIcon(base::make_unique_q<SearchIcon>(parent)) {
	_compose->setClickedCallback([=] { showComposeMenu(); });
	_composeFullWidth = _compose->width();
	_searchIcon->hide();
	Lang::Updated() | rpl::on_next([=] {
		refreshComposeText();
	}, _compose->lifetime());
}

void ChatsHeader::refreshComposeText() {
	_compose->setText(tr::lng_parvane_compose(tr::now));
	_composeFullWidth = _compose->width();
	if (_compact) {
		_compose->setText(QString());
	}
	_compose->setAccessibleName(tr::lng_parvane_compose(tr::now));
}

std::optional<int> ChatsHeader::takeSearchSkipChange() {
	if (_searchSkipApplied == _searchSkip) {
		return std::nullopt;
	}
	_searchSkipApplied = _searchSkip;
	return _searchSkip;
}

ChatsHeader::~ChatsHeader() = default;

QRect ChatsHeader::layout(QRect area, QRect search, bool collapsed) {
	if (!collapsed || area.width() <= 0) {
		_title->hide();
		_compose->hide();
		_searchIcon->hide();
		_searchSkip = 0;
		return QRect(area.x(), search.y(), area.width(), search.height());
	}
	const auto gap = Kit::Rem(0.5);
	const auto compact = (area.width()
		< _composeFullWidth + Kit::Rem(kPillMinRem) + Kit::Rem(kTitleMinRem) + 2 * gap);
	if (_compact != compact) {
		_compact = compact;
		refreshComposeText();
	}
	const auto right = area.x() + area.width();
	_compose->moveToLeft(
		right - _compose->width(),
		search.y() + (search.height() - _compose->height()) / 2);
	_compose->show();
	// `.SearchInput--pill`: flex 0 1 5.75rem, не уже 2.125rem; пилюле — всё, что осталось после заголовка, иначе
	// подпись «Поиск» за лупой обрезается до «…» (spec 030)
	const auto free = _compose->x() - gap - area.x();
	const auto pill = std::clamp(free - gap - Kit::Rem(kTitleMinRem), Kit::Rem(2.125), Kit::Rem(7.));
	const auto searchLeft = _compose->x() - gap - pill;
	const auto titleWidth = searchLeft - gap - area.x();
	if (titleWidth > Kit::Rem(1.)) {
		_title->setGeometry(area.x(), area.y(), titleWidth, area.height());
		_title->show();
	} else {
		_title->hide();
	}
	// Лупа слева в пилюле, подпись «Поиск» сдвигается за неё (отступ поля — takeSearchSkipChange)
	const auto iconLeft = searchLeft + Kit::Rem(0.75);
	_searchIcon->moveToLeft(
		iconLeft,
		search.y() + (search.height() - _searchIcon->height()) / 2);
	_searchIcon->show();
	_searchSkip = _searchIcon->width() + Kit::Rem(0.375);
	return QRect(searchLeft, search.y(), pill, search.height());
}

void ChatsHeader::raise() {
	_title->raise();
	_compose->raise();
	_searchIcon->raise();
}

void ChatsHeader::showComposeMenu() {
	if (_menu) {
		return;
	}
	const auto controller = _controller;
	_menu = base::make_unique_q<Ui::PopupMenu>(
		_compose.get(),
		st::popupMenuWithIcons);
	_menu->addAction(tr::lng_parvane_compose_message(tr::now), [=] {
		controller->show(PrepareContactsBox(controller));
	}, &st::menuIconChatBubble);
	_menu->addAction(tr::lng_create_group_title(tr::now), [=] {
		controller->showNewGroup();
	}, &st::menuIconGroups);
	_menu->addAction(tr::lng_create_channel_title(tr::now), [=] {
		controller->showNewChannel();
	}, &st::menuIconChannel);
	_menu->addAction(tr::lng_parvane_compose_plan(tr::now), [=] {
		// web requestPlannerAdd: «План» и сразу ввод текстом
		ShowSection(Section::Calendar);
		Health::OpenQuickEntry(controller, QString());
	}, &st::menuIconSchedule);
	// Закрытое меню удаляет себя само — _menu (QPointer) снова пуст
	_menu->setForcedOrigin(Ui::PanelAnimation::Origin::TopRight);
	_menu->popup(_compose->mapToGlobal(QPoint(_compose->width(), _compose->height() + Kit::Rem(0.25))));
}

} // namespace Parvane
