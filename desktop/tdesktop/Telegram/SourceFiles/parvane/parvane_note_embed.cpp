// Parvane fork: встроенный файл заметки и статьи — см. parvane_note_embed.h.
#include "parvane/parvane_note_embed.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_cloud_internal.h"
#include "parvane/parvane_local_files.h"
#include "parvane/parvane_notes_canvas_media.h"
#include "parvane/parvane_safe_open.h"
#include "parvane/parvane_space.h"

#include <parvane/blobcrypt.h>
#include <parvane/v2_engine.h>
#include <parvane/v2_session.h>

#include "core/file_utilities.h"
#include "core/mime_type.h"
#include "lang/lang_keys.h"
#include "ui/painter.h"

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>

#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QStandardPaths>
#include <QtCore/QUrl>
#include <QtCore/QUuid>
#include <QtGui/QDesktopServices>
#include <QtGui/QtEvents>

namespace Parvane::Knowledge {
namespace {

namespace cloud = parvane::sections::cloud;
namespace CanvasMedia = Parvane::NotesUi::CanvasMedia;
using Kit::Px;
using Kit::Rem;

// `.image`: не выше 30rem, не шире колонки текста
constexpr auto kImageMaxHeightRem = 30.;
constexpr auto kCardHeightRem = 2.75;
constexpr auto kCardMaxWidthRem = 24.;

[[nodiscard]] std::string BlobFileId(const cloud::CloudNode &node) {
	return (node.blob && node.blob->is_object()) ? node.blob->value("fileId", std::string()) : std::string();
}

// Временный каталог экземпляра (tdata/parvane-tmp), не общий $TMPDIR: стирается при старте и выходе. Пусто — нет каталога
[[nodiscard]] QString TempPath(const QString &name) {
	const auto dir = MakeTempDir(u"embed"_q);
	if (dir.isEmpty()) {
		return QString();
	}
	// Имя выбирает отправитель: только последней частью пути, без «..» и скрытых
	return QDir(dir).filePath(SafeLocalName(name));
}

// Наибольшая сторона картинки статьи и заметки на экране: крупнее — уменьшается при разборе
constexpr auto kEmbedImageMaxSide = 2560;
// Вложение чужой статьи по «Воспроизвести»/«Скачать» — не крупнее (как «Сохранить» в окне статьи); 0 снимал потолок вовсе
constexpr auto kEmbedFileMaxBytes = int64_t(512) * 1024 * 1024;

// Файл, выбранный пользователем («Сохранить как»)
[[nodiscard]] bool WriteFile(const QString &path, const QByteArray &bytes) {
	auto f = QFile(path);
	return f.open(QIODevice::WriteOnly) && f.write(bytes) == bytes.size();
}

class EmbedView final : public Ui::RpWidget {
public:
	EmbedView(QWidget *parent, EmbedSource source)
	: RpWidget(parent)
	, _source(std::move(source))
	, _kind(_source.type == EmbedSource::Type::Missing
		? cloud::FileKind::Other
		: cloud::kindOfFile(_source.mime, S(_source.name))) {
		Kit::RepaintOnTones(this);
		_type = Q(cloud::fileTypeLabel(S(_source.name)));
		setCursor(isMissing() ? style::cur_default : style::cur_pointer);
		if (isImage()) {
			startImage();
		}
		resize(width(), resizeGetHeight(width()));
	}

	~EmbedView() {
		if (!_acquired.empty()) {
			CanvasMedia::Release(_acquired);
		}
	}

protected:
	int resizeGetHeight(int newWidth) override {
		if (isImage() && !_image.isNull()) {
			const auto size = imageSize(newWidth);
			return size.height();
		}
		return Rem(kCardHeightRem) + Px(2);
	}

