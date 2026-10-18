// Parvane fork: реализация parvane_icons.h — контуры из web ParvaneIcon.tsx (viewBox 24, штрих 1.8,
// скруглённые концы), растр через QSvgRenderer с учётом плотности экрана.
#include "parvane/parvane_icons.h"

#include "ui/painter.h"
#include "ui/style/style_core.h"

#include <QtCore/QHash>
#include <QtSvg/QSvgRenderer>

namespace Parvane {
namespace {

// Контуры — те же, что в web/telegram-tt/src/components/main/ParvaneIcon.tsx
const QHash<QString, QStringList> &Paths() {
	static const auto result = QHash<QString, QStringList>{
		{ u"chat"_q, { u"M4 5h16v11H9l-5 4z"_q } },
		{ u"chats"_q, { u"M3 5h13v9H8l-5 4z"_q, u"M8 17h8l5 4V9h-2"_q } },
		{ u"sun"_q, {
			u"M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"_q,
			u"M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"_q,
		} },
		{ u"calendar"_q, {
			u"M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"_q,
			u"M3 10h18M8 3v4M16 3v4"_q,
		} },
		{ u"heart"_q, { u"M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"_q } },
		{ u"book"_q, { u"M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"_q, u"M5 17a3 3 0 0 1 3-3h11"_q } },
		{ u"cloud"_q, { u"M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.3 1.5A3.3 3.3 0 0 0 7 18z"_q } },
		{ u"search"_q, { u"M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12z"_q, u"M20 20l-4.5-4.5"_q } },
		{ u"user"_q, { u"M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"_q, u"M4 21a8 8 0 0 1 16 0"_q } },
		{ u"users"_q, {
			u"M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z"_q,
			u"M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6"_q,
		} },
		{ u"megaphone"_q, { u"M4 10v4h3l8 4V6L7 10z"_q, u"M18 9a4 4 0 0 1 0 6"_q } },
		{ u"plus"_q, { u"M12 5v14M5 12h14"_q } },
		{ u"pen"_q, { u"M4 20h4L19 9l-4-4L4 16z"_q, u"M13 7l4 4"_q } },
		{ u"right"_q, { u"M9 5l7 7-7 7"_q } },
		{ u"check"_q, { u"M5 12l5 5 9-10"_q } },
		{ u"sliders"_q, {
			u"M4 7h10M18 7h2M4 17h4M12 17h8"_q,
			u"M16 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4z"_q,
			u"M10 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z"_q,
		} },
		{ u"warn"_q, { u"M12 3l10 18H2z"_q, u"M12 10v5M12 18v.5"_q } },
		{ u"link"_q, {
			u"M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"_q,
		} },
		{ u"smile"_q, {
			u"M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z"_q,
			u"M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.5M15 9.5v.5"_q,
		} },
		{ u"work"_q, {
			u"M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"_q,
			u"M9 7V5h6v2M3 13h18"_q,
		} },
		{ u"cap"_q, { u"M2 9l10-5 10 5-10 5z"_q, u"M6 11v5c3 2 9 2 12 0v-5M22 9v6"_q } },
		{ u"home"_q, { u"M3 11l9-7 9 7"_q, u"M5 10v10h5v-6h4v6h5V10"_q } },
		{ u"folder"_q, { u"M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"_q } },
		{ u"bell"_q, { u"M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"_q, u"M10 20a2 2 0 0 0 4 0"_q } },
		{ u"note"_q, { u"M6 3h9l4 4v14H6z"_q, u"M14 3v5h5"_q } },
		{ u"logout"_q, { u"M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"_q, u"M10 8l-4 4 4 4M6 12h10"_q } },
		{ u"star"_q, { u"M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"_q } },
	};
	return result;
}

[[nodiscard]] QByteArray Svg(const QStringList &paths, const QColor &color) {
	auto result = QByteArray(
		"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"");
	result += color.name(QColor::HexRgb).toLatin1();
	result += "\" stroke-opacity=\"" + QByteArray::number(color.alphaF(), 'f', 3);
	result += "\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">";
	for (const auto &d : paths) {
		result += "<path d=\"" + d.toLatin1() + "\"/>";
	}
	result += "</svg>";
	return result;
}

} // namespace

bool HasIcon(const QString &name) {
	return Paths().contains(name);
}

QImage IconImage(const QString &name, const QColor &color, int size) {
	static auto cache = QHash<QString, QImage>();
	const auto ratio = style::DevicePixelRatio();
	const auto key = name + '/' + QString::number(color.rgba(), 16) + '/'
		+ QString::number(size) + '/' + QString::number(ratio);
	if (const auto i = cache.constFind(key); i != cache.constEnd()) {
		return *i;
	}
	const auto paths = Paths().value(name);
	auto image = QImage(QSize(size, size) * ratio, QImage::Format_ARGB32_Premultiplied);
	image.fill(Qt::transparent);
	if (!paths.isEmpty()) {
		auto renderer = QSvgRenderer(Svg(paths, color));
		auto p = QPainter(&image);
		renderer.render(&p, QRectF(0, 0, size * ratio, size * ratio));
	}
	image.setDevicePixelRatio(ratio);
	cache.insert(key, image);
	return image;
}

void PaintIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size) {
	p.drawImage(x, y, IconImage(name, color, size));
}

} // namespace Parvane
