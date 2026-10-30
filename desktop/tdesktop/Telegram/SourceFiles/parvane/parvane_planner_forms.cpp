// Parvane fork: реализация parvane_planner_forms.h — окна «Плана» (spec 029, T061). В web форма и карточка
// записи стоят справа на месте дня, настройки — окном поверх раздела; на desktop все они — шторка набора
// (Kit::Sheet) поверх окна. Одновременно открыто одно окно: новое закрывает прежнее.
#include "parvane/parvane_planner_forms.h"

#include "parvane/parvane_planner_form_editors.h"
#include "parvane/parvane_planner_settings.h"

#include "lang/lang_keys.h"
#include "base/weak_ptr.h"
#include "mainwindow.h"
#include "window/window_session_controller.h"

#include <QtCore/QPointer>

namespace Parvane::PlannerUi {
namespace {

namespace Forms = Parvane::PlannerForms;
namespace planner = parvane::sections::planner;

QPointer<Kit::Sheet> &CurrentSheet() {
	static auto result = QPointer<Kit::Sheet>();
	return result;
}

[[nodiscard]] not_null<Kit::Sheet*> OpenSheet(
		not_null<Window::SessionController*> controller,
		const QString &title) {
	if (const auto old = CurrentSheet().data()) {
		old->requestClose();
	}
	const auto parent = controller->widget()->bodyWidget();
	const auto sheet = Kit::Sheet::Show(parent, Kit::Sheet::Descriptor{
		.title = title,
		.closeName = tr::lng_parvane_planner_close(tr::now),
	});
	CurrentSheet() = sheet.get();
	return sheet;
}

[[nodiscard]] Forms::EditorHost HostFor(
		not_null<Window::SessionController*> controller,
		not_null<Kit::Sheet*> sheet) {
	const auto weak = QPointer<Kit::Sheet>(sheet.get());
	// ответ рабочего потока приходит позже — окно к тому времени могло закрыться (выход из аккаунта)
	const auto weakController = base::make_weak(controller.get());
	return Forms::EditorHost{
		.controller = controller,
		.close = [=] {
			if (const auto strong = weak.data()) {
				strong->requestClose();
			}
		},
		.openTask = [=](std::string taskId, std::string day) {
			if (const auto strong = weakController.get()) {
				OpenTaskEditor(strong, taskId, day);
			}
		},
		.footer = sheet->footer(),
	};
}

[[nodiscard]] planner::State CurrentState() {
	const auto view = Sections::Planner();
	return view ? view->state : planner::createEmptyState();
}

// Шапка карточки (web `.cardHead`): чип вида и день — в строке с кнопкой закрытия, вместо названия
not_null<Forms::CardHead*> SetCardHead(not_null<Kit::Sheet*> sheet, const QString &icon, const QString &kind) {
	auto head = object_ptr<Forms::CardHead>(sheet.get(), icon, kind);
	const auto raw = head.data();
	sheet->setHeadWidget(std::move(head));
	return raw;
}

void OpenForm(
		not_null<Window::SessionController*> controller,
		const std::string &day,
		bool event) {
	const auto sheet = OpenSheet(controller, tr::lng_parvane_planner_title_new(tr::now));
	const auto form = sheet->add(object_ptr<Forms::TaskForm>(
		sheet->content(),
		HostFor(controller, sheet),
		CurrentState(),
		day,
		event));
	form->focusName();
}

} // namespace

void OpenTaskEditor(
		not_null<Window::SessionController*> controller,
		const std::string &taskId,
		const std::string &day) {
	if (taskId.empty()) {
		OpenForm(controller, day, false);
		return;
	}
	const auto sheet = OpenSheet(controller, tr::lng_parvane_planner_title_task(tr::now));
	const auto head = SetCardHead(sheet, u"check"_q, tr::lng_parvane_planner_kind_task(tr::now));
	// День экземпляра ряда; у разовой задачи карточка открывается на ней самой
	const auto editor = sheet->add(object_ptr<Forms::TaskEditor>(
		sheet->content(),
		HostFor(controller, sheet),
		taskId,
		day,
		day));
	editor->dayLabel() | rpl::on_next([=](QString text) {
		head->setDay(text);
	}, head->lifetime());
}

void OpenEventEditor(
		not_null<Window::SessionController*> controller,
		const std::string &eventId,
		const std::string &day,
		const std::string &instanceDay) {
	if (eventId.empty()) {
		OpenForm(controller, day, true);
		return;
	}
	const auto state = CurrentState();
	const auto i = ranges::find(state.events, eventId, &planner::Event::id);
	if (i == end(state.events)) {
		return;
	}
	auto event = (i->repeat && !instanceDay.empty()) ? planner::eventInstance(*i, instanceDay) : *i;
	const auto shownDay = event.instanceDay ? *event.instanceDay : event.day.value_or(std::string());
	const auto sheet = OpenSheet(controller, tr::lng_parvane_planner_title_event(tr::now));
	const auto head = SetCardHead(sheet, u"calendar"_q, tr::lng_parvane_planner_kind_event(tr::now));
	if (!shownDay.empty()) {
		head->setDay(Forms::FormatDayLabel(shownDay));
	}
	sheet->add(object_ptr<Forms::EventEditor>(
		sheet->content(),
		HostFor(controller, sheet),
		std::move(event),
		state));
}

void OpenPlannerSettings(not_null<Window::SessionController*> controller) {
	const auto sheet = OpenSheet(controller, tr::lng_parvane_planner_settings(tr::now));
	sheet->add(Forms::MakePlannerSettings(sheet->content(), controller));
}

} // namespace Parvane::PlannerUi
