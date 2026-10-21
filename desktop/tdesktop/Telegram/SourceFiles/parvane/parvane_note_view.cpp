// Parvane fork: реализация parvane_note_view.h. Размеры — web `Knowledge.module.scss` (`.note*`, `.props`, `.prop`,
// `.noteButtons`, `.planned*`, `.editorTools`) и `MediaEmbed.module.scss` (`.card`).
#include "parvane/parvane_note_view.h"

#include "parvane/parvane_icons.h"
#include "parvane/parvane_note_links.h"
#include "parvane/parvane_note_embed.h"
#include "parvane/parvane_note_markdown.h"
#include "parvane/parvane_sections_host.h"
#include "parvane/parvane_space.h"

#include <parvane/sections/cloud_model.h>
#include <parvane/sections/notes_canvas_note.h>
#include <parvane/sections/notes_embeds.h>
#include <parvane/sections/notes_folders.h>
#include <parvane/sections/notes_look.h>
#include <parvane/sections/notes_tasks.h>
#include <parvane/sections/notes_view.h>
#include <parvane/sections/planner_quick.h>
#include <parvane/sections/planner_quick_apply.h>

#include "base/weak_qptr.h"
#include "core/file_utilities.h"
#include "parvane/parvane_cloud_internal.h"
#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/fields/input_field.h"
#include "styles/style_basic.h"
#include "styles/style_widgets.h"

#include <crl/crl_on_main.h>

#include <QtCore/QDir>
#include <QtCore/QFileInfo>
#include <QtCore/QMimeData>
#include <QtCore/QStandardPaths>
#include <QtCore/QUuid>
#include <QtGui/QTextCursor>
#include <QtGui/QtEvents>

namespace Parvane::Knowledge {
namespace {

using Kit::Px;
using Kit::Rem;

// `.prop` / `.propButton`: пилюля 0.1875rem 0.625rem, скругление 0.75rem, 0.8125rem `--pv-muted` на `--pv-raised`;
// значение — `<b>` 500 `--pv-fg`; кнопка — со значком папки, наведение `--pv-hover`
class PropPill final : public Kit::Button {
public:
	PropPill(QWidget *parent, QString key, QString value, QString icon = QString(), bool clickable = false)
	: Button(parent)
	, _key(std::move(key))
	, _value(std::move(value))
	, _icon(std::move(icon))
	, _clickable(clickable) {
		if (!_clickable) {
			setAttribute(Qt::WA_TransparentForMouseEvents);
			setFocusPolicy(Qt::NoFocus);
		}
		setAccessibleName(_key + ' ' + _value);
		const auto w = contentWidth();
		setNaturalWidth(w);
		resize(w, Kit::Font(13)->height + 2 * Rem(0.1875));
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto over = _clickable && (isOver() || isDown());
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(over ? Tone::Hover : Tone::Raised));
		const auto radius = Rem(0.75);
		p.drawRoundedRect(rect(), radius, radius);
		auto x = Rem(0.625);
		const auto muted = ToneColor(over ? Tone::Fg : Tone::Muted);
		if (!_icon.isEmpty()) {
			const auto size = Rem(1);
			PaintNotesIcon(p, _icon, muted, x, (height() - size) / 2, size);
			x += size + Rem(0.25);
		}
		const auto font = Kit::Font(13);
		const auto baseline = (height() - font->height) / 2 + font->ascent;
		p.setFont(font->f);
		p.setPen(muted);
		p.drawText(x, baseline, _key);
		x += font->width(_key);
		if (!_value.isEmpty()) {
			const auto bold = Kit::Font(13, true);
			p.setFont(bold->f);
			p.setPen(ToneColor(Tone::Fg));
			p.drawText(x, baseline, _value);
		}
		if (focusVisible() && hasFocus()) {
			paintFocusRing(p, QRectF(rect()), radius);
		}
	}

private:
	[[nodiscard]] int contentWidth() const {
		auto w = 2 * Rem(0.625) + Kit::Font(13)->width(_key);
		if (!_icon.isEmpty()) {
			w += Rem(1) + Rem(0.25);
		}
		if (!_value.isEmpty()) {
			w += Kit::Font(13, true)->width(_value);
		}
		return w;
	}

