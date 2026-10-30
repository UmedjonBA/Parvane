// Parvane fork: холст «Знаний» (spec 029, T063) — порт web `components/parvane/notes/NotesCanvas.tsx` и его частей
// (`CanvasCard`, `CanvasEdgeView`, `CanvasSelectionBar`, `CanvasContextMenu`, `CanvasFilePicker`, `CanvasFileBody`,
// `CanvasLinkBody`, `notesCanvasLook`). Поле — один виджет, который рисует QPainter: точечный фон, стрелки, группы
// и карточки в точках холста под общим сдвигом и масштабом; правка на месте — поле Ui::InputField поверх карточки.
// Вся логика холста (разбор и запись `.canvas`, правки, выравнивание, отмена, что начинает нажатие, вид) — ядро
// parvane::sections::notes; здесь — показ, жесты и запись через рабочий поток разделов.
//
// Отличия от web: пинч двумя пальцами и долгое нажатие пальцем не перенесены (на компьютере их заменяют колесо,
// жест щипка тачпада и правая кнопка); поиск по холсту из шапки раздела и просмотр файла облака (CloudPreview) —
// за экраном «Знаний» и «Облаком», здесь их нет.
#include "parvane/parvane_notes_canvas.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_safe_open.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_notes_canvas_look.h"
#include "parvane/parvane_notes_canvas_media.h"
#include "parvane/parvane_notes_canvas_widgets.h"
#include "parvane/parvane_sections_data.h"

#include <parvane/sections/board_view.h>
#include <parvane/sections/notes_canvas.h>
#include <parvane/sections/notes_canvas_align.h>
#include <parvane/sections/notes_canvas_edit.h>
#include <parvane/sections/notes_canvas_files.h>
#include <parvane/sections/notes_canvas_graph.h>
#include <parvane/sections/notes_canvas_history.h>
#include <parvane/sections/notes_canvas_images.h>
#include <parvane/sections/notes_canvas_look.h>
#include <parvane/sections/notes_canvas_note.h>
#include <parvane/sections/notes_canvas_press.h>
#include <parvane/sections/notes_look.h>
#include <parvane/sections/notes_model.h>

#include "base/event_filter.h"
#include "base/timer.h"
#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"
#include "styles/style_basic.h"
#include "styles/style_widgets.h"

#include <QtCore/QDateTime>
#include <QtCore/QUrl>
#include <QtGui/QClipboard>
#include <QtGui/QDesktopServices>
#include <QtGui/QFontMetricsF>
#include <QtGui/QGuiApplication>
#include <QtGui/QPainterPath>
#include <QtGui/QtEvents>
#include <QtWidgets/QApplication>

#include <array>
#include <cmath>
#include <map>
#include <set>

namespace Parvane::NotesUi {
namespace {

namespace notes = parvane::sections::notes;
namespace cloud = parvane::sections::cloud;
using namespace Kit;
using CanvasLook::Blend;
using CanvasLook::Fade;
using notes::CanvasDoc;
using notes::CanvasDocPtr;
using notes::CanvasNode;
using notes::CanvasEdge;
using notes::CanvasPoint;
using notes::CanvasRect;
using notes::CanvasSide;
using notes::CanvasHandle;
using notes::CanvasSelection;
using notes::CanvasJson;

// Запись холста в облако: через паузу после последней правки, но не позже потолка от первой несохранённой
constexpr auto kSaveDelayMs = crl::time(4000);
constexpr auto kSaveMaxWaitMs = crl::time(15000);
// Поиск: к первой находке холст едет после паузы набора; мелкий масштаб подрастает, чтобы её было видно (web)
constexpr auto kFoundDelayMs = crl::time(400);
constexpr auto kFoundMinScale = 0.8;
constexpr auto kGroupWidth = 420.;
constexpr auto kGroupHeight = 280.;
constexpr auto kNoteHeight = 140.;
constexpr auto kLinkWidth = 300.;
constexpr auto kLinkHeight = 160.;
constexpr auto kFileHeight = 200.;
// Новая карточка встаёт правее и ниже прежних, а не поверх них
constexpr auto kNewOffsetX = 280.;
constexpr auto kNewOffsetY = 40.;
constexpr auto kNewColumns = 3;
constexpr auto kDragThreshold = 3.;
// Место под панель инструментов сверху (на узком экране она в два ряда) и под название группы над рамкой
constexpr auto kFitTop = 64.;
constexpr auto kFitTopNarrow = 112.;
constexpr auto kFitBottom = 20.;
constexpr auto kGroupLabelRoom = 40.;
// Стрелка выбирается нажатием не дальше этого от линии (в точках экрана)
constexpr auto kEdgeHit = 8.;
constexpr auto kCanvasTitleMax = 80;
// Высота карточки идёт по тексту, пока под текстом нет свободного места больше этого
constexpr auto kAutoSlack = 4.;
constexpr auto kBarGap = 12.;
constexpr auto kBarHeight = 44.;
constexpr auto kNarrowWidth = 760.;
constexpr auto kPreviewLines = 7;
constexpr auto kNoteEditMaxHeight = 360.;
// Размеры частей карточек и групп в точках холста (Knowledge.module.scss)
constexpr auto kGroupHead = 32.;
constexpr auto kGroupBorder = 2.;
constexpr auto kGroupGrab = 24.;
constexpr auto kGroupGrabOut = 6.;
constexpr auto kHandleSize = 12.; // угловая ручка — в точках экрана
constexpr auto kEdgeHandle = 10.;
constexpr auto kEdgeHandleInset = 8.;
constexpr auto kPortSize = 14.; // в точках экрана
constexpr auto kCardRadius = 12.;
constexpr auto kPadX = 12.;
constexpr auto kPadY = 8.;

using Kind = notes::CanvasPressAction::Kind;

[[nodiscard]] QString Q(const std::string &value) {
	return QString::fromStdString(value);
}

[[nodiscard]] std::string S(const QString &value) {
	return value.toStdString();
}

[[nodiscard]] std::string Lower(const std::string &value) {
	return Q(value).toLower().toStdString();
}

[[nodiscard]] std::string VaultName() {
	return IsRussianUi() ? std::string("Знания") : std::string("Knowledge");
}

[[nodiscard]] CanvasDocPtr Share(CanvasDoc doc) {
	return std::make_shared<const CanvasDoc>(std::move(doc));
}

[[nodiscard]] std::vector<notes::BoardRect> ToBoardRects(const std::vector<CanvasRect> &rects) {
	auto result = std::vector<notes::BoardRect>();
	result.reserve(rects.size());
	for (const auto &r : rects) {
		result.push_back({ r.x, r.y, r.width, r.height });
	}
	return result;
}

[[nodiscard]] CanvasNode MakeNode(const std::string &type, double width, double height) {
	auto node = CanvasNode();
	node.type = type;
	node.width = width;
	node.height = height;
	return node;
}

template <typename Item>
[[nodiscard]] std::string Str(const Item &node, std::string_view key) {
	return node.str(key).value_or(std::string());
}

[[nodiscard]] QRectF RectOf(const CanvasRect &r) {
	return QRectF(r.x, r.y, r.width, r.height);
}

// Шрифт поля правки на месте: размер `px` точек холста при текущем масштабе
struct FieldStyle {
	FieldStyle()
	: textBg(QColor(0, 0, 0, 0))
	, textFg(ToneColor(Tone::Fg))
	, placeholderFg(ToneColor(Tone::Faint))
	, borderFg(ToneColor(Tone::Accent))
	, text(st::defaultTextStyle)
	, st(st::defaultInputField) {
	}
	style::owned_color textBg;
	style::owned_color textFg;
	style::owned_color placeholderFg;
	style::owned_color borderFg;
	style::TextStyle text;
	style::InputField st;
};

enum class InlineKind {
	Node,
	Edge,
	Note,
	Title,
};

struct Inline {
	std::string id;
	InlineKind kind = InlineKind::Node;
	bool isNew = false;
	bool isAuto = false;
	std::string noteId;
	std::string base;
	// Название заметки на начало правки текста: под ним она создаётся заново, если её за это время удалили
	std::string noteTitle;
};

// Начало стрелки, брошенной на пустом месте: карточка, которую там создадут, будет связана с этой
struct EdgeStart {
	std::string id;
	CanvasSide side = CanvasSide::Right;
};

struct Pending {
	std::string id;
	std::string title;
	CanvasDocPtr doc;
	crl::time since = 0;
};

struct Gesture {
	enum class Type {
		Pan,
		Move,
		Resize,
		Marquee,
		Edge,
	};
	Type type = Type::Pan;
	QPointF screen; // pan: последняя точка экрана
	bool hasMoved = false;
	std::string lead;
	std::vector<std::string> ids;
	CanvasPoint origin;
	CanvasDocPtr base;
	std::vector<CanvasRect> others;
	CanvasRect bounds;
	std::optional<std::string> collapseTo;
	std::string id;
	CanvasHandle handle = CanvasHandle::SE;
	CanvasSide side = CanvasSide::Right;
	CanvasSelection baseSelection;
};

struct Live {
	CanvasDoc doc;
	std::vector<notes::CanvasGuide> guides;
};

enum class MenuKind {
	Selection,
	Board,
	Drop,
};

struct MenuState {
	QPoint at; // точка на виджете поля
	CanvasPoint point;
	MenuKind kind = MenuKind::Board;
	std::optional<EdgeStart> from;
};

// Что под указателем: узел (у группы — шапка, граница и ручки), его часть, ручка, точка стрелки
struct Hit {
	std::optional<std::string> nodeId;
	std::optional<CanvasSide> port;
	std::optional<CanvasHandle> handle;
	bool groupBand = false;
	bool groupHead = false;
	bool noteHead = false;
	bool openNote = false;
	std::optional<std::string> linkUrl; // кнопка «открыть ссылку» карточки-ссылки
};

// Высота строки текста карточки (`font-size: 0.8125rem; line-height: 1.45`)
[[nodiscard]] CanvasLook::TextStyle BodyStyle(QColor color) {
	return { 13., 1.45, color, false };
}

[[nodiscard]] double NoteHeadHeight() {
	static const auto result = kPadY * 2 + 1. + std::max(
		QFontMetricsF(CanvasLook::CanvasFont(15., true)).height(),
		16.);
	return result;
}

class Board final : public Ui::RpWidget {
public:
	// Поиск из шапки «Знаний»: найденные подсвечены, к первой холст едет сам; searchNext — к следующей
	void setSearchQuery(const QString &query);
	void searchNext();

