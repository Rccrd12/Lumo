// The Email pill's other source: the classic Outlook on this PC (Office,
// Microsoft 365), read through its own automation (COM), with no password and
// nothing on the network from Lumo. Outlook already has the accounts and
// keeps the mail in sync; Lumo asks it, on a thread of its own, what the
// inboxes hold.
//
// Lumo attaches to the Outlook already running (GetActiveObject) and never
// starts it, but for one case: Settings → Security → "Open Outlook if it's
// closed", where it starts Outlook once, in the background with no window,
// a minute after Lumo starts (or when the switch is turned on). If the user
// then closes Outlook, Lumo doesn't start it again until it next starts.
//
// It reads as the IMAP side does (mail.rs): the newest unread emails of each
// account's inbox for the island, and for the agents the newest emails of a
// folder, a search, one email in full with its files, the folders. Reading
// never marks anything read. Sending, replying, forwarding go out of Outlook
// (so they land in its Sent Items), each only after the user's click on the
// email's card; marking, moving, archiving and trashing too, each on its own
// card. Nothing here deletes an email for good: the trash is Deleted Items.
//
// What Outlook guards (the sender, the text, the headers) is read through
// MAPI (outlook_mapi.rs), never through the automation, which would make
// Outlook ask the user "A program is trying to access e-mail address
// information" at each look. Writing an email still goes through the
// automation: Outlook may ask then, only after the user's click.
//
// The "new Outlook" for Windows has no automation: with it, only IMAP works.

use std::collections::HashMap;
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use ::windows::core::{w, IUnknown, Interface, BSTR, GUID, HSTRING, PCWSTR};
use ::windows::Win32::Foundation::SYSTEMTIME;
use ::windows::Win32::System::Com::{
    CLSIDFromProgID, CoCreateInstance, CoInitializeEx, IDispatch, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, DISPATCH_FLAGS,
    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPATCH_PROPERTYPUTREF, DISPPARAMS, EXCEPINFO,
};
use ::windows::Win32::System::Ole::{GetActiveObject, DISPID_PROPERTYPUT};
use ::windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
use ::windows::Win32::System::Variant::{VARIANT, VT_DATE, VT_DISPATCH};

use crate::log;
use crate::mail::{Found, Message};
use crate::outlook_mapi::{Guarded, Mapi};

/// What the agents' ids of an Outlook email start with ("outlook-12"), what
/// its folders' names start with ("outlook:ada@outlook.it/Inbox"), and the
/// island's link that opens one in Outlook ("lumo-outlook:12").
pub const ID_PREFIX: &str = "outlook-";
pub const FOLDER_PREFIX: &str = "outlook:";
pub const LINK_PREFIX: &str = "lumo-outlook:";

/// Outlook answers within this, or the step fails (a window of Outlook's
/// own, a security prompt, may be waiting for the user).
const STEP: Duration = Duration::from_secs(25);
/// Steps that walk folders or fetch files.
const SLOW_STEP: Duration = Duration::from_secs(55);
/// Unread emails looked at per inbox when the promotional ones are left out.
const PROMO_LOOK: i32 = 30;
/// At most this many folders listed, searched or walked.
const MOST_FOLDERS: usize = 200;
const MOST_SEARCHED: usize = 60;
/// How deep folders are walked.
const DEPTH: usize = 6;

// Outlook's own numbers (the OlDefaultFolders, OlObjectClass… enumerations).
const FOLDER_DELETED: i32 = 3;
const FOLDER_OUTBOX: i32 = 4;
const FOLDER_SENT: i32 = 5;
const FOLDER_INBOX: i32 = 6;
const FOLDER_DRAFTS: i32 = 16;
const FOLDER_JUNK: i32 = 23;
const MAIL_ITEM: i32 = 0;
const TO: i32 = 1;
const CC: i32 = 2;
const FORMAT_HTML: i32 = 2;
const MARK_NO_DATE: i32 = 4;
const DISCARD: i32 = 1;
const PUBLIC_FOLDERS: i32 = 2;
/// The date Outlook gives for "none" (1 January 4501).
const NO_DATE: f64 = 949_998.0;

// ── The settings ──────────────────────────────────────────────────────────────

/// Settings → Pills → Email → "Outlook on this PC".
pub fn on(app: &AppHandle) -> bool {
    crate::integrations::enabled(app, crate::mail::ID)
        && app.try_state::<crate::Shared>().is_some_and(|s| s.settings.lock().unwrap().mail_outlook)
}

/// Settings → Security → "Open Outlook if it's closed".
fn may_start(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>().is_some_and(|s| s.settings.lock().unwrap().outlook_start)
}

// ── Watching the inboxes ──────────────────────────────────────────────────────

static WAKE: Notify = Notify::const_new();
/// Lumo started Outlook already (or tried to) since it started: never again.
static STARTED: AtomicBool = AtomicBool::new(false);
/// "Open Outlook if it's closed" waits this long after Lumo starts: classic
/// Outlook takes the disk and the processor for a while as it opens, and Lumo's
/// own start (its webviews, the greeting) should not have to share them.
/// An Outlook already running is read at once, as before.
const START_AFTER: Duration = Duration::from_secs(60);

/// How long is still left of START_AFTER, `since` Lumo started.
fn start_wait(since: Duration) -> Option<Duration> {
    START_AFTER.checked_sub(since).filter(|left| !left.is_zero())
}

/// Look again now (Refresh, a change of settings).
pub fn wake() {
    WAKE.notify_one();
}

