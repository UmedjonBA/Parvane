// Parvane fork: граф связей «Знаний» (spec 029, T063) — порт web `notes/NotesGraph.tsx`: заметки, заметки, которых
// ещё нет (блёклые), по желанию дни и записи «Плана». Поле двигается и масштабируется (колесо, кнопки), точки
// перетаскиваются. Нажатие выбирает точку (её показывает панель справа), двойное открывает заметку на вкладке
// «Заметки». Связь — это ссылка в тексте: её ведут от кольца вокруг заметки к другой заметке (или на пустое место —
// к новой), а убирают, выбрав линию. Раскладка и правила — ядро (notes_graph.h, board_view.h).
#pragma once

#include "parvane/parvane_knowledge_common.h"

#include <parvane/sections/board_view.h>
#include <parvane/sections/notes_canvas_graph.h>
#include <parvane/sections/notes_graph.h>

#include "base/timer.h"
#include "base/unique_qptr.h"

namespace Parvane::Knowledge {

// Выбранная точка графа — то, что показывает панель справа
struct GraphPick {
	std::string id;
	notes::GraphNodeKind kind = notes::GraphNodeKind::Note;
	std::string title;
	std::optional<std::string> group;
};

enum class GraphLinkOutcome {
	Added,
	Exists,
	Refused,
	Failed,
};

struct NotesGraphCallbacks {
	Fn<void(GraphPick)> pick;
	// Двойное нажатие: заметка открывается на вкладке «Заметки»
	Fn<void(GraphPick)> open;
	Fn<void(std::string fromId, std::string toTitle, Fn<void(GraphLinkOutcome)> done)> link;
	// Связь, брошенная на пустое место: новая заметка с этим названием; done — её id
	Fn<void(std::string fromId, std::string title, Fn<void(std::optional<std::string>)> done)> linkNew;
	Fn<void(std::string fromId, std::string toTitle)> unlink;
	Fn<void()> linkModeEnd;
	// Escape без иных дел закрывает панель выбранной точки
	Fn<void()> close;
	// «Создать холст»: холст из заметок, которые сейчас видны на графе
	Fn<void(notes::GraphCanvasScope)> makeCanvas;
};

class NotesGraph final : public Ui::RpWidget {
public:
	NotesGraph(QWidget *parent, NotesGraphCallbacks callbacks);
	~NotesGraph();

	void setNotes(const std::vector<notes::NoteRef> &notes);
	void setPlanner(const planner::State &state);
	void setPicked(std::optional<std::string> id);
	void setLinkFrom(std::optional<std::string> id);
	// Поиск из шапки раздела: найденные точки подсвечены; searchNext (Enter в поле) выбирает следующую
	void setQuery(const QString &query);
	void searchNext();

protected:
	void paintEvent(QPaintEvent *e) override;
	void resizeEvent(QResizeEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void mouseDoubleClickEvent(QMouseEvent *e) override;
	void wheelEvent(QWheelEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	struct Drag;
	struct Draft;
	struct Removal;

	void rebuild(bool force = false);
	void layoutStep();
	void refreshNodes();
	void rememberPlaces();
	void fit();
	void maybeFit();
	void applyView(notes::BoardView view);
	void reveal(const std::string &id);
	void refreshTools();
	void refreshOverlays();
	void toggleFolderMenu();
	void pickFolders(std::optional<std::vector<std::string>> folders);
	void connect(const std::string &fromId, const notes::GraphNode &to);
	void submitNew(const QString &title);
	void cancelNew();
	void removeLink(const std::string &fromId);
	void clearDraft();
	void setFlash(std::string pair);

	[[nodiscard]] notes::GraphPoint toWorld(QPointF screen) const;
	[[nodiscard]] QPointF toScreen(notes::GraphPoint world) const;
	[[nodiscard]] const notes::GraphNode *nodeById(const std::string &id) const;
	[[nodiscard]] const notes::GraphNode *targetAt(notes::GraphPoint point, const std::string &fromId) const;
	[[nodiscard]] const notes::GraphNode *handleAt(QPointF screen) const;
	[[nodiscard]] std::optional<std::string> edgeAt(QPointF screen) const;
	[[nodiscard]] QString labelOf(const notes::GraphNode &node) const;
	[[nodiscard]] bool isFound(const notes::GraphNode &node) const;
	[[nodiscard]] std::vector<Removal> removals() const;
	[[nodiscard]] std::optional<std::string> linkSourceId() const;

	NotesGraphCallbacks _callbacks;

	// Входы
	std::vector<notes::NoteRef> _notes;
	std::map<const notes::NoteEntry*, std::vector<std::string>> _links; // ссылки заметки (по версии записи)
	planner::State _planner;
	std::optional<std::string> _pickedId;
	std::optional<std::string> _linkFromId;
	QString _query;

	// Выбор
	bool _withDays = false;
	bool _withRecords = false;
	std::optional<std::vector<std::string>> _savedFolders;
	std::vector<notes::GraphFolder> _folderOptions;
	std::optional<std::vector<std::string>> _folders;

	// Граф и раскладка
	std::string _signature;
	std::unique_ptr<notes::GraphLayoutRun> _run;
	std::vector<notes::GraphEdge> _edges;
	std::vector<notes::GraphNode> _nodes; // с местами, сдвинутыми руками
	std::map<std::string, notes::GraphPoint> _moved;
	std::map<std::string, std::string> _labels;
	std::set<std::string> _dailyIds;
	int _layoutRound = 0;
	bool _refit = false;
	std::string _fitKey;
	base::Timer _layoutTimer;

	// Поле
	notes::BoardView _view;
	std::unique_ptr<Drag> _drag;
	std::unique_ptr<Draft> _draft;
	std::unique_ptr<Draft> _newAt;
	std::optional<std::string> _pickedEdge;
	std::optional<std::string> _flash;
	std::optional<std::string> _hoverId;
	base::Timer _flashTimer;
	struct Tap {
		std::string id;
		crl::time at = 0;
	};
	Tap _lastTap;

	// Над полем
	Ui::RpWidget *_tools = nullptr;
	NotesTextButton *_notesChip = nullptr;
	NotesTextButton *_daysChip = nullptr;
	NotesTextButton *_recordsChip = nullptr;
	NotesTextButton *_foldersChip = nullptr;
	NotesTextButton *_canvasChip = nullptr;
	base::unique_qptr<Ui::RpWidget> _folderMenu;
	base::unique_qptr<Ui::RpWidget> _linkHint;
	base::unique_qptr<Kit::Field> _newField;
	std::vector<base::unique_qptr<Ui::RpWidget>> _removeButtons;
	Ui::RpWidget *_zoom = nullptr;

};

// Места точек прежнего аккаунта при выходе забываются (id и названия заметок не должны жить в памяти дальше)
void ResetGraphPlaces();

} // namespace Parvane::Knowledge
