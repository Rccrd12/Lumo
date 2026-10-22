// The user's own tools (the Tools tab). A tool is a folder under
// %APPDATA%\com.rccrd12.lumo\tools\<id>: its script or program, and
// tool.json, which says what it is called, what it does (the words an AI reads
// to know when to use it), its parameters, what it needs (the network, files,
// the system) and whether it is on.
//
// Tools are made in the tool workshop (the chat in its workshop mode,
// src/views/forge.ts): the AI writes a draft, the user tries it and saves it
// with a click. Nothing is saved or run without that click.
//
// The agents get the tools that are on through `lumo-hook --mcp --tools=user`,
// an MCP server Claude Code starts for the island's chat (claude_code.rs). The
// relay asks Lumo for the list (`{"lumo_tools": …}`) and hands each call to Lumo
// (`{"lumo_tool": {"tool": …, "input": …}}`, pipe.rs), which runs it here. The
// chat's API providers call `serve_call` themselves (claude.rs, openai_compat.rs).
//
// Three things stand between an agent and a tool:
//   * the supervisor's review (tool_review.rs): a tool is offered only once a
//     second model read it, and any change to it (a file, its tool.json, the
//     script it runs from elsewhere) asks for a new review (`fingerprint`);
//   * the user's click: every call is an Allow / Deny card on the island
//     (`approve`), unless the user chose to trust that tool, which is only
//     offered when Lumo can hold it to what it declared;
//   * the guard: what the tool said it needs is what it may do. Python runs
//     under tool_guard.py's audit hook, Node under its permission model; the
//     other kinds can't be held to it (`unguarded`), and are never trusted.
//
// A script gets its parameters as JSON on stdin and in LUMO_TOOL_INPUT, or on
// its command line when tool.json gives `args` ("--count", "{count}"); what it
// prints is its answer. It may write in LUMO_TOOL_WORK (and TEMP points there).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::island::WINDOW_LABEL;
use crate::platform;

const MANIFEST: &str = "tool.json";
/// What the workshop's Try runs from: the draft's files, written afresh each time.
const TRYOUT_DIR: &str = "tool-workshop";
pub const PERMISSIONS: &[&str] = &["network", "read", "write", "system"];
pub const PARAM_TYPES: &[&str] = &["string", "number", "integer", "boolean"];
const MAX_FILES: usize = 20;
const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_NAME: usize = 60;
const MAX_DESCRIPTION: usize = 1500;
const MAX_ID: usize = 48;
/// What a run may print that goes back: the rest is cut.
const MAX_OUTPUT: usize = 32 * 1024;
const DEFAULT_TIMEOUT_S: u64 = 120;
const MAX_TIMEOUT_S: u64 = 600;
/// Where a run may write: one folder per tool, under Lumo's local data.
const WORK_DIR: &str = "tool-runs";
/// The guard Python tools run under, written next to Lumo's local data.
const GUARD: &str = include_str!("tool_guard.py");
const GUARD_FILE: &str = "lumo_guard.py";
/// The MCP server name of the tools (claude_code.rs and the terminal's Claude Code).
pub const SERVER: &str = "lumo_tools";
/// How long a click on Claude Code's own card for a tool covers its call.
const ALLOWED_FOR: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    /// One of PARAM_TYPES.
    #[serde(default = "string_type", rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
}

fn string_type() -> String {
    "string".into()
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The file that runs: one of the tool's own, or the full path of a
    /// script the user already had (it runs where it is).
    pub entry: String,
    /// Its command line, `{param}` standing for a parameter's value; empty:
    /// the parameters go as JSON on stdin.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub params: Vec<Param>,
    /// What it says it needs, from PERMISSIONS.
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Seconds a run may take (0: the default).
    #[serde(default)]
    pub timeout: u64,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub updated: u64,
    /// The user chose to let agents run it without a card. Only counts while
    /// `may_trust` says so.
    #[serde(default)]
    pub trust: bool,
    /// The supervisor's last review, of the tool as it was then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<Review>,
}

/// What the supervisor said about a tool (tool_review.rs).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// `fingerprint` of the tool it read: another one means it changed since.
    pub fingerprint: String,
    /// "ok", "caution" or "danger".
    pub verdict: String,
    /// What the tool does, in plain words, in the user's language.
    pub summary: String,
    /// What to know before using it.
    #[serde(default)]
    pub points: Vec<String>,
    /// What the code does that the tool didn't declare, from PERMISSIONS.
    #[serde(default)]
    pub undeclared: Vec<String>,
    /// Which model reviewed it.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub at: u64,
}

/// A tool as the Tools tab shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    #[serde(flatten)]
    pub manifest: Manifest,
    pub dir: String,
    /// Its own files, by name.
    pub files: Vec<String>,
    /// The file that runs isn't there any more.
    pub missing: bool,
    /// The review is of the tool as it is now.
    pub reviewed: bool,
    /// What it didn't declare and Lumo couldn't stop it doing anyway.
    pub unguarded: Vec<String>,
    /// The user may let it run without a card.
    pub may_trust: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftFile {
    pub name: String,
    pub content: String,
}

/// What the workshop hands over to try or to save.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub entry: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub timeout: u64,
    #[serde(default)]
    pub files: Vec<DraftFile>,
    /// The tool this draft changes (the workshop opened from it), if any.
    #[serde(default)]
    pub replaces: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub ok: bool,
    pub output: String,
    pub ms: u64,
}

pub fn tools_dir() -> PathBuf {
    platform::config_dir().join("tools")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ── Names ─────────────────────────────────────────────────────────────────────

/// A tool's id from its name: lower case letters, digits and `_`, as MCP
/// wants a tool's name ("Benchmark del PC" → "benchmark_del_pc").
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(|c| c.to_lowercase()) {
        let c = match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    }
    let mut id: String = out.trim_end_matches('_').chars().take(MAX_ID).collect();
    while id.ends_with('_') {
        id.pop();
    }
    if id.is_empty() {
        "tool".into()
    } else {
        id
    }
}

