// Parvane fork: реализация parvane_knowledge_list.h. Размеры — web `Knowledge.module.scss` (`.list`, `.folder*`,
// `.guideNotice`, `.listButtons`) и `PvKit.module.scss` (`.row`, `.ava`, `.grp`).
#include "parvane/parvane_knowledge_list.h"

#include <parvane/sections/notes_look.h>
#include <parvane/sections/notes_prefs.h>

#include "lang/lang_keys.h"
#include "ui/painter.h"

#include <crl/crl_on_main.h>

#include <QtGui/QFontMetricsF>
#include <QtGui/QtEvents>

namespace Parvane::Knowledge {
namespace {

using Kit::Px;
using Kit::Rem;

// Столько последних заметок дня видно в списке, пока не попросили все
constexpr auto kDailyShown = 5;
// Названия папки заметок дня на обоих языках (как в хранилище)
const auto kDailyFolders = std::vector<std::string>{ "Ежедневные", "Daily" };

// Заголовок группы (`.folderToggle` в `.grp`): стрелка, название моноширинными заглавными, число у свёрнутой
class GroupToggle final : public Kit::Button {
public:
	GroupToggle(QWidget *parent, const QString &caption, bool collapsed, int count)
	: Button(parent)
	, _caption(caption)
	, _collapsed(collapsed)
	, _count(collapsed ? QString::number(count) : QString()) {
		setAccessibleName(caption);
		resize(width(), Rem(1.875));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		return Rem(1.875);
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		const auto over = isOver() || isDown();
		const auto color = ToneColor(over ? Tone::Fg : Tone::Muted);
		auto x = Rem(0.25);
		const auto icon = Rem(1.125);
		PaintNotesIcon(p, _collapsed ? u"right"_q : u"down"_q, color, x, (height() - icon) / 2, icon);
		x += icon + Rem(0.25);
		auto font = Kit::Font(12, true, true)->f;
		font.setCapitalization(QFont::AllUppercase);
		font.setLetterSpacing(QFont::AbsoluteSpacing, Px(12) * 0.06);
		const auto metrics = QFontMetricsF(font);
		auto right = width() - Rem(0.25);
		if (!_count.isEmpty()) {
			right -= int(std::ceil(metrics.horizontalAdvance(_count))) + Rem(0.25);
		}
		const auto text = metrics.elidedText(_caption, Qt::ElideRight, std::max(right - x, 0));
		p.setFont(font);
		p.setPen(color);
		const auto rectText = QRectF(x, 0, std::max(right - x, 0), height());
		p.drawText(rectText, Qt::AlignLeft | Qt::AlignVCenter, text);
		if (!_count.isEmpty()) {
			const auto cx = x + metrics.horizontalAdvance(text) + Rem(0.25);
			p.setPen(ToneColor(Tone::Faint));
			p.drawText(QRectF(cx, 0, width() - cx, height()), Qt::AlignLeft | Qt::AlignVCenter, _count);
		}
		if (focusVisible() && hasFocus()) {
			paintFocusRing(p, QRectF(rect()), Rem(0.375));
		}
	}

private:
	QString _caption;
	bool _collapsed = false;
	QString _count;

};

// Голова группы (`.folderHead`): заголовок со сворачиванием, «+» и «⋯»
class GroupHead final : public Ui::RpWidget {
public:
	GroupHead(QWidget *parent) : RpWidget(parent) {
	}