/// The newest unread emails of every account's inbox, while the pill and
/// "Outlook on this PC" are on, looked at as often as the IMAP side does
/// (mail.rs, idle_for). Outlook closed is not an error: the island says so,
/// and the emails come back as soon as it opens.
pub async fn run(app: AppHandle) {
    let launched = Instant::now();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let mut seen: Option<f64> = None;
    let mut cache: HashMap<String, (Message, f64)> = HashMap::new();
    let mut failures = 0u32;
    let mut was_on = false;
    loop {
        if !on(&app) || crate::integrations::PAUSED.load(Ordering::Relaxed) {
            if was_on {
                // Outlook stays as the user left it: only Lumo's hold on it goes.
                let _ = with_outlook(STEP, |s| {
                    s.let_go();
                    Ok(())
                })
                .await;
                crate::mail::from_outlook(&app, None, Vec::new());
                was_on = false;
            }
            seen = None;
            cache.clear();
            let _ = tokio::time::timeout(Duration::from_secs(60), WAKE.notified()).await;
            continue;
        }
        was_on = true;
        if may_start(&app) && !STARTED.load(Ordering::SeqCst) {
            if let Some(left) = start_wait(launched.elapsed()) {
                let running = with_outlook(STEP, |s| Ok(s.app()?.is_some())).await.unwrap_or(false);
                if !running {
                    // Then round again: the switches may have changed meanwhile.
                    tokio::time::sleep(left).await;
                    continue;
                }
            }
        }
        if may_start(&app) && !STARTED.swap(true, Ordering::SeqCst) {
            match with_outlook(SLOW_STEP, |s| s.start()).await {
                Ok(true) => log::line("[outlook] started in the background"),
                Ok(false) => {}
                Err(e) => log::line(format!("[outlook] could not start: {e}")),
            }
        }
        let hide = crate::mail::hides_promotions(&app);
        let known: HashMap<String, (Message, f64)> = cache.clone();
        let looked = with_outlook(STEP, move |s| s.look(hide, known)).await;
        match looked {
            Ok(Some(inbox)) => {
                failures = 0;
                let newest = inbox.messages.iter().map(|(_, at)| *at).fold(seen.unwrap_or(0.0), f64::max);
                let fresh: Vec<Message> = match seen {
                    Some(before) => inbox.messages.iter().filter(|(_, at)| *at > before).map(|(m, _)| m.clone()).collect(),
                    None => Vec::new(),
                };
                seen = Some(newest);
                cache = cache_of(&inbox);
                let messages = inbox.messages.into_iter().map(|(m, _)| m).collect();
                crate::mail::from_outlook(&app, Some(Ok((inbox.unread, messages))), fresh);
            }
            Ok(None) => {
                failures = 0;
                cache.clear();
                crate::mail::from_outlook(&app, Some(Err(closed_text())), Vec::new());
            }
            Err(e) => {
                failures += 1;
                log::line(format!("[outlook] {e}"));
                let shown = if e == not_installed() {
                    crate::i18n::t("Classic Outlook isn't installed on this PC. The new Outlook can't be read by other apps: use IMAP.")
                } else {
                    crate::i18n::t("Lumo couldn't read Outlook. It tries again in a moment.")
                };
                if failures >= 2 || e == not_installed() {
                    crate::mail::from_outlook(&app, Some(Err(shown)), Vec::new());
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(crate::energy::pick(5, 20, 60)), WAKE.notified()).await;
    }
}

fn closed_text() -> String {
    crate::i18n::t("Outlook is closed: the emails come back as soon as you open it.")
}

// ── For Settings ──────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Classic Outlook is installed.
    pub installed: bool,
    /// It is running, and Lumo reaches it.
    pub running: bool,
    /// Its accounts' addresses.
    pub accounts: Vec<String>,
}

/// What Settings → Pills → Email shows under "Outlook on this PC". Asks
/// Outlook only when it is already running: it never starts it.
#[tauri::command]
pub async fn outlook_status() -> Status {
    with_outlook(STEP, |s| {
        if !installed() {
            return Ok(Status::default());
        }
        let Some(app) = s.app()? else { return Ok(Status { installed: true, ..Default::default() }) };
        let accounts = accounts(&app)?.into_iter().map(|a| a.address).collect();
        Ok(Status { installed: true, running: true, accounts })
    })
    .await
    .unwrap_or_default()
}

// ── For the agents ────────────────────────────────────────────────────────────

/// Whether Outlook is running now (it is never started for this).
pub async fn running() -> bool {
    with_outlook(STEP, |s| Ok(s.app()?.is_some())).await.unwrap_or(false)
}

/// The newest `count` emails of the inboxes (or of `folder`), read or not
/// (or only the unread ones).
pub async fn newest(count: usize, unread_only: bool, folder: Option<String>) -> Result<Vec<Found>, String> {
    with_outlook(SLOW_STEP, move |s| {
        let app = s.running()?;
        let places = match folder.as_deref() {
            None => inboxes(&app)?,
            Some(asked) => places_named(&app, asked)?,
        };
        let mut found = Vec::new();
        for place in &places {
            let items = place.folder.obj("Items")?;
            let items = if unread_only { items.call("Restrict", vec!["[UnRead] = True".into()])?.dispatch()? } else { items };
            found.extend(newest_of(s, &items, count)?);
        }
        Ok(newest_first(found, count))
    })
    .await
}

/// The newest `count` emails that match `query`: in `folder` when given, else
/// in every mail folder but Deleted Items, Junk and the Outbox.
pub async fn search(query: String, count: usize, folder: Option<String>) -> Result<Vec<Found>, String> {
    let filter = dasl_filter(&query).ok_or_else(|| "Say what to search for.".to_string())?;
    with_outlook(SLOW_STEP, move |s| {
        let app = s.running()?;
        let places = match folder.as_deref() {
            Some(asked) => places_named(&app, asked)?,
            None => all_places(&app)?
                .into_iter()
                .filter(|p| !matches!(p.role, Some(Role::Trash | Role::Junk | Role::Outbox)))
                .take(MOST_SEARCHED)
                .collect(),
        };
        let mut found = Vec::new();
        for place in &places {
            let Ok(items) = place.folder.obj("Items") else { continue };
            let Ok(matched) = items.call("Restrict", vec![filter.as_str().into()]).and_then(|v| v.dispatch()) else { continue };
            found.extend(newest_of(s, &matched, count)?);
        }
        Ok(newest_first(found, count))
    })
    .await
}

/// A file attached to an email: its name, type and size.
pub struct File {
    pub name: String,
    pub mime: &'static str,
    pub size: usize,
}

/// One email in full, with its files.
pub async fn read(id: String, chars: usize) -> Result<(Found, Vec<File>), String> {
    with_outlook(STEP, move |s| {
        let app = s.running()?;
        let item = item_of(&app, &id)?;
        let found = found_of(s, &item, &id, chars);
        let files = files_of(&item)?;
        Ok((found, files))
    })
    .await
}

/// The HTML of email `id` for the island's Email view, through MAPI (no
/// prompt), with the pictures its attachments hold for it (`cid:`) and the
/// code page Outlook keeps it in (`InternetCodepage`, 0 when unknown): no HTML
/// when it has none, or MAPI can't be had (the view keeps the text).
pub async fn html(id: String, bytes: usize, picture: usize, pictures: usize) -> Result<(Vec<u8>, crate::outlook_mapi::Pictures, u32), String> {
    with_outlook(STEP, move |s| {
        let app = s.running()?;
        let item = item_of(&app, &id)?;
        let store = item.obj("Parent").map(|p| p.text("StoreID")).unwrap_or_default();
        let entry = item.text("EntryID");
        let codepage = item.int("InternetCodepage").ok().and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
        let mapi = s.mapi.get_or_insert_with(Mapi::logon).as_mut();
        let (html, inline) = mapi.and_then(|m| m.html(&store, &entry, bytes, picture, pictures)).unwrap_or_default();
        Ok((html, inline, codepage))
    })
    .await
}

/// `mail_folders`: every mail folder, what it is for, how many emails.
pub async fn folders() -> Result<String, String> {
    with_outlook(SLOW_STEP, |s| {
        let app = s.running()?;
        let mut out = String::new();
        for p in all_places(&app)? {
            out.push_str(&format!("- {FOLDER_PREFIX}{}", p.path));
            if let Some(role) = p.role {
                out.push_str(&format!(" ({})", role.word()));
            }
            let all = p.folder.obj("Items").and_then(|i| i.int("Count")).unwrap_or(0);
            let unread = p.folder.int("UnReadItemCount").unwrap_or(0);
            out.push_str(&format!(": {all} emails, {unread} unread\n"));
        }
        Ok(out)
    })
    .await
}

/// `mail_attachment`: one of the email's files, saved with the chat's files.
pub async fn save_attachment(id: String, which: Option<serde_json::Value>) -> Result<String, String> {
    let (name, bytes) = with_outlook(SLOW_STEP, move |s| {
        let app = s.running()?;
        let item = item_of(&app, &id)?;
        let files = files_of(&item)?;
        let n = pick(&files, which.as_ref())?;
        let file = &files[n];
        if file.size > crate::mail::MAX_ATTACHMENT_BYTES {
            return Err(format!("{} is too big for Lumo to fetch.", file.name));
        }
        let attachment = item.obj("Attachments")?.call("Item", vec![(n as i32 + 1).into()])?.dispatch()?;
        let temp = std::env::temp_dir().join(format!("lumo-outlook-{}-{}", std::process::id(), next_token()));
        attachment.call("SaveAsFile", vec![temp.to_string_lossy().as_ref().into()])?;
        let bytes = std::fs::read(&temp).map_err(|e| format!("Lumo couldn't read {}: {e}", file.name));
        let _ = std::fs::remove_file(&temp);
        Ok((file.name.clone(), bytes?))
    })
    .await?;
    let saved = crate::files::write_in(&name, &bytes)?;
    log::line(format!("[outlook] a file of an email saved for the chat ({} bytes)", saved.size));
    Ok(format!(
        "Saved {} ({}) with the files attached to the chat: {}. Read it from there.",
        saved.name,
        crate::mail::size_text(saved.size as usize),
        saved.path
    ))
}

/// Which file the agent asked for: its number in mail_read's list, or its name.
fn pick(files: &[File], which: Option<&serde_json::Value>) -> Result<usize, String> {
    if files.is_empty() {
        return Err("This email has no files attached.".into());
    }
    let nth = |n: u64| (n as usize).checked_sub(1).filter(|i| *i < files.len());
    let found = match which {
        None | Some(serde_json::Value::Null) if files.len() == 1 => Some(0),
        Some(serde_json::Value::Number(n)) => n.as_u64().and_then(nth),
        Some(serde_json::Value::String(s)) => match s.trim().parse::<u64>() {
            Ok(n) => nth(n),
            Err(_) => files.iter().position(|f| f.name.eq_ignore_ascii_case(s.trim())),
        },
        _ => None,
    };
    found.ok_or_else(|| format!("Say which file: its number in mail_read's list (1 to {}) or its name.", files.len()))
}

// ── Writing ───────────────────────────────────────────────────────────────────

/// An email the AI wrote: a new one, a reply or a forward.
pub enum Draft {
    New { to: Vec<String>, cc: Vec<String> },
    Reply { id: String, all: bool, cc: Vec<String> },
    Forward { id: String, to: Vec<String>, cc: Vec<String>, with_files: bool },
}

/// The email as Outlook made it, for its card: Outlook keeps it until the
/// user clicks Send (it goes) or not (it is thrown away).
pub struct Made {
    token: u64,
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// Each file: its name, its size, and the path it came from (none for the email's own).
    pub files: Vec<serde_json::Value>,
}

/// Makes the email in Outlook, without sending it: the text, the people,
/// the files (paths already checked by mail.rs).
pub async fn make(draft: Draft, subject: String, text: String, paths: Vec<String>) -> Result<Made, String> {
    with_outlook(SLOW_STEP, move |s| {
        let app = s.running()?;
        let (item, account) = match &draft {
            Draft::New { .. } => (app.call("CreateItem", vec![MAIL_ITEM.into()])?.dispatch()?, default_account(&app)),
            Draft::Reply { id, all, .. } => {
                let original = item_of(&app, id)?;
                let reply = original.call(if *all { "ReplyAll" } else { "Reply" }, vec![])?.dispatch()?;
                (reply, account_of(&app, &original))
            }
            Draft::Forward { id, .. } => {
                let original = item_of(&app, id)?;
                (original.call("Forward", vec![])?.dispatch()?, account_of(&app, &original))
            }
        };
        match fill(&item, account, &draft, &subject, &text, &paths) {
            Ok(mut made) => {
                made.token = next_token();
                s.pending.insert(made.token, item);
                Ok(made)
            }
            Err(e) => {
                throw_away(&item);
                Err(e)
            }
        }
    })
    .await
}

/// The email's people, words and files, put in Outlook's item.
fn fill(item: &Disp, account: Option<Account>, draft: &Draft, subject: &str, text: &str, paths: &[String]) -> Result<Made, String> {
    if let Some(account) = &account {
        // Outlook would send a reply from the default account otherwise.
        let _ = item.put_ref("SendUsingAccount", account.disp.clone_variant());
    }
    let recipients = item.obj("Recipients")?;
    let add = |address: &str, kind: i32| -> Result<(), String> {
        let r = recipients.call("Add", vec![address.into()])?.dispatch()?;
        r.put("Type", kind.into())
    };
    match draft {
        Draft::New { to, cc } | Draft::Forward { to, cc, .. } => {
            for a in to {
                add(a, TO)?;
            }
            for a in cc {
                add(a, CC)?;
            }
        }
        Draft::Reply { cc, .. } => {
            let already = people(item)?;
            for a in cc {
                if !already.0.iter().chain(&already.1).any(|b| b.eq_ignore_ascii_case(a)) {
                    add(a, CC)?;
                }
            }
        }
    }
    let _ = recipients.call("ResolveAll", vec![]);
    if let Draft::New { .. } = *draft {
        item.put("Subject", subject.into())?;
        item.put("Body", text.into())?;
    } else {
        write_above(item, text)?;
    }
    if let Draft::Forward { with_files: false, .. } = *draft {
        let attachments = item.obj("Attachments")?;
        while attachments.int("Count")? > 0 {
            attachments.call("Remove", vec![1.into()])?;
        }
    }
    let own = item.obj("Attachments")?.int("Count")?.max(0) as usize;
    for path in paths {
        item.obj("Attachments")?.call("Add", vec![path.as_str().into()])?;
    }
    let (to, cc) = people(item)?;
    if to.len() + cc.len() > crate::smtp::MAX_RECIPIENTS {
        return Err(format!("At most {} people, to and cc together.", crate::smtp::MAX_RECIPIENTS));
    }
    let listed = files_of(item)?;
    let total: usize = listed.iter().map(|f| f.size).sum();
    if total as u64 > crate::smtp::MAX_ATTACHED_BYTES {
        return Err(crate::mail::too_heavy());
    }
    let files = listed
        .iter()
        .enumerate()
        .map(|(i, f)| json!({ "name": f.name, "size": f.size, "path": i.checked_sub(own).and_then(|j| paths.get(j)).cloned().unwrap_or_default() }))
        .collect();
    let body: String = item.text("Body").chars().take(crate::smtp::MAX_BODY).collect();
    let from = account.map(|a| a.address).unwrap_or_default();
    let subject = item.text("Subject");
    Ok(Made { token: 0, from, to, cc, subject, body, files })
}

/// The email as the user left it on its card (mail.rs outlook_revision),
/// checked: who it goes to, the subject, the text when it changed, the files
/// left out and the paths added with Attach.
pub struct Revision {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    /// Only when the user changed it: Outlook's own text (a reply's HTML) stays otherwise.
    pub new_body: Option<String>,
    /// The files the user took off the card, by name and size (places_to_remove).
    pub drop: Vec<(String, usize)>,
    pub add: Vec<String>,
    /// What changed, in words for the AI.
    pub changed: Vec<&'static str>,
}

/// What the user changed on the card, put in Outlook's email before Send;
/// `made` then says what the email holds now.
pub async fn revise(made: &mut Made, change: Revision) -> Result<(), String> {
    let token = made.token;
    let (to, cc, subject, body, files) = with_outlook(SLOW_STEP, move |s| {
        let item = s.pending.get(&token).ok_or_else(|| "Outlook closed before the email went.".to_string())?;
        let recipients = item.obj("Recipients")?;
        while recipients.int("Count")? > 0 {
            recipients.call("Remove", vec![1.into()])?;
        }
        let add = |address: &str, kind: i32| -> Result<(), String> {
            let r = recipients.call("Add", vec![address.into()])?.dispatch()?;
            r.put("Type", kind.into())
        };
        for a in &change.to {
            add(a, TO)?;
        }
        for a in &change.cc {
            add(a, CC)?;
        }
        let _ = recipients.call("ResolveAll", vec![]);
        item.put("Subject", change.subject.as_str().into())?;
        if let Some(body) = &change.new_body {
            item.put("Body", body.as_str().into())?;
        }
        // The files left out go, found by name and size, from the last one so the places hold.
        let attachments = item.obj("Attachments")?;
        let listed: Vec<Option<(String, usize)>> = (1..=attachments.int("Count")?.max(0)).map(|i| file_at(&attachments, i).map(|f| (f.name, f.size))).collect();
        for place in places_to_remove(&listed, &change.drop) {
            attachments.call("Remove", vec![place.into()])?;
        }
        for path in &change.add {
            item.obj("Attachments")?.call("Add", vec![path.as_str().into()])?;
        }
        let (to, cc) = people(item)?;
        let listed = files_of(item)?;
        let body: String = item.text("Body").chars().take(crate::smtp::MAX_BODY).collect();
        Ok((to, cc, item.text("Subject"), body, listed))
    })
    .await?;
    let total: usize = files.iter().map(|f| f.size).sum();
    if total as u64 > crate::smtp::MAX_ATTACHED_BYTES {
        return Err(crate::mail::too_heavy());
    }
    made.to = to;
    made.cc = cc;
    made.subject = subject;
    made.body = body;
    made.files = files.iter().map(|f| json!({ "name": f.name, "size": f.size, "path": "" })).collect();
    Ok(())
}

/// After the card: Send sends it out of Outlook (into its Sent Items);
/// anything else throws it away.
pub async fn finish(made: &Made, send: bool) -> Result<(), String> {
    use std::sync::atomic::AtomicU8;
    const WAITING: u8 = 0;
    const SENDING: u8 = 1;
    const GAVE_UP: u8 = 2;
    let token = made.token;
    // Outlook may hold Send on a prompt of its own ("A program is trying to
    // send…") past the wait, and send once the user allows it: once Send is
    // called, no answer doesn't mean the email didn't go. Send is called only
    // while Lumo still waits, so a wait that ends first means it wasn't.
    let state = std::sync::Arc::new(AtomicU8::new(WAITING));
    let job_state = state.clone();
    let done = with_outlook(if send { SLOW_STEP } else { STEP }, move |s| {
        let item = s.pending.remove(&token).ok_or_else(|| "Outlook closed before the email went.".to_string())?;
        if send && job_state.compare_exchange(WAITING, SENDING, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            item.call("Send", vec![]).map(|_| ())
        } else {
            throw_away(&item);
            Ok(())
        }
    })
    .await;
    match done {
        Err(e) if send && e == NO_ANSWER && state.compare_exchange(WAITING, GAVE_UP, Ordering::SeqCst, Ordering::SeqCst).is_err() => Err(MAYBE_SENT.into()),
        other => other,
    }
}

/// What `with_outlook` says when Outlook didn't answer within its wait.
const NO_ANSWER: &str = "Outlook didn't answer in time: a window of its own may be waiting for the user.";
/// What the AI reads when Outlook was told to send and never said it did.
const MAYBE_SENT: &str = "The email may have been sent: Outlook was told to send it but didn't confirm in time (it may be asking the user to allow it). Do not send it again: ask the user to check Outlook's Sent Items and Outbox first.";

/// Keeps the email in Outlook's Drafts: nothing is sent.
pub async fn keep_draft(made: &Made) -> Result<String, String> {
    let token = made.token;
    with_outlook(STEP, move |s| {
        let item = s.pending.remove(&token).ok_or_else(|| "Outlook closed before the draft was saved.".to_string())?;
        item.call("Save", vec![])?;
        let place = item.obj("Parent").map(|p| p.text("Name")).unwrap_or_default();
        Ok(if place.is_empty() { "Drafts".to_string() } else { place })
    })
    .await
}

/// An email made and not sent: closed without saving, and if Outlook saved
/// it anyway (files added do), out of Drafts.
fn throw_away(item: &Disp) {
    let _ = item.call("Close", vec![DISCARD.into()]);
    if !item.text("EntryID").is_empty() {
        let _ = item.call("Delete", vec![]);
    }
}

/// The user's words above what Outlook put in a reply or a forward (the
/// email answered, quoted in the user's language), in HTML when it is.
fn write_above(item: &Disp, text: &str) -> Result<(), String> {
    if item.int("BodyFormat").ok() == Some(FORMAT_HTML) {
        let html = item.text("HTMLBody");
        item.put("HTMLBody", html_above(&html, text).as_str().into())
    } else {
        let body = item.text("Body");
        item.put("Body", format!("{}\n\n{body}", text.trim_end()).as_str().into())
    }
}

// ── Managing ──────────────────────────────────────────────────────────────────

/// What a managing tool does to one email.
pub enum Change {
    Mark { read: Option<bool>, starred: Option<bool> },
    Move(String),
    Archive,
    Trash,
}

/// What the card shows of the email and where it goes.
pub struct Planned {
    pub from: String,
    pub subject: String,
    pub date: String,
    /// The folder it goes to (a move, the archive, the trash).
    pub folder: String,
}

/// The email and where it would go, for its card: nothing changes yet.
pub async fn plan(id: String, change: Change) -> Result<(Planned, Change), String> {
    with_outlook(SLOW_STEP, move |s| {
        let app = s.running()?;
        let item = item_of(&app, &id)?;
        let found = found_of(s, &item, &id, 200);
        let m = &found.message;
        let from = if m.from.is_empty() || m.from == m.address { m.address.clone() } else { format!("{} <{}>", m.from, m.address) };
        let folder = match &change {
            Change::Mark { .. } => String::new(),
            _ => target(&app, &item, &change)?.path,
        };
        Ok((Planned { from, subject: m.subject.clone(), date: m.date.clone(), folder }, change))
    })
    .await
}

/// Does `change` to the email, after the user's click.
pub async fn apply(id: String, change: Change) -> Result<String, String> {
    with_outlook(SLOW_STEP, move |s| {
        let app = s.running()?;
        let item = item_of(&app, &id)?;
        match &change {
            Change::Mark { read, starred } => {
                if let Some(read) = read {
                    item.put("UnRead", (!read).into())?;
                }
                match starred {
                    Some(true) => {
                        item.call("MarkAsTask", vec![MARK_NO_DATE.into()])?;
                    }
                    Some(false) => {
                        item.call("ClearTaskFlag", vec![])?;
                    }
                    None => {}
                }
                item.call("Save", vec![])?;
                Ok("Done: the email is marked.".to_string())
            }
            _ => {
                let to = target(&app, &item, &change)?;
                let moved = item.call("Move", vec![to.folder.0.clone().into()])?.dispatch()?;
                // The id the agent has stays good: it now points where the email went.
                let entry = moved.text("EntryID");
                let store = to.folder.text("StoreID");
                if !entry.is_empty() {
                    book().lock().unwrap().repoint(&id, entry, store);
                }
                Ok(format!("Done: the email is in {FOLDER_PREFIX}{} now.", to.path))
            }
        }
    })
    .await
}

/// Where a move, an archive or a trash takes the email.
fn target(app: &Disp, item: &Disp, change: &Change) -> Result<Place, String> {
    let here = item.obj("Parent")?;
    let here_id = here.text("EntryID");
    let store = here.obj("Store")?;
    let place = match change {
        Change::Move(asked) => {
            let mut found = places_named(app, asked)?;
            if found.len() != 1 {
                return Err(format!("Say one folder: {asked} names several (mail_folders lists them)."));
            }
            found.remove(0)
        }
        Change::Trash => {
            let trash = store.call("GetDefaultFolder", vec![FOLDER_DELETED.into()])?.dispatch()?;
            if trash.text("EntryID") == here_id {
                return Err("The email is already in the trash: Lumo never deletes an email for good.".into());
            }
            let path = path_of(&store, &trash);
            Place { path, folder: trash, role: Some(Role::Trash) }
        }
        Change::Archive => {
            let root = store.call("GetRootFolder", vec![])?.dispatch()?;
            let mut found = None;
            for f in children(&root)? {
                if crate::mail::is_archive_name(&f.text("Name")) {
                    found = Some(f);
                    break;
                }
            }
            let archive = found.ok_or_else(|| "This mailbox has no Archive folder: use mail_move with one mail_folders lists.".to_string())?;
            let path = path_of(&store, &archive);
            Place { path, folder: archive, role: Some(Role::Archive) }
        }
        Change::Mark { .. } => return Err("Nothing to move.".into()),
    };
    if place.folder.text("EntryID") == here_id {
        return Err(format!("The email is already in {FOLDER_PREFIX}{}.", place.path));
    }
    Ok(place)
}

// ── Opening in Outlook ────────────────────────────────────────────────────────

/// The island's "Open" on an Outlook email (`lumo-outlook:12`), or on the
/// pill (`lumo-outlook:inbox`): shown in Outlook, if it is running.
pub fn open(link: &str) {
    let what = link.trim_start_matches(LINK_PREFIX).to_string();
    tauri::async_runtime::spawn(async move {
        let shown = with_outlook(STEP, move |s| {
            let app = s.running()?;
            if what == "inbox" {
                let inbox = app.obj("Session")?.call("GetDefaultFolder", vec![FOLDER_INBOX.into()])?.dispatch()?;
                inbox.call("Display", vec![])?;
            } else {
                item_of(&app, &format!("{ID_PREFIX}{what}"))?.call("Display", vec![])?;
            }
            Ok(())
        })
        .await;
        if let Err(e) = shown {
            log::line(format!("[outlook] open: {e}"));
        }
    });
}

// ── The thread that talks to Outlook ──────────────────────────────────────────

type Job = Box<dyn FnOnce(&mut Session) + Send>;

static JOBS: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

/// Runs `job` on Outlook's thread, waiting at most `wait`. A job that comes
/// up after its caller stopped waiting is not run.
async fn with_outlook<T: Send + 'static>(wait: Duration, job: impl FnOnce(&mut Session) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let deadline = Instant::now() + wait;
    let task: Job = Box::new(move |s: &mut Session| {
        if Instant::now() > deadline {
            return;
        }
        // No catch_unwind: the release profile is panic = "abort", where it
        // would catch nothing. The jobs are written to have nothing to panic on.
        let out = job(s);
        // MAPI's session lasts one job: nothing of it holds Outlook's profile in between.
        s.mapi = None;
        if GONE.with(|g| g.replace(false)) {
            s.let_go();
        } else if !s.started {
            // An Outlook the user opened is held only during a job, so
            // nothing of Lumo keeps it running once they close it.
            s.app = None;
        }
        let _ = tx.send(out);
    });
    let jobs = JOBS.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("outlook".into())
            .spawn(move || {
                // Outlook runs in a process of its own: the calls go to it from
                // this thread's apartment, which needs no message loop.
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                let mut session = Session::default();
                while let Ok(job) = rx.recv() {
                    job(&mut session);
                }
            })
            .ok();
        Mutex::new(tx)
    });
    jobs.lock().unwrap().send(task).map_err(|_| "Lumo couldn't reach Outlook.".to_string())?;
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(out)) => out,
        _ => Err(NO_ANSWER.into()),
    }
}

