// Parvane fork: реализация parvane_planner_quick.h. Размеры — из web Planner.module.scss (`.quick*`, `.chip*`,
// `.tag*`, `.hscroll`), в комментариях — rem.
#include "parvane/parvane_planner_quick.h"

#include "parvane/parvane_planner_day.h"

#include "lang/lang_keys.h"
#include "base/event_filter.h"
#include "base/unique_qptr.h"
#include "ui/painter.h"
#include "ui/wrap/vertical_layout.h"
#include "ui/widgets/fields/input_field.h"

#include <parvane/sections/planner_health.h>
#include <parvane/sections/planner_quick.h>
#include <parvane/sections/planner_quick_apply.h>
#include <parvane/sections/planner_quick_learn.h>
#include <parvane/sections/planner_quick_suggest.h>

#include <crl/crl.h>

#include <QtCore/QPointer>
#include <QtCore/QRegularExpression>
#include <QtGui/QtEvents>
#include <QtWidgets/QToolTip>

namespace Parvane {
[[nodiscard]] bool IsRussianUi(); // parvane_client.cpp
} // namespace Parvane

namespace Parvane::PlannerViews {
namespace {

constexpr auto kNameMaxLength = 160;
constexpr auto kInputMaxLength = 300;
constexpr auto kMinutesInDayFull = 1440;

const std::vector<std::string> kChoices = { "auto", "event", "task", "food", "sleep", "workout" };

QString ChoiceLabel(const std::string &choice) {
	if (choice == "event") {
		return tr::lng_parvane_planner_kind_event(tr::now);
	} else if (choice == "task") {
		return tr::lng_parvane_planner_kind_task(tr::now);
	} else if (choice == "food") {
		return tr::lng_parvane_planner_kind_food(tr::now);
	} else if (choice == "sleep") {
		return tr::lng_parvane_planner_kind_sleep(tr::now);
	} else if (choice == "workout") {
		return tr::lng_parvane_planner_kind_workout(tr::now);
	}
	return tr::lng_parvane_planner_quick_auto(tr::now);
}

QString DraftKindLabel(const std::string &kind) {
	if (kind == "water") {
		return tr::lng_parvane_planner_health_water(tr::now);
	} else if (kind == "metric") {
		return tr::lng_parvane_planner_health_body(tr::now);
	} else if (kind == "goal") {
		return tr::lng_parvane_planner_health_goals(tr::now);
	}
	return ChoiceLabel(kind);
}

Kind DraftKind(const std::string &kind) {
	if (kind == "event") {
		return Kind::Event;
	} else if (kind == "task") {
		return Kind::Task;
	} else if (kind == "food" || kind == "water") {
		return Kind::Food;
	} else if (kind == "sleep") {
		return Kind::Sleep;
	} else if (kind == "workout") {
		return Kind::Workout;
	} else if (kind == "metric") {
		return Kind::Metric;
	}
	return Kind::Muted;
}

QString DraftKindIcon(const std::string &kind) {
	if (kind == "event") {
		return u"calendar"_q;
	} else if (kind == "task") {
		return u"check"_q;
	} else if (kind == "food" || kind == "water") {
		return u"eats"_q;
	} else if (kind == "sleep") {
		return u"darkmode"_q;
	} else if (kind == "workout") {
		return u"sport"_q;
	} else if (kind == "metric") {
		return u"heart-outline"_q;
	}
	return u"settings"_q;
}

QString MetricLabel(const std::string &metric) {
	if (metric == "weight") {
		return tr::lng_parvane_planner_health_weight(tr::now);
	} else if (metric == "pressure") {
		return tr::lng_parvane_planner_health_pressure(tr::now);
	} else if (metric == "pulse") {
		return tr::lng_parvane_planner_health_pulse(tr::now);
	} else if (metric == "steps") {
		return tr::lng_parvane_planner_health_steps_short(tr::now);
	}
	return tr::lng_parvane_planner_health_mood(tr::now);
}

// Какие виды строк подсказывать при выбранном виде окна (пусто — все)
std::optional<std::vector<std::string>> ChoiceKinds(const std::string &choice) {
	if (choice == "task" || choice == "event" || choice == "sleep" || choice == "workout") {
		return std::vector<std::string>{ choice };
	} else if (choice == "food") {
		return std::vector<std::string>{ "food", "water" };
	}
	return std::nullopt;
}

// Виды, которые в переключателе стоят под одной кнопкой
std::string ChoiceOf(const std::string &kind) {
	if (kind == "water") {
		return "food";
	} else if (kind == "metric" || kind == "goal") {
		return "auto";
	}
	return kind;
}

QString ErrorText(const std::string &error) {
	if (error == "name") {
		return tr::lng_parvane_planner_error_name(tr::now);
	} else if (error == "minutes") {
		return tr::lng_parvane_planner_error_minutes(tr::now);
	} else if (error == "startNeedsDayAndMinutes") {
		return tr::lng_parvane_planner_error_start_needs(tr::now);
	} else if (error == "pastMidnight") {
		return tr::lng_parvane_planner_error_past_midnight(tr::now);
	} else if (error == "dayAfterDue") {
		return tr::lng_parvane_planner_error_day_after_due(tr::now);
	} else if (error == "time") {
		return tr::lng_parvane_planner_error_event_time(tr::now);
	} else if (error == "repeat") {
		return tr::lng_parvane_planner_error_event_repeat(tr::now);
	} else if (error == "interval") {
		return tr::lng_parvane_planner_error_repeat_interval(tr::now);
	} else if (error == "weekdays") {
		return tr::lng_parvane_planner_error_repeat_weekdays(tr::now);
	} else if (error == "monthDay") {
		return tr::lng_parvane_planner_error_repeat_month_day(tr::now);
	} else if (error == "startDay") {
		return tr::lng_parvane_planner_error_repeat_start(tr::now);
	} else if (error == "endDay") {
		return tr::lng_parvane_planner_error_repeat_end(tr::now);
	} else if (error == "count") {
		return tr::lng_parvane_planner_error_repeat_count(tr::now);
	}
	return QString();
}

QString Number(double value) {
	return FormatNumber(value, 3);
}

struct Chip {
	std::string field;
	QString text;
	bool isFixed = false;
	bool isLearned = false;
};

bool HasSpan(const planner::QuickDraft &draft, const std::string &field) {
	return std::any_of(draft.spans.begin(), draft.spans.end(), [&](const planner::QuickSpan &span) {
		return span.field == field;
	});
}

bool Learned(const planner::QuickDraft &draft, const std::string &what) {
	return draft.learned && std::find(draft.learned->begin(), draft.learned->end(), what) != draft.learned->end();
}

// Чипы распознанного (web buildChips)
std::vector<Chip> BuildChips(const planner::QuickDraft &draft) {
	auto chips = std::vector<Chip>();
	const auto fixed = [&](const std::string &field, const QString &text) {
		chips.push_back({ field, text, true });
	};
	if (draft.kind == "goal" && draft.goalChanges) {
		const auto &changes = *draft.goalChanges;
		for (const auto &[metric, value] : changes.goals) {
			fixed("health", Q(metric) + u" → "_q + Number(value));
		}
		const auto health = nlohmann::json(changes.health);
		for (auto i = health.begin(); i != health.end(); ++i) {
			if (!i->is_number()) {
				continue;
			}
			const auto value = i->get<double>();
			// Цель режима сна — минуты от полуночи: показываются временем
			const auto isTime = (i.key() == "bedtime" || i.key() == "wakeTime");
			fixed("health", Q(i.key()) + u" → "_q + (isTime ? Q(planner::toTime(int(value))) : Number(value)));
		}
		if (changes.dayStart && changes.dayEnd) {
			fixed("time", Q(planner::toTime(int(*changes.dayStart))) + QChar(0x2013) + Q(planner::toTime(int(*changes.dayEnd))));
		}
		if (changes.budget && *changes.budget) {
			fixed("minutes", FormatDuration(int(*changes.budget)));
		}
		return chips;
	}
	if (draft.kind == "metric") {
		if (draft.value) {
			fixed("health", (draft.value2 && *draft.value2)
				? (Number(*draft.value) + u'/' + Number(*draft.value2))
				: Number(*draft.value));
		}
		return chips;
	}
	if (draft.kind == "water") {
		if (draft.waterMl && *draft.waterMl) {
			fixed("water", tr::lng_parvane_planner_health_ml(tr::now, lt_value, Number(*draft.waterMl)));
		}
		return chips;
	}
	if (draft.kind == "sleep") {
		if (draft.start && draft.end) {
			fixed("time", Q(*draft.start) + QChar(0x2013) + Q(*draft.end));
		}
		if (draft.minutes && *draft.minutes) {
			fixed("minutes", FormatSpan(*draft.minutes));
		}
		return chips;
	}
	if (draft.repeat) {
		chips.push_back({ "repeat", FormatRepeat(*draft.repeat) });
	} else if (draft.day) {
		chips.push_back({ "day", FormatDay(*draft.day), draft.isDayAssumed.value_or(false) || !HasSpan(draft, "day") });
	}
	if (draft.kind == "food") {
		const auto nutrients = draft.nutrients.value_or(std::map<std::string, double>());
		const auto get = [&](const char *key) -> std::optional<double> {
			const auto i = nutrients.find(key);
			return (i != nutrients.end()) ? std::optional<double>(i->second) : std::nullopt;
		};
		if (draft.meal) {
			fixed("meal", FormatMeal(*draft.meal));
		}
		if (const auto kcal = get("kcal")) {
			fixed("kcal", tr::lng_parvane_planner_health_kcal(tr::now, lt_value, Number(*kcal)));
		}
		if (get("protein") || get("fat") || get("carbs")) {
			fixed("protein", tr::lng_parvane_planner_health_macros(
				tr::now,
				lt_protein,
				Number(get("protein").value_or(0)),
				lt_fat,
				Number(get("fat").value_or(0)),
				lt_carbs,
				Number(get("carbs").value_or(0))));
		}
		if (const auto fiber = get("fiber")) {
			fixed("fiber", tr::lng_parvane_planner_health_fiber_short(tr::now, lt_value, Number(*fiber)));
		}
		if (draft.grams && *draft.grams) {
			fixed("grams", tr::lng_parvane_planner_health_grams(tr::now, lt_value, Number(*draft.grams)));
		}
		return chips;
	}
	if (draft.kind == "workout") {
		if (draft.start) {
			fixed("time", Q(*draft.start));
		}
		if (draft.minutes && *draft.minutes) {
			fixed("minutes", FormatDuration(int(*draft.minutes)));
		}
		if (draft.distanceKm && *draft.distanceKm) {
			auto text = tr::lng_parvane_planner_health_km(tr::now, lt_value, Number(*draft.distanceKm));
			if (const auto pace = planner::formatPace(draft.minutes.value_or(0), *draft.distanceKm)) {
				text += u" · "_q + tr::lng_parvane_planner_health_pace(tr::now, lt_value, Q(*pace));
			}
			fixed("health", text);
		}
		if (draft.exercises) {
			fixed("grams", tr::lng_parvane_planner_quick_workout_sets(
				tr::now,
				lt_amount,
				QString::number(draft.exercises->size())));
		}
		return chips;
	}
	if (draft.isAllDay.value_or(false)) {
		chips.push_back({ "time", tr::lng_parvane_planner_all_day_short(tr::now), true });
	} else if (draft.start) {
		chips.push_back({ "time", draft.end ? (Q(*draft.start) + QChar(0x2013) + Q(*draft.end)) : Q(*draft.start) });
	}
	if (draft.minutes && *draft.minutes && (draft.kind == "task" || !draft.end)) {
		chips.push_back({ "minutes", FormatDuration(int(*draft.minutes)), !HasSpan(draft, "minutes") });
	}
	// Длительность из словаря правок — своим чипом: его снятие возвращает обычную
	if (Learned(draft, "minutes") && draft.start && draft.end) {
		chips.push_back({
			"minutes",
			FormatDuration(planner::toMinutes(*draft.end) - planner::toMinutes(*draft.start)),
			false,
			true,
		});
	}
	if (draft.due) {
		chips.push_back({ "due", tr::lng_parvane_planner_quick_due(tr::now, lt_date, FormatDay(*draft.due)) });
	}
	if (draft.list) {
		chips.push_back({ "list", u"#"_q + Q(*draft.list) });
	}
	if (draft.place) {
		chips.push_back({ "place", u"@"_q + Q(*draft.place) });
	}
	if (draft.isImportant.value_or(false)) {
		chips.push_back({ "important", u"! "_q + tr::lng_parvane_planner_status_active(tr::now) });
	}
	if (draft.remind) {
		chips.push_back({ "remind", FormatRemind(int(*draft.remind)) });
	}
	return chips;
}

// Подпись другого чтения — так же, как его показал бы чип
QString FormatAlt(const planner::QuickDraft &draft, const planner::QuickAlt &alt) {
	if (alt.field == "kind") {
		return DraftKindLabel(alt.pick);
	} else if (alt.field == "time") {
		auto text = Q(alt.pick);
		text.replace(u'-', QChar(0x2013));
		return text;
	} else if (alt.field == "day") {
		return FormatDay(alt.pick);
	} else if (alt.field == "due") {
		return tr::lng_parvane_planner_quick_due(tr::now, lt_date, FormatDay(alt.pick));
	}
	if (draft.repeat) {
		auto repeat = *draft.repeat;
		repeat.endDay = (alt.pick == planner::kQuickRepeatEnd) ? alt.day : std::nullopt;
		return FormatRepeat(repeat);
	}
	return Q(alt.pick);
}

// Пример с экрана «Здоровье» («бег 5 км 30 мин»): вид окна и подсказки только этого вида
struct ExampleFilter {
	std::string choice;
	std::vector<std::string> kinds;
	std::optional<std::string> lead;
};

std::optional<ExampleFilter> ExampleFilterOf(const QString &text, const std::string &today, const std::string &lang) {
	auto ctx = planner::QuickContext();
	ctx.today = today;
	ctx.nowMinutes = 0;
	ctx.dayStart = 0;
	ctx.dayEnd = kMinutesInDayFull;
	ctx.lang = lang;
	const auto draft = planner::parseQuickInput(S(text), ctx);
	if (draft.error) {
		return std::nullopt;
	}
	auto choice = std::string();
	if (draft.kind == "food" || draft.kind == "water") {
		choice = "food";
	} else if (draft.kind == "sleep" || draft.kind == "workout") {
		choice = draft.kind;
	} else if (draft.kind == "metric") {
		choice = "auto";
	} else {
		return std::nullopt;
	}
	auto result = ExampleFilter{ choice, { draft.kind } };
	if (draft.kind == "metric" || draft.kind == "water") {
		const auto words = text.trimmed().split(QRegularExpression(u"\\s+"_q), Qt::SkipEmptyParts);
		if (!words.isEmpty()) {
			result.lead = S(words.front().toLower());
		}
	}
	return result;
}

// Крестик, нарисованный холстом (`.tagRemove`): невидимая кнопка над ним даёт фокус с клавиатуры, кольцо фокуса и
// подпись для чтения с экрана (`aria-label`). Мышь проходит сквозь неё к холсту — наведение рисует холст
class HitButton final : public Kit::Button {
public:
	explicit HitButton(QWidget *parent) : Button(parent) {
		setAttribute(Qt::WA_TransparentForMouseEvents);
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		paintFocusRing(p, QRectF(rect()), height() / 2.);
	}

};

// Тело окна под полем ввода: распознанное, вид записи, подсказки, кнопки
class QuickBody final : public Canvas {
public:
	QuickBody(QWidget *parent, QuickArgs args, Kit::Field *field, Fn<void()> close);

