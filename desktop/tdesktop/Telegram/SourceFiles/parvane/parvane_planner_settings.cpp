// Parvane fork: реализация parvane_planner_settings.h (spec 029, T061).
#include "parvane/parvane_planner_settings.h"

#include "parvane/parvane_planner_form_widgets.h"
#include "parvane/parvane_sections_data.h"

#include "lang/lang_keys.h"
#include "ui/boxes/confirm_box.h"
#include "ui/widgets/fields/input_field.h"
#include "window/window_session_controller.h"
#include "styles/style_layers.h"

#include <parvane/sections/planner_schedule.h>

namespace Parvane::PlannerForms {
namespace {

using Kit::Rem;

class PlannerSettingsWidget final : public Ui::RpWidget {
public:
	PlannerSettingsWidget(QWidget *parent, not_null<Window::SessionController*> controller)
	: RpWidget(parent)
	, _controller(controller) {
		_column = Ui::CreateChild<Ui::VerticalLayout>(this);
		_column->heightValue() | rpl::on_next([=] {
			if (width() > 0) {
				resizeToWidth(width());
			}
		}, lifetime());
		const auto view = Sections::Planner();
		_state = view ? view->state : planner::createEmptyState();
		build();
		Sections::PlannerValue() | rpl::on_next([=](std::shared_ptr<const Sections::PlannerView> view) {
			if (view) {
				_state = view->state;
				refresh();
			}
		}, lifetime());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		_column->resizeToWidth(newWidth);
		_column->moveToLeft(0, 0, newWidth);
		return _column->height();
	}

private:
	void build();
	void refresh();
	void refreshSchedule();
	bool applySettings(Fn<void(planner::Settings&)> change);
	void addSchedule();
	void addHint(const QString &text);
	void addTitle(const QString &text, bool first);

