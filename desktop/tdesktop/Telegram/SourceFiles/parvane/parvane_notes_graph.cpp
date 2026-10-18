// Parvane fork: реализация parvane_notes_graph.h. Размеры и цвета — web `Knowledge.module.scss` (`.board*`, `.graph*`).
#include "parvane/parvane_notes_graph.h"

#include <parvane/sections/notes_prefs.h>
#include <parvane/sections/notes_view.h>

#include "base/weak_qptr.h"
#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/fields/input_field.h"

#include <QtGui/QPainterPath>
#include <QtGui/QtEvents>

#include <set>

namespace Parvane::Knowledge {
namespace {

using Kit::Px;
using Kit::Rem;

// Раскладка свободная (не сжата в область): область задаёт только центр
constexpr auto kLayoutWidth = 900.;
constexpr auto kLayoutHeight = 620.;
constexpr auto kLabelGap = 17.;
// Мельче этого масштаба подписи остаются только у выбранной точки, её соседей и найденного поиском
constexpr auto kLabelMinScale = 0.55;
// Кольцо, за которое тянут связь: настолько шире кружка (обводка 4 — попадание от r+3 до r+7)
constexpr auto kHandleGap = 5.;
// Запас попадания в точку при отпускании связи, в пикселях экрана
constexpr auto kDropSlop = 10.;
// Место под подпись точки при вписывании графа в поле
constexpr auto kFitBoxWidth = 120.;
constexpr auto kFitBoxHeight = 60.;
constexpr auto kFitTop = 60.;
constexpr auto kFitBottom = 20.;
// Выбранная точка ближе этого к краю поля считается скрытой — поле сдвигается к ней
constexpr auto kRevealPad = 32.;
constexpr auto kDragThreshold = 5;
constexpr auto kDoubleTapMs = crl::time(380);
constexpr auto kFlashMs = crl::time(1200);
constexpr auto kFrameMs = crl::time(16);
constexpr auto kNewTitleMax = 120;
// Где на выбранной связи стоит крестик: посередине, у взаимной — ближе к заметке, чью ссылку он убирает
constexpr auto kRemoveAtMiddle = 0.5;
constexpr auto kRemoveAtSource = 0.3;

// Места точек переживают уход с вкладки: граф не перетряхивается, пока его не попросят разложить заново
notes::GraphPlaces &PlacedById() {
	static auto result = notes::GraphPlaces();
	return result;
}

[[nodiscard]] std::string KeyOf(const notes::GraphEdge &edge) {
	return edge.from + '>' + edge.to;
}

[[nodiscard]] std::string PairOf(const std::string &a, const std::string &b) {
	return (a < b) ? (a + '>' + b) : (b + '>' + a);
}

[[nodiscard]] Tone NodeTone(const notes::GraphNode &node) {
	switch (node.kind) {
	case notes::GraphNodeKind::Missing: return Tone::Faint;
	case notes::GraphNodeKind::Day: return Tone::Yellow;
	case notes::GraphNodeKind::Record: return (node.group.value_or(std::string()) == "task") ? Tone::Purple : Tone::Blue;
	case notes::GraphNodeKind::Note: break;
	}
	return FolderTone(node.group.value_or(std::string()));
}

// Наконечник стрелки из пути SVG ядра `M x y L x y L x y Z`
[[nodiscard]] QPolygonF HeadPolygon(const std::string &path) {
	auto numbers = std::vector<double>();
	auto current = std::string();
	const auto flush = [&] {
		if (!current.empty()) {
			numbers.push_back(std::atof(current.c_str()));
			current.clear();
		}
	};
	for (const auto c : path) {
		if ((c >= '0' && c <= '9') || c == '.' || c == '-' || c == 'e') {
			if (c == '-' && !current.empty()) {
				flush();
			}
			current.push_back(c);
		} else {
			flush();
		}
	}
	flush();
	auto result = QPolygonF();
	for (auto i = 0; i + 1 < int(numbers.size()); i += 2) {
		result.push_back(QPointF(numbers[i], numbers[i + 1]));
	}
	return result;
}

// Расстояние от точки до отрезка
[[nodiscard]] double SegmentDistance(QPointF p, QPointF a, QPointF b) {
	const auto d = b - a;
	const auto length = d.x() * d.x() + d.y() * d.y();
	if (length <= 0.) {
		return std::hypot(p.x() - a.x(), p.y() - a.y());
	}
	const auto t = std::clamp(((p.x() - a.x()) * d.x() + (p.y() - a.y()) * d.y()) / length, 0., 1.);
	const auto q = a + d * t;
	return std::hypot(p.x() - q.x(), p.y() - q.y());
}

// Круглая кнопка над полем: крестик на выбранной связи (`.graphEdgeRemove` 1.75rem акцентом)
class RemoveButton final : public Kit::Button {
public:
	RemoveButton(QWidget *parent, const QString &label) : Button(parent) {
		setAccessibleName(label);
		const auto side = Rem(1.75);
		resize(side, side);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Accent));
		p.drawEllipse(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5));
		const auto icon = Rem(1.125);
		PaintNotesIcon(p, u"x"_q, ToneColor(Tone::AccentInk), (width() - icon) / 2, (height() - icon) / 2, icon);
	}

};

// Кнопка масштаба (`.boardTool`): квадрат 2.375rem со скруглением 0.625rem, рамка `--pv-line2`, фон `--pv-panel`
class BoardTool final : public Kit::Button {
public:
	BoardTool(QWidget *parent, const QString &icon, const QString &label)
	: Button(parent)
	, _icon(icon) {
		setAccessibleName(label);
		const auto side = Rem(2.375);
		resize(side, side);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(QPen(ToneColor(Tone::Line2), Px(1)));
		p.setBrush(ToneColor((isOver() || isDown()) ? Tone::Hover : Tone::Panel));
		const auto radius = Rem(0.625);
		p.drawRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), radius, radius);
		const auto icon = Rem(1.125);
		PaintNotesIcon(p, _icon, ToneColor(Tone::Fg), (width() - icon) / 2, (height() - icon) / 2, icon);
	}

private:
	QString _icon;

};

// Ряд над полем, мышь проходит мимо детей в поле (`.boardTools` с `pointer-events: none`)
class ToolsRow final : public Ui::RpWidget {
public:
	using RpWidget::RpWidget;

	void add(not_null<Ui::RpWidget*> widget) {
		_items.push_back(widget);
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto gap = Rem(0.375);
		auto x = 0;
		auto h = 0;
		for (const auto item : _items) {
			if (item->isHidden()) {
				continue;
			}
			item->moveToLeft(x, 0, newWidth);
			x += item->width() + gap;
			h = std::max(h, item->height());
		}
		return h;
	}

private:
	std::vector<not_null<Ui::RpWidget*>> _items;

};

