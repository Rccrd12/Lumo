// A folder of its own for each chat with a local model, where the model works
// on copies: it copies a file or a folder of the computer in (the original is
// only read), then reads, searches, writes, edits and deletes what is in there,
// and nothing outside it. Every path a model names is checked to stay inside:
// no "..", no drive or root, no link or junction on the way.
//
// The user finds what changed in the chat's files (`chat-file` events), and
// writes a copy over its original with a click (`workspace_put_back`), its
// differences seen first.
//
// %LOCALAPPDATA%\com.rccrd12.lumo\workspaces\<chat>; deleted with the chat.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const COPY: &str = "workspace_copy";
pub const LIST: &str = "workspace_list";
pub const READ: &str = "workspace_read";
pub const SEARCH: &str = "workspace_search";
pub const WRITE: &str = "workspace_write";
pub const EDIT: &str = "workspace_edit";
pub const DELETE: &str = "workspace_delete";

pub const NAMES: [&str; 7] = [COPY, LIST, READ, SEARCH, WRITE, EDIT, DELETE];
/// The ones that change nothing in the folder but what is copied in: Plan only keeps them.
pub const READS: [&str; 4] = [COPY, LIST, READ, SEARCH];

/// The biggest file copied in, and the most a folder copies.
const MAX_FILE: u64 = 50 * 1024 * 1024;
const MAX_FILES: usize = 2_000;
const MAX_BYTES: u64 = 300 * 1024 * 1024;
/// Folders a copy of a project leaves out: rebuilt, not written.
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", "dist", "build", ".next"];
/// The most a read gives back, a listing names, a search finds.
const MAX_READ: usize = 20_000;
const MAX_LIST: usize = 300;
const MAX_HITS: usize = 60;
/// What the folder keeps of its copies; never listed nor touched by the model.
const MANIFEST: &str = ".lumo-copies.json";

/// What the model is told the folder is for, in each tool's words.
const ABOUT: &str = "Your own folder for this chat: you can't read or change the user's files, only copies of them here.";

/// The tools, as the chat's API providers take them: id, the words the model
/// reads, and the schema of the input.
pub fn api_tools() -> Vec<(String, String, Value)> {
    let path = |what: &str| json!({ "type": "string", "description": what });
    vec![
        (
            COPY.into(),
            format!("{ABOUT} Copies a file or a folder of the user's computer into it, by its full path (C:\\Users\\…), and says where the copy is. The original is only read. A folder leaves out .git, node_modules and build output. Copy before you read or change anything; a file already copied is not copied again."),
            json!({ "type": "object", "properties": { "path": path("The full path of the file or folder on the computer.") }, "required": ["path"] }),
        ),
        (
            LIST.into(),
            format!("{ABOUT} Lists what is in it (or in one of its folders), with sizes, and which copies you changed."),
            json!({ "type": "object", "properties": { "path": path("A folder in it; empty for all of it.") } }),
        ),
        (
            READ.into(),
            format!("{ABOUT} Reads a file in it, with line numbers. A long file is read in parts: give the line to start from."),
            json!({ "type": "object", "properties": {
                "path": path("The file, as workspace_copy or workspace_list name it."),
                "from_line": { "type": "integer", "description": "The first line to read (1 is the first)." },
                "lines": { "type": "integer", "description": "How many lines." }
            }, "required": ["path"] }),
        ),
        (
            SEARCH.into(),
            format!("{ABOUT} Finds the lines of its text files that hold some words (any case)."),
            json!({ "type": "object", "properties": {
                "text": { "type": "string", "description": "The words to find." },
                "path": path("Only in this file or folder of it.")
            }, "required": ["text"] }),
        ),
        (
            WRITE.into(),
            format!("{ABOUT} Writes a whole file in it, new or over a copy. After changing a copy, tell the user that the copy changed, not their file, and that the chat's files list it with a button to put it back."),
            json!({ "type": "object", "properties": {
                "path": path("The file, in the folder."),
                "content": { "type": "string", "description": "All of the file's text." }
            }, "required": ["path", "content"] }),
        ),
        (
            EDIT.into(),
            format!("{ABOUT} Replaces a piece of a file in it: `old` must be found once, exactly as written (read the file first). Tell the user afterwards that the copy changed, not their file."),
            json!({ "type": "object", "properties": {
                "path": path("The file, in the folder."),
                "old": { "type": "string", "description": "The text there now." },
                "new": { "type": "string", "description": "What it becomes." },
                "all": { "type": "boolean", "description": "Every time it is found, not once." }
            }, "required": ["path", "old", "new"] }),
        ),
        (
            DELETE.into(),
            format!("{ABOUT} Deletes a file or a folder in it (never the user's own)."),
            json!({ "type": "object", "properties": { "path": path("The file or folder, in the folder.") }, "required": ["path"] }),
        ),
    ]
}

