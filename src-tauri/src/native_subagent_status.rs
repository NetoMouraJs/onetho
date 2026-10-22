use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Transcript paths already found, keyed by agent id, so each poll skips the directory scan.
static TRANSCRIPTS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn cached_transcript(agent_id: &str, find: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let paths = TRANSCRIPTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(path) = paths
        .lock()
        .ok()?
        .get(agent_id)
        .filter(|path| path.is_file())
    {
        return Some(path.clone());
    }
    let path = find()?;
    paths
        .lock()
        .ok()?
        .insert(agent_id.to_string(), path.clone());
    Some(path)
}

fn claude_transcript(session_id: &str, agent_id: &str) -> Option<PathBuf> {
    let root = crate::claude_sessions::claude_projects_dir()?;
    for project in std::fs::read_dir(root).ok()?.flatten() {
        let path = project
            .path()
            .join(session_id)
            .join("subagents")
            .join(format!("agent-{agent_id}.jsonl"));
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Claude Code marks `finished` in the `agent-<id>.meta.json` written next to the transcript.
fn claude_meta_finished(transcript: &Path, started_at_ms: i64) -> bool {
    let meta = transcript.with_extension("meta.json");
    let fresh = std::fs::metadata(&meta)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|elapsed| elapsed.as_millis() as i64 >= started_at_ms.saturating_sub(2_000));
    fresh
        && std::fs::read_to_string(&meta)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|value| value["finished"] == true)
}

fn last_record(path: &Path) -> Option<serde_json::Value> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    for tail in [256 * 1024_u64, 4 * 1024 * 1024] {
        let start = len.saturating_sub(tail);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.by_ref().take(tail).read_to_end(&mut bytes).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        if let Some(record) = text
            .lines()
            .skip(usize::from(start > 0))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .find(|line| !line.trim().is_empty())
            .and_then(|line| serde_json::from_str(line).ok())
        {
            return Some(record);
        }
        if start == 0 {
            break;
        }
    }
    None
}

fn completed_from_record(record: &serde_json::Value, agent: &str, started_at_ms: i64) -> bool {
    let Some(at) = record
        .get("timestamp")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    else {
        return false;
    };
    if at.timestamp_millis() < started_at_ms.saturating_sub(2_000) {
        return false;
    }
    match agent {
        "codex" => record["type"] == "event_msg" && record["payload"]["type"] == "task_complete",
        // The result of the tool that hands control back to the parent (`SubagentHandback`).
        // `end_turn` is not used: it also shows up mid-run before the handback.
        "claude" => record["type"] == "user" && record["toolEndsTurn"] == true,
        _ => false,
    }
}

fn completed(agent: &str, agent_id: &str, session_id: Option<&str>, started_at_ms: i64) -> bool {
    if !valid_id(agent_id) || started_at_ms <= 0 {
        return false;
    }
    let path = match agent {
        "codex" => cached_transcript(agent_id, || {
            crate::codex_sessions::find_codex_session_file(agent_id)
        }),
        "claude" => session_id.filter(|id| valid_id(id)).and_then(|id| {
            cached_transcript(agent_id, || claude_transcript(id, agent_id))
        }),
        _ => None,
    };
    let Some(path) = path else {
        return false;
    };
    (agent == "claude" && claude_meta_finished(&path, started_at_ms))
        || last_record(&path)
            .is_some_and(|record| completed_from_record(&record, agent, started_at_ms))
}

/// Reconciles a missed SubagentStop only when the provider's local transcript ended this turn.
#[tauri::command]
pub async fn native_subagent_completed(
    agent: String,
    agent_id: String,
    session_id: Option<String>,
    started_at_ms: i64,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        completed(&agent, &agent_id, session_id.as_deref(), started_at_ms)
    })
    .await
    .map_err(|error| format!("native_subagent_completed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{claude_meta_finished, completed_from_record, last_record};
    use serde_json::json;

    #[test]
    fn accepts_only_a_final_record_after_the_subagent_started() {
        let codex = json!({"timestamp":"2026-10-20T20:22:10Z","type":"event_msg","payload":{"type":"task_complete"}});
        let claude = json!({"timestamp":"2026-10-20T20:22:10Z","type":"user","toolEndsTurn":true});
        let started = chrono::DateTime::parse_from_rfc3339("2026-10-20T20:20:00Z")
            .unwrap()
            .timestamp_millis();
        assert!(completed_from_record(&codex, "codex", started));
        assert!(completed_from_record(&claude, "claude", started));
        assert!(!completed_from_record(&codex, "codex", started + 300_000));
        assert!(!completed_from_record(&claude, "claude", started + 300_000));
        assert!(!completed_from_record(
            &json!({"type":"event_msg","payload":{"type":"token_count"}}),
            "codex",
            started
        ));
        assert!(!completed_from_record(
            &json!({"timestamp":"2026-10-20T20:22:10Z","type":"assistant","message":{"stop_reason":"end_turn"}}),
            "claude",
            started
        ));
        assert!(!completed_from_record(
            &json!({"timestamp":"2026-10-20T20:22:10Z","type":"user","message":{"content":[]}}),
            "claude",
            started
        ));
    }

    #[test]
    fn reads_the_latest_record_without_exposing_transcript_text() {
        let path = std::env::temp_dir().join(format!(
            "onetho-subagent-status-{}.jsonl",
            nanoid::nanoid!(8)
        ));
        std::fs::write(&path, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n").unwrap();
        assert_eq!(
            last_record(&path).unwrap()["payload"]["type"],
            "task_started"
        );
        std::fs::write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n{broken\n",
        )
        .unwrap();
        assert!(last_record(&path).is_none());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn claude_meta_closes_only_when_finished() {
        let dir = std::env::temp_dir().join(format!("onetho-subagent-meta-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let transcript = dir.join("agent-a4d7766eff983fb69.jsonl");
        let meta = dir.join("agent-a4d7766eff983fb69.meta.json");
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(!claude_meta_finished(&transcript, started));
        std::fs::write(&meta, "{\"agentType\":\"Explore\"}").unwrap();
        assert!(!claude_meta_finished(&transcript, started));
        std::fs::write(&meta, "{broken").unwrap();
        assert!(!claude_meta_finished(&transcript, started));
        std::fs::write(&meta, "{\"agentType\":\"Explore\",\"finished\":true}").unwrap();
        assert!(claude_meta_finished(&transcript, started));
        assert!(!claude_meta_finished(&transcript, started + 300_000));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