// Подсказка режима «Связать» (`.boardHint` + `.graphLinkHint`): пилюля акцентом с текстом и «Отмена»
class LinkHint final : public Ui::RpWidget {
public:
	LinkHint(QWidget *parent, const QString &text, Fn<void()> cancel)
	: RpWidget(parent)
	, _text(text) {
		_cancel = Ui::CreateChild<NotesTextButton>(
			this,
			tr::lng_parvane_notes_cancel(tr::now),
			QString(),
			NotesTextButton::Kind::Plain);
		_cancel->setFontPx(13, true);
		_cancel->setTextTone(Tone::AccentInk);
		_cancel->setClickedCallback(std::move(cancel));
	}

	void fitTo(int maxWidth) {
		const auto font = Kit::Font(13, true);
		const auto padX = Rem(0.875);
		const auto gap = Rem(0.75);
		const auto h = std::max(font->height, _cancel->height()) + 2 * Rem(0.375);
		const auto textWidth = std::min(font->width(_text), std::max(maxWidth - 2 * padX - gap - _cancel->width(), 0));
		_textWidth = textWidth;
		resize(2 * padX + textWidth + gap + _cancel->width(), h);
		_cancel->moveToLeft(padX + textWidth + gap, (h - _cancel->height()) / 2);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Accent));
		p.drawRoundedRect(rect(), height() / 2., height() / 2.);
		const auto font = Kit::Font(13, true);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::AccentInk));
		p.drawText(Rem(0.875), (height() - font->height) / 2 + font->ascent, font->elided(_text, _textWidth));
	}

private:
	QString _text;
	int _textWidth = 0;
	NotesTextButton *_cancel = nullptr;

};

// Список папок графа (`.graphFoldersMenu`): «Все папки» и папки с галочками и числом заметок
class FolderMenu final : public Ui::RpWidget {
public:
	struct Option {
		QString caption;
		std::optional<std::string> path; // nullopt — «Все папки»
		int count = 0;
		bool on = false;
		std::optional<Tone> tone;
	};
	FolderMenu(QWidget *parent, std::vector<Option> options, Fn<void(std::optional<std::string>)> chosen)
	: RpWidget(parent)
	, _options(std::move(options))
	, _chosen(std::move(chosen)) {
		Kit::RepaintOnTones(this);
		setMouseTracking(true);
		const auto font = Kit::Font(14);
		auto w = Rem(13);
		for (const auto &option : _options) {
			w = std::max(w, 2 * Rem(0.625) + Rem(1.125) + Rem(0.625) + font->width(option.caption) + Rem(2.5));
		}
		w = std::min(w, Rem(20));
		resize(w + 2 * Rem(0.25), int(_options.size()) * rowHeight() + 2 * Rem(0.25));
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto radius = Rem(0.875);
		p.setPen(QPen(ToneColor(Tone::Line2), Px(1)));
		p.setBrush(ToneColor(Tone::Panel));
		p.drawRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), radius, radius);
		const auto pad = Rem(0.25);
		const auto font = Kit::Font(14);
		const auto small = Kit::Font(12);
		const auto icon = Rem(1.125);
		for (auto i = 0; i != int(_options.size()); ++i) {
			const auto &option = _options[i];
			const auto row = QRect(pad, pad + i * rowHeight(), width() - 2 * pad, rowHeight());
			if (i == _over) {
				p.setPen(Qt::NoPen);
				p.setBrush(ToneColor(Tone::Hover));
				p.drawRoundedRect(row, Rem(0.5), Rem(0.5));
			}
			auto x = row.x() + Rem(0.625);
			if (option.on) {
				PaintNotesIcon(p, u"check"_q, ToneColor(Tone::Fg), x, row.y() + (row.height() - icon) / 2, icon);
			}
			x += icon + Rem(0.625);
			auto right = row.right() - Rem(0.625);
			if (option.path) {
				const auto count = QString::number(option.count);
				p.setFont(small->f);
				p.setPen(ToneColor(Tone::Muted));
				right -= small->width(count);
				p.drawText(right, row.y() + (row.height() - small->height) / 2 + small->ascent, count);
				right -= Rem(0.625);
			}
			p.setFont(font->f);
			p.setPen(ToneColor(Tone::Fg));
			p.drawText(
				x,
				row.y() + (row.height() - font->height) / 2 + font->ascent,
				font->elided(option.caption, std::max(right - x, 0)));
		}
	}

	void mouseMoveEvent(QMouseEvent *e) override {
		const auto over = indexAt(e->pos());
		if (over != _over) {
			_over = over;
			setCursor((over >= 0) ? style::cur_pointer : style::cur_default);
			update();
		}
	}

	void leaveEventHook(QEvent *e) override {
		_over = -1;
		update();
	}

	void mouseReleaseEvent(QMouseEvent *e) override {
		const auto index = indexAt(e->pos());
		if (index >= 0 && _chosen) {
			_chosen(_options[index].path);
		}
	}

private:
	[[nodiscard]] static int rowHeight() {
		return Kit::Font(14)->height + 2 * Rem(0.4375);
	}

	[[nodiscard]] int indexAt(QPoint position) const {
		const auto y = position.y() - Rem(0.25);
		if (y < 0) {
			return -1;
		}
		const auto index = y / rowHeight();
		return (index < int(_options.size())) ? index : -1;
	}

	std::vector<Option> _options;
	Fn<void(std::optional<std::string>)> _chosen;
	int _over = -1;

};

} // namespace

// Что тянут: поле, точку, связь из кольца точки; нажатая связь при движении тянет поле
struct NotesGraph::Drag {
	enum class Mode {
		Pan,
		Node,
		Link,
		Edge,
	};
	Mode mode = Mode::Pan;
	std::string id;
	std::string edge;
	QPointF start;
	// Положение точки либо сдвиг поля в начале движения
	QPointF origin;
	bool hasMoved = false;
	std::optional<notes::GraphPoint> at;
};

// Связь, которую ведут: от точки `from` до места указателя на поле; `overId` — заметка под указателем
struct NotesGraph::Draft {
	notes::GraphPoint at;
	std::string from;
	std::optional<std::string> overId;
};

struct NotesGraph::Removal {
	notes::GraphNode from;
	notes::GraphNode to;
	notes::GraphPoint spot;
};