	void set(GroupToggle *toggle, NotesIconButton *add, NotesIconButton *menu) {
		_toggle = toggle;
		_add = add;
		_menu = menu;
	}

protected:
	int resizeGetHeight(int newWidth) override {
		// min-height 2.25rem, поле сверху 0.375rem, промежуток 0.125rem
		const auto top = Rem(0.375);
		const auto h = Rem(2.25) - top;
		auto right = newWidth;
		for (const auto button : { _menu, _add }) {
			if (button) {
				right -= button->width();
				button->moveToLeft(right, top + (h - button->height()) / 2, newWidth);
				right -= Rem(0.125);
			}
		}
		if (_toggle) {
			_toggle->resizeToWidth(std::max(right, 1));
			_toggle->moveToLeft(0, top + (h - _toggle->height()) / 2, newWidth);
		}
		return Rem(2.25);
	}

private:
	GroupToggle *_toggle = nullptr;
	NotesIconButton *_add = nullptr;
	NotesIconButton *_menu = nullptr;

};

// Сообщение о справке (`.guideNotice`): текст, «Открыть», крестик — на `--pv-raised`
class GuideNotice final : public Ui::RpWidget {
public:
	GuideNotice(QWidget *parent, const QString &text, Fn<void()> open, Fn<void()> dismiss)
	: RpWidget(parent)
	, _text(Ui::CreateChild<Kit::Label>(this, text, Kit::Label::Style{ .px = 13, .multiline = true })) {
		Kit::RepaintOnTones(this);
		_open = Ui::CreateChild<NotesTextButton>(
			this,
			tr::lng_parvane_notes_guide_open(tr::now),
			QString(),
			NotesTextButton::Kind::Accent);
		_open->setClickedCallback(std::move(open));
		_dismiss = Ui::CreateChild<NotesIconButton>(this, u"x"_q, tr::lng_parvane_notes_guide_dismiss(tr::now));
		_dismiss->setToolTip(tr::lng_parvane_notes_guide_dismiss(tr::now));
		_dismiss->setClickedCallback(std::move(dismiss));
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto padY = Rem(0.5);
		const auto gap = Rem(0.5);
		auto right = newWidth - Rem(0.25);
		right -= _dismiss->width();
		const auto inner = std::max(_open->height(), _dismiss->height());
		right -= gap + _open->width();
		const auto left = Rem(0.75);
		_text->resizeToWidth(std::max(right - gap - left, 1));
		const auto h = std::max(inner, _text->height()) + 2 * padY;
		_text->moveToLeft(left, (h - _text->height()) / 2, newWidth);
		_open->moveToLeft(right, (h - _open->height()) / 2, newWidth);
		_dismiss->moveToLeft(right + _open->width() + gap, (h - _dismiss->height()) / 2, newWidth);
		return h;
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Raised));
		p.drawRoundedRect(rect(), Rem(0.5), Rem(0.5));
	}

private:
	not_null<Kit::Label*> _text;
	NotesTextButton *_open = nullptr;
	NotesIconButton *_dismiss = nullptr;

};

// `.listButtons`: две кнопки поровну (`flex: 1 1 8rem`), перенос, если не помещаются
class ButtonsRow final : public Ui::RpWidget {
public:
	ButtonsRow(QWidget *parent) : RpWidget(parent) {
	}

	void set(std::vector<NotesTextButton*> buttons) {
		_buttons = std::move(buttons);
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto gap = Rem(0.5);
		const auto count = int(_buttons.size());
		if (!count) {
			return 0;
		}
		const auto inRow = (newWidth >= count * Rem(8) + (count - 1) * gap) ? count : 1;
		const auto w = (newWidth - (inRow - 1) * gap) / inRow;
		auto y = 0;
		for (auto i = 0; i != count; ++i) {
			const auto column = i % inRow;
			if (i && !column) {
				y += _buttons[i - 1]->height() + gap;
			}
			_buttons[i]->resizeToWidth(w);
			_buttons[i]->moveToLeft(column * (w + gap), y, newWidth);
		}
		return y + _buttons.back()->height();
	}

private:
	std::vector<NotesTextButton*> _buttons;

};

[[nodiscard]] QString GroupCaption(const notes::NoteGroup &group) {
	if (group.isDaily) {
		return tr::lng_parvane_notes_daily_folder(tr::now);
	}
	return FolderCaption(group.folder);
}

} // namespace

KnowledgeList::KnowledgeList(QWidget *parent, KnowledgeListCallbacks callbacks)
: RpWidget(parent)
, _callbacks(std::move(callbacks)) {
	Kit::RepaintOnTones(this);
}

void KnowledgeList::setData(KnowledgeListData data) {
	_data = std::move(data);
	rebuild();
}