/// An id Lumo made: what `slug` gives, never a path.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A file name of the tool's own folder: no folders, nothing hidden, no `..`.
fn valid_file_name(name: &str) -> bool {
    let reserved = ["con", "prn", "aux", "nul", "com1", "lpt1"];
    !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && name != MANIFEST
        && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
        && !reserved.contains(&name.split('.').next().unwrap_or("").to_ascii_lowercase().as_str())
}

fn valid_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 40
}

// ── Reading ───────────────────────────────────────────────────────────────────

fn read_manifest(dir: &Path) -> Option<Manifest> {
    let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
    let m: Manifest = serde_json::from_str(&text).ok()?;
    // The folder's name is the id: a tool.json copied elsewhere says the old one.
    let id = dir.file_name()?.to_str()?.to_string();
    valid_id(&id).then(|| Manifest { id, ..m })
}

fn entry_path(dir: &Path, entry: &str) -> PathBuf {
    let p = Path::new(entry);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        dir.join(entry)
    }
}

/// A tool's own files, by name: everything in its folder but tool.json.
fn own_files(dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .filter(|n| n != MANIFEST)
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn info(dir: &Path, manifest: Manifest) -> ToolInfo {
    let files = own_files(dir);
    let path = entry_path(dir, &manifest.entry);
    let missing = !path.is_file();
    let reviewed = manifest.review.as_ref().is_some_and(|r| r.fingerprint == fingerprint(dir, &manifest));
    let unguarded = unguarded(&path, &manifest.permissions);
    let may_trust = reviewed
        && unguarded.is_empty()
        && manifest.review.as_ref().is_some_and(|r| r.verdict != "danger" && r.undeclared.is_empty());
    ToolInfo { manifest, dir: dir.to_string_lossy().to_string(), files, missing, reviewed, unguarded, may_trust }
}

// ── What was reviewed ─────────────────────────────────────────────────────────

/// FNV-1a over `bytes`: to tell a changed tool from the one reviewed.
fn fnv(hash: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *hash ^= u64::from(*b);
        *hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
}

/// The tool as the supervisor reads it: its tool.json (but whether it is on,
/// trusted or reviewed), every file of its folder, and the script it runs from
/// elsewhere (by size and time: it can be a big program). Any change to one of
/// them is another fingerprint, and the review no longer counts.
pub fn fingerprint(dir: &Path, m: &Manifest) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let what = json!([m.name, m.description, m.entry, m.args, m.params, m.permissions, m.timeout]).to_string();
    fnv(&mut h, what.as_bytes());
    for name in own_files(dir) {
        fnv(&mut h, name.as_bytes());
        let bytes = std::fs::read(dir.join(&name)).unwrap_or_default();
        fnv(&mut h, &(bytes.len() as u64).to_le_bytes());
        fnv(&mut h, &bytes);
    }
    let entry = Path::new(&m.entry);
    if entry.is_absolute() {
        if let Ok(meta) = std::fs::metadata(entry) {
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            fnv(&mut h, &meta.len().to_le_bytes());
            fnv(&mut h, &modified.to_le_bytes());
        }
    }
    format!("{h:016x}")
}

// ── What Lumo can hold a tool to ──────────────────────────────────────────────

/// The major version of the Node.js on PATH (0: none), asked once.
fn node_major() -> u32 {
    static MAJOR: OnceLock<u32> = OnceLock::new();
    *MAJOR.get_or_init(|| {
        let Some(node) = platform::find_on_path("node") else { return 0 };
        let mut cmd = Command::new(node);
        cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
        platform::no_console(&mut cmd);
        cmd.output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|v| v.trim().trim_start_matches('v').split('.').next().and_then(|n| n.parse().ok()))
            .unwrap_or(0)
    })
}

/// The kind of file `path` is, by its extension.
fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// What a tool that runs `path` didn't declare and Lumo couldn't stop it doing
/// anyway: nothing for Python (tool_guard.py), the network for Node (its
/// permission model has files and programs only), everything for the rest.
pub fn unguarded(path: &Path, declared: &[String]) -> Vec<String> {
    let undeclared = PERMISSIONS.iter().filter(|p| !declared.iter().any(|d| d == *p)).map(|p| p.to_string());
    match extension(path).as_str() {
        "py" | "pyw" => Vec::new(),
        "js" | "mjs" | "cjs" if node_major() >= 20 => undeclared.filter(|p| p == "network").collect(),
        _ => undeclared.collect(),
    }
}

/// Every tool, by name.
pub fn list() -> Vec<ToolInfo> {
    let root = tools_dir();
    let Ok(rd) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut all: Vec<ToolInfo> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|dir| read_manifest(&dir).map(|m| info(&dir, m)))
        .collect();
    all.sort_by_key(|t| t.manifest.name.to_lowercase());
    all
}

fn find(id: &str) -> Option<(PathBuf, Manifest)> {
    if !valid_id(id) {
        return None;
    }
    let dir = tools_dir().join(id);
    read_manifest(&dir).map(|m| (dir, m))
}

/// Whether any tool is on: only then does the chat get the tools' MCP server.
pub fn any_enabled() -> bool {
    list().iter().any(|t| t.manifest.enabled && !t.missing)
}

// ── Saving ────────────────────────────────────────────────────────────────────