	QString _key;
	QString _value;
	QString _icon;
	bool _clickable = false;

};

// Строка «Запланировано» (`.plannedRow`): день моноширинным, полоска цвета вида, название (повтор, «в работе»),
// справа время либо срок; прошедшая — прозрачность 0.5
class PlannedRow final : public Ui::RpWidget {
public:
	PlannedRow(QWidget *parent, const notes::PlannedItem &item, const std::string &today)
	: RpWidget(parent)
	, _tone(KindTone(item.kind))
	, _day(item.day ? FormatDayShort(*item.day) : tr::lng_parvane_notes_no_date(tr::now))
	, _name(Q(item.name))
	, _past(item.day && *item.day < today && !item.repeat) {
		Kit::RepaintOnTones(this);
		if (item.repeat) {
			_note = u" · "_q + FormatRepeat(*item.repeat);
		}
		if (item.isActive.value_or(false) && !item.day) {
			_note += u" · "_q + tr::lng_parvane_notes_status_active(tr::now);
		}
		_meta = item.day
			? (item.time ? Q(*item.time) : QString())
			: item.due
			? FormatDue(*item.due)
			: QString();
		resize(width(), Rem(2.75));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		return Rem(2.75);
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		if (_past) {
			p.setOpacity(0.5);
		}
		const auto gap = Rem(0.75);
		const auto mono = Kit::Font(13, false, true);
		auto x = 0;
		p.setFont(mono->f);
		p.setPen(ToneColor(Tone::Muted));
		const auto dayWidth = Rem(3.5);
		p.drawText(x, (height() - mono->height) / 2 + mono->ascent, mono->elided(_day, dayWidth));
		x += dayWidth + gap;
		const auto pad = Rem(0.375);
		const auto bar = Rem(0.25);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(_tone));
		p.drawRoundedRect(QRectF(x, pad, bar, height() - 2 * pad), bar / 2., bar / 2.);
		x += bar + gap;
		auto right = width();
		if (!_meta.isEmpty()) {
			const auto w = mono->width(_meta);
			right -= w;
			p.setFont(mono->f);
			p.setPen(ToneColor(Tone::Muted));
			p.drawText(right, (height() - mono->height) / 2 + mono->ascent, _meta);
			right -= gap;
		}
		const auto font = Kit::Font(Kit::kBodyPx);
		const auto small = Kit::Font(13);
		const auto available = std::max(right - x, 0);
		const auto nameText = font->elided(_name, available);
		const auto baseline = (height() - font->height) / 2 + font->ascent;
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Fg));
		p.drawText(x, baseline, nameText);
		const auto used = font->width(nameText);
		if (!_note.isEmpty() && used < available) {
			p.setFont(small->f);
			p.setPen(ToneColor(Tone::Muted));
			p.drawText(x + used, baseline, small->elided(_note, available - used));
		}
	}

private:
	Tone _tone = Tone::Blue;
	QString _day;
	QString _name;
	QString _note;
	QString _meta;
	bool _past = false;

};

// Локальные файлы из перетаскивания/буфера (папки и не-файлы пропускаются)
[[nodiscard]] QStringList LocalFilePaths(not_null<const QMimeData*> data) {
	auto result = QStringList();
	if (!data->hasUrls()) {
		return result;
	}
	for (const auto &url : data->urls()) {
		if (url.isLocalFile() && QFileInfo(url.toLocalFile()).isFile()) {
			result.push_back(url.toLocalFile());
		}
	}
	return result;
}

// Столбец с промежутками: виджеты по порядку (видимые), у каждого — отступ сверху
class Column final : public Ui::RpWidget {
public:
	using RpWidget::RpWidget;

	void add(not_null<Ui::RpWidget*> widget, int top) {
		_items.push_back({ widget, top });
		widget->heightValue() | rpl::skip(1) | rpl::on_next([=] {
			resizeToWidth(width());
		}, widget->lifetime());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		auto y = 0;
		for (const auto &[widget, top] : _items) {
			if (widget->isHidden()) {
				continue;
			}
			y += top;
			widget->resizeToWidth(newWidth);
			widget->moveToLeft(0, y, newWidth);
			y += widget->height();
		}
		return y;
	}

private:
	std::vector<std::pair<not_null<Ui::RpWidget*>, int>> _items;

};

// Путь файла от корня диска (`папка/вложенная/имя`)
[[nodiscard]] std::string DrivePath(
		const std::vector<parvane::sections::cloud::CloudNode> &nodes,
		const parvane::sections::cloud::CloudNode &node) {
	auto parts = std::vector<std::string>{ node.name };
	auto parent = node.parent;
	auto guard = 0;
	while (parent && !parent->empty() && guard++ < 64) {
		const auto i = ranges::find(nodes, *parent, &parvane::sections::cloud::CloudNode::id);
		if (i == nodes.end()) {
			break;
		}
		parts.insert(parts.begin(), i->name);
		parent = i->parent;
	}
	auto result = std::string();
	for (const auto &part : parts) {
		result += (result.empty() ? "" : "/") + part;
	}
	return result;
}

} // namespace

// Стиль поля названия (`.noteTitleInput`): 1.75rem полужирный, без рамки, линия снизу при правке и фокусе
struct NoteView::TitleStyle {
	TitleStyle()
	: bg(QColor(0, 0, 0, 0))
	, fg(ToneColor(Tone::Fg))
	, placeholder(ToneColor(Tone::Faint))
	, border(QColor(0, 0, 0, 0))
	, borderActive(ToneColor(Tone::Accent))
	, text(st::defaultTextStyle)
	, st(st::defaultInputField) {
		text.font = Kit::Font(28, true);
		text.lineHeight = 0;
		st.style = text;
		st.textBg = bg.color();
		st.textBgActive = bg.color();
		st.textFg = fg.color();
		st.placeholderFg = placeholder.color();
		st.placeholderFgActive = placeholder.color();
		st.placeholderFgError = placeholder.color();
		st.borderFg = border.color();
		st.borderFgActive = borderActive.color();
		st.borderFgError = borderActive.color();
		st.placeholderFont = text.font;
		st.placeholderScale = 0.;
		st.placeholderShift = 0;
		st.placeholderMargins = style::margins();
		st.border = Px(1);
		st.borderActive = Px(1);
		st.borderDenominator = 1;
		st.borderRadius = 0;
		const auto pad = Rem(0.125);
		st.textMargins = style::margins(0, pad, 0, pad);
		st.heightMin = text.font->height + 2 * pad + Px(1);
		st.heightMax = st.heightMin;
	}

