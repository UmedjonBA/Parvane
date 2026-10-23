#!/usr/bin/env bash
# Parvane Android, стадия 3: Telegram X (GPL-3, TGX-Android/Telegram-X) поверх
# нашего шва. Клон X живёт ВНЕ репозитория (/mnt/hdd/ub/android/tgx, сабмодули
# ~1 ГБ); здесь — оверлей: подмена модуля tdlib (наш Client.kt + ParvaneStore +
# ParvaneCore + libparvane_jni.so вместо libtdjni.so), правка CMake (без tdjni),
# local.properties. Повторяемо: скрипт идемпотентен.
#   ./setup-tgx.sh            — наложить оверлей на существующий клон
#   ./setup-tgx.sh --build    — … и собрать assembleLatestArm64Debug
# Тулчейн X: JDK 21, Gradle 9.7 (wrapper), AGP 9.4, NDK r27d (27.3.13750724).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
SDK="${ANDROID_HOME:-/mnt/hdd/ub/android/sdk}"
JDK21="${JDK21:-/mnt/hdd/ub/android/jdk-21}"
KEYS="${PARVANE_KEYS:-/mnt/hdd/ub/android/keys}"
[ -d "$TGX/app" ] || { echo "нет клона Telegram X в $TGX: git clone --recursive --depth=1 --shallow-submodules https://github.com/TGX-Android/Telegram-X $TGX"; exit 2; }
[ -x "$JDK21/bin/java" ] || { echo "нет JDK 21 в $JDK21"; exit 2; }

echo "== бандл tdlib: бинарники OpenSSL лежат в Git LFS (без git-lfs — файлы-указатели) =="
export PATH="/mnt/hdd/ub/android/tools/bin:$PATH"
if head -c 40 "$TGX/tdlib/openssl/27.3.13750724/arm64-v8a/lib/libcryptox.so" 2>/dev/null | grep -q "git-lfs"; then
  command -v git-lfs >/dev/null || { echo "нужен git-lfs (tools/bin) — см. BUILD-android.md"; exit 2; }
  (cd "$TGX/tdlib" && git lfs install --local >/dev/null 2>&1 && git lfs pull)
fi

echo "== оверлей tdlib: наш шов вместо TDLib =="
TDLIB="$TGX/tdlib/src/main/java/org/drinkless/tdlib"
mkdir -p "$TDLIB" "$TGX/tdlib/src/main/java/org/parvane/core"
rm -f "$TDLIB/Client.java"
# все Kotlin-файлы шва (spec 005 добавил Stickers/PackIndex/PollStore/… — раньше копировались два)
cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/"*.kt "$TDLIB/"
# ParvaneCore + StoreKey (P-13) + ParvaneProtocol (движок v2, spec 007) — весь пакет
cp "$ROOT/libtd/src/main/java/org/parvane/core/"*.kt "$TGX/tdlib/src/main/java/org/parvane/core/"
# BuildConfig шва: у нас модуль org.parvane.libtd, у X — org.drinkless.tdlib (DEBUG тот же смысл)
sed -i 's/org\.parvane\.libtd\.BuildConfig/org.drinkless.tdlib.BuildConfig/g' "$TDLIB/"*.kt "$TGX/tdlib/src/main/java/org/parvane/core/"*.kt
# …а BuildConfig в модуле tdlib X по умолчанию не генерируется — включаем (идемпотентно)
grep -q 'buildConfig = true' "$TGX/tdlib/build.gradle.kts" || \
  sed -i 's/^  namespace = "org.drinkless.tdlib"$/  namespace = "org.drinkless.tdlib"\n  buildFeatures { buildConfig = true } \/\/ Parvane: BuildConfig.DEBUG для dev-хуков шва (P-12)/' "$TGX/tdlib/build.gradle.kts"
# TdApi: у бандла X тот же коммит TDLib (tdlib/version.txt); если версии разойдутся —
# перегенерировать наш (android/BUILD-android.md) и подложить сюда
if [ -f "$TGX/tdlib/version.txt" ]; then
  echo "   TDLib бандла X: $(cat "$TGX/tdlib/version.txt")"
fi
[ -f "$TDLIB/TdApi.java" ] || cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/TdApi.java" "$TDLIB/"

echo "== нативная либа шва в jniLibs =="
for abi in arm64-v8a x86_64; do
  so="$(find "$ROOT/libtd/build/intermediates" -path "*/$abi/libparvane_jni.so" 2>/dev/null | grep -v Debug | head -1)"
  if [ -n "$so" ]; then
    mkdir -p "$TGX/tdlib/src/main/jniLibs/$abi"
    cp "$so" "$TGX/tdlib/src/main/jniLibs/$abi/"
    echo "   $abi: $(stat -c %s "$so") байт"
  else
    echo "   $abi: libparvane_jni.so не собрана (gradle :app:assembleRelease в android/) — пропуск"
  fi
done

echo "== NLoader: грузим libparvane_jni вместо libtdjni =="
for f in "$TGX"/app/src/*/kotlin/tgx/flavor/NLoader.kt; do
  sed -i 's/loadLibrary("tdjni")/loadLibrary("parvane_jni")/; s/loadLibrary(reLinker, "tdjni", BuildConfig.TDLIB_VERSION)/loadLibrary(reLinker, "parvane_jni", BuildConfig.JNI_VERSION)/' "$f"
done

echo "== экран входа по нику (ParvaneNickController) вместо PhoneController в логине =="
cp -r "$ROOT/tgx-overlay/app" "$TGX/"
MA="$TGX/app/src/main/java/org/thunderdog/challegram/MainActivity.java"
sed -i 's/PhoneController c = new PhoneController(this, account.tdlib());/ParvaneNickController c = new ParvaneNickController(this, account.tdlib());/; s/new PhoneController(this, account.tdlib())/new ParvaneNickController(this, account.tdlib())/g' "$MA"
grep -q "import org.thunderdog.challegram.ui.ParvaneNickController;" "$MA" ||   sed -i 's/^import org.thunderdog.challegram.ui.PhoneController;/import org.thunderdog.challegram.ui.PhoneController;\nimport org.thunderdog.challegram.ui.ParvaneNickController;/' "$MA"
sed -i 's/navigateTo(new PhoneController(context, getTdlib()));/navigateTo(new ParvaneNickController(context, getTdlib()));/' "$TGX/app/src/main/java/org/thunderdog/challegram/ui/IntroController.java"

echo "== контакты: без диалога синхронизации с Telegram (телефонной книги у Parvane нет) =="
CMGR="$TGX/app/src/main/java/org/thunderdog/challegram/telegram/TdlibContactManager.java"
grep -q "parvane: нет синхронизации контактов" "$CMGR" || sed -i 's/^  private boolean canShowAlert (boolean force) {$/  private boolean canShowAlert (boolean force) {\n    if (true) return false; \/\/ parvane: нет синхронизации контактов с Telegram/' "$CMGR"

echo "== ребрендинг: Telegram → Parvane в строках, интро X → экран ника, иконки =="
# Текст ресурсов (все локали): «Telegram X» и слово Telegram (не в URL/ключах)
for f in "$TGX"/app/src/main/res/values*/strings.xml; do
  perl -pi -e 's/Telegram X/Parvane/g; s/\bTelegram\b(?!\.(?:org|me|dog|com)\b|\/)/Parvane/g; s/(\\n)Telegram\b/$1Parvane/g' "$f"
done
# Русский язык: values-ru из словаря десктопа + ручного (tgx-overlay/ru_hand.py); формы few/many
python3 "$(dirname "$0")/tgx-overlay/gen-ru.py" "$TGX" "$(cd "$(dirname "$0")/.." && pwd)" || { echo "gen-ru упал"; exit 3; }
# Без телеграмовского интро (бумажный самолётик, «fastest messaging app»): сразу ник
sed -i 's/navigation.initController(new IntroController(this, account.tdlib()));/navigation.initController(new ParvaneNickController(this, account.tdlib()));/' "$MA"
# Иконки приложения/уведомлений — из tgx-overlay (mipmap-*), скопированы выше вместе с app/

