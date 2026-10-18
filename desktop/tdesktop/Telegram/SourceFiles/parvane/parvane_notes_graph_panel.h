// Parvane fork: панель графа «Знаний» (spec 029, T063) — порт web `notes/GraphPanel.tsx`: выбранная точка читается и
// правится, не уходя с графа (и рядом с холстом). Заметка — настоящий NoteView (текст, правка, «Запланировано»,
// обратные ссылки); заметки ещё нет — предложение создать; запись «Плана» — её день и время с переходом в «План».
#pragma once

#include "parvane/parvane_note_view.h"
#include "parvane/parvane_notes_graph.h"

namespace Ui {
class ScrollArea;
} // namespace Ui

namespace Parvane::Knowledge {

struct GraphPanelState {
	GraphPick pick;
	// Заметка точки: у заметки и заметки дня; у «заметки, которой ещё нет» — если её успели создать
	NoteData note;
	// Запись «Плана» точки
	std::optional<notes::PlannedItem> record;
};

struct GraphPanelCallbacks {
	Fn<void()> close;
	Fn<void(std::string noteId)> openInNotes;
	// «Связать»: следующая нажатая на графе заметка получит ссылку из этой; пусто — кнопки нет (рядом с холстом)
	Fn<void(std::string noteId)> linkStart;
	Fn<void(std::string title)> create;
	Fn<void(notes::PlannedItem record)> openInPlan;
	Fn<void(QString title)> openTitle;
	Fn<void(std::string noteId)> deleted;
	Fn<void(std::string noteId)> pickFolder;
};

class GraphPanel final : public Kit::Island {
public:
	GraphPanel(QWidget *parent, GraphPanelCallbacks callbacks);

	void setState(GraphPanelState state);
	void setLinkStartEnabled(bool enabled);
	void requestEdit(const std::string &noteId, size_t from, size_t to);

protected:
	void resizeEvent(QResizeEvent *e) override;

private:
	void rebuildHeader();
	void rebuildBody();
	void relayout();

	GraphPanelCallbacks _callbacks;
	std::optional<GraphPanelState> _state;
	bool _linkStartEnabled = true;
	std::string _headerKey;
	std::string _bodyKey;

	base::unique_qptr<Kit::Header> _header;
	Ui::ScrollArea *_scroll = nullptr;
	Ui::RpWidget *_inner = nullptr;
	NoteView *_note = nullptr;
	base::unique_qptr<Ui::RpWidget> _info;

};

} // namespace Parvane::Knowledge