NotesGraph::NotesGraph(QWidget *parent, NotesGraphCallbacks callbacks)
: RpWidget(parent)
, _callbacks(std::move(callbacks))
, _savedFolders(notes::parseGraphFolders(PrefGet(notes::kKnowledgeGraphFoldersKey)))
, _layoutTimer([=] { layoutStep(); })
, _flashTimer([=] {
	_flash = std::nullopt;
	update();
}) {
	setMouseTracking(true);
	setFocusPolicy(Qt::ClickFocus);
	Kit::RepaintOnTones(this);

	// Чипы над полем (`.boardTools`, одна строка)
	const auto tools = Ui::CreateChild<ToolsRow>(this);
	_tools = tools;
	using Kind = NotesTextButton::Kind;
	_notesChip = Ui::CreateChild<NotesTextButton>(tools, QString(), QString(), Kind::Chip);
	_notesChip->setOn(true, Tone::Yellow);
	_notesChip->setAttribute(Qt::WA_TransparentForMouseEvents);
	tools->add(_notesChip);
	_daysChip = Ui::CreateChild<NotesTextButton>(tools, tr::lng_parvane_notes_graph_days(tr::now), QString(), Kind::Chip);
	_daysChip->setClickedCallback([=] {
		_withDays = !_withDays;
		rebuild();
		refreshTools();
	});
	tools->add(_daysChip);
	_recordsChip = Ui::CreateChild<NotesTextButton>(
		tools,
		tr::lng_parvane_notes_graph_records(tr::now),
		QString(),
		Kind::Chip);
	_recordsChip->setClickedCallback([=] {
		_withRecords = !_withRecords;
		rebuild();
		refreshTools();
	});
	tools->add(_recordsChip);
	_foldersChip = Ui::CreateChild<NotesTextButton>(tools, QString(), u"folder"_q, Kind::Chip);
	_foldersChip->setAccessibleName(tr::lng_parvane_notes_graph_folders(tr::now));
	_foldersChip->setClickedCallback([=] { toggleFolderMenu(); });
	tools->add(_foldersChip);
	_canvasChip = Ui::CreateChild<NotesTextButton>(
		tools,
		tr::lng_parvane_notes_graph_to_canvas(tr::now),
		u"board"_q,
		Kind::Chip);
	_canvasChip->setToolTip(tr::lng_parvane_notes_graph_to_canvas_title(tr::now));
	_canvasChip->setClickedCallback([=] {
		if (_callbacks.makeCanvas) {
			_callbacks.makeCanvas({ .folders = _folders, .days = _withDays });
		}
	});
	tools->add(_canvasChip);

	// Масштаб (`.boardZoom`): справа внизу столбцом
	const auto zoom = Ui::CreateChild<Ui::RpWidget>(this);
	_zoom = zoom;
	const auto zoomBy = [=](double factor) {
		applyView(notes::zoomAround(_view, _view.scale * factor, width() / 2., height() / 2.));
	};
	const auto in = Ui::CreateChild<BoardTool>(zoom, u"plus"_q, tr::lng_parvane_notes_zoom_in(tr::now));
	in->setClickedCallback([=] { zoomBy(notes::kBoardZoomStep); });
	const auto out = Ui::CreateChild<BoardTool>(zoom, u"minus"_q, tr::lng_parvane_notes_zoom_out(tr::now));
	out->setClickedCallback([=] { zoomBy(1. / notes::kBoardZoomStep); });
	const auto fitButton = Ui::CreateChild<BoardTool>(zoom, u"fit"_q, tr::lng_parvane_notes_zoom_fit(tr::now));
	// «Вписать» раскладывает граф заново (сдвинутые руками точки возвращаются) и показывает его целиком
	fitButton->setClickedCallback([=] {
		PlacedById().clear();
		_moved.clear();
		++_layoutRound;
		rebuild(true);
	});
	const auto gap = Rem(0.375);
	in->moveToLeft(0, 0);
	out->moveToLeft(0, in->height() + gap);
	fitButton->moveToLeft(0, 2 * (in->height() + gap));
	zoom->resize(in->width(), 3 * in->height() + 2 * gap);

	refreshTools();
}

NotesGraph::~NotesGraph() {
	rememberPlaces();
}

void NotesGraph::setNotes(const std::vector<notes::NoteRef> &notes) {
	_notes = notes;
	// Ссылки заметки разбираются один раз на версию записи
	auto links = std::map<const notes::NoteEntry*, std::vector<std::string>>();
	for (const auto &note : _notes) {
		const auto i = _links.find(note.get());
		links.emplace(note.get(), (i != _links.end()) ? i->second : notes::parseNote(note->text).links);
	}
	_links = std::move(links);
	rebuild();
	refreshTools();
}

void NotesGraph::setPlanner(const planner::State &state) {
	_planner = state;
	if (_withRecords) {
		rebuild();
	}
}

void NotesGraph::setPicked(std::optional<std::string> id) {
	if (_pickedId == id) {
		return;
	}
	_pickedId = std::move(id);
	if (_pickedId) {
		reveal(*_pickedId);
	}
	update();
}

void NotesGraph::setLinkFrom(std::optional<std::string> id) {
	if (_linkFromId == id) {
		return;
	}
	_linkFromId = std::move(id);
	if (!_linkFromId) {
		// Режим «Связать» кончился — недоведённая связь исчезает
		_draft = nullptr;
	}
	refreshOverlays();
	update();
}

void NotesGraph::setQuery(const QString &query) {
	_query = query;
	update();
}

void NotesGraph::searchNext() {
	auto hits = std::vector<std::string>();
	for (const auto &node : _nodes) {
		if (isFound(node)) {
			hits.push_back(node.id);
		}
	}
	const auto index = notes::nextFoundIndex(hits, _pickedId);
	if (!index) {
		return;
	}
	const auto node = nodeById(hits[*index]);
	if (node && _callbacks.pick) {
		_callbacks.pick({ node->id, node->kind, node->title, node->group });
	}
}

