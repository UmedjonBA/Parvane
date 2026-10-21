// Parvane fork: вид папок «Пространства» (spec 030, пункт B) — одно правило цвета и значка для чипов над списком
// чатов и для меток папок в строках чатов, как web `util/folderColors.ts` и `ChatFolderTabList renderChipIcon`.
// Цвет: «Все» — акцент; выбранный в настройках папки цвет (индексы Telegram 0–6) — тон схемы; без цвета — тона по
// порядку папок. Значок: «Все» — «все чаты»; эмодзи папки — значок папок tdesktop (`ui/filter_icons`); без
// эмодзи — линейный значок «папка». Только заголовок: файл подключают клиентские TU, CMake не меняется.
#pragma once

#include "data/data_chat_filters.h"
#include "parvane/parvane_icons.h"
#include "parvane/parvane_space.h"
#include "ui/filter_icons.h"
#include "ui/style/style_core.h"

#include <QtGui/QImage>
#include <QtGui/QPainter>

namespace Parvane {

// web CHOSEN_FOLDER_COLORS: красный, оранжевый, фиолетовый, зелёный, бирюзовый, синий, розовый (= фиолетовый)
inline QColor ChosenFolderColor(int index) {
	static constexpr Tone kChosen[] = {
		Tone::Red, Tone::Orange, Tone::Purple, Tone::Green, Tone::Aqua, Tone::Blue, Tone::Purple,
	};
	return ToneColor(kChosen[((index % 7) + 7) % 7]);
}

// web FALLBACK_FOLDER_COLORS — для папок без выбранного цвета, по порядку
inline QColor FallbackFolderColor(int index) {
	static constexpr Tone kFallback[] = {
		Tone::Blue, Tone::Orange, Tone::Purple, Tone::Aqua, Tone::Green, Tone::Red,
	};
	return ToneColor(kFallback[((index % 6) + 6) % 6]);
}

// Цвет папки filterId в порядке списка list (тот же, что у чипов). Нет такой папки — акцент.
inline QColor FolderColor(const std::vector<Data::ChatFilter> &list, FilterId filterId) {
	if (!filterId) {
		return ToneColor(Tone::Accent);
	}
	auto fallback = 0;
	for (const auto &filter : list) {
		if (!filter.id()) {
			continue;
		}
		const auto color = filter.colorIndex();
		if (filter.id() == filterId) {
			return color ? ChosenFolderColor(*color) : FallbackFolderColor(fallback);
		}
		if (!color) {
			++fallback;
		}
	}
	return ToneColor(Tone::Accent);
}

// Значок папки size×size логических пикселей цветом color (с учётом плотности экрана).
inline QImage FolderIconImage(const Data::ChatFilter &filter, const QColor &color, int size) {
	const auto ratio = style::DevicePixelRatio();
	const auto lookup = [&]() -> std::optional<Ui::FilterIcon> {
		if (!filter.id()) {
			return Ui::FilterIcon::All;
		}
		const auto emoji = filter.iconEmoji();
		return emoji.isEmpty() ? std::nullopt : Ui::LookupFilterIconByEmoji(emoji);
	}();
	if (!lookup) {
		return IconImage(u"folder"_q, color, size);
	}
	const auto &icons = Ui::LookupFilterIcon(*lookup);
	auto image = icons.normal->instance(color);
	if (image.isNull()) {
		return IconImage(u"folder"_q, color, size);
	}
	image = image.scaled(
		QSize(size, size) * ratio,
		Qt::KeepAspectRatio,
		Qt::SmoothTransformation);
	image.setDevicePixelRatio(ratio);
	return image;
}

} // namespace Parvane
