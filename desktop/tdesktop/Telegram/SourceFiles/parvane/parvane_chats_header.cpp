// Parvane fork: реализация parvane_chats_header.h. Размеры — web LeftMainHeader.scss: заголовок 1.25rem полужирный
// (`.left-header-title`), пилюля поиска 5.75rem (`.SearchInput--pill`), «Написать» 2.125rem (`.left-header-compose`),
// промежуток 0.5rem; в узкой колонке от «Написать» остаётся значок.
#include "parvane/parvane_chats_header.h"

#include "parvane/parvane_health.h"
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

// Колонка уже этого — «Написать» без подписи (web `.left-header--compact`)
constexpr auto kCompactWidthPx = 300;

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
	true)) {
	_compose->setClickedCallback([=] { showComposeMenu(); });
	Lang::Updated() | rpl::on_next([=] {
		_compose->setText(_compact ? QString() : tr::lng_parvane_compose(tr::now));
		_compose->setAccessibleName(tr::lng_parvane_compose(tr::now));
	}, _compose->lifetime());
}

ChatsHeader::~ChatsHeader() = default;

QRect ChatsHeader::layout(QRect area, QRect search, bool collapsed) {
	if (!collapsed || area.width() <= 0) {
		_title->hide();
		_compose->hide();
		return QRect(area.x(), search.y(), area.width(), search.height());
	}
	const auto compact = (area.width() < Kit::Px(kCompactWidthPx));
	if (_compact != compact) {
		_compact = compact;
		_compose->setText(_compact ? QString() : tr::lng_parvane_compose(tr::now));
		_compose->setAccessibleName(tr::lng_parvane_compose(tr::now));
	}
	const auto gap = Kit::Rem(0.5);
	const auto right = area.x() + area.width();
	_compose->moveToLeft(
		right - _compose->width(),
		search.y() + (search.height() - _compose->height()) / 2);
	_compose->show();
	// `.SearchInput--pill`: flex 0 1 5.75rem, не уже 2.125rem
	const auto free = _compose->x() - gap - area.x();
	const auto pill = std::clamp(free / 2, Kit::Rem(2.125), Kit::Rem(5.75));
	const auto searchLeft = _compose->x() - gap - pill;
	const auto titleWidth = searchLeft - gap - area.x();
	if (titleWidth > Kit::Rem(1.)) {
		_title->setGeometry(area.x(), area.y(), titleWidth, area.height());
		_title->show();
	} else {
		_title->hide();
	}
	return QRect(searchLeft, search.y(), pill, search.height());
}

void ChatsHeader::raise() {
	_title->raise();
	_compose->raise();
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
