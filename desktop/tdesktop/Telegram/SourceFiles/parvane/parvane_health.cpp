// Parvane fork: реализация parvane_health.h — экран «Здоровье» (spec 029, T062). Сводки считает ядро
// (`parvane/sections/planner_health.h`), запись строки — `applyQuickDraft` (planner_quick_apply.h); правки —
// `Sections::UpdatePlanner` (лямбды правок берут только значения: они идут в рабочий поток).
#include "parvane/parvane_health.h"
#include "parvane/parvane_planner_quick.h"
#include "parvane/parvane_planner_forms.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_health_widgets.h"
#include "parvane/parvane_mascot.h"
#include "parvane/parvane_sections_data.h"
#include "parvane/parvane_sections_host.h"

#include "lang/lang_keys.h"

#include <crl/crl_on_main.h>
#include "mainwindow.h"
#include "ui/painter.h"
#include "ui/qt_object_factory.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/scroll_area.h"
#include "window/window_session_controller.h"

#include <parvane/sections/planner_quick.h>
#include <parvane/sections/planner_quick_apply.h>

#include <QtCore/QDateTime>
#include <QtCore/QPointer>

#include <cmath>

namespace Parvane::Health {
namespace {

using Kit::Font;
using Kit::Px;
using Kit::Rem;
using PlannerForms::AddTo;
using PlannerForms::FormatDayShort;
using PlannerForms::FormatSpan;
using PlannerForms::Q;
using PlannerForms::S;
using PlannerForms::SmallText;

constexpr auto kGlassMl = 250;
constexpr auto kBottleMl = 500;
constexpr auto kWeightDays = 21;
constexpr auto kWeek = 7;
constexpr auto kClockStep = 5;       // среднее время — с точностью до пяти минут
constexpr auto kOnGoalMinutes = 10;  // среднее ближе этого к цели — «по цели»

[[nodiscard]] QString Number(double value, int digits = 0) {
	return PlannerForms::FormatNumber(value, digits);
}

[[nodiscard]] double Share(double value, std::optional<double> goal) {
	return (goal && *goal) ? std::min(1., value / *goal) : 0.;
}

[[nodiscard]] int RoundToStep(double minutes) {
	return int(std::round(minutes / kClockStep)) * kClockStep;
}

[[nodiscard]] QString Litres(double ml) {
	return tr::lng_parvane_health_litres(tr::now, lt_value, Number(ml / 1000., 1));
}

[[nodiscard]] QString GoalLabel(const QString &value) {
	return tr::lng_parvane_health_goal_value(tr::now, lt_value, value);
}

[[nodiscard]] QString MinutesText(int value) {
	return tr::lng_parvane_planner_minutes_value(tr::now, lt_minutes, QString::number(value));
}

[[nodiscard]] std::string QuickLang() {
	return IsRussianUi() ? "ru" : "en";
}

[[nodiscard]] QString MealLabel(const std::string &meal) {
	if (meal == "breakfast") return tr::lng_parvane_health_meal_breakfast(tr::now);
	if (meal == "lunch") return tr::lng_parvane_health_meal_lunch(tr::now);
	if (meal == "dinner") return tr::lng_parvane_health_meal_dinner(tr::now);
	if (meal == "snack") return tr::lng_parvane_health_meal_snack(tr::now);
	return tr::lng_parvane_health_meal_other(tr::now);
}

[[nodiscard]] planner::State CurrentState() {
	const auto view = Sections::Planner();
	return view ? view->state : planner::createEmptyState();
}

[[nodiscard]] not_null<QWidget*> SheetParent(not_null<Window::SessionController*> controller) {
	return controller->widget()->bodyWidget();
}

// Сводка целей одной строкой (web `goalsSection`)
[[nodiscard]] QString GoalsSummary(const planner::State &state, const std::string &day, const std::string &today) {
	const auto goals = planner::getGoalsForDay(state, day, today);
	const auto &health = state.healthGoals;
	const auto goal = [&](const char *metric) -> std::optional<double> {
		const auto i = goals.find(metric);
		return (i != goals.end() && i->second.target) ? std::optional<double>(i->second.target) : std::nullopt;
	};
	auto parts = QStringList();
	if (const auto kcal = goal("kcal")) {
		parts.push_back(tr::lng_parvane_health_kcal(tr::now, lt_value, Number(*kcal)));
	}
	const auto macros = std::array<std::pair<const char*, QString>, 4>{ {
		{ "protein", tr::lng_parvane_health_protein(tr::now) },
		{ "fat", tr::lng_parvane_health_fat(tr::now) },
		{ "carbs", tr::lng_parvane_health_carbs(tr::now) },
		{ "fiber", tr::lng_parvane_health_fiber(tr::now) },
	} };
	for (const auto &[metric, label] : macros) {
		if (const auto value = goal(metric)) {
			parts.push_back(label + ' ' + Number(*value));
		}
	}
	if (const auto water = goal("water")) {
		parts.push_back(tr::lng_parvane_health_water(tr::now) + ' ' + Litres(*water));
	}
	if (health.sleepMinutes && *health.sleepMinutes) {
		parts.push_back(tr::lng_parvane_health_sleep(tr::now) + ' ' + FormatSpan(*health.sleepMinutes));
	}
	const auto bed = planner::getClockGoal(health.bedtime);
	const auto wake = planner::getClockGoal(health.wakeTime);
	if (bed && wake) {
		parts.push_back(tr::lng_parvane_health_routine_goal_short(
			tr::now,
			lt_bed,
			Q(planner::toTime(int(*bed))),
			lt_wake,
			Q(planner::toTime(int(*wake)))));
	}
	if (health.steps && *health.steps) {
		parts.push_back(tr::lng_parvane_health_steps_short(tr::now) + ' ' + Number(*health.steps));
	}
	parts.push_back(tr::lng_parvane_health_day_window(
		tr::now,
		lt_from,
		Q(planner::toTime(state.settings.dayStart)),
		lt_to,
		Q(planner::toTime(state.settings.dayEnd)),
		lt_budget,
		PlannerForms::FormatHours(state.budget)));
	return parts.join(u" · "_q);
}

// Карточка целей (web `goalsSection`): сводка и правка текстом той же грамматикой, что строка «цель …»
class GoalsCard final : public Ui::RpWidget {
public:
	GoalsCard(QWidget *parent, not_null<Window::SessionController*> controller)
	: RpWidget(parent) {
		_card = Ui::CreateChild<Card>(this);
		_card->add(MakeHead(_card->column(), tr::lng_parvane_health_goals(tr::now)));
		_summary = _card->add(SmallText(_card->column(), QString(), Tone::Muted, 14));
		_card->add(object_ptr<TextForm>(
			_card->column(),
			tr::lng_parvane_health_goals_placeholder(tr::now),
			tr::lng_parvane_health_goals_apply(tr::now),
			true,
			[=](QString text) {
				const auto state = CurrentState();
				auto context = planner::QuickContext();
				context.today = PlannerForms::TodayKey();
				context.nowMinutes = 0;
				context.dayStart = state.settings.dayStart;
				context.dayEnd = state.settings.dayEnd;
				context.kind = "goal";
				context.lang = QuickLang();
				const auto draft = planner::parseQuickInput(S(text), context);
				if (draft.error) {
					PlannerForms::ShowError(controller, tr::lng_parvane_health_goals_bad(tr::now));
					return false;
				}
				const auto today = context.today;
				Sections::UpdatePlanner([=](planner::State &state) {
					planner::applyQuickDraft(state, draft, today, planner::randomUuid);
				}, tr::lng_parvane_health_notice_goals_saved(tr::now));
				return true;
			}));
		_card->heightValue() | rpl::on_next([=](int h) {
			resize(width(), h);
		}, lifetime());
		Sections::PlannerValue() | rpl::on_next([=](std::shared_ptr<const Sections::PlannerView> view) {
			if (view) {
				const auto today = PlannerForms::TodayKey();
				_summary->setText(GoalsSummary(view->state, today, today));
			}
		}, lifetime());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		_card->resizeToWidth(newWidth);
		_card->moveToLeft(0, 0, newWidth);
		return _card->height();
	}

private:
	Card *_card = nullptr;
	Kit::Label *_summary = nullptr;

};

// Строка даты (web PlannerDateNav): «Сегодня»/день недели и дата крупно, «Сегодня», стрелки
class DateNav final : public Ui::RpWidget {
public:
	DateNav(QWidget *parent, Fn<void(int)> shift, Fn<void()> today)
	: RpWidget(parent) {
		Kit::RepaintOnTones(this);
		_today = Ui::CreateChild<Kit::Pill>(this, tr::lng_parvane_health_jump_today(tr::now));
		_today->setClickedCallback(today);
		_prev = Ui::CreateChild<PlannerForms::GlyphButton>(this, u"previous"_q, tr::lng_parvane_health_prev_period(tr::now));
		_prev->setClickedCallback([=] { shift(-1); });
		_next = Ui::CreateChild<PlannerForms::GlyphButton>(this, u"next"_q, tr::lng_parvane_health_next_period(tr::now));
		_next->setClickedCallback([=] { shift(1); });
		setNaturalWidth(-1);
	}

