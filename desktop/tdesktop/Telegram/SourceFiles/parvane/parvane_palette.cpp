// Parvane fork: реализация parvane_palette.h — окно и строки как web `ParvanePalette.tsx` /
// `ParvanePalette.module.scss` (шторка `.sheetTight`, строка `.row` с плиткой `.ava` 2.125rem, совпадения `.mark`
// полужирным акцентом, отрывок `.sub`, справа `.meta`, группы `.grp`). Поиск — с задержкой 120 мс после нажатия;
// Enter ищет по набранному сразу. Стрелки двигают выбор по кольцу, Escape закрывает.
#include "parvane/parvane_palette.h"

#include "parvane/parvane_cloud.h"
#include "parvane/parvane_cloud_internal.h"
#include "parvane/parvane_health.h"
#include "parvane/parvane_icons.h"
#include "parvane/parvane_kit.h"
#include "parvane/parvane_knowledge.h"
#include "parvane/parvane_knowledge_common.h"
#include "parvane/parvane_planner_common.h"
#include "parvane/parvane_planner_forms.h"
#include "parvane/parvane_sections_data.h"
#include "parvane/parvane_space.h"

#include "base/event_filter.h"
#include "core/shortcuts.h"
#include "data/data_folder.h"
#include "data/data_peer.h"
#include "data/data_session.h"
#include "data/data_user.h"
#include "dialogs/dialogs_indexed_list.h"
#include "dialogs/dialogs_main_list.h"
#include "dialogs/dialogs_row.h"
#include "history/history.h"
#include "lang/lang_keys.h"
#include "main/main_session.h"
#include "mainwindow.h"
#include "ui/painter.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/scroll_area.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"

#include <parvane/sections/cloud_model.h>
#include <parvane/sections/palette_records.h>
#include <parvane/sections/palette_search.h>

#include <crl/crl_on_main.h>

#include <QtCore/QPointer>
#include <QtCore/QTimer>
#include <QtGui/QKeyEvent>
#include <QtWidgets/QTextEdit>

#include <set>

namespace Parvane {
namespace {

namespace palette = parvane::sections::palette;
namespace cloud = parvane::sections::cloud;

// Задержка поиска после последнего нажатия: ввод не ждёт перебора заметок и записей
constexpr auto kSearchDelayMs = 120;

[[nodiscard]] QString Q(const std::string &value) {
	return QString::fromStdString(value);
}

[[nodiscard]] std::string S(const QString &value) {
	return value.toStdString();
}

// Строка палитры: запись для поиска и что сделать по Enter
struct Entry {
	palette::PaletteItem item;
	QString icon;
	QColor tone; // цвет плитки значка (`--c`)
	QString meta;
	Fn<void()> run;
};

// Найденное: строка, совпадения в названии и отрывок
struct Found {
	const Entry *entry = nullptr;
	std::vector<palette::PalettePart> title;
	std::vector<palette::PalettePart> snippet;
};

struct Group {
	QString title;
	std::vector<Found> rows;
};

[[nodiscard]] std::vector<palette::PalettePart> PartsOf(
		const std::string &text,
		const std::vector<palette::PaletteRange> &ranges) {
	return ranges.empty()
		? std::vector<palette::PalettePart>{ { text, false } }
		: palette::splitByRanges(text, ranges);
}

// Куски строки с выделением совпадений — в одну строку с многоточием
void DrawParts(
		QPainter &p,
		const std::vector<palette::PalettePart> &parts,
		int x,
		int baseline,
		int right,
		int px,
		QColor color) {
	const auto plain = Kit::Font(px);
	const auto marked = Kit::Font(px, true);
	const auto accent = ToneColor(Tone::Accent);
	for (const auto &part : parts) {
		if (x >= right) {
			break;
		}
		const auto &font = part.isMatch ? marked : plain;
		auto text = Q(part.text);
		text.replace(u'\n', u' ');
		const auto width = font->width(text);
		const auto available = right - x;
		const auto shown = (width > available) ? font->elided(text, available) : text;
		p.setFont(font->f);
		p.setPen(part.isMatch ? accent : color);
		p.drawText(x, baseline, shown);
		x += font->width(shown);
		if (width > available) {
			break;
		}
	}
}

// `.row` палитры: плитка со значком тоном записи, название с совпадениями, отрывок, справа `.meta`
class PaletteRow final : public Kit::Button {
public:
	PaletteRow(QWidget *parent, const Found &found)
	: Button(parent)
	, _title(found.title)
	, _snippet(found.snippet)
	, _icon(found.entry->icon)
	, _tone(found.entry->tone)
	, _meta(found.entry->meta) {
		auto name = QString();
		for (const auto &part : _title) {
			name += Q(part.text);
		}
		setAccessibleName(name);
		resize(width(), resizeGetHeight(width()));
	}

