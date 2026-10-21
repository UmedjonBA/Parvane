// Parvane fork: реализация parvane_planner_form_editors.h — карточки задачи и события и новая запись «Плана»
// (spec 029, T061). Поведение — как в web (`PlannerTaskEditor.tsx`, `PlannerEventEditor.tsx`,
// `PlannerTaskForm.tsx`); правки — `Sections::UpdatePlanner` (задания идут в рабочий поток: лямбды правок
// берут только значения, не виджеты).
#include "parvane/parvane_kit.h"
#include "parvane/parvane_planner_form_editors.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/qt_object_factory.h"
#include "ui/widgets/fields/input_field.h"
#include "window/window_session_controller.h"

#include <parvane/sections/planner_links.h>

#include <QtGui/QtEvents>

#include <cmath>

namespace Parvane::PlannerForms {
namespace {

using Kit::Font;
using Kit::Px;
using Kit::Rem;

constexpr auto kNameMaxLength = 160;
constexpr auto kStepMaxLength = 160;
constexpr auto kDescriptionMaxLength = 2000; // движок принимает до 4000 байт
constexpr auto kSavedShownMs = crl::time(2000);

// Поле правки со значением (ключ есть; пустое `optional` — «undefined» web)
template <typename T>
[[nodiscard]] planner::PatchField<T> F(const std::optional<T> &value) {
	return planner::PatchField<T>(value);
}

template <typename T>
[[nodiscard]] planner::PatchField<T> V(T value) {
	return planner::PatchField<T>(std::optional<T>(std::move(value)));
}

template <typename T>
[[nodiscard]] planner::PatchField<T> U() {
	return planner::undefinedField<T>();
}

[[nodiscard]] std::optional<std::string> NonEmpty(const std::string &value) {
	return value.empty() ? std::nullopt : std::optional<std::string>(value);
}

[[nodiscard]] planner::PatchField<planner::RepeatPatch> RepeatField(const std::optional<planner::Repeat> &repeat) {
	return repeat ? V(planner::RepeatPatch::of(*repeat)) : U<planner::RepeatPatch>();
}

[[nodiscard]] QString NameOf(const std::string &name) {
	return Q(planner::formatPlainName(name));
}

// Название записи (`.editorTitle` + `.editorTitleEditable`): нажатие открывает правку (`.cardTitleInput`)
class NameTitle final : public Ui::RpWidget {
public:
	NameTitle(QWidget *parent, const QString &name, Fn<void(QString)> commit)
	: RpWidget(parent)
	, _name(name)
	, _commit(std::move(commit)) {
		Kit::RepaintOnTones(this);
		_button = Ui::CreateChild<Kit::Button>(this);
		_button->setAccessibleName(tr::lng_parvane_planner_rename_hint(tr::now));
		_button->setClickedCallback([=] { startEdit(); });
		_button->paintRequest() | rpl::on_next([=] {
			paintTitle();
		}, _button->lifetime());
		setNaturalWidth(-1);
	}

	void setName(const QString &name) {
		_name = name;
		if (!_input) {
			resizeToWidth(width());
			_button->update();
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		if (_input) {
			_input->resizeToWidth(newWidth);
			_input->moveToLeft(0, 0, newWidth);
			return _input->height();
		}
		// 1.25rem полужирным, строка 1.5rem, снизу 0.375rem и линия
		const auto lines = textLines(newWidth);
		const auto h = lines * Rem(1.5) + Rem(0.375) + Px(1);
		_button->setGeometry(0, 0, newWidth, h);
		return h;
	}

private:
	[[nodiscard]] int textLines(int width) const {
		const auto font = Font(20, true);
		const auto available = std::max(width - Rem(1) - Rem(0.375), 1);
		return std::clamp(int(std::ceil(font->width(_name) / double(available))), 1, 4);
	}

	void paintTitle() {
		auto p = QPainter(_button);
		const auto font = Font(20, true);
		const auto icon = Rem(1);
		const auto textWidth = std::max(_button->width() - icon - Rem(0.375), 1);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Fg));
		const auto textRect = QRect(0, 0, textWidth, _button->height() - Rem(0.375) - Px(1));
		auto bounding = QRect();
		p.drawText(textRect, Qt::AlignLeft | Qt::AlignTop | Qt::TextWordWrap, _name, &bounding);
		// `.editorTitleIcon`: прозрачность 0.55, при наведении — 1
		p.setOpacity(_button->isOver() ? 1. : 0.55);
		const auto lastLine = std::max(bounding.bottom() - Rem(1.5), 0);
		const auto x = std::min(bounding.right() + Rem(0.375), _button->width() - icon);
		PaintGlyph(p, u"edit"_q, ToneColor(Tone::Muted), QRect(x, lastLine + (Rem(1.5) - icon) / 2, icon, icon));
		p.setOpacity(1.);
		p.fillRect(0, _button->height() - Px(1), _button->width(), Px(1), ToneColor(Tone::Line2));
	}

	void startEdit() {
		if (_input) {
			return;
		}
		_button->hide();
		_input = Ui::CreateChild<TextInput>(
			this,
			TextInput::Kind::Title,
			tr::lng_parvane_planner_field_task_name(tr::now),
			_name,
			kNameMaxLength);
		_input->show();
		const auto field = _input->input();
		field->submits() | rpl::on_next([=] {
			finish(true);
		}, _input->lifetime());
		field->cancelled() | rpl::on_next([=] {
			finish(false);
		}, _input->lifetime());
		field->focusedChanges() | rpl::on_next([=](bool focused) {
			if (!focused) {
				finish(true);
			}
		}, _input->lifetime());
		resizeToWidth(width());
		field->setFocusFast();
		field->selectAll();
	}

	void finish(bool commit) {
		if (!_input || _finishing) {
			return;
		}
		_finishing = true;
		const auto text = _input->text().trimmed();
		const auto input = _input;
		_input = nullptr;
		input->hide();
		crl::on_main(this, [=] { delete input; });
		_button->show();
		resizeToWidth(width());
		_finishing = false;
		if (commit && !text.isEmpty() && text != _name) {
			_commit(text);
		}
	}

	QString _name;
	Fn<void(QString)> _commit;
	Kit::Button *_button = nullptr;
	TextInput *_input = nullptr;
	bool _finishing = false;

};

// Свободное окно (`.slot`): моноширинный 0.8125rem на `--pv-raised`, поля 0.5rem 0.75rem
class SlotButton final : public Kit::Button {
public:
	SlotButton(QWidget *parent, const QString &text)
	: Button(parent)
	, _text(text) {
		setAccessibleName(text);
		Kit::RepaintOnTones(this);
		const auto font = Font(13, false, true);
		const auto w = font->width(_text) + 2 * Rem(0.75);
		setNaturalWidth(w);
		resize(w, font->height + 2 * Rem(0.5));
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		{
			PainterHighQualityEnabler hq(p);
			p.setPen(Qt::NoPen);
			p.setBrush(ToneColor((isOver() || isDown()) ? Tone::Hover : Tone::Raised));
			p.drawRoundedRect(QRectF(rect()), Rem(0.5), Rem(0.5));
		}
		const auto font = Font(13, false, true);
		p.setFont(font->f);
		p.setPen(ToneColor(Tone::Fg));
		p.drawText(Rem(0.75), (height() - font->height) / 2 + font->ascent, _text);
		if (focusVisible() && hasFocus()) {
			paintFocusRing(p, QRectF(rect()), Rem(0.5));
		}
	}

private:
	QString _text;

};

// Подпись поля `.fieldLabel` над многострочным полем (у `TextArea` мессенджера подпись в рамке)
[[nodiscard]] object_ptr<Kit::Label> FieldLabel(QWidget *parent, const QString &text) {
	return object_ptr<Kit::Label>(parent, text, Kit::Label::Style{ .px = 12, .tone = Tone::Muted });
}

// Отметка «Описание для всех повторов» из ядра
[[nodiscard]] std::optional<planner::DescriptionScope> ScopeOf(
		const planner::State &state,
		planner::SeriesKind kind,
		const planner::SeriesItem &item) {
	return planner::getDescriptionScope(state, kind, item);
}

} // namespace

// ── карточка задачи ──────────────────────────────────────────────────────────

TaskEditor::TaskEditor(QWidget *parent, EditorHost host, std::string taskId, std::string instanceDay, std::string picked)
: RpWidget(parent)
, _host(std::move(host))
, _taskId(std::move(taskId))
, _instanceDay(std::move(instanceDay))
, _picked(std::move(picked))
, _savedTimer([=] {
	_saved = false;
	if (_autosave) {
		_autosave->setText(tr::lng_parvane_planner_auto_saved(tr::now));
	}
}) {
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	Sections::PlannerValue() | rpl::on_next([=](std::shared_ptr<const Sections::PlannerView> view) {
		applyView(view);
	}, lifetime());
}

