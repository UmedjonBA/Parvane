// Parvane fork: карточки записей «Плана» (spec 029, T061) — порт web `planner/PlannerTaskEditor.tsx`,
// `PlannerEventEditor.tsx` и `PlannerTaskForm.tsx`. Открываются шторкой (parvane_planner_forms.cpp).
#pragma once

#include "parvane/parvane_planner_form_widgets.h"
#include "parvane/parvane_sections_data.h"

#include "base/timer.h"

namespace Parvane::PlannerForms {

// Что карточка просит у окна: закрыть себя, открыть другую задачу (новая запись дня, ряд, отделённый день)
struct EditorHost {
	Window::SessionController *controller = nullptr;
	Fn<void()> close;
	Fn<void(std::string taskId, std::string day)> openTask;
	Ui::VerticalLayout *footer = nullptr; // низ окна вне прокрутки — туда кнопки карточки (spec 030)
};

// Карточка задачи: поля пишутся сразу; у экземпляра ряда — выбор объёма правки
class TaskEditor final : public Ui::RpWidget {
public:
	TaskEditor(QWidget *parent, EditorHost host, std::string taskId, std::string instanceDay, std::string picked);

	// Подпись дня в шапке окна: день экземпляра или дата работы; без даты — «Без даты»
	[[nodiscard]] rpl::producer<QString> dayLabel() const;

protected:
	int resizeGetHeight(int newWidth) override;

private:
	struct Pending {
		QString kind; // patch | copy | delete | rule
		planner::ItemPatch changes;
		QString notice;
		std::optional<planner::Repeat> repeat;
	};

	void applyView(const std::shared_ptr<const Sections::PlannerView> &view);
	[[nodiscard]] QString shapeOf() const;
	void rebuild();
	void refreshValues();
	void rebuildBottom();
	void rebuildSlots();
	[[nodiscard]] bool isInstance() const;

	bool patch(planner::ItemPatch changes, const QString &notice);
	void patchTemplate(planner::ItemPatch changes, const QString &notice);
	void chooseScope(const QString &scope);
	void markSaved();

	EditorHost _host;
	std::string _taskId;
	std::string _instanceDay;
	std::string _picked;
	std::shared_ptr<const Sections::PlannerView> _view;
	planner::Task _task;
	bool _found = false;
	QString _shape;

	std::shared_ptr<rpl::variable<planner::RepeatDraft>> _repeatDraft;
	std::optional<planner::DescriptionScope> _descriptionScope;
	QString _descriptionDraft;
	std::optional<Pending> _pending;
	std::optional<std::vector<planner::SlotAnswer>> _slots;
	QString _slotHint;
	QString _repeatError;
	bool _repeatOpen = false;
	bool _saved = false;
	base::Timer _savedTimer;
	rpl::variable<QString> _dayLabel;

	Ui::VerticalLayout *_column = nullptr;
	Ui::RpWidget *_title = nullptr;
	Kit::Label *_autosave = nullptr;
	CheckRow *_done = nullptr;
	FormField *_day = nullptr;
	FormField *_start = nullptr;
	FormField *_minutes = nullptr;
	FormField *_due = nullptr;
	RepeatRow *_repeatRow = nullptr;
	ListPicker *_list = nullptr;
	FormSelect *_status = nullptr;
	FormSelect *_remind = nullptr;
	TextInput *_description = nullptr;
	Ui::VerticalLayout *_descriptionSave = nullptr;
	Ui::VerticalLayout *_slotsColumn = nullptr;
	Ui::VerticalLayout *_bottom = nullptr;

};

// Карточка события: поля правятся черновиком и сохраняются кнопкой; у экземпляра ряда — выбор объёма
class EventEditor final : public Ui::RpWidget {
public:
	EventEditor(QWidget *parent, EditorHost host, planner::Event event, const planner::State &state);

protected:
	int resizeGetHeight(int newWidth) override;

private:
	struct Pending {
		QString kind; // save | rule | delete | copy
		planner::ItemPatch patch;
		std::optional<std::string> ownDescription;
		std::optional<planner::Repeat> repeat;
		planner::ItemPatch next;
		planner::ItemPatch fields;
	};

	void build();
	void rebuildWhen();
	void rebuildBottom();
	void submit();
	void applyScope(const QString &scope, const Pending &action);
	[[nodiscard]] bool isInstance() const;

	EditorHost _host;
	planner::Event _event;
	planner::State _state;

	QString _name;
	QString _description;
	std::optional<planner::DescriptionScope> _descriptionScope;
	std::string _start;
	std::string _end;
	std::string _day;
	bool _allDay = false;
	bool _holiday = false;
	int _color = 0;
	std::string _project;
	std::optional<int> _remind;
	std::shared_ptr<rpl::variable<planner::RepeatDraft>> _repeatDraft;
	std::optional<Pending> _pending;

	Ui::VerticalLayout *_column = nullptr;
	Ui::VerticalLayout *_when = nullptr;
	Ui::SlideWrap<ColorSwatches> *_swatches = nullptr;
	Ui::SlideWrap<Kit::Label> *_error = nullptr;
	Ui::VerticalLayout *_bottom = nullptr;

};

// Новая задача либо событие — разовое или ряд (web PlannerTaskForm)
class TaskForm final : public Ui::RpWidget {
public:
	TaskForm(QWidget *parent, EditorHost host, const planner::State &state, std::string day, bool event);

	void focusName();

protected:
	int resizeGetHeight(int newWidth) override;

private:
	void rebuild();
	void submit();
	void setStart(const std::string &value);

	EditorHost _host;
	planner::State _state;
	bool _event = false;
	QString _name;
	QString _description;
	planner::DescriptionScope _descriptionScope = planner::DescriptionScope::All;
	std::string _minutes;
	std::string _day;
	std::string _start;
	std::string _end;
	std::string _due;
	std::string _status = "queue";
	std::string _project;
	bool _allDay = false;
	bool _holiday = false;
	int _color = 0;
	std::optional<int> _remind;
	bool _endTouched = false;
	std::shared_ptr<rpl::variable<planner::RepeatDraft>> _repeatDraft;
	bool _repeatOpen = false;
	QString _error;

	Ui::VerticalLayout *_column = nullptr;
	TextInput *_nameInput = nullptr;
	FormField *_endField = nullptr;
	RepeatRow *_repeatRow = nullptr;

};

} // namespace Parvane::PlannerForms