	void setDay(const std::string &day, const std::string &today) {
		_over = PlannerForms::FormatRelativeDay(day, today);
		_big = PlannerForms::FormatDay(day);
		_today->setVisible(day != today);
		resizeToWidth(width());
		update();
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto h = Font(14)->height + Font(26, true, true)->height;
		const auto gap = Rem(0.625);
		auto x = newWidth;
		for (const auto button : { static_cast<Ui::RpWidget*>(_next), static_cast<Ui::RpWidget*>(_prev) }) {
			x -= button->width();
			button->moveToLeft(x, (h - button->height()) / 2, newWidth);
			x -= gap;
		}
		if (!_today->isHidden()) {
			x -= _today->width();
			_today->moveToLeft(x, (h - _today->height()) / 2, newWidth);
		}
		return h;
	}

	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		const auto over = Font(14);
		const auto big = Font(26, true, true);
		const auto right = (_today->isHidden() ? _prev->x() : _today->x()) - Rem(0.625);
		p.setFont(over->f);
		p.setPen(ToneColor(Tone::Muted));
		p.drawText(0, over->ascent, over->elided(_over, std::max(right, 0)));
		p.setFont(big->f);
		p.setPen(ToneColor(Tone::Fg));
		p.drawText(0, over->height + big->ascent, big->elided(_big, std::max(right, 0)));
	}

private:
	Kit::Pill *_today = nullptr;
	PlannerForms::GlyphButton *_prev = nullptr;
	PlannerForms::GlyphButton *_next = nullptr;
	QString _over;
	QString _big;

};

// Сетка карточек (`.health`): две колонки (одна — на узком экране); широкие — на обе колонки
class Grid final : public Ui::RpWidget {
public:
	explicit Grid(QWidget *parent)
	: RpWidget(parent) {
	}

	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child, bool wide = false) {
		const auto raw = child.release();
		raw->setParent(this);
		raw->show();
		_items.push_back({ raw, wide });
		raw->heightValue() | rpl::skip(1) | rpl::on_next([=] {
			// Пересчёт после текущего прохода и один на пачку: синхронный зацикливался (карточка ↔ сетка)
			if (_inResize || _relayoutScheduled) {
				return;
			}
			_relayoutScheduled = true;
			crl::on_main(this, [=] {
				_relayoutScheduled = false;
				if (width() > 0) {
					resizeToWidth(width());
				}
			});
		}, raw->lifetime());
		return static_cast<Widget*>(raw);
	}

protected:
	int resizeGetHeight(int newWidth) override {
		_inResize = true;
		const auto gap = Rem(1);
		// web: одна колонка уже 1100 px окна — здесь по ширине самого экрана
		const auto columns = (newWidth >= Rem(50)) ? 2 : 1;
		const auto cell = (newWidth - gap * (columns - 1)) / columns;
		auto y = 0;
		auto column = 0;
		auto rowHeight = 0;
		for (const auto &item : _items) {
			if (item.wide || columns == 1) {
				if (column) {
					y += rowHeight + gap;
					column = 0;
					rowHeight = 0;
				}
				item.widget->resizeToWidth(newWidth);
				item.widget->moveToLeft(0, y, newWidth);
				y += item.widget->height() + gap;
				continue;
			}
			item.widget->resizeToWidth(cell);
			item.widget->moveToLeft(column * (cell + gap), y, newWidth);
			rowHeight = std::max(rowHeight, item.widget->height());
			if (++column == columns) {
				y += rowHeight + gap;
				column = 0;
				rowHeight = 0;
			}
		}
		if (column) {
			y += rowHeight + gap;
		}
		_inResize = false;
		return std::max(y - gap, 0);
	}

private:
	struct Item {
		Ui::RpWidget *widget = nullptr;
		bool wide = false;
	};
	std::vector<Item> _items;
	bool _inResize = false;
	bool _relayoutScheduled = false;

};

