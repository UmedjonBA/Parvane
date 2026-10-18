// Parvane fork: оболочка «Пространство» на desktop (spec 029, как web): текущий раздел (Чаты, Календарь,
// Здоровье, Знания, Файлы) и тона своих разделов `--pv-*` текущей цветовой схемы.
#pragma once

#include <rpl/producer.h>

#include <QtGui/QColor>

#include <array>

namespace Parvane {

// Разделы рейки — как web FoldersSidebar (Календарь и Здоровье — виды «Плана», Знания и Файлы — «Облака»).
enum class Section {
	Chats,
	Calendar,
	Health,
	Knowledge,
	Files,
};

[[nodiscard]] Section CurrentSection();
[[nodiscard]] rpl::producer<Section> SectionValue(); // текущий и все смены
void ShowSection(Section section);

// Тона `--pv-*` (web buildSchemeTokens): акцент прототипа, цвета видов записей, нейтральные тона.
enum class Tone {
	Accent,
	AccentInk,
	Blue,
	Purple,
	Orange,
	Aqua,
	Green,
	Red,
	Yellow,
	Bg,
	Panel,
	Raised,
	Hover,
	Line,
	Line2,
	Fg,
	Muted,
	Faint,
};

[[nodiscard]] QColor ToneColor(Tone tone);

// Цветовые схемы (как web colorScheme.ts): gruvbox (по умолчанию), telegram, nord, catppuccin, solarized.
// Схема — настройка устройства (tdata/parvane-scheme); не «telegram» — встроенная тема `:/gui/space-*`.
[[nodiscard]] QStringList Schemes();
[[nodiscard]] QString CurrentScheme();
void SetScheme(const QString &scheme);
// Путь темы схемы для режима ("" — штатная дневная tdesktop); для переключения день/ночь.
[[nodiscard]] QString SchemeThemePath(const QString &scheme, bool night);
// Первый запуск: применить схему по умолчанию. Звать после подъёма окна.
void EnsureSchemeApplied();
// Образцы схемы для выбора: фон, панель, акцент, текст.
[[nodiscard]] std::array<QColor, 4> SchemeSwatches(const QString &scheme, bool night);
[[nodiscard]] rpl::producer<> TonesChanges(); // смена схемы или светлого/тёмного режима

} // namespace Parvane
