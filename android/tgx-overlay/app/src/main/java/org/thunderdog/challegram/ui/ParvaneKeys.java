/*
 * Parvane: резервная копия ключей E2E файлом (формат веб-клиента, как
 * Settings → Privacy на десктопе). Экспорт — под паролем в место, которое пользователь выберет
 * системным окном (как Telegram; без общих «Загрузок» и разрешения на хранилище); импорт —
 * системный выбор файла + пароль, слияние как при линковке.
 * Зовётся из «Профиля» (ProfileHubController, «Копия ключей») и SettingsController X.
 */
package org.thunderdog.challegram.ui;

import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

import org.parvane.core.ParvaneCore;
import org.thunderdog.challegram.R;
import org.thunderdog.challegram.navigation.ViewController;
import org.thunderdog.challegram.parvane.sections.SaveTo;
import org.thunderdog.challegram.tool.UI;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public final class ParvaneKeys {
  private static final int ACTIVITY_RESULT_KEYS_IMPORT = 10777;

  private ParvaneKeys () {}

  public static void export (ViewController<?> c) {
    c.openInputAlert(UI.getAppContext().getString(R.string.ParvaneKeysExport), UI.getAppContext().getString(R.string.ParvaneKeysPassword),
      R.string.Save, R.string.Cancel, null, (inputView, password) -> {
        if (password.length() < 8) {
          UI.showToast(R.string.ParvaneKeysPasswordShort, Toast.LENGTH_SHORT);
          return false;
        }
        String name = "parvane-keys-" + c.tdlib().myUserUsername() + ".parvane-keys";
        // Место — системным окном выбора (application/octet-stream: иначе поставщик дописывает .json)
        SaveTo.pick(c.context(), name, "application/octet-stream", uri -> {
          if (uri == null) {
            return;
          }
          new Thread(() -> {
            String file = ParvaneCore.exportKeys(password);
            String result;
            if (file.isEmpty()) {
              SaveTo.discard(UI.getAppContext(), uri);
              result = UI.getAppContext().getString(R.string.ParvaneKeysExportFailed);
            } else if (SaveTo.write(UI.getAppContext(), uri, file.getBytes(StandardCharsets.UTF_8))) {
              result = UI.getAppContext().getString(R.string.ParvaneKeysSaved) + " " + SaveTo.label(UI.getAppContext(), uri);
            } else {
              result = UI.getAppContext().getString(R.string.ParvaneKeysExportFailed);
            }
            final String toast = result;
            UI.post(() -> UI.showToast(toast, Toast.LENGTH_LONG));
          }, "parvane-keys-export").start();
        });
        return true;
      }, true);
  }

  public static void importFile (ViewController<?> c) {
    c.context().putActivityResultHandler(ACTIVITY_RESULT_KEYS_IMPORT, (requestCode, resultCode, data) -> {
      if (resultCode != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
        return;
      }
      final Uri uri = data.getData();
      c.openInputAlert(UI.getAppContext().getString(R.string.ParvaneKeysImport), UI.getAppContext().getString(R.string.ParvaneKeysPassword),
        R.string.Done, R.string.Cancel, null, (inputView, password) -> {
          new Thread(() -> {
            String toast;
            try (InputStream is = UI.getAppContext().getContentResolver().openInputStream(uri)) {
              byte[] buf = new byte[1 << 20];
              StringBuilder sb = new StringBuilder();
              int n;
              while ((n = is.read(buf)) > 0) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
              // Формат 2 (как web/desktop): история из копии сливается с журналом; −2 — копия старого формата
              int result = ParvaneCore.importKeys(sb.toString(), password);
              if (result > 0) {
                toast = UI.getAppContext().getString(R.string.ParvaneKeysImported);
              } else if (result == -2) {
                toast = UI.getAppContext().getString(R.string.ParvaneKeysOldFormat);
              } else {
                toast = UI.getAppContext().getString(R.string.ParvaneKeysImportFailed);
              }
            } catch (Throwable t) {
              toast = UI.getAppContext().getString(R.string.ParvaneKeysImportFailed) + ": " + t.getMessage();
            }
            final String msg = toast;
            UI.post(() -> UI.showToast(msg, Toast.LENGTH_LONG));
          }, "parvane-keys-import").start();
          return true;
        }, true);
    });
    try {
      Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      intent.setType("*/*");
      c.context().startActivityForResult(intent, ACTIVITY_RESULT_KEYS_IMPORT);
    } catch (Throwable t) {
      UI.showToast(UI.getAppContext().getString(R.string.ParvaneKeysImportFailed) + ": " + t.getMessage(), Toast.LENGTH_LONG);
    }
  }
}