echo "== кнопки без логики — прячем (решение пользователя: боты/Stories/Premium/платежи вне скоупа; Telegram-ссылки не про нас) =="
DR="$TGX/app/src/main/java/org/thunderdog/challegram/navigation/DrawerController.java"
# боковое меню: «Пригласить друзей», «Помощь» (Telegram FAQ), «Звонки» (на Android пока нет), «Добавить аккаунт», прокси
perl -0pi -e 's/^\s*items\.add\(new ListItem\(ListItem\.TYPE_DRAWER_ITEM, R\.id\.btn_(invite|help|addAccount), [^\n]*\n//mg; s/^\s*items\.add\(new ListItem\(ListItem\.TYPE_DRAWER_ITEM, R\.id\.btn_calls, [^\n]*\n//mg; s/^\s*items\.add\(proxyItem\);\n//mg' "$DR"
SC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/SettingsController.java"
# файл восстанавливается из git перед патчами: все правки к нему — ниже в этом скрипте,
# иначе блок «код-пароль/устройства/ключи» дублировался на каждый прогон (27 сен 2026: 14 строк вместо 2)
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/ui/SettingsController.java
# настройки: строки, за которыми Telegram-сервисы (вопрос, FAQ, политика, обновления, бета, исходники),
# и строка устройств (возвращается ниже своим блоком) — вместе с разделителем перед ними;
# стикеры/эмодзи, папки и телефон остаются (spec 005); «Privacy and Security» остаётся (spec 007:
# экран урезан ниже до рабочих пунктов — чёрный список и «кто может писать мне»)
perl -0pi -e 's/^\s*items\.add\(new ListItem\(ListItem\.TYPE_SEPARATOR\)\);\n(?=\s*items\.add\(new ListItem\([^\n]*R\.id\.btn_(help|faq|privacyPolicy|checkUpdates|subscribeToBeta|sourceCode|sourceCodeChanges|devices)\b)//mg; s/^\s*items\.add\(new ListItem\([^\n]*R\.id\.btn_(help|faq|privacyPolicy|checkUpdates|subscribeToBeta|sourceCode|sourceCodeChanges|devices)\b[^\n]*\n(\s*\.set[^\n]*\n)*//mg' "$SC"
grep -c "btn_faq\|btn_privacyPolicy" "$SC" | sed 's/^/   осталось упоминаний faq\/policy в настройках: /'
ML="$TGX/app/src/main/java/org/thunderdog/challegram/component/attach/MediaLayout.java"
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/component/attach/MediaLayout.java
# меню вложений (spec 005): пятая вкладка — всегда «Опрос» (инлайн-ботов не будет); без права
# на опросы (needVote=false, GROUP-2) тап ничего не открывает
perl -0pi -e 's/new MediaBottomBar\.BarItem\(R\.drawable\.deproko_baseline_bots_24, R\.string\.InlineBot, ColorId\.attachInlineBot\)/new MediaBottomBar.BarItem(R.drawable.baseline_poll_24, R.string.CreatePoll, ColorId.attachInlineBot)/g; s/(      case 4: \{\n        if \(needVote\) \{.*?\n          return false;\n        \}\n)(        break;)/$1        return false; \/\/ Parvane: без права на опросы вкладка не открывает инлайн-ботов/s' "$ML"
# Parvane: опросы разрешены и в личных чатах (web/desktop шлют их 1-на-1) — у Telegram только с ботами;
# без этого вкладка «Опрос» в меню вложений молчит (needVote=false), 27 сен 2026
TDL="$TGX/app/src/main/java/org/thunderdog/challegram/telegram/Tdlib.java"
perl -0pi -e 's/return \/\*isSelfChat\(chatId\) \|\|\*\/ isBotChat\(chatId\);/return !isSelfChat(chatId); \/\/ Parvane: опросы в личных чатах/' "$TDL"
echo "   polls in private chats: $(grep -c 'Parvane: опросы в личных чатах' "$TDL") (ожидается 1)"
echo "   attach: poll tabs $(grep -c 'R.string.CreatePoll' "$ML") (ожидается 4), inline-bot $(grep -c 'R.string.InlineBot' "$ML") (ожидается 0)"
PC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/ProfileController.java"
# профиль, меню «…»: «Секретный чат» (у нас всё E2E), «Приватность» (экрана нет)
perl -0pi -e 's/^\s*if \(mode == Mode\.USER && user\.id != myUserId && !TD\.isBot\(user\)\) \{\n\s*ids\.append\(R\.id\.btn_newSecretChat\);\n\s*strings\.append\(R\.string\.StartEncryptedChat\);\n\s*\}\n//m; s/^\s*if \(!tdlib\.chatFullyBlocked\((?:chatId|getChatId\(\))\)\) \{\n\s*ids\.append\(R\.id\.more_btn_privacy\);\n\s*strings\.append\(R\.string\.EditPrivacy\);\n\s*\}\n//mg' "$PC"
# предохранители: код, ищущий удалённые строки по id (−1 → вставка по кривому индексу)
sed -i 's/position = adapter.indexOfViewById(R.id.btn_phone);/position = adapter.indexOfViewById(R.id.btn_username);/' "$SC"
sed -i 's/^\(\s*\)adapter.addItem(i, proxyItem);/\1if (i >= 0) adapter.addItem(i, proxyItem);/' "$DR"
# drawer: отладочные «Clear/Send TDLib logs» (в debug-сборке developer mode включён всегда)
perl -0pi -e 's/if \(Settings\.instance\(\)\.inDeveloperMode\(\)\) \{\n(\s*items\.add\(new ListItem\(ListItem\.TYPE_SEPARATOR_FULL\)\);)/if (false) {\n$1/' "$DR"
CC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/ChatsController.java"
# пустой список чатов: кнопка «Invite contacts» (SMS-приглашения) — нет
perl -0pi -e 's/^\s*items\.add\(new ListItem\(ListItem\.TYPE_SHADOW_TOP\)\);\n\s*items\.add\(new ListItem\(ListItem\.TYPE_BUTTON, R\.id\.btn_invite, 0, [^\n]*\n\s*items\.add\(new ListItem\(ListItem\.TYPE_SHADOW_BOTTOM\)\);\n//m' "$CC"
MC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/MainController.java"
# главный экран: вкладка «Calls» (звонков на Android пока нет) — одна вкладка
perl -0pi -e 's/return hasFolders\(\) \? pagerChatLists\.size\(\) : 2;/return hasFolders() ? pagerChatLists.size() : 1;/; s/(getMenuSectionName\(MAIN_PAGER_ITEM_ID, \/\* pagerItemPosition \*\/ 0, \/\* hasFolders \*\/ false, ChatFolderStyle\.LABEL_ONLY, \/\* upperCase \*\/ true\)),\n\s*Lang\.uppercase\(Lang\.getString\(R\.string\.Calls\)\)[^\n]*\n/$1\n/; s/(getDefaultMainItem\(\)),\n\s*new ViewPagerTopView\.Item\(callsItem\)\n/$1\n/' "$MC"
NM="$TGX/app/src/main/java/org/thunderdog/challegram/telegram/TdlibNotificationManager.java"
# нет Firebase → X вечно светит «уведомления могут не работать» красной точкой; пуша у нас нет по дизайну
perl -0pi -e 's/boolean hasPushServices = hasRemotePushService\(\);\n(\s*)if \(!hasPushServices\) \{/boolean hasPushServices = hasRemotePushService();\n$1if (false) {/; s/if \(tdlib\.context\(\)\.getTokenState\(\) == TdlibManager\.TokenState\.ERROR\)\n(\s*)return Status\.PUSH_SERVICE_ERROR;/if (false)\n$1return Status.PUSH_SERVICE_ERROR;/' "$NM"
sed -i '/^      !hasRemotePushService() ||$/d' "$NM"   # hasLocalNotificationProblem: без Firebase — не «проблема»
echo "   drawer devmode: $(grep -c 'inDeveloperMode()) {' "$DR"), invite btn: $(grep -c 'R.id.btn_invite, 0' "$CC"), calls tab: $(grep -c 'R.string.Calls))' "$MC"), push warn: $(grep -c 'if (!hasPushServices)' "$NM")"
# профиль: строка «Телефон: Unknown» только при заданном номере; «Переименовать/Удалить/Добавить контакт» — телефонной книги нет
perl -0pi -e 's/return user\.isContact \|\| user\.isMutualContact \|\| TD\.hasPhoneNumber\(user\);/return TD.hasPhoneNumber(user);/; s/^\s*if \(TD\.isContact\(user\)\) \{\n\s*ids\.append\(R\.id\.more_btn_edit\);\n\s*strings\.append\(R\.string\.RenameContact\);\n\s*ids\.append\(R\.id\.more_btn_delete\);\n\s*strings\.append\(R\.string\.DeleteContact\);\n\s*\} else if \(TD\.canAddContact\(user\)\) \{\n\s*ids\.append\(R\.id\.more_btn_addToContacts\);\n\s*strings\.append\(R\.string\.AddContact\);\n\s*\}\n//m' "$PC"
echo "   profile contact menu: $(grep -c 'R.string.RenameContact' "$PC"), phone cell: $(grep -c 'user.isMutualContact || TD.hasPhoneNumber' "$PC")"
# Settings: код-пароль (локальный у X), устройства (identity.device.*), копия ключей — после «Уведомления»
perl -0pi -e 's/(\n(\s*)items\.add\(new ListItem\(notificationErrorDescriptionRes != 0 \? ListItem\.TYPE_VALUED_SETTING_COMPACT : ListItem\.TYPE_SETTING, R\.id\.btn_notificationSettings, [^\n]*\n)/$1$2items.add(new ListItem(ListItem.TYPE_SEPARATOR));\n$2items.add(new ListItem(ListItem.TYPE_SETTING, R.id.btn_passcode, R.drawable.baseline_lock_24, R.string.PasscodeTitle));\n$2items.add(new ListItem(ListItem.TYPE_SEPARATOR));\n$2items.add(new ListItem(ListItem.TYPE_VALUED_SETTING_COMPACT, R.id.btn_devices, R.drawable.baseline_devices_other_24, R.string.Devices));\n$2items.add(new ListItem(ListItem.TYPE_SEPARATOR));\n$2items.add(new ListItem(ListItem.TYPE_SETTING, R.id.btn_parvaneKeysExport, R.drawable.baseline_vpn_key_24, R.string.ParvaneKeysExport));\n$2items.add(new ListItem(ListItem.TYPE_SEPARATOR));\n$2items.add(new ListItem(ListItem.TYPE_SETTING, R.id.btn_parvaneKeysImport, R.drawable.baseline_file_download_24, R.string.ParvaneKeysImport));\n/' "$SC"
perl -0pi -e 's/(\n(\s*)\} else if \(viewId == R\.id\.btn_devices\) \{)/\n$2} else if (viewId == R.id.btn_passcode) {\n$2  tdlib.ui().openPasscodeSetup(this);\n$2} else if (viewId == R.id.btn_parvaneKeysExport) {\n$2  ParvaneKeys.export(this);\n$2} else if (viewId == R.id.btn_parvaneKeysImport) {\n$2  ParvaneKeys.importFile(this);$1/' "$SC"
SS="$TGX/app/src/main/java/org/thunderdog/challegram/ui/SettingsSessionsController.java"
# экран устройств: «Scan QR» (вход по QR — MTProto) и «завершать старые сессии через…» (identity этого не умеет)
perl -0pi -e 's/if \(tdlib\.allowQrLoginCamera\(\)\) \{\n\s*items\.add\(new ListItem\(ListItem\.TYPE_VALUED_SETTING_COMPACT, R\.id\.btn_qrLogin,[^\n]*\n\s*items\.add\(new ListItem\(ListItem\.TYPE_SEPARATOR_FULL\)\);\n\s*\}\n//; s/^\s*items\.add\(new ListItem\(ListItem\.TYPE_VALUED_SETTING, R\.id\.btn_sessionTtl, 0, R\.string\.SessionTerminateTtl\)\);\n\s*items\.add\(new ListItem\(ListItem\.TYPE_SHADOW_BOTTOM\)\);\n//m' "$SS"
echo "   sessions: qr/ttl rows left: $(grep -c 'R.id.btn_qrLogin,\|R.id.btn_sessionTtl, 0' "$SS")"
# Телефон профиля (spec 005): тап по строке — нативный диалог ввода X (openInputAlert),
# значение уходит в шов SetOption("x_parvane_phone") → identity.user.setname phone
# (как простой бокс на desktop); пусто — убрать номер
perl -0pi -e 's/(  public void onClick \(View v\) \{\n    cancelSupportOpen\(\);\n)/$1    if (v.getId() == R.id.btn_phone) { \/\/ Parvane: телефон без SMS-потока MTProto\n      openInputAlert(Lang.getString(R.string.PhoneNumber), Lang.getString(R.string.Phone), R.string.Save, R.string.Cancel, myPhone, (inputView, result) -> {\n        final String phone = result == null ? "" : result.trim();\n        tdlib.client().send(new TdApi.SetOption("x_parvane_phone", new TdApi.OptionValueString(phone)), ignored -> {});\n        myPhone = phone; originalPhoneNumber = phone;\n        runOnUiThreadOptional(() -> adapter.updateValuedSettingById(R.id.btn_phone));\n        return true;\n      }, true);\n      return;\n    }\n/' "$SC"
echo "   settings phone dialog: $(grep -c 'x_parvane_phone' "$SC") (ожидается 1), phone row: $(grep -c 'R.id.btn_phone, ' "$SC")"
echo "   settings parvane rows: $(grep -c 'btn_parvaneKeysExport' "$SC") (ожидается 2)"
echo "   attach InlineBot: $(grep -c 'R.string.InlineBot' "$ML"), profile newSecretChat/privacy: $(grep -c 'btn_newSecretChat\|more_btn_privacy' "$PC")"