thread_local! {
    /// Outlook went away during the job (closed, or crashed): its objects are dead.
    static GONE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// What Outlook's thread keeps between jobs.
#[derive(Default)]
struct Session {
    /// Outlook.Application, while Outlook runs.
    app: Option<Disp>,
    /// Lumo started this Outlook ("Open Outlook if it's closed"): it is held
    /// between jobs, or it would close again.
    started: bool,
    /// Emails made and waiting for their card.
    pending: HashMap<u64, Disp>,
    /// MAPI, during a job: not tried yet (None), or what logging on gave.
    mapi: Option<Option<Mapi>>,
    /// Whether each unread email (by its EntryID) is a promotion, as found.
    promotions: HashMap<String, bool>,
}

impl Session {
    /// Outlook, if it is running: never starts it.
    fn app(&mut self) -> Result<Option<Disp>, String> {
        if let Some(app) = &self.app {
            return Ok(Some(app.clone()));
        }
        let Some(clsid) = clsid() else { return Err(not_installed()) };
        let mut unknown: Option<IUnknown> = None;
        if unsafe { GetActiveObject(&clsid, None, &mut unknown) }.is_err() {
            return Ok(None);
        }
        let app = unknown.and_then(|u| u.cast::<IDispatch>().ok()).map(Disp);
        self.app = app.clone();
        Ok(app)
    }

    /// Outlook, or why not.
    fn running(&mut self) -> Result<Disp, String> {
        self.app()?.ok_or_else(|| "Outlook is closed on this PC: ask the user to open it.".to_string())
    }

    /// "Open Outlook if it's closed": started in the background, with no
    /// window. Whether Lumo started it.
    fn start(&mut self) -> Result<bool, String> {
        if self.app()?.is_some() {
            return Ok(false);
        }
        let Some(clsid) = clsid() else { return Err(not_installed()) };
        let app: IDispatch = unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }.map_err(|e| e.message())?;
        let app = Disp(app);
        // Outlook started this way has no session until it is asked for one.
        let _ = app.call("GetNamespace", vec!["MAPI".into()]);
        self.app = Some(app);
        self.started = true;
        Ok(true)
    }

    /// Lets go of Outlook: Lumo holds nothing of it any more.
    fn let_go(&mut self) {
        for (_, item) in self.pending.drain() {
            throw_away(&item);
        }
        self.mapi = None;
        self.app = None;
        self.started = false;
    }

    /// What Outlook guards of an email, read through MAPI (no prompt): the
    /// text up to `chars` characters, the headers when asked. None when MAPI
    /// can't be had (a 32-bit Office).
    fn guarded(&mut self, store_id: &str, entry_id: &str, chars: usize, headers: bool) -> Option<Guarded> {
        let mapi = self.mapi.get_or_insert_with(Mapi::logon).as_mut()?;
        mapi.read(store_id, entry_id, chars, headers)
    }

    /// The unread emails of every account's inbox; None while Outlook is closed.
    fn look(&mut self, hide_promotions: bool, known: HashMap<String, (Message, f64)>) -> Result<Option<Inbox>, String> {
        let Some(app) = self.app()? else { return Ok(None) };
        let mut unread = 0usize;
        let mut all: Vec<(Message, f64)> = Vec::new();
        let mut entries = HashMap::new();
        for place in watched(&app)? {
            let count = place.folder.int("UnReadItemCount").unwrap_or(0).max(0) as usize;
            if count == 0 {
                continue;
            }
            let items = place.folder.obj("Items")?.call("Restrict", vec!["[UnRead] = True".into()])?.dispatch()?;
            items.call("Sort", vec!["[ReceivedTime]".into(), true.into()])?;
            let listed = items.int("Count")?.max(0);
            let look_at = if hide_promotions { listed.min(PROMO_LOOK) } else { listed.min(crate::mail::FETCH as i32) };
            let mut promotions = 0usize;
            let mut kept = 0usize;
            let store = place.store_id.clone();
            for i in 1..=look_at {
                let Ok(item) = items.call("Item", vec![i.into()]).and_then(|v| v.dispatch()) else { continue };
                let entry = item.text("EntryID");
                let cached = known.get(&entry).map(|(m, _)| m.clone());
                let mut read = None;
                // Whether it's a promotion, from its headers through MAPI:
                // without MAPI, none is (the automation would make Outlook ask).
                if hide_promotions && cached.is_none() {
                    let promotion = match self.promotions.get(&entry) {
                        Some(known) => *known,
                        None => {
                            let chars = if kept < crate::mail::FETCH { RAW_BODY_CHARS } else { 0 };
                            read = self.guarded(&store, &entry, chars, true);
                            let promotion = read.as_ref().is_some_and(|g| has_unsubscribe(&g.headers));
                            if read.is_some() {
                                self.promotions.insert(entry.clone(), promotion);
                            }
                            promotion
                        }
                    };
                    if promotion {
                        promotions += 1;
                        continue;
                    }
                }
                if kept >= crate::mail::FETCH {
                    continue;
                }
                kept += 1;
                let id = book().lock().unwrap().id_for(&entry, &store);
                let at = item.date("ReceivedTime").unwrap_or(0.0);
                let message = match cached {
                    // The id it had may be gone since (the Book starts again
                    // past MOST_IDS): it goes under the one it has now.
                    Some(mut m) => {
                        m.id = id.clone();
                        m
                    }
                    None => {
                        let guarded = read.filter(|g| !g.body.is_empty()).or_else(|| self.guarded(&store, &entry, RAW_BODY_CHARS, false));
                        message_of(&item, &id, crate::mail::BODY_CHARS, guarded, Quiet::Yes)
                    }
                };
                entries.insert(id, entry);
                all.push((message, at));
            }
            unread += count.saturating_sub(promotions);
        }
        all.sort_by(|a, b| b.1.total_cmp(&a.1));
        all.truncate(crate::mail::FETCH);
        if self.promotions.len() > 2_000 {
            self.promotions.clear();
        }
        Ok(Some(Inbox { unread, messages: all, entries }))
    }
}

