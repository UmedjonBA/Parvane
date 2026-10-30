/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "settings.h"

#include "ui/emoji_config.h"

bool gInstallBetaVersion = AppBetaVersion;
uint64 gAlphaVersion = AppAlphaVersion;
uint64 gRealAlphaVersion = AppAlphaVersion;
QByteArray gAlphaPrivateKey;

bool gManyInstance = false;
QString gKeyFile;
QString gWorkingDir;

QList<QUrl> gStartUrls;

QString gDialogLastPath, gDialogHelperPath; // optimize QFileDialog

bool gStartMinimized = false;
bool gStartInTray = false;
bool gAutoStart = false;
bool gSendToMenu = false;
bool gAutoUpdate = true;
LaunchMode gLaunchMode = LaunchModeNormal;
bool gSeenTrayTooltip = false;
bool gRestartingUpdate = false, gRestarting = false, gRestartingToSettings = false, gWriteProtected = false;
bool gQuit = false;
int32 gLastUpdateCheck = 0;
bool gNoStartUpdate = false;
bool gStartToSettings = false;
bool gDebugMode = false;

int gScreenScale = style::kScaleAuto;
int gConfigScale = style::kScaleAuto;

RecentStickerPreload gRecentStickersPreload;
RecentStickerPack gRecentStickers;

RecentHashtagPack gRecentWriteHashtags, gRecentSearchHashtags;

bool gPasswordRecovered = false;
int32 gPasscodeBadTries = 0;
crl::time gPasscodeLastTry = 0;


int gOtherOnline = 0;

