//! Paired phones. Each phone pairs once (QR code or 6-digit code) and gets its
//! own long-lived token, so it reconnects to every later share from this
//! laptop without pairing again. Only SHA-256 hashes of tokens are stored.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::server::now_secs;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Device {
    pub id: String,
    pub name: String,
    token_sha256: String,
    pub paired_at: u64,
    pub last_seen: u64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct Data {
    server_id: String,
    devices: Vec<Device>,
}

/// The device list lives on disk and may be changed by another process
/// (`mdshare unpair` while a share runs), so every read re-checks the file and
/// every write is a read-modify-write.
pub struct Registry {
    file: Option<PathBuf>,
    server_id: String,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    data: Data,
    mtime: Option<SystemTime>,
    /// Last-seen times not yet written to disk.
    seen: HashMap<String, u64>,
}

pub fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| CHARS[rng.random_range(0..CHARS.len())] as char)
        .collect()
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn config_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("mdshare"))
    } else if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        Some(PathBuf::from(xdg).join("mdshare"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("mdshare"))
    }
}

impl Registry {
    /// Loads `mdshare.json` from the config directory, creating the laptop's
    /// permanent server id on first run.
    pub fn load() -> Self {
        let file = config_dir().map(|d| d.join("mdshare.json"));
        Self::load_from(file)
    }

    pub fn load_from(file: Option<PathBuf>) -> Self {
        let mut reg = Self {
            file,
            server_id: String::new(),
            cache: Mutex::new(Cache::default()),
        };
        let mut cache = reg.cache.lock().unwrap();
        reg.reload(&mut cache);
        if cache.data.server_id.is_empty() {
            cache.data.server_id = random_string(16);
            reg.write(&mut cache);
        }
        reg.server_id = cache.data.server_id.clone();
        drop(cache);
        reg
    }

    fn mtime(&self) -> Option<SystemTime> {
        let file = self.file.as_ref()?;
        std::fs::metadata(file).and_then(|m| m.modified()).ok()
    }

    fn reload(&self, cache: &mut Cache) {
        cache.mtime = self.mtime();
        cache.data = self
            .file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| Data {
                server_id: cache.data.server_id.clone(),
                devices: Vec::new(),
            });
    }

    fn refresh(&self, cache: &mut Cache) {
        if self.file.is_some() && self.mtime() != cache.mtime {
            self.reload(cache);
        }
    }

    /// Re-reads the file, applies `f` and pending last-seen times, writes it.
    fn update<T>(&self, f: impl FnOnce(&mut Data) -> T) -> T {
        let mut cache = self.cache.lock().unwrap();
        self.refresh(&mut cache);
        let out = f(&mut cache.data);
        self.write(&mut cache);
        out
    }

    fn write(&self, cache: &mut Cache) {
        let seen = std::mem::take(&mut cache.seen);
        for d in &mut cache.data.devices {
            if let Some(&t) = seen.get(&d.id) {
                d.last_seen = d.last_seen.max(t);
            }
        }
        let Some(file) = &self.file else { return };
        let json = serde_json::to_string_pretty(&cache.data).unwrap();
        let tmp = file.with_extension("json.tmp");
        let written = file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, json))
            .and_then(|_| std::fs::rename(&tmp, file));
        if let Err(e) = written {
            eprintln!("warning: couldn't save {}: {e}", file.display());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
        }
        cache.mtime = self.mtime();
    }

    pub fn server_id(&self) -> String {
        self.server_id.clone()
    }

    pub fn list(&self) -> Vec<Device> {
        let mut cache = self.cache.lock().unwrap();
        self.refresh(&mut cache);
        let mut list = cache.data.devices.clone();
        for d in &mut list {
            if let Some(&t) = cache.seen.get(&d.id) {
                d.last_seen = d.last_seen.max(t);
            }
        }
        list
    }

    /// The device a token belongs to. Its last-seen time is kept in memory
    /// until the next `save`.
    pub fn authorize(&self, token: &str) -> Option<String> {
        let h = hash(token);
        let mut cache = self.cache.lock().unwrap();
        self.refresh(&mut cache);
        let id = cache
            .data
            .devices
            .iter()
            .find(|d| d.token_sha256 == h)?
            .id
            .clone();
        cache.seen.insert(id.clone(), now_secs());
        Some(id)
    }

    /// Registers a new phone and returns its id and token. The token is only
    /// ever returned here; the laptop keeps just its hash.
    pub fn pair(&self, name: &str) -> (String, String) {
        let token = random_string(32);
        let id = random_string(8);
        let name: String = name.trim().chars().take(64).collect();
        let now = now_secs();
        let device = Device {
            id: id.clone(),
            name: if name.is_empty() {
                "Phone".into()
            } else {
                name
            },
            token_sha256: hash(&token),
            paired_at: now,
            last_seen: now,
        };
        self.update(|data| data.devices.push(device));
        (id, token)
    }

    /// Removes devices whose id starts with `prefix` (or all, if `None`).
    /// Returns how many were removed.
    pub fn remove(&self, prefix: Option<&str>) -> usize {
        self.update(|data| {
            let before = data.devices.len();
            data.devices
                .retain(|d| prefix.is_some_and(|p| !p.is_empty() && !d.id.starts_with(p)));
            before - data.devices.len()
        })
    }

    /// Writes pending last-seen times.
    pub fn save(&self) {
        self.update(|_| ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_authorize_remove() {
        let file = std::env::temp_dir().join(format!("mdshare-reg-{}.json", random_string(6)));
        let reg = Registry::load_from(Some(file.clone()));
        let id = reg.server_id();
        assert_eq!(id.len(), 16);

        let (dev, token) = reg.pair("Pixel");
        assert_eq!(reg.authorize(&token), Some(dev.clone()));
        assert_eq!(reg.authorize("nope"), None);

        // Survives a reload, and only the hash is on disk.
        let reg2 = Registry::load_from(Some(file.clone()));
        assert_eq!(reg2.server_id(), id);
        assert_eq!(reg2.authorize(&token), Some(dev.clone()));
        assert!(!std::fs::read_to_string(&file).unwrap().contains(&token));

        // Un-pairing from another process (a second Registry) takes effect,
        // and saving the first one doesn't bring the device back.
        assert_eq!(reg2.remove(Some(&dev[..3])), 1);
        assert_eq!(reg.authorize(&token), None);
        reg.save();
        assert_eq!(reg2.authorize(&token), None);
        std::fs::remove_file(file).ok();
    }
}
