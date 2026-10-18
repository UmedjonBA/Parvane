// Parvane fork: детали окон «Плана» (spec 029, T061/T062) — порт web `planner/PlannerField.tsx`,
// `PlannerCardRow.tsx`, `PlannerRepeatFields.tsx`, `PlannerRemindSelect.tsx`, `PlannerListPicker.tsx`,
// `PlannerSeriesPrompt.tsx`, `PlannerDescriptionScope.tsx`, `PlannerDetailsFold.tsx`, полей `Select`/`Checkbox`
// мессенджера в тонах «Плана» и подписей `plannerFormat.ts`. Размеры — из `Planner.module.scss` (1rem = 16 px),
// цвета — тона Parvane::ToneColor. Логика (черновик повтора, разбор дат и времени) — в ядре
// (`parvane/sections/planner_forms.h`).
#pragma once

#include "parvane/parvane_kit.h"

#include <parvane/sections/planner_forms.h>
#include <parvane/sections/planner_model.h>
#include <parvane/sections/planner_series.h>

#include "base/unique_qptr.h"
#include "ui/wrap/vertical_layout.h"

#include <rpl/variable.h>

#include <QtCore/QDate>
#include <QtCore/QPointer>

#include <memory>

class QPainter;

namespace Ui {
class InputField;
class PopupMenu;
} // namespace Ui

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::PlannerForms {

namespace planner = parvane::sections::planner;

// ── строки и подписи (plannerFormat.ts) ──────────────────────────────────────

[[nodiscard]] QString Q(const std::string &text);
[[nodiscard]] std::string S(const QString &text);
[[nodiscard]] std::string TodayKey();
[[nodiscard]] QDate DateOf(const std::string &day);
[[nodiscard]] std::string KeyOf(const QDate &date);
[[nodiscard]] planner::IdGen NewId();

// «18 октября»
[[nodiscard]] QString FormatDay(const std::string &day);
// «18 окт»
[[nodiscard]] QString FormatDayShort(const std::string &day);
// «Сб, 18 октября»
[[nodiscard]] QString FormatDayLabel(const std::string &day);
// «Сегодня», «Завтра», «Вчера», иначе день недели полностью
[[nodiscard]] QString FormatRelativeDay(const std::string &day, const std::string &today);
// День недели, понедельник — 0
[[nodiscard]] QString FormatWeekday(int index, bool full = false);
// Число по правилам языка: до `digits` знаков после запятой, группы разрядов
[[nodiscard]] QString FormatNumber(double value, int digits = 0);
[[nodiscard]] QString FormatDuration(int minutes);
[[nodiscard]] QString FormatHours(double minutes);
[[nodiscard]] QString FormatSpan(double minutes);
[[nodiscard]] QString FormatRemind(int minutes);
[[nodiscard]] QString FormatRepeat(const planner::Repeat &repeat);
[[nodiscard]] QString FormatStatus(const std::string &status);
[[nodiscard]] QString FormatProject(const std::string &project);

// Тексты кодов проверок ядра (`validateTask`, `validateEvent`, `validateRepeat`, `validateSettings`)
[[nodiscard]] QString TaskErrorText(const std::string &code);
[[nodiscard]] QString EventErrorText(const std::string &code);
[[nodiscard]] QString RepeatErrorText(const std::string &code);
[[nodiscard]] QString SettingsErrorText(const std::string &code);

// Цвет списка 1…8 (`--color-peer-0…7`); 0 — без цвета
[[nodiscard]] QColor ListColor(int color);

// Значок: набор ParvaneIcon, а недостающие в нём значки мессенджера (`clock`, `loop`, `info`, `schedule`,
// `delete`, `close`, `down`, `up`, `previous`, `next`, `settings`, `sport`, `add`, `edit`) — свои контуры
void PaintGlyph(QPainter &p, const QString &name, const QColor &color, QRect rect);

// Сообщение об ошибке (web `showPlannerNotice`) — всплывающей подсказкой окна
void ShowError(not_null<Window::SessionController*> controller, const QString &text);

// Правка «Плана» с результатом (идентификатор записи, которая теперь стоит в дне): `done` — на главном потоке
void UpdatePlannerWithResult(
	std::function<std::optional<std::string>(planner::State&)> mutate,
	const QString &notice,
	Fn<void(std::optional<std::string>)> done);

// ── раскладка ────────────────────────────────────────────────────────────────

// Строка элементов слева направо с промежутком, по центру по высоте; addStretch() — `.grow`
class Line final : public Ui::RpWidget {
public:
	explicit Line(QWidget *parent, int gap = 0, bool alignTop = false);

	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child, bool stretch = false) {
		return static_cast<Widget*>(addItem(std::move(child), stretch));
	}
	void addStretch();
	void setAlignBottom(bool bottom); // `align-items: flex-end`

protected:
	int resizeGetHeight(int newWidth) override;

private:
	struct Item {
		Ui::RpWidget *widget = nullptr; // nullptr — растяжка
		bool stretch = false;
	};
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child, bool stretch);

	std::vector<Item> _items;
	int _gap = 0;
	bool _alignTop = false;
	bool _alignBottom = false;
	bool _inResize = false;

};