	void setSelected(bool selected) {
		if (_selected != selected) {
			_selected = selected;
			update();
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		// `.row`: мин. 2.75rem, поля 0.375rem; плитка 2.125rem
		const auto text = Kit::Font(Kit::kBodyPx)->height
			+ (_snippet.empty() ? 0 : Kit::Font(13)->height);
		return std::max({ Kit::Rem(2.75), Kit::Rem(2.125) + 2 * Kit::Rem(0.375), text + 2 * Kit::Rem(0.375) });
	}

	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto r = rect();
		const auto radius = double(Kit::Rem(0.5));
		if (_selected || isOver()) {
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor(Tone::Hover));
			p.drawRoundedRect(r, radius, radius);
		}
		paintFocusRing(p, QRectF(r), radius);

		const auto padX = Kit::Rem(0.625);
		const auto gap = Kit::Rem(0.75);
		// Плитка `.ava` 2.125rem: тон на 22 %, значок тоном
		const auto tile = Kit::Rem(2.125);
		const auto tileRect = QRect(padX, (height() - tile) / 2, tile, tile);
		p.setPen(Qt::NoPen);
		p.setBrush(Kit::Mix(_tone, 0.22));
		const auto tileRadius = double(Kit::Rem(0.625));
		p.drawRoundedRect(tileRect, tileRadius, tileRadius);
		const auto iconSize = Kit::Px(18);
		PaintIcon(
			p,
			_icon,
			_tone,
			tileRect.x() + (tile - iconSize) / 2,
			tileRect.y() + (tile - iconSize) / 2,
			iconSize);

		auto right = width() - padX;
		if (!_meta.isEmpty()) {
			const auto meta = Kit::Font(13, false, true);
			const auto metaWidth = std::min(meta->width(_meta), width() / 3);
			p.setFont(meta->f);
			p.setPen(ToneColor(Tone::Muted));
			p.drawText(
				right - metaWidth,
				(height() - meta->height) / 2 + meta->ascent,
				meta->elided(_meta, metaWidth));
			right -= metaWidth + gap;
		}
		const auto left = tileRect.x() + tile + gap;
		const auto titleFont = Kit::Font(Kit::kBodyPx);
		const auto subFont = Kit::Font(13);
		const auto textHeight = titleFont->height + (_snippet.empty() ? 0 : subFont->height);
		const auto top = (height() - textHeight) / 2;
		DrawParts(p, _title, left, top + titleFont->ascent, right, Kit::kBodyPx, ToneColor(Tone::Fg));
		if (!_snippet.empty()) {
			DrawParts(
				p,
				_snippet,
				left,
				top + titleFont->height + subFont->ascent,
				right,
				13,
				ToneColor(Tone::Muted));
		}
	}

private:
	std::vector<palette::PalettePart> _title;
	std::vector<palette::PalettePart> _snippet;
	QString _icon;
	QColor _tone;
	QString _meta;
	bool _selected = false;

};

class Palette final {
public:
	Palette(not_null<Window::SessionController*> controller, not_null<Kit::Sheet*> sheet);

	void focus();

private:
	void collect();
	void search();
	void render();
	void select(int index);
	void move(int delta);
	void runSelected();
	void close(Fn<void()> after);