// Содержимое экрана: строка даты и карточки; перестраивается при смене состояния «Плана» и дня
class Content final : public Ui::RpWidget {
public:
	Content(QWidget *parent, not_null<Window::SessionController*> controller)
	: RpWidget(parent)
	, _controller(controller)
	, _today(PlannerForms::TodayKey())
	, _day(_today) {
		_nav = Ui::CreateChild<DateNav>(this, [=](int delta) {
			_day = planner::addDays(_day, delta);
			_pickedSleepDay = std::string();
			_editingSleepId = std::string(); // правка сна относится к показанному дню
			rebuild();
		}, [=] {
			_day = PlannerForms::TodayKey();
			_editingSleepId = std::string();
			rebuild();
		});
		_column = Ui::CreateChild<Ui::VerticalLayout>(this);
		_column->heightValue() | rpl::on_next([=] {
			if (width() > 0) {
				resizeToWidth(width());
			}
		}, lifetime());
		Sections::PlannerValue() | rpl::on_next([=](std::shared_ptr<const Sections::PlannerView> view) {
			if (!view || (_view && view->revision == _view->revision && view->state.health.size() == _view->state.health.size() && _builtDay == _day)) {
				_view = view;
				return;
			}
			_view = view;
			rebuild();
		}, lifetime());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		// `.content`: поля 1.25rem; `.dateNav`: отступ 1rem снизу
		const auto pad = Rem(1.25);
		const auto inner = std::max(newWidth - 2 * pad, 1);
		_nav->resizeToWidth(inner);
		_nav->moveToLeft(pad, pad, newWidth);
		const auto top = pad + _nav->height() + Rem(1);
		_column->resizeToWidth(inner);
		_column->moveToLeft(pad, top, newWidth);
		return top + _column->height() + pad;
	}

private:
	void rebuild();
	void example(const QString &text) {
		OpenQuickEntry(_controller, text);
	}
	void addNutrition(not_null<Grid*> grid);
	void addWaterBody(not_null<Grid*> grid);
	void addSleep(not_null<Grid*> grid);
	void addRoutine(not_null<Card*> card);
	void addActivity(not_null<Grid*> grid);
	void addKcalWeek(not_null<Grid*> grid);
	[[nodiscard]] object_ptr<Bars> makeBars(
		QWidget *parent,
		std::vector<std::optional<double>> values,
		Fn<QString(double)> format,
		Tone tone,
		std::optional<double> goal,
		Fn<bool(double)> isLow = nullptr) const;
	[[nodiscard]] QString sleepDetail(const std::string &key) const;

	const not_null<Window::SessionController*> _controller;
	std::string _today;
	std::string _day;
	std::string _builtDay;
	std::shared_ptr<const Sections::PlannerView> _view;
	std::string _pickedSleepDay;
	std::string _editingSleepId;
	DateNav *_nav = nullptr;
	Ui::VerticalLayout *_column = nullptr;
	TextForm *_sleepForm = nullptr;
	Kit::Label *_sleepDetail = nullptr;
	RoutineChart *_routineChart = nullptr;

};

object_ptr<Bars> Content::makeBars(
		QWidget *parent,
		std::vector<std::optional<double>> values,
		Fn<QString(double)> format,
		Tone tone,
		std::optional<double> goal,
		Fn<bool(double)> isLow) const {
	const auto week = planner::getLastDays(_day);
	auto data = Bars::Data{
		.values = std::move(values),
		.format = std::move(format),
		.tone = tone,
		.goal = (goal && *goal) ? goal : std::nullopt,
		.isLow = std::move(isLow),
	};
	for (const auto &key : week) {
		data.labels.push_back(PlannerForms::FormatWeekday((planner::weekdayOf(key) + 6) % kWeek));
		data.current.push_back(key == _day);
	}
	return object_ptr<Bars>(parent, std::move(data));
}

void Content::rebuild() {
	_today = PlannerForms::TodayKey();
	_builtDay = _day;
	_nav->setDay(_day, _today);
	// Набранное в строке сна переживает перестройку
	const auto sleepText = _sleepForm ? _sleepForm->text() : QString();
	const auto sleepFocus = _sleepForm && _sleepForm->hasFocus();
	Kit::ClearLayout(_column);
	_sleepForm = nullptr;
	_sleepDetail = nullptr;
	_routineChart = nullptr;
	if (!_view) {
		return;
	}
	const auto grid = AddTo(_column, object_ptr<Grid>(_column), 0);

	// Подсказка: всё вводится текстом, примеры строк
	{
		const auto card = grid->add(object_ptr<Card>(grid), true);
		const auto head = card->add(MakeHead(card->column(), tr::lng_parvane_health_hint_title(tr::now)));
		head->add(object_ptr<Kit::PushButton>(
			head,
			tr::lng_parvane_health_goals_short(tr::now),
			Kit::PushButton::Kind::Ghost,
			u"sliders"_q))->setClickedCallback([=] {
			OpenGoals(_controller);
		});
		card->add(SmallText(card->column(), tr::lng_parvane_health_hint(tr::now), Tone::Muted, 14));
		const auto chips = card->add(object_ptr<Kit::Flow>(card->column()));
		for (const auto &raw : tr::lng_parvane_health_examples(tr::now).split('|')) {
			const auto text = raw.trimmed();
			if (text.isEmpty()) {
				continue;
			}
			const auto chip = chips->add(object_ptr<Kit::Chip>(chips, Kit::Chip::Descriptor{ .text = text }));
			// Пробел в конце — признак начала строки, а не примера вида
			chip->setClickedCallback([=] { example(text + ' '); });
		}
	}
	addNutrition(grid);
	addWaterBody(grid);
	addSleep(grid);
	addActivity(grid);
	addKcalWeek(grid);
	if (_sleepForm && (!sleepText.isEmpty() || sleepFocus)) {
		_sleepForm->restore(sleepText, sleepFocus);
	}
	if (width() > 0) {
		resizeToWidth(width());
	}
}