	Board(
		QWidget *parent,
		not_null<Window::SessionController*> controller,
		std::string canvasId,
		Fn<void(std::string)> openNote);
	~Board();

protected:
	void paintEvent(QPaintEvent *e) override;
	void resizeEvent(QResizeEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void mouseDoubleClickEvent(QMouseEvent *e) override;
	void contextMenuEvent(QContextMenuEvent *e) override;
	void wheelEvent(QWheelEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;
	void keyReleaseEvent(QKeyEvent *e) override;
	void leaveEventHook(QEvent *e) override;
	void focusOutEvent(QFocusEvent *e) override;
	bool eventHook(QEvent *e) override;

private:
	void refreshFound();
	// ── данные ──
	void applyNotes(std::shared_ptr<const Sections::NotesView> view);
	[[nodiscard]] notes::CanvasRef entry() const;
	CanvasDocPtr loadDoc(const std::string &text);
	void flushSave(bool drop = false);
	void applyDoc(CanvasDocPtr next);
	void change(CanvasDoc next, bool isAmend = false);
	void syncHistory();
	void measureTextCards();
	[[nodiscard]] double textContentHeight(const CanvasNode &node) const;
	[[nodiscard]] notes::NoteRef noteOf(const std::string &title) const;
	[[nodiscard]] notes::NoteCardState noteStateOf(const notes::NoteRef &note) const;
	[[nodiscard]] std::optional<std::string> noteTitleOf(const CanvasNode &node) const;
	[[nodiscard]] const cloud::CloudNode *driveFile(const CanvasNode &node) const;
	[[nodiscard]] std::vector<notes::GraphNoteInput> graphNotes() const;
	[[nodiscard]] QString nameOfNode(const std::string &id) const;

	// ── вид ──
	[[nodiscard]] double k() const;
	[[nodiscard]] QSizeF viewport() const;
	[[nodiscard]] bool isNarrow() const;
	[[nodiscard]] CanvasPoint toCanvas(QPointF logical) const;
	[[nodiscard]] QPointF toScreen(CanvasPoint point) const; // логические точки виджета
	void applyView(notes::BoardView next);
	[[nodiscard]] notes::BoardView fitTo(const CanvasDoc &doc) const;
	void zoomBy(double factor);
	[[nodiscard]] CanvasPoint centerPoint() const;
	[[nodiscard]] std::optional<CanvasPoint> pointerPoint() const;

	// ── показ ──
	[[nodiscard]] const CanvasDoc &shown() const;
	[[nodiscard]] const CanvasNode *selectedNode() const;
	[[nodiscard]] const CanvasEdge *selectedEdge() const;
	[[nodiscard]] bool hasGrips(const CanvasNode &node) const;
	[[nodiscard]] double shownHeight(const CanvasNode &node) const;
	void paintBackground(QPainter &p);
	void paintEdge(QPainter &p, const CanvasEdge &edge, std::optional<bool> linked);
	void paintGroup(QPainter &p, const CanvasNode &node);
	void paintCard(QPainter &p, const CanvasNode &node, std::optional<bool> linked, std::set<std::string> &wanted);
	void paintTextBody(QPainter &p, const CanvasNode &node, QRectF card);
	void paintNoteCard(QPainter &p, const CanvasNode &node, QRectF card, const std::string &title);
	void paintLinkBody(QPainter &p, const CanvasNode &node, QRectF card);
	void paintFileBody(QPainter &p, const CanvasNode &node, QRectF card, std::set<std::string> &wanted);
	void paintGrips(QPainter &p, const CanvasNode &node, QRectF rect);
	void paintSelectionOutline(QPainter &p, QRectF rect, double radius, double offset, bool dashed = false);
	void syncAcquired(std::set<std::string> wanted);

	// ── попадание ──
	[[nodiscard]] Hit hitTest(CanvasPoint point) const;
	[[nodiscard]] std::optional<std::string> nodeUnder(const Hit &hit, CanvasPoint point, double edgeHit) const;
	[[nodiscard]] std::optional<std::string> hoverGroupAt(CanvasPoint point) const;
	void updateCursor(CanvasPoint point);

	// ── выделение и правки ──
	void select(CanvasSelection next);
	void selectNodes(std::vector<std::string> ids);
	void dropGesture();
	CanvasNode add(CanvasNode node, std::optional<CanvasPoint> at);
	void addText(std::optional<CanvasPoint> at);
	void addGroup(std::optional<CanvasPoint> at);
	CanvasNode addLinked(CanvasNode node, const EdgeStart &from, CanvasPoint point);
	void addNoteCard(
		const std::string &title,
		const std::string &noteId,
		std::optional<CanvasPoint> at,
		std::optional<EdgeStart> from);
	void addLink(const std::string &url, std::optional<CanvasPoint> at);
	void pasteNodes(const notes::CanvasClip &clip, std::optional<CanvasPoint> at);
	void pasteText(const std::string &text, std::optional<CanvasPoint> at);
	std::optional<std::string> copySelection();
	void removeSelected();
	void undo();
	void redo();
	void duplicate();
	void recolor(std::optional<std::string> color);
	void fitGroups();
	void turnEdges();
	void align(notes::CanvasAlign value);
	void distribute(notes::CanvasAxis axis);
	void reorder(notes::CanvasLayer layer);
	void startMove(const std::string &lead, std::vector<std::string> ids, CanvasPoint origin, std::optional<std::string> collapseTo);
	void showLive(CanvasDoc doc, std::vector<notes::CanvasGuide> guides);

	// ── правка на месте ──
	void startInline(const CanvasNode &node, bool isNew = false);
	void startEdgeInline(const CanvasEdge &edge);
	void startNoteInline(const CanvasNode &node, const notes::NoteRef &note, InlineKind kind);
	void openField(const QString &text, rpl::producer<QString> placeholder);
	void updateFieldGeometry();
	void finishInline(bool canceled = false);
	void commitNoteText(Inline current, std::string text);
	void commitNoteTitle(const std::string &noteId, const std::string &from, const std::string &title);
	void retitleCards(const std::string &from, const std::string &to);
	void relinkCards(const std::string &fromId, const std::string &fromTitle, const std::string &toId, const std::string &toTitle);

	// ── действия ──
	void activate(const std::string &nodeId, notes::NoteCardPart part = notes::NoteCardPart::Command);
	void activateSelected(notes::NoteCardPart part);
	void openFileNode(const CanvasNode &node);
	void openNoteByTitle(const std::string &title);
	void openMenuAt(QPoint at);
	void showMenu(MenuState state);
	void closeMenu();
	void handleCommand(const QString &command);
	void handleLinkMode();
	void refreshFromGraph();
	void newCanvas();
	void graphCanvas();
	void createCanvas(const std::string &title, const CanvasDoc &content);
	void pickCanvas(const std::string &id);

	// ── шторки ──
	void showEditSheet();
	void showLinkSheet(std::optional<std::string> nodeId, std::string url, std::optional<CanvasPoint> at);
	void showCanvasMenu();
	void showDeleteConfirm();
	void showNotePicker(std::optional<CanvasPoint> at, std::optional<EdgeStart> from);
	void showNewNote(std::optional<CanvasPoint> at, std::optional<EdgeStart> from);
	void showFilePicker(std::optional<CanvasPoint> at);
	void fillFilePicker(not_null<Sheet*> sheet, std::optional<std::string> folderId, std::optional<CanvasPoint> at);
	void toast(const QString &text);

	// ── панели ──
	void setupTools();
	void rebuildChips();
	void relayoutTools();
	void refreshTools();
	void refreshBar();

	const not_null<Window::SessionController*> _controller;
	const Fn<void(std::string)> _openNote;

	std::shared_ptr<const Sections::NotesView> _notes;
	std::vector<notes::CanvasRef> _canvases;
	std::set<std::string> _removedIds;
	std::string _canvasId;
	std::string _loadedId;
	std::string _knownText;
	std::map<std::string, notes::NoteRef> _noteByTitle;
	std::vector<cloud::CloudNode> _driveNodes;
	std::map<std::string, std::optional<std::size_t>> _driveFiles;
	std::string _driveId;
	std::set<std::string> _filesOnCanvas;

	// Поиск из шапки раздела (как web `found`): найденные карточки подсвечены, остальные приглушены
	QString _searchQuery;
	std::optional<std::set<std::string>> _found;
	int _foundAt = -1;
	base::Timer _foundTimer;

	CanvasDocPtr _doc;
	std::optional<Live> _live;
	notes::CanvasHistory _history;
	std::optional<Pending> _pending;
	base::Timer _saveTimer;
	bool _damaged = false;
	bool _creating = false;
	bool _creatingNote = false;

	notes::BoardView _view;
	bool _viewFitted = false;
	CanvasSelection _selection;
	std::optional<CanvasRect> _marquee;
	std::optional<notes::CanvasCurve> _draft;
	std::optional<std::string> _linkFrom;
	bool _selectMode = false;
	std::optional<std::string> _hoverGroup;
	std::optional<std::string> _hoverNode;
	std::optional<Gesture> _gesture;
	std::optional<QPointF> _pointer;
	bool _spaceDown = false;

	std::optional<Inline> _inline;
	Ui::InputField *_field = nullptr;
	bool _finishing = false;

	std::optional<MenuState> _menu;
	base::unique_qptr<CanvasWidgets::ContextMenu> _menuWidget;
	CanvasWidgets::SelectionBar *_bar = nullptr;

	std::optional<std::pair<std::string, std::string>> _savingNote; // заметка, текст на записи
	std::optional<std::pair<std::string, std::string>> _renaming; // прежнее → новое название

	std::set<std::string> _acquired;
	bool _syncAcquiredQueued = false;
	mutable std::map<std::string, std::pair<std::string, CanvasLook::TextLayout>> _layouts;

	// панели
	Ui::RpWidget *_chipRow = nullptr;
	std::vector<CanvasWidgets::Chip*> _chips;
	int _chipScroll = 0;
	Ui::RpWidget *_toolRow = nullptr;
	CanvasWidgets::ToolButton *_toolConnect = nullptr;
	CanvasWidgets::ToolButton *_toolSelect = nullptr;
	CanvasWidgets::ToolButton *_toolGroup = nullptr;
	Ui::RpWidget *_zoom = nullptr;
	CanvasWidgets::ToolButton *_undo = nullptr;
	CanvasWidgets::ToolButton *_redo = nullptr;
	Ui::RpWidget *_start = nullptr;

	static std::string LastClipText;

};

std::string Board::LastClipText;

Board::Board(
	QWidget *parent,
	not_null<Window::SessionController*> controller,
	std::string canvasId,
	Fn<void(std::string)> openNote)
: RpWidget(parent)
, _controller(controller)
, _openNote(std::move(openNote))
, _canvasId(std::move(canvasId))
, _doc(Share(notes::createEmptyCanvas()))
, _foundTimer([=] { searchNext(); })
, _saveTimer([=] { flushSave(); }) {
	setMouseTracking(true);
	setFocusPolicy(Qt::StrongFocus);
	setAttribute(Qt::WA_AcceptTouchEvents, false);
	RepaintOnTones(this);
	setupTools();

	CanvasMedia::Updated() | rpl::on_next([=] {
		update();
	}, lifetime());

	Sections::NotesValue() | rpl::on_next([=](std::shared_ptr<const Sections::NotesView> view) {
		applyNotes(std::move(view));
	}, lifetime());
}

Board::~Board() {
	// Уход с вкладки посреди правки заметки: набранное сохраняется
	if (_inline && _inline->kind == InlineKind::Note && _field) {
		const auto text = S(_field->getLastText());
		if (text != _inline->base) {
			const auto current = *_inline;
			const auto vault = VaultName();
			Sections::Post([=](Sections::Workers &w) {
				w.notes.saveNoteOrRestore(current.noteId, current.noteTitle, text, vault, current.base);
			});
		}
	}
	_inline.reset();
	flushSave();
	for (const auto &fileId : _acquired) {
		CanvasMedia::Release(fileId);
	}
	if (_field) {
		delete base::take(_field);
	}
}

// ── данные ───────────────────────────────────────────────────────────────────

notes::CanvasRef Board::entry() const {
	for (const auto &canvas : _canvases) {
		if (canvas->id == _canvasId) {
			return canvas;
		}
	}
	return _canvases.empty() ? nullptr : _canvases.front();
}

void Board::applyNotes(std::shared_ptr<const Sections::NotesView> view) {
	_notes = std::move(view);
	_canvases.clear();
	for (const auto &canvas : _notes->canvases) {
		if (!_removedIds.contains(canvas->id)) {
			_canvases.push_back(canvas);
		}
	}
	_noteByTitle.clear();
	for (const auto &note : _notes->notes) {
		_noteByTitle.emplace(Lower(note->title), note);
	}
	_driveNodes.clear();
	_driveId.clear();
	if (const auto &cloudData = _notes->cloud; cloudData && cloudData->rootId) {
		_driveId = *cloudData->rootId;
		_driveNodes = cloudData->nodesOf(cloudData->rootId);
	}
	_driveFiles.clear();
	const auto current = entry();
	rebuildChips();
	if (!current) {
		_loadedId.clear();
		refreshTools();
		update();
		return;
	}
	if (_loadedId != current->id) {
		_canvasId = current->id;
		_loadedId = current->id;
		select({});
		loadDoc(current->text);
		CanvasMedia::ForgetEmptyPreviews();
		_viewFitted = false;
		if (width() > 0 && height() > 0) {
			_view = fitTo(*_doc);
			_viewFitted = true;
		}
	} else if (current->text != _knownText) {
		_knownText = current->text;
		// Своя несохранённая правка новее пришедшего текста; текст, равный открытому документу, — эхо своей записи
		if (!_pending && current->text != notes::serializeCanvas(*_doc)) {
			const auto doc = loadDoc(current->text);
			select(notes::pruneSelection(*doc, _selection));
		}
	}
	refreshTools();
	measureTextCards();
	update();
}

CanvasDocPtr Board::loadDoc(const std::string &text) {
	auto parsed = notes::parseCanvas(text);
	_knownText = text;
	// Несохранённый текст заметки к файлу холста не относится: он сохраняется, а не пропадает с документом
	if (_inline && _inline->kind == InlineKind::Note) {
		finishInline();
	}
	_doc = Share(std::move(parsed.doc));
	if (_inline) {
		_inline.reset();
		if (_field) {
			delete base::take(_field);
		}
	}
	_history = notes::createHistory();
	dropGesture();
	_damaged = parsed.error.has_value();
	_linkFrom.reset();
	closeMenu();
	syncHistory();
	_layouts.clear();
	return _doc;
}

void Board::flushSave(bool drop) {
	_saveTimer.cancel();
	auto pending = std::exchange(_pending, std::nullopt);
	if (!pending || drop) {
		return;
	}
	const auto text = notes::serializeCanvas(*pending->doc);
	if (pending->id == _loadedId) {
		_knownText = text;
	}
	const auto vault = VaultName();
	Sections::Post([id = pending->id, title = pending->title, text, vault](Sections::Workers &w) {
		w.notes.saveCanvas(title, text, vault, id);
	});
}

void Board::applyDoc(CanvasDocPtr next) {
	_doc = std::move(next);
	const auto current = entry();
	if (current) {
		const auto now = crl::now();
		const auto since = _pending ? _pending->since : now;
		_pending = Pending{ current->id, current->title, _doc, since };
		_saveTimer.callOnce(std::max(crl::time(0), std::min(kSaveDelayMs, since + kSaveMaxWaitMs - now)));
	}
	refreshTools();
	measureTextCards();
	refreshFound();
	updateFieldGeometry();
	update();
}

void Board::change(CanvasDoc next, bool isAmend) {
	if (next == *_doc) {
		return;
	}
	if (!isAmend) {
		_history = notes::recordStep(_history, _doc);
		syncHistory();
	}
	applyDoc(Share(std::move(next)));
}

void Board::syncHistory() {
	if (_undo) {
		_undo->setEnabled(!_history.past.empty());
		_undo->update();
	}
	if (_redo) {
		_redo->setEnabled(!_history.future.empty());
		_redo->update();
	}
}

double Board::textContentHeight(const CanvasNode &node) const {
	// Рамка 2, поля 0.5rem 0.75rem, строки текста
	const auto inner = node.width - kGroupBorder * 2 - kPadX * 2;
	const auto text = Str(node, "text");
	const auto key = node.id;
	const auto signature = std::to_string(inner) + '\n' + text;
	auto &cached = _layouts[key];
	if (cached.first != signature) {
		auto lines = std::vector<std::string>();
		auto from = std::size_t(0);
		while (true) {
			const auto to = text.find('\n', from);
			lines.push_back(text.substr(from, to == std::string::npos ? std::string::npos : to - from));
			if (to == std::string::npos) {
				break;
			}
			from = to + 1;
		}
		cached = { signature, CanvasLook::LayoutLines(lines, inner, BodyStyle(ToneColor(Tone::Fg))) };
	}
	return kGroupBorder * 2 + kPadY * 2 + cached.second.height();
}

// Высота текстовой карточки идёт по тексту: карточка растёт вместе с ним, а узел документа догоняет её здесь. Это не
// правка пользователя: шага истории и записи в облако нет
void Board::measureTextCards() {
	if (_live || _inline || _gesture) {
		return;
	}
	const auto current = _doc;
	auto next = *current;
	auto changed = false;
	for (const auto &node : current->nodes) {
		if (node.type != "text") {
			continue;
		}
		const auto height = std::ceil(textContentHeight(node));
		if (height > node.height + 0.5) {
			next = notes::updateNode(next, node.id, { { "height", CanvasJson(height) } });
			changed = true;
		}
	}
	if (!changed) {
		return;
	}
	next = notes::growGroups(*current, next);
	_doc = Share(std::move(next));
	if (_pending) {
		_pending->doc = _doc;
	}
}

notes::NoteRef Board::noteOf(const std::string &title) const {
	const auto key = Lower(title);
	if (const auto i = _noteByTitle.find(key); i != _noteByTitle.end()) {
		return i->second;
	}
	// Пока идёт переименование с холста, карточка несёт новое название, а заметка ещё прежнее
	if (_renaming && key == Lower(_renaming->second)) {
		if (const auto i = _noteByTitle.find(Lower(_renaming->first)); i != _noteByTitle.end()) {
			return i->second;
		}
	}
	return nullptr;
}

notes::NoteCardState Board::noteStateOf(const notes::NoteRef &note) const {
	if (note) {
		return notes::NoteCardState::Found;
	}
	return (_notes && _notes->status == notes::NotesStatus::Ready)
		? notes::NoteCardState::Missing
		: notes::NoteCardState::Loading;
}

const cloud::CloudNode *Board::driveFile(const CanvasNode &node) const {
	const auto path = node.str("file");
	if (!path || path->empty()) {
		return nullptr;
	}
	auto &files = const_cast<Board*>(this)->_driveFiles;
	auto i = files.find(*path);
	if (i == files.end()) {
		const auto found = notes::resolveDrivePath(_driveNodes, *path);
		i = files.emplace(*path, found
			? std::optional<std::size_t>(std::size_t(found - _driveNodes.data()))
			: std::nullopt).first;
	}
	return i->second ? &_driveNodes[*i->second] : nullptr;
}

// Карточка файла — заметка: путь кончается на `.md` и такая заметка есть (либо файла с таким путём нет)
std::optional<std::string> Board::noteTitleOf(const CanvasNode &node) const {
	if (node.type != "file") {
		return std::nullopt;
	}
	const auto title = notes::noteTitleOfPath(node.str("file"));
	if (!title) {
		return std::nullopt;
	}
	return (_noteByTitle.contains(Lower(*title)) || !driveFile(node)) ? title : std::nullopt;
}

std::vector<notes::GraphNoteInput> Board::graphNotes() const {
	auto result = std::vector<notes::GraphNoteInput>();
	if (!_notes) {
		return result;
	}
	for (const auto &note : _notes->notes) {
		result.push_back({
			.id = note->id,
			.title = note->title,
			.folder = note->folder,
			.links = notes::parseNote(note->text).links,
			.isDaily = note->isDaily,
		});
	}
	return result;
}

QString Board::nameOfNode(const std::string &id) const {
	const auto node = notes::findNode(*_doc, id);
	if (!node) {
		return u"?"_q;
	}
	if (const auto name = notes::canvasNodeName(*node)) {
		return Q(*name);
	}
	return (node->type == "group")
		? tr::lng_parvane_canvas_group(tr::now)
		: tr::lng_parvane_canvas_text(tr::now);
}

// ── вид ──────────────────────────────────────────────────────────────────────

// Точки холста и размеры web — в «точках CSS»: на масштабе интерфейса 100 % это пиксели виджета
double Board::k() const {
	return Px(1000) / 1000.;
}

QSizeF Board::viewport() const {
	return QSizeF(std::max(width(), 1) / k(), std::max(height(), 1) / k());
}

bool Board::isNarrow() const {
	return viewport().width() <= kNarrowWidth;
}

CanvasPoint Board::toCanvas(QPointF logical) const {
	const auto css = logical / k();
	return { (css.x() - _view.x) / _view.scale, (css.y() - _view.y) / _view.scale };
}

QPointF Board::toScreen(CanvasPoint point) const {
	return QPointF(point.x * _view.scale + _view.x, point.y * _view.scale + _view.y) * k();
}

void Board::applyView(notes::BoardView next) {
	_view = next;
	updateFieldGeometry();
	refreshBar();
	update();
}

// Вид, в котором видно всё (на узком экране — крупно первая группа со своим содержимым)
notes::BoardView Board::fitTo(const CanvasDoc &doc) const {
	auto fitted = std::vector<notes::BoardRect>();
	const auto narrow = isNarrow();
	const CanvasNode *group = nullptr;
	if (narrow) {
		for (const auto &node : doc.nodes) {
			if (node.type == "group") {
				group = &node;
				break;
			}
		}
	}
	const auto push = [&](const CanvasNode &node) {
		if (node.type == "group") {
			fitted.push_back({ node.x, node.y - kGroupLabelRoom, node.width, node.height + kGroupLabelRoom });
		} else {
			fitted.push_back({ node.x, node.y, node.width, node.height });
		}
	};
	if (group) {
		push(*group);
		for (const auto &node : notes::nodesInGroup(doc, group->id)) {
			push(node);
		}
	} else {
		for (const auto &node : doc.nodes) {
			push(node);
		}
	}
	const auto size = viewport();
	return notes::fitRects(fitted, size.width(), size.height(), narrow ? kFitTopNarrow : kFitTop, kFitBottom);
}

void Board::zoomBy(double factor) {
	const auto size = viewport();
	applyView(notes::zoomAround(_view, _view.scale * factor, size.width() / 2., size.height() / 2.));
}

CanvasPoint Board::centerPoint() const {
	const auto size = viewport();
	const auto count = int(_doc->nodes.size());
	return {
		std::round((size.width() / 2. - _view.x) / _view.scale) + (count % kNewColumns) * kNewOffsetX,
		std::round((size.height() / 2. - _view.y) / _view.scale) + (count / kNewColumns) * (kNoteHeight + kNewOffsetY),
	};
}

std::optional<CanvasPoint> Board::pointerPoint() const {
	if (!_pointer || !rect().contains(_pointer->toPoint())) {
		return std::nullopt;
	}
	return toCanvas(*_pointer);
}

// ── показ ────────────────────────────────────────────────────────────────────

const CanvasDoc &Board::shown() const {
	return _live ? _live->doc : *_doc;
}

const CanvasNode *Board::selectedNode() const {
	if (_selection.nodes.size() != 1 || !_selection.edges.empty()) {
		return nullptr;
	}
	return notes::findNode(shown(), _selection.nodes.front());
}

const CanvasEdge *Board::selectedEdge() const {
	if (_selection.edges.size() != 1 || !_selection.nodes.empty()) {
		return nullptr;
	}
	return notes::findEdge(*_doc, _selection.edges.front());
}

// Ручки размера и точки для стрелок — у единственного выделенного узла, когда нет ни правки, ни режима связи
bool Board::hasGrips(const CanvasNode &node) const {
	const auto selected = selectedNode();
	return selected && selected->id == node.id && !_linkFrom && !(_inline && _inline->id == node.id);
}

double Board::shownHeight(const CanvasNode &node) const {
	if (node.type == "text") {
		// Высота текстовой карточки — не меньше заданной и не меньше её текста
		auto height = std::max(node.height, textContentHeight(node));
		if (_inline && _inline->id == node.id && _field) {
			height = std::max(height, _field->height() / (k() * _view.scale) + kGroupBorder * 2);
		}
		return height;
	}
	if (_inline && _inline->id == node.id && _inline->kind == InlineKind::Note && _field) {
		// Пока правится текст заметки, карточка растёт за ним
		return std::max(node.height, NoteHeadHeight() + _field->height() / (k() * _view.scale));
	}
	return node.height;
}

void Board::paintBackground(QPainter &p) {
	// `.board`: фон `--pv-bg` на 55 % поверх панели, точки `--pv-line2` в клетке 22 точки, едут вместе с полем
	const auto bg = Blend(ToneColor(Tone::Bg), ToneColor(Tone::Panel), 0.55);
	p.fillRect(rect(), bg);
	const auto cell = notes::kBoardGrid * _view.scale * k();
	if (cell < 4.) {
		return;
	}
	const auto ratio = style::DevicePixelRatio();
	const auto side = std::max(2, int(std::round(cell * ratio)));
	static auto cache = std::pair<int, QImage>{ 0, QImage() };
	static auto cacheColor = QColor();
	const auto dot = ToneColor(Tone::Line2);
	if (cache.first != side || cacheColor != dot) {
		auto tile = QImage(side, side, QImage::Format_ARGB32_Premultiplied);
		tile.fill(Qt::transparent);
		{
			auto q = QPainter(&tile);
			PainterHighQualityEnabler hq(q);
			q.setPen(Qt::NoPen);
			q.setBrush(dot);
			const auto r = 1.15 * ratio;
			q.drawEllipse(QPointF(0, 0), r, r);
			q.drawEllipse(QPointF(side, 0), r, r);
			q.drawEllipse(QPointF(0, side), r, r);
			q.drawEllipse(QPointF(side, side), r, r);
		}
		cache = { side, tile };
		cacheColor = dot;
	}
	auto brush = QBrush(cache.second);
	auto transform = QTransform();
	transform.translate(_view.x * k(), _view.y * k());
	transform.scale(cell / side, cell / side);
	brush.setTransform(transform);
	p.fillRect(rect(), brush);
}

void Board::paintEdge(QPainter &p, const CanvasEdge &edge, std::optional<bool> linked) {
	const auto &doc = shown();
	const auto from = notes::findNode(doc, edge.fromNode);
	const auto to = notes::findNode(doc, edge.toNode);
	if (!from || !to) {
		return;
	}
	const auto anchors = notes::edgeAnchors(from->rect(), to->rect(), notes::sidesOf(edge));
	const auto curve = notes::curveBetween(anchors.from, anchors.to);
	const auto arrows = notes::canvasEdgeArrows(edge);
	const auto isOn = std::find(_selection.edges.begin(), _selection.edges.end(), edge.id) != _selection.edges.end();
	const auto accent = isOn || (linked && *linked);
	const auto color = accent
		? ToneColor(Tone::Accent)
		: CanvasLook::PresetColor(edge.str("color")).value_or(ToneColor(Tone::Muted));
	p.save();
	if (!isOn && linked && !*linked) {
		p.setOpacity(0.2);
	}
	const auto start = notes::canvasLineEnd(curve.p, arrows.start);
	const auto end = notes::canvasLineEnd(curve.q, arrows.end);
	auto path = QPainterPath(QPointF(start.x, start.y));
	path.cubicTo(QPointF(curve.c1.x, curve.c1.y), QPointF(curve.c2.x, curve.c2.y), QPointF(end.x, end.y));
	p.setBrush(Qt::NoBrush);
	p.setPen(QPen(color, accent ? 3. : 2.));
	p.drawPath(path);
	const auto head = [&](const notes::CanvasAnchor &anchor) {
		const auto h = notes::canvasArrowHead(anchor);
		auto polygon = QPolygonF();
		polygon << QPointF(h.tip.x, h.tip.y) << QPointF(h.left.x, h.left.y) << QPointF(h.right.x, h.right.y);
		p.setPen(Qt::NoPen);
		p.setBrush(color);
		p.drawPolygon(polygon);
	};
	if (arrows.start) {
		head(curve.p);
	}
	if (arrows.end) {
		head(curve.q);
	}
	const auto label = Str(edge, "label");
	const auto hidden = _inline && _inline->kind == InlineKind::Edge && _inline->id == edge.id;
	if (!label.empty() && !hidden) {
		// `.canvasEdgeLabel`: 12 точек, по середине, обводка цветом фона 4 точки
		const auto point = notes::curvePoint(curve, 0.5);
		const auto font = CanvasLook::CanvasFont(12.);
		const auto text = Q(label);
		const auto w = QFontMetricsF(font).horizontalAdvance(text);
		auto textPath = QPainterPath();
		textPath.addText(QPointF(point.x - w / 2., point.y + 4.), font, text);
		auto pen = QPen(ToneColor(Tone::Bg), 4.);
		pen.setJoinStyle(Qt::RoundJoin);
		p.setPen(pen);
		p.setBrush(Qt::NoBrush);
		p.drawPath(textPath);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Fg));
		p.drawPath(textPath);
	}
	p.restore();
}

void Board::paintSelectionOutline(QPainter &p, QRectF rect, double radius, double offset, bool dashed) {
	// `outline: 2px solid --pv-accent; outline-offset`
	auto pen = QPen(ToneColor(Tone::Accent), 2.);
	if (dashed) {
		pen.setStyle(Qt::DashLine);
	}
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	const auto grow = offset + 1.;
	p.drawRoundedRect(rect.adjusted(-grow, -grow, grow, grow), radius + grow, radius + grow);
}

void Board::paintGroup(QPainter &p, const CanvasNode &node) {
	const auto rect = RectOf(node.rect());
	const auto gc = CanvasLook::PresetColor(node.str("color"));
	const auto line = gc.value_or(ToneColor(Tone::Line2));
	const auto panel = ToneColor(Tone::Panel);
	const auto hover = (_hoverGroup == node.id);
	PainterHighQualityEnabler hq(p);
	// Рамка: скругление только снизу (сверху — шапка)
	{
		auto path = QPainterPath();
		const auto r = 16.;
		const auto inner = rect.adjusted(kGroupBorder / 2., kGroupBorder / 2., -kGroupBorder / 2., -kGroupBorder / 2.);
		path.moveTo(inner.topLeft());
		path.lineTo(inner.topRight());
		path.lineTo(inner.right(), inner.bottom() - r);
		path.quadTo(inner.bottomRight(), QPointF(inner.right() - r, inner.bottom()));
		path.lineTo(inner.left() + r, inner.bottom());
		path.quadTo(inner.bottomLeft(), QPointF(inner.left(), inner.bottom() - r));
		path.closeSubpath();
		p.setBrush(Fade(line, hover ? 0.13 : 0.07));
		p.setPen(QPen(line, kGroupBorder));
		p.drawPath(path);
	}
	// Шапка вдоль верхнего края: название группы; за неё группу берут и двигают
	const auto head = QRectF(rect.x() - kGroupBorder, rect.y() - kGroupBorder - kGroupHead, rect.width() + kGroupBorder * 2, kGroupHead);
	{
		auto path = QPainterPath();
		const auto r = 12.;
		const auto h = head.adjusted(kGroupBorder / 2., kGroupBorder / 2., -kGroupBorder / 2., 0.);
		path.moveTo(h.bottomLeft());
		path.lineTo(h.left(), h.top() + r);
		path.quadTo(h.topLeft(), QPointF(h.left() + r, h.top()));
		path.lineTo(h.right() - r, h.top());
		path.quadTo(h.topRight(), QPointF(h.right(), h.top() + r));
		path.lineTo(h.bottomRight());
		p.setBrush(Blend(line, panel, hover ? 0.30 : 0.16));
		p.setPen(QPen(line, kGroupBorder));
		p.drawPath(path);
	}
	const auto editing = _inline && _inline->id == node.id;
	if (!editing) {
		const auto label = Str(node, "label");
		const auto left = head.x() + 10.;
		const auto room = head.width() - 20.;
		if (!label.empty()) {
			const auto font = CanvasLook::CanvasFont(16., true);
			p.setFont(font);
			p.setPen(gc.value_or(ToneColor(Tone::Muted)));
			const auto text = QFontMetricsF(font).elidedText(Q(label), Qt::ElideRight, room);
			p.drawText(QRectF(left, head.y(), room, head.height()), Qt::AlignLeft | Qt::AlignVCenter, text);
		} else {
			// Группа без названия: в шапке приглушённое слово «Группа»
			const auto faint = ToneColor(Tone::Faint);
			CanvasLook::PaintIcon(p, u"group"_q, faint, QRectF(left, head.center().y() - 9., 18., 18.));
			const auto font = CanvasLook::CanvasFont(16.);
			p.setFont(font);
			p.setPen(faint);
			p.drawText(
				QRectF(left + 24., head.y(), room - 24., head.height()),
				Qt::AlignLeft | Qt::AlignVCenter,
				tr::lng_parvane_canvas_group(tr::now));
		}
	}
	const auto selected = std::find(_selection.nodes.begin(), _selection.nodes.end(), node.id) != _selection.nodes.end();
	if (selected) {
		paintSelectionOutline(p, rect, 16., 3.);
	}
	if (hasGrips(node)) {
		paintGrips(p, node, rect);
	}
}

void Board::paintTextBody(QPainter &p, const CanvasNode &node, QRectF card) {
	if (_inline && _inline->id == node.id) {
		return;
	}
	textContentHeight(node);
	const auto &layout = _layouts[node.id].second;
	const auto body = card.adjusted(kGroupBorder + kPadX, kGroupBorder + kPadY, -kGroupBorder - kPadX, -kGroupBorder);
	CanvasLook::PaintLayout(p, layout, body.topLeft(), body.bottom(), BodyStyle(ToneColor(Tone::Fg)));
}

void Board::paintNoteCard(QPainter &p, const CanvasNode &node, QRectF card, const std::string &title) {
	const auto note = noteOf(title);
	const auto state = noteStateOf(note);
	const auto headHeight = NoteHeadHeight();
	const auto inner = card.adjusted(1., 1., -1., -1.);
	const auto head = QRectF(inner.x(), inner.y(), inner.width(), headHeight);
	// `.canvasCardHead`: точка цвета папки, название, «открыть заметку»; линия снизу
	p.fillRect(QRectF(head.x(), head.bottom() - 1., head.width(), 1.), ToneColor(Tone::Line));
	const auto dot = note ? CanvasLook::FolderColor(note->folder, note->isDaily) : ToneColor(Tone::Faint);
	{
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(dot);
		p.drawEllipse(QRectF(head.x() + kPadX, head.center().y() - 4.5, 8., 8.));
	}
	const auto editingTitle = _inline && _inline->id == node.id && _inline->kind == InlineKind::Title;
	const auto editingText = _inline && _inline->id == node.id && _inline->kind == InlineKind::Note;
	const auto titleLeft = head.x() + kPadX + 8. + 8.;
	const auto openRight = head.right() - kPadX + 6.;
	const auto titleRight = (note && !editingTitle) ? (openRight - 24. - 8.) : (head.right() - kPadX);
	if (!editingTitle) {
		const auto font = CanvasLook::CanvasFont(15., true);
		p.setFont(font);
		p.setPen(ToneColor(Tone::Fg));
		const auto text = QFontMetricsF(font).elidedText(Q(title), Qt::ElideRight, titleRight - titleLeft);
		p.drawText(QRectF(titleLeft, head.y(), titleRight - titleLeft, head.height() - 1.), Qt::AlignLeft | Qt::AlignVCenter, text);
	}
	if (note && !editingTitle) {
		const auto button = QRectF(openRight - 24., head.center().y() - 12., 24., 24.);
		CanvasLook::PaintIcon(p, u"open"_q, ToneColor(Tone::Faint), button.adjusted(3., 3., -3., -3.));
	}
	if (editingText) {
		return;
	}
	const auto body = QRectF(inner.x() + kPadX, head.bottom() + kPadY, inner.width() - kPadX * 2, 0.);
	const auto bottom = inner.bottom();
	const auto style = BodyStyle(ToneColor(Tone::Muted));
	if (note) {
		// Начало текста заметки без разметки; отправленный на запись текст — сразу
		const auto text = (_savingNote && _savingNote->first == note->id) ? _savingNote->second : note->text;
		const auto key = "note:" + node.id;
		const auto signature = std::to_string(body.width()) + '\n' + note->title + '\n' + text;
		auto &cached = _layouts[key];
		if (cached.first != signature) {
			const auto lines = notes::notePreviewLines(notes::parseNote(text).body, note->title, kPreviewLines);
			cached = { signature, CanvasLook::LayoutLines(lines, body.width(), style) };
		}
		p.save();
		p.setClipRect(QRectF(inner.x(), head.bottom(), inner.width(), bottom - head.bottom()), Qt::IntersectClip);
		CanvasLook::PaintLayout(p, cached.second, body.topLeft(), bottom, style);
		p.restore();
	} else {
		const auto font = CanvasLook::CanvasFont(13.);
		p.setFont(font);
		p.setPen(ToneColor(Tone::Faint));
		const auto text = (state == notes::NoteCardState::Loading)
			? tr::lng_parvane_canvas_note_loading(tr::now)
			: tr::lng_parvane_canvas_note_missing(tr::now);
		p.drawText(QRectF(body.x(), body.y(), body.width(), 13. * 1.45), Qt::AlignLeft | Qt::AlignVCenter, text);
	}
}

void Board::paintLinkBody(QPainter &p, const CanvasNode &node, QRectF card) {
	const auto url = Str(node, "url");
	const auto preview = CanvasMedia::LinkPreview(url);
	const auto inner = card.adjusted(kGroupBorder, kGroupBorder, -kGroupBorder, -kGroupBorder);
	const auto hasContent = preview && notes::hasPreviewContent(preview->preview);
	// `.canvasLinkFoot`: значок, узел сайта, «открыть»
	const auto footHeight = 6. + 28. + 6.;
	const auto foot = QRectF(inner.x(), inner.bottom() - footHeight, inner.width(), footHeight);
	auto textTop = inner.y();
	auto textBottom = foot.y();
	p.save();
	{
		auto clip = QPainterPath();
		clip.addRoundedRect(inner, 10., 10.);
		p.setClipPath(clip, Qt::IntersectClip);
	}
	const auto image = preview ? preview->image : QImage();
	if (!image.isNull()) {
		// Картинка сверху (`object-fit: cover`), текст под ней не выше 45 %
		const auto textHeight = std::min((foot.y() - inner.y()) * 0.45, 8. + 13. * 1.4 * 3);
		const auto imageRect = QRectF(inner.x(), inner.y(), inner.width(), foot.y() - inner.y() - textHeight);
		if (imageRect.height() > 1.) {
			const auto scale = std::max(imageRect.width() / image.width(), imageRect.height() / image.height());
			const auto w = image.width() * scale;
			const auto h = image.height() * scale;
			p.save();
			p.setClipRect(imageRect, Qt::IntersectClip);
			p.drawImage(QRectF(imageRect.center().x() - w / 2., imageRect.center().y() - h / 2., w, h), image);
			p.restore();
		}
		textTop = imageRect.bottom();
	}
	auto y = textTop + 8.;
	const auto left = inner.x() + kPadX;
	const auto width = inner.width() - kPadX * 2;
	p.setClipRect(QRectF(inner.x(), textTop, inner.width(), textBottom - textTop), Qt::IntersectClip);
	if (!preview) {
		// Пока превью читается — две полоски-заглушки
		p.setPen(Qt::NoPen);
		p.setBrush(Fade(ToneColor(Tone::Line2), 0.6));
		p.drawRoundedRect(QRectF(left, y, width * 0.85, 10.), 5., 5.);
		p.drawRoundedRect(QRectF(left, y + 14., width * 0.55, 10.), 5., 5.);
	} else {
		const auto lineHeight = 13. * 1.4;
		const auto paintWrapped = [&](const QString &text, const QFont &font, QColor color, int maxLines) {
			auto layout = QStringList();
			const auto metrics = QFontMetricsF(font);
			// показываем не больше нужного на maxLines строк: подбор длины строки на длинном адресе иначе квадратичен
			auto rest = text.left(maxLines * 120);
			while (!rest.isEmpty() && layout.size() < maxLines) {
				auto count = rest.size();
				while (count > 1 && metrics.horizontalAdvance(rest.left(count)) > width) {
					const auto space = rest.left(count - 1).lastIndexOf(' ');
					count = (space > 0) ? space : count - 1;
				}
				layout.push_back(rest.left(count));
				rest = rest.mid(count).trimmed();
			}
			if (!rest.isEmpty() && !layout.isEmpty()) {
				layout.back() = metrics.elidedText(layout.back() + u" "_q + rest, Qt::ElideRight, width);
			}
			p.setFont(font);
			p.setPen(color);
			for (const auto &line : layout) {
				p.drawText(QRectF(left, y, width, lineHeight), Qt::AlignLeft | Qt::AlignVCenter, line);
				y += lineHeight;
			}
			y += 4.;
		};
		if (preview->preview.title) {
			paintWrapped(Q(*preview->preview.title), CanvasLook::CanvasFont(13., true), ToneColor(Tone::Fg), 2);
		}
		if (preview->preview.description) {
			paintWrapped(Q(*preview->preview.description), CanvasLook::CanvasFont(13.), ToneColor(Tone::Muted), 6);
		}
		if (!hasContent) {
			paintWrapped(Q(url), CanvasLook::CanvasFont(13.), ToneColor(Tone::Muted), 6);
		}
	}
	p.restore();
	const auto muted = ToneColor(Tone::Muted);
	CanvasLook::PaintIcon(p, u"link"_q, muted, QRectF(foot.x() + kPadX, foot.center().y() - 9., 18., 18.));
	const auto host = (preview && preview->preview.siteName) ? *preview->preview.siteName : notes::hostOf(url);
	const auto font = CanvasLook::CanvasFont(12.);
	const auto hostLeft = foot.x() + kPadX + 18. + 6.;
	const auto button = QRectF(foot.right() - 8. - 28., foot.center().y() - 14., 28., 28.);
	p.setFont(font);
	p.setPen(muted);
	p.drawText(
		QRectF(hostLeft, foot.y(), button.x() - 6. - hostLeft, foot.height()),
		Qt::AlignLeft | Qt::AlignVCenter,
		QFontMetricsF(font).elidedText(Q(host), Qt::ElideRight, button.x() - 6. - hostLeft));
	CanvasLook::PaintIcon(p, u"open"_q, ToneColor(Tone::Accent), button.adjusted(5., 5., -5., -5.));
}

void Board::paintFileBody(QPainter &p, const CanvasNode &node, QRectF card, std::set<std::string> &wanted) {
	const auto file = driveFile(node);
	const auto inner = card.adjusted(1., 1., -1., -1.);
	// `.canvasFileFoot`: имя и размер
	const auto footHeight = 6. + QFontMetricsF(CanvasLook::CanvasFont(13., true)).height() + 6.;
	const auto foot = QRectF(inner.x(), inner.bottom() - footHeight, inner.width(), footHeight);
	const auto area = QRectF(inner.x(), inner.y(), inner.width(), foot.y() - inner.y());
	auto image = QImage();
	if (file) {
		const auto quality = CanvasMedia::ImageQuality();
		// Картинка в полном качестве — когда карточка на экране шире порога
		const auto large = node.width * _view.scale >= notes::kCanvasFullImageMinPx;
		const auto source = notes::canvasImageSource(file, quality);
		// Без миниатюры (вставленная картинка, миниатюра не прочиталась) мелкая карточка иначе осталась бы
		// пустой — берётся сам файл
		const auto noThumb = CanvasMedia::ThumbUnavailable(*file);
		if ((large || noThumb) && source == notes::CanvasImageSource::Full && file->blob) {
			const auto fileId = file->blob->value("fileId", std::string());
			wanted.insert(fileId);
			if (!_acquired.contains(fileId)) {
				CanvasMedia::Acquire(_driveId, *file);
				_acquired.insert(fileId);
			}
			image = CanvasMedia::Full(fileId);
		}
		if (image.isNull() && file->thumb && !file->thumb->is_null()) {
			image = CanvasMedia::Thumb(_driveId, *file);
		}
	}
	p.save();
	{
		auto clip = QPainterPath();
		clip.addRoundedRect(inner, 10., 10.);
		p.setClipPath(clip, Qt::IntersectClip);
	}
	if (!image.isNull() && area.height() > 1.) {
		// `object-fit: contain` на подложке
		p.fillRect(area, Blend(ToneColor(Tone::Bg), ToneColor(Tone::Panel), 0.6));
		const auto scale = std::min(area.width() / image.width(), area.height() / image.height());
		const auto w = image.width() * scale;
		const auto h = image.height() * scale;
		p.drawImage(QRectF(area.center().x() - w / 2., area.center().y() - h / 2., w, h), image);
	} else if (area.height() > 1.) {
		const auto muted = ToneColor(Tone::Muted);
		const auto label = file ? Q(cloud::fileTypeLabel(file->name)) : QString();
		const auto labelHeight = label.isEmpty() ? 0. : 15.;
		const auto top = area.center().y() - (22. + labelHeight) / 2.;
		CanvasLook::PaintIcon(p, file ? u"file"_q : u"x"_q, muted, QRectF(area.center().x() - 11., top, 22., 22.));
		if (!label.isEmpty()) {
			auto font = CanvasLook::CanvasFont(11., true);
			font.setLetterSpacing(QFont::PercentageSpacing, 104.);
			p.setFont(font);
			p.setPen(muted);
			p.drawText(QRectF(area.x(), top + 22. + 2., area.width(), 13.), Qt::AlignHCenter | Qt::AlignVCenter, label);
		}
	}
	p.restore();
	const auto name = file ? Q(file->name) : Q(notes::fileNameOfPath(node.str("file")));
	const auto size = file
		? Q(notes::formatCardSize(double(file->size)))
		: tr::lng_parvane_canvas_file_missing(tr::now);
	const auto sizeFont = CanvasLook::CanvasFont(12.);
	const auto sizeWidth = QFontMetricsF(sizeFont).horizontalAdvance(size);
	const auto right = foot.right() - 8.;
	p.setFont(sizeFont);
	p.setPen(ToneColor(Tone::Muted));
	p.drawText(QRectF(right - sizeWidth, foot.y(), sizeWidth, foot.height()), Qt::AlignRight | Qt::AlignVCenter, size);
	const auto nameFont = CanvasLook::CanvasFont(13., true);
	const auto nameLeft = foot.x() + kPadX;
	const auto nameWidth = std::max(0., right - sizeWidth - 6. - nameLeft);
	p.setFont(nameFont);
	p.setPen(ToneColor(Tone::Fg));
	p.drawText(
		QRectF(nameLeft, foot.y(), nameWidth, foot.height()),
		Qt::AlignLeft | Qt::AlignVCenter,
		QFontMetricsF(nameFont).elidedText(name, Qt::ElideRight, nameWidth));
}

void Board::paintGrips(QPainter &p, const CanvasNode &node, QRectF rect) {
	// Угловые ручки не мельчают при отдалении: размер — в точках экрана
	const auto inv = 1. / _view.scale;
	const auto size = kHandleSize * inv;
	PainterHighQualityEnabler hq(p);
	p.setPen(QPen(ToneColor(Tone::Accent), 2. * inv));
	p.setBrush(ToneColor(Tone::Panel));
	for (const auto handle : notes::kCanvasCornerHandles) {
		const auto x = notes::canvasHandleHas(handle, 'w') ? rect.left() : rect.right();
		const auto y = notes::canvasHandleHas(handle, 'n') ? rect.top() : rect.bottom();
		p.drawRoundedRect(QRectF(x - size / 2., y - size / 2., size, size), 3. * inv, 3. * inv);
	}
}

void Board::paintCard(QPainter &p, const CanvasNode &node, std::optional<bool> linked, std::set<std::string> &wanted) {
	const auto height = shownHeight(node);
	const auto card = QRectF(node.x, node.y, node.width, height);
	const auto title = noteTitleOf(node);
	const auto isTextLike = (node.type == "text" || node.type == "link" || (node.type != "file" && node.type != "group"));
	const auto gc = CanvasLook::PresetColor(node.str("color"));
	const auto dim = linked && !*linked;
	PainterHighQualityEnabler hq(p);
	if (!dim) {
		// `box-shadow: 0 0.375rem 1.125rem rgb(0 0 0 / 25%)` — несколько мягких колец
		p.setPen(Qt::NoPen);
		for (auto i = 3; i > 0; --i) {
			p.setBrush(QColor(0, 0, 0, 14));
			const auto spread = i * 3.;
			p.drawRoundedRect(card.adjusted(-spread, -spread + 6., spread, spread + 6.), kCardRadius + spread, kCardRadius + spread);
		}
	}
	const auto border = (isTextLike && node.type != "file") ? kGroupBorder : 1.;
	p.setPen(QPen((border > 1.) ? gc.value_or(ToneColor(Tone::Line2)) : ToneColor(Tone::Line2), border));
	p.setBrush(ToneColor(Tone::Panel));
	p.drawRoundedRect(card.adjusted(border / 2., border / 2., -border / 2., -border / 2.), kCardRadius, kCardRadius);
	if (node.type == "link") {
		paintLinkBody(p, node, card);
	} else if (node.type == "file" && title) {
		paintNoteCard(p, node, card, *title);
	} else if (node.type == "file") {
		paintFileBody(p, node, card, wanted);
	} else {
		paintTextBody(p, node, card);
	}
	const auto selected = std::find(_selection.nodes.begin(), _selection.nodes.end(), node.id) != _selection.nodes.end()
		|| (_linkFrom == node.id);
	if (selected) {
		paintSelectionOutline(p, card, kCardRadius, 3.);
	} else if (linked && *linked) {
		paintSelectionOutline(p, card, kCardRadius, 2.);
	}
	if (dim) {
		// Приглушение — подложкой поверх карточки (`.canvasDim::after`)
		p.setPen(Qt::NoPen);
		p.setBrush(Fade(ToneColor(Tone::Bg), 0.65));
		p.drawRoundedRect(card.adjusted(-1., -1., 1., 1.), kCardRadius, kCardRadius);
	}
	// Точки для стрелок: у единственной выделенной карточки — всегда, у карточки под указателем — при наведении
	const auto editing = _inline && _inline->id == node.id;
	const auto grips = hasGrips(node);
	if (!_linkFrom && !editing && (grips || _hoverNode == node.id)) {
		const auto inv = 1. / _view.scale;
		const auto size = kPortSize * inv;
		p.setPen(QPen(ToneColor(Tone::Panel), 2. * inv));
		p.setBrush(ToneColor(Tone::Accent));
		for (const auto side : notes::kCanvasSides) {
			const auto point = notes::sidePoint({ card.x(), card.y(), card.width(), card.height() }, side);
			p.drawEllipse(QRectF(point.x - size / 2., point.y - size / 2., size, size));
		}
	}
	if (grips) {
		paintGrips(p, node, card);
	}
}

void Board::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	paintBackground(p);
	if (!entry()) {
		return;
	}
	const auto &doc = shown();
	// Выбрана одна карточка (не группа) — её стрелки и связанные карточки подсвечены, остальное приглушено
	auto focusEdges = std::set<std::string>();
	auto focusNodes = std::set<std::string>();
	const auto selected = selectedNode();
	const auto hasFocus = !_found && selected && selected->type != "group";
	if (hasFocus) {
		for (const auto &edge : _doc->edges) {
			if (edge.fromNode == selected->id || edge.toNode == selected->id) {
				focusEdges.insert(edge.id);
				focusNodes.insert(edge.fromNode == selected->id ? edge.toNode : edge.fromNode);
			}
		}
	}
	p.save();
	p.scale(k(), k());
	p.translate(_view.x, _view.y);
	p.scale(_view.scale, _view.scale);
	{
		PainterHighQualityEnabler hq(p);
		for (const auto &edge : doc.edges) {
			paintEdge(p, edge, hasFocus ? std::optional<bool>(focusEdges.contains(edge.id)) : std::nullopt);
		}
		if (_draft) {
			auto pen = QPen(ToneColor(Tone::Accent), 2.);
			pen.setDashPattern({ 3., 2.5 });
			const auto end = notes::canvasLineEnd(_draft->q, true);
			auto path = QPainterPath(QPointF(_draft->p.x, _draft->p.y));
			path.cubicTo(QPointF(_draft->c1.x, _draft->c1.y), QPointF(_draft->c2.x, _draft->c2.y), QPointF(end.x, end.y));
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			p.drawPath(path);
			const auto h = notes::canvasArrowHead(_draft->q);
			auto polygon = QPolygonF();
			polygon << QPointF(h.tip.x, h.tip.y) << QPointF(h.left.x, h.left.y) << QPointF(h.right.x, h.right.y);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Muted));
			p.drawPolygon(polygon);
		}
		if (_live) {
			p.setPen(QPen(ToneColor(Tone::Red), 1. / _view.scale));
			for (const auto &guide : _live->guides) {
				if (guide.axis == notes::CanvasAxis::X) {
					p.drawLine(QPointF(guide.at, guide.from), QPointF(guide.at, guide.to));
				} else {
					p.drawLine(QPointF(guide.from, guide.at), QPointF(guide.to, guide.at));
				}
			}
		}
	}
	const auto visible = QRectF(
		-_view.x / _view.scale,
		-_view.y / _view.scale,
		viewport().width() / _view.scale,
		viewport().height() / _view.scale);
	for (const auto &node : doc.nodes) {
		if (node.type == "group") {
			paintGroup(p, node);
		}
	}
	auto wanted = std::set<std::string>();
	const CanvasNode *editedNote = nullptr;
	for (const auto &node : doc.nodes) {
		if (node.type == "group") {
			continue;
		}
		if (_inline && _inline->id == node.id && _inline->kind == InlineKind::Note) {
			editedNote = &node; // правка текста заметки: карточка поверх соседних
			continue;
		}
		const auto rect = QRectF(node.x - 20., node.y - 20., node.width + 40., shownHeight(node) + 40.);
		if (!rect.intersects(visible)) {
			continue;
		}
		const auto linked = _found
			? std::optional<bool>(_found->contains(node.id))
			: (hasFocus && node.id != selected->id)
			? std::optional<bool>(focusNodes.contains(node.id))
			: std::nullopt;
		paintCard(p, node, linked, wanted);
	}
	if (editedNote) {
		paintCard(p, *editedNote, std::nullopt, wanted);
	}
	if (_marquee) {
		const auto r = RectOf(*_marquee);
		p.setPen(QPen(ToneColor(Tone::Accent), 1. / _view.scale));
		p.setBrush(Fade(ToneColor(Tone::Accent), 0.12));
		p.drawRect(r);
	}
	p.restore();

	// Подсказки поверх поля: режим связи, повреждённый файл
	auto hints = QStringList();
	if (_linkFrom) {
		hints.push_back(tr::lng_parvane_canvas_link_hint(tr::now));
	}
	if (_damaged) {
		hints.push_back(tr::lng_parvane_canvas_damaged(tr::now));
	}
	auto top = Rem(isNarrow() ? 6.5 : 3.625);
	for (const auto &hint : hints) {
		const auto font = Font(13, true);
		const auto w = std::min(font->width(hint) + Rem(0.875) * 2, width() - Rem(1.25));
		const auto h = font->height + Rem(0.375) * 2;
		const auto r = QRect((width() - w) / 2, top, w, h);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Accent));
		p.drawRoundedRect(r, h / 2., h / 2.);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::AccentInk));
		p.drawText(r, Qt::AlignCenter, font->elided(hint, w - Rem(0.875) * 2));
		top += h + Rem(0.375);
	}
	syncAcquired(std::move(wanted));
}

