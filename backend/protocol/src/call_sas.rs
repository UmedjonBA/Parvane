//! Сверка ключей звонка словами (spec 041, доски `PhCalls`, `DkCalls`, правило CALL-3): четыре слова от отпечатков
//! DTLS обеих сторон. Отпечатки сортируются и склеиваются через `|`, от SHA-256 берутся первые четыре байта — номер
//! слова в одном общем списке из 256 английских слов (решение пользователя: язык общий, не язык интерфейса —
//! собеседники с разными языками сверяют одни и те же слова). Общий образец — `conformance/call-sas/cases.json`.

use sha2::{Digest, Sha256};

/// Слов в сверке: 4 × 8 бит.
pub const WORD_COUNT: usize = 4;

/// Слова сверки для пары отпечатков. Пустой отпечаток — `None`: сверять нечего.
pub fn words(local: &str, remote: &str) -> Option<Vec<&'static str>> {
    if local.trim().is_empty() || remote.trim().is_empty() {
        return None;
    }
    let mut pair = [local.trim(), remote.trim()];
    pair.sort_unstable();
    let hash = Sha256::digest(pair.join("|").as_bytes());
    Some(hash[..WORD_COUNT].iter().map(|byte| WORDS[*byte as usize]).collect())
}

/// Вызов из обвязок: `{local, remote}` → `["harbor", …]` либо `null`.
pub fn words_json(args: &serde_json::Value) -> serde_json::Value {
    let text = |key: &str| args.get(key).and_then(serde_json::Value::as_str).unwrap_or("");
    match words(text("local"), text("remote")) {
        Some(list) => serde_json::json!(list),
        None => serde_json::Value::Null,
    }
}

const WORDS: [&str; 256] = [
    "anchor", "apple", "arrow", "badge", "bagel", "baker", "bamboo", "banana", "basket", "beacon", "beaver", "bell",
    "berry", "bicycle", "blanket", "bottle", "bridge", "brush", "bucket", "buffalo", "butter", "button", "cabin",
    "cactus", "camel", "camera", "candle", "canoe", "canyon", "carpet", "carrot", "castle", "cedar", "cherry",
    "chess", "circus", "cliff", "clock", "cloud", "clover", "cobalt", "cocoa", "coconut", "comet", "compass",
    "copper", "coral", "cotton", "cougar", "cowboy", "coyote", "crane", "crayon", "cricket", "crystal", "cupboard",
    "dagger", "daisy", "desert", "diamond", "dinner", "dolphin", "donkey", "dragon", "drum", "eagle", "easel", "echo",
    "eclipse", "elbow", "elephant", "elm", "ember", "engine", "falcon", "feather", "fern", "ferry", "fiddle", "finch",
    "fjord", "flame", "flute", "forest", "fossil", "fountain", "fox", "garden", "garlic", "gecko", "geyser", "ginger",
    "giraffe", "glacier", "globe", "goat", "gold", "gopher", "grape", "gravel", "guitar", "hammer", "harbor", "harp",
    "hawk", "hazel", "helmet", "heron", "hill", "honey", "horizon", "hornet", "horse", "iceberg", "igloo", "island",
    "ivory", "jacket", "jaguar", "jasmine", "jelly", "jungle", "kayak", "kettle", "kitten", "koala", "ladder",
    "lagoon", "lake", "lantern", "lemon", "leopard", "lighthouse", "lily", "lime", "lion", "lizard", "llama",
    "lobster", "lotus", "magnet", "mango", "maple", "marble", "meadow", "melon", "mirror", "monkey", "moon", "moose",
    "mountain", "mushroom", "napkin", "needle", "nest", "nickel", "noodle", "oak", "oasis", "ocean", "olive", "onion",
    "orange", "orchid", "otter", "owl", "oyster", "paddle", "palace", "palm", "panda", "panther", "paper", "parrot",
    "peach", "peanut", "pearl", "pebble", "pelican", "pencil", "penguin", "pepper", "piano", "pigeon", "pillow",
    "pine", "pirate", "planet", "plum", "pony", "poppy", "potato", "pumpkin", "puzzle", "quartz", "rabbit", "raccoon",
    "radio", "rainbow", "raven", "ribbon", "river", "robin", "rocket", "rose", "saddle", "sailor", "salmon", "sandal",
    "saturn", "scarf", "seagull", "shadow", "shark", "shell", "shovel", "silver", "sketch", "sled", "snail", "socket",
    "spider", "spoon", "squirrel", "star", "statue", "stone", "storm", "sugar", "summit", "sunset", "swan", "table",
    "teapot", "temple", "thunder", "tiger", "timber", "tomato", "tortoise", "tower", "tractor", "trumpet", "tulip",
    "tunnel", "turtle", "umbrella", "valley", "velvet", "violin", "volcano", "wagon", "walnut", "walrus", "water",
    "whale",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_have_distinct_words() {
        let mut sorted = WORDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 256);
    }

    #[test]
    fn order_of_sides_does_not_matter() {
        assert_eq!(words("AA:BB", "CC:DD"), words("CC:DD", "AA:BB"));
        assert_eq!(words("", "CC:DD"), None);
    }
}
