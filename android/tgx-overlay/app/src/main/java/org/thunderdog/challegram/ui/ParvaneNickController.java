/*
 * Parvane: экран входа по нику вместо телефонного PhoneController Telegram X.
 * Ник уходит в шов как SetAuthenticationPhoneNumber(ник) → шов отвечает
 * AuthorizationStateWaitPassword → X сам открывает родной PasswordController
 * (CheckAuthenticationPassword → identity.token.issue → Ready).
 */
package org.thunderdog.challegram.ui;

import android.content.Context;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.TextView;

import androidx.recyclerview.widget.RecyclerView;

import org.drinkless.tdlib.TdApi;
import org.thunderdog.challegram.R;
import org.thunderdog.challegram.data.TD;
import org.thunderdog.challegram.navigation.BackHeaderButton;
import org.thunderdog.challegram.telegram.Tdlib;
import org.thunderdog.challegram.theme.ColorId;
import org.thunderdog.challegram.theme.Theme;
import org.thunderdog.challegram.tool.Fonts;
import org.thunderdog.challegram.tool.Keyboard;
import org.thunderdog.challegram.tool.Screen;
import org.thunderdog.challegram.tool.UI;
import org.thunderdog.challegram.widget.MaterialEditTextGroup;
import org.thunderdog.challegram.widget.NoScrollTextView;

import me.vkryl.android.widget.FrameLayoutFix;

public class ParvaneNickController extends EditBaseController<Void> implements MaterialEditTextGroup.TextChangeListener {
  private MaterialEditTextGroup nickView;
  private TextView hintView;
  private boolean inProgress;

  public ParvaneNickController (Context context, Tdlib tdlib) {
    super(context, tdlib);
  }

  @Override
  public int getId () {
    return R.id.controller_phone;
  }

  @Override
  public CharSequence getName () {
    return "Parvane";
  }

  @Override
  public boolean isUnauthorized () {
    return true;
  }

  @Override
  protected int getBackButton () {
    return stackSize() > 0 && stackItemAt(0) instanceof IntroController ? BackHeaderButton.TYPE_BACK : BackHeaderButton.TYPE_NONE;
  }

  @Override
  protected void onCreateView (Context context, FrameLayoutFix contentView, RecyclerView recyclerView) {
    setDoneIcon(R.drawable.baseline_arrow_forward_24);
    recyclerView.setVisibility(android.view.View.GONE);

    FrameLayoutFix.LayoutParams params = FrameLayoutFix.newParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
    params.topMargin = Screen.dp(24f);
    params.leftMargin = params.rightMargin = Screen.dp(16f);
    nickView = new MaterialEditTextGroup(context, tdlib);
    nickView.addThemeListeners(this);
    nickView.getEditText().setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
    nickView.getEditText().setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_ACTION_DONE);
    nickView.getEditText().setHint("Ник");
    nickView.setTextListener(this);
    nickView.setLayoutParams(params);
    contentView.addView(nickView);

    hintView = new NoScrollTextView(context);
    hintView.setTextSize(android.util.TypedValue.COMPLEX_UNIT_DIP, 14f);
    hintView.setTypeface(Fonts.getRobotoRegular());
    hintView.setTextColor(Theme.getColor(ColorId.textLight));
    addThemeTextDecentColorListener(hintView);
    hintView.setText(UI.getAppContext().getString(R.string.ParvaneSignInHint) + " " + UI.getAppContext().getString(R.string.ParvaneNoAccount));
    // регистрация из приложения (паритет с интро десктопа): тап по подсказке → экран создания аккаунта
    hintView.setOnClickListener(v -> navigateTo(new ParvaneRegisterController(context, tdlib)));
    params = FrameLayoutFix.newParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
    params.topMargin = Screen.dp(96f);
    params.leftMargin = params.rightMargin = Screen.dp(16f);
    hintView.setLayoutParams(params);
    contentView.addView(hintView);

    setLockFocusView(nickView.getEditText());
  }

  @Override
  public void onTextChanged (MaterialEditTextGroup v, CharSequence text) {
    setDoneVisible(text.toString().trim().length() > 0);
  }

  @Override
  protected boolean onDoneClick () {
    String nick = nickView.getText().toString().trim();
    if (nick.isEmpty() || inProgress) {
      return true;
    }
    inProgress = true;
    setDoneInProgress(true);
    tdlib.client().send(new TdApi.SetAuthenticationPhoneNumber(nick, null), result -> runOnUiThreadOptional(() -> {
      inProgress = false;
      setDoneInProgress(false);
      if (result.getConstructor() == TdApi.Error.CONSTRUCTOR) {
        hintView.setText(TD.toErrorString(result));
        hintView.setTextColor(Theme.getColor(ColorId.textNegative));
        Keyboard.show(nickView.getEditText());
      }
    }));
    return true;
  }
}