# spec 004: у basic-групп шва управление идёт через шов; тумблеры, требующие
# апгрейда в супергруппу (одобрение вступления, защита контента, история для
# новых, реакции), скрываем — иначе X предлагает «улучшить группу» (MTProto)
perl -0pi -e 's/tdlib\.canToggleJoinByRequest\(chat\)/false/g; s/tdlib\.canToggleAllHistory\(chat\)/false/g; s/tdlib\.canToggleContentProtection\(chat\.id\) \|\| \(myStatus != null && TD\.isAdmin\(myStatus\)\)/false/g; s/if \(tdlib\.canChangeInfo\(chat\)\) \{\n(\s*items\.add\(new ListItem\(added \? ListItem\.TYPE_SEPARATOR_FULL : ListItem\.TYPE_SHADOW_TOP\)\);\n\s*items\.add\(new ListItem\(ListItem\.TYPE_VALUED_SETTING, R\.id\.btn_enabledReactions)/if (false) {\n$1/' "$PC"
echo "   profile upgrade toggles left: $(grep -c 'tdlib.canToggleJoinByRequest(chat)\|tdlib.canToggleAllHistory(chat)' "$PC"), reactions row: $(grep -c 'if (tdlib.canChangeInfo(chat)) {' "$PC")"

echo "== spec 007: приватность v2, режим «усиленная приватность» (L2), кадры перехода на v2 =="
UI_DIR="$TGX/app/src/main/java/org/thunderdog/challegram/ui"
SPC="$UI_DIR/SettingsPrivacyController.java"
SPK="$UI_DIR/SettingsPrivacyKeyController.java"
# оба файла восстанавливаются из git: правки ниже заменяют целые блоки (идемпотентность)
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/ui/SettingsPrivacyController.java app/src/main/java/org/thunderdog/challegram/ui/SettingsPrivacyKeyController.java
# Экран «Privacy and Security»: из пунктов Telegram в шве работают чёрный список и «кто может писать мне»
# (T079, FR-040: NewChatPrivacySettings.allowNewChatsFromUnknownUsers ↔ messages_from_strangers). Остальное
# (2FA Telegram, правила видимости, контакты, платежи, секретные чаты, удаление аккаунта) — без логики, не показываем.
# Пункт «Messages» — только при включённом протоколе v2 (опция шва can_set_new_chat_privacy_settings).
perl -0pi -e 's/    final List<ListItem> items = new ArrayList<>\(\);\n.*?\n    adapter\.setItems\(items, false\);\n/    final List<ListItem> items = new ArrayList<>();\n    \/\/ Parvane: только рабочие пункты — чёрный список и «кто может писать мне» (протокол v2)\n    items.add(new ListItem(ListItem.TYPE_EMPTY_OFFSET_SMALL));\n    items.add(new ListItem(ListItem.TYPE_HEADER, 0, 0, R.string.PrivacyTitle));\n    items.add(new ListItem(ListItem.TYPE_SHADOW_TOP));\n    items.add(new ListItem(ListItem.TYPE_VALUED_SETTING_COMPACT, R.id.btn_blockedSenders, R.drawable.baseline_remove_circle_24, R.string.BlockedSenders));\n    if (tdlib.canSetNewChatPrivacySettings()) {\n      items.add(new ListItem(ListItem.TYPE_SEPARATOR_FULL));\n      items.add(new ListItem(ListItem.TYPE_VALUED_SETTING_COMPACT, R.id.btn_newChatsPrivacy, R.drawable.baseline_chat_bubble_24, R.string.PrivacyMessage));\n      tdlib.send(new TdApi.GetNewChatPrivacySettings(), (newChatPrivacySettings, error) -> runOnUiThreadOptional(() -> {\n        if (newChatPrivacySettings != null) {\n          setNewChatsPrivacy(newChatPrivacySettings);\n        }\n      }));\n    }\n    items.add(new ListItem(ListItem.TYPE_SHADOW_BOTTOM));\n    if (tdlib.canSetNewChatPrivacySettings()) {\n      items.add(new ListItem(ListItem.TYPE_DESCRIPTION, 0, 0, R.string.NewChatsPrivacyDesc));\n    }\n\n    adapter.setItems(items, false);\n/s; s/      if \(true\) \{\n        context\.tooltipManager\(\)\n.*?\n        return;\n      \}\n(      SettingsPrivacyKeyController c = new SettingsPrivacyKeyController\(context, tdlib\);\n      c\.setArguments\(SettingsPrivacyKeyController\.Args\.newChatsPrivacy\(\)\);)/$1/s' "$SPC"
# Экран «Who can send me messages?»: «Все» / «Только те, кому писал(а) я»; платных сообщений (Stars) нет
perl -0pi -e 's/(      items\.add\(new ListItem\(ListItem\.TYPE_RADIO_OPTION, R\.id\.btn_contacts, 0, Lang\.getMarkdownString\(this, R\.string\.MyContactsAndPremium\), R\.id\.btn_privacyRadio, rulesType == PrivacySettings\.Mode\.CONTACTS\)\);\n)      items\.add\(new ListItem\(ListItem\.TYPE_SEPARATOR_FULL\)\);\n      items\.add\(new ListItem\(ListItem\.TYPE_RADIO_OPTION, R\.id\.btn_nobody, 0, Lang\.getMarkdownString\(this, R\.string\.ChargeForMessages\), R\.id\.btn_privacyRadio, rulesType == PrivacySettings\.Mode\.NOBODY\)\);\n/$1/' "$SPK"
# тексты пункта (EN; русские — tgx-overlay/ru_hand.py): у Parvane нет Premium и телефонной книги
perl -pi -e 's{(<string name="MyContactsAndPremium">)[^<]*}{$1Only people I have messaged}; s{(<string name="PrivacyMessageContactsPremium">)[^<]*}{$1Only people you have messaged}; s{(<string name="NewChatsPrivacyDesc">)[^<]*}{$1When restricted, only people you have written to can message you.}' "$TGX/app/src/main/res/values/strings.xml"
echo "   privacy screen: rows $(grep -c 'R.id.btn_blockedSenders, R.drawable\|R.id.btn_newChatsPrivacy, R.drawable' "$SPC") (ожидается 2), tooltip-заглушка $(grep -c 'Changing message privacy is not available' "$SPC") (ожидается 0), paid option $(grep -c 'R.string.ChargeForMessages)' "$SPK") (ожидается 0), settings row $(grep -c 'R.id.btn_privacySettings, R.drawable' "$SC") (ожидается 1)"