/// What the next look already knows, by EntryID. A message whose id has no
/// EntryID is left out (read again next time) rather than taking Lumo down.
fn cache_of(inbox: &Inbox) -> HashMap<String, (Message, f64)> {
    inbox
        .messages
        .iter()
        .filter_map(|(m, at)| Some((inbox.entries.get(&m.id)?.clone(), (m.clone(), *at))))
        .collect()
}

/// What a look at the inboxes found.
struct Inbox {
    unread: usize,
    /// The newest unread emails, newest first, with when each arrived.
    messages: Vec<(Message, f64)>,
    /// Each message's Outlook EntryID, by its id.
    entries: HashMap<String, String>,
}

fn clsid() -> Option<GUID> {
    unsafe { CLSIDFromProgID(w!("Outlook.Application")) }.ok()
}

fn installed() -> bool {
    clsid().is_some()
}

fn not_installed() -> String {
    "Classic Outlook is not installed on this PC.".into()
}

/// A number for each email made, and each file saved.
fn next_token() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

// ── Reading Outlook's objects ─────────────────────────────────────────────────

/// One of Outlook's objects, asked by name (IDispatch).
#[derive(Clone)]
struct Disp(IDispatch);

impl Disp {
    fn invoke(&self, name: &str, flags: DISPATCH_FLAGS, args: Vec<VARIANT>) -> Result<VARIANT, String> {
        let wide = HSTRING::from(name);
        let names = [PCWSTR(wide.as_ptr())];
        let mut id = 0i32;
        unsafe { self.0.GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, LOCALE, &mut id) }.map_err(|e| failed(name, &e))?;
        // IDispatch takes the arguments last first.
        let mut args = args;
        args.reverse();
        let mut named = DISPID_PROPERTYPUT;
        let putting = flags == DISPATCH_PROPERTYPUT || flags == DISPATCH_PROPERTYPUTREF;
        let params = DISPPARAMS {
            rgvarg: if args.is_empty() { std::ptr::null_mut() } else { args.as_mut_ptr() },
            rgdispidNamedArgs: if putting { &mut named } else { std::ptr::null_mut() },
            cArgs: args.len() as u32,
            cNamedArgs: u32::from(putting),
        };
        let mut result = VARIANT::default();
        let mut exception = EXCEPINFO::default();
        let done = unsafe { self.0.Invoke(id, &GUID::zeroed(), LOCALE, flags, &params, Some(&mut result as *mut VARIANT), Some(&mut exception as *mut EXCEPINFO), None) };
        let said = unsafe {
            let description = ManuallyDrop::take(&mut exception.bstrDescription);
            drop(ManuallyDrop::take(&mut exception.bstrSource));
            drop(ManuallyDrop::take(&mut exception.bstrHelpFile));
            description.to_string()
        };
        match done {
            Ok(()) => Ok(result),
            Err(e) if !said.trim().is_empty() => {
                note_gone(&e);
                Err(format!("Outlook: {}", said.trim()))
            }
            Err(e) => Err(failed(name, &e)),
        }
    }

    fn get(&self, name: &str) -> Result<VARIANT, String> {
        self.invoke(name, DISPATCH_PROPERTYGET, Vec::new())
    }

    fn call(&self, name: &str, args: Vec<VARIANT>) -> Result<VARIANT, String> {
        self.invoke(name, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args)
    }

    fn put(&self, name: &str, value: VARIANT) -> Result<(), String> {
        self.invoke(name, DISPATCH_PROPERTYPUT, vec![value]).map(|_| ())
    }

    /// An object put in a property ("Set x.SendUsingAccount = …").
    fn put_ref(&self, name: &str, value: VARIANT) -> Result<(), String> {
        self.invoke(name, DISPATCH_PROPERTYPUTREF, vec![value.clone()]).map(|_| ()).or_else(|_| self.put(name, value))
    }

    fn obj(&self, name: &str) -> Result<Disp, String> {
        self.get(name)?.dispatch()
    }

    fn text(&self, name: &str) -> String {
        self.get(name).map(|v| v.string()).unwrap_or_default()
    }

    fn int(&self, name: &str) -> Result<i32, String> {
        let v = self.get(name)?;
        i32::try_from(&v).map_err(|_| format!("Outlook's {name} is not a number."))
    }

    fn date(&self, name: &str) -> Option<f64> {
        let v = self.get(name).ok()?;
        (v.vt() == VT_DATE).then(|| unsafe { v.Anonymous.Anonymous.Anonymous.date })
    }

    fn clone_variant(&self) -> VARIANT {
        VARIANT::from(self.0.clone())
    }
}