// Полный файл держится, пока карточка на экране и крупная; ушедшая — отпускается (кэш ядра держит ещё срок)
void Board::syncAcquired(std::set<std::string> wanted) {
	auto released = std::vector<std::string>();
	for (const auto &fileId : _acquired) {
		if (!wanted.contains(fileId)) {
			released.push_back(fileId);
		}
	}
	if (released.empty()) {
		return;
	}
	for (const auto &fileId : released) {
		_acquired.erase(fileId);
	}
	crl::on_main(this, [released] {
		for (const auto &fileId : released) {
			CanvasMedia::Release(fileId);
		}
	});
}

// ── попадание ────────────────────────────────────────────────────────────────

Hit Board::hitTest(CanvasPoint point) const {
	auto result = Hit();
	const auto &doc = shown();
	const auto inv = 1. / _view.scale;
	const auto at = QPointF(point.x, point.y);
	// Ручки и точки выделенного узла — поверх всего
	if (const auto selected = selectedNode(); selected && hasGrips(*selected)) {
		const auto rect = QRectF(selected->x, selected->y, selected->width, shownHeight(*selected));
		const auto corner = kHandleSize * inv;
		for (const auto handle : notes::kCanvasCornerHandles) {
			const auto x = notes::canvasHandleHas(handle, 'w') ? rect.left() : rect.right();
			const auto y = notes::canvasHandleHas(handle, 'n') ? rect.top() : rect.bottom();
			if (QRectF(x - corner / 2., y - corner / 2., corner, corner).contains(at)) {
				result.nodeId = selected->id;
				result.handle = handle;
				return result;
			}
		}
		if (selected->type != "group") {
			const auto port = kPortSize * inv / 2.;
			for (const auto side : notes::kCanvasSides) {
				const auto p = notes::sidePoint({ rect.x(), rect.y(), rect.width(), rect.height() }, side);
				if (std::hypot(p.x - point.x, p.y - point.y) <= port) {
					result.nodeId = selected->id;
					result.port = side;
					return result;
				}
			}
			// Полосы вдоль сторон (`.canvasHandleN` …): размер в точках холста
			const auto strip = kEdgeHandle;
			const auto inset = kEdgeHandleInset;
			const auto strips = std::array<std::pair<CanvasHandle, QRectF>, 4>{ {
				{ CanvasHandle::N, QRectF(rect.left() + inset, rect.top() - strip / 2., rect.width() - inset * 2, strip) },
				{ CanvasHandle::S, QRectF(rect.left() + inset, rect.bottom() - strip / 2., rect.width() - inset * 2, strip) },
				{ CanvasHandle::E, QRectF(rect.right() - strip / 2., rect.top() + inset, strip, rect.height() - inset * 2) },
				{ CanvasHandle::W, QRectF(rect.left() - strip / 2., rect.top() + inset, strip, rect.height() - inset * 2) },
			} };
			for (const auto &[handle, area] : strips) {
				if (area.contains(at)) {
					result.nodeId = selected->id;
					result.handle = handle;
					return result;
				}
			}
		}
	}
	// Точки стрелок карточки под указателем
	if (!_linkFrom && _hoverNode) {
		if (const auto node = notes::findNode(doc, *_hoverNode); node && node->type != "group"
				&& !(_inline && _inline->id == node->id)) {
			const auto port = kPortSize * inv / 2.;
			for (const auto side : notes::kCanvasSides) {
				const auto p = notes::sidePoint({ node->x, node->y, node->width, shownHeight(*node) }, side);
				if (std::hypot(p.x - point.x, p.y - point.y) <= port) {
					result.nodeId = node->id;
					result.port = side;
					return result;
				}
			}
		}
	}
	// Карточки: позднее в списке — выше; карточка с правкой текста заметки — выше всех
	const auto cardHit = [&](const CanvasNode &node) {
		const auto rect = QRectF(node.x, node.y, node.width, shownHeight(node));
		if (!rect.contains(at)) {
			return false;
		}
		result.nodeId = node.id;
		if (node.type == "file" && noteTitleOf(node)) {
			const auto head = NoteHeadHeight();
			if (point.y < node.y + head) {
				result.noteHead = true;
				const auto openRight = node.x + node.width - 1. - kPadX + 6.;
				const auto button = QRectF(openRight - 24., node.y + 1. + head / 2. - 12., 24., 24.);
				if (noteOf(*noteTitleOf(node)) && button.contains(at)) {
					result.openNote = true;
				}
			}
		} else if (node.type == "link") {
			const auto inner = rect.adjusted(kGroupBorder, kGroupBorder, -kGroupBorder, -kGroupBorder);
			const auto button = QRectF(inner.right() - 8. - 28., inner.bottom() - 20. - 14., 28., 28.);
			if (button.contains(at)) {
				result.linkUrl = Str(node, "url");
			}
		}
		return true;
	};
	if (_inline && _inline->kind == InlineKind::Note) {
		if (const auto node = notes::findNode(doc, _inline->id); node && cardHit(*node)) {
			return result;
		}
	}
	for (auto i = doc.nodes.rbegin(); i != doc.nodes.rend(); ++i) {
		if (i->type != "group" && cardHit(*i)) {
			return result;
		}
	}
	// Группы: шапка и полосы вдоль рамки; середина пропускает нажатие до поля
	for (auto i = doc.nodes.rbegin(); i != doc.nodes.rend(); ++i) {
		if (i->type != "group") {
			continue;
		}
		const auto rect = RectOf(i->rect());
		const auto head = QRectF(rect.x() - kGroupBorder, rect.y() - kGroupBorder - kGroupHead, rect.width() + kGroupBorder * 2, kGroupHead + kGroupBorder);
		if (head.contains(at)) {
			result.nodeId = i->id;
			result.groupHead = true;
			return result;
		}
		const auto out = kGroupGrabOut;
		const auto grab = kGroupGrab;
		const auto bands = std::array<QRectF, 4>{ {
			QRectF(rect.left(), rect.top() - out, rect.width(), grab),
			QRectF(rect.left(), rect.bottom() + out - grab, rect.width(), grab),
			QRectF(rect.left() - out, rect.top(), grab, rect.height()),
			QRectF(rect.right() + out - grab, rect.top(), grab, rect.height()),
		} };
		for (const auto &band : bands) {
			if (band.contains(at)) {
				result.nodeId = i->id;
				result.groupBand = true;
				return result;
			}
		}
	}
	return result;
}

