// Parvane fork: детали поля холста «Знаний» (spec 029, T063) — кнопки панели инструментов (`.boardTool`), чипы
// холстов (`.chip` на панели), панель у выделенного (web `CanvasSelectionBar.tsx`, `.canvasBar`) и меню по правой
// кнопке (web `CanvasContextMenu.tsx`, `.canvasMenu`). Размеры — из `Knowledge.module.scss` (1rem = 16 px), цвета —
// тона Parvane::ToneColor; подписи передаёт поле.
#pragma once

#include "parvane/parvane_kit.h"

#include <parvane/sections/notes_canvas_align.h>

#include <rpl/event_stream.h>

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace Parvane::NotesUi::CanvasWidgets {

namespace notes = parvane::sections::notes;

// `.boardTool`: квадрат 2.375rem в рамке, значок 1.125rem; `.boardToolOn` — заливка акцентом
class ToolButton final : public Kit::Button {
public:
	ToolButton(QWidget *parent, const QString &icon, const QString &label);

	void setIcon(const QString &icon);
	void setOn(bool on);
	void setLabel(const QString &label);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _icon;
	bool _on = false;

};

// `.chip` панели поля (`.boardChip`): фон панели, выбранный — акцент на 22 %; значок и подпись (подпись может
// быть пустой — только значок)
class Chip final : public Kit::Button {
public:
	Chip(QWidget *parent, const QString &icon, const QString &text, const QString &label);

	void setText(const QString &text);
	void setOn(bool on);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();

	QString _icon;
	QString _text;
	bool _on = false;

};

// Ячейка панели: кнопка со значком, образец цвета либо строка меню
struct Cell {
	enum class Type {
		Button, // `.canvasBarButton`
		Swatch, // `.canvasSwatch`
		Item, // `.canvasMenuItem`
	};
	Type type = Type::Button;
	QRect rect;
	QString icon;
	QString label; // подсказка у кнопки и образца, текст у строки
	bool danger = false;
	bool on = false;
	std::optional<QColor> color; // образец: цвет; нет — «без цвета»
	bool swatchInButton = false; // кнопка «Цвет» панели: образец внутри кнопки
	Fn<void()> click;
};

// Плавающая панель с ячейками: рамка, тень, наведение, подсказки
class Panel : public Ui::RpWidget {
public:
	explicit Panel(QWidget *parent);

protected:
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void leaveEventHook(QEvent *e) override;
	bool eventHook(QEvent *e) override;

	std::vector<Cell> _cells;
	std::vector<QRect> _lines; // разделители `.canvasMenuStrip`
	int _scroll = 0;

private:
	[[nodiscard]] int cellAt(QPoint point) const;
	void paintCell(QPainter &p, const Cell &cell, bool over) const;

	int _over = -1;
	int _down = -1;

};

// Панель у выделенного: цвет (палитра раскрывается над кнопками), правка, открыть, направление, копия, обернуть,
// по содержимому, удалить, «⋯»
class SelectionBar final : public Panel {
public:
	struct Descriptor {
		std::optional<std::string> color;
		bool canEdit = false;
		QString editIcon = u"edit"_q;
		QString editLabel;
		bool canOpen = false;
		bool canDuplicate = false;
		bool canWrap = false;
		bool canFit = false;
		bool canTurn = false;
	};
	struct Labels {
		QString color, noColor, edit, open, direction, duplicate, wrap, fit, remove, more;
	};
	SelectionBar(QWidget *parent, Labels labels);

	void setDescriptor(Descriptor descriptor);
	// Место у выделенного: точка середины низа панели на поле (её `--bx`, `--by`); nullopt — прижата к низу поля
	void setPlace(std::optional<QPoint> place);

	[[nodiscard]] rpl::producer<QString> actions() const; // edit | open | direction | duplicate | wrap | fit | remove
	[[nodiscard]] rpl::producer<std::optional<std::string>> colors() const;
	[[nodiscard]] rpl::producer<QPoint> moreRequests() const; // точка под кнопкой «⋯» на поле

private:
	void rebuild();
	void relayout();

	Labels _labels;
	Descriptor _descriptor;
	std::optional<QPoint> _place;
	bool _paletteOpen = false;
	rpl::event_stream<QString> _actions;
	rpl::event_stream<std::optional<std::string>> _colors;
	rpl::event_stream<QPoint> _more;

};

// Меню по правой кнопке и по «⋯»: строка цветов, строка выравнивания, пункты
class ContextMenu final : public Panel {
public:
	struct Item {
		QString command;
		QString icon;
		QString label;
		bool danger = false;
	};
	struct Descriptor {
		QPoint at; // точка поля, у которой открыто меню
		std::vector<Item> items;
		bool hasColors = false;
		std::optional<std::string> color;
		bool canAlign = false;
		bool canDistribute = false;
	};
	struct Labels {
		QString color, noColor;
		QString alignLeft, alignCenter, alignRight, alignTop, alignMiddle, alignBottom;
		QString distributeX, distributeY;
	};
	ContextMenu(QWidget *parent, Descriptor descriptor, Labels labels);

	[[nodiscard]] rpl::producer<QString> commands() const;
	[[nodiscard]] rpl::producer<std::optional<std::string>> colors() const;
	[[nodiscard]] rpl::producer<notes::CanvasAlign> aligns() const;
	[[nodiscard]] rpl::producer<notes::CanvasAxis> distributes() const;

protected:
	void wheelEvent(QWheelEvent *e) override;

private:
	void rebuild();
	void relayout();

	Descriptor _descriptor;
	Labels _labels;
	int _contentHeight = 0;
	rpl::event_stream<QString> _commands;
	rpl::event_stream<std::optional<std::string>> _colors;
	rpl::event_stream<notes::CanvasAlign> _aligns;
	rpl::event_stream<notes::CanvasAxis> _distributes;

};

} // namespace Parvane::NotesUi::CanvasWidgets
