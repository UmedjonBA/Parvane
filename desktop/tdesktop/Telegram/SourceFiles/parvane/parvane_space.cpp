// Parvane fork: реализация parvane_space.h. Схема «Telegram» берёт нейтральные тона из палитры
// мессенджера (как web: `var(--color-background)` и т. п.), акценты — из таблицы TONES web.
#include "parvane/parvane_space.h"

#include "parvane/parvane_space_table.h"

#include "settings.h"
#include "window/themes/window_theme.h"
#include "styles/style_basic.h"
#include "styles/style_window.h"

#include <rpl/variable.h>

#include <QtGui/QFont>
#include <QtGui/QFontInfo>

namespace Parvane {
namespace {

rpl::variable<Section> &SectionVariable() {
	static auto result = rpl::variable<Section>(Section::Chats);
	return result;
}

[[nodiscard]] bool IsDark() {
	return Window::Theme::IsNightMode();
}

// web TONES.telegram: [светлая, тёмная]
[[nodiscard]] QColor TelegramTone(Tone tone) {
	const auto dark = IsDark();
	switch (tone) {
	case Tone::Accent: return dark ? QColor(0x87, 0x74, 0xe1) : QColor(0x33, 0x90, 0xec);
	case Tone::AccentInk: return QColor(0xff, 0xff, 0xff);
	case Tone::Blue: return dark ? QColor(0x5d, 0xb4, 0xf0) : QColor(0x33, 0x90, 0xec);
	case Tone::Purple: return dark ? QColor(0xa6, 0x95, 0xe7) : QColor(0x86, 0x5d, 0xd9);
	case Tone::Orange: return dark ? QColor(0xf5, 0x9f, 0x5b) : QColor(0xe5, 0x80, 0x2d);
	case Tone::Aqua: return dark ? QColor(0x4f, 0xc3, 0xb5) : QColor(0x1f, 0xa3, 0x95);
	case Tone::Green: return dark ? QColor(0x6c, 0xc2, 0x6f) : QColor(0x4f, 0xae, 0x4e);
	case Tone::Red: return dark ? QColor(0xf0, 0x6b, 0x6b) : QColor(0xe5, 0x39, 0x35);
	case Tone::Yellow: return dark ? QColor(0xf2, 0xc9, 0x4c) : QColor(0xd9, 0xa4, 0x06);
	case Tone::Bg: return st::windowBgOver->c;
	case Tone::Panel: return st::windowBg->c;
	case Tone::Raised: return st::windowBgRipple->c;
	case Tone::Hover: return st::windowBgOver->c;
	case Tone::Line: return st::shadowFg->c;
	case Tone::Line2: return st::windowSubTextFg->c;
	case Tone::Fg: return st::windowFg->c;
	case Tone::Muted: return st::windowSubTextFg->c;
	case Tone::Faint: return st::windowSubTextFg->c;
	}
	return st::windowFg->c;
}

[[nodiscard]] QString SchemePath() {
	return cWorkingDir() + u"tdata/parvane-scheme"_q;
}

[[nodiscard]] int SchemeIndex(const QString &scheme) {
	for (auto i = 0; i != SpaceTable::kSchemeCount; ++i) {
		if (scheme == QLatin1String(SpaceTable::kSchemes[i])) {
			return i;
		}
	}
	return -1;
}

[[nodiscard]] QString ReadScheme() {
	auto f = QFile(SchemePath());
	if (!f.open(QIODevice::ReadOnly)) {
		return QString();
	}
	const auto value = QString::fromUtf8(f.readAll()).trimmed();
	return (SchemeIndex(value) >= 0) ? value : QString();
}

QString &CachedScheme() {
	static auto result = QString();
	return result;
}

} // namespace

QStringList Schemes() {
	auto result = QStringList();
	for (const auto scheme : SpaceTable::kSchemes) {
		result.push_back(QString::fromLatin1(scheme));
	}
	return result;
}

QString CurrentScheme() {
	auto &cached = CachedScheme();
	if (cached.isEmpty()) {
		cached = ReadScheme();
	}
	return cached.isEmpty() ? QString::fromLatin1(SpaceTable::kDefaultScheme) : cached;
}

QString SchemeThemePath(const QString &scheme, bool night) {
	if (scheme == u"telegram"_q || SchemeIndex(scheme) < 0) {
		return night ? Window::Theme::NightThemePath() : QString();
	}
	return u":/gui/space-%1-%2.tdesktop-theme"_q.arg(scheme, night ? u"dark"_q : u"light"_q);
}

void SetScheme(const QString &scheme) {
	if (SchemeIndex(scheme) < 0) {
		return;
	}
	CachedScheme() = scheme;
	auto f = QFile(SchemePath());
	if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		f.write(scheme.toUtf8());
	}
	Window::Theme::ApplyDefaultWithPath(SchemeThemePath(scheme, Window::Theme::IsNightMode()));
	Window::Theme::KeepApplied();
}

void EnsureSchemeApplied() {
	if (ReadScheme().isEmpty()) {
		SetScheme(QString::fromLatin1(SpaceTable::kDefaultScheme));
	}
}

std::array<QColor, 4> SchemeSwatches(const QString &scheme, bool night) {
	auto result = std::array<QColor, 4>();
	const auto index = std::max(SchemeIndex(scheme), 0);
	for (auto i = 0; i != 4; ++i) {
		result[i] = QColor::fromRgba(SpaceTable::kSwatches[index][night ? 1 : 0][i]);
	}
	return result;
}

Section CurrentSection() {
	return SectionVariable().current();
}

rpl::producer<Section> SectionValue() {
	return SectionVariable().value();
}

void ShowSection(Section section) {
	SectionVariable() = section;
}

QColor ToneColor(Tone tone) {
	const auto index = SchemeIndex(CurrentScheme());
	if (index >= 0) {
		const auto value = SpaceTable::kTones[index][IsDark() ? 1 : 0][int(tone)];
		if (value) {
			return QColor::fromRgba(value);
		}
	}
	return TelegramTone(tone); // «Telegram»: нейтральные тона — из палитры мессенджера
}

rpl::producer<> TonesChanges() {
	return Window::Theme::Background()->updates(
	) | rpl::filter([](const Window::Theme::BackgroundUpdate &update) {
		return update.paletteChanged();
	}) | rpl::to_empty;
}

QString UiFontFamily(const QString &custom) {
	if (!custom.isEmpty()) {
		return custom;
	}
	return u"IBM Plex Sans"_q;
}

void SetupFontFallbacks() {
	// Plex — латиница, кириллица, греческий; арабское письмо — встроенный Vazirmatn, как у Open Sans
	QFont::insertSubstitutions(u"IBM Plex Sans"_q, {
		u"Vazirmatn UI NL"_q,
		u"Open Sans"_q,
	});
}

} // namespace Parvane