// `.fields` (две колонки, в узкой карточке — одна) и `.fieldsThree` (1.4fr 1fr 1fr; уже 30rem — дата на всю
// строку, два поля под ней)
class FieldsGrid final : public Ui::RpWidget {
public:
	FieldsGrid(QWidget *parent, bool three);

	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addItem(std::move(child)));
	}

protected:
	int resizeGetHeight(int newWidth) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child);

	std::vector<Ui::RpWidget*> _items;
	bool _three = false;
	bool _inResize = false;

};

// Столбец с промежутком между элементами (`.stack`, `.editor`, `.cardRowBody`…)
[[nodiscard]] object_ptr<Ui::VerticalLayout> MakeColumn(QWidget *parent);
// Элемент столбца с промежутком сверху (у первого — без него)
template <typename Widget>
Widget *AddTo(not_null<Ui::VerticalLayout*> column, object_ptr<Widget> &&child, int gap) {
	return column->add(std::move(child), style::margins(0, column->count() ? gap : 0, 0, 0));
}

// Небольшой текст набора (`.small`, `.fieldLabel`, `.error`, `.sheetHint`, `.cardText`, `.seriesTitle`)
[[nodiscard]] object_ptr<Kit::Label> SmallText(QWidget *parent, const QString &text, Tone tone = Tone::Muted, int px = 13);

// ── поля ─────────────────────────────────────────────────────────────────────

// Однострочное поле без рамки с линией снизу (`.cardTitleInput`, 1.25rem полужирным) либо многострочное в рамке
// обычным шрифтом (`TextArea` мессенджера, `.dailyEditor`)
class TextInput final : public Ui::RpWidget {
public:
	enum class Kind {
		Title,
		Multiline,
	};
	TextInput(QWidget *parent, Kind kind, const QString &placeholder, const QString &value, int maxLength = 0, int minHeight = 0);
	~TextInput();

	[[nodiscard]] not_null<Ui::InputField*> input() const;
	[[nodiscard]] QString text() const;
	void setText(const QString &text);
	[[nodiscard]] rpl::producer<QString> textChanges() const;

protected:
	int resizeGetHeight(int newWidth) override;

private:
	struct Styles;
	void refreshColors();

	const Kind _kind;
	std::unique_ptr<Styles> _styles;
	object_ptr<Ui::InputField> _input = { nullptr };

};

// Поле «Плана» (web PlannerField): подпись `.fieldLabel` и поле `.fieldInput`. Значение отдаётся по завершении
// ввода (уход фокуса, Enter; дата из календаря — сразу); `false` от onCommit — значение отвергнуто, поле
// возвращает прежнее. onInput — на каждое изменение (дата и время — разобранные, негодные — пусто)
class FormField final : public Ui::RpWidget {
public:
	enum class Type {
		Date,
		Time,
		Number,
		Text,
	};
	FormField(
		QWidget *parent,
		Window::SessionController *controller,
		const QString &label,
		Type type,
		const std::string &value,
		const QString &placeholder = QString(),
		int maxLength = 0);

	void setOnCommit(Fn<bool(std::string)> callback);
	void setOnInput(Fn<void(std::string)> callback);
	// Новое значение извне; поле в фокусе не трогается, пока не просят force
	void setValue(const std::string &value, bool force = false);
	[[nodiscard]] std::string value() const; // набранное: дата и время — разобранные, негодные — пусто
	[[nodiscard]] QString raw() const;
	[[nodiscard]] bool hasFocus() const;
	void setFocusFast();
	[[nodiscard]] rpl::producer<> submits() const;

protected:
	int resizeGetHeight(int newWidth) override;

private:
	[[nodiscard]] QString shown(const std::string &value) const;
	[[nodiscard]] std::optional<std::string> parse(const QString &raw) const;
	void commit();
	void pickDate();