/// The draft, checked and tidied: what a save or a try works from.
fn checked(draft: &Draft) -> Result<Draft, String> {
    let name = draft.name.trim().chars().take(MAX_NAME).collect::<String>();
    if name.is_empty() {
        return Err(t("The tool has no name yet."));
    }
    let description = draft.description.trim().chars().take(MAX_DESCRIPTION).collect::<String>();
    if draft.files.len() > MAX_FILES {
        return Err(t("The tool has too many files."));
    }
    let mut files = Vec::new();
    for f in &draft.files {
        let file = f.name.trim();
        if !valid_file_name(file) {
            return Err(tf("Lumo can't save a file called {name}.", &[("name", file)]));
        }
        if f.content.len() > MAX_FILE_BYTES {
            return Err(tf("{name} is too big for a tool.", &[("name", file)]));
        }
        if !files.iter().any(|g: &DraftFile| g.name.eq_ignore_ascii_case(file)) {
            files.push(DraftFile { name: file.to_string(), content: f.content.clone() });
        }
    }
    let entry = draft.entry.trim().to_string();
    let absolute = Path::new(&entry).is_absolute();
    let own = files.iter().any(|f| f.name.eq_ignore_ascii_case(&entry));
    let kept = !absolute
        && valid_file_name(&entry)
        && draft.replaces.as_deref().and_then(find).is_some_and(|(dir, _)| dir.join(&entry).is_file());
    if !(own || kept || (absolute && Path::new(&entry).is_file())) {
        return Err(tf("The file that runs the tool, {name}, isn't there.", &[("name", &entry)]));
    }
    let params: Vec<Param> = draft
        .params
        .iter()
        .filter(|p| valid_param_name(p.name.trim()))
        .map(|p| Param {
            name: p.name.trim().to_string(),
            kind: if PARAM_TYPES.contains(&p.kind.as_str()) { p.kind.clone() } else { string_type() },
            description: p.description.trim().chars().take(400).collect(),
            required: p.required,
        })
        .collect();
    let mut permissions: Vec<String> =
        PERMISSIONS.iter().filter(|p| draft.permissions.iter().any(|q| q.eq_ignore_ascii_case(p))).map(|p| p.to_string()).collect();
    permissions.dedup();
    Ok(Draft {
        name,
        description,
        entry,
        args: draft.args.iter().take(40).cloned().collect(),
        params,
        permissions,
        timeout: draft.timeout.min(MAX_TIMEOUT_S),
        files,
        replaces: draft.replaces.clone().filter(|id| valid_id(id)),
    })
}

/// An id no other tool has, from the name.
fn free_id(name: &str) -> String {
    let base = slug(name);
    let root = tools_dir();
    if !root.join(&base).exists() {
        return base;
    }
    (2..1000).map(|n| format!("{base}_{n}")).find(|id| !root.join(id).exists()).unwrap_or_else(|| format!("{base}_{}", now_ms()))
}

/// Saves a draft as a tool, on: a new one, or the one it `replaces` (whose
/// other files stay). The user's click in the workshop is what calls this.
/// The file a changed tool ran before, when the new version runs another one
/// and has no use for it: no file of the draft named after it, and none
/// mentions it. Left in the folder, the supervisor would read it as part of
/// the tool, and the user would find it there.
fn old_entry(old: &Manifest, d: &Draft) -> Option<String> {
    let before = old.entry.as_str();
    if before == d.entry || Path::new(before).is_absolute() || d.files.iter().any(|f| f.name.eq_ignore_ascii_case(before)) {
        return None;
    }
    let stem = Path::new(before).file_stem()?.to_str()?;
    (!d.files.iter().any(|f| f.content.contains(stem))).then(|| before.to_string())
}

pub fn save(draft: &Draft) -> Result<ToolInfo, String> {
    let d = checked(draft)?;
    let old = d.replaces.as_deref().and_then(find);
    let id = old.as_ref().map(|(_, m)| m.id.clone()).unwrap_or_else(|| free_id(&d.name));
    let dir = tools_dir().join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for f in &d.files {
        std::fs::write(dir.join(&f.name), f.content.as_bytes()).map_err(|e| e.to_string())?;
    }
    if let Some(gone) = old.as_ref().and_then(|(_, m)| old_entry(m, &d)) {
        let _ = std::fs::remove_file(dir.join(gone));
    }
    let now = now_ms();
    // Trust outlives a change that asks for nothing more; the old review
    // stays, and no longer counts unless nothing changed (`fingerprint`).
    let trust = old.as_ref().is_some_and(|(_, m)| m.trust && d.permissions.iter().all(|p| m.permissions.contains(p)));
    let manifest = Manifest {
        id,
        name: d.name,
        description: d.description,
        entry: d.entry,
        args: d.args,
        params: d.params,
        permissions: d.permissions,
        enabled: old.as_ref().map(|(_, m)| m.enabled).unwrap_or(true),
        timeout: d.timeout,
        created: old.as_ref().map(|(_, m)| m.created).filter(|c| *c > 0).unwrap_or(now),
        updated: now,
        trust,
        review: old.and_then(|(_, m)| m.review),
    };
    write_manifest(&dir, &manifest)?;
    Ok(info(&dir, manifest))
}

fn write_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST), text).map_err(|e| e.to_string())
}

pub fn set_enabled(id: &str, on: bool) -> Result<(), String> {
    let (dir, mut m) = find(id).ok_or_else(|| t("That tool isn't there any more."))?;
    m.enabled = on;
    write_manifest(&dir, &m)
}

/// "Always ask" or "Trust": refused for a tool Lumo can't hold to what it declared.
pub fn set_trust(id: &str, trust: bool) -> Result<(), String> {
    let (dir, mut m) = find(id).ok_or_else(|| t("That tool isn't there any more."))?;
    if trust && !info(&dir, m.clone()).may_trust {
        return Err(t("Lumo can't let this tool run without asking."));
    }
    m.trust = trust;
    write_manifest(&dir, &m)
}

/// Keeps the supervisor's review, if the tool is still the one it read. A tool
/// it finds dangerous is turned off: turning it back on is the user's call.
pub fn set_review(id: &str, review: Review) -> Result<ToolInfo, String> {
    let (dir, mut m) = find(id).ok_or_else(|| t("That tool isn't there any more."))?;
    if review.fingerprint != fingerprint(&dir, &m) {
        return Err(t("The tool changed while it was being reviewed."));
    }
    if review.verdict == "danger" {
        m.enabled = false;
        m.trust = false;
    }
    m.review = Some(review);
    write_manifest(&dir, &m)?;
    Ok(info(&dir, m))
}