	[[nodiscard]] std::vector<Entry> commands() const;
	[[nodiscard]] std::vector<Entry> chats() const;
	[[nodiscard]] std::vector<Entry> notes() const;
	[[nodiscard]] std::vector<Entry> records() const;
	[[nodiscard]] std::vector<Entry> files() const;
	[[nodiscard]] bool isLoading() const;

	const not_null<Window::SessionController*> _controller;
	const QPointer<Kit::Sheet> _sheet;
	Kit::Field *_field = nullptr;
	Ui::VerticalLayout *_list = nullptr;
	QTimer _timer;

	std::vector<Entry> _chats; // на момент открытия: пока палитра открыта, список почти не меняется
	std::vector<Entry> _items; // команды, чаты, заметки, записи — порядок групп ядра
	std::vector<Entry> _files;
	QString _query;
	QString _searched;
	std::vector<Group> _groups;
	std::vector<PaletteRow*> _rows;
	std::vector<const Entry*> _flat;
	int _selected = 0;

};

Palette::Palette(not_null<Window::SessionController*> controller, not_null<Kit::Sheet*> sheet)
: _controller(controller)
, _sheet(sheet.get()) {
	// Поле поиска остаётся на месте, прокручивается только список (web `.form { position: sticky }`): поле —
	// на подложке цвета окна поверх верха прокрутки шторки, в начале списка — отступ его высоты
	const auto spacer = sheet->add(object_ptr<Ui::RpWidget>(sheet->content()));
	const auto holder = Ui::CreateChild<Ui::RpWidget>(sheet.get());
	holder->paintRequest() | rpl::on_next([=](QRect clip) {
		QPainter(holder).fillRect(clip, ToneColor(Tone::Panel));
	}, holder->lifetime());
	_field = Ui::CreateChild<Kit::Field>(
		holder,
		Kit::Field::Kind::Search,
		rpl::single(tr::lng_parvane_palette_placeholder(tr::now)));
	_list = sheet->add(object_ptr<Ui::VerticalLayout>(sheet->content()));
	auto scroll = static_cast<Ui::ScrollArea*>(nullptr);
	for (auto w = sheet->content()->parentWidget(); w && !scroll; w = w->parentWidget()) {
		scroll = dynamic_cast<Ui::ScrollArea*>(w);
	}
	if (scroll) {
		const auto place = [=] {
			// `.form`: поля 1rem сверху, 0.5rem снизу
			const auto top = Kit::Rem(1);
			const auto bottom = Kit::Rem(0.5);
			// Прокрутка — не прямой ребёнок шторки: её место — в координатах шторки
			const auto origin = scroll->mapTo(sheet.get(), QPoint());
			const auto width = scroll->width();
			_field->resizeToWidth(width);
			_field->move(0, top);
			const auto height = top + _field->height() + bottom;
			holder->setGeometry(origin.x(), origin.y(), width, height);
			holder->show();
			holder->raise();
			if (spacer->height() != height) {
				spacer->resize(spacer->width(), height);
			}
		};
		base::install_event_filter(holder, scroll, [=](not_null<QEvent*> e) {
			if (e->type() == QEvent::Move || e->type() == QEvent::Resize) {
				place();
			}
			return base::EventFilterResult::Continue;
		});
		_field->heightValue() | rpl::on_next(place, holder->lifetime());
		place();
	}

	_timer.setSingleShot(true);
	QObject::connect(&_timer, &QTimer::timeout, [=] {
		search();
	});
	_field->textChanges() | rpl::on_next([=](const QString &text) {
		_query = text;
		_selected = 0;
		_timer.start(kSearchDelayMs);
	}, _field->lifetime());
	_field->submits() | rpl::on_next([=] {
		runSelected();
	}, _field->lifetime());
	_field->cancels() | rpl::on_next([=] {
		close(nullptr);
	}, _field->lifetime());
	// Стрелки — из поля: фокус остаётся в нём, выбор ходит по списку кольцом
	base::install_event_filter(_field->input()->rawTextEdit(), [=](not_null<QEvent*> e) {
		if (e->type() != QEvent::KeyPress) {
			return base::EventFilterResult::Continue;
		}
		const auto key = static_cast<QKeyEvent*>(e.get())->key();
		if (key == Qt::Key_Up || key == Qt::Key_Down) {
			move(key == Qt::Key_Up ? -1 : 1);
			return base::EventFilterResult::Cancel;
		}
		return base::EventFilterResult::Continue;
	});

	// Данные разделов приходят по мере чтения: найденное появляется в списке само
	rpl::merge(
		Sections::NotesValue() | rpl::to_empty,
		Sections::PlannerValue() | rpl::to_empty,
		Sections::CloudValue() | rpl::to_empty,
		TonesChanges()
	) | rpl::on_next([=] {
		collect();
		search();
	}, _list->lifetime());

	_chats = chats();
	collect();
	search();
}

void Palette::focus() {
	if (_field) {
		_field->setFocusFast();
	}
}

void Palette::collect() {
	_items.clear();
	for (auto &&list : { commands(), _chats, notes(), records() }) {
		for (const auto &entry : list) {
			_items.push_back(entry);
		}
	}
	_files = files();
}

std::vector<Entry> Palette::commands() const {
	const auto controller = _controller;
	const auto accent = ToneColor(Tone::Accent);
	const auto command = [&](const char *key, const QString &title, const QString &icon, Fn<void()> run) {
		auto item = palette::PaletteItem();
		item.key = key;
		item.group = palette::PaletteGroup::Command;
		item.title = S(title);
		return Entry{ palette::withNormalized(std::move(item)), icon, accent, QString(), std::move(run) };
	};
	return {
		command("nav:chats", tr::lng_parvane_rail_chats(tr::now), u"chat"_q, [] {
			ShowSection(Section::Chats);
		}),
		command("nav:today", tr::lng_parvane_planner_today(tr::now), u"sun"_q, [] {
			ShowSection(Section::Calendar);
		}),
		command("nav:calendar", tr::lng_parvane_rail_calendar(tr::now), u"calendar"_q, [] {
			ShowSection(Section::Calendar);
		}),
		command("nav:knowledge", tr::lng_parvane_rail_knowledge(tr::now), u"book"_q, [] {
			ShowSection(Section::Knowledge);
		}),
		command("nav:health", tr::lng_parvane_rail_health(tr::now), u"heart"_q, [] {
			ShowSection(Section::Health);
		}),
		command("nav:cloud", tr::lng_parvane_rail_cloud(tr::now), u"cloud"_q, [] {
			ShowSection(Section::Files);
		}),
		command("quick", tr::lng_parvane_planner_quick_title(tr::now), u"plus"_q, [=] {
			Health::OpenQuickEntry(controller, QString());
		}),
		command("quick:sleep", tr::lng_parvane_palette_log_sleep(tr::now), u"plus"_q, [=] {
			Health::OpenQuickEntry(controller, tr::lng_parvane_palette_sleep_text(tr::now) + ' ');
		}),
		command("quick:food", tr::lng_parvane_palette_log_food(tr::now), u"plus"_q, [=] {
			Health::OpenQuickEntry(controller, tr::lng_parvane_palette_food_text(tr::now) + ' ');
		}),
		// Заметка с таким названием уже есть — откроется она, иначе раздел создаст новую
		command("newnote", tr::lng_parvane_notes_new_note(tr::now), u"note"_q, [] {
			OpenKnowledgeNote(tr::lng_parvane_notes_new_note(tr::now));
		}),
		command("settings", tr::lng_parvane_planner_settings(tr::now), u"sliders"_q, [=] {
			PlannerUi::OpenPlannerSettings(controller);
		}),
	};
}

// Чаты и контакты, известные устройству: названия уже в памяти, запросов к серверу нет
std::vector<Entry> Palette::chats() const {
	const auto controller = _controller;
	const auto session = &controller->session();
	auto result = std::vector<Entry>();
	auto seen = std::set<PeerId>();
	const auto tone = ToneColor(Tone::Muted);
	const auto add = [&](not_null<PeerData*> peer) {
		if (!seen.insert(peer->id).second) {
			return;
		}
		const auto title = peer->isSelf() ? tr::lng_saved_messages(tr::now) : peer->name();
		if (title.isEmpty()) {
			return;
		}
		auto item = palette::PaletteItem();
		item.key = "chat:" + std::to_string(peer->id.value);
		item.group = palette::PaletteGroup::Chat;
		item.title = S(title);
		const auto id = peer->id;
		result.push_back(Entry{ palette::withNormalized(std::move(item)), u"chat"_q, tone, QString(), [=] {
			ShowSection(Section::Chats);
			controller->showPeerHistory(id);
		} });
	};
	const auto addList = [&](not_null<Dialogs::IndexedList*> list) {
		for (const auto &row : list->all()) {
			if (const auto history = row->history()) {
				add(history->peer);
			}
		}
	};
	addList(session->data().chatsList()->indexed());
	if (const auto folder = session->data().folderLoaded(Data::Folder::kId)) {
		addList(folder->chatsList()->indexed());
	}
	addList(session->data().contactsNoChatsList());
	// «Избранное» есть всегда, даже пока в нём пусто и в списке чатов его нет
	add(session->user().get());
	return result;
}

std::vector<Entry> Palette::notes() const {
	auto result = std::vector<Entry>();
	const auto view = Sections::Notes();
	if (!view) {
		return result;
	}
	for (const auto &note : view->notes) {
		if (!note) {
			continue;
		}
		auto item = palette::PaletteItem();
		item.key = "note:" + note->id;
		item.group = palette::PaletteGroup::Note;
		item.title = note->title;
		item.text = note->text;
		const auto slash = note->folder.find('/');
		const auto id = note->id;
		result.push_back(Entry{
			palette::withNormalized(std::move(item)),
			u"note"_q,
			ToneColor(Knowledge::FolderTone(note->folder, note->isDaily)),
			Q(note->folder.substr(0, slash)),
			[=] { OpenKnowledgeNoteById(id); },
		});
	}
	return result;
}

std::vector<Entry> Palette::records() const {
	auto result = std::vector<Entry>();
	const auto view = Sections::Planner();
	if (!view || !view->isLoaded) {
		return result;
	}
	const auto controller = _controller;
	for (const auto &record : palette::collectPlannerRecords(view->state, PlannerViews::TodayKey())) {
		const auto kind = record.kind;
		const auto id = record.id;
		const auto day = record.day.value_or(std::string());
		const auto look = (kind == "event")
			? std::make_pair(u"calendar"_q, PlannerViews::Kind::Event)
			: (kind == "task")
			? std::make_pair(u"check"_q, PlannerViews::Kind::Task)
			: std::make_pair(u"heart"_q, PlannerViews::Kind::Workout);
		// Запись — в своём разделе: задача и событие — окном правки в «Календаре», тренировка — «Здоровье»
		result.push_back(Entry{
			palette::withNormalized(record.item),
			look.first,
			PlannerViews::KindColor(look.second),
			day.empty()
				? tr::lng_parvane_planner_undated_short(tr::now)
				: PlannerViews::FormatDayShort(day),
			[=] {
				if (kind == "workout") {
					ShowSection(Section::Health);
					return;
				}
				ShowSection(Section::Calendar);
				if (kind == "task") {
					PlannerUi::OpenTaskEditor(controller, id, day);
					return;
				}
				// Повторяющееся событие — экземпляр этого дня (окно спросит «только это / все»)
				auto instanceDay = std::string();
				if (const auto now = Sections::Planner()) {
					for (const auto &event : now->state.events) {
						if (event.id == id && event.repeat) {
							instanceDay = day;
						}
					}
				}
				PlannerUi::OpenEventEditor(controller, id, day, instanceDay);
			},
		});
	}
	return result;
}

// Файлы и папки облака (в web палитра их не ищет — здесь по T065): личный диск и совместные папки, без корзины,
// служебных файлов и заметок «Знаний» (они — в группе заметок)
std::vector<Entry> Palette::files() const {
	auto result = std::vector<Entry>();
	const auto &data = Cloud::Current();
	const auto tone = ToneColor(Tone::Aqua);
	for (const auto &container : data.containers) {
		if (container.kind == "invite") {
			continue;
		}
		const auto place = (container.kind == "root")
			? tr::lng_parvane_cloud_drive(tr::now)
			: Cloud::ContainerName(&container);
		for (const auto &node : cloud::listedNodes(Cloud::NodesOf(container.id))) {
			if (node.trashed || node.name.empty()) {
				continue;
			}
			const auto name = Q(node.name);
			if (!node.isFolder()
				&& (name.endsWith(u".md"_q, Qt::CaseInsensitive)
					|| name.endsWith(u".canvas"_q, Qt::CaseInsensitive))) {
				continue;
			}
			auto item = palette::PaletteItem();
			item.key = "file:" + container.id + "/" + node.id;
			item.group = palette::PaletteGroup::Note;
			item.title = node.name;
			const auto containerId = container.id;
			const auto nodeId = node.id;
			result.push_back(Entry{
				palette::withNormalized(std::move(item)),
				node.isFolder() ? u"folder"_q : u"cloud"_q,
				tone,
				place,
				[=] { OpenCloudNode(containerId, nodeId); },
			});
		}
	}
	return result;
}

bool Palette::isLoading() const {
	const auto notes = Sections::Notes();
	const auto planner = Sections::Planner();
	return (notes && notes->status == parvane::sections::notes::NotesStatus::Loading)
		|| (planner && !planner->isLoaded && planner->status == "loading");
}

void Palette::search() {
	_timer.stop();
	_searched = _query;
	const auto query = S(_query);
	auto items = std::vector<palette::PaletteItem>();
	items.reserve(_items.size());
	for (const auto &entry : _items) {
		items.push_back(entry.item);
	}
	_groups.clear();
	for (const auto &section : palette::searchPalette(items, query)) {
		auto group = Group();
		switch (section.group) {
		case palette::PaletteGroup::Command: group.title = tr::lng_parvane_palette_commands(tr::now); break;
		case palette::PaletteGroup::Chat: group.title = tr::lng_parvane_rail_chats(tr::now); break;
		case palette::PaletteGroup::Note: group.title = tr::lng_parvane_notes_tab_notes(tr::now); break;
		case palette::PaletteGroup::Record: group.title = tr::lng_parvane_palette_records(tr::now); break;
		}
		for (const auto &found : section.results) {
			const auto &entry = _items[found.index];
			group.rows.push_back(Found{
				&entry,
				PartsOf(entry.item.title, found.ranges),
				found.snippet ? PartsOf(found.snippet->text, found.snippet->ranges) : std::vector<palette::PalettePart>(),
			});
		}
		_groups.push_back(std::move(group));
	}
	// Файлы — своей группой после записей (пустой запрос их не показывает, как и всё, кроме команд)
	if (!_files.empty() && !_query.trimmed().isEmpty()) {
		auto fileItems = std::vector<palette::PaletteItem>();
		fileItems.reserve(_files.size());
		for (const auto &entry : _files) {
			fileItems.push_back(entry.item);
		}
		for (const auto &section : palette::searchPalette(fileItems, query)) {
			auto group = Group{ tr::lng_parvane_palette_files(tr::now) };
			for (const auto &found : section.results) {
				const auto &entry = _files[found.index];
				group.rows.push_back(Found{ &entry, PartsOf(entry.item.title, found.ranges), {} });
			}
			_groups.push_back(std::move(group));
		}
	}
	render();
}

void Palette::render() {
	Kit::ClearLayout(_list);
	_rows.clear();
	_flat.clear();
	for (const auto &group : _groups) {
		_list->add(object_ptr<Kit::Caps>(_list, group.title, Kit::Caps::Kind::Group));
		for (const auto &found : group.rows) {
			const auto index = int(_rows.size());
			const auto row = _list->add(
				object_ptr<PaletteRow>(_list, found),
				style::margins(0, Kit::Rem(0.125), 0, 0));
			row->setClickedCallback([=] {
				_selected = index;
				runSelected();
			});
			_rows.push_back(row);
			_flat.push_back(found.entry);
		}
	}
	// Поиск по пустому запросу показывает только команды — это не «ничего не найдено»
	if (_flat.empty() && !_searched.trimmed().isEmpty() && !isLoading()) {
		_list->add(object_ptr<Kit::Label>(_list, tr::lng_parvane_notes_nothing_found(tr::now), Kit::Label::Muted()));
	}
	if (isLoading()) {
		_list->add(
			object_ptr<Kit::Label>(_list, tr::lng_parvane_palette_loading(tr::now), Kit::Label::Small()),
			style::margins(Kit::Rem(0.25), Kit::Rem(0.75), Kit::Rem(0.25), Kit::Rem(0.25)));
	}
	_list->resizeToWidth(_list->width());
	select(std::clamp(_selected, 0, std::max(int(_rows.size()) - 1, 0)));
}

void Palette::select(int index) {
	_selected = index;
	for (auto i = 0; i != int(_rows.size()); ++i) {
		_rows[i]->setSelected(i == index);
	}
	if (index < 0 || index >= int(_rows.size())) {
		return;
	}
	// Выбранная строка — в видимой части прокрутки шторки
	for (auto w = _list->parentWidget(); w; w = w->parentWidget()) {
		if (const auto scroll = dynamic_cast<Ui::ScrollArea*>(w)) {
			const auto row = _rows[index];
			const auto top = row->mapTo(scroll->widget(), QPoint()).y();
			scroll->scrollToY(top, top + row->height());
			break;
		}
	}
}

void Palette::move(int delta) {
	if (_searched != _query) {
		search();
	}
	select(palette::movePaletteIndex(_selected, delta, int(_rows.size())));
}

void Palette::runSelected() {
	// Набранное ещё не искалось — результат по нему считается сейчас, иначе выбор пошёл бы по прежнему списку
	if (_searched != _query) {
		search();
	}
	if (_flat.empty()) {
		return;
	}
	const auto entry = _flat[std::clamp(_selected, 0, int(_flat.size()) - 1)];
	close(entry->run);
}

void Palette::close(Fn<void()> after) {
	if (_sheet) {
		_sheet->requestClose();
	}
	// Действие — после закрытия: окна разделов открываются поверх уже без шторки палитры
	if (after) {
		crl::on_main([after] { after(); });
	}
}

QPointer<Kit::Sheet> &OpenSheet() {
	static auto result = QPointer<Kit::Sheet>();
	return result;
}

} // namespace