void NotesGraph::rebuild(bool force) {
	auto input = notes::GraphInput();
	_dailyIds.clear();
	auto inputNotes = std::vector<notes::GraphNoteInput>();
	for (const auto &note : _notes) {
		const auto i = _links.find(note.get());
		input.notes.push_back({
			note->id,
			note->title,
			note->folder,
			(i != _links.end()) ? i->second : std::vector<std::string>(),
			note->isDaily,
		});
		if (note->isDaily) {
			_dailyIds.emplace(note->id);
		}
	}
	// Записи «Плана» нужны графу только при включённых «Записях»
	if (_withRecords) {
		input.records = notes::graphRecordsOf(_planner);
	}
	// Папки с заметками; выбор приводится к ним — удалённая папка из него выпадает
	_folderOptions = notes::listGraphFolders(input.notes);
	_folders = notes::resolveGraphFolders(_savedFolders, _folderOptions);

	// Подпись входа: та же — граф не пересобирается (новые снимки хранилища приходят часто)
	auto signature = std::string();
	signature += _withDays ? 'D' : 'd';
	signature += _withRecords ? 'R' : 'r';
	signature += std::to_string(_layoutRound) + '\x1f';
	if (_folders) {
		for (const auto &path : *_folders) {
			signature += path + '\x1e';
		}
	} else {
		signature += "*";
	}
	signature += '\x1f';
	for (const auto &note : input.notes) {
		signature += note.id + '\x1e' + note.title + '\x1e' + note.folder + (note.isDaily ? "\x1d" : "\x1c");
		for (const auto &link : note.links) {
			signature += link + '\x1e';
		}
		signature += '\x1f';
	}
	for (const auto &record : input.records) {
		signature += record.id + '\x1e' + record.title + '\x1f';
	}
	if (!force && signature == _signature && _run) {
		return;
	}
	_signature = std::move(signature);

	const auto graph = notes::buildGraph(input, { .withDays = _withDays, .withRecords = _withRecords, .folders = _folders });
	_edges = graph.edges;
	rememberPlaces();
	auto options = notes::GraphLayoutOptions();
	options.width = kLayoutWidth;
	options.height = kLayoutHeight;
	options.isLoose = true;
	// Точки, у которых уже есть место, стоят на нём: новая связь, заметка или смена папок граф не перетряхивают
	_run = std::make_unique<notes::GraphLayoutRun>(
		notes::startGraphLayout(graph.nodes, graph.edges, &PlacedById(), options));
	_run->step(notes::kGraphSyncWork);
	refreshNodes();
	if (_run->isDone()) {
		_layoutTimer.cancel();
		rememberPlaces();
	} else {
		_layoutTimer.callEach(kFrameMs);
	}

	// Подписи точек: у заметки дня — дата словами, у записи «Плана» — название без разметки ссылок
	_labels.clear();
	for (const auto &node : _nodes) {
		if (_dailyIds.contains(node.id)) {
			_labels[node.id] = S(DisplayTitle(node.title, true));
		} else if (node.kind == notes::GraphNodeKind::Record) {
			_labels[node.id] = notes::recordLabel(node.title);
		}
	}
	maybeFit();
	refreshTools();
	refreshOverlays();
	update();
}

void NotesGraph::layoutStep() {
	if (!_run) {
		_layoutTimer.cancel();
		return;
	}
	const auto done = _run->step(notes::kGraphFrameWork);
	refreshNodes();
	if (done || _run->isDone()) {
		_layoutTimer.cancel();
		rememberPlaces();
		if (_refit) {
			_refit = false;
			fit();
		}
	}
	refreshOverlays();
	update();
}

void NotesGraph::refreshNodes() {
	_nodes = _run ? _run->nodes() : std::vector<notes::GraphNode>();
	for (auto &node : _nodes) {
		if (const auto i = _moved.find(node.id); i != _moved.end()) {
			node.x = i->second.x;
			node.y = i->second.y;
		}
	}
}

void NotesGraph::rememberPlaces() {
	if (!_run || !_run->isDone()) {
		return;
	}
	for (const auto &node : _nodes) {
		PlacedById()[node.id] = { node.x, node.y };
	}
}

void NotesGraph::maybeFit() {
	// Граф вписывается в поле при открытии, при смене фильтра и когда его раскладывают заново
	const auto hasNodes = !_nodes.empty();
	auto key = std::string(hasNodes ? "1" : "0") + (_withDays ? "1" : "0") + (_withRecords ? "1" : "0")
		+ std::to_string(_layoutRound) + '|';
	if (_folders) {
		for (const auto &path : *_folders) {
			key += path + '\n';
		}
	} else {
		key += "*";
	}
	if (_fitKey == key || width() <= 0 || height() <= 0) {
		return;
	}
	_fitKey = key;
	fit();
}

void NotesGraph::fit() {
	if (width() <= 0 || height() <= 0) {
		return;
	}
	// Пока раскладка не закончена, вписывается промежуточный граф — по готовому вписывание повторится
	_refit = _run && !_run->isDone();
	auto rects = std::vector<notes::BoardRect>();
	rects.reserve(_nodes.size());
	for (const auto &node : _nodes) {
		rects.push_back({ node.x - kFitBoxWidth / 2, node.y - kFitBoxHeight / 2, kFitBoxWidth, kFitBoxHeight });
	}
	applyView(notes::fitRects(rects, width(), height(), kFitTop, kFitBottom));
}

void NotesGraph::applyView(notes::BoardView view) {
	_view = view;
	refreshOverlays();
	update();
}

void NotesGraph::reveal(const std::string &id) {
	// Вид, в котором точка видна: прежний, если она и так на поле, иначе поле сдвигается к ней без смены масштаба
	const auto node = nodeById(id);
	if (!node || width() <= 0 || height() <= 0) {
		return;
	}
	const auto x = _view.x + node->x * _view.scale;
	const auto y = _view.y + node->y * _view.scale;
	const auto shown = x >= kRevealPad && x <= width() - kRevealPad && y >= kFitTop && y <= height() - kRevealPad;
	if (!shown) {
		applyView({ _view.scale, width() / 2. - node->x * _view.scale, height() / 2. - node->y * _view.scale });
	}
}

notes::GraphPoint NotesGraph::toWorld(QPointF screen) const {
	return { (screen.x() - _view.x) / _view.scale, (screen.y() - _view.y) / _view.scale };
}

QPointF NotesGraph::toScreen(notes::GraphPoint world) const {
	return { _view.x + world.x * _view.scale, _view.y + world.y * _view.scale };
}

const notes::GraphNode *NotesGraph::nodeById(const std::string &id) const {
	const auto i = ranges::find(_nodes, id, &notes::GraphNode::id);
	return (i != _nodes.end()) ? &*i : nullptr;
}

const notes::GraphNode *NotesGraph::targetAt(notes::GraphPoint point, const std::string &fromId) const {
	const auto node = notes::nodeAt(_nodes, point.x, point.y, kDropSlop / _view.scale);
	return (node && node->id != fromId && notes::canLinkTo(node)) ? node : nullptr;
}

const notes::GraphNode *NotesGraph::handleAt(QPointF screen) const {
	if (_linkFromId) {
		return nullptr;
	}
	const auto world = toWorld(screen);
	for (auto i = _nodes.rbegin(); i != _nodes.rend(); ++i) {
		if (!notes::canLinkFrom(&*i)) {
			continue;
		}
		const auto r = notes::nodeRadius(i->degree);
		const auto d = std::hypot(world.x - i->x, world.y - i->y);
		if (d > r && d >= r + kHandleGap - 2 && d <= r + kHandleGap + 2) {
			return &*i;
		}
	}
	return nullptr;
}