void KnowledgeList::clear() {
	for (const auto &item : _items) {
		delete item.widget;
	}
	_items.clear();
	_groups.clear();
	_rows.clear();
	_draggable.clear();
	_drag = std::nullopt;
	_dropGroup = -1;
}

void KnowledgeList::add(Ui::RpWidget *widget, int top, int group) {
	widget->show();
	_items.push_back({ widget, top, false, group });
}

void KnowledgeList::rebuild() {
	clear();
	const auto &data = _data;
	// Действия кнопок — после обработки нажатия: список перестраивается и удаляет нажатую кнопку
	const auto later = [=](Fn<void()> callback) {
		return [=] {
			crl::on_main(this, callback);
		};
	};

	if (!data.guideNotice.isEmpty()) {
		add(Ui::CreateChild<GuideNotice>(
			this,
			tr::lng_parvane_notes_guide_added(tr::now, lt_name, data.guideNotice),
			later(_callbacks.guide),
			later(_callbacks.guideDismiss)), 0);
	}

	// Группы: найденное поиском либо все заметки
	auto byId = std::map<std::string, notes::NoteRef>();
	for (const auto &note : data.notes) {
		byId.emplace(note->id, note);
	}
	auto input = notes::NoteGroupsInput();
	const auto pushNote = [&](const notes::NoteRef &note) {
		input.notes.push_back({ note->id, note->title, note->folder, note->isDaily });
	};
	if (data.found) {
		for (const auto &id : *data.found) {
			if (const auto i = byId.find(id); i != byId.end()) {
				pushNote(i->second);
			}
		}
	} else {
		for (const auto &note : data.notes) {
			pushNote(note);
		}
	}
	input.folders = data.folders;
	input.dailyFolders = kDailyFolders;
	input.isSearch = data.found.has_value();
	if (!data.areAllDailyShown) {
		input.dailyShown = kDailyShown;
	}
	const auto groups = notes::buildNoteGroups(input);

	if (data.notes.empty()) {
		add(Ui::CreateChild<Kit::Label>(this, tr::lng_parvane_notes_empty(tr::now), Kit::Label::Style{
			.tone = Tone::Muted,
			.multiline = true,
		}), _items.empty() ? 0 : Rem(0.5));
	} else if (groups.empty()) {
		add(Ui::CreateChild<Kit::Label>(this, tr::lng_parvane_notes_nothing_found(tr::now), Kit::Label::Muted()), 0);
	}

	for (const auto &group : groups) {
		const auto index = int(_groups.size());
		const auto isRoot = !group.isDaily && group.folder == notes::kRootFolder;
		const auto caption = GroupCaption(group);
		// При поиске свёрнутые папки раскрыты: иначе найденное было бы не видно
		const auto isCollapsed = !data.found && ranges::contains(data.collapsed, group.key);
		// В папку переносят и в ней создают, пока её узел известен; «Без папки» — корень хранилища
		const auto isTarget = !data.found && !group.isDaily && (isRoot || group.folderId.has_value());
		_groups.push_back({ group.key, group.folderId, isTarget, QRect() });

		const auto head = Ui::CreateChild<GroupHead>(this);
		const auto toggle = Ui::CreateChild<GroupToggle>(
			head,
			caption,
			isCollapsed,
			int(group.items.size()) + group.hidden);
		const auto key = group.key;
		toggle->setClickedCallback(later([=] {
			if (_callbacks.toggleGroup) {
				_callbacks.toggleGroup(key);
			}
		}));
		auto addButton = (NotesIconButton*)nullptr;
		auto menuButton = (NotesIconButton*)nullptr;
		const auto folderId = group.folderId;
		if (isTarget) {
			const auto label = tr::lng_parvane_notes_folder_add_note(tr::now, lt_name, caption);
			addButton = Ui::CreateChild<NotesIconButton>(head, u"plus"_q, label, Rem(1.875));
			addButton->setToolTip(label);
			addButton->setClickedCallback(later([=] {
				if (_callbacks.newInFolder) {
					_callbacks.newInFolder(folderId, key);
				}
			}));
			if (folderId) {
				const auto menuLabel = tr::lng_parvane_notes_folder_actions(tr::now, lt_name, caption);
				menuButton = Ui::CreateChild<NotesIconButton>(head, u"dots"_q, menuLabel, Rem(1.875));
				menuButton->setToolTip(menuLabel);
				const auto id = *folderId;
				menuButton->setClickedCallback(later([=] {
					if (_callbacks.folderMenu) {
						_callbacks.folderMenu(id);
					}
				}));
			}
		}
		head->set(toggle, addButton, menuButton);
		add(head, 0, index);

		if (isCollapsed) {
			continue;
		}
		for (const auto &item : group.items) {
			const auto i = byId.find(item.id);
			if (i == byId.end()) {
				continue;
			}
			const auto &note = *i->second;
			const auto isDaily = note.isDaily && notes::isDayTitle(note.title);
			const auto preview = notes::previewOf(note.title, note.text);
			const auto nearest = data.nearest.find(note.id);
			const auto row = Ui::CreateChild<Kit::Row>(this, Kit::Row::Descriptor{
				.title = DisplayTitle(note.title, note.isDaily),
				.subtitle = preview.empty() ? tr::lng_parvane_notes_note_empty(tr::now) : Q(preview),
				.meta = (nearest != data.nearest.end()) ? nearest->second : QString(),
				.avatar = Kit::Avatar{
					.text = Q(notes::avatarText(note.title, note.isDaily)),
					.tone = FolderTone(note.folder, note.isDaily),
				},
			});
			row->setSelected(data.openId && *data.openId == note.id);
			const auto id = note.id;
			row->setClickedCallback([=] {
				// Строку отпустили после перетаскивания — это перенос, а не выбор
				if (std::exchange(_suppressClick, false)) {
					return;
				}
				crl::on_main(this, [=] {
					if (_callbacks.pick) {
						_callbacks.pick(id);
					}
				});
			});
			if (!data.narrow && !isDaily) {
				row->installEventFilter(this);
				_draggable.emplace(row, id);
			}
			_rows.emplace(id, row);
			add(row, 0, index);
		}
		if (group.items.empty()) {
			const auto empty = Ui::CreateChild<NotesTextButton>(
				this,
				tr::lng_parvane_notes_folder_empty(tr::now),
				QString(),
				NotesTextButton::Kind::Plain);
			empty->setFontPx(13);
			empty->setTextTone(Tone::Faint);
			empty->setClickedCallback(later([=] {
				if (_callbacks.newInFolder) {
					_callbacks.newInFolder(folderId, key);
				}
			}));
			add(empty, Rem(0.375), index);
		}
		if (group.hidden > 0) {
			const auto all = Ui::CreateChild<NotesTextButton>(
				this,
				tr::lng_parvane_notes_show_all(
					tr::now,
					lt_amount,
					QString::number(group.hidden + int(group.items.size()))),
				QString(),
				NotesTextButton::Kind::Ghost);
			all->setWide(true);
			all->setClickedCallback(later(_callbacks.showAllDaily));
			add(all, 0, index);
		}
	}

	const auto buttons = Ui::CreateChild<ButtonsRow>(this);
	const auto newNote = Ui::CreateChild<NotesTextButton>(
		buttons,
		tr::lng_parvane_notes_new_note(tr::now),
		u"plus"_q,
		NotesTextButton::Kind::Btn);
	newNote->setWide(true);
	newNote->setClickedCallback(later(_callbacks.newNote));
	const auto newFolder = Ui::CreateChild<NotesTextButton>(
		buttons,
		tr::lng_parvane_notes_new_folder(tr::now),
		u"folder"_q,
		NotesTextButton::Kind::Btn);
	newFolder->setWide(true);
	newFolder->setClickedCallback(later(_callbacks.newFolder));
	buttons->set({ newNote, newFolder });
	add(buttons, Rem(0.75));

	// Справка есть у всех с первого открытия; кнопка нужна, только чтобы вернуть удалённую
	if (data.guideMissing) {
		const auto guide = Ui::CreateChild<NotesTextButton>(
			this,
			tr::lng_parvane_notes_guide_return(tr::now),
			QString(),
			NotesTextButton::Kind::Ghost);
		guide->setWide(true);
		guide->setClickedCallback(later(_callbacks.guide));
		add(guide, Rem(0.25));
	}
	resizeToWidth(width());
	update();
}

