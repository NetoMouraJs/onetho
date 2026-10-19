// Best-effort: a missing session directory is retried, since the CLI creates it on first use.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::codex_sessions::{collect_jsonl_files, parse_codex_session};

const WATCH_RETRY: Duration = Duration::from_secs(30);
/// Codex appends to a rollout many times per turn; its usage is read once the burst settles.
const USAGE_SETTLE: Duration = Duration::from_millis(750);

fn watch_dir(watcher: &mut RecommendedWatcher, dir: &Option<PathBuf>) -> bool {
    dir.as_ref()
        .is_some_and(|p| p.is_dir() && watcher.watch(p, RecursiveMode::Recursive).is_ok())
}

fn announce_codex_rollout(app: &AppHandle, announced: &mut HashSet<PathBuf>, path: &Path) {
    if announced.contains(path) {
        return;
    }
    // The first line can still be half written; the next modify event retries it.
    let Some(session) = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| parse_codex_session(path, &metadata))
    else {
        return;
    };
    announced.insert(path.to_path_buf());
    let _ = app.emit(
        "session://new",
        serde_json::json!({
            "agent": "codex",
            "session": {
                "id": session.id,
                "cwd": session.cwd,
                "source": session.source,
                "started_at": session.started_at,
            }
        }),
    );
}

/// Pushes the usage Codex just recorded, so the app does not have to ask the API for it.
fn push_codex_usage(app: &AppHandle, paths: &mut HashSet<PathBuf>) {
    for path in paths.drain() {
        if let Some(reading) = crate::codex_usage::rollout_usage(&path) {
            if crate::codex_usage::offer_session_usage(&reading) {
                let _ = app.emit("usage://codex", reading);
            }
        }
    }
}

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[session_watcher] falha criando watcher: {e}");
                return;
            }
        };

        let claude = crate::claude_sessions::claude_projects_dir();
        let codex = crate::codex_sessions::codex_sessions_dir();
        if claude.is_none() && codex.is_none() {
            eprintln!("[session_watcher] nenhum dir de sessão pra observar");
            return;
        }

        let mut announced_codex: HashSet<PathBuf> = HashSet::new();
        let mut watching_claude = watch_dir(&mut watcher, &claude);
        let mut watching_codex = watch_dir(&mut watcher, &codex);
        if let (true, Some(dir)) = (watching_codex, &codex) {
            let mut existing = Vec::new();
            collect_jsonl_files(dir, &mut existing);
            announced_codex.extend(existing);
        }
        eprintln!("[session_watcher] observando sessões");

        let mut next_retry = Instant::now() + WATCH_RETRY;
        let mut usage_paths: HashSet<PathBuf> = HashSet::new();
        let mut usage_due: Option<Instant> = None;
        loop {
            if usage_due.is_some_and(|due| Instant::now() >= due) {
                usage_due = None;
                push_codex_usage(&app, &mut usage_paths);
            }
            if Instant::now() >= next_retry {
                next_retry = Instant::now() + WATCH_RETRY;
                watching_claude = watching_claude || watch_dir(&mut watcher, &claude);
                if !watching_codex && watch_dir(&mut watcher, &codex) {
                    watching_codex = true;
                    // Rollouts written before the watch attached were all created this run.
                    let mut created = Vec::new();
                    if let Some(dir) = &codex {
                        collect_jsonl_files(dir, &mut created);
                    }
                    for path in created {
                        announce_codex_rollout(&app, &mut announced_codex, &path);
                    }
                }
            }
            let all_watched =
                (watching_claude || claude.is_none()) && (watching_codex || codex.is_none());
            let wake = match (all_watched, usage_due) {
                (true, None) => None,
                (true, Some(due)) => Some(due),
                (false, None) => Some(next_retry),
                (false, Some(due)) => Some(due.min(next_retry)),
            };
            let received = match wake {
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
            };
            let event = match received {
                Ok(Ok(event)) => event,
                Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            for path in event.paths {
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                if claude.as_ref().is_some_and(|c| path.starts_with(c)) {
                    let _ = app.emit("session://new", serde_json::json!({ "agent": "claude" }));
                } else if codex.as_ref().is_some_and(|c| path.starts_with(c)) {
                    announce_codex_rollout(&app, &mut announced_codex, &path);
                    usage_due.get_or_insert_with(|| Instant::now() + USAGE_SETTLE);
                    usage_paths.insert(path);
                }
            }
        }
    });
}
