// Parvane fork: реализация parvane_knowledge.h — экран раздела «Знания». Размеры — web `Knowledge.module.scss`
// (`.root`, `.page`, `.side`, `.graphPanel`, `.layout`, `.list`, `.pane`, `.notice`, `.graphNotice`, `.pickNote`).
#include "parvane/parvane_knowledge.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_knowledge_common.h"
#include "parvane/parvane_knowledge_list.h"
#include "parvane/parvane_note_folders.h"
#include "parvane/parvane_note_links.h"
#include "parvane/parvane_note_view.h"
#include "parvane/parvane_notes_canvas.h"
#include "parvane/parvane_notes_graph.h"
#include "parvane/parvane_notes_graph_panel.h"
#include "parvane/parvane_sections_host.h"

#include <parvane/sections/notes_canvas.h>
#include <parvane/sections/notes_canvas_graph.h>
#include <parvane/sections/notes_folders.h>
#include <parvane/sections/notes_guide.h>
#include <parvane/sections/notes_link_edit.h>
#include <parvane/sections/notes_look.h>
#include <parvane/sections/notes_prefs.h>
#include <parvane/sections/notes_tasks.h>
#include <parvane/sections/notes_view.h>

#include "base/timer.h"
#include "base/unique_qptr.h"
#include "base/weak_qptr.h"
#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/scroll_area.h"
#include "window/window_session_controller.h"

#include <crl/crl_on_main.h>
#include <rpl/event_stream.h>

#include <QtGui/QtEvents>

namespace Parvane {
namespace {

namespace notes = parvane::sections::notes;
namespace md = parvane::sections::markdown;
using namespace Knowledge;
using Kit::Px;
using Kit::Rem;

// Узкий экран: виден либо список, либо заметка
constexpr auto kNarrowWidth = 760;
// Пределы ширины панелей, которые меняет пользователь (px web)
constexpr auto kListMin = 220;
constexpr auto kListMax = 560;
constexpr auto kLinksMin = 280;
constexpr auto kLinksMax = 640;
constexpr auto kPanelMin = 320;
constexpr auto kPanelMax = 900;
// Панель не занимает больше этой доли окна, какой бы предел ей ни задали
constexpr auto kMaxViewportShare = 0.6;
// Широкий экран: «Связи» открытой заметки — отдельный остров справа
constexpr auto kSideMinWidth = 1241;
constexpr auto kNoticeHideMs = crl::time(6000);
// Пауза между набором в поиске и самим поиском
constexpr auto kSearchDelayMs = crl::time(150);

const auto kViewKey = std::string("parvane:knowledge-tab");

enum class View {
	Notes,
	Graph,
	Canvas,
};

[[nodiscard]] View ReadView() {
	const auto saved = PrefGet(kViewKey).value_or(std::string());
	return (saved == "graph") ? View::Graph : (saved == "canvas") ? View::Canvas : View::Notes;
}

void WriteView(View view) {
	PrefSet(kViewKey, std::string((view == View::Graph) ? "graph" : (view == View::Canvas) ? "canvas" : "notes"));
}

// Заметка, которую раздел должен открыть (ссылка из «Плана», заметка дня)
rpl::variable<QString> &NoteRequest() {
	static auto result = rpl::variable<QString>();
	return result;
}

// Заметка по id (палитра Ctrl+K)
rpl::variable<QString> &NoteIdRequest() {
	static auto result = rpl::variable<QString>();
	return result;
}

[[nodiscard]] int ClampPanel(int width, int min, int max, int viewport) {
	const auto top = std::max(Px(min), std::min(Px(max), int(viewport * kMaxViewportShare)));
	return std::max(Px(min), std::min(top, width));
}

// Тело правой части (`.pane`): поля 1.5rem 1.75rem (на узком экране — без полей) вокруг одного виджета
class PaneBody final : public Ui::RpWidget {
public:
	using RpWidget::RpWidget;

	void setChild(Ui::RpWidget *child, bool padded) {
		_child = child;
		_padded = padded;
		if (_child) {
			_child->heightValue() | rpl::skip(1) | rpl::on_next([=] {
				resizeToWidth(width());
			}, _child->lifetime());
		}
		resizeToWidth(width());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		if (!_child) {
			return 0;
		}
		const auto padX = _padded ? Rem(1.75) : 0;
		const auto padY = _padded ? Rem(1.5) : 0;
		_child->resizeToWidth(std::max(newWidth - 2 * padX, 1));
		_child->moveToLeft(padX, padY, newWidth);
		return _child->height() + 2 * padY;
	}

private:
	Ui::RpWidget *_child = nullptr;
	bool _padded = true;

};

// Сообщение о правке связи (`.graphNotice`): поверх поля графа внизу, «Отменить» акцентом
class GraphNoticeBar final : public Ui::RpWidget {
public:
	GraphNoticeBar(QWidget *parent, const QString &text, Fn<void()> undo)
	: RpWidget(parent)
	, _text(text) {
		Kit::RepaintOnTones(this);
		if (undo) {
			_undo = Ui::CreateChild<NotesTextButton>(
				this,
				tr::lng_parvane_notes_graph_undo(tr::now),
				u"undo"_q,
				NotesTextButton::Kind::Plain);
			_undo->setFontPx(14, true);
			_undo->setTextTone(Tone::Accent);
			_undo->setClickedCallback(std::move(undo));
		}
	}

	void fitTo(int maxWidth) {
		const auto font = Kit::Font(14);
		const auto padX = Rem(0.875);
		const auto gap = Rem(0.875);
		const auto undo = _undo ? (_undo->width() + gap) : 0;
		_textWidth = std::min(font->width(_text), std::max(maxWidth - 2 * padX - undo, 0));
		const auto h = std::max(font->height, _undo ? _undo->height() : 0) + 2 * Rem(0.5);
		resize(2 * padX + _textWidth + undo, h);
		if (_undo) {
			_undo->moveToLeft(padX + _textWidth + gap, (h - _undo->height()) / 2);
		}
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(QPen(ToneColor(Tone::Line2), Px(1)));
		p.setBrush(ToneColor(Tone::Panel));
		p.drawRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), Rem(0.875), Rem(0.875));
		const auto font = Kit::Font(14);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Fg));
		p.drawText(Rem(0.875), (height() - font->height) / 2 + font->ascent, font->elided(_text, _textWidth));
	}

private:
	QString _text;
	int _textWidth = 0;
	NotesTextButton *_undo = nullptr;

};

// Сообщение хранилища (`.notice`): строка на `--pv-raised` с линией снизу
class NoticeBar final : public Ui::RpWidget {
public:
	NoticeBar(QWidget *parent) : RpWidget(parent) {
		Kit::RepaintOnTones(this);
		_label = Ui::CreateChild<Kit::Label>(this, QString(), Kit::Label::Style{ .px = 14, .multiline = true });
	}

	void setText(const QString &text) {
		_label->setText(text);
		resizeToWidth(width());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto padX = Rem(1.125);
		_label->resizeToWidth(std::max(newWidth - 2 * padX, 1));
		_label->moveToLeft(padX, Rem(0.5), newWidth);
		return _label->height() + 2 * Rem(0.5) + Px(1);
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		p.fillRect(rect(), ToneColor(Tone::Raised));
		p.fillRect(0, height() - Px(1), width(), Px(1), ToneColor(Tone::Line));
	}

private:
	Kit::Label *_label = nullptr;

};

// Подложка содержимого: линия справа от списка (`.list` border-inline-end)
class ContentArea final : public Ui::RpWidget {
public:
	using RpWidget::RpWidget;

	void setDivider(std::optional<int> x) {
		_divider = x;
		update();
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		if (_divider) {
			auto p = QPainter(this);
			p.fillRect(*_divider, 0, Px(1), height(), ToneColor(Tone::Line));
		}
	}

private:
	std::optional<int> _divider;

};

class KnowledgeScreen final : public Ui::RpWidget {
public:
	KnowledgeScreen(QWidget *parent, not_null<Window::SessionController*> controller);

protected:
	void resizeEvent(QResizeEvent *e) override;
	void paintEvent(QPaintEvent *e) override;

private:
	struct GraphNotice {
		QString text;
		Fn<void()> undo;
	};
	struct EditRequest {
		std::string noteId;
		size_t from = 0;
		size_t to = 0;
	};