/// A tool to review: its tool.json as the supervisor reads it, its files with
/// what they hold, and the fingerprint of all that.
pub fn for_review(id: &str) -> Option<(Manifest, Vec<(String, String)>, String)> {
    let (dir, m) = find(id)?;
    let mut files = read_files(id);
    let entry = Path::new(&m.entry);
    if entry.is_absolute() {
        let text = std::fs::read(entry).ok().filter(|b| b.len() <= MAX_FILE_BYTES).and_then(|b| String::from_utf8(b).ok());
        files.push((m.entry.clone(), text.unwrap_or_else(|| "(a program, not a script: its code can't be read)".into())));
    }
    let print = fingerprint(&dir, &m);
    Some((m, files, print))
}

/// Deletes a tool's folder. A script it ran from elsewhere stays where it is.
pub fn delete(id: &str) -> Result<(), String> {
    let (dir, _) = find(id).ok_or_else(|| t("That tool isn't there any more."))?;
    std::fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

/// A tool's own files with what they hold, for the workshop to change it.
pub fn read_files(id: &str) -> Vec<(String, String)> {
    let Some((dir, m)) = find(id) else { return Vec::new() };
    info(&dir, m)
        .files
        .into_iter()
        .filter_map(|name| {
            let bytes = std::fs::read(dir.join(&name)).ok()?;
            (bytes.len() <= MAX_FILE_BYTES).then(|| String::from_utf8(bytes).ok()).flatten().map(|text| (name, text))
        })
        .collect()
}

// ── Running ───────────────────────────────────────────────────────────────────

/// A parameter's value as a word of a command line.
fn arg_value(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

/// The command line `args` makes of `input`: `{name}` is the value; an
/// argument that is only `{name}` goes when the value isn't given, and so
/// does the flag right before it ("--count", "{count}").
pub fn fill_args(args: &[String], input: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in args {
        let whole = a.strip_prefix('{').and_then(|r| r.strip_suffix('}')).filter(|n| valid_param_name(n));
        if let Some(name) = whole {
            match input.get(name).and_then(arg_value) {
                Some(v) => out.push(v),
                None => {
                    if out.last().is_some_and(|l| l.starts_with('-')) {
                        out.pop();
                    }
                }
            }
            continue;
        }
        let mut filled = a.clone();
        if let Some(obj) = input.as_object() {
            for (k, v) in obj {
                if let Some(v) = arg_value(v) {
                    filled = filled.replace(&format!("{{{k}}}"), &v);
                }
            }
        }
        out.push(filled);
    }
    out
}

/// Where a run of `id` may write (and TEMP points): its own folder, made if need be.
fn work_dir(id: &str) -> PathBuf {
    let dir = platform::local_dir().join(WORK_DIR).join(id);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// tool_guard.py, where Python can run it: written again when it changed.
fn guard_file() -> Result<PathBuf, String> {
    let path = platform::local_dir().join(GUARD_FILE);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(GUARD) {
        std::fs::create_dir_all(platform::local_dir()).map_err(|e| e.to_string())?;
        std::fs::write(&path, GUARD).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// Node's permission model for a tool that declared `allow`: files read in
/// its own folders unless it reads, written in its work folder unless it
/// writes, programs and workers only for the system. Before Node 20 there is none.
fn node_flags(major: u32, allow: &[String], folders: &[&Path], work: &Path) -> Vec<String> {
    if major < 20 {
        return Vec::new();
    }
    let has = |p: &str| allow.iter().any(|a| a == p);
    let mut flags = vec![if major >= 22 { "--permission" } else { "--experimental-permission" }.to_string()];
    // Node 20 and 21 take a comma-separated list; later ones repeat the flag.
    let mut grant = |flag: &str, paths: Vec<String>| {
        if major >= 22 {
            flags.extend(paths.iter().map(|p| format!("{flag}={p}")));
        } else {
            flags.push(format!("{flag}={}", paths.join(",")));
        }
    };
    let own = |dirs: &[&Path]| dirs.iter().map(|d| d.to_string_lossy().to_string()).collect::<Vec<_>>();
    let mut readable: Vec<&Path> = folders.to_vec();
    readable.push(work);
    grant("--allow-fs-read", if has("read") { vec!["*".into()] } else { own(&readable) });
    grant("--allow-fs-write", if has("write") { vec!["*".into()] } else { own(&[work]) });
    if has("system") {
        flags.push("--allow-child-process".into());
        flags.push("--allow-worker".into());
        if major >= 22 {
            flags.push("--allow-addons".into());
        }
    }
    flags
}

/// How a file runs, by its extension: the program and the words before the
/// file's own arguments, Python under the guard and Node under its permissions.
fn runner(path: &Path, allow: &[String], dir: &Path, work: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let ext = extension(path);
    let on_path = |names: &[&str]| names.iter().find_map(|n| platform::find_on_path(n));
    let file = path.to_string_lossy().to_string();
    match ext.as_str() {
        "py" | "pyw" => {
            let exe = on_path(&["python", "py", "python3"]).ok_or_else(|| t("Python isn't installed, so this tool can't run."))?;
            let guard = guard_file()?.to_string_lossy().to_string();
            Ok((exe, vec!["-X".into(), "utf8".into(), guard, file]))
        }
        "ps1" => {
            let exe = on_path(&["pwsh", "powershell"]).unwrap_or_else(|| PathBuf::from("powershell.exe"));
            Ok((exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"].iter().map(|s| s.to_string()).chain([file]).collect()))
        }
        "js" | "mjs" | "cjs" => {
            let exe = on_path(&["node"]).ok_or_else(|| t("Node.js isn't installed, so this tool can't run."))?;
            let script_dir = path.parent().unwrap_or(dir);
            let mut words = node_flags(node_major(), allow, &[dir, script_dir], work);
            words.push(file);
            Ok((exe, words))
        }
        "exe" | "bat" | "cmd" => Ok((path.to_path_buf(), Vec::new())),
        _ => Err(tf("Lumo doesn't know how to run .{ext} files.", &[("ext", &ext)])),
    }
}

fn cut(text: &str) -> String {
    if text.len() <= MAX_OUTPUT {
        return text.to_string();
    }
    let mut end = MAX_OUTPUT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &text[..end])
}

/// Runs the file at `entry` (in `dir` unless absolute) with `input`, within
/// its time. Blocking.
pub fn run_in(dir: &Path, m: &Manifest, input: &Value) -> RunResult {
    let started = Instant::now();
    let done = |ok: bool, output: String| RunResult { ok, output, ms: started.elapsed().as_millis() as u64 };
    let path = entry_path(dir, &m.entry);
    if !path.is_file() {
        return done(false, tf("The file that runs the tool, {name}, isn't there.", &[("name", &m.entry)]));
    }
    let work = work_dir(&m.id);
    let (exe, mut words) = match runner(&path, &m.permissions, dir, &work) {
        Ok(r) => r,
        Err(e) => return done(false, e),
    };
    words.extend(fill_args(&m.args, input));
    let input_text = input.to_string();
    let mut cmd = Command::new(exe);
    cmd.args(&words)
        .current_dir(path.parent().unwrap_or(dir))
        .env("LUMO_TOOL_INPUT", &input_text)
        .env("LUMO_TOOL_DIR", dir)
        .env("LUMO_TOOL_WORK", &work)
        .env("LUMO_TOOL_ALLOW", m.permissions.join(","))
        .env("TEMP", &work)
        .env("TMP", &work)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // No internet declared: what honours a proxy (curl, .NET, Python, many
    // others) is pointed at one that isn't there. Python is stopped anyway.
    if !m.permissions.iter().any(|p| p == "network") {
        for var in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
            cmd.env(var, "http://127.0.0.1:9");
        }
        cmd.env("NO_PROXY", "").env("no_proxy", "");
    }
    platform::no_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return done(false, e.to_string()),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input_text.as_bytes());
    }
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.by_ref().take((MAX_OUTPUT * 4) as u64).read_to_end(&mut buf);
                // Whatever else it prints is read and dropped, so it never blocks on a full pipe.
                let _ = std::io::copy(&mut r, &mut std::io::sink());
            }
            String::from_utf8_lossy(&buf).to_string()
        })
    };
    let out = pipe(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = pipe(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let limit = Duration::from_secs(if m.timeout == 0 { DEFAULT_TIMEOUT_S } else { m.timeout.clamp(5, MAX_TIMEOUT_S) });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    match status {
        None => done(false, tf("The tool took more than {seconds} s and was stopped.", &[("seconds", &limit.as_secs().to_string())])),
        Some(s) if s.success() => {
            let text = if stdout.trim().is_empty() { stderr.trim().to_string() } else { stdout.trim().to_string() };
            done(true, cut(&text))
        }
        Some(s) => {
            let code = s.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            let mut text = format!("exit code {code}");
            for part in [stderr.trim(), stdout.trim()].into_iter().filter(|p| !p.is_empty()) {
                text.push('\n');
                text.push_str(part);
            }
            done(false, cut(&text))
        }
    }
}

/// Try in the workshop: the draft's files are written to a folder of their
/// own (emptied first) and run from there; a script that was already on the
/// computer runs where it is. Only on the user's click.
pub fn try_draft(draft: &Draft, input: &Value) -> Result<RunResult, String> {
    let d = checked(draft)?;
    let dir = platform::local_dir().join(TRYOUT_DIR);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A tool being changed: its other files are there too.
    if let Some((old, m)) = d.replaces.as_deref().and_then(find) {
        let gone = old_entry(&m, &d);
        for name in info(&old, m).files.into_iter().filter(|n| Some(n) != gone.as_ref()) {
            let _ = std::fs::copy(old.join(&name), dir.join(&name));
        }
    }
    for f in &d.files {
        std::fs::write(dir.join(&f.name), f.content.as_bytes()).map_err(|e| e.to_string())?;
    }
    let m = Manifest {
        id: "draft".into(),
        name: d.name,
        description: d.description,
        entry: d.entry,
        args: d.args,
        params: d.params,
        permissions: d.permissions,
        enabled: true,
        timeout: d.timeout,
        created: 0,
        updated: 0,
        trust: false,
        review: None,
    };
    Ok(run_in(&dir, &m, input))
}

// ── For the agents (lumo-hook --mcp --tools=user) ─────────────────────────────

const PERMISSION_WORDS: &[(&str, &str)] = &[
    ("network", "uses the internet"),
    ("read", "reads files"),
    ("write", "changes files"),
    ("system", "changes system settings or runs system commands"),
];

/// A tool as MCP lists it.
pub fn mcp_tool(m: &Manifest) -> Value {
    let mut properties = Map::new();
    for p in &m.params {
        properties.insert(p.name.clone(), json!({ "type": p.kind, "description": p.description }));
    }
    let required: Vec<&str> = m.params.iter().filter(|p| p.required).map(|p| p.name.as_str()).collect();
    let needs: Vec<&str> =
        PERMISSION_WORDS.iter().filter(|(k, _)| m.permissions.iter().any(|p| p == k)).map(|(_, w)| *w).collect();
    let mut description = m.description.clone();
    description.push_str(&format!("\n\n(A tool the user added to Lumo: {}.", m.name));
    if !needs.is_empty() {
        description.push_str(&format!(" It {}.", needs.join(", ")));
    }
    description.push(')');
    json!({
        "name": m.id,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

/// The tools agents may use: on, there, and reviewed as they are now.
pub fn offered() -> Vec<ToolInfo> {
    list().into_iter().filter(|t| t.manifest.enabled && !t.missing && t.reviewed).collect()
}

/// The tools agents may use, for the chat's API providers: the island's own
/// (island_tools.rs, its GitHub ones with `listen`), then the user's that are
/// on: id, the words the model reads, and the JSON schema of the input.
pub fn api_tools(listen: bool) -> Vec<(String, String, Value)> {
    let mut all = crate::island_tools::api_tools(listen);
    // Never one of the user's with the name of the island's own.
    all.extend(offered().iter().filter(|t| !crate::island_tools::NAMES.contains(&t.manifest.id.as_str())).map(|t| {
        let v = mcp_tool(&t.manifest);
        (t.manifest.id.clone(), v["description"].as_str().unwrap_or("").to_string(), v["inputSchema"].clone())
    }));
    all
}

/// A call from the chat `chat_id`'s API providers (claude.rs,
/// openai_compat.rs): what goes back to the model, and whether it failed.
pub async fn call_for_chat(app: &AppHandle, chat_id: &str, id: &str, input: Value) -> (String, bool) {
    if crate::island_tools::NAMES.contains(&id) {
        return crate::island_tools::call(chat_id, id, &input);
    }
    let answer = serve_call(app, &json!({ "tool": id, "input": input })).await;
    match answer.get("error").and_then(Value::as_str) {
        Some(e) => (e.to_string(), true),
        None => (answer.get("text").and_then(Value::as_str).unwrap_or("Done.").to_string(), false),
    }
}

/// `{"lumo_tools": …}`: the tools that are on, for `tools/list`.
pub fn serve_list() -> Value {
    let tools: Vec<Value> = offered().iter().map(|t| mcp_tool(&t.manifest)).collect();
    json!({ "tools": tools })
}

/// Calls of a tool the user just allowed on Claude Code's own card (pipe.rs):
/// that click covers the call that follows, once, for a short while.
static ALLOWED: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

/// Claude Code's card for `tool` (`mcp__lumo_tools__<id>`) was allowed with a click.
pub fn note_allowed(tool: &str) {
    let Some(id) = tool.strip_prefix(&format!("mcp__{SERVER}__")) else { return };
    let mut allowed = ALLOWED.lock().unwrap_or_else(|e| e.into_inner());
    allowed.retain(|(_, at)| at.elapsed() < ALLOWED_FOR);
    allowed.push((id.to_string(), Instant::now()));
}

fn take_allowed(id: &str) -> bool {
    let mut allowed = ALLOWED.lock().unwrap_or_else(|e| e.into_inner());
    allowed.retain(|(_, at)| at.elapsed() < ALLOWED_FOR);
    match allowed.iter().position(|(a, _)| a == id) {
        Some(i) => {
            allowed.remove(i);
            true
        }
        None => false,
    }
}

/// The user's go-ahead for one call: none needed for a tool they trust (and
/// Lumo can hold to what it declared), the click on Claude Code's own card
/// when there was one, else an Allow / Deny card on the island.
async fn approve(app: &AppHandle, tool: &ToolInfo, input: &Value) -> Result<(), String> {
    let m = &tool.manifest;
    if m.trust && tool.may_trust {
        return Ok(());
    }
    if take_allowed(&m.id) {
        return Ok(());
    }
    let summary = m.review.as_ref().map(|r| r.summary.clone()).unwrap_or_default();
    let payload = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "tool_name": format!("mcp__{SERVER}__{}", m.id),
        "tool_input": input,
        "lumo_user_tool": { "name": m.name, "summary": summary, "verdict": m.review.as_ref().map(|r| r.verdict.clone()) },
    });
    match crate::pipe::ask(app, payload).await.as_deref() {
        Some("allow") => Ok(()),
        Some(_) => Err(format!("The user said no to running {} this time.", m.name)),
        None => Err("Lumo couldn't ask the user (the island is paused or busy). Try again in a moment.".into()),
    }
}

/// `{"lumo_tool": {"tool": …, "input": …}}`: runs a tool that is on and
/// reviewed, once the user said yes, and tells the island it ran. The chat's
/// API providers call it too.
pub async fn serve_call(app: &AppHandle, request: &Value) -> Value {
    let id = request.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
    let input = request.get("input").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let Some(tool) = find(&id).map(|(dir, m)| info(&dir, m)) else {
        return json!({ "error": format!("Lumo has no tool called {id}.") });
    };
    let m = &tool.manifest;
    if !m.enabled {
        return json!({ "error": format!("The user turned the tool {} off in Lumo.", m.name) });
    }
    if !tool.reviewed {
        return json!({ "error": format!("The tool {} changed since it was reviewed. The user can review it again in Lumo's Tools tab.", m.name) });
    }
    if let Err(e) = approve(app, &tool, &input).await {
        return json!({ "error": e });
    }
    let name = m.name.clone();
    let (dir, m) = (PathBuf::from(&tool.dir), tool.manifest.clone());
    let result = tauri::async_runtime::spawn_blocking(move || run_in(&dir, &m, &input))
        .await
        .unwrap_or_else(|e| RunResult { ok: false, output: e.to_string(), ms: 0 });
    let _ = app.emit_to(WINDOW_LABEL, "tool-ran", json!({ "name": name, "ok": result.ok }));
    if result.ok {
        let text = if result.output.is_empty() { "Done.".to_string() } else { result.output };
        json!({ "text": text })
    } else {
        json!({ "error": result.output })
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

pub(crate) fn changed(app: &AppHandle) {
    let _ = app.emit_to(WINDOW_LABEL, "tools-changed", list());
}

#[tauri::command(async)]
pub fn tools_list() -> Vec<ToolInfo> {
    list()
}

#[tauri::command(async)]
pub fn tools_save(app: AppHandle, draft: Draft) -> Result<ToolInfo, String> {
    let saved = save(&draft)?;
    crate::log::line(format!("[tools] saved {}", saved.manifest.id));
    changed(&app);
    // A new tool, or a changed one: the supervisor reads it before any agent may.
    if !saved.reviewed {
        crate::tool_review::start(&app, &saved.manifest.id);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn tools_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    set_enabled(&id, enabled)?;
    changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn tools_set_trust(app: AppHandle, id: String, trust: bool) -> Result<(), String> {
    set_trust(&id, trust)?;
    changed(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn tools_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete(&id)?;
    crate::log::line(format!("[tools] deleted {id}"));
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn tools_try(draft: Draft, input: Value) -> Result<RunResult, String> {
    let input = if input.is_object() { input } else { json!({}) };
    tauri::async_runtime::spawn_blocking(move || try_draft(&draft, &input)).await.map_err(|e| e.to_string())?
}

/// A tool's files, for the workshop to change it: name and text.
#[tauri::command(async)]
pub fn tools_files(id: String) -> Vec<(String, String)> {
    read_files(&id)
}

// ── Claude Code in the terminal ───────────────────────────────────────────────

/// `claude <args>`, quietly, for its MCP settings. Claude Code edits its own
/// file: Lumo never writes it.
fn claude_cli(args: &[String]) -> Result<std::process::Output, String> {
    let exe = platform::claude_candidates()
        .into_iter()
        .next()
        .ok_or_else(|| t("Claude Code isn't installed. Install it, sign in once with `claude` in a terminal, then try again."))?;
    let mut cmd = crate::claude_code::cli_command(&exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_console(&mut cmd);
    cmd.output().map_err(|e| tf("Cannot start Claude Code: {error}", &[("error", &e.to_string())]))
}

/// Whether Claude Code in the terminal has the tools' server, for the user.
pub fn terminal_has() -> bool {
    claude_cli(&["mcp".into(), "get".into(), SERVER.into()]).is_ok_and(|o| o.status.success())
}

/// Adds the tools' server to Claude Code for every project of the user
/// (`claude mcp add --scope user`), or takes it away. Each call there is a
/// card on the island too, unless Claude Code's own card was allowed on it.
pub fn terminal_set(on: bool) -> Result<(), String> {
    let had = terminal_has();
    if had {
        let out = claude_cli(&["mcp", "remove", "--scope", "user", SERVER].map(String::from))?;
        if !on && !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    if !on {
        return Ok(());
    }
    let hook = crate::settings::hook_exe_path().to_string_lossy().to_string();
    if crate::claude_code::safe_dir(&hook).is_none() {
        return Err(t("Lumo's folder has a name Claude Code's command line can't take."));
    }
    let args: Vec<String> = ["mcp", "add", "--scope", "user", SERVER, "--", &hook, "--mcp", "--tools=user"].map(String::from).to_vec();
    let out = claude_cli(&args)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command(async)]
pub fn tools_terminal_has() -> bool {
    terminal_has()
}

#[tauri::command(async)]
pub fn tools_terminal_set(on: bool) -> Result<bool, String> {
    terminal_set(on)?;
    crate::log::line(format!("[tools] Claude Code in the terminal: {}", if on { "added" } else { "removed" }));
    Ok(terminal_has())
}

/// Opens the folder of a tool, or of all of them.
#[tauri::command(async)]
pub fn tools_reveal(id: Option<String>) {
    let dir = match id.as_deref().and_then(find) {
        Some((dir, _)) => dir,
        None => tools_dir(),
    };
    let _ = std::fs::create_dir_all(&dir);
    platform::reveal_folder(&dir.to_string_lossy());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_becomes_an_id_mcp_takes() {
        assert_eq!(slug("Benchmark del PC"), "benchmark_del_pc");
        assert_eq!(slug("  Più veloce!  "), "piu_veloce");
        assert_eq!(slug("???"), "tool");
        assert!(slug(&"a".repeat(200)).len() <= MAX_ID);
        assert!(valid_id(&slug("Ciao Mondo 2")));
        assert!(!valid_id("../x") && !valid_id("A") && !valid_id(""));
    }

    #[test]
    fn only_plain_file_names_go_in_a_tools_folder() {
        for ok in ["bench.py", "run me.ps1", "data.json"] {
            assert!(valid_file_name(ok), "{ok}");
        }
        for bad in ["", "../x.py", "a/b.py", "a\\b.py", ".env", "tool.json", "C:x.py", "con.txt", "x.py."] {
            assert!(!valid_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn args_take_the_values_and_drop_what_was_not_given() {
        let args: Vec<String> = ["--count", "{count}", "--name={name}", "-v", "{verbose}", "fixed"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            fill_args(&args, &json!({ "count": 3, "name": "pc", "verbose": true })),
            ["--count", "3", "--name=pc", "-v", "true", "fixed"]
        );
        assert_eq!(fill_args(&args, &json!({ "name": "pc" })), ["--name=pc", "fixed"]);
    }

    #[test]
    fn a_tool_is_listed_for_the_agents_with_its_parameters_and_needs() {
        let m = Manifest {
            id: "bench".into(),
            name: "Benchmark".into(),
            description: "Measures the PC.".into(),
            entry: "bench.py".into(),
            args: vec![],
            params: vec![Param { name: "quick".into(), kind: "boolean".into(), description: "Short run".into(), required: true }],
            permissions: vec!["read".into()],
            enabled: true,
            timeout: 0,
            created: 0,
            updated: 0,
            trust: false,
            review: None,
        };
        let t = mcp_tool(&m);
        assert_eq!(t["name"], "bench");
        assert_eq!(t["inputSchema"]["properties"]["quick"]["type"], "boolean");
        assert_eq!(t["inputSchema"]["required"], json!(["quick"]));
        assert!(t["description"].as_str().unwrap().contains("reads files"));
    }

    #[test]
    fn a_draft_is_checked_before_anything_is_written() {
        let draft = |entry: &str, files: Vec<DraftFile>| Draft {
            name: " Bench ".into(),
            description: "x".into(),
            entry: entry.into(),
            args: vec![],
            params: vec![
                Param { name: "ok_name".into(), kind: "weird".into(), description: String::new(), required: false },
                Param { name: "bad name".into(), kind: "string".into(), description: String::new(), required: false },
            ],
            permissions: vec!["Network".into(), "everything".into()],
            timeout: 9999,
            files,
            replaces: Some("../evil".into()),
        };
        let file = || vec![DraftFile { name: "bench.py".into(), content: "print(1)".into() }];
        let d = checked(&draft("bench.py", file())).unwrap();
        assert_eq!(d.name, "Bench");
        assert_eq!(d.params.len(), 1);
        assert_eq!(d.params[0].kind, "string");
        assert_eq!(d.permissions, ["network"]);
        assert_eq!(d.timeout, MAX_TIMEOUT_S);
        assert_eq!(d.replaces, None);
        assert!(checked(&draft("other.py", file())).is_err(), "the entry must be there");
        assert!(checked(&draft("../x.py", vec![DraftFile { name: "../x.py".into(), content: String::new() }])).is_err());
    }

    fn manifest(entry: &str, permissions: &[&str]) -> Manifest {
        Manifest {
            id: "t".into(),
            name: "T".into(),
            description: String::new(),
            entry: entry.into(),
            args: vec![],
            params: vec![],
            permissions: permissions.iter().map(|p| p.to_string()).collect(),
            enabled: true,
            timeout: 0,
            created: 0,
            updated: 0,
            trust: false,
            review: None,
        }
    }

    #[test]
    fn the_file_a_changed_tool_ran_before_goes_unless_the_new_one_uses_it() {
        let draft = |entry: &str, files: &[(&str, &str)]| Draft {
            name: "T".into(),
            description: String::new(),
            entry: entry.into(),
            args: vec![],
            params: vec![],
            permissions: vec![],
            timeout: 0,
            files: files.iter().map(|(n, c)| DraftFile { name: n.to_string(), content: c.to_string() }).collect(),
            replaces: None,
        };
        let old = manifest("pdfcraft_tool.py", &[]);
        assert_eq!(old_entry(&old, &draft("pdfcraft_mcp.py", &[("pdfcraft_mcp.py", "print(1)")])).as_deref(), Some("pdfcraft_tool.py"));
        assert_eq!(old_entry(&old, &draft("pdfcraft_mcp.py", &[("pdfcraft_mcp.py", "import pdfcraft_tool")])), None, "still imported");
        assert_eq!(old_entry(&old, &draft("pdfcraft_tool.py", &[])), None, "the same entry");
        assert_eq!(old_entry(&old, &draft("b.py", &[("b.py", ""), ("pdfcraft_tool.py", "")])), None, "still one of its files");
        assert_eq!(old_entry(&manifest("C:\\Scripts\\x.py", &[]), &draft("b.py", &[("b.py", "")])), None, "the user's own script is never touched");
    }

    #[test]
    fn any_change_to_a_tool_is_another_fingerprint_but_turning_it_off_is_not() {
        let dir = std::env::temp_dir().join(format!("lumo-tool-fp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t.py"), "print(1)").unwrap();
        let m = manifest("t.py", &["read"]);
        let first = fingerprint(&dir, &m);
        assert_eq!(first, fingerprint(&dir, &Manifest { enabled: false, trust: true, ..m.clone() }));
        assert_ne!(first, fingerprint(&dir, &manifest("t.py", &["read", "network"])), "what it declares");
        std::fs::write(dir.join("t.py"), "print(2)").unwrap();
        assert_ne!(first, fingerprint(&dir, &m), "a file");
        std::fs::write(dir.join("t.py"), "print(1)").unwrap();
        assert_eq!(first, fingerprint(&dir, &m));
        std::fs::write(dir.join("helper.py"), "x = 1").unwrap();
        assert_ne!(first, fingerprint(&dir, &m), "a file added");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn python_is_held_to_what_it_declared_and_scripts_lumo_cant_guard_never_are() {
        assert!(unguarded(Path::new("t.py"), &[]).is_empty());
        assert_eq!(unguarded(Path::new("t.ps1"), &["read".into()]), ["network", "write", "system"]);
        assert!(unguarded(Path::new("t.bat"), &PERMISSIONS.iter().map(|p| p.to_string()).collect::<Vec<_>>()).is_empty(), "declared all: nothing left to hold");
    }

    #[test]
    fn node_runs_with_its_permissions_to_what_the_tool_declared() {
        let (dir, work) = (Path::new("C:/t"), Path::new("C:/w"));
        assert!(node_flags(18, &[], &[dir], work).is_empty(), "no permission model before Node 20");
        let none = node_flags(22, &[], &[dir], work);
        assert_eq!(none, ["--permission", "--allow-fs-read=C:/t", "--allow-fs-read=C:/w", "--allow-fs-write=C:/w"]);
        let all: Vec<String> = ["read", "write", "system"].iter().map(|p| p.to_string()).collect();
        let full = node_flags(22, &all, &[dir], work);
        assert!(full.contains(&"--allow-fs-read=*".to_string()) && full.contains(&"--allow-fs-write=*".to_string()));
        assert!(full.contains(&"--allow-child-process".to_string()) && full.contains(&"--allow-addons".to_string()));
        let old = node_flags(20, &[], &[dir], work);
        assert_eq!(old, ["--experimental-permission", "--allow-fs-read=C:/t,C:/w", "--allow-fs-write=C:/w"]);
    }

    #[test]
    fn a_click_on_claude_codes_own_card_covers_one_call_of_that_tool() {
        note_allowed("mcp__lumo_tools__bench_card");
        note_allowed("mcp__other__bench_card");
        assert!(take_allowed("bench_card"));
        assert!(!take_allowed("bench_card"), "once");
        assert!(!take_allowed("other_card"));
    }
}