rpl::producer<QString> TaskEditor::dayLabel() const {
	return _dayLabel.value();
}

bool TaskEditor::isInstance() const {
	return _task.repeat.has_value() && _task.instanceDay && !_task.instanceDay->empty();
}

void TaskEditor::applyView(const std::shared_ptr<const Sections::PlannerView> &view) {
	if (!view) {
		return;
	}
	_view = view;
	const auto &state = view->state;
	const auto i = ranges::find(state.tasks, _taskId, &planner::Task::id);
	if (i == end(state.tasks)) {
		// Новая запись ещё не дошла до снимка — ждём; удалённая — карточка закрывается
		if (_found && _host.close) {
			crl::on_main(this, [close = _host.close] { close(); });
		}
		return;
	}
	const auto first = !_found;
	_found = true;
	_task = (i->repeat && !_instanceDay.empty()) ? planner::taskInstance(*i, _instanceDay) : *i;
	const auto day = _task.instanceDay ? *_task.instanceDay : _task.day.value_or(std::string());
	_dayLabel = day.empty() ? tr::lng_parvane_planner_undated_short(tr::now) : FormatDayLabel(day);
	if (first) {
		const auto start = _task.day ? *_task.day : TodayKey();
		_repeatDraft = std::make_shared<rpl::variable<planner::RepeatDraft>>(
			planner::repeatToDraft(_task.repeat, start));
		_descriptionScope = ScopeOf(state, planner::SeriesKind::Task, planner::SeriesItem(_task));
		_descriptionDraft = Q(_task.description);
	}
	const auto shape = shapeOf();
	if (shape != _shape) {
		_shape = shape;
		rebuild();
	} else {
		refreshValues();
	}
}

QString TaskEditor::shapeOf() const {
	auto parts = QStringList{
		_task.repeat ? u"r"_q : u"-"_q,
		isInstance() ? u"i"_q : u"-"_q,
		_task.origin ? u"o"_q : u"-"_q,
		_descriptionScope ? QString::number(int(*_descriptionScope)) : u"-"_q,
	};
	for (const auto &step : _task.steps) {
		parts.push_back(Q(step.text) + (step.isDone ? u"+"_q : u"-"_q));
	}
	return parts.join(QChar(0x1F));
}

void TaskEditor::markSaved() {
	_saved = true;
	if (_autosave) {
		_autosave->setText(tr::lng_parvane_planner_saved(tr::now));
	}
	_savedTimer.callOnce(kSavedShownMs);
}

void TaskEditor::patchTemplate(planner::ItemPatch changes, const QString &notice) {
	const auto id = _taskId;
	Sections::UpdatePlanner([=](planner::State &state) {
		if (const auto target = planner::findTask(state, id)) {
			planner::applyPatch(*target, changes);
		}
	}, notice);
	_slots = std::nullopt;
	rebuildSlots();
}

// У экземпляра ряда правка полей требует выбора объёма (FR-004); у отделённого дня — тоже, если изменённое
// можно отдать ряду (свой день и отметка выполнения остаются у дня)
bool TaskEditor::patch(planner::ItemPatch changes, const QString &notice) {
	if (isInstance()) {
		_pending = Pending{ .kind = u"patch"_q, .changes = changes, .notice = notice };
		rebuildBottom();
		return true;
	}
	if (_view
		&& planner::seriesOfCopy(_view->state, planner::SeriesKind::Task, planner::SeriesItem(_task))
		&& !planner::changedFields(_task, changes).empty()) {
		_pending = Pending{ .kind = u"copy"_q, .changes = changes, .notice = notice };
		rebuildBottom();
		return true;
	}
	patchTemplate(std::move(changes), notice);
	return true;
}

void TaskEditor::chooseScope(const QString &scope) {
	if (!_pending) {
		return;
	}
	const auto action = *_pending;
	_pending = std::nullopt;
	rebuildBottom();
	const auto task = _task;
	const auto id = _taskId;
	const auto instanceDay = _task.instanceDay.value_or(std::string());
	const auto openTask = _host.openTask;
	const auto close = _host.close;
	const auto kind = planner::SeriesKind::Task;
	if (action.kind == u"copy"_q) {
		if (scope == u"one"_q) {
			patchTemplate(action.changes, action.notice);
			return;
		}
		const auto changes = action.changes;
		Sections::UpdatePlanner([=](planner::State &state) {
			if (const auto target = planner::findTask(state, id)) {
				planner::applyPatch(*target, changes);
			}
			planner::updateFromCopy(state, kind, planner::SeriesItem(task), planner::changedFields(task, changes));
		}, action.notice);
		_slots = std::nullopt;
		rebuildSlots();
		return;
	}
	if (action.kind == u"rule"_q) {
		const auto repeat = action.repeat;
		const auto notice = repeat
			? tr::lng_parvane_planner_notice_repeat_updated(tr::now, lt_name, NameOf(task.name))
			: tr::lng_parvane_planner_notice_repeat_stopped(tr::now, lt_name, NameOf(task.name));
		const auto ruleScope = repeat
			? ((scope == u"following"_q) ? planner::RuleScope::Following : planner::RuleScope::All)
			: ((scope == u"stop"_q) ? planner::RuleScope::Stop : planner::RuleScope::One);
		auto reopenDay = std::make_shared<std::optional<std::string>>();
		UpdatePlannerWithResult([=](planner::State &state) -> std::optional<std::string> {
			const auto result = planner::changeSeriesRule(
				state,
				kind,
				id,
				instanceDay,
				repeat,
				ruleScope,
				planner::ItemPatch(),
				planner::randomUuid);
			if (!result) {
				return std::nullopt;
			}
			// Карточка остаётся на записи этого дня: разовой копии, продолжении ряда либо ближайшем дне правила
			const auto day = planner::nearestSeriesDay(*result, instanceDay);
			return planner::itemId(*result) + "\n" + day.value_or(std::string());
		}, notice, [=](std::optional<std::string> result) {
			if (!result || !openTask) {
				return;
			}
			const auto split = result->find('\n');
			openTask(result->substr(0, split), result->substr(split + 1));
		});
		return;
	}
	if (action.kind == u"delete"_q) {
		Sections::UpdatePlanner([=](planner::State &state) {
			if (scope == u"one"_q) {
				planner::excludeInstance(state, kind, id, instanceDay);
			} else if (scope == u"following"_q) {
				planner::truncateSeries(state, kind, id, instanceDay);
			} else {
				planner::removeSeries(state, kind, id);
			}
		}, tr::lng_parvane_planner_notice_task_deleted(tr::now, lt_name, NameOf(task.name)));
		if (close) {
			close();
		}
		return;
	}
	const auto changes = action.changes;
	const auto changedDay = (changes.day && *changes.day && !(*changes.day)->empty())
		? **changes.day
		: std::string();
	UpdatePlannerWithResult([=](planner::State &state) -> std::optional<std::string> {
		if (scope == u"one"_q) {
			const auto detached = planner::detachInstance(state, kind, id, instanceDay, changes, planner::randomUuid);
			return detached ? std::optional<std::string>(planner::itemId(*detached) + "\n") : std::nullopt;
		}
		// Новый день экземпляра переносит ряд (весь либо его продолжение), а не пишется в шаблон
		auto seriesId = id;
		if (scope == u"following"_q) {
			auto fields = changes;
			fields.day = U<std::string>();
			if (const auto split = planner::splitSeries(state, kind, id, instanceDay, fields, planner::randomUuid)) {
				seriesId = planner::itemId(*split);
			}
		}
		planner::updateSeries(state, kind, seriesId, instanceDay, changes);
		// Уже отделённые дни ряда (всего либо с этого дня) получают те же изменённые поля
		planner::patchCopies(
			state,
			kind,
			id,
			planner::changedFields(task, changes),
			(scope == u"following"_q) ? std::optional<std::string>(instanceDay) : std::nullopt);
		if (seriesId != id || !changedDay.empty()) {
			return seriesId + "\n" + (changedDay.empty() ? instanceDay : changedDay);
		}
		return std::nullopt;
	}, action.notice, [=](std::optional<std::string> result) {
		if (!result || !openTask) {
			return;
		}
		const auto split = result->find('\n');
		openTask(result->substr(0, split), result->substr(split + 1));
	});
}