void Content::addNutrition(not_null<Grid*> grid) {
	const auto &state = _view->state;
	const auto day = _day;
	const auto goals = planner::getGoalsForDay(state, day, _today);
	const auto goalOf = [&](const char *metric) -> std::optional<double> {
		const auto i = goals.find(metric);
		return (i != goals.end() && i->second.target) ? std::optional<double>(i->second.target) : std::nullopt;
	};
	const auto total = [&](const char *nutrient) {
		return planner::getNutrientTotal(state, day, nutrient).value;
	};
	const auto i = state.nutrition.find(day);
	const auto nutritionDay = (i != state.nutrition.end()) ? std::optional(i->second) : std::nullopt;
	const auto kcal = total("kcal");
	const auto kcalGoal = goalOf("kcal");
	const auto isOver = kcalGoal ? (kcal > *kcalGoal) : false;
	const auto isClosed = nutritionDay ? nutritionDay->isComplete : false;

	const auto card = grid->add(object_ptr<Card>(grid));
	card->add(MakeHead(
		card->column(),
		tr::lng_parvane_health_nutrition(tr::now),
		kcalGoal ? GoalLabel(Number(*kcalGoal)) : QString()));
	auto suffix = tr::lng_parvane_health_kcal_unit(tr::now);
	if (kcalGoal) {
		suffix += u" · "_q + (isOver
			? tr::lng_parvane_health_kcal_over(tr::now, lt_value, Number(kcal - *kcalGoal))
			: tr::lng_parvane_health_kcal_left(tr::now, lt_value, Number(*kcalGoal - kcal)));
	}
	const auto tone = isOver ? Tone::Red : Tone::Orange;
	card->add(object_ptr<BigValue>(card->column(), Number(kcal), tone, suffix, false));
	card->add(MakeProgress(card->column(), Share(kcal, kcalGoal), tone, true));
	// День питания закрыт — итог дня считается окончательным
	const auto closed = card->add(object_ptr<PlannerForms::CheckRow>(
		card->column(),
		isClosed ? tr::lng_parvane_health_day_closed_hint(tr::now) : tr::lng_parvane_health_close_day(tr::now),
		isClosed,
		false,
		Tone::Green));
	// целевое значение берём из отрисованного состояния, а не переключаем флаг в записи: два быстрых нажатия
	// или правка с другого устройства не должны перевернуть результат
	const auto target = !isClosed;
	closed->setOnChange([=](bool) {
		Sections::UpdatePlanner([=](planner::State &state) {
			auto &record = state.nutrition[day];
			record.isComplete = target;
		}, isClosed ? tr::lng_parvane_health_day_reopened(tr::now) : tr::lng_parvane_health_day_closed(tr::now));
	});
	// Белки, жиры, углеводы, клетчатка; сахар и соль — пределы
	const auto macros = card->add(object_ptr<Ui::VerticalLayout>(card->column()));
	struct Macro {
		const char *nutrient;
		QString label;
		Tone tone;
	};
	const auto list = std::array<Macro, 4>{ {
		{ "protein", tr::lng_parvane_health_protein(tr::now), KindTone(Kind::Sleep) },
		{ "fat", tr::lng_parvane_health_fat(tr::now), KindTone(Kind::Note) },
		{ "carbs", tr::lng_parvane_health_carbs(tr::now), KindTone(Kind::Food) },
		{ "fiber", tr::lng_parvane_health_fiber(tr::now), KindTone(Kind::Workout) },
	} };
	for (const auto &macro : list) {
		const auto value = total(macro.nutrient);
		const auto goal = goalOf(macro.nutrient);
		const auto goalPart = goal
			? tr::lng_parvane_health_grams(tr::now, lt_value, QString(), lt_goal, Number(*goal))
			: tr::lng_parvane_health_grams_no_goal(tr::now, lt_value, QString());
		AddTo(macros, object_ptr<MacroRow>(
			macros,
			macro.label,
			Number(value),
			goalPart,
			Share(value, goal),
			macro.tone,
			false), Rem(0.5));
	}
	struct Limit {
		const char *nutrient;
		QString label;
		std::optional<double> goal;
		Tone tone;
	};
	const auto &health = state.healthGoals;
	const auto limits = std::array<Limit, 2>{ {
		{ "sugar", tr::lng_parvane_health_sugar(tr::now), health.sugarMax, KindTone(Kind::Metric) },
		{ "salt", tr::lng_parvane_health_salt(tr::now), health.saltMax, KindTone(Kind::Task) },
	} };
	for (const auto &limit : limits) {
		const auto value = planner::getLimitTotal(state, day, limit.nutrient);
		const auto max = (limit.goal && *limit.goal) ? limit.goal : std::nullopt;
		const auto exceeded = max && value > *max;
		const auto goalPart = max
			? tr::lng_parvane_health_limit(tr::now, lt_value, QString(), lt_goal, Number(*max, 1))
			: tr::lng_parvane_health_grams_no_goal(tr::now, lt_value, QString());
		AddTo(macros, object_ptr<MacroRow>(
			macros,
			limit.label,
			Number(value, 1),
			goalPart,
			Share(value, max),
			exceeded ? Tone::Red : limit.tone,
			exceeded), Rem(0.5));
	}
	// Приёмы пищи по времени
	auto entries = nutritionDay ? nutritionDay->entries : std::vector<planner::FoodEntry>();
	std::stable_sort(entries.begin(), entries.end(), [](const auto &a, const auto &b) {
		return a.time.value_or("99") < b.time.value_or("99");
	});
	const auto meals = card->add(object_ptr<Ui::VerticalLayout>(card->column()));
	if (entries.empty()) {
		AddTo(meals, SmallText(meals, tr::lng_parvane_health_no_meals(tr::now), Tone::Muted, Kit::kBodyPx), 0);
	}
	for (const auto &entry : entries) {
		auto parts = QStringList();
		if (entry.protein || entry.fat || entry.carbs) {
			parts.push_back(tr::lng_parvane_health_macros(
				tr::now,
				lt_protein,
				Number(entry.protein.value_or(0.)),
				lt_fat,
				Number(entry.fat.value_or(0.)),
				lt_carbs,
				Number(entry.carbs.value_or(0.))));
		}
		if (entry.fiber) {
			parts.push_back(tr::lng_parvane_health_fiber_short(tr::now, lt_value, Number(*entry.fiber)));
		}
		const auto id = entry.id;
		AddTo(meals, object_ptr<EntryRow>(meals, EntryRow::Descriptor{
			.time = Q(entry.time.value_or(std::string())),
			.title = MealLabel(entry.meal) + u": "_q + Q(entry.name),
			.subtitle = parts.isEmpty() ? tr::lng_parvane_health_no_macros(tr::now) : parts.join(u" · "_q),
			.subtitleMono = true,
			.meta = Number(entry.kcal),
			.deleteName = tr::lng_parvane_health_delete(tr::now, lt_name, Q(entry.name)),
		}, [=] {
			Sections::UpdatePlanner([=](planner::State &state) {
				const auto i = state.nutrition.find(day);
				if (i != state.nutrition.end()) {
					auto &list = i->second.entries;
					list.erase(ranges::remove(list, id, &planner::FoodEntry::id), end(list));
				}
			}, tr::lng_parvane_health_notice_deleted(tr::now));
		}), 0);
	}
}

