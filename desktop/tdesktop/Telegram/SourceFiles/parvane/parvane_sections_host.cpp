// Parvane fork: реализация parvane_sections_host.h.
#include "parvane/parvane_sections_host.h"

#include "parvane/parvane_kit.h"
#include "parvane/parvane_sections_data.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "window/window_session_controller.h"
#include "styles/style_basic.h"

namespace Parvane {
namespace {

base::flat_map<Section, SectionFactory> &Factories() {
	static auto result = base::flat_map<Section, SectionFactory>();
	return result;
}

// Заглушка раздела, у которого ещё нет экрана: заголовок на острове
class Placeholder final : public Ui::RpWidget {
public:
	Placeholder(QWidget *parent, Section section)
	: RpWidget(parent)
	, _section(section) {
		TonesChanges() | rpl::on_next([=] { update(); }, lifetime());
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = Painter(this);
		PainterHighQualityEnabler hq(p);
		const auto island = rect().marginsRemoved({ 8, 8, 8, 8 });
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Panel));
		p.drawRoundedRect(island, 16, 16);
		const auto font = Kit::Font(20, true);
		p.setFont(font);
		p.setPen(ToneColor(Tone::Fg));
		p.drawText(island.x() + 24, island.y() + 24 + font->ascent, SectionTitle(_section));
	}

private:
	const Section _section;

};

} // namespace

void RegisterSectionFactory(Section section, SectionFactory factory) {
	Factories()[section] = std::move(factory);
}

QString SectionTitle(Section section) {
	switch (section) {
	case Section::Calendar: return tr::lng_parvane_rail_calendar(tr::now);
	case Section::Health: return tr::lng_parvane_rail_health(tr::now);
	case Section::Knowledge: return tr::lng_parvane_rail_knowledge(tr::now);
	case Section::Files: return tr::lng_parvane_rail_cloud(tr::now);
	case Section::Chats: break;
	}
	return tr::lng_parvane_rail_chats(tr::now);
}

SectionsHost::SectionsHost(QWidget *parent, not_null<Window::SessionController*> controller)
: RpWidget(parent)
, _controller(controller) {
	hide();
	static const auto registered = [] {
		RegisterPlannerViews();
		RegisterPlannerHealth();
		RegisterKnowledge();
		RegisterCloud();
		return true;
	}();
	(void)registered;
	SectionValue() | rpl::on_next([=](Section section) {
		showSection(section);
	}, lifetime());
	sizeValue() | rpl::on_next([=](QSize size) {
		for (const auto &[section, screen] : _screens) {
			screen->setGeometry(QRect(QPoint(), size));
		}
	}, lifetime());
	TonesChanges() | rpl::on_next([=] { update(); }, lifetime());
}

void SectionsHost::showSection(Section section) {
	_shown = section;
	Sections::SetShownSection(section);
	if (section == Section::Chats) {
		hide();
		return;
	}
	auto i = _screens.find(section);
	if (i == _screens.end()) {
		const auto f = Factories().find(section);
		auto screen = (f != Factories().end() && f->second)
			? f->second(this, _controller, section)
			: object_ptr<Ui::RpWidget>(object_ptr<Placeholder>(this, section));
		i = _screens.emplace(section, std::move(screen)).first;
	}
	for (const auto &[key, screen] : _screens) {
		if (key == section) {
			screen->setGeometry(rect());
			screen->show();
		} else {
			screen->hide();
		}
	}
	show();
	raise();
}

void SectionsHost::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.fillRect(e->rect(), ToneColor(Tone::Bg));
}

} // namespace Parvane
