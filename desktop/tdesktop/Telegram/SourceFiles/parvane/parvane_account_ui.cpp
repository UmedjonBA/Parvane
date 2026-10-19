// Parvane fork: окна аккаунта (parvane_account_ui.h). Тексты — как web `SettingsActiveSessions.tsx`.
#include "parvane/parvane_kit.h"
#include "parvane/parvane_account_ui.h"

#include "parvane/parvane_client.h"

#include "base/call_delayed.h"
#include "base/timer.h"
#include "boxes/abstract_box.h"
#include "lang/lang_keys.h"
#include "main/main_session.h"
#include "settings/cloud_password/settings_cloud_password_common.h"
#include "settings/settings_common.h"
#include "ui/boxes/confirm_box.h"
#include "ui/layers/generic_box.h"
#include "ui/layers/show.h"
#include "ui/vertical_list.h"
#include "ui/widgets/buttons.h"
#include "ui/widgets/checkbox.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/fields/password_input.h"
#include "ui/widgets/labels.h"
#include "ui/wrap/slide_wrap.h"
#include "ui/wrap/vertical_layout.h"
#include "window/window_session_controller.h"
#include "styles/style_boxes.h"
#include "styles/style_layers.h"
#include "styles/style_menu_icons.h"
#include "styles/style_settings.h"

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>
#include <QtGui/QClipboard>
#include <QtGui/QGuiApplication>
#include <QtCore/QDateTime>
#include <QtCore/QLocale>
#include <QtCore/QRegularExpression>

