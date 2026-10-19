use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::cli_resolver;

/// Quota endpoint the Codex CLI itself reads for ChatGPT logins.
const WHAM_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

const APP_SERVER_INITIALIZE: &str =
    r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"alethe","version":"1.2.0"}}}"#;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexUsageWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    /// Epoch in **milliseconds** (0 = unknown). The frontend computes `resets_at_ms - Date.now()`.
    pub resets_at_ms: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexUsage {
    pub primary: CodexUsageWindow,

    pub secondary: CodexUsageWindow,
    /// Account plan ("plus", "pro", ...). Empty when unknown.
    pub plan: String,

    pub rate_limited: bool,

    pub reset_credits: u64,
    pub reset_credit_items: Vec<CodexResetCredit>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexResetCredit {
    pub id: String,
    pub status: String,
    pub expires_at_ms: f64,
    pub title: String,
    pub description: String,
}

fn resolve_codex() -> Option<std::path::PathBuf> {
    let path = cli_resolver::rebuilt_path();
    let cwd = std::env::current_dir().unwrap_or_default();
    which::which_in("codex", Some(&path), &cwd).ok()
}

fn parse_window(value: Option<&serde_json::Value>) -> CodexUsageWindow {
    let default = CodexUsageWindow {
        used_percent: 0.0,
        window_minutes: 0,
        resets_at_ms: 0.0,
    };
    let Some(obj) = value else {
        return default;
    };
    if obj.is_null() {
        return default;
    }
    let used_percent = obj
        .get("usedPercent")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let window_minutes = obj
        .get("windowDurationMins")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let resets_at_ms = obj
        .get("resetsAt")
        .and_then(|v| v.as_f64())
        .map(|secs| secs * 1000.0)
        .unwrap_or(0.0);
    CodexUsageWindow {
        used_percent,
        window_minutes,
        resets_at_ms,
    }
}

fn parse_wham_window(value: Option<&Value>) -> CodexUsageWindow {
    let field = |key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_f64);
    CodexUsageWindow {
        used_percent: field("used_percent").unwrap_or(0.0),
        window_minutes: field("limit_window_seconds").map_or(0, |secs| (secs / 60.0) as u64),
        resets_at_ms: field("reset_at").map_or(0.0, |secs| secs * 1000.0),
    }
}

/// Codex lists its windows by position, not by length: a plan whose only limit is weekly (Pro
/// Lite) sends it as `primary`. Consumers read `primary` as the 5h window and `secondary` as the
/// weekly one, so a window longer than a day moves to `secondary`.
fn by_duration(
    primary: CodexUsageWindow,
    secondary: CodexUsageWindow,
) -> (CodexUsageWindow, CodexUsageWindow) {
    const DAY_MINUTES: u64 = 24 * 60;
    if primary.window_minutes > DAY_MINUTES && secondary.window_minutes <= DAY_MINUTES {
        (secondary, primary)
    } else {
        (primary, secondary)
    }
}

fn either<'a>(obj: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    obj.get(camel).or_else(|| obj.get(snake))
}

/// Epoch seconds or an RFC 3339 string, as epoch milliseconds.
fn timestamp_ms(value: &Value) -> Option<f64> {
    value.as_f64().map(|secs| secs * 1000.0).or_else(|| {
        chrono::DateTime::parse_from_rfc3339(value.as_str()?)
            .ok()
            .map(|at| at.timestamp_millis() as f64)
    })
}

/// Reset credits as app-server (camelCase) or the HTTP endpoint (snake_case) reports them.
fn parse_reset_credits(value: Option<&Value>) -> (u64, Vec<CodexResetCredit>) {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return (0, Vec::new());
    };
    let text = |credit: &Value, key: &str| {
        credit
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let items = value
        .get("credits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available"))
        .filter_map(|credit| {
            Some(CodexResetCredit {
                id: credit.get("id")?.as_str()?.to_string(),
                status: "available".to_string(),
                expires_at_ms: either(credit, "expiresAt", "expires_at")
                    .and_then(timestamp_ms)
                    .unwrap_or(0.0),
                title: text(credit, "title"),
                description: text(credit, "description"),
            })
        })
        .collect();
    let count = either(value, "availableCount", "available_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    (count, items)
}