	void refresh(bool editing) {
		fg.update(ToneColor(Tone::Fg));
		placeholder.update(ToneColor(Tone::Faint));
		border.update(editing ? ToneColor(Tone::Line2) : QColor(0, 0, 0, 0));
		borderActive.update(ToneColor(Tone::Accent));
	}

	style::owned_color bg;
	style::owned_color fg;
	style::owned_color placeholder;
	style::owned_color border;
	style::owned_color borderActive;
	style::TextStyle text;
	style::InputField st;
};

NoteView::NoteView(QWidget *parent, NoteOptions options, NoteCallbacks callbacks)
: RpWidget(parent)
, _options(options)
, _callbacks(std::move(callbacks))
, _titleStyle(std::make_unique<TitleStyle>()) {
	TonesChanges() | rpl::on_next([=] {
		_titleStyle->refresh(isEditing());
		if (_titleField) {
			_titleField->update();
		}
	}, lifetime());
}

NoteView::~NoteView() {
	// Поле названия держит ссылку на стиль
	_title = nullptr;
	_titleField = nullptr;
}

const std::string &NoteView::noteId() const {
	return _shownId;
}

bool NoteView::isEditing() const {
	return _editor != nullptr;
}

void NoteView::setData(NoteData data) {
	_data = std::move(data);
	if (!_data.note) {
		return;
	}
	const auto &note = *_data.note;
	const auto changedNote = (note.id != _shownId) || (note.title != _shownTitle);
	if (changedNote) {
		// Другая заметка либо новое название: правка и черновик названия сбрасываются (web — по note.id/note.title)
		_shownId = note.id;
		_shownTitle = note.title;
		_editor = nullptr;
		_tools = nullptr;
		_base = std::nullopt;
		_selection = std::nullopt;
		_saving = false;
		_shownText.clear();
		_markdown = nullptr;
		rebuildTitle();
	}
	rebuildProps();
	if (!isEditing() && (!_markdown || _shownText != note.text)) {
		rebuildBody();
	}
	rebuildButtons();
	rebuildPlanned();
	rebuildLinks();
	relayout();
}

void NoteView::rebuildTitle() {
	const auto &note = *_data.note;
	const auto isDaily = note.isDaily && notes::isDayTitle(note.title);
	_titleField = nullptr;
	_title = nullptr;
	_barToggle = nullptr;
	_bar = nullptr;
	_backButton = nullptr;
	if (_options.narrow) {
		// `.noteBar`: папка приглушённо и кнопка правки (в правке — «Готово»)
		const auto bar = Ui::CreateChild<Kit::Header>(this, QString(), Kit::Header::TitleSize::Small);
		const auto folder = isDaily
			? tr::lng_parvane_notes_daily_folder(tr::now)
			: FolderCaption(note.folder);
		bar->add(object_ptr<Kit::Label>(bar, folder, Kit::Label::Style{ .px = 16, .tone = Tone::Muted, .semibold = true }));
		bar->addStretch();
		const auto toggle = bar->add(object_ptr<NotesIconButton>(
			bar,
			u"edit"_q,
			tr::lng_parvane_notes_edit(tr::now)));
		_barToggle = toggle;
		toggle->setClickedCallback([=] {
			crl::on_main(this, [=] {
				if (isEditing()) {
					save();
				} else {
					startEdit();
				}
			});
		});
		_bar.reset(bar);
		const auto back = Ui::CreateChild<NotesTextButton>(
			this,
			SectionTitle(Section::Knowledge),
			u"left"_q,
			NotesTextButton::Kind::Ghost);
		back->setAccessibleName(tr::lng_parvane_notes_back(tr::now));
		back->setClickedCallback([=] {
			if (_callbacks.back) {
				_callbacks.back();
			}
		});
		_backButton.reset(back);
	}
	if (isDaily) {
		_title.reset(Ui::CreateChild<Kit::Label>(this, DisplayTitle(note.title, true), Kit::Label::Style{
			.px = 28,
			.semibold = true,
			.multiline = true,
		}));
	} else {
		_titleStyle->refresh(isEditing());
		const auto field = Ui::CreateChild<Ui::InputField>(
			this,
			_titleStyle->st,
			Ui::InputField::Mode::SingleLine,
			tr::lng_parvane_notes_note_title(),
			Q(note.title));
		field->setMaxLength(notes::kNoteTitleMax);
		field->setAccessibleName(tr::lng_parvane_notes_note_title(tr::now));
		field->submits() | rpl::on_next([=] {
			setFocus();
		}, field->lifetime());
		field->focusedChanges() | rpl::filter(!rpl::mappers::_1) | rpl::on_next([=] {
			commitTitle();
		}, field->lifetime());
		_titleField = field;
		_title.reset(field);
	}
	for (const auto widget : { _bar.get(), _backButton.get(), _title.get() }) {
		if (widget) {
			widget->show();
			widget->heightValue() | rpl::skip(1) | rpl::on_next([=] {
				relayout();
			}, widget->lifetime());
		}
	}
}

