use chrono::{Duration, Local, NaiveDate};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::claude_sessions::{read_capped_line, truncate_chars};
use crate::provider_common::{file_modified_ms, normalize_cwd, provider_home_dir, provider_scope};

static SESSION_FILE_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn session_file_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    SESSION_FILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
static FIND_SESSION_WALKS: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn reset_codex_session_file_cache() {
    session_file_cache().lock().unwrap().clear();
    FIND_SESSION_WALKS.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn codex_session_find_walk_count() -> usize {
    FIND_SESSION_WALKS.load(Ordering::SeqCst)
}

/// How many calendar days of `sessions/<y>/<m>/<d>/` folders to scan before a full tree walk.
const RECENT_SESSION_DAYS: i64 = 14;

#[derive(Serialize)]
pub struct CodexSessionSnapshot {
    pub id: String,
    pub cwd: String,
    pub modified_at_ms: u128,
    pub size_bytes: u64,
    pub source: Option<String>,
    pub started_at: Option<String>,
}

pub(crate) fn codex_sessions_dir() -> Option<PathBuf> {
    provider_home_dir(&[".codex", "sessions"])
}

pub(crate) fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

struct CodexSessionMeta {
    id: String,
    cwd: String,
    source: Option<String>,
    started_at: Option<String>,
}

fn parse_session_meta(first_line: &str) -> Option<CodexSessionMeta> {
    let value = serde_json::from_str::<serde_json::Value>(first_line).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    Some(CodexSessionMeta {
        id: text("id")?,
        cwd: text("cwd")?,
        // Subagent threads carry an object here; only a plain string names a launch surface.
        source: text("source"),
        started_at: text("timestamp"),
    })
}

pub(crate) fn parse_codex_session(
    path: &Path,
    metadata: &fs::Metadata,
) -> Option<CodexSessionSnapshot> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    if first_line.trim().is_empty() {
        return None;
    }

    let meta = parse_session_meta(&first_line)?;
    Some(CodexSessionSnapshot {
        id: meta.id,
        cwd: meta.cwd,
        modified_at_ms: file_modified_ms(metadata),
        size_bytes: metadata.len(),
        source: meta.source,
        started_at: meta.started_at,
    })
}

pub(crate) fn session_meta_id(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&first_line).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")?
        .get("id")?
        .as_str()
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn snapshot_codex_sessions(cwd: String) -> Result<Vec<CodexSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_codex_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_codex_sessions: falha na task bloqueante: {error}"))?
}

fn snapshot_codex_sessions_inner(cwd: String) -> Result<Vec<CodexSessionSnapshot>, String> {
    if normalize_cwd(&cwd).is_empty() {
        return Ok(Vec::new());
    }

    let Some(scope) = provider_scope(&cwd, &[".codex", "sessions"]) else {
        if crate::wsl::wsl_target(&cwd).is_some() {
            return Ok(Vec::new());
        }
        return Err("USERPROFILE/HOME is not set".to_string());
    };
    let target_cwd = scope.match_key();
    if !scope.root.is_dir() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_jsonl_files(&scope.root, &mut files);

    let mut sessions = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    for path in files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Some(session) = parse_codex_session(&path, &metadata) else {
            continue;
        };
        if scope.normalize(&session.cwd) != target_cwd || !seen_ids.insert(session.id.clone()) {
            continue;
        }
        sessions.push(session);
    }

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

/// Codex has no equivalent of Claude's generated `ai-title`, and its session
/// files are laid out under `sessions/<year>/<month>/<day>/`, not per-project
/// like Claude's, so the id can't be turned into a path directly. The file
/// name itself carries the session id as its trailing UUID
/// (`rollout-<timestamp>-<id>.jsonl`), so a filename match avoids opening
/// every file just to find the right one.
fn session_file_suffix(session_id: &str) -> String {
    format!("{session_id}.jsonl")
}

fn path_matches_session_id(path: &Path, suffix: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(suffix))
}

fn match_session_in_dir(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    entries.filter_map(|entry| entry.ok()).find_map(|entry| {
        let path = entry.path();
        if path.is_file() && path_matches_session_id(&path, suffix) {
            Some(path)
        } else {
            None
        }
    })
}

