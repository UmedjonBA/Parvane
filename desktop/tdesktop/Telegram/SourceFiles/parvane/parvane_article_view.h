// Parvane fork: окно чтения статьи (ARTICLE-1, spec 030 пункт аудита 13) — порт web `article/ArticleViewer.tsx`:
// Markdown статьи со встроенными файлами (`article_media`: блобы вложений по секрету доступа, CAP-1) и «Сохранить
// в заметки» — заметка в хранилище «Знаний», файлы статьи — в ту же папку облака (занятые имена — с номером,
// ссылки в тексте правятся; web `notesStore.saveChatFilesToVault`).
#pragma once

#include <nlohmann/json.hpp>

namespace Parvane {

// content — содержимое сообщения вида `article` (title, markdown, article_media)
void ShowArticleWindow(const nlohmann::json &content);

} // namespace Parvane
