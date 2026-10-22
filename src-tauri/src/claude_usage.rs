use serde::Serialize;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone)]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: String,
}

/// A weekly limit scoped to one model, such as Fable.
#[derive(Debug, Serialize, Clone)]
pub struct ModelLimit {
    pub model: String,
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub seven_day_opus: UsageWindow,
    pub model_limits: Vec<ModelLimit>,
}

fn read_credentials_json_with_retry(path: &std::path::Path) -> Option<serde_json::Value> {
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
            return Some(json);
        }
    }
    None
}

fn oauth_object(root: &serde_json::Value) -> Option<&serde_json::Value> {
    root.get("claudeAiOauth").filter(|value| value.is_object())
}

fn access_token_from_oauth(oauth: &serde_json::Value) -> Option<String> {
    oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|tok| !tok.is_empty())
        .map(str::to_string)
}

fn read_credentials_file_with_retry(path: &std::path::Path) -> Option<String> {
    read_credentials_json_with_retry(path).and_then(|json| {
        oauth_object(&json)
            .and_then(access_token_from_oauth)
    })
}

/// Builds the plan label shown on the usage card, such as `max · 5x`, from OAuth metadata only.
pub(crate) fn format_claude_plan_label(
    subscription_type: Option<&str>,
    rate_limit_tier: Option<&str>,
) -> Option<String> {
    let plan = subscription_type
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_ascii_lowercase();
    match rate_limit_tier.and_then(tier_multiplier) {
        Some(multiplier) => Some(format!("{plan} · {multiplier}")),
        None => Some(plan),
    }
}

/// The usage multiplier a rate limit tier ends with (`default_claude_max_20x` → `20x`); tiers
/// without one, such as `default_claude_ai`, have none.
fn tier_multiplier(tier: &str) -> Option<String> {
    let last = tier.trim().rsplit('_').next()?.to_ascii_lowercase();
    let digits = last.strip_suffix('x')?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(last)
}

fn plan_label_from_oauth(oauth: &serde_json::Value) -> Option<String> {
    format_claude_plan_label(
        oauth.get("subscriptionType").and_then(|v| v.as_str()),
        oauth.get("rateLimitTier").and_then(|v| v.as_str()),
    )
}

fn plan_label_from_credentials_root(root: &serde_json::Value) -> Option<String> {
    oauth_object(root).and_then(plan_label_from_oauth)
}

fn discover_credentials_root() -> Option<serde_json::Value> {
    if let Some(home) = dirs_next::home_dir() {
        let cred_path = home.join(".claude").join(".credentials.json");
        if let Some(json) = read_credentials_json_with_retry(&cred_path) {
            return Some(json);
        }
    }

    let service = "Claude Code-credentials";
    let mut usernames: Vec<String> = Vec::new();
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        if !user.is_empty() {
            usernames.push(user);
        }
    }
    for u in ["default", "user", "claude", ""] {
        usernames.push(u.to_string());
    }
    for username in &usernames {
        if let Ok(entry) = keyring::Entry::new(service, username) {
            if let Ok(secret) = entry.get_password() {
                if secret.is_empty() {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&secret) {
                    return Some(json);
                }
            }
        }
    }

    None
}

fn discover_plan_label() -> Option<String> {
    plan_label_unless_token_override(std::env::var("CLAUDE_OAUTH_TOKEN").ok().as_deref(), || {
        discover_credentials_root().and_then(|root| plan_label_from_credentials_root(&root))
    })
}

/// A `CLAUDE_OAUTH_TOKEN` override may belong to another account than the local sign-in, so the
/// plan stays unknown instead of being read from that sign-in.
fn plan_label_unless_token_override(
    env_token: Option<&str>,
    discover: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if env_token.is_some_and(|tok| !tok.is_empty()) {
        return None;
    }
    discover()
}

