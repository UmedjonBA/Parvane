// Parvane fork: общее для видов «Плана» на desktop (spec 029, T061) — подписи дат и длительностей в языке
// интерфейса (порт web `plannerFormat.ts` поверх QLocale), цвета видов записей и групп, холст с нажимаемыми
// областями (виды месяца, недели, года, ленты дня рисуются целиком — как блоки web), метки `.tag`, название с
// ссылками `[[заметка]]` (web PlannerName) и связь видов с оболочкой раздела (`Actions`).
#pragma once

#include "parvane/parvane_kit.h"
#include "parvane/parvane_sections_data.h"

#include <parvane/sections/planner_model.h>

#include <QtCore/QDate>

#include <functional>
#include <memory>
#include <string>

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::PlannerViews {

namespace planner = parvane::sections::planner;
using ViewPtr = std::shared_ptr<const Sections::PlannerView>;

// ── подписи (web plannerFormat.ts) ───────────────────────────────────────────

[[nodiscard]] QDate DateOf(const std::string &day);
[[nodiscard]] std::string DayKey(const QDate &date);
[[nodiscard]] std::string TodayKey();
[[nodiscard]] int NowMinutes();

[[nodiscard]] QString Q(const std::string &text);
[[nodiscard]] std::string S(const QString &text);

[[nodiscard]] QString FormatDay(const std::string &day);       // «12 октября»
[[nodiscard]] QString FormatDayShort(const std::string &day);  // «12 окт»
[[nodiscard]] QString FormatDayLong(const std::string &day);   // «Понедельник, 12 октября»
[[nodiscard]] QString FormatDayLabel(const std::string &day);  // «Пн, 12 октября»
[[nodiscard]] QString FormatRelativeDay(const std::string &day, const std::string &today);
[[nodiscard]] QString FormatMonth(int year, int month);        // «Октябрь 2026»
[[nodiscard]] QString FormatMonthShort(int month);             // «Окт»
[[nodiscard]] QString FormatMonthName(int month);              // «Октябрь»
// Понедельник — первым; `index` 0…6
[[nodiscard]] QString FormatWeekday(int index, bool isLong = false);
// Индекс дня недели с понедельника (0 — понедельник)
[[nodiscard]] int MondayIndex(const std::string &day);
[[nodiscard]] QString FormatWeekRange(const std::string &day); // «12 окт – 18 окт»
// Заголовок периода вида: year | month | week | agenda | day
[[nodiscard]] QString FormatPeriod(const std::string &view, const std::string &day);
[[nodiscard]] QString FormatNumber(double value, int maximumFractionDigits = 1);
[[nodiscard]] QString FormatInt(long long value);
[[nodiscard]] QString FormatHours(double minutes);       // «4,5 ч»
[[nodiscard]] QString FormatHoursNumber(double minutes); // «4,5»
[[nodiscard]] QString FormatDuration(int minutes);       // «1 ч 30 мин»
[[nodiscard]] QString FormatSpan(double minutes);        // «6:46»
[[nodiscard]] QString FormatRemind(int minutes);
[[nodiscard]] QString FormatRepeat(const planner::Repeat &repeat);
[[nodiscard]] QString FormatStatus(const std::string &status);
[[nodiscard]] QString FormatProject(const std::string &project);
[[nodiscard]] QString FormatMeal(const std::string &meal);
// Название без разметки ссылок
[[nodiscard]] QString PlainName(const std::string &name);

// ── цвета ────────────────────────────────────────────────────────────────────

// Виды записей (`--planner-kind`): event, task, food, sleep, workout, due (красный), muted, metric
enum class Kind {
	Event,
	Task,
	Food,
	Sleep,
	Workout,
	Due,
	Muted,
	Metric,
};
[[nodiscard]] QColor KindColor(Kind kind);
// Цвет группы (`--color-peer-<n-1>`); 0 — нет цвета (невалидный QColor)
[[nodiscard]] QColor ListColor(int color);
// `--planner-color`: цвет группы, иначе цвет вида
[[nodiscard]] QColor EntryColor(int listColor, Kind kind);
// `color-mix(in srgb, color share, base)`
[[nodiscard]] QColor MixOver(QColor color, double share, QColor base);

// ── холст с нажимаемыми областями ────────────────────────────────────────────

// Вид, нарисованный целиком: draw() и меряет (p == nullptr), и рисует; во время рисования регистрирует области
// нажатия. Нажатие — по последней добавленной области под курсором (вложенные — поверх внешних).
class Canvas : public Ui::RpWidget {
public:
	explicit Canvas(QWidget *parent);

	void refresh(); // перемерить по текущей ширине и перерисовать

protected:
	struct Area {
		QRect rect;
		Fn<void()> click;
		Fn<void()> doubleClick;
		QString drag; // ключ перетаскивания (задача месяца); пусто — не тянется
	};

	virtual int draw(QPainter *p, int width) = 0;
	// Отпущено перетаскивание области с ключом `key` в точке `point`
	virtual void dropped(const QString &key, QPoint point) {
	}

	void area(QRect rect, Fn<void()> click, Fn<void()> doubleClick = nullptr, const QString &drag = QString());
	[[nodiscard]] bool over(QRect rect) const;
	[[nodiscard]] std::optional<QPoint> mouse() const {
		return _mouse;
	}

	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void mouseDoubleClickEvent(QMouseEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	[[nodiscard]] int areaAt(QPoint point) const;

	std::vector<Area> _areas;
	std::optional<QPoint> _mouse;
	std::optional<QPoint> _pressAt;
	QString _pressDrag;
	bool _dragging = false;

};

// ── рисование ────────────────────────────────────────────────────────────────

// Текст в одну строку с многоточием; возвращает ширину нарисованного
int DrawElided(QPainter *p, const style::font &font, QColor color, int x, int baseline, const QString &text, int maxWidth);
// Текст с переносом не больше `maxLines` строк; возвращает высоту
int DrawWrapped(QPainter *p, const style::font &font, QColor color, QRect rect, const QString &text, int maxLines,
	int lineHeight = 0);

// Подпись моноширинными заглавными (`.cardTitle`, `.groupTitle`, `.statLabel`): возвращает ширину
int DrawCaps(QPainter *p, int px, QColor color, int x, int baseline, const QString &text, int maxWidth,
	bool semibold = true);

// Метка `.tag` / `.tagLarge`: цвет на 18 % (у кнопки под курсором — 30 %), значок слева. Возвращает размер
struct TagLook {
	QColor color;
	bool large = false;
	bool done = false; // `.tagDone`: прозрачность 0.6
	QString icon;
	double share = 0.18;
};
[[nodiscard]] QSize TagSize(const TagLook &look, const QString &text, int maxWidth = 0);
void DrawTag(QPainter &p, QRect rect, const TagLook &look, const QString &text, bool hovered = false);

// Название с ссылками на заметки одной строкой: ссылки — `--pv-purple`, нажатие открывает «Знания»
struct NameLook {
	style::font font;
	QColor color;
	bool strike = false;
};
int DrawName(QPainter *p, const NameLook &look, int x, int baseline, int maxWidth, const std::string &name,
	const Fn<void(QRect, std::string)> &linkArea, bool onlyLinks = false);

// Значок web PvIcon по имени web (`previous`, `next`, `add`, `settings`, `flag`, `loop`, `darkmode`, `eats`, `clock`,
// `archive`, `sport`, `edit`, `close`, `up`, `down`…): недостающие в parvane_icons — свои контуры той же толщины
void PaintPlannerIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size);

// `.ib` (2.25rem, круг; `accent` — `.ibAccent`) со значком PaintPlannerIcon
class IconBtn final : public Kit::Button {
public:
	IconBtn(QWidget *parent, const QString &icon, const QString &accessibleName, bool accent = false);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _icon;
	bool _accent = false;

};

// Галочка `.check` (1.375rem, у `small` — 1.25rem)
void DrawCheck(QPainter &p, QRect rect, bool checked, QColor tone, bool hovered);

// ── связь с оболочкой ────────────────────────────────────────────────────────

struct Actions {
	Fn<void(std::string)> pickDay;
	// День экземпляра ряда ("" — разовая запись)
	Fn<void(std::string taskId, std::string day)> openTask;
	Fn<void(std::string eventId, std::string day)> openEvent;
	Fn<void(std::string day)> createForDay;
	Fn<void(std::string day, int start)> createAt;
	Fn<void(std::string day)> openSleep;
	Fn<void(QString text)> quick;
	Fn<void(QString text)> toast;
	Fn<void()> openCalendar;
	Fn<void()> openHealth;
	Fn<void(std::string taskKey, std::string day)> moveTask;
	Fn<void(std::string day)> openMonth;
	Fn<void(QString title)> openNote;
	// Виджет, поверх которого встают шторки (экран раздела)
	Fn<QWidget*()> sheetHost;
};

// Отметить задачу (или экземпляр ряда) выполненной — с уведомлением «Готово» / «Очередь»
void ToggleTaskDone(const planner::Task &task, bool done);

} // namespace Parvane::PlannerViews
