// Parvane fork: шторки папок заметок «Знаний» (spec 029, T063) — порт web `notes/NoteFolderSheet.tsx` (новая папка,
// переименование и удаление) и `notes/NoteFolderPicker.tsx` (выбор папки для заметки: «Без папки», папки
// хранилища и «Новая папка…»).
#pragma once

#include "parvane/parvane_knowledge_common.h"

#include <parvane/sections/notes_folders.h>

namespace Parvane::Knowledge {

// Причина отказа формы папки строкой интерфейса
[[nodiscard]] QString FolderErrorText(notes::FolderSubmitError error);

using FolderSubmit = Fn<void(
	QString name,
	Fn<void(std::optional<notes::FolderSubmitError>)> done)>;

// Шторка папки: folder не задана — создаётся новая; без ошибки шторка закрывается
void ShowFolderSheet(
	not_null<QWidget*> parent,
	std::optional<notes::NoteFolder> folder,
	FolderSubmit submit,
	Fn<void()> remove);

// Выбор папки: pick(folderId) — nullopt «Без папки»; create — создать папку и перенести заметку в неё
void ShowFolderPicker(
	not_null<QWidget*> parent,
	const QString &noteTitle,
	const std::string &currentPath,
	const std::vector<notes::NoteFolder> &folders,
	Fn<void(std::optional<std::string> folderId)> pick,
	FolderSubmit create);

} // namespace Parvane::Knowledge