	void applyNotes(std::shared_ptr<const Sections::NotesView> view);
	void applyPlanner(std::shared_ptr<const Sections::PlannerView> view);
	void refresh();
	void refreshHeader();
	void refreshNotice();
	void refreshList();
	void refreshPane();
	void refreshSide();
	void refreshGraph();
	void refreshCanvas();
	void refreshPanel();
	void relayout();

	void setView(View view);
	void setOpenId(std::optional<std::string> id);
	void setQuery(const QString &value);
	void searchNext();
	void markGuide();
	void expandGroup(const std::string &key);
	void createIn(std::optional<std::string> folderId);
	void handleNew();
	void handleGuide();
	void openTitle(const QString &title);
	void showFolderSheet(std::optional<std::string> folderId);
	void deleteFolder(const notes::NoteFolder &folder);
	void askMove(const std::string &noteId);
	void showGraphNotice(const QString &text, Fn<void()> undo = nullptr);
	[[nodiscard]] Fn<void()> revertNote(const std::string &noteId, const std::string &before);

	void pickNoteInGraph(const std::string &noteId);
	void linkInGraph(const std::string &fromId, const std::string &toTitle, Fn<void(GraphLinkOutcome)> done);
	void linkNewInGraph(const std::string &fromId, const std::string &title, Fn<void(std::optional<std::string>)> done);
	void unlinkInGraph(const std::string &fromId, const std::string &toTitle);
	void makeGraphCanvas(notes::GraphCanvasScope scope);
	void closePanel();

	[[nodiscard]] bool isNarrow() const;
	[[nodiscard]] bool hasSide() const;
	[[nodiscard]] notes::NoteRef openNote() const;
	[[nodiscard]] notes::NoteRef noteById(const std::string &id) const;
	[[nodiscard]] notes::NoteRef pickNote() const;
	[[nodiscard]] std::optional<notes::PlannedItem> pickRecord() const;
	[[nodiscard]] bool isPanelShown() const;
	[[nodiscard]] std::vector<notes::PlannedItem> plannedFor(const notes::NoteEntry &note) const;
	[[nodiscard]] NoteData noteData(const notes::NoteRef &note) const;
	[[nodiscard]] std::optional<std::string> guideOverviewId() const;
	[[nodiscard]] std::optional<std::string> guideOverviewFolder() const;
	[[nodiscard]] QString viewQuery() const;

	const not_null<Window::SessionController*> _controller;

	// Данные
	std::shared_ptr<const Sections::NotesView> _notes;
	std::shared_ptr<const notes::NotesIndex> _index;
	planner::State _planner;
	notes::PlannedIndex _plannedIndex;
	std::string _plannerSignature;
	std::string _today;

	// Состояние раздела
	View _view = View::Notes;
	std::optional<std::string> _openId;
	QString _query;
	QString _searchQuery;
	QString _graphQuery;
	QString _canvasQuery;
	base::Timer _searchTimer;
	bool _areAllDailyShown = false;
	std::vector<std::string> _collapsed;
	bool _hasSeenGuide = false;
	bool _hasPickedNote = false;
	std::optional<GraphPick> _graphPick;
	View _pickView = View::Graph;
	std::optional<std::string> _linkFromId;
	std::optional<EditRequest> _editRequest;
	std::optional<GraphNotice> _graphNotice;
	base::Timer _graphNoticeTimer;
	int64_t _noticeAt = 0;
	bool _noticeShown = false;
	base::Timer _noticeTimer;
	std::optional<std::string> _graphCanvasId;
	bool _makingCanvas = false;
	bool _guideConsuming = false;

	// Виджеты
	Kit::Island *_page = nullptr;
	base::unique_qptr<Kit::Header> _header;
	std::string _headerKey;
	Kit::Field *_search = nullptr;
	NoticeBar *_noticeBar = nullptr;
	ContentArea *_content = nullptr;
	Ui::ScrollArea *_listScroll = nullptr;
	KnowledgeList *_list = nullptr;
	std::string _listKey;
	Kit::Resizer *_listResizer = nullptr;
	Ui::ScrollArea *_paneScroll = nullptr;
	PaneBody *_pane = nullptr;
	NoteView *_noteView = nullptr;
	int _noteViewMode = -1;
	base::unique_qptr<RichText> _pickText;
	NotesGraph *_graph = nullptr;
	base::unique_qptr<Ui::RpWidget> _canvas;
	std::optional<std::string> _canvasShownId;
	base::unique_qptr<GraphNoticeBar> _graphNoticeBar;
	Kit::Island *_side = nullptr;
	Kit::Header *_sideHeader = nullptr;
	Ui::ScrollArea *_sideScroll = nullptr;
	PaneBody *_sideBody = nullptr;
	base::unique_qptr<NoteLinks> _sideLinks;
	std::string _sideKey;
	Kit::Resizer *_sideResizer = nullptr;
	GraphPanel *_panel = nullptr;
	Kit::Resizer *_panelResizer = nullptr;

	// Ширины панелей (px интерфейса); при перетаскивании — от ширины в начале
	int _listWidth = 0;
	int _sideWidth = 0;
	std::optional<int> _panelWidth;
	std::optional<int> _dragStart;

};