std::optional<std::string> NotesGraph::edgeAt(QPointF screen) const {
	const auto world = toWorld(screen);
	const auto point = QPointF(world.x, world.y);
	for (const auto &edge : _edges) {
		const auto from = nodeById(edge.from);
		const auto to = nodeById(edge.to);
		// Править можно связь между заметками: у дней и записей «Плана» ссылки стоят не в тексте заметки
		if (!from || !to || !notes::canLinkFrom(from) || !notes::canLinkTo(to)) {
			continue;
		}
		const auto shape = notes::edgeShape(
			{ from->x, from->y },
			{ to->x, to->y },
			notes::nodeRadius(from->degree),
			notes::nodeRadius(to->degree),
			edge.isMutual);
		if (SegmentDistance(point, { shape.x1, shape.y1 }, { shape.x2, shape.y2 }) * _view.scale <= 7.) {
			return KeyOf(edge);
		}
	}
	return std::nullopt;
}

QString NotesGraph::labelOf(const notes::GraphNode &node) const {
	const auto i = _labels.find(node.id);
	return Q((i != _labels.end()) ? i->second : node.title);
}

bool NotesGraph::isFound(const notes::GraphNode &node) const {
	return notes::isGraphFound(S(_query), S(labelOf(node)), node.title);
}

std::optional<std::string> NotesGraph::linkSourceId() const {
	if (_newAt) {
		return _newAt->from;
	} else if (_draft) {
		return _draft->from;
	}
	return _linkFromId;
}

std::vector<NotesGraph::Removal> NotesGraph::removals() const {
	auto result = std::vector<Removal>();
	if (!_pickedEdge) {
		return result;
	}
	const auto i = ranges::find_if(_edges, [&](const notes::GraphEdge &edge) {
		return KeyOf(edge) == *_pickedEdge;
	});
	if (i == _edges.end()) {
		return result;
	}
	const auto from = nodeById(i->from);
	const auto to = nodeById(i->to);
	if (!from || !to) {
		return result;
	}
	const auto at = [&](double share) {
		return notes::GraphPoint{ from->x + (to->x - from->x) * share, from->y + (to->y - from->y) * share };
	};
	if (!i->isMutual) {
		result.push_back({ *from, *to, at(kRemoveAtMiddle) });
	} else {
		result.push_back({ *from, *to, at(kRemoveAtSource) });
		result.push_back({ *to, *from, at(1. - kRemoveAtSource) });
	}
	return result;
}

void NotesGraph::refreshTools() {
	auto noteCount = 0;
	auto hasCanvasNotes = false;
	for (const auto &node : _nodes) {
		if (node.kind == notes::GraphNodeKind::Note) {
			++noteCount;
		}
		if (node.kind == notes::GraphNodeKind::Note || node.kind == notes::GraphNodeKind::Day) {
			hasCanvasNotes = true;
		}
	}
	_notesChip->setText(tr::lng_parvane_notes_graph_notes(tr::now, lt_amount, QString::number(noteCount)));
	_daysChip->setOn(_withDays, Tone::Yellow);
	_recordsChip->setOn(_withRecords, Tone::Blue);
	// Выбирать есть из чего, когда заметки лежат больше чем в одном месте
	_foldersChip->setVisible(_folderOptions.size() > 1);
	const auto label = !_folders
		? tr::lng_parvane_notes_graph_folders_all(tr::now)
		: (_folders->size() == 1)
		? FolderCaption(_folders->front())
		: tr::lng_parvane_notes_graph_folders_count(tr::now, lt_amount, QString::number(_folders->size()));
	_foldersChip->setText(Kit::Font(13)->elided(label, Rem(11)));
	_foldersChip->setIcon(u"folder"_q, _folderMenu ? u"up"_q : u"down"_q);
	_foldersChip->setOn(_folders.has_value());
	_canvasChip->setEnabled(hasCanvasNotes);
	_tools->resizeToWidth(std::max(width() - 2 * Rem(0.625), 1));
	_tools->moveToLeft(Rem(0.625), Rem(0.625));
}

void NotesGraph::toggleFolderMenu() {
	if (_folderMenu) {
		_folderMenu = nullptr;
		refreshTools();
		return;
	}
	auto options = std::vector<FolderMenu::Option>();
	options.push_back({ .caption = tr::lng_parvane_notes_graph_folders_all(tr::now), .on = !_folders });
	for (const auto &folder : _folderOptions) {
		const auto on = _folders && ranges::contains(*_folders, folder.path);
		options.push_back({
			.caption = FolderCaption(folder.path),
			.path = folder.path,
			.count = folder.count,
			.on = on,
			.tone = FolderTone(folder.path),
		});
	}
	const auto menu = Ui::CreateChild<FolderMenu>(this, std::move(options), [=](std::optional<std::string> path) {
		if (!path) {
			pickFolders(std::nullopt);
			_folderMenu = nullptr;
		} else {
			// Папка в списке — галочка: из «всех папок» нажатие оставляет одну, дальше папки добавляются и убираются
			pickFolders(notes::toggleGraphFolder(_folders, *path));
			_folderMenu = nullptr;
			toggleFolderMenu();
			return;
		}
		refreshTools();
	});
	menu->moveToLeft(_tools->x() + _foldersChip->x(), _tools->y() + _tools->height() + Rem(0.375));
	menu->show();
	menu->raise();
	_folderMenu.reset(menu);
	refreshTools();
}

void NotesGraph::pickFolders(std::optional<std::vector<std::string>> folders) {
	const auto resolved = notes::resolveGraphFolders(folders, _folderOptions);
	_savedFolders = resolved;
	PrefSet(notes::kKnowledgeGraphFoldersKey, notes::serializeGraphFolders(resolved));
	rebuild();
	// Заметка в панели ушла с графа вместе со своей папкой — панель закрывается
	if (_pickedId) {
		const auto i = ranges::find(_notes, *_pickedId, [](const notes::NoteRef &note) { return note->id; });
		if (i != _notes.end()) {
			auto options = notes::GraphOptions();
			options.withDays = _withDays;
			options.folders = resolved;
			if (!notes::isNoteInGraph((*i)->folder, (*i)->isDaily, options) && _callbacks.close) {
				_callbacks.close();
			}
		}
	}
}