namespace Parvane {
namespace {

constexpr auto kExtrasRefresh = crl::time(15000); // как web: экран «Устройства» перечитывает свой журнал
constexpr auto kSignOutAfterDelete = crl::time(4000);
const auto kNickRule = QRegularExpression(u"^[a-z0-9][a-z0-9_.-]{1,63}$"_q);

using ToastFn = Fn<void(QString)>;

enum class SignOutMode {
	Keep,
	Rotate,
};

// Поле ввода в окне: ключ (видимый текст) либо пароль. done — непустое значение.
void AskText(
		std::shared_ptr<Ui::Show> show,
		rpl::producer<QString> title,
		rpl::producer<QString> about,
		rpl::producer<QString> placeholder,
		rpl::producer<QString> button,
		bool secret,
		Fn<void(QString)> done) {
	show->showBox(Box([=](not_null<Ui::GenericBox*> box) mutable {
		box->setTitle(std::move(title));
		box->addRow(object_ptr<Ui::FlatLabel>(box, std::move(about), st::boxLabel));
		if (secret) {
			const auto field = Settings::CloudPassword::AddPasswordField(
				box->verticalLayout(),
				std::move(placeholder),
				QString());
			box->setFocusCallback([=] { field->setFocus(); });
			const auto submit = [=] {
				const auto value = field->getLastText();
				if (value.isEmpty()) {
					field->showError();
					return;
				}
				box->closeBox();
				done(value);
			};
			QObject::connect(field, &Ui::MaskedInputField::submitted, submit);
			box->addButton(std::move(button), submit);
		} else {
			const auto field = box->addRow(object_ptr<Ui::InputField>(
				box,
				st::defaultInputField,
				std::move(placeholder)));
			box->setFocusCallback([=] { field->setFocusFast(); });
			const auto submit = [=] {
				const auto value = field->getLastText().trimmed();
				if (value.isEmpty()) {
					field->showError();
					return;
				}
				box->closeBox();
				done(value);
			};
			field->submits() | rpl::on_next(submit, field->lifetime());
			box->addButton(std::move(button), submit);
		}
		box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
	}));
}

// Работа на воркере, итог — на main (если получатель ещё жив).
void RunWork(not_null<QObject*> guard, Fn<QString()> work, Fn<void(QString)> done) {
	crl::async([=] {
		const auto result = work();
		crl::on_main(guard, [=] { done(result); });
	});
}

[[nodiscard]] QString TelegramStateText(TelegramRecoveryState state) {
	switch (state) {
	case TelegramRecoveryState::Waiting: return tr::lng_parvane_tg_recover_waiting(tr::now);
	case TelegramRecoveryState::Joining: return tr::lng_parvane_tg_recover_joining(tr::now);
	case TelegramRecoveryState::Done: return tr::lng_parvane_tg_recover_done(tr::now);
	case TelegramRecoveryState::Failed: return tr::lng_parvane_tg_recover_failed(tr::now);
	case TelegramRecoveryState::Limit: return tr::lng_parvane_tg_recover_limit(tr::now);
	case TelegramRecoveryState::Expired: return tr::lng_parvane_tg_recover_expired(tr::now);
	case TelegramRecoveryState::Idle:
	case TelegramRecoveryState::Unavailable: break;
	}
	return QString();
}

[[nodiscard]] bool CanAskAgain(TelegramRecoveryState state) {
	return state == TelegramRecoveryState::Waiting
		|| state == TelegramRecoveryState::Expired
		|| state == TelegramRecoveryState::Limit
		|| state == TelegramRecoveryState::Failed;
}

[[nodiscard]] rpl::producer<LinkingStatus> LinkingStatusValue() {
	return rpl::single(rpl::empty) | rpl::then(
		LinkingStatusChanges()
	) | rpl::map([] { return CurrentLinkingStatus(); });
}

// Подпись блока: текст из потока; пустой — блок скрыт.
void AddHiddenWhenEmpty(
		not_null<Ui::VerticalLayout*> container,
		rpl::producer<QString> title,
		rpl::producer<QString> text) {
	auto shared = rpl::duplicate(text) | rpl::start_spawning(container->lifetime());
	const auto wrap = container->add(object_ptr<Ui::SlideWrap<Ui::VerticalLayout>>(
		container,
		object_ptr<Ui::VerticalLayout>(container)));
	const auto inner = wrap->entity();
	Ui::AddSkip(inner);
	Ui::AddSubsectionTitle(inner, std::move(title));
	Ui::AddDividerText(inner, rpl::duplicate(shared));
	wrap->toggleOn(std::move(shared) | rpl::map([](const QString &value) {
		return !value.isEmpty();
	}));
	wrap->finishAnimating();
}

// Содержимое привязки (окно и экран «Устройства»): Telegram, другое устройство, ключ, сброс.
void FillLinking(
		not_null<Ui::VerticalLayout*> container,
		std::shared_ptr<Ui::Show> show) {
	auto status = LinkingStatusValue() | rpl::start_spawning(container->lifetime());
	AddHiddenWhenEmpty(
		container,
		tr::lng_parvane_tg_recover_title(),
		rpl::duplicate(status) | rpl::map([](const LinkingStatus &s) {
			return TelegramStateText(s.telegram);
		}));
	const auto againWrap = container->add(object_ptr<Ui::SlideWrap<Ui::VerticalLayout>>(
		container,
		object_ptr<Ui::VerticalLayout>(container)));
	Settings::AddButtonWithIcon(
		againWrap->entity(),
		tr::lng_parvane_tg_recover_again(),
		st::settingsButton,
		{ &st::menuIconRestore }
	)->addClickHandler([] {
		RequestTelegramKeyAgain();
	});
	againWrap->toggleOn(rpl::duplicate(status) | rpl::map([](const LinkingStatus &s) {
		return CanAskAgain(s.telegram);
	}));
	againWrap->finishAnimating();

	AddHiddenWhenEmpty(
		container,
		tr::lng_parvane_link_pending_title(),
		rpl::duplicate(status) | rpl::map([](const LinkingStatus &s) {
			return s.linkCode.isEmpty()
				? tr::lng_parvane_link_pending_wait(tr::now)
				: tr::lng_parvane_link_pending_text(tr::now, lt_code, s.linkCode);
		}));

	Ui::AddSkip(container);
	Ui::AddSubsectionTitle(container, tr::lng_parvane_recover_title());
	Settings::AddButtonWithIcon(
		container,
		tr::lng_parvane_recover_action(),
		st::settingsButton,
		{ &st::menuIconLock }
	)->addClickHandler([=] {
		AskText(
			show,
			tr::lng_parvane_recover_title(),
			tr::lng_parvane_recover_text(),
			tr::lng_parvane_ssk_rotation_placeholder(),
			tr::lng_parvane_recover_action(),
			false,
			[=](QString key) {
				RunWork(container, [=] { return RecoverWithKey(key); }, [=](QString result) {
					show->showToast((result == u"ok"_q)
						? tr::lng_parvane_recover_done(tr::now)
						: (result == u"bad_key"_q)
						? tr::lng_parvane_ssk_rotation_bad_key(tr::now)
						: (result == u"no_backup"_q)
						? tr::lng_parvane_recover_no_backup(tr::now)
						: tr::lng_parvane_tg_recover_failed(tr::now));
				});
			});
	});
	Settings::AddButtonWithIcon(
		container,
		tr::lng_parvane_reset_action(),
		st::settingsAttentionButtonWithIcon,
		{ &st::menuIconDeleteAttention }
	)->addClickHandler([=] {
		AskText(
			show,
			tr::lng_parvane_reset_action(),
			tr::lng_parvane_reset_text(),
			tr::lng_parvane_password_confirm(),
			tr::lng_parvane_reset_confirm(),
			true,
			[=](QString password) {
				RunWork(container, [=] { return ResetIdentityWithPassword(password); }, [=](QString result) {
					show->showToast((result == u"ok"_q)
						? tr::lng_parvane_reset_done(tr::now)
						: (result == u"bad_password"_q)
						? tr::lng_parvane_reset_bad_password(tr::now)
						: tr::lng_parvane_reset_failed(tr::now));
				});
			});
	});
	Ui::AddSkip(container);
}

// Блок с текстом и кнопкой, которая спрашивает ключ восстановления.
void AddKeyAction(
		not_null<Ui::VerticalLayout*> container,
		std::shared_ptr<Ui::Show> show,
		rpl::producer<QString> title,
		rpl::producer<QString> text,
		rpl::producer<QString> action,
		Fn<QString(QString)> work,
		Fn<QString(QString)> message,
		Fn<void()> refresh) {
	Ui::AddSkip(container);
	Ui::AddSubsectionTitle(container, rpl::duplicate(title));
	auto about = std::move(text) | rpl::start_spawning(container->lifetime());
	Ui::AddDividerText(container, rpl::duplicate(about));
	auto buttonText = std::move(action) | rpl::start_spawning(container->lifetime());
	Settings::AddButtonWithIcon(
		container,
		rpl::duplicate(buttonText),
		st::settingsButton,
		{ &st::menuIconLock }
	)->addClickHandler([=]() mutable {
		AskText(
			show,
			rpl::duplicate(title),
			rpl::duplicate(about),
			tr::lng_parvane_ssk_rotation_placeholder(),
			rpl::duplicate(buttonText),
			false,
			[=](QString key) {
				RunWork(container, [=] { return work(key); }, [=](QString result) {
					show->showToast(message(result));
					if (result == u"ok"_q) {
						refresh();
					}
				});
			});
	});
}

void FillReadyExtras(
		not_null<Ui::VerticalLayout*> container,
		std::shared_ptr<Ui::Show> show,
		const DevicesExtras &extras,
		Fn<void()> refresh) {
	if (extras.rotationNeeded) {
		AddKeyAction(
			container,
			show,
			tr::lng_parvane_ssk_rotation_title(),
			tr::lng_parvane_ssk_rotation_text(),
			tr::lng_parvane_ssk_rotation_action(),
			[](QString key) { return RotateSskWithKey(key); },
			[](QString result) {
				return (result == u"ok"_q)
					? tr::lng_parvane_ssk_rotation_done(tr::now)
					: (result == u"bad_key"_q)
					? tr::lng_parvane_ssk_rotation_bad_key(tr::now)
					: (result == u"no_backup"_q)
					? tr::lng_parvane_ssk_rotation_no_backup(tr::now)
					: tr::lng_parvane_ssk_rotation_failed(tr::now);
			},
			refresh);
	}
	if (!extras.leftDevices.empty()) {
		Ui::AddSkip(container);
		Ui::AddSubsectionTitle(container, tr::lng_parvane_left_devices());
		for (const auto &id : extras.leftDevices) {
			const auto name = u"Parvane "_q + id.left(8);
			Settings::AddButtonWithLabel(
				container,
				rpl::single(name),
				tr::lng_parvane_left_device_stolen(),
				st::settingsButton,
				{ &st::menuIconBlock }
			)->addClickHandler([=] {
				show->showBox(Ui::MakeConfirmBox({
					.text = tr::lng_parvane_left_device_stolen_confirm(tr::now, lt_device, name),
					.confirmed = [=](Fn<void()> close) {
						close();
						RunWork(container, [=] {
							return ReportDeviceStolen(id) ? u"ok"_q : u"failed"_q;
						}, [=](QString result) {
							show->showToast((result == u"ok"_q)
								? tr::lng_parvane_left_device_stolen_done(tr::now)
								: tr::lng_parvane_left_device_stolen_failed(tr::now));
							refresh();
						});
					},
					.confirmText = tr::lng_parvane_left_device_stolen(),
					.confirmStyle = &st::attentionBoxButton,
				}));
			});
		}
		Ui::AddSkip(container);
		Ui::AddDividerText(container, tr::lng_parvane_left_devices_hint());
	}
	if (extras.escrowMissing) {
		AddKeyAction(
			container,
			show,
			tr::lng_parvane_escrow_title(),
			tr::lng_parvane_escrow_text(),
			tr::lng_parvane_escrow_action(),
			[](QString key) { return StoreEscrowCopy(key); },
			[](QString result) {
				return (result == u"ok"_q)
					? tr::lng_parvane_escrow_done(tr::now)
					: (result == u"bad_key"_q)
					? tr::lng_parvane_ssk_rotation_bad_key(tr::now)
					: tr::lng_parvane_ssk_rotation_failed(tr::now);
			},
			refresh);
	}
	if (extras.canSendTelegram) {
		AddKeyAction(
			container,
			show,
			tr::lng_parvane_tg_send_title(),
			tr::lng_parvane_tg_send_text(),
			tr::lng_parvane_tg_send_action(),
			[](QString key) { return SendRecoveryKeyToTelegram(key); },
			[](QString result) {
				return (result == u"ok"_q)
					? tr::lng_parvane_tg_send_done(tr::now)
					: (result == u"bad_key"_q)
					? tr::lng_parvane_ssk_rotation_bad_key(tr::now)
					: (result == u"no_telegram"_q)
					? tr::lng_parvane_tg_send_no_telegram(tr::now)
					: tr::lng_parvane_ssk_rotation_failed(tr::now);
			},
			refresh);
	}
}

} // namespace

void ShowLinkingBox() {
	static auto shown = base::weak_qptr<Ui::BoxContent>();
	if (shown || !CurrentLinkingStatus().needsLinking) {
		return;
	}
	auto box = Box([](not_null<Ui::GenericBox*> box) {
		box->setTitle(tr::lng_parvane_linking_title());
		box->setWidth(st::boxWideWidth);
		box->addRow(object_ptr<Ui::FlatLabel>(
			box,
			tr::lng_parvane_needs_linking_notice(),
			st::boxLabel));
		FillLinking(box->verticalLayout(), box->uiShow());
		box->addButton(tr::lng_close(), [=] { box->closeBox(); });
		LinkingStatusChanges() | rpl::filter([] {
			return !CurrentLinkingStatus().needsLinking;
		}) | rpl::take(1) | rpl::on_next([=] {
			box->closeBox();
		}, box->lifetime());
	});
	shown = base::make_weak(box.data());
	Ui::show(std::move(box));
}

void ShowRecoveryKeyBox(const QString &key) {
	Ui::show(Box([=](not_null<Ui::GenericBox*> box) {
		box->setTitle(tr::lng_parvane_recovery_key_title());
		box->setCloseByOutsideClick(false);
		box->setCloseByEscape(false);
		box->addRow(object_ptr<Ui::FlatLabel>(
			box,
			tr::lng_parvane_recovery_key_about(),
			st::boxLabel));
		const auto label = box->addRow(
			object_ptr<Ui::FlatLabel>(box, rpl::single(key), st::boxLabel),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		label->setSelectable(true);
		box->addButton(tr::lng_parvane_recovery_key_saved(), [=] { box->closeBox(); });
		box->addLeftButton(tr::lng_parvane_recovery_key_copy(), [=] {
			QGuiApplication::clipboard()->setText(key);
			box->showToast(tr::lng_parvane_recovery_key_copied(tr::now));
		});
	}));
}

void AskSignOutPassword(
		bool many,
		Fn<void(QString password, bool rotateKeys)> done,
		Fn<void()> cancelled) {
	Ui::show(Box([=](not_null<Ui::GenericBox*> box) {
		const auto decided = std::make_shared<bool>(false);
		box->setTitle(many
			? tr::lng_sessions_terminate_all()
			: tr::lng_sessions_terminate());
		box->addRow(object_ptr<Ui::FlatLabel>(
			box,
			tr::lng_parvane_session_password_hint(),
			st::boxLabel));
		const auto field = Settings::CloudPassword::AddPasswordField(
			box->verticalLayout(),
			tr::lng_parvane_password_confirm(),
			QString());
		const auto group = std::make_shared<Ui::RadioenumGroup<SignOutMode>>(SignOutMode::Keep);
		const auto addMode = [&](SignOutMode mode, tr::phrase<> title, tr::phrase<> hint) {
			box->addRow(
				object_ptr<Ui::Radioenum<SignOutMode>>(box, group, mode, title(tr::now)),
				st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
			box->addRow(
				object_ptr<Ui::FlatLabel>(box, hint(), st::boxDividerLabel),
				st::boxRowPadding + QMargins(st::defaultCheckbox.textPosition.x(), 0, 0, 0));
		};
		addMode(SignOutMode::Keep, tr::lng_parvane_sign_out_keep, tr::lng_parvane_sign_out_keep_hint);
		addMode(SignOutMode::Rotate, tr::lng_parvane_sign_out_rotate, tr::lng_parvane_sign_out_rotate_hint);
		box->setFocusCallback([=] { field->setFocus(); });
		const auto submit = [=] {
			const auto value = field->getLastText();
			if (value.isEmpty()) {
				field->showError();
				return;
			}
			*decided = true;
			box->closeBox();
			done(value, group->current() == SignOutMode::Rotate);
		};
		QObject::connect(field, &Ui::MaskedInputField::submitted, submit);
		box->addButton(tr::lng_sessions_terminate(), submit, st::attentionBoxButton);
		box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
		box->boxClosing() | rpl::on_next([=] {
			if (!*decided && cancelled) {
				cancelled();
			}
		}, box->lifetime());
	}));
}

void ShowRenameBox(not_null<Window::SessionController*> controller) {
	controller->show(Box([=](not_null<Ui::GenericBox*> box) {
		box->setTitle(tr::lng_parvane_rename_title());
		box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_rename_hint(), st::boxLabel));
		const auto nick = box->addRow(object_ptr<Ui::InputField>(
			box,
			st::defaultInputField,
			tr::lng_parvane_rename_nick()));
		box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_rename_nick_rule(), st::boxDividerLabel));
		const auto password = Settings::CloudPassword::AddPasswordField(
			box->verticalLayout(),
			tr::lng_parvane_rename_password(),
			QString());
		const auto key = box->addRow(object_ptr<Ui::InputField>(
			box,
			st::defaultInputField,
			tr::lng_parvane_rename_recovery_key()));
		const auto error = box->addRow(object_ptr<Ui::FlatLabel>(box, QString(), st::boxLabel));
		error->setTextColorOverride(st::boxTextFgError->c);
		box->setFocusCallback([=] { nick->setFocusFast(); });
		const auto busy = std::make_shared<bool>(false);
		const auto submit = [=] {
			if (*busy) {
				return;
			}
			const auto nickText = nick->getLastText().trimmed().toLower();
			if (!kNickRule.match(nickText).hasMatch()) {
				nick->showError();
				error->setText(tr::lng_parvane_nick_invalid(tr::now));
				return;
			}
			if (password->getLastText().isEmpty()) {
				password->showError();
				return;
			}
			if (key->getLastText().trimmed().isEmpty()) {
				key->showError();
				return;
			}
			*busy = true;
			const auto passwordText = password->getLastText();
			const auto keyText = key->getLastText();
			RunWork(box, [=] { return RenameAccount(nickText, passwordText, keyText); }, [=](QString result) {
				*busy = false;
				if (result == u"ok"_q) {
					box->closeBox();
					controller->showToast(tr::lng_parvane_rename_done(tr::now));
					return;
				}
				error->setText((result == u"bad_password"_q)
					? tr::lng_parvane_rename_error_password(tr::now)
					: (result == u"bad_key"_q)
					? tr::lng_parvane_rename_error_key(tr::now)
					: (result == u"no_backup"_q)
					? tr::lng_parvane_rename_error_no_backup(tr::now)
					: (result == u"taken"_q)
					? tr::lng_parvane_rename_error_taken(tr::now)
					: (result == u"invalid"_q)
					? tr::lng_parvane_rename_error_invalid(tr::now)
					: tr::lng_parvane_rename_error_failed(tr::now));
			});
		};
		nick->submits() | rpl::on_next(submit, nick->lifetime());
		key->submits() | rpl::on_next(submit, key->lifetime());
		box->addButton(tr::lng_parvane_rename_submit(), submit);
		box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
	}));
}

