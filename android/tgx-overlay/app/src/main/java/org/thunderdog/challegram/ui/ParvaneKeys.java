/*
 * Parvane: резервная копия ключей E2E файлом (формат веб-клиента, как
 * Settings → Privacy на десктопе). Экспорт — в Downloads/parvane-keys-<ник>.parvane-keys
 * под паролем; импорт — системный выбор файла + пароль, слияние как при линковке.
 * Зовётся из SettingsController (строки btn_parvaneKeysExport / btn_parvaneKeysImport).
 */
package org.thunderdog.challegram.ui;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;

import org.parvane.core.ParvaneCore;
import org.thunderdog.challegram.R;
import org.thunderdog.challegram.navigation.ViewController;
import org.thunderdog.challegram.tool.UI;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
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
        new Thread(() -> {
          String file = ParvaneCore.exportKeys(password);
          String result;
          if (file.isEmpty()) {
            result = UI.getAppContext().getString(R.string.ParvaneKeysExportFailed);
          } else {
            try {
              String name = "parvane-keys-" + c.tdlib().myUserUsername() + ".parvane-keys";
              result = UI.getAppContext().getString(R.string.ParvaneKeysSaved) + " " + saveToDownloads(name, file.getBytes(StandardCharsets.UTF_8));
            } catch (Throwable t) {
              result = UI.getAppContext().getString(R.string.ParvaneKeysExportFailed) + ": " + t.getMessage();
            }
          }
          final String toast = result;
          UI.post(() -> UI.showToast(toast, Toast.LENGTH_LONG));
        }, "parvane-keys-export").start();
        return true;
      }, true);
  }

  private static String saveToDownloads (String name, byte[] bytes) throws Exception {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ContentValues values = new ContentValues();
      values.put(MediaStore.Downloads.DISPLAY_NAME, name);
      values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream"); // иначе MediaStore дописывает .json
      values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
      Uri uri = UI.getAppContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
      if (uri == null) throw new IllegalStateException("MediaStore");
      try (OutputStream os = UI.getAppContext().getContentResolver().openOutputStream(uri)) {
        os.write(bytes);
      }
      return "Download/" + name;
    }
    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
    //noinspection ResultOfMethodCallIgnored
    dir.mkdirs();
    File f = new File(dir, name);
    try (FileOutputStream os = new FileOutputStream(f)) {
      os.write(bytes);
    }
    return f.getAbsolutePath();
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
              int merged = ParvaneCore.importKeys(sb.toString(), password);
              if (merged >= 0) {
                toast = UI.getAppContext().getString(R.string.ParvaneKeysImported) + " " + merged;
              } else if (merged == -2) {
                toast = UI.getAppContext().getString(R.string.ParvaneKeysNotReady);
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
