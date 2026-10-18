// Parvane fork: рейка разделов «Пространство» (как web FoldersSidebar) на месте боковой панели папок:
// знак, разделы (Чаты со счётчиком непрочитанных, Календарь, Здоровье, Знания, Облако), внизу Поиск и Профиль.
// Папки чатов — чипами над списком чатов.
#pragma once

#include "ui/rp_widget.h"

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

class SectionRail final : public Ui::RpWidget {
public:
	SectionRail(QWidget *parent, not_null<Window::SessionController*> controller);

protected:
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	struct Item {
		QString icon;
		QString title;
		QRect rect;
	};
	void refreshTitles();
	void layoutItems();
	[[nodiscard]] int itemAt(QPoint point) const;
	[[nodiscard]] bool isActive(int index) const;
	void activate(int index);

	const not_null<Window::SessionController*> _controller;
	std::vector<Item> _items; // разделы, затем Поиск и Профиль
	int _over = -1;
	int _pressed = -1;
	int _unread = 0;

};

} // namespace Parvane