	Window::SessionController *_controller = nullptr;
	const Type _type;
	Kit::Label *_label = nullptr;
	Kit::Field *_field = nullptr;
	Kit::IconButton *_calendar = nullptr;
	std::string _value;
	Fn<bool(std::string)> _onCommit;
	Fn<void(std::string)> _onInput;
	bool _settingText = false;

};

// Выбор из списка (`Select` мессенджера со стрелкой): подпись сверху, поле с текстом пункта и стрелкой; пункты —
// всплывающим меню
class FormSelect final : public Kit::Button {
public:
	struct Option {
		QString value;
		QString text;
	};
	FormSelect(QWidget *parent, const QString &label, std::vector<Option> options, const QString &value);

	void setOptions(std::vector<Option> options);
	void setValue(const QString &value);
	[[nodiscard]] QString value() const;
	void setOnChange(Fn<void(QString)> callback);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	void showMenu();
	[[nodiscard]] QString currentText() const;

	QString _label;
	std::vector<Option> _options;
	QString _value;
	Fn<void(QString)> _onChange;
	base::unique_qptr<Ui::PopupMenu> _menu;

};

// Квадратная галочка с подписью (`Checkbox` мессенджера): «Весь день», дни недели, «Описание для всех повторов»
class TickBox final : public Kit::Button {
public:
	TickBox(QWidget *parent, const QString &text, bool checked);

	void setChecked(bool checked);
	[[nodiscard]] bool checked() const;
	void setOnChange(Fn<void(bool)> callback);

	QAccessible::Role accessibilityRole() override;
	Ui::AccessibilityState accessibilityState() const override;

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _text;
	bool _checked = false;
	Fn<void(bool)> _onChange;

};

// `.row.rowButton` с круглой галочкой `.check`: «Отметить выполненной», шаги задачи, «Закрыть день питания».
// done (`.rowDone`) — подпись бледная и зачёркнута
class CheckRow final : public Kit::Button {
public:
	CheckRow(QWidget *parent, const QString &text, bool checked, bool isSmall = false, Tone tone = Tone::Purple, bool strike = false);

	void setText(const QString &text);
	void setChecked(bool checked);
	[[nodiscard]] bool checked() const;
	void setOnChange(Fn<void(bool)> callback);

	QAccessible::Role accessibilityRole() override;
	Ui::AccessibilityState accessibilityState() const override;

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	QString _text;
	bool _checked = false;
	bool _small = false;
	Tone _tone = Tone::Purple;
	bool _strike = false;
	Fn<void(bool)> _onChange;

};

// Кнопка со значком мессенджера (значки PaintGlyph): `.ib`, `.ibSmall`, `.ibActive`
class GlyphButton final : public Kit::Button {
public:
	GlyphButton(QWidget *parent, const QString &icon, const QString &accessibleName, bool isSmall = false);

	void setActive(bool active);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _icon;
	bool _small = false;
	bool _active = false;

};

// Строка карточки записи (`.cardRow`): значок слева, содержимое справа, линия снизу (у последней — нет)
class CardRow final : public Ui::RpWidget {
public:
	CardRow(QWidget *parent, const QString &icon);

	[[nodiscard]] not_null<Ui::VerticalLayout*> body() const;
	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addItem(std::move(child)));
	}
	void setLast(bool last);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child);

	QString _icon;
	Ui::VerticalLayout *_body = nullptr;
	bool _last = false;

};

// Выбор объёма правки ряда (web PlannerSeriesPrompt): edit | delete | rule | stop | copy; выбор —
// one | following | all | stop
class SeriesPrompt final : public Ui::RpWidget {
public:
	SeriesPrompt(QWidget *parent, const QString &mode, Fn<void(QString)> choose, Fn<void()> cancel);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Ui::VerticalLayout *_column = nullptr;

};

// Поля правила повтора (web PlannerRepeatFields): вид, шаг, дни недели или число, начало и конец ряда
class RepeatFields final : public Ui::RpWidget {
public:
	RepeatFields(QWidget *parent, Window::SessionController *controller, std::shared_ptr<rpl::variable<planner::RepeatDraft>> draft);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void rebuild();
	void set(Fn<void(planner::RepeatDraft&)> change, bool structural);
	void refreshSummary();

