// Parvane fork: раздел «Облако» (рейка — «Файлы») на desktop (spec 029, T064) — родной экран Qt по web
// `components/parvane/cloud/*` (Cloud.tsx, CloudItem, CloudMenu, CloudDialogs, CloudShareDialog, CloudTransfers,
// CloudPreview, CloudLinkDialog/CloudLinkBlock, CloudSendDialog, CloudChatDialogs). Логика — ядро
// (`parvane::sections::cloud`: cloud_model, cloud_sync, cloud_files), данные — `Parvane::Sections` (рабочий поток).
// Экран регистрирует `RegisterCloud()` (parvane_sections_host.h).
//
// Связь с чатами (web cloudBridge.ts) — точки входа ниже; вызывающие места мессенджера (меню сообщения
// «Сохранить в облако», меню вложений «Из облака») к ним ещё не подключены: TODO(spec 029, T064) — врезки в
// `history/view/history_view_context_menu.cpp` и меню вложений композера.
#pragma once

#include "base/basic_types.h"

#include <QtCore/QStringList>

class QWidget;

namespace Data {
class Thread;
} // namespace Data

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

// «Сохранить в облако» (web `requestCloudSave` + `parvaneCloudSaveFromChat`): выбрать папку личного диска и
// загрузить туда локальные файлы. Отличие от web: файл сообщения не копируется на сервере (`cloud.blob.copy` из
// медиа чатов), а загружается заново из локального файла — вызывающий передаёт пути уже скачанных вложений.
void ShowCloudSaveDialog(not_null<Window::SessionController*> controller, const QStringList &paths);

// «Из облака» (web `requestCloudAttach`): выбрать файлы личного диска и отправить их в чат `thread` штатной
// отправкой файлов (скачиваются во временный каталог и уходят через `MainWidget::sendPaths` — без копии блоба
// на сервере, как в web).
void ShowCloudAttachDialog(not_null<Window::SessionController*> controller, not_null<Data::Thread*> thread);

} // namespace Parvane