void TaskEditor::rebuild() {
	if (_repeatRow) {
		_repeatOpen = _repeatRow->isOpen();
	}
	Kit::ClearLayout(_column);
	_title = nullptr;
	_autosave = nullptr;
	_done = nullptr;
	_day = _start = _minutes = _due = nullptr;
	_repeatRow = nullptr;
	_list = nullptr;
	_status = _remind = nullptr;
	_description = nullptr;
	_descriptionSave = nullptr;
	_slotsColumn = nullptr;
	if (_host.footer) {
		Kit::ClearLayout(_host.footer); // кнопки прежней сборки в низу окна
	}
	_bottom = nullptr;
	if (!_view) {
		return;
	}
	const auto controller = _host.controller;
	const auto &state = _view->state;
	const auto gap = Rem(0.5); // `.eventCard`
	const auto task = _task;
	const auto instance = isInstance();
	const auto hasDate = !task.repeat || instance;

	// Название: нажатие открывает правку, пустое возвращает прежнее
	_title = AddTo(_column, object_ptr<NameTitle>(_column, NameOf(task.name), [=](QString name) {
		patch(
			planner::ItemPatch{ .name = V(S(name)) },
			tr::lng_parvane_planner_notice_name_updated(tr::now, lt_name, name));
	}), gap);
	// Поля задачи пишутся сразу (у события — кнопка «Сохранить»): об этом нужно сказать
	_autosave = AddTo(_column, SmallText(_column, _saved
		? tr::lng_parvane_planner_saved(tr::now)
		: tr::lng_parvane_planner_auto_saved(tr::now)), gap);
	if (task.origin) {
		AddTo(_column, SmallText(_column, tr::lng_parvane_planner_series_detached_hint(tr::now)), gap);
	}
	if (hasDate) {
		const auto done = (task.status == "done");
		_done = AddTo(_column, object_ptr<CheckRow>(
			_column,
			done ? tr::lng_parvane_planner_status_done(tr::now) : tr::lng_parvane_planner_mark_done(tr::now),
			done), gap);
		_done->setOnChange([=](bool checked) {
			const auto current = _task;
			Sections::UpdatePlanner([=](planner::State &state) {
				planner::setTaskDone(state, current, checked);
			}, checked
				? tr::lng_parvane_planner_notice_done(tr::now, lt_name, NameOf(current.name))
				: tr::lng_parvane_planner_notice_reopened(tr::now, lt_name, NameOf(current.name)));
		});
	}

	// Когда: дата работы, начало, длительность; дедлайн — у разовой
	const auto when = AddTo(_column, object_ptr<CardRow>(_column, u"clock"_q), gap);
	const auto grid = when->add(object_ptr<FieldsGrid>(when->body(), hasDate));
	if (hasDate) {
		_day = grid->add(object_ptr<FormField>(
			grid,
			controller,
			tr::lng_parvane_planner_field_work_date(tr::now),
			FormField::Type::Date,
			task.day.value_or(std::string())));
		_day->setOnCommit([=](std::string value) {
			const auto name = NameOf(_task.name);
			return value.empty()
				? patch(
					planner::ItemPatch{ .start = U<std::string>(), .day = U<std::string>() },
					tr::lng_parvane_planner_notice_unscheduled(tr::now, lt_name, name))
				: patch(
					planner::ItemPatch{ .day = V(value) },
					tr::lng_parvane_planner_notice_moved(tr::now, lt_date, FormatDay(value), lt_name, name));
		});
	}
	_start = grid->add(object_ptr<FormField>(
		grid,
		controller,
		tr::lng_parvane_planner_field_start(tr::now),
		FormField::Type::Time,
		task.start.value_or(std::string())));
	_start->setOnCommit([=](std::string value) {
		const auto &current = _task;
		if (!value.empty() && !current.day && !current.repeat) {
			ShowError(controller, tr::lng_parvane_planner_error_need_day(tr::now));
			return false;
		}
		if (!value.empty() && current.minutes && planner::toMinutes(value) + *current.minutes > planner::kMinutesInDay) {
			ShowError(controller, tr::lng_parvane_planner_error_past_midnight(tr::now));
			return false;
		}
		return patch(
			planner::ItemPatch{ .start = F(NonEmpty(value)) },
			tr::lng_parvane_planner_notice_time_updated(tr::now, lt_name, NameOf(current.name)));
	});
	_minutes = grid->add(object_ptr<FormField>(
		grid,
		controller,
		tr::lng_parvane_planner_field_minutes(tr::now),
		FormField::Type::Number,
		task.minutes ? std::to_string(*task.minutes) : std::string(),
		tr::lng_parvane_planner_no_estimate(tr::now)));
	_minutes->setOnCommit([=](std::string value) {
		const auto &current = _task;
		auto minutes = std::optional<int>();
		if (!value.empty()) {
			auto ok = false;
			const auto number = Q(value).toDouble(&ok);
			if (!ok
				|| !std::isfinite(number)
				|| number < planner::kMinTaskMinutes
				|| number > planner::kMinutesInDay) {
				ShowError(controller, tr::lng_parvane_planner_error_minutes(tr::now));
				return false;
			}
			minutes = int(std::round(number));
		}
		if (current.start && minutes && planner::toMinutes(*current.start) + *minutes > planner::kMinutesInDay) {
			ShowError(controller, tr::lng_parvane_planner_error_past_midnight(tr::now));
			return false;
		}
		return patch(
			planner::ItemPatch{
				.start = minutes ? F(current.start) : U<std::string>(),
				.minutes = F(minutes),
			},
			tr::lng_parvane_planner_notice_estimate_updated(tr::now, lt_name, NameOf(current.name)));
	});
	if (!task.repeat) {
		const auto dueGrid = when->add(object_ptr<FieldsGrid>(when->body(), false));
		_due = dueGrid->add(object_ptr<FormField>(
			dueGrid,
			controller,
			tr::lng_parvane_planner_field_due(tr::now),
			FormField::Type::Date,
			task.due.value_or(std::string())));
		_due->setOnCommit([=](std::string value) {
			return patch(
				planner::ItemPatch{ .due = F(NonEmpty(value)) },
				tr::lng_parvane_planner_notice_due_updated(tr::now, lt_name, NameOf(_task.name)));
		});
	}

	// Правило повтора: у шаблона ряда и разовой задачи пишется сразу; у экземпляра спрашивается объём
	_repeatRow = AddTo(_column, object_ptr<RepeatRow>(_column, controller, _repeatDraft), gap);
	{
		const auto extra = _repeatRow->extra();
		const auto error = AddFold(extra, SmallText(extra, _repeatError, Tone::Red), Rem(0.625), !_repeatError.isEmpty());
		const auto line = AddTo(extra, object_ptr<Line>(extra), Rem(0.625));
		const auto save = line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_repeat_save(tr::now)));
		line->addStretch();
		save->setClickedCallback([=] {
			const auto repeat = planner::draftToRepeat(_repeatDraft->current());
			const auto problem = repeat ? planner::validateRepeat(*repeat) : std::nullopt;
			if (problem) {
				_repeatError = RepeatErrorText(*problem);
				error->entity()->setText(_repeatError);
				error->toggle(true, anim::type::instant);
				return;
			}
			_repeatError = QString();
			error->toggle(false, anim::type::instant);
			const auto current = _task;
			if (isInstance()) {
				// Сравнение — с правилом в том виде, в каком его показывает форма
				if (!planner::sameRepeat(repeat, planner::draftToRepeat(planner::repeatToDraft(current.repeat)))) {
					_pending = Pending{ .kind = u"rule"_q, .repeat = repeat };
					rebuildBottom();
				}
				return;
			}
			const auto id = _taskId;
			Sections::UpdatePlanner([=](planner::State &state) {
				const auto target = planner::findTask(state, id);
				if (!target) {
					return;
				}
				target->repeat = repeat;
				if (repeat) {
					target->day = std::nullopt;
					target->due = std::nullopt;
					if (target->status == "done") {
						target->status = "queue";
					}
				} else {
					target->occurrences = std::nullopt;
				}
			}, tr::lng_parvane_planner_notice_repeat_updated(tr::now, lt_name, NameOf(current.name)));
		});
	}
	_repeatRow->setOpen(_repeatOpen);
	if (instance) {
		const auto link = AddTo(_column, object_ptr<Kit::LinkButton>(
			_column,
			tr::lng_parvane_planner_series_open(tr::now)), gap);
		link->setClickedCallback([=] {
			if (_host.openTask) {
				_host.openTask(_taskId, std::string());
			}
		});
	}

	// Группа
	const auto group = AddTo(_column, object_ptr<CardRow>(_column, u"folder"_q), gap);
	_list = group->add(object_ptr<ListPicker>(group->body(), controller, state, task.project, [=](std::string project) {
		patch(
			planner::ItemPatch{ .project = V(project) },
			tr::lng_parvane_planner_notice_list_updated(tr::now, lt_name, NameOf(_task.name)));
	}));

	// Статус и напоминание
	const auto status = AddTo(_column, object_ptr<CardRow>(_column, u"schedule"_q), gap);
	const auto statusGrid = status->add(object_ptr<FieldsGrid>(status->body(), false));
	_status = statusGrid->add(MakeStatusSelect(statusGrid, task.status, [=](std::string value) {
		patch(
			planner::ItemPatch{ .status = V(value) },
			tr::lng_parvane_planner_notice_status_updated(tr::now, lt_name, NameOf(_task.name)));
	}));
	_remind = statusGrid->add(MakeRemindSelect(statusGrid, task.remind, [=](std::optional<int> value) {
		patch(
			planner::ItemPatch{ .remind = F(value) },
			tr::lng_parvane_planner_notice_remind_updated(tr::now, lt_name, NameOf(_task.name)));
	}));

	// Описание: у разовой и отделённого дня пишется сразу; у экземпляра ряда — кнопкой
	const auto info = AddTo(_column, object_ptr<CardRow>(_column, u"info"_q), gap);
	info->add(FieldLabel(info->body(), tr::lng_parvane_planner_field_description(tr::now)));
	_description = info->add(object_ptr<TextInput>(
		info->body(),
		TextInput::Kind::Multiline,
		QString(),
		instance ? _descriptionDraft : Q(task.description),
		kDescriptionMaxLength));
	if (_descriptionScope) {
		info->add(object_ptr<DescriptionScopeBox>(
			info->body(),
			*_descriptionScope,
			!instance,
			[=](planner::DescriptionScope scope) {
				_descriptionScope = scope;
				// Отделённый день: «для всех» переносит его описание в ряд (вопрос уже задан)
				if (scope != planner::DescriptionScope::All || isInstance()) {
					return;
				}
				const auto current = _task;
				Sections::UpdatePlanner([=](planner::State &state) {
					planner::shareDescription(state, planner::SeriesKind::Task, planner::SeriesItem(current));
				}, tr::lng_parvane_planner_notice_description_updated(tr::now, lt_name, NameOf(current.name)));
			}));
	}
	_descriptionSave = info->add(object_ptr<Ui::VerticalLayout>(info->body()));
	const auto refreshSave = [=] {
		Kit::ClearLayout(_descriptionSave);
		if (!isInstance() || _descriptionDraft == Q(_task.description)) {
			_descriptionSave->resizeToWidth(_descriptionSave->width());
			return;
		}
		const auto line = AddTo(_descriptionSave, object_ptr<Line>(_descriptionSave), 0);
		const auto save = line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_description_save(tr::now)));
		line->addStretch();
		save->setClickedCallback([=] {
			const auto current = _task;
			const auto description = S(_descriptionDraft);
			const auto scope = _descriptionScope.value_or(planner::DescriptionScope::All);
			const auto openTask = _host.openTask;
			UpdatePlannerWithResult([=](planner::State &state) -> std::optional<std::string> {
				const auto saved = planner::setDescription(
					state,
					planner::SeriesKind::Task,
					planner::SeriesItem(current),
					description,
					scope,
					planner::randomUuid);
				return saved ? std::optional<std::string>(planner::itemId(*saved)) : std::nullopt;
			}, tr::lng_parvane_planner_notice_description_updated(tr::now, lt_name, NameOf(current.name)),
			[=](std::optional<std::string> savedId) {
				if (savedId && *savedId != current.id && openTask) {
					openTask(*savedId, std::string());
				}
			});
		});
		_descriptionSave->resizeToWidth(_descriptionSave->width());
	};
	refreshSave();
	_description->textChanges() | rpl::on_next([=](QString text) {
		if (isInstance()) {
			_descriptionDraft = text;
			refreshSave();
			return;
		}
		// Отделённый день с галочкой «для всех» пишет описание и в свой ряд
		const auto current = _task;
		const auto scope = _descriptionScope.value_or(planner::DescriptionScope::One);
		const auto description = S(text);
		Sections::UpdatePlanner([=](planner::State &state) {
			planner::setDescription(
				state,
				planner::SeriesKind::Task,
				planner::SeriesItem(current),
				description,
				scope,
				planner::randomUuid);
		});
		markSaved();
	}, _description->lifetime());

	// Шаги: отметка экземпляра — по дню, без выбора объёма (FR-005)
	const auto steps = AddTo(_column, object_ptr<CardRow>(_column, u"check"_q), gap);
	const auto doneSteps = ranges::count(task.steps, true, &planner::Step::isDone);
	steps->add(FieldLabel(steps->body(), tr::lng_parvane_planner_steps(
		tr::now,
		lt_done,
		QString::number(doneSteps),
		lt_total,
		QString::number(task.steps.size()))));
	const auto stepsColumn = steps->add(object_ptr<Ui::VerticalLayout>(steps->body()));
	for (auto index = 0; index != int(task.steps.size()); ++index) {
		const auto &step = task.steps[index];
		const auto row = stepsColumn->add(object_ptr<CheckRow>(
			stepsColumn,
			Q(step.text),
			step.isDone,
			true,
			Tone::Purple,
			true));
		const auto text = Q(step.text);
		row->setOnChange([=](bool isDone) {
			const auto current = _task;
			Sections::UpdatePlanner([=](planner::State &state) {
				planner::setTaskStepDone(state, current, index, isDone);
			}, tr::lng_parvane_planner_notice_step_updated(tr::now, lt_name, text));
		});
	}
	const auto stepForm = steps->add(object_ptr<Line>(steps->body(), Rem(0.5)));
	stepForm->setAlignBottom(true);
	const auto stepField = stepForm->add(object_ptr<FormField>(
		stepForm,
		controller,
		tr::lng_parvane_planner_step_new(tr::now),
		FormField::Type::Text,
		std::string(),
		QString(),
		kStepMaxLength), true);
	const auto stepAdd = stepForm->add(object_ptr<GlyphButton>(
		stepForm,
		u"add"_q,
		tr::lng_parvane_planner_step_add(tr::now)));
	const auto submitStep = [=] {
		const auto text = stepField->raw().trimmed();
		if (text.isEmpty()) {
			return;
		}
		auto list = std::vector<planner::Step>();
		for (const auto &step : _task.steps) {
			list.push_back({ step.text, isInstance() ? false : step.isDone });
		}
		list.push_back({ S(text), false });
		stepField->setValue(std::string(), true);
		patch(planner::ItemPatch{ .steps = V(list) }, tr::lng_parvane_planner_notice_step_added(tr::now));
	};
	stepAdd->setClickedCallback(submitStep);
	stepField->submits() | rpl::on_next(submitStep, stepField->lifetime());

	// Найти свободное время
	const auto slots = AddTo(_column, object_ptr<CardRow>(_column, u"search"_q), gap);
	const auto findLine = slots->add(object_ptr<Line>(slots->body()));
	findLine->add(object_ptr<Kit::PushButton>(
		findLine,
		tr::lng_parvane_planner_find_slots(tr::now)))->setClickedCallback([=] {
		if (!_task.minutes) {
			_slots = std::nullopt;
			_slotHint = tr::lng_parvane_planner_error_need_minutes(tr::now);
		} else if (_view) {
			const auto found = planner::findSlots(_view->state, _task, TodayKey(), _picked.empty() ? TodayKey() : _picked);
			_slots = found;
			const auto &settings = _view->state.settings;
			_slotHint = found.empty()
				? tr::lng_parvane_planner_slots_none(tr::now)
				: Q(planner::formatClock(settings.dayStart)) + QChar(0x2013) + Q(planner::formatClock(settings.dayEnd));
		}
		rebuildSlots();
	});
	findLine->addStretch();
	_slotsColumn = slots->add(object_ptr<Ui::VerticalLayout>(slots->body()));
	slots->setLast(true);
	rebuildSlots();

	_bottom = _host.footer ? _host.footer : AddTo(_column, object_ptr<Ui::VerticalLayout>(_column), gap);
	rebuildBottom();

	if (width() > 0) {
		_column->resizeToWidth(width());
	}
}