void NoteView::commitTitle() {
	if (!_titleField || !_data.note) {
		return;
	}
	const auto next = notes::nextNoteTitle(S(_titleField->getLastText()), _data.note->title);
	if (next) {
		RenameNote(_data.note->id, *next);
	} else {
		_titleField->setText(Q(_data.note->title));
	}
}

void NoteView::rebuildProps() {
	const auto &note = *_data.note;
	const auto isDaily = note.isDaily && notes::isDayTitle(note.title);
	const auto flow = Ui::CreateChild<Kit::Flow>(this, Rem(0.375));
	const auto folderName = isDaily
		? tr::lng_parvane_notes_daily_folder(tr::now)
		: FolderCaption(note.folder);
	if (_callbacks.pickFolder && !isDaily) {
		const auto button = flow->add(object_ptr<PropPill>(flow, folderName, QString(), u"folder"_q, true));
		button->setAccessibleName(folderName + u". "_q + tr::lng_parvane_notes_move_note(tr::now));
		const auto id = note.id;
		const auto pick = _callbacks.pickFolder;
		button->setClickedCallback([=] {
			pick(id);
		});
	} else {
		flow->add(object_ptr<PropPill>(flow, folderName, QString()));
	}
	const auto parsed = notes::parseNote(note.text);
	for (const auto &[key, value] : parsed.properties.entries) {
		auto text = QString();
		if (value.isList) {
			auto list = QStringList();
			for (const auto &item : value.list) {
				list.push_back(Q(item));
			}
			text = list.join(u", "_q);
		} else {
			text = Q(value.scalar);
		}
		flow->add(object_ptr<PropPill>(flow, Q(key) + ' ', text));
	}
	const auto today = TodayKey();
	if (const auto nearest = notes::nearestPlanned(_data.planned, today)) {
		const auto &item = _data.planned[*nearest];
		auto when = FormatDayShort(item.day.value_or(today));
		if (item.time) {
			when += u", "_q + Q(*item.time);
		}
		flow->add(object_ptr<PropPill>(flow, tr::lng_parvane_notes_nearest(tr::now) + ' ', when));
	}
	flow->show();
	_props.reset(flow);
}

object_ptr<Ui::RpWidget> NoteView::createEmbed(QWidget *parent, const md::MdBlock &block) {
	if (block.url) {
		// Внешний адрес не загружается — ссылкой
		auto result = object_ptr<RichText>(parent, RichText::Style());
		auto part = md::MdInline();
		part.type = md::MdInlineType::Link;
		part.text = block.alt.value_or(*block.url);
		part.url = *block.url;
		result->setInlines({ part });
		return result;
	}
	// Встроенный файл (web `NoteEmbed`): картинка — сам файл, видео/аудио — «Воспроизвести», прочее — «Скачать»
	const auto cloud = _data.cloud;
	const auto rootId = cloud ? cloud->rootId : std::nullopt;
	const parvane::sections::cloud::CloudNode *node = nullptr;
	if (cloud && rootId) {
		node = notes::resolveEmbed(cloud->nodesOf(rootId), block.name, _data.note->id);
	}
	auto source = EmbedSource();
	source.name = Q(node ? node->name : md::embedBaseName(block.name));
	if (node) {
		source.type = EmbedSource::Type::Cloud;
		source.size = node->size;
		source.mime = node->mime;
		source.container = *rootId;
		source.node = *node;
	}
	return CreateEmbedView(parent, std::move(source));
}