void ShowDeleteAccountBox(not_null<Window::SessionController*> controller) {
	controller->show(Box([=](not_null<Ui::GenericBox*> box) {
		box->setTitle(tr::lng_parvane_delete_account_title());
		box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_delete_account_hint(), st::boxLabel));
		for (const auto &point : {
				tr::lng_parvane_delete_account_point_data,
				tr::lng_parvane_delete_account_point_nick,
				tr::lng_parvane_delete_account_point_restore,
				tr::lng_parvane_delete_account_point_export }) {
			box->addRow(
				object_ptr<Ui::FlatLabel>(box, u"• "_q + point(tr::now), st::boxDividerLabel),
				st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		}
		const auto password = Settings::CloudPassword::AddPasswordField(
			box->verticalLayout(),
			tr::lng_parvane_password_confirm(),
			QString());
		const auto error = box->addRow(object_ptr<Ui::FlatLabel>(box, QString(), st::boxLabel));
		error->setTextColorOverride(st::boxTextFgError->c);
		box->setFocusCallback([=] { password->setFocus(); });
		const auto busy = std::make_shared<bool>(false);
		const auto submit = [=] {
			if (*busy) {
				return;
			}
			const auto value = password->getLastText();
			if (value.isEmpty()) {
				password->showError();
				return;
			}
			*busy = true;
			crl::async([=] {
				const auto out = DeleteAccount(value);
				crl::on_main(box, [=] {
					*busy = false;
					if (out.result != u"ok"_q) {
						error->setText((out.result == u"bad_password"_q)
							? tr::lng_parvane_delete_account_error_password(tr::now)
							: tr::lng_parvane_delete_account_error_failed(tr::now));
						return;
					}
					const auto date = QLocale().toString(
						QDateTime::fromMSecsSinceEpoch(out.deletionAtMs).date(),
						QLocale::LongFormat);
					controller->showToast(tr::lng_parvane_delete_account_done(tr::now, lt_date, date));
					box->closeBox();
					base::call_delayed(kSignOutAfterDelete, [] { SignOutDeletedAccount(); });
				});
			});
		};
		QObject::connect(password, &Ui::MaskedInputField::submitted, submit);
		box->addButton(tr::lng_parvane_delete_account_submit(), submit, st::attentionBoxButton);
		box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
	}));
}