void TaskEditor::refreshValues() {
	const auto &task = _task;
	if (const auto title = static_cast<NameTitle*>(_title)) {
		title->setName(NameOf(task.name));
	}
	if (_done) {
		const auto done = (task.status == "done");
		_done->setChecked(done);
		_done->setText(done ? tr::lng_parvane_planner_status_done(tr::now) : tr::lng_parvane_planner_mark_done(tr::now));
	}
	if (_day) {
		_day->setValue(task.day.value_or(std::string()));
	}
	if (_start) {
		_start->setValue(task.start.value_or(std::string()));
	}
	if (_minutes) {
		_minutes->setValue(task.minutes ? std::to_string(*task.minutes) : std::string());
	}
	if (_due) {
		_due->setValue(task.due.value_or(std::string()));
	}
	if (_list && _view) {
		_list->setState(_view->state, task.project);
	}
	if (_status) {
		_status->setValue(Q(task.status));
	}
	if (_remind) {
		SetRemindValue(_remind, task.remind);
	}
	if (_description && !isInstance() && !_description->input()->hasFocus()) {
		const auto text = Q(task.description);
		if (_description->text() != text) {
			_description->setText(text);
		}
	}
}

void TaskEditor::rebuildSlots() {
	if (!_slotsColumn) {
		return;
	}
	Kit::ClearLayout(_slotsColumn);
	const auto gap = Rem(0.375); // `.slots`
	if (!_slotHint.isEmpty()) {
		AddTo(_slotsColumn, SmallText(_slotsColumn, _slotHint), gap);
	}
	if (_slots) {
		for (const auto &slot : *_slots) {
			const auto text = FormatDay(slot.day) + u" · "_q + Q(slot.start) + QChar(0x2013) + Q(slot.end);
			const auto line = AddTo(_slotsColumn, object_ptr<Line>(_slotsColumn), gap);
			const auto button = line->add(object_ptr<SlotButton>(line, text));
			line->addStretch();
			const auto day = slot.day;
			const auto start = slot.start;
			button->setClickedCallback([=] {
				patch(
					planner::ItemPatch{ .start = V(start), .day = V(day) },
					tr::lng_parvane_planner_notice_scheduled(tr::now, lt_date, FormatDay(day), lt_time, Q(start)));
			});
		}
	}
	_slotsColumn->resizeToWidth(_slotsColumn->width());
}

