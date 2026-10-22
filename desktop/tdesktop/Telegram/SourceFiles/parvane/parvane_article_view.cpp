// Parvane fork: окно чтения статьи — см. parvane_article_view.h.
#include "parvane/parvane_article_view.h"

#include "parvane/parvane_client.h"
#include "parvane/parvane_cloud_internal.h"
#include "parvane/parvane_knowledge.h"
#include "parvane/parvane_local_files.h"
#include "parvane/parvane_note_embed.h"
#include "parvane/parvane_note_markdown.h"
#include "parvane/parvane_safe_open.h"
#include "parvane/parvane_sections_data.h"

#include <parvane/sections/cloud_model.h>
#include <parvane/sections/markdown.h>
#include <parvane/sections/notes_store.h>

#include "boxes/abstract_box.h"
#include "core/application.h"
#include "lang/lang_keys.h"
#include "ui/boxes/confirm_box.h"
#include "ui/layers/generic_box.h"
#include "window/window_controller.h"
#include "styles/style_layers.h"

#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QStandardPaths>
#include <QtCore/QUuid>

#include <map>
#include <memory>
#include <set>

namespace Parvane {
namespace {

namespace cloud = parvane::sections::cloud;
namespace md = parvane::sections::markdown;
using nlohmann::json;

// Файл статьи по имени в тексте (`![[имя]]` либо путь — по последнему элементу)
[[nodiscard]] const json *FindMedia(const json &media, const std::string &name) {
	if (!media.is_array()) {
		return nullptr;
	}
	const auto base = md::embedBaseName(name);
	for (const auto &m : media) {
		const auto file = m.value("filename", std::string());
		if (!file.empty() && (file == name || file == base)) {
			return &m;
		}
	}
	return nullptr;
}

// Файл статьи больше этого в облако читателя не сохраняется (как предел медиа чата); всего больше второго —
// с вопросом (ревью 21 окт 2026, 2.2)
constexpr auto kArticleSaveFileMaxBytes = int64_t(512) * 1024 * 1024;
constexpr auto kArticleSaveConfirmBytes = int64_t(20) * 1024 * 1024;

[[nodiscard]] std::string VaultName() {
	return IsRussianUi() ? std::string("Знания") : std::string("Knowledge");
}

struct SaveResult {
	bool ok = false;
	std::string rootId;
	std::optional<std::string> folder; // папка хранилища в облаке
	std::map<std::string, std::string> names; // имя файла в статье → имя в облаке
};

void ShowToast(const QString &text) {
	if (const auto window = Core::App().activeWindow()) {
		window->showToast(text);
	}
}

// Файлы статьи — по одному во временный каталог под именами облака, затем загрузкой в папку хранилища. По одному:
// в памяти одновременно один файл (прежде — все сразу); каждый — с потолком заявленного размера
void UploadArticleFiles(const json &media, const SaveResult &saved) {
	if (!media.is_array() || media.empty() || saved.rootId.empty()) {
		return;
	}
	// Временный каталог экземпляра (tdata/parvane-tmp), не общий $TMPDIR: стирается при старте и выходе
	const auto dir = MakeTempDir(u"article"_q);
	if (dir.isEmpty()) {
		return;
	}
	struct Pending {
		std::size_t next = 0;
		QStringList paths;
		Fn<void()> step;
	};
	const auto state = std::make_shared<Pending>();
	const auto rootId = saved.rootId;
	const auto folder = saved.folder;
	const auto names = saved.names;
	state->step = [=] {
		if (state->next >= media.size()) {
			if (!state->paths.isEmpty()) {
				Cloud::UploadFiles(rootId, folder, state->paths);
			}
			state->step = nullptr; // разорвать цикл ссылок
			return;
		}
		const auto &m = media[state->next++];
		const auto file = m.value("filename", std::string("file"));
		const auto i = names.find(file);
		const auto target = QString::fromStdString(i != names.end() ? i->second : file);
		Knowledge::LoadChatMediaBytes(m, kArticleSaveFileMaxBytes, [=](std::optional<QByteArray> bytes) {
			if (bytes) {
				const auto path = QDir(dir).filePath(SafeLocalName(target));
				if (WriteTempFile(path, *bytes)) {
					state->paths.push_back(path);
				}
			}
			if (state->step) {
				state->step();
			}
		});
	};
	state->step();
}

void SaveArticle(const std::string &title, const std::string &markdown, const json &media) {
	const auto vault = VaultName();
	Sections::Ask<SaveResult>([=](Sections::Workers &w) -> SaveResult {
		auto result = SaveResult();
		if (w.self.empty()) {
			return result;
		}
		w.notes.loadNotes(w.self);
		const auto data = w.notes.cloudData();
		const auto rootId = data ? data->rootId : std::nullopt;
		// Папка хранилища (корневая папка с названием «Знания»), если она уже есть: занятые имена в ней
		auto vaultId = std::optional<std::string>();
		if (data && rootId) {
			for (const auto &node : data->nodesOf(rootId)) {
				if (node.isFolder() && !node.trashed && (!node.parent || node.parent->empty()) && node.name == vault) {
					vaultId = node.id;
					break;
				}
			}
		}
		auto taken = (data && rootId && vaultId)
			? cloud::namesIn(data->nodesOf(rootId), vaultId)
			: std::vector<std::string>();
		auto rename = std::map<std::string, std::string>();
		if (media.is_array()) {
			for (const auto &m : media) {
				const auto file = m.value("filename", std::string("file"));
				if (result.names.count(file)) {
					continue;
				}
				const auto name = cloud::freeName(taken, file.empty() ? std::string("file") : file);
				taken.push_back(name);
				result.names[file] = name;
				if (name != file) {
					rename[file] = name;
				}
			}
		}
		const auto text = rename.empty() ? markdown : md::renameEmbeds(markdown, rename);
		const auto noteId = w.notes.createNote(title, vault, text);
		if (!noteId) {
			return result;
		}
		result.ok = true;
		const auto after = w.notes.cloudData();
		const auto root = after ? after->rootId : std::nullopt;
		result.rootId = root.value_or(std::string());
		if (after && root) {
			for (const auto &node : after->nodesOf(root)) {
				if (node.id == *noteId) {
					result.folder = (node.parent && !node.parent->empty()) ? node.parent : std::nullopt;
					break;
				}
			}
		}
		return result;
	}, [=](SaveResult saved) {
		ShowToast(saved.ok
			? tr::lng_parvane_article_saved(tr::now, lt_title, QString::fromStdString(title))
			: tr::lng_parvane_article_save_failed(tr::now));
		if (saved.ok) {
			UploadArticleFiles(media, saved);
		}
	});
}

// Ревью 21 окт 2026 (2.2): «Сохранить в заметки» скачивает вложения в память и заливает в облако читателя (его
// квота). Как web — только файлы, встроенные в текст; крупнее kArticleSaveFileMaxBytes — не сохраняются; всего
// больше kArticleSaveConfirmBytes — сначала вопрос «с файлами / только текст» с их размером.
void AskAndSaveArticle(const std::string &title, const std::string &markdown, const json &media) {
	auto files = json::array();
	auto total = int64_t(0);
	auto skipped = false;
	auto seen = std::set<std::string>();
	for (const auto &name : md::embedNames(markdown)) {
		const auto found = FindMedia(media, name);
		if (!found || !seen.insert(found->value("filename", std::string())).second) {
			continue;
		}
		const auto declared = (found->contains("size_bytes") && (*found)["size_bytes"].is_number())
			? (*found)["size_bytes"].get<double>()
			: 0.;
		if (declared > double(kArticleSaveFileMaxBytes)) {
			skipped = true;
			continue;
		}
		total += int64_t(std::max(declared, 0.));
		files.push_back(*found);
	}
	if (skipped) {
		ShowToast(tr::lng_parvane_article_files_skipped(
			tr::now,
			lt_size,
			Knowledge::FormatSize(kArticleSaveFileMaxBytes)));
	}
	if (total <= kArticleSaveConfirmBytes || files.empty()) {
		SaveArticle(title, markdown, files);
		return;
	}
	const auto window = Core::App().activeWindow();
	if (!window) {
		return;
	}
	window->show(Ui::MakeConfirmBox({
		.text = tr::lng_parvane_article_save_big(tr::now, lt_size, Knowledge::FormatSize(total)),
		.confirmed = [=](Fn<void()> close) {
			SaveArticle(title, markdown, files);
			close();
		},
		.cancelled = [=](Fn<void()> close) {
			SaveArticle(title, markdown, json::array());
			close();
		},
		.confirmText = tr::lng_parvane_article_save_with_files(tr::now),
		.cancelText = tr::lng_parvane_article_save_text_only(tr::now),
		.strictCancel = true,
	}));
}

} // namespace

void ShowArticleWindow(const nlohmann::json &content) {
	const auto title = content.value("title", std::string());
	const auto markdown = content.value("markdown", std::string());
	const auto media = content.value("article_media", json::array());
	const auto window = Core::App().activeWindow();
	if (!window) {
		return;
	}
	window->show(Box([=](not_null<Ui::GenericBox*> box) {
		box->setTitle(rpl::single(QString::fromStdString(title)));
		box->setWidth(st::boxWideWidth);
		box->addRow(Knowledge::CreateMarkdownView(box, markdown, std::string(), [](QString target) {
			OpenKnowledgeNote(target);
		}, [=](QWidget *parent, const md::MdBlock &block) -> object_ptr<Ui::RpWidget> {
			if (block.url) {
				// Внешний адрес не загружается — ссылкой
				auto link = object_ptr<Knowledge::RichText>(parent, Knowledge::RichText::Style());
				auto part = md::MdInline();
				part.type = md::MdInlineType::Link;
				part.text = block.alt.value_or(*block.url);
				part.url = *block.url;
				link->setInlines({ part });
				return link;
			}
			// Встроенный файл статьи: блоб по секрету доступа; не приложен — «Файл не найден»
			auto source = Knowledge::EmbedSource();
			const auto found = FindMedia(media, block.name);
			source.name = QString::fromStdString(found
				? found->value("filename", std::string())
				: md::embedBaseName(block.name));
			if (found) {
				source.type = Knowledge::EmbedSource::Type::Chat;
				source.size = found->value("size_bytes", std::int64_t(0));
				source.mime = found->value("mime", std::string());
				source.media = *found;
			}
			return Knowledge::CreateEmbedView(parent, std::move(source));
		}));
		box->addButton(tr::lng_parvane_article_save(), [=] {
			box->closeBox();
			AskAndSaveArticle(title, markdown, media);
		});
		box->addButton(tr::lng_close(), [=] { box->closeBox(); });
	}));
}

} // namespace Parvane