/// The user's language, for what Outlook names.
const LOCALE: u32 = 0x0400;

trait VariantExt {
    fn dispatch(self) -> Result<Disp, String>;
    fn string(&self) -> String;
}

impl VariantExt for VARIANT {
    fn dispatch(self) -> Result<Disp, String> {
        if self.vt() != VT_DISPATCH {
            return Err("Outlook gave nothing there.".into());
        }
        IDispatch::try_from(&self).map(Disp).map_err(|_| "Outlook gave nothing there.".into())
    }

    fn string(&self) -> String {
        BSTR::try_from(self).map(|b| b.to_string()).unwrap_or_default()
    }
}

/// HRESULTs that say Outlook is gone (closed, crashed, its proxy dead).
fn note_gone(e: &::windows::core::Error) {
    const GONE_CODES: [u32; 5] = [0x8001_0108, 0x8001_0007, 0x8007_06BA, 0x8007_06BE, 0x8004_01FD];
    if GONE_CODES.contains(&(e.code().0 as u32)) {
        GONE.with(|g| g.set(true));
    }
}

fn failed(name: &str, e: &::windows::core::Error) -> String {
    note_gone(e);
    format!("Outlook couldn't give {name}: {}", e.message())
}

/// An account of Outlook's: its address, and the store its mail arrives in.
struct Account {
    address: String,
    store_id: String,
    disp: Disp,
}

fn accounts(app: &Disp) -> Result<Vec<Account>, String> {
    let list = app.obj("Session")?.obj("Accounts")?;
    let mut out = Vec::new();
    for i in 1..=list.int("Count")? {
        let Ok(account) = list.call("Item", vec![i.into()]).and_then(|v| v.dispatch()) else { continue };
        // Its name, which Outlook makes the address: SmtpAddress is guarded
        // (Outlook would ask the user each time it's read).
        let address = Some(account.text("DisplayName")).filter(|a| !a.trim().is_empty()).unwrap_or_else(|| account.text("UserName"));
        let store_id = account.obj("DeliveryStore").map(|s| s.text("StoreID")).unwrap_or_default();
        out.push(Account { address, store_id, disp: account });
    }
    Ok(out)
}

/// The account new emails go from: the one of the default store, else the first.
fn default_account(app: &Disp) -> Option<Account> {
    let default = app.obj("Session").and_then(|s| s.obj("DefaultStore")).map(|s| s.text("StoreID")).unwrap_or_default();
    let mut all = accounts(app).ok()?;
    let at = all.iter().position(|a| a.store_id == default && !default.is_empty()).unwrap_or(0);
    (!all.is_empty()).then(|| all.swap_remove(at))
}

/// The account an email arrived in, to answer from it.
fn account_of(app: &Disp, item: &Disp) -> Option<Account> {
    let store = item.obj("Parent").and_then(|p| p.text_of("StoreID")).unwrap_or_default();
    accounts(app).ok()?.into_iter().find(|a| a.store_id == store && !store.is_empty()).or_else(|| default_account(app))
}

impl Disp {
    fn text_of(&self, name: &str) -> Result<String, String> {
        self.get(name).map(|v| v.string())
    }
}

/// A mail folder: where it is ("ada@outlook.it/Inbox/Work"), and what for.
struct Place {
    path: String,
    folder: Disp,
    role: Option<Role>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Role {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Outbox,
    Archive,
}

impl Role {
    fn word(self) -> &'static str {
        match self {
            Role::Inbox => "inbox",
            Role::Sent => "sent",
            Role::Drafts => "drafts",
            Role::Trash => "trash",
            Role::Junk => "spam",
            Role::Outbox => "outbox",
            Role::Archive => "archive",
        }
    }

