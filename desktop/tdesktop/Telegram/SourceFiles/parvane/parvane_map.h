// Parvane fork: картинка карты для пузыря геолокации. Штатный tdesktop ждёт
// превью карты от MTProto (upload.getWebFile), которого у нас нет; вместо этого
// склеиваем OSM-тайлы через шард preview (preview.map.tile) и кладём готовую
// картинку в нативный Data::CloudImage точки — вьюха, пин, live-таймер и клик
// остаются штатными. Математика склейки — parvane-core map_tiles (паритет с web
// media.ts: тот же центр, зум 16). Наружу к картографическим хостам клиент не
// ходит (conformance MAP-1).
#pragma once

#include "base/basic_types.h"

namespace Main {
class Session;
} // namespace Main

namespace Data {
class LocationPoint;
class CloudImage;
} // namespace Data

namespace Parvane {

// Вызывается из Data::Session::location() сразу после создания CloudImage
// точки. Дедуп по (lat, lon) на сессию; работа на воркере; публикация на
// main-потоке. Логи: «карта локации собрана …» / «карта локации не собрана …».
void RequestLocationMap(
	not_null<Main::Session*> session,
	const Data::LocationPoint &point,
	not_null<Data::CloudImage*> image);

// Сколько карт собрано за сессию (диагностика/e2e).
[[nodiscard]] int LocationMapsBuilt();

// Повторить склейки, которые не удались (preview/сеть были недоступны):
// зовётся по таймеру (30 с) и при переподключении gateway; ≤ 3 повторов на
// точку. Main-поток.
void RetryFailedLocationMaps();

// Сброс дедупа, очереди повторов и кэша тайлов — при остановке сессии.
void ResetLocationMaps();

} // namespace Parvane