// Полоса захвата вдоль рамки группы широкая и накрывает стрелки у края группы: на самой линии стрелки нажатие
// достаётся стрелке, а не группе
std::optional<std::string> Board::nodeUnder(const Hit &hit, CanvasPoint point, double edgeHit) const {
	if (!hit.nodeId || !hit.groupBand) {
		return hit.nodeId;
	}
	return notes::edgeAt(*_doc, point, edgeHit) ? std::nullopt : hit.nodeId;
}

std::optional<std::string> Board::hoverGroupAt(CanvasPoint point) const {
	const auto hit = hitTest(point);
	if (!hit.nodeId || hit.port || hit.handle) {
		return std::nullopt;
	}
	const auto node = notes::findNode(shown(), *hit.nodeId);
	return (node && node->type == "group") ? hit.nodeId : std::nullopt;
}

void Board::updateCursor(CanvasPoint point) {
	if (_gesture) {
		if (_gesture->type == Gesture::Type::Pan || _gesture->type == Gesture::Type::Move) {
			setCursor(Qt::ClosedHandCursor);
		}
		return;
	}
	const auto hit = hitTest(point);
	if (hit.handle) {
		switch (*hit.handle) {
		case CanvasHandle::N: case CanvasHandle::S: setCursor(Qt::SizeVerCursor); return;
		case CanvasHandle::E: case CanvasHandle::W: setCursor(Qt::SizeHorCursor); return;
		case CanvasHandle::NE: case CanvasHandle::SW: setCursor(Qt::SizeBDiagCursor); return;
		default: setCursor(Qt::SizeFDiagCursor); return;
		}
	}
	if (hit.port || _selectMode || (_linkFrom && hit.nodeId && *hit.nodeId != *_linkFrom)) {
		setCursor(Qt::CrossCursor);
		return;
	}
	if (hit.openNote || hit.linkUrl) {
		setCursor(style::cur_pointer);
		return;
	}
	if (!hit.nodeId && notes::edgeAt(*_doc, point, kEdgeHit / _view.scale)) {
		setCursor(style::cur_pointer);
		return;
	}
	setCursor(Qt::OpenHandCursor);
}

// ── выделение и правки ───────────────────────────────────────────────────────

void Board::select(CanvasSelection next) {
	_selection = std::move(next);
	refreshTools();
	refreshBar();
	update();
}

void Board::selectNodes(std::vector<std::string> ids) {
	select({ std::move(ids), {} });
}

void Board::dropGesture() {
	_gesture.reset();
	_live.reset();
	_marquee.reset();
	_draft.reset();
}

// Новый узел: серединой в точке `at` (на сетке) либо на свободном месте у середины экрана
CanvasNode Board::add(CanvasNode node, std::optional<CanvasPoint> at) {
	finishInline();
	const auto point = at.value_or(centerPoint());
	node.id = notes::newCanvasId();
	if (!at && node.type != "group") {
		const auto spot = notes::findFreeSpot(*_doc, point, node.width, node.height);
		node.x = spot.x;
		node.y = spot.y;
	} else {
		const auto grid = at ? notes::kCanvasGrid : 1.;
		node.x = notes::snapTo(point.x - node.width / 2., grid);
		node.y = notes::snapTo(point.y - node.height / 2., grid);
	}
	change(notes::addNode(*_doc, node));
	selectNodes({ node.id });
	return node;
}

// Новая текстовая карточка и новая группа сразу открыты для ввода — слов-заглушек в файл не попадает
void Board::addText(std::optional<CanvasPoint> at) {
	auto node = MakeNode("text", notes::kCanvasDefaultNodeWidth, notes::kCanvasDefaultNodeHeight);
	node.set("text", "");
	startInline(add(std::move(node), at), true);
}

// Новая группа: вокруг выделенных узлов, а без выделения — пустая обычного размера
void Board::addGroup(std::optional<CanvasPoint> at) {
	finishInline();
	const auto ids = at ? std::vector<std::string>() : _selection.nodes;
	auto wrapped = notes::wrapInGroup(*_doc, ids);
	if (!wrapped.id) {
		startInline(add(MakeNode("group", kGroupWidth, kGroupHeight), at), true);
		return;
	}
	change(wrapped.doc);
	if (const auto node = notes::findNode(*_doc, *wrapped.id)) {
		startInline(*node, true);
	}
}

// Карточка у конца стрелки, брошенной на пустом месте, и сама стрелка — одним шагом истории
CanvasNode Board::addLinked(CanvasNode node, const EdgeStart &from, CanvasPoint point) {
	node.id = notes::newCanvasId();
	const auto place = notes::droppedCardPlace(point, from.side, node.width, node.height, notes::kCanvasGrid);
	node.x = place.x;
	node.y = place.y;
	auto sides = notes::CanvasSides();
	sides.fromSide = notes::canvasSideName(from.side);
	sides.toSide = notes::canvasSideName(notes::oppositeSide(from.side));
	change(notes::connectNodes(notes::addNode(*_doc, node), from.id, node.id, sides));
	selectNodes({ node.id });
	return node;
}

// Карточка заметки: в точке `at`, у конца стрелки `from` (если её начало ещё на холсте) либо на свободном месте.
// Идентификатор заметки: по нему карточка найдёт её после переименования («Обновить из графа»)
void Board::addNoteCard(
		const std::string &title,
		const std::string &noteId,
		std::optional<CanvasPoint> at,
		std::optional<EdgeStart> from) {
	auto card = MakeNode("file", notes::kCanvasDefaultNodeWidth, kNoteHeight);
	card.set("file", title + ".md");
	if (!noteId.empty()) {
		card.set(notes::kGraphNoteField, noteId);
	}
	if (from && at && notes::findNode(*_doc, from->id)) {
		finishInline();
		addLinked(std::move(card), *from, *at);
		return;
	}
	add(std::move(card), at);
}

void Board::addLink(const std::string &url, std::optional<CanvasPoint> at) {
	auto node = MakeNode("link", kLinkWidth, kLinkHeight);
	node.set("url", url);
	add(std::move(node), at);
}

// Вставка снимка узлов: серединой в точку `at`, а без неё — со сдвигом от места, откуда скопировано
void Board::pasteNodes(const notes::CanvasClip &clip, std::optional<CanvasPoint> at) {
	const auto bounds = notes::clipBounds(clip);
	if (!bounds) {
		return;
	}
	const auto dx = at ? notes::snapTo(at->x - bounds->x - bounds->width / 2.) : notes::kCanvasCopyShift;
	const auto dy = at ? notes::snapTo(at->y - bounds->y - bounds->height / 2.) : notes::kCanvasCopyShift;
	auto pasted = notes::pasteClip(*_doc, clip, dx, dy);
	change(std::move(pasted.doc));
	selectNodes(std::move(pasted.ids));
}

// Текст из буфера обмена: узлы холста — узлами, адрес страницы — карточкой-ссылкой, прочее — текстовой
void Board::pasteText(const std::string &text, std::optional<CanvasPoint> at) {
	const auto pasted = notes::parsePasted(text);
	if (!pasted) {
		return;
	}
	finishInline();
	using PKind = notes::CanvasPasted::Kind;
	if (pasted->kind == PKind::Nodes) {
		pasteNodes(pasted->clip, at);
	} else if (pasted->kind == PKind::Link) {
		addLink(pasted->url, at);
	} else {
		auto node = MakeNode("text", notes::kCanvasDefaultNodeWidth, notes::kCanvasDefaultNodeHeight);
		node.set("text", pasted->text);
		add(std::move(node), at);
	}
}

std::optional<std::string> Board::copySelection() {
	if (_selection.nodes.empty()) {
		return std::nullopt;
	}
	LastClipText = notes::serializeClip(notes::copyNodes(*_doc, _selection.nodes));
	return LastClipText;
}

void Board::removeSelected() {
	if (notes::isSelectionEmpty(_selection)) {
		return;
	}
	if (_inline) {
		_inline.reset();
		if (_field) {
			delete base::take(_field);
		}
	}
	change(notes::removeSelection(*_doc, _selection));
	select({});
}

void Board::undo() {
	finishInline();
	dropGesture();
	auto move = notes::undoStep(_history, _doc);
	if (!move) {
		return;
	}
	_history = std::move(move->history);
	syncHistory();
	applyDoc(move->doc);
	select(notes::pruneSelection(*_doc, _selection));
}

void Board::redo() {
	finishInline();
	dropGesture();
	auto move = notes::redoStep(_history, _doc);
	if (!move) {
		return;
	}
	_history = std::move(move->history);
	syncHistory();
	applyDoc(move->doc);
	select(notes::pruneSelection(*_doc, _selection));
}

void Board::duplicate() {
	finishInline();
	pasteNodes(notes::copyNodes(*_doc, _selection.nodes), std::nullopt);
}

void Board::recolor(std::optional<std::string> color) {
	closeMenu();
	change(notes::recolorSelection(*_doc, _selection, color));
}

void Board::fitGroups() {
	auto next = *_doc;
	for (const auto &id : _selection.nodes) {
		next = notes::fitGroupToContent(next, id);
	}
	change(std::move(next));
}

void Board::turnEdges() {
	auto next = *_doc;
	for (const auto &id : _selection.edges) {
		const auto edge = notes::findEdge(next, id);
		if (!edge) {
			continue;
		}
		const auto ends = notes::nextEdgeEnds({ edge->str("fromEnd"), edge->str("toEnd") });
		const auto value = [](const std::optional<std::string> &end) -> std::optional<CanvasJson> {
			return end ? std::optional<CanvasJson>(CanvasJson(*end)) : std::nullopt;
		};
		next = notes::updateEdge(next, id, { { "fromEnd", value(ends.fromEnd) }, { "toEnd", value(ends.toEnd) } });
	}
	change(std::move(next));
}

void Board::align(notes::CanvasAlign value) {
	closeMenu();
	change(notes::alignNodes(*_doc, _selection.nodes, value));
}

void Board::distribute(notes::CanvasAxis axis) {
	closeMenu();
	change(notes::distributeNodes(*_doc, _selection.nodes, axis));
}

void Board::reorder(notes::CanvasLayer layer) {
	change(notes::reorderNodes(*_doc, _selection.nodes, layer));
}

void Board::startMove(
		const std::string &lead,
		std::vector<std::string> ids,
		CanvasPoint origin,
		std::optional<std::string> collapseTo) {
	const auto base = _doc;
	auto moving = std::set<std::string>(ids.begin(), ids.end());
	for (const auto &id : ids) {
		for (const auto &node : notes::nodesInGroup(*base, id)) {
			moving.insert(node.id);
		}
	}
	auto gesture = Gesture();
	gesture.type = Gesture::Type::Move;
	gesture.lead = lead;
	gesture.ids = std::move(ids);
	gesture.origin = origin;
	gesture.base = base;
	for (const auto &node : base->nodes) {
		if (!moving.contains(node.id)) {
			gesture.others.push_back(node.rect());
		}
	}
	gesture.bounds = notes::selectionBounds(*base, std::vector<std::string>(moving.begin(), moving.end()))
		.value_or(CanvasRect());
	gesture.collapseTo = std::move(collapseTo);
	_gesture = std::move(gesture);
}

void Board::showLive(CanvasDoc doc, std::vector<notes::CanvasGuide> guides) {
	_live = Live{ std::move(doc), std::move(guides) };
	refreshBar();
	update();
}

// ── правка на месте ──────────────────────────────────────────────────────────

void Board::startInline(const CanvasNode &node, bool isNew) {
	auto next = Inline{ .id = node.id, .kind = InlineKind::Node, .isNew = isNew };
	if (node.type == "text") {
		// Шла ли высота карточки по тексту: под последней строкой нет свободного места
		const auto slack = node.height - textContentHeight(node);
		next.isAuto = isNew || slack < kAutoSlack || node.height <= notes::kCanvasDefaultNodeHeight;
	}
	_inline = next;
	closeMenu();
	selectNodes({ node.id });
	const auto isGroup = (node.type == "group");
	openField(
		Q(Str(node, isGroup ? "label" : "text")),
		isGroup ? tr::lng_parvane_canvas_group_name() : tr::lng_parvane_canvas_text());
}

void Board::startEdgeInline(const CanvasEdge &edge) {
	_inline = Inline{ .id = edge.id, .kind = InlineKind::Edge };
	closeMenu();
	select({ {}, { edge.id } });
	openField(Q(Str(edge, "label")), tr::lng_parvane_canvas_label());
}

// Правка заметки прямо на карточке: текст целиком (исходник `.md`) либо название
void Board::startNoteInline(const CanvasNode &node, const notes::NoteRef &note, InlineKind kind) {
	// Текст, который ещё пишется в облако, уже считается текстом заметки: повторная правка идёт от него
	const auto base = (kind == InlineKind::Title)
		? note->title
		: (_savingNote && _savingNote->first == note->id) ? _savingNote->second : note->text;
	_inline = Inline{
		.id = node.id,
		.kind = kind,
		.noteId = note->id,
		.base = base,
		.noteTitle = note->title,
	};
	closeMenu();
	selectNodes({ node.id });
	openField(
		Q(base),
		(kind == InlineKind::Note) ? tr::lng_parvane_canvas_editor_placeholder() : rpl::single(QString()));
}

void Board::openField(const QString &text, rpl::producer<QString> placeholder) {
	if (_field) {
		delete base::take(_field);
	}
	const auto kind = _inline->kind;
	const auto multiline = (kind == InlineKind::Note)
		|| (kind == InlineKind::Node && notes::findNode(*_doc, _inline->id)
			&& notes::findNode(*_doc, _inline->id)->type != "group");
	const auto bordered = !multiline;
	const auto px = (kind == InlineKind::Node && !multiline) ? 16.
		: (kind == InlineKind::Title) ? 15.
		: 13.;
	const auto semibold = (kind == InlineKind::Title) || (kind == InlineKind::Node && !multiline);
	const auto zoom = k() * _view.scale;
	auto fieldStyle = std::make_shared<FieldStyle>();
	auto &text_ = fieldStyle->text;
	text_.font = style::font(
		std::max(6, int(std::round(px * zoom))),
		semibold ? style::FontFlags(style::FontFlag::Bold) : style::FontFlags(),
		0);
	text_.lineHeight = multiline ? int(std::round(13. * 1.45 * zoom)) : 0;
	auto &st = fieldStyle->st;
	if (bordered) {
		fieldStyle->textBg.update(ToneColor(Tone::Panel));
	}
	st.style = text_;
	st.textBg = fieldStyle->textBg.color();
	st.textBgActive = fieldStyle->textBg.color();
	st.textFg = fieldStyle->textFg.color();
	st.placeholderFg = fieldStyle->placeholderFg.color();
	st.placeholderFgActive = fieldStyle->placeholderFg.color();
	st.placeholderFgError = fieldStyle->placeholderFg.color();
	st.borderFg = fieldStyle->borderFg.color();
	st.borderFgActive = fieldStyle->borderFg.color();
	st.borderFgError = fieldStyle->borderFg.color();
	st.placeholderFont = text_.font;
	st.placeholderScale = 0.;
	st.placeholderShift = 0;
	st.placeholderMargins = style::margins();
	st.border = bordered ? Px(1) : 0;
	st.borderActive = bordered ? Px(1) : 0;
	st.borderDenominator = 1;
	st.borderRadius = bordered ? int(std::round(6. * zoom)) : 0;
	if (multiline) {
		const auto padX = int(std::round(kPadX * zoom));
		const auto padY = int(std::round(kPadY * zoom));
		st.textMargins = style::margins(padX, padY, padX, padY);
		st.heightMin = 1;
		st.heightMax = 100000;
	} else {
		const auto line = text_.font->height;
		const auto height = int(std::round(((kind == InlineKind::Edge) ? 22. : 24.) * zoom));
		const auto top = std::max((height - line) / 2, 0);
		const auto padX = int(std::round(6. * zoom));
		st.textMargins = style::margins(padX, top, padX, std::max(height - top - line, 0));
		st.heightMin = std::max(height, line);
		st.heightMax = std::max(height, line);
	}
	_field = Ui::CreateChild<Ui::InputField>(
		this,
		st,
		multiline ? Ui::InputField::Mode::MultiLine : Ui::InputField::Mode::SingleLine,
		std::move(placeholder),
		text);
	const auto field = _field;
	// Стиль живёт, пока живо поле (оно может удаляться отложенно)
	field->lifetime().add([keep = fieldStyle] {});
	// Enter сохраняет (в тексте карточки Shift+Enter — новая строка; в тексте заметки Enter — новая строка,
	// сохраняет Ctrl+Enter), Escape отменяет, уход фокуса сохраняет
	field->setSubmitSettings((kind == InlineKind::Note)
		? Ui::InputField::SubmitSettings::CtrlEnter
		: Ui::InputField::SubmitSettings::Enter);
	if (kind == InlineKind::Title) {
		field->setMaxLength(notes::kNoteTitleMax);
	}
	field->submits() | rpl::on_next([=] {
		crl::on_main(this, [=] { finishInline(false); });
	}, field->lifetime());
	field->cancelled() | rpl::on_next([=] {
		crl::on_main(this, [=] { finishInline(true); });
	}, field->lifetime());
	field->focusedChanges() | rpl::filter([](bool focused) {
		return !focused;
	}) | rpl::on_next([=] {
		crl::on_main(this, [=] {
			if (_field == field) {
				finishInline(false);
			}
		});
	}, field->lifetime());
	field->heightChanges() | rpl::on_next([=] {
		updateFieldGeometry();
		update();
	}, field->lifetime());
	updateFieldGeometry();
	field->show();
	field->setFocusFast();
	// У названия выделено всё, у текста курсор в конце
	if (multiline) {
		field->setCursorPosition(int(text.size()));
	} else {
		field->selectAll();
	}
	update();
}