	void paintEvent(QPaintEvent *e) override {
		auto p = QPainter(this);
		PainterHighQualityEnabler hq(p);
		if (isImage() && !_image.isNull()) {
			const auto size = imageSize(width());
			auto path = QPainterPath();
			path.addRoundedRect(QRectF(0, 0, size.width(), size.height()), Rem(0.5), Rem(0.5));
			p.setClipPath(path);
			p.drawImage(QRect(QPoint(), size), _image);
			return;
		}
		paintCard(p);
	}

	void mouseReleaseEvent(QMouseEvent *e) override {
		if (e->button() != Qt::LeftButton || isMissing() || _busy) {
			return;
		}
		activate();
	}

private:
	[[nodiscard]] bool isMissing() const {
		return _source.type == EmbedSource::Type::Missing;
	}
	// Картинка показывается сама: своя (облако) — всегда, из статьи — не больше kArticleImageAutoMaxBytes
	// (заявленное больше — карточка, файл по нажатию; как web MediaEmbed с CANVAS_IMAGE_MAX_BYTES)
	[[nodiscard]] bool isImage() const {
		return !isMissing()
			&& _kind == cloud::FileKind::Photo
			&& (_source.type != EmbedSource::Type::Chat || _source.size <= kArticleImageAutoMaxBytes);
	}
	[[nodiscard]] bool isPlayable() const {
		return _kind == cloud::FileKind::Video || _kind == cloud::FileKind::Audio;
	}

	[[nodiscard]] QSize imageSize(int available) const {
		const auto maxW = std::max(std::min(available, _image.width()), 1);
		const auto maxH = Rem(kImageMaxHeightRem);
		auto size = _image.size().scaled(maxW, maxH, Qt::KeepAspectRatio);
		if (size.width() > _image.width()) {
			size = _image.size();
		}
		return size;
	}

	void startImage() {
		if (_source.type == EmbedSource::Type::Cloud) {
			const auto fileId = BlobFileId(_source.node);
			if (!fileId.empty()) {
				_acquired = fileId;
				CanvasMedia::Acquire(_source.container, _source.node);
			}
			refreshCloudImage();
			CanvasMedia::Updated() | rpl::on_next([=] {
				refreshCloudImage();
			}, lifetime());
		} else if (_source.type == EmbedSource::Type::Chat) {
			_busy = true;
			const auto weak = QPointer<EmbedView>(this);
			LoadChatMediaBytes(_source.media, kArticleImageAutoMaxBytes, [=](std::optional<QByteArray> bytes) {
				if (!weak) {
					return;
				}
				weak->_busy = false;
				auto image = bytes ? DecodeImageBounded(*bytes, kEmbedImageMaxSide) : QImage();
				if (image.isNull()) {
					weak->_failed = true;
				} else {
					weak->setImage(std::move(image));
				}
				weak->update();
			});
		}
	}

	void refreshCloudImage() {
		auto image = _acquired.empty() ? QImage() : CanvasMedia::Full(_acquired);
		if (image.isNull()) {
			image = CanvasMedia::Thumb(_source.container, _source.node);
		}
		if (!image.isNull() && image.cacheKey() != _image.cacheKey()) {
			setImage(std::move(image));
		}
	}

	void setImage(QImage image) {
		_image = std::move(image);
		resizeToWidth(width());
		update();
	}