/// Try to find the Claude OAuth token.
fn discover_token() -> Option<String> {
    // 1. Env var
    if let Ok(tok) = std::env::var("CLAUDE_OAUTH_TOKEN") {
        if !tok.is_empty() {
            return Some(tok);
        }
    }

    // 2. ~/.claude/.credentials.json (where Claude Code actually stores it)
    if let Some(home) = dirs_next::home_dir() {
        let cred_path = home.join(".claude").join(".credentials.json");
        if let Some(tok) = read_credentials_file_with_retry(&cred_path) {
            return Some(tok);
        }
    }

    // 3. Keyring (Windows Credential Manager / macOS Keychain).
    //    On macOS Claude Code saves the entry with account = the local username,

    let service = "Claude Code-credentials";
    let mut usernames: Vec<String> = Vec::new();
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        if !user.is_empty() {
            usernames.push(user);
        }
    }
    for u in ["default", "user", "claude", ""] {
        usernames.push(u.to_string());
    }
    for username in &usernames {
        if let Ok(entry) = keyring::Entry::new(service, username) {
            if let Ok(secret) = entry.get_password() {
                if secret.is_empty() {
                    continue;
                }
                return Some(extract_token_from_secret(&secret));
            }
        }
    }

    None
}

/// Keychain entries store `{"claudeAiOauth":{"accessToken":...}}`, like on macOS.
fn extract_token_from_secret(secret: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(secret) {
        if let Some(tok) = oauth_object(&json).and_then(access_token_from_oauth) {
            return tok;
        }
    }
    secret.to_string()
}

/// Account plan for the Claude usage card, from OAuth metadata only (no token leaves the backend).
#[tauri::command]
pub async fn get_claude_plan() -> Result<Option<String>, String> {
    // Reading the credentials may sleep between retries and query the keyring.
    tokio::task::spawn_blocking(discover_plan_label)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_claude_usage() -> Result<ClaudeUsage, String> {
    let token = discover_token().ok_or_else(|| "no_token".to_string())?;

    let client = http_client();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        // The frontend holds every caller back for this long after a 429.
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        return Err(match retry_after {
            Some(secs) => format!("API returned {}; retry-after={secs}", resp.status()),
            None => format!("API returned {}", resp.status()),
        });
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    Ok(parse_usage(&body))
}

/// A Claude usage reading Claude Code passed to its status line, and when it arrived.
#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSessionUsage {
    pub usage: ClaudeUsage,
    pub at_ms: f64,
}

static LATEST_SESSION_USAGE: std::sync::Mutex<Option<ClaudeSessionUsage>> =
    std::sync::Mutex::new(None);

/// `rate_limits` from the JSON Claude Code passes to the status line command: the 5h and weekly
/// windows, `used_percentage` with `resets_at` in epoch seconds. The opus and per-model windows
/// only come from the usage API.
pub(crate) fn parse_statusline(body: &serde_json::Value, at_ms: f64) -> Option<ClaudeSessionUsage> {
    let limits = body.get("rate_limits").filter(|v| v.is_object())?;
    let window = |key: &str| -> Option<UsageWindow> {
        let window = limits.get(key).filter(|v| v.is_object())?;
        let resets_at = window.get("resets_at").and_then(|value| {
            value
                .as_f64()
                .and_then(|secs| chrono::DateTime::from_timestamp(secs as i64, 0))
                .map(|at| at.to_rfc3339())
                .or_else(|| value.as_str().map(str::to_string))
        });
        Some(UsageWindow {
            utilization: window.get("used_percentage").and_then(|v| v.as_f64())?,
            resets_at: resets_at.unwrap_or_default(),
        })
    };
    let empty = || UsageWindow {
        utilization: 0.0,
        resets_at: String::new(),
    };
    let (five_hour, seven_day) = (window("five_hour"), window("seven_day"));
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(ClaudeSessionUsage {
        usage: ClaudeUsage {
            five_hour: five_hour.unwrap_or_else(empty),
            seven_day: seven_day.unwrap_or_else(empty),
            seven_day_opus: empty(),
            model_limits: Vec::new(),
        },
        at_ms,
    })
}

/// Keeps `reading` when it is newer than the one held, and says whether it was.
pub(crate) fn offer_session_usage(reading: &ClaudeSessionUsage) -> bool {
    let Ok(mut latest) = LATEST_SESSION_USAGE.lock() else {
        return false;
    };
    if latest.as_ref().is_some_and(|held| held.at_ms >= reading.at_ms) {
        return false;
    }
    *latest = Some(reading.clone());
    true
}

/// The last usage a Claude Code status line reported this run, without touching the network.
#[tauri::command]
pub fn get_claude_session_usage() -> Option<ClaudeSessionUsage> {
    LATEST_SESSION_USAGE.lock().ok().and_then(|held| held.clone())
}

