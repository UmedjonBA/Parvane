/*
 * Parvane: регистрация из приложения (паритет с интро десктопа, режим SignUp).
 * Ник + пароль + email (если сервер подтверждает почтой) → identity.user.register
 * через шов (ParvaneCore.register). Подтверждение:
 *  - telegram: ссылка на бота открывается сама, статус опрашивается каждые 2 с
 *    (identity.register.status), после подтверждения — обычный вход;
 *  - email: поле кода → identity.email.confirm → обычный вход.
 * Обычный вход = SetAuthenticationPhoneNumber(ник) + CheckAuthenticationPassword(пароль)
 * через штатный клиент X (шов поднимает сессию и отдаёт AuthorizationStateReady).
 */
package org.thunderdog.challegram.ui;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.TextView;

import androidx.recyclerview.widget.RecyclerView;

import org.drinkless.tdlib.TdApi;
import org.json.JSONObject;
import org.parvane.core.ParvaneCore;
import org.thunderdog.challegram.R;
import org.thunderdog.challegram.navigation.BackHeaderButton;
import org.thunderdog.challegram.telegram.Tdlib;
import org.thunderdog.challegram.theme.ColorId;
import org.thunderdog.challegram.theme.Theme;
import org.thunderdog.challegram.tool.Fonts;
import org.thunderdog.challegram.tool.Screen;
import org.thunderdog.challegram.tool.UI;
import org.thunderdog.challegram.widget.MaterialEditTextGroup;
import org.thunderdog.challegram.widget.NoScrollTextView;

import me.vkryl.android.widget.FrameLayoutFix;

public class ParvaneRegisterController extends EditBaseController<Void> implements MaterialEditTextGroup.TextChangeListener {
  private MaterialEditTextGroup nickView, passwordView, emailView, codeView;
  private TextView hintView;
  private boolean inProgress;
  private String serverConfirm = "", serverBot = "";
  // подтверждение через Telegram
  private String tgAddress, tgPassword, tgToken;
  private int tgGeneration;
  private long tgStartedAt;
  private boolean codeStage;

  public ParvaneRegisterController (Context context, Tdlib tdlib) {
    super(context, tdlib);
  }

  @Override
  public int getId () {
    return R.id.controller_name;
  }

  @Override
  public CharSequence getName () {
    return UI.getAppContext().getString(R.string.ParvaneSignUp);
  }

  @Override
  public boolean isUnauthorized () {
    return true;
  }

  @Override
  protected int getBackButton () {
    return BackHeaderButton.TYPE_BACK;
  }

  private MaterialEditTextGroup field (Context context, FrameLayoutFix contentView, String hint, int topDp, boolean password) {
    FrameLayoutFix.LayoutParams params = FrameLayoutFix.newParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
    params.topMargin = Screen.dp(topDp);
    params.leftMargin = params.rightMargin = Screen.dp(16f);
    MaterialEditTextGroup v = new MaterialEditTextGroup(context, tdlib);
    v.addThemeListeners(this);
    v.getEditText().setInputType(password
      ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
      : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
    v.getEditText().setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_ACTION_DONE);
    v.getEditText().setHint(hint);
    v.setTextListener(this);
    v.setLayoutParams(params);
    contentView.addView(v);
    return v;
  }

  @Override
  protected void onCreateView (Context context, FrameLayoutFix contentView, RecyclerView recyclerView) {
    setDoneIcon(R.drawable.baseline_check_24);
    recyclerView.setVisibility(android.view.View.GONE);
    nickView = field(context, contentView, UI.getAppContext().getString(R.string.ParvaneNick), 24, false);
    passwordView = field(context, contentView, UI.getAppContext().getString(R.string.ParvanePassword), 88, true);
    emailView = field(context, contentView, UI.getAppContext().getString(R.string.ParvaneEmailOptional), 152, false);
    codeView = field(context, contentView, UI.getAppContext().getString(R.string.ParvaneEmailCode), 88, false);
    codeView.setVisibility(android.view.View.GONE);

    hintView = new NoScrollTextView(context);
    hintView.setTextSize(android.util.TypedValue.COMPLEX_UNIT_DIP, 14f);
    hintView.setTypeface(Fonts.getRobotoRegular());
    hintView.setTextColor(Theme.getColor(ColorId.textLight));
    addThemeTextDecentColorListener(hintView);
    hintView.setText(R.string.ParvaneSignUpHint);
    FrameLayoutFix.LayoutParams params = FrameLayoutFix.newParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
    params.topMargin = Screen.dp(224f);
    params.leftMargin = params.rightMargin = Screen.dp(16f);
    hintView.setLayoutParams(params);
    contentView.addView(hintView);
    setLockFocusView(nickView.getEditText());

    // режим подтверждения сервера — в фоне (identity.server.info)
    new Thread(() -> {
      JSONObject info = ParvaneCore.serverInfo();
      runOnUiThreadOptional(() -> {
        serverConfirm = info.optString("confirm");
        serverBot = info.optString("telegram_bot");
        if ("email".equals(serverConfirm)) {
          emailView.getEditText().setHint(UI.getAppContext().getString(R.string.ParvaneEmailRequired));
        }
      });
    }, "parvane-serverinfo").start();
  }

