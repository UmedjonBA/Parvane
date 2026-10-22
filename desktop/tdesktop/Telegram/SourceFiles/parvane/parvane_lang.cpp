// Parvane fork: язык интерфейса без облачного каталога Telegram (ревью безопасности 21 окт 2026), см. parvane_lang.h.
#include "parvane/parvane_lang.h"

#include "parvane/parvane_client.h" // Parvane::DevEnv (шлюз dev-хуков)
#include "core/application.h"       // Core::Restart
#include "lang/lang_instance.h"
#include "storage/localstorage.h"   // Local::writeLangPack
#include "settings.h"               // cWorkingDir
#include "base/debug_log.h"

#include <parvane/local_files.h> // logpriv::devBuild — dev-сборка ли (ставится до main)

#include <QtCore/QFile>
#include <QtCore/QFileInfo>

namespace Parvane {
namespace {

// Встроенный пакет (qrc, parvane_space.qrc). Имя файла с «_ru_RU» — по нему tdesktop выбирает правила
// множественного числа (PluralCodeForCustom).
constexpr auto kEmbeddedRussian = ":/parvane/lang/parvane_ru_RU.strings";

[[nodiscard]] QString MarkerPath() {
	return cWorkingDir() + u"tdata/parvane-lang-applied"_q;
}

[[nodiscard]] QByteArray ReadMarker() {
	QFile f(MarkerPath());
	return f.open(QIODevice::ReadOnly) ? f.readAll().trimmed() : QByteArray();
}

void WriteMarker(const QByteArray &value) {
	QFile f(MarkerPath());
	if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		f.write(value);
	}
}

// Dev-стенд: PARVANE_LANG_FILE (только при открытом шлюзе dev-хуков; в релизе DevEnv всегда nullptr).
[[nodiscard]] QString DevLangFile() {
	if (const char *lf = DevEnv("PARVANE_LANG_FILE"); lf && *lf) {
		const auto path = QString::fromUtf8(lf);
		if (QFileInfo::exists(path)) {
			return path;
		}
		LOG(("Parvane: языковой файл не найден, беру встроенный: %1").arg(path));
	}
	return QString();
}

} // namespace

QString RussianLangPackPath() {
	const auto dev = DevLangFile();
	return dev.isEmpty() ? QString::fromLatin1(kEmbeddedRussian) : dev;
}

bool RussianLanguageActive() {
	return Lang::GetInstance().isCustom();
}

void SwitchToRussian() {
	Lang::GetInstance().switchToCustomFile(RussianLangPackPath());
	WriteMarker("ru");
}

void SwitchToEnglish() {
	WriteMarker("en");
	Lang::GetInstance().switchToId(Lang::DefaultLanguage());
	Local::writeLangPack();
	Core::Restart();
}

void ApplyDefaultLanguage() {
	auto path = QString();
	if (parvane::logpriv::devBuild()) {
		// Dev-сборка: как прежде — только по PARVANE_LANG_FILE (сценарии verify_* идут на английском).
		path = DevLangFile();
		if (path.isEmpty()) {
			return;
		}
	} else {
		path = QString::fromLatin1(kEmbeddedRussian);
	}
	const auto marker = ReadMarker();
	if (marker.isEmpty()) {
		// Первый запуск профиля: русский по умолчанию, дальше — выбор пользователя.
		Lang::GetInstance().switchToCustomFile(path);
		WriteMarker("ru");
		LOG(("Parvane: язык по умолчанию — русский (%1)").arg(path));
	} else if (marker == "ru" && Lang::GetInstance().isCustom()) {
		// Наш русский уже выбран: перечитать пакет — в кэше tdata лежит снимок прошлой версии без новых строк.
		Lang::GetInstance().switchToCustomFile(path);
	}
}

} // namespace Parvane
