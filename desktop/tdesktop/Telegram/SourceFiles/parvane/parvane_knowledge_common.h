// Parvane fork: общее экранов раздела «Знания» (spec 029, T063) — порт мелочей web `notes/*.tsx`: строки UTF-8 ↔ Qt,
// тона папок и видов записей (`folderColor`, `--pv-task`/`--pv-event`), даты для показа (`displayTitle`,
// `formatDayShort`, `formatRepeat`), настройки раздела на устройстве (web localStorage: свёрнутые папки, папки графа,
// отметка справки, ширины панелей `parvanePanels`), текст с разметкой строки (жирный, курсив, код, теги, ссылки,
// [[заметки]]) и окна вопроса. Правки хранилища заметок — заданиями рабочего потока (Sections::Post/Ask).
#pragma once

#include "parvane/parvane_kit.h"
#include "parvane/parvane_sections_data.h"

#include <parvane/sections/markdown.h>
#include <parvane/sections/notes_model.h>
#include <parvane/sections/notes_planned.h>

#include "ui/text/text.h"

#include <optional>
#include <string>

namespace Parvane::Knowledge {

namespace notes = parvane::sections::notes;
namespace md = parvane::sections::markdown;
namespace planner = parvane::sections::planner;

// ── строки и тона ─────────────────────────────────────────────────────────────

[[nodiscard]] inline QString Q(const std::string &value) {
	return QString::fromStdString(value);
}
[[nodiscard]] inline std::string S(const QString &value) {
	return value.toStdString();
}

// Тон папки (web `folderColor`): заметки дня и без папки — `--pv-note`
[[nodiscard]] Tone FolderTone(const std::string &folder, bool isDaily = false);
// Тон записи «Плана»: задача — `--pv-task`, событие — `--pv-event`
[[nodiscard]] Tone KindTone(const std::string &kind);

// Название хранилища и папки заметок дня на языке интерфейса (web `KnowledgeVaultName` / `KnowledgeDailyFolder`)
[[nodiscard]] std::string VaultName();
[[nodiscard]] std::string DailyFolderName();
// Местные «сегодня» (YYYY-MM-DD) и минуты от полуночи
[[nodiscard]] std::string TodayKey();
[[nodiscard]] double NowMinutes();
[[nodiscard]] bool IsRussian();

// Название заметки для показа: у заметки дня — дата словами («пт, 17 октября»)
[[nodiscard]] QString DisplayTitle(const std::string &title, bool isDaily);
// Короткая дата «12 окт»
[[nodiscard]] QString FormatDayShort(const std::string &day);
// Повтор записи словами (web `formatRepeat`)
[[nodiscard]] QString FormatRepeat(const planner::Repeat &repeat);
// «срок 12 окт»
[[nodiscard]] QString FormatDue(const std::string &day);
// Подпись папки: корень — «Без папки», вложенная — «А / Б»
[[nodiscard]] QString FolderCaption(const std::string &path);
// Размер файла для карточки встроенного файла
[[nodiscard]] QString FormatSize(int64_t bytes);

// ── значки ────────────────────────────────────────────────────────────────────

// Значок web PvIcon (поле 24, обводка 1.8): своих контуров раздела в наборе ParvaneIcon нет — рисуются здесь
// (edit, trash, cal, left, up, down, x, dots, open, undo, minus, fit, board, file, graph, link); прочие — ParvaneIcon
void PaintNotesIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size);
// Имя значка для кнопок набора (они рисуют только ParvaneIcon): то же либо похожее, нет такого — пусто
[[nodiscard]] QString KitIcon(const QString &name);

// `.ib`: круглая кнопка со значком 2.25rem (`small` — 1.875rem, как `.folderButton`) — значок из PaintNotesIcon
class NotesIconButton final : public Kit::Button {
public:
	NotesIconButton(QWidget *parent, const QString &icon, const QString &accessibleName, int side = 0);

	void setIcon(const QString &icon);

protected:
	void paintEvent(QPaintEvent *e) override;

private:
	QString _icon;

};

// Кнопка-текст со значком (`.plain`, `.boardChip`, кнопка `.btn` с любым значком PvIcon): рамка/подложка по виду
class NotesTextButton final : public Kit::Button {
public:
	enum class Kind {
		Plain, // `.plain`: без подложки, наведение — цвет `--pv-fg`
		Btn, // `.btn`: 2.25rem, `--pv-raised`, скругление 0.5rem
		Ghost, // `.btnGhost`
		Accent, // `.btnAcc`
		Danger, // `.btnDanger`
		Chip, // `.chip` + `.boardChip`: 1.875rem, рамка `--pv-line2`, подложка `--pv-panel`
	};
	NotesTextButton(QWidget *parent, const QString &text, const QString &icon, Kind kind);

	void setText(const QString &text);
	void setIcon(const QString &icon, const QString &trailingIcon = QString());
	void setOn(bool on, std::optional<Tone> tone = std::nullopt); // `.chipOn` / `.boardChipOn`
	void setTextTone(Tone tone);
	void setFontPx(int px, bool semibold = false);
	void setWide(bool wide); // во всю ширину, подпись по центру

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	void refreshSize();
	[[nodiscard]] int contentWidth() const;

