// Parvane fork: язык интерфейса без облачного каталога Telegram (ревью безопасности 21 окт 2026).
//
// Русский пакет (`desktop/langs/parvane_ru_RU.strings`) встроен в бинарь ресурсом qrc
// (`Resources/qrc/telegram/parvane_space.qrc`, `:/parvane/lang/parvane_ru_RU.strings`). Прежде релиз брал его только
// из PARVANE_LANG_FILE — подменный файл менял, например, текст окна одобрения привязки устройства; без переменной
// «Русский» в настройках ничего не делал. Теперь релиз переменную не читает; dev-сборка — только при открытом шлюзе
// dev-хуков (стенд), иначе тоже встроенный пакет.
#pragma once

#include <QtCore/QString>

namespace Parvane {

// Путь русского пакета: dev-стенд — PARVANE_LANG_FILE (если задан и шлюз dev-хуков открыт), иначе встроенный ресурс.
[[nodiscard]] QString RussianLangPackPath();

// Русский сейчас выбран (свой пакет)?
[[nodiscard]] bool RussianLanguageActive();

// Включить русский сразу (без перезапуска).
void SwitchToRussian();

// Включить английский (встроенный базовый язык; с перезапуском, как прежде в настройках).
void SwitchToEnglish();

// При старте (Application::run): релиз — русский по умолчанию на первом запуске профиля; если выбран наш русский —
// перечитать встроенный пакет (новые строки версии); dev — как прежде, только при PARVANE_LANG_FILE.
void ApplyDefaultLanguage();

} // namespace Parvane