KnowledgeScreen::KnowledgeScreen(QWidget *parent, not_null<Window::SessionController*> controller)
: RpWidget(parent)
, _controller(controller)
, _today(TodayKey())
, _view(ReadView())
, _searchTimer([=] {
	_searchQuery = _query;
	refreshList();
})
, _graphNoticeTimer([=] {
	_graphNotice = std::nullopt;
	_graphNoticeBar = nullptr;
})
, _noticeTimer([=] {
	_noticeShown = false;
	refreshNotice();
	relayout();
}) {
	setObjectName(u"ParvaneKnowledge"_q);
	Kit::RepaintOnTones(this);
	_collapsed = notes::parseCollapsedFolders(PrefGet(notes::kKnowledgeCollapsedKey));
	_hasSeenGuide = notes::isGuideSeenValue(PrefGet(notes::guideSeenKey(S(SelfAddress()))));
	_listWidth = PanelWidth("notes-list").value_or(Rem(20));
	_sideWidth = PanelWidth("notes-links").value_or(Rem(23.75));
	_panelWidth = PanelWidth("graph-note");

	_page = Ui::CreateChild<Kit::Island>(this);
	_noticeBar = Ui::CreateChild<NoticeBar>(_page);
	_noticeBar->hide();
	_content = Ui::CreateChild<ContentArea>(_page);

	// Список и заметка
	_listScroll = Ui::CreateChild<Ui::ScrollArea>(_content);
	_list = _listScroll->setOwnedWidget(object_ptr<KnowledgeList>(_listScroll, KnowledgeListCallbacks{
		.pick = [=](std::string id) {
			_hasPickedNote = true;
			setOpenId(id);
		},
		.toggleGroup = [=](std::string key) {
			if (ranges::contains(_collapsed, key)) {
				_collapsed.erase(ranges::remove(_collapsed, key), end(_collapsed));
			} else {
				_collapsed.push_back(key);
			}
			PrefSet(notes::kKnowledgeCollapsedKey, notes::serializeCollapsedFolders(_collapsed));
			refreshList();
		},
		.newInFolder = [=](std::optional<std::string> folderId, std::string key) {
			expandGroup(key);
			createIn(folderId);
		},
		.folderMenu = [=](std::string folderId) {
			showFolderSheet(folderId);
		},
		.showAllDaily = [=] {
			_areAllDailyShown = true;
			refreshList();
		},
		.newNote = [=] { handleNew(); },
		.newFolder = [=] { showFolderSheet(std::nullopt); },
		.guide = [=] { handleGuide(); },
		.guideDismiss = [=] { markGuide(); },
		.move = [=](std::string noteId, std::optional<std::string> folderId) {
			MoveNote(noteId, folderId);
		},
	})).data();
	_listScroll->widthValue() | rpl::on_next([=](int width) {
		_list->resizeToWidth(width);
	}, lifetime());
	_listResizer = Ui::CreateChild<Kit::Resizer>(_content, tr::lng_parvane_notes_resize_panel(tr::now));
	_listResizer->moves() | rpl::on_next([=](int delta) {
		if (!_dragStart) {
			_dragStart = _listWidth;
		}
		_listWidth = ClampPanel(*_dragStart + delta, kListMin, kListMax, window()->width());
		relayout();
	}, lifetime());
	_listResizer->finished() | rpl::on_next([=] {
		_dragStart = std::nullopt;
		SetPanelWidth("notes-list", _listWidth);
	}, lifetime());
	_paneScroll = Ui::CreateChild<Ui::ScrollArea>(_content);
	_pane = _paneScroll->setOwnedWidget(object_ptr<PaneBody>(_paneScroll)).data();
	_paneScroll->widthValue() | rpl::on_next([=](int width) {
		_pane->resizeToWidth(width);
	}, lifetime());

	// «Связи» на широком экране
	_side = Ui::CreateChild<Kit::Island>(this);
	_sideHeader = Ui::CreateChild<Kit::Header>(_side, tr::lng_parvane_notes_links(tr::now), Kit::Header::TitleSize::Small);
	_sideScroll = Ui::CreateChild<Ui::ScrollArea>(_side);
	_sideBody = _sideScroll->setOwnedWidget(object_ptr<PaneBody>(_sideScroll)).data();
	_sideScroll->widthValue() | rpl::on_next([=](int width) {
		_sideBody->resizeToWidth(width);
	}, lifetime());
	_side->hide();
	_sideResizer = Ui::CreateChild<Kit::Resizer>(this, tr::lng_parvane_notes_resize_panel(tr::now));
	_sideResizer->moves() | rpl::on_next([=](int delta) {
		if (!_dragStart) {
			_dragStart = _sideWidth;
		}
		_sideWidth = ClampPanel(*_dragStart - delta, kLinksMin, kLinksMax, window()->width());
		relayout();
	}, lifetime());
	_sideResizer->finished() | rpl::on_next([=] {
		_dragStart = std::nullopt;
		SetPanelWidth("notes-links", _sideWidth);
	}, lifetime());
	_sideResizer->hide();

	// Панель графа и холста
	_panel = Ui::CreateChild<GraphPanel>(this, GraphPanelCallbacks{
		.close = [=] { closePanel(); },
		.openInNotes = [=](std::string noteId) {
			// С холста заметку увели на вкладку «Заметки» — панель рядом с холстом больше не нужна
			if (_view == View::Canvas) {
				_graphPick = std::nullopt;
			}
			setOpenId(noteId);
			setView(View::Notes);
		},
		.linkStart = [=](std::string noteId) {
			_linkFromId = noteId;
			refresh();
		},
		.create = [=](std::string title) {
			EnsureNote(title, [=](std::optional<std::string> id) {
				if (id) {
					pickNoteInGraph(*id);
				}
			});
		},
		.openInPlan = [=](notes::PlannedItem) {
			ShowSection(Section::Calendar);
		},
		.openTitle = [=](QString title) {
			EnsureNote(S(title), [=](std::optional<std::string> id) {
				if (id) {
					pickNoteInGraph(*id);
				}
			});
		},
		.deleted = [=](std::string noteId) {
			_graphPick = std::nullopt;
			if (_openId == noteId) {
				_openId = std::nullopt;
			}
			refresh();
		},
		.pickFolder = [=](std::string noteId) { askMove(noteId); },
	});
	_panel->hide();
	_panelResizer = Ui::CreateChild<Kit::Resizer>(this, tr::lng_parvane_notes_resize_panel(tr::now));
	_panelResizer->moves() | rpl::on_next([=](int delta) {
		if (!_dragStart) {
			_dragStart = _panel->width();
		}
		_panelWidth = ClampPanel(*_dragStart - delta, kPanelMin, kPanelMax, window()->width());
		relayout();
	}, lifetime());
	_panelResizer->finished() | rpl::on_next([=] {
		_dragStart = std::nullopt;
		SetPanelWidth("graph-note", _panelWidth);
	}, lifetime());
	_panelResizer->hide();

	Sections::NotesValue() | rpl::on_next([=](std::shared_ptr<const Sections::NotesView> view) {
		applyNotes(std::move(view));
	}, lifetime());
	Sections::PlannerValue() | rpl::on_next([=](std::shared_ptr<const Sections::PlannerView> view) {
		applyPlanner(std::move(view));
	}, lifetime());
	rpl::merge(NoteRequest().value(), NoteIdRequest().value()) | rpl::filter([](const QString &value) {
		return !value.isEmpty();
	}) | rpl::on_next([=] {
		refresh();
	}, lifetime());
	TonesChanges() | rpl::on_next([=] { update(); }, lifetime());
}

// ── данные ───────────────────────────────────────────────────────────────────

void KnowledgeScreen::applyNotes(std::shared_ptr<const Sections::NotesView> view) {
	const auto changed = !_notes || (_notes->notes != view->notes);
	_notes = std::move(view);
	if (changed || !_index) {
		auto sources = std::vector<notes::NoteSource>();
		sources.reserve(_notes->notes.size());
		for (const auto &note : _notes->notes) {
			sources.push_back(*note);
		}
		_index = std::make_shared<const notes::NotesIndex>(sources);
	}
	// «Обзор» справки нового хранилища открывается сам (на узком экране остаётся список с сообщением о ней)
	if (const auto guideId = _notes->guideOpenId; guideId && noteById(*guideId) && !_guideConsuming) {
		_guideConsuming = true;
		Sections::Post([](Sections::Workers &w) {
			w.notes.consumeGuideOpen();
		});
		if (!_openId && !isNarrow() && !_hasPickedNote) {
			_openId = *guideId;
			markGuide();
		}
	} else if (!_notes->guideOpenId) {
		_guideConsuming = false;
	}
	// Сообщение хранилища показывается 6 секунд
	if (_notes->notice && _notes->notice->at != _noticeAt) {
		_noticeAt = _notes->notice->at;
		_noticeShown = true;
		_noticeTimer.callOnce(kNoticeHideMs);
	}
	// Галочки и удаления из «Плана» доезжают до пунктов заметок
	if (_notes->status == notes::NotesStatus::Ready && !_plannerSignature.empty()) {
		static auto applied = std::string();
		if (applied != _plannerSignature) {
			applied = _plannerSignature;
			const auto vault = VaultName();
			Sections::Post([=](Sections::Workers &w) {
				w.notes.applyPlannerToNotes(vault);
			});
		}
	}
	refresh();
}

void KnowledgeScreen::applyPlanner(std::shared_ptr<const Sections::PlannerView> view) {
	_planner = view->state;
	_today = TodayKey();
	_plannedIndex = notes::buildPlannedIndex(_planner, _today);
	const auto signature = notes::noteTasksStatusSignature(_planner) + '\x1f' + std::to_string(view->revision);
	if (signature != _plannerSignature) {
		_plannerSignature = signature;
		if (_notes && _notes->status == notes::NotesStatus::Ready) {
			const auto vault = VaultName();
			Sections::Post([=](Sections::Workers &w) {
				w.notes.applyPlannerToNotes(vault);
			});
		}
	}
	if (_graph) {
		_graph->setPlanner(_planner);
	}
	refresh();
}

notes::NoteRef KnowledgeScreen::noteById(const std::string &id) const {
	if (!_notes) {
		return nullptr;
	}
	for (const auto &note : _notes->notes) {
		if (note->id == id) {
			return note;
		}
	}
	return nullptr;
}

notes::NoteRef KnowledgeScreen::openNote() const {
	return _openId ? noteById(*_openId) : nullptr;
}

std::vector<notes::PlannedItem> KnowledgeScreen::plannedFor(const notes::NoteEntry &note) const {
	return notes::plannedOf(_plannedIndex, note.id, note.title);
}

NoteData KnowledgeScreen::noteData(const notes::NoteRef &note) const {
	return NoteData{
		.note = note,
		.index = _index,
		.planned = note ? plannedFor(*note) : std::vector<notes::PlannedItem>(),
		.cloud = _notes ? _notes->cloud : nullptr,
		.planner = _planner,
	};
}