/// What the island says the model is doing with a tool of the folder.
pub fn activity(id: &str, input: &Value) -> crate::claude_code::Activity {
    let named = |key: &str| {
        let p = input.get(key).and_then(Value::as_str).unwrap_or("");
        p.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("").to_string()
    };
    match id {
        COPY | READ => crate::claude_code::Activity::new("read", named("path")),
        WRITE | EDIT => crate::claude_code::Activity::new("edit", named("path")),
        SEARCH => crate::claude_code::Activity::new("search", input.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
        _ => crate::claude_code::Activity::new("tool", crate::claude_code::pretty_tool(id)),
    }
}

/// The user's own folders as they are on this computer (OneDrive's when it
/// holds them), for the model's instructions.
pub fn folders_note() -> String {
    let home = crate::platform::home_dir();
    let mut found = vec![format!("home {}", home.display())];
    for name in ["Desktop", "Documents", "Downloads", "Pictures"] {
        let at = [home.join("OneDrive").join(name), home.join(name)].into_iter().find(|p| p.is_dir());
        if let Some(at) = at {
            found.push(format!("{name} {}", at.display()));
        }
    }
    format!(" The user's folders on this computer: {}. Use these paths as they are; never guess one from the user's name.", found.join(", "))
}

/// A path that isn't there: what its folder holds instead, so the model can
/// pick the right name (or what the nearest folder that is there holds).
fn not_found(path: &Path) -> String {
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d.is_dir() {
            let mut names: Vec<String> = std::fs::read_dir(d)
                .map(|r| r.flatten().map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if e.file_type().is_ok_and(|k| k.is_dir()) { format!("{n}\\") } else { n }
                }).collect())
                .unwrap_or_default();
            names.sort_by_key(|n| n.to_lowercase());
            let more = names.len().saturating_sub(80);
            names.truncate(80);
            let tail = if more > 0 { format!(" and {more} more") } else { String::new() };
            return format!("{} doesn't exist. {} holds: {}{tail}.", path.display(), d.display(), if names.is_empty() { "nothing".into() } else { names.join(", ") });
        }
        dir = d.parent();
    }
    format!("{} doesn't exist, or can't be read.", path.display())
}

/// The chat's folder.
pub fn dir(chat: &str) -> PathBuf {
    root().join(safe_id(chat))
}

fn root() -> PathBuf {
    crate::platform::local_dir().join("workspaces")
}

fn safe_id(chat: &str) -> String {
    let id: String = chat.chars().take(80).map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if id.is_empty() { "chat".into() } else { id }
}

