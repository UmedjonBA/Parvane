// Parvane fork: набор виджетов разделов «Пространство» (spec 029, T060) — порт web
// `components/parvane/notes/PvKit.module.scss` и общих деталей `planner/Planner.module.scss`: остров и шапка,
// вкладки-сегменты, кнопки (`.ib`, `.pill`, `.btn`), чипы, строки списка, аватарки-буквы, подписи, карточки,
// полоса прогресса, круглая галочка, метки, образцы цвета, поля ввода, шторка, меню, ручка ширины панели.
// Цвета — только тона Parvane::ToneColor (аналог `--pv-*`), перерисовка по TonesChanges(); значки — ParvaneIcon
// (parvane_icons.h); размеры — из scss (1rem = 16 px) с учётом масштаба интерфейса. Текстов UI в наборе нет:
// подписи и названия для озвучки передаёт вызывающий.
#pragma once

#include "parvane/parvane_space.h"
#include "ui/abstract_button.h"
#include "ui/rp_widget.h"
#include "ui/style/style_core_types.h"
#include "base/object_ptr.h"
#include "base/unique_qptr.h"

#include <rpl/variable.h>

#include <optional>

class QPainter;

namespace Ui {
class InputField;
class PopupMenu;
class ScrollArea;
class VerticalLayout;
} // namespace Ui

namespace Parvane::Kit {

// ── основа ───────────────────────────────────────────────────────────────────

// Пиксели web (1rem = 16 px) → пиксели интерфейса с учётом масштаба.
[[nodiscard]] int Px(int px);
[[nodiscard]] int Rem(double rem);

// Шрифт размера px web: обычный/полужирный, моноширинный — JetBrains Mono (`--font-family-monospace`).
[[nodiscard]] style::font Font(int px, bool semibold = false, bool mono = false);

// Основной размер текста разделов (`.root`/`.sheet`: 0.9375rem).
inline constexpr auto kBodyPx = 15;

// `color-mix(in srgb, <тон> N%, transparent)`.
[[nodiscard]] QColor Mix(QColor color, double share);
[[nodiscard]] QColor Mix(Tone tone, double share);

// Перерисовывать виджет при смене схемы или режима.
void RepaintOnTones(not_null<Ui::RpWidget*> widget);

// Кружок цвета (`.dot`, `.chipDot`): 0.5rem.
void PaintDot(QPainter &p, QPoint center, QColor color, int size = 0);

// Аватар-буква (`.ava`): квадрат со скруглением 0.625rem (или круг), моноширинная буква тоном на его 22 %.
enum class AvatarSize {
	Large, // `.ava` 2.5rem
	Medium, // `.avaM` 2.25rem
	Small, // `.avaS` 2rem
};
struct Avatar {
	QString text; // одна-две буквы
	Tone tone = Tone::Yellow; // `--c`, по умолчанию `--pv-note`
	AvatarSize size = AvatarSize::Large;
	bool round = false; // `.avaRound`
};
[[nodiscard]] int AvatarSide(AvatarSize size);
void PaintAvatar(QPainter &p, QPoint topLeft, const Avatar &avatar);

// Кнопка набора: наведение, нажатие, кольцо фокуса с клавиатуры (`:focus-visible`), рука, имя для озвучки.
class Button : public Ui::AbstractButton {
public:
	explicit Button(QWidget *parent);

	void setAccessibleName(const QString &name);
	QString accessibilityName() override;

protected:
	void onStateChanged(State was, StateChangeSource source) override;
	void focusInEvent(QFocusEvent *e) override;
	void focusOutEvent(QFocusEvent *e) override;

	// Кольцо фокуса `outline: 2px solid --pv-accent` по контуру кнопки (внутри границ виджета).
	void paintFocusRing(QPainter &p, QRectF rect, double radius) const;
	[[nodiscard]] bool focusVisible() const {
		return _focusVisible;
	}

private:
	QString _accessibleName;
	bool _focusVisible = false;

};

// ── остров и шапка ───────────────────────────────────────────────────────────

// `.island`: панель `--pv-panel` со скруглением 1.5rem и лёгкой тенью. Содержимое размещает владелец внутри
// innerRect(); углы не обрезаются, поэтому дети не должны заливать фон до края.
class Island : public Ui::RpWidget {
public:
	explicit Island(QWidget *parent, int radius = 0); // 0 — `--border-radius-island`