void Board::updateFieldGeometry() {
	if (!_field || !_inline) {
		return;
	}
	const auto zoom = k() * _view.scale;
	const auto &doc = *_doc;
	if (_inline->kind == InlineKind::Edge) {
		const auto edge = notes::findEdge(doc, _inline->id);
		const auto curve = edge ? notes::edgeCurve(doc, *edge) : std::nullopt;
		if (!curve) {
			return;
		}
		const auto point = toScreen(notes::curvePoint(*curve, 0.5));
		const auto w = int(std::round(160. * zoom));
		_field->resizeToWidth(w);
		_field->move(int(point.x()) - w / 2, int(point.y()) - _field->height() / 2);
		return;
	}
	const auto node = notes::findNode(doc, _inline->id);
	if (!node) {
		return;
	}
	const auto topLeft = toScreen({ node->x, node->y });
	if (node->type == "group") {
		// Название группы — в её шапке
		const auto head = toScreen({ node->x - kGroupBorder + 8., node->y - kGroupBorder - kGroupHead + 4. });
		const auto w = int(std::round((node->width + kGroupBorder * 2 - 16.) * zoom));
		_field->resizeToWidth(std::max(w, 1));
		_field->move(head.toPoint());
		return;
	}
	if (_inline->kind == InlineKind::Title) {
		const auto left = toScreen({ node->x + 1. + kPadX + 16., node->y + 1. + (NoteHeadHeight() - 24.) / 2. });
		const auto w = int(std::round((node->width - 2. - kPadX * 2 - 16.) * zoom));
		_field->resizeToWidth(std::max(w, 1));
		_field->move(left.toPoint());
		return;
	}
	if (_inline->kind == InlineKind::Note) {
		const auto top = toScreen({ node->x + 1., node->y + 1. + NoteHeadHeight() });
		const auto w = int(std::round((node->width - 2.) * zoom));
		const auto minHeight = int(std::round((node->height - 2. - NoteHeadHeight()) * zoom));
		const auto maxHeight = int(std::round((std::max(kNoteEditMaxHeight, node->height) - NoteHeadHeight()) * zoom));
		_field->setMinHeight(std::max(minHeight, 1));
		_field->setMaxHeight(std::max(maxHeight, minHeight));
		_field->resizeToWidth(std::max(w, 1));
		_field->move(top.toPoint());
		return;
	}
	// Текст карточки: поле занимает карточку внутри рамки
	const auto w = int(std::round((node->width - kGroupBorder * 2) * zoom));
	const auto minHeight = int(std::round((std::max(node->height, notes::kCanvasDefaultNodeHeight) - kGroupBorder * 2) * zoom));
	_field->setMinHeight(std::max(minHeight, 1));
	_field->resizeToWidth(std::max(w, 1));
	_field->move((topLeft + QPointF(kGroupBorder * zoom, kGroupBorder * zoom)).toPoint());
}

// Конец правки на месте. Вызывается и с ухода фокуса, и явно — второй вызов ничего не делает
void Board::finishInline(bool canceled) {
	if (!_inline || _finishing) {
		return;
	}
	_finishing = true;
	const auto current = *_inline;
	const auto raw = _field ? S(_field->getLastText()) : std::string();
	const auto value = notes::canvasjs::trim(raw);
	// Фокус возвращается полю холста, только если он был в поле правки (уход фокуса его не отбирает)
	const auto focused = QApplication::focusWidget();
	const auto hadFocus = _field && focused && (focused == _field || _field->isAncestorOf(focused));
	_inline.reset();
	if (_field) {
		const auto field = base::take(_field);
		field->hide();
		field->deleteLater();
	}
	_finishing = false;
	if (hadFocus) {
		setFocus();
	}
	refreshBar();
	update();
	// Текст и название заметки — другой файл: ни шага истории холста, ни записи холста
	if (current.kind == InlineKind::Note) {
		if (!canceled && raw != current.base) {
			commitNoteText(current, raw);
		}
		return;
	}
	if (current.kind == InlineKind::Title) {
		const auto title = canceled ? std::nullopt : notes::nextNoteTitle(raw, current.base);
		if (title) {
			commitNoteTitle(current.noteId, current.base, *title);
		}
		return;
	}
	if (current.kind == InlineKind::Edge) {
		if (!canceled) {
			change(notes::updateEdge(*_doc, current.id, { { "label", CanvasJson(value) } }));
		}
		return;
	}
	const auto node = notes::findNode(*_doc, current.id);
	if (!node) {
		return;
	}
	const auto isGroup = (node->type == "group");
	if (current.isNew && !isGroup && (canceled || value.empty())) {
		// Новая текстовая карточка без текста не остаётся: шаг, которым она добавлена, забывается
		if (auto dropped = notes::dropStep(_history)) {
			_history = std::move(dropped->history);
			syncHistory();
			applyDoc(dropped->doc);
		} else {
			change(notes::removeNode(*_doc, node->id));
		}
		select({});
		return;
	}
	if (canceled || value == Str(*node, isGroup ? "label" : "text")) {
		return;
	}
	if (isGroup) {
		change(notes::updateNode(*_doc, node->id, {
			{ "label", value.empty() ? std::nullopt : std::optional<CanvasJson>(CanvasJson(value)) },
		}), current.isNew);
	} else {
		// Дальше высоту подгонит замер: карточка не ниже своего текста
		const auto height = current.isAuto ? std::min(node->height, notes::kCanvasDefaultNodeHeight) : node->height;
		change(notes::updateNode(*_doc, node->id, {
			{ "text", CanvasJson(value) },
			{ "height", CanvasJson(height) },
		}), current.isNew);
	}
}

// Текст заметки пишется тем же путём, что с экрана заметки. Изменения, пришедшие в заметку за время правки,
// сводятся с ней при записи. Заметку за это время удалили — она создаётся заново с набранным текстом. Не
// записалось — поле открывается снова с набранным текстом
void Board::commitNoteText(Inline current, std::string text) {
	const auto canvas = _loadedId;
	_savingNote = { current.noteId, text };
	update();
	const auto vault = VaultName();
	Sections::Ask<notes::NoteSaveResult>([=](Sections::Workers &w) {
		try {
			return w.notes.saveNoteOrRestore(current.noteId, current.noteTitle, text, vault, current.base);
		} catch (...) {
			return notes::NoteSaveResult{ "failed" };
		}
	}, crl::guard(this, [=](notes::NoteSaveResult result) {
		if (_savingNote && _savingNote->first == current.noteId && _savingNote->second == text) {
			_savingNote.reset();
		}
		update();
		if (result.status == "saved") {
			return;
		}
		if (result.status == "restored") {
			if (canvas == _loadedId) {
				relinkCards(current.noteId, current.noteTitle, result.id, result.title);
			}
			toast(tr::lng_parvane_canvas_note_restored(tr::now, lt_name, Q(result.title)));
			return;
		}
		const auto node = notes::findNode(*_doc, current.id);
		const auto note = node ? noteOf(current.noteTitle) : nullptr;
		if (_inline || canvas != _loadedId || !node || !note) {
			return;
		}
		startNoteInline(*node, note, InlineKind::Note);
		if (_field) {
			_field->setText(Q(text));
			_field->setCursorPosition(int(Q(text).size()));
		}
	}));
}

// Переименованная заметка — новый путь в её карточках: в открытом документе и во всех шагах истории (отмена не
// вернёт прежний путь). Шагом истории это не становится
void Board::retitleCards(const std::string &from, const std::string &to) {
	_history = notes::mapHistory(_history, [&](const CanvasDocPtr &step) {
		auto next = notes::renameCanvasNote(*step, from, to);
		return (next == *step) ? step : Share(std::move(next));
	});
	auto next = notes::renameCanvasNote(*_doc, from, to);
	if (!(next == *_doc)) {
		applyDoc(Share(std::move(next)));
	}
}

// Название заметки: карточки холста получают его сразу, файл холста пишется до переименования — тогда хранилищу
// в этом холсте править нечего. Ссылки в других заметках и карточки других холстов правит `renameNote`
void Board::commitNoteTitle(const std::string &noteId, const std::string &from, const std::string &title) {
	Sections::Ask<std::string>([=](Sections::Workers &w) {
		return w.notes.freeNoteTitle(noteId, title);
	}, crl::guard(this, [=](std::string to) {
		if (to == from) {
			return;
		}
		const auto canvas = _loadedId;
		_renaming = { from, to };
		retitleCards(from, to);
		flushSave();
		const auto vault = VaultName();
		Sections::Ask<bool>([=](Sections::Workers &w) {
			try {
				return w.notes.renameNote(noteId, to, vault);
			} catch (...) {
				return false;
			}
		}, crl::guard(this, [=](bool done) {
			_renaming.reset();
			if (done) {
				update();
				return;
			}
			if (canvas == _loadedId) {
				retitleCards(to, from);
			}
			toast(tr::lng_parvane_canvas_notice_failed(tr::now, lt_name, Q(from)));
		}));
	}));
}

// Заметку удалили, пока её текст правили на карточке: набранное легло в новую заметку. Карточки прежней заметки
// (в открытом документе и в шагах истории) указывают на новую; шагом истории это не становится
void Board::relinkCards(
		const std::string &fromId,
		const std::string &fromTitle,
		const std::string &toId,
		const std::string &toTitle) {
	const auto relink = [&](const CanvasDoc &step) {
		return notes::relinkNoteCards(step, fromId, fromTitle, toId, toTitle);
	};
	_history = notes::mapHistory(_history, [&](const CanvasDocPtr &step) {
		auto next = relink(*step);
		return (next == *step) ? step : Share(std::move(next));
	});
	auto next = relink(*_doc);
	if (!(next == *_doc)) {
		applyDoc(Share(std::move(next)));
	}
}

// ── действия ─────────────────────────────────────────────────────────────────

void Board::openNoteByTitle(const std::string &title) {
	if (const auto note = noteOf(title)) {
		if (_openNote) {
			_openNote(note->id);
		}
		return;
	}
	// Заметки нет — создать её и открыть
	const auto vault = VaultName();
	Sections::Ask<std::optional<std::string>>([=](Sections::Workers &w) -> std::optional<std::string> {
		try {
			return w.notes.createNote(title, vault);
		} catch (...) {
			return std::nullopt;
		}
	}, crl::guard(this, [=](std::optional<std::string> id) {
		if (id && _openNote) {
			_openNote(*id);
		}
	}));
}

// Карточка заметки открывает заметку; карточка файла облака — файл в разделе «Облако» (просмотр — там)
void Board::openFileNode(const CanvasNode &node) {
	if (const auto title = noteTitleOf(node)) {
		// Заметка, которую прямо сейчас переименовывают с холста, открывается под прежним названием
		const auto note = noteOf(*title);
		openNoteByTitle(note ? note->title : *title);
		return;
	}
	if (driveFile(node)) {
		toast(tr::lng_parvane_canvas_file_in_cloud(tr::now));
	}
}

// Двойной щелчок, Enter и «Изменить»: текстовая карточка — правка текста на месте, группа — правка названия,
// ссылка — правка адреса, карточка файла открывает файл. Карточка заметки правит саму заметку: по тексту — её
// текст, по шапке — название; заметку, которой нет, команда создаёт
void Board::activate(const std::string &nodeId, notes::NoteCardPart part) {
	const auto node = notes::findNode(*_doc, nodeId);
	if (!node) {
		return;
	}
	const auto copy = *node;
	if (const auto title = noteTitleOf(copy)) {
		const auto note = noteOf(*title);
		const auto isDaily = note && note->isDaily && notes::isDayTitle(note->title);
		const auto action = notes::noteCardAction(noteStateOf(note), part, isDaily);
		using A = notes::NoteCardAction;
		if (action == A::Create) {
			openNoteByTitle(*title);
		} else if (note && action != A::None) {
			startNoteInline(copy, note, (action == A::EditTitle) ? InlineKind::Title : InlineKind::Note);
		} else {
			selectNodes({ copy.id });
		}
	} else if (copy.type == "file") {
		openFileNode(copy);
	} else if (copy.type == "text" || copy.type == "group") {
		startInline(copy);
	} else if (copy.type == "link") {
		selectNodes({ copy.id });
		showLinkSheet(copy.id, Str(copy, "url"), std::nullopt);
	} else {
		selectNodes({ copy.id });
		showEditSheet();
	}
}

// Единственное выделенное: `part` — откуда пришло действие (клавиша правит текст заметки, но не создаёт её)
void Board::activateSelected(notes::NoteCardPart part) {
	closeMenu();
	if (const auto edge = selectedEdge()) {
		startEdgeInline(*edge);
	} else if (_selection.nodes.size() == 1 && _selection.edges.empty()) {
		activate(_selection.nodes.front(), part);
	}
}

void Board::openMenuAt(QPoint at) {
	finishInline();
	dropGesture();
	const auto point = toCanvas(at);
	const auto edgeHit = kEdgeHit * 2.25 / _view.scale;
	const auto nodeId = nodeUnder(hitTest(point), point, edgeHit);
	const auto edgeId = nodeId ? std::nullopt : notes::edgeAt(*_doc, point, edgeHit);
	const auto has = [](const std::vector<std::string> &list, const std::string &id) {
		return std::find(list.begin(), list.end(), id) != list.end();
	};
	if (nodeId && !has(_selection.nodes, *nodeId)) {
		selectNodes({ *nodeId });
	} else if (edgeId && !has(_selection.edges, *edgeId)) {
		select({ {}, { *edgeId } });
	} else if (!nodeId && !edgeId) {
		select({});
	}
	_linkFrom.reset();
	showMenu({ at, point, (nodeId || edgeId) ? MenuKind::Selection : MenuKind::Board });
}

void Board::showMenu(MenuState state) {
	_menu = state;
	const auto narrow = isNarrow();
	(void)narrow;
	const auto selected = selectedNode();
	const auto edge = selectedEdge();
	const auto noteTitle = (selected && selected->type == "file") ? noteTitleOf(*selected) : std::nullopt;
	const auto noteState = noteTitle ? std::optional(noteStateOf(noteOf(*noteTitle))) : std::nullopt;
	const auto isPlainFile = selected && selected->type == "file" && !noteState;
	const auto canEdit = edge || (selected && noteState != notes::NoteCardState::Loading);
	const auto editIcon = (noteState == notes::NoteCardState::Missing) ? u"plus"_q : isPlainFile ? u"open"_q : u"edit"_q;
	const auto editLabel = edge ? tr::lng_parvane_canvas_edge_label(tr::now)
		: (noteState == notes::NoteCardState::Found) ? tr::lng_parvane_canvas_edit_note(tr::now)
		: (noteState == notes::NoteCardState::Missing) ? tr::lng_parvane_canvas_create_note(tr::now)
		: isPlainFile ? tr::lng_parvane_canvas_open_file(tr::now)
		: tr::lng_parvane_canvas_edit(tr::now);
	auto hasGroup = false;
	for (const auto &id : _selection.nodes) {
		if (const auto node = notes::findNode(*_doc, id); node && node->type == "group") {
			hasGroup = true;
		}
	}
	using Item = CanvasWidgets::ContextMenu::Item;
	auto items = std::vector<Item>();
	const auto item = [&](const char *command, const char *icon, const QString &label, bool danger = false) {
		items.push_back({ QString::fromLatin1(command), QString::fromLatin1(icon), label, danger });
	};
	if (state.kind == MenuKind::Board) {
		item("textHere", "text", tr::lng_parvane_canvas_text_here(tr::now));
		item("groupHere", "group", tr::lng_parvane_canvas_group_here(tr::now));
		item("newNote", "noteNew", tr::lng_parvane_canvas_new_note_here(tr::now));
		item("note", "note", tr::lng_parvane_canvas_choose_note(tr::now));
		item("link", "link", tr::lng_parvane_canvas_link_title(tr::now));
		item("file", "file", tr::lng_parvane_canvas_file_choose(tr::now));
		item("paste", "paste", tr::lng_parvane_canvas_paste(tr::now));
		item("selectAll", "select", tr::lng_parvane_canvas_select_all(tr::now));
		item("refreshGraph", "refresh", tr::lng_parvane_canvas_refresh(tr::now));
		item("fitView", "fit", tr::lng_parvane_canvas_zoom_fit(tr::now));
	} else if (state.kind == MenuKind::Drop) {
		item("dropNewNote", "noteNew", tr::lng_parvane_canvas_new_note(tr::now));
		item("dropNote", "note", tr::lng_parvane_canvas_drop_note(tr::now));
		item("dropText", "text", tr::lng_parvane_canvas_text_card(tr::now));
	} else if (_selection.nodes.empty()) {
		if (edge) {
			item("edit", "edit", tr::lng_parvane_canvas_edge_label(tr::now));
		}
		item("direction", "arrow", tr::lng_parvane_canvas_direction(tr::now));
		item("remove", "trash", tr::lng_parvane_canvas_remove(tr::now), true);
	} else {
		if (selected && canEdit) {
			items.push_back({ u"edit"_q, editIcon, editLabel, false });
		}
		if (noteState == notes::NoteCardState::Found) {
			item("open", "open", tr::lng_parvane_canvas_open_note(tr::now));
		}
		item("duplicate", "copy", tr::lng_parvane_canvas_duplicate(tr::now));
		item("copy", "copy", tr::lng_parvane_canvas_copy(tr::now));
		item("cut", "x", tr::lng_parvane_canvas_cut(tr::now));
		item("wrap", "group", tr::lng_parvane_canvas_wrap(tr::now));
		if (hasGroup) {
			item("fit", "fit", tr::lng_parvane_canvas_fit_group(tr::now));
		}
		item("front", "front", tr::lng_parvane_canvas_to_front(tr::now));
		item("back", "back", tr::lng_parvane_canvas_to_back(tr::now));
		if (selected) {
			item("props", "dots", tr::lng_parvane_canvas_props(tr::now));
		}
		item("remove", "trash", tr::lng_parvane_canvas_remove(tr::now), true);
	}
	auto descriptor = CanvasWidgets::ContextMenu::Descriptor{
		.at = state.at,
		.items = std::move(items),
		.hasColors = (state.kind == MenuKind::Selection),
		.color = notes::colorOfSelection(*_doc, _selection),
		.canAlign = (state.kind == MenuKind::Selection) && _selection.nodes.size() > 1,
		.canDistribute = _selection.nodes.size() > 2,
	};
	auto labels = CanvasWidgets::ContextMenu::Labels{
		.color = tr::lng_parvane_canvas_color(tr::now),
		.noColor = tr::lng_parvane_canvas_no_color(tr::now),
		.alignLeft = tr::lng_parvane_canvas_align_left(tr::now),
		.alignCenter = tr::lng_parvane_canvas_align_center(tr::now),
		.alignRight = tr::lng_parvane_canvas_align_right(tr::now),
		.alignTop = tr::lng_parvane_canvas_align_top(tr::now),
		.alignMiddle = tr::lng_parvane_canvas_align_middle(tr::now),
		.alignBottom = tr::lng_parvane_canvas_align_bottom(tr::now),
		.distributeX = tr::lng_parvane_canvas_distribute_x(tr::now),
		.distributeY = tr::lng_parvane_canvas_distribute_y(tr::now),
	};
	_menuWidget = base::make_unique_q<CanvasWidgets::ContextMenu>(this, std::move(descriptor), std::move(labels));
	const auto menu = _menuWidget.get();
	menu->commands() | rpl::on_next([=](QString command) {
		crl::on_main(this, [=] { handleCommand(command); });
	}, menu->lifetime());
	menu->colors() | rpl::on_next([=](std::optional<std::string> color) {
		crl::on_main(this, [=] { recolor(color); });
	}, menu->lifetime());
	menu->aligns() | rpl::on_next([=](notes::CanvasAlign value) {
		crl::on_main(this, [=] { align(value); });
	}, menu->lifetime());
	menu->distributes() | rpl::on_next([=](notes::CanvasAxis axis) {
		crl::on_main(this, [=] { distribute(axis); });
	}, menu->lifetime());
	menu->show();
	menu->raise();
	refreshBar();
	update();
}

void Board::closeMenu() {
	if (!_menu && !_menuWidget) {
		return;
	}
	const auto wasDrop = _menu && _menu->kind == MenuKind::Drop;
	_menu.reset();
	if (_menuWidget) {
		_menuWidget->hide();
		_menuWidget.reset();
	}
	// Стрелка, оставленная на экране меню её конца, уходит вместе с меню
	if (wasDrop) {
		_draft.reset();
	}
	refreshBar();
	update();
}