	void submit();
	bool acceptTab();

protected:
	int draw(QPainter *p, int width) override;
	int resizeGetHeight(int newWidth) override;
	bool eventHook(QEvent *e) override;

private:
	// Подсказка при наведении (`title`)
	struct Hint {
		QRect rect;
		QString text;
	};
	// Действие крестика: подпись для чтения с экрана и нажатие
	struct Action {
		QRect rect;
		QString name;
		Fn<void()> click;
	};

	void hint(QRect rect, const QString &text);
	void action(QRect rect, const QString &name, Fn<void()> click);
	void syncActions();
	void runAction(int index);

	[[nodiscard]] planner::QuickContext baseContext() const;
	[[nodiscard]] planner::QuickDraft parse(const QString &value) const;
	void reparse();
	void buildCandidates();
	[[nodiscard]] std::vector<planner::QuickSuggestion> suggestions() const;
	void fill(const QString &value);
	void skipField(const std::string &field);
	void chooseAlt(const planner::QuickAlt &alt);
	void forget(const std::string &line);

	const QuickArgs _args;
	Kit::Field * const _field;
	const Fn<void()> _close;
	ViewPtr _view;
	std::string _lang;
	planner::QuickLearned _learned;
	QString _text;
	std::string _choice = "auto";
	std::vector<std::string> _skip;
	planner::QuickPick _pick;
	std::optional<std::string> _altField;
	std::optional<ExampleFilter> _example;
	planner::QuickDraft _draft;
	std::optional<std::vector<planner::QuickCandidate>> _candidates;
	std::vector<Hint> _hints;
	std::vector<Action> _actions;
	std::vector<base::unique_qptr<HitButton>> _buttons;

};

QuickBody::QuickBody(QWidget *parent, QuickArgs args, Kit::Field *field, Fn<void()> close)
: Canvas(parent)
, _args(std::move(args))
, _field(field)
, _close(std::move(close))
, _view(Sections::Planner())
, _lang(planner::getQuickLang(IsRussianUi() ? std::string("ru") : std::string("en"))) {
	// Словарь правок читается в момент открытия окна
	if (_view) {
		_learned = planner::learnedDefaults(planner::learnStoreFromWords(_view->state.learned));
	}
	// Начало строки («задача сегодня ») — в поле; готовый пример вида — подсказкой, поле пустое
	const auto &initial = _args.initialText;
	const auto isExample = !initial.isEmpty() && !initial.endsWith(u' ');
	_example = isExample ? ExampleFilterOf(initial, _args.today, _lang) : std::nullopt;
	if (_example) {
		_choice = _example->choice;
	} else {
		_text = initial;
		_field->setText(initial);
	}
	_field->textChanges() | rpl::on_next([=](QString text) {
		_text = text;
		// Правка строки возвращает снятые значения и выбранные чтения: слова могли измениться
		_skip.clear();
		_pick = planner::QuickPick();
		_altField.reset();
		reparse();
	}, lifetime());
	_field->submits() | rpl::on_next([=] { submit(); }, lifetime());
	reparse();
	buildCandidates();
}

void QuickBody::hint(QRect rect, const QString &text) {
	_hints.push_back({ rect, text });
}

void QuickBody::action(QRect rect, const QString &name, Fn<void()> click) {
	_actions.push_back({ rect, name, std::move(click) });
	// Подсказка крестика — та же подпись (`title`)
	hint(rect, name);
}

int QuickBody::resizeGetHeight(int newWidth) {
	const auto result = Canvas::resizeGetHeight(newWidth);
	syncActions();
	return result;
}

// Кнопки над крестиками — по раскладке последнего замера; лишние прячутся, а не удаляются: в фокусе может быть
// только что нажатая
void QuickBody::syncActions() {
	while (_buttons.size() < _actions.size()) {
		const auto index = int(_buttons.size());
		auto button = base::make_unique_q<HitButton>(this);
		button->setClickedCallback([=] { runAction(index); });
		_buttons.push_back(std::move(button));
	}
	for (auto i = 0; i != int(_buttons.size()); ++i) {
		const auto &button = _buttons[i];
		if (i < int(_actions.size())) {
			button->setGeometry(_actions[i].rect);
			button->setAccessibleName(_actions[i].name);
			button->show();
		} else {
			button->hide();
		}
	}
}

void QuickBody::runAction(int index) {
	if (index < 0 || index >= int(_actions.size())) {
		return;
	}
	// Нажатие перестраивает список действий — вызывается копия
	const auto click = _actions[index].click;
	if (click) {
		click();
	}
}

bool QuickBody::eventHook(QEvent *e) {
	if (e->type() == QEvent::ToolTip) {
		const auto help = static_cast<QHelpEvent*>(e);
		// Последняя добавленная — верхняя: крестик поверх чипа
		for (auto i = int(_hints.size()) - 1; i >= 0; --i) {
			if (_hints[i].rect.contains(help->pos())) {
				QToolTip::showText(help->globalPos(), _hints[i].text, this, _hints[i].rect);
				return true;
			}
		}
		QToolTip::hideText();
		e->ignore();
		return true;
	}
	return Canvas::eventHook(e);
}

planner::QuickContext QuickBody::baseContext() const {
	auto ctx = planner::QuickContext();
	ctx.today = _args.today;
	ctx.nowMinutes = NowMinutes();
	const auto settings = _view ? _view->state.settings : planner::Settings();
	ctx.dayStart = settings.dayStart;
	ctx.dayEnd = settings.dayEnd;
	ctx.lang = _lang;
	return ctx;
}

planner::QuickDraft QuickBody::parse(const QString &value) const {
	auto ctx = baseContext();
	if (_choice != "auto") {
		ctx.kind = _choice;
	}
	ctx.skip = _skip;
	ctx.pick = _pick;
	ctx.learned = _learned;
	return planner::parseQuickInput(S(value), ctx);
}

void QuickBody::reparse() {
	_draft = parse(_text);
	refresh();
}

void QuickBody::buildCandidates() {
	if (!_view) {
		return;
	}
	// Кандидаты собираются при открытии окна (каждая строка проходит разбор) — вне главного потока
	auto sources = planner::QuickSuggestSources();
	sources.history = planner::historyFromLines(_view->state.quickLines);
	sources.tasks = _view->state.tasks;
	sources.events = _view->state.events;
	for (const auto &example : tr::lng_parvane_planner_quick_examples(tr::now).split(u'|')) {
		const auto trimmed = example.trimmed();
		if (!trimmed.isEmpty()) {
			sources.examples.push_back(S(trimmed));
		}
	}
	auto ctx = baseContext();
	ctx.learned = _learned;
	const auto weak = QPointer<QuickBody>(this);
	crl::async([=, sources = std::move(sources)] {
		auto result = planner::buildCandidates(sources, ctx);
		crl::on_main([=, result = std::move(result)]() mutable {
			if (weak) {
				weak->_candidates = std::move(result);
				weak->refresh();
			}
		});
	});
}

std::vector<planner::QuickSuggestion> QuickBody::suggestions() const {
	if (!_candidates) {
		return {};
	}
	// Пример показателя сужает подсказки до него, пока вид окна не сменён вручную
	const auto filter = (_example && _example->choice == _choice) ? _example : std::nullopt;
	auto pool = std::vector<planner::QuickCandidate>();
	if (filter && filter->lead) {
		for (const auto &candidate : *_candidates) {
			if (candidate.line.rfind(*filter->lead, 0) == 0) {
				pool.push_back(candidate);
			}
		}
	} else {
		pool = *_candidates;
	}
	return planner::filterSuggestions(S(_text), pool, planner::kMaxSuggestions,
		filter ? std::optional<std::vector<std::string>>(filter->kinds) : ChoiceKinds(_choice));
}

void QuickBody::fill(const QString &value) {
	_field->setText(value);
	_text = value;
	_skip.clear();
	_pick = planner::QuickPick();
	_altField.reset();
	_field->setFocusFast();
	_field->input()->setCursorPosition(value.size());
	reparse();
}

void QuickBody::skipField(const std::string &field) {
	_skip.push_back(field);
	_altField.reset();
	_field->setFocusFast();
	reparse();
}

void QuickBody::chooseAlt(const planner::QuickAlt &alt) {
	if (alt.field == "kind") {
		_choice = alt.pick;
	} else if (alt.field == "repeat" && alt.pick == planner::kQuickRepeatEnd) {
		_pick.repeat.reset();
	} else if (alt.field == "time") {
		_pick.time = alt.pick;
	} else if (alt.field == "day") {
		_pick.day = alt.pick;
	} else if (alt.field == "due") {
		_pick.due = alt.pick;
	} else if (alt.field == "repeat") {
		_pick.repeat = alt.pick;
	}
	_altField.reset();
	_field->setFocusFast();
	reparse();
}

void QuickBody::forget(const std::string &line) {
	if (!_candidates) {
		return;
	}
	const auto i = std::find_if(_candidates->begin(), _candidates->end(), [&](const planner::QuickCandidate &c) {
		return c.text == line;
	});
	if (i == _candidates->end()) {
		return;
	}
	const auto key = i->key;
	const auto texts = i->texts;
	// Забытое уходит со всех устройств
	Sections::UpdatePlanner([key, texts](planner::State &state) {
		state.quickLines = planner::forgetQuickLine(state.quickLines, key, texts);
	});
	_candidates->erase(i);
	_field->setFocusFast();
	refresh();
}

bool QuickBody::acceptTab() {
	// Tab дописывает строку до первой подсказки, когда набрано её начало
	const auto list = suggestions();
	if (list.empty() || !planner::isSuggestionPrefix(S(_field->text()), list.front().text)) {
		return false;
	}
	fill(Q(list.front().text));
	return true;
}

void QuickBody::submit() {
	const auto value = _field->text();
	const auto entry = parse(value);
	if (value.trimmed().isEmpty() || entry.error || Q(entry.name).size() > kNameMaxLength) {
		return;
	}
	// Правка угаданного типа либо длительности запоминается за первым словом названия
	const auto autoDraft = planner::parseQuickInput(S(value), baseContext());
	const auto historyKey = planner::lineKey(S(value), entry, _lang);
	const auto today = _args.today;
	const auto typed = S(value);
	// Запись, словарь правок и строка истории — одной правкой «Плана»: одна операция, одна отмена
	Sections::UpdatePlanner([=](planner::State &state) {
		planner::applyQuickDraft(state, entry, today, planner::randomUuid);
		if (const auto words = planner::correctWords(state.learned, autoDraft, entry)) {
			state.learned = *words;
		}
		state.quickLines = planner::recordQuickLine(state.quickLines, typed, historyKey);
	}, (entry.kind == "goal")
		? tr::lng_parvane_planner_notice_goals_saved(tr::now)
		: tr::lng_parvane_planner_notice_added(
			tr::now,
			lt_name,
			entry.name.empty() ? value.trimmed() : Q(entry.name)));
	const auto created = _args.created;
	const auto day = entry.day.value_or(std::string());
	const auto close = _close;
	close();
	if (created) {
		created(day);
	}
}

int QuickBody::draw(QPainter *p, int width) {
	const auto &draft = _draft;
	const auto hasText = !_text.trimmed().isEmpty();
	const auto gap = Kit::Rem(0.875);
	const auto muted = ToneColor(Tone::Muted);
	_hints.clear();
	_actions.clear();
	auto y = Kit::Rem(0.25);

	// ── распознанное (`.quickPreview`) ──
	const auto chipGap = Kit::Rem(0.375);
	if (hasText) {
		auto x = 0;
		auto rowHeight = 0;
		const auto flowRect = [&](int itemWidth, int itemHeight) {
			if (x > 0 && x + itemWidth > width) {
				x = 0;
				y += rowHeight + chipGap;
				rowHeight = 0;
			}
			const auto rect = QRect(x, y, std::min(itemWidth, width), itemHeight);
			x += rect.width() + chipGap;
			rowHeight = std::max(rowHeight, itemHeight);
			return rect;
		};
		const auto alternativesOf = [&](const std::string &field) {
			auto list = std::vector<planner::QuickAlt>();
			for (const auto &alt : draft.alternatives.value_or(std::vector<planner::QuickAlt>())) {
				if (alt.field == field) {
					list.push_back(alt);
				}
			}
			return list;
		};
		// Чип: метка `.tagLarge`, значок, подпись (с вариантами — стрелка), точка выученного, крестик
		const auto chip = [&](const std::string &field, const QString &label, QColor color, const QString &icon,
				bool learned, bool removable) {
			const auto font = Kit::Font(13);
			const auto hasAlts = !alternativesOf(field).empty();
			const auto padX = Kit::Rem(0.625);
			const auto iconSize = icon.isEmpty() ? 0 : (Kit::Px(13) + Kit::Rem(0.25));
			const auto altArrow = hasAlts ? (Kit::Px(12) + Kit::Rem(0.125)) : 0;
			const auto dot = learned ? (Kit::Rem(0.3125) + Kit::Rem(0.125)) : 0;
			const auto close = removable ? (Kit::Px(14) + Kit::Rem(0.25)) : 0;
			const auto chipWidth = padX + iconSize + font->width(label) + altArrow + dot + close + padX
				- (removable ? Kit::Rem(0.25) : 0);
			const auto rect = flowRect(chipWidth, Kit::Px(18) + 2 * Kit::Rem(0.25));
			// Значение из словаря правок (`title` чипа)
			if (learned) {
				hint(rect, tr::lng_parvane_planner_quick_learned(tr::now));
			}
			auto cx = rect.x() + padX;
			if (p) {
				p->setPen(Qt::NoPen);
				p->setBrush(Kit::Mix(color, 0.18));
				p->drawRoundedRect(rect, rect.height() / 2., rect.height() / 2.);
				if (!icon.isEmpty()) {
					PaintPlannerIcon(*p, icon, color, cx, rect.y() + (rect.height() - Kit::Px(13)) / 2, Kit::Px(13));
				}
			}
			cx += iconSize;
			const auto labelWidth = std::min(font->width(label), std::max(rect.right() - cx - altArrow - dot - close, 0));
			DrawElided(p, font, color, cx, rect.y() + (rect.height() - font->height) / 2 + font->ascent, label, labelWidth);
			if (hasAlts) {
				const auto toggle = QRect(cx, rect.y(), labelWidth + altArrow, rect.height());
				if (p) {
					PaintPlannerIcon(*p, u"down"_q, Kit::Mix(color, over(toggle) ? 1. : 0.7), cx + labelWidth + Kit::Rem(0.125),
						rect.y() + (rect.height() - Kit::Px(12)) / 2, Kit::Px(12));
				}
				area(toggle, [=] {
					_altField = (_altField == field) ? std::nullopt : std::optional<std::string>(field);
					refresh();
				});
				hint(toggle, tr::lng_parvane_planner_quick_alternatives(tr::now));
			}
			cx += labelWidth + altArrow;
			if (learned) {
				if (p) {
					Kit::PaintDot(*p, QPoint(cx + Kit::Rem(0.125) + Kit::Rem(0.3125) / 2, rect.center().y()), color,
						Kit::Rem(0.3125));
				}
				cx += dot;
			}
			if (removable) {
				const auto closeRect = QRect(cx + Kit::Rem(0.25), rect.y() + (rect.height() - Kit::Px(14)) / 2, Kit::Px(14),
					Kit::Px(14));
				if (p) {
					PaintPlannerIcon(*p, u"close"_q, Kit::Mix(color, over(closeRect) ? 1. : 0.7), closeRect.x(),
						closeRect.y(), closeRect.width());
				}
				area(closeRect.marginsAdded({ 3, 3, 3, 3 }), [=] { skipField(field); });
				action(closeRect.marginsAdded({ 3, 3, 3, 3 }),
					tr::lng_parvane_planner_quick_remove(tr::now, lt_value, label),
					[=] { skipField(field); });
			}
		};
		const auto isKindLearned = Learned(draft, "kind");
		const auto kindLabel = draft.metric ? MetricLabel(*draft.metric) : DraftKindLabel(draft.kind);
		chip("kind", kindLabel, KindColor(DraftKind(draft.kind)), DraftKindIcon(draft.kind), isKindLearned, isKindLearned);
		for (const auto &item : BuildChips(draft)) {
			chip(item.field, item.text, KindColor(Kind::Muted), QString(), item.isLearned, !item.isFixed);
		}
		y += rowHeight;
		x = 0;
		rowHeight = 0;

		// Другие чтения
		if (_altField) {
			const auto alts = alternativesOf(*_altField);
			if (!alts.empty()) {
				y += chipGap;
				const auto labelFont = Kit::Font(12);
				const auto label = tr::lng_parvane_planner_quick_alternatives(tr::now);
				const auto labelRect = flowRect(labelFont->width(label), Kit::Rem(1.875));
				DrawElided(p, labelFont, muted, labelRect.x(), labelRect.y() + (labelRect.height() - labelFont->height) / 2
					+ labelFont->ascent, label, labelRect.width());
				for (const auto &alt : alts) {
					const auto text = FormatAlt(draft, alt);
					const auto font = Kit::Font(13);
					const auto rect = flowRect(font->width(text) + 2 * Kit::Rem(0.75), Kit::Rem(1.875));
					if (p) {
						p->setPen(QPen(ToneColor(Tone::Line2), 1));
						p->setBrush(Qt::NoBrush);
						p->drawRoundedRect(QRectF(rect).adjusted(0.5, 0.5, -0.5, -0.5), rect.height() / 2.,
							rect.height() / 2.);
					}
					DrawElided(p, font, over(rect) ? ToneColor(Tone::Fg) : muted, rect.x() + Kit::Rem(0.75),
						rect.y() + (rect.height() - font->height) / 2 + font->ascent, text, rect.width() - 2 * Kit::Rem(0.75));
					area(rect, [=] { chooseAlt(alt); });
				}
				y += rowHeight;
			}
		}

		// Название и описание задачи либо события; у прочих — название
		y += Kit::Rem(0.375);
		const auto font = Kit::Font(14);
		const auto nameFont = Kit::Font(14, true);
		if (draft.kind == "task" || draft.kind == "event") {
			const auto labelWidth = Kit::Rem(5);
			const auto labelFont = Kit::Font(12);
			const auto lineHeight = Kit::Px(20);
			const auto part = [&](const QString &label, const QString &text, const style::font &textFont, bool removable) {
				DrawElided(p, labelFont, muted, 0, y + (lineHeight - labelFont->height) / 2 + labelFont->ascent, label,
					labelWidth);
				const auto textX = labelWidth + Kit::Rem(0.625);
				const auto textWidth = std::max(width - textX - (removable ? Kit::Px(20) : 0), 0);
				const auto height = std::max(lineHeight,
					DrawWrapped(p, textFont, ToneColor(Tone::Fg), QRect(textX, y, textWidth, 0), text, 4, lineHeight));
				if (removable) {
					const auto closeRect = QRect(width - Kit::Px(14), y + (lineHeight - Kit::Px(14)) / 2, Kit::Px(14),
						Kit::Px(14));
					if (p) {
						PaintPlannerIcon(*p, u"close"_q, Kit::Mix(Tone::Fg, over(closeRect) ? 1. : 0.7), closeRect.x(),
							closeRect.y(), closeRect.width());
					}
					area(closeRect.marginsAdded({ 3, 3, 3, 3 }), [=] { skipField("description"); });
					action(closeRect.marginsAdded({ 3, 3, 3, 3 }), tr::lng_parvane_planner_quick_remove(
						tr::now,
						lt_value,
						tr::lng_parvane_planner_field_description(tr::now)), [=] { skipField("description"); });
					// При наведении — что сделает крестик (web `title`)
					hint(closeRect.marginsAdded({ 3, 3, 3, 3 }),
						tr::lng_parvane_planner_quick_description_to_name(tr::now));
				}
				y += height + Kit::Rem(0.25);
			};
			part(tr::lng_parvane_planner_quick_name(tr::now),
				draft.name.empty() ? tr::lng_parvane_planner_quick_no_name(tr::now) : Q(draft.name), nameFont, false);
			if (draft.description && !draft.description->empty()) {
				part(tr::lng_parvane_planner_field_description(tr::now), Q(*draft.description), font, true);
			}
		} else {
			auto name = Q(draft.name);
			if (name.isEmpty()) {
				name = draft.metric ? MetricLabel(*draft.metric)
					: (draft.kind == "sleep") ? tr::lng_parvane_planner_kind_sleep(tr::now)
					: (draft.kind == "water") ? tr::lng_parvane_planner_health_water(tr::now)
					: (draft.kind == "goal") ? tr::lng_parvane_planner_health_goals(tr::now)
					: tr::lng_parvane_planner_quick_no_name(tr::now);
			}
			y += DrawWrapped(p, nameFont, ToneColor(Tone::Fg), QRect(0, y, width, 0), name, 3) + Kit::Rem(0.25);
		}
		const auto errorFont = Kit::Font(13);
		if (draft.error) {
			const auto text = ErrorText(*draft.error);
			if (!text.isEmpty()) {
				y += DrawWrapped(p, errorFont, ToneColor(Tone::Red), QRect(0, y, width, 0), text, 0);
			}
		}
		if (Q(draft.name).size() > kNameMaxLength) {
			y += DrawWrapped(p, errorFont, ToneColor(Tone::Red), QRect(0, y, width, 0),
				tr::lng_parvane_planner_quick_too_long(tr::now), 0);
		}
	} else {
		y += DrawWrapped(p, Kit::Font(14), muted, QRect(0, y, width, 0), tr::lng_parvane_planner_quick_hint(tr::now), 0);
	}
	y += gap;

	// ── вид записи (`.hscroll` с `.chip`) ──
	{
		auto x = 0;
		const auto font = Kit::Font(13);
		const auto height = Kit::Rem(1.875);
		for (const auto &choice : kChoices) {
			const auto label = ChoiceLabel(choice);
			const auto chipWidth = font->width(label) + 2 * Kit::Rem(0.75);
			if (x > 0 && x + chipWidth > width) {
				x = 0;
				y += height + chipGap;
			}
			const auto rect = QRect(x, y, chipWidth, height);
			const auto isActive = (_choice == choice)
				|| (_choice == "auto" && hasText && ChoiceOf(draft.kind) == choice);
			const auto color = (choice == "auto") ? ToneColor(Tone::Accent) : KindColor(DraftKind(choice));
			if (p) {
				if (isActive) {
					p->setPen(Qt::NoPen);
					p->setBrush(Kit::Mix(color, 0.22));
				} else {
					p->setPen(QPen(ToneColor(Tone::Line2), 1));
					p->setBrush(Qt::NoBrush);
				}
				p->drawRoundedRect(QRectF(rect).adjusted(0.5, 0.5, -0.5, -0.5), height / 2., height / 2.);
			}
			DrawElided(p, font, isActive ? color : (over(rect) ? ToneColor(Tone::Fg) : muted), rect.x() + Kit::Rem(0.75),
				rect.y() + (height - font->height) / 2 + font->ascent, label, chipWidth);
			area(rect, [=] {
				_choice = choice;
				_field->setFocusFast();
				reparse();
			});
			x += chipWidth + chipGap;
		}
		y += height + gap;
	}

	// ── подсказки ──
	const auto list = suggestions();
	if (!list.empty()) {
		const auto hasExamples = std::any_of(list.begin(), list.end(), [](const auto &s) { return s.source == "example"; });
		const auto hasOwn = std::any_of(list.begin(), list.end(), [](const auto &s) { return s.source != "example"; });
		const auto titleFont = Kit::Font(13);
		DrawElided(p, titleFont, muted, 0, y + titleFont->ascent, !hasExamples
			? tr::lng_parvane_planner_quick_recent_title(tr::now)
			: hasOwn
			? tr::lng_parvane_planner_quick_suggestions_title(tr::now)
			: tr::lng_parvane_planner_quick_examples_title(tr::now), width);
		y += titleFont->height + Kit::Rem(0.375);
		auto x = 0;
		const auto height = Kit::Rem(1.875);
		const auto font = Kit::Font(13);
		for (const auto &item : list) {
			const auto text = Q(item.text);
			const auto forgettable = (item.source != "example");
			const auto closeWidth = forgettable ? (Kit::Px(14) + Kit::Rem(0.375)) : 0;
			const auto itemWidth = std::min(font->width(text) + closeWidth + 2 * Kit::Rem(0.75), width);
			if (x > 0 && x + itemWidth > width) {
				x = 0;
				y += height + chipGap;
			}
			const auto rect = QRect(x, y, itemWidth, height);
			const auto hovered = over(rect);
			if (p) {
				p->setPen(QPen(ToneColor(Tone::Line2), 1));
				p->setBrush(Qt::NoBrush);
				p->drawRoundedRect(QRectF(rect).adjusted(0.5, 0.5, -0.5, -0.5), height / 2., height / 2.);
			}
			const auto textRect = QRect(rect.x(), rect.y(), rect.width() - closeWidth, rect.height());
			DrawElided(p, font, hovered ? ToneColor(Tone::Fg) : muted, rect.x() + Kit::Rem(0.75),
				rect.y() + (height - font->height) / 2 + font->ascent, text, textRect.width() - 2 * Kit::Rem(0.75)
				+ (forgettable ? Kit::Rem(0.75) : 0));
			area(textRect, [=] { fill(text); });
			if (forgettable) {
				const auto closeRect = QRect(rect.right() - Kit::Rem(0.75) - Kit::Px(14) + Kit::Rem(0.25),
					rect.y() + (height - Kit::Px(14)) / 2, Kit::Px(14), Kit::Px(14));
				if (p) {
					PaintPlannerIcon(*p, u"close"_q, hovered ? ToneColor(Tone::Fg) : muted, closeRect.x(), closeRect.y(),
						closeRect.width());
				}
				area(closeRect.marginsAdded({ 3, 3, 3, 3 }), [=, line = item.text] { forget(line); });
				action(closeRect.marginsAdded({ 3, 3, 3, 3 }), tr::lng_parvane_planner_quick_forget(
					tr::now,
					lt_value,
					text), [=, line = item.text] { forget(line); });
			}
			x += itemWidth + chipGap;
		}
		y += height + gap;
	}

	// ── низ окна: день по умолчанию и кнопки ──
	{
		const auto canSubmit = hasText && !draft.error && Q(draft.name).size() <= kNameMaxLength;
		const auto font = Kit::Font(14);
		const auto height = Kit::Rem(2.25);
		struct Button {
			QString text;
			bool accent = false;
			bool enabled = true;
			Fn<void()> click;
		};
		auto buttons = std::vector<Button>();
		if (_args.more) {
			const auto more = _args.more;
			const auto close = _close;
			buttons.push_back({ tr::lng_parvane_planner_quick_more(tr::now), false, true, [=] {
				close();
				more();
			} });
		}
		buttons.push_back({ tr::lng_parvane_planner_cancel(tr::now), false, true, _close });
		buttons.push_back({ tr::lng_parvane_planner_quick_add(tr::now), true, canSubmit, [=] { submit(); } });
		auto right = width;
		for (auto i = int(buttons.size()) - 1; i >= 0; --i) {
			const auto &button = buttons[i];
			const auto buttonFont = button.accent ? Kit::Font(14, true) : font;
			const auto buttonWidth = buttonFont->width(button.text) + 2 * Kit::Rem(0.875);
			const auto rect = QRect(right - buttonWidth, y, buttonWidth, height);
			if (p) {
				p->save();
				if (!button.enabled) {
					p->setOpacity(0.5);
				}
				const auto hovered = button.enabled && over(rect);
				p->setPen(Qt::NoPen);
				p->setBrush(button.accent ? ToneColor(Tone::Accent) : hovered ? ToneColor(Tone::Hover) : QColor(0, 0, 0, 0));
				p->drawRoundedRect(rect, Kit::Rem(0.5), Kit::Rem(0.5));
				DrawElided(p, buttonFont, button.accent ? ToneColor(Tone::AccentInk) : (hovered ? ToneColor(Tone::Fg) : muted),
					rect.x() + Kit::Rem(0.875), rect.y() + (height - buttonFont->height) / 2 + buttonFont->ascent,
					button.text, rect.width());
				p->restore();
			}
			if (button.enabled) {
				area(rect, button.click);
			}
			right = rect.x() - Kit::Rem(0.5);
		}
		const auto small = Kit::Font(13);
		DrawElided(p, small, muted, 0, y + (height - small->height) / 2 + small->ascent,
			tr::lng_parvane_planner_quick_default(tr::now, lt_date, FormatDayLabel(_args.today)), right);
		y += height;
	}
	return y;
}

} // namespace

void OpenQuickInput(not_null<QWidget*> host, QuickArgs args) {
	const auto sheet = Kit::Sheet::Show(host, {
		.title = tr::lng_parvane_planner_quick_title(tr::now),
		.closeName = tr::lng_parvane_planner_close(tr::now),
	});
	const auto weak = QPointer<Kit::Sheet>(sheet.get());
	const auto close = [=] {
		if (weak) {
			weak->requestClose();
		}
	};
	// Пример вида — подсказкой в пустом поле
	const auto isExample = !args.initialText.isEmpty() && !args.initialText.endsWith(u' ');
	const auto placeholder = isExample ? args.initialText : tr::lng_parvane_planner_quick_placeholder(tr::now);
	const auto field = sheet->add(object_ptr<Kit::Field>(
		sheet->content(),
		Kit::Field::Kind::Input,
		rpl::single(placeholder)));
	field->input()->setMaxLength(kInputMaxLength);
	const auto body = sheet->add(object_ptr<QuickBody>(sheet->content(), std::move(args), field, close));
	// Tab дописывает строку до первой подсказки
	base::install_event_filter(field->input(), [=](not_null<QEvent*> e) {
		if (e->type() == QEvent::KeyPress) {
			const auto key = static_cast<QKeyEvent*>(e.get());
			if (key->key() == Qt::Key_Tab && !(key->modifiers() & Qt::ShiftModifier) && body->acceptTab()) {
				return base::EventFilterResult::Cancel;
			}
		}
		return base::EventFilterResult::Continue;
	});
	field->setFocusFast();
}

} // namespace Parvane::PlannerViews