# Режим «усиленная приватность» (L2, правило L2-1): строка-переключатель в профиле личного чата (своё
# предпочтение; активен из-за собеседника — подпись «Включена собеседником») и на экране управления
# группой v2 (политика; тумблер заперт без права менять сведения). Готового TdApi-поля у X нет
# (hasProtectedContent меняет поведение чата) — строка своя, состояние и смена через шов:
# GetOption/SetOption "x_parvane_l2:<chatId>" (биты: 1 активен, 2 включён мной/политикой, 4 собеседником, 8 можно менять).
grep -q 'parvaneCheckL2' "$PC" || perl -0pi -e 's/(  private ListItem newNotificationItem \(\) \{)/  \/\/ Parvane: режим «усиленная приватность» (L2, spec 007) — состояние и смена через шов (опция x_parvane_l2:<chatId>)\n  private int parvaneL2Bits = -1;\n  private boolean parvaneL2Busy;\n\n  private void parvaneCheckL2 () {\n    final int anchorId;\n    if (mode == Mode.USER && user != null && !tdlib.isSelfUserId(user.id)) {\n      anchorId = R.id.btn_notifications;\n    } else if (mode == Mode.EDIT_GROUP) {\n      anchorId = R.id.belowRecentActions;\n    } else {\n      return;\n    }\n    tdlib.client().send(new TdApi.GetOption("x_parvane_l2:" + chat.id), result -> runOnUiThreadOptional(() -> {\n      if (!(result instanceof TdApi.OptionValueInteger)) {\n        return; \/\/ режима в этом чате нет: v2 выключен, собеседник или группа не на v2\n      }\n      parvaneL2Bits = (int) ((TdApi.OptionValueInteger) result).value;\n      if (baseAdapter.indexOfViewById(R.id.btn_parvaneL2) != -1) {\n        baseAdapter.updateValuedSettingById(R.id.btn_parvaneL2);\n        return;\n      }\n      int index = baseAdapter.indexOfViewById(anchorId);\n      if (index == -1) {\n        return;\n      }\n      if (mode == Mode.USER) {\n        index++; \/\/ тень под строкой «Уведомления»\n      }\n      baseAdapter.addItems(index + 1,\n        new ListItem(ListItem.TYPE_SHADOW_TOP),\n        new ListItem(ListItem.TYPE_VALUED_SETTING_COMPACT_WITH_TOGGLER, R.id.btn_parvaneL2, mode == Mode.USER ? R.drawable.baseline_security_24 : 0, R.string.ParvaneL2Toggle),\n        new ListItem(ListItem.TYPE_SHADOW_BOTTOM),\n        new ListItem(ListItem.TYPE_DESCRIPTION, 0, 0, R.string.ParvaneL2Info)\n      );\n      onItemsHeightProbablyChanged();\n    }));\n  }\n\n  private void parvaneBindL2 (SettingView view, boolean isUpdate) {\n    final int bits = Math.max(parvaneL2Bits, 0);\n    final boolean checked = (bits & 2) != 0;\n    view.getToggler().setRadioEnabled(checked, isUpdate);\n    view.getToggler().setShowLock((bits & 8) == 0);\n    view.setData((bits & 4) != 0 ? R.string.ParvaneL2ByPeer : checked ? R.string.ParvaneL2On : R.string.ParvaneL2Off);\n  }\n\n  private void parvaneToggleL2 (View v) {\n    final int bits = Math.max(parvaneL2Bits, 0);\n    if ((bits & 8) == 0) {\n      context().tooltipManager().builder(((SettingView) v).getToggler()).show(tdlib, R.string.ParvaneL2NoRights);\n      return;\n    }\n    if (parvaneL2Busy) {\n      return;\n    }\n    parvaneL2Busy = true;\n    final boolean enable = (bits & 2) == 0;\n    tdlib.client().send(new TdApi.SetOption("x_parvane_l2:" + chat.id, new TdApi.OptionValueBoolean(enable)), result -> runOnUiThreadOptional(() -> {\n      parvaneL2Busy = false;\n      if (result instanceof TdApi.Error) {\n        UI.showError(result);\n      }\n      parvaneCheckL2(); \/\/ новое состояние — из шва (кэш события l2State)\n    }));\n  }\n\n$1/; s/(    buildCells\(\);\n    baseRecyclerView\.setAdapter\(baseAdapter\);\n)/$1    parvaneCheckL2(); \/\/ Parvane: строка «усиленная приватность» (появляется, если режим доступен в чате)\n/; s/(        final int itemId = item\.getId\(\);\n        )(if \(itemId == R\.id\.btn_useExplicitDice\) \{)/$1if (itemId == R.id.btn_parvaneL2) {\n          parvaneBindL2(view, isUpdate);\n        } else $2/; s/(    \} else if \(viewId == R\.id\.btn_toggleProtection\) \{\n      toggleContentProtection\(v\);\n)/    } else if (viewId == R.id.btn_parvaneL2) {\n      parvaneToggleL2(v);\n$1/' "$PC"
echo "   profile L2 row: $(grep -c 'parvaneCheckL2();\|parvaneBindL2(view, isUpdate);\|parvaneToggleL2(v);' "$PC") (ожидается 4)"

