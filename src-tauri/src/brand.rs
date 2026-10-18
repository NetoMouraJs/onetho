//! Fork identity. Onetho is a fork of Alethe (Kauã Miguel, AGPL-3.0-or-later); the
//! Alethe trademark is not licensed by the AGPL (see TRADEMARK.md), so what the user
//! sees goes through here. Internal identifiers (`ALETHE_*`, `.alethe/`, the
//! `alethe_*` MCP tools) stay as they are to keep upstream merges cheap.
//!
//! Mirrors `src/lib/brand.ts` and the `identifier` in `tauri.conf.json`; keep them in sync.

// Some uses are platform-specific (`cfg(windows)`, `debug_assertions`).
#![allow(dead_code)]

pub const NAME: &str = "Onetho";
pub const COMMAND: &str = "onetho";
pub const IDENTIFIER: &str = "com.netomoura.onetho";
