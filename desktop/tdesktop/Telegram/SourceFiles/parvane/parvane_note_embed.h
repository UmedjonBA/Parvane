// Parvane fork: встроенный файл заметки и статьи (spec 030, пункты аудита 6 и 13) — порт web
// `markdown/MediaEmbed.tsx` и `notes/NoteEmbed.tsx`: картинка — сам файл (пока читается — миниатюра облака либо
// карточка «Загрузка…»), видео и аудио — карточка с «Воспроизвести» (файл расшифровывается во временный каталог и
// открывается системным проигрывателем: своего проигрывателя у desktop нет), прочее — карточка «Скачать», не
// найден — красная карточка «Файл не найден». Источник — узел личного диска (заметка) либо вложение сообщения по
// секрету доступа (статья, CAP-1).
#pragma once

#include "parvane/parvane_knowledge_common.h"

#include <parvane/sections/cloud_model.h>

#include <nlohmann/json.hpp>

namespace Parvane::Knowledge {

struct EmbedSource {
	enum class Type {
		Missing, // файл не найден
		Cloud, // узел облака (заметка)
		Chat, // вложение сообщения (статья)
	};
	Type type = Type::Missing;
	QString name;
	int64_t size = 0;
	std::string mime;
	// Cloud
	std::string container;
	parvane::sections::cloud::CloudNode node;
	// Chat: {file_id, file_key, file_nonce, capability, mime, size_bytes, name, blob_domain?}
	nlohmann::json media;
};

[[nodiscard]] object_ptr<Ui::RpWidget> CreateEmbedView(QWidget *parent, EmbedSource source);

// Вложение сообщения по секрету доступа, расшифрованное; ответ — на главном потоке (nullopt — не вышло)
void LoadChatMediaBytes(const nlohmann::json &media, Fn<void(std::optional<QByteArray>)> done);

} // namespace Parvane::Knowledge