	[[nodiscard]] QRect innerRect() const;
	void setRadius(int radius); // для `--planner-island-radius` и т. п.

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	int _radius = 0;

};

// `.hdr`: строка шапки (мин. высота 3.75rem, поля 0.75rem 1.125rem, промежуток 0.875rem, линия снизу).
// Слева — название (`.hdrTitle` 1.25rem / `.hdrSmall` 1rem), затем элементы по порядку; addStretch() — `.grow`.
class Header : public Ui::RpWidget {
public:
	enum class TitleSize {
		Large, // `.hdrTitle`
		Small, // `.hdrSmall`
	};
	explicit Header(QWidget *parent, const QString &title = QString(), TitleSize size = TitleSize::Large);

	void setTitle(const QString &title);
	void setTitleSize(TitleSize size);

	// Элемент шапки с его собственной шириной.
	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addItem(std::move(child), 0, 0));
	}
	// Сжимаемый элемент (`flex: 0 1 <basis>; min-width: <min>`) — например, поле поиска `.hdrSearch`.
	template <typename Widget>
	Widget *addShrinkable(object_ptr<Widget> &&child, int basis, int minWidth) {
		return static_cast<Widget*>(addItem(std::move(child), basis, minWidth));
	}
	void addStretch(); // `.grow`

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	struct Item {
		Ui::RpWidget *widget = nullptr; // nullptr — растяжка
		int basis = 0; // 0 — своя ширина
		int minWidth = 0;
	};
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child, int basis, int minWidth);
	void relayout();
	[[nodiscard]] int titleWidth() const;
	[[nodiscard]] style::font titleFont() const;

	QString _title;
	TitleSize _titleSize = TitleSize::Large;
	std::vector<Item> _items;

};

// ── кнопки ───────────────────────────────────────────────────────────────────

// `.ib`: круглая кнопка со значком 2.25rem (`.ibSmall` 1.75rem, `.ibAccent` — заливка акцентом).
class IconButton final : public Button {
public:
	enum class Kind {
		Normal,
		Small,
		Accent,
	};
	IconButton(QWidget *parent, const QString &icon, const QString &accessibleName, Kind kind = Kind::Normal);

	void setIcon(const QString &icon);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _icon;
	Kind _kind = Kind::Normal;

};

// `.pill`: пилюля 2.125rem со значком и подписью; `.pillAcc` — акцентная.
class Pill final : public Button {
public:
	Pill(QWidget *parent, const QString &text, const QString &icon = QString(), bool accent = false);

	void setText(const QString &text);
	void setIcon(const QString &icon);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();

	QString _text;
	QString _icon;
	bool _accent = false;

};

// `.btn` (2.25rem, скругление 0.5rem) и варианты `.btnAcc`, `.btnGhost`, `.btnDanger`; setWide — `.btnWide`
// (вся ширина, подпись по центру; в «Плане» — `justify-content: flex-start`, см. setWideAlign).
class PushButton final : public Button {
public:
	enum class Kind {
		Normal,
		Accent,
		Ghost,
		Danger,
	};
	PushButton(QWidget *parent, const QString &text, Kind kind = Kind::Normal, const QString &icon = QString());

	void setText(const QString &text);
	void setIcon(const QString &icon);
	void setKind(Kind kind);
	void setWide(bool wide, bool alignStart = false);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();
	[[nodiscard]] int contentWidth() const;

	QString _text;
	QString _icon;
	Kind _kind = Kind::Normal;
	bool _wide = false;
	bool _alignStart = false;

};

// Кнопка-ссылка (`.linkButton` «Плана»): подчёркнутый текст `--pv-purple`.
class LinkButton final : public Button {
public:
	LinkButton(QWidget *parent, const QString &text, int fontPx = kBodyPx);