void OpenPalette(not_null<Window::SessionController*> controller) {
	if (const auto open = OpenSheet().data()) {
		open->showSheet();
		return;
	}
	const auto sheet = Kit::Sheet::Show(controller->widget()->bodyWidget(), {
		.title = tr::lng_parvane_rail_search(tr::now),
		.closeName = tr::lng_parvane_planner_close(tr::now),
		.tight = true,
	});
	OpenSheet() = sheet.get();
	Sections::SetPaletteOpen(true);
	const auto state = sheet->lifetime().make_state<Palette>(controller, sheet);
	sheet->closed() | rpl::on_next([] {
		Sections::SetPaletteOpen(false);
	}, sheet->lifetime());
	state->focus();
}

void SetupPaletteShortcut(not_null<Window::SessionController*> controller, rpl::lifetime &lifetime) {
	Shortcuts::Requests(
	) | rpl::on_next([=](not_null<Shortcuts::Request*> request) {
		using Command = Shortcuts::Command;
		// Окон может быть несколько — палитру открывает активное
		if (!controller->widget()->isActiveWindow()) {
			return;
		}
		request->check(Command::ParvanePalette, 1) && request->handle([=] {
			OpenPalette(controller);
			return true;
		});
	}, lifetime);
}

} // namespace Parvane