fn parse_usage(body: &serde_json::Value) -> ClaudeUsage {
    let parse_window = |key: &str| -> UsageWindow {
        let default = UsageWindow {
            utilization: 0.0,
            resets_at: String::new(),
        };
        let Some(obj) = body.get(key) else {
            return default;
        };
        if obj.is_null() {
            return default;
        }
        let utilization = obj
            .get("utilization")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let resets_at = obj
            .get("resets_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        UsageWindow {
            utilization,
            resets_at,
        }
    };

    // Opus has its own row; when the legacy `seven_day_opus` window is absent, fill that row from
    // the Opus entry in `limits[]` instead of listing it twice.
    let (opus, model_limits): (Vec<_>, Vec<_>) = parse_model_limits(body)
        .into_iter()
        .partition(|limit| limit.model.eq_ignore_ascii_case("opus"));
    let seven_day_opus = match opus.into_iter().next() {
        Some(limit) if body.get("seven_day_opus").is_none_or(|v| v.is_null()) => UsageWindow {
            utilization: limit.utilization,
            resets_at: limit.resets_at,
        },
        _ => parse_window("seven_day_opus"),
    };

    ClaudeUsage {
        five_hour: parse_window("five_hour"),
        seven_day: parse_window("seven_day"),
        seven_day_opus,
        model_limits,
    }
}

