// Parvane fork: картинки и превью карточек холста «Знаний» (spec 029, T063) — порт web `CanvasFileBody.tsx` и
// `CanvasLinkBody.tsx`. Миниатюра облака, сам файл картинки (общий кэш ядра `CanvasImageCache`: очередь чтения,
// предел памяти, срок жизни без карточек) и превью страницы для карточки-ссылки (шард preview — `preview.link`;
// сам клиент на чужой сайт не ходит). Чтение — заданиями в рабочий поток разделов; готовое — на главном потоке,
// о нём сообщает `Updated()`.
#pragma once

#include <parvane/sections/cloud_model.h>
#include <parvane/sections/notes_canvas_files.h>
#include <parvane/sections/notes_canvas_images.h>

#include <rpl/producer.h>

#include <QtGui/QImage>

#include <optional>
#include <string>

namespace Parvane::NotesUi::CanvasMedia {

namespace notes = parvane::sections::notes;
namespace cloud = parvane::sections::cloud;

// Выход из аккаунта: картинки, превью и настройка забываются, поздние ответы прежнего аккаунта отбрасываются
void Reset();

// Что-то загрузилось — карточкам перерисоваться
[[nodiscard]] rpl::producer<> Updated();

// Миниатюра облака узла (320 точек по длинной стороне); нет — пустая картинка, чтение начато
[[nodiscard]] QImage Thumb(const std::string &container, const cloud::CloudNode &node);

// Миниатюры у узла нет либо она не читается — карточке нечего показать, кроме самого файла
[[nodiscard]] bool ThumbUnavailable(const cloud::CloudNode &node);

// Сам файл картинки: `Acquire` по версии содержимого (`blob.fileId`) — карточка на экране и крупная; каждому
// `Acquire` — свой `Release`. `Full` — готовая картинка либо пустая
void Acquire(const std::string &container, const cloud::CloudNode &node);
void Release(const std::string &fileId);
[[nodiscard]] QImage Full(const std::string &fileId);

// Превью страницы по адресу (не больше 100 адресов в памяти); nullopt — ещё читается
struct Preview {
	notes::LinkPreview preview;
	QImage image;
};
[[nodiscard]] const Preview *LinkPreview(const std::string &url);
// Недоступные превью забываются при открытии холста: следующий показ — новая попытка
void ForgetEmptyPreviews();

// Настройка устройства «Картинки на холсте» (web `parvane:knowledge-canvas-images`)
[[nodiscard]] notes::CanvasImageQuality ImageQuality();
void SetImageQuality(notes::CanvasImageQuality quality);

} // namespace Parvane::NotesUi::CanvasMedia