/// Walk only day-level folders for the last [`RECENT_SESSION_DAYS`] before touching older archives.
fn find_session_in_recent_days(root: &Path, session_id: &str) -> Option<PathBuf> {
    let suffix = session_file_suffix(session_id);
    let today = Local::now().date_naive();
    for day_offset in 0..RECENT_SESSION_DAYS {
        let day = today - Duration::days(day_offset);
        if let Some(path) = day_folder_session_file(root, day, &suffix) {
            return Some(path);
        }
    }
    None
}

fn day_folder_session_file(root: &Path, day: NaiveDate, suffix: &str) -> Option<PathBuf> {
    let dir = root
        .join(day.format("%Y").to_string())
        .join(day.format("%m").to_string())
        .join(day.format("%d").to_string());
    if dir.is_dir() {
        match_session_in_dir(&dir, suffix)
    } else {
        None
    }
}

fn find_codex_session_file_walk(root: &Path, session_id: &str) -> Option<PathBuf> {
    #[cfg(test)]
    FIND_SESSION_WALKS.fetch_add(1, Ordering::SeqCst);

    let suffix = session_file_suffix(session_id);
    if let Some(path) = find_session_in_recent_days(root, session_id) {
        return Some(path);
    }
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files);
    files
        .into_iter()
        .find(|path| path_matches_session_id(path, &suffix))
}

/// Locate a session's `.jsonl` file under the given Codex sessions root (for unit tests).
#[cfg(test)]
pub(crate) fn find_codex_session_file_at(root: &Path, session_id: &str) -> Option<PathBuf> {
    find_codex_session_file_with_root(root, session_id)
}

fn find_codex_session_file_with_root(root: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) {
        return None;
    }
    if !root.is_dir() {
        return None;
    }
    if let Ok(mut cache) = session_file_cache().lock() {
        if let Some(path) = cache.get(session_id) {
            if path.is_file() {
                return Some(path.clone());
            }
            cache.remove(session_id);
        }
    }
    find_codex_session_file_walk(root, session_id).map(|path| {
        if let Ok(mut cache) = session_file_cache().lock() {
            cache.insert(session_id.to_string(), path.clone());
        }
        path
    })
}

/// Codex session files live under [`codex_sessions_dir`] (see issue #27 for `CODEX_HOME`).
pub(crate) fn find_codex_session_file(session_id: &str) -> Option<PathBuf> {
    let root = codex_sessions_dir()?;
    find_codex_session_file_with_root(&root, session_id)
}

/// Only the first genuine user turn: the file also carries the framework's
/// own injected messages (permissions/collaboration-mode/environment-context
/// blocks), which are also `role: "user"` but wrapped in `<tag>` prose, so
/// those are skipped in favor of the first line that isn't.
fn codex_first_user_text(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("response_item") {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(|v| v.as_str()) != Some("message")
        || payload.get("role").and_then(|v| v.as_str()) != Some("user")
    {
        return None;
    }
    payload
        .get("content")?
        .as_array()?
        .iter()
        .find_map(|block| {
            let text = block.get("text").and_then(|v| v.as_str())?.trim();
            if text.is_empty() || text.starts_with('<') {
                None
            } else {
                Some(text.to_string())
            }
        })
}

const MAX_TITLE_SCAN_LINES: usize = 200;

fn get_codex_session_title_inner(session_id: String) -> Result<Option<String>, String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) {
        return Ok(None);
    }
    let Some(path) = find_codex_session_file(&session_id) else {
        return Ok(None);
    };
    let Ok(file) = fs::File::open(&path) else {
        return Ok(None);
    };
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut scanned = 0usize;
    while read_capped_line(&mut reader, &mut buf).unwrap_or(false) {
        scanned += 1;
        if scanned > MAX_TITLE_SCAN_LINES {
            break;
        }
        if buf.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        if let Some(text) = codex_first_user_text(line) {
            return Ok(Some(truncate_chars(&text, 240)));
        }
    }
    Ok(None)
}