void NotesGraph::refreshOverlays() {
	// Подсказка режима «Связать»
	const auto linkFrom = _linkFromId ? nodeById(*_linkFromId) : nullptr;
	if (linkFrom) {
		if (!_linkHint) {
			const auto hint = Ui::CreateChild<LinkHint>(
				this,
				tr::lng_parvane_notes_graph_connect_hint(tr::now, lt_name, Q(linkFrom->title)),
				[=] {
					if (_callbacks.linkModeEnd) {
						_callbacks.linkModeEnd();
					}
				});
			hint->show();
			_linkHint.reset(hint);
		}
		const auto hint = static_cast<LinkHint*>(_linkHint.get());
		hint->fitTo(width() - Rem(1.25));
		hint->moveToLeft((width() - hint->width()) / 2, Rem(3.625));
		hint->raise();
	} else {
		_linkHint = nullptr;
	}

	// Крестики выбранной связи
	const auto list = removals();
	if (_removeButtons.size() != list.size()) {
		_removeButtons.clear();
		for (const auto &removal : list) {
			const auto label = (list.size() > 1)
				? tr::lng_parvane_notes_graph_remove_link_from(tr::now, lt_name, Q(removal.from.title))
				: tr::lng_parvane_notes_graph_remove_link(tr::now);
			const auto button = Ui::CreateChild<RemoveButton>(this, label);
			button->setToolTip(label);
			const auto fromId = removal.from.id;
			button->setClickedCallback([=] { removeLink(fromId); });
			button->show();
			_removeButtons.emplace_back(button);
		}
	}
	for (auto i = 0; i != int(list.size()); ++i) {
		const auto button = _removeButtons[i].get();
		const auto at = toScreen(list[i].spot);
		button->move(int(at.x()) - button->width() / 2, int(at.y()) - button->height() / 2);
		button->raise();
	}

	// Поле названия новой заметки там, где бросили связь (за край поля не выходит)
	if (_newField && _newAt) {
		const auto at = toScreen(_newAt->at);
		const auto w = std::min(Rem(14), width() - Rem(1.25));
		_newField->resizeToWidth(w);
		const auto x = std::clamp(int(at.x()), Rem(7.75), std::max(width() - Rem(7.75), Rem(7.75)));
		const auto y = std::clamp(int(at.y()), Rem(5), std::max(height() - Rem(2), Rem(5)));
		_newField->move(x - w / 2, y - _newField->height() / 2);
		_newField->raise();
	}

	_zoom->moveToLeft(width() - Rem(0.625) - _zoom->width(), height() - Rem(0.625) - _zoom->height());
	_zoom->raise();
	_tools->raise();
	if (_folderMenu) {
		_folderMenu->raise();
	}
}

void NotesGraph::resizeEvent(QResizeEvent *e) {
	// Панель справа открылась или закрылась: граф остаётся посередине в прежнем масштабе
	const auto previous = e->oldSize();
	if (previous.width() > 0 && previous.width() != width()) {
		_view.x += (width() - previous.width()) / 2.;
		if (_pickedId) {
			reveal(*_pickedId);
		}
	}
	refreshTools();
	maybeFit();
	refreshOverlays();
}

void NotesGraph::clearDraft() {
	_draft = nullptr;
	update();
}

void NotesGraph::setFlash(std::string pair) {
	_flash = std::move(pair);
	_flashTimer.callOnce(kFlashMs);
	update();
}

void NotesGraph::connect(const std::string &fromId, const notes::GraphNode &to) {
	clearDraft();
	if (!_callbacks.link) {
		return;
	}
	const auto weak = base::make_weak(this);
	const auto pair = PairOf(fromId, to.id);
	_callbacks.link(fromId, to.title, [=](GraphLinkOutcome outcome) {
		if (weak && (outcome == GraphLinkOutcome::Added || outcome == GraphLinkOutcome::Exists)) {
			setFlash(pair);
		}
	});
}

void NotesGraph::cancelNew() {
	_newAt = nullptr;
	if (_newField) {
		_newField = nullptr;
	}
	clearDraft();
	setFocus();
}

void NotesGraph::submitNew(const QString &title) {
	if (!_newAt) {
		return;
	}
	const auto at = *_newAt;
	cancelNew();
	const auto trimmed = title.trimmed();
	if (trimmed.isEmpty() || !_callbacks.linkNew) {
		return;
	}
	const auto spot = at.at;
	// Новая заметка встаёт туда, где бросили связь: место ждёт её под названием
	PlacedById()[notes::kMissingNodePrefix + notes::normalizeNoteTitle(S(trimmed))] = spot;
	const auto weak = base::make_weak(this);
	const auto from = at.from;
	_callbacks.linkNew(from, S(trimmed), [=](std::optional<std::string> id) {
		if (!weak || !id) {
			return;
		}
		PlacedById()[*id] = spot;
		_moved[*id] = spot;
		refreshNodes();
		setFlash(PairOf(from, *id));
	});
}

void NotesGraph::removeLink(const std::string &fromId) {
	const auto list = removals();
	auto chosen = std::optional<Removal>();
	for (const auto &removal : list) {
		if (removal.from.id == fromId) {
			chosen = removal;
		}
	}
	if (!chosen && !list.empty()) {
		chosen = list.front();
	}
	_pickedEdge = std::nullopt;
	refreshOverlays();
	update();
	if (chosen && _callbacks.unlink) {
		_callbacks.unlink(chosen->from.id, chosen->to.title);
	}
}

// ── ввод ─────────────────────────────────────────────────────────────────────

void NotesGraph::mousePressEvent(QMouseEvent *e) {
	if (e->button() != Qt::LeftButton) {
		return;
	}
	setFocus();
	if (_folderMenu) {
		// Нажатие мимо списка папок закрывает его
		_folderMenu = nullptr;
		refreshTools();
	}
	const auto pos = e->position();
	const auto world = toWorld(pos);
	const auto handle = handleAt(pos);
	const auto node = handle
		? handle
		: notes::nodeAt(_nodes, world.x, world.y, 0);
	const auto edge = node ? std::nullopt : edgeAt(pos);
	auto drag = std::make_unique<Drag>();
	drag->mode = handle
		? Drag::Mode::Link
		: node
		? Drag::Mode::Node
		: edge
		? Drag::Mode::Edge
		: Drag::Mode::Pan;
	drag->id = node ? node->id : std::string();
	drag->edge = edge.value_or(std::string());
	drag->start = pos;
	drag->origin = (drag->mode == Drag::Mode::Node && node)
		? QPointF(node->x, node->y)
		: QPointF(_view.x, _view.y);
	_drag = std::move(drag);
	if (_drag->mode == Drag::Mode::Pan) {
		setCursor(style::cur_default);
	}
}

void NotesGraph::mouseMoveEvent(QMouseEvent *e) {
	const auto pos = e->position();
	if (!_drag) {
		// Режим «Связать» с мышью: линия тянется за указателем до нажатия
		if (_linkFromId) {
			const auto world = toWorld(pos);
			const auto over = targetAt(world, *_linkFromId);
			_draft = std::make_unique<Draft>(Draft{ world, *_linkFromId, over ? std::make_optional(over->id) : std::nullopt });
			update();
			return;
		}
		// Наведение: кольцо вокруг заметки и курсор
		const auto world = toWorld(pos);
		const auto node = notes::nodeAt(_nodes, world.x, world.y, kHandleGap + 2);
		const auto hover = node ? std::make_optional(node->id) : std::nullopt;
		if (hover != _hoverId) {
			_hoverId = hover;
			update();
		}
		setCursor(handleAt(pos)
			? style::cur_cross
			: (node || edgeAt(pos))
			? style::cur_pointer
			: style::cur_default);
		return;
	}
	auto &drag = *_drag;
	const auto delta = pos - drag.start;
	if (!drag.hasMoved && std::abs(delta.x()) + std::abs(delta.y()) < kDragThreshold) {
		return;
	}
	drag.hasMoved = true;
	if (drag.mode == Drag::Mode::Link) {
		const auto world = toWorld(pos);
		const auto over = targetAt(world, drag.id);
		_draft = std::make_unique<Draft>(Draft{ world, drag.id, over ? std::make_optional(over->id) : std::nullopt });
		update();
	} else if (drag.mode == Drag::Mode::Node) {
		const auto at = notes::GraphPoint{
			drag.origin.x() + delta.x() / _view.scale,
			drag.origin.y() + delta.y() / _view.scale,
		};
		drag.at = at;
		_moved[drag.id] = at;
		refreshNodes();
		refreshOverlays();
		update();
	} else {
		_view.x = drag.origin.x() + delta.x();
		_view.y = drag.origin.y() + delta.y();
		refreshOverlays();
		update();
	}
}

