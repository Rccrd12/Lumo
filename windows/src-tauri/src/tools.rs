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
// (`{"lumo_tool": {"tool": …, "input": …}}`, pipe.rs), which runs it here: a
// tool turned off, or gone, is refused. Claude Code asks the user on the
// island before each call, as for every MCP tool.
//
// A script gets its parameters as JSON on stdin and in LUMO_TOOL_INPUT, or on
// its command line when tool.json gives `args` ("--count", "{count}"); what it
// prints is its answer.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

fn info(dir: &Path, manifest: Manifest) -> ToolInfo {
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
    let missing = !entry_path(dir, &manifest.entry).is_file();
    ToolInfo { manifest, dir: dir.to_string_lossy().to_string(), files, missing }
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
pub fn save(draft: &Draft) -> Result<ToolInfo, String> {
    let d = checked(draft)?;
    let old = d.replaces.as_deref().and_then(find);
    let id = old.as_ref().map(|(_, m)| m.id.clone()).unwrap_or_else(|| free_id(&d.name));
    let dir = tools_dir().join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for f in &d.files {
        std::fs::write(dir.join(&f.name), f.content.as_bytes()).map_err(|e| e.to_string())?;
    }
    let now = now_ms();
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

/// How a file runs, by its extension: the program and the words before the file.
fn runner(path: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let on_path = |names: &[&str]| names.iter().find_map(|n| platform::find_on_path(n));
    let file = path.to_string_lossy().to_string();
    match ext.as_str() {
        "py" | "pyw" => {
            let exe = on_path(&["python", "py", "python3"]).ok_or_else(|| t("Python isn't installed, so this tool can't run."))?;
            Ok((exe, vec!["-X".into(), "utf8".into(), file]))
        }
        "ps1" => {
            let exe = on_path(&["pwsh", "powershell"]).unwrap_or_else(|| PathBuf::from("powershell.exe"));
            Ok((exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"].iter().map(|s| s.to_string()).chain([file]).collect()))
        }
        "js" | "mjs" | "cjs" => {
            let exe = on_path(&["node"]).ok_or_else(|| t("Node.js isn't installed, so this tool can't run."))?;
            Ok((exe, vec![file]))
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
    let (exe, mut words) = match runner(&path) {
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
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        for name in info(&old, m).files {
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

/// `{"lumo_tools": …}`: the tools that are on, for `tools/list`.
pub fn serve_list() -> Value {
    let tools: Vec<Value> =
        list().into_iter().filter(|t| t.manifest.enabled && !t.missing).map(|t| mcp_tool(&t.manifest)).collect();
    json!({ "tools": tools })
}

/// `{"lumo_tool": {"tool": …, "input": …}}`: runs a tool that is on, and
/// tells the island it ran.
pub async fn serve_call(app: &AppHandle, request: &Value) -> Value {
    let id = request.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
    let input = request.get("input").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let Some((dir, m)) = find(&id) else {
        return json!({ "error": format!("Lumo has no tool called {id}.") });
    };
    if !m.enabled {
        return json!({ "error": format!("The user turned the tool {} off in Lumo.", m.name) });
    }
    let name = m.name.clone();
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

fn changed(app: &AppHandle) {
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
    Ok(saved)
}

#[tauri::command(async)]
pub fn tools_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    set_enabled(&id, enabled)?;
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
}