# Кадры перехода на v2 (E6, T110): шов шлёт UpdateServiceNotification; для типа PARVANE_UPGRADE_REQUIRED —
# штатный диалог X «Update required» с кнопкой «Update» (ведёт на страницу загрузки, не в Google Play)
grep -q 'PARVANE_UPGRADE_REQUIRED' "$TDL" || perl -0pi -e 's/(        )(if \(!StringUtils\.isEmpty\(update\.type\) && \(update\.type\.startsWith\("AUTH_KEY_DROP"\))/$1if (!StringUtils.isEmpty(update.type) && update.type.startsWith("PARVANE_UPGRADE_REQUIRED")) { \/\/ Parvane: сервер отключил v1 — «обновите приложение»\n$1  c.openAlert(R.string.AppUpdateRequiredTitle, msg, Lang.getString(R.string.AppUpdateOk), (dialog, which) -> org.thunderdog.challegram.tool.Intents.openLink(BuildConfig.DOWNLOAD_URL), 0);\n$1} else $2/' "$TDL"
echo "   upgrade dialog: $(grep -c 'PARVANE_UPGRADE_REQUIRED' "$TDL") (ожидается 1)"

echo "== spec 031: R8 не трогает шов и оверлей (ядро зовёт их из C++ по имени: onEvent, media*) =="
PG="$TGX/app/proguard-rules.pro"
grep -q "parvane: шов и оверлей" "$PG" || cat >> "$PG" <<'PRO'

# parvane: шов и оверлей — методы, которые ядро зовёт из C++ по имени (ParvaneCore.onEvent, ParvaneCalls.media*),
# R8 иначе выбрасывает как неиспользуемые: release без событий ядра и звонков
-keep class org.parvane.core.** { *; }
-keep class org.thunderdog.challegram.parvane.** { *; }
-keep class org.webrtc.ParvaneWebrtcInit { *; }
PRO
echo "   proguard: $(grep -c 'org.parvane.core' "$PG") (ожидается 1)"

echo "== CMake: без libtdjni (наш шов — не JNI TDLib) =="
CM="$TGX/app/jni/CMakeLists.txt"
if grep -q "^  tdjni$" "$CM"; then
  sed -i '/^  tdjni$/d' "$CM"
fi
grep -q "parvane: tdjni убран" "$CM" || sed -i '1i # parvane: tdjni убран из линковки tgxjni (шов над parvane-core, см. android/setup-tgx.sh)' "$CM"
# x86_64 release (только для проверки входа в эмуляторе) без LTO: при LTO-линковке под android24 потоковые переменные
# webrtc уходят в __tls_get_addr, которого у bionic API 24 нет (emulated TLS теряется); arm64 — с LTO, как было
perl -pi -e 's/"\$<\$<CONFIG:Release,RelWithDebInfo,MinSizeRel>:-flto=full>"/"\$<\$<AND:\$<CONFIG:Release,RelWithDebInfo,MinSizeRel>,\$<NOT:\$<STREQUAL:\${ANDROID_ABI},x86_64>>>:-flto=full>"/g' "$CM"
echo "   LTO кроме x86_64: $(grep -c 'STREQUAL:${ANDROID_ABI},x86_64' "$CM") (ожидается 2)"

echo "== spec 031: release без загрузки переводов с translations.telegram.org (T045; строки — в исходниках, как у debug) =="
git -C "$TGX" checkout -q -- app/build.gradle.kts
python3 - "$TGX/app/build.gradle.kts" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = ("      variant.sources.res?.addGeneratedSourceDirectory(\n"
       "        fetchLocalizedStrings, FetchLocalizedStringsTask::resOutputDir\n"
       "      )\n")
assert old in s, 'build.gradle.kts: fetchLocalizedStrings'
s = s.replace(old, "      // Parvane: переводы X с серверов Telegram не загружаются (T045)\n", 1)
open(p, "w").write(s)
PY
grep -q "Parvane: переводы X с серверов Telegram" "$TGX/app/build.gradle.kts" && echo "   загрузка переводов отключена" || { echo "   build.gradle.kts не пропатчен"; exit 2; }

echo "== google-services.json: клиент для нашего app.id (Firebase у нас не используется) =="
python3 - "$TGX/app/google-services.json" <<'PY'
import json, sys, copy
p = sys.argv[1]; j = json.load(open(p))
pk = "org.parvane.tgx"
# Свой заглушечный id приложения: Firebase отключён, а проверка выпуска X (validateApiTokens) отвергает чужой
# id Telegram X при другом пакете
own_id = "1:0:android:0000000000000000"
mine = [c for c in j["client"] if c["client_info"]["android_client_info"]["package_name"] == pk]
if not mine:
    c = copy.deepcopy(j["client"][0])
    c["client_info"]["android_client_info"]["package_name"] = pk
    j["client"].append(c)
    mine = [c]
for c in mine:
    c["client_info"]["mobilesdk_app_id"] = own_id
json.dump(j, open(p, "w"), indent=2)
print("   клиент", pk, "с заглушечным id приложения")
PY

echo "== spec 031: звонки — экран X поверх ядра и org.webrtc =="
git -C "$TGX" checkout -- app/src/main/java/org/thunderdog/challegram/service/TGCallService.java app/src/main/java/org/thunderdog/challegram/BaseApplication.kt 2>/dev/null
python3 - "$TGX" <<'PY'
import sys
root = sys.argv[1] + "/app/src/main/java/org/thunderdog/challegram/"
p = root + "service/TGCallService.java"; s = open(p).read()
s = s.replace("return tgcalls != null ? tgcalls.getCallDuration() : VoIPInstance.DURATION_UNKNOWN;",
  "return tgcalls != null ? tgcalls.getCallDuration() : org.drinkless.tdlib.Calls.durationMs(); // Parvane: таймер — ядро")
s = s.replace("    this.postponedCallSettings = settings;\n",
  "    this.postponedCallSettings = settings;\n    org.parvane.core.ParvaneCalls.INSTANCE.setMuted(settings != null && settings.isMicMuted(), false); // Parvane: микрофон — ядро\n", 1)
s = s.replace("    TdApi.CallStateReady state = (TdApi.CallStateReady) call.state;\n",
  "    TdApi.CallStateReady state = (TdApi.CallStateReady) call.state;\n    if (true) { tdlib.dispatchCallStateChanged(call.id, CallState.ESTABLISHED); return; } // Parvane: медиа — ядро и org.webrtc, tgcalls не нужен\n", 1)
# Новый звонок, пока служба держит прежний (тот закончился без её уборки), — не падение, а перезапуск под новый
s = s.replace("      if (oldCallId != 0 && oldCallId != callId)\n        throw new IllegalStateException();\n",
  "      if (oldCallId != 0 && oldCallId != callId) { callInitialized = false; initCall(tdlib, call); } // Parvane: прежний звонок не убран\n", 1)
open(p, "w").write(s)
p = root + "BaseApplication.kt"; s = open(p).read()
s = s.replace("    scope = MainScope()\n", "    scope = MainScope()\n    org.thunderdog.challegram.parvane.Parvane.onAppCreate(this) // Parvane: звонки, фон\n", 1)
open(p, "w").write(s)
PY
grep -q "Parvane: прежний звонок не убран" "$TGX/app/src/main/java/org/thunderdog/challegram/service/TGCallService.java" || { echo "   TGCallService: перезапуск не пропатчен"; exit 2; }
grep -q "Parvane: медиа — ядро" "$TGX/app/src/main/java/org/thunderdog/challegram/service/TGCallService.java" && echo "   TGCallService → ядро" || { echo "   TGCallService не пропатчен"; exit 2; }