void Content::addWaterBody(not_null<Grid*> grid) {
	const auto &state = _view->state;
	const auto day = _day;
	const auto goals = planner::getGoalsForDay(state, day, _today);
	const auto waterIt = goals.find("water");
	const auto waterGoal = (waterIt != goals.end() && waterIt->second.target)
		? std::optional<double>(waterIt->second.target)
		: std::nullopt;
	const auto i = state.nutrition.find(day);
	const auto waterMl = (i != state.nutrition.end()) ? i->second.waterMl.value_or(0.) : 0.;
	const auto &health = state.healthGoals;

	const auto card = grid->add(object_ptr<Card>(grid));
	// Вода
	card->add(MakeHead(
		card->column(),
		tr::lng_parvane_health_water(tr::now),
		waterGoal ? GoalLabel(Litres(*waterGoal)) : QString()));
	const auto water = card->add(object_ptr<BigValue>(
		card->column(),
		Number(waterMl / 1000., 2),
		KindTone(Kind::Event),
		tr::lng_parvane_health_litres_unit(tr::now),
		true));
	water->setClickedCallback([=] { example(tr::lng_parvane_health_water_example(tr::now)); });
	card->add(MakeProgress(card->column(), Share(waterMl, waterGoal), KindTone(Kind::Event), true));
	const auto chips = card->add(object_ptr<Kit::Flow>(card->column()));
	const auto addWater = [=](int amount) {
		Sections::UpdatePlanner([=](planner::State &state) {
			auto &record = state.nutrition[day];
			record.waterMl = record.waterMl.value_or(0.) + amount;
		}, tr::lng_parvane_planner_notice_added(
			tr::now,
			lt_name,
			tr::lng_parvane_health_ml(tr::now, lt_value, QString::number(amount))));
	};
	chips->add(object_ptr<Kit::Chip>(chips, Kit::Chip::Descriptor{
		.text = tr::lng_parvane_health_add_glass(tr::now),
	}))->setClickedCallback([=] { addWater(kGlassMl); });
	chips->add(object_ptr<Kit::Chip>(chips, Kit::Chip::Descriptor{
		.text = tr::lng_parvane_health_add_bottle(tr::now),
	}))->setClickedCallback([=] { addWater(kBottleMl); });

	// Тело: вес с изменением за неделю, график за три недели, давление, пульс, самочувствие
	const auto latest = planner::getLatestRecord(state, "weight", day);
	const auto before = latest ? planner::getLatestRecord(state, "weight", planner::addDays(latest->day, -kWeek)) : std::nullopt;
	const auto change = (latest && before && before->id != latest->id)
		? std::optional<double>(latest->value - before->value)
		: std::nullopt;
	const auto weightGoal = (health.weight && *health.weight) ? health.weight : std::nullopt;
	card->add(MakeHead(
		card->column(),
		tr::lng_parvane_health_body(tr::now),
		weightGoal ? GoalLabel(tr::lng_parvane_health_kg(tr::now, lt_value, Number(*weightGoal, 1))) : QString()));
	auto suffix = tr::lng_parvane_health_kg_unit(tr::now);
	if (change) {
		suffix += u" · "_q + tr::lng_parvane_health_week_change(
			tr::now,
			lt_value,
			((*change > 0) ? u"+"_q : QString()) + Number(*change, 1));
	}
	const auto weight = card->add(object_ptr<BigValue>(
		card->column(),
		latest ? Number(latest->value, 1) : QString(QChar(0x2014)),
		KindTone(Kind::Workout),
		suffix,
		true));
	weight->setClickedCallback([=] { example(tr::lng_parvane_health_weight_example(tr::now)); });
	const auto series = planner::getDailySeries(state, "weight", planner::getLastDays(day, kWeightDays));
	if (ranges::any_of(series, [](const auto &value) { return value.has_value(); })) {
		card->add(object_ptr<WeightSpark>(
			card->column(),
			series,
			health.weight,
			health.weight ? GoalLabel(Number(*health.weight, 1)) : QString()));
	} else {
		card->add(SmallText(card->column(), tr::lng_parvane_health_no_records(tr::now), Tone::Muted, Kit::kBodyPx));
	}
	const auto pressure = planner::getLatestRecord(state, "pressure", day);
	const auto pulse = planner::getLatestRecord(state, "pulse", day);
	const auto mood = planner::getDailyRecord(state, "mood", day);
	const auto facts = card->add(object_ptr<PlannerForms::FieldsGrid>(card->column(), false));
	// `.healthFacts`: три колонки — три показателя в ряд
	const auto factsLine = facts->add(object_ptr<Line>(facts, Rem(0.5)));
	const auto addFact = [&](const QString &label, const QString &value, const QString &exampleText, bool accent) {
		const auto button = factsLine->add(object_ptr<FactButton>(factsLine, label, value, accent), true);
		button->setClickedCallback([=] { example(exampleText); });
	};
	addFact(
		tr::lng_parvane_health_pressure(tr::now),
		pressure ? (Number(pressure->value) + '/' + Number(pressure->value2.value_or(0.))) : QString(),
		tr::lng_parvane_health_pressure_example(tr::now),
		false);
	addFact(
		tr::lng_parvane_health_pulse(tr::now),
		pulse ? tr::lng_parvane_health_bpm(tr::now, lt_value, Number(pulse->value)) : QString(),
		tr::lng_parvane_health_pulse_example(tr::now),
		false);
	addFact(
		tr::lng_parvane_health_mood(tr::now),
		mood ? Number(mood->value) : QString(),
		tr::lng_parvane_health_mood_example(tr::now),
		true);
}

void Content::addSleep(not_null<Grid*> grid) {
	const auto &state = _view->state;
	const auto day = _day;
	const auto week = planner::getLastDays(day);
	const auto sleep = planner::getDailyRecord(state, "sleep", day);
	const auto sleeps = planner::getSleepRecords(state, day);
	const auto series = planner::getDailySeries(state, "sleep", week);
	auto known = 0;
	auto sum = 0.;
	for (const auto &value : series) {
		if (value) {
			++known;
			sum += *value;
		}
	}
	const auto &health = state.healthGoals;

	const auto card = grid->add(object_ptr<Card>(grid));
	card->add(MakeHead(
		card->column(),
		tr::lng_parvane_health_sleep(tr::now),
		known ? tr::lng_parvane_health_sleep_average(tr::now, lt_value, FormatSpan(sum / known)) : QString()));
	if (sleep) {
		const auto isShort = sleep->value < planner::kShortSleepMinutes;
		card->add(object_ptr<BigValue>(
			card->column(),
			FormatSpan(sleep->value),
			isShort ? Tone::Red : KindTone(Kind::Sleep),
			QString(),
			false));
		// Сны дня (ночь и дневной): «Изменить» — строка этого сна в поле, сохранение меняет его
		const auto rows = card->add(object_ptr<Ui::VerticalLayout>(card->column()));
		for (const auto &record : sleeps) {
			const auto line = AddTo(rows, object_ptr<Line>(rows, Rem(0.5)), 0);
			const auto timed = record.time && record.endTime;
			line->add(object_ptr<Kit::Label>(
				line,
				timed ? (Q(*record.time) + u" → "_q + Q(*record.endTime)) : QString(QChar(0x2014)),
				Kit::Label::Style{ .px = 14, .mono = true }));
			line->add(object_ptr<Kit::Label>(line, FormatSpan(record.value), Kit::Label::Muted()));
			line->addStretch();
			const auto edit = line->add(object_ptr<PlannerForms::GlyphButton>(
				line,
				u"edit"_q,
				tr::lng_parvane_planner_edit(tr::now)));
			edit->setActive(_editingSleepId == record.id);
			const auto remove = line->add(object_ptr<PlannerForms::GlyphButton>(
				line,
				u"delete"_q,
				tr::lng_parvane_planner_delete(tr::now)));
			const auto id = record.id;
			const auto text = timed
				? (Q(*record.time) + QChar(0x2013) + Q(*record.endTime))
				: tr::lng_parvane_health_sleep_hours(tr::now, lt_hours, Number(record.value / 60., 2));
			edit->setClickedCallback([=] {
				_editingSleepId = id;
				if (_sleepForm) {
					_sleepForm->setButtonText(tr::lng_parvane_planner_save(tr::now));
					_sleepForm->fill(text);
				}
				edit->setActive(true);
			});
			remove->setClickedCallback([=] {
				if (_editingSleepId == id) {
					_editingSleepId = std::string();
				}
				Sections::UpdatePlanner([=](planner::State &state) {
					state.health.erase(
						ranges::remove(state.health, id, &planner::HealthRecord::id),
						end(state.health));
				}, tr::lng_parvane_health_notice_sleep_deleted(tr::now));
			});
			// `.sleepRow`: линия снизу
			const auto rule = AddTo(rows, object_ptr<Ui::RpWidget>(rows), Rem(0.125));
			rule->resize(rule->width(), Px(1));
			rule->paintRequest() | rpl::on_next([=] {
				QPainter(rule).fillRect(rule->rect(), ToneColor(Tone::Line));
			}, rule->lifetime());
		}
	} else {
		const auto line = card->add(object_ptr<Line>(card->column()));
		line->add(object_ptr<Kit::PushButton>(
			line,
			tr::lng_parvane_health_sleep_add(tr::now)))->setClickedCallback([=] {
			example(tr::lng_parvane_health_sleep_example(tr::now));
		});
		line->addStretch();
	}
	// Сон дня экрана: ввод через «+» пишет в сегодняшний день, а режим складывается и из прошлых ночей
	_sleepForm = card->add(object_ptr<TextForm>(
		card->column(),
		tr::lng_parvane_health_sleep_day_placeholder(tr::now),
		_editingSleepId.empty()
			? tr::lng_parvane_health_sleep_add_short(tr::now)
			: tr::lng_parvane_planner_save(tr::now),
		false,
		[=](QString text) {
			const auto view = _view;
			if (!view) {
				return false;
			}
			auto context = planner::QuickContext();
			context.today = day;
			context.nowMinutes = 0;
			context.dayStart = view->state.settings.dayStart;
			context.dayEnd = view->state.settings.dayEnd;
			context.kind = "sleep";
			context.lang = QuickLang();
			const auto draft = planner::parseQuickInput(S(text), context);
			if (draft.error || draft.kind != "sleep") {
				PlannerForms::ShowError(_controller, tr::lng_parvane_health_sleep_day_bad(tr::now));
				return false;
			}
			const auto replaceId = _editingSleepId.empty()
				? std::nullopt
				: std::optional<std::string>(_editingSleepId);
			Sections::UpdatePlanner([=](planner::State &state) {
				planner::applyQuickDraft(state, draft, day, planner::randomUuid, replaceId);
			}, replaceId
				? tr::lng_parvane_health_notice_sleep_updated(tr::now)
				: tr::lng_parvane_planner_notice_added(tr::now, lt_name, tr::lng_parvane_health_sleep(tr::now)));
			_editingSleepId = std::string();
			return true;
		}));
	card->add(makeBars(
		card->column(),
		series,
		[](double value) { return FormatSpan(value); },
		KindTone(Kind::Sleep),
		health.sleepMinutes,
		[](double value) { return value < planner::kShortSleepMinutes; }));
	card->add(SmallText(
		card->column(),
		tr::lng_parvane_health_sleep_short(tr::now, lt_hours, QString::number(planner::kShortSleepMinutes / 60)),
		Tone::Muted,
		14));
	addRoutine(card);
}