std::optional<std::string> KnowledgeScreen::guideOverviewId() const {
	if (!_notes) {
		return std::nullopt;
	}
	auto refs = std::vector<notes::GuideNoteRef>();
	for (const auto &note : _notes->notes) {
		refs.push_back({ note->id, note->title });
	}
	const auto index = notes::findGuideOverview(refs);
	return index ? std::make_optional(refs[*index].id) : std::nullopt;
}

std::optional<std::string> KnowledgeScreen::guideOverviewFolder() const {
	const auto id = guideOverviewId();
	const auto note = id ? noteById(*id) : nullptr;
	return note ? std::make_optional(note->folder) : std::nullopt;
}

notes::NoteRef KnowledgeScreen::pickNote() const {
	// Заметка выбранной точки; «заметка, которой ещё нет», могла тем временем появиться
	if (!_graphPick || _graphPick->kind == notes::GraphNodeKind::Record) {
		return nullptr;
	}
	if (_graphPick->kind == notes::GraphNodeKind::Missing) {
		const auto found = _index ? _index->byTitle(_graphPick->title) : nullptr;
		return found ? noteById(found->id) : nullptr;
	}
	return noteById(_graphPick->id);
}

std::optional<notes::PlannedItem> KnowledgeScreen::pickRecord() const {
	if (!_graphPick || _graphPick->kind != notes::GraphNodeKind::Record) {
		return std::nullopt;
	}
	for (const auto &map : { &_plannedIndex.byTitle, &_plannedIndex.byNote }) {
		for (const auto &[key, items] : *map) {
			for (const auto &item : items) {
				if (item.key == _graphPick->id) {
					return item;
				}
			}
		}
	}
	return std::nullopt;
}

bool KnowledgeScreen::isPanelShown() const {
	// Панель заметки стоит рядом с графом и рядом с холстом (там её открывает кнопка карточки)
	const auto isPanelView = (_view == View::Graph) || (_view == View::Canvas);
	return isPanelView
		&& (_pickView == _view)
		&& _notes
		&& _notes->status == notes::NotesStatus::Ready
		&& _graphPick
		&& (_graphPick->kind == notes::GraphNodeKind::Missing || pickNote() || pickRecord());
}

bool KnowledgeScreen::isNarrow() const {
	return window()->width() <= Px(kNarrowWidth);
}

bool KnowledgeScreen::hasSide() const {
	return window()->width() >= Px(kSideMinWidth);
}

QString KnowledgeScreen::viewQuery() const {
	return (_view == View::Graph) ? _graphQuery : (_view == View::Canvas) ? _canvasQuery : _query;
}

// ── обновление ───────────────────────────────────────────────────────────────

void KnowledgeScreen::refresh() {
	if (!_notes) {
		return;
	}
	// Заметка, которую раздел должен открыть
	if (const auto title = NoteRequest().current(); !title.isEmpty() && _notes->status == notes::NotesStatus::Ready) {
		NoteRequest() = QString();
		setView(View::Notes);
		openTitle(title);
	}
	if (const auto id = NoteIdRequest().current(); !id.isEmpty() && _notes->status == notes::NotesStatus::Ready) {
		NoteIdRequest() = QString();
		_view = View::Notes;
		WriteView(_view);
		if (noteById(S(id))) {
			_hasPickedNote = true;
			_openId = S(id);
		}
	}
	// Режим «Связать» и просьба о правке живут только на графе
	if (_view != View::Graph) {
		_linkFromId = std::nullopt;
		_editRequest = std::nullopt;
	}
	refreshHeader();
	refreshNotice();
	refreshList();
	refreshPane();
	refreshSide();
	refreshGraph();
	refreshCanvas();
	refreshPanel();
	relayout();
}

void KnowledgeScreen::refreshHeader() {
	const auto note = openNote();
	const auto isNoteShown = (_view == View::Notes) && note;
	const auto isNoteAlone = isNarrow() && isNoteShown;
	const auto crumb = isNoteShown
		? (note->isDaily ? tr::lng_parvane_notes_daily_folder(tr::now) : FolderCaption(note->folder))
		: QString();
	const auto key = std::to_string(int(_view)) + (isNarrow() ? "n" : "w") + (isNoteAlone ? "a" : "-")
		+ S(crumb);
	if (key == _headerKey && (_header || isNoteAlone)) {
		return;
	}
	_headerKey = key;
	const auto hadFocus = _search && _search->input()->hasFocus();
	_search = nullptr;
	_header = nullptr;
	if (isNoteAlone) {
		return;
	}
	const auto narrow = isNarrow();
	const auto header = Ui::CreateChild<Kit::Header>(_page, narrow ? QString() : SectionTitle(Section::Knowledge));
	const auto tabs = header->add(object_ptr<Kit::Segments>(header, std::vector<QString>{
		tr::lng_parvane_notes_tab_notes(tr::now),
		tr::lng_parvane_notes_tab_graph(tr::now),
		tr::lng_parvane_notes_tab_canvas(tr::now),
		tr::lng_parvane_notes_tab_files(tr::now),
	}, int(_view)));
	tabs->activated() | rpl::on_next([=](int index) {
		crl::on_main(this, [=] {
			if (index == 3) {
				// «Файлы» — раздел облака на рейке; вкладка этого раздела остаётся прежней
				tabs->setActive(int(_view));
				ShowSection(Section::Files);
			} else {
				setView(View(index));
			}
		});
	}, tabs->lifetime());
	// Поиск по текущей вкладке: заметки — список, граф — точки, холст — карточки (web `PvHeaderSearch`)
	{
		const auto label = (_view == View::Graph)
			? tr::lng_parvane_notes_graph_search()
			: (_view == View::Canvas)
			? tr::lng_parvane_notes_canvas_search()
			: tr::lng_parvane_notes_search();
		// Поле не уже 12rem: подсказки справа сжимаются (до нуля) раньше, чем поле теряет ширину
		const auto search = header->addShrinkable(
			object_ptr<Kit::Field>(header, Kit::Field::Kind::HeaderSearch, std::move(label), viewQuery()),
			Rem(15),
			Rem(12));
		search->textChanges() | rpl::on_next([=](const QString &value) {
			setQuery(value);
		}, search->lifetime());
		search->submits() | rpl::on_next([=] {
			searchNext();
		}, search->lifetime());
		search->cancels() | rpl::on_next([=] {
			if (!search->text().isEmpty()) {
				search->setText(QString());
			}
		}, search->lifetime());
		_search = search;
	}
	if (isNoteShown && !narrow) {
		header->add(object_ptr<Kit::Label>(header, u"/ "_q + crumb, Kit::Label::Muted()));
	}
	header->addStretch();
	if (_view == View::Notes && !narrow) {
		const auto add = header->add(object_ptr<Kit::Pill>(
			header,
			tr::lng_parvane_notes_note_short(tr::now),
			u"plus"_q,
			true));
		add->setClickedCallback([=] { crl::on_main(this, [=] { handleNew(); }); });
	} else if ((_view == View::Canvas || _view == View::Graph) && !narrow) {
		// Подсказка холста/графа: одна строка, не помещается — обрезается (целиком — во всплывающей подписи);
		// поле поиска при этом держит свою минимальную ширину
		const auto text = (_view == View::Canvas)
			? tr::lng_parvane_notes_canvas_hint(tr::now)
			: tr::lng_parvane_notes_graph_hint(tr::now);
		const auto hint = header->addShrinkable(
			object_ptr<Kit::Label>(header, text, Kit::Label::Style{
				.px = 13,
				.tone = Tone::Muted,
				.align = style::al_right,
			}),
			Kit::Font(13)->width(text),
			0);
		hint->setToolTip(text);
		hint->setAttribute(Qt::WA_TransparentForMouseEvents, false);
	}
	header->show();
	_header.reset(header);
	if (hadFocus && _search) {
		_search->setFocusFast();
		_search->input()->setCursorPosition(_search->text().size());
	}
}