/// A call from the chat `chat`: what goes back to the model, whether it
/// failed, and the file it touched (the chat lists it: "read" for a copy,
/// "edited" or "created").
pub fn call(chat: &str, id: &str, input: &Value) -> (String, bool, Vec<(&'static str, PathBuf)>) {
    let ws = Workspace::new(dir(chat));
    match ws.run(id, input) {
        Ok((text, touched)) => (text, false, touched),
        Err(e) => (e, true, Vec::new()),
    }
}

/// The chat's folder goes with the chat.
pub fn delete(chat: &str) {
    let _ = std::fs::remove_dir_all(dir(chat));
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
struct Entry {
    /// In the folder, with forward slashes.
    copy: String,
    /// Where it came from.
    original: String,
    /// The copy as it came in (FNV-1a of its bytes), to tell what changed.
    hash: u64,
}

/// A copy that is no longer what was copied, or a file the model made.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// The copy, its full path.
    pub path: String,
    /// The file it came from; None for one the model made.
    pub original: Option<String>,
}

struct Workspace {
    dir: PathBuf,
}

/// Text a model copied from workspace_read with its line numbers on every
/// line (`    7| text`, counting up): the text without them. None for any other.
fn without_line_numbers(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() < 2 {
        return None;
    }
    let mut plain = Vec::with_capacity(lines.len());
    let mut next: Option<u64> = None;
    for line in lines {
        let line = line.trim_start();
        let bar = line.find('|')?;
        let n: u64 = line[..bar].parse().ok()?;
        if next.is_some_and(|want| want != n) {
            return None;
        }
        next = Some(n + 1);
        let rest = &line[bar + 1..];
        plain.push(rest.strip_prefix(' ').unwrap_or(rest));
    }
    let mut text = plain.join("\n");
    if content.ends_with('\n') {
        text.push('\n');
    }
    Some(text)
}

/// What a tool says, and the files it touched (their kind, for the chat's files).
type Done = (String, Vec<(&'static str, PathBuf)>);

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

fn hash_of(path: &Path) -> Option<u64> {
    std::fs::read(path).ok().map(|b| fnv(&b))
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn rel_string(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/")
}

impl Workspace {
    fn new(dir: PathBuf) -> Self {
        Workspace { dir }
    }

    fn manifest(&self) -> Vec<Entry> {
        std::fs::read_to_string(self.dir.join(MANIFEST)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn save_manifest(&self, entries: &[Entry]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
        std::fs::write(self.dir.join(MANIFEST), text).map_err(|e| e.to_string())
    }

    /// `path`, as a model names it, inside the folder: relative, or the
    /// folder's own full path before it. None for anything that leaves it.
    fn inside(&self, path: &str) -> Result<(PathBuf, PathBuf), String> {
        let path = path.trim().trim_matches('"');
        let given = Path::new(path);
        let rel: PathBuf = if given.is_absolute() || given.has_root() {
            let own = given.strip_prefix(&self.dir).ok().or_else(|| {
                let lower = path.replace('/', "\\").to_lowercase();
                let dir = self.dir.to_string_lossy().replace('/', "\\").to_lowercase();
                lower.strip_prefix(&dir).and_then(|_| path.get(dir.len()..)).map(Path::new)
            });
            match own {
                Some(rel) => rel.components().filter(|c| !matches!(c, Component::RootDir)).collect(),
                None => return Err(format!("{path} is outside your folder: copy it in first with {COPY}.")),
            }
        } else {
            given.to_path_buf()
        };
        let mut clean = PathBuf::new();
        for c in rel.components() {
            match c {
                Component::Normal(part) => {
                    let s = part.to_string_lossy();
                    // Windows reads "a.txt:stream" and "con" as something else.
                    if s.contains(':') || s.eq_ignore_ascii_case(MANIFEST) {
                        return Err(format!("{path}: not a name in your folder."));
                    }
                    clean.push(part);
                }
                Component::CurDir => {}
                _ => return Err(format!("{path} is outside your folder.")),
            }
        }
        // No link or junction on the way, to anywhere.
        let mut at = self.dir.clone();
        for part in clean.components() {
            at.push(part);
            if is_link(&at) {
                return Err(format!("{path} goes through a link: not followed."));
            }
        }
        Ok((self.dir.join(&clean), clean))
    }

    fn run(&self, id: &str, input: &Value) -> Result<Done, String> {
        let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        match id {
            COPY => self.copy_in(&text("path")),
            LIST => self.list(&text("path")).map(|t| (t, Vec::new())),
            READ => {
                let from = input.get("from_line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
                let lines = input.get("lines").and_then(Value::as_u64).map(|n| n as usize);
                self.read(&text("path"), from, lines).map(|t| (t, Vec::new()))
            }
            SEARCH => self.search(&text("text"), &text("path")).map(|t| (t, Vec::new())),
            WRITE => self.write(&text("path"), &text("content")),
            EDIT => self.edit(&text("path"), &text("old"), &text("new"), input.get("all").and_then(Value::as_bool).unwrap_or(false)),
            DELETE => self.delete(&text("path")).map(|t| (t, Vec::new())),
            _ => Err(format!("Unknown tool: {id}")),
        }
    }

    fn copy_in(&self, source: &str) -> Result<Done, String> {
        let source = source.trim().trim_matches('"');
        let from = Path::new(source);
        if !from.is_absolute() {
            return Err(format!("{source}: give the full path of the file or folder on the computer."));
        }
        let meta = std::fs::metadata(from).map_err(|_| not_found(from))?;
        let mut entries = self.manifest();
        // Copied already: the copy, perhaps changed, stays as it is.
        let same = |e: &Entry| Path::new(&e.original) == from || Path::new(&e.original).starts_with(from) && meta.is_dir();
        if let Some(e) = entries.iter().find(|e| same(e)) {
            let top = if meta.is_dir() { e.copy.split('/').next().unwrap_or(&e.copy).to_string() } else { e.copy.clone() };
            return Ok((format!("Already copied: {top} (your changes to it are kept)."), Vec::new()));
        }
        let name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "copy".into());
        let mut top = PathBuf::from(&name);
        for n in 2..1000 {
            if !self.dir.join(&top).exists() {
                break;
            }
            let p = Path::new(&name);
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            top = PathBuf::from(match p.extension() {
                Some(ext) if !meta.is_dir() => format!("{stem} ({n}).{}", ext.to_string_lossy()),
                _ => format!("{name} ({n})"),
            });
        }
        let mut files: Vec<(PathBuf, PathBuf)> = Vec::new();
        if meta.is_dir() {
            let mut total = 0u64;
            let mut stack = vec![(from.to_path_buf(), top.clone())];
            while let Some((src, rel)) = stack.pop() {
                let Ok(read) = std::fs::read_dir(&src) else { continue };
                std::fs::create_dir_all(self.dir.join(&rel)).map_err(|e| e.to_string())?;
                for item in read.flatten() {
                    let path = item.path();
                    let Ok(kind) = item.file_type() else { continue };
                    let item_name = item.file_name().to_string_lossy().to_string();
                    if kind.is_symlink() {
                        continue;
                    }
                    if kind.is_dir() {
                        if !SKIP_DIRS.contains(&item_name.as_str()) {
                            stack.push((path, rel.join(&item_name)));
                        }
                        continue;
                    }
                    let len = item.metadata().map(|m| m.len()).unwrap_or(0);
                    if len > MAX_FILE {
                        continue;
                    }
                    total += len;
                    if files.len() >= MAX_FILES || total > MAX_BYTES {
                        return Err(format!("{source} is too big to copy whole (past {MAX_FILES} files or {} MB): copy the folders or files you need.", MAX_BYTES / 1024 / 1024));
                    }
                    files.push((path, rel.join(&item_name)));
                }
            }
        } else {
            if meta.len() > MAX_FILE {
                return Err(format!("{source} is too big to copy (past {} MB).", MAX_FILE / 1024 / 1024));
            }
            files.push((from.to_path_buf(), top.clone()));
        }
        for (src, rel) in &files {
            let to = self.dir.join(rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(src, &to).map_err(|e| format!("{}: {e}", src.display()))?;
            entries.push(Entry { copy: rel_string(rel), original: src.to_string_lossy().to_string(), hash: hash_of(&to).unwrap_or(0) });
        }
        self.save_manifest(&entries)?;
        let top_name = rel_string(&top);
        let what = if meta.is_dir() { format!("{} files", files.len()) } else { "the file".into() };
        let touched = if meta.is_dir() { Vec::new() } else { vec![("read", self.dir.join(&top))] };
        Ok((format!("Copied {what} to {top_name} in your folder. Work on it there: {source} stays as it was. Read it (workspace_read, or workspace_list for a folder) before you answer about it or change it."), touched))
    }

    fn changed(&self, entries: &[Entry], rel: &str, full: &Path) -> Option<bool> {
        entries.iter().find(|e| e.copy == rel).map(|e| hash_of(full) != Some(e.hash))
    }

    fn list(&self, path: &str) -> Result<String, String> {
        let (start, rel) = if path.trim().is_empty() { (self.dir.clone(), PathBuf::new()) } else { self.inside(path)? };
        if !start.is_dir() {
            return Err(format!("{path}: no such folder in your folder."));
        }
        let entries = self.manifest();
        let mut out = Vec::new();
        let mut stack = vec![(start, rel)];
        while let Some((dir, rel)) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else { continue };
            let mut items: Vec<_> = read.flatten().collect();
            items.sort_by_key(|i| i.file_name());
            for item in items.into_iter().rev() {
                let name = item.file_name().to_string_lossy().to_string();
                if name == MANIFEST || item.file_type().is_ok_and(|k| k.is_symlink()) {
                    continue;
                }
                let item_rel = rel.join(&name);
                if item.file_type().is_ok_and(|k| k.is_dir()) {
                    out.push(format!("{}/", rel_string(&item_rel)));
                    stack.push((item.path(), item_rel));
                } else {
                    let size = item.metadata().map(|m| m.len()).unwrap_or(0);
                    let note = match self.changed(&entries, &rel_string(&item_rel), &item.path()) {
                        Some(true) => " (changed)",
                        Some(false) => "",
                        None => " (new)",
                    };
                    out.push(format!("{} ({size} bytes){note}", rel_string(&item_rel)));
                }
                if out.len() >= MAX_LIST {
                    out.push("…".into());
                    return Ok(out.join("\n"));
                }
            }
        }
        if out.is_empty() {
            return Ok(format!("Your folder is empty: copy a file or a folder in with {COPY}."));
        }
        out.sort();
        Ok(out.join("\n"))
    }

    fn read(&self, path: &str, from: usize, lines: Option<usize>) -> Result<String, String> {
        let (full, _) = self.inside(path)?;
        if full.is_dir() {
            return self.list(path);
        }
        let text = if full.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
            crate::pdf_text::text(&full.to_string_lossy(), 2_000_000).ok_or_else(|| format!("{path}: its text can't be read (a scan, or protected)."))?
        } else {
            let bytes = std::fs::read(&full).map_err(|_| format!("{path}: no such file in your folder."))?;
            String::from_utf8(bytes).map_err(|_| format!("{path} isn't text: it can't be read here."))?
        };
        let all: Vec<&str> = text.lines().collect();
        if from > all.len().max(1) {
            return Err(format!("{path} has {} lines.", all.len()));
        }
        let mut out = String::new();
        let mut last = from - 1;
        for (i, line) in all.iter().enumerate().skip(from - 1).take(lines.unwrap_or(usize::MAX)) {
            // Unpadded: a model that copies the text back drops "7| " and keeps no spaces.
            let next = format!("{}| {line}\n", i + 1);
            if out.len() + next.len() > MAX_READ {
                break;
            }
            out.push_str(&next);
            last = i + 1;
        }
        if last < all.len() {
            out.push_str(&format!("… {} lines in all: read on from line {}.", all.len(), last + 1));
        }
        Ok(out)
    }

    fn search(&self, words: &str, path: &str) -> Result<String, String> {
        let needle = words.trim().to_lowercase();
        if needle.is_empty() {
            return Err("Say what to find.".into());
        }
        let (start, rel) = if path.trim().is_empty() { (self.dir.clone(), PathBuf::new()) } else { self.inside(path)? };
        let mut hits = Vec::new();
        let mut stack = vec![(start, rel)];
        while let Some((at, rel)) = stack.pop() {
            if at.is_file() {
                let Ok(text) = std::fs::read_to_string(&at) else { continue };
                for (i, line) in text.lines().enumerate() {
                    if line.to_lowercase().contains(&needle) {
                        let line: String = line.trim().chars().take(200).collect();
                        hits.push(format!("{}:{}: {line}", rel_string(&rel), i + 1));
                        if hits.len() >= MAX_HITS {
                            hits.push("…".into());
                            return Ok(hits.join("\n"));
                        }
                    }
                }
                continue;
            }
            let Ok(read) = std::fs::read_dir(&at) else { continue };
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().to_string();
                if name != MANIFEST && !item.file_type().is_ok_and(|k| k.is_symlink()) {
                    stack.push((item.path(), rel.join(name)));
                }
            }
        }
        Ok(if hits.is_empty() { format!("\"{words}\" is nowhere in your folder.") } else { hits.join("\n") })
    }

    fn touched_kind(&self, rel: &Path) -> &'static str {
        if self.manifest().iter().any(|e| e.copy == rel_string(rel)) { "edited" } else { "created" }
    }

    fn write(&self, path: &str, content: &str) -> Result<Done, String> {
        let (full, rel) = self.inside(path)?;
        if rel.as_os_str().is_empty() || full.is_dir() {
            return Err(format!("{path} is a folder: name a file."));
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // The line numbers of workspace_read copied into the text go.
        let (content, numbered) = match without_line_numbers(content) {
            Some(plain) => (plain, true),
            None => (content.to_string(), false),
        };
        std::fs::write(&full, &content).map_err(|e| e.to_string())?;
        let kind = self.touched_kind(&rel);
        let note = if numbered { ", the line numbers of workspace_read left out" } else { "" };
        Ok((format!("Wrote {} in your folder ({} bytes{note}).", rel_string(&rel), content.len()), vec![(kind, full)]))
    }

    fn edit(&self, path: &str, old: &str, new: &str, all: bool) -> Result<Done, String> {
        let (full, rel) = self.inside(path)?;
        let text = std::fs::read_to_string(&full).map_err(|_| format!("{path}: no such text file in your folder."))?;
        if old.is_empty() {
            return Err("Say the text to replace.".into());
        }
        let found = text.matches(old).count();
        if found == 0 {
            return Err(format!("{path} doesn't hold that text: read it again and copy it exactly."));
        }
        if found > 1 && !all {
            return Err(format!("{path} holds that text {found} times: give more of it around, or all: true."));
        }
        let changed = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
        std::fs::write(&full, changed).map_err(|e| e.to_string())?;
        let kind = self.touched_kind(&rel);
        Ok((format!("Changed {} in your folder ({} {}).", rel_string(&rel), found.min(if all { found } else { 1 }), if found == 1 || !all { "place" } else { "places" }), vec![(kind, full)]))
    }

    fn delete(&self, path: &str) -> Result<String, String> {
        let (full, rel) = self.inside(path)?;
        if rel.as_os_str().is_empty() {
            return Err("Name what to delete in your folder.".into());
        }
        if full.is_dir() {
            std::fs::remove_dir_all(&full).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&full).map_err(|_| format!("{path}: no such file in your folder."))?;
        }
        let gone = rel_string(&rel);
        let entries: Vec<Entry> = self.manifest().into_iter().filter(|e| e.copy != gone && !e.copy.starts_with(&format!("{gone}/"))).collect();
        self.save_manifest(&entries)?;
        Ok(format!("Deleted {gone} from your folder (never the user's own)."))
    }

    fn changes(&self) -> Vec<Change> {
        let entries = self.manifest();
        let mut out = Vec::new();
        let mut stack = vec![(self.dir.clone(), PathBuf::new())];
        while let Some((at, rel)) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&at) else { continue };
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().to_string();
                if name == MANIFEST || item.file_type().is_ok_and(|k| k.is_symlink()) {
                    continue;
                }
                let item_rel = rel.join(&name);
                if item.file_type().is_ok_and(|k| k.is_dir()) {
                    stack.push((item.path(), item_rel));
                    continue;
                }
                let key = rel_string(&item_rel);
                match entries.iter().find(|e| e.copy == key) {
                    Some(e) if hash_of(&item.path()) != Some(e.hash) => out.push(Change { path: item.path().to_string_lossy().to_string(), original: Some(e.original.clone()) }),
                    Some(_) => {}
                    None => out.push(Change { path: item.path().to_string_lossy().to_string(), original: None }),
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    fn entry_of(&self, copy: &Path) -> Option<(Entry, PathBuf)> {
        let rel = copy.strip_prefix(&self.dir).ok()?;
        let key = rel_string(rel);
        self.manifest().into_iter().find(|e| e.copy == key).map(|e| (e, rel.to_path_buf()))
    }

    /// The copy over its original, after the user's click.
    fn put_back(&self, copy: &Path) -> Result<(), String> {
        let (entry, _) = self.entry_of(copy).ok_or("This file wasn't copied from the computer: there's nowhere to put it back.")?;
        let original = Path::new(&entry.original);
        let bytes = std::fs::read(copy).map_err(|e| e.to_string())?;
        if let Some(parent) = original.parent().filter(|_| !original.exists()) {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(original, &bytes).map_err(|e| e.to_string())?;
        // In place again: no longer a change.
        let key = entry.copy.clone();
        let entries: Vec<Entry> = self.manifest().into_iter().map(|mut e| {
            if e.copy == key {
                e.hash = fnv(&bytes);
            }
            e
        }).collect();
        self.save_manifest(&entries)?;
        Ok(())
    }
}

/// What changed in the chat's folder: the copies changed, the files made.
#[tauri::command(async)]
pub fn workspace_changes(chat: String) -> Vec<Change> {
    Workspace::new(dir(&chat)).changes()
}

/// The copy and its original, line by line, for the user to see before
/// putting it back: `-` the original's lines, `+` the copy's.
#[tauri::command(async)]
pub fn workspace_diff(chat: String, path: String) -> Result<Diff, String> {
    let ws = Workspace::new(dir(&chat));
    let (entry, _) = ws.entry_of(Path::new(&path)).ok_or("This file wasn't copied from the computer.")?;
    let before = std::fs::read_to_string(&entry.original).unwrap_or_default();
    let after = std::fs::read_to_string(&path).map_err(|_| "This copy isn't text: its changes can't be shown.".to_string())?;
    let (lines, numbers) = diff_numbered(&before, &after);
    let mut text: String = after.chars().take(DIFF_TEXT).collect();
    if text.len() < after.len() {
        text.push('…');
    }
    let mut was: String = before.chars().take(DIFF_TEXT).collect();
    if was.len() < before.len() {
        was.push('…');
    }
    Ok(Diff { original: entry.original, lines, numbers, before_lines: before.lines().count(), after_lines: after.lines().count(), text, before: was })
}

/// Writes the copy over its original, after the user's click.
#[tauri::command(async)]
pub fn workspace_put_back(chat: String, path: String) -> Result<(), String> {
    Workspace::new(dir(&chat)).put_back(Path::new(&path))
}

/// The chat's folder in File Explorer.
#[tauri::command(async)]
pub fn workspace_reveal(chat: String) {
    let d = dir(&chat);
    let _ = std::fs::create_dir_all(&d);
    crate::platform::reveal_folder(&d.to_string_lossy());
}

/// The chat is deleted: its folder too.
#[tauri::command(async)]
pub fn workspace_delete(chat: String) {
    delete(&chat);
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub original: String,
    /// " line", "-line", "+line", or "…" where unchanged lines are left out.
    pub lines: Vec<String>,
    /// Each line's number: in the original for "-", in the copy otherwise (0 for "…").
    pub numbers: Vec<usize>,
    /// How many lines the original and the copy have.
    pub before_lines: usize,
    pub after_lines: usize,
    /// The copy's text and the original's, at most DIFF_TEXT characters each:
    /// what is shown when the copy is rewritten.
    pub text: String,
    pub before: String,
}

/// The most lines compared line by line; past it, the whole of each is shown.
const DIFF_MAX: usize = 3_000;
/// The most characters of the copy's text sent along with its differences.
const DIFF_TEXT: usize = 20_000;

#[cfg(test)]
fn diff_lines(before: &str, after: &str) -> Vec<String> {
    diff_numbered(before, after).0
}

fn diff_numbered(before: &str, after: &str) -> (Vec<String>, Vec<usize>) {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    if a.len() > DIFF_MAX || b.len() > DIFF_MAX {
        let lines = a.iter().map(|l| format!("-{l}")).chain(b.iter().map(|l| format!("+{l}"))).take(2 * DIFF_MAX).collect();
        let numbers = (1..=a.len()).chain(1..=b.len()).take(2 * DIFF_MAX).collect();
        return (lines, numbers);
    }
    // The longest common lines (LCS), then the edit script.
    let mut lcs = vec![vec![0u16; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1].saturating_add(1) } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut script = Vec::new();
    let mut numbers = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            script.push(format!(" {}", a[i]));
            i += 1;
            j += 1;
            numbers.push(j);
        } else if i < a.len() && (j == b.len() || lcs[i + 1][j] >= lcs[i][j + 1]) {
            // What goes, before what comes in its place.
            script.push(format!("-{}", a[i]));
            i += 1;
            numbers.push(i);
        } else {
            script.push(format!("+{}", b[j]));
            j += 1;
            numbers.push(j);
        }
    }
    // Three lines of context around each change; the rest is "…".
    let near: Vec<bool> = (0..script.len()).map(|k| {
        let lo = k.saturating_sub(3);
        let hi = (k + 4).min(script.len());
        script[lo..hi].iter().any(|l| !l.starts_with(' '))
    }).collect();
    let mut out = Vec::new();
    let mut nums = Vec::new();
    for (k, line) in script.into_iter().enumerate() {
        if near[k] {
            out.push(line);
            nums.push(numbers[k]);
        } else if out.last().map(String::as_str) != Some("…") {
            out.push("…".into());
            nums.push(0);
        }
    }
    (out, nums)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_numbers_copied_from_a_read_are_left_out() {
        assert_eq!(without_line_numbers("    1| Lista\n    2| \n    3| il cane\n").as_deref(), Some("Lista\n\nil cane\n"));
        assert_eq!(without_line_numbers("   10| a\n   11| b").as_deref(), Some("a\nb"));
        assert_eq!(without_line_numbers("1| a\n3| b"), None);
        assert_eq!(without_line_numbers("a | b\nc | d"), None);
        assert_eq!(without_line_numbers("    1| sola"), None);
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lumo-ws-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_model_works_on_copies_inside_its_folder_only() {
        let base = temp("copies");
        let computer = base.join("computer");
        std::fs::create_dir_all(computer.join("proj/src")).unwrap();
        std::fs::create_dir_all(computer.join("proj/node_modules/x")).unwrap();
        std::fs::write(computer.join("notes.txt"), "uno\ndue\ntre\n").unwrap();
        std::fs::write(computer.join("proj/src/main.rs"), "fn main() {\n    println!(\"ciao\");\n}\n").unwrap();
        std::fs::write(computer.join("proj/node_modules/x/big.js"), "skip").unwrap();
        let ws = Workspace::new(base.join("ws"));
        std::fs::create_dir_all(&ws.dir).unwrap();

        let notes = computer.join("notes.txt").to_string_lossy().to_string();
        let (said, touched) = ws.run(COPY, &json!({ "path": notes })).unwrap();
        assert!(said.contains("notes.txt"), "{said}");
        assert_eq!(touched[0].0, "read");
        assert!(ws.run(COPY, &json!({ "path": notes })).unwrap().0.starts_with("Already copied"));
        let proj = computer.join("proj").to_string_lossy().to_string();
        assert!(ws.run(COPY, &json!({ "path": proj })).unwrap().0.contains("1 files"), "node_modules left out");

        let listed = ws.run(LIST, &json!({})).unwrap().0;
        assert!(listed.contains("notes.txt (12 bytes)") && listed.contains("proj/src/main.rs") && !listed.contains("node_modules"), "{listed}");
        assert_eq!(ws.run(READ, &json!({ "path": "notes.txt", "from_line": 2, "lines": 1 })).unwrap().0, "2| due\n… 3 lines in all: read on from line 3.");
        assert_eq!(ws.run(SEARCH, &json!({ "text": "CIAO" })).unwrap().0, "proj/src/main.rs:2: println!(\"ciao\");");

        // Changing a copy never touches the original.
        let (_, touched) = ws.run(EDIT, &json!({ "path": "notes.txt", "old": "due", "new": "DUE" })).unwrap();
        assert_eq!(touched[0].0, "edited");
        assert_eq!(std::fs::read_to_string(computer.join("notes.txt")).unwrap(), "uno\ndue\ntre\n");
        assert!(ws.run(EDIT, &json!({ "path": "notes.txt", "old": "nope", "new": "x" })).is_err());
        let (_, touched) = ws.run(WRITE, &json!({ "path": "out/summary.md", "content": "# Sum" })).unwrap();
        assert_eq!(touched[0].0, "created");
        assert!(ws.run(LIST, &json!({})).unwrap().0.contains("notes.txt (12 bytes) (changed)"));

        // What changed: the edited copy (with its original), the new file.
        let changes = ws.changes();
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().any(|c| c.path.ends_with("notes.txt") && c.original.as_deref() == Some(notes.as_str())));
        assert!(changes.iter().any(|c| c.path.ends_with("summary.md") && c.original.is_none()));

        // Written over the original, with nothing left beside it.
        let copy = ws.dir.join("notes.txt");
        ws.put_back(&copy).unwrap();
        assert_eq!(std::fs::read_dir(&computer).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".bak")).count(), 0);
        assert_eq!(std::fs::read_to_string(computer.join("notes.txt")).unwrap(), "uno\nDUE\ntre\n");
        assert_eq!(ws.changes().len(), 1, "back in place, no longer a change");
        assert!(ws.put_back(&ws.dir.join("out/summary.md")).is_err());

        assert!(ws.run(DELETE, &json!({ "path": "proj" })).is_ok());
        assert!(!ws.dir.join("proj").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn no_path_leaves_the_folder() {
        let base = temp("escape");
        let ws = Workspace::new(base.join("ws"));
        std::fs::create_dir_all(&ws.dir).unwrap();
        std::fs::write(base.join("secret.txt"), "no").unwrap();
        for bad in ["../secret.txt", "a/../../secret.txt", "C:\\Windows\\win.ini", "/etc/passwd", "notes.txt:hidden", MANIFEST] {
            assert!(ws.inside(bad).is_err(), "{bad}");
            assert!(ws.run(READ, &json!({ "path": bad })).is_err(), "{bad}");
            assert!(ws.run(WRITE, &json!({ "path": bad, "content": "x" })).is_err(), "{bad}");
        }
        assert!(ws.run(DELETE, &json!({ "path": "" })).is_err());
        // Its own full path is inside.
        let own = ws.dir.join("a.txt").to_string_lossy().to_string();
        assert!(ws.run(WRITE, &json!({ "path": own, "content": "ok" })).is_ok());
        assert!(ws.dir.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(base.join("secret.txt")).unwrap(), "no");
        assert!(ws.run(COPY, &json!({ "path": "relative.txt" })).is_err());
        // A path that isn't there says what its folder holds.
        let missing = base.join("Riccardo").join("file.txt").to_string_lossy().to_string();
        let said = ws.run(COPY, &json!({ "path": missing })).unwrap_err();
        assert!(said.contains("doesn't exist") && said.contains("secret.txt") && said.contains("ws"), "{said}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn the_differences_show_what_changed_with_a_little_around_it() {
        let before = (1..=20).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        let after = before.replace("10", "dieci");
        assert_eq!(diff_lines(&before, &after), ["…", " 7", " 8", " 9", "-10", "+dieci", " 11", " 12", " 13", "…"]);
        assert_eq!(diff_lines("a", "a\nb"), [" a", "+b"]);
        assert_eq!(diff_numbered("a\nb\nc", "a\nB\nc").1, [1, 2, 2, 3]);
        assert_eq!(safe_id("chat-1/../x"), "chat-1____x");
    }
}
