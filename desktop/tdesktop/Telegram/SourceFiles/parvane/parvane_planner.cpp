// Parvane fork: раздел «Календарь» («План») на desktop (spec 029, T061) — порт оболочки web Planner.tsx: острова
// страницы раздела и справа дня календаря, шапка с переключателем вида («Сегодня» — первый пункт, затем неделя,
// месяц, год, список), строка состояния синхронизации, уведомление с «Отменить», ввод текстом. Редакторы записей
// и настройки — окна parvane_planner_forms.h (агент B); «Здоровье» — свой раздел рейки.
#include "parvane/parvane_sections_host.h"

#include "parvane/parvane_knowledge.h"
#include "parvane/parvane_mascot.h"
#include "parvane/parvane_planner_agenda.h"
#include "parvane/parvane_planner_calendar.h"
#include "parvane/parvane_planner_forms.h"
#include "parvane/parvane_planner_header.h"
#include "parvane/parvane_planner_quick.h"
#include "parvane/parvane_planner_today.h"

#include "lang/lang_keys.h"
#include "ui/painter.h"
#include "ui/widgets/scroll_area.h"
#include "window/window_session_controller.h"

#include <QtCore/QDateTime>
#include <QtCore/QTimer>
#include <QtGui/QtEvents>

namespace Parvane {
namespace {

using namespace PlannerViews;

// 75 % потолка открытого текста снимка контейнера (1 МиБ, spec 010 R5)
constexpr auto kSnapshotWarnBytes = 786432;
constexpr auto kToastMs = 3000;
// Ширина, до которой правая панель дня уже (`Planner.module.scss`, 1240px)
constexpr auto kNarrowSideWidth = 1240;

// Вид календаря и слои — настройка устройства на время работы приложения (web — localStorage)
QString &SavedCalendarView() {
	static auto result = u"month"_q;
	return result;
}

planner::Layers &SavedLayers() {
	static auto result = planner::Layers();
	return result;
}

int MsUntilTomorrow() {
	const auto now = QDateTime::currentDateTime();
	const auto tomorrow = QDateTime(now.date().addDays(1), QTime(0, 0));
	return int(std::min<qint64>(now.msecsTo(tomorrow) + 1000, 24LL * 3600 * 1000));
}

// Уведомление (`.toast`): снизу по центру, «Отменить» — подчёркнутой ссылкой
class Toast final : public Ui::RpWidget {
public:
	Toast(QWidget *parent, Fn<void()> undo)
	: RpWidget(parent)
	, _undo(std::move(undo)) {
		Kit::RepaintOnTones(this);
		setCursor(style::cur_default);
		hide();
	}

	void setNotice(const QString &text, bool canUndo) {
		_text = text;
		_canUndo = canUndo;
		setVisible(!_text.isEmpty());
		relayout();
	}

	void relayout() {
		if (_text.isEmpty() || !parentWidget()) {
			return;
		}
		const auto font = Kit::Font(14);
		const auto undoFont = Kit::Font(14, true);
		const auto padX = Kit::Rem(1.125);
		const auto padY = Kit::Rem(0.625);
		const auto maxWidth = parentWidget()->width() - Kit::Rem(2);
		auto contentWidth = font->width(_text);
		if (_canUndo) {
			contentWidth += Kit::Rem(0.75) + undoFont->width(tr::lng_parvane_planner_undo(tr::now));
		}
		const auto width = std::min(contentWidth + 2 * padX, maxWidth);
		const auto height = font->height + 2 * padY;
		setGeometry((parentWidget()->width() - width) / 2, parentWidget()->height() - Kit::Rem(1.75) - height, width,
			height);
		raise();
		update();
	}

protected:
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		p.setPen(Qt::NoPen);
		p.setBrush(ToneColor(Tone::Fg));
		p.drawRoundedRect(rect(), height() / 2., height() / 2.);
		const auto font = Kit::Font(14);
		const auto undoFont = Kit::Font(14, true)->underline();
		const auto padX = Kit::Rem(1.125);
		const auto baseline = (height() - font->height) / 2 + font->ascent;
		auto undoWidth = 0;
		if (_canUndo) {
			const auto undo = tr::lng_parvane_planner_undo(tr::now);
			undoWidth = undoFont->width(undo);
			DrawElided(&p, undoFont, ToneColor(Tone::Panel), width() - padX - undoWidth, baseline, undo, undoWidth);
			undoWidth += Kit::Rem(0.75);
		}
		DrawElided(&p, font, ToneColor(Tone::Panel), padX, baseline, _text, width() - 2 * padX - undoWidth);
	}
	void mouseReleaseEvent(QMouseEvent *e) override {
		if (_canUndo && _undo) {
			_undo();
		}
	}

private:
	const Fn<void()> _undo;
	QString _text;
	bool _canUndo = false;

};

// Строка состояния синхронизации (`.syncNotice`)
class SyncNotice final : public Ui::RpWidget {
public:
	explicit SyncNotice(QWidget *parent)
	: RpWidget(parent) {
		Kit::RepaintOnTones(this);
	}