    fn of_word(word: &str) -> Option<Role> {
        match word.trim().to_lowercase().as_str() {
            "inbox" => Some(Role::Inbox),
            "sent" => Some(Role::Sent),
            "drafts" => Some(Role::Drafts),
            "trash" | "deleted" => Some(Role::Trash),
            "spam" | "junk" => Some(Role::Junk),
            "archive" => Some(Role::Archive),
            _ => None,
        }
    }
}

/// The stores Lumo reads: each account's, else all but public folders.
fn stores(app: &Disp) -> Result<Vec<(Disp, String)>, String> {
    let list = app.obj("Session")?.obj("Stores")?;
    let delivering: Vec<String> = accounts(app).unwrap_or_default().into_iter().map(|a| a.store_id).filter(|s| !s.is_empty()).collect();
    let mut out = Vec::new();
    for i in 1..=list.int("Count")? {
        let Ok(store) = list.call("Item", vec![i.into()]).and_then(|v| v.dispatch()) else { continue };
        if store.int("ExchangeStoreType").ok() == Some(PUBLIC_FOLDERS) {
            continue;
        }
        let id = store.text("StoreID");
        if !delivering.is_empty() && !delivering.contains(&id) {
            continue;
        }
        out.push((store, id));
    }
    Ok(out)
}

/// What a watched inbox needs: the folder and its store.
struct Watched {
    folder: Disp,
    store_id: String,
}

/// Every account's inbox.
fn inboxes(app: &Disp) -> Result<Vec<Place>, String> {
    Ok(watched(app)?.into_iter().map(|w| Place { path: String::new(), folder: w.folder, role: Some(Role::Inbox) }).collect())
}

fn watched(app: &Disp) -> Result<Vec<Watched>, String> {
    let mut out = Vec::new();
    for (store, store_id) in stores(app)? {
        if let Ok(folder) = store.call("GetDefaultFolder", vec![FOLDER_INBOX.into()]).and_then(|v| v.dispatch()) {
            out.push(Watched { folder, store_id });
        }
    }
    if out.is_empty() {
        let session = app.obj("Session")?;
        let folder = session.call("GetDefaultFolder", vec![FOLDER_INBOX.into()])?.dispatch()?;
        let store_id = folder.text("StoreID");
        out.push(Watched { folder, store_id });
    }
    Ok(out)
}

/// Every mail folder of the stores Lumo reads, with what each is for.
fn all_places(app: &Disp) -> Result<Vec<Place>, String> {
    let mut out = Vec::new();
    for (store, _) in stores(app)? {
        let name = store.text("DisplayName");
        let roles: Vec<(Role, String)> = [
            (Role::Inbox, FOLDER_INBOX),
            (Role::Sent, FOLDER_SENT),
            (Role::Drafts, FOLDER_DRAFTS),
            (Role::Trash, FOLDER_DELETED),
            (Role::Junk, FOLDER_JUNK),
            (Role::Outbox, FOLDER_OUTBOX),
        ]
        .iter()
        .filter_map(|(role, n)| {
            let f = store.call("GetDefaultFolder", vec![(*n).into()]).ok()?.dispatch().ok()?;
            Some((*role, f.text("EntryID")))
        })
        .collect();
        let Ok(root) = store.call("GetRootFolder", vec![]).and_then(|v| v.dispatch()) else { continue };
        walk(&root, &name, 0, &roles, &mut out)?;
        if out.len() >= MOST_FOLDERS {
            break;
        }
    }
    Ok(out)
}

fn walk(folder: &Disp, path: &str, depth: usize, roles: &[(Role, String)], out: &mut Vec<Place>) -> Result<(), String> {
    if depth >= DEPTH {
        return Ok(());
    }
    for child in children(folder)? {
        if out.len() >= MOST_FOLDERS {
            return Ok(());
        }
        let here = format!("{path}/{}", child.text("Name"));
        // Mail folders only: not the calendar, the contacts, the tasks.
        if child.int("DefaultItemType").ok() == Some(MAIL_ITEM) {
            let entry = child.text("EntryID");
            let top = depth == 0;
            let role = roles
                .iter()
                .find(|(_, id)| *id == entry)
                .map(|(r, _)| *r)
                .or_else(|| (top && crate::mail::is_archive_name(&child.text("Name"))).then_some(Role::Archive));
            out.push(Place { path: here.clone(), folder: child.clone(), role });
        }
        walk(&child, &here, depth + 1, roles, out)?;
    }
    Ok(())
}

fn children(folder: &Disp) -> Result<Vec<Disp>, String> {
    let list = folder.obj("Folders")?;
    let mut out = Vec::new();
    for i in 1..=list.int("Count")? {
        if let Ok(f) = list.call("Item", vec![i.into()]).and_then(|v| v.dispatch()) {
            out.push(f);
        }
    }
    Ok(out)
}

/// A folder's path as mail_folders gives it.
fn path_of(store: &Disp, folder: &Disp) -> String {
    let mut names = vec![folder.text("Name")];
    let root = store.call("GetRootFolder", vec![]).ok().and_then(|v| v.dispatch().ok()).map(|r| r.text("EntryID")).unwrap_or_default();
    let mut at = folder.clone();
    for _ in 0..DEPTH {
        let Ok(parent) = at.obj("Parent") else { break };
        if parent.text("EntryID") == root || parent.int("DefaultItemType").is_err() {
            break;
        }
        names.push(parent.text("Name"));
        at = parent;
    }
    names.push(store.text("DisplayName"));
    names.reverse();
    names.join("/")
}

/// The folders an agent named: "inbox", "sent", "trash"… (each account's),
/// or a path mail_folders gave, with or without "outlook:" and the account.
fn places_named(app: &Disp, asked: &str) -> Result<Vec<Place>, String> {
    let asked = asked.trim().strip_prefix(FOLDER_PREFIX).unwrap_or(asked.trim()).trim();
    if asked.eq_ignore_ascii_case("inbox") {
        return inboxes(app);
    }
    let all = all_places(app)?;
    let paths: Vec<String> = all.iter().map(|p| p.path.clone()).collect();
    if let Some(i) = match_path(&paths, asked) {
        return Ok(all.into_iter().nth(i).into_iter().collect());
    }
    if let Some(role) = Role::of_word(asked) {
        let found: Vec<Place> = all.into_iter().filter(|p| p.role == Some(role)).collect();
        if !found.is_empty() {
            return Ok(found);
        }
    }
    Err(format!("Outlook has no folder called {asked}: mail_folders lists them."))
}

/// The newest `count` emails of a list of Outlook's items.
fn newest_of(s: &mut Session, items: &Disp, count: usize) -> Result<Vec<(Found, f64)>, String> {
    items.call("Sort", vec!["[ReceivedTime]".into(), true.into()])?;
    let listed = items.int("Count")?.max(0) as usize;
    let mut out = Vec::new();
    for i in 1..=listed.min(count) {
        let Ok(item) = items.call("Item", vec![(i as i32).into()]).and_then(|v| v.dispatch()) else { continue };
        let store = item.obj("Parent").map(|p| p.text("StoreID")).unwrap_or_default();
        let id = book().lock().unwrap().id_for(&item.text("EntryID"), &store);
        let at = item.date("ReceivedTime").filter(|d| *d < NO_DATE).or_else(|| item.date("LastModificationTime")).unwrap_or(0.0);
        out.push((found_of(s, &item, &id, crate::mail::BODY_CHARS), at));
    }
    Ok(out)
}

fn newest_first(mut found: Vec<(Found, f64)>, count: usize) -> Vec<Found> {
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    found.into_iter().take(count).map(|(f, _)| f).collect()
}

/// The email the agent's id points to.
fn item_of(app: &Disp, id: &str) -> Result<Disp, String> {
    let (entry, store) = book().lock().unwrap().entry_of(id).ok_or_else(|| format!("{id} is not an email id: use one mail_recent or mail_search gave."))?;
    let session = app.obj("Session")?;
    let args: Vec<VARIANT> = if store.is_empty() { vec![entry.as_str().into()] } else { vec![entry.as_str().into(), store.as_str().into()] };
    session
        .call("GetItemFromID", args)
        .and_then(|v| v.dispatch())
        .map_err(|_| format!("No email {id}: it may have been moved or deleted."))
}

/// An email an agent asked for: what Outlook guards through MAPI, else
/// through the automation (Outlook may ask the user then: they asked).
fn found_of(s: &mut Session, item: &Disp, id: &str, chars: usize) -> Found {
    let store = item.obj("Parent").map(|p| p.text("StoreID")).unwrap_or_default();
    let guarded = s.guarded(&store, &item.text("EntryID"), raw_chars(chars), false);
    let unread = item.get("UnRead").ok().and_then(|v| bool::try_from(&v).ok()).unwrap_or(false);
    Found { id: id.to_string(), unread, message: message_of(item, id, chars, guarded, Quiet::No) }
}

/// Whether reading may fall back on the fields Outlook guards: never for
/// the island's looks, which nobody asked for.
#[derive(PartialEq)]
enum Quiet {
    Yes,
    No,
}

/// How much of an email's text is read through MAPI: more than is kept,
/// as the quoted emails below it are cut off.
const RAW_BODY_CHARS: usize = 16_000;

fn raw_chars(chars: usize) -> usize {
    chars.saturating_mul(2).max(RAW_BODY_CHARS)
}