int KnowledgeList::resizeGetHeight(int newWidth) {
	auto y = 0;
	for (auto &group : _groups) {
		group.rect = QRect();
	}
	for (const auto &item : _items) {
		y += item.top;
		item.widget->resizeToWidth(newWidth);
		item.widget->moveToLeft(0, y, newWidth);
		if (item.group >= 0) {
			auto &rect = _groups[item.group].rect;
			rect = rect.united(item.widget->geometry());
		}
		y += item.widget->height();
	}
	return y + Rem(0.25);
}

std::optional<QRect> KnowledgeList::rowGeometry(const std::string &noteId) const {
	const auto i = _rows.find(noteId);
	return (i != _rows.end()) ? std::make_optional(i->second->geometry()) : std::nullopt;
}

int KnowledgeList::groupAt(QPoint position) const {
	for (auto i = 0; i != int(_groups.size()); ++i) {
		if (_groups[i].isTarget && _groups[i].rect.contains(position)) {
			return i;
		}
	}
	return -1;
}

void KnowledgeList::paintEvent(QPaintEvent *e) {
	if (_dropGroup < 0 || _dropGroup >= int(_groups.size())) {
		return;
	}
	// `.folderDrop`: пунктир акцентом вокруг группы
	auto p = QPainter(this);
	PainterHighQualityEnabler hq(p);
	auto pen = QPen(ToneColor(Tone::Accent), Px(2));
	pen.setStyle(Qt::DashLine);
	p.setPen(pen);
	p.setBrush(Qt::NoBrush);
	p.drawRoundedRect(QRectF(_groups[_dropGroup].rect).adjusted(1, 1, -1, -1), Rem(0.5), Rem(0.5));
}

