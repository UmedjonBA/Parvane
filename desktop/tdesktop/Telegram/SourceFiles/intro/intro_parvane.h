// Parvane fork: экран логина через шард identity (вместо телефон/код Telegram).
// Поля user/password → identity.token.issue → JWT → синтез self MTPUser →
// Step::createSession. Заменяет стартовый intro-экран (Фаза 2, срез логина).
#pragma once

#include "intro/intro_step.h"

namespace Ui {
class InputField;
class PasswordInput;
class LinkButton;
} // namespace Ui

namespace Intro {
namespace details {

class ParvaneWidget final : public Step {
public:
	ParvaneWidget(
		QWidget *parent,
		not_null<Main::Account*> account,
		not_null<Data*> data);

	void setInnerFocus() override;
	void activate() override;
	void submit() override;
	rpl::producer<QString> nextButtonText() const override;

protected:
	void resizeEvent(QResizeEvent *e) override;

private:
	void updateControlsGeometry();
	void onIssued(const QString &user, bool ok, QString token, QString error);
	void loginSucceeded(const QString &user);

	// Регистрация через почту (PARVANE_EMAIL_REQUIRED на identity): после
	// пароля — экран email, затем 6-значный код из письма (identity.email.confirm).
	enum class Stage { Login, Email, Code, Telegram };
	void setStage(Stage stage);
	void finishLogin(const QString &user, const QString &password);
	// Экран Telegram: deep link боту + опрос identity.register.status.
	// mode: регистрация (после подтверждения — обычный вход) или двухфакторный
	// вход (Issue с loginToken).
	enum class TelegramMode { Register, Login };
	void startTelegram(
		const QString &user,
		const QString &password,
		const QString &token,
		const QString &bot,
		TelegramMode mode);
	void pollTelegram();
	// Headless e2e: PARVANE_AUTOCODE_FILE — опрос файла с кодом (тест пишет его
	// из лога identity); уже испробованный код повторно не шлём.
	void startCodeFilePoll();
	QString _lastCodeTried;

	object_ptr<Ui::InputField> _user;
	object_ptr<Ui::PasswordInput> _password;
	object_ptr<Ui::InputField> _email;
	object_ptr<Ui::InputField> _code;
	Stage _stage = Stage::Login;
	bool _requesting = false;
	bool _autologinTried = false;
	// Домен сервера (identity.server.info): голый ник → ник@домен
	QString _serverDomain;
	QString _serverConfirm;
	QString _serverBot;
	bool _serverInfoLoaded = false;
	// Состояние экрана Telegram
	QString _tgUser;
	QString _tgPassword;
	QString _tgToken;
	TelegramMode _tgMode = TelegramMode::Register;
	int _tgGeneration = 0;
	qint64 _tgStartedAt = 0;
	object_ptr<Ui::InputField> _tgLink;
	// Кнопка-переключатель видимости пароля (нет нативной в PasswordInput)
	object_ptr<Ui::LinkButton> _showPassword;
	bool _passwordShown = false;
	void togglePasswordShown();

};

} // namespace details
} // namespace Intro
