use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::IpcError;
use crate::graph::models::{AppSettingsDto, ModelTierConfig, ProviderKind, SaveSettingsInput};

const KEYRING_SERVICE: &str = "dev.axiom.canvas";
const REASONING_KEY_NAME: &str = "reasoning_api_key";
const UTILITY_KEY_NAME: &str = "utility_api_key";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTierConfig {
    provider: ProviderKind,
    base_url: String,
    model: String,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSettings {
    reasoning: StoredTierConfig,
    utility: StoredTierConfig,
    default_token_budget: u32,
    auto_summarize: bool,
    theme: String,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            reasoning: StoredTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: "https://api.openai.com/v1".to_owned(),
                model: "gpt-4o".to_owned(),
                temperature: 0.4,
                max_tokens: 2048,
            },
            utility: StoredTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: "https://api.openai.com/v1".to_owned(),
                model: "gpt-4o-mini".to_owned(),
                temperature: 0.2,
                max_tokens: 256,
            },
            default_token_budget: 6000,
            auto_summarize: true,
            theme: "dark".to_owned(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SettingsStore {
    config_path: PathBuf,
    use_keychain: bool,
}

impl SettingsStore {
    pub fn new() -> Result<Self, IpcError> {
        let base = dirs::config_dir().or_else(dirs::home_dir).ok_or_else(|| {
            IpcError::db("Unable to resolve user configuration directory for settings")
        })?;
        Ok(Self {
            config_path: base.join("axiom-canvas").join("settings.json"),
            use_keychain: true,
        })
    }

    pub fn with_config_path(path: PathBuf, use_keychain: bool) -> Self {
        Self {
            config_path: path,
            use_keychain,
        }
    }

    fn load_stored(&self) -> Result<StoredSettings, IpcError> {
        if !self.config_path.exists() {
            return Ok(StoredSettings::default());
        }
        let raw = std::fs::read_to_string(&self.config_path)?;
        let parsed: StoredSettings = serde_json::from_str(&raw)?;
        Ok(parsed)
    }

    fn keychain_has_key(&self, key_name: &str) -> bool {
        self.keychain_get_key(key_name).is_some()
    }

    fn keychain_get_key(&self, key_name: &str) -> Option<String> {
        if !self.use_keychain {
            return None;
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, key_name).ok()?;
        match entry.get_password() {
            Ok(val) => {
                let trimmed = val.trim().to_owned();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }
            Err(_) => None,
        }
    }

    fn keychain_update_key(&self, key_name: &str, value: Option<&str>) -> Result<(), IpcError> {
        let Some(raw) = value else {
            return Ok(());
        };
        if !self.use_keychain {
            return Ok(());
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, key_name)
            .map_err(|e| IpcError::db(format!("Failed to access OS keychain: {e}")))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(IpcError::db(format!(
                    "Failed to delete OS keychain credential: {e}"
                ))),
            }
        } else {
            entry
                .set_password(trimmed)
                .map_err(|e| IpcError::db(format!("Failed to save OS keychain credential: {e}")))
        }
    }

    pub fn load_dto(&self) -> Result<AppSettingsDto, IpcError> {
        let stored = self.load_stored()?;
        Ok(AppSettingsDto {
            reasoning: ModelTierConfig {
                provider: stored.reasoning.provider,
                base_url: stored.reasoning.base_url,
                model: stored.reasoning.model,
                has_api_key: self.keychain_has_key(REASONING_KEY_NAME),
                temperature: stored.reasoning.temperature,
                max_tokens: stored.reasoning.max_tokens,
            },
            utility: ModelTierConfig {
                provider: stored.utility.provider,
                base_url: stored.utility.base_url,
                model: stored.utility.model,
                has_api_key: self.keychain_has_key(UTILITY_KEY_NAME),
                temperature: stored.utility.temperature,
                max_tokens: stored.utility.max_tokens,
            },
            default_token_budget: stored.default_token_budget,
            auto_summarize: stored.auto_summarize,
            theme: stored.theme,
        })
    }

    pub fn save(&self, input: SaveSettingsInput) -> Result<AppSettingsDto, IpcError> {
        let theme = input.theme.trim().to_lowercase();
        if theme != "dark" && theme != "light" {
            return Err(IpcError::validation(
                "Theme must be either 'dark' or 'light'",
            ));
        }
        if input.default_token_budget < 512 {
            return Err(IpcError::validation(
                "Default token budget must be at least 512",
            ));
        }

        let reasoning = validate_tier(&input.reasoning, "reasoning")?;
        let utility = validate_tier(&input.utility, "utility")?;

        let stored = StoredSettings {
            reasoning,
            utility,
            default_token_budget: input.default_token_budget,
            auto_summarize: input.auto_summarize,
            theme,
        };

        let json = serde_json::to_string_pretty(&stored)?;
        if let Some(parent) = self.config_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let file_name = self
            .config_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("settings.json");
        let tmp_path = self
            .config_path
            .with_file_name(format!(".{file_name}.{}.tmp", ulid::Ulid::new()));
        {
            let mut f = std::fs::File::create(&tmp_path)?;
            f.write_all(json.as_bytes())?;
            f.sync_all()?;
        }
        if let Err(err) = std::fs::rename(&tmp_path, &self.config_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(err.into());
        }

        self.keychain_update_key(REASONING_KEY_NAME, input.reasoning_api_key.as_deref())?;
        self.keychain_update_key(UTILITY_KEY_NAME, input.utility_api_key.as_deref())?;

        self.load_dto()
    }

    pub fn tier_config_and_key(
        &self,
        tier: &str,
    ) -> Result<(ModelTierConfig, Option<String>), IpcError> {
        let dto = self.load_dto()?;
        match tier {
            "reasoning" => Ok((dto.reasoning, self.keychain_get_key(REASONING_KEY_NAME))),
            "utility" => Ok((dto.utility, self.keychain_get_key(UTILITY_KEY_NAME))),
            other => Err(IpcError::validation(format!(
                "Unknown model tier '{other}', expected 'reasoning' or 'utility'"
            ))),
        }
    }
}

fn validate_tier(tier: &ModelTierConfig, label: &str) -> Result<StoredTierConfig, IpcError> {
    let base_url = tier.base_url.trim().to_owned();
    if base_url.is_empty() {
        return Err(IpcError::validation(format!(
            "Base URL for {label} tier cannot be empty"
        )));
    }
    let model = tier.model.trim().to_owned();
    if model.is_empty() {
        return Err(IpcError::validation(format!(
            "Model name for {label} tier cannot be empty"
        )));
    }
    if !tier.temperature.is_finite() || !(0.0..=2.0).contains(&tier.temperature) {
        return Err(IpcError::validation(format!(
            "Temperature for {label} tier must be between 0.0 and 2.0"
        )));
    }
    if tier.max_tokens < 64 {
        return Err(IpcError::validation(format!(
            "Max tokens for {label} tier must be at least 64"
        )));
    }

    Ok(StoredTierConfig {
        provider: tier.provider,
        base_url,
        model,
        temperature: tier.temperature,
        max_tokens: tier.max_tokens,
    })
}