echo "== spec 031: публичные группы — «Вступить» у превью (PUBLIC-1) =="
MSC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/MessagesController.java"
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/ui/MessagesController.java
perl -0pi -e 's/if \(tdlib\.isSupergroupChat\(chat\) && status != null && TD\.canReturnToChat\(status\)\) \{/if ((tdlib.isSupergroupChat(chat) || ChatId.isBasicGroup(chat.id)) \&\& status != null \&\& TD.canReturnToChat(status)) { \/\/ Parvane: публичная группа без вступления/' "$MSC"
grep -q "Parvane: публичная группа без вступления" "$MSC" && echo "   MessagesController: «Вступить» у превью" || { echo "   MessagesController не пропатчен"; exit 2; }

echo "== spec 031: связь чатов с разделами (T067) — меню сообщения и меню чата =="
MV="$TGX/app/src/main/java/org/thunderdog/challegram/component/chat/MessageView.java"
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/component/chat/MessageView.java
python3 - "$MV" "$MSC" <<'PY'
import sys
mv, msc = sys.argv[1], sys.argv[2]
s = open(mv).read()
old = "      if (allMessages.length == 1 && playListAddMode != TGPlayerController.ADD_MODE_NONE) {"
new = ("      if (allMessages.length == 1 && downloadedFiles.size() == 1) { // Parvane: сохранить в облако\n"
       "        ids.append(R.id.btn_parvaneSaveToCloud);\n"
       "        strings.append(R.string.ParvaneSaveToCloud);\n"
       "        icons.append(R.drawable.baseline_cloud_download_24);\n"
       "      }\n" + old)
assert old in s, 'MessageView: меню сообщения'
s = s.replace(old, new, 1)
open(mv, 'w').write(s)
s = open(msc).read()
old = "      } else if (id == R.id.btn_saveFile) {"
new = ("      } else if (id == R.id.btn_parvaneSaveToCloud) { // Parvane: сохранить в облако\n"
       "        org.thunderdog.challegram.parvane.sections.CloudBridge.saveFiles(this, (List<TD.DownloadedFile>) selectedMessageTag);\n"
       "        return true;\n" + old)
assert old in s, 'MessagesController: обработчик меню сообщения'
s = s.replace(old, new, 1)
old = ("    if ((!tdlib.isChannel(chat.id) || (status != null && !TD.isLeft(status))) && !tdlib.isSelfChat(chat.id)) {\n"
       "      ids.append(R.id.btn_mute);")
new = ("    if (!isSecretChat() && !tdlib.isChannel(chat.id)) { // Parvane: разделы в чате\n"
       "      ids.append(R.id.btn_parvaneFromCloud); strings.append(R.string.ParvaneFromCloud);\n"
       "      ids.append(R.id.btn_parvaneSuggestPlan); strings.append(R.string.ParvaneSuggestPlan);\n"
       "      ids.append(R.id.btn_parvaneArticle); strings.append(R.string.ParvaneArticle);\n"
       "    }\n" + old)
assert old in s, 'MessagesController: меню чата'
s = s.replace(old, new, 1)
old = "    } else if (id == R.id.btn_viewScheduled) {\n      viewScheduledMessages(false);"
new = ("    } else if (id == R.id.btn_parvaneFromCloud) {\n"
       "      org.thunderdog.challegram.parvane.sections.CloudBridge.attachFromCloud(this, chat.id);\n"
       "    } else if (id == R.id.btn_parvaneSuggestPlan) {\n"
       "      org.thunderdog.challegram.parvane.sections.CloudBridge.suggestPlan(this, chat.id);\n"
       "    } else if (id == R.id.btn_parvaneArticle) {\n"
       "      org.thunderdog.challegram.parvane.sections.CloudBridge.sendArticle(this, chat.id);\n" + old)
assert s.count(old) >= 1, 'MessagesController: обработчик меню чата'
s = s.replace(old, new, 1)
open(msc, 'w').write(s)
PY
grep -q "btn_parvaneSaveToCloud" "$MV" && grep -q "btn_parvaneArticle" "$MSC" && echo "   меню: облако, план, статья" || { echo "   меню не пропатчены"; exit 2; }

echo "== spec 031: темы — цветовые схемы web (Gruvbox по умолчанию) =="
python3 "$(dirname "$0")/theme/gen_tgx_themes.py" "$TGX" --check >/dev/null || { echo "   темы: генератор сообщил о контрасте"; exit 2; }
python3 - "$TGX" "$(dirname "$0")/tgx-overlay/app/src/main/other/theme-names.json" <<'PY'
import json, re, sys
tgx, names_path = sys.argv[1], sys.argv[2]
names = json.load(open(names_path, encoding='utf-8'))
for res, idx in (('values', 0), ('values-ru', 1)):
    p = f'{tgx}/app/src/main/res/{res}/strings.xml'
    try:
        s = open(p, encoding='utf-8').read()
    except FileNotFoundError:
        continue
    for key, pair in names.items():
        s = re.sub(r'(<string name="%s">)[^<]*(</string>)' % key, lambda m: m.group(1) + pair[idx] + m.group(2), s)
    open(p, 'w', encoding='utf-8').write(s)
PY
TM="$TGX/app/src/main/java/org/thunderdog/challegram/theme/ThemeManager.java"
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/theme/ThemeManager.java
python3 - "$TM" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
order = ("ThemeId.CLASSIC, ThemeId.NIGHT_BLUE, ThemeId.CYAN, ThemeId.WHITE_BLACK, ThemeId.GREEN, ThemeId.BLACK_WHITE, "
         "ThemeId.ORANGE, ThemeId.RED, ThemeId.BLUE, ThemeId.NIGHT_BLACK")
s2 = re.sub(r'int\[\] builtInThemeIds = BuildConfig\.DEBUG \? new int\[\] \{.*?\} : new int\[\] \{.*?\};',
            'int[] builtInThemeIds = new int[] { %s }; // Parvane: схемы web — светлая и тёмная парами' % order, s, flags=re.S)
assert s2 != s, 'список тем не найден'
open(p, 'w').write(s2)
PY
grep -q "Parvane: схемы web" "$TM" && echo "   темы: Gruvbox, Nord, Catppuccin, Solarized, Telegram" || { echo "   ThemeManager не пропатчен"; exit 2; }

echo "== spec 031: шрифты IBM Plex Sans и JetBrains Mono (OFL, как web и desktop) =="
FONTS_SRC="$(cd "$(dirname "$0")/.." && pwd)/desktop/tdesktop/Telegram/lib_ui/fonts"
mkdir -p "$TGX/app/src/main/assets/fonts"
for f in IBMPlexSans-Regular IBMPlexSans-SemiBold IBMPlexSans-Italic JetBrainsMono-Regular; do
  cp "$FONTS_SRC/$f.ttf" "$TGX/app/src/main/assets/fonts/$f.ttf" || { echo "   нет шрифта $f"; exit 2; }
done
cp "$FONTS_SRC/IBMPlexSans-OFL.txt" "$FONTS_SRC/JetBrainsMono-OFL.txt" "$TGX/app/src/main/assets/fonts/"
FJ="$TGX/app/src/main/java/org/thunderdog/challegram/tool/Fonts.java"
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/tool/Fonts.java
sed -i 's#"fonts/Roboto-Regular.ttf"#"fonts/IBMPlexSans-Regular.ttf"#; s#"fonts/Roboto-Bold.ttf"#"fonts/IBMPlexSans-SemiBold.ttf"#; s#"fonts/Roboto-Medium.ttf"#"fonts/IBMPlexSans-SemiBold.ttf"#; s#"fonts/Roboto-Italic.ttf"#"fonts/IBMPlexSans-Italic.ttf"#; s#"fonts/RobotoMono-Regular.ttf"#"fonts/JetBrainsMono-Regular.ttf"#' "$FJ"
grep -q "IBMPlexSans-Regular" "$FJ" && echo "   Fonts: Plex / JetBrains Mono" || { echo "   Fonts.java не пропатчен"; exit 2; }