/// `credits` is the `/wham/rate-limit-reset-credits` body: `/wham/usage` only counts the
/// available reset credits, while their titles and expiry come from that endpoint.
fn parse_wham_usage(body: &Value, credits: Option<&Value>) -> Result<CodexUsage, String> {
    let rate_limit = body
        .get("rate_limit")
        .filter(|v| !v.is_null())
        .ok_or("no rate limits")?;
    let (reset_credits, mut reset_credit_items) =
        parse_reset_credits(body.get("rate_limit_reset_credits"));
    if credits.is_some() {
        reset_credit_items = parse_reset_credits(credits).1;
    }
    let (primary, secondary) = by_duration(
        parse_wham_window(rate_limit.get("primary_window")),
        parse_wham_window(rate_limit.get("secondary_window")),
    );
    Ok(CodexUsage {
        primary,
        secondary,
        plan: body
            .get("plan_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        rate_limited: rate_limit
            .get("limit_reached")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reset_credits,
        reset_credit_items,
    })
}

/// A Codex usage reading taken from a session file, and when Codex recorded it.
#[derive(Debug, Serialize, Clone)]
pub struct CodexSessionUsage {
    pub usage: CodexUsage,
    /// Epoch milliseconds of the `token_count` event the reading comes from.
    pub at_ms: f64,
}

static LATEST_SESSION_USAGE: std::sync::Mutex<Option<CodexSessionUsage>> =
    std::sync::Mutex::new(None);

fn parse_rollout_window(value: Option<&Value>) -> CodexUsageWindow {
    let field = |key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_f64);
    CodexUsageWindow {
        used_percent: field("used_percent").unwrap_or(0.0),
        window_minutes: field("window_minutes").map_or(0, |minutes| minutes as u64),
        resets_at_ms: field("resets_at").map_or(0.0, |secs| secs * 1000.0),
    }
}

/// The rate limits in one rollout line: an `event_msg` / `token_count` event for the `codex` limit.
fn parse_rollout_line(line: &str) -> Option<CodexSessionUsage> {
    if !line.contains("\"token_count\"") {
        return None;
    }
    let event: Value = serde_json::from_str(line).ok()?;
    let payload = event.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }
    let limits = payload.get("rate_limits").filter(|v| !v.is_null())?;
    if limits
        .get("limit_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id != "codex")
    {
        return None;
    }
    let at_ms = event.get("timestamp").and_then(timestamp_ms)?;
    let (primary, secondary) = by_duration(
        parse_rollout_window(limits.get("primary")),
        parse_rollout_window(limits.get("secondary")),
    );
    Some(CodexSessionUsage {
        usage: CodexUsage {
            primary,
            secondary,
            plan: limits
                .get("plan_type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            rate_limited: limits
                .get("rate_limit_reached_type")
                .is_some_and(|reached| !reached.is_null()),
            reset_credits: 0,
            reset_credit_items: Vec::new(),
        },
        at_ms,
    })
}

/// The newest reading in a rollout. Its lines can run past a megabyte, so the tail read grows
/// until it holds a `token_count` event or covers the whole file.
pub(crate) fn rollout_usage(path: &std::path::Path) -> Option<CodexSessionUsage> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    for tail in [256 * 1024_u64, 4 * 1024 * 1024, 32 * 1024 * 1024] {
        let start = len.saturating_sub(tail);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        Read::take(&mut file, tail).read_to_end(&mut bytes).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        // A read that starts mid-file cuts its first line.
        let skip = usize::from(start > 0);
        let found = text
            .lines()
            .skip(skip)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .find_map(parse_rollout_line);
        if found.is_some() || start == 0 {
            return found;
        }
    }
    None
}

/// Keeps `reading` when it is newer than the one held, and says whether it was.
pub(crate) fn offer_session_usage(reading: &CodexSessionUsage) -> bool {
    let Ok(mut latest) = LATEST_SESSION_USAGE.lock() else {
        return false;
    };
    if latest.as_ref().is_some_and(|held| held.at_ms >= reading.at_ms) {
        return false;
    }
    *latest = Some(reading.clone());
    true
}