	const not_null<Window::SessionController*> _controller;
	planner::State _state;
	Ui::VerticalLayout *_column = nullptr;
	FormField *_dayStart = nullptr;
	FormField *_dayEnd = nullptr;
	FormField *_budget = nullptr;
	TextInput *_scheduleText = nullptr;
	ListPicker *_scheduleList = nullptr;
	FormField *_scheduleUntil = nullptr;
	Kit::Label *_schedulePreview = nullptr;
	Kit::Label *_scheduleSkipped = nullptr;
	Kit::PushButton *_scheduleAdd = nullptr;
	planner::ParsedSchedule _schedule;
	std::string _scheduleGroup;
	// Дата конца, выбранная полем; нет — из текста («до 15.12.2026»)
	std::optional<std::string> _scheduleUntilPicked;

};

void PlannerSettingsWidget::addHint(const QString &text) {
	AddTo(_column, SmallText(_column, text), Rem(0.875));
}

void PlannerSettingsWidget::addTitle(const QString &text, bool first) {
	// `.groupTitle` (моноширинные заглавные 0.75rem, отступ 0.75rem сверху); первый — без отступа
	AddTo(_column, object_ptr<Kit::Caps>(_column, text, Kit::Caps::Kind::Caps), first ? 0 : Rem(1.625));
}

void PlannerSettingsWidget::build() {
	const auto controller = _controller.get();
	const auto gap = Rem(0.875); // `.editor`
	addTitle(tr::lng_parvane_planner_section(tr::now), true);
	const auto grid = AddTo(_column, object_ptr<FieldsGrid>(_column, false), gap);
	_dayStart = grid->add(object_ptr<FormField>(
		grid,
		controller,
		tr::lng_parvane_planner_settings_day_start(tr::now),
		FormField::Type::Time,
		planner::toTime(_state.settings.dayStart)));
	_dayStart->setOnCommit([=](std::string value) {
		const auto minutes = planner::toMinutes(value);
		return !value.empty() && applySettings([=](planner::Settings &settings) {
			settings.dayStart = minutes;
		});
	});
	_dayEnd = grid->add(object_ptr<FormField>(
		grid,
		controller,
		tr::lng_parvane_planner_settings_day_end(tr::now),
		FormField::Type::Time,
		planner::toTime(_state.settings.dayEnd)));
	_dayEnd->setOnCommit([=](std::string value) {
		const auto minutes = planner::toMinutes(value);
		return !value.empty() && applySettings([=](planner::Settings &settings) {
			settings.dayEnd = minutes;
		});
	});
	_budget = grid->add(object_ptr<FormField>(
		grid,
		controller,
		tr::lng_parvane_planner_settings_budget(tr::now),
		FormField::Type::Number,
		std::to_string(_state.budget)));
	_budget->setOnCommit([=](std::string value) {
		auto ok = false;
		const auto next = Q(value).toDouble(&ok);
		if (value.empty() || !ok || !planner::validateBudget(next)) {
			ShowError(_controller, tr::lng_parvane_planner_error_settings_budget(tr::now));
			return false;
		}
		const auto budget = int(std::round(next));
		Sections::UpdatePlanner([=](planner::State &state) {
			state.budget = budget;
		}, tr::lng_parvane_planner_notice_settings_saved(tr::now));
		return true;
	});
	addHint(tr::lng_parvane_planner_settings_hint(tr::now));
	addHint(tr::lng_parvane_planner_settings_goals_hint(tr::now));
	{
		const auto line = AddTo(_column, object_ptr<Line>(_column), gap);
		line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_settings_reset(tr::now),
			Kit::PushButton::Kind::Danger))->setClickedCallback([=] {
			Sections::UpdatePlanner([=](planner::State &state) {
				state.settings = planner::defaultSettings();
				state.budget = planner::createEmptyState().budget;
			}, tr::lng_parvane_planner_notice_settings_saved(tr::now));
		});
		line->addStretch();
	}
	addHint(tr::lng_parvane_planner_settings_learned_hint(tr::now));
	{
		const auto line = AddTo(_column, object_ptr<Line>(_column), gap);
		line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_settings_learned_reset(tr::now),
			Kit::PushButton::Kind::Ghost))->setClickedCallback([=] {
			// Словарь правок и история строк окна ввода — в данных «Плана» (на всех устройствах); своей записи
			// устройства у desktop нет
			const auto text = S(tr::lng_parvane_planner_notice_learned_reset(tr::now));
			Sections::Post([=](Sections::Workers &w) {
				const auto &state = w.planner.state();
				const auto hasWords = w.planner.canSyncLearned() && !state.learned.empty();
				const auto hasLines = w.planner.canSyncQuickHistory() && !state.quickLines.empty();
				if (hasWords || hasLines) {
					w.planner.update([=](planner::State &state) {
						if (hasWords) {
							state.learned.clear();
						}
						if (hasLines) {
							state.quickLines.clear();
						}
					}, text, w.nowMs);
				} else {
					w.planner.showNotice(text, w.nowMs);
				}
			});
		});
		line->addStretch();
	}

	// Расписание на неделю: каждая строка — еженедельный ряд с сегодняшнего дня до даты конца
	addTitle(tr::lng_parvane_planner_schedule_title(tr::now), false);
	addHint(tr::lng_parvane_planner_schedule_hint(tr::now));
	_scheduleText = AddTo(_column, object_ptr<TextInput>(
		_column,
		TextInput::Kind::Multiline,
		tr::lng_parvane_planner_schedule_placeholder(tr::now).replace('|', '\n'),
		QString(),
		0,
		Rem(12)), Rem(0.5));
	_scheduleText->textChanges() | rpl::on_next([=](QString text) {
		_schedule = planner::parseSchedule(S(text));
		refreshSchedule();
	}, _scheduleText->lifetime());
	_scheduleList = AddTo(_column, object_ptr<ListPicker>(
		_column,
		controller,
		_state,
		_scheduleGroup,
		[=](std::string project) { _scheduleGroup = project; }), Rem(0.75));
	const auto untilGrid = AddTo(_column, object_ptr<FieldsGrid>(_column, false), gap);
	_scheduleUntil = untilGrid->add(object_ptr<FormField>(
		untilGrid,
		controller,
		tr::lng_parvane_planner_schedule_until(tr::now),
		FormField::Type::Date,
		std::string()));
	_scheduleUntil->setOnCommit([=](std::string value) {
		_scheduleUntilPicked = value.empty() ? std::nullopt : std::optional<std::string>(value);
		refreshSchedule();
		return true;
	});
	_schedulePreview = AddTo(_column, SmallText(_column, QString()), gap);
	_scheduleSkipped = AddTo(_column, SmallText(_column, QString()), gap);
	{
		const auto line = AddTo(_column, object_ptr<Line>(_column), gap);
		_scheduleAdd = line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_schedule_add(tr::now),
			Kit::PushButton::Kind::Accent));
		_scheduleAdd->setClickedCallback([=] { addSchedule(); });
		line->addStretch();
	}
	refreshSchedule();

	// Очистить план: все задачи и события, после вопроса
	addTitle(tr::lng_parvane_planner_clear_title(tr::now), false);
	addHint(tr::lng_parvane_planner_clear_hint(tr::now));
	{
		const auto line = AddTo(_column, object_ptr<Line>(_column), gap);
		line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_planner_clear_title(tr::now),
			Kit::PushButton::Kind::Danger))->setClickedCallback([=] {
			_controller->show(Ui::MakeConfirmBox({
				.text = tr::lng_parvane_planner_clear_confirm(tr::now),
				.confirmed = [=](Fn<void()> close) {
					close();
					Sections::UpdatePlanner([=](planner::State &state) {
						state.tasks.clear();
						state.events.clear();
					}, tr::lng_parvane_planner_notice_cleared(tr::now));
				},
				.confirmText = tr::lng_parvane_planner_clear_title(tr::now),
				.confirmStyle = &st::attentionBoxButton,
			}));
		});
		line->addStretch();
	}
}

