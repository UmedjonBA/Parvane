// Parvane fork: картинки и превью карточек холста «Знаний» (spec 029, T063) — см. parvane_notes_canvas_media.h.
#include "parvane/parvane_notes_canvas_media.h"

#include "parvane/parvane_sections_data.h"

#include "base/timer.h"
#include "settings.h"

#include <rpl/event_stream.h>

#include <QtCore/QFile>

#include <deque>
#include <map>
#include <memory>
#include <set>

namespace Parvane::NotesUi::CanvasMedia {
namespace {

using json = nlohmann::json;

// Миниатюр держится в памяти не больше этого (давно не нужные уходят первыми)
constexpr auto kThumbsMax = 300;
// Превью ссылок — не больше 100 адресов (web PREVIEWS_MAX)
constexpr auto kPreviewsMax = 100;
// Картинка крупнее этого по длинной стороне уменьшается при чтении: экрану больше не нужно
constexpr auto kFullMaxSide = 2560;

struct State {
	rpl::event_stream<> updated;

	std::map<std::string, QImage> thumbs; // fileId миниатюры → картинка
	std::deque<std::string> thumbOrder;
	std::set<std::string> thumbsLoading;
	std::set<std::string> thumbsFailed;

	std::unique_ptr<notes::CanvasImageCache> cache;
	std::map<std::string, QImage> fullByUrl; // адрес кэша → картинка
	std::map<std::string, std::string> urlByFile; // fileId → адрес
	std::map<notes::CanvasTimerId, std::unique_ptr<base::Timer>> timers;
	notes::CanvasTimerId nextTimer = 0;
	std::uint64_t nextUrl = 0;

	std::map<std::string, Preview> previews;
	std::deque<std::string> previewOrder;
	std::set<std::string> previewsLoading;

