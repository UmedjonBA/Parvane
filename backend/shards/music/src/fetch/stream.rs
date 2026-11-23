//! «Слушать из сети» (макет «Музыки» 23 ноя, доска `MusicPlayer-04`): трек каталога, которого нет на сервере, играет
//! потоком из источника — без сохранения и без расхода суточного лимита. Файл выбирается тем же сравнением, что и
//! при скачивании, но только уверенный; ссылка на поток подписана и ведёт через шард к сервису (`/_parvane/music/n/`).

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use tracing::warn;

use super::jobs::{query_of, Fetch, CANDIDATES_PER_SOURCE};
use super::matching::{self, Verdict};
use super::service::ServiceError;
use crate::now_ms;
use crate::token::{self, Claims, Grant};

type Reply = Result<Vec<u8>, ErrorCode>;

/// Ссылка на поток живёт столько же, сколько ссылка трека библиотеки.
const NET_TTL_MS: i64 = token::STREAM_TTL_MS;
/// Разделитель источника и id файла в разрешении.
pub(crate) const NET_SEPARATOR: char = '\u{1f}';

impl Fetch {
    pub async fn catalog_stream(&self, key: &[u8; 32], public_base: &str, user: &str, r: pb::CatalogStreamRequest) -> Reply {
        let service = self.service()?;
        let track = r.track.ok_or(ErrorCode::Invalid)?;
        let query = query_of(&track);
        if query.artist.is_empty() || query.title.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let mut all = Vec::new();
        for source in matching::source_order(&query, &self.rules) {
            match service.candidates(source, &query, CANDIDATES_PER_SOURCE).await {
                Ok(found) => all.extend(found),
                Err(ServiceError::SourceRefused) => continue,
                Err(e) => {
                    warn!("музыка: поток — поиск в {source} не удался: {e:?}");
                    continue;
                }
            }
            let ranked = matching::rank(&query, &all, &self.rules);
            if matching::verdict(&query, &ranked, &self.rules) != Verdict::Auto {
                continue;
            }
            let Some(best) = ranked.iter().find(|x| x.score >= self.rules.auto_threshold && (!matching::needs_uncensored(&query) || x.trusted_original)) else {
                continue;
            };
            let exp = now_ms() + NET_TTL_MS;
            let item = format!("{}{NET_SEPARATOR}{}", best.candidate.source, best.candidate.id);
            let tok = token::sign(key, &Claims { user: user.to_string(), exp_ms: exp, grant: Grant::Net { item } }).ok_or(ErrorCode::Unavailable)?;
            return Ok(pb::CatalogStreamResponse { url: format!("{public_base}/_parvane/music/n/{tok}"), expires_ms: exp, source: best.candidate.source.clone() }.encode_to_vec());
        }
        Err(ErrorCode::NotFound)
    }
}
