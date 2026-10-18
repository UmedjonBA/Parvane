// Parvane fork: реализация parvane_planner_agenda.h — «Список» и группы. Размеры — из web Planner.module.scss
// (`.agenda*`, `.group*`, `.feedLine*`, `.swatch*`), в комментариях — rem.
#include "parvane/parvane_planner_agenda.h"

#include "lang/lang_keys.h"
#include "base/algorithm.h"
#include "ui/painter.h"
#include "ui/wrap/vertical_layout.h"

#include <QtCore/QPointer>
#include "ui/widgets/popup_menu.h"
#include "ui/widgets/fields/input_field.h"

#include <parvane/sections/planner_links.h>

namespace Parvane::PlannerViews {
namespace {

constexpr auto kGroupNameMax = 60;

struct GroupStat {
	int count = 0;
	int minutes = 0;
};

} // namespace

struct AgendaView::Shared {
	ViewPtr view;
	std::string day;
	std::string today;
	std::vector<std::pair<std::string, planner::DayIndexEntry>> days;
	std::map<std::string, GroupStat> stats; // "" — без группы

	bool isPicking = false;
	std::vector<std::pair<std::string, Pick>> picks; // по порядку отметки
	std::string target;
	bool withRepeats = true;

	struct Editing {
		std::optional<std::string> from; // нет — новая группа
		std::string name;
		int color = 0;
	};
	std::optional<Editing> editing;

	Fn<void()> changed; // перерисовать оба столбца
	Fn<void()> toast;