void KnowledgeScreen::refreshNotice() {
	const auto &notice = _notes->notice;
	if (!_noticeShown || !notice) {
		_noticeBar->hide();
		return;
	}
	const auto name = Q(notice->title);
	const auto text = (notice->code == "guide-failed")
		? tr::lng_parvane_notes_notice_guide_failed(tr::now)
		: (notice->code == "conflict")
		? tr::lng_parvane_notes_notice_conflict(tr::now, lt_name, name)
		: (notice->code == "merged")
		? tr::lng_parvane_notes_notice_merged(tr::now, lt_name, name)
		: (notice->code == "folder-files")
		? tr::lng_parvane_notes_notice_folder_files(tr::now, lt_name, name)
		: tr::lng_parvane_notes_notice_failed(tr::now, lt_name, name);
	_noticeBar->setText(text);
	_noticeBar->show();
}

void KnowledgeScreen::refreshList() {
	if (!_notes) {
		return;
	}
	auto data = KnowledgeListData();
	data.notes = _notes->notes;
	data.folders = _notes->folders;
	if (!_searchQuery.trimmed().isEmpty() && _index) {
		auto found = std::vector<std::string>();
		for (const auto note : _index->search(S(_searchQuery))) {
			found.push_back(note->id);
		}
		data.found = std::move(found);
	}
	data.collapsed = _collapsed;
	data.openId = _openId;
	data.areAllDailyShown = _areAllDailyShown;
	for (const auto &note : _notes->notes) {
		const auto planned = plannedFor(*note);
		if (const auto nearest = notes::nearestPlanned(planned, _today)) {
			if (const auto &day = planned[*nearest].day) {
				data.nearest.emplace(note->id, FormatDayShort(*day));
			}
		}
	}
	const auto overview = guideOverviewId();
	const auto overviewFolder = guideOverviewFolder();
	if (overview && !_hasSeenGuide && !data.found) {
		data.guideNotice = (overviewFolder && !overviewFolder->empty())
			? Q(notes::folderCaption(*overviewFolder))
			: Q(notes::buildGuide(IsRussian() ? "ru" : "en").folderName);
	}
	data.guideMissing = !overview;
	data.narrow = isNarrow();

	// Список перестраивается, только когда изменилось показанное
	auto key = std::string();
	for (const auto &note : data.notes) {
		key += std::to_string(reinterpret_cast<std::uintptr_t>(note.get())) + ',';
	}
	key += '|';
	for (const auto &folder : data.folders) {
		key += folder.id + folder.path + ',';
	}
	key += '|';
	if (data.found) {
		for (const auto &id : *data.found) {
			key += id + ',';
		}
	} else {
		key += '*';
	}
	key += '|';
	for (const auto &item : data.collapsed) {
		key += item + ',';
	}
	key += '|' + data.openId.value_or(std::string()) + (data.areAllDailyShown ? "A" : "a") + S(data.guideNotice)
		+ (data.guideMissing ? "M" : "m") + (data.narrow ? "N" : "n") + '|';
	for (const auto &[id, day] : data.nearest) {
		key += id + S(day) + ',';
	}
	if (key == _listKey) {
		return;
	}
	_listKey = key;
	_list->setData(std::move(data));
}

void KnowledgeScreen::refreshPane() {
	const auto note = (_view == View::Notes) ? openNote() : nullptr;
	if (note) {
		const auto narrow = isNarrow();
		const auto mode = (narrow ? 1 : 0) + (hasSide() ? 2 : 0);
		if (!_noteView || _noteView->noteId() != note->id || _noteViewMode != mode) {
			_noteViewMode = mode;
			delete _noteView;
			_pickText = nullptr;
			_noteView = Ui::CreateChild<NoteView>(_pane, NoteOptions{
				.hasLinks = !hasSide(),
				.narrow = narrow,
			}, NoteCallbacks{
				.openTitle = [=](QString title) { openTitle(title); },
				.back = narrow ? Fn<void()>([=] { setOpenId(std::nullopt); }) : Fn<void()>(),
				.deleted = [=](std::string id) {
					if (_openId == id) {
						setOpenId(std::nullopt);
					}
				},
				.pickFolder = [=](std::string id) { askMove(id); },
			});
			_noteView->show();
			_pane->setChild(_noteView, !narrow);
			_paneScroll->scrollToY(0);
		}
		_noteView->setData(noteData(note));
		return;
	}
	if (_noteView) {
		_pane->setChild(nullptr, true);
		delete _noteView;
		_noteView = nullptr;
	}
	if (!_pickText) {
		// `.pickNote`: подсказка с образцом [[ссылки]] (не нажимается), не шире 52ch
		const auto text = Ui::CreateChild<RichText>(_pane, RichText::Style{ .tone = Tone::Muted });
		auto parts = std::vector<md::MdInline>();
		const auto full = tr::lng_parvane_notes_pick_note(tr::now);
		auto rest = full;
		while (true) {
			const auto open = rest.indexOf(u"[["_q);
			const auto close = (open >= 0) ? rest.indexOf(u"]]"_q, open) : -1;
			if (open < 0 || close < 0) {
				parts.push_back({ .type = md::MdInlineType::Text, .text = S(rest) });
				break;
			}
			parts.push_back({ .type = md::MdInlineType::Text, .text = S(rest.mid(0, open)) });
			const auto sample = rest.mid(open, close + 2 - open);
			parts.push_back({ .type = md::MdInlineType::Note, .text = S(sample), .target = S(sample) });
			rest = rest.mid(close + 2);
		}
		text->setInlines(parts);
		text->show();
		_pickText.reset(text);
		_pane->setChild(text, true);
	}
}

void KnowledgeScreen::refreshSide() {
	const auto note = (_view == View::Notes) ? openNote() : nullptr;
	const auto shown = hasSide() && note;
	_side->setVisible(shown);
	_sideResizer->setVisible(shown);
	if (!shown) {
		_sideLinks = nullptr;
		_sideKey.clear();
		return;
	}
	const auto planned = plannedFor(*note);
	auto key = note->id + '|' + std::to_string(reinterpret_cast<std::uintptr_t>(_index.get())) + '|';
	for (const auto &item : planned) {
		key += item.key + item.name + ',';
	}
	if (key == _sideKey && _sideLinks) {
		return;
	}
	_sideKey = key;
	const auto links = Ui::CreateChild<NoteLinks>(_sideBody, NoteLinks::Args{
		.note = note,
		.index = _index,
		.planned = planned,
		.openTitle = [=](QString title) { crl::on_main(this, [=] { openTitle(title); }); },
	});
	links->show();
	_sideLinks.reset(links);
	_sideBody->setChild(links, false);
}

void KnowledgeScreen::refreshGraph() {
	const auto shown = (_view == View::Graph) && _notes->status == notes::NotesStatus::Ready;
	if (!shown) {
		if (_graph) {
			_graph->hide();
		}
		_graphNoticeBar = nullptr;
		return;
	}
	if (!_graph) {
		_graph = Ui::CreateChild<NotesGraph>(_content, NotesGraphCallbacks{
			.pick = [=](GraphPick pick) {
				_editRequest = std::nullopt;
				_pickView = _view;
				_graphPick = pick;
				refresh();
			},
			.open = [=](GraphPick pick) {
				if (pick.kind == notes::GraphNodeKind::Record) {
					return;
				}
				const auto open = [=](std::optional<std::string> id) {
					if (id) {
						setOpenId(*id);
						setView(View::Notes);
					}
				};
				if (pick.kind == notes::GraphNodeKind::Missing) {
					EnsureNote(pick.title, open);
				} else {
					open(pick.id);
				}
			},
			.link = [=](std::string fromId, std::string toTitle, Fn<void(GraphLinkOutcome)> done) {
				linkInGraph(fromId, toTitle, std::move(done));
			},
			.linkNew = [=](std::string fromId, std::string title, Fn<void(std::optional<std::string>)> done) {
				linkNewInGraph(fromId, title, std::move(done));
			},
			.unlink = [=](std::string fromId, std::string toTitle) {
				unlinkInGraph(fromId, toTitle);
			},
			.linkModeEnd = [=] {
				_linkFromId = std::nullopt;
				refresh();
			},
			.close = [=] { closePanel(); },
			.makeCanvas = [=](notes::GraphCanvasScope scope) {
				makeGraphCanvas(scope);
			},
		});
		_graph->setPlanner(_planner);
	}
	_graph->setNotes(_notes->notes);
	_graph->setQuery(_graphQuery);
	_graph->setLinkFrom(_linkFromId);
	if (isPanelShown()) {
		const auto note = pickNote();
		_graph->setPicked(note ? note->id : _graphPick->id);
	} else {
		_graph->setPicked(std::nullopt);
	}
	_graph->show();
	if (_graphNotice) {
		if (!_graphNoticeBar) {
			const auto bar = Ui::CreateChild<GraphNoticeBar>(_content, _graphNotice->text, _graphNotice->undo);
			bar->show();
			_graphNoticeBar.reset(bar);
		}
	} else {
		_graphNoticeBar = nullptr;
	}
}

