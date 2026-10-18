// Parvane fork: внешний вид холста «Знаний» (spec 029, T063) — см. parvane_notes_canvas_look.h.
#include "parvane/parvane_notes_canvas_look.h"

#include "parvane/parvane_kit.h"

#include <parvane/sections/notes_look.h>

#include "ui/painter.h"
#include "styles/style_basic.h"

#include <QtGui/QFontMetricsF>
#include <QtGui/QPainter>
#include <QtSvg/QSvgRenderer>

namespace Parvane::NotesUi::CanvasLook {
namespace {

// Фигура значка (web PvIcon `Shape`): линия, круг, прямоугольник
struct Shape {
	enum class Kind { Path, Circle, Rect } kind = Kind::Path;
	QString d;
	double a = 0., b = 0., c = 0., w = 0., r = 0.;
	bool special = false; // круг — залитая точка, прямоугольник — пунктир
};

[[nodiscard]] Shape P(const char *d) {
	return { Shape::Kind::Path, QString::fromLatin1(d) };
}

[[nodiscard]] Shape C(double x, double y, double r, bool filled = false) {
	auto result = Shape{ Shape::Kind::Circle };
	result.a = x;
	result.b = y;
	result.c = r;
	result.special = filled;
	return result;
}

[[nodiscard]] Shape R(double x, double y, double w, double h, double r, bool dashed = false) {
	auto result = Shape{ Shape::Kind::Rect };
	result.a = x;
	result.b = y;
	result.w = w;
	result.c = h;
	result.r = r;
	result.special = dashed;
	return result;
}

// Линейные значки прототипа: поле 24×24, обводка 1.8 (web `PvIcon.tsx`, только те, что нужны холсту)
[[nodiscard]] const QHash<QString, std::vector<Shape>> &Icons() {
	static const auto result = QHash<QString, std::vector<Shape>>{
		{ u"plus"_q, { P("M12 5v14M5 12h14") } },
		{ u"minus"_q, { P("M5 12h14") } },
		{ u"left"_q, { P("M15 5l-7 7 7 7") } },
		{ u"right"_q, { P("M9 5l7 7-7 7") } },
		{ u"x"_q, { P("M6 6l12 12M18 6L6 18") } },
		{ u"edit"_q, { P("M4 20h4L19 9l-4-4L4 16z") } },
		{ u"trash"_q, { P("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13") } },
		{ u"note"_q, { P("M6 3h9l4 4v14H6z"), P("M14 3v5h5") } },
		{ u"noteNew"_q, { P("M6 3h9l4 4v14H6z"), P("M14 3v5h5M12.5 11v6M9.5 14h6") } },
		{ u"link"_q, { P("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1") } },
		{ u"text"_q, { P("M5 6h14M12 6v13") } },
		{ u"group"_q, { R(3, 5, 18, 15, 3, true), P("M3 9h7") } },
		{ u"board"_q, { R(3, 3, 8, 7, 1.5), R(14, 6, 7, 6, 1.5), R(6, 15, 8, 6, 1.5), P("M11 7h3M10 10l0 5") } },
		{ u"fit"_q, { P("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5") } },
		{ u"graph"_q, {
			C(6, 6, 2.5), C(18, 9, 2.5), C(9, 18, 2.5),
			P("M8.4 6.6l7.2 1.8M6.6 8.4l1.8 7.2M16.2 10.8l-5.4 5.4") } },
		{ u"folder"_q, { P("M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z") } },
		{ u"file"_q, { P("M6 3h9l4 4v14H6z"), P("M14 3v5h5M9 13h6M9 17h6") } },
		{ u"dots"_q, { C(12, 5, 1.4, true), C(12, 12, 1.4, true), C(12, 19, 1.4, true) } },
		{ u"refresh"_q, { P("M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"), P("M18.5 3v4.5H14M5.5 21v-4.5H10") } },
		{ u"undo"_q, { P("M9 14L4 9l5-5"), P("M4 9h10a6 6 0 0 1 0 12h-3") } },
		{ u"redo"_q, { P("M15 14l5-5-5-5"), P("M20 9H10a6 6 0 0 0 0 12h3") } },
		{ u"copy"_q, { R(8, 8, 12, 12, 2), P("M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2") } },
		{ u"select"_q, { R(3, 3, 14, 14, 2, true), P("M13 13l8 3-3.5 1.5L16 21z") } },
		{ u"arrow"_q, { P("M4 12h16M14 6l6 6-6 6") } },
		{ u"open"_q, { P("M14 4h6v6M20 4l-9 9"), P("M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5") } },
		{ u"front"_q, { R(9, 9, 12, 12, 2), P("M5 15V5h10") } },
		{ u"back"_q, { R(3, 3, 12, 12, 2), P("M19 9v10H9") } },
		{ u"alignLeft"_q, { P("M4 3v18"), R(7, 6, 12, 4, 1), R(7, 14, 7, 4, 1) } },
		{ u"alignCenter"_q, { P("M12 3v18"), R(5, 6, 14, 4, 1), R(8, 14, 8, 4, 1) } },
		{ u"alignRight"_q, { P("M20 3v18"), R(5, 6, 12, 4, 1), R(10, 14, 7, 4, 1) } },
		{ u"alignTop"_q, { P("M3 4h18"), R(6, 7, 4, 12, 1), R(14, 7, 4, 7, 1) } },
		{ u"alignMiddle"_q, { P("M3 12h18"), R(6, 5, 4, 14, 1), R(14, 8, 4, 8, 1) } },
		{ u"alignBottom"_q, { P("M3 20h18"), R(6, 5, 4, 12, 1), R(14, 10, 4, 7, 1) } },
		{ u"spreadX"_q, { P("M4 3v18M20 3v18"), R(9, 7, 6, 10, 1) } },
		{ u"spreadY"_q, { P("M3 4h18M3 20h18"), R(7, 9, 10, 6, 1) } },
		{ u"paste"_q, { R(5, 5, 14, 16, 2), P("M9 5V3h6v2M9 11h6M9 15h6") } },
	};
	return result;
}

[[nodiscard]] QByteArray Svg(const std::vector<Shape> &shapes, const QColor &color) {
	const auto hex = color.name(QColor::HexRgb).toLatin1();
	auto result = QByteArray("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"")
		+ hex
		+ "\" stroke-opacity=\"" + QByteArray::number(color.alphaF(), 'f', 3)
		+ "\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">";
	const auto n = [](double v) { return QByteArray::number(v, 'g', 6); };
	for (const auto &shape : shapes) {
		switch (shape.kind) {
		case Shape::Kind::Path:
			result += "<path d=\"" + shape.d.toLatin1() + "\"/>";
			break;
		case Shape::Kind::Circle:
			result += "<circle cx=\"" + n(shape.a) + "\" cy=\"" + n(shape.b) + "\" r=\"" + n(shape.c) + "\"";
			if (shape.special) {
				// `.iconDot`: залитая точка без обводки
				result += " fill=\"" + hex + "\" fill-opacity=\"" + QByteArray::number(color.alphaF(), 'f', 3)
					+ "\" stroke=\"none\"";
			}
			result += "/>";
			break;
		case Shape::Kind::Rect:
			result += "<rect x=\"" + n(shape.a) + "\" y=\"" + n(shape.b) + "\" width=\"" + n(shape.w)
				+ "\" height=\"" + n(shape.c) + "\" rx=\"" + n(shape.r) + "\"";
			if (shape.special) {
				result += " stroke-dasharray=\"3 3\""; // `.iconDashed`
			}
			result += "/>";
			break;
		}
	}
	result += "</svg>";
	return result;
}

using Kind = notes::CanvasInlinePart::Kind;

[[nodiscard]] QFont RunFont(const TextStyle &st, Kind kind) {
	switch (kind) {
	case Kind::Bold: return CanvasFont(st.px, true);
	// `.code`: моноширинный 0.8125rem
	case Kind::Code: return CanvasFont(13., false, true);
	default: return CanvasFont(st.px, st.semibold);
	}
}

// Перенос: слова (с пробелом после) по строке; слово шире строки рвётся по знакам
void AppendRun(std::vector<Line> &lines, double &x, double width, const QString &text, Kind kind, const QFont &font) {
	const auto metrics = QFontMetricsF(font);
	// Код рисуется на подложке с полями 0.3125rem — ширина с полями
	const auto pad = (kind == Kind::Code) ? 5. * 2 : 0.;
	auto words = QStringList();
	{
		auto current = QString();
		for (const auto ch : text) {
			current += ch;
			if (ch == QChar(' ')) {
				words.push_back(current);
				current.clear();
			}
		}
		if (!current.isEmpty()) {
			words.push_back(current);
		}
	}
	const auto push = [&](const QString &part, double partWidth) {
		auto &runs = lines.back().runs;
		if (!runs.empty() && runs.back().kind == kind && runs.back().x + runs.back().width == x && kind != Kind::Code) {
			runs.back().text += part;
			runs.back().width += partWidth;
		} else {
			runs.push_back({ part, kind, x, partWidth });
		}
		x += partWidth;
	};
	for (const auto &word : words) {
		const auto trimmed = word.endsWith(' ') ? word.chopped(1) : word;
		const auto fits = metrics.horizontalAdvance(trimmed) + pad;
		if (x > 0. && x + fits > width) {
			lines.push_back({});
			x = 0.;
		}
		const auto full = metrics.horizontalAdvance(word) + pad;
		if (full <= width - x || x > 0.) {
			push(word, full);
			continue;
		}
		// `overflow-wrap: anywhere`: длинное слово — по знакам
		auto part = QString();
		auto partWidth = pad;
		for (const auto ch : word) {
			const auto w = metrics.horizontalAdvance(ch);
			if (!part.isEmpty() && x + partWidth + w > width) {
				push(part, partWidth);
				lines.push_back({});
				x = 0.;
				part.clear();
				partWidth = pad;
			}
			part += ch;
			partWidth += w;
		}
		if (!part.isEmpty()) {
			push(part, partWidth);
		}
	}
}

} // namespace

QColor Blend(QColor a, QColor b, double share) {
	const auto mix = [&](double x, double y) {
		return std::clamp(int(std::round(x * share + y * (1. - share))), 0, 255);
	};
	return QColor(
		mix(a.red(), b.red()),
		mix(a.green(), b.green()),
		mix(a.blue(), b.blue()),
		mix(a.alpha(), b.alpha()));
}

QColor Fade(QColor c, double share) {
	c.setAlphaF(std::clamp(c.alphaF() * share, 0., 1.));
	return c;
}

std::optional<QColor> PresetColor(const std::optional<std::string> &color) {
	if (!notes::isCanvasPresetColor(color)) {
		return std::nullopt;
	}
	switch ((*color)[0]) {
	case '1': return ToneColor(Tone::Red);
	case '2': return ToneColor(Tone::Orange);
	case '3': return ToneColor(Tone::Yellow);
	case '4': return ToneColor(Tone::Green);
	case '5': return ToneColor(Tone::Blue);
	default: return ToneColor(Tone::Purple);
	}
}

QColor FolderColor(const std::string &folder, bool isDaily) {
	const auto tone = notes::folderTone(folder, isDaily);
	if (tone == "blue") return ToneColor(Tone::Blue);
	if (tone == "green") return ToneColor(Tone::Green);
	if (tone == "orange") return ToneColor(Tone::Orange);
	if (tone == "purple") return ToneColor(Tone::Purple);
	if (tone == "aqua") return ToneColor(Tone::Aqua);
	if (tone == "red") return ToneColor(Tone::Red);
	return ToneColor(Tone::Yellow); // `--pv-note`
}

QFont CanvasFont(double px, bool semibold, bool mono) {
	auto result = Kit::Font(13, semibold, mono)->f;
	result.setPixelSize(std::max(1, int(std::round(px))));
	result.setHintingPreference(QFont::PreferNoHinting);
	return result;
}

QImage IconImage(const QString &name, const QColor &color, int size) {
	static auto cache = QHash<QString, QImage>();
	const auto ratio = style::DevicePixelRatio();
	const auto key = name + '/' + QString::number(color.rgba(), 16) + '/' + QString::number(size) + '/'
		+ QString::number(ratio);
	if (const auto i = cache.constFind(key); i != cache.constEnd()) {
		return *i;
	}
	auto image = QImage(QSize(size, size) * ratio, QImage::Format_ARGB32_Premultiplied);
	image.fill(Qt::transparent);
	if (const auto i = Icons().constFind(name); i != Icons().constEnd()) {
		auto renderer = QSvgRenderer(Svg(*i, color));
		auto p = QPainter(&image);
		renderer.render(&p, QRectF(0, 0, size * ratio, size * ratio));
	}
	image.setDevicePixelRatio(ratio);
	cache.insert(key, image);
	return image;
}

void PaintIcon(QPainter &p, const QString &name, const QColor &color, QRectF rect) {
	// Под масштабом поля значок рисуется в нужный размер экрана, чтобы не размывался
	const auto scale = std::sqrt(std::abs(p.worldTransform().determinant()));
	const auto pixels = std::max(1, int(std::round(rect.width() * (scale > 0. ? scale : 1.))));
	const auto image = IconImage(name, color, pixels);
	p.drawImage(rect, image);
}

TextLayout LayoutLines(const std::vector<std::string> &lines, double width, const TextStyle &st) {
	auto result = TextLayout();
	result.lineHeight = st.px * st.lineHeight;
	width = std::max(width, 1.);
	for (const auto &source : lines) {
		result.lines.push_back({});
		auto x = 0.;
		for (const auto &part : notes::canvasInlineParts(source)) {
			AppendRun(result.lines, x, width, QString::fromStdString(part.text), part.kind, RunFont(st, part.kind));
		}
	}
	return result;
}

void PaintLayout(QPainter &p, const TextLayout &layout, QPointF topLeft, double bottom, const TextStyle &st) {
	auto y = topLeft.y();
	for (const auto &line : layout.lines) {
		if (y >= bottom) {
			break;
		}
		const auto partial = (y + layout.lineHeight > bottom);
		if (partial) {
			p.save();
			p.setClipRect(QRectF(topLeft.x() - 2., y, 100000., bottom - y), Qt::IntersectClip);
		}
		for (const auto &run : line.runs) {
			const auto font = RunFont(st, run.kind);
			const auto metrics = QFontMetricsF(font);
			const auto baseline = y + (layout.lineHeight - metrics.height()) / 2. + metrics.ascent();
			auto x = topLeft.x() + run.x;
			auto text = run.text;
			switch (run.kind) {
			case Kind::Link: {
				// `.cardLink`: фиолетовый текст с пунктирной чертой снизу
				const auto purple = ToneColor(Tone::Purple);
				p.setFont(font);
				p.setPen(purple);
				p.drawText(QPointF(x, baseline), text);
				auto pen = QPen(Fade(purple, 0.5), 1.);
				pen.setStyle(Qt::DashLine);
				p.setPen(pen);
				const auto lineY = baseline + metrics.descent() - 0.5;
				p.drawLine(QPointF(x, lineY), QPointF(x + metrics.horizontalAdvance(text.trimmed()), lineY));
			} break;
			case Kind::Code: {
				// `.code`: поля 0.0625rem 0.3125rem, скругление 0.25rem, оранжевый на `--pv-hover`
				const auto box = QRectF(x, baseline - metrics.ascent() - 1., run.width, metrics.height() + 2.);
				p.setPen(Qt::NoPen);
				p.setBrush(ToneColor(Tone::Hover));
				p.drawRoundedRect(box, 4., 4.);
				p.setFont(font);
				p.setPen(ToneColor(Tone::Orange));
				p.drawText(QPointF(x + 5., baseline), text);
			} break;
			default:
				p.setFont(font);
				p.setPen(st.color);
				p.drawText(QPointF(x, baseline), text);
			}
		}
		if (partial) {
			p.restore();
		}
		y += layout.lineHeight;
	}
}

} // namespace Parvane::NotesUi::CanvasLook