fn message_of(item: &Disp, id: &str, chars: usize, guarded: Option<Guarded>, quiet: Quiet) -> Message {
    let (from, address, text) = match guarded {
        Some(g) => (g.from, g.address, g.body),
        // Without MAPI the island shows the subject alone, from "Outlook".
        None if quiet == Quiet::Yes => ("Outlook".to_string(), String::new(), String::new()),
        None => (item.text("SenderName").trim().to_string(), sender_address(item), item.text("Body")),
    };
    let text = crate::mail::tidy(&text);
    let at = item.date("ReceivedTime").filter(|d| *d < NO_DATE).or_else(|| item.date("LastModificationTime"));
    Message {
        id: id.to_string(),
        from,
        address,
        subject: item.text("Subject").trim().to_string(),
        preview: crate::mail::preview(&text),
        body: text.chars().take(chars).collect(),
        date: at.map(rfc_date).unwrap_or_default(),
        link: Some(format!("{LINK_PREFIX}{}", id.trim_start_matches(ID_PREFIX))),
    }
}

/// The sender's plain address, also for a colleague on Exchange.
fn sender_address(item: &Disp) -> String {
    if item.text("SenderEmailType") == "EX" {
        let smtp = item.obj("Sender").and_then(|s| s.call("GetExchangeUser", vec![])).and_then(|v| v.dispatch()).map(|u| u.text("PrimarySmtpAddress"));
        if let Some(a) = smtp.ok().filter(|a| !a.is_empty()) {
            return a;
        }
    }
    item.text("SenderEmailAddress").trim().to_string()
}

/// The people of an email being written: to, and in copy.
fn people(item: &Disp) -> Result<(Vec<String>, Vec<String>), String> {
    let list = item.obj("Recipients")?;
    let (mut to, mut cc) = (Vec::new(), Vec::new());
    for i in 1..=list.int("Count")? {
        let Ok(r) = list.call("Item", vec![i.into()]).and_then(|v| v.dispatch()) else { continue };
        let mut address = r.text("Address");
        if !address.contains('@') {
            if let Ok(smtp) = r.obj("AddressEntry").and_then(|e| e.call("GetExchangeUser", vec![])).and_then(|v| v.dispatch()) {
                address = smtp.text("PrimarySmtpAddress");
            }
        }
        if address.is_empty() {
            address = r.text("Name");
        }
        match r.int("Type").unwrap_or(TO) {
            CC => cc.push(address),
            TO => to.push(address),
            _ => {}
        }
    }
    Ok((to, cc))
}

fn files_of(item: &Disp) -> Result<Vec<File>, String> {
    let list = item.obj("Attachments")?;
    Ok((1..=list.int("Count")?).filter_map(|i| file_at(&list, i)).collect())
}

/// The attachment at `place` (from 1) of an email's Attachments, as the card
/// lists it; None when Outlook can't give it.
fn file_at(list: &Disp, place: i32) -> Option<File> {
    let a = list.call("Item", vec![place.into()]).and_then(|v| v.dispatch()).ok()?;
    let name = Some(a.text("FileName")).filter(|n| !n.is_empty()).unwrap_or_else(|| a.text("DisplayName"));
    Some(File { mime: crate::smtp::mime_of(&name), size: a.int("Size").unwrap_or(0).max(0) as usize, name })
}

/// The places (from 1, the last first) of the attachments to take out of an
/// email: `listed` is each attachment as Outlook gives it now (None: one it
/// can't), `drop` the files the user took off the card, by name and size.
/// Found by what they are, not by their place on the card, which one Outlook
/// couldn't give when the card was made would have shifted; that one is never
/// taken out, and of two alike only as many go as were taken off.
fn places_to_remove(listed: &[Option<(String, usize)>], drop: &[(String, usize)]) -> Vec<i32> {
    let mut left: Vec<&(String, usize)> = drop.iter().collect();
    let mut places = Vec::new();
    for (i, file) in listed.iter().enumerate().rev() {
        let Some(file) = file else { continue };
        if let Some(at) = left.iter().position(|d| *d == file) {
            left.remove(at);
            places.push(i as i32 + 1);
        }
    }
    places
}

// ── Ids ───────────────────────────────────────────────────────────────────────

/// Outlook's ids are long (an EntryID and its store's): the agents get short
/// ones, good while Lumo runs.
#[derive(Default)]
struct Book {
    next: u32,
    by_number: HashMap<u32, (String, String)>,
    by_entry: HashMap<String, u32>,
}

/// After this many, the ids start again (the old ones then say "no email").
const MOST_IDS: usize = 20_000;

impl Book {
    fn id_for(&mut self, entry: &str, store: &str) -> String {
        if let Some(n) = self.by_entry.get(entry) {
            return format!("{ID_PREFIX}{n}");
        }
        if self.by_number.len() >= MOST_IDS {
            self.by_number.clear();
            self.by_entry.clear();
        }
        self.next += 1;
        self.by_number.insert(self.next, (entry.to_string(), store.to_string()));
        self.by_entry.insert(entry.to_string(), self.next);
        format!("{ID_PREFIX}{}", self.next)
    }

    fn entry_of(&self, id: &str) -> Option<(String, String)> {
        let n: u32 = id.trim().strip_prefix(ID_PREFIX)?.parse().ok()?;
        self.by_number.get(&n).cloned()
    }

    /// An email moved has a new EntryID: its id follows it.
    fn repoint(&mut self, id: &str, entry: String, store: String) {
        let Some(n) = id.trim().strip_prefix(ID_PREFIX).and_then(|n| n.parse::<u32>().ok()) else { return };
        if let Some((old, old_store)) = self.by_number.get(&n).cloned() {
            self.by_entry.remove(&old);
            let store = if store.is_empty() { old_store } else { store };
            self.by_entry.insert(entry.clone(), n);
            self.by_number.insert(n, (entry, store));
        }
    }
}

fn book() -> &'static Mutex<Book> {
    static BOOK: OnceLock<Mutex<Book>> = OnceLock::new();
    BOOK.get_or_init(|| Mutex::new(Book::default()))
}

/// Whether `id` is an Outlook email's.
pub fn is_id(id: &str) -> bool {
    id.trim().starts_with(ID_PREFIX)
}

/// Whether `folder` names an Outlook folder.
pub fn is_folder(folder: &str) -> bool {
    folder.trim().starts_with(FOLDER_PREFIX)
}

// ── Plain helpers ─────────────────────────────────────────────────────────────

/// Outlook's dates are local times (days since 30 December 1899): as an
/// email's Date header, in UTC ("Sun, 8 Nov 2026 16:33:00 +0000").
fn rfc_date(local: f64) -> String {
    let (y, m, d, hh, mm, ss) = civil(local);
    let local = SYSTEMTIME { wYear: y as u16, wMonth: m as u16, wDay: d as u16, wHour: hh as u16, wMinute: mm as u16, wSecond: ss as u16, ..Default::default() };
    let mut utc = SYSTEMTIME::default();
    let (y, m, d, hh, mm, ss) = if unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.is_ok() {
        (utc.wYear as i64, utc.wMonth as i64, utc.wDay as i64, utc.wHour as i64, utc.wMinute as i64, utc.wSecond as i64)
    } else {
        (y, m, d, hh, mm, ss)
    };
    header_date(y, m, d, hh, mm, ss)
}

/// Days since 30 December 1899 (an OLE date) → year, month, day, hours, minutes, seconds.
fn civil(date: f64) -> (i64, i64, i64, i64, i64, i64) {
    let mut days = date.trunc() as i64;
    // Before 1900 the fraction counts the other way: never in an email.
    let mut secs = ((date - date.trunc()).abs() * 86_400.0).round() as i64;
    if secs >= 86_400 {
        days += 1;
        secs -= 86_400;
    }
    let (y, m, d) = from_days(days - 25_569);
    (y, m, d, secs / 3600, secs / 60 % 60, secs % 60)
}

/// Days since 1970-01-01 → the date (H. Hinnant's civil_from_days).
fn from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn header_date(y: i64, m: i64, d: i64, hh: i64, mm: i64, ss: i64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    // Days since 1970-01-01, a Thursday (days_from_civil).
    let (yy, mm_) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm_ + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let month = MONTHS.get((m - 1).clamp(0, 11) as usize).copied().unwrap_or("Jan");
    format!("{}, {d} {month} {y} {hh:02}:{mm:02}:{ss:02} +0000", DAYS[days.rem_euclid(7) as usize])
}

/// The search for `query` as Outlook takes it (DASL): each word in the
/// subject, the text, the sender or the people it went to; `from:`, `to:`
/// and `subject:` look only there.
fn dasl_filter(query: &str) -> Option<String> {
    const SUBJECT: &str = "\"urn:schemas:httpmail:subject\"";
    const TEXT: &str = "\"urn:schemas:httpmail:textdescription\"";
    const FROM_NAME: &str = "\"urn:schemas:httpmail:fromname\"";
    const FROM: &str = "\"urn:schemas:httpmail:fromemail\"";
    const TO_: &str = "\"urn:schemas:httpmail:displayto\"";
    let mut terms = Vec::new();
    for word in query.split_whitespace().take(8) {
        let (fields, word): (&[&str], &str) = match word.split_once(':') {
            Some((k, w)) if k.eq_ignore_ascii_case("from") => (&[FROM_NAME, FROM], w),
            Some((k, w)) if k.eq_ignore_ascii_case("to") => (&[TO_], w),
            Some((k, w)) if k.eq_ignore_ascii_case("subject") => (&[SUBJECT], w),
            _ => (&[SUBJECT, TEXT, FROM_NAME, FROM, TO_], word),
        };
        let clean: String = word.chars().filter(|c| !c.is_control() && *c != '%' && *c != '"').collect::<String>().replace('\'', "''");
        if clean.is_empty() {
            continue;
        }
        let any: Vec<String> = fields.iter().map(|f| format!("{f} LIKE '%{clean}%'")).collect();
        terms.push(format!("({})", any.join(" OR ")));
    }
    (!terms.is_empty()).then(|| format!("@SQL={}", terms.join(" AND ")))
}