void KnowledgeScreen::refreshCanvas() {
	const auto shown = (_view == View::Canvas) && _notes->status == notes::NotesStatus::Ready;
	if (!shown) {
		if (_canvas) {
			_canvas->hide();
		}
		return;
	}
	// Холст, созданный с графа, открывается сразу; иначе вид холста сам показывает выбор
	if (!_canvas || _canvasShownId != _graphCanvasId) {
		_canvasShownId = _graphCanvasId;
		auto view = NotesUi::CreateCanvasView(
			_content,
			_controller,
			_graphCanvasId.value_or(std::string()),
			[=](std::string noteId) {
				// Карточка-заметка открыта: заметка встаёт рядом с холстом
				crl::on_main(this, [=] { pickNoteInGraph(noteId); });
			});
		const auto raw = view.release();
		raw->setParent(_content);
		_canvas.reset(raw);
		if (!_canvasQuery.isEmpty()) {
			NotesUi::SetCanvasSearch(raw, _canvasQuery);
		}
	}
	_canvas->show();
}

void KnowledgeScreen::refreshPanel() {
	const auto shown = isPanelShown() && !isNarrow();
	const auto narrowShown = isPanelShown() && isNarrow() && !_linkFromId;
	if (!shown && !narrowShown) {
		_panel->hide();
		_panelResizer->hide();
		return;
	}
	auto state = GraphPanelState();
	state.pick = *_graphPick;
	if (const auto note = pickNote()) {
		state.note = noteData(note);
	} else {
		state.note.index = _index;
		state.note.cloud = _notes->cloud;
		state.note.planner = _planner;
	}
	state.record = pickRecord();
	_panel->setLinkStartEnabled(_view == View::Graph);
	_panel->setState(std::move(state));
	if (_editRequest) {
		const auto request = *_editRequest;
		_editRequest = std::nullopt;
		_panel->requestEdit(request.noteId, request.from, request.to);
	}
	_panel->show();
	_panel->raise();
	_panelResizer->setVisible(shown);
}

void KnowledgeScreen::relayout() {
	if (!_notes) {
		return;
	}
	const auto narrow = isNarrow();
	// `.root`: поля 0.5rem 0.5rem 0.5rem 0, промежуток 0.5rem
	const auto outer = narrow ? rect() : rect().marginsRemoved({ 0, Rem(0.5), Rem(0.5), Rem(0.5) });
	const auto gap = Rem(0.5);
	auto right = outer.x() + outer.width();
	const auto viewport = window()->width();
	const auto panelShown = !_panel->isHidden() && !narrow;
	if (panelShown) {
		const auto fallback = std::clamp(int(outer.width() * 0.38), Rem(22), Rem(30));
		const auto w = ClampPanel(_panelWidth.value_or(fallback), kPanelMin, kPanelMax, viewport);
		_panel->setGeometry(right - w, outer.y(), w, outer.height());
		_panelResizer->setGeometry(right - w, outer.y() + Rem(1.5), _panelResizer->width(), outer.height() - Rem(3));
		_panelResizer->raise();
		right -= w + gap;
	}
	if (!_side->isHidden()) {
		const auto w = ClampPanel(_sideWidth, kLinksMin, kLinksMax, viewport);
		_side->setGeometry(right - w, outer.y(), w, outer.height());
		_sideResizer->setGeometry(right - w, outer.y() + Rem(1.5), _sideResizer->width(), outer.height() - Rem(3));
		_sideResizer->raise();
		const auto inner = _side->innerRect();
		_sideHeader->resizeToWidth(inner.width());
		_sideHeader->moveToLeft(inner.x(), inner.y(), w);
		const auto top = inner.y() + _sideHeader->height();
		// `.sideContent`: поля 1.125rem
		const auto pad = Rem(1.125);
		_sideScroll->setGeometry(
			inner.x() + pad,
			top + pad,
			std::max(inner.width() - 2 * pad, 1),
			std::max(inner.y() + inner.height() - top - 2 * pad, 0));
		_sideBody->resizeToWidth(_sideScroll->width());
		right -= w + gap;
	}
	_page->setGeometry(outer.x(), outer.y(), std::max(right - outer.x(), 0), outer.height());
	const auto inner = _page->innerRect();
	auto y = inner.y();
	if (_header) {
		_header->resizeToWidth(inner.width());
		_header->moveToLeft(inner.x(), y, _page->width());
		y += _header->height();
	}
	if (!_noticeBar->isHidden()) {
		_noticeBar->resizeToWidth(inner.width());
		_noticeBar->moveToLeft(inner.x(), y, _page->width());
		y += _noticeBar->height();
	}
	// Низ острова скруглён: содержимое не доходит до края на величину скругления по бокам
	const auto bottom = inner.y() + inner.height();
	_content->setGeometry(inner.x(), y, inner.width(), std::max(bottom - y - Rem(0.5), 0));
	const auto cw = _content->width();
	const auto ch = _content->height();

	const auto isNotes = (_view == View::Notes) && _notes->status == notes::NotesStatus::Ready;
	const auto note = openNote();
	const auto isNoteShown = isNotes && note;
	const auto isNoteAlone = narrow && isNoteShown;
	const auto listShown = isNotes && !isNoteAlone;
	const auto paneShown = isNotes && (!narrow || isNoteShown);
	_listScroll->setVisible(listShown);
	_listResizer->setVisible(listShown && !narrow);
	_paneScroll->setVisible(paneShown);
	_content->setDivider(std::nullopt);
	if (listShown) {
		const auto w = narrow ? cw : ClampPanel(_listWidth, kListMin, kListMax, viewport);
		// `.list`: поля 0.75rem (на узком — 0.875rem 1rem 1.5rem)
		const auto padX = narrow ? Rem(1) : Rem(0.75);
		const auto padY = narrow ? Rem(0.875) : Rem(0.75);
		_listScroll->setGeometry(padX, padY, std::max(w - 2 * padX, 1), std::max(ch - padY, 0));
		_list->resizeToWidth(_listScroll->width());
		if (!narrow) {
			_content->setDivider(w - Px(1));
			_listResizer->setGeometry(w - Rem(0.3125), 0, _listResizer->width(), ch);
			_listResizer->raise();
		}
		if (paneShown) {
			_paneScroll->setGeometry(w, 0, std::max(cw - w, 0), ch);
		}
	} else if (paneShown) {
		_paneScroll->setGeometry(0, 0, cw, ch);
	}
	if (paneShown) {
		_pane->resizeToWidth(_paneScroll->width());
	}
	if (_graph && !_graph->isHidden()) {
		_graph->setGeometry(0, 0, cw, ch);
	}
	if (_canvas && !_canvas->isHidden()) {
		_canvas->setGeometry(0, 0, cw, ch);
	}
	if (_graphNoticeBar) {
		_graphNoticeBar->fitTo(cw - Rem(7.5));
		_graphNoticeBar->move((cw - _graphNoticeBar->width()) / 2, ch - Rem(0.75) - _graphNoticeBar->height());
		_graphNoticeBar->raise();
	}
	if (!_panel->isHidden() && narrow) {
		// Узкий экран: панель поверх поля во всю ширину
		_panel->setGeometry(outer.x(), outer.y(), outer.width(), outer.height());
		_panel->raise();
	}
}

void KnowledgeScreen::resizeEvent(QResizeEvent *e) {
	refresh();
}

void KnowledgeScreen::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.fillRect(e->rect(), ToneColor(Tone::Bg));
}

// ── действия ─────────────────────────────────────────────────────────────────

void KnowledgeScreen::setView(View view) {
	if (_view == view) {
		return;
	}
	_view = view;
	WriteView(view);
	refresh();
}

