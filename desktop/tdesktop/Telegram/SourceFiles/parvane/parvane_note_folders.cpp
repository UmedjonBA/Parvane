// Parvane fork: реализация parvane_note_folders.h.
#include "parvane/parvane_note_folders.h"

#include "lang/lang_keys.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/wrap/vertical_layout.h"

namespace Parvane::Knowledge {
namespace {

// Поле названия, строка ошибки и занятость формы
struct FolderForm {
	Kit::Field *field = nullptr;
	Kit::Label *error = nullptr;
	std::shared_ptr<bool> busy = std::make_shared<bool>(false);

	void showError(std::optional<notes::FolderSubmitError> value) const {
		error->setText(value ? FolderErrorText(*value) : QString());
		error->setVisible(value.has_value());
		field->setError(value.has_value());
	}
};

[[nodiscard]] FolderForm AddForm(not_null<Kit::Sheet*> sheet, const QString &value) {
	auto result = FolderForm();
	result.field = sheet->add(object_ptr<Kit::Field>(
		sheet,
		Kit::Field::Kind::Input,
		tr::lng_parvane_notes_folder_name(),
		value));
	result.field->input()->setMaxLength(notes::kFolderNameMax);
	result.error = sheet->add(object_ptr<Kit::Label>(sheet, QString(), Kit::Label::Error()));
	result.error->hide();
	return result;
}

// Отправка формы: пустое — «плохое название», иначе — вызов с ответом; без ошибки — onDone
void Submit(const FolderForm &form, const FolderSubmit &submit, Fn<void()> onDone) {
	const auto value = form.field->text().trimmed();
	if (*form.busy) {
		return;
	}
	if (value.isEmpty()) {
		form.showError(notes::FolderSubmitError::BadName);
		return;
	}
	*form.busy = true;
	const auto busy = form.busy;
	const auto weak = QPointer<Kit::Field>(form.field);
	const auto copy = form;
	submit(value, [=](std::optional<notes::FolderSubmitError> failure) {
		*busy = false;
		if (!weak) {
			return;
		}
		copy.showError(failure);
		if (!failure && onDone) {
			onDone();
		}
	});
}

} // namespace

QString FolderErrorText(notes::FolderSubmitError error) {
	switch (error) {
	case notes::FolderSubmitError::BadName: return tr::lng_parvane_notes_folder_bad_name(tr::now);
	case notes::FolderSubmitError::Taken: return tr::lng_parvane_notes_folder_taken(tr::now);
	case notes::FolderSubmitError::Failed: break;
	}
	return tr::lng_parvane_notes_folder_failed(tr::now);
}

void ShowFolderSheet(
		not_null<QWidget*> parent,
		std::optional<notes::NoteFolder> folder,
		FolderSubmit submit,
		Fn<void()> remove) {
	const auto sheet = Kit::Sheet::Show(parent, {
		.title = folder ? Q(notes::folderCaption(folder->path)) : tr::lng_parvane_notes_new_folder(tr::now),
		.closeName = tr::lng_parvane_notes_close(tr::now),
	});
	const auto form = AddForm(sheet, folder ? Q(folder->name) : QString());
	form.field->textChanges() | rpl::on_next([=] {
		form.showError(std::nullopt);
	}, form.field->lifetime());
	const auto weak = QPointer<Kit::Sheet>(sheet.get());
	const auto send = [=] {
		Submit(form, submit, [=] {
			if (weak) {
				weak->requestClose();
			}
		});
	};
	form.field->submits() | rpl::on_next(send, form.field->lifetime());
	const auto buttons = sheet->addButtons();
	const auto ok = buttons->add(object_ptr<Kit::PushButton>(
		buttons,
		folder ? tr::lng_parvane_notes_folder_rename(tr::now) : tr::lng_parvane_notes_folder_create(tr::now),
		Kit::PushButton::Kind::Accent,
		folder ? KitIcon(u"edit"_q) : u"plus"_q));
	ok->setClickedCallback(send);
	if (folder && remove) {
		const auto del = buttons->add(object_ptr<NotesTextButton>(
			buttons,
			tr::lng_parvane_notes_folder_delete(tr::now),
			u"trash"_q,
			NotesTextButton::Kind::Danger));
		del->setClickedCallback([=] {
			if (weak) {
				weak->requestClose();
			}
			remove();
		});
	}
	sheet->showSheet();
	form.field->setFocusFast();
}

void ShowFolderPicker(
		not_null<QWidget*> parent,
		const QString &noteTitle,
		const std::string &currentPath,
		const std::vector<notes::NoteFolder> &folders,
		Fn<void(std::optional<std::string> folderId)> pick,
		FolderSubmit create) {
	const auto sheet = Kit::Sheet::Show(parent, {
		.title = tr::lng_parvane_notes_move_title(tr::now, lt_name, noteTitle),
		.closeName = tr::lng_parvane_notes_close(tr::now),
		.tight = true,
	});
	const auto weak = QPointer<Kit::Sheet>(sheet.get());
	const auto addOption = [&](const std::string &path, std::optional<std::string> folderId) {
		const auto isCurrent = (path == currentPath);
		const auto row = sheet->add(object_ptr<IconRow>(sheet, IconRow::Descriptor{
			.title = FolderCaption(path),
			.icon = u"folder"_q,
			.tone = FolderTone(path),
			.trailingIcon = isCurrent ? u"check"_q : QString(),
			.selected = isCurrent,
		}));
		row->setClickedCallback([=] {
			if (weak) {
				weak->requestClose();
			}
			pick(folderId);
		});
	};
	addOption(std::string(), std::nullopt);
	for (const auto &folder : folders) {
		addOption(folder.path, folder.id);
	}
	const auto add = sheet->add(object_ptr<IconRow>(sheet, IconRow::Descriptor{
		.title = tr::lng_parvane_notes_move_new_folder(tr::now),
		.icon = u"plus"_q,
	}));
	add->setClickedCallback([=] {
		if (!weak) {
			return;
		}
		add->hide();
		const auto form = AddForm(weak.data(), QString());
		const auto send = [=] {
			Submit(form, create, [=] {
				if (weak) {
					weak->requestClose();
				}
			});
		};
		form.field->submits() | rpl::on_next(send, form.field->lifetime());
		const auto button = weak->add(object_ptr<Kit::PushButton>(
			weak.data(),
			tr::lng_parvane_notes_folder_create(tr::now),
			Kit::PushButton::Kind::Accent,
			u"plus"_q));
		button->setClickedCallback(send);
		form.field->setFocusFast();
	});
	sheet->showSheet();
}

} // namespace Parvane::Knowledge
