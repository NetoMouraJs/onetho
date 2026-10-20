//! `statusline-bridge`: the status line command Onetho sets for the Claude terminals it starts.
//! Claude Code passes its status JSON, rate limits included, to that command on stdin. The bridge
//! hands it to the local listener and, when the person has a status line of their own, echoes it
//! down the pipe to their command, so what they see does not change.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const SUBCOMMAND: &str = "statusline-bridge";
const INPUT_LIMIT: u64 = 1024 * 1024;
const LISTENER_TIMEOUT: Duration = Duration::from_millis(300);

/// Runs the bridge when the process was started as one, before anything of the app starts.
pub fn run_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(SUBCOMMAND) {
        return None;
    }
    let flag = |name: &str| {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };

    let mut input = Vec::new();
    let _ = std::io::stdin().take(INPUT_LIMIT).read_to_end(&mut input);
    if let (Some(port), Some(token)) = (flag("--port").and_then(|p| p.parse().ok()), flag("--token")) {
        post(port, &token, &input);
    }
    if args.iter().any(|arg| arg == "--echo") {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(&input).and_then(|()| stdout.flush());
    }
    Some(0)
}

fn post(port: u16, token: &str, body: &[u8]) {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, LISTENER_TIMEOUT) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(LISTENER_TIMEOUT));
    let _ = stream.set_read_timeout(Some(LISTENER_TIMEOUT));
    let head = format!(
        "POST /usage/claude HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Alethe-Token: {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body)).is_ok() {
        // Waits for the answer, so the listener has the whole body before the connection drops.
        let mut answer = [0_u8; 64];
        let _ = stream.read(&mut answer);
    }
}

/// The person's own status line command, unless it is not a command or is already the bridge.
fn own_command(status_line: &serde_json::Value) -> Option<&str> {
    if status_line.get("type").and_then(|v| v.as_str()) != Some("command") {
        return None;
    }
    let command = status_line.get("command")?.as_str()?.trim();
    (!command.is_empty() && !command.contains(SUBCOMMAND)).then_some(command)
}

/// The status line the person set in `~/.claude/settings.json`.
fn own_status_line() -> Option<serde_json::Value> {
    let path = dirs_next::home_dir()?.join(".claude").join("settings.json");
    let settings: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    settings.get("statusLine").cloned()
}

fn setting_for(exe: &str, port: u16, token: &str, own: Option<&serde_json::Value>) -> serde_json::Value {
    let bridge = format!("\"{exe}\" {SUBCOMMAND} --port {port} --token {token}");
    let command = match own.and_then(own_command) {
        Some(theirs) => format!("{bridge} --echo | {theirs}"),
        None => bridge,
    };
    let mut setting = serde_json::json!({ "type": "command", "command": command });
    if let Some(padding) = own.filter(|own| own_command(own).is_some()).and_then(|own| own.get("padding")) {
        setting["padding"] = padding.clone();
    }
    setting
}

/// The `statusLine` setting for a Claude terminal: the bridge, piped into the person's own
/// status line command when they have one, keeping its padding.
pub fn status_line_setting(port: u16, token: &str) -> Option<serde_json::Value> {
    let exe = crate::cli_launch::strip_verbatim_prefix(std::env::current_exe().ok()?);
    // Forward slashes read the same in Git Bash, sh and cmd.
    let exe = exe.to_string_lossy().replace('\\', "/");
    Some(setting_for(&exe, port, token, own_status_line().as_ref()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    const EXE: &str = "C:/Users/me/AppData/Local/Onetho/alethe.exe";

    #[test]
    fn pipes_the_bridge_into_the_persons_own_status_line() {
        let own = json!({ "type": "command", "command": " bash ~/.claude/statusline-command.sh ", "padding": 1 });
        let setting = super::setting_for(EXE, 9123, "tok", Some(&own));
        assert_eq!(
            setting["command"],
            "\"C:/Users/me/AppData/Local/Onetho/alethe.exe\" statusline-bridge --port 9123 --token tok \
             --echo | bash ~/.claude/statusline-command.sh"
        );
        assert_eq!(setting["padding"], 1);
    }

    #[test]
    fn without_a_status_line_of_their_own_the_bridge_prints_nothing() {
        let setting = super::setting_for(EXE, 9123, "tok", None);
        assert_eq!(
            setting["command"],
            "\"C:/Users/me/AppData/Local/Onetho/alethe.exe\" statusline-bridge --port 9123 --token tok"
        );
        assert!(setting.get("padding").is_none());
    }

    #[test]
    fn never_chains_into_itself_or_a_status_line_that_is_not_a_command() {
        let bridge = json!({ "type": "command", "command": "alethe.exe statusline-bridge --port 1" });
        let static_text = json!({ "type": "static", "command": "echo hi", "padding": 2 });
        for own in [bridge, static_text] {
            let setting = super::setting_for(EXE, 9123, "tok", Some(&own));
            assert!(!setting["command"].as_str().unwrap().contains("--echo"));
            assert!(setting.get("padding").is_none());
        }
    }
}