	void setText(const QString &text) {
		_text = text;
		setVisible(!_text.isEmpty());
		resizeToWidth(width());
		update();
	}

protected:
	int resizeGetHeight(int newWidth) override {
		if (_text.isEmpty()) {
			return 0;
		}
		const auto font = Kit::Font(14);
		return DrawWrapped(nullptr, font, QColor(), QRect(0, 0, newWidth - 2 * Kit::Rem(1.125), 0), _text, 0)
			+ 2 * Kit::Rem(0.5) + 1;
	}
	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		p.fillRect(rect(), ToneColor(Tone::Raised));
		p.fillRect(QRect(0, height() - 1, width(), 1), ToneColor(Tone::Line));
		const auto font = Kit::Font(14);
		DrawWrapped(&p, font, ToneColor(Tone::Muted), QRect(Kit::Rem(1.125), Kit::Rem(0.5),
			width() - 2 * Kit::Rem(1.125), 0), _text, 0);
	}

private:
	QString _text;

};

// Содержимое прокрутки страницы (`.content`, поля 1.25rem): один вид за раз
class Holder final : public Ui::RpWidget {
public:
	explicit Holder(QWidget *parent)
	: RpWidget(parent) {
	}

	void setCurrent(Ui::RpWidget *current) {
		_current = current;
		resizeToWidth(width());
	}

protected:
	int resizeGetHeight(int newWidth) override {
		const auto pad = Kit::Rem(1.25);
		if (!_current) {
			return 0;
		}
		_current->resizeToWidth(std::max(newWidth - 2 * pad, 0));
		_current->move(pad, pad);
		return _current->height() + 2 * pad;
	}

private:
	Ui::RpWidget *_current = nullptr;

};