void KnowledgeScreen::setOpenId(std::optional<std::string> id) {
	_openId = std::move(id);
	refresh();
}

void KnowledgeScreen::setQuery(const QString &value) {
	if (_view == View::Graph) {
		_graphQuery = value;
		if (_graph) {
			_graph->setQuery(value);
		}
		return;
	} else if (_view == View::Canvas) {
		_canvasQuery = value;
		if (_canvas) {
			NotesUi::SetCanvasSearch(_canvas.get(), value);
		}
		return;
	}
	_query = value;
	// Очищенное поле показывает весь список сразу
	if (value.trimmed().isEmpty()) {
		_searchTimer.cancel();
		_searchQuery = QString();
		refreshList();
	} else {
		_searchTimer.callOnce(kSearchDelayMs);
	}
}

void KnowledgeScreen::searchNext() {
	if (_view == View::Graph && _graph) {
		_graph->searchNext();
	} else if (_view == View::Canvas && _canvas) {
		NotesUi::CanvasSearchNext(_canvas.get());
	}
}

void KnowledgeScreen::markGuide() {
	PrefSet(notes::guideSeenKey(S(SelfAddress())), notes::kGuideSeenValue);
	_hasSeenGuide = true;
	refreshList();
}

void KnowledgeScreen::expandGroup(const std::string &key) {
	if (!ranges::contains(_collapsed, key)) {
		return;
	}
	_collapsed.erase(ranges::remove(_collapsed, key), end(_collapsed));
	PrefSet(notes::kKnowledgeCollapsedKey, notes::serializeCollapsedFolders(_collapsed));
}

void KnowledgeScreen::createIn(std::optional<std::string> folderId) {
	_hasPickedNote = true;
	const auto title = S(tr::lng_parvane_notes_new_note(tr::now));
	const auto vault = VaultName();
	const auto weak = base::make_weak(this);
	Sections::Ask<std::optional<std::string>>([=](Sections::Workers &w) {
		return w.notes.createNote(title, vault, std::nullopt, std::nullopt, folderId);
	}, [=](std::optional<std::string> id) {
		if (weak && id) {
			setOpenId(*id);
		}
	});
}

void KnowledgeScreen::handleNew() {
	// Новая заметка ложится в папку открытой заметки; из справки и заметок дня — в «Без папки»
	const auto note = openNote();
	const auto path = notes::newNoteFolder({
		.openFolder = note ? std::make_optional(note->folder) : std::nullopt,
		.openIsDay = note && note->isDaily && notes::isDayTitle(note->title),
		.guideFolder = guideOverviewFolder(),
	});
	auto folderId = std::optional<std::string>();
	if (path) {
		for (const auto &folder : _notes->folders) {
			if (folder.path == *path) {
				folderId = folder.id;
			}
		}
	}
	expandGroup(folderId ? *path : notes::kRootFolder);
	createIn(folderId);
}

void KnowledgeScreen::handleGuide() {
	// «Справка Parvane»: открыть «Обзор»; справки нет (удалена либо ещё не создана) — предложить создать
	if (const auto overview = guideOverviewId()) {
		_openId = *overview;
		markGuide();
		refresh();
		return;
	}
	const auto folder = Q(notes::buildGuide(IsRussian() ? "ru" : "en").folderName);
	const auto weak = base::make_weak(this);
	ShowQuestion(
		this,
		tr::lng_parvane_notes_guide_return(tr::now),
		tr::lng_parvane_notes_guide_restore_text(tr::now, lt_name, folder),
		{ SheetButton{
			.text = tr::lng_parvane_notes_guide_restore(tr::now),
			.kind = Kit::PushButton::Kind::Accent,
			.callback = [=] {
				Sections::Ask<std::optional<std::string>>([](Sections::Workers &w) {
					return w.notes.restoreGuide();
				}, [=](std::optional<std::string> id) {
					if (weak && id) {
						_openId = *id;
						markGuide();
						refresh();
					}
				});
			},
		} });
}

void KnowledgeScreen::openTitle(const QString &title) {
	// Ссылка на заметку, которой ещё нет, создаёт её
	const auto weak = base::make_weak(this);
	EnsureNote(S(title), [=](std::optional<std::string> id) {
		if (weak && id) {
			_hasPickedNote = true;
			setOpenId(*id);
		}
	});
}

void KnowledgeScreen::showFolderSheet(std::optional<std::string> folderId) {
	auto folder = std::optional<notes::NoteFolder>();
	if (folderId) {
		for (const auto &item : _notes->folders) {
			if (item.id == *folderId) {
				folder = item;
			}
		}
	}
	const auto vault = VaultName();
	ShowFolderSheet(this, folder, [=](QString name, Fn<void(std::optional<notes::FolderSubmitError>)> done) {
		const auto value = S(name);
		if (folder) {
			const auto id = folder->id;
			Sections::Ask<std::optional<notes::FolderSubmitError>>([=](Sections::Workers &w) {
				return w.notes.renameNoteFolder(id, value, vault);
			}, done);
		} else {
			Sections::Ask<std::optional<notes::FolderSubmitError>>([=](Sections::Workers &w) {
				return w.notes.createNoteFolder(value, vault).error;
			}, done);
		}
	}, folder ? Fn<void()>([=] { deleteFolder(*folder); }) : Fn<void()>());
}

void KnowledgeScreen::deleteFolder(const notes::NoteFolder &folder) {
	// Пустая папка удаляется сразу; с заметками — после вопроса: в «Без папки» либо вместе с папкой в корзину
	auto count = 0;
	for (const auto &note : _notes->notes) {
		if (notes::isInFolder(note->folder, folder.path)) {
			++count;
		}
	}
	const auto id = folder.id;
	const auto remove = [=](std::string mode) {
		Sections::Post([=](Sections::Workers &w) {
			w.notes.deleteNoteFolder(id, mode);
		});
	};
	if (!count) {
		remove(std::string());
		return;
	}
	ShowQuestion(
		this,
		tr::lng_parvane_notes_folder_delete_title(tr::now),
		tr::lng_parvane_notes_folder_delete_confirm(
			tr::now,
			lt_name,
			Q(notes::folderCaption(folder.path)),
			lt_amount,
			QString::number(count)),
		{
			SheetButton{
				.text = tr::lng_parvane_notes_folder_delete_action(tr::now),
				.kind = Kit::PushButton::Kind::Normal,
				.callback = [=] { remove("move"); },
			},
			SheetButton{
				.text = tr::lng_parvane_notes_folder_delete_with_notes(tr::now),
				.kind = Kit::PushButton::Kind::Danger,
				.callback = [=] { remove("with-notes"); },
			},
		},
		true);
}

void KnowledgeScreen::askMove(const std::string &noteId) {
	const auto note = noteById(noteId);
	if (!note) {
		return;
	}
	const auto vault = VaultName();
	ShowFolderPicker(this, Q(note->title), note->folder, _notes->folders, [=](std::optional<std::string> folderId) {
		MoveNote(noteId, folderId);
	}, [=](QString name, Fn<void(std::optional<notes::FolderSubmitError>)> done) {
		const auto value = S(name);
		Sections::Ask<std::optional<notes::FolderSubmitError>>([=](Sections::Workers &w)
				-> std::optional<notes::FolderSubmitError> {
			const auto created = w.notes.createNoteFolder(value, vault);
			if (!created.id) {
				return created.error.value_or(notes::FolderSubmitError::Failed);
			}
			w.notes.moveNote(noteId, created.id);
			return std::nullopt;
		}, done);
	});
}

void KnowledgeScreen::closePanel() {
	_graphPick = std::nullopt;
	_linkFromId = std::nullopt;
	_editRequest = std::nullopt;
	refresh();
}

// ── граф: панель выбранной точки и правка связей ─────────────────────────────

void KnowledgeScreen::showGraphNotice(const QString &text, Fn<void()> undo) {
	_graphNoticeBar = nullptr;
	_graphNotice = GraphNotice{ text, std::move(undo) };
	_graphNoticeTimer.callOnce(kNoticeHideMs);
	refresh();
}