void ShowBugReportBox(not_null<Window::SessionController*> controller) {
	const auto session = &controller->session();
	controller->show(Box([=](not_null<Ui::GenericBox*> box) {
		box->setTitle(tr::lng_parvane_bug_report());
		box->addRow(object_ptr<Ui::FlatLabel>(box, tr::lng_parvane_bug_report_about(), st::boxLabel));
		const auto field = box->addRow(object_ptr<Ui::InputField>(
			box,
			st::newGroupDescription,
			Ui::InputField::Mode::MultiLine,
			tr::lng_parvane_bug_report_placeholder()));
		field->setMaxLength(4000);
		box->setFocusCallback([=] { field->setFocusFast(); });
		const auto busy = std::make_shared<bool>(false);
		const auto submit = [=] {
			const auto text = field->getLastText().trimmed();
			if (*busy) {
				return;
			} else if (text.isEmpty()) {
				field->showError();
				return;
			}
			*busy = true;
			SendBugReport(session, text, crl::guard(box, [=](QString result) {
				*busy = false;
				if (result == u"sent"_q) {
					controller->showToast(tr::lng_parvane_bug_report_sent(tr::now));
					box->closeBox();
				} else {
					controller->showToast((result == u"not_found"_q)
						? tr::lng_parvane_bug_report_no_address(tr::now)
						: tr::lng_parvane_bug_report_failed(tr::now));
				}
			}));
		};
		box->addButton(tr::lng_parvane_bug_report_send(), submit);
		box->addButton(tr::lng_cancel(), [=] { box->closeBox(); });
	}));
}

