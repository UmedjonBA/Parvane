// Parvane fork: место разделов «Пространство» (spec 029, T060): слой поверх колонок мессенджера справа от
// рейки; виден, когда выбран раздел, отличный от «Чатов». Экраны разделов подключаются фабриками, каждый —
// в своих файлах (parvane_planner_*, parvane_notes_*, parvane_cloud_*).
#pragma once

#include "parvane/parvane_space.h"
#include "ui/rp_widget.h"

#include <QtCore/QPointer>

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

using SectionFactory = Fn<object_ptr<Ui::RpWidget>(
	not_null<QWidget*> parent,
	not_null<Window::SessionController*> controller,
	Section section)>;

// Экран раздела: фабрика отдаёт виджет, который заполнит место раздела. Без фабрики — заглушка с заголовком.
void RegisterSectionFactory(Section section, SectionFactory factory);

class SectionsHost final : public Ui::RpWidget {
public:
	SectionsHost(QWidget *parent, not_null<Window::SessionController*> controller);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void showSection(Section section);

	const not_null<Window::SessionController*> _controller;
	base::flat_map<Section, object_ptr<Ui::RpWidget>> _screens;
	Section _shown = Section::Chats;

};

// Заголовок раздела (как web `.hdr`): крупное название слева.
[[nodiscard]] QString SectionTitle(Section section);

} // namespace Parvane
