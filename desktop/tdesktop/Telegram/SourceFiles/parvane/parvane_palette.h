// Parvane fork: общий поиск по Ctrl+K (spec 029, T065) — порт web `components/parvane/palette/ParvanePalette.tsx`:
// шторка набора разделов с полем поиска и списком по группам — команды-переходы, чаты, заметки «Знаний», записи
// «Плана» и (в отличие от web) файлы облака. Что найти и в каком порядке — ядро (`parvane::sections::palette`:
// searchPalette, collectPlannerRecords); здесь — сбор записей из снимков разделов и действия по выбору.
// Открывают Ctrl+K (команда Shortcuts::Command::ParvanePalette) и «Поиск» рейки.
#pragma once

namespace rpl {
class lifetime;
} // namespace rpl

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane {

// Показать палитру поверх окна (уже открыта — только фокус в поле)
void OpenPalette(not_null<Window::SessionController*> controller);

// Слушать Ctrl+K для окна этого контроллера (зовёт рейка разделов, одна на окно)
void SetupPaletteShortcut(not_null<Window::SessionController*> controller, rpl::lifetime &lifetime);

} // namespace Parvane