void NoteView::rebuildBody() {
	const auto &note = *_data.note;
	_shownText = note.text;
	const auto index = _data.index;
	const auto noteId = note.id;
	// Пункты, ставшие задачами «Плана»: метка пункта → задача
	auto byMarker = std::map<std::string, planner::Task>();
	for (const auto &task : notes::getNoteTasks(_data.planner, noteId)) {
		byMarker.emplace(notes::markerOfTask(task), task);
	}
	auto callbacks = MarkdownCallbacks{
		.noteExists = [=](const std::string &target) {
			return index && index->byTitle(target) != nullptr;
		},
		.openNote = _callbacks.openTitle,
		.toggleTask = [=](int line, bool done) {
			toggleTask(line, done);
		},
		.taskTail = [byMarker = std::move(byMarker)](const std::string &text) {
			const auto split = notes::splitTaskMarker(text);
			auto when = QString();
			if (split.marker) {
				if (const auto i = byMarker.find(*split.marker); i != byMarker.end()) {
					const auto &task = i->second;
					if (task.day) {
						when = FormatDayShort(*task.day);
						if (task.start) {
							when += ' ' + Q(*task.start);
						}
					} else if (task.due) {
						when = FormatDue(*task.due);
					}
				}
			}
			return std::make_pair(split.text, when);
		},
		.embed = [=](QWidget *parent, const md::MdBlock &block) {
			return createEmbed(parent, block);
		},
	};
	const auto view = Ui::CreateChild<MarkdownView>(this, std::move(callbacks));
	view->setBlocks(md::parseMarkdown(note.text, note.title));
	view->show();
	view->heightValue() | rpl::skip(1) | rpl::on_next([=] {
		relayout();
	}, view->lifetime());
	_markdown.reset(view);
}

void NoteView::rebuildButtons() {
	const auto &note = *_data.note;
	const auto isDaily = note.isDaily && notes::isDayTitle(note.title);
	const auto flow = Ui::CreateChild<Kit::Flow>(this, Rem(0.5));
	using Kind = NotesTextButton::Kind;
	if (isEditing()) {
		const auto saveButton = flow->add(object_ptr<NotesTextButton>(
			flow,
			tr::lng_parvane_notes_save(tr::now),
			u"check"_q,
			Kind::Btn));
		saveButton->setDisabled(_saving);
		saveButton->setClickedCallback([=] { crl::on_main(this, [=] { save(); }); });
		const auto cancel = flow->add(object_ptr<NotesTextButton>(
			flow,
			tr::lng_parvane_notes_cancel(tr::now),
			QString(),
			Kind::Ghost));
		cancel->setClickedCallback([=] { crl::on_main(this, [=] { cancelEdit(); }); });
	} else {
		const auto edit = flow->add(object_ptr<NotesTextButton>(
			flow,
			tr::lng_parvane_notes_edit(tr::now),
			u"edit"_q,
			Kind::Btn));
		edit->setClickedCallback([=] { crl::on_main(this, [=] { startEdit(); }); });
		if (isDaily) {
			// Заметка дня: её день в «Плане» (название — ключ дня)
			const auto day = flow->add(object_ptr<NotesTextButton>(
				flow,
				tr::lng_parvane_notes_open_day(tr::now),
				u"cal"_q,
				Kind::Btn));
			day->setClickedCallback([] { ShowSection(Section::Calendar); });
		} else {
			const auto plan = flow->add(object_ptr<NotesTextButton>(
				flow,
				tr::lng_parvane_notes_plan(tr::now),
				u"cal"_q,
				Kind::Btn));
			plan->setClickedCallback([=] { schedule(); });
		}
		const auto del = flow->add(object_ptr<NotesTextButton>(
			flow,
			tr::lng_parvane_notes_delete(tr::now),
			u"trash"_q,
			Kind::Ghost));
		del->setClickedCallback([=] { askDelete(); });
	}
	flow->show();
	_buttons.reset(flow);
}

void NoteView::rebuildPlanned() {
	_planned = nullptr;
	const auto &note = *_data.note;
	const auto isDaily = note.isDaily && notes::isDayTitle(note.title);
	const auto today = TodayKey();
	const auto shown = notes::shownPlanned(_data.planned, today);
	if (isDaily || shown.empty()) {
		return;
	}
	const auto card = Ui::CreateChild<Kit::Card>(
		this,
		tr::lng_parvane_notes_planned(tr::now),
		tr::lng_parvane_notes_planned_hint(tr::now));
	for (const auto &item : shown) {
		card->add(object_ptr<PlannedRow>(card, item, today));
	}
	card->show();
	_planned.reset(card);
}

void NoteView::rebuildLinks() {
	_links = nullptr;
	if (!_options.hasLinks || !_data.index) {
		return;
	}
	const auto links = Ui::CreateChild<NoteLinks>(this, NoteLinks::Args{
		.note = _data.note,
		.index = _data.index,
		.planned = _data.planned,
		.isGraphHidden = _options.isGraphHidden,
		.openTitle = _callbacks.openTitle,
	});
	links->show();
	_links.reset(links);
}

void NoteView::relayout() {
	resizeToWidth(width());
}