void TaskEditor::rebuildBottom() {
	if (!_bottom) {
		return;
	}
	Kit::ClearLayout(_bottom);
	if (_pending) {
		// О чём спрашивает выбор объёма: правка полей, удаление, новое правило повтора либо его снятие
		const auto mode = (_pending->kind == u"rule"_q)
			? (_pending->repeat ? u"rule"_q : u"stop"_q)
			: (_pending->kind == u"delete"_q)
			? u"delete"_q
			: (_pending->kind == u"copy"_q)
			? u"copy"_q
			: u"edit"_q;
		AddTo(_bottom, object_ptr<SeriesPrompt>(_bottom, mode, [=](QString scope) {
			crl::on_main(this, [=] { chooseScope(scope); });
		}, [=] {
			crl::on_main(this, [=] {
				_pending = std::nullopt;
				rebuildBottom();
			});
		}), 0);
	} else {
		const auto line = AddTo(_bottom, object_ptr<Line>(_bottom), 0);
		const auto remove = line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_delete_task(tr::now),
			Kit::PushButton::Kind::Danger));
		line->addStretch();
		remove->setClickedCallback([=] {
			if (isInstance()) {
				_pending = Pending{ .kind = u"delete"_q };
				crl::on_main(this, [=] { rebuildBottom(); });
				return;
			}
			const auto id = _taskId;
			Sections::UpdatePlanner([=](planner::State &state) {
				state.tasks.erase(
					ranges::remove(state.tasks, id, &planner::Task::id),
					end(state.tasks));
			}, tr::lng_parvane_planner_notice_task_deleted(tr::now, lt_name, NameOf(_task.name)));
			if (_host.close) {
				_host.close();
			}
		});
	}
	_bottom->resizeToWidth(_bottom->width());
}

int TaskEditor::resizeGetHeight(int newWidth) {
	_column->resizeToWidth(newWidth);
	_column->moveToLeft(0, 0, newWidth);
	return _column->height();
}

// ── карточка события ─────────────────────────────────────────────────────────

EventEditor::EventEditor(QWidget *parent, EditorHost host, planner::Event event, const planner::State &state)
: RpWidget(parent)
, _host(std::move(host))
, _event(std::move(event))
, _state(state) {
	_name = Q(_event.name);
	_description = Q(_event.description.value_or(std::string()));
	_descriptionScope = ScopeOf(_state, planner::SeriesKind::Event, planner::SeriesItem(_event));
	_start = _event.start;
	_end = _event.end;
	_day = _event.instanceDay ? *_event.instanceDay : _event.day.value_or(std::string());
	_allDay = _event.isAllDay.value_or(false);
	_holiday = _event.isHoliday.value_or(false);
	_color = _event.color.value_or(0);
	_project = _event.project.value_or(std::string());
	_remind = _event.remind;
	_repeatDraft = std::make_shared<rpl::variable<planner::RepeatDraft>>(
		planner::repeatToDraft(_event.repeat, _event.day.value_or(std::string())));
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	build();
}

bool EventEditor::isInstance() const {
	return _event.repeat.has_value() && _event.instanceDay && !_event.instanceDay->empty();
}

void EventEditor::build() {
	const auto controller = _host.controller;
	const auto gap = Rem(0.5);
	const auto name = AddTo(_column, object_ptr<TextInput>(
		_column,
		TextInput::Kind::Title,
		tr::lng_parvane_planner_field_event_name(tr::now),
		_name,
		kNameMaxLength), gap);
	name->textChanges() | rpl::on_next([=](QString text) {
		_name = text;
	}, name->lifetime());
	name->input()->submits() | rpl::on_next([=] {
		submit();
	}, name->lifetime());
	if (_event.origin) {
		AddTo(_column, SmallText(_column, tr::lng_parvane_planner_series_detached_hint(tr::now)), gap);
	}

	const auto when = AddTo(_column, object_ptr<CardRow>(_column, u"clock"_q), gap);
	_when = when->add(object_ptr<Ui::VerticalLayout>(when->body()));
	const auto checks = when->add(object_ptr<Kit::Flow>(when->body(), Rem(1.125)));
	checks->add(object_ptr<TickBox>(checks, tr::lng_parvane_planner_all_day(tr::now), _allDay))->setOnChange(
		[=](bool checked) {
			_allDay = checked;
			crl::on_main(this, [=] { rebuildWhen(); });
		});
	checks->add(object_ptr<TickBox>(checks, tr::lng_parvane_planner_holiday(tr::now), _holiday))->setOnChange(
		[=](bool checked) {
			_holiday = checked;
		});
	rebuildWhen();

	AddTo(_column, object_ptr<RepeatRow>(_column, controller, _repeatDraft), gap);

	const auto group = AddTo(_column, object_ptr<CardRow>(_column, u"folder"_q), gap);
	group->add(object_ptr<ListPicker>(group->body(), controller, _state, _project, [=](std::string project) {
		_project = project;
		if (_swatches) {
			_swatches->toggle(_project.empty(), anim::type::instant);
		}
	}));
	// Цвет — у группы; свой цвет события — только без группы (скрытые кружки места не занимают)
	_swatches = AddFold(group->body(), object_ptr<ColorSwatches>(group->body(), _color, [=](int color) {
		_color = color;
	}), Rem(0.625), _project.empty());

	const auto remind = AddTo(_column, object_ptr<CardRow>(_column, u"schedule"_q), gap);
	remind->add(MakeRemindSelect(remind->body(), _remind, [=](std::optional<int> value) {
		_remind = value;
	}));

	const auto info = AddTo(_column, object_ptr<CardRow>(_column, u"info"_q), gap);
	info->setLast(true);
	info->add(FieldLabel(info->body(), tr::lng_parvane_planner_field_description(tr::now)));
	const auto description = info->add(object_ptr<TextInput>(
		info->body(),
		TextInput::Kind::Multiline,
		QString(),
		_description,
		kDescriptionMaxLength));
	description->textChanges() | rpl::on_next([=](QString text) {
		_description = text;
	}, description->lifetime());
	if (_descriptionScope) {
		info->add(object_ptr<DescriptionScopeBox>(
			info->body(),
			*_descriptionScope,
			!isInstance(),
			[=](planner::DescriptionScope scope) {
				_descriptionScope = scope;
			}));
	}

	_error = AddFold(_column, SmallText(_column, QString(), Tone::Red), gap, false);
	_bottom = _host.footer ? _host.footer : AddTo(_column, object_ptr<Ui::VerticalLayout>(_column), gap);
	rebuildBottom();
}

void EventEditor::rebuildWhen() {
	Kit::ClearLayout(_when);
	const auto controller = _host.controller;
	const auto hasDate = !_event.repeat || isInstance();
	const auto grid = AddTo(_when, object_ptr<FieldsGrid>(_when, hasDate && !_allDay), 0);
	if (hasDate) {
		grid->add(object_ptr<FormField>(
			grid,
			controller,
			tr::lng_parvane_planner_field_event_date(tr::now),
			FormField::Type::Date,
			_day))->setOnInput([=](std::string value) {
			_day = value;
		});
	}
	if (!_allDay) {
		grid->add(object_ptr<FormField>(
			grid,
			controller,
			tr::lng_parvane_planner_field_start(tr::now),
			FormField::Type::Time,
			_start))->setOnInput([=](std::string value) {
			_start = value;
		});
		grid->add(object_ptr<FormField>(
			grid,
			controller,
			tr::lng_parvane_planner_field_end(tr::now),
			FormField::Type::Time,
			_end))->setOnInput([=](std::string value) {
			_end = value;
		});
	}
	if (width() > 0) {
		_when->resizeToWidth(_when->width());
	}
}