void AddDevicesExtras(
		not_null<Ui::VerticalLayout*> container,
		not_null<Window::SessionController*> controller) {
	const auto show = controller->uiShow();
	const auto linking = container->add(object_ptr<Ui::SlideWrap<Ui::VerticalLayout>>(
		container,
		object_ptr<Ui::VerticalLayout>(container)));
	FillLinking(linking->entity(), show);
	linking->toggleOn(LinkingStatusValue() | rpl::map([](const LinkingStatus &s) {
		return s.needsLinking;
	}) | rpl::distinct_until_changed());
	linking->finishAnimating();

	const auto ready = container->add(object_ptr<Ui::VerticalLayout>(container));
	const auto fetching = std::make_shared<bool>(false);
	const auto refresh = std::make_shared<Fn<void()>>();
	*refresh = [=] {
		if (*fetching) {
			return;
		}
		*fetching = true;
		crl::async([=] {
			const auto extras = FetchDevicesExtras();
			crl::on_main(ready, [=] {
				*fetching = false;
				Parvane::Kit::ClearLayout(ready);
				if (extras.ready) {
					FillReadyExtras(ready, show, extras, [=] { (*refresh)(); });
				}
				ready->resizeToWidth(container->width());
			});
		});
	};
	const auto timer = ready->lifetime().make_state<base::Timer>([=] { (*refresh)(); });
	timer->callEach(kExtrasRefresh);
	(*refresh)();
}

} // namespace Parvane