/// Mirrors `get_claude_session_title`: a pane header only needs the title of
/// the one session it is attached to.
#[tauri::command]
pub async fn get_codex_session_title(session_id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || get_codex_session_title_inner(session_id))
        .await
        .map_err(|error| format!("get_codex_session_title: falha na task bloqueante: {error}"))?
}

#[cfg(test)]
mod session_meta_tests {
    use super::parse_session_meta;

    #[test]
    fn reads_the_launch_surface_and_start_time_of_an_interactive_session() {
        let line = r#"{"timestamp":"2026-10-07T12:00:01.000Z","type":"session_meta","payload":{"id":"abc","timestamp":"2026-10-07T12:00:00.000Z","cwd":"D:\\repo","originator":"codex-tui","source":"cli"}}"#;
        let meta = parse_session_meta(line).expect("session_meta line");

        assert_eq!(meta.id, "abc");
        assert_eq!(meta.cwd, r"D:\repo");
        assert_eq!(meta.source.as_deref(), Some("cli"));
        assert_eq!(meta.started_at.as_deref(), Some("2026-10-07T12:00:00.000Z"));
    }

    #[test]
    fn a_subagent_thread_has_no_launch_surface() {
        let line = r#"{"type":"session_meta","payload":{"id":"abc","cwd":"D:\\repo","originator":"codex-tui","source":{"subagent":{"thread_spawn":{}}}}}"#;
        let meta = parse_session_meta(line).expect("session_meta line");

        assert_eq!(meta.source, None);
        assert_eq!(meta.started_at, None);
    }

    #[test]
    fn rejects_a_line_that_is_not_session_meta() {
        assert!(parse_session_meta(r#"{"type":"event_msg","payload":{}}"#).is_none());
        assert!(parse_session_meta(r#"{"type":"session_meta","payl"#).is_none());
    }
}

#[cfg(test)]
mod find_session_file_tests {
    use super::{
        codex_session_find_walk_count, find_codex_session_file_at, reset_codex_session_file_cache,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn test_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("alethe-codex-find-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_session(root: &Path, year: &str, month: &str, day: &str, session_id: &str) {
        let dir = root.join(year).join(month).join(day);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-01-01-{session_id}.jsonl"));
        fs::write(path, r#"{"type":"session_meta","payload":{"id":"x"}}"#).unwrap();
    }

    #[test]
    fn second_lookup_uses_cache_instead_of_walking_again() {
        reset_codex_session_file_cache();
        let root = test_root("cache-hit");
        let session_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        write_session(&root, "2099", "12", "31", session_id);

        assert!(find_codex_session_file_at(&root, session_id).is_some());
        assert_eq!(codex_session_find_walk_count(), 1);
        assert!(find_codex_session_file_at(&root, session_id).is_some());
        assert_eq!(
            codex_session_find_walk_count(),
            1,
            "a cache hit must not walk the tree again"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deleted_file_invalidates_cache_and_walks_again() {
        reset_codex_session_file_cache();
        let root = test_root("cache-stale");
        let session_id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
        write_session(&root, "2098", "06", "15", session_id);

        let path = find_codex_session_file_at(&root, session_id).unwrap();
        assert_eq!(codex_session_find_walk_count(), 1);
        fs::remove_file(&path).unwrap();
        assert!(
            find_codex_session_file_at(&root, session_id).is_none(),
            "missing file should yield None after cache invalidation"
        );
        assert_eq!(codex_session_find_walk_count(), 2);
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod title_tests {
    use super::codex_first_user_text;

    #[test]
    fn skips_injected_environment_context_and_finds_the_real_prompt() {
        let env_context = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>C:\\Users\\kauam</cwd>\n</environment_context>"}]}}"#;
        let real_prompt = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"oi"}]}}"#;
        assert_eq!(codex_first_user_text(env_context), None);
        assert_eq!(codex_first_user_text(real_prompt).as_deref(), Some("oi"));
    }

    #[test]
    fn ignores_developer_and_assistant_records() {
        let developer = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"some instructions"}]}}"#;
        let assistant = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}"#;
        let other_record = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        assert_eq!(codex_first_user_text(developer), None);
        assert_eq!(codex_first_user_text(assistant), None);
        assert_eq!(codex_first_user_text(other_record), None);
    }
}
