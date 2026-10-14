// Gemini Live's move_files: moving, renaming and sorting the user's files into
// folders ("tidy up my Downloads"), in three steps that keep the user in hand:
//
// 1. `plan`: what would happen, checked but not done. The model reads it to
//    the user and waits for their yes.
// 2. `apply`: the plan the user agreed to, by its id, and only that plan.
// 3. `undo`: the last plan applied, put back as it was.
//
// Nothing is ever deleted or overwritten: a file whose new place is taken
// stays where it is, and the plan says so before anything moves. Only files in
// the user's home folder are touched, never the hidden app data in it
// (AppData) nor anything outside (Windows, Program Files, other drives' roots).
// Plans live in memory only: a restart forgets them.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A tidy-up, not a migration.
pub const MAX_STEPS: usize = 300;

/// What the model asks: `to` is the new full path, or a folder to move into.
#[derive(Debug, Clone, Deserialize)]
pub struct Ask {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Step {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: u32,
    pub moves: Vec<Step>,
    /// Folders made first.
    pub new_folders: Vec<String>,
    /// What can't be done, and why; the rest of the plan stands.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub moved: usize,
    pub new_folders: usize,
    pub failed: Vec<String>,
}

#[derive(Default)]
struct Store {
    next: u32,
    pending: Option<Plan>,
    /// The last plan applied: what moved (from → to) and the folders made.
    done: Option<(Vec<Step>, Vec<String>)>,
}

static STORE: Mutex<Store> = Mutex::new(Store { next: 1, pending: None, done: None });

fn show(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A path we may touch: inside `home`, outside its AppData, with no `..`.
pub fn allowed(path: &Path, home: &Path) -> bool {
    use std::path::Component;
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let Ok(rest) = path.strip_prefix(home) else { return false };
    let first = rest.components().next().map(|c| c.as_os_str().to_string_lossy().to_lowercase());
    match first {
        None => false,
        Some(f) => f != "appdata" && !f.starts_with('.'),
    }
}

fn path_of(raw: &str) -> Option<PathBuf> {
    crate::live::full_path(raw)
}

/// Checks what was asked and writes the plan, doing nothing. `home` is the
/// user's home folder; the plan replaces any plan still waiting.
pub fn plan_in(asks: &[Ask], folders: &[String], home: &Path) -> Result<Plan, String> {
    if asks.is_empty() && folders.is_empty() {
        return Err("Say what to move, or which folders to make.".into());
    }
    if asks.len() + folders.len() > MAX_STEPS {
        return Err(format!("That is more than {MAX_STEPS} changes at once: do it in parts."));
    }
    let mut skipped = Vec::new();
    let mut new_folders: Vec<PathBuf> = Vec::new();
    for raw in folders {
        match path_of(raw) {
            Some(p) if allowed(&p, home) => {
                if p.is_dir() || new_folders.contains(&p) {
                    continue;
                }
                if p.exists() {
                    skipped.push(format!("{}: a file already has that name.", show(&p)));
                } else {
                    new_folders.push(p);
                }
            }
            _ => skipped.push(format!("{raw}: only folders in the user's home folder can be made.")),
        }
    }
    let will_be_dir = |p: &Path| p.is_dir() || new_folders.iter().any(|f| f == p);
    let mut moves: Vec<Step> = Vec::new();
    let mut taken: Vec<PathBuf> = Vec::new();
    for ask in asks {
        let (Some(from), Some(to)) = (path_of(&ask.from), path_of(&ask.to)) else {
            skipped.push(format!("{} → {}: paths must be absolute.", ask.from, ask.to));
            continue;
        };
        if !allowed(&from, home) || !allowed(&to, home) {
            skipped.push(format!("{}: only files in the user's home folder can be moved.", show(&from)));
            continue;
        }
        if !from.exists() {
            skipped.push(format!("{}: there is no such file or folder.", show(&from)));
            continue;
        }
        let Some(name) = from.file_name() else { continue };
        let dest = if will_be_dir(&to) { to.join(name) } else { to };
        if dest == from {
            continue;
        }
        if dest.starts_with(&from) {
            skipped.push(format!("{}: a folder can't go inside itself.", show(&from)));
            continue;
        }
        let parent_ok = dest.parent().is_some_and(will_be_dir);
        if !parent_ok {
            skipped.push(format!("{}: the folder it would go to doesn't exist; add it to the folders to make.", show(&dest)));
            continue;
        }
        if dest.exists() || taken.contains(&dest) {
            skipped.push(format!("{}: something already has that name there, and nothing is overwritten.", show(&dest)));
            continue;
        }
        taken.push(dest.clone());
        moves.push(Step { from: show(&from), to: show(&dest) });
    }
    if moves.is_empty() && new_folders.is_empty() {
        return Err(if skipped.is_empty() { "There is nothing to change.".into() } else { skipped.join(" ") });
    }
    let mut s = STORE.lock().unwrap();
    let id = s.next;
    s.next += 1;
    let plan = Plan { id, moves, new_folders: new_folders.iter().map(|p| show(p)).collect(), skipped };
    s.pending = Some(plan.clone());
    Ok(plan)
}

/// Moves one file or folder; across drives a file is copied, checked, then
/// the original removed (a folder across drives is refused).
fn move_one(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err("something already has that name".into());
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        return Err("a folder can't be moved to another drive this way".into());
    }
    let size = std::fs::metadata(from).map_err(|e| e.to_string())?.len();
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    if std::fs::metadata(to).map(|m| m.len()).ok() != Some(size) {
        let _ = std::fs::remove_file(to);
        return Err("the copy came out different".into());
    }
    std::fs::remove_file(from).map_err(|e| e.to_string())
}

/// Does the waiting plan `id`, the one the user agreed to.
pub fn apply(id: u32) -> Result<Applied, String> {
    let plan = {
        let mut s = STORE.lock().unwrap();
        match s.pending.take() {
            Some(p) if p.id == id => p,
            other => {
                s.pending = other;
                return Err("That plan is no longer waiting: make a new one with move_files and read it to the user first.".into());
            }
        }
    };
    let mut made = Vec::new();
    let mut failed = Vec::new();
    for f in &plan.new_folders {
        match std::fs::create_dir_all(f) {
            Ok(()) => made.push(f.clone()),
            Err(e) => failed.push(format!("{f}: {e}")),
        }
    }
    let mut moved = Vec::new();
    for step in &plan.moves {
        match move_one(Path::new(&step.from), Path::new(&step.to)) {
            Ok(()) => moved.push(step.clone()),
            Err(e) => failed.push(format!("{}: {e}", step.from)),
        }
    }
    let result = Applied { moved: moved.len(), new_folders: made.len(), failed };
    STORE.lock().unwrap().done = Some((moved, made));
    Ok(result)
}

/// Puts the last plan applied back: files where they were, the folders it
/// made removed if they are empty again.
pub fn undo() -> Result<Applied, String> {
    let (moved, made) = STORE.lock().unwrap().done.take().ok_or("Nothing was moved during this session, or it was already put back.")?;
    let mut failed = Vec::new();
    let mut back = 0;
    for step in moved.iter().rev() {
        match move_one(Path::new(&step.to), Path::new(&step.from)) {
            Ok(()) => back += 1,
            Err(e) => failed.push(format!("{}: {e}", step.to)),
        }
    }
    let mut removed = 0;
    for f in made.iter().rev() {
        // remove_dir only removes an empty folder.
        if std::fs::remove_dir(f).is_ok() {
            removed += 1;
        }
    }
    Ok(Applied { moved: back, new_folders: removed, failed })
}

#[tauri::command]
pub async fn pc_files_plan(moves: Vec<Ask>, folders: Vec<String>) -> Result<Plan, String> {
    let home = crate::platform::home_dir();
    tauri::async_runtime::spawn_blocking(move || plan_in(&moves, &folders, &home)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pc_files_apply(id: u32) -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(move || apply(id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pc_files_undo() -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(undo).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(from: &Path, to: &Path) -> Ask {
        Ask { from: show(from), to: show(to) }
    }

    #[test]
    fn only_the_users_own_files_are_touched() {
        let home = Path::new(r"C:\Users\ana");
        assert!(allowed(&home.join("Downloads").join("a.pdf"), home));
        assert!(!allowed(home, home), "not the home folder itself");
        assert!(!allowed(&home.join("AppData").join("x"), home));
        assert!(!allowed(&home.join(".ssh").join("id"), home));
        assert!(!allowed(Path::new(r"C:\Windows\System32"), home));
        assert!(!allowed(&home.join("Downloads").join("..").join("AppData"), home));
    }

    // One test, as the plans share one store.
    #[test]
    fn a_plan_is_checked_first_applied_once_and_can_be_undone() {
        let home = std::env::temp_dir().join(format!("lumo-moves-{}", std::process::id()));
        let downloads = home.join("Downloads");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("a.pdf"), b"pdf").unwrap();
        std::fs::write(downloads.join("b.jpg"), b"jpg").unwrap();
        std::fs::write(downloads.join("taken.txt"), b"1").unwrap();
        let docs = downloads.join("PDF");
        std::fs::create_dir_all(downloads.join("Old")).unwrap();
        std::fs::write(downloads.join("Old").join("taken.txt"), b"2").unwrap();

        let plan = plan_in(
            &[
                ask(&downloads.join("a.pdf"), &docs),
                ask(&downloads.join("b.jpg"), &downloads.join("photo.jpg")),
                ask(&downloads.join("taken.txt"), &downloads.join("Old")),
                ask(&downloads.join("missing.txt"), &docs),
                ask(&downloads.join("a.pdf"), Path::new(r"C:\Windows")),
                ask(&downloads.join("Old"), &downloads.join("Old").join("inner")),
            ],
            &[show(&docs)],
            &home,
        )
        .unwrap();
        assert_eq!(plan.new_folders, [show(&docs)]);
        assert_eq!(plan.moves.len(), 2);
        assert_eq!(plan.moves[0].to, show(&docs.join("a.pdf")));
        assert_eq!(plan.skipped.len(), 4, "{:?}", plan.skipped);
        assert!(downloads.join("a.pdf").exists(), "a plan does nothing");

        assert!(apply(plan.id + 1).is_err(), "only the plan read to the user");
        let done = apply(plan.id).unwrap();
        assert_eq!((done.moved, done.new_folders), (2, 1));
        assert!(docs.join("a.pdf").exists() && downloads.join("photo.jpg").exists());
        assert_eq!(std::fs::read(downloads.join("Old").join("taken.txt")).unwrap(), b"2", "never overwritten");
        assert!(apply(plan.id).is_err(), "once");

        let back = undo().unwrap();
        assert_eq!((back.moved, back.new_folders), (2, 1));
        assert!(downloads.join("a.pdf").exists() && downloads.join("b.jpg").exists());
        assert!(!docs.exists());
        assert!(undo().is_err());

        assert!(plan_in(&[], &[], &home).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
