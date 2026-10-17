//! Администрирование федерации (spec 028, R6): список закреплённых серверов,
//! сброс закрепления после смены ключа чужого сервера, блокировка доменов.
//!
//! `federation_admin list | unpin <домен> | block <домен> | unblock <домен>`;
//! база — `PARVANE_DB_PATH` (как у шарда). На проде:
//! `docker compose exec federation federation_admin unpin b.example`.

#[path = "../store.rs"]
#[allow(dead_code)]
mod store;

use anyhow::{bail, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./federation.db".to_string());
    let pool = store::open(&db_path).await?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let domain = |i: usize| -> Result<String> {
        let d = args.get(i).map(|d| d.trim().to_lowercase()).unwrap_or_default();
        if !parvane_protocol::address::is_valid_domain(&d) {
            bail!("нужен домен");
        }
        Ok(d)
    };
    match args.first().map(String::as_str) {
        Some("list") => {
            for (d, key, first, state) in store::list(&pool).await? {
                let k: String = key.iter().take(8).map(|b| format!("{b:02x}")).collect();
                println!("{d}\t{state}\tключ {k}…\tс {first}");
            }
        }
        Some("unpin") => {
            let d = domain(1)?;
            let n = store::unpin(&pool, &d).await?;
            println!("{d}: закрепление сброшено ({n}); при следующем контакте ключ закрепится заново");
        }
        Some("block") => {
            let d = domain(1)?;
            store::block(&pool, &d, now).await?;
            println!("{d}: заблокирован");
        }
        Some("unblock") => {
            let d = domain(1)?;
            store::unblock(&pool, &d).await?;
            println!("{d}: разблокирован");
        }
        _ => bail!("federation_admin list | unpin <домен> | block <домен> | unblock <домен>"),
    }
    Ok(())
}