Fn<void()> KnowledgeScreen::revertNote(const std::string &noteId, const std::string &before) {
	// Отмена правки связи: текст заметки возвращается, а что в ней изменили после — остаётся
	return [=] {
		crl::on_main(this, [=] {
			const auto now = noteById(noteId);
			const auto after = now ? std::make_optional(now->text) : std::nullopt;
			_graphNotice = std::nullopt;
			_graphNoticeBar = nullptr;
			SaveNote(noteId, before, after);
		});
	};
}

void KnowledgeScreen::pickNoteInGraph(const std::string &noteId) {
	const auto weak = base::make_weak(this);
	const auto apply = [=] {
		if (!weak) {
			return;
		}
		const auto note = noteById(noteId);
		if (!note) {
			return;
		}
		_editRequest = std::nullopt;
		_pickView = _view;
		_graphPick = GraphPick{
			note->id,
			note->isDaily ? notes::GraphNodeKind::Day : notes::GraphNodeKind::Note,
			note->title,
			note->folder,
		};
		refresh();
	};
	if (noteById(noteId)) {
		apply();
	} else {
		// Заметку только что создали: она появится со следующим снимком хранилища
		Sections::NotesValue() | rpl::filter([=](const std::shared_ptr<const Sections::NotesView> &view) {
			return ranges::any_of(view->notes, [&](const notes::NoteRef &note) { return note->id == noteId; });
		}) | rpl::take(1) | rpl::on_next([=](auto&&) {
			crl::on_main(this, apply);
		}, lifetime());
	}
}

void KnowledgeScreen::linkInGraph(
		const std::string &fromId,
		const std::string &toTitle,
		Fn<void(GraphLinkOutcome)> done) {
	// Связь на графе — ссылка `[[…]]` в тексте заметки-источника: одно сохранение на жест
	const auto from = noteById(fromId);
	if (!from) {
		done(GraphLinkOutcome::Failed);
		return;
	}
	const auto fromTitle = Q(from->title);
	const auto to = Q(toTitle).trimmed();
	const auto result = notes::addLinkToText(from->text, toTitle);
	if (result.status == notes::AddLinkStatus::Refused) {
		showGraphNotice(tr::lng_parvane_notes_graph_link_refused(tr::now, lt_name, to));
		done(GraphLinkOutcome::Refused);
		return;
	} else if (result.status == notes::AddLinkStatus::Exists) {
		showGraphNotice(tr::lng_parvane_notes_graph_link_exists(tr::now, lt_from, fromTitle, lt_to, to));
		done(GraphLinkOutcome::Exists);
		return;
	}
	const auto before = from->text;
	const auto weak = base::make_weak(this);
	SaveNote(fromId, result.text, before, [=](bool ok) {
		if (!ok) {
			done(GraphLinkOutcome::Failed);
			return;
		}
		if (weak) {
			showGraphNotice(
				tr::lng_parvane_notes_graph_linked(tr::now, lt_from, fromTitle, lt_to, to),
				revertNote(fromId, before));
			// На телефоне лист заметки закрыт, пока выбирают цель: после связи остаётся граф
			if (isNarrow() && _linkFromId) {
				_graphPick = std::nullopt;
				refresh();
			}
		}
		done(GraphLinkOutcome::Added);
	});
}

void KnowledgeScreen::linkNewInGraph(
		const std::string &fromId,
		const std::string &title,
		Fn<void(std::optional<std::string>)> done) {
	// Связь, брошенная на пустое место: заметка с таким названием (новая либо уже существующая) и ссылка на неё
	if (!notes::canLinkTitle(title)) {
		showGraphNotice(tr::lng_parvane_notes_graph_link_refused(tr::now, lt_name, Q(title).trimmed()));
		done(std::nullopt);
		return;
	}
	const auto trimmed = S(Q(title).trimmed());
	const auto vault = VaultName();
	const auto daily = DailyFolderName();
	const auto weak = base::make_weak(this);
	using Created = std::optional<std::pair<std::string, std::string>>;
	Sections::Ask<Created>([=](Sections::Workers &w) -> Created {
		auto id = std::optional<std::string>();
		if (const auto found = w.notes.findNoteByTitle(trimmed)) {
			id = found->id;
		} else {
			id = notes::isDayTitle(trimmed)
				? w.notes.openDailyNote(trimmed, vault, daily)
				: w.notes.createNote(trimmed, vault);
		}
		if (!id) {
			return std::nullopt;
		}
		for (const auto &note : w.notes.notes()) {
			if (note->id == *id) {
				return std::make_pair(note->id, note->title);
			}
		}
		return std::nullopt;
	}, [=](Created created) {
		if (!weak || !created || created->first == fromId) {
			done(std::nullopt);
			return;
		}
		const auto id = created->first;
		linkInGraph(fromId, created->second, [=](GraphLinkOutcome) {
			done(id);
		});
	});
}

void KnowledgeScreen::unlinkInGraph(const std::string &fromId, const std::string &toTitle) {
	// Ссылка отдельной строкой уходит из текста; ссылку внутри предложения граф не трогает — заметка
	// открывается в панели в правке, ссылка выделена
	const auto from = noteById(fromId);
	if (!from) {
		return;
	}
	const auto fromTitle = Q(from->title);
	const auto to = Q(toTitle);
	const auto result = notes::removeLinkFromText(from->text, toTitle);
	if (result.status == notes::RemoveLinkStatus::Inline) {
		pickNoteInGraph(fromId);
		_editRequest = EditRequest{ fromId, result.from, result.to };
		showGraphNotice(tr::lng_parvane_notes_graph_unlink_inline(tr::now, lt_to, to, lt_from, fromTitle));
		return;
	} else if (result.status != notes::RemoveLinkStatus::Removed) {
		return;
	}
	const auto before = from->text;
	const auto weak = base::make_weak(this);
	SaveNote(fromId, result.text, before, [=](bool ok) {
		if (ok && weak) {
			showGraphNotice(
				tr::lng_parvane_notes_graph_unlinked(tr::now, lt_from, fromTitle, lt_to, to),
				revertNote(fromId, before));
		}
	});
}

void KnowledgeScreen::makeGraphCanvas(notes::GraphCanvasScope scope) {
	// «Создать холст»: холст из заметок, которые сейчас на графе видны, открывается на вкладке «Холст»
	if (_makingCanvas) {
		return;
	}
	auto inputs = std::vector<notes::GraphNoteInput>();
	for (const auto &note : _notes->notes) {
		inputs.push_back({
			note->id,
			note->title,
			note->folder,
			notes::parseNote(note->text).links,
			note->isDaily,
		});
	}
	auto options = notes::GraphCanvasOptions();
	options.scope = scope;
	const auto content = notes::canvasFromGraph(inputs, options);
	if (content.nodes.empty()) {
		showGraphNotice(tr::lng_parvane_notes_graph_to_canvas_empty(tr::now));
		return;
	}
	_makingCanvas = true;
	auto taken = std::vector<std::string>();
	for (const auto &canvas : _notes->canvases) {
		taken.push_back(canvas->title);
	}
	const auto title = notes::freeCanvasTitle(S(tr::lng_parvane_notes_canvas_graph_name(tr::now)), taken);
	const auto text = notes::serializeCanvas(content);
	const auto vault = VaultName();
	const auto weak = base::make_weak(this);
	Sections::Ask<std::optional<std::string>>([=](Sections::Workers &w) {
		return w.notes.saveCanvas(title, text, vault);
	}, [=](std::optional<std::string> id) {
		if (!weak) {
			return;
		}
		_makingCanvas = false;
		if (!id) {
			return;
		}
		_graphCanvasId = *id;
		setView(View::Canvas);
		refresh();
	});
}

} // namespace

void OpenKnowledgeNote(const QString &title) {
	NoteRequest() = title;
	ShowSection(Section::Knowledge);
}

void OpenKnowledgeNoteById(const std::string &noteId) {
	NoteIdRequest() = Knowledge::Q(noteId);
	ShowSection(Section::Knowledge);
}

void RegisterKnowledge() {
	RegisterSectionFactory(Section::Knowledge, [](
			not_null<QWidget*> parent,
			not_null<Window::SessionController*> controller,
			Section section) {
		return object_ptr<Ui::RpWidget>(object_ptr<KnowledgeScreen>(parent.get(), controller));
	});
}

} // namespace Parvane
