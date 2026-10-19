// Parvane fork: «Выгрузка данных» на desktop (spec 029, T036) — окно по web `export/DataExportModal.tsx`:
// что включить (медиа чатов, файлы облака), папка для архива, ход выгрузки в фоновом потоке, отмена, итог и
// уведомление. Сборка архива — ядро (`parvane::sections::exportdata`: createProviderSource + runDataExport);
// здесь — хост провайдера поверх клиента (снимок переписки, вложения) и данных разделов («План», облако).
// Точка входа — «Настройки → Продвинутые → Выгрузить мои данные» (место бывшего «Export Telegram data»).
#pragma once

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

void ShowDataExportBox(not_null<Window::SessionController*> controller);

} // namespace Parvane