void EventEditor::rebuildBottom() {
	Kit::ClearLayout(_bottom);
	if (_pending) {
		const auto mode = (_pending->kind == u"rule"_q)
			? (_pending->repeat ? u"rule"_q : u"stop"_q)
			: (_pending->kind == u"delete"_q)
			? u"delete"_q
			: (_pending->kind == u"copy"_q)
			? u"copy"_q
			: u"edit"_q;
		AddTo(_bottom, object_ptr<SeriesPrompt>(_bottom, mode, [=](QString scope) {
			crl::on_main(this, [=] {
				if (!_pending) {
					return;
				}
				const auto action = *_pending;
				_pending = std::nullopt;
				rebuildBottom();
				applyScope(scope, action);
			});
		}, [=] {
			crl::on_main(this, [=] {
				_pending = std::nullopt;
				rebuildBottom();
			});
		}), 0);
	} else {
		const auto actions = AddTo(_bottom, object_ptr<Kit::Flow>(_bottom, Rem(0.5)), 0);
		actions->add(object_ptr<Kit::PushButton>(
			actions,
			tr::lng_parvane_planner_save(tr::now),
			Kit::PushButton::Kind::Accent))->setClickedCallback([=] {
			submit();
		});
		actions->add(object_ptr<Kit::PushButton>(
			actions,
			tr::lng_parvane_planner_delete_event(tr::now),
			Kit::PushButton::Kind::Danger))->setClickedCallback([=] {
			if (isInstance()) {
				_pending = Pending{ .kind = u"delete"_q };
				crl::on_main(this, [=] { rebuildBottom(); });
				return;
			}
			const auto id = _event.id;
			Sections::UpdatePlanner([=](planner::State &state) {
				state.events.erase(
					ranges::remove(state.events, id, &planner::Event::id),
					end(state.events));
			}, tr::lng_parvane_planner_notice_event_deleted(tr::now));
			if (_host.close) {
				_host.close();
			}
		});
	}
	_bottom->resizeToWidth(_bottom->width());
}

void EventEditor::submit() {
	const auto repeat = planner::draftToRepeat(_repeatDraft->current());
	const auto showError = [=](const QString &text) {
		_error->entity()->setText(text);
		_error->toggle(!text.isEmpty(), anim::type::instant);
		_column->resizeToWidth(width());
	};
	// Событие, бывшее «весь день», получает обычное время заново
	const auto wasAllDay = _event.isAllDay.value_or(false)
		&& !_allDay
		&& _start == planner::kAllDayStart
		&& _end == planner::kAllDayEnd;
	if (wasAllDay) {
		showError(tr::lng_parvane_planner_error_event_time(tr::now));
		return;
	}
	auto next = planner::Event();
	next.id = _event.id;
	next.name = S(_name.trimmed());
	next.description = NonEmpty(S(_description.trimmed()));
	next.start = _allDay ? std::string(planner::kAllDayStart) : _start;
	next.end = _allDay ? std::string(planner::kAllDayEnd) : _end;
	next.repeat = repeat;
	next.day = repeat ? std::nullopt : NonEmpty(_day);
	next.isAllDay = _allDay ? std::optional<bool>(true) : std::nullopt;
	next.isHoliday = _holiday ? std::optional<bool>(true) : std::nullopt;
	next.color = (!_project.empty() || !_color) ? std::nullopt : std::optional<int>(_color);
	next.project = NonEmpty(_project);
	next.remind = _remind;
	if (const auto problem = planner::validateEvent(next)) {
		showError(EventErrorText(*problem));
		return;
	}
	showError(QString());
	// Правка всей карточки (`Partial<PlannerEvent>` web: все ключи, пустые — `undefined`)
	const auto nextPatch = planner::ItemPatch{
		.name = V(next.name),
		.description = F(next.description),
		.start = V(next.start),
		.end = V(next.end),
		.day = F(next.day),
		.project = F(next.project),
		.color = F(next.color),
		.remind = F(next.remind),
		.isAllDay = F(next.isAllDay),
		.isHoliday = F(next.isHoliday),
		.repeat = RepeatField(repeat),
	};
	if (isInstance()) {
		const auto instanceDay = *_event.instanceDay;
		const auto nextDescription = next.description.value_or(std::string());
		const auto descriptionChanged = nextDescription != _event.description.value_or(std::string());
		const auto otherChanges = next.name != _event.name
			|| next.start != _event.start
			|| next.end != _event.end
			|| next.isAllDay.value_or(false) != _event.isAllDay.value_or(false)
			|| next.isHoliday.value_or(false) != _event.isHoliday.value_or(false)
			|| next.color.value_or(0) != _event.color.value_or(0)
			|| (_day.empty() ? instanceDay : _day) != instanceDay
			|| next.remind != _event.remind
			|| next.project.value_or(std::string()) != _event.project.value_or(std::string());
		const auto ownDescription = descriptionChanged && _descriptionScope == planner::DescriptionScope::One;
		auto patch = planner::ItemPatch{
			.name = V(next.name),
			.start = V(next.start),
			.end = V(next.end),
			.project = F(next.project),
			.color = F(next.color),
			.remind = F(next.remind),
			.isAllDay = F(next.isAllDay),
			.isHoliday = F(next.isHoliday),
		};
		if (!ownDescription) {
			patch.description = F(next.description);
		}
		const auto own = ownDescription ? std::optional<std::string>(nextDescription) : std::nullopt;
		// Новое правило повтора: объём — «это и последующие» или «все в серии», для «Не повторяется» — с какого дня
		if (!planner::sameRepeat(repeat, planner::draftToRepeat(planner::repeatToDraft(_event.repeat)))) {
			_pending = Pending{ .kind = u"rule"_q, .patch = patch, .ownDescription = own, .repeat = repeat };
			rebuildBottom();
			return;
		}
		// Одно описание объёма не спрашивает: его задаёт галочка у поля
		if (descriptionChanged && !otherChanges) {
			const auto event = _event;
			const auto scope = _descriptionScope.value_or(planner::DescriptionScope::All);
			Sections::UpdatePlanner([=](planner::State &state) {
				planner::setDescription(
					state,
					planner::SeriesKind::Event,
					planner::SeriesItem(event),
					nextDescription,
					scope,
					planner::randomUuid);
			}, tr::lng_parvane_planner_notice_event_updated(tr::now, lt_name, NameOf(next.name)));
			if (_host.close) {
				_host.close();
			}
			return;
		}
		_pending = Pending{ .kind = u"save"_q, .patch = patch, .ownDescription = own };
		rebuildBottom();
		return;
	}
	// Отделённый день ряда: правку можно отдать всему ряду; описание — только если галочка «для всех»
	if (!repeat && planner::seriesOfCopy(_state, planner::SeriesKind::Event, planner::SeriesItem(_event))) {
		auto fields = planner::changedFields(_event, nextPatch);
		if (_descriptionScope == planner::DescriptionScope::One) {
			fields.description = std::nullopt;
		}
		if (!fields.empty()) {
			_pending = Pending{ .kind = u"copy"_q, .next = nextPatch, .fields = fields };
			rebuildBottom();
			return;
		}
	}
	applyScope(QString(), Pending{ .kind = u"own"_q, .next = nextPatch });
}