	Window::SessionController *_controller = nullptr;
	std::shared_ptr<rpl::variable<planner::RepeatDraft>> _draft;
	Ui::VerticalLayout *_column = nullptr;
	Kit::Label *_summary = nullptr;

};

// Строка повтора (web PlannerRepeatRow): правило одной строкой, настройки раскрываются по нажатию; extra —
// виджеты под полями (кнопка «Сохранить правило», ошибка), видны вместе с полями
class RepeatRow final : public Ui::RpWidget {
public:
	RepeatRow(QWidget *parent, Window::SessionController *controller, std::shared_ptr<rpl::variable<planner::RepeatDraft>> draft);

	[[nodiscard]] not_null<Ui::VerticalLayout*> extra() const;
	[[nodiscard]] not_null<CardRow*> row() const;
	[[nodiscard]] bool isOpen() const {
		return _open;
	}
	void setOpen(bool open);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void toggle();

	CardRow *_row = nullptr;
	RepeatFields *_fields = nullptr;
	Ui::VerticalLayout *_extra = nullptr;
	bool _open = false;

};

// Кружки цвета списка (web PlannerColorSwatches): 0 — без цвета, 1…8
class ColorSwatches final : public Ui::RpWidget {
public:
	ColorSwatches(QWidget *parent, int value, Fn<void(int)> change);

	void setValue(int value);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	Kit::Flow *_flow = nullptr;
	std::vector<Kit::Button*> _items;
	int _value = 0;

};

// Выбор списка (группы) записи (web PlannerListPicker): существующие, «Без группы» и создание новой на месте
class ListPicker final : public Ui::RpWidget {
public:
	ListPicker(QWidget *parent, Window::SessionController *controller, const planner::State &state, const std::string &value, Fn<void(std::string)> change);

	void setState(const planner::State &state, const std::string &value);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void showSelect();
	void showCreate();
	void refreshOptions();

	Window::SessionController *_controller = nullptr;
	std::vector<std::string> _projects;
	std::string _value;
	Fn<void(std::string)> _change;
	Ui::VerticalLayout *_column = nullptr;
	FormSelect *_select = nullptr;
	bool _creating = false;

};

// «Напомнить» (web PlannerRemindSelect): без напоминания, в начале, за 5 мин … за неделю
[[nodiscard]] object_ptr<FormSelect> MakeRemindSelect(QWidget *parent, std::optional<int> value, Fn<void(std::optional<int>)> change);
void SetRemindValue(not_null<FormSelect*> select, std::optional<int> value);

// Статус задачи (В очереди / В работе / Готово)
[[nodiscard]] object_ptr<FormSelect> MakeStatusSelect(QWidget *parent, const std::string &value, Fn<void(std::string)> change);

// Галочка «Описание для всех повторов» (web PlannerDescriptionScope); confirmAll — «для всех» сначала спрашивает
class DescriptionScopeBox final : public Ui::RpWidget {
public:
	DescriptionScopeBox(QWidget *parent, planner::DescriptionScope scope, bool confirmAll, Fn<void(planner::DescriptionScope)> change);

	void setScope(planner::DescriptionScope scope);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void ask(bool asking);

	Ui::VerticalLayout *_column = nullptr;
	TickBox *_check = nullptr;
	Ui::RpWidget *_prompt = nullptr;
	bool _confirmAll = false;
	Fn<void(planner::DescriptionScope)> _change;

};

// Сворачиваемый блок «Повтор и детали» (web PlannerDetailsFold): открыт ли — привычка устройства
class DetailsFold final : public Ui::RpWidget {
public:
	DetailsFold(QWidget *parent, const QString &summary);

	[[nodiscard]] not_null<Ui::VerticalLayout*> body() const;
	void setSummary(const QString &summary);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	void toggle();

	Kit::Button *_toggle = nullptr;
	QString _summary;
	Ui::VerticalLayout *_body = nullptr;

};

// Переключатель вида (web `.kindSwitch`): «Задача» / «Событие»
class KindSwitch final : public Ui::RpWidget {
public:
	KindSwitch(QWidget *parent, std::vector<QString> labels, int active, Fn<void(int)> change);

	void setActive(int index);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	std::vector<Kit::Button*> _items;
	int _active = 0;
	Fn<void(int)> _change;

};

} // namespace Parvane::PlannerForms
