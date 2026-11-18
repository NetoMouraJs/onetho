use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const DEV_RUNTIMES: &[&str] = &[
    "node", "bun", "deno", "python", "python3", "pythonw", "uv", "bash", "sh", "cmd", "pwsh",
    "powershell", "java", "ruby", "php", "dotnet", "cargo", "go", "adb", "codex", "claude",
    "opencode", "esbuild",
];

const MIN_UPTIME_SECS: u64 = 60;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverProcess {
    pub pid: u32,
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_secs: u64,
    pub uptime_secs: u64,
    pub memory_mb: f64,
    pub process_count: usize,
}

#[derive(Clone, Copy)]
struct ProcessFacts {
    parent: Option<u32>,
    start_time: u64,
}

fn runtime_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

fn is_dev_runtime(name: &str) -> bool {
    DEV_RUNTIMES.contains(&runtime_name(name).as_str())
}

fn is_managed_daemon(name: &str, command: &str) -> bool {
    match runtime_name(name).as_str() {
        "claude" => command.contains(" daemon"),
        "codex" => command.contains(" app-server"),
        _ => false,
    }
}

fn is_orphan(pid: u32, facts: &HashMap<u32, ProcessFacts>) -> bool {
    let Some(own) = facts.get(&pid) else {
        return false;
    };
    let Some(parent) = own.parent else {
        return false;
    };
    // PIDs are recycled: a parent younger than its child is a different process.
    match facts.get(&parent) {
        Some(parent_facts) => parent_facts.start_time > own.start_time,
        None => true,
    }
}

fn subtree(root: u32, children: &HashMap<u32, Vec<u32>>) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut stack = vec![root];
    let mut ordered = Vec::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        ordered.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    ordered
}

fn refreshed_system() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet)
            .with_user(UpdateKind::OnlyIfNotSet),
    );
    system
}

fn scan(system: &System) -> (Vec<LeftoverProcess>, HashMap<u32, Vec<u32>>) {
    let own_user = system
        .process(Pid::from_u32(std::process::id()))
        .and_then(|process| process.user_id().cloned());

    let mut facts = HashMap::new();
    for (pid, process) in system.processes() {
        if process.thread_kind().is_some() {
            continue;
        }
        facts.insert(
            pid.as_u32(),
            ProcessFacts {
                parent: process.parent().map(|parent| parent.as_u32()),
                start_time: process.start_time(),
            },
        );
    }
    let mut live_children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, own) in &facts {
        if let Some(parent) = own.parent {
            if !is_orphan(pid, &facts) {
                live_children.entry(parent).or_default().push(pid);
            }
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let mut leftovers = Vec::new();
    for (pid, process) in system.processes() {
        let pid = pid.as_u32();
        if process.thread_kind().is_some() || pid == std::process::id() {
            continue;
        }
        let name = process.name().to_string_lossy().into_owned();
        if !is_dev_runtime(&name) || !is_orphan(pid, &facts) {
            continue;
        }
        if now.saturating_sub(process.start_time()) < MIN_UPTIME_SECS {
            continue;
        }
        if own_user.is_some() && process.user_id() != own_user.as_ref() {
            continue;
        }
        let tree = subtree(pid, &live_children);
        let command = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        if is_managed_daemon(&name, &command) {
            continue;
        }
        let memory_bytes: u64 = tree
            .iter()
            .filter_map(|member| {
                system.process(Pid::from_u32(*member)).map(|process| {
                    crate::resources::process_private_commit_bytes(*member, process.memory())
                })
            })
            .sum();
        leftovers.push(LeftoverProcess {
            pid,
            name,
            command,
            cwd: process.cwd().map(|cwd| cwd.display().to_string()),
            started_at_secs: process.start_time(),
            uptime_secs: now.saturating_sub(process.start_time()),
            memory_mb: memory_bytes as f64 / 1024.0 / 1024.0,
            process_count: tree.len(),
        });
    }
    leftovers.sort_by(|a, b| b.memory_mb.total_cmp(&a.memory_mb));
    (leftovers, live_children)
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/F", "/PID", &pid.to_string()]);
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        crate::git_control::hide_console(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        if let Ok(pid) = i32::try_from(pid) {
            if pid > 1 {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
}

#[tauri::command]
pub async fn list_leftover_processes() -> Result<Vec<LeftoverProcess>, String> {
    tokio::task::spawn_blocking(|| scan(&refreshed_system()).0)
        .await
        .map_err(|error| format!("list_leftover_processes: {error}"))
}

#[tauri::command]
pub async fn kill_leftover_process(pid: u32, started_at_secs: u64) -> Result<Vec<u32>, String> {
    tokio::task::spawn_blocking(move || {
        let system = refreshed_system();
        let (leftovers, children) = scan(&system);
        let target = leftovers
            .iter()
            .find(|leftover| leftover.pid == pid && leftover.started_at_secs == started_at_secs)
            .ok_or_else(|| format!("Process {pid} is no longer a leftover"))?;
        let mut tree = subtree(target.pid, &children);
        tree.reverse();
        for member in &tree {
            kill_pid(*member);
        }
        std::thread::sleep(Duration::from_millis(150));
        Ok(tree)
    })
    .await
    .map_err(|error| format!("kill_leftover_process: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(entries: &[(u32, Option<u32>, u64)]) -> HashMap<u32, ProcessFacts> {
        entries
            .iter()
            .map(|&(pid, parent, start_time)| (pid, ProcessFacts { parent, start_time }))
            .collect()
    }

    #[test]
    fn a_process_whose_parent_exited_is_an_orphan() {
        let table = facts(&[(10, Some(5), 100)]);
        assert!(is_orphan(10, &table));
    }

    #[test]
    fn a_living_older_parent_keeps_the_child_owned() {
        let table = facts(&[(5, None, 50), (10, Some(5), 100)]);
        assert!(!is_orphan(10, &table));
    }

    #[test]
    fn a_recycled_parent_pid_does_not_adopt_the_child() {
        let table = facts(&[(5, None, 200), (10, Some(5), 100)]);
        assert!(is_orphan(10, &table));
    }

    #[test]
    fn root_processes_without_a_parent_are_ignored() {
        let table = facts(&[(10, None, 100)]);
        assert!(!is_orphan(10, &table));
    }

    #[test]
    fn dev_runtimes_match_with_or_without_extension() {
        assert!(is_dev_runtime("node.exe"));
        assert!(is_dev_runtime("Python"));
        assert!(!is_dev_runtime("explorer.exe"));
        assert!(!is_dev_runtime("firefox.exe"));
    }

    #[test]
    fn agent_daemons_are_not_leftovers() {
        assert!(is_managed_daemon("claude.exe", "claude.exe daemon run --origin transcript"));
        assert!(is_managed_daemon("codex.exe", "codex.exe app-server --listen"));
        assert!(!is_managed_daemon("claude.exe", "claude.exe --resume"));
        assert!(!is_managed_daemon("node.exe", "node server.js daemon"));
    }

    #[test]
    fn subtree_walks_every_descendant_once() {
        let children = HashMap::from([(1, vec![2, 3]), (2, vec![4]), (4, vec![2])]);
        let mut tree = subtree(1, &children);
        tree.sort();
        assert_eq!(tree, vec![1, 2, 3, 4]);
    }
}