	void setText(const QString &text);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _text;
	int _fontPx = kBodyPx;

};

// ── вкладки-сегменты ─────────────────────────────────────────────────────────

// `.seg` / `.segItem` / `.segItemOn`: ряд вкладок на подложке `--pv-raised`; активная — `--pv-panel` с тенью.
// Стрелки влево/вправо переключают вкладку с клавиатуры.
class Segments final : public Ui::RpWidget {
public:
	Segments(QWidget *parent, std::vector<QString> labels, int active = 0);

	void setLabels(std::vector<QString> labels);
	void setActive(int index);
	[[nodiscard]] int active() const;
	[[nodiscard]] rpl::producer<int> activeValue() const; // текущая и все смены
	[[nodiscard]] rpl::producer<int> activated() const; // выбор пользователем

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	class Item;
	void rebuild(std::vector<QString> labels);
	void relayout();
	void choose(int index);

	std::vector<Item*> _items;
	rpl::variable<int> _active = 0;
	rpl::event_stream<int> _activated;

};

// ── чипы ─────────────────────────────────────────────────────────────────────

// `.chip`: чип 1.875rem в рамке `--pv-line2`; `.chipOn` — цвет тона (по умолчанию акцент) на его 22 %.
// С точкой (`.dot`/`.chipDot`) или значком слева.
class Chip final : public Button {
public:
	struct Descriptor {
		QString text;
		std::optional<Tone> tone; // `--c` / `--planner-kind`; пусто — акцент
		bool dot = false;
		QString icon;
		bool toggleOnClick = false; // нажатие само переключает «включён»
	};
	Chip(QWidget *parent, Descriptor descriptor);

	void setText(const QString &text);
	void setOn(bool on);
	[[nodiscard]] bool isOn() const;
	[[nodiscard]] rpl::producer<bool> onValue() const;

	QAccessible::Role accessibilityRole() override;
	Ui::AccessibilityState accessibilityState() const override;

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();
	[[nodiscard]] QColor toneColor() const;

	Descriptor _descriptor;
	rpl::variable<bool> _on = false;

};

// `.chips`, `.sheetButtons`, `.swatches`, `.hscroll` без прокрутки: ряд с переносом и промежутком gap.
class Flow final : public Ui::RpWidget {
public:
	explicit Flow(QWidget *parent, int gap = 0); // 0 — 0.375rem

	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addItem(std::move(child)));
	}
	void clear();

protected:
	int resizeGetHeight(int newWidth) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child);

	std::vector<Ui::RpWidget*> _items;
	int _gap = 0;
	bool _inResize = false;

};

// ── строки списка ────────────────────────────────────────────────────────────

// `.row`: строка 2.75rem (поля 0.375rem 0.625rem, скругление 0.5rem, промежуток 0.75rem): значок или
// аватар, `.ttl` + `.sub`, справа `.meta` (моноширинный) и значок. `.rowSel` — выбрана, `.rowRed` — опасное.
class Row final : public Button {
public:
	struct Descriptor {
		QString title;
		QString subtitle;
		QString meta;
		QString icon; // слева, цвет `--pv-muted` (или красный у опасной)
		std::optional<Avatar> avatar; // вместо значка
		QString trailingIcon; // справа, например `right`
		bool danger = false;
	};
	Row(QWidget *parent, Descriptor descriptor);

	void setDescriptor(Descriptor descriptor);
	void setSelected(bool selected);
	[[nodiscard]] bool selected() const {
		return _selected;
	}

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Descriptor _descriptor;
	bool _selected = false;

};

// ── подписи ──────────────────────────────────────────────────────────────────

// Текст набора: `.muted`, `.faint`, `.small`, `.mono`, `.fieldError`, `.empty`, `.cardText`, `.hdrTitle` и т. п.
// Однострочный с многоточием или многострочный с переносом.
class Label final : public Ui::RpWidget {
public:
	struct Style {
		int px = kBodyPx;
		Tone tone = Tone::Fg;
		bool semibold = false;
		bool mono = false;
		bool multiline = false;
		style::align align = style::al_left;
	};
	Label(QWidget *parent, const QString &text, Style st);
	Label(QWidget *parent, const QString &text); // обычный текст `--pv-fg`