void EventEditor::applyScope(const QString &scope, const Pending &action) {
	const auto kind = planner::SeriesKind::Event;
	const auto event = _event;
	const auto id = _event.id;
	const auto instanceDay = _event.instanceDay.value_or(std::string());
	const auto descriptionScope = _descriptionScope;
	const auto close = _host.close;
	// Правка самой записи (разовой, шаблона ряда либо отделённого дня)
	const auto saveOwn = [=](planner::State &state, const planner::ItemPatch &next) {
		auto result = std::optional<planner::Event>();
		const auto target = planner::findEvent(state, id);
		if (!target) {
			return result;
		}
		planner::applyPatch(*target, next);
		const auto hasRepeat = next.repeat && *next.repeat;
		if (hasRepeat) {
			target->occurrences = std::nullopt;
			result = *target;
		} else if (descriptionScope == planner::DescriptionScope::All) {
			result = *target;
			planner::setDescription(
				state,
				kind,
				planner::SeriesItem(*result),
				result->description.value_or(std::string()),
				planner::DescriptionScope::All,
				planner::randomUuid);
		} else {
			result = *target;
		}
		return result;
	};
	if (action.kind == u"own"_q) {
		const auto next = action.next;
		const auto name = Q(next.name && *next.name ? **next.name : event.name);
		Sections::UpdatePlanner([=](planner::State &state) {
			saveOwn(state, next);
		}, tr::lng_parvane_planner_notice_event_updated(tr::now, lt_name, NameOf(S(name))));
		if (close) {
			close();
		}
		return;
	}
	if (action.kind == u"delete"_q) {
		Sections::UpdatePlanner([=](planner::State &state) {
			if (scope == u"one"_q) {
				planner::excludeInstance(state, kind, id, instanceDay);
			} else if (scope == u"following"_q) {
				planner::truncateSeries(state, kind, id, instanceDay);
			} else {
				planner::removeSeries(state, kind, id);
			}
		}, tr::lng_parvane_planner_notice_event_deleted(tr::now));
		if (close) {
			close();
		}
		return;
	}
	if (action.kind == u"copy"_q) {
		const auto next = action.next;
		const auto fields = action.fields;
		const auto name = (next.name && *next.name) ? **next.name : event.name;
		Sections::UpdatePlanner([=](planner::State &state) {
			const auto target = saveOwn(state, next);
			if (target && scope == u"all"_q) {
				planner::updateFromCopy(state, kind, planner::SeriesItem(*target), fields);
			}
		}, tr::lng_parvane_planner_notice_event_updated(tr::now, lt_name, NameOf(name)));
		if (close) {
			close();
		}
		return;
	}
	const auto patch = action.patch;
	const auto ownDescription = action.ownDescription;
	const auto targetDay = _day.empty() ? instanceDay : _day;
	const auto name = (patch.name && *patch.name) ? **patch.name : event.name;
	const auto withOwn = [=](planner::ItemPatch base) {
		if (ownDescription) {
			base.description = F(NonEmpty(*ownDescription));
		}
		return base;
	};
	if (action.kind == u"rule"_q) {
		const auto repeat = action.repeat;
		Sections::UpdatePlanner([=](planner::State &state) {
			if (!repeat) {
				// Без повтора: день остаётся разовой записью со всеми правками карточки
				auto fields = withOwn(patch);
				fields.day = V(targetDay);
				planner::changeSeriesRule(
					state,
					kind,
					id,
					instanceDay,
					std::nullopt,
					(scope == u"stop"_q) ? planner::RuleScope::Stop : planner::RuleScope::One,
					fields,
					planner::randomUuid);
				return;
			}
			// Дни ряда задаёт новое правило: дата из карточки на него не влияет
			const auto series = planner::changeSeriesRule(
				state,
				kind,
				id,
				instanceDay,
				repeat,
				(scope == u"following"_q) ? planner::RuleScope::Following : planner::RuleScope::All,
				patch,
				planner::randomUuid);
			if (series && ownDescription) {
				planner::detachWithDescription(
					state,
					kind,
					planner::itemId(*series),
					instanceDay,
					*ownDescription,
					planner::randomUuid);
			}
		}, repeat
			? tr::lng_parvane_planner_notice_event_updated(tr::now, lt_name, NameOf(name))
			: tr::lng_parvane_planner_notice_repeat_stopped(tr::now, lt_name, NameOf(name)));
		if (close) {
			close();
		}
		return;
	}
	Sections::UpdatePlanner([=](planner::State &state) {
		if (scope == u"one"_q) {
			auto fields = withOwn(patch);
			fields.repeat = U<planner::RepeatPatch>();
			fields.day = V(targetDay);
			planner::detachInstance(state, kind, id, instanceDay, fields, planner::randomUuid);
			return;
		}
		// Новый день экземпляра переносит ряд (весь либо его продолжение)
		auto seriesId = id;
		if (scope == u"following"_q) {
			if (const auto split = planner::splitSeries(state, kind, id, instanceDay, patch, planner::randomUuid)) {
				seriesId = planner::itemId(*split);
			}
		}
		auto fields = patch;
		fields.day = V(targetDay);
		planner::updateSeries(state, kind, seriesId, instanceDay, fields);
		// Уже отделённые дни ряда (всего либо с этого дня) получают те же изменённые поля
		planner::patchCopies(
			state,
			kind,
			id,
			planner::changedFields(event, patch),
			(scope == u"following"_q) ? std::optional<std::string>(instanceDay) : std::nullopt);
		if (ownDescription) {
			planner::detachWithDescription(state, kind, seriesId, targetDay, *ownDescription, planner::randomUuid);
		}
	}, tr::lng_parvane_planner_notice_event_updated(tr::now, lt_name, NameOf(name)));
	if (close) {
		close();
	}
}

int EventEditor::resizeGetHeight(int newWidth) {
	_column->resizeToWidth(newWidth);
	_column->moveToLeft(0, 0, newWidth);
	return _column->height();
}

// ── новая запись ─────────────────────────────────────────────────────────────

TaskForm::TaskForm(QWidget *parent, EditorHost host, const planner::State &state, std::string day, bool event)
: RpWidget(parent)
, _host(std::move(host))
, _state(state)
, _event(event)
, _day(day) {
	_repeatDraft = std::make_shared<rpl::variable<planner::RepeatDraft>>(planner::emptyRepeatDraft(day));
	_column = Ui::CreateChild<Ui::VerticalLayout>(this);
	_column->heightValue() | rpl::on_next([=] {
		if (width() > 0) {
			resizeToWidth(width());
		}
	}, lifetime());
	// «Не повторяется» ↔ ряд меняет состав полей (у ряда нет даты и дедлайна)
	_repeatDraft->value() | rpl::map([](const planner::RepeatDraft &draft) {
		return draft.kind == "none";
	}) | rpl::distinct_until_changed() | rpl::skip(1) | rpl::on_next([=] {
		crl::on_main(this, [=] { rebuild(); });
	}, lifetime());
	rebuild();
}

void TaskForm::focusName() {
	if (_nameInput) {
		_nameInput->input()->setFocusFast();
	}
}

void TaskForm::setStart(const std::string &value) {
	_start = value;
	// Конец события следует за началом (+1 ч), пока пользователь не задал его сам
	if (_event && !_endTouched && !value.empty()) {
		_end = planner::getDefaultEventEnd(value);
		if (_endField) {
			_endField->setValue(_end, true);
		}
	}
}

