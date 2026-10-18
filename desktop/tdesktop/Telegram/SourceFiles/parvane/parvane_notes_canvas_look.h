// Parvane fork: внешний вид холста «Знаний» (spec 029, T063) — порт web `notesCanvasLook.tsx` и стилей холста
// `Knowledge.module.scss`: тона JSON Canvas, шрифты в точках холста, значки прототипа (`PvIcon`), раскладка строк
// карточки с разметкой `[[ссылка]]` / `` `код` `` / `**жирный**`. Разбор разметки и геометрия стрелок — ядро
// (parvane/sections/notes_canvas_look.h); здесь только рисование.
#pragma once

#include "parvane/parvane_space.h"

#include <parvane/sections/notes_canvas_look.h>

#include <QtGui/QColor>
#include <QtGui/QFont>
#include <QtGui/QImage>

#include <optional>
#include <string>
#include <vector>

class QPainter;

namespace Parvane::NotesUi::CanvasLook {

namespace notes = parvane::sections::notes;

// `color-mix(in srgb, a share, b)` — смесь двух непрозрачных цветов
[[nodiscard]] QColor Blend(QColor a, QColor b, double share);
// `color-mix(in srgb, c share, transparent)`
[[nodiscard]] QColor Fade(QColor c, double share);

// Цвет JSON Canvas 1…6 (web CANVAS_TONES): красный, оранжевый, жёлтый, зелёный, синий, фиолетовый; иначе nullopt
[[nodiscard]] std::optional<QColor> PresetColor(const std::optional<std::string> &color);
// Тон папки (ядро `folderTone`): note | blue | green | orange | purple | aqua | red
[[nodiscard]] QColor FolderColor(const std::string &folder, bool isDaily);

// Шрифт размера `px` точек холста (масштаб поля даёт рисование) — без хинтинга, чтобы ширины строк не
// зависели от масштаба
[[nodiscard]] QFont CanvasFont(double px, bool semibold = false, bool mono = false);

// Значки прототипа (web `PvIcon`): plus, minus, x, edit, trash, note, noteNew, link, text, group, board, fit, graph,
// folder, file, dots, refresh, undo, redo, copy, select, arrow, open, front, back, paste, left, right, align*, spread*
[[nodiscard]] QImage IconImage(const QString &name, const QColor &color, int size);
void PaintIcon(QPainter &p, const QString &name, const QColor &color, QRectF rect);

// Раскладка строк карточки: куски с разметкой, перенос по словам (`overflow-wrap: anywhere`)
struct Run {
	QString text;
	notes::CanvasInlinePart::Kind kind = notes::CanvasInlinePart::Kind::Text;
	double x = 0.;
	double width = 0.;
};
struct Line {
	std::vector<Run> runs;
};
struct TextLayout {
	std::vector<Line> lines;
	double lineHeight = 0.;
	[[nodiscard]] double height() const {
		return lines.size() * lineHeight;
	}
};

struct TextStyle {
	double px = 13.;
	double lineHeight = 1.45;
	QColor color;
	bool semibold = false;
};

// Строки текста (разделитель — `\n`) в ширину `width`; пустая строка держит свою высоту
[[nodiscard]] TextLayout LayoutLines(const std::vector<std::string> &lines, double width, const TextStyle &st);
// Нарисовать раскладку с левым верхним углом в `topLeft`, не ниже `bottom` (обрезка `overflow: hidden`)
void PaintLayout(QPainter &p, const TextLayout &layout, QPointF topLeft, double bottom, const TextStyle &st);

} // namespace Parvane::NotesUi::CanvasLook