QString Content::sleepDetail(const std::string &key) const {
	// «16 окт: 05:40 → 08:40 (3:00), 21:00 → 22:10 (1:10) · всего 4:10»
	const auto &state = _view->state;
	const auto label = FormatDayShort(key);
	auto records = planner::getSleepRecords(state, key);
	if (records.empty()) {
		return tr::lng_parvane_health_routine_detail_none(tr::now, lt_day, label);
	}
	std::stable_sort(records.begin(), records.end(), [](const auto &a, const auto &b) {
		const auto spanA = planner::getSleepSpan(a.time, a.endTime);
		const auto spanB = planner::getSleepSpan(b.time, b.endTime);
		return (spanA ? spanA->from : 0) < (spanB ? spanB->from : 0);
	});
	auto parts = QStringList();
	auto total = 0.;
	for (const auto &record : records) {
		total += record.value;
		parts.push_back(planner::getSleepSpan(record.time, record.endTime)
			? (Q(*record.time) + u" → "_q + Q(*record.endTime) + u" ("_q + FormatSpan(record.value) + ')')
			: tr::lng_parvane_health_routine_detail_untimed(tr::now, lt_value, FormatSpan(record.value)));
	}
	const auto sleepsText = parts.join(u", "_q);
	if (records.size() < 2) {
		return tr::lng_parvane_health_routine_detail(tr::now, lt_day, label, lt_sleeps, sleepsText);
	}
	return tr::lng_parvane_health_routine_detail_total(
		tr::now,
		lt_day,
		label,
		lt_sleeps,
		sleepsText,
		lt_total,
		FormatSpan(total));
}