void NotesGraph::mouseReleaseEvent(QMouseEvent *e) {
	if (e->button() != Qt::LeftButton || !_drag) {
		return;
	}
	const auto drag = std::move(_drag);
	const auto pos = e->position();
	if (drag->hasMoved) {
		if (drag->mode == Drag::Mode::Node) {
			// Место, куда точку поставили руками, она сохраняет
			if (drag->at) {
				PlacedById()[drag->id] = *drag->at;
			}
			return;
		}
		if (drag->mode != Drag::Mode::Link) {
			return;
		}
		// Связь отпущена: на заметке — ссылка, на пустом месте — вопрос о названии новой заметки
		const auto world = toWorld(pos);
		const auto over = notes::nodeAt(_nodes, world.x, world.y, kDropSlop / _view.scale);
		if (const auto to = targetAt(world, drag->id)) {
			connect(drag->id, *to);
		} else if (over) {
			clearDraft();
		} else {
			clearDraft();
			_newAt = std::make_unique<Draft>(Draft{ world, drag->id, std::nullopt });
			const auto field = Ui::CreateChild<Kit::Field>(
				this,
				Kit::Field::Kind::Input,
				tr::lng_parvane_notes_graph_new_linked());
			field->input()->setMaxLength(kNewTitleMax);
			field->input()->setAccessibleName(tr::lng_parvane_notes_graph_new_linked(tr::now));
			field->submits() | rpl::on_next([=] {
				submitNew(field->text());
			}, field->lifetime());
			field->cancels() | rpl::on_next([=] {
				crl::on_main(this, [=] { cancelNew(); });
			}, field->lifetime());
			field->input()->focusedChanges() | rpl::filter(!rpl::mappers::_1) | rpl::on_next([=] {
				crl::on_main(this, [=] {
					if (_newAt) {
						cancelNew();
					}
				});
			}, field->lifetime());
			field->show();
			_newField.reset(field);
			refreshOverlays();
			field->setFocusFast();
		}
		update();
		return;
	}
	const auto node = drag->id.empty() ? nullptr : nodeById(drag->id);
	if (_linkFromId) {
		// Режим «Связать»: нажатая заметка получает ссылку, нажатие мимо точек выходит из режима
		const auto from = *_linkFromId;
		if (!node) {
			if (_callbacks.linkModeEnd) {
				_callbacks.linkModeEnd();
			}
		} else if (node->id != from && notes::canLinkTo(node)) {
			const auto copy = *node;
			connect(from, copy);
			if (_callbacks.linkModeEnd) {
				_callbacks.linkModeEnd();
			}
		}
		return;
	}
	if (!drag->edge.empty()) {
		_pickedEdge = drag->edge;
		refreshOverlays();
		update();
		return;
	}
	if (_pickedEdge) {
		_pickedEdge = std::nullopt;
		refreshOverlays();
		update();
	}
	// Нажатие мимо точек выбор не снимает: панель закрывает её крестик
	if (!node) {
		return;
	}
	// Нажатие без движения выбирает точку; второе подряд открывает заметку
	const auto now = crl::now();
	const auto isDouble = (_lastTap.id == node->id) && (now - _lastTap.at < kDoubleTapMs);
	_lastTap = { node->id, now };
	const auto pick = GraphPick{ node->id, node->kind, node->title, node->group };
	if (isDouble) {
		if (_callbacks.open) {
			_callbacks.open(pick);
		}
	} else if (_callbacks.pick) {
		_callbacks.pick(pick);
	}
}

void NotesGraph::mouseDoubleClickEvent(QMouseEvent *e) {
	// Qt отдаёт второе нажатие двойным: оно идёт тем же путём, что и в web (нажатие + отпускание)
	mousePressEvent(e);
}

void NotesGraph::wheelEvent(QWheelEvent *e) {
	const auto pixel = e->pixelDelta().y();
	const auto delta = pixel ? -double(pixel) : -e->angleDelta().y() * 100. / 120.;
	const auto pos = e->position();
	applyView(notes::zoomByWheel(_view, delta, pos.x(), pos.y()));
	e->accept();
}

void NotesGraph::keyPressEvent(QKeyEvent *e) {
	const auto key = e->key();
	if (key == Qt::Key_Escape) {
		// Escape по очереди: название новой заметки, список папок, режим «Связать», выбранная линия, панель
		if (_newAt) {
			cancelNew();
		} else if (_folderMenu) {
			_folderMenu = nullptr;
			refreshTools();
		} else if (_linkFromId) {
			if (_callbacks.linkModeEnd) {
				_callbacks.linkModeEnd();
			}
		} else if (_pickedEdge) {
			_pickedEdge = std::nullopt;
			refreshOverlays();
			update();
		} else if (_callbacks.close) {
			_callbacks.close();
		}
		return;
	} else if ((key == Qt::Key_Delete || key == Qt::Key_Backspace) && _pickedEdge) {
		// Delete убирает выбранную связь
		removeLink(std::string());
		return;
	}
	RpWidget::keyPressEvent(e);
}

void NotesGraph::leaveEventHook(QEvent *e) {
	if (_hoverId) {
		_hoverId = std::nullopt;
		update();
	}
}

// ── рисование ────────────────────────────────────────────────────────────────