echo "== spec 031: групповой звонок — кнопка звонка в профиле группы (CALL-2) =="
PRC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/ProfileController.java"
python3 - "$PRC" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
if "Parvane: групповой звонок" not in s:
    old = "      if (mode == Mode.SECRET) {\n        StopwatchHeaderButton"
    new = ("      if (mode != Mode.SECRET && mode != Mode.USER && chat != null && ChatId.isBasicGroup(chat.id)) { // Parvane: групповой звонок\n"
           "        callButton = header.addButton(realMenu, R.id.menu_btn_call, R.drawable.baseline_phone_24, buttonColorId, this, Screen.dp(48f));\n"
           "      }\n" + old)
    assert old in s, 'шапка профиля'
    s = s.replace(old, new, 1)
    old = "      if (userFull != null) {\n        tdlib.context().calls().makeCall(this, user.id, userFull);\n      }"
    new = old + "\n      else if (chat != null && ChatId.isBasicGroup(chat.id)) org.thunderdog.challegram.parvane.sections.GroupCallController.Companion.start(this, chat.id);"
    assert old in s, 'нажатие звонка'
    s = s.replace(old, new, 1)
    open(p, 'w').write(s)
PY
grep -q "Parvane: групповой звонок" "$PRC" && echo "   ProfileController: групповой звонок" || { echo "   ProfileController не пропатчен"; exit 2; }
python3 - "$PRC" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
if "btn_parvanePublic" not in s:
    old = "    tdlib.ui().addDeleteChatOptions(getChatId(), ids, strings, false, true);\n\n    if (ids.size() > 0) {\n      showMore(ids.get(), strings.get(), 0);"
    new = ("    if (mode == Mode.GROUP && org.thunderdog.challegram.parvane.sections.PublicGroupUi.canOpen(getChatId())) { // Parvane: PUBLIC-1\n"
           "      ids.append(R.id.btn_parvanePublic);\n"
           "      strings.append(R.string.ParvanePublicGroup);\n"
           "    }\n" + old)
    assert old in s, 'меню «⋮» группы'
    s = s.replace(old, new, 1)
    old = "        if (id == R.id.more_btn_addMember) {\n          addMember(null);"
    new = ("        if (id == R.id.btn_parvanePublic) { // Parvane: PUBLIC-1\n"
           "          org.thunderdog.challegram.parvane.sections.PublicGroupUi.open(this, getChatId());\n"
           "          return;\n"
           "        }\n" + old)
    assert old in s, 'обработчик «⋮» группы'
    s = s.replace(old, new, 1)
    open(p, 'w').write(s)
PY
grep -q "btn_parvanePublic" "$PRC" && echo "   ProfileController: тип группы (PUBLIC-1)" || { echo "   ProfileController: PUBLIC-1 не вставлен"; exit 2; }

echo "== spec 031: нижняя панель разделов на главном экране =="
MC="$TGX/app/src/main/java/org/thunderdog/challegram/ui/MainController.java"
if ! grep -q "ParvaneTabBar.attachToMain" "$MC"; then
  perl -0pi -e 's/(\n(\s*)contentView\.addView\(composeWrap\);\n)/$1$2org.thunderdog.challegram.parvane.sections.ParvaneTabBar.attachToMain(this, contentView, mainWrap, composeWrap); \/\/ Parvane: Чаты · План · + · Знания · Профиль\n/' "$MC"
fi
grep -q "ParvaneTabBar.attachToMain" "$MC" && echo "   MainController: панель разделов" || { echo "   MainController: панель не вставлена"; exit 2; }

echo "== spec 032: значок приложения — Parvane и на Android 8+ (адаптивный значок X с самолётиком не подменяет PNG) =="
rm -f "$TGX/app/src/sinceOreo/res/mipmap-anydpi-v26/app_launcher.xml" "$TGX/app/src/sinceOreo/res/mipmap-anydpi-v26/app_launcher_round.xml"
[ -e "$TGX/app/src/sinceOreo/res/mipmap-anydpi-v26/app_launcher.xml" ] && { echo "   адаптивный значок X не удалён"; exit 2; } || echo "   значок: PNG Parvane"

echo "== spec 032: вход и регистрация одним экраном как web (пароль и подтверждение Telegram — тот же экран) =="
rm -f "$TGX/app/src/main/java/org/thunderdog/challegram/ui/ParvaneNickController.java" "$TGX/app/src/main/java/org/thunderdog/challegram/ui/ParvaneRegisterController.java"
MA="$TGX/app/src/main/java/org/thunderdog/challegram/MainActivity.java"
python3 - "$MA" <<'PYMA'
import sys
p = sys.argv[1]; s = open(p).read()
if "spec 032): экран входа" not in s:
    old = """      case TdApi.AuthorizationStateWaitPassword.CONSTRUCTOR: {
        TdApi.AuthorizationStateWaitPassword state = (TdApi.AuthorizationStateWaitPassword) authState;
        PasswordController c = new PasswordController(this, tdlib);
        c.setArguments(new PasswordController.Args(PasswordController.MODE_LOGIN, state));
        return c;
      }"""
    assert old in s, "WaitPassword в MainActivity"
    s = s.replace(old, """      case TdApi.AuthorizationStateWaitPassword.CONSTRUCTOR: {
        return new ParvaneNickController(this, tdlib); // Parvane (spec 032): экран входа — пароль на том же экране
      }""", 1)
    old = """      case TdApi.AuthorizationStateWaitOtherDeviceConfirmation.CONSTRUCTOR: {
        // Should never come to TGX.
        break;
      }"""
    assert old in s, "WaitOtherDeviceConfirmation в MainActivity"
    s = s.replace(old, """      case TdApi.AuthorizationStateWaitOtherDeviceConfirmation.CONSTRUCTOR: {
        return new ParvaneNickController(this, tdlib); // Parvane: подтверждение входа в Telegram (2FA)
      }""", 1)
    old = """    if (c != null) {
      navigation.initController(c);
      c = new ParvaneNickController(this, account.tdlib());
      navigation.insertController(c, 0);
      return;
    }"""
    assert old in s, "initUnauthorizedController"
    s = s.replace(old, """    if (c != null) {
      navigation.initController(c);
      if (!(c instanceof ParvaneNickController)) {
        navigation.insertController(new ParvaneNickController(this, account.tdlib()), 0);
      }
      return;
    }""", 1)
    open(p, "w").write(s)
PYMA
grep -q "spec 032): экран входа" "$MA" && echo "   MainActivity: вход одним экраном" || { echo "   MainActivity: вход не пропатчен"; exit 2; }

echo "== spec 032: шапка списка чатов как web (без ☰ и меню Telegram, «Чаты» + лупа, папки чипами) =="
python3 - "$MC" <<'PYMC'
import sys
p = sys.argv[1]; s = open(p).read()
# своя шапка (ниже) заменяет шапку X; прежний метод X остаётся под другим именем
s = s.replace("  @Override\n  public View getCustomHeaderCell () {\n    if (displayTabsAtBottom()) {",
              "  public View telegramCustomHeaderCell () {\n    if (displayTabsAtBottom()) {", 1)
if "parvaneChips" not in s:
    old = "  @Override\n  protected int getBackButton () {\n    return BackHeaderButton.TYPE_MENU;\n  }"
    assert old in s, "getBackButton главного экрана"
    s = s.replace(old, """  @Override
  protected int getBackButton () {
    return BackHeaderButton.TYPE_NONE; // Parvane (spec 032): меню Telegram нет — всё в «Профиле»
  }

  // Parvane (spec 032): шапка как web — «Чаты» и лупа; папки — чипами под шапкой (ParvaneChatsHeader)
  public android.view.View parvaneChips, parvaneChipsBelow;
  private android.view.View parvaneTitle;

  @Override
  public View getCustomHeaderCell () {
    if (parvaneTitle == null) parvaneTitle = org.thunderdog.challegram.parvane.sections.ParvaneChatsHeader.title(this);
    return parvaneTitle;
  }

  @Override
  protected boolean swipeNavigationEnabled () {
    return false; // свайп от края открывал боковое меню Telegram
  }

  public java.util.List<TdApi.ChatList> parvaneChatLists () {
    return hasFolders() ? pagerChatLists : java.util.Collections.emptyList();
  }

  public TdApi.ChatFolderInfo[] parvaneFolderInfos () {
    return chatFolderInfos;
  }

  public int parvaneCurrentPage () {
    return getViewPager() != null ? getViewPager().getCurrentItem() : 0;
  }

  public void parvaneSelectPage (int position) {
    if (getViewPager() != null) getViewPager().setCurrentItem(position, true);
  }""", 1)
    old = "      header.addLockButton(menu);\n      header.addSearchButton(menu, this);"
    assert old in s, "меню главного экрана"
    s = s.replace(old, "      header.addLockButton(menu);\n      menu.addView(org.thunderdog.challegram.parvane.sections.ParvaneChatsHeader.searchButton(this));", 1)
    old = "  public void onPageSelected (int position, int actualPosition) {\n"
    assert old in s, "onPageSelected"
    s = s.replace(old, old + "    org.thunderdog.challegram.parvane.sections.ParvaneChatsHeader.select(this, position);\n", 1)
    old = "    notifyPagerItemPositionsChanged();\n    ViewPager pager = getViewPager();"
    assert old in s, "updatePagerSections"
    s = s.replace(old, "    notifyPagerItemPositionsChanged();\n    org.thunderdog.challegram.parvane.sections.ParvaneChatsHeader.refresh(this);\n    ViewPager pager = getViewPager();", 1)