	QString _text;
	QString _icon;
	QString _trailing;
	Kind _kind = Kind::Plain;
	bool _on = false;
	std::optional<Tone> _tone;
	std::optional<Tone> _textTone;
	int _px = Kit::kBodyPx;
	bool _semibold = false;
	bool _wide = false;

};

// ── настройки раздела на устройстве (tdata/parvane-knowledge.json) ────────────

[[nodiscard]] std::optional<std::string> PrefGet(const std::string &key);
void PrefSet(const std::string &key, const std::optional<std::string> &value);

// Ширина панели (web `parvanePanels`): сохранённая либо nullopt — ширина по умолчанию
[[nodiscard]] std::optional<int> PanelWidth(const std::string &panel);
void SetPanelWidth(const std::string &panel, std::optional<int> width);

// ── текст с разметкой строки ──────────────────────────────────────────────────

// Строка Markdown (web MarkdownBlocks `renderInline`): жирный, курсив, зачёркнутый, код (`--pv-orange`), #тег
// (`--pv-aqua`), ссылка (цвет ссылок), [[заметка]] (`--pv-purple`; заметки ещё нет — `--pv-red`). Переносится по
// словам; нажатие на [[заметку]] — openNote(target), на ссылку — браузер.
class RichText final : public Ui::RpWidget {
public:
	struct Style {
		int px = Kit::kBodyPx;
		bool semibold = false;
		bool mono = false;
		Tone tone = Tone::Fg;
		double lineHeight = 1.5;
		bool strike = false; // весь текст зачёркнут (`.taskDone`)
	};
	RichText(QWidget *parent, Style st);
	~RichText();

	// Куски строки; noteExists — есть ли заметка с таким названием
	void setInlines(const std::vector<md::MdInline> &parts, Fn<bool(const std::string&)> noteExists = nullptr);
	void setMarkdown(const std::string &text, Fn<bool(const std::string&)> noteExists = nullptr);
	void setPlain(const QString &text);
	void setTone(Tone tone);
	void setOpenNote(Fn<void(QString)> callback);

	[[nodiscard]] int naturalTextWidth() const;

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mousePressEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void leaveEventHook(QEvent *e) override;

private:
	struct Colors;
	void refreshStyle();
	void apply();
	[[nodiscard]] ClickHandlerPtr linkAt(QPoint point) const;

	Style _st;
	std::unique_ptr<Colors> _colors;
	TextWithEntities _marked;
	Ui::Text::String _text;
	Fn<void(QString)> _openNote;
	ClickHandlerPtr _pressed;

};

// Строка `.row` с плиткой-значком (`.ava.avaS` со значком внутри, `--c` — тон): обратные ссылки, выбор папки
class IconRow final : public Kit::Button {
public:
	struct Descriptor {
		QString title;
		QString icon;
		std::optional<Tone> tone; // пусто — плитка без цвета (`--pv-raised`, значок `--pv-muted`)
		QString trailingIcon; // справа, например `check`
		bool selected = false;
	};
	IconRow(QWidget *parent, Descriptor descriptor);

protected:
	int resizeGetHeight(int newWidth) override;
	void paintEvent(QPaintEvent *e) override;

private:
	Descriptor _descriptor;

};

// ── окна ──────────────────────────────────────────────────────────────────────

struct SheetButton {
	QString text;
	Kit::PushButton::Kind kind = Kit::PushButton::Kind::Normal;
	Fn<void()> callback; // окно закрывается до вызова
	QString icon;
};

// Слой для шторок раздела: экран «Знаний» (objectName `ParvaneKnowledge`), иначе — окно
[[nodiscard]] not_null<QWidget*> SheetHost(not_null<QWidget*> widget);

// Вопрос (web ConfirmDialog / Modal «confirm»): шторка с текстом и кнопками; «Отмена» добавляется сама
not_null<Kit::Sheet*> ShowQuestion(
	not_null<QWidget*> parent,
	const QString &title,
	const QString &text,
	std::vector<SheetButton> buttons,
	bool column = false);

// ── правки заметок (задания рабочего потока) ──────────────────────────────────

// Заметка с этим названием; нет — создаётся (название-дата — заметка дня по шаблону в своей папке)
void EnsureNote(const std::string &title, Fn<void(std::optional<std::string>)> done);
// Сохранение с базой правки (сведение с правками, пришедшими за время правки)
void SaveNote(
	const std::string &noteId,
	const std::string &text,
	std::optional<std::string> base,
	Fn<void(bool)> done = nullptr);
void RenameNote(const std::string &noteId, const std::string &title);
void DeleteNote(const std::string &noteId);
void MoveNote(const std::string &noteId, std::optional<std::string> folderId);

// Снимок заметок (главный поток): заметка по id
[[nodiscard]] notes::NoteRef FindNote(const std::string &noteId);

} // namespace Parvane::Knowledge