	void setText(const QString &text);
	void setTone(Tone tone);

	// Готовые стили по классам scss.
	[[nodiscard]] static Style Muted(); // `.muted`
	[[nodiscard]] static Style Faint(); // `.faint`
	[[nodiscard]] static Style Small(); // `.small` + `.muted`
	[[nodiscard]] static Style Mono(); // `.mono`
	[[nodiscard]] static Style Error(); // `.fieldError`
	[[nodiscard]] static Style CardText(); // `.cardText`
	[[nodiscard]] static Style Title(); // `.hdrTitle`
	[[nodiscard]] static Style SmallTitle(); // `.hdrSmall`

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	[[nodiscard]] style::font font() const;

	QString _text;
	Style _st;

};

// Подписи моноширинными заглавными (`letter-spacing: 0.06em`, `--pv-muted`): `.grp`, `.caps`, `.cardTitle`,
// `.groupTitle` «Плана».
class Caps final : public Ui::RpWidget {
public:
	enum class Kind {
		Group, // `.grp`: 0.75rem, поля 0.75rem 0.25rem 0.25rem
		Caps, // `.caps`: 0.75rem
		CardTitle, // `.cardTitle`: 0.8125rem
	};
	Caps(QWidget *parent, const QString &text, Kind kind = Kind::Caps);

	void setText(const QString &text);
	void setCount(const QString &count); // `.groupCount`: обычным начертанием после текста

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	[[nodiscard]] QFont capsFont(bool semibold) const;
	[[nodiscard]] QMargins padding() const;

	QString _text;
	QString _count;
	Kind _kind = Kind::Caps;

};

// `.empty`: пустое состояние — приглушённый текст по центру, не шире 36ch, поля 2.5rem сверху и снизу.
class Empty final : public Ui::RpWidget {
public:
	Empty(QWidget *parent, const QString &text);

	void setText(const QString &text);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	[[nodiscard]] QRect textRect(int width) const;

	QString _text;

};

// ── карточка ─────────────────────────────────────────────────────────────────

// `.card` (поля 1rem, скругление 0.75rem, `--pv-raised`) с необязательной `.cardHead`: `.cardTitle` слева,
// справа `.cardNote` или свой виджет. Содержимое — body() (столбец с промежутком 0.875rem, как `.stack`).
class Card final : public Ui::RpWidget {
public:
	Card(QWidget *parent, const QString &title = QString(), const QString &note = QString());

	[[nodiscard]] not_null<Ui::VerticalLayout*> body() const;
	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addItem(std::move(child)));
	}
	void setHeadWidget(object_ptr<Ui::RpWidget> widget); // справа в шапке вместо `.cardNote`

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child);
	[[nodiscard]] int headHeight() const;

	Caps *_title = nullptr;
	Label *_note = nullptr;
	Ui::RpWidget *_headWidget = nullptr;
	Ui::VerticalLayout *_body = nullptr;

};

// ── «План»: прогресс, галочка, метки, образцы цвета ──────────────────────────

// `.prog` / `.progFill`: полоса 0.375rem (`.progThin` 0.25rem, `.progThick` 0.5rem) на `--pv-line`.
class Progress final : public Ui::RpWidget {
public:
	enum class Thickness {
		Thin,
		Normal,
		Thick,
	};
	explicit Progress(QWidget *parent, Thickness thickness = Thickness::Normal, Tone tone = Tone::Accent);

	void setValue(double value); // 0…1
	void setTone(Tone tone);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	Thickness _thickness = Thickness::Normal;
	Tone _tone = Tone::Accent;
	double _value = 0.;

};

// `.check`: круглая галочка 1.375rem (`.checkSmall` 1.25rem); отмечена — заливка тоном (`--pv-task` = фиолетовый,
// `.checkGreen` — зелёный) и галочка `--pv-accent-ink`. Нажатие переключает.
class Check final : public Button {
public:
	Check(QWidget *parent, const QString &accessibleName, bool checked = false, bool isSmall = false, Tone tone = Tone::Purple);