	std::optional<notes::CanvasImageQuality> quality;
};

State &S();

[[nodiscard]] QString QualityPath() {
	return cWorkingDir() + u"tdata/parvane-canvas-images"_q;
}

[[nodiscard]] std::string BlobFileId(const std::optional<json> &blob) {
	return (blob && blob->is_object()) ? blob->value("fileId", std::string()) : std::string();
}

[[nodiscard]] QImage Decode(const std::string &bytes, int maxSide) {
	auto image = QImage::fromData(
		reinterpret_cast<const uchar*>(bytes.data()),
		int(bytes.size()));
	if (image.isNull()) {
		return image;
	}
	if (maxSide > 0 && std::max(image.width(), image.height()) > maxSide) {
		image = image.scaled(maxSide, maxSide, Qt::KeepAspectRatio, Qt::SmoothTransformation);
	}
	return image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
}

// Прочитать блоб узла в рабочем потоке и разобрать картинку там же
void ReadImage(
		const std::string &container,
		const std::string &nodeId,
		const json &blob,
		int maxSide,
		std::function<void(QImage)> done) {
	Sections::Ask<QImage>([=](Sections::Workers &w) {
		try {
			const auto read = w.drive.readText(container, nodeId, blob);
			if (!read || !read->contains("text") || !(*read)["text"].is_string()) {
				return QImage();
			}
			return Decode((*read)["text"].get_ref<const std::string&>(), maxSide);
		} catch (...) {
			return QImage();
		}
	}, std::move(done));
}

void Touch(std::deque<std::string> &order, const std::string &key) {
	if (const auto i = std::find(order.begin(), order.end(), key); i != order.end()) {
		order.erase(i);
	}
	order.push_back(key);
}

State &S() {
	static auto result = State();
	if (!result.cache) {
		auto deps = notes::CanvasImageCacheDeps();
		deps.createUrl = [](const notes::CanvasImageBlob &blob) {
			auto &s = S();
			const auto url = "full:" + std::to_string(++s.nextUrl);
			const auto image = std::static_pointer_cast<QImage>(blob.data);
			s.fullByUrl[url] = image ? *image : QImage();
			return url;
		};
		deps.revokeUrl = [](const std::string &url) {
			auto &s = S();
			s.fullByUrl.erase(url);
			for (auto i = s.urlByFile.begin(); i != s.urlByFile.end();) {
				i = (i->second == url) ? s.urlByFile.erase(i) : std::next(i);
			}
		};
		deps.setTimer = [](std::function<void()> fn, std::int64_t ms) {
			auto &s = S();
			const auto id = ++s.nextTimer;
			auto timer = std::make_unique<base::Timer>([id, fn = std::move(fn)] {
				auto &s = S();
				auto keep = std::move(s.timers[id]);
				s.timers.erase(id);
				fn();
			});
			timer->callOnce(ms);
			s.timers[id] = std::move(timer);
			return id;
		};
		deps.clearTimer = [](notes::CanvasTimerId id) {
			S().timers.erase(id);
		};
		deps.keepMs = notes::kCanvasImageKeepMs;
		result.cache = std::make_unique<notes::CanvasImageCache>(std::move(deps));
	}
	return result;
}

} // namespace

rpl::producer<> Updated() {
	return S().updated.events();
}

QImage Thumb(const std::string &container, const cloud::CloudNode &node) {
	auto &s = S();
	const auto key = BlobFileId(node.thumb);
	if (key.empty() || container.empty()) {
		return QImage();
	}
	if (const auto i = s.thumbs.find(key); i != s.thumbs.end()) {
		return i->second;
	}
	if (s.thumbsLoading.contains(key) || s.thumbsFailed.contains(key)) {
		return QImage();
	}
	s.thumbsLoading.insert(key);
	ReadImage(container, node.id, *node.thumb, 0, [key](QImage image) {
		auto &s = S();
		s.thumbsLoading.erase(key);
		if (image.isNull()) {
			s.thumbsFailed.insert(key);
			return;
		}
		s.thumbs[key] = std::move(image);
		Touch(s.thumbOrder, key);
		while (int(s.thumbOrder.size()) > kThumbsMax) {
			s.thumbs.erase(s.thumbOrder.front());
			s.thumbOrder.pop_front();
		}
		s.updated.fire({});
	});
	return QImage();
}

void Acquire(const std::string &container, const cloud::CloudNode &node) {
	auto &s = S();
	const auto fileId = BlobFileId(node.blob);
	if (fileId.empty()) {
		return;
	}
	const auto blob = *node.blob;
	const auto nodeId = node.id;
	s.cache->acquire(fileId, [=](notes::CanvasImageDone done) {
		ReadImage(container, nodeId, blob, kFullMaxSide, [done](QImage image) {
			if (image.isNull()) {
				done(std::nullopt);
				return;
			}
			auto result = notes::CanvasImageBlob();
			result.size = std::int64_t(image.sizeInBytes());
			result.data = std::make_shared<QImage>(std::move(image));
			done(result);
		});
	}, [fileId](std::optional<std::string> url) {
		auto &s = S();
		if (!url) {
			return;
		}
		s.urlByFile[fileId] = *url;
		s.updated.fire({});
	});
}

void Release(const std::string &fileId) {
	S().cache->release(fileId);
}

QImage Full(const std::string &fileId) {
	auto &s = S();
	const auto i = s.urlByFile.find(fileId);
	if (i == s.urlByFile.end()) {
		return QImage();
	}
	const auto j = s.fullByUrl.find(i->second);
	return (j != s.fullByUrl.end()) ? j->second : QImage();
}

void ForgetEmptyPreviews() {
	auto &s = S();
	for (auto i = s.previews.begin(); i != s.previews.end();) {
		if (notes::hasPreviewContent(i->second.preview)) {
			++i;
			continue;
		}
		const auto url = i->first;
		i = s.previews.erase(i);
		if (const auto j = std::find(s.previewOrder.begin(), s.previewOrder.end(), url); j != s.previewOrder.end()) {
			s.previewOrder.erase(j);
		}
	}
}

const Preview *LinkPreview(const std::string &url) {
	auto &s = S();
	if (const auto i = s.previews.find(url); i != s.previews.end()) {
		Touch(s.previewOrder, url);
		return &i->second;
	}
	if (s.previewsLoading.contains(url)) {
		return nullptr;
	}
	s.previewsLoading.insert(url);
	Sections::Ask<std::optional<Preview>>([url](Sections::Workers &w) -> std::optional<Preview> {
		auto source = std::optional<notes::LinkPreviewSource>();
		try {
			if (!w.self.empty()) {
				const auto body = w.transport.encodeMethod("preview.link", json{ { "url", url } });
				const auto bytes = w.transport.request(false, "preview.link", body, std::string());
				const auto r = w.transport.decodeMethod("preview.link", bytes);
				const auto str = [&](const char *a, const char *b = nullptr) -> std::optional<std::string> {
					for (const auto key : { a, b }) {
						if (key && r.contains(key) && r[key].is_string()) {
							return r[key].get<std::string>();
						}
					}
					return std::nullopt;
				};
				source = notes::LinkPreviewSource{
					.url = str("url"),
					.siteName = str("siteName", "site_name"),
					.title = str("title"),
					.description = str("description"),
					.imageBase64 = str("image"),
					.imageMime = str("imageMime", "image_mime"),
				};
			}
		} catch (...) {
			source = std::nullopt;
		}
		auto result = Preview{ notes::buildLinkPreview(url, source) };
		if (result.preview.imageBase64 && result.preview.imageMime) {
			const auto raw = QByteArray::fromBase64(QByteArray::fromStdString(*result.preview.imageBase64));
			result.image = Decode(raw.toStdString(), 1280);
		}
		return result;
	}, [url](std::optional<Preview> result) {
		auto &s = S();
		s.previewsLoading.erase(url);
		if (!result) {
			return;
		}
		s.previews[url] = std::move(*result);
		Touch(s.previewOrder, url);
		while (int(s.previewOrder.size()) > kPreviewsMax) {
			s.previews.erase(s.previewOrder.front());
			s.previewOrder.pop_front();
		}
		s.updated.fire({});
	});
	return nullptr;
}

notes::CanvasImageQuality ImageQuality() {
	auto &s = S();
	if (!s.quality) {
		auto f = QFile(QualityPath());
		auto stored = std::optional<std::string>();
		if (f.open(QIODevice::ReadOnly)) {
			stored = QString::fromUtf8(f.readAll()).trimmed().toStdString();
		}
		s.quality = notes::parseCanvasImageQuality(stored);
	}
	return *s.quality;
}

void SetImageQuality(notes::CanvasImageQuality quality) {
	auto &s = S();
	s.quality = quality;
	auto f = QFile(QualityPath());
	if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		f.write(QByteArray::fromStdString(notes::canvasImageQualityValue(quality)));
	}
	s.updated.fire({});
}

} // namespace Parvane::NotesUi::CanvasMedia
