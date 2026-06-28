// Parvane fork: точка входа клиента Parvane внутри tdesktop. Пока — только
// проверка, что транспорт parvane-core слинкован в бинарь (Фаза 2, шаг 23a).
// Дальше здесь появится владение parvane::Transport, логин и мост к Main::Session.
#pragma once

namespace Parvane {

// URL шины из PARVANE_NATS_URL (или дефолт). Реального соединения не открывает.
[[nodiscard]] QString NatsUrl();

// Логирует факт линковки транспорта и целевой NATS-URL. Зовётся из
// Application::run() как ранний sanity-check интеграции (соединение не трогает).
void LogStartup();

} // namespace Parvane