int NoteView::resizeGetHeight(int newWidth) {
	const auto narrow = _options.narrow;
	auto y = 0;
	if (_bar) {
		_bar->resizeToWidth(newWidth);
		_bar->moveToLeft(0, 0, newWidth);
		y += _bar->height();
	}
	// `.noteBody` на узком экране: поля 0.875rem 1rem 1.5rem
	const auto padX = narrow ? Rem(1) : 0;
	const auto inner = std::max(newWidth - 2 * padX, 1);
	y += narrow ? Rem(0.875) : 0;
	const auto place = [&](Ui::RpWidget *widget, int top, int width) {
		if (!widget) {
			return;
		}
		y += top;
		widget->resizeToWidth(width);
		widget->moveToLeft(padX, y, newWidth);
		y += widget->height();
	};
	if (_backButton) {
		// `.backButton`: margin -0.25rem 0 0.5rem -0.5rem
		_backButton->moveToLeft(padX - Rem(0.5), y - Rem(0.25), newWidth);
		y += _backButton->height() - Rem(0.25) + Rem(0.5);
	}
	place(_title.get(), 0, inner);
	place(_props.get(), Rem(0.375), inner);
	y += Rem(1.125);
	if (_tools) {
		place(_tools.get(), 0, inner);
		y += Rem(0.5);
	}
	if (_editor) {
		place(_editor.get(), 0, inner);
	} else {
		place(_markdown.get(), 0, inner);
	}
	place(_buttons.get(), Rem(1), inner);
	y += Rem(1.375);
	const auto maxWidth = std::min(inner, Kit::Font(Kit::kBodyPx)->width(QChar('0')) * 70);
	if (_planned) {
		place(_planned.get(), 0, maxWidth);
	}
	if (_links) {
		place(_links.get(), _planned ? Rem(1.375) : 0, maxWidth);
	}
	y += narrow ? Rem(1.5) : 0;
	return y;
}

void NoteView::startEdit() {
	if (isEditing() || !_data.note) {
		return;
	}
	const auto &note = *_data.note;
	_base = note.text;
	const auto field = Ui::CreateChild<Kit::Field>(
		this,
		Kit::Field::Kind::Textarea,
		tr::lng_parvane_notes_editor_placeholder(),
		Q(note.text));
	field->input()->setMinHeight(Rem(18.75));
	field->input()->setMaxHeight(Rem(4000));
	field->input()->setAccessibleName(Q(note.title));
	field->submits() | rpl::on_next([=] { save(); }, field->lifetime());
	field->cancels() | rpl::on_next([=] {
		crl::on_main(this, [=] { cancelEdit(); });
	}, field->lifetime());
	field->heightValue() | rpl::skip(1) | rpl::on_next([=] { relayout(); }, field->lifetime());
	field->show();
	_editor.reset(field);

	// Файл с диска, перетаскиванием либо из буфера (web `NoteView`: drop, paste) — в облако, в папку заметки
	field->input()->setMimeDataHook([=](not_null<const QMimeData*> data, Ui::InputField::MimeAction action) {
		const auto paths = LocalFilePaths(data);
		const auto image = paths.isEmpty() && data->hasImage() && !data->hasText();
		if (paths.isEmpty() && !image) {
			return false;
		}
		if (action == Ui::InputField::MimeAction::Insert) {
			if (image) {
				insertClipboardImage(qvariant_cast<QImage>(data->imageData()));
			} else {
				insertLocalFiles(paths);
			}
		}
		return true;
	});

	// `.editorTools`: файл с диска и из облака
	const auto tools = Ui::CreateChild<Kit::Flow>(this, Rem(0.5));
	const auto disk = tools->add(object_ptr<NotesTextButton>(
		tools,
		tr::lng_parvane_notes_insert_file(tr::now),
		u"file"_q,
		NotesTextButton::Kind::Ghost));
	disk->setClickedCallback([=] {
		const auto self = base::make_weak(this);
		FileDialog::GetOpenPaths(this, tr::lng_parvane_notes_insert_file(tr::now), QString(), [=](
				FileDialog::OpenResult &&result) {
			if (self && !result.paths.isEmpty()) {
				insertLocalFiles(result.paths);
			}
		});
	});
	const auto cloud = tools->add(object_ptr<NotesTextButton>(
		tools,
		tr::lng_parvane_notes_insert_from_cloud(tr::now),
		u"cloud"_q,
		NotesTextButton::Kind::Ghost));
	cloud->setClickedCallback([=] { chooseFromCloud(); });
	tools->show();
	_tools.reset(tools);

	_markdown = nullptr;
	_shownText.clear();
	_titleStyle->refresh(true);
	if (_titleField) {
		_titleField->update();
	}
	rebuildButtons();
	relayout();
	if (_bar) {
		if (_barToggle) {
			_barToggle->setIcon(u"check"_q);
		}
	}
	field->setFocusFast();
	if (const auto selection = std::exchange(_selection, std::nullopt)) {
		auto cursor = field->input()->textCursor();
		cursor.setPosition(selection->first);
		cursor.setPosition(selection->second, QTextCursor::KeepAnchor);
		field->input()->setTextCursor(cursor);
	} else {
		field->input()->setCursorPosition(0);
	}
}

void NoteView::cancelEdit() {
	if (!isEditing()) {
		return;
	}
	_editor = nullptr;
	_tools = nullptr;
	_base = std::nullopt;
	_saving = false;
	_titleStyle->refresh(false);
	if (_titleField) {
		_titleField->update();
	}
	if (_bar) {
		if (_barToggle) {
			_barToggle->setIcon(u"edit"_q);
		}
	}
	rebuildBody();
	rebuildButtons();
	relayout();
}