void Content::addRoutine(not_null<Card*> card) {
	// «Режим сна»: одинаково ли время отхода ко сну и подъёма изо дня в день
	const auto &state = _view->state;
	const auto day = _day;
	const auto routine = planner::getSleepRoutine(state, day);
	const auto &health = state.healthGoals;
	const auto goalBed = planner::getClockGoal(health.bedtime);
	const auto goalWake = planner::getClockGoal(health.wakeTime);
	const auto hasGoal = goalBed && goalWake;
	const auto goalBedText = hasGoal ? Q(planner::toTime(int(*goalBed))) : QString();
	const auto goalWakeText = hasGoal ? Q(planner::toTime(int(*goalWake))) : QString();

	const auto head = card->add(MakeHead(
		card->column(),
		tr::lng_parvane_health_routine(tr::now),
		hasGoal ? GoalLabel(goalBedText + QChar(0x2013) + goalWakeText) : QString(),
		true));
	const auto level = routine.level;
	const auto levelLabel = (level == "stable")
		? tr::lng_parvane_health_routine_stable(tr::now)
		: (level == "drifting")
		? tr::lng_parvane_health_routine_drifting(tr::now)
		: (level == "broken")
		? tr::lng_parvane_health_routine_broken(tr::now)
		: tr::lng_parvane_health_routine_none(tr::now);
	const auto levelTone = (level == "stable")
		? KindTone(Kind::Good)
		: (level == "drifting")
		? KindTone(Kind::Warn)
		: (level == "broken")
		? KindTone(Kind::Due)
		: KindTone(Kind::Muted);
	head->add(object_ptr<Kit::Tag>(head, Kit::Tag::Descriptor{ .text = levelLabel, .tone = levelTone }));

	const auto text = [&](const QString &value) {
		card->add(SmallText(card->column(), value, Tone::Muted, 14));
	};
	if (routine.bed && routine.wake) {
		text(tr::lng_parvane_health_routine_summary(
			tr::now,
			lt_bed,
			Q(planner::toTime(int(planner::wrapClock(RoundToStep(routine.bed->mean))))),
			lt_bed_spread,
			MinutesText(routine.bed->spread),
			lt_wake,
			Q(planner::toTime(int(planner::wrapClock(RoundToStep(routine.wake->mean))))),
			lt_wake_spread,
			MinutesText(routine.wake->spread)));
	} else {
		text(tr::lng_parvane_health_routine_hint(
			tr::now,
			lt_amount,
			QString::number(routine.timedCount),
			lt_min,
			QString::number(planner::kSleepRoutineMinNights)));
	}
	if (hasGoal && routine.bedGoalDeviation && routine.wakeGoalDeviation) {
		const auto toGoal = [](int deviation, const QString &goal) {
			if (std::abs(deviation) < kOnGoalMinutes) {
				return tr::lng_parvane_health_routine_on_goal(tr::now, lt_goal, goal);
			}
			const auto value = PlannerForms::FormatDuration(RoundToStep(std::abs(deviation)));
			return (deviation > 0)
				? tr::lng_parvane_health_routine_later(tr::now, lt_value, value, lt_goal, goal)
				: tr::lng_parvane_health_routine_earlier(tr::now, lt_value, value, lt_goal, goal);
		};
		text(tr::lng_parvane_health_routine_bed_goal(tr::now, lt_value, toGoal(*routine.bedGoalDeviation, goalBedText))
			+ u" · "_q
			+ tr::lng_parvane_health_routine_wake_goal(tr::now, lt_value, toGoal(*routine.wakeGoalDeviation, goalWakeText)));
	}

	// Сны двух недель столбиками на шкале часов
	if (!routine.nights.empty()) {
		const auto selected = (!_pickedSleepDay.empty() && ranges::contains(routine.days, _pickedSleepDay))
			? _pickedSleepDay
			: day;
		auto data = RoutineChart::Data();
		auto marks = std::vector<double>();
		for (const auto &key : routine.days) {
			auto column = RoutineChart::Column();
			column.day = key;
			column.number = QString::number(PlannerForms::DateOf(key).day());
			column.isScreenDay = (key == day);
			const auto records = planner::getSleepRecords(state, key);
			const auto main = planner::getDailyRecord(state, "sleep", key);
			const auto night = ranges::find(routine.nights, key, &planner::SleepNight::day);
			const auto hasNight = (night != end(routine.nights));
			for (const auto &record : records) {
				const auto span = planner::getSleepSpan(record.time, record.endTime);
				if (!span) {
					continue;
				}
				const auto isMain = main && (record.id == main->id);
				auto tone = KindTone(Kind::Sleep);
				if (isMain && hasNight && night->deviation) {
					// Отклонение от среднего: до получаса — обычный, до часа — жёлтый, больше — красный
					if (*night->deviation > planner::kSleepRoutineDriftingSpread) {
						tone = Tone::Red;
					} else if (*night->deviation > planner::kSleepRoutineStableSpread) {
						tone = Tone::Yellow;
					}
				}
				column.bars.push_back({ span->from, span->to, isMain, tone });
				marks.push_back(span->from);
				marks.push_back(span->to);
			}
			column.untimed = hasNight && !night->bed;
			data.columns.push_back(std::move(column));
		}
		if (routine.bed && routine.wake) {
			data.means = { planner::getBedOffset(routine.bed->mean), routine.wake->mean };
		}
		if (hasGoal) {
			data.goals = { planner::getBedOffset(int(*goalBed)), int(*goalWake) };
		}
		for (const auto value : data.means) {
			marks.push_back(value);
		}
		for (const auto value : data.goals) {
			marks.push_back(value);
		}
		data.axis = planner::getSleepAxis(marks);
		data.selected = selected;
		_routineChart = card->add(object_ptr<RoutineChart>(card->column(), std::move(data), [=](std::string key) {
			_pickedSleepDay = key;
			if (_sleepDetail) {
				_sleepDetail->setText(sleepDetail(key));
			}
		}));
		_sleepDetail = card->add(SmallText(card->column(), sleepDetail(selected), Tone::Muted, 14));
	}
	if (!routine.outliers.empty()) {
		auto nights = QStringList();
		for (const auto &night : routine.outliers) {
			nights.push_back(FormatDayShort(night.day)
				+ ' ' + Q(planner::toTime(night.bed.value_or(0)))
				+ u" → "_q + Q(planner::toTime(night.wake.value_or(0))));
		}
		text(tr::lng_parvane_health_routine_outliers(tr::now, lt_nights, nights.join(u", "_q)));
	}
	// Сдвиг выходных меньше получаса — не повод для строки
	if (routine.socialJetlag && std::abs(*routine.socialJetlag) >= planner::kSleepRoutineStableSpread) {
		const auto value = PlannerForms::FormatDuration(RoundToStep(std::abs(*routine.socialJetlag)));
		text((*routine.socialJetlag > 0)
			? tr::lng_parvane_health_routine_jetlag_later(tr::now, lt_value, value)
			: tr::lng_parvane_health_routine_jetlag_earlier(tr::now, lt_value, value));
	}
	if (routine.untimedCount) {
		text(tr::lng_parvane_health_routine_untimed(tr::now, lt_amount, QString::number(routine.untimedCount)));
	}
	if (!routine.nights.empty()) {
		card->add(SmallText(card->column(), tr::lng_parvane_health_routine_legend(tr::now)));
	}
	if (!hasGoal) {
		const auto chips = card->add(object_ptr<Kit::Flow>(card->column()));
		chips->add(object_ptr<Kit::Label>(
			chips,
			tr::lng_parvane_health_routine_goal_hint(tr::now),
			Kit::Label::Style{ .px = 14, .tone = Tone::Muted }));
		chips->add(object_ptr<Kit::Chip>(chips, Kit::Chip::Descriptor{
			.text = tr::lng_parvane_health_routine_goal_example(tr::now),
		}))->setClickedCallback([=] {
			example(tr::lng_parvane_health_routine_goal_example(tr::now));
		});
	}
}

void Content::addActivity(not_null<Grid*> grid) {
	const auto &state = _view->state;
	const auto day = _day;
	const auto week = planner::getLastDays(day);
	const auto &health = state.healthGoals;
	const auto steps = planner::getDailyRecord(state, "steps", day);
	const auto stepsValue = steps ? steps->value : 0.;
	const auto workouts = planner::getWorkouts(state, week);
	const auto active = planner::sumActiveMinutes(workouts);

	const auto card = grid->add(object_ptr<Card>(grid));
	const auto head = card->add(MakeHead(card->column(), tr::lng_parvane_health_activity(tr::now)));
	head->add(object_ptr<Kit::PushButton>(
		head,
		tr::lng_parvane_health_workout(tr::now),
		Kit::PushButton::Kind::Ghost,
		u"plus"_q))->setClickedCallback([=] {
		example(tr::lng_parvane_health_workout_example(tr::now));
	});
	const auto has = [](const std::optional<double> &value) {
		return value && *value;
	};
	card->add(object_ptr<ProgressRow>(
		card->column(),
		tr::lng_parvane_health_steps(tr::now),
		Number(stepsValue),
		has(health.steps) ? (u" / "_q + Number(*health.steps)) : QString(),
		Share(stepsValue, health.steps),
		KindTone(Kind::Workout)));
	card->add(object_ptr<ProgressRow>(
		card->column(),
		tr::lng_parvane_health_active_minutes(tr::now),
		Number(active),
		has(health.activeMinutes)
			? (u" / "_q + tr::lng_parvane_health_minutes(tr::now, lt_value, Number(*health.activeMinutes)))
			: (' ' + tr::lng_parvane_health_minutes_unit(tr::now)),
		Share(active, health.activeMinutes),
		KindTone(Kind::Food)));
	card->add(object_ptr<ProgressRow>(
		card->column(),
		tr::lng_parvane_health_workouts(tr::now),
		QString::number(workouts.size()),
		has(health.workouts) ? (u" / "_q + Number(*health.workouts)) : QString(),
		Share(double(workouts.size()), health.workouts),
		KindTone(Kind::Event)));
	card->add(makeBars(
		card->column(),
		planner::getDailySeries(state, "steps", week),
		[](double value) {
			return (value >= 1000.) ? (Number(value / 1000., 1) + 'k') : QString::number(int(std::round(value)));
		},
		KindTone(Kind::Workout),
		health.steps));
	const auto list = card->add(object_ptr<Ui::VerticalLayout>(card->column()));
	if (workouts.empty()) {
		AddTo(list, SmallText(list, tr::lng_parvane_health_no_workouts(tr::now), Tone::Muted, Kit::kBodyPx), 0);
	}
	for (const auto &record : workouts) {
		auto details = QStringList();
		if (record.value) {
			details.push_back(PlannerForms::FormatDuration(int(std::round(record.value))));
		}
		if (record.value2 && *record.value2) {
			details.push_back(tr::lng_parvane_health_km(tr::now, lt_value, Number(*record.value2, 1)));
		}
		if (const auto pace = planner::formatPace(record.value, record.value2.value_or(0.))) {
			details.push_back(tr::lng_parvane_health_pace(tr::now, lt_value, Q(*pace)));
		}
		if (record.exercises && !record.exercises->empty()) {
			auto exercises = QStringList();
			for (const auto &exercise : *record.exercises) {
				auto numbers = QStringList();
				for (const auto &part : { exercise.sets, exercise.reps, exercise.weight }) {
					if (part && *part) {
						numbers.push_back(Number(*part, 3));
					}
				}
				exercises.push_back(Q(exercise.name) + ' ' + numbers.join(QChar(0x00D7)));
			}
			details.push_back(exercises.join(u", "_q));
		}
		const auto id = record.id;
		AddTo(list, object_ptr<EntryRow>(list, EntryRow::Descriptor{
			.icon = u"sport"_q,
			.iconTone = KindTone(Kind::Workout),
			.title = Q(record.name.value_or(std::string())),
			.subtitle = details.join(u" · "_q),
			.meta = FormatDayShort(record.day),
			.deleteName = tr::lng_parvane_health_delete(tr::now, lt_name, Q(record.name.value_or(std::string()))),
		}, [=] {
			Sections::UpdatePlanner([=](planner::State &state) {
				state.health.erase(ranges::remove(state.health, id, &planner::HealthRecord::id), end(state.health));
			}, tr::lng_parvane_health_notice_deleted(tr::now));
		}), 0);
	}
	card->add(SmallText(card->column(), tr::lng_parvane_health_activity_hint(tr::now), Tone::Muted, 14));
}