	void paintCard(QPainter &p) {
		const auto w = std::min(width(), Rem(kCardMaxWidthRem));
		const auto r = QRectF(0.5, 0.5, w - 1., height() - 1.);
		p.setPen(QPen(ToneColor(Tone::Line), Px(1)));
		p.setBrush(ToneColor(Tone::Raised));
		p.drawRoundedRect(r, Rem(0.5), Rem(0.5));
		const auto missing = isMissing();
		const auto fg = ToneColor((missing || _failed) ? Tone::Red : Tone::Fg);
		auto x = Rem(0.75);
		const auto icon = Rem(1.375);
		if (missing) {
			PaintNotesIcon(p, u"x"_q, fg, x, (height() - icon) / 2, icon);
		} else {
			const auto type = Kit::Font(10, true);
			const auto top = (height() - icon - (_type.isEmpty() ? 0 : type->height)) / 2;
			PaintNotesIcon(p, u"file"_q, ToneColor(Tone::Muted), x, top, icon);
			if (!_type.isEmpty()) {
				p.setFont(type->f);
				p.setPen(ToneColor(Tone::Muted));
				const auto tw = type->width(_type);
				p.drawText(x + (icon - tw) / 2, top + icon + type->ascent, _type);
			}
		}
		x += icon + Rem(0.625);
		const auto meta = missing
			? tr::lng_parvane_notes_embed_missing(tr::now)
			: _failed
			? tr::lng_parvane_notes_embed_failed(tr::now)
			: _busy
			? tr::lng_parvane_notes_embed_loading(tr::now)
			: isImage()
			? tr::lng_parvane_notes_embed_loading(tr::now)
			: isPlayable()
			? tr::lng_parvane_notes_embed_play(tr::now)
			: tr::lng_parvane_cloud_download(tr::now);
		const auto size = (missing || _source.size <= 0) ? QString() : FormatSize(_source.size);
		const auto small = Kit::Font(13);
		const auto metaWidth = small->width(meta);
		const auto sizeWidth = size.isEmpty() ? 0 : small->width(size) + Rem(0.75);
		const auto right = w - Rem(0.75) - metaWidth - sizeWidth - Rem(0.625);
		const auto font = Kit::Font(Kit::kBodyPx);
		p.setFont(font->f);
		p.setPen(fg);
		p.drawText(x, (height() - font->height) / 2 + font->ascent, font->elided(_source.name, std::max(right - x, 0)));
		p.setFont(small->f);
		if (!size.isEmpty()) {
			p.setPen(ToneColor(Tone::Muted));
			p.drawText(right + Rem(0.625), (height() - small->height) / 2 + small->ascent, size);
		}
		const auto actionable = !missing && !_busy && !_failed && !isImage();
		p.setPen(missing ? fg : ToneColor(actionable ? Tone::Accent : Tone::Muted));
		p.drawText(w - Rem(0.75) - metaWidth, (height() - small->height) / 2 + small->ascent, meta);
	}

	void activate() {
		if ((_kind == cloud::FileKind::Photo || isPlayable()) && safeToOpen()) {
			openExternally();
		} else {
			save();
		}
	}

	// Файл система откроет по расширению, а имя выбирает отправитель статьи либо любой редактор совместной папки
	// (`x.desktop` при `image/png`): открываем, только если вид по расширению совпадает с видом по mime
	// (картинка, видео, звук) и расширение не исполняемое, иначе — «Сохранить как». Для облака — то же
	// (ревью 21 окт 2026, 2.3), для картинки ещё и совпадение с видом карточки.
	[[nodiscard]] bool safeToOpen() const {
		if (!SafeToOpenFile(_source.name, _source.mime)) {
			return false;
		}
		const auto type = Core::DetectNameType(_source.name);
		switch (_kind) {
		case cloud::FileKind::Photo: return (type == Core::NameType::Image);
		case cloud::FileKind::Video: return (type == Core::NameType::Video);
		case cloud::FileKind::Audio: return (type == Core::NameType::Audio);
		default: return false;
		}
	}

	// Картинка — системным просмотрщиком, видео и аудио — системным проигрывателем (из временного каталога)
	void openExternally() {
		const auto weak = QPointer<EmbedView>(this);
		_busy = true;
		update();
		const auto finish = [=](QString path) {
			if (!weak) {
				return;
			}
			weak->_busy = false;
			weak->_failed = path.isEmpty();
			weak->update();
			if (!path.isEmpty()) {
				QDesktopServices::openUrl(QUrl::fromLocalFile(path));
			}
		};
		if (_source.type == EmbedSource::Type::Cloud) {
			Cloud::DownloadToTemp({ Cloud::Entry{ _source.container, _source.node } }, [=](QStringList paths, QString) {
				finish(paths.isEmpty() ? QString() : paths.front());
			});
		} else {
			const auto name = _source.name;
			LoadChatMediaBytes(_source.media, kEmbedFileMaxBytes, [=](std::optional<QByteArray> bytes) {
				if (!bytes) {
					finish(QString());
					return;
				}
				const auto path = TempPath(name);
				finish((!path.isEmpty() && WriteTempFile(path, *bytes)) ? path : QString());
			});
		}
	}