	void setChecked(bool checked);
	[[nodiscard]] bool checked() const;
	[[nodiscard]] rpl::producer<bool> checkedChanges() const; // только смены пользователем и setChecked

	QAccessible::Role accessibilityRole() override;
	Ui::AccessibilityState accessibilityState() const override;

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	bool _small = false;
	Tone _tone = Tone::Purple;
	rpl::variable<bool> _checked = false;

};

// Метки «Плана»: `.tag` (0.75rem, тон на 18 %), `.tagLarge`, `.typePill` (1.75rem, тон на 20 %). Со значком;
// clickable — `.tagButton` (наведение — 30 %); done — `.tagDone` (прозрачность 0.6).
class Tag final : public Button {
public:
	enum class Kind {
		Small, // `.tag`
		Large, // `.tagLarge`
		TypePill, // `.typePill`
	};
	struct Descriptor {
		QString text;
		Tone tone = Tone::Accent;
		Kind kind = Kind::Small;
		QString icon;
		bool clickable = false;
		bool done = false;
	};
	Tag(QWidget *parent, Descriptor descriptor);

	void setText(const QString &text);
	void setDone(bool done);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();
	[[nodiscard]] int fontPx() const;
	[[nodiscard]] int iconSize() const;
	[[nodiscard]] QMargins padding() const;

	Descriptor _descriptor;

};

// `.swatch`: круг 1.75rem цвета списка в кольце `--pv-panel`; пустой — `.swatchNone`; выбран — `.swatchActive`.
class Swatch final : public Button {
public:
	Swatch(QWidget *parent, std::optional<Tone> tone, const QString &accessibleName);

	void setActive(bool active);
	[[nodiscard]] bool active() const {
		return _active;
	}

	Ui::AccessibilityState accessibilityState() const override;

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	std::optional<Tone> _tone;
	bool _active = false;

};

// ── поля ввода ───────────────────────────────────────────────────────────────

// Ui::InputField со стилем набора:
//   Input        — `.input` (2.625rem, рамка `--pv-line2`, скругление 0.5rem, фон `--pv-panel`);
//   Search       — `.search` + `.searchInput` (2.625rem, пилюля `--pv-raised`, лупа слева, рамка — при фокусе);
//   HeaderSearch — `.hdrSearch` + `.hdrSearchInput` (2.25rem, для Header::addShrinkable);
//   Textarea     — `.textarea` (многострочное, от 7.5rem, моноширинный 0.875rem, межстрочный 1.6).
// Рамка при фокусе — `--pv-accent`, при setError — `--pv-red`. Плейсхолдер — `--pv-faint`.
class Field final : public Ui::RpWidget {
public:
	enum class Kind {
		Input,
		Search,
		HeaderSearch,
		Textarea,
	};
	Field(QWidget *parent, Kind kind, rpl::producer<QString> placeholder, const QString &value = QString());
	~Field();

	[[nodiscard]] not_null<Ui::InputField*> input() const;
	[[nodiscard]] QString text() const;
	void setText(const QString &text);
	void setError(bool error);
	void setFocusFast();

	[[nodiscard]] rpl::producer<QString> textChanges() const;
	[[nodiscard]] rpl::producer<> submits() const; // Enter (в многострочном — Ctrl+Enter)
	[[nodiscard]] rpl::producer<> cancels() const; // Escape

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	struct Styles;
	void refreshColors();
	[[nodiscard]] int searchIconLeft() const;

	const Kind _kind;
	std::unique_ptr<Styles> _styles; // поле удаляется в ~Field() раньше стиля
	object_ptr<Ui::InputField> _input = { nullptr };
	bool _error = false;

};

// ── шторка ───────────────────────────────────────────────────────────────────