void Board::handleCommand(const QString &command) {
	const auto state = _menu;
	const auto at = (state && state->kind == MenuKind::Board) ? std::optional(state->point) : std::nullopt;
	const auto drop = (state && state->kind == MenuKind::Drop && state->from) ? state : std::nullopt;
	closeMenu();
	if (command == u"edit"_q) {
		activateSelected(notes::NoteCardPart::Command);
	} else if (command == u"open"_q) {
		if (const auto node = selectedNode(); node && node->type == "file") {
			openFileNode(*node);
		}
	} else if (command == u"direction"_q) {
		turnEdges();
	} else if (command == u"duplicate"_q) {
		duplicate();
	} else if (command == u"copy"_q || command == u"cut"_q) {
		if (const auto text = copySelection()) {
			QGuiApplication::clipboard()->setText(Q(*text));
		}
		if (command == u"cut"_q) {
			removeSelected();
		}
	} else if (command == u"paste"_q) {
		const auto text = S(QGuiApplication::clipboard()->text());
		pasteText(text.empty() ? LastClipText : text, at);
	} else if (command == u"wrap"_q) {
		addGroup(std::nullopt);
	} else if (command == u"fit"_q) {
		fitGroups();
	} else if (command == u"front"_q) {
		reorder(notes::CanvasLayer::Front);
	} else if (command == u"back"_q) {
		reorder(notes::CanvasLayer::Back);
	} else if (command == u"props"_q) {
		showEditSheet();
	} else if (command == u"remove"_q) {
		removeSelected();
	} else if (command == u"selectAll"_q) {
		select(notes::selectAll(*_doc));
	} else if (command == u"textHere"_q) {
		addText(at);
	} else if (command == u"groupHere"_q) {
		addGroup(at ? at : std::optional(centerPoint()));
	} else if (command == u"note"_q) {
		showNotePicker(at, std::nullopt);
	} else if (command == u"newNote"_q) {
		showNewNote(at, std::nullopt);
	} else if (command == u"dropText"_q) {
		// Конец стрелки, брошенной на пустом месте: текстовая карточка, новая заметка либо заметка из списка
		if (drop && notes::findNode(*_doc, drop->from->id)) {
			auto node = MakeNode("text", notes::kCanvasDefaultNodeWidth, notes::kCanvasDefaultNodeHeight);
			node.set("text", "");
			startInline(addLinked(std::move(node), *drop->from, drop->point), true);
		}
	} else if (command == u"dropNewNote"_q) {
		if (drop) {
			showNewNote(drop->point, drop->from);
		}
	} else if (command == u"dropNote"_q) {
		if (drop) {
			showNotePicker(drop->point, drop->from);
		}
	} else if (command == u"link"_q) {
		showLinkSheet(std::nullopt, std::string(), at);
	} else if (command == u"file"_q) {
		showFilePicker(at);
	} else if (command == u"refreshGraph"_q) {
		refreshFromGraph();
	} else {
		applyView(fitTo(*_doc));
	}
}

// «Связать»: от выделенной карточки к той, которую нажмут следующей
void Board::handleLinkMode() {
	const auto selected = selectedNode();
	if (_linkFrom || !selected || selected->type == "group") {
		_linkFrom.reset();
	} else {
		_linkFrom = selected->id;
	}
	refreshTools();
	refreshBar();
	update();
}

// «Обновить из графа»: открытый холст получает карточки новых заметок и стрелки новых ссылок, свои стрелки
// исчезнувших ссылок уходят; сделанное руками не трогается. Один шаг истории
void Board::refreshFromGraph() {
	if (!entry()) {
		return;
	}
	finishInline();
	dropGesture();
	closeMenu();
	_linkFrom.reset();
	auto options = notes::GraphCanvasOptions();
	options.cardHeight = kNoteHeight;
	auto result = notes::refreshCanvasFromGraph(*_doc, graphNotes(), options);
	if (!result.changed) {
		toast(tr::lng_parvane_canvas_refresh_nothing(tr::now));
		return;
	}
	const auto added = result.addedCards;
	change(result.doc);
	if (!added.empty()) {
		selectNodes(added);
		auto rects = std::vector<CanvasRect>();
		for (const auto &id : added) {
			if (const auto node = notes::findNode(*_doc, id)) {
				rects.push_back(node->rect());
			}
		}
		const auto size = viewport();
		applyView(notes::revealRects(
			_view,
			ToBoardRects(rects),
			size.width(),
			size.height(),
			isNarrow() ? kFitTopNarrow : kFitTop,
			kFitBottom));
	} else {
		select(notes::pruneSelection(*_doc, _selection));
	}
	auto message = tr::lng_parvane_canvas_refresh_done(
		tr::now,
		lt_cards,
		QString::number(added.size()),
		lt_edges,
		QString::number(result.addedEdges.size()),
		lt_removed,
		QString::number(result.removedEdges.size()));
	if (!result.renamedCards.empty()) {
		message += u". "_q + tr::lng_parvane_canvas_refresh_renamed(
			tr::now,
			lt_amount,
			QString::number(result.renamedCards.size()));
	}
	toast(message);
}

void Board::createCanvas(const std::string &title, const CanvasDoc &content) {
	if (_creating) {
		return;
	}
	_creating = true;
	finishInline();
	flushSave();
	const auto text = notes::serializeCanvas(content);
	const auto vault = VaultName();
	Sections::Ask<std::optional<std::string>>([=](Sections::Workers &w) -> std::optional<std::string> {
		try {
			return w.notes.saveCanvas(title, text, vault);
		} catch (...) {
			return std::nullopt;
		}
	}, crl::guard(this, [=](std::optional<std::string> id) {
		_creating = false;
		if (id) {
			pickCanvas(*id);
		}
	}));
}

void Board::newCanvas() {
	auto taken = std::set<std::string>();
	for (const auto &canvas : _canvases) {
		taken.insert(Lower(canvas->title));
	}
	auto count = int(_canvases.size()) + 1;
	const auto name = [&] {
		return tr::lng_parvane_canvas_name(tr::now, lt_amount, QString::number(count));
	};
	while (taken.contains(Lower(S(name())))) {
		++count;
	}
	createCanvas(S(name()), notes::createEmptyCanvas());
}

// «Холст из графа»: карточка на каждую заметку, стрелка на каждую ссылку; дальше это обычный холст
void Board::graphCanvas() {
	auto options = notes::GraphCanvasOptions();
	options.cardHeight = kNoteHeight;
	const auto content = notes::canvasFromGraph(graphNotes(), options);
	auto taken = std::vector<std::string>();
	for (const auto &canvas : _canvases) {
		taken.push_back(canvas->title);
	}
	createCanvas(notes::freeCanvasTitle(S(tr::lng_parvane_canvas_graph_name(tr::now)), taken), content);
}

void Board::pickCanvas(const std::string &id) {
	finishInline();
	flushSave();
	_canvasId = id;
	if (_notes) {
		applyNotes(_notes);
	}
}

void Board::toast(const QString &text) {
	_controller->showToast(text);
}

// ── указатель ────────────────────────────────────────────────────────────────

void Board::mousePressEvent(QMouseEvent *e) {
	setFocus(Qt::MouseFocusReason);
	// Нажатие мимо поля правки сохраняет набранное
	finishInline();
	closeMenu();
	if (!entry() || e->button() == Qt::RightButton) {
		return;
	}
	const auto pos = e->position();
	const auto point = toCanvas(pos);
	const auto edgeHit = kEdgeHit / _view.scale;
	const auto hit = hitTest(point);
	// Кнопка «открыть заметку» на шапке и «открыть ссылку» карточки-ссылки
	if (e->button() == Qt::LeftButton && hit.openNote && hit.nodeId) {
		if (const auto node = notes::findNode(*_doc, *hit.nodeId)) {
			openFileNode(*node);
		}
		return;
	}
	if (e->button() == Qt::LeftButton && hit.linkUrl && !hit.linkUrl->empty()) {
		// Ревью 21 окт 2026 (2.3): адрес карточки — из файла холста (совместная папка, статья): только http(s)/mailto
		// и с окном «Перейти по ссылке?» — карточка показывает заголовок страницы, а не адрес
		OpenExternalLink(Q(*hit.linkUrl), QString(), true);
		return;
	}
	const auto nodeId = nodeUnder(hit, point, edgeHit);
	const auto mods = e->modifiers();
	const auto isAdditive = (mods & (Qt::ShiftModifier | Qt::ControlModifier | Qt::MetaModifier)) || _selectMode;
	auto press = notes::CanvasPress();
	press.isPanForced = (e->button() == Qt::MiddleButton) || _spaceDown;
	press.isAdditive = isAdditive;
	press.isLinking = _linkFrom.has_value();
	press.nodeId = nodeId;
	press.port = nodeId ? hit.port : std::nullopt;
	press.handle = nodeId ? hit.handle : std::nullopt;
	press.edgeId = nodeId ? std::nullopt : notes::edgeAt(*_doc, point, edgeHit);
	const auto action = notes::pressAction(press);
	const auto pan = [&] {
		auto gesture = Gesture();
		gesture.type = Gesture::Type::Pan;
		gesture.screen = pos;
		return gesture;
	};
	switch (action.kind) {
	case Kind::Pan:
		_gesture = pan();
		break;
	case Kind::Arrow: {
		_linkFrom.reset();
		selectNodes({ *action.id });
		auto gesture = Gesture();
		gesture.type = Gesture::Type::Edge;
		gesture.id = *action.id;
		gesture.side = *action.side;
		_gesture = std::move(gesture);
	} break;
	case Kind::Resize: {
		auto gesture = Gesture();
		gesture.type = Gesture::Type::Resize;
		gesture.id = *action.id;
		gesture.handle = *action.handle;
		gesture.origin = point;
		gesture.base = _doc;
		for (const auto &node : _doc->nodes) {
			if (node.id != *action.id) {
				gesture.others.push_back(node.rect());
			}
		}
		_gesture = std::move(gesture);
	} break;
	case Kind::Link: {
		const auto node = action.id ? notes::findNode(*_doc, *action.id) : nullptr;
		if (node && node->id != *_linkFrom && node->type != "group") {
			change(notes::addEdge(*_doc, *_linkFrom, node->id));
		}
		_linkFrom.reset();
		refreshTools();
		refreshBar();
		update();
	} break;
	case Kind::Node: {
		const auto &id = *action.id;
		const auto isIn = std::find(_selection.nodes.begin(), _selection.nodes.end(), id) != _selection.nodes.end();
		const auto next = isAdditive
			? notes::toggleSelected(_selection, notes::CanvasSelectionKind::Nodes, id)
			: isIn ? _selection : CanvasSelection{ { id }, {} };
		select(next);
		// Нажатие без сдвига на одном из нескольких выделенных оставляет выделенным только его
		if (std::find(next.nodes.begin(), next.nodes.end(), id) != next.nodes.end()) {
			startMove(
				id,
				next.nodes,
				point,
				(!isAdditive && isIn && next.nodes.size() > 1) ? std::optional(id) : std::nullopt);
		} else {
			_gesture.reset();
		}
	} break;
	case Kind::Edge:
		select(isAdditive
			? notes::toggleSelected(_selection, notes::CanvasSelectionKind::Edges, *action.id)
			: CanvasSelection{ {}, { *action.id } });
		_gesture = pan();
		break;
	// Пустое место с Shift (или в режиме выбора) рисует рамку — и вне групп, и внутри группы
	case Kind::Marquee: {
		auto gesture = Gesture();
		gesture.type = Gesture::Type::Marquee;
		gesture.origin = point;
		gesture.baseSelection = _selection;
		_gesture = std::move(gesture);
	} break;
	// Пустое место двигает поле — и вне групп, и внутри группы (группу берут за шапку и границу)
	default:
		select({});
		_gesture = pan();
	}
	updateCursor(point);
}

void Board::mouseMoveEvent(QMouseEvent *e) {
	const auto pos = e->position();
	_pointer = pos;
	const auto point = toCanvas(pos);
	if (!_gesture) {
		// Наведение: группа, которую возьмёт перетаскивание, и карточка с точками для стрелок
		const auto hover = hoverGroupAt(point);
		auto hoverNode = std::optional<std::string>();
		const auto &doc = shown();
		for (auto i = doc.nodes.rbegin(); i != doc.nodes.rend(); ++i) {
			if (i->type == "group") {
				continue;
			}
			const auto margin = kPortSize / _view.scale / 2.;
			if (QRectF(i->x, i->y, i->width, shownHeight(*i)).adjusted(-margin, -margin, margin, margin)
					.contains(QPointF(point.x, point.y))) {
				hoverNode = i->id;
				break;
			}
		}
		if (hover != _hoverGroup || hoverNode != _hoverNode) {
			_hoverGroup = hover;
			_hoverNode = hoverNode;
			update();
		}
		updateCursor(point);
		return;
	}
	auto &gesture = *_gesture;
	if (gesture.type == Gesture::Type::Pan) {
		const auto delta = (pos - gesture.screen) / k();
		if (!gesture.hasMoved && std::abs(delta.x()) + std::abs(delta.y()) < kDragThreshold) {
			return;
		}
		gesture.screen = pos;
		gesture.hasMoved = true;
		applyView({ _view.scale, _view.x + delta.x(), _view.y + delta.y() });
		return;
	}
	if (gesture.type == Gesture::Type::Edge) {
		const auto source = notes::findNode(*_doc, gesture.id);
		if (!source) {
			return;
		}
		gesture.hasMoved = true;
		const auto target = notes::nodeAtPoint(*_doc, point, gesture.id);
		const auto side = target ? notes::nearestSide(target->rect(), point) : notes::oppositeSide(gesture.side);
		const auto from = notes::sidePoint(source->rect(), gesture.side);
		const auto to = target ? notes::sidePoint(target->rect(), side) : point;
		_draft = notes::curveBetween({ from.x, from.y, gesture.side }, { to.x, to.y, side });
		update();
		return;
	}
	const auto dx = point.x - gesture.origin.x;
	const auto dy = point.y - gesture.origin.y;
	if (!gesture.hasMoved && (std::abs(dx) + std::abs(dy)) * _view.scale < kDragThreshold) {
		return;
	}
	gesture.hasMoved = true;
	if (gesture.type == Gesture::Type::Marquee) {
		const auto rect = notes::rectOfPoints(gesture.origin, point);
		const auto hit = notes::nodesInRect(*_doc, rect);
		_marquee = rect;
		auto nodes = gesture.baseSelection.nodes;
		for (const auto &id : hit) {
			if (std::find(nodes.begin(), nodes.end(), id) == nodes.end()) {
				nodes.push_back(id);
			}
		}
		select({ std::move(nodes), gesture.baseSelection.edges });
		return;
	}
	// Alt отключает и сетку, и прилипание к соседям
	const auto isFree = (e->modifiers() & Qt::AltModifier) != 0;
	const auto tolerance = notes::kCanvasSnapDistance / _view.scale;
	if (gesture.type == Gesture::Type::Move) {
		const auto lead = notes::findNode(*gesture.base, gesture.lead);
		if (!lead) {
			return;
		}
		auto delta = isFree
			? notes::CanvasDelta{ std::round(dx), std::round(dy) }
			: notes::snapDelta({ lead->x, lead->y }, dx, dy);
		const auto raw = CanvasRect{ gesture.bounds.x + dx, gesture.bounds.y + dy, gesture.bounds.width, gesture.bounds.height };
		auto snap = std::optional<notes::CanvasSnap>();
		if (!isFree) {
			snap = notes::snapToNeighbours(raw, gesture.others, tolerance);
		}
		// Сосед ближе допуска сильнее сетки — по каждой оси отдельно
		const auto hasAxis = [&](notes::CanvasAxis axis) {
			return snap && std::any_of(snap->guides.begin(), snap->guides.end(), [&](const notes::CanvasGuide &g) {
				return g.axis == axis;
			});
		};
		if (hasAxis(notes::CanvasAxis::X)) {
			delta.dx = std::round(dx + snap->dx);
		}
		if (hasAxis(notes::CanvasAxis::Y)) {
			delta.dy = std::round(dy + snap->dy);
		}
		const auto placed = CanvasRect{ gesture.bounds.x + delta.dx, gesture.bounds.y + delta.dy, gesture.bounds.width, gesture.bounds.height };
		auto guides = (snap && !snap->guides.empty())
			? notes::snapToNeighbours(placed, gesture.others, 0).guides
			: std::vector<notes::CanvasGuide>();
		showLive(
			notes::growGroups(*gesture.base, notes::moveNodes(*gesture.base, gesture.ids, delta.dx, delta.dy)),
			std::move(guides));
		return;
	}
	const auto node = notes::findNode(*gesture.base, gesture.id);
	if (!node) {
		return;
	}
	const auto min = notes::minSizeOf(node->type);
	auto rect = notes::resizeRect(node->rect(), gesture.handle, dx, dy, min, isFree ? 1. : notes::kCanvasGrid);
	auto guides = std::vector<notes::CanvasGuide>();
	if (!isFree) {
		const auto snapped = notes::snapResize(
			notes::resizeRect(node->rect(), gesture.handle, dx, dy, min, 1.),
			gesture.handle,
			gesture.others,
			tolerance,
			min);
		guides = snapped.guides;
		for (const auto &guide : guides) {
			if (guide.axis == notes::CanvasAxis::X) {
				rect.x = snapped.rect.x;
				rect.width = snapped.rect.width;
			} else {
				rect.y = snapped.rect.y;
				rect.height = snapped.rect.height;
			}
		}
	}
	showLive(notes::growGroups(*gesture.base, notes::placeNode(*gesture.base, node->id, rect)), std::move(guides));
}

void Board::mouseReleaseEvent(QMouseEvent *e) {
	auto gesture = std::exchange(_gesture, std::nullopt);
	auto result = std::exchange(_live, std::nullopt);
	_marquee.reset();
	const auto draft = std::exchange(_draft, std::nullopt);
	if (!gesture) {
		update();
		return;
	}
	const auto pos = e->position();
	const auto point = toCanvas(pos);
	if (gesture->hasMoved) {
		if ((gesture->type == Gesture::Type::Move || gesture->type == Gesture::Type::Resize) && result) {
			change(std::move(result->doc));
		}
		if (gesture->type == Gesture::Type::Edge) {
			const auto target = notes::nodeAtPoint(*_doc, point, gesture->id);
			if (target) {
				auto sides = notes::CanvasSides();
				sides.fromSide = notes::canvasSideName(gesture->side);
				sides.toSide = notes::canvasSideName(notes::nearestSide(target->rect(), point));
				change(notes::connectNodes(*_doc, gesture->id, target->id, sides));
			} else {
				// Стрелка, брошенная на пустом месте, спрашивает, что поставить на её конце. Пока меню открыто,
				// стрелка остаётся на экране
				_draft = draft;
				showMenu({ pos.toPoint(), point, MenuKind::Drop, EdgeStart{ gesture->id, gesture->side } });
			}
		}
		refreshBar();
		updateCursor(point);
		update();
		return;
	}
	if (gesture->type == Gesture::Type::Move && gesture->collapseTo) {
		selectNodes({ *gesture->collapseTo });
	}
	refreshBar();
	updateCursor(point);
	update();
}

// Двойной щелчок на пустом месте — новая текстовая карточка, на стрелке — правка подписи, на узле — он сам
void Board::mouseDoubleClickEvent(QMouseEvent *e) {
	if (!entry() || e->button() != Qt::LeftButton) {
		return;
	}
	const auto point = toCanvas(e->position());
	const auto hit = hitTest(point);
	if (hit.handle || hit.port || hit.openNote || hit.linkUrl) {
		return;
	}
	const auto nodeId = nodeUnder(hit, point, kEdgeHit / _view.scale);
	if (nodeId) {
		activate(*nodeId, hit.noteHead ? notes::NoteCardPart::Title : notes::NoteCardPart::Body);
		return;
	}
	if (const auto edgeId = notes::edgeAt(*_doc, point, kEdgeHit / _view.scale)) {
		if (const auto edge = notes::findEdge(*_doc, *edgeId)) {
			startEdgeInline(*edge);
		}
		return;
	}
	addText(point);
}

void Board::contextMenuEvent(QContextMenuEvent *e) {
	if (!entry()) {
		return;
	}
	e->accept();
	openMenuAt(e->pos());
}

void Board::wheelEvent(QWheelEvent *e) {
	if (!entry()) {
		return;
	}
	// Колесо меняет масштаб вокруг указателя (как в web: `deltaY` браузера — 100 на щелчок колеса)
	const auto pixel = e->pixelDelta();
	const auto deltaY = !pixel.isNull() ? -double(pixel.y()) : -e->angleDelta().y() * 100. / 120.;
	const auto css = e->position() / k();
	applyView(notes::zoomByWheel(_view, deltaY, css.x(), css.y()));
	e->accept();
}

bool Board::eventHook(QEvent *e) {
	if (e->type() == QEvent::NativeGesture) {
		// Щипок тачпада — масштаб вокруг точки жеста
		const auto gesture = static_cast<QNativeGestureEvent*>(e);
		if (gesture->gestureType() == Qt::ZoomNativeGesture && entry()) {
			const auto css = mapFromGlobal(gesture->globalPosition().toPoint()) / k();
			applyView(notes::zoomAround(_view, _view.scale * (1. + gesture->value()), css.x(), css.y()));
			return true;
		}
	}
	return RpWidget::eventHook(e);
}

void Board::leaveEventHook(QEvent *e) {
	_pointer.reset();
	if (_hoverGroup || _hoverNode) {
		_hoverGroup.reset();
		_hoverNode.reset();
		update();
	}
}

void Board::focusOutEvent(QFocusEvent *e) {
	// Отпущенный пробел и уход из окна (отпускание тогда не придёт) возвращают обычное перетаскивание
	_spaceDown = false;
	RpWidget::focusOutEvent(e);
}

// ── клавиши ──────────────────────────────────────────────────────────────────