	void save() {
		if (_source.type == EmbedSource::Type::Cloud) {
			Cloud::Download(this, Cloud::Entry{ _source.container, _source.node });
			return;
		}
		const auto media = _source.media;
		const auto name = _source.name;
		const auto weak = QPointer<EmbedView>(this);
		// Имя выбирает отправитель: в окно «Сохранить как» — только последней частью пути
		const auto initial = QDir(QStandardPaths::writableLocation(QStandardPaths::DownloadLocation)).filePath(SafeLocalName(name));
		FileDialog::GetWritePath(this, tr::lng_parvane_cloud_download(tr::now), QString(), initial, [=](QString &&path) {
			if (path.isEmpty()) {
				return;
			}
			if (weak) {
				weak->_busy = true;
				weak->update();
			}
			LoadChatMediaBytes(media, kEmbedFileMaxBytes, [=](std::optional<QByteArray> bytes) {
				const auto ok = bytes && WriteFile(path, *bytes);
				if (!weak) {
					return;
				}
				weak->_busy = false;
				weak->_failed = !ok;
				weak->update();
			});
		});
	}

	EmbedSource _source;
	cloud::FileKind _kind = cloud::FileKind::Other;
	QString _type;
	QImage _image;
	std::string _acquired;
	bool _busy = false;
	bool _failed = false;

};

} // namespace

object_ptr<Ui::RpWidget> CreateEmbedView(QWidget *parent, EmbedSource source) {
	return object_ptr<EmbedView>(parent, std::move(source));
}

void LoadChatMediaBytes(
		const nlohmann::json &media,
		int64_t maxPlainBytes,
		Fn<void(std::optional<QByteArray>)> done) {
	const auto fileId = media.value("file_id", std::string());
	const auto capability = media.value("capability", std::string());
	const auto key = media.value("file_key", std::string());
	const auto nonce = media.value("file_nonce", std::string());
	const auto domain = media.value("blob_domain", std::string());
	const auto declared = media.contains("size_bytes") && media["size_bytes"].is_number()
		? media["size_bytes"].get<double>()
		: 0.;
	// Заявлено больше потолка — не качать вовсе; иначе потолок — меньший из заявленного и данного
	if (maxPlainBytes > 0 && declared > double(maxPlainBytes)) {
		crl::on_main([=] {
			done(std::nullopt);
		});
		return;
	}
	auto limit = (declared > 0. && declared < 9e15) ? int64_t(declared) : int64_t(0);
	if (maxPlainBytes > 0 && (limit <= 0 || limit > maxPlainBytes)) {
		limit = maxPlainBytes;
	}
	const auto maxCipher = limit > 0 ? parvane::blobcrypt::maxCipherSize(std::size_t(limit)) : std::size_t(0);
	crl::async([=] {
		auto result = std::optional<QByteArray>();
		try {
			const auto session = SectionsSession();
			if (session && !fileId.empty() && !capability.empty()) {
				const auto cipher = session->downloadBlobCap(
					fileId,
					parvane::v2::fromBase64(capability),
					domain,
					maxCipher);
				if (key.empty()) {
					result = QByteArray::fromStdString(cipher);
				} else if (const auto plain = parvane::blobcrypt::decrypt(cipher, key, nonce)) {
					result = QByteArray::fromStdString(*plain);
				}
			}
		} catch (const std::exception &) {
		}
		crl::on_main([=] {
			done(result);
		});
	});
}

} // namespace Parvane::Knowledge