/// The user's text above an email's HTML (a reply, a forward), escaped.
fn html_above(html: &str, text: &str) -> String {
    let escaped: String = text
        .trim_end()
        .chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\n' => "<br>".to_string(),
            '\r' => String::new(),
            c => c.to_string(),
        })
        .collect();
    let block = format!("<div>{escaped}</div><br>");
    let lower = html.to_ascii_lowercase();
    match lower.find("<body").and_then(|at| lower[at..].find('>').map(|end| at + end + 1)) {
        Some(at) => format!("{}{block}{}", &html[..at], &html[at..]),
        None => format!("{block}{html}"),
    }
}

/// Whether an email's headers have a List-Unsubscribe line.
fn has_unsubscribe(headers: &str) -> bool {
    // Compared as bytes: a header line can have any character at byte 17, and
    // slicing a str there panics when it falls inside one.
    headers.lines().any(|l| l.as_bytes().get(..17).is_some_and(|b| b.eq_ignore_ascii_case(b"list-unsubscribe:")))
}

/// Which of `paths` the agent meant: the whole path, the path without the
/// account, or the folder's own name, when only one folder has it.
fn match_path(paths: &[String], asked: &str) -> Option<usize> {
    let asked = asked.trim().trim_matches('/');
    if asked.is_empty() {
        return None;
    }
    let one = |hits: Vec<usize>| (hits.len() == 1).then(|| hits[0]);
    if let Some(i) = paths.iter().position(|p| p == asked) {
        return Some(i);
    }
    if let Some(i) = one(paths.iter().enumerate().filter(|(_, p)| p.eq_ignore_ascii_case(asked)).map(|(i, _)| i).collect()) {
        return Some(i);
    }
    let without_account = |p: &str| p.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or_default();
    if let Some(i) = one(paths.iter().enumerate().filter(|(_, p)| without_account(p).eq_ignore_ascii_case(asked)).map(|(i, _)| i).collect()) {
        return Some(i);
    }
    one(paths.iter().enumerate().filter(|(_, p)| p.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(asked))).map(|(i, _)| i).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_taken_off_the_card_go_by_name_and_size_not_by_place() {
        let f = |name: &str, size: usize| Some((name.to_string(), size));
        let off = |name: &str, size: usize| (name.to_string(), size);
        // The second of three taken off: its place, whatever the card's order.
        assert_eq!(places_to_remove(&[f("a.pdf", 10), f("b.png", 20), f("c.txt", 30)], &[off("b.png", 20)]), [2]);
        // Outlook couldn't give the first when the card was made (so the card
        // listed two): b.png is still found, and the one it can't give stays.
        assert_eq!(places_to_remove(&[None, f("b.png", 20), f("c.txt", 30)], &[off("b.png", 20)]), [2]);
        // Two alike, one taken off: one goes. The last first, so the places hold.
        assert_eq!(places_to_remove(&[f("logo.png", 5), f("a.pdf", 10), f("logo.png", 5)], &[off("logo.png", 5)]), [3]);
        assert_eq!(places_to_remove(&[f("a.pdf", 10), f("b.png", 20), f("c.txt", 30)], &[off("a.pdf", 10), off("c.txt", 30)]), [3, 1]);
        // Nothing taken off, or a name with another size: nothing goes.
        assert!(places_to_remove(&[f("a.pdf", 10)], &[]).is_empty());
        assert!(places_to_remove(&[f("a.pdf", 10)], &[off("a.pdf", 11)]).is_empty());
    }

    #[test]
    fn outlook_is_started_a_minute_after_lumo() {
        assert_eq!(start_wait(Duration::from_secs(4)), Some(START_AFTER - Duration::from_secs(4)));
        assert_eq!(start_wait(START_AFTER), None);
        assert_eq!(start_wait(START_AFTER + Duration::from_secs(30)), None);
    }

    #[test]
    fn outlook_dates_become_header_dates() {
        // 8 November 2026, 17:33:00.
        assert_eq!(civil(46_334.0 + (17.0 * 3600.0 + 33.0 * 60.0) / 86_400.0), (2026, 11, 8, 17, 33, 0));
        assert_eq!(header_date(2026, 11, 8, 16, 33, 0), "Sun, 8 Nov 2026 16:33:00 +0000");
        assert_eq!(header_date(2024, 2, 29, 0, 0, 5), "Thu, 29 Feb 2024 00:00:05 +0000");
        assert_eq!(civil(25_569.0), (1970, 1, 1, 0, 0, 0));
        // A second short of midnight rounds into the next day, not to 24:00.
        assert_eq!(civil(25_569.0 + 86_399.6 / 86_400.0), (1970, 1, 2, 0, 0, 0));
    }

    #[test]
    fn a_search_is_a_dasl_filter_with_each_word_and_no_quote_breaks_it() {
        assert_eq!(dasl_filter("   "), None);
        let f = dasl_filter("invoice from:amazon").unwrap();
        assert!(f.starts_with("@SQL=("));
        assert!(f.contains("\"urn:schemas:httpmail:subject\" LIKE '%invoice%'"));
        assert!(f.contains(") AND (\"urn:schemas:httpmail:fromname\" LIKE '%amazon%' OR \"urn:schemas:httpmail:fromemail\" LIKE '%amazon%')"));
        let quoted = dasl_filter("l'offerta 100%").unwrap();
        assert!(quoted.contains("'%l''offerta%'") && quoted.contains("'%100%'"));
    }

    #[test]
    fn the_users_words_go_above_the_email_in_its_body() {
        let html = "<html><head></head><BODY lang=IT><p>quoted</p></body></html>";
        assert_eq!(
            html_above(html, "Ciao <Ada> & co\nsì\n"),
            "<html><head></head><BODY lang=IT><div>Ciao &lt;Ada&gt; &amp; co<br>sì</div><br><p>quoted</p></body></html>"
        );
        assert_eq!(html_above("<p>x</p>", "Hi"), "<div>Hi</div><br><p>x</p>");
    }

    #[test]
    fn promotions_are_the_emails_with_an_unsubscribe_header() {
        assert!(has_unsubscribe("From: a@b.it\r\nList-Unsubscribe: <mailto:x@y.z>\r\n"));
        assert!(!has_unsubscribe("From: a@b.it\r\nSubject: list-unsubscribe\r\n"));
    }

    #[test]
    fn a_folder_is_found_by_its_path_or_its_name_when_only_one_has_it() {
        let paths = vec![
            "ada@outlook.it/Posta in arrivo".to_string(),
            "ada@outlook.it/Posta in arrivo/Lavoro".to_string(),
            "bob@work.com/Inbox/Lavoro".to_string(),
            "bob@work.com/Inbox".to_string(),
        ];
        assert_eq!(match_path(&paths, "ada@outlook.it/Posta in arrivo"), Some(0));
        assert_eq!(match_path(&paths, "bob@work.com/inbox/lavoro"), Some(2));
        assert_eq!(match_path(&paths, "Posta in arrivo/Lavoro"), Some(1));
        assert_eq!(match_path(&paths, "Lavoro"), None, "two folders are called so");
        assert_eq!(match_path(&paths, "inbox"), Some(3));
        assert_eq!(match_path(&paths, ""), None);
    }

    #[test]
    fn ids_are_short_stay_the_same_and_follow_a_moved_email() {
        let mut book = Book::default();
        let a = book.id_for("AAAA", "S1");
        assert_eq!(a, "outlook-1");
        assert_eq!(book.id_for("AAAA", "S1"), a);
        assert_eq!(book.id_for("BBBB", "S1"), "outlook-2");
        assert_eq!(book.entry_of(" outlook-1 "), Some(("AAAA".into(), "S1".into())));
        assert_eq!(book.entry_of("outlook-9"), None);
        assert_eq!(book.entry_of("inbox:1"), None);
        book.repoint("outlook-1", "CCCC".into(), String::new());
        assert_eq!(book.entry_of("outlook-1"), Some(("CCCC".into(), "S1".into())));
        assert_eq!(book.id_for("CCCC", "S1"), "outlook-1");
        assert!(is_id("outlook-3") && !is_id("inbox:3") && is_folder("outlook:ada/Inbox") && !is_folder("Sent"));
    }

    #[test]
    fn a_cached_email_whose_id_started_again_never_takes_lumo_down() {
        let mut book = Book::default();
        let old = book.id_for("E1", "S1");
        // Past MOST_IDS (wide agent searches), the ids start again.
        for i in 0..MOST_IDS {
            book.id_for(&format!("X{i}"), "S1");
        }
        let new = book.id_for("E1", "S1");
        assert_ne!(old, new);
        assert_eq!(book.entry_of(&old), None);
        // A message cached before still carrying its old id: left out of the
        // cache (read again next time), where `entries[&m.id]` panicked and,
        // with panic = "abort", closed Lumo.
        let stale = Message { id: old.clone(), subject: "Hi".into(), ..Message::default() };
        let inbox = Inbox { unread: 1, messages: vec![(stale, 1.0)], entries: HashMap::from([(new.clone(), "E1".to_string())]) };
        assert!(cache_of(&inbox).is_empty());
        // As look() gives it now, under the id it has now: kept by its EntryID.
        let fresh = Message { id: new.clone(), subject: "Hi".into(), ..Message::default() };
        let inbox = Inbox { unread: 1, messages: vec![(fresh.clone(), 2.0)], entries: HashMap::from([(new, "E1".to_string())]) };
        assert_eq!(cache_of(&inbox).get("E1"), Some(&(fresh, 2.0)));
    }
}