/// The newest Codex usage recorded in a session file, read without touching the network.
#[tauri::command]
pub async fn get_codex_session_usage() -> Option<CodexSessionUsage> {
    if let Some(held) = LATEST_SESSION_USAGE.lock().ok().and_then(|held| held.clone()) {
        return Some(held);
    }
    tokio::task::spawn_blocking(|| {
        let root = crate::codex_sessions::codex_sessions_dir()?;
        let mut files = Vec::new();
        crate::codex_sessions::collect_jsonl_files(&root, &mut files);
        let mut by_age: Vec<_> = files
            .into_iter()
            .filter_map(|path| Some((std::fs::metadata(&path).ok()?.modified().ok()?, path)))
            .collect();
        by_age.sort_by(|a, b| b.0.cmp(&a.0));
        // A session that has just started has no token_count yet; an older one still does.
        let reading = by_age
            .iter()
            .take(5)
            .find_map(|(_, path)| rollout_usage(path))?;
        offer_session_usage(&reading);
        Some(reading)
    })
    .await
    .ok()
    .flatten()
}

/// Codex keeps its ChatGPT login in `$CODEX_HOME/auth.json` (default `~/.codex`).
fn codex_auth_path() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join("auth.json"))
        .or_else(|| crate::provider_common::provider_home_dir(&[".codex", "auth.json"]))
}

/// `(access_token, account_id)`; `None` for API-key logins or credentials kept in the OS keyring.
fn oauth_credentials(auth: &Value) -> Option<(String, Option<String>)> {
    let tokens = auth.get("tokens")?;
    let text = |key: &str| {
        tokens
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    Some((text("access_token")?, text("account_id")))
}

/// Reads the quota over HTTP with the token the Codex CLI already stored, without spawning
/// `codex.exe`. Read-only on purpose: refreshing here would rotate the refresh token under the CLI.
/// An expired token fails with 401 and falls back to app-server, which refreshes it.
async fn fetch_usage_http() -> Result<CodexUsage, String> {
    let path = codex_auth_path().ok_or("no_home")?;
    let raw = std::fs::read(&path).map_err(|e| format!("auth read failed: {e}"))?;
    let auth: Value =
        serde_json::from_slice(&raw).map_err(|e| format!("auth parse failed: {e}"))?;
    let (token, account_id) = oauth_credentials(&auth).ok_or("no_oauth_token")?;

    let body = wham_get(WHAM_USAGE_URL, &token, account_id.as_deref()).await?;
    let usage = parse_wham_usage(&body, None)?;
    if usage.reset_credits == 0 {
        return Ok(usage);
    }
    match wham_get(WHAM_RESET_CREDITS_URL, &token, account_id.as_deref()).await {
        Ok(credits) => parse_wham_usage(&body, Some(&credits)),
        Err(e) => {
            eprintln!("[codex_usage] reset credit details unavailable: {e}");
            Ok(usage)
        }
    }
}

async fn wham_get(url: &str, token: &str, account_id: Option<&str>) -> Result<Value, String> {
    let mut request = http_client()
        .get(url)
        .bearer_auth(token)
        .header("User-Agent", concat!("Alethe/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10));
    if let Some(account_id) = account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("API returned {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("json parse: {e}"))
}

/// One JSON-RPC call against a short-lived `codex app-server`; returns its `result`.
/// Blocking — run via `spawn_blocking`.
fn app_server_call(method: &str, params: Option<Value>) -> Result<Value, String> {
    let exe = resolve_codex().ok_or_else(|| "codex_not_found".to_string())?;

    let mut command = Command::new(exe);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::git_control::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("id").and_then(Value::as_i64) == Some(2) {
                    let _ = tx.send(value);
                    break;
                }
            }
        }
    });

    let mut request = serde_json::json!({ "id": 2, "method": method });
    if let Some(params) = params {
        request["params"] = params;
    }
    let requests = format!("{APP_SERVER_INITIALIZE}\n{{\"method\":\"initialized\"}}\n{request}\n");
    let received = stdin
        .write_all(requests.as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|e| format!("write failed: {e}"))
        .and_then(|()| {
            rx.recv_timeout(Duration::from_secs(12))
                .map_err(|_| "timeout".to_string())
        });

    // Close stdin so app-server exits on its own and kill it only if it lingers: hard-killing
    // codex.exe mid-call is tied to lsass.exe crashes on Windows (#202). Off-thread so the caller
    // gets its answer without waiting for the exit.
    thread::spawn(move || {
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(5);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
        let _ = reader.join();
    });

    let message = received?;
    if let Some(error) = message.get("error") {
        return Err(format!("rpc error: {error}"));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| "no result".to_string())
}

