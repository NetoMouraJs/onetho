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

fn read_credentials_file_with_retry(path: &std::path::Path) -> Option<String> {
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    None
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
    //    No macOS o Claude Code grava a entrada com account = username local,

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

/// ({"claudeAiOauth":{"accessToken":...}}), como no macOS Keychain.
fn extract_token_from_secret(secret: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(secret) {
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return tok.to_string();
            }
        }
    }
    secret.to_string()
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
}