// `.sheet` / `.scrim` + `.sheetPane`: затемнение `rgb(0 0 0 / 45%)` поверх parent и окно по центру сверху
// (отступ 10 % высоты, ширина до 35rem — wide: 56rem, высота до 80 %, скругление 1.125rem, `--pv-panel`).
// Шапка — `.sheetHead` + `.sheetTitle` (1.125rem) и кнопка закрытия; содержимое — столбец с промежутком
// 0.875rem (`tight` — 0.125rem) в прокрутке; `.sheetButtons` — addButtons(). Escape и щелчок по затемнению
// закрывают. Окно удаляет себя после закрытия.
class Sheet final : public Ui::RpWidget {
public:
	struct Descriptor {
		QString title;
		QString closeName; // имя кнопки закрытия для озвучки; пусто — без кнопки
		bool wide = false; // `.sheetWide`
		bool tight = false; // `.sheetTight`
		bool closeByScrim = true;
	};
	Sheet(not_null<QWidget*> parent, Descriptor descriptor);
	~Sheet();

	static not_null<Sheet*> Show(not_null<QWidget*> parent, Descriptor descriptor);

	void setTitle(const QString &title);
	template <typename Widget>
	Widget *add(object_ptr<Widget> &&child) {
		return static_cast<Widget*>(addItem(std::move(child)));
	}
	[[nodiscard]] not_null<Flow*> addButtons(); // `.sheetButtons`: ряд с промежутком 0.5rem
	[[nodiscard]] not_null<Ui::VerticalLayout*> content() const;

	void showSheet(); // показать поверх соседей и взять фокус
	void requestClose();
	[[nodiscard]] rpl::producer<> closed() const;

protected:
	void paintEvent(QPaintEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;

private:
	Ui::RpWidget *addItem(object_ptr<Ui::RpWidget> child);
	void relayout();
	[[nodiscard]] QRect paneRect() const;
	[[nodiscard]] int headHeight() const;

	Descriptor _descriptor;
	IconButton *_close = nullptr;
	Ui::ScrollArea *_scroll = nullptr;
	Ui::VerticalLayout *_content = nullptr;
	rpl::event_stream<> _closed;
	bool _closing = false;

};

// ── меню ─────────────────────────────────────────────────────────────────────

// Всплывающее меню (Ui::PopupMenu) в тонах набора: фон `--pv-panel`, наведение `--pv-hover`, текст `--pv-fg`.
// Очистить раскладку и удалить её строки. `Ui::VerticalLayout::clear()` строки только отвязывает: у виджета с
// родителем `object_ptr` не удаляет его, и прежние строки остаются видимыми (наложение при перестройке)
void ClearLayout(not_null<Ui::VerticalLayout*> layout);

[[nodiscard]] base::unique_qptr<Ui::PopupMenu> CreateMenu(QWidget *parent);

// Пункт меню: значок ParvaneIcon слева (необязательно), подпись; danger — красным (`.rowRed`).
void AddMenuAction(
	not_null<Ui::PopupMenu*> menu,
	const QString &text,
	Fn<void()> callback,
	const QString &icon = QString(),
	bool danger = false);

// ── ручка ширины панели ──────────────────────────────────────────────────────

// `.resizer` (`PvResizer`): полоса 0.625rem с курсором «↔»; при наведении, перетаскивании и фокусе — линия
// 0.125rem акцентом с прозрачностью 0.7. Стрелки с клавиатуры двигают на 1rem.
class Resizer final : public Ui::RpWidget {
public:
	Resizer(QWidget *parent, const QString &accessibleName);

	// Сдвиг от начала перетаскивания (в px интерфейса); finished — конец перетаскивания.
	[[nodiscard]] rpl::producer<int> moves() const;
	[[nodiscard]] rpl::producer<> finished() const;

	QAccessible::Role accessibilityRole() override;
	QString accessibilityName() override;

protected:
	void paintEvent(QPaintEvent *e) override;
	void enterEventHook(QEnterEvent *e) override;
	void leaveEventHook(QEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;
	void focusInEvent(QFocusEvent *e) override;
	void focusOutEvent(QFocusEvent *e) override;

private:
	QString _accessibleName;
	rpl::event_stream<int> _moves;
	rpl::event_stream<> _finished;
	std::optional<int> _pressX;
	bool _over = false;
	bool _focused = false;

};

} // namespace Parvane::Kit