void PlannerSettingsWidget::refresh() {
	_dayStart->setValue(planner::toTime(_state.settings.dayStart));
	_dayEnd->setValue(planner::toTime(_state.settings.dayEnd));
	_budget->setValue(std::to_string(_state.budget));
	_scheduleList->setState(_state, _scheduleGroup);
}

void PlannerSettingsWidget::refreshSchedule() {
	const auto until = _scheduleUntilPicked ? _scheduleUntilPicked : _schedule.endDay;
	if (!_scheduleUntilPicked && !_scheduleUntil->hasFocus()) {
		_scheduleUntil->setValue(until.value_or(std::string()), true);
	}
	const auto count = int(_schedule.items.size());
	if (count) {
		const auto date = until
			? FormatDay(*until) + ' ' + QString::number(DateOf(*until).year())
			: QString(QChar(0x2014));
		_schedulePreview->setText(tr::lng_parvane_planner_schedule_preview(
			tr::now,
			lt_amount,
			QString::number(count),
			lt_date,
			date));
	}
	_schedulePreview->setVisible(count > 0);
	const auto skipped = int(_schedule.skipped.size());
	if (skipped) {
		_scheduleSkipped->setText(tr::lng_parvane_planner_schedule_skipped(
			tr::now,
			lt_amount,
			QString::number(skipped)));
	}
	_scheduleSkipped->setVisible(skipped > 0);
	_scheduleAdd->setDisabled(!count);
	_scheduleAdd->update();
	_column->resizeToWidth(width());
}

bool PlannerSettingsWidget::applySettings(Fn<void(planner::Settings&)> change) {
	auto next = _state.settings;
	change(next);
	if (const auto error = planner::validateSettings(next)) {
		ShowError(_controller, SettingsErrorText(*error));
		return false;
	}
	Sections::UpdatePlanner([=](planner::State &state) {
		state.settings = next;
	}, tr::lng_parvane_planner_notice_settings_saved(tr::now));
	return true;
}

void PlannerSettingsWidget::addSchedule() {
	const auto today = TodayKey();
	const auto until = _scheduleUntilPicked ? _scheduleUntilPicked : _schedule.endDay;
	if (_schedule.items.empty()) {
		ShowError(_controller, tr::lng_parvane_planner_error_schedule_empty(tr::now));
		return;
	}
	if (!until || until->empty() || *until < today) {
		ShowError(_controller, tr::lng_parvane_planner_error_schedule_until(tr::now));
		return;
	}
	const auto events = planner::buildScheduleEvents(
		_schedule.items,
		today,
		*until,
		_scheduleGroup.empty() ? std::nullopt : std::optional<std::string>(_scheduleGroup),
		planner::randomUuid);
	Sections::UpdatePlanner([=](planner::State &state) {
		state.events.insert(end(state.events), begin(events), end(events));
	}, tr::lng_parvane_planner_notice_schedule_added(tr::now, lt_amount, QString::number(events.size())));
	_scheduleText->setText(QString());
	_scheduleUntilPicked = std::nullopt;
	_schedule = planner::ParsedSchedule();
	refreshSchedule();
}

} // namespace

object_ptr<Ui::RpWidget> MakePlannerSettings(QWidget *parent, not_null<Window::SessionController*> controller) {
	return object_ptr<PlannerSettingsWidget>(parent, controller);
}

} // namespace Parvane::PlannerForms