open(p, "w").write(s)
PYMC
grep -q "parvaneChips" "$MC" && echo "   MainController: шапка и чипы папок" || { echo "   MainController: шапка не вставлена"; exit 2; }

echo "== spec 031: фон — UnifiedPush и служба связи (манифест) =="
git -C "$TGX" checkout -- app/src/main/AndroidManifest.xml 2>/dev/null
python3 - "$TGX/app/src/main/AndroidManifest.xml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
perm = '  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />\n'
if "FOREGROUND_SERVICE_REMOTE_MESSAGING" not in s:
    s = s.replace("  <application", perm + "  <application", 1)
if "RECEIVE_BOOT_COMPLETED" not in s:
    s = s.replace("  <application", '  <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />\n  <application', 1)
if "SCHEDULE_EXACT_ALARM" not in s:
    s = s.replace("  <application", '  <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />\n  <uses-permission android:name="android.permission.USE_EXACT_ALARM" />\n  <application', 1)
comp = """    <!-- Parvane: работа в фоне без Firebase (spec 031) -->
    <service android:name="org.thunderdog.challegram.parvane.ParvaneLinkService" android:exported="false"
      android:foregroundServiceType="remoteMessaging" />
    <service android:name="org.thunderdog.challegram.parvane.ParvaneSyncJob" android:exported="false"
      android:permission="android.permission.BIND_JOB_SERVICE" />
    <receiver android:name="org.thunderdog.challegram.parvane.ParvaneUnifiedPushReceiver" android:exported="true">
      <intent-filter>
        <action android:name="org.unifiedpush.android.connector.NEW_ENDPOINT" />
        <action android:name="org.unifiedpush.android.connector.MESSAGE" />
        <action android:name="org.unifiedpush.android.connector.UNREGISTERED" />
        <action android:name="org.unifiedpush.android.connector.REGISTRATION_FAILED" />
      </intent-filter>
    </receiver>
    <receiver android:name="org.thunderdog.challegram.parvane.sections.ParvaneReminderReceiver" android:exported="false" />
    <receiver android:name="org.thunderdog.challegram.parvane.ParvaneBootReceiver" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
        <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
      </intent-filter>
    </receiver>
"""
if "ParvaneLinkService" not in s:
    s = s.replace("  </application>", comp + "  </application>", 1)
# Android 11+: распространители UnifiedPush видны приложению только через <queries>
if "org.unifiedpush.android.distributor.REGISTER" not in s:
    s = s.replace("  </queries>", "    <intent><action android:name=\"org.unifiedpush.android.distributor.REGISTER\" /></intent>\n  </queries>", 1)
open(p, "w").write(s)
PY
grep -q "ParvaneLinkService" "$TGX/app/src/main/AndroidManifest.xml" && echo "   манифест: служба связи и приёмник UnifiedPush" || { echo "   манифест не пропатчен"; exit 2; }

echo "== spec 031: без Firebase (T045: токены устройства Google/Telegram X не запрашиваются) =="
git -C "$TGX" checkout -q -- app/src/google/main/java/org/thunderdog/challegram/service/DefaultFirebaseTokenRetriever.kt
python3 - "$TGX" <<'PY'
import sys
tgx = sys.argv[1]
p = tgx + "/app/src/google/main/java/org/thunderdog/challegram/service/DefaultFirebaseTokenRetriever.kt"
s = open(p).read()
s = s.replace("override fun isAvailable(context: Context): Boolean =\n    U.isGooglePlayServicesAvailable(context)",
              "override fun isAvailable(context: Context): Boolean = false // Parvane: без Firebase, пробуждение — UnifiedPush", 1)
s = s.replace("  override fun performInitialization(context: Context): Boolean {\n    try {",
              "  override fun performInitialization(context: Context): Boolean {\n    if (true) return false // Parvane: Firebase не инициализируется\n    try {", 1)
open(p, "w").write(s)
p = tgx + "/app/src/main/java/org/thunderdog/challegram/BaseApplication.kt"
s = open(p).read()
s = s.replace("        FirebaseMessaging.getInstance().isAutoInitEnabled = false\n",
              "        // Parvane: Firebase не инициализируется (провайдер инициализации убран из манифеста)\n", 1)
open(p, "w").write(s)
p = tgx + "/app/src/main/AndroidManifest.xml"
s = open(p).read()
prov = ('    <provider android:name="com.google.firebase.provider.FirebaseInitProvider" '
        'android:authorities="${applicationId}.firebaseinitprovider" tools:node="remove" />\n')
if "FirebaseInitProvider" not in s:
    s = s.replace("  </application>", prov + "  </application>", 1)
open(p, "w").write(s)
PY
grep -q "Parvane: без Firebase" "$TGX/app/src/google/main/java/org/thunderdog/challegram/service/DefaultFirebaseTokenRetriever.kt" && grep -q "FirebaseInitProvider" "$TGX/app/src/main/AndroidManifest.xml" && echo "   Firebase отключён" || { echo "   Firebase не отключён"; exit 2; }

echo "== spec 031: без проверки обновлений Google Play и канала Telegram X (T045; обновления — /apk/ сервера) =="
git -C "$TGX" checkout -q -- app/src/main/java/org/thunderdog/challegram/util/AppUpdater.java
python3 - "$TGX/app/src/main/java/org/thunderdog/challegram/util/AppUpdater.java" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "    if (AppInstallationUtil.allowInAppGooglePlayUpdates(context)) {"
assert old in s, 'AppUpdater: менеджер Play'
s = s.replace(old, "    if (false) { // Parvane: приложения нет в Google Play — менеджер обновлений не создаётся", 1)
old = "  public void checkForUpdates () {\n"
assert old in s, 'AppUpdater: checkForUpdates'
s = s.replace(old, old + "    if (true) return; // Parvane: ни Google Play, ни канал Telegram X — обновление с /apk/ сервера\n", 1)
open(p, "w").write(s)
PY
grep -q "Parvane: ни Google Play" "$TGX/app/src/main/java/org/thunderdog/challegram/util/AppUpdater.java" && echo "   проверка обновлений отключена" || { echo "   AppUpdater не пропатчен"; exit 2; }

echo "== local.properties / keystore =="
KEYPROPS="${PARVANE_KEYSTORE_PROPS:-$KEYS/keystore.properties}" # выпуск — keystore-release.properties (T077)
[ -f "$KEYPROPS" ] || { echo "нет $KEYPROPS (см. BUILD-android.md)"; exit 2; }
cat > "$TGX/local.properties" <<PROPS
sdk.dir=$SDK
org.gradle.workers.max=8
keystore.file=$KEYPROPS
app.id=org.parvane.tgx
app.name=Parvane
app.download_url=https://parvane.duckdns.org:20443/
app.sources_url=https://github.com/TGX-Android/Telegram-X
telegram.api_id=17349
telegram.api_hash=344583e45741c457fe1862106095a5eb
youtube.api_key=
tgx.extension=none
PROPS
echo "   $TGX/local.properties записан"

if [ "${1:-}" = "--build" ]; then
  echo "== сборка assembleLatestArm64Debug (долго: ffmpeg/libvpx/webrtc) =="
  cd "$TGX"
  export JAVA_HOME="$JDK21" ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
  export PATH="$JDK21/bin:/mnt/hdd/ub/android/tools/bin:$PATH"
  ./gradlew assembleLatestArm64Debug --no-daemon --console=plain
fi
echo "== готово =="