bool KnowledgeList::eventFilter(QObject *o, QEvent *e) {
	// Перенос заметки в папку перетаскиванием строки
	const auto i = _draggable.find(o);
	if (i == _draggable.end()) {
		return false;
	}
	const auto widget = static_cast<QWidget*>(o);
	switch (e->type()) {
	case QEvent::MouseButtonPress: {
		const auto event = static_cast<QMouseEvent*>(e);
		if (event->button() == Qt::LeftButton) {
			_suppressClick = false;
			_drag = RowDrag{ i->second, widget->mapTo(this, event->pos()) };
		}
	} break;
	case QEvent::MouseMove: {
		const auto event = static_cast<QMouseEvent*>(e);
		if (!_drag || !(event->buttons() & Qt::LeftButton)) {
			break;
		}
		const auto position = widget->mapTo(this, event->pos());
		if (!_drag->active && (position - _drag->start).manhattanLength() >= Rem(0.5)) {
			_drag->active = true;
			setCursor(Qt::ClosedHandCursor);
		}
		if (_drag->active) {
			const auto group = groupAt(position);
			if (group != _dropGroup) {
				_dropGroup = group;
				update();
			}
		}
	} break;
	case QEvent::MouseButtonRelease: {
		if (!_drag) {
			break;
		}
		const auto drag = *_drag;
		_drag = std::nullopt;
		if (!drag.active) {
			break;
		}
		setCursor(style::cur_default);
		const auto group = _dropGroup;
		_dropGroup = -1;
		update();
		_suppressClick = true;
		if (group >= 0 && _callbacks.move) {
			const auto folderId = _groups[group].folderId;
			const auto noteId = drag.noteId;
			const auto move = _callbacks.move;
			crl::on_main(this, [=] {
				move(noteId, folderId);
			});
		}
	} break;
	default: break;
	}
	return false;
}

} // namespace Parvane::Knowledge