void NoteView::save() {
	if (!isEditing() || _saving || !_data.note) {
		return;
	}
	_saving = true;
	rebuildButtons();
	relayout();
	const auto weak = base::make_weak(this);
	const auto id = _data.note->id;
	SaveNote(id, S(_editor->text()), _base, [=](bool ok) {
		if (!weak || _shownId != id) {
			return;
		}
		_saving = false;
		if (ok) {
			cancelEdit();
		} else {
			rebuildButtons();
			relayout();
		}
	});
}

void NoteView::toggleTask(int line, bool done) {
	if (!_data.note) {
		return;
	}
	SaveNote(_data.note->id, notes::setTaskDone(_data.note->text, line, done), std::nullopt);
}

void NoteView::askDelete() {
	if (!_data.note) {
		return;
	}
	const auto id = _data.note->id;
	const auto deleted = _callbacks.deleted;
	ShowQuestion(
		SheetHost(this),
		tr::lng_parvane_notes_delete(tr::now),
		tr::lng_parvane_notes_delete_confirm(tr::now, lt_name, Q(_data.note->title)),
		{ SheetButton{
			.text = tr::lng_parvane_notes_delete(tr::now),
			.kind = Kit::PushButton::Kind::Danger,
			.callback = [=] {
				if (deleted) {
					deleted(id);
				}
				DeleteNote(id);
			},
			.icon = u"trash"_q,
		} });
}

void NoteView::schedule() {
	// «Запланировать» (web — окно ввода текстом «Плана» поверх раздела): строка со ссылкой на заметку; запись с
	// ней встаёт в «Запланировано»
	if (!_data.note) {
		return;
	}
	const auto sheet = Kit::Sheet::Show(SheetHost(this), {
		.title = tr::lng_parvane_notes_plan(tr::now),
		.closeName = tr::lng_parvane_notes_close(tr::now),
	});
	const auto field = sheet->add(object_ptr<Kit::Field>(
		sheet,
		Kit::Field::Kind::Input,
		rpl::single(QString()),
		Q(notes::notePlanLine(_data.note->title))));
	const auto hint = sheet->add(object_ptr<Kit::Label>(sheet, QString(), Kit::Label::Style{
		.px = 13,
		.tone = Tone::Muted,
		.multiline = true,
	}));
	const auto context = [] {
		auto ctx = planner::QuickContext();
		ctx.today = TodayKey();
		ctx.nowMinutes = NowMinutes();
		ctx.lang = IsRussian() ? "ru" : "en";
		return ctx;
	};
	const auto describe = [=](const QString &text) {
		const auto draft = planner::parseQuickInput(S(text), context());
		if (draft.error || draft.name.empty()) {
			return QString();
		}
		auto parts = QStringList{
			(draft.kind == "event")
				? tr::lng_parvane_notes_graph_kind_event(tr::now)
				: tr::lng_parvane_notes_graph_kind_task(tr::now),
			Q(draft.name),
		};
		if (draft.day) {
			auto when = FormatDayShort(*draft.day);
			if (draft.start) {
				when += ' ' + Q(*draft.start);
			}
			parts.push_back(when);
		} else if (draft.due) {
			parts.push_back(FormatDue(*draft.due));
		}
		if (draft.repeat) {
			parts.push_back(FormatRepeat(*draft.repeat));
		}
		return parts.join(u" · "_q);
	};
	hint->setText(describe(field->text()));
	field->textChanges() | rpl::on_next([=](const QString &text) {
		hint->setText(describe(text));
	}, field->lifetime());
	const auto weak = QPointer<Kit::Sheet>(sheet.get());
	const auto submit = [=] {
		const auto draft = planner::parseQuickInput(S(field->text()), context());
		if (draft.error || draft.name.empty()) {
			field->setError(true);
			return;
		}
		const auto today = TodayKey();
		Sections::UpdatePlanner([=](planner::State &state) {
			planner::applyQuickDraft(state, draft, today, [] {
				return S(QUuid::createUuid().toString(QUuid::WithoutBraces));
			});
		});
		if (weak) {
			weak->requestClose();
		}
	};
	field->submits() | rpl::on_next(submit, field->lifetime());
	const auto buttons = sheet->addButtons();
	buttons->add(object_ptr<Kit::PushButton>(
		buttons,
		tr::lng_parvane_notes_plan_add(tr::now),
		Kit::PushButton::Kind::Accent,
		u"plus"_q))->setClickedCallback(submit);
	sheet->showSheet();
	field->setFocusFast();
	field->input()->setCursorPosition(field->text().size());
}

