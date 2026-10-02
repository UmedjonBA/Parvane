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

echo "== CMake: без libtdjni (наш шов — не JNI TDLib) =="
CM="$TGX/app/jni/CMakeLists.txt"
if grep -q "^  tdjni$" "$CM"; then
  sed -i '/^  tdjni$/d' "$CM"
fi
grep -q "parvane: tdjni убран" "$CM" || sed -i '1i # parvane: tdjni убран из линковки tgxjni (шов над parvane-core, см. android/setup-tgx.sh)' "$CM"

echo "== google-services.json: клиент для нашего app.id (Firebase у нас не используется) =="
python3 - "$TGX/app/google-services.json" <<'PY'
import json, sys, copy
p = sys.argv[1]; j = json.load(open(p))
pk = "org.parvane.tgx"
if not any(c["client_info"]["android_client_info"]["package_name"] == pk for c in j["client"]):
    c = copy.deepcopy(j["client"][0])
    c["client_info"]["android_client_info"]["package_name"] = pk
    j["client"].append(c)
    json.dump(j, open(p, "w"), indent=2)
    print("   добавлен клиент", pk)
else:
    print("   клиент", pk, "уже есть")
PY

echo "== local.properties / keystore =="
[ -f "$KEYS/keystore.properties" ] || { echo "нет $KEYS/keystore.properties (см. BUILD-android.md)"; exit 2; }
cat > "$TGX/local.properties" <<PROPS
sdk.dir=$SDK
org.gradle.workers.max=8
keystore.file=$KEYS/keystore.properties
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