void Board::keyPressEvent(QKeyEvent *e) {
	if (!entry() || _inline) {
		RpWidget::keyPressEvent(e);
		return;
	}
	const auto key = e->key();
	const auto mods = e->modifiers();
	const auto ctrl = (mods & (Qt::ControlModifier | Qt::MetaModifier)) != 0;
	// Escape по очереди: меню, режим связи, выделение, режим выбора
	if (key == Qt::Key_Escape) {
		if (_menu) {
			closeMenu();
		} else if (_linkFrom) {
			_linkFrom.reset();
			refreshTools();
			refreshBar();
			update();
		} else if (!notes::isSelectionEmpty(_selection)) {
			select({});
		} else if (_selectMode) {
			_selectMode = false;
			refreshTools();
		} else {
			RpWidget::keyPressEvent(e);
		}
		return;
	}
	if (key == Qt::Key_Space && !e->isAutoRepeat()) {
		// Пробел с перетаскиванием двигает поле
		_spaceDown = true;
		return;
	}
	// Буквы — по клавише на латинской и русской раскладке (web `e.code`)
	const auto is = [&](Qt::Key latin, int cyrillic) {
		return key == latin || key == cyrillic;
	};
	if (ctrl && !(mods & Qt::ShiftModifier) && (is(Qt::Key_C, 0x421) || is(Qt::Key_X, 0x427))) {
		if (const auto text = copySelection()) {
			QGuiApplication::clipboard()->setText(Q(*text));
			if (is(Qt::Key_X, 0x427)) {
				removeSelected();
			}
		}
		return;
	}
	if (ctrl && !(mods & Qt::ShiftModifier) && is(Qt::Key_V, 0x41C)) {
		const auto text = S(QGuiApplication::clipboard()->text());
		if (!text.empty()) {
			pasteText(text, pointerPoint());
		}
		return;
	}
	auto canvasKey = notes::CanvasKey();
	canvasKey.ctrlKey = (mods & Qt::ControlModifier) != 0;
	canvasKey.metaKey = (mods & Qt::MetaModifier) != 0;
	canvasKey.shiftKey = (mods & Qt::ShiftModifier) != 0;
	canvasKey.altKey = (mods & Qt::AltModifier) != 0;
	if (is(Qt::Key_Z, 0x42F)) {
		canvasKey.code = "KeyZ";
	} else if (is(Qt::Key_Y, 0x41D)) {
		canvasKey.code = "KeyY";
	} else if (is(Qt::Key_A, 0x424)) {
		canvasKey.code = "KeyA";
	} else if (is(Qt::Key_D, 0x412)) {
		canvasKey.code = "KeyD";
	}
	switch (key) {
	case Qt::Key_Delete: canvasKey.key = "Delete"; break;
	case Qt::Key_Backspace: canvasKey.key = "Backspace"; break;
	case Qt::Key_Return: case Qt::Key_Enter: canvasKey.key = "Enter"; break;
	case Qt::Key_F2: canvasKey.key = "F2"; break;
	case Qt::Key_Left: canvasKey.key = "ArrowLeft"; break;
	case Qt::Key_Right: canvasKey.key = "ArrowRight"; break;
	case Qt::Key_Up: canvasKey.key = "ArrowUp"; break;
	case Qt::Key_Down: canvasKey.key = "ArrowDown"; break;
	default: break;
	}
	const auto action = notes::canvasShortcut(canvasKey);
	using Sc = notes::CanvasShortcut;
	if (!action) {
		RpWidget::keyPressEvent(e);
		return;
	}
	// Без выделения клавиши удаления, правки и стрелки остаются приложению
	const auto needsSelection = (*action != Sc::Undo && *action != Sc::Redo && *action != Sc::SelectAll);
	if (needsSelection && notes::isSelectionEmpty(_selection)) {
		RpWidget::keyPressEvent(e);
		return;
	}
	e->accept();
	const auto step = canvasKey.shiftKey ? notes::kCanvasNudgeBig : notes::kCanvasGrid;
	const auto nudge = [&](double dx, double dy) {
		const auto base = *_doc;
		change(notes::growGroups(base, notes::moveNodes(base, _selection.nodes, dx, dy)));
	};
	switch (*action) {
	case Sc::Undo: undo(); break;
	case Sc::Redo: redo(); break;
	case Sc::SelectAll: select(notes::selectAll(*_doc)); break;
	case Sc::Duplicate: duplicate(); break;
	case Sc::Remove: removeSelected(); break;
	case Sc::Edit: activateSelected(notes::NoteCardPart::Body); break;
	case Sc::Left: nudge(-step, 0.); break;
	case Sc::Right: nudge(step, 0.); break;
	case Sc::Up: nudge(0., -step); break;
	case Sc::Down: nudge(0., step); break;
	}
}

void Board::keyReleaseEvent(QKeyEvent *e) {
	if (e->key() == Qt::Key_Space && !e->isAutoRepeat()) {
		_spaceDown = false;
	}
	RpWidget::keyReleaseEvent(e);
}

// ── шторки ───────────────────────────────────────────────────────────────────

// «Свойства» (и «Изменить» у узла без правки на месте): текст карточки, название группы, подпись связи, цвет и
// подписи связей карточки
void Board::showEditSheet() {
	finishInline();
	closeMenu();
	const auto node = selectedNode();
	const auto edge = selectedEdge();
	if (!node && !edge) {
		return;
	}
	struct Editing {
		std::string nodeId;
		std::string edgeId;
		std::string type;
		std::optional<std::string> color;
		std::map<std::string, Field*> labels;
		std::set<std::string> removed;
		Field *text = nullptr;
		std::vector<std::pair<std::optional<std::string>, Kit::Chip*>> chips;
	};
	const auto editing = std::make_shared<Editing>();
	editing->nodeId = node ? node->id : std::string();
	editing->edgeId = edge ? edge->id : std::string();
	editing->type = node ? node->type : std::string();
	editing->color = node ? node->str("color") : edge->str("color");
	const auto title = !node ? tr::lng_parvane_canvas_edge_title(tr::now)
		: (node->type == "group") ? tr::lng_parvane_canvas_group(tr::now)
		: (node->type == "file") ? nameOfNode(node->id)
		: (node->type == "link") ? tr::lng_parvane_canvas_link_card(tr::now)
		: tr::lng_parvane_canvas_text_card(tr::now);
	const auto sheet = Sheet::Show(this->window(), {
		.title = title,
		.closeName = tr::lng_parvane_canvas_close(tr::now),
	});
	if (node && node->type == "file") {
		const auto open = sheet->add(object_ptr<PushButton>(
			sheet->content(),
			noteTitleOf(*node) ? tr::lng_parvane_canvas_open_note(tr::now) : tr::lng_parvane_canvas_open_file(tr::now)));
		const auto id = node->id;
		open->setClickedCallback([=] {
			sheet->requestClose();
			if (const auto found = notes::findNode(*_doc, id)) {
				openFileNode(*found);
			}
		});
	} else if (node && node->type == "text") {
		editing->text = sheet->add(object_ptr<Field>(
			sheet->content(),
			Field::Kind::Textarea,
			tr::lng_parvane_canvas_text(),
			Q(Str(*node, "text"))));
	} else if (!node || node->type == "group") {
		editing->text = sheet->add(object_ptr<Field>(
			sheet->content(),
			Field::Kind::Input,
			node ? tr::lng_parvane_canvas_group_name() : tr::lng_parvane_canvas_label(),
			Q(node ? Str(*node, "label") : Str(*edge, "label"))));
	}
	sheet->add(object_ptr<Label>(sheet->content(), tr::lng_parvane_canvas_color(tr::now), Label::Small()));
	const auto colors = sheet->add(object_ptr<Flow>(sheet->content()));
	const auto tones = std::array<Tone, 6>{ Tone::Red, Tone::Orange, Tone::Yellow, Tone::Green, Tone::Blue, Tone::Purple };
	const auto refreshChips = [=] {
		for (const auto &[value, chip] : editing->chips) {
			chip->setOn(value == editing->color || (!value && !CanvasLook::PresetColor(editing->color)));
		}
	};
	for (auto i = 0; i != 6; ++i) {
		const auto value = std::optional<std::string>(notes::kCanvasPresetColors[i]);
		const auto chip = colors->add(object_ptr<Kit::Chip>(colors, Kit::Chip::Descriptor{
			.text = QString(),
			.tone = tones[i],
			.dot = true,
		}));
		chip->setAccessibleName(tr::lng_parvane_canvas_color(tr::now) + ' ' + Q(*value));
		chip->setClickedCallback([=] {
			editing->color = value;
			refreshChips();
		});
		editing->chips.push_back({ value, chip });
	}
	const auto none = colors->add(object_ptr<Kit::Chip>(colors, Kit::Chip::Descriptor{
		.text = tr::lng_parvane_canvas_no_color(tr::now),
	}));
	none->setClickedCallback([=] {
		editing->color.reset();
		refreshChips();
	});
	editing->chips.push_back({ std::nullopt, none });
	refreshChips();
	if (node) {
		auto edges = std::vector<CanvasEdge>();
		for (const auto &item : _doc->edges) {
			if (item.fromNode == node->id || item.toNode == node->id) {
				edges.push_back(item);
			}
		}
		if (!edges.empty()) {
			sheet->add(object_ptr<Label>(sheet->content(), tr::lng_parvane_canvas_edges_hint(tr::now), Label::Small()));
			for (const auto &item : edges) {
				const auto row = sheet->add(object_ptr<Ui::RpWidget>(sheet->content()));
				const auto name = Ui::CreateChild<Label>(
					row,
					nameOfNode(item.fromNode) + u" → "_q + nameOfNode(item.toNode),
					Label::Small());
				const auto input = Ui::CreateChild<Field>(
					row,
					Field::Kind::Input,
					tr::lng_parvane_canvas_label(),
					Q(Str(item, "label")));
				const auto remove = Ui::CreateChild<IconButton>(
					row,
					u"x"_q,
					tr::lng_parvane_canvas_remove_edge(tr::now),
					IconButton::Kind::Small);
				const auto id = item.id;
				editing->labels[id] = input;
				remove->setClickedCallback([=] {
					editing->removed.insert(id);
					row->hide();
					row->resize(row->width(), 0);
				});
				row->widthValue() | rpl::on_next([=](int w) {
					// `.edgeRow`: «откуда → куда» 44 %, подпись, удалить
					const auto gap = Rem(0.5);
					const auto nameWidth = int(w * 0.44);
					name->resizeToWidth(nameWidth);
					remove->moveToRight(0, (input->height() - remove->height()) / 2, w);
					input->resizeToWidth(std::max(w - nameWidth - remove->width() - gap * 2, 1));
					input->moveToLeft(nameWidth + gap, 0, w);
					name->moveToLeft(0, (input->height() - name->height()) / 2, w);
					row->resize(w, row->isHidden() ? 0 : input->height());
				}, row->lifetime());
			}
		}
	}
	const auto done = sheet->add(object_ptr<PushButton>(sheet->content(), tr::lng_parvane_canvas_done(tr::now), PushButton::Kind::Accent));
	done->setClickedCallback([=] {
		const auto current = *_doc;
		const auto text = editing->text ? notes::canvasjs::trim(S(editing->text->text())) : std::string();
		const auto colorValue = editing->color
			? std::optional<CanvasJson>(CanvasJson(*editing->color))
			: std::nullopt;
		if (!editing->edgeId.empty()) {
			change(notes::updateEdge(current, editing->edgeId, {
				{ "label", CanvasJson(text) },
				{ "color", colorValue },
			}));
		} else if (const auto found = notes::findNode(current, editing->nodeId)) {
			auto patch = notes::CanvasPatch{ { "color", colorValue } };
			if (found->type == "group") {
				patch.push_back({ "label", text.empty() ? std::nullopt : std::optional<CanvasJson>(CanvasJson(text)) });
			} else if (found->type == "text") {
				patch.push_back({ "text", CanvasJson(text) });
			}
			auto next = notes::updateNode(current, found->id, patch);
			for (const auto &[id, input] : editing->labels) {
				if (editing->removed.contains(id)) {
					continue;
				}
				const auto value = notes::canvasjs::trim(S(input->text()));
				const auto edge = notes::findEdge(next, id);
				if (edge && Str(*edge, "label") != value) {
					next = notes::updateEdge(next, id, { { "label", CanvasJson(value) } });
				}
			}
			for (const auto &id : editing->removed) {
				next = notes::removeEdge(next, id);
			}
			change(std::move(next));
		}
		sheet->requestClose();
	});
	if (editing->text) {
		editing->text->setFocusFast();
	}
}

void Board::showLinkSheet(std::optional<std::string> nodeId, std::string url, std::optional<CanvasPoint> at) {
	finishInline();
	const auto sheet = Sheet::Show(this->window(), {
		.title = tr::lng_parvane_canvas_link_title(tr::now),
		.closeName = tr::lng_parvane_canvas_close(tr::now),
	});
	const auto field = sheet->add(object_ptr<Field>(
		sheet->content(),
		Field::Kind::Input,
		rpl::single(u"https://"_q),
		Q(url)));
	field->input()->setAccessibleName(tr::lng_parvane_canvas_link_url(tr::now));
	const auto button = sheet->add(object_ptr<PushButton>(
		sheet->content(),
		nodeId ? tr::lng_parvane_canvas_done(tr::now) : tr::lng_parvane_canvas_link_add(tr::now),
		PushButton::Kind::Accent));
	// Адрес берётся из самого поля
	const auto save = [=] {
		const auto normalized = notes::normalizeCanvasUrl(S(field->text()));
		if (!normalized) {
			toast(tr::lng_parvane_canvas_link_bad(tr::now));
			return;
		}
		sheet->requestClose();
		if (nodeId) {
			change(notes::updateNode(*_doc, *nodeId, { { "url", CanvasJson(*normalized) } }));
		} else {
			addLink(*normalized, at);
		}
	};
	button->setClickedCallback(save);
	field->submits() | rpl::on_next(save, field->lifetime());
	field->setFocusFast();
}

void Board::showCanvasMenu() {
	finishInline();
	const auto current = entry();
	if (!current) {
		return;
	}
	const auto id = current->id;
	const auto sheet = Sheet::Show(this->window(), {
		.title = Q(current->title),
		.closeName = tr::lng_parvane_canvas_close(tr::now),
	});
	const auto field = sheet->add(object_ptr<Field>(
		sheet->content(),
		Field::Kind::Input,
		tr::lng_parvane_canvas_title(),
		Q(current->title)));
	field->input()->setMaxLength(kCanvasTitleMax);
	const auto rename = sheet->add(object_ptr<PushButton>(
		sheet->content(),
		tr::lng_parvane_canvas_rename(tr::now),
		PushButton::Kind::Accent,
		u"pen"_q));
	// Название берётся из самого поля
	const auto doRename = [=] {
		const auto title = notes::canvasjs::trim(S(field->text()));
		sheet->requestClose();
		const auto now = entry();
		if (!now || now->id != id || title.empty() || title == now->title) {
			return;
		}
		flushSave();
		Sections::Post([=](Sections::Workers &w) {
			w.notes.renameCanvas(id, title);
		});
	};
	rename->setClickedCallback(doRename);
	field->submits() | rpl::on_next(doRename, field->lifetime());
	sheet->add(object_ptr<Label>(sheet->content(), tr::lng_parvane_canvas_images(tr::now), Label::Small()));
	const auto qualities = sheet->add(object_ptr<Flow>(sheet->content()));
	const auto full = qualities->add(object_ptr<Kit::Chip>(qualities, Kit::Chip::Descriptor{
		.text = tr::lng_parvane_canvas_images_full(tr::now),
	}));
	const auto thumb = qualities->add(object_ptr<Kit::Chip>(qualities, Kit::Chip::Descriptor{
		.text = tr::lng_parvane_canvas_images_thumb(tr::now),
	}));
	const auto refreshQuality = [=] {
		const auto quality = CanvasMedia::ImageQuality();
		full->setOn(quality == notes::CanvasImageQuality::Full);
		thumb->setOn(quality == notes::CanvasImageQuality::Thumb);
	};
	full->setClickedCallback([=] {
		CanvasMedia::SetImageQuality(notes::CanvasImageQuality::Full);
		refreshQuality();
	});
	thumb->setClickedCallback([=] {
		CanvasMedia::SetImageQuality(notes::CanvasImageQuality::Thumb);
		refreshQuality();
	});
	refreshQuality();
	sheet->add(object_ptr<Label>(sheet->content(), tr::lng_parvane_canvas_images_hint(tr::now), Label::Faint()));
	const auto remove = sheet->add(object_ptr<PushButton>(
		sheet->content(),
		tr::lng_parvane_canvas_delete(tr::now),
		PushButton::Kind::Danger));
	remove->setClickedCallback([=] {
		sheet->requestClose();
		crl::on_main(this, [=] { showDeleteConfirm(); });
	});
	field->setFocusFast();
}

// В корзину облака; после этого открыт другой холст, а если их не осталось — пустое состояние
void Board::showDeleteConfirm() {
	const auto current = entry();
	if (!current) {
		return;
	}
	const auto id = current->id;
	const auto sheet = Sheet::Show(this->window(), {
		.title = Q(current->title),
	});
	sheet->add(object_ptr<Label>(
		sheet->content(),
		tr::lng_parvane_canvas_delete_confirm(tr::now, lt_name, Q(current->title)),
		Label::Style{ .multiline = true }));
	const auto buttons = sheet->addButtons();
	const auto cancel = buttons->add(object_ptr<PushButton>(buttons, tr::lng_parvane_canvas_cancel(tr::now)));
	cancel->setClickedCallback([=] { sheet->requestClose(); });
	const auto confirm = buttons->add(object_ptr<PushButton>(
		buttons,
		tr::lng_parvane_canvas_delete(tr::now),
		PushButton::Kind::Danger));
	confirm->setClickedCallback([=] {
		sheet->requestClose();
		flushSave(true);
		_removedIds.insert(id);
		if (_canvasId == id) {
			_canvasId.clear();
		}
		_loadedId.clear();
		if (_notes) {
			applyNotes(_notes);
		}
		Sections::Ask<bool>([=](Sections::Workers &w) {
			try {
				return w.notes.deleteCanvas(id);
			} catch (...) {
				return false;
			}
		}, crl::guard(this, [=](bool done) {
			// Не удалось — холст возвращается в список
			if (!done) {
				_removedIds.erase(id);
				if (_notes) {
					applyNotes(_notes);
				}
			}
		}));
	});
}

// Заметка на холст: первая строка — новая заметка, дальше все заметки (уже лежащие на холсте приглушены подписью)
void Board::showNotePicker(std::optional<CanvasPoint> at, std::optional<EdgeStart> from) {
	finishInline();
	const auto sheet = Sheet::Show(this->window(), {
		.title = tr::lng_parvane_canvas_choose_note(tr::now),
		.closeName = tr::lng_parvane_canvas_close(tr::now),
		.tight = true,
	});
	const auto fresh = sheet->add(object_ptr<Row>(sheet->content(), Row::Descriptor{
		.title = tr::lng_parvane_canvas_new_note(tr::now),
		.subtitle = tr::lng_parvane_canvas_new_note_hint(tr::now),
		.icon = u"plus"_q,
	}));
	fresh->setClickedCallback([=] {
		sheet->requestClose();
		crl::on_main(this, [=] { showNewNote(at, from); });
	});
	auto onCanvas = std::set<std::string>();
	for (const auto &node : _doc->nodes) {
		if (node.type == "file") {
			onCanvas.insert(Lower(notes::noteTitleOfPath(node.str("file")).value_or(std::string())));
		}
	}
	if (!_notes) {
		return;
	}
	for (const auto &note : _notes->notes) {
		const auto isOn = onCanvas.contains(Lower(note->title));
		const auto row = sheet->add(object_ptr<Row>(sheet->content(), Row::Descriptor{
			.title = Q(note->title),
			.subtitle = isOn
				? tr::lng_parvane_canvas_already_on(tr::now)
				: note->folder.empty() ? tr::lng_parvane_canvas_root(tr::now) : Q(note->folder),
			.icon = u"note"_q,
		}));
		const auto title = note->title;
		const auto noteId = note->id;
		row->setClickedCallback([=] {
			sheet->requestClose();
			addNoteCard(title, noteId, at, from);
		});
	}
}

// Новая заметка прямо с холста: название спрашивается шторкой; заметка — настоящий файл `.md` в хранилище
void Board::showNewNote(std::optional<CanvasPoint> at, std::optional<EdgeStart> from) {
	finishInline();
	const auto sheet = Sheet::Show(this->window(), {
		.title = tr::lng_parvane_canvas_new_note(tr::now),
		.closeName = tr::lng_parvane_canvas_close(tr::now),
	});
	const auto field = sheet->add(object_ptr<Field>(
		sheet->content(),
		Field::Kind::Input,
		tr::lng_parvane_canvas_note_title()));
	field->input()->setMaxLength(notes::kNoteTitleMax);
	sheet->add(object_ptr<Label>(
		sheet->content(),
		from ? tr::lng_parvane_canvas_new_note_linked_hint(tr::now) : tr::lng_parvane_canvas_new_note_hint(tr::now),
		Label::Faint()));
	const auto create = sheet->add(object_ptr<PushButton>(
		sheet->content(),
		tr::lng_parvane_canvas_new_note_create(tr::now),
		PushButton::Kind::Accent));
	// Карточка встаёт, когда заметка записана: занятое название получает номер, и карточка несёт уже его
	const auto save = [=] {
		const auto title = notes::canvasjs::trim(S(field->text()));
		if (title.empty() || _creatingNote) {
			return;
		}
		sheet->requestClose();
		const auto canvas = _loadedId;
		_creatingNote = true;
		const auto vault = VaultName();
		Sections::Ask<std::pair<std::optional<std::string>, std::string>>([=](Sections::Workers &w) {
			auto result = std::pair<std::optional<std::string>, std::string>{ std::nullopt, title };
			try {
				result.first = w.notes.createNote(title, vault);
				if (result.first) {
					for (const auto &note : w.notes.notes()) {
						if (note->id == *result.first) {
							result.second = note->title;
						}
					}
				}
			} catch (...) {
			}
			return result;
		}, crl::guard(this, [=](std::pair<std::optional<std::string>, std::string> result) {
			_creatingNote = false;
			// Холст за это время сменили — заметка создана, карточку ставить некуда
			if (!result.first || canvas != _loadedId) {
				return;
			}
			addNoteCard(result.second, *result.first, at, from);
		}));
	};
	create->setClickedCallback(save);
	field->submits() | rpl::on_next(save, field->lifetime());
	field->setFocusFast();
}