void NoteView::chooseFromCloud() {
	const auto cloud = _data.cloud;
	if (!cloud || !cloud->rootId || !_data.note) {
		return;
	}
	const auto &nodes = cloud->nodesOf(cloud->rootId);
	auto files = std::vector<std::pair<std::string, const parvane::sections::cloud::CloudNode*>>();
	for (const auto &node : nodes) {
		if (node.trashed || node.kind == "folder") {
			continue;
		}
		files.emplace_back(DrivePath(nodes, node), &node);
	}
	ranges::sort(files, [](const auto &a, const auto &b) {
		return QString::localeAwareCompare(Q(a.first), Q(b.first)) < 0;
	});
	const auto sheet = Kit::Sheet::Show(SheetHost(this), {
		.title = tr::lng_parvane_notes_insert_from_cloud(tr::now),
		.closeName = tr::lng_parvane_notes_close(tr::now),
		.tight = true,
	});
	const auto weak = QPointer<Kit::Sheet>(sheet.get());
	const auto noteId = _data.note->id;
	for (const auto &[path, node] : files) {
		// Имя, если по нему находится именно этот файл, иначе путь от корня диска
		const auto byName = notes::resolveEmbed(nodes, node->name, noteId);
		const auto insert = (byName && byName->id == node->id) ? node->name : path;
		const auto row = sheet->add(object_ptr<Kit::Row>(sheet, Kit::Row::Descriptor{
			.title = Q(node->name),
			.subtitle = Q(path),
			.meta = FormatSize(node->size),
			.icon = u"note"_q,
		}));
		const auto self = base::make_weak(this);
		row->setClickedCallback([=] {
			if (weak) {
				weak->requestClose();
			}
			if (self) {
				insertEmbeds({ Q(insert) });
			}
		});
	}
	if (files.empty()) {
		sheet->add(object_ptr<Kit::Empty>(sheet, tr::lng_parvane_notes_embed_missing(tr::now)));
	}
	sheet->showSheet();
}

void NoteView::insertLocalFiles(const QStringList &paths) {
	// Имена — как их даст загрузка (`Cloud::UploadFiles`: свободное имя в папке заметки), в текст — `![[имя]]`
	const auto cloud = _data.cloud;
	if (!_editor || !cloud || !cloud->rootId || !_data.note || paths.isEmpty()) {
		return;
	}
	const auto &nodes = cloud->nodesOf(cloud->rootId);
	auto parent = std::optional<std::string>();
	for (const auto &node : nodes) {
		if (node.id == _data.note->id) {
			parent = (node.parent && !node.parent->empty()) ? node.parent : std::nullopt;
			break;
		}
	}
	auto taken = parvane::sections::cloud::namesIn(nodes, parent);
	auto names = std::vector<QString>();
	auto files = QStringList();
	for (const auto &path : paths) {
		const auto info = QFileInfo(path);
		if (!info.isFile()) {
			continue;
		}
		const auto name = parvane::sections::cloud::freeName(
			taken,
			info.fileName().isEmpty() ? std::string("file") : S(info.fileName()));
		taken.push_back(name);
		names.push_back(Q(name));
		files.push_back(path);
	}
	if (files.isEmpty()) {
		return;
	}
	Cloud::UploadFiles(*cloud->rootId, parent, files);
	insertEmbeds(names);
}

void NoteView::insertClipboardImage(const QImage &image) {
	if (image.isNull()) {
		return;
	}
	const auto dir = QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation)).filePath(
		u"parvane-paste/"_q + QUuid::createUuid().toString(QUuid::WithoutBraces));
	QDir().mkpath(dir);
	const auto path = QDir(dir).filePath(u"Pasted image.png"_q);
	if (image.save(path, "PNG")) {
		insertLocalFiles({ path });
	}
}

void NoteView::insertEmbeds(const std::vector<QString> &names) {
	// Строки `![[имя]]` встают на место курсора (отдельными строками)
	if (!_editor || names.empty()) {
		return;
	}
	const auto input = _editor->input();
	const auto prev = input->getLastText();
	const auto at = std::min(input->textCursor().position(), int(prev.size()));
	const auto before = prev.mid(0, at);
	const auto after = prev.mid(at);
	const auto lead = (!before.isEmpty() && !before.endsWith('\n')) ? u"\n"_q : QString();
	const auto tail = after.startsWith('\n') ? QString() : u"\n"_q;
	auto lines = QStringList();
	for (const auto &name : names) {
		lines.push_back(u"![["_q + name + u"]]"_q);
	}
	const auto inserted = lead + lines.join('\n') + tail;
	input->setText(before + inserted + after);
	input->setCursorPosition(at + inserted.size());
	input->setFocusFast();
}

void NoteView::requestEdit(size_t from, size_t to) {
	if (!_data.note) {
		return;
	}
	const auto &text = _data.note->text;
	const auto qFrom = int(QString::fromUtf8(text.data(), int(std::min(from, text.size()))).size());
	const auto qTo = int(QString::fromUtf8(text.data(), int(std::min(to, text.size()))).size());
	if (isEditing()) {
		// Правка уже открыта: заметка не перечитывается, кусок выделяется в нынешнем тексте
		auto cursor = _editor->input()->textCursor();
		cursor.setPosition(qFrom);
		cursor.setPosition(qTo, QTextCursor::KeepAnchor);
		_editor->input()->setTextCursor(cursor);
		_editor->setFocusFast();
		return;
	}
	_selection = std::make_pair(qFrom, qTo);
	startEdit();
}

} // namespace Parvane::Knowledge