/// Blocking — run via `spawn_blocking`.
fn fetch_usage_app_server() -> Result<CodexUsage, String> {
    parse_app_server_usage(&app_server_call("account/rateLimits/read", None)?)
}

fn parse_app_server_usage(result: &Value) -> Result<CodexUsage, String> {
    let rate_limits = result
        .get("rateLimits")
        .filter(|v| !v.is_null())
        .ok_or("no rate limits")?;
    let (reset_credits, reset_credit_items) =
        parse_reset_credits(result.get("rateLimitResetCredits"));
    let (primary, secondary) = by_duration(
        parse_window(rate_limits.get("primary")),
        parse_window(rate_limits.get("secondary")),
    );

    Ok(CodexUsage {
        primary,
        secondary,
        plan: rate_limits
            .get("planType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        rate_limited: rate_limits
            .get("rateLimitReachedType")
            .is_some_and(|v| !v.is_null()),
        reset_credits,
        reset_credit_items,
    })
}

fn consume_reset_credit(credit_id: Option<String>) -> Result<(), String> {
    let mut params = serde_json::json!({ "idempotencyKey": nanoid::nanoid!() });
    if let Some(credit_id) = credit_id.filter(|id| !id.is_empty()) {
        params["creditId"] = Value::String(credit_id);
    }
    let result = app_server_call("account/rateLimitResetCredit/consume", Some(params))?;
    let outcome = result
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if outcome != "reset" && outcome != "alreadyRedeemed" {
        return Err(format!("reset credit was not consumed: {outcome}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_codex_usage() -> Result<CodexUsage, String> {
    // HTTP first: spawning codex.exe on every poll can crash lsass.exe on Windows (#202).
    match fetch_usage_http().await {
        Ok(usage) => return Ok(usage),
        Err(e) => eprintln!("[codex_usage] http read failed, using app-server: {e}"),
    }
    tokio::task::spawn_blocking(fetch_usage_app_server)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn consume_codex_reset_credit(credit_id: Option<String>) -> Result<CodexUsage, String> {
    tokio::task::spawn_blocking(move || consume_reset_credit(credit_id))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    get_codex_usage().await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn parses_wham_usage_response() {
        let body = json!({
            "plan_type": "plus",
            "rate_limit": {
                "allowed": true,
                "limit_reached": true,
                "primary_window": { "used_percent": 12, "limit_window_seconds": 18_000, "reset_at": 1_700_003_600 },
                "secondary_window": { "used_percent": 44.5, "limit_window_seconds": 604_800, "reset_at": 1_700_475_600 }
            },
            "rate_limit_reset_credits": {
                "available_count": 2,
                "credits": [
                    { "id": "c1", "status": "available", "title": "Full reset", "expires_at": "2026-10-04T01:14:53Z" },
                    { "id": "c2", "status": "redeemed" }
                ]
            }
        });

        let usage = super::parse_wham_usage(&body, None).expect("usage should parse");

        assert_eq!(usage.plan, "plus");
        assert!(usage.rate_limited);
        assert_eq!(usage.primary.used_percent, 12.0);
        assert_eq!(usage.primary.window_minutes, 300);
        assert_eq!(usage.primary.resets_at_ms, 1_700_003_600_000.0);
        assert_eq!(usage.secondary.used_percent, 44.5);
        assert_eq!(usage.secondary.window_minutes, 10_080);
        assert_eq!(usage.reset_credits, 2);
        assert_eq!(usage.reset_credit_items.len(), 1);
        assert_eq!(usage.reset_credit_items[0].id, "c1");
        assert_eq!(
            usage.reset_credit_items[0].expires_at_ms,
            1_791_076_493_000.0
        );
    }

    #[test]
    fn app_server_weekly_only_plan_reports_its_window_as_weekly() {
        // Pro Lite (#187): the only limit is weekly and arrives as `primary`.
        let usage = super::parse_app_server_usage(&json!({
            "rateLimits": {
                "planType": "prolite",
                "primary": { "usedPercent": 92, "windowDurationMins": 10_080, "resetsAt": 1_790_403_968 },
                "secondary": null
            }
        }))
        .expect("usage should parse");

        assert_eq!(usage.primary.window_minutes, 0);
        assert_eq!(usage.primary.used_percent, 0.0);
        assert_eq!(usage.secondary.used_percent, 92.0);
        assert_eq!(usage.secondary.window_minutes, 10_080);
        assert_eq!(usage.secondary.resets_at_ms, 1_790_403_968_000.0);
    }

    #[test]
    fn wham_weekly_only_plan_reports_its_window_as_weekly() {
        let usage = super::parse_wham_usage(
            &json!({
                "plan_type": "prolite",
                "rate_limit": {
                    "primary_window": { "used_percent": 92, "limit_window_seconds": 604_800, "reset_at": 1_790_403_968 },
                    "secondary_window": null
                }
            }),
            None,
        )
        .expect("usage should parse");

        assert_eq!(usage.primary.window_minutes, 0);
        assert_eq!(usage.secondary.used_percent, 92.0);
        assert_eq!(usage.secondary.window_minutes, 10_080);
    }

    #[test]
    fn wham_reset_credit_details_come_from_their_endpoint() {
        // `/wham/usage` only counts the credits; the dedicated endpoint lists them.
        let usage = super::parse_wham_usage(
            &json!({
                "plan_type": "pro",
                "rate_limit": { "primary_window": null, "secondary_window": null },
                "rate_limit_reset_credits": { "available_count": 1, "applicable_available_count": 1 }
            }),
            Some(&json!({
                "available_count": 1,
                "total_earned_count": 1,
                "credits": [{
                    "id": "c1", "reset_type": "full", "status": "available",
                    "expires_at": "2026-10-04T01:14:53Z", "title": "Full reset", "description": "Refills your limits"
                }]
            })),
        )
        .expect("usage should parse");

        assert_eq!(usage.reset_credits, 1);
        assert_eq!(usage.reset_credit_items.len(), 1);
        assert_eq!(usage.reset_credit_items[0].title, "Full reset");
        assert_eq!(
            usage.reset_credit_items[0].expires_at_ms,
            1_791_076_493_000.0
        );
    }

    #[test]
    fn wham_usage_without_rate_limit_is_an_error() {
        assert!(
            super::parse_wham_usage(&json!({ "plan_type": "free", "rate_limit": null }), None)
                .is_err()
        );
    }

    #[test]
    fn app_server_reset_credits_keep_camel_case_shape() {
        let (count, items) = super::parse_reset_credits(Some(&json!({
            "availableCount": 1,
            "credits": [{ "id": "c1", "status": "available", "expiresAt": 1_700_000_000 }]
        })));

        assert_eq!(count, 1);
        assert_eq!(items[0].expires_at_ms, 1_700_000_000_000.0);
        assert_eq!(items[0].title, "");
    }

    #[test]
    fn oauth_credentials_come_only_from_chatgpt_logins() {
        let login = json!({ "tokens": { "access_token": " at ", "account_id": "acc", "refresh_token": "rt" } });
        assert_eq!(
            super::oauth_credentials(&login),
            Some(("at".to_string(), Some("acc".to_string())))
        );

        let api_key = json!({ "OPENAI_API_KEY": "sk-test", "tokens": null });
        assert_eq!(super::oauth_credentials(&api_key), None);
        assert_eq!(
            super::oauth_credentials(&json!({ "tokens": { "access_token": "" } })),
            None
        );
    }

    fn token_count(timestamp: &str, rate_limits: serde_json::Value) -> String {
        json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": { "type": "token_count", "info": null, "rate_limits": rate_limits }
        })
        .to_string()
    }

    #[test]
    fn reads_the_rate_limits_codex_records_in_a_rollout() {
        let line = token_count(
            "2026-10-19T20:29:15.781Z",
            json!({
                "limit_id": "codex",
                "primary": { "used_percent": 36, "window_minutes": 300, "resets_at": 1_792_452_840 },
                "secondary": { "used_percent": 14, "window_minutes": 10_080, "resets_at": 1_792_922_635 },
                "plan_type": "plus",
                "rate_limit_reached_type": null
            }),
        );
        let reading = super::parse_rollout_line(&line).expect("reading");
        assert_eq!(reading.at_ms, 1_792_441_755_781.0);
        assert_eq!(reading.usage.primary.used_percent, 36.0);
        assert_eq!(reading.usage.primary.window_minutes, 300);
        assert_eq!(reading.usage.primary.resets_at_ms, 1_792_452_840_000.0);
        assert_eq!(reading.usage.secondary.window_minutes, 10_080);
        assert_eq!(reading.usage.plan, "plus");
        assert!(!reading.usage.rate_limited);
    }

    #[test]
    fn rollout_reading_tolerates_a_missing_window_and_flags_a_reached_limit() {
        let line = token_count(
            "2026-10-19T20:29:15Z",
            json!({
                "primary": null,
                "secondary": { "used_percent": 100, "window_minutes": 10_080, "resets_at": 1_792_922_635 },
                "rate_limit_reached_type": "secondary"
            }),
        );
        let reading = super::parse_rollout_line(&line).expect("reading");
        assert_eq!(reading.usage.primary.window_minutes, 0);
        assert_eq!(reading.usage.secondary.used_percent, 100.0);
        assert!(reading.usage.rate_limited);
        assert_eq!(reading.usage.plan, "");
    }

    #[test]
    fn rollout_lines_without_codex_limits_are_ignored() {
        let other_limit = token_count(
            "2026-10-19T20:29:15Z",
            json!({ "limit_id": "code_review", "primary": { "used_percent": 5 } }),
        );
        assert!(super::parse_rollout_line(&other_limit).is_none());
        assert!(super::parse_rollout_line(&token_count("2026-10-19T20:29:15Z", json!(null))).is_none());
        let message = json!({
            "timestamp": "2026-10-19T20:29:15Z",
            "type": "response_item",
            "payload": { "type": "message", "content": "token_count" }
        });
        assert!(super::parse_rollout_line(&message.to_string()).is_none());
    }

    #[test]
    fn newest_rollout_reading_is_found_past_long_lines() {
        let dir = std::env::temp_dir().join(format!("onetho-rollout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-test.jsonl");
        let reading = |percent: u32, at: &str| {
            token_count(
                at,
                json!({ "primary": { "used_percent": percent, "window_minutes": 300, "resets_at": 1 } }),
            )
        };
        // The newest reading sits behind a line longer than the first tail read.
        let long_line = json!({ "type": "response_item", "payload": { "text": "x".repeat(300 * 1024) } });
        let body = [
            reading(10, "2026-10-19T20:00:00Z"),
            reading(20, "2026-10-19T20:10:00Z"),
            long_line.to_string(),
        ]
        .join("\n");
        std::fs::write(&path, body).unwrap();

        let found = super::rollout_usage(&path).expect("reading");
        assert_eq!(found.usage.primary.used_percent, 20.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_a_newer_session_reading_replaces_the_held_one() {
        let line = |at: &str| {
            super::parse_rollout_line(&token_count(at, json!({ "primary": { "used_percent": 1 } })))
                .expect("reading")
        };
        let newer = line("2030-01-01T00:00:10Z");
        let older = line("2030-01-01T00:00:05Z");
        assert!(super::offer_session_usage(&newer));
        assert!(!super::offer_session_usage(&older));
        assert!(!super::offer_session_usage(&newer));
    }
}
