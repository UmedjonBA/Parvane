// Parvane fork: ввод от сервера и собеседника (ревью безопасности 21 окт 2026, вечер, пункты 2.2 и 2.3).
//
// Картинки из чужих байтов разбираются с пределом размера (бомба распаковки, тысячи миниатюр в памяти), имена
// файлов из сообщений и совместных папок — только последней частью пути, файлы чужого происхождения открываются
// системой лишь картинкой/видео/звуком с совпадающими типом и расширением, ссылки из чужого текста — только
// http(s)/mailto и с окном «Перейти по ссылке?», если подпись не совпадает с адресом. Логика проверок — в
// parvane-core (`cloud::safeToOpenExternally`, `cloud::safeLocalName`, `markdown::isSafeUrl`,
// `markdown::linkNeedsConfirmation`) с тестами.
#pragma once

#include <parvane/sections/cloud_model.h>

#include <QtCore/QBuffer>
#include <QtCore/QByteArray>
#include <QtCore/QString>
#include <QtGui/QImage>
#include <QtGui/QImageReader>

#include <algorithm>
#include <string>

namespace Parvane {

// Больше этого пикселей картинку из чужих байтов не разбираем вовсе (до чтения, по заголовку): 40 Мпикс — 160 МиБ кадра
inline constexpr qint64 kDecodeMaxPixels = qint64(40) * 1000 * 1000;
// Предел выделения Qt под кадр (МиБ): без размера в заголовке или при ошибке заголовка больше не выделится
inline constexpr int kDecodeAllocationLimitMb = 192;

// Картинка из чужих байтов не крупнее `maxSide` по длинной стороне (0 — без уменьшения): JPEG уменьшается уже при
// разборе, прочие — сразу после; формат не из белого списка, нет размера в заголовке или больше kDecodeMaxPixels пикселей — пустая картинка.
[[nodiscard]] inline QImage DecodeImageBounded(const QByteArray &bytes, int maxSide) {
	auto buffer = QBuffer();
	buffer.setData(bytes);
	if (!buffer.open(QIODevice::ReadOnly)) {
		return QImage();
	}
	auto reader = QImageReader(&buffer);
	// Байты чужие: разбираем только форматы из белого списка (не все установленные плагины Qt — TGA, TIFF, XPM…)
	// и только с размером в заголовке, чтобы предел площади действовал всегда
	const auto format = reader.format().toLower();
	if (format != "jpeg" && format != "jpg" && format != "png" && format != "gif"
		&& format != "webp" && format != "bmp") {
		return QImage();
	}
	reader.setAllocationLimit(kDecodeAllocationLimitMb);
	reader.setAutoTransform(true);
	const auto size = reader.size();
	if (!size.isValid() || qint64(size.width()) * size.height() > kDecodeMaxPixels) {
		return QImage();
	}
	if (maxSide > 0 && std::max(size.width(), size.height()) > maxSide) {
		reader.setScaledSize(size.scaled(maxSide, maxSide, Qt::KeepAspectRatio));
	}
	auto image = reader.read();
	if (!image.isNull() && maxSide > 0 && std::max(image.width(), image.height()) > maxSide) {
		image = image.scaled(maxSide, maxSide, Qt::KeepAspectRatio, Qt::SmoothTransformation);
	}
	return image;
}

// Имя файла на диске из чужого имени (без `/`, управляющих знаков, ведущих точек; не длиннее 200 байт)
[[nodiscard]] inline QString SafeLocalName(const QString &name) {
	return QString::fromStdString(parvane::sections::cloud::safeLocalName(name.toStdString()));
}

// Файл чужого происхождения (вложение статьи, файл совместной папки) можно открыть системой: картинка, видео или
// звук, вид по расширению совпадает с видом по mime, и tdesktop не считает расширение исполняемым. Иначе —
// «Сохранить как». Реализация — parvane_knowledge_common.cpp.
[[nodiscard]] bool SafeToOpenFile(const QString &name, const std::string &mime);

// Ссылка из чужого текста (статья, заметка, карточка холста): открывается только http(s)/mailto и только браузером
// системы — внутренние пути tdesktop (`tg://`, `t.me` как `tg://`) в Parvane не работают, как и в web. Подпись
// `shown` не совпадает с адресом (или `alwaysConfirm`) — сначала окно «Перейти по ссылке?» с полным адресом.
// Иная схема — уведомление «ссылку открыть нельзя». Реализация — parvane_knowledge_common.cpp.
void OpenExternalLink(const QString &url, const QString &shown, bool alwaysConfirm = false);

} // namespace Parvane