void NotesGraph::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);

	// Поле: `color-mix(--pv-bg 55%, --pv-panel)` и точечная сетка `--pv-line2`, едущая с полем
	const auto bg = ToneColor(Tone::Bg);
	const auto panel = ToneColor(Tone::Panel);
	p.fillRect(rect(), QColor(
		int(bg.red() * 0.55 + panel.red() * 0.45),
		int(bg.green() * 0.55 + panel.green() * 0.45),
		int(bg.blue() * 0.55 + panel.blue() * 0.45)));
	const auto cell = notes::kBoardGrid * _view.scale;
	if (cell >= 4.) {
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Line2));
		const auto startX = std::fmod(_view.x, cell);
		const auto startY = std::fmod(_view.y, cell);
		for (auto x = (startX < 0 ? startX + cell : startX); x < width(); x += cell) {
			for (auto y = (startY < 0 ? startY + cell : startY); y < height(); y += cell) {
				p.drawEllipse(QPointF(x, y), 1., 1.);
			}
		}
	}

	if (_nodes.empty()) {
		// `.boardEmpty`: подсказка посередине
		const auto font = Kit::Font(Kit::kBodyPx);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Muted));
		const auto w = std::min(font->width(QChar('0')) * 36, width() - Rem(2));
		p.drawText(
			QRect((width() - w) / 2, 0, w, height()),
			Qt::AlignCenter | Qt::TextWordWrap,
			tr::lng_parvane_notes_graph_empty(tr::now));
		return;
	}

	p.save();
	p.translate(_view.x, _view.y);
	p.scale(_view.scale, _view.scale);

	const auto picked = (_pickedId && nodeById(*_pickedId)) ? _pickedId : std::nullopt;
	const auto neighbours = picked ? notes::neighboursOf(*picked, _edges) : std::set<std::string>();
	const auto source = linkSourceId();
	auto found = std::optional<std::set<std::string>>();
	if (!notes::graphQueryText(S(_query)).empty()) {
		found.emplace();
		for (const auto &node : _nodes) {
			if (isFound(node)) {
				found->emplace(node.id);
			}
		}
	}

	// Связи
	for (const auto &edge : _edges) {
		const auto from = nodeById(edge.from);
		const auto to = nodeById(edge.to);
		if (!from || !to) {
			continue;
		}
		const auto key = KeyOf(edge);
		const auto shape = notes::edgeShape(
			{ from->x, from->y },
			{ to->x, to->y },
			notes::nodeRadius(from->degree),
			notes::nodeRadius(to->degree),
			edge.isMutual);
		const auto isOn = picked && (*picked == edge.from || *picked == edge.to);
		// Пока ведут связь, граф виден целиком: любая заметка — цель
		const auto isDim = !source
			&& (found ? !(found->contains(edge.from) && found->contains(edge.to)) : (picked && !isOn));
		const auto isPicked = (_pickedEdge && *_pickedEdge == key);
		const auto isFlash = (_flash && *_flash == PairOf(edge.from, edge.to));
		auto color = ToneColor(Tone::Line2);
		auto widthF = 1.5;
		if (isPicked) {
			color = ToneColor(Tone::Accent);
			widthF = 3.5;
		} else if (isFlash) {
			color = ToneColor(Tone::Accent);
			widthF = 5.;
		} else if (isOn && !isDim) {
			color = ToneColor(Tone::Accent);
			widthF = 2.5;
		}
		p.setOpacity((isDim && !isPicked) ? 0.15 : 1.);
		auto pen = QPen(color, widthF);
		pen.setCapStyle(Qt::FlatCap);
		p.setPen(pen);
		p.drawLine(QPointF(shape.x1, shape.y1), QPointF(shape.x2, shape.y2));
		p.setPen(Qt::NoPen);
		p.setBrush(color);
		for (const auto &head : shape.heads) {
			p.drawPolygon(HeadPolygon(head));
		}
	}
	p.setOpacity(1.);

	// Связь, которую ведут от заметки
	const auto line = _newAt ? _newAt.get() : _draft.get();
	if (line) {
		if (const auto from = nodeById(line->from)) {
			auto pen = QPen(ToneColor(Tone::Accent), 2.);
			pen.setDashPattern({ 3., 2.5 });
			pen.setCapStyle(Qt::RoundCap);
			p.setPen(pen);
			p.drawLine(QPointF(from->x, from->y), QPointF(line->at.x, line->at.y));
		}
	}

	// Точки
	const auto areLabelsShown = (_view.scale >= kLabelMinScale);
	const auto font = Kit::Font(12);
	const auto overId = line ? line->overId : std::nullopt;
	for (const auto &node : _nodes) {
		const auto radius = notes::nodeRadius(node.degree);
		const auto isPicked = picked && (*picked == node.id);
		const auto isNear = isPicked || (picked && neighbours.contains(node.id));
		const auto isFoundNode = found && found->contains(node.id);
		const auto isTarget = overId && (*overId == node.id);
		const auto isSource = source && (*source == node.id);
		const auto isDim = source
			? (!isSource && !notes::canLinkTo(&node))
			: found
			? !isFoundNode
			: (picked && !isNear);
		const auto hasLabel = areLabelsShown || isNear || isFoundNode || isTarget || isSource;
		p.setOpacity(isDim ? 0.15 : 1.);
		const auto center = QPointF(node.x, node.y);
		auto fill = ToneColor(NodeTone(node));
		if (node.kind == notes::GraphNodeKind::Missing) {
			fill.setAlphaF(fill.alphaF() * 0.35);
		}
		auto stroke = ToneColor(Tone::Bg);
		auto strokeWidth = 2.;
		if (isTarget) {
			stroke = ToneColor(Tone::Accent);
			strokeWidth = 5.;
		} else if (isFoundNode) {
			stroke = ToneColor(Tone::Fg);
			strokeWidth = 3.;
		} else if (isPicked) {
			stroke = ToneColor(Tone::Accent);
			strokeWidth = 3.;
		}
		p.setPen(QPen(stroke, strokeWidth));
		p.setBrush(fill);
		p.drawEllipse(center, radius, radius);
		// Кольцо вокруг заметки: за него тянут связь. Видно под указателем и у выбранной заметки
		const auto ringShown = notes::canLinkFrom(&node)
			&& (isPicked || isSource || (_hoverId && *_hoverId == node.id && !source));
		if (ringShown) {
			auto ring = Kit::Mix(Tone::Accent, 0.7);
			auto pen = QPen(ring, 4.);
			pen.setDashPattern({ 0.75, 0.75 });
			p.setPen(pen);
			p.setBrush(Qt::NoBrush);
			p.drawEllipse(center, radius + kHandleGap, radius + kHandleGap);
		}
		if (hasLabel) {
			const auto label = Q(notes::shortenLabel(S(labelOf(node)), notes::kGraphLabelMax));
			const auto w = font->width(label);
			auto path = QPainterPath();
			path.addText(QPointF(node.x - w / 2., node.y + radius + kLabelGap), font->f, label);
			auto halo = QPen(ToneColor(Tone::Bg), 4.);
			halo.setJoinStyle(Qt::RoundJoin);
			p.strokePath(path, halo);
			p.fillPath(path, ToneColor(Tone::Fg));
		}
	}
	p.setOpacity(1.);
	p.restore();
}

} // namespace Parvane::Knowledge