/// Model-scoped weekly limits are reported only in `limits[]`, as `weekly_scoped` entries with a
/// model scope. Limits that also narrow to one surface are skipped: they would repeat the model
/// name without saying which surface they cover.
fn parse_model_limits(body: &serde_json::Value) -> Vec<ModelLimit> {
    body.get("limits")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|limit| limit.get("kind").and_then(|v| v.as_str()) == Some("weekly_scoped"))
        .filter(|limit| limit.pointer("/scope/surface").is_none_or(|v| v.is_null()))
        .filter_map(|limit| {
            let model = limit.pointer("/scope/model/display_name")?.as_str()?;
            Some(ModelLimit {
                model: model.to_string(),
                utilization: limit.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0),
                resets_at: limit
                    .get("resets_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn reads_the_rate_limits_claude_code_passes_to_the_status_line() {
        let reading = super::parse_statusline(
            &json!({
                "model": { "display_name": "Opus" },
                "rate_limits": {
                    "five_hour": { "used_percentage": 100, "resets_at": 1_792_453_800 },
                    "seven_day": { "used_percentage": 41.5, "resets_at": 1_792_922_635 }
                }
            }),
            1_000.0,
        )
        .expect("reading");
        assert_eq!(reading.at_ms, 1_000.0);
        assert_eq!(reading.usage.five_hour.utilization, 100.0);
        assert_eq!(reading.usage.five_hour.resets_at, "2026-10-19T23:50:00+00:00");
        assert_eq!(reading.usage.seven_day.utilization, 41.5);
        assert_eq!(reading.usage.seven_day_opus.resets_at, "");
        assert!(reading.usage.model_limits.is_empty());
    }

    #[test]
    fn status_line_without_rate_limits_has_no_reading() {
        assert!(super::parse_statusline(&json!({ "model": {} }), 1.0).is_none());
        assert!(super::parse_statusline(&json!({ "rate_limits": null }), 1.0).is_none());
        assert!(super::parse_statusline(&json!({ "rate_limits": { "five_hour": {} } }), 1.0).is_none());
        let weekly_only = super::parse_statusline(
            &json!({ "rate_limits": { "seven_day": { "used_percentage": 3 } } }),
            1.0,
        )
        .expect("reading");
        assert_eq!(weekly_only.usage.five_hour.utilization, 0.0);
        assert_eq!(weekly_only.usage.seven_day.resets_at, "");
    }

    #[test]
    fn reads_model_scoped_weekly_limits() {
        let usage = super::parse_usage(&json!({
            "five_hour": { "utilization": 15.0, "resets_at": "2026-09-24T02:59:59Z" },
            "seven_day": { "utilization": 30.0, "resets_at": "2026-09-24T01:59:59Z" },
            "seven_day_opus": null,
            "limits": [
                { "kind": "session", "percent": 15, "resets_at": "2026-09-24T02:59:59Z", "scope": null },
                { "kind": "weekly_all", "percent": 30, "resets_at": "2026-09-24T01:59:59Z", "scope": null },
                {
                    "kind": "weekly_scoped", "percent": 25, "resets_at": "2026-09-24T01:59:59Z",
                    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }
                },
                {
                    "kind": "weekly_scoped", "percent": 40, "resets_at": "2026-09-24T01:59:59Z",
                    "scope": { "model": { "id": null, "display_name": "Opus" }, "surface": null }
                },
                {
                    "kind": "weekly_scoped", "percent": 70, "resets_at": "2026-09-24T01:59:59Z",
                    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": { "id": "cli" } }
                }
            ]
        }));

        assert_eq!(usage.five_hour.utilization, 15.0);
        assert_eq!(
            usage.model_limits.len(),
            1,
            "Opus keeps its own row; surface limits are skipped"
        );
        assert_eq!(usage.model_limits[0].model, "Fable");
        assert_eq!(usage.model_limits[0].utilization, 25.0);
        assert_eq!(usage.model_limits[0].resets_at, "2026-09-24T01:59:59Z");
        assert_eq!(
            usage.seven_day_opus.utilization, 40.0,
            "Opus from limits[] fills its row"
        );
    }

    #[test]
    fn legacy_opus_window_wins_over_its_scoped_limit() {
        let usage = super::parse_usage(&json!({
            "seven_day_opus": { "utilization": 12.0, "resets_at": "2026-09-24T01:59:59Z" },
            "limits": [{
                "kind": "weekly_scoped", "percent": 40, "resets_at": "2026-09-24T01:59:59Z",
                "scope": { "model": { "id": null, "display_name": "Opus" }, "surface": null }
            }]
        }));

        assert_eq!(usage.seven_day_opus.utilization, 12.0);
        assert!(usage.model_limits.is_empty());
    }

    #[test]
    fn missing_limits_means_no_model_rows() {
        let usage = super::parse_usage(&json!({ "five_hour": null, "limits": null }));
        assert!(usage.model_limits.is_empty());
    }

    #[test]
    fn formats_known_claude_plan_from_oauth_fields() {
        assert_eq!(
            super::format_claude_plan_label(Some("max"), Some("default_claude_max_5x")),
            Some("max · 5x".to_string())
        );
        assert_eq!(
            super::format_claude_plan_label(Some("max"), Some("default_claude_max_20x")),
            Some("max · 20x".to_string())
        );
        assert_eq!(
            super::format_claude_plan_label(Some("PRO"), None),
            Some("pro".to_string())
        );
    }

    #[test]
    fn tier_without_a_multiplier_shows_the_plan_alone() {
        assert_eq!(
            super::format_claude_plan_label(Some("pro"), Some("default_claude_ai")),
            Some("pro".to_string())
        );
        assert_eq!(
            super::format_claude_plan_label(Some("max"), Some("default_claude_max_other")),
            Some("max".to_string())
        );
        assert_eq!(
            super::format_claude_plan_label(Some("pro"), Some("default_claude_x")),
            Some("pro".to_string())
        );
    }

    #[test]
    fn unknown_claude_plan_has_no_label() {
        assert_eq!(super::format_claude_plan_label(None, None), None);
        assert_eq!(
            super::format_claude_plan_label(Some(""), Some("default_claude_max_5x")),
            None
        );
        assert_eq!(
            super::format_claude_plan_label(None, Some("default_claude_max_5x")),
            None
        );
    }

    #[test]
    fn reads_plan_from_credentials_json_without_exposing_token() {
        let label = super::plan_label_from_credentials_root(&json!({
            "claudeAiOauth": {
                "accessToken": "secret-token",
                "subscriptionType": "max",
                "rateLimitTier": "default_claude_max_5x"
            }
        }));
        assert_eq!(label, Some("max · 5x".to_string()));
    }

    #[test]
    fn token_override_hides_the_local_plan() {
        let local = || Some("max · 5x".to_string());
        assert_eq!(super::plan_label_unless_token_override(Some("env-token"), local), None);
        assert_eq!(
            super::plan_label_unless_token_override(Some(""), local),
            Some("max · 5x".to_string())
        );
        assert_eq!(
            super::plan_label_unless_token_override(None, local),
            Some("max · 5x".to_string())
        );
    }

    #[test]
    fn unreadable_credentials_have_no_plan_label() {
        assert!(super::plan_label_from_credentials_root(&json!({})).is_none());
        assert!(super::plan_label_from_credentials_root(&json!({ "claudeAiOauth": null })).is_none());
        assert!(
            super::plan_label_from_credentials_root(&json!({
                "claudeAiOauth": { "accessToken": "only-a-token" }
            }))
                .is_none()
        );
    }
}
