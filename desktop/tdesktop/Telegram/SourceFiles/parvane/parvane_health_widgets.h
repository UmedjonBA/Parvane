// Parvane fork: детали экрана «Здоровье» (spec 029, T062) — порт частей web `planner/PlannerHealth.tsx`:
// карточка (`.card` + `.stack`), крупное значение (`.big`), строки нутриентов (`.macroRow`), строки еды и
// тренировок (`.row`), показатели тела (`.healthFact`), столбики недели (`.bars`), график веса (`.spark`),
// график режима сна (`.routineChart`), строка ввода с кнопкой (HealthTextForm). Размеры — `Planner.module.scss`.
#pragma once

#include "parvane/parvane_planner_form_widgets.h"

#include <parvane/sections/planner_health.h>

namespace Parvane::Health {

namespace planner = parvane::sections::planner;
using PlannerForms::Line;

// Тон вида записи `--planner-kind`: event — синий, task — фиолетовый, food — оранжевый, sleep — бирюзовый,
// workout — зелёный, note — жёлтый, metric и due — красный
enum class Kind {
	Event,
	Task,
	Food,
	Sleep,
	Workout,
	Note,
	Metric,
	Due,
	Muted,
	Good,
	Warn,
};
[[nodiscard]] Tone KindTone(Kind kind);

// `.card` + `.stack`: поля 1rem, скругление 0.75rem, `--pv-raised`; столбец с промежутком 0.875rem
class Card final : public Ui::RpWidget {
public:
	explicit Card(QWidget *parent);

	[[nodiscard]] not_null<Ui::VerticalLayout*> column() const;
	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child, int gap = -1) {
		return static_cast<Widget*>(addItem(std::move(child), gap));
	}

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child, int gap);

	Ui::VerticalLayout *_column = nullptr;

};

// `.cardHead`: `.cardTitle` слева (или `.groupTitle`), растяжка, справа — заметка `.cardNote` и виджеты
[[nodiscard]] object_ptr<Line> MakeHead(QWidget *parent, const QString &title, const QString &note = QString(), bool group = false);

// `.healthBig`: крупное значение `.big` тоном и приглушённая подпись; clickable — `.healthValueButton`
class BigValue final : public Kit::Button {
public:
	BigValue(QWidget *parent, const QString &value, Tone tone, const QString &suffix, bool clickable);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	QString _value;
	Tone _tone = Tone::Fg;
	QString _suffix;
	bool _clickable = false;

};

// Строка нутриента (`.macroRow`): название, «значение / цель», полоса; red — значение красным (`.kindDue`)
class MacroRow final : public Ui::RpWidget {
public:
	MacroRow(QWidget *parent, const QString &label, const QString &value, const QString &goalPart, double fraction, Tone tone, bool red);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	QString _label;
	QString _value;
	QString _goalPart;
	double _fraction = 0.;
	Tone _tone = Tone::Accent;
	bool _red = false;

};

// Строка с прогрессом (активность): название, значение тоном и цель, толстая полоса
class ProgressRow final : public Ui::RpWidget {
public:
	ProgressRow(QWidget *parent, const QString &label, const QString &value, const QString &goalPart, double fraction, Tone tone);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	QString _label;
	QString _value;
	QString _goalPart;
	double _fraction = 0.;
	Tone _tone = Tone::Accent;

};

// Полоса прогресса (`.prog`, `.progThick`) с заливкой тоном
[[nodiscard]] object_ptr<Kit::Progress> MakeProgress(QWidget *parent, double fraction, Tone tone, bool thick);

// Строка записи (`.row`): слева время (`.healthTime`) либо значок вида (`.rowIcon`), название и подпись, справа
// `.rowMeta` и кнопка удаления
class EntryRow final : public Ui::RpWidget {
public:
	struct Descriptor {
		QString time;          // `.healthTime`; пусто и без значка — пустая колонка времени
		QString icon;          // `.rowIcon` вместо времени
		Tone iconTone = Tone::Green;
		QString title;
		QString subtitle;
		bool subtitleMono = false;
		QString meta;
		QString deleteName;
	};
	EntryRow(QWidget *parent, Descriptor descriptor, Fn<void()> remove);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	void enterEventHook(QEnterEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	[[nodiscard]] int leftWidth() const;

	Descriptor _descriptor;
	PlannerForms::GlyphButton *_remove = nullptr;
	bool _over = false;

};

// Показатель тела (`.healthFact` + `.healthValueButton`): подпись и значение; нажатие — ввод текстом для него
class FactButton final : public Kit::Button {
public:
	FactButton(QWidget *parent, const QString &label, const QString &value, bool accent);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	QString _label;
	QString _value;
	bool _accent = false;

};

// Столбики недели: значение над столбиком, пунктир цели, день экрана обведён; isLow — красный столбик
class Bars final : public Ui::RpWidget {
public:
	struct Data {
		std::vector<std::optional<double>> values;
		std::vector<QString> labels;
		std::vector<bool> current;
		Fn<QString(double)> format;
		Tone tone = Tone::Accent;
		std::optional<double> goal;
		Fn<bool(double)> isLow;
	};
	Bars(QWidget *parent, Data data);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Data _data;

};

// График веса за три недели: ломаная по записям, пунктир цели, точка последней записи
class WeightSpark final : public Ui::RpWidget {
public:
	WeightSpark(QWidget *parent, std::vector<std::optional<double>> series, std::optional<double> goal, QString goalLabel);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	std::vector<std::optional<double>> _series;
	std::optional<double> _goal;
	QString _goalLabel;

};

// График режима сна: дни колонками, сверху вниз — часы суток; нажатие на день — его сны строкой под графиком
class RoutineChart final : public Ui::RpWidget {
public:
	struct Column {
		std::string day;
		QString number;
		bool isScreenDay = false;
		struct Bar {
			int from = 0;
			int to = 0;
			bool isMain = false;
			Tone tone = Tone::Aqua;
		};
		std::vector<Bar> bars;
		bool untimed = false;
		QString name; // для озвучки
	};
	struct Data {
		planner::SleepAxis axis;
		std::vector<Column> columns;
		std::vector<int> means;
		std::vector<int> goals;
		std::string selected;
	};
	RoutineChart(QWidget *parent, Data data, Fn<void(std::string)> pick);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	[[nodiscard]] QRect plot() const;
	[[nodiscard]] int columnAt(QPoint point) const;
	[[nodiscard]] double yOf(double value) const;

	Data _data;
	Fn<void(std::string)> _pick;
	int _over = -1;

};

// Строка ввода с кнопкой (`.healthGoalForm`: «сон дня», «цели»): `true` от onSubmit — строка принята, поле
// очищается. Кнопка недоступна, пока поле пусто
class TextForm final : public Ui::RpWidget {
public:
	TextForm(QWidget *parent, const QString &placeholder, const QString &buttonText, bool accent, Fn<bool(QString)> submit);

	void fill(const QString &text);
	void setButtonText(const QString &text);
	[[nodiscard]] QString text() const;
	[[nodiscard]] bool hasFocus() const;
	void restore(const QString &text, bool focus);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void submit();
	void refreshButton();

	Kit::Field *_field = nullptr;
	Kit::PushButton *_button = nullptr;
	Fn<bool(QString)> _submit;

};

} // namespace Parvane::Health
