// Parvane fork: склейка карты геолокации из тайлов preview.map.tile — см. .h
#include "parvane/parvane_map.h"

#include "base/call_delayed.h"
#include "base/debug_log.h"
#include "data/data_cloud_file.h"
#include "data/data_location.h"
#include "main/main_session.h"
#include "parvane/parvane_client.h"
#include "parvane/parvane_local_files.h" // LogSecret
#include "parvane/parvane_safe_open.h" // DecodeImageBounded
#include "ui/image/image_location_factory.h" // Images::FromImageInMemory

#include <parvane/map_tiles.h> // parvane-core
#include <parvane/v2_account.h> // parvane-core: preview.map_tile
#include <parvane/v2_control.h>

#include <QtCore/QBuffer>
#include <QtGui/QImage>
#include <QtGui/QPainter>

#include <atomic>
#include <future>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <utility>

namespace Parvane {
namespace {

// Фон под тайлами (тот же, что в web renderStaticMap), виден при недостающих тайлах
constexpr auto kMapBackground = 0xe8e6e1;
// Тайлов одной карты качаем параллельно не больше этого (gateway: 20 req/s)
constexpr int kTilesPerMapParallel = 4;
// Повтор неудавшейся склейки (preview/сеть недоступны): пауза и потолок на точку.
// Без него пузырь оставался бы с фоном до рестарта — CloudImage точки живёт в
// Session::_locations всю сессию и второй раз location() не зовётся.
constexpr auto kMapRetryDelay = crl::time(30000);
constexpr int kMapRetryMax = 3;

using PointKey = std::pair<double, double>;

struct FailedMap {
	Main::Session *session = nullptr;
	Data::CloudImage *image = nullptr;
};

std::mutex g_mapMutex;
std::set<PointKey> g_requested; // точки, для которых склейка уже запущена
std::map<PointKey, FailedMap> g_failed;   // ждут повтора
std::map<PointKey, int> g_attempts;       // сколько повторов уже сделано
bool g_retryScheduled = false;
std::shared_ptr<parvane::map::TileClient> g_tiles; // воркер склейки держит свою копию: сброс его не рушит
std::atomic<int> g_built{ 0 };

// Запомнить неудачу и взвести один общий таймер повтора (любой поток).
void noteFailed(
		Main::Session *session,
		Data::CloudImage *image,
		const PointKey &key) {
	auto schedule = false;
	{
		std::lock_guard<std::mutex> lk(g_mapMutex);
		if (g_attempts[key] >= kMapRetryMax) {
			LOG(("Parvane: карта локации %1,%2 — повторы исчерпаны (%3)")
				.arg(LogSecret(key.first)).arg(LogSecret(key.second)).arg(kMapRetryMax));
			return;
		}
		g_failed[key] = FailedMap{ session, image };
		if (!g_retryScheduled) {
			g_retryScheduled = true;
			schedule = true;
		}
	}
	if (schedule) {
		crl::on_main([] {
			base::call_delayed(kMapRetryDelay, [] { RetryFailedLocationMaps(); });
		});
	}
}

// Кладём картинку в CloudImage. set() отвязывает уже созданный view (его
// держит нарисованный HistoryView::Location), а usePreloaded пишет в пустоту —
// поэтому снимаем старый view ДО set() и пишем картинку и в него, и в новый.
// Новый view не держим: когда элемент выгрузит heavy part, штатный load()
// восстановит картинку из PNG-байт InMemoryLocation.
void publishOnMain(
		not_null<Main::Session*> session,
		not_null<Data::CloudImage*> image,
		QImage canvas,
		QByteArray png) {
	const auto oldView = image->activeView();
	image->set(session, Images::FromImageInMemory(canvas, "PNG", png));
	const auto view = image->createView();
	if (view) {
		*view = canvas;
	}
	if (oldView && oldView != view) {
		*oldView = canvas;
	}
	session->notifyDownloaderTaskFinished();
}

} // namespace

void RequestLocationMap(
		not_null<Main::Session*> session,
		const Data::LocationPoint &point,
		not_null<Data::CloudImage*> image) {
	const auto lat = point.lat();
	const auto lon = point.lon();
	const auto key = std::make_pair(lat, lon);
	if (!std::isfinite(lat) || !std::isfinite(lon)) {
		return; // NaN/inf в ключе дедупа ломает порядок std::set
	}
	auto bus = SnapshotBus();
	if (!bus.control) {
		LOG(("Parvane: карта локации не собрана %1,%2: нет транспорта")
			.arg(LogSecret(lat)).arg(LogSecret(lon)));
		noteFailed(session.get(), image.get(), key);
		return;
	}
	std::shared_ptr<parvane::map::TileClient> tiles;
	{
		std::lock_guard<std::mutex> lk(g_mapMutex);
		if (!g_requested.insert(key).second) {
			return; // уже собираем / собрали в этой сессии
		}
		if (!g_tiles) {
			g_tiles = std::make_shared<parvane::map::TileClient>();
		}
		tiles = g_tiles;
	}
	// Размер и DPR-масштаб — штатные (пузырь 320×240 / scale), зум — как в вебе
	// (16, а не 13 из ComputeLocation), чтобы карты на клиентах совпадали.
	const auto native = Data::ComputeLocation(point);
	const auto geometry = parvane::map::computeGeometry(
		lat,
		lon,
		parvane::map::kDefaultZoom,
		native.width,
		native.height,
		double(native.scale));
	if (geometry.tiles.empty()) {
		LOG(("Parvane: карта локации не собрана %1,%2: пустая геометрия")
			.arg(LogSecret(lat)).arg(LogSecret(lon)));
		return;
	}
	const auto sessionPtr = session.get();
	const auto imagePtr = image.get();
	crl::async([=, control = bus.control] {
		// Тайл — методом preview.map_tile соединения управления (MAP-1)
		const auto fetcher = [control](const parvane::map::TileKey &key) {
			return parvane::v2::account::mapTile(*control, key.z, key.x, key.y, parvane::map::kTileTimeoutMs);
		};
		// Тайлы — параллельно небольшими группами; неудавшиеся оставляют фон
		std::vector<std::vector<std::uint8_t>> pngs(geometry.tiles.size());
		for (std::size_t start = 0; start < geometry.tiles.size(); start += kTilesPerMapParallel) {
			std::vector<std::future<void>> batch;
			const auto end = std::min(geometry.tiles.size(), start + kTilesPerMapParallel);
			for (auto i = start; i < end; ++i) {
				batch.push_back(std::async(std::launch::async, [&, i] {
					auto fromCache = false;
					pngs[i] = tiles->fetch(fetcher, geometry.tiles[i].key, &fromCache);
					if (pngs[i].empty()) {
						return;
					}
					// «через preview» — только реальный запрос к шарду
					// (SC-005: e2e считает повторы по этому маркеру)
					LOG((fromCache
						? u"Parvane: тайл %1 из кэша %2 байт"_q
						: u"Parvane: тайл %1 через preview %2 байт"_q)
						.arg(QString::fromStdString(geometry.tiles[i].key.str()))
						.arg(int(pngs[i].size())));
				}));
			}
			for (auto &f : batch) {
				f.wait();
			}
		}
		auto canvas = QImage(
			geometry.canvasWidth(),
			geometry.canvasHeight(),
			QImage::Format_ARGB32_Premultiplied);
		canvas.fill(QColor(kMapBackground));
		auto ok = 0;
		{
			auto p = QPainter(&canvas);
			p.setRenderHint(QPainter::SmoothPixmapTransform);
			for (std::size_t i = 0; i < geometry.tiles.size(); ++i) {
				if (pngs[i].empty()) {
					continue;
				}
				// тайл от сервера: разбор с пределом размера (256 px на единицу масштаба)
				const auto tile = DecodeImageBounded(
					QByteArray::fromRawData(reinterpret_cast<const char*>(pngs[i].data()), int(pngs[i].size())),
					256 * std::max(1, int(std::ceil(native.scale))));
				if (tile.isNull()) {
					continue;
				}
				const auto &t = geometry.tiles[i];
				p.drawImage(QRect(t.dstX, t.dstY, t.dstSize, t.dstSize), tile);
				++ok;
			}
		}
		const auto total = int(geometry.tiles.size());
		if (!ok) {
			LOG(("Parvane: карта локации не собрана %1,%2: 0 тайлов из %3")
				.arg(LogSecret(lat)).arg(LogSecret(lon)).arg(total));
			{
				std::lock_guard<std::mutex> lk(g_mapMutex);
				g_requested.erase(key); // дать шанс повтору
			}
			noteFailed(sessionPtr, imagePtr, key);
			return;
		}
		auto png = QByteArray();
		{
			auto buffer = QBuffer(&png);
			canvas.save(&buffer, "PNG");
		}
		crl::on_main([=] {
			// Сессия могла смениться, пока качали: CloudImage принадлежит её Data
			if (ActiveMainSession() != sessionPtr) {
				return;
			}
			publishOnMain(sessionPtr, imagePtr, canvas, png);
			++g_built;
			LOG(("Parvane: карта локации собрана %1,%2 z%3 %4x%5 тайлов=%6/%7")
				.arg(LogSecret(lat)).arg(LogSecret(lon)).arg(geometry.zoom)
				.arg(canvas.width()).arg(canvas.height())
				.arg(ok).arg(total));
			if (ok < total) {
				// Часть тайлов не пришла (preview/сеть): показываем что есть и
				// ставим точку в очередь повторов — иначе пузырь оставался с
				// дырами до рестарта (готовые тайлы повтор берёт из LRU).
				LOG(("Parvane: карта локации собрана частично %1,%2 — повтор")
					.arg(LogSecret(lat)).arg(LogSecret(lon)));
				{
					std::lock_guard<std::mutex> lk(g_mapMutex);
					g_requested.erase(key);
				}
				noteFailed(sessionPtr, imagePtr, key);
			}
		});
	});
}

int LocationMapsBuilt() {
	return g_built.load();
}

void RetryFailedLocationMaps() {
	auto batch = std::vector<std::pair<PointKey, FailedMap>>();
	{
		std::lock_guard<std::mutex> lk(g_mapMutex);
		g_retryScheduled = false;
		for (auto &[key, failed] : g_failed) {
			++g_attempts[key];
			batch.emplace_back(key, failed);
		}
		g_failed.clear();
	}
	for (const auto &[key, failed] : batch) {
		// Сессия могла смениться — CloudImage той сессии уже разрушен
		if (!failed.session || ActiveMainSession() != failed.session || !failed.image) {
			continue;
		}
		auto attempt = 0;
		{
			std::lock_guard<std::mutex> lk(g_mapMutex);
			attempt = g_attempts[key];
		}
		LOG(("Parvane: повтор склейки карты %1,%2 (попытка %3 из %4)")
			.arg(LogSecret(key.first)).arg(LogSecret(key.second)).arg(attempt).arg(kMapRetryMax));
		RequestLocationMap(
			failed.session,
			Data::LocationPoint(key.first, key.second, Data::LocationPoint::NoAccessHash),
			failed.image);
	}
}

void ResetLocationMaps() {
	std::lock_guard<std::mutex> lk(g_mapMutex);
	g_requested.clear();
	g_failed.clear();
	g_attempts.clear();
	g_retryScheduled = false;
	g_tiles.reset();
}

} // namespace Parvane