  @Override
  public void onTextChanged (MaterialEditTextGroup v, CharSequence text) {
    setDoneVisible(nickView.getText().toString().trim().length() > 0 && passwordView.getText().toString().length() > 0);
  }

  private void showError (String text) {
    hintView.setText(text);
    hintView.setTextColor(Theme.getColor(ColorId.textNegative));
  }

  private void showInfo (String text) {
    hintView.setText(text);
    hintView.setTextColor(Theme.getColor(ColorId.textLight));
  }

  @Override
  protected boolean onDoneClick () {
    if (inProgress) {
      return true;
    }
    final String nick = nickView.getText().toString().trim();
    final String password = passwordView.getText().toString();
    final String email = emailView.getText().toString().trim();
    if (codeStage) {
      final String code = codeView.getText().toString().trim();
      if (code.isEmpty()) {
        return true;
      }
      inProgress = true;
      setDoneInProgress(true);
      new Thread(() -> {
        JSONObject r = ParvaneCore.confirmEmail(tgAddress, code);
        runOnUiThreadOptional(() -> {
          inProgress = false;
          setDoneInProgress(false);
          if (r.optBoolean("ok")) {
            login(nick, password);
          } else {
            showError(r.optString("error", UI.getAppContext().getString(R.string.ParvaneWrongCode)));
          }
        });
      }, "parvane-confirm").start();
      return true;
    }
    if (nick.isEmpty() || password.length() < 4) {
      showError(UI.getAppContext().getString(R.string.ParvanePasswordShort));
      return true;
    }
    inProgress = true;
    setDoneInProgress(true);
    new Thread(() -> {
      JSONObject r = ParvaneCore.register(nick, password, email);
      runOnUiThreadOptional(() -> {
        inProgress = false;
        setDoneInProgress(false);
        if (!r.optBoolean("ok")) {
          showError(r.optString("error", UI.getAppContext().getString(R.string.ParvaneSignUpFailed)));
          return;
        }
        tgAddress = r.optString("address", nick);
        tgPassword = password;
        if (r.optBoolean("confirm_required") && !r.optString("telegram_token").isEmpty()) {
          startTelegram(r.optString("telegram_token"));
        } else if (r.optBoolean("confirm_required")) {
          codeStage = true;
          codeView.setVisibility(android.view.View.VISIBLE);
          passwordView.setVisibility(android.view.View.GONE);
          emailView.setVisibility(android.view.View.GONE);
          showInfo(UI.getAppContext().getString(R.string.ParvaneEmailCodeHint));
          codeView.getEditText().requestFocus();
          setDoneVisible(true);
        } else {
          login(nick, password);
        }
      });
    }, "parvane-register").start();
    return true;
  }

  private void startTelegram (String token) {
    tgToken = token;
    tgGeneration++;
    tgStartedAt = System.currentTimeMillis();
    final String link = "https://t.me/" + serverBot + "?start=" + token;
    showInfo(UI.getAppContext().getString(R.string.ParvaneConfirmInTelegram) + "\n" + link);
    try {
      Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link));
      context.startActivity(intent);
    } catch (Throwable ignored) {
    }
    final int generation = tgGeneration;
    UI.post(() -> pollTelegram(generation), 2000);
  }

  private void pollTelegram (final int generation) {
    if (generation != tgGeneration || isDestroyed()) {
      return;
    }
    if (System.currentTimeMillis() - tgStartedAt > 14 * 60 * 1000L) {
      showError(UI.getAppContext().getString(R.string.ParvaneLinkExpired));
      return;
    }
    final String address = tgAddress, token = tgToken, password = tgPassword;
    new Thread(() -> {
      boolean confirmed = ParvaneCore.registerStatus(address, token);
      runOnUiThreadOptional(() -> {
        if (generation != tgGeneration) {
          return;
        }
        if (confirmed) {
          login(address, password);
        } else {
          UI.post(() -> pollTelegram(generation), 2000);
        }
      });
    }, "parvane-poll").start();
  }

  // Обычный вход штатным путём X: шов → WaitPassword → CheckAuthenticationPassword → Ready
  private void login (String nick, String password) {
    showInfo(UI.getAppContext().getString(R.string.ParvaneSigningIn));
    tdlib.client().send(new TdApi.SetAuthenticationPhoneNumber(nick, null), r1 ->
      tdlib.client().send(new TdApi.CheckAuthenticationPassword(password), r2 -> runOnUiThreadOptional(() -> {
        if (r2.getConstructor() == TdApi.Error.CONSTRUCTOR) {
          showError(((TdApi.Error) r2).message);
        }
      })));
  }
}