	[[nodiscard]] bool isPicked(const std::string &key) const {
		return std::any_of(picks.begin(), picks.end(), [&](const auto &item) { return item.first == key; });
	}
	void togglePick(const std::string &key, Pick pick) {
		const auto i = std::find_if(picks.begin(), picks.end(), [&](const auto &item) { return item.first == key; });
		if (i != picks.end()) {
			picks.erase(i);
		} else {
			picks.emplace_back(key, std::move(pick));
		}
		if (changed) {
			changed();
		}
	}
};

// Повестка: дни с делами, строка — время и блок цвета записи; срок задачи — красной строкой
class AgendaView::List final : public PlannerCanvas {
public:
	List(QWidget *parent, Actions actions, std::shared_ptr<Shared> shared)
	: PlannerCanvas(parent, std::move(actions))
	, _shared(std::move(shared)) {
	}

protected:
	int draw(QPainter *p, int width) override;

private:
	const std::shared_ptr<Shared> _shared;

};

int AgendaView::List::draw(QPainter *p, int width) {
	const auto &shared = *_shared;
	if (!shared.view) {
		return 0;
	}
	const auto &state = shared.view->state;
	const auto actions = _actions;
	const auto weak = _shared;
	if (shared.days.empty()) {
		// `.empty`: по центру, поля 2.5rem
		const auto font = Kit::Font(Kit::kBodyPx);
		const auto text = tr::lng_parvane_planner_agenda_empty(tr::now);
		const auto textWidth = std::min(font->width(text), width);
		DrawElided(p, font, ToneColor(Tone::Muted), (width - textWidth) / 2, Kit::Rem(2.5) + font->ascent, text, width);
		return Kit::Rem(2.5) * 2 + font->height;
	}
	const auto timeWidth = Kit::Rem(3);
	const auto gap = Kit::Rem(0.625);
	const auto linePad = Kit::Rem(0.1875);
	const auto bodyX = timeWidth + gap;
	const auto bodyWidth = std::max(width - bodyX, 0);
	const auto muted = ToneColor(Tone::Muted);

	// Строка повестки (`.feedLine` + `.feedBlock`)
	struct Line {
		QString time;
		QColor timeColor;
		std::string name;
		QString sub;
		QString note;
		QColor color;
		bool done = false;
		std::string pickKey; // пусто — отметить нельзя (срок)
		Pick pick;
		Fn<void()> open;
	};
	const auto drawLine = [&](int top, const Line &line) {
		const auto padX = Kit::Rem(0.625);
		const auto padY = Kit::Rem(0.375);
		const auto nameFont = Kit::Font(Kit::kBodyPx, true);
		const auto subFont = Kit::Font(12, false, true);
		const auto noteFont = Kit::Font(13);
		const auto nameLine = Kit::Px(22);
		const auto subLine = Kit::Px(18);
		const auto noteLine = Kit::Px(19);
		const auto inner = padY * 2 + nameLine + subLine + (line.note.isEmpty() ? 0 : noteLine);
		const auto height = inner + 2 * linePad;
		const auto whole = QRect(0, top, width, height);
		const auto picked = shared.isPicking && !line.pickKey.empty() && shared.isPicked(line.pickKey);
		if (p) {
			if (picked) {
				p->setPen(QPen(ToneColor(Tone::Accent), Kit::Px(2)));
				p->setBrush(Kit::Mix(Tone::Accent, 0.18));
				p->drawRoundedRect(QRectF(whole).adjusted(1, 1, -1, -1), Kit::Rem(0.5), Kit::Rem(0.5));
			}
			const auto timeFont = Kit::Font(13, false, true);
			DrawElided(p, timeFont, line.timeColor, 0, top + (height - timeFont->height) / 2 + timeFont->ascent, line.time,
				timeWidth);
			const auto rect = QRect(bodyX, top + linePad, bodyWidth, inner);
			const auto hovered = over(rect);
			const auto fill = MixOver(line.color, hovered ? 0.26 : 0.16, ToneColor(Tone::Panel));
			p->setPen(Qt::NoPen);
			p->setBrush(fill);
			p->drawRoundedRect(rect, Kit::Rem(0.375), Kit::Rem(0.375));
			p->setBrush(line.color);
			p->drawRoundedRect(QRect(rect.x(), rect.y(), Kit::Rem(0.375), rect.height()), Kit::Px(2), Kit::Px(2));
			p->fillRect(QRect(rect.x() + Kit::Px(3), rect.y(), Kit::Rem(0.375) - Kit::Px(3), rect.height()), fill);
			const auto left = rect.x() + Kit::Px(3) + padX;
			const auto textWidth = std::max(rect.right() - padX - left, 0);
			auto y = rect.y() + padY;
			DrawName(p, { nameFont, line.done ? ToneColor(Tone::Faint) : ToneColor(Tone::Fg), line.done }, left,
				y + (nameLine - nameFont->height) / 2 + nameFont->ascent, textWidth, line.name, [&](QRect r, std::string note) {
					if (!shared.isPicking) {
						linkArea(r, note);
					}
				});
			y += nameLine;
			DrawElided(p, subFont, muted, left, y + (subLine - subFont->height) / 2 + subFont->ascent, line.sub, textWidth);
			y += subLine;
			if (!line.note.isEmpty()) {
				DrawElided(p, noteFont, muted, left, y + (noteLine - noteFont->height) / 2 + noteFont->ascent, line.note,
					textWidth);
			}
		}
		// В режиме выбора нажатие на запись отмечает её, а не открывает
		if (shared.isPicking && !line.pickKey.empty()) {
			const auto key = line.pickKey;
			const auto pick = line.pick;
			area(whole, [weak, key, pick] {
				weak->togglePick(key, pick);
			});
		} else if (!shared.isPicking || line.pickKey.empty()) {
			area(QRect(bodyX, top + linePad, bodyWidth, inner), line.open);
		}
		return height;
	};

	auto y = 0;
	const auto titleFont = Kit::Font(14, true);
	for (const auto &[key, entry] : shared.days) {
		// Заголовок дня — кнопка (`.agendaDayTitle`)
		y += Kit::Rem(0.875);
		const auto title = FormatRelativeDay(key, shared.today) + u", "_q + FormatDay(key);
		const auto titleRect = QRect(0, y, std::min(titleFont->width(title), width), titleFont->height);
		if (p) {
			const auto color = (key == shared.today) ? ToneColor(Tone::Accent)
				: entry.isHoliday ? ToneColor(Tone::Red)
				: muted;
			DrawElided(p, over(titleRect) ? titleFont->underline() : titleFont, color, 0, y + titleFont->ascent, title,
				width);
		}
		area(titleRect, [actions, day = key] {
			if (actions.pickDay) {
				actions.pickDay(day);
			}
		});
		y += titleFont->height + Kit::Rem(0.375);

		// События на весь день — первыми, дальше события и задачи по времени начала, задачи без времени — в конце
		auto lines = std::vector<std::pair<std::string, Line>>();
		for (const auto &event : entry.events) {
			const auto allDay = event.isAllDay.value_or(false);
			const auto holiday = event.isHoliday.value_or(false);
			auto line = Line();
			line.time = allDay ? tr::lng_parvane_planner_all_day_tiny(tr::now) : Q(event.start);
			line.timeColor = muted;
			line.name = event.name;
			line.sub = (allDay
				? (holiday ? tr::lng_parvane_planner_holiday(tr::now) : tr::lng_parvane_planner_all_day(tr::now))
				: (Q(event.start) + QChar(0x2013) + Q(event.end)))
				+ (event.repeat ? (u" · "_q + tr::lng_parvane_planner_repeat_mark(tr::now)) : QString());
			line.note = event.description ? Q(planner::formatDescriptionLine(event.description)) : QString();
			line.color = EntryColor(planner::getEventColor(state, event), holiday ? Kind::Due : Kind::Event);
			line.pickKey = "e:" + event.id + ":" + key;
			line.pick = Pick{ planner::GroupPick{ planner::SeriesKind::Event, event.id, key, event.repeat.has_value() },
				event.name };
			line.open = [actions, id = event.id, day = key] {
				if (actions.openEvent) {
					actions.openEvent(id, day);
				}
			};
			lines.emplace_back(allDay ? std::string() : event.start, std::move(line));
		}
		for (const auto &task : entry.tasks) {
			const auto isTimed = task.start && !task.start->empty() && task.minutes;
			auto line = Line();
			line.time = task.start ? Q(*task.start) : u"—"_q;
			line.timeColor = muted;
			line.name = task.name;
			if (isTimed) {
				line.sub = Q(*task.start) + QChar(0x2013)
					+ Q(planner::toTime(planner::toMinutes(*task.start) + *task.minutes));
			} else {
				auto parts = QStringList{ tr::lng_parvane_planner_kind_task(tr::now).toLower() };
				if (task.minutes) {
					parts.push_back(FormatDuration(*task.minutes));
				}
				line.sub = parts.join(u" · "_q);
			}
			if (task.repeat) {
				line.sub += u" · "_q + tr::lng_parvane_planner_repeat_mark(tr::now);
			}
			line.note = Q(planner::formatDescriptionLine(task.description));
			line.color = EntryColor(planner::getListColor(state, task.project), Kind::Task);
			line.done = (task.status == "done");
			const auto instanceDay = task.instanceDay.value_or(std::string());
			line.pickKey = "t:" + task.id + ":" + instanceDay;
			line.pick = Pick{
				planner::GroupPick{
					planner::SeriesKind::Task,
					task.id,
					instanceDay.empty() ? std::nullopt : std::optional<std::string>(instanceDay),
					task.repeat.has_value(),
				},
				task.name,
			};
			line.open = [actions, id = task.id, instanceDay] {
				if (actions.openTask) {
					actions.openTask(id, instanceDay);
				}
			};
			lines.emplace_back(task.start.value_or("99"), std::move(line));
		}
		std::stable_sort(lines.begin(), lines.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
		for (const auto &[order, line] : lines) {
			y += drawLine(y, line) + Kit::Rem(0.25);
		}
		for (const auto &task : entry.deadlines) {
			auto line = Line();
			line.time = tr::lng_parvane_planner_due_tiny(tr::now);
			line.timeColor = ToneColor(Tone::Red);
			line.name = task.name;
			line.sub = FormatProject(task.project);
			line.color = KindColor(Kind::Due);
			line.open = [actions, id = task.id] {
				if (actions.openTask) {
					actions.openTask(id, std::string());
				}
			};
			y += drawLine(y, line) + Kit::Rem(0.25);
		}
	}
	return y;
}

// Группы и «Добавить в группу» (правая колонка `.agendaSide`)
class AgendaView::Side final : public PlannerCanvas {
public:
	Side(QWidget *parent, Actions actions, std::shared_ptr<Shared> shared)
	: PlannerCanvas(parent, std::move(actions))
	, _shared(std::move(shared)) {
	}

	void refreshEditor();

protected:
	int draw(QPainter *p, int width) override;
	void resizeEvent(QResizeEvent *e) override;

private:
	void startEdit(std::optional<std::string> from);
	void save();
	void confirmDelete();
	void apply();
	void chooseTarget(QRect anchor);

	const std::shared_ptr<Shared> _shared;
	Kit::Field *_field = nullptr;
	QRect _fieldRect;
	base::unique_qptr<Ui::PopupMenu> _menu;

};

void AgendaView::Side::startEdit(std::optional<std::string> from) {
	auto &shared = *_shared;
	const auto same = shared.editing && shared.editing->from == from;
	if (same) {
		shared.editing.reset();
	} else {
		auto editing = Shared::Editing{ from };
		if (from) {
			editing.name = *from;
			for (const auto &list : shared.view->state.lists) {
				if (list.name == *from) {
					editing.color = list.color.value_or(0);
				}
			}
		}
		shared.editing = editing;
	}
	refreshEditor();
	shared.changed();
}

void AgendaView::Side::refreshEditor() {
	const auto &shared = *_shared;
	if (!shared.editing) {
		if (_field) {
			delete base::take(_field);
		}
		return;
	}
	const auto placeholder = shared.editing->from
		? tr::lng_parvane_planner_group_name(tr::now)
		: tr::lng_parvane_planner_new_list(tr::now);
	if (!_field) {
		_field = Ui::CreateChild<Kit::Field>(this, Kit::Field::Kind::Input, rpl::single(placeholder),
			Q(shared.editing->name));
		_field->input()->setMaxLength(kGroupNameMax);
		_field->textChanges() | rpl::on_next([=](QString text) {
			if (_shared->editing) {
				_shared->editing->name = S(text);
			}
		}, _field->lifetime());
		_field->submits() | rpl::on_next([=] { save(); }, _field->lifetime());
		_field->show();
		_field->setFocusFast();
	} else if (_field->text() != Q(shared.editing->name)) {
		_field->setText(Q(shared.editing->name));
	}
}

void AgendaView::Side::save() {
	auto &shared = *_shared;
	if (!shared.editing || !shared.view) {
		return;
	}
	const auto editing = *shared.editing;
	// Проверка на копии: правка «Плана» применяется безусловно
	auto check = shared.view->state;
	const auto error = editing.from
		? planner::renameGroup(check, *editing.from, editing.name)
		: planner::createGroup(check, editing.name, editing.color, planner::randomUuid);
	if (error) {
		if (_actions.toast) {
			_actions.toast((*error == "duplicate")
				? tr::lng_parvane_planner_error_group_duplicate(tr::now)
				: tr::lng_parvane_planner_error_list_name(tr::now));
		}
		return;
	}
	const auto normalized = Q(planner::normalizeGroupName(editing.name));
	Sections::UpdatePlanner([editing](planner::State &state) {
		if (!editing.from) {
			planner::createGroup(state, editing.name, editing.color, planner::randomUuid);
			return;
		}
		planner::renameGroup(state, *editing.from, editing.name);
		planner::setGroupColor(state, planner::normalizeGroupName(editing.name), editing.color);
	}, editing.from
		? tr::lng_parvane_planner_notice_group_saved(tr::now)
		: tr::lng_parvane_planner_notice_list_created(tr::now, lt_name, normalized));
	shared.editing.reset();
	refreshEditor();
	shared.changed();
}

void AgendaView::Side::confirmDelete() {
	const auto name = _shared->editing ? _shared->editing->from : std::nullopt;
	const auto host = _actions.sheetHost ? _actions.sheetHost() : nullptr;
	if (!name || !host) {
		return;
	}
	const auto sheet = Kit::Sheet::Show(host, {
		.title = tr::lng_parvane_planner_group_delete(tr::now),
		.closeName = tr::lng_parvane_planner_close(tr::now),
	});
	sheet->add(object_ptr<Kit::Label>(
		sheet->content(),
		tr::lng_parvane_planner_group_delete_confirm(tr::now, lt_name, Q(*name)),
		Kit::Label::Style{ .multiline = true }));
	const auto buttons = sheet->addButtons();
	const auto weakSheet = QPointer<Kit::Sheet>(sheet.get());
	const auto shared = _shared;
	const auto weak = QPointer<AgendaView::Side>(this);
	buttons->add(object_ptr<Kit::PushButton>(
		buttons,
		tr::lng_parvane_planner_group_delete(tr::now),
		Kit::PushButton::Kind::Danger))->setClickedCallback([=] {
		Sections::UpdatePlanner([name = *name](planner::State &state) {
			planner::deleteGroup(state, name);
		}, tr::lng_parvane_planner_notice_group_deleted(tr::now));
		shared->editing.reset();
		if (weak) {
			weak->refreshEditor();
		}
		shared->changed();
		if (weakSheet) {
			weakSheet->requestClose();
		}
	});
	buttons->add(object_ptr<Kit::PushButton>(
		buttons,
		tr::lng_parvane_planner_cancel(tr::now),
		Kit::PushButton::Kind::Ghost))->setClickedCallback([=] {
		if (weakSheet) {
			weakSheet->requestClose();
		}
	});
}

void AgendaView::Side::apply() {
	auto &shared = *_shared;
	if (shared.picks.empty() || shared.target.empty()) {
		return;
	}
	auto list = std::vector<planner::GroupPick>();
	for (const auto &[key, pick] : shared.picks) {
		list.push_back(pick.pick);
	}
	const auto target = shared.target;
	const auto withRepeats = shared.withRepeats;
	Sections::UpdatePlanner([list, target, withRepeats](planner::State &state) {
		planner::assignToGroup(state, list, target, withRepeats, planner::randomUuid);
	}, tr::lng_parvane_planner_notice_group_added(
		tr::now,
		lt_name,
		Q(target),
		lt_amount,
		QString::number(list.size())));
	shared.isPicking = false;
	shared.picks.clear();
	shared.changed();
}

void AgendaView::Side::chooseTarget(QRect anchor) {
	if (!_shared->view) {
		return;
	}
	_menu = Kit::CreateMenu(this);
	const auto shared = _shared;
	for (const auto &list : shared->view->state.lists) {
		Kit::AddMenuAction(_menu.get(), Q(list.name), [shared, name = list.name] {
			shared->target = name;
			shared->changed();
		});
	}
	_menu->popup(mapToGlobal(anchor.bottomLeft()));
}

void AgendaView::Side::resizeEvent(QResizeEvent *e) {
	if (_field && !_fieldRect.isEmpty()) {
		_field->resizeToWidth(_fieldRect.width());
		_field->move(_fieldRect.topLeft());
	}
}

int AgendaView::Side::draw(QPainter *p, int width) {
	auto &shared = *_shared;
	if (!shared.view) {
		return 0;
	}
	const auto &state = shared.view->state;
	const auto gap = Kit::Rem(0.75);
	auto y = 0;

	// Шапка: «Группы», период, «Добавить в группу»
	const auto titleFont = Kit::Font(16, true);
	const auto periodFont = Kit::Font(12);
	const auto pickText = tr::lng_parvane_planner_group_pick(tr::now);
	const auto pickWidth = ButtonWidth(pickText, QString());
	const auto headHeight = std::max(titleFont->height + periodFont->height, Kit::Rem(2.25));
	const auto textWidth = shared.isPicking ? width : std::max(width - pickWidth - gap, 0);
	DrawElided(p, titleFont, ToneColor(Tone::Fg), 0, (headHeight - titleFont->height - periodFont->height) / 2
		+ titleFont->ascent, tr::lng_parvane_planner_groups(tr::now), textWidth);
	DrawElided(p, periodFont, ToneColor(Tone::Muted), 0, (headHeight - titleFont->height - periodFont->height) / 2
		+ titleFont->height + periodFont->ascent, tr::lng_parvane_planner_groups_period(tr::now), textWidth);
	if (!shared.isPicking) {
		const auto rect = QRect(width - pickWidth, (headHeight - Kit::Rem(2.25)) / 2, pickWidth, Kit::Rem(2.25));
		if (p) {
			p->setPen(Qt::NoPen);
			p->setBrush(ToneColor(Tone::Accent));
			p->drawRoundedRect(rect, Kit::Rem(0.5), Kit::Rem(0.5));
			const auto font = Kit::Font(14, true);
			DrawElided(p, font, ToneColor(Tone::AccentInk), rect.x() + Kit::Rem(0.875),
				rect.y() + (rect.height() - font->height) / 2 + font->ascent, pickText, rect.width());
		}
		const auto weak = _shared;
		area(rect, [weak] {
			auto &s = *weak;
			s.isPicking = true;
			s.picks.clear();
			s.withRepeats = true;
			const auto &lists = s.view->state.lists;
			const auto known = std::any_of(lists.begin(), lists.end(), [&](const planner::List &list) {
				return list.name == s.target;
			});
			if (!known) {
				s.target = lists.empty() ? std::string() : lists.front().name;
			}
			s.changed();
		});
	}
	y += headHeight + gap;

	// Группы цветом с числом записей и часов
	const auto chipHeight = Kit::Rem(2.25);
	const auto chipFont = Kit::Font(14);
	const auto statFont = Kit::Font(12);
	const auto drawChip = [&](const QString &name, QColor dot, const QString &stat, bool active, bool isStatic,
			Fn<void()> click, const QString &icon = QString()) {
		const auto rect = QRect(0, y, width, chipHeight);
		if (p) {
			const auto hovered = !isStatic && over(rect);
			p->setPen(QPen((active || hovered) ? ToneColor(Tone::Accent) : ToneColor(Tone::Line2), 1));
			p->setBrush(ToneColor(Tone::Panel));
			p->drawRoundedRect(QRectF(rect).adjusted(0.5, 0.5, -0.5, -0.5), Kit::Rem(0.5), Kit::Rem(0.5));
			auto x = rect.x() + Kit::Rem(0.75);
			if (!icon.isEmpty()) {
				const auto size = Kit::Px(16);
				PaintPlannerIcon(*p, icon, ToneColor(Tone::Muted), x, rect.y() + (rect.height() - size) / 2, size);
				x += size + Kit::Rem(0.5);
			} else {
				const auto size = Kit::Rem(0.625);
				Kit::PaintDot(*p, QPoint(x + size / 2, rect.y() + rect.height() / 2), dot, size);
				x += size + Kit::Rem(0.5);
			}
			auto right = rect.right() - Kit::Rem(0.75);
			if (!stat.isEmpty()) {
				const auto statWidth = statFont->width(stat);
				DrawElided(p, statFont, ToneColor(Tone::Muted), right - statWidth,
					rect.y() + (rect.height() - statFont->height) / 2 + statFont->ascent, stat, statWidth);
				right -= statWidth + Kit::Rem(0.5);
			}
			DrawElided(p, chipFont, icon.isEmpty() ? ToneColor(Tone::Fg) : ToneColor(Tone::Muted), x,
				rect.y() + (rect.height() - chipFont->height) / 2 + chipFont->ascent, name, right - x);
		}
		if (click) {
			area(rect, click);
		}
		y += chipHeight + Kit::Rem(0.375);
	};
	const auto statText = [&](const std::string &name) {
		const auto i = shared.stats.find(name);
		return (i != shared.stats.end())
			? (QString::number(i->second.count) + u" · "_q + FormatHours(i->second.minutes))
			: u"—"_q;
	};
	for (const auto &list : state.lists) {
		const auto color = ListColor(list.color.value_or(0));
		drawChip(Q(list.name), color.isValid() ? color : ToneColor(Tone::Muted), statText(list.name),
			shared.editing && shared.editing->from == list.name, false, [=, name = list.name] {
				startEdit(name);
			});
	}
	if (shared.stats.count(std::string())) {
		drawChip(tr::lng_parvane_planner_no_list(tr::now), ToneColor(Tone::Muted), statText(std::string()), false, true,
			nullptr);
	}
	drawChip(tr::lng_parvane_planner_group_add(tr::now), QColor(), QString(), false, false, [=] {
		startEdit(std::nullopt);
	}, u"add"_q);
	y += Kit::Rem(0.375);

	// Панель (`.groupEditor` / `.groupPick`): рамка `--pv-line2`, поля 0.875rem. Содержимое меряется первым
	// проходом, затем рисуется рамка и само содержимое
	const auto panelPad = Kit::Rem(0.875);
	const auto innerWidth = std::max(width - 2 * panelPad, 0);
	using ButtonList = std::vector<std::tuple<QString, Kit::PushButton::Kind, Fn<void()>, bool>>;
	const auto drawButtonsRow = [&](QPainter *q, int top, const ButtonList &list) {
		auto x = panelPad;
		auto rowTop = top;
		for (const auto &[text, kind, click, enabled] : list) {
			const auto buttonWidth = ButtonWidth(text, QString());
			if (x > panelPad && x + buttonWidth > panelPad + innerWidth) {
				x = panelPad;
				rowTop += Kit::Rem(2.25) + Kit::Rem(0.5);
			}
			const auto rect = QRect(x, rowTop, buttonWidth, Kit::Rem(2.25));
			if (q) {
				q->save();
				if (!enabled) {
					q->setOpacity(0.5);
				}
				const auto hovered = enabled && over(rect);
				auto bg = QColor(0, 0, 0, 0);
				auto fg = ToneColor(Tone::Muted);
				auto font = Kit::Font(14);
				if (kind == Kit::PushButton::Kind::Accent) {
					bg = ToneColor(Tone::Accent);
					fg = ToneColor(Tone::AccentInk);
					font = Kit::Font(14, true);
				} else if (kind == Kit::PushButton::Kind::Danger) {
					bg = hovered ? Kit::Mix(Tone::Red, 0.22) : Kit::Mix(Tone::Red, 0.14);
					fg = ToneColor(Tone::Red);
				} else if (hovered) {
					bg = ToneColor(Tone::Hover);
					fg = ToneColor(Tone::Fg);
				}
				q->setPen(Qt::NoPen);
				q->setBrush(bg);
				q->drawRoundedRect(rect, Kit::Rem(0.5), Kit::Rem(0.5));
				DrawElided(q, font, fg, rect.x() + Kit::Rem(0.875), rect.y() + (rect.height() - font->height) / 2
					+ font->ascent, text, rect.width());
				q->restore();
				if (enabled) {
					area(rect, click);
				}
			}
			x += buttonWidth + Kit::Rem(0.5);
		}
		return rowTop + Kit::Rem(2.25) - top;
	};
	const auto panel = [&](QPainter *q, int top, Fn<int(QPainter*)> body) {
		const auto height = body(nullptr);
		if (q) {
			q->setPen(QPen(ToneColor(Tone::Line2), 1));
			q->setBrush(ToneColor(Tone::Panel));
			q->drawRoundedRect(QRectF(0, top, width, height).adjusted(0.5, 0.5, -0.5, -0.5), Kit::Rem(0.5),
				Kit::Rem(0.5));
			body(q);
		}
		return height;
	};

	if (shared.editing) {
		const auto top = y;
		y += panel(p, top, [&](QPainter *q) {
			auto inner = top + panelPad;
			// Поле названия — живой виджет поверх холста
			const auto fieldHeight = Kit::Rem(2.625);
			_fieldRect = QRect(panelPad, inner, innerWidth, fieldHeight);
			inner += fieldHeight + gap;
			// Кружки цвета: 0 — без цвета
			const auto swatch = Kit::Rem(1.75);
			const auto swatchGap = Kit::Rem(0.375);
			auto sx = panelPad;
			auto swatchesTop = inner;
			for (auto color = 0; color <= planner::kListColorCount; ++color) {
				if (sx > panelPad && sx + swatch > panelPad + innerWidth) {
					sx = panelPad;
					swatchesTop += swatch + swatchGap;
				}
				const auto rect = QRect(sx, swatchesTop, swatch, swatch);
				if (q) {
					if (shared.editing->color == color) {
						q->setPen(QPen(ToneColor(Tone::Accent), Kit::Px(2)));
						q->setBrush(Qt::NoBrush);
						q->drawEllipse(QRectF(rect).adjusted(-Kit::Px(2), -Kit::Px(2), Kit::Px(2), Kit::Px(2)));
					}
					q->setPen(Qt::NoPen);
					q->setBrush(ToneColor(Tone::Panel));
					q->drawEllipse(rect);
					const auto ring = Kit::Rem(0.1875);
					if (color) {
						q->setBrush(ListColor(color));
						q->drawEllipse(QRectF(rect).adjusted(ring, ring, -ring, -ring));
					} else {
						q->setPen(QPen(ToneColor(Tone::Line2), 1));
						q->setBrush(Qt::NoBrush);
						q->drawEllipse(QRectF(rect).adjusted(0.5, 0.5, -0.5, -0.5));
					}
					const auto weak = _shared;
					area(rect, [weak, color] {
						if (weak->editing) {
							weak->editing->color = color;
							weak->changed();
						}
					});
				}
				sx += swatch + swatchGap;
			}
			inner = swatchesTop + swatch + gap;
			auto buttons = ButtonList{
				{
					shared.editing->from
						? tr::lng_parvane_planner_save(tr::now)
						: tr::lng_parvane_planner_create_list(tr::now),
					Kit::PushButton::Kind::Accent,
					[=] { save(); },
					true,
				},
				{
					tr::lng_parvane_planner_cancel(tr::now),
					Kit::PushButton::Kind::Ghost,
					[=] {
						_shared->editing.reset();
						refreshEditor();
						_shared->changed();
					},
					true,
				},
			};
			if (shared.editing->from) {
				buttons.emplace_back(
					tr::lng_parvane_planner_group_delete(tr::now),
					Kit::PushButton::Kind::Danger,
					[=] { confirmDelete(); },
					true);
			}
			inner += drawButtonsRow(q, inner, buttons);
			return inner + panelPad - top;
		}) + gap;
	} else {
		_fieldRect = QRect();
	}

	if (shared.isPicking) {
		const auto top = y;
		y += panel(p, top, [&](QPainter *q) {
			auto inner = top + panelPad;
			const auto hintFont = Kit::Font(13);
			inner += DrawWrapped(q, hintFont, ToneColor(Tone::Muted), QRect(panelPad, inner, innerWidth, 0),
				tr::lng_parvane_planner_group_pick_hint(tr::now), 0) + gap;
			// Предварительный список: ряд, отмеченный в нескольких днях, — одна строка, когда он идёт целиком
			auto names = std::vector<QString>();
			auto hasRepeat = false;
			for (const auto &[key, pick] : shared.picks) {
				hasRepeat = hasRepeat || pick.pick.isRepeat;
				const auto name = (pick.pick.isRepeat && shared.withRepeats)
					? (PlainName(pick.name) + u" · "_q + tr::lng_parvane_planner_repeat_mark(tr::now))
					: PlainName(pick.name);
				if (std::find(names.begin(), names.end(), name) == names.end()) {
					names.push_back(name);
				}
			}
			if (!names.empty()) {
				const auto font = Kit::Font(13);
				auto x = panelPad;
				auto rowTop = inner;
				const auto pillHeight = font->height + Kit::Rem(0.25);
				for (const auto &name : names) {
					const auto pillWidth = std::min(font->width(name) + Kit::Rem(1), innerWidth);
					if (x > panelPad && x + pillWidth > panelPad + innerWidth) {
						x = panelPad;
						rowTop += pillHeight + Kit::Rem(0.375);
					}
					if (q) {
						q->setPen(Qt::NoPen);
						q->setBrush(ToneColor(Tone::Bg));
						q->drawRoundedRect(QRect(x, rowTop, pillWidth, pillHeight), Kit::Rem(0.75), Kit::Rem(0.75));
						DrawElided(q, font, ToneColor(Tone::Fg), x + Kit::Rem(0.5), rowTop + Kit::Rem(0.125)
							+ font->ascent, name, pillWidth - Kit::Rem(1));
					}
					x += pillWidth + Kit::Rem(0.375);
				}
				inner = rowTop + pillHeight + gap;
			}
			const auto smallFont = Kit::Font(13);
			DrawElided(q, smallFont, ToneColor(Tone::Muted), panelPad, inner + smallFont->ascent,
				tr::lng_parvane_planner_group_picked(tr::now, lt_amount, QString::number(shared.picks.size())),
				innerWidth);
			inner += smallFont->height + Kit::Rem(0.5);
			// Выбор группы — кнопка со списком
			const auto selectRect = QRect(panelPad, inner, innerWidth, Kit::Rem(2.625));
			if (q) {
				q->setPen(QPen(over(selectRect) ? ToneColor(Tone::Accent) : ToneColor(Tone::Line2), 1));
				q->setBrush(ToneColor(Tone::Panel));
				q->drawRoundedRect(QRectF(selectRect).adjusted(0.5, 0.5, -0.5, -0.5), Kit::Rem(0.5), Kit::Rem(0.5));
				const auto font = Kit::Font(Kit::kBodyPx);
				const auto label = shared.target.empty()
					? tr::lng_parvane_planner_field_list(tr::now)
					: Q(shared.target);
				DrawElided(q, font, shared.target.empty() ? ToneColor(Tone::Faint) : ToneColor(Tone::Fg),
					selectRect.x() + Kit::Rem(0.75),
					selectRect.y() + (selectRect.height() - font->height) / 2 + font->ascent,
					label, selectRect.width() - Kit::Rem(2.5));
				const auto icon = Kit::Px(18);
				PaintPlannerIcon(*q, u"down"_q, ToneColor(Tone::Muted), selectRect.right() - Kit::Rem(0.75) - icon,
					selectRect.y() + (selectRect.height() - icon) / 2, icon);
				area(selectRect, [=] { chooseTarget(selectRect); });
			}
			inner += selectRect.height() + gap;
			if (hasRepeat) {
				// «Вместе с повторами»
				const auto side = Kit::Rem(1.25);
				const auto font = Kit::Font(14);
				const auto text = tr::lng_parvane_planner_group_with_repeats(tr::now);
				const auto rect = QRect(panelPad, inner, std::min(side + Kit::Rem(0.5) + font->width(text), innerWidth),
					side);
				if (q) {
					const auto box = QRect(rect.x(), rect.y(), side, side);
					q->setPen(QPen(shared.withRepeats ? ToneColor(Tone::Accent) : ToneColor(Tone::Line2), Kit::Px(2)));
					q->setBrush(shared.withRepeats ? ToneColor(Tone::Accent) : QColor(0, 0, 0, 0));
					q->drawRoundedRect(QRectF(box).adjusted(1, 1, -1, -1), Kit::Px(4), Kit::Px(4));
					if (shared.withRepeats) {
						auto pen = QPen(ToneColor(Tone::AccentInk), Kit::Px(2));
						pen.setCapStyle(Qt::RoundCap);
						q->setPen(pen);
						q->drawPolyline(QPolygonF{
							QPointF(box.x() + side * 0.25, box.y() + side * 0.52),
							QPointF(box.x() + side * 0.43, box.y() + side * 0.7),
							QPointF(box.x() + side * 0.75, box.y() + side * 0.32),
						});
					}
					DrawElided(q, font, ToneColor(Tone::Fg), rect.x() + side + Kit::Rem(0.5),
						rect.y() + (side - font->height) / 2 + font->ascent, text, rect.width() - side - Kit::Rem(0.5));
					const auto weak = _shared;
					area(rect, [weak] {
						weak->withRepeats = !weak->withRepeats;
						weak->changed();
					});
				}
				inner += side + gap;
			}
			const auto canApply = !shared.picks.empty() && !shared.target.empty();
			const auto buttons = ButtonList{
				{ tr::lng_parvane_planner_group_apply(tr::now), Kit::PushButton::Kind::Accent, [=] { apply(); }, canApply },
				{
					tr::lng_parvane_planner_cancel(tr::now),
					Kit::PushButton::Kind::Ghost,
					[=] {
						_shared->isPicking = false;
						_shared->picks.clear();
						_shared->changed();
					},
					true,
				},
			};
			inner += drawButtonsRow(q, inner, buttons);
			return inner + panelPad - top;
		}) + gap;
	}
	if (_field && !_fieldRect.isEmpty()) {
		_field->resizeToWidth(_fieldRect.width());
		_field->move(_fieldRect.topLeft());
	}
	return std::max(y - gap, 0);
}

// ── AgendaView ───────────────────────────────────────────────────────────────

AgendaView::AgendaView(QWidget *parent, Actions actions)
: RpWidget(parent)
, _actions(std::move(actions))
, _shared(std::make_shared<Shared>()) {
	_list = Ui::CreateChild<List>(this, _actions, _shared);
	_side = Ui::CreateChild<Side>(this, _actions, _shared);
	_shared->changed = [=] {
		_list->refresh();
		_side->refresh();
		resizeToWidth(width());
	};
}

void AgendaView::setData(ViewPtr view, std::string day, std::string today) {
	auto &shared = *_shared;
	shared.view = view;
	shared.day = day;
	shared.today = today;
	const auto &state = view->state;
	const auto lastDay = planner::addDays(day, planner::kAgendaDays - 1);
	const auto index = planner::getDayIndex(state, day, lastDay);
	shared.days.clear();
	shared.stats.clear();
	for (const auto &[key, entry] : index) {
		if (entry.tasks.size() + entry.events.size() + entry.deadlines.size() == 0) {
			continue;
		}
		shared.days.emplace_back(key, entry);
		// Записи и время по группам; события на весь день времени не добавляют
		for (const auto &event : entry.events) {
			auto &item = shared.stats[event.project.value_or(std::string())];
			item.count += 1;
			if (!event.isAllDay.value_or(false)) {
				item.minutes += std::max(0, planner::toMinutes(event.end) - planner::toMinutes(event.start));
			}
		}
		for (const auto &task : entry.tasks) {
			auto &item = shared.stats[task.project];
			item.count += 1;
			item.minutes += std::max(0, task.minutes.value_or(0));
		}
	}
	_side->refreshEditor();
	_list->refresh();
	_side->refresh();
	resizeToWidth(width());
}

void AgendaView::relayout(int width) {
	// `.agendaLayout`: повестка до 44rem и справа группы 16–22rem, промежуток 2rem
	const auto gap = Kit::Rem(2);
	const auto sideWidth = std::clamp(width - Kit::Rem(44) - gap, Kit::Rem(16), Kit::Rem(22));
	const auto listWidth = std::max(width - sideWidth - gap, 0);
	_list->resizeToWidth(std::min(listWidth, Kit::Rem(44)));
	_list->move(0, 0);
	_side->resizeToWidth(sideWidth);
	_side->move(listWidth + gap, 0);
}

int AgendaView::resizeGetHeight(int newWidth) {
	relayout(newWidth);
	return std::max(_list->height(), _side->height());
}

} // namespace Parvane::PlannerViews
