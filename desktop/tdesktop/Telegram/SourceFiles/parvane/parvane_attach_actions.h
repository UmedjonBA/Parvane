// Parvane fork (spec 030): пункты меню вложений, которых нет у Telegram или которые у Telegram завязаны на его
// сервисы, — «Предложить в план» (задание в чат, TASK-1), «Статья» (заметка «Знаний», ARTICLE-1) и
// «Геопозиция» с трансляцией. Как web `AttachMenu.tsx`, `TaskOfferModal.tsx`, `ArticlePickerModal.tsx`.
#pragma once

#include <QtCore/QPoint>

class PeerData;

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

// Окно «Предложить в план»: название, описание, шаги, день/начало/длительность либо срок → `task_offer`
void ShowTaskOfferBox(not_null<Window::SessionController*> controller, not_null<PeerData*> peer);

// Выбор заметки «Знаний» → `article` (название, Markdown без свойств, `text` для клиентов без окна чтения)
void ShowArticlePicker(not_null<Window::SessionController*> controller, not_null<PeerData*> peer);

// Подменю «Геопозиция»: текущая либо трансляция 15 мин / 1 ч / 8 ч (координаты вводятся — у компьютера нет
// службы местоположения)
void ShowLocationMenu(
	not_null<Window::SessionController*> controller,
	not_null<PeerData*> peer,
	QPoint globalPosition);

} // namespace Parvane