class PlannerScreen final : public Ui::RpWidget {
public:
	PlannerScreen(QWidget *parent, not_null<Window::SessionController*> controller);

protected:
	void resizeEvent(QResizeEvent *e) override;
	void paintEvent(QPaintEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;

private:
	[[nodiscard]] Actions makeActions();
	[[nodiscard]] bool isCalendar() const {
		return _view != u"today"_q;
	}
	void apply(ViewPtr view);
	void refresh();
	void relayout();
	void pickDay(const std::string &day);
	void changePeriod(int delta);
	void switchSegment(const QString &segment);
	void toggleLayer(const QString &layer);
	void openTask(const std::string &taskId, const std::string &day);
	void openEvent(const std::string &eventId, const std::string &day);
	void createForDay(const std::string &day);
	void moveTask(const std::string &taskKey, const std::string &day);
	void openQuick(const QString &text);
	void showToast(const QString &text);
	void undo();
	void scheduleMidnight();

	const not_null<Window::SessionController*> _controller;
	ViewPtr _data;
	std::string _today;
	std::string _picked;
	QString _view = u"today"_q; // today | calendar
	QString _calendarView;
	planner::Layers _layers;

	Kit::Island *_page = nullptr;
	PeriodBar *_bar = nullptr;
	SyncNotice *_notice = nullptr;
	Ui::ScrollArea *_scroll = nullptr;
	Holder *_holder = nullptr;
	TodayView *_todayView = nullptr;
	MonthView *_month = nullptr;
	YearView *_year = nullptr;
	AgendaView *_agenda = nullptr;
	WeekView *_week = nullptr;
	DayIsland *_side = nullptr;
	Toast *_toast = nullptr;
	Mascot *_loading = nullptr; // web `<Loading />` — маскот, пока нет ни данных, ни сохранённой копии
	QString _localToast;
	QTimer _localToastTimer;
	QTimer _midnight;

};

PlannerScreen::PlannerScreen(QWidget *parent, not_null<Window::SessionController*> controller)
: RpWidget(parent)
, _controller(controller)
, _today(TodayKey())
, _picked(_today)
, _calendarView(SavedCalendarView())
, _layers(SavedLayers()) {
	setFocusPolicy(Qt::ClickFocus);
	Kit::RepaintOnTones(this);
	const auto actions = makeActions();

	_page = Ui::CreateChild<Kit::Island>(this, Kit::Rem(1.125));
	_bar = Ui::CreateChild<PeriodBar>(_page, PeriodBar::Callbacks{
		.prev = [=] { changePeriod(-1); },
		.next = [=] { changePeriod(1); },
		.today = [=] { pickDay(_today); },
		.pickDay = [=](std::string day) { pickDay(day); },
		.segment = [=](QString segment) { switchSegment(segment); },
		.toggleLayer = [=](QString layer) { toggleLayer(layer); },
		.settings = [=] { PlannerUi::OpenPlannerSettings(_controller); },
		.add = [=] { openQuick(QString()); },
	});
	_notice = Ui::CreateChild<SyncNotice>(_page);
	_scroll = Ui::CreateChild<Ui::ScrollArea>(_page);
	_holder = _scroll->setOwnedWidget(object_ptr<Holder>(_scroll)).data();

	_todayView = Ui::CreateChild<TodayView>(_holder, actions, [=](int delta) {
		pickDay(planner::addDays(_picked, delta));
	}, [=] {
		pickDay(_today);
	});
	_todayView->setScrollTo([=](int y) {
		_scroll->scrollToY(y + Kit::Rem(1.25));
	});
	_loading = Ui::CreateChild<Mascot>(_holder);
	_month = Ui::CreateChild<MonthView>(_holder, actions);
	_year = Ui::CreateChild<YearView>(_holder, actions);
	_agenda = Ui::CreateChild<AgendaView>(_holder, actions);
	_week = Ui::CreateChild<WeekView>(_page, actions);
	_side = Ui::CreateChild<DayIsland>(this, actions, [=](int delta) {
		pickDay(planner::addDays(_picked, delta));
	});
	_toast = Ui::CreateChild<Toast>(this, [=] { undo(); });

	_localToastTimer.setSingleShot(true);
	QObject::connect(&_localToastTimer, &QTimer::timeout, [=] {
		_localToast = QString();
		refresh();
	});
	scheduleMidnight();

	// Высота содержимого меняется — прокрутка перемеряется
	_holder->heightValue() | rpl::on_next([=] {
		_holder->update();
	}, lifetime());

	Sections::PlannerValue() | rpl::on_next([=](ViewPtr view) {
		apply(std::move(view));
	}, lifetime());
}

Actions PlannerScreen::makeActions() {
	auto result = Actions();
	result.pickDay = [=](std::string day) { pickDay(day); };
	result.openTask = [=](std::string id, std::string day) { openTask(id, day); };
	result.openEvent = [=](std::string id, std::string day) { openEvent(id, day); };
	result.createForDay = [=](std::string day) { createForDay(day); };
	// Нажатие на свободное время в сетке: новое дело на этот день (время начала полная форма не принимает)
	result.createAt = [=](std::string day, int) { createForDay(day); };
	result.openSleep = [=](std::string day) {
		pickDay(day);
		ShowSection(Section::Health);
	};
	result.quick = [=](QString text) { openQuick(text); };
	result.toast = [=](QString text) { showToast(text); };
	result.openCalendar = [=] {
		_view = u"calendar"_q;
		refresh();
	};
	result.openHealth = [=] { ShowSection(Section::Health); };
	result.moveTask = [=](std::string key, std::string day) { moveTask(key, day); };
	result.openMonth = [=](std::string day) {
		_picked = day;
		switchSegment(u"month"_q);
	};
	result.openNote = [=](QString title) { OpenKnowledgeNote(title); }; // [[заметка]] — открыть (создать) в «Знаниях»
	result.sheetHost = [=]() -> QWidget* { return this; };
	return result;
}

void PlannerScreen::scheduleMidnight() {
	// Смена суток при открытом «Плане»: «сегодня» и завершённость вчерашнего дня обновляются сами
	_midnight.setSingleShot(true);
	QObject::connect(&_midnight, &QTimer::timeout, [=] {
		const auto was = _today;
		_today = TodayKey();
		if (_picked == was) {
			_picked = _today;
		}
		refresh();
		_midnight.start(MsUntilTomorrow());
	});
	_midnight.start(MsUntilTomorrow());
}

void PlannerScreen::apply(ViewPtr view) {
	_data = std::move(view);
	refresh();
}

void PlannerScreen::pickDay(const std::string &day) {
	if (day.empty()) {
		return;
	}
	_picked = day;
	refresh();
}

void PlannerScreen::changePeriod(int delta) {
	pickDay(planner::shiftPeriod(isCalendar() ? S(_calendarView) : std::string("day"), _picked, delta));
}

void PlannerScreen::switchSegment(const QString &segment) {
	if (segment == u"today"_q) {
		_view = u"today"_q;
	} else {
		_view = u"calendar"_q;
		_calendarView = segment;
		SavedCalendarView() = segment;
	}
	refresh();
}

void PlannerScreen::toggleLayer(const QString &layer) {
	if (layer == u"sleep"_q) {
		_layers.sleep = !_layers.sleep;
	} else if (layer == u"food"_q) {
		_layers.food = !_layers.food;
	} else {
		_layers.work = !_layers.work;
	}
	SavedLayers() = _layers;
	refresh();
}

void PlannerScreen::openTask(const std::string &taskId, const std::string &day) {
	if (!_data) {
		return;
	}
	const auto &tasks = _data->state.tasks;
	const auto i = std::find_if(tasks.begin(), tasks.end(), [&](const planner::Task &task) {
		return task.id == taskId;
	});
	const auto isRepeat = (i != tasks.end()) && i->repeat.has_value();
	const auto target = !day.empty() ? day : (i != tasks.end() ? i->day.value_or(std::string()) : std::string());
	if (!target.empty()) {
		pickDay(target);
	}
	PlannerUi::OpenTaskEditor(_controller, taskId, isRepeat ? day : std::string());
}

void PlannerScreen::openEvent(const std::string &eventId, const std::string &day) {
	if (!_data) {
		return;
	}
	const auto &events = _data->state.events;
	const auto i = std::find_if(events.begin(), events.end(), [&](const planner::Event &event) {
		return event.id == eventId;
	});
	const auto isRepeat = (i != events.end()) && i->repeat.has_value();
	PlannerUi::OpenEventEditor(_controller, eventId, day, isRepeat ? day : std::string());
}

void PlannerScreen::createForDay(const std::string &day) {
	pickDay(day);
	PlannerUi::OpenTaskEditor(_controller, std::string(), day);
}

void PlannerScreen::moveTask(const std::string &taskKey, const std::string &day) {
	// Перетаскивание экземпляра ряда на другой день — «только это» (отделение)
	if (!_data) {
		return;
	}
	const auto at = taskKey.find('@');
	const auto taskId = taskKey.substr(0, at);
	const auto fromDay = (at == std::string::npos) ? std::string() : taskKey.substr(at + 1);
	const auto &tasks = _data->state.tasks;
	const auto i = std::find_if(tasks.begin(), tasks.end(), [&](const planner::Task &task) {
		return task.id == taskId;
	});
	if (i == tasks.end() || i->day == day || (i->repeat && fromDay.empty()) || fromDay == day) {
		return;
	}
	const auto isRepeat = i->repeat.has_value();
	Sections::UpdatePlanner([=](planner::State &state) {
		if (isRepeat) {
			auto patch = planner::ItemPatch();
			patch.day = std::optional<std::string>(day);
			planner::detachInstance(state, planner::SeriesKind::Task, taskId, fromDay, patch, planner::randomUuid);
		} else if (const auto task = planner::findTask(state, taskId)) {
			task->day = day;
		}
	}, tr::lng_parvane_planner_notice_moved(tr::now, lt_date, FormatDay(day), lt_name, Q(i->name)));
}

void PlannerScreen::openQuick(const QString &text) {
	if (!_data || !_data->isLoaded) {
		return;
	}
	OpenQuickInput(this, QuickArgs{
		.initialText = text,
		.today = _today,
		.created = [=](std::string day) {
			if (!day.empty()) {
				pickDay(day);
			}
		},
		.more = [=] { createForDay(_picked); },
	});
}

void PlannerScreen::showToast(const QString &text) {
	_localToast = text;
	_localToastTimer.start(kToastMs);
	refresh();
}

void PlannerScreen::undo() {
	Sections::UndoPlanner(tr::lng_parvane_planner_notice_undone(tr::now));
}

void PlannerScreen::keyPressEvent(QKeyEvent *e) {
	if (e->matches(QKeySequence::Undo)) {
		undo();
		return;
	}
	RpWidget::keyPressEvent(e);
}

void PlannerScreen::refresh() {
	const auto hasData = (_data != nullptr);
	const auto isLoaded = hasData && _data->isLoaded;
	const auto hasContent = hasData && (_data->isLoaded || _data->isCached);
	const auto calendar = isCalendar();
	const auto isWeek = calendar && _calendarView == u"week"_q;
	const auto isMonth = (_calendarView == u"month"_q);

	// Шапка
	auto bar = PeriodBar::State();
	bar.isToday = !calendar;
	bar.title = (isWeek ? FormatWeekRange(_picked) : FormatPeriod(S(_calendarView), _picked));
	bar.prevLabel = isMonth ? tr::lng_parvane_planner_prev_month(tr::now) : tr::lng_parvane_planner_prev_period(tr::now);
	bar.nextLabel = isMonth ? tr::lng_parvane_planner_next_month(tr::now) : tr::lng_parvane_planner_next_period(tr::now);
	bar.picked = _picked;
	bar.today = _today;
	bar.segment = calendar ? _calendarView : u"today"_q;
	bar.layers = _layers;
	_bar->setState(bar);

	// spec 010: строка состояния синхронизации — только когда есть что сказать
	auto notice = QString();
	if (hasData) {
		const auto &status = _data->status;
		notice = (!isLoaded && _data->isCached) ? tr::lng_parvane_planner_showing_saved(tr::now)
			: (status == "needs-linking") ? tr::lng_parvane_planner_needs_linking(tr::now)
			: (status == "offline") ? tr::lng_parvane_planner_sync_unavailable(tr::now)
			: (status == "no-key") ? tr::lng_parvane_planner_sync_pending(tr::now)
			: (_data->sizeBytes > kSnapshotWarnBytes) ? tr::lng_parvane_planner_near_limit(tr::now)
			: QString();
	}
	_notice->setText(notice);

	// Вид
	_todayView->setVisible(hasContent && !calendar);
	_month->setVisible(hasContent && calendar && isMonth);
	_year->setVisible(hasContent && calendar && _calendarView == u"year"_q);
	_agenda->setVisible(hasContent && calendar && _calendarView == u"agenda"_q);
	_week->setVisible(hasContent && isWeek);
	_scroll->setVisible(!(hasContent && isWeek));
	_loading->setVisible(!hasContent);
	auto current = hasContent ? (Ui::RpWidget*)nullptr : (Ui::RpWidget*)_loading;
	if (hasContent) {
		if (!calendar) {
			_todayView->setData(_data, _picked, _today);
			current = _todayView;
		} else if (isMonth) {
			_month->setData(_data, _picked, _today, _layers);
			current = _month;
		} else if (_calendarView == u"year"_q) {
			_year->setData(_data, _picked, _today);
			current = _year;
		} else if (_calendarView == u"agenda"_q) {
			_agenda->setData(_data, _picked, _today);
			current = _agenda;
		} else {
			_week->setData(_data, _picked, _today, _layers);
		}
	}
	_holder->setCurrent(current);

	// Правая панель дня — у календаря, кроме «Списка»
	const auto sideShown = hasContent && calendar && _calendarView != u"agenda"_q;
	_side->setVisible(sideShown);
	if (sideShown) {
		_side->setData(_data, _picked, _today, _layers);
	}

	// Уведомление: правка «Плана» с «Отменить» либо своё сообщение
	if (!_localToast.isEmpty()) {
		_toast->setNotice(_localToast, false);
	} else if (hasData && _data->notice) {
		_toast->setNotice(Q(_data->notice->text), _data->notice->canUndo);
	} else {
		_toast->setNotice(QString(), false);
	}
	relayout();
	update();
}

void PlannerScreen::relayout() {
	// `.root`: поля 0.5rem 0.5rem 0.5rem 0; `.body`: промежуток 0.5rem; правая панель 23.75rem (20rem до 1240px)
	const auto margin = Kit::Rem(0.5);
	const auto area = rect().marginsRemoved({ 0, margin, margin, margin });
	const auto sideWidth = _side->isVisible()
		? ((width() <= kNarrowSideWidth) ? Kit::Rem(20) : Kit::Rem(23.75))
		: 0;
	const auto pageWidth = std::max(area.width() - (sideWidth ? sideWidth + margin : 0), 0);
	_page->setGeometry(area.x(), area.y(), pageWidth, area.height());
	if (sideWidth) {
		_side->setGeometry(area.x() + pageWidth + margin, area.y(), sideWidth, area.height());
	}
	const auto inner = _page->innerRect();
	_bar->resizeToWidth(inner.width());
	_bar->move(inner.topLeft());
	auto top = inner.y() + _bar->height();
	if (_notice->isVisible()) {
		_notice->resizeToWidth(inner.width());
		_notice->move(inner.x(), top);
		top += _notice->height();
	}
	const auto content = QRect(inner.x(), top, inner.width(), std::max(inner.bottom() + 1 - top, 0));
	// Сетка недели листается сама, шапки дней стоят на месте (`.contentFlush`)
	_week->setGeometry(content.marginsRemoved({ 0, 0, 0, Kit::Rem(0.5) }));
	_scroll->setGeometry(content);
	// Маскот — по центру видимой части (web `.Loading { height: 100% }`; `Holder` даёт поля 1.25rem)
	_loading->setNaturalHeight(content.height() - 2 * Kit::Rem(1.25));
	_holder->resizeToWidth(content.width());
	_toast->relayout();
}

void PlannerScreen::resizeEvent(QResizeEvent *e) {
	relayout();
}

void PlannerScreen::paintEvent(QPaintEvent *e) {
	auto p = QPainter(this);
	p.fillRect(e->rect(), ToneColor(Tone::Bg));
}

} // namespace

void RegisterPlannerViews() {
	RegisterSectionFactory(Section::Calendar, [](
			not_null<QWidget*> parent,
			not_null<Window::SessionController*> controller,
			Section section) {
		return object_ptr<Ui::RpWidget>(object_ptr<PlannerScreen>(parent.get(), controller));
	});
}

} // namespace Parvane