// Выбор файла личного диска для карточки холста: папки открываются, файл выбирается нажатием
void Board::showFilePicker(std::optional<CanvasPoint> at) {
	finishInline();
	const auto sheet = Sheet::Show(this->window(), {
		.title = tr::lng_parvane_canvas_file_choose(tr::now),
		.closeName = tr::lng_parvane_canvas_close(tr::now),
		.tight = true,
	});
	fillFilePicker(sheet, std::nullopt, at);
}

void Board::fillFilePicker(not_null<Sheet*> sheet, std::optional<std::string> folderId, std::optional<CanvasPoint> at) {
	Kit::ClearLayout(sheet->content());
	const auto nodes = _driveNodes;
	// Папка сама либо любая из её родительских лежит в корзине — открыт корень
	const auto trashedIn = [&](const std::string &id) {
		auto current = std::optional<std::string>(id);
		for (auto depth = 0; current && depth <= int(nodes.size()); ++depth) {
			const auto i = std::find_if(nodes.begin(), nodes.end(), [&](const cloud::CloudNode &n) { return n.id == *current; });
			if (i == nodes.end()) {
				return false;
			}
			if (i->trashed) {
				return true;
			}
			current = (i->parent && !i->parent->empty()) ? i->parent : std::nullopt;
		}
		return false;
	};
	const cloud::CloudNode *folder = nullptr;
	if (folderId && !trashedIn(*folderId)) {
		for (const auto &node : nodes) {
			if (node.id == *folderId) {
				folder = &node;
			}
		}
	}
	sheet->setTitle(folder ? Q(folder->name) : tr::lng_parvane_canvas_file_choose(tr::now));
	if (folder) {
		const auto parent = folder->parent;
		const auto back = sheet->add(object_ptr<Row>(sheet->content(), Row::Descriptor{
			.title = tr::lng_parvane_canvas_back(tr::now),
			.icon = u"right"_q,
		}));
		back->setClickedCallback([=] {
			crl::on_main(sheet.get(), [=] {
				fillFilePicker(sheet, (parent && !parent->empty()) ? parent : std::nullopt, at);
			});
		});
	}
	// Папки идут первыми, корзина в список не попадает
	const auto rows = cloud::sortNodes(
		cloud::childrenOf(cloud::listedNodes(nodes), folder ? std::optional(folder->id) : std::nullopt),
		cloud::Sort{ cloud::SortKey::Name, false });
	if (rows.empty()) {
		sheet->add(object_ptr<Empty>(sheet->content(), tr::lng_parvane_canvas_file_empty(tr::now)));
	}
	for (const auto &node : rows) {
		const auto isFolder = node.isFolder();
		const auto row = sheet->add(object_ptr<Row>(sheet->content(), Row::Descriptor{
			.title = Q(node.name),
			.subtitle = isFolder ? QString() : Q(notes::formatCardSize(double(node.size))),
			.icon = isFolder ? u"folder"_q : u"note"_q,
			.trailingIcon = isFolder ? u"right"_q : QString(),
		}));
		const auto id = node.id;
		row->setClickedCallback([=] {
			if (isFolder) {
				crl::on_main(sheet.get(), [=] { fillFilePicker(sheet, id, at); });
				return;
			}
			const auto path = notes::drivePathOf(_driveNodes, id);
			sheet->requestClose();
			const auto file = notes::resolveDrivePath(_driveNodes, path);
			const auto isImage = file && ((file->thumb && !file->thumb->is_null()) || notes::isCanvasImage(file->mime, file->name));
			auto card = MakeNode(
				"file",
				notes::kCanvasDefaultNodeWidth,
				(isImage && !notes::noteTitleOfPath(path)) ? kFileHeight : kNoteHeight);
			card.set("file", path);
			add(std::move(card), at);
		});
	}
}

// ── панели ───────────────────────────────────────────────────────────────────

void Board::setupTools() {
	using CanvasWidgets::ToolButton;
	_chipRow = Ui::CreateChild<Ui::RpWidget>(this);
	// Чипы холстов не помещаются — строка листается колесом
	base::install_event_filter(_chipRow, [=](not_null<QEvent*> e) {
		if (e->type() != QEvent::Wheel) {
			return base::EventFilterResult::Continue;
		}
		const auto wheel = static_cast<QWheelEvent*>(e.get());
		const auto delta = wheel->angleDelta();
		_chipScroll -= (std::abs(delta.x()) > std::abs(delta.y())) ? delta.x() / 2 : delta.y() / 2;
		relayoutTools();
		return base::EventFilterResult::Cancel;
	});
	_toolRow = Ui::CreateChild<Ui::RpWidget>(this);
	const auto tool = [&](not_null<Ui::RpWidget*> row, const char *icon, const QString &label, Fn<void()> click) {
		const auto button = Ui::CreateChild<ToolButton>(row.get(), QString::fromLatin1(icon), label);
		button->setClickedCallback(std::move(click));
		return button;
	};
	tool(_toolRow, "text", tr::lng_parvane_canvas_text_card(tr::now), [=] { addText(std::nullopt); });
	tool(_toolRow, "note", tr::lng_parvane_canvas_choose_note(tr::now), [=] { showNotePicker(std::nullopt, std::nullopt); });
	tool(_toolRow, "noteNew", tr::lng_parvane_canvas_new_note(tr::now), [=] { showNewNote(std::nullopt, std::nullopt); });
	tool(_toolRow, "open", tr::lng_parvane_canvas_link_title(tr::now), [=] { showLinkSheet(std::nullopt, std::string(), std::nullopt); });
	tool(_toolRow, "file", tr::lng_parvane_canvas_file_choose(tr::now), [=] { showFilePicker(std::nullopt); });
	_toolGroup = tool(_toolRow, "group", tr::lng_parvane_canvas_group(tr::now), [=] { addGroup(std::nullopt); });
	_toolConnect = tool(_toolRow, "link", tr::lng_parvane_canvas_link(tr::now), [=] { handleLinkMode(); });
	_toolSelect = tool(_toolRow, "select", tr::lng_parvane_canvas_select_mode(tr::now), [=] {
		_selectMode = !_selectMode;
		refreshTools();
	});
	{
		const auto gap = Rem(0.375);
		auto x = 0;
		for (const auto child : _toolRow->children()) {
			if (const auto widget = qobject_cast<QWidget*>(child)) {
				widget->move(x, 0);
				x += widget->width() + gap;
			}
		}
		_toolRow->resize(std::max(x - gap, 0), Rem(2.375));
	}

	_zoom = Ui::CreateChild<Ui::RpWidget>(this);
	_undo = tool(_zoom, "undo", tr::lng_parvane_canvas_undo(tr::now), [=] { undo(); });
	_redo = tool(_zoom, "redo", tr::lng_parvane_canvas_redo(tr::now), [=] { redo(); });
	tool(_zoom, "plus", tr::lng_parvane_canvas_zoom_in(tr::now), [=] { zoomBy(notes::kBoardZoomStep); });
	tool(_zoom, "minus", tr::lng_parvane_canvas_zoom_out(tr::now), [=] { zoomBy(1. / notes::kBoardZoomStep); });
	tool(_zoom, "fit", tr::lng_parvane_canvas_zoom_fit(tr::now), [=] { applyView(fitTo(*_doc)); });
	{
		const auto gap = Rem(0.375);
		auto y = 0;
		for (const auto child : _zoom->children()) {
			if (const auto widget = qobject_cast<QWidget*>(child)) {
				widget->move(0, y);
				y += widget->height() + gap;
			}
		}
		_zoom->resize(Rem(2.375), std::max(y - gap, 0));
	}
	syncHistory();

	_bar = Ui::CreateChild<CanvasWidgets::SelectionBar>(this, CanvasWidgets::SelectionBar::Labels{
		.color = tr::lng_parvane_canvas_color(tr::now),
		.noColor = tr::lng_parvane_canvas_no_color(tr::now),
		.edit = tr::lng_parvane_canvas_edit(tr::now),
		.open = tr::lng_parvane_canvas_open_note(tr::now),
		.direction = tr::lng_parvane_canvas_direction(tr::now),
		.duplicate = tr::lng_parvane_canvas_duplicate(tr::now),
		.wrap = tr::lng_parvane_canvas_wrap(tr::now),
		.fit = tr::lng_parvane_canvas_fit_group(tr::now),
		.remove = tr::lng_parvane_canvas_remove(tr::now),
		.more = tr::lng_parvane_canvas_more(tr::now),
	});
	_bar->hide();
	_bar->actions() | rpl::on_next([=](QString action) {
		crl::on_main(this, [=] {
			if (action == u"edit"_q) {
				activateSelected(notes::NoteCardPart::Command);
			} else if (action == u"open"_q) {
				if (const auto node = selectedNode(); node && node->type == "file") {
					openFileNode(*node);
				}
			} else if (action == u"direction"_q) {
				turnEdges();
			} else if (action == u"duplicate"_q) {
				duplicate();
			} else if (action == u"wrap"_q) {
				addGroup(std::nullopt);
			} else if (action == u"fit"_q) {
				fitGroups();
			} else if (action == u"remove"_q) {
				removeSelected();
			}
		});
	}, _bar->lifetime());
	_bar->colors() | rpl::on_next([=](std::optional<std::string> color) {
		crl::on_main(this, [=] { recolor(color); });
	}, _bar->lifetime());
	_bar->moreRequests() | rpl::on_next([=](QPoint at) {
		crl::on_main(this, [=] {
			// «⋯» панели выделенного: то же меню рядом с кнопкой
			if (_menu) {
				closeMenu();
				return;
			}
			showMenu({ at, centerPoint(), MenuKind::Selection });
		});
	}, _bar->lifetime());

	// Пустое состояние: холстов ещё нет
	_start = Ui::CreateChild<Ui::RpWidget>(this);
	_start->hide();
}

void Board::rebuildChips() {
	for (const auto chip : _chips) {
		delete chip;
	}
	_chips.clear();
	const auto current = entry();
	const auto add = [&](const QString &icon, const QString &text, const QString &label, Fn<void()> click) {
		const auto chip = Ui::CreateChild<CanvasWidgets::Chip>(_chipRow, icon, text, label);
		chip->setClickedCallback(std::move(click));
		chip->show();
		_chips.push_back(chip);
		return chip;
	};
	for (const auto &canvas : _canvases) {
		const auto id = canvas->id;
		const auto chip = add(u"board"_q, Q(canvas->title), QString(), [=] { pickCanvas(id); });
		chip->setOn(current && current->id == id);
	}
	add(u"plus"_q, tr::lng_parvane_canvas(tr::now), tr::lng_parvane_canvas_new(tr::now), [=] { newCanvas(); });
	const auto fromGraph = add(
		u"graph"_q,
		tr::lng_parvane_canvas_from_graph_short(tr::now),
		tr::lng_parvane_canvas_from_graph(tr::now),
		[=] { graphCanvas(); });
	fromGraph->setEnabled(_notes && !_notes->notes.empty());
	add(u"refresh"_q, QString(), tr::lng_parvane_canvas_refresh(tr::now), [=] { refreshFromGraph(); });
	add(u"dots"_q, QString(), tr::lng_parvane_canvas_actions(tr::now), [=] { showCanvasMenu(); });

	// Пустое состояние: подсказка, «Холст из графа» (если есть заметки) и «Новый холст»
	for (const auto child : _start->children()) {
		if (const auto widget = qobject_cast<QWidget*>(child)) {
			widget->hide();
			widget->deleteLater();
		}
	}
	if (!current) {
		const auto hasNotes = _notes && !_notes->notes.empty();
		const auto text = Ui::CreateChild<Label>(
			_start,
			hasNotes ? tr::lng_parvane_canvas_empty_graph(tr::now) : tr::lng_parvane_canvas_empty(tr::now),
			Label::Style{ .tone = Tone::Muted, .multiline = true, .align = style::al_top });
		text->show();
		auto buttons = std::vector<PushButton*>();
		if (hasNotes) {
			const auto graph = Ui::CreateChild<PushButton>(
				_start,
				tr::lng_parvane_canvas_from_graph(tr::now),
				PushButton::Kind::Accent,
				QString());
			graph->setClickedCallback([=] { graphCanvas(); });
			graph->show();
			buttons.push_back(graph);
		}
		const auto fresh = Ui::CreateChild<PushButton>(
			_start,
			tr::lng_parvane_canvas_new(tr::now),
			hasNotes ? PushButton::Kind::Normal : PushButton::Kind::Accent,
			u"plus"_q);
		fresh->setClickedCallback([=] { newCanvas(); });
		fresh->show();
		buttons.push_back(fresh);
		// `.boardStart`: столбец по центру, промежуток 0.75rem, ширина до 40ch
		const auto width = std::min(Font(kBodyPx)->width(u"0"_q) * 40, std::max(this->width() - Rem(2), Rem(10)));
		text->resizeToWidth(width);
		auto y = text->height() + Rem(0.75);
		for (const auto button : buttons) {
			button->move((width - button->width()) / 2, y);
			y += button->height() + Rem(0.75);
		}
		_start->resize(width, y - Rem(0.75));
	}
	relayoutTools();
}

void Board::relayoutTools() {
	const auto current = entry();
	const auto margin = Rem(0.625);
	const auto gap = Rem(0.375);
	// Чипы холстов — строка с прокруткой колесом, если не помещаются
	auto chipsWidth = 0;
	for (const auto chip : _chips) {
		chipsWidth += chip->width() + gap;
	}
	chipsWidth = std::max(chipsWidth - gap, 0);
	const auto available = std::max(width() - margin * 2, 1);
	const auto rowWidth = std::min(chipsWidth, available);
	_chipScroll = std::clamp(_chipScroll, 0, std::max(chipsWidth - rowWidth, 0));
	auto x = -_chipScroll;
	for (const auto chip : _chips) {
		chip->move(x, 0);
		x += chip->width() + gap;
	}
	_chipRow->setGeometry(margin, margin, rowWidth, Rem(1.875));
	// Строка инструментов — рядом с чипами, а если не помещается — ниже
	const auto toolWidth = _toolRow->width();
	const auto sameLine = (rowWidth + gap + toolWidth <= available);
	const auto toolTop = sameLine
		? margin + (Rem(1.875) - _toolRow->height()) / 2
		: margin + Rem(1.875) + gap;
	_toolRow->move(sameLine ? margin + rowWidth + gap : margin, std::max(toolTop, Px(2)));
	_chipRow->setVisible(true);
	_toolRow->setVisible(current != nullptr);
	_zoom->setVisible(current != nullptr);
	_zoom->move(width() - margin - _zoom->width(), height() - margin - _zoom->height());
	_start->setVisible(current == nullptr);
	_chipRow->setVisible(current != nullptr);
	if (!current) {
		_start->move((width() - _start->width()) / 2, (height() - _start->height()) / 2);
	}
	_chipRow->raise();
	_toolRow->raise();
	_zoom->raise();
	if (_bar) {
		_bar->raise();
	}
}

void Board::refreshTools() {
	const auto selected = selectedNode();
	if (_toolConnect) {
		_toolConnect->setEnabled(selected && selected->type != "group");
		_toolConnect->setOn(_linkFrom.has_value());
	}
	if (_toolSelect) {
		_toolSelect->setOn(_selectMode);
	}
	if (_toolGroup) {
		_toolGroup->setLabel(_selection.nodes.empty()
			? tr::lng_parvane_canvas_group(tr::now)
			: tr::lng_parvane_canvas_wrap(tr::now));
	}
	syncHistory();
}

// Панель у выделенного: над ним, а если сверху нет места — под ним; на узком экране прижата к низу поля
void Board::refreshBar() {
	if (!_bar) {
		return;
	}
	const auto shownBar = entry() && !notes::isSelectionEmpty(_selection) && !_live && !_inline && !_linkFrom
		&& !_marquee && !_draft && !_menu;
	if (!shownBar) {
		_bar->hide();
		return;
	}
	const auto selected = selectedNode();
	const auto edge = selectedEdge();
	const auto noteTitle = (selected && selected->type == "file") ? noteTitleOf(*selected) : std::nullopt;
	const auto noteState = noteTitle ? std::optional(noteStateOf(noteOf(*noteTitle))) : std::nullopt;
	const auto isPlainFile = selected && selected->type == "file" && !noteState;
	auto hasGroup = false;
	for (const auto &id : _selection.nodes) {
		if (const auto node = notes::findNode(*_doc, id); node && node->type == "group") {
			hasGroup = true;
		}
	}
	_bar->setDescriptor({
		.color = notes::colorOfSelection(*_doc, _selection),
		.canEdit = edge || (selected && noteState != notes::NoteCardState::Loading),
		.editIcon = (noteState == notes::NoteCardState::Missing) ? u"plus"_q : isPlainFile ? u"open"_q : u"edit"_q,
		.editLabel = edge ? tr::lng_parvane_canvas_edge_label(tr::now)
			: (noteState == notes::NoteCardState::Found) ? tr::lng_parvane_canvas_edit_note(tr::now)
			: (noteState == notes::NoteCardState::Missing) ? tr::lng_parvane_canvas_create_note(tr::now)
			: isPlainFile ? tr::lng_parvane_canvas_open_file(tr::now)
			: tr::lng_parvane_canvas_edit(tr::now),
		.canOpen = (noteState == notes::NoteCardState::Found),
		.canDuplicate = !_selection.nodes.empty(),
		.canWrap = !_selection.nodes.empty(),
		.canFit = hasGroup,
		.canTurn = !_selection.edges.empty() && _selection.nodes.empty(),
	});
	auto place = std::optional<QPoint>();
	if (!isNarrow()) {
		const auto &doc = shown();
		auto bounds = notes::selectionBounds(doc, _selection.nodes);
		if (!bounds && !_selection.edges.empty()) {
			if (const auto first = notes::findEdge(doc, _selection.edges.front())) {
				if (const auto curve = notes::edgeCurve(doc, *first)) {
					const auto middle = notes::curvePoint(*curve, 0.5);
					bounds = CanvasRect{ middle.x, middle.y, 0., 0. };
				}
			}
		}
		if (!bounds) {
			_bar->hide();
			return;
		}
		const auto top = (bounds->y - (hasGroup ? kGroupLabelRoom : 0.)) * _view.scale + _view.y;
		const auto bottom = (bounds->y + bounds->height) * _view.scale + _view.y;
		const auto y = (top - kBarGap >= kFitTop + kBarHeight) ? (top - kBarGap) : (bottom + kBarGap + kBarHeight);
		const auto x = (bounds->x + bounds->width / 2.) * _view.scale + _view.x;
		place = QPoint(int(std::round(x * k())), int(std::round(y * k())));
	}
	_bar->setPlace(place);
	_bar->show();
	_bar->raise();
}

[[nodiscard]] QString NormalizeSearch(const QString &value) {
	return value.trimmed().toLower().replace(QChar(0x0451), QChar(0x0435)); // ё → е, как web
}

void Board::setSearchQuery(const QString &query) {
	_searchQuery = NormalizeSearch(query);
	_foundAt = -1;
	refreshFound();
	_foundTimer.cancel();
	if (_found) {
		_foundTimer.callOnce(kFoundDelayMs);
	}
	update();
}

// Текст карточки, подпись группы, адрес ссылки, путь файла, название и текст заметки (web `found`)
void Board::refreshFound() {
	if (_searchQuery.isEmpty() || !entry() || !_doc) {
		_found = std::nullopt;
		return;
	}
	auto found = std::set<std::string>();
	for (const auto &node : _doc->nodes) {
		auto texts = QStringList();
		for (const auto key : { "text", "label", "url", "file" }) {
			if (const auto value = node.str(key)) {
				texts.push_back(Q(*value));
			}
		}
		if (const auto title = notes::noteTitleOfPath(node.str("file"))) {
			if (const auto i = _noteByTitle.find(Lower(*title)); i != _noteByTitle.end() && i->second) {
				texts.push_back(Q(i->second->text));
			}
		}
		for (const auto &text : texts) {
			if (NormalizeSearch(text).contains(_searchQuery)) {
				found.insert(node.id);
				break;
			}
		}
	}
	_found = std::move(found);
}

void Board::searchNext() {
	if (!_found || !entry() || !_doc) {
		return;
	}
	auto hits = std::vector<const CanvasNode*>();
	for (const auto &node : _doc->nodes) {
		if (_found->contains(node.id)) {
			hits.push_back(&node);
		}
	}
	if (hits.empty()) {
		return;
	}
	_foundAt = (_foundAt + 1) % int(hits.size());
	const auto &hit = *hits[_foundAt];
	const auto size = viewport();
	const auto scale = notes::clampBoardScale(std::max(_view.scale, kFoundMinScale));
	applyView({
		scale,
		size.width() / 2. - (hit.x + hit.width / 2.) * scale,
		size.height() / 2. - (hit.y + shownHeight(hit) / 2.) * scale,
	});
}

void Board::resizeEvent(QResizeEvent *e) {
	if (!_viewFitted && entry() && width() > 0 && height() > 0) {
		_view = fitTo(*_doc);
		_viewFitted = true;
	}
	if (!entry()) {
		rebuildChips();
	}
	relayoutTools();
	updateFieldGeometry();
	refreshBar();
}

} // namespace

void SetCanvasSearch(not_null<Ui::RpWidget*> view, const QString &query) {
	if (const auto board = dynamic_cast<Board*>(view.get())) {
		board->setSearchQuery(query);
	}
}

void CanvasSearchNext(not_null<Ui::RpWidget*> view) {
	if (const auto board = dynamic_cast<Board*>(view.get())) {
		board->searchNext();
	}
}

object_ptr<Ui::RpWidget> CreateCanvasView(
		not_null<QWidget*> parent,
		not_null<Window::SessionController*> controller,
		const std::string &canvasId,
		Fn<void(std::string noteId)> openNote) {
	return object_ptr<Board>(parent, controller, canvasId, std::move(openNote));
}

} // namespace Parvane::NotesUi