void TaskForm::rebuild() {
	const auto hadFocus = _nameInput && _nameInput->input()->hasFocus();
	if (_repeatRow) {
		_repeatOpen = _repeatRow->isOpen();
	}
	Kit::ClearLayout(_column);
	_nameInput = nullptr;
	_endField = nullptr;
	_repeatRow = nullptr;
	const auto controller = _host.controller;
	const auto gap = Rem(0.5);
	const auto hasDate = (_repeatDraft->current().kind == "none");

	// Что добавить: задача или событие
	const auto switchLine = AddTo(_column, object_ptr<Line>(_column), gap);
	switchLine->add(object_ptr<KindSwitch>(
		switchLine,
		std::vector<QString>{
			tr::lng_parvane_planner_kind_task(tr::now),
			tr::lng_parvane_planner_kind_event(tr::now),
		},
		_event ? 1 : 0,
		[=](int index) {
			_event = (index == 1);
			if (_event && !_start.empty() && !_endTouched) {
				_end = planner::getDefaultEventEnd(_start);
			}
			_error = QString();
			crl::on_main(this, [=] { rebuild(); });
		}));
	switchLine->addStretch();

	_nameInput = AddTo(_column, object_ptr<TextInput>(
		_column,
		TextInput::Kind::Title,
		_event ? tr::lng_parvane_planner_field_event_name(tr::now) : tr::lng_parvane_planner_field_task_name(tr::now),
		_name,
		kNameMaxLength), gap);
	_nameInput->textChanges() | rpl::on_next([=](QString text) {
		_name = text;
	}, _nameInput->lifetime());
	_nameInput->input()->submits() | rpl::on_next([=] {
		submit();
	}, _nameInput->lifetime());

	const auto when = AddTo(_column, object_ptr<CardRow>(_column, u"clock"_q), gap);
	if (!_event) {
		const auto grid = when->add(object_ptr<FieldsGrid>(when->body(), hasDate));
		if (hasDate) {
			grid->add(object_ptr<FormField>(
				grid,
				controller,
				tr::lng_parvane_planner_field_work_date(tr::now),
				FormField::Type::Date,
				_day))->setOnInput([=](std::string value) { _day = value; });
		}
		grid->add(object_ptr<FormField>(
			grid,
			controller,
			tr::lng_parvane_planner_field_start(tr::now),
			FormField::Type::Time,
			_start))->setOnInput([=](std::string value) { setStart(value); });
		grid->add(object_ptr<FormField>(
			grid,
			controller,
			tr::lng_parvane_planner_field_minutes(tr::now),
			FormField::Type::Number,
			_minutes,
			tr::lng_parvane_planner_no_estimate(tr::now)))->setOnInput([=](std::string value) { _minutes = value; });
		if (hasDate) {
			const auto dueGrid = when->add(object_ptr<FieldsGrid>(when->body(), false));
			dueGrid->add(object_ptr<FormField>(
				dueGrid,
				controller,
				tr::lng_parvane_planner_field_due(tr::now),
				FormField::Type::Date,
				_due))->setOnInput([=](std::string value) { _due = value; });
		}
	} else {
		const auto whenGrid = QPointer<Ui::VerticalLayout>(when->add(object_ptr<Ui::VerticalLayout>(when->body())));
		const auto fill = [=] {
			if (!whenGrid) {
				return;
			}
			Kit::ClearLayout(whenGrid);
			_endField = nullptr;
			const auto hasDateNow = (_repeatDraft->current().kind == "none");
			const auto grid = AddTo(whenGrid.data(), object_ptr<FieldsGrid>(whenGrid.data(), hasDateNow && !_allDay), 0);
			if (hasDateNow) {
				grid->add(object_ptr<FormField>(
					grid,
					controller,
					tr::lng_parvane_planner_field_event_date(tr::now),
					FormField::Type::Date,
					_day))->setOnInput([=](std::string value) { _day = value; });
			}
			if (!_allDay) {
				grid->add(object_ptr<FormField>(
					grid,
					controller,
					tr::lng_parvane_planner_field_start(tr::now),
					FormField::Type::Time,
					_start))->setOnInput([=](std::string value) { setStart(value); });
				_endField = grid->add(object_ptr<FormField>(
					grid,
					controller,
					tr::lng_parvane_planner_field_end(tr::now),
					FormField::Type::Time,
					_end));
				_endField->setOnInput([=](std::string value) {
					_end = value;
					_endTouched = true;
				});
			}
			whenGrid->resizeToWidth(whenGrid->width());
		};
		fill();
		const auto checks = when->add(object_ptr<Kit::Flow>(when->body(), Rem(1.125)));
		checks->add(object_ptr<TickBox>(checks, tr::lng_parvane_planner_all_day(tr::now), _allDay))->setOnChange(
			[=](bool checked) {
				_allDay = checked;
				crl::on_main(this, fill);
			});
		checks->add(object_ptr<TickBox>(checks, tr::lng_parvane_planner_holiday(tr::now), _holiday))->setOnChange(
			[=](bool checked) {
				_holiday = checked;
			});
	}

	_repeatRow = AddTo(_column, object_ptr<RepeatRow>(_column, controller, _repeatDraft), gap);
	_repeatRow->setOpen(_repeatOpen);

	const auto group = AddTo(_column, object_ptr<CardRow>(_column, u"folder"_q), gap);
	const auto swatches = std::make_shared<QPointer<Ui::SlideWrap<ColorSwatches>>>();
	group->add(object_ptr<ListPicker>(group->body(), controller, _state, _project, [=](std::string project) {
		_project = project;
		if (const auto strong = swatches->data()) {
			strong->toggle(_event && _project.empty(), anim::type::instant);
		}
	}));
	if (_event) {
		*swatches = AddFold(group->body(), object_ptr<ColorSwatches>(group->body(), _color, [=](int color) {
			_color = color;
		}), Rem(0.625), _project.empty());
	}

	const auto remind = AddTo(_column, object_ptr<CardRow>(_column, u"schedule"_q), gap);
	const auto remindGrid = remind->add(object_ptr<FieldsGrid>(remind->body(), false));
	if (!_event) {
		remindGrid->add(MakeStatusSelect(remindGrid, _status, [=](std::string value) {
			_status = value;
		}));
	}
	remindGrid->add(MakeRemindSelect(remindGrid, _remind, [=](std::optional<int> value) {
		_remind = value;
	}));

	const auto info = AddTo(_column, object_ptr<CardRow>(_column, u"info"_q), gap);
	info->setLast(true);
	info->add(FieldLabel(info->body(), tr::lng_parvane_planner_field_description(tr::now)));
	const auto description = info->add(object_ptr<TextInput>(
		info->body(),
		TextInput::Kind::Multiline,
		QString(),
		_description,
		kDescriptionMaxLength));
	description->textChanges() | rpl::on_next([=](QString text) {
		_description = text;
	}, description->lifetime());
	if (!hasDate) {
		// Описание ряда — всех повторов (по умолчанию) либо только первого дня
		info->add(object_ptr<DescriptionScopeBox>(
			info->body(),
			_descriptionScope,
			false,
			[=](planner::DescriptionScope scope) {
				_descriptionScope = scope;
			}));
	}

	if (!_error.isEmpty()) {
		AddTo(_column, SmallText(_column, _error, Tone::Red), gap);
	}
	const auto actions = AddTo(_column, object_ptr<Kit::Flow>(_column, Rem(0.5)), gap);
	actions->add(object_ptr<Kit::PushButton>(
		actions,
		tr::lng_parvane_planner_create(tr::now),
		Kit::PushButton::Kind::Accent))->setClickedCallback([=] {
		submit();
	});
	actions->add(object_ptr<Kit::PushButton>(
		actions,
		tr::lng_parvane_planner_cancel(tr::now),
		Kit::PushButton::Kind::Ghost))->setClickedCallback([=] {
		if (_host.close) {
			_host.close();
		}
	});

	if (width() > 0) {
		_column->resizeToWidth(width());
	}
	if (hadFocus) {
		focusName();
	}
}

void TaskForm::submit() {
	const auto repeat = planner::draftToRepeat(_repeatDraft->current());
	// День отсчёта первого повтора у ряда без даты начала
	const auto fallbackDay = _day.empty() ? TodayKey() : _day;
	const auto fail = [=](const QString &text) {
		_error = text;
		crl::on_main(this, [=] { rebuild(); });
	};
	const auto project = _project;
	const auto scope = _descriptionScope;
	if (_event) {
		auto event = planner::Event();
		event.name = S(_name.trimmed());
		event.description = NonEmpty(S(_description.trimmed()));
		event.start = _allDay ? std::string(planner::kAllDayStart) : _start;
		event.end = _allDay
			? std::string(planner::kAllDayEnd)
			: !_end.empty()
			? _end
			: !_start.empty()
			? planner::getDefaultEventEnd(_start)
			: std::string();
		event.repeat = repeat;
		event.day = repeat ? std::nullopt : NonEmpty(_day);
		event.isAllDay = _allDay ? std::optional<bool>(true) : std::nullopt;
		event.isHoliday = _holiday ? std::optional<bool>(true) : std::nullopt;
		// Цвет — у группы; свой цвет события — только без группы
		event.color = (!project.empty() || !_color) ? std::nullopt : std::optional<int>(_color);
		event.project = NonEmpty(project);
		event.remind = _remind;
		if (const auto problem = planner::validateEvent(event)) {
			fail(EventErrorText(*problem));
			return;
		}
		event.id = planner::randomUuid();
		Sections::UpdatePlanner([=](planner::State &state) {
			planner::ensureList(state, project, planner::randomUuid);
			planner::addEntry(state, planner::SeriesKind::Event, planner::SeriesItem(event), scope, fallbackDay, planner::randomUuid);
		}, tr::lng_parvane_planner_notice_added(tr::now, lt_name, NameOf(event.name)));
		if (_host.close) {
			_host.close();
		}
		return;
	}
	// Задача-ряд: дата работы — у правила (`startDay`), у шаблона её нет
	auto task = planner::Task();
	task.name = S(_name.trimmed());
	if (!_minutes.empty()) {
		auto ok = false;
		const auto number = Q(_minutes).toDouble(&ok);
		task.minutes = (ok && std::isfinite(number)) ? int(std::round(number)) : 0;
	}
	task.day = repeat ? std::nullopt : NonEmpty(_day);
	task.start = NonEmpty(_start);
	task.due = repeat ? std::nullopt : NonEmpty(_due);
	task.remind = _remind;
	auto checked = task;
	if (repeat && task.start) {
		checked.day = NonEmpty(repeat->startDay.empty() ? _day : repeat->startDay);
	}
	if (const auto problem = planner::validateTask(checked)) {
		fail(TaskErrorText(*problem));
		return;
	}
	if (repeat) {
		if (const auto problem = planner::validateRepeat(*repeat)) {
			fail(RepeatErrorText(*problem));
			return;
		}
	}
	task.id = planner::randomUuid();
	task.description = S(_description.trimmed());
	task.status = _status;
	task.project = project;
	task.repeat = repeat;
	const auto taskId = task.id;
	const auto openDay = repeat ? repeat->startDay : std::string();
	const auto openTask = _host.openTask;
	UpdatePlannerWithResult([=](planner::State &state) -> std::optional<std::string> {
		planner::ensureList(state, project, planner::randomUuid);
		auto entry = task;
		// Новая задача — первой в очереди
		entry.rank = planner::newTaskRank(state);
		const auto own = planner::addEntry(
			state,
			planner::SeriesKind::Task,
			planner::SeriesItem(entry),
			scope,
			fallbackDay,
			planner::randomUuid);
		return own ? std::optional<std::string>(planner::itemId(*own)) : std::nullopt;
	}, tr::lng_parvane_planner_notice_added(tr::now, lt_name, NameOf(task.name)),
	[=](std::optional<std::string> ownDayId) {
		// Первый день с собственным описанием — отдельная запись: карточка открывается на ней
		if (!openTask) {
			return;
		}
		if (ownDayId) {
			openTask(*ownDayId, std::string());
		} else {
			openTask(taskId, openDay);
		}
	});
}

int TaskForm::resizeGetHeight(int newWidth) {
	_column->resizeToWidth(newWidth);
	_column->moveToLeft(0, 0, newWidth);
	return _column->height();
}

} // namespace Parvane::PlannerForms