void Content::addKcalWeek(not_null<Grid*> grid) {
	const auto &state = _view->state;
	const auto week = planner::getLastDays(_day);
	auto values = std::vector<std::optional<double>>();
	auto known = 0;
	auto sum = 0.;
	for (const auto &key : week) {
		const auto value = std::round(planner::getNutrientTotal(state, key, "kcal").value);
		if (value) {
			values.push_back(value);
			++known;
			sum += value;
		} else {
			values.push_back(std::nullopt);
		}
	}
	const auto goals = planner::getGoalsForDay(state, _day, _today);
	const auto i = goals.find("kcal");
	const auto goal = (i != goals.end() && i->second.target) ? std::optional<double>(i->second.target) : std::nullopt;
	const auto card = grid->add(object_ptr<Card>(grid));
	card->add(MakeHead(
		card->column(),
		tr::lng_parvane_health_kcal_week(tr::now),
		known ? tr::lng_parvane_health_sleep_average(tr::now, lt_value, Number(sum / known)) : QString()));
	card->add(makeBars(
		card->column(),
		std::move(values),
		[](double value) { return Number(value); },
		KindTone(Kind::Food),
		goal));
}

// Экран раздела: остров с шапкой (`.hdr`: «Здоровье», настройки, «+ Запись») и прокруткой содержимого
class Screen final : public Ui::RpWidget {
public:
	Screen(QWidget *parent, not_null<Window::SessionController*> controller)
	: RpWidget(parent) {
		_island = Ui::CreateChild<Kit::Island>(this, Rem(1.125));
		_header = Ui::CreateChild<Kit::Header>(_island, tr::lng_parvane_health_title(tr::now));
		_header->addStretch();
		_header->add(object_ptr<Kit::IconButton>(
			_header,
			u"sliders"_q,
			tr::lng_parvane_health_settings(tr::now)))->setClickedCallback([=] {
			OpenGoals(controller);
		});
		_header->add(object_ptr<Kit::Pill>(
			_header,
			tr::lng_parvane_health_add_entry(tr::now),
			QString(),
			true))->setClickedCallback([=] {
			OpenQuickEntry(controller, QString());
		});
		_scroll = Ui::CreateChild<Ui::ScrollArea>(_island);
		_content = _scroll->setOwnedWidget(object_ptr<Content>(_scroll, controller)).data();
		// web: «Здоровье» — вид «Плана», пока нет ни данных, ни сохранённой копии — `<Loading />`
		_loading = Ui::CreateChild<Mascot>(_island);
		Sections::PlannerValue() | rpl::on_next([=](std::shared_ptr<const Sections::PlannerView> view) {
			const auto hasContent = view && (view->isLoaded || view->isCached);
			_scroll->setVisible(hasContent);
			_loading->setVisible(!hasContent);
		}, lifetime());
		sizeValue() | rpl::on_next([=](QSize size) {
			// `.root`: отступы 0.5rem сверху, справа и снизу
			const auto margin = Rem(0.5);
			_island->setGeometry(0, margin, std::max(size.width() - margin, 0), std::max(size.height() - 2 * margin, 0));
			const auto inner = _island->innerRect();
			_header->resizeToWidth(inner.width());
			_header->move(inner.topLeft());
			_scroll->setGeometry(
				inner.x(),
				inner.y() + _header->height(),
				inner.width(),
				std::max(inner.height() - _header->height(), 0));
			_content->resizeToWidth(inner.width());
			_loading->setGeometry(_scroll->geometry());
		}, lifetime());
	}

private:
	Kit::Island *_island = nullptr;
	Kit::Header *_header = nullptr;
	Ui::ScrollArea *_scroll = nullptr;
	Content *_content = nullptr;
	Mascot *_loading = nullptr;

};

} // namespace

void OpenQuickEntry(not_null<Window::SessionController*> controller, const QString &text) {
	// Полное окно ввода текстом «Плана» (словарь правок, история, подсказки) — общее с видами
	PlannerViews::OpenQuickInput(SheetParent(controller), PlannerViews::QuickArgs{
		.initialText = text,
		.today = QDate::currentDate().toString(Qt::ISODate).toStdString(),
		.created = nullptr,
		.more = [=] { PlannerUi::OpenTaskEditor(controller, std::string(), std::string()); },
	});
}

void OpenGoals(not_null<Window::SessionController*> controller) {
	const auto sheet = Kit::Sheet::Show(SheetParent(controller), Kit::Sheet::Descriptor{
		.title = tr::lng_parvane_health_settings(tr::now),
		.closeName = tr::lng_parvane_planner_close(tr::now),
	});
	sheet->add(object_ptr<GoalsCard>(sheet->content(), controller));
}

} // namespace Parvane::Health

namespace Parvane {

void RegisterPlannerHealth() {
	RegisterSectionFactory(Section::Health, [](
			not_null<QWidget*> parent,
			not_null<Window::SessionController*> controller,
			Section section) {
		return object_ptr<Ui::RpWidget>(object_ptr<Health::Screen>(parent.get(), controller));
	});
}

} // namespace Parvane
