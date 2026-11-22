// The emails the agents write (mail_agents.rs): with Settings → Security →
// Email's "Read and send", send, reply in the conversation, forward with the
// files and save drafts in the mailbox's Drafts, over SMTP (smtp.rs) or the
// classic Outlook. Each email is on its card, gone only when the user clicks
// Send.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;

use crate::i18n::t;
use crate::log;
use crate::mail::{imap_ready, timed_for, wake, Account};
use crate::mail_agents::{account_for, attached_bytes, bad_id, close, enter, find_role, full_text, gone, header_and_body, mailboxes, open, parse_id, structure, tool_accounts, FULL_BYTES, Folder, QUOTED_CHARS, Role, SLOW_TIMEOUT};
use crate::mail_imap::{is_gmail, quoted, search_uids, Part};
use crate::mail_parse::{clean_header, decode_words, parse_from, parse_headers};

/// A new email goes out of Outlook when it is on and running, else over SMTP.
pub(crate) async fn sends_from_outlook(app: &AppHandle) -> bool {
    crate::outlook::on(app) && (!imap_ready(app) || crate::outlook::running().await)
}

/// `mail_send` out of Outlook.
pub(crate) async fn outlook_send(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let (mail, paths) = outgoing(input)?;
    let draft = crate::outlook::Draft::New { to: mail.to, cc: mail.cc };
    outlook_deliver(app, "mail_send", draft, mail.subject, mail.body, paths).await
}

/// `mail_reply` to an Outlook email: Outlook's own reply, in its conversation.
pub(crate) async fn outlook_reply(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (_, body) = subject_and_body(input)?;
    let all = input.get("reply_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let cc = addresses(input.get("cc"), "cc")?;
    let (_, paths): (Vec<_>, Vec<_>) = attachments(input.get("attachments"))?.into_iter().unzip();
    let draft = crate::outlook::Draft::Reply { id, all, cc };
    outlook_deliver(app, "mail_reply", draft, String::new(), body, paths).await
}

/// `mail_forward` of an Outlook email, with its files unless `with_files` is false.
pub(crate) async fn outlook_forward(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let to = addresses(input.get("to"), "to")?;
    let cc = addresses(input.get("cc"), "cc")?;
    if to.is_empty() {
        return Err("Say who to forward the email to (to).".into());
    }
    let note = input.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if note.len() > crate::smtp::MAX_BODY / 2 {
        return Err("The email's text is too long.".into());
    }
    let with_files = input.get("with_files").and_then(|v| v.as_bool()).unwrap_or(true);
    let draft = crate::outlook::Draft::Forward { id, to, cc, with_files };
    outlook_deliver(app, "mail_forward", draft, String::new(), note, Vec::new()).await
}

/// `mail_draft` in Outlook's Drafts: nothing is sent, no card.
pub(crate) async fn outlook_draft(input: &serde_json::Value) -> Result<String, String> {
    let (mail, paths) = outgoing_for(input, false)?;
    let draft = match input.get("reply_to").and_then(|v| v.as_str()).map(str::trim).filter(|r| !r.is_empty()) {
        Some(id) if crate::outlook::is_id(id) => crate::outlook::Draft::Reply { id: id.to_string(), all: false, cc: mail.cc },
        _ => crate::outlook::Draft::New { to: mail.to, cc: mail.cc },
    };
    let made = crate::outlook::make(draft, mail.subject, mail.body, paths).await?;
    let place = crate::outlook::keep_draft(&made).await?;
    log::line("[outlook] a draft saved");
    Ok(format!("Saved in Outlook's {place}: the user finds it among their drafts, to read, finish and send themselves. It was not sent."))
}

/// Any email the AI sends out of Outlook: made in Outlook, shown whole on its
/// card, and sent only once the user clicks Send; thrown away otherwise.
async fn outlook_deliver(
    app: &AppHandle,
    tool: &str,
    draft: crate::outlook::Draft,
    subject: String,
    text: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let mut made = crate::outlook::make(draft, subject, text, paths).await?;
    let names: Vec<String> = made.files.iter().filter_map(|f| f.get("name").and_then(|n| n.as_str()).map(str::to_string)).collect();
    let shown = crate::smtp::Outgoing { to: made.to.clone(), cc: made.cc.clone(), subject: made.subject.clone(), body: made.body.clone(), ..Default::default() };
    let card = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "tool_name": format!("mcp__lumo__{tool}"),
        "tool_input": { "to": made.to, "cc": made.cc, "subject": made.subject, "attachments": names },
        "lumo_mail_send": card_mail(&made.from, &shown, &made.files, &[]),
    });
    let answer = crate::pipe::ask(app, card).await;
    let revised = match card_answer(answer.as_deref()) {
        Ok(revised) => revised,
        Err(e) => {
            let _ = crate::outlook::finish(&made, false).await;
            return Err(e);
        }
    };
    // What the user changed goes into Outlook's email before it is sent.
    let mut changed = Vec::new();
    if let Some(revised) = &revised {
        let revision = match outlook_revision(&made, revised) {
            Ok(r) => r,
            Err(e) => {
                let _ = crate::outlook::finish(&made, false).await;
                return Err(not_sent_after_changes(e));
            }
        };
        changed = revision.changed.clone();
        if let Err(e) = crate::outlook::revise(&mut made, revision).await {
            let _ = crate::outlook::finish(&made, false).await;
            return Err(not_sent_after_changes(e));
        }
    }
    crate::outlook::finish(&made, true).await.inspect_err(|e| log::line(format!("[outlook] send: {e}")))?;
    log::line(format!("[outlook] sent to {} people", made.to.len() + made.cc.len()));
    wake();
    let done = format!("Sent from Outlook to {}.", made.to.iter().chain(&made.cc).cloned().collect::<Vec<_>>().join(", "));
    let went = crate::smtp::Outgoing { to: made.to.clone(), cc: made.cc.clone(), subject: made.subject.clone(), body: made.body.clone(), ..Default::default() };
    let mut out = with_changes(done, &changed, &made.from, &went);
    if !changed.is_empty() && !made.files.is_empty() {
        let names: Vec<&str> = made.files.iter().filter_map(|f| f.get("name").and_then(|n| n.as_str())).collect();
        out = out.replacen("\nText:\n", &format!("\nFiles: {}\nText:\n", names.join(", ")), 1);
    }
    Ok(out)
}

/// The email as the user left it on its card, checked as in `revise`, for
/// Outlook's own email (outlook.rs revise).
fn outlook_revision(made: &crate::outlook::Made, revised: &serde_json::Value) -> Result<crate::outlook::Revision, String> {
    let mut mail = crate::smtp::Outgoing { to: made.to.clone(), cc: made.cc.clone(), subject: made.subject.clone(), body: made.body.clone(), ..Default::default() };
    // The files stay in Outlook: only their places and the paths added are needed.
    let count = made.files.len();
    let keep: Vec<usize> = revised
        .get("keep")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|i| i.as_u64()).map(|i| i as usize).filter(|i| *i < count).collect())
        .unwrap_or_else(|| (0..count).collect());
    let mut keep = keep;
    keep.sort_unstable();
    keep.dedup();
    let add: Vec<String> = revised.get("add").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str()).map(str::to_string).collect()).unwrap_or_default();
    let mut words = json!(revised);
    words["keep"] = json!([]);
    words["add"] = json!([]);
    let mut changed = revise(&mut mail, &words)?;
    changed.retain(|c| *c != "the files attached");
    let added = read_picked(&add)?;
    if keep.len() + added.len() > crate::smtp::MAX_ATTACHMENTS {
        return Err(format!("at most {} files attached.", crate::smtp::MAX_ATTACHMENTS));
    }
    let kept: u64 = keep.iter().filter_map(|&i| made.files[i].get("size").and_then(|s| s.as_u64())).sum();
    if kept + added.iter().map(|f| f.bytes.len() as u64).sum::<u64>() > crate::smtp::MAX_ATTACHED_BYTES {
        return Err(too_heavy());
    }
    if keep.len() != count || !add.is_empty() {
        changed.push("the files attached");
    }
    // Taken out of Outlook by name and size (outlook.rs places_to_remove), not by their place here.
    let drop = (0..count)
        .filter(|i| !keep.contains(i))
        .map(|i| {
            let file = &made.files[i];
            (file.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(), file.get("size").and_then(|s| s.as_u64()).unwrap_or(0) as usize)
        })
        .collect();
    Ok(crate::outlook::Revision {
        new_body: (mail.body != made.body).then(|| mail.body.clone()),
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        drop,
        add,
        changed,
    })
}

/// The addresses of `mail_send`'s `to` or `cc`: a list or one string, each checked.
fn addresses(v: Option<&serde_json::Value>, field: &str) -> Result<Vec<String>, String> {
    let list: Vec<String> = match v {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::String(s)) => s.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect(),
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(|a| a.trim().to_string()).collect(),
        Some(_) => return Err(format!("{field} must be a list of email addresses.")),
    };
    match list.iter().find(|a| !crate::smtp::valid_address(a)) {
        Some(bad) => Err(format!("{bad} is not an email address Lumo can send to (give plain addresses, like name@example.com).")),
        None => Ok(list),
    }
}

/// A file the AI may attach: one the user attached to the chat (in the
/// inbox), or any other but those in app data (%APPDATA%, %LOCALAPPDATA%,
/// where programs keep their own and the user's secrets) or in a hidden
/// folder (`.ssh`, `.aws`…). The card shows each one before Send all the same.
fn may_attach(real: &std::path::Path, inbox: Option<&std::path::Path>, app_data: &[std::path::PathBuf]) -> bool {
    if inbox.is_some_and(|inbox| real.starts_with(inbox)) {
        return true;
    }
    let hidden = real.components().any(|c| matches!(c, std::path::Component::Normal(n) if n.to_string_lossy().starts_with('.')));
    !hidden && !app_data.iter().any(|d| real.starts_with(d))
}

/// `mail_send`'s `attachments`: full paths of files, each checked and read.
fn attachments(v: Option<&serde_json::Value>) -> Result<Vec<(crate::smtp::Attachment, String)>, String> {
    let paths: Vec<String> = match v {
        None | Some(serde_json::Value::Null) => return Ok(Vec::new()),
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect(),
        Some(_) => return Err("attachments must be a list of full paths of files.".into()),
    };
    if paths.len() > crate::smtp::MAX_ATTACHMENTS {
        return Err(format!("At most {} files attached.", crate::smtp::MAX_ATTACHMENTS));
    }
    let inbox = crate::files::inbox_dir().canonicalize().ok();
    let app_data: Vec<std::path::PathBuf> = ["APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .filter_map(|d| std::path::PathBuf::from(d).canonicalize().ok())
        .collect();
    let mut total = 0u64;
    let mut out = Vec::new();
    for raw in paths {
        let path = std::path::Path::new(raw.trim());
        let real = path
            .is_absolute()
            .then(|| path.canonicalize().ok())
            .flatten()
            .filter(|r| r.is_file())
            .ok_or_else(|| format!("{raw} is not a file Lumo can find (give its full path)."))?;
        if !may_attach(&real, inbox.as_deref(), &app_data) {
            return Err(format!("{raw} is in a folder Lumo never sends files from (app data or a hidden folder)."));
        }
        total += std::fs::metadata(&real).map(|m| m.len()).unwrap_or(0);
        if total > crate::smtp::MAX_ATTACHED_BYTES {
            return Err(too_heavy());
        }
        let bytes = std::fs::read(&real).map_err(|e| format!("Lumo couldn't read {raw}: {e}"))?;
        let name = real.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let mime = crate::smtp::mime_of(&name);
        out.push((crate::smtp::Attachment { name, mime, bytes }, path.to_string_lossy().to_string()));
    }
    Ok(out)
}

pub(crate) fn too_heavy() -> String {
    format!("The files attached weigh more than {} MB together.", crate::smtp::MAX_ATTACHED_BYTES / (1024 * 1024))
}

/// The subject and the text, checked.
fn subject_and_body(input: &serde_json::Value) -> Result<(String, String), String> {
    let subject = input.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let body = input.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if subject.chars().count() > crate::smtp::MAX_SUBJECT {
        return Err("The subject is too long.".into());
    }
    if body.trim().is_empty() {
        return Err("The email has no text (body).".into());
    }
    if body.len() > crate::smtp::MAX_BODY {
        return Err("The email's text is too long.".into());
    }
    Ok((subject, body))
}

/// `mail_send`'s input, checked: who, the subject, the text, the files.
pub fn outgoing(input: &serde_json::Value) -> Result<(crate::smtp::Outgoing, Vec<String>), String> {
    outgoing_for(input, true)
}

/// As `outgoing`; a draft (`needs_to` false) may have nobody yet.
fn outgoing_for(input: &serde_json::Value, needs_to: bool) -> Result<(crate::smtp::Outgoing, Vec<String>), String> {
    let to = addresses(input.get("to"), "to")?;
    let cc = addresses(input.get("cc"), "cc")?;
    if needs_to && to.is_empty() {
        return Err("Say who the email is for (to).".into());
    }
    if to.len() + cc.len() > crate::smtp::MAX_RECIPIENTS {
        return Err(format!("At most {} people, to and cc together.", crate::smtp::MAX_RECIPIENTS));
    }
    let (subject, body) = subject_and_body(input)?;
    let (attachments, paths): (Vec<_>, Vec<_>) = attachments(input.get("attachments"))?.into_iter().unzip();
    Ok((crate::smtp::Outgoing { to, cc, subject, body, attachments, ..Default::default() }, paths))
}

/// `mail_send`: the email on a card of its own on the island, sent only when
/// the user clicks Send. Nothing (Auto, Turbo, a trusted tool) skips the card.
pub(crate) async fn send(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let (mail, paths) = outgoing(input)?;
    let files = card_files(&mail, &paths);
    let accounts = tool_accounts(app)?;
    // A new email may go from any of the accounts: the card's From picks one.
    deliver(app, "mail_send", mail, files, &accounts[0], &accounts).await
}

/// The files of an email as its card lists them: name, size, and the path it came from (none for an email's own).
fn card_files(mail: &crate::smtp::Outgoing, paths: &[String]) -> Vec<serde_json::Value> {
    mail.attachments
        .iter()
        .enumerate()
        .map(|(i, f)| json!({ "name": f.name, "size": f.bytes.len(), "path": paths.get(i).cloned().unwrap_or_default() }))
        .collect()
}

/// Any email the AI sends (a new one, a reply, a forward): on its card, whole,
/// and sent only once the user clicks Send, as the user left it on the card
/// (they may change who it goes to, its subject, its text and its files, and
/// with more than one account in `accounts`, who it is from). Then a copy in
/// Sent, where the server keeps none itself.
async fn deliver(
    app: &AppHandle,
    tool: &str,
    mut mail: crate::smtp::Outgoing,
    files: Vec<serde_json::Value>,
    acct: &Account,
    accounts: &[Account],
) -> Result<String, String> {
    let names: Vec<&str> = mail.attachments.iter().map(|f| f.name.as_str()).collect();
    let from = acct.address.trim().to_string();
    let choices: Vec<&str> = if accounts.len() > 1 { accounts.iter().map(|a| a.address.trim()).collect() } else { Vec::new() };
    let card = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "tool_name": format!("mcp__lumo__{tool}"),
        "tool_input": { "to": mail.to, "cc": mail.cc, "subject": mail.subject, "attachments": names },
        "lumo_mail_send": card_mail(&from, &mail, &files, &choices),
    });
    let answer = crate::pipe::ask(app, card).await;
    let revised = card_answer(answer.as_deref())?;
    let mut acct = acct;
    let mut changed = Vec::new();
    if let Some(revised) = &revised {
        changed = revise(&mut mail, revised).map_err(not_sent_after_changes)?;
        if let Some(asked) = revised.get("from").and_then(|v| v.as_str()).map(str::trim).filter(|a| !a.is_empty() && *a != from) {
            acct = accounts.iter().find(|a| a.address.trim().eq_ignore_ascii_case(asked)).ok_or_else(|| not_sent_after_changes(format!("{asked} is not one of the user's accounts.")))?;
            changed.insert(0, "the account it is sent from");
        }
    }
    let sent = crate::smtp::send(&mail, acct).await.inspect_err(|e| log::line(format!("[mail] send: {e}")))?;
    log::line(format!("[mail] sent through {} to {} people", sent.host, mail.to.len() + mail.cc.len()));
    keep_copy(sent, acct.clone());
    let done = format!("Sent to {}.", mail.to.iter().chain(&mail.cc).cloned().collect::<Vec<_>>().join(", "));
    Ok(with_changes(done, &changed, &acct.address, &mail))
}

/// The email as its card shows it (views.ts emailEditor), with the limits its
/// fields are checked against there and again here.
fn card_mail(from: &str, mail: &crate::smtp::Outgoing, files: &[serde_json::Value], accounts: &[&str]) -> serde_json::Value {
    json!({
        "from": from, "to": mail.to, "cc": mail.cc, "subject": mail.subject, "body": mail.body, "attachments": files,
        "accounts": accounts,
        "limits": {
            "recipients": crate::smtp::MAX_RECIPIENTS,
            "subject": crate::smtp::MAX_SUBJECT,
            "body": crate::smtp::MAX_BODY,
            "files": crate::smtp::MAX_ATTACHMENTS,
            "bytes": crate::smtp::MAX_ATTACHED_BYTES,
        },
    })
}

/// The click on an email's card: Send as it was (None), Send as the user
/// changed it (the email on the card, pipe.rs answer_mail), or not sent.
fn card_answer(answer: Option<&str>) -> Result<Option<serde_json::Value>, String> {
    match answer {
        Some("allow") => Ok(None),
        Some(d) if d.starts_with('{') => serde_json::from_str::<serde_json::Value>(d)
            .ok()
            .and_then(|v| v.get("revised").filter(|r| r.is_object()).cloned())
            .map(Some)
            .ok_or_else(|| "Lumo couldn't read the email as the user left it on the card: it was not sent.".to_string()),
        Some(_) => Err("The user discarded the email: it was not sent. Ask them what to change if they want it sent.".into()),
        None => Err("Lumo couldn't show the email to the user (the island is paused or busy, or nobody clicked Send in time): it was not sent.".into()),
    }
}

/// What the AI reads when the user's changes couldn't be used.
fn not_sent_after_changes(why: String) -> String {
    format!("The user changed the email on its card and clicked Send, but Lumo couldn't use it: {why} It was not sent. Ask the user what they want.")
}

/// The email as the user left it on its card, checked as the AI's is, put in
/// `mail`: who it goes to, its subject, its text, the files kept (`keep`, by
/// their place on the card) and the ones the user added with Attach (`add`,
/// only files picked in the picker, `pick_attachments`). What changed, in
/// words for the AI. The conversation it answers (a reply's) stays.
fn revise(mail: &mut crate::smtp::Outgoing, revised: &serde_json::Value) -> Result<Vec<&'static str>, String> {
    let to = addresses(revised.get("to"), "to")?;
    let cc = addresses(revised.get("cc"), "cc")?;
    if to.is_empty() {
        return Err("it has nobody to go to.".into());
    }
    if to.len() + cc.len() > crate::smtp::MAX_RECIPIENTS {
        return Err(format!("at most {} people, to and cc together.", crate::smtp::MAX_RECIPIENTS));
    }
    let (subject, body) = subject_and_body(revised)?;
    let mut keep: Vec<usize> = revised
        .get("keep")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|i| i.as_u64()).map(|i| i as usize).filter(|i| *i < mail.attachments.len()).collect())
        .unwrap_or_else(|| (0..mail.attachments.len()).collect());
    keep.sort_unstable();
    keep.dedup();
    let added: Vec<String> = revised.get("add").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str()).map(str::to_string).collect()).unwrap_or_default();
    let mut files: Vec<crate::smtp::Attachment> = keep.iter().map(|&i| mail.attachments[i].clone()).collect();
    files.extend(read_picked(&added)?);
    if files.len() > crate::smtp::MAX_ATTACHMENTS {
        return Err(format!("at most {} files attached.", crate::smtp::MAX_ATTACHMENTS));
    }
    if files.iter().map(|f| f.bytes.len() as u64).sum::<u64>() > crate::smtp::MAX_ATTACHED_BYTES {
        return Err(too_heavy());
    }
    let same = |a: &[String], b: &[String]| a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y));
    let mut changed = Vec::new();
    if !same(&to, &mail.to) || !same(&cc, &mail.cc) {
        changed.push("who it goes to");
    }
    if subject != mail.subject.trim() {
        changed.push("the subject");
    }
    if body != mail.body {
        changed.push("the text");
    }
    if keep.len() != mail.attachments.len() || !added.is_empty() {
        changed.push("the files attached");
    }
    *mail = crate::smtp::Outgoing { to, cc, subject, body, attachments: files, ..std::mem::take(mail) };
    Ok(changed)
}

/// The tool's answer, and when the user changed the email first, what went:
/// the AI must not go on from its own version.
fn with_changes(done: String, changed: &[&str], from: &str, mail: &crate::smtp::Outgoing) -> String {
    if changed.is_empty() {
        return done;
    }
    const SHOWN: usize = 4000;
    let mut text: String = mail.body.chars().take(SHOWN).collect();
    if mail.body.chars().count() > SHOWN {
        text.push('…');
    }
    let files: Vec<&str> = mail.attachments.iter().map(|f| f.name.as_str()).collect();
    let mut out = format!("{done}\nBefore Send the user changed the email on its card ({}). This is what went, not what you wrote:\nFrom: {from}\nTo: {}\n", changed.join(", "), mail.to.join(", "));
    if !mail.cc.is_empty() {
        out.push_str(&format!("Cc: {}\n", mail.cc.join(", ")));
    }
    out.push_str(&format!("Subject: {}\n", mail.subject));
    if !files.is_empty() {
        out.push_str(&format!("Files: {}\n", files.join(", ")));
    }
    out.push_str(&format!("Text:\n{text}"));
    out
}

/// How long a file picked with Attach on an email's card may be sent: the
/// card itself waits at most pipe.rs MAIL_CARD_TIMEOUT.
const PICKED_VALID_FOR: Duration = Duration::from_secs(15 * 60);

/// Files the user picked with Attach on an email's card, and when: the only
/// files the card can add (a path the page names is not enough).
static PICKED: Mutex<Vec<(std::path::PathBuf, std::time::Instant)>> = Mutex::new(Vec::new());

/// Attach on an email's card: the system's picker, then each file's name,
/// size and path for the card. Only what the user picked there can be added.
/// The picker belongs to the island (`window`), so it shows over it.
#[tauri::command]
pub async fn pick_attachments(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_parent(&window).blocking_pick_files())
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let now = std::time::Instant::now();
    let mut out = Vec::new();
    let mut list = PICKED.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|(_, at)| now.duration_since(*at) < PICKED_VALID_FOR);
    for file in picked {
        let Ok(path) = file.into_path() else { continue };
        let Ok(real) = path.canonicalize() else { continue };
        let Ok(meta) = std::fs::metadata(&real) else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = real.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        out.push(json!({ "name": name, "size": meta.len(), "path": path.to_string_lossy() }));
        list.push((real, now));
    }
    Ok(out)
}

/// The files added with Attach, read: each one must have been picked there.
fn read_picked(paths: &[String]) -> Result<Vec<crate::smtp::Attachment>, String> {
    let now = std::time::Instant::now();
    let mut out = Vec::new();
    for raw in paths {
        let real = std::path::Path::new(raw.trim()).canonicalize().map_err(|_| format!("{raw} is no longer there."))?;
        let picked = PICKED.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(p, at)| *p == real && now.duration_since(*at) < PICKED_VALID_FOR);
        if !picked {
            return Err(format!("{raw} was not picked with Attach on the card."));
        }
        let bytes = std::fs::read(&real).map_err(|e| format!("Lumo couldn't read {raw}: {e}"))?;
        let name = real.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let mime = crate::smtp::mime_of(&name);
        out.push(crate::smtp::Attachment { name, mime, bytes });
    }
    Ok(out)
}

/// How long after sending Lumo looks in Sent for the server's own copy.
const SENT_COPY_AFTER: Duration = Duration::from_secs(10);

/// Gmail keeps in Sent what it sends, and so do most servers; for one that
/// didn't, a copy goes there over IMAP, a little later, once.
fn keep_copy(sent: crate::smtp::Sent, acct: Account) {
    if is_gmail(&acct.host().0) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SENT_COPY_AFTER).await;
        match sent_copy(&acct, &sent).await {
            Ok(true) => log::line("[mail] a copy of the email sent put in Sent"),
            Ok(false) => {}
            Err(e) => log::line(format!("[mail] no copy in Sent: {e}")),
        }
    });
}

/// Puts the email sent in Sent, unless the server already did. Whether it did.
async fn sent_copy(acct: &Account, sent: &crate::smtp::Sent) -> Result<bool, String> {
    let (mut imap, host) = open(acct).await?;
    let done = timed_for(SLOW_TIMEOUT, &host, async {
        let boxes = mailboxes(&mut imap).await?;
        let place = find_role(&boxes, Role::Sent).ok_or_else(|| "the mailbox has no Sent folder".to_string())?.wire.clone();
        imap.run(&format!("EXAMINE {}", quoted(&place))).await?;
        let units = imap.run(&format!("UID SEARCH HEADER Message-ID {}", quoted(&sent.message_id))).await?;
        if !search_uids(&units).is_empty() {
            return Ok(false);
        }
        imap.run_literal(&format!("APPEND {} (\\Seen)", quoted(&place)), &sent.data).await?;
        Ok(true)
    })
    .await;
    close(imap).await;
    done
}

/// What a reply or a forward needs of the email it is about.
#[derive(Clone, Debug, Default, PartialEq)]
struct Original {
    from: String,
    address: String,
    reply_to: Vec<String>,
    to: Vec<String>,
    cc: Vec<String>,
    subject: String,
    date: String,
    message_id: String,
    references: String,
    /// Its whole text.
    text: String,
}

/// The addresses of a To or Cc header (`"Rossi, Ada" <ada@x.it>, bob@y.it`), plain.
fn address_list(raw: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut piece = String::new();
    let (mut quoted, mut angle, mut escaped) = (false, false, false);
    for c in decode_words(raw).chars() {
        // `\"` inside a quoted name is a quote of the name, not its end.
        if std::mem::take(&mut escaped) {
            piece.push(c);
            continue;
        }
        match c {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '<' => angle = true,
            '>' => angle = false,
            ',' | ';' if !quoted && !angle => {
                pieces.push(std::mem::take(&mut piece));
                continue;
            }
            _ => {}
        }
        piece.push(c);
    }
    pieces.push(piece);
    let mut out: Vec<String> = Vec::new();
    for address in pieces.iter().map(|p| parse_from(p).1.trim().to_string()) {
        if crate::smtp::valid_address(&address) && !out.iter().any(|a| a.eq_ignore_ascii_case(&address)) {
            out.push(address);
        }
    }
    out
}

/// The email from a FETCH of its whole header and its text.
fn original_of(unit: &[Part]) -> Original {
    let (header, _) = header_and_body(unit);
    let headers = parse_headers(header);
    let field = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).unwrap_or("");
    let (from, address) = parse_from(&decode_words(field("From")));
    Original {
        from: clean_header(&from),
        address: address.trim().to_string(),
        reply_to: address_list(field("Reply-To")),
        to: address_list(field("To")),
        cc: address_list(field("Cc")),
        subject: clean_header(&decode_words(field("Subject"))),
        date: field("Date").trim().to_string(),
        message_id: crate::smtp::message_ids(field("Message-ID")),
        references: crate::smtp::message_ids(field("References")),
        text: full_text(unit),
    }
}

/// Email `id`, with its files when `with_files` (a forward).
/// The account it is of answers it.
async fn fetch_original(app: &AppHandle, id: &str, with_files: bool) -> Result<(Original, Vec<crate::smtp::Attachment>, Account), String> {
    let (acct, plain) = account_for(app, id)?;
    let (folder, uid) = parse_id(&plain).ok_or_else(|| bad_id(id))?;
    let (mut imap, host) = open(&acct).await?;
    let got = timed_for(SLOW_TIMEOUT, &host, async {
        if folder != Folder::Inbox {
            enter(&mut imap, &folder, false).await?;
        }
        let units = imap.run(&format!("UID FETCH {uid} (UID BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.{FULL_BYTES}>)")).await?;
        let unit = units.iter().find(|u| matches!(u.first(), Some(Part::Text(l)) if l.contains(" FETCH "))).ok_or_else(|| gone(id))?;
        let original = original_of(unit);
        let mut files = Vec::new();
        if with_files {
            let mut total = 0usize;
            let attached = structure(&mut imap, uid).await?;
            if attached.len() > crate::smtp::MAX_ATTACHMENTS {
                return Err(format!(
                    "The email has {} files attached: Lumo forwards {} at most. The email can still be forwarded without them (with_files false).",
                    attached.len(),
                    crate::smtp::MAX_ATTACHMENTS
                ));
            }
            for file in &attached {
                total += file.file_size();
                if total as u64 > crate::smtp::MAX_ATTACHED_BYTES {
                    return Err(format!("{} The email can still be forwarded without them (with_files false).", too_heavy()));
                }
                let bytes = attached_bytes(&mut imap, uid, file).await?;
                files.push(crate::smtp::Attachment { mime: crate::smtp::mime_of(&file.name), name: file.name.clone(), bytes });
            }
        }
        Ok((original, files))
    })
    .await;
    close(imap).await;
    got.map(|(original, files)| (original, files, acct))
}

/// "Re: Lunch", once.
fn re_subject(subject: &str) -> String {
    let s = subject.trim();
    if s.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("re:")) { s.to_string() } else { format!("Re: {s}") }
}

/// "Fwd: Lunch", once.
fn fwd_subject(subject: &str) -> String {
    let s = subject.trim();
    let done = ["fwd:", "fw:", "i:", "tr:", "rv:"].iter().any(|p| s.get(..p.len()).is_some_and(|h| h.eq_ignore_ascii_case(p)));
    if done { s.to_string() } else { format!("Fwd: {s}") }
}

/// Who a reply goes to: the sender (or their Reply-To); with `all`, everyone
/// else who had it in copy, the user's own address left out.
fn reply_people(original: &Original, me: &str, all: bool) -> (Vec<String>, Vec<String>) {
    let to: Vec<String> = if original.reply_to.is_empty() { vec![original.address.clone()] } else { original.reply_to.clone() };
    let to: Vec<String> = to.into_iter().filter(|a| crate::smtp::valid_address(a)).collect();
    let mut cc = Vec::new();
    if all {
        for a in original.to.iter().chain(&original.cc) {
            let known = a.eq_ignore_ascii_case(me) || to.iter().chain(&cc).any(|b: &String| b.eq_ignore_ascii_case(a));
            if !known {
                cc.push(a.clone());
            }
        }
    }
    (to, cc)
}

/// The conversation's References, with the email answered last: the newest 20 ids.
fn thread_of(original: &Original) -> String {
    let mut ids: Vec<&str> = original.references.split_whitespace().collect();
    ids.extend(original.message_id.split_whitespace());
    let keep = ids.len().saturating_sub(20);
    ids[keep..].join(" ")
}

/// Of the email answered, what goes under the reply, each line quoted.
fn quoted_text(original: &Original) -> String {
    let text: String = original.text.chars().take(QUOTED_CHARS).collect();
    if text.trim().is_empty() {
        return String::new();
    }
    let who = if original.from.is_empty() || original.from == original.address { original.address.clone() } else { format!("{} <{}>", original.from, original.address) };
    let mut out = format!("\n\n{}, {who}:\n", original.date);
    for line in text.lines() {
        out.push_str(if line.is_empty() { ">" } else { "> " });
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// `mail_reply`: an answer to email `id`, in its conversation (In-Reply-To,
/// References), to its sender or with `reply_all` everyone, on its card first.
pub(crate) async fn reply(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (_, body) = subject_and_body(input)?;
    let all = input.get("reply_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let more_cc = addresses(input.get("cc"), "cc")?;
    let (files, paths): (Vec<_>, Vec<_>) = attachments(input.get("attachments"))?.into_iter().unzip();
    let (original, _, acct) = fetch_original(app, &id, false).await?;
    let (to, mut cc) = reply_people(&original, &acct.address, all);
    if to.is_empty() {
        return Err("Lumo can't tell who sent this email: use mail_send with their address.".into());
    }
    for a in more_cc {
        if !to.iter().chain(&cc).any(|b| b.eq_ignore_ascii_case(&a)) {
            cc.push(a);
        }
    }
    if to.len() + cc.len() > crate::smtp::MAX_RECIPIENTS {
        return Err(format!("At most {} people, to and cc together.", crate::smtp::MAX_RECIPIENTS));
    }
    let mail = crate::smtp::Outgoing {
        to,
        cc,
        subject: re_subject(&original.subject),
        body: format!("{}{}", body.trim_end(), quoted_text(&original)),
        attachments: files,
        in_reply_to: Some(original.message_id.clone()).filter(|m| !m.is_empty()),
        references: Some(thread_of(&original)).filter(|r| !r.is_empty()),
    };
    let files = card_files(&mail, &paths);
    deliver(app, "mail_reply", mail, files, &acct, &[]).await
}

/// The email forwarded, under the user's words: its header lines, then its text.
fn forwarded_text(note: &str, original: &Original) -> String {
    let who = if original.from.is_empty() || original.from == original.address { original.address.clone() } else { format!("{} <{}>", original.from, original.address) };
    let mut out = String::new();
    if !note.trim().is_empty() {
        out.push_str(note.trim_end());
        out.push_str("\n\n");
    }
    out.push_str(&format!("---------- {} ----------\n", t("Forwarded message")));
    out.push_str(&format!("From: {who}\nDate: {}\nSubject: {}\n", original.date, original.subject));
    if !original.to.is_empty() {
        out.push_str(&format!("To: {}\n", original.to.join(", ")));
    }
    out.push('\n');
    let room = crate::smtp::MAX_BODY.saturating_sub(out.len() + 16);
    let mut text = original.text.clone();
    if text.len() > room {
        let mut cut = room;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
    }
    out.push_str(&text);
    out
}

/// `mail_forward`: email `id` to someone else, with its files unless
/// `with_files` is false, on its card first.
pub(crate) async fn forward(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let to = addresses(input.get("to"), "to")?;
    let cc = addresses(input.get("cc"), "cc")?;
    if to.is_empty() {
        return Err("Say who to forward the email to (to).".into());
    }
    if to.len() + cc.len() > crate::smtp::MAX_RECIPIENTS {
        return Err(format!("At most {} people, to and cc together.", crate::smtp::MAX_RECIPIENTS));
    }
    let note = input.get("body").and_then(|v| v.as_str()).unwrap_or("");
    if note.len() > crate::smtp::MAX_BODY / 2 {
        return Err("The email's text is too long.".into());
    }
    let with_files = input.get("with_files").and_then(|v| v.as_bool()).unwrap_or(true);
    let (original, files, acct) = fetch_original(app, &id, with_files).await?;
    let mail = crate::smtp::Outgoing {
        to,
        cc,
        subject: fwd_subject(&original.subject),
        body: forwarded_text(note, &original),
        attachments: files,
        ..Default::default()
    };
    let files = card_files(&mail, &[]);
    deliver(app, "mail_forward", mail, files, &acct, &[]).await
}

/// `mail_draft`: an email saved in the mailbox's Drafts (IMAP APPEND), for the
/// user to finish and send themselves. Nothing is sent. With `reply_to`, a
/// reply to that email, in its conversation.
pub(crate) async fn draft(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let (mut mail, _) = outgoing_for(input, false)?;
    let mut acct = tool_accounts(app)?.remove(0);
    if let Some(id) = input.get("reply_to").and_then(|v| v.as_str()).filter(|i| !i.trim().is_empty()) {
        let (original, _, of) = fetch_original(app, id, false).await?;
        acct = of;
        if mail.to.is_empty() {
            mail.to = reply_people(&original, &acct.address, false).0;
        }
        if mail.subject.is_empty() {
            mail.subject = re_subject(&original.subject);
        }
        mail.body = format!("{}{}", mail.body.trim_end(), quoted_text(&original));
        mail.in_reply_to = Some(original.message_id.clone()).filter(|m| !m.is_empty());
        mail.references = Some(thread_of(&original)).filter(|r| !r.is_empty());
    }
    let from = acct.address.trim().to_string();
    let (left, secs) = crate::smtp::new_id();
    let data = crate::smtp::message(&from, &mail, secs, &left);
    let (mut imap, host) = open(&acct).await?;
    let saved = timed_for(SLOW_TIMEOUT, &host, async {
        let boxes = mailboxes(&mut imap).await?;
        let place = find_role(&boxes, Role::Drafts).ok_or_else(|| "The mailbox has no Drafts folder: write the draft in the answer instead.".to_string())?.clone();
        imap.run_literal(&format!("APPEND {} (\\Draft \\Seen)", quoted(&place.wire)), &data).await?;
        Ok(place.name)
    })
    .await;
    close(imap).await;
    let place = saved?;
    log::line("[mail] a draft saved");
    Ok(format!("Saved in {place}: the user finds it among their drafts, to read, finish and send themselves. It was not sent."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_send_takes_plain_addresses_a_subject_and_a_text() {
        let (ok, _) = outgoing(&json!({ "to": "ada@example.com, bob@example.com", "subject": "Hi", "body": "Ciao" })).unwrap();
        assert_eq!(ok.to, ["ada@example.com", "bob@example.com"]);
        assert!(ok.cc.is_empty() && ok.attachments.is_empty());
        let (list, _) = outgoing(&json!({ "to": ["ada@example.com"], "cc": ["c@example.com"], "body": "x" })).unwrap();
        assert_eq!((list.cc.len(), list.subject.as_str()), (1, ""));
        assert!(outgoing(&json!({ "to": [], "body": "x" })).is_err(), "nobody");
        assert!(outgoing(&json!({ "to": "ada@example.com", "body": "  " })).is_err(), "no text");
        assert!(outgoing(&json!({ "to": "ada@example.com>\r\nRCPT TO:<eve@example.com", "body": "x" })).is_err());
        let many: Vec<String> = (0..21).map(|i| format!("p{i}@example.com")).collect();
        assert!(outgoing(&json!({ "to": many, "body": "x" })).is_err(), "too many");
    }

    #[test]
    fn mail_send_attaches_files_by_their_full_path() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("target").join("mail-attach-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Analisi2.pdf");
        std::fs::write(&file, b"%PDF-1.7").unwrap();
        let path = file.to_string_lossy().to_string();
        let (mail, paths) = outgoing(&json!({ "to": "ada@example.com", "body": "x", "attachments": [path] })).unwrap();
        assert_eq!(mail.attachments.len(), 1);
        assert_eq!((mail.attachments[0].name.as_str(), mail.attachments[0].mime), ("Analisi2.pdf", "application/pdf"));
        assert_eq!(mail.attachments[0].bytes, b"%PDF-1.7");
        assert_eq!(paths, std::slice::from_ref(&path));
        let (one, _) = outgoing(&json!({ "to": "ada@example.com", "body": "x", "attachments": path })).unwrap();
        assert_eq!(one.attachments.len(), 1, "one path as a string");
        for bad in [json!(["Analisi2.pdf"]), json!([dir.join("missing.pdf").to_string_lossy()]), json!([dir.to_string_lossy()]), json!(3)] {
            assert!(outgoing(&json!({ "to": "ada@example.com", "body": "x", "attachments": bad })).is_err(), "{bad}");
        }
        let many = vec![path; crate::smtp::MAX_ATTACHMENTS + 1];
        assert!(outgoing(&json!({ "to": "ada@example.com", "body": "x", "attachments": many })).is_err());
    }

    #[test]
    fn files_in_app_data_or_hidden_folders_are_never_attached_but_the_chats_are() {
        use std::path::{Path, PathBuf};
        let inbox = Path::new("C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox");
        let app_data = [PathBuf::from("C:\\Users\\me\\AppData\\Roaming"), PathBuf::from("C:\\Users\\me\\AppData\\Local")];
        let ok = |p: &str| may_attach(Path::new(p), Some(inbox), &app_data);
        assert!(ok("C:\\Users\\me\\Documents\\Analisi2.pdf"));
        assert!(ok("C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox\\Analisi2.pdf"), "attached to the chat");
        assert!(!ok("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data"));
        assert!(!ok("C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\x"));
        assert!(!ok("C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\settings.json"));
        assert!(!ok("C:\\Users\\me\\.ssh\\id_ed25519"));
        assert!(!ok("D:\\work\\.git\\config"));
    }

    #[test]
    fn a_reply_goes_to_the_sender_and_with_all_to_the_others_but_me() {
        let header = b"From: \"Rossi, Ada\" <ada@example.com>\r\nTo: me@example.it, \"Bob\" <bob@example.com>\r\nCc: =?UTF-8?Q?Caf=C3=A8?= <cafe@example.com>; me@example.it\r\nSubject: Pranzo\r\nDate: Wed, 28 Oct 2026 12:00:00 +0100\r\nMessage-ID: <a2@example.com>\r\nReferences: <a0@example.com>\r\n <a1@example.com>\r\nContent-Type: text/plain\r\n\r\n".to_vec();
        let unit = vec![
            Part::Text("* 1 FETCH (UID 4 BODY[HEADER] {300}".into()),
            Part::Literal(header),
            Part::Text(" BODY[TEXT]<0> {20}".into()),
            Part::Literal(b"Ci vediamo?\nA dopo".to_vec()),
            Part::Text(")".into()),
        ];
        let original = original_of(&unit);
        assert_eq!((original.from.as_str(), original.address.as_str()), ("Rossi, Ada", "ada@example.com"));
        assert_eq!(original.to, ["me@example.it", "bob@example.com"]);
        assert_eq!(original.cc, ["cafe@example.com", "me@example.it"]);
        assert_eq!(reply_people(&original, "ME@example.it", false), (vec!["ada@example.com".to_string()], vec![]));
        assert_eq!(reply_people(&original, "ME@example.it", true).1, ["bob@example.com", "cafe@example.com"]);
        let with_reply_to = Original { reply_to: vec!["list@example.com".into()], ..original.clone() };
        assert_eq!(reply_people(&with_reply_to, "me@example.it", false).0, ["list@example.com"]);
        assert_eq!(thread_of(&original), "<a0@example.com> <a1@example.com> <a2@example.com>");
        assert_eq!(re_subject("Pranzo"), "Re: Pranzo");
        assert_eq!(re_subject("RE: Pranzo"), "RE: Pranzo");
        assert_eq!(fwd_subject("Pranzo"), "Fwd: Pranzo");
        assert_eq!(fwd_subject("I: Pranzo"), "I: Pranzo");
        let quote = quoted_text(&original);
        assert!(quote.starts_with("\n\nWed, 28 Oct 2026 12:00:00 +0100, Rossi, Ada <ada@example.com>:\n> Ci vediamo?\n> A dopo\n"), "{quote:?}");
        let forwarded = forwarded_text("Guarda qui", &original);
        assert!(forwarded.starts_with("Guarda qui\n\n---------- Forwarded message ----------\nFrom: Rossi, Ada <ada@example.com>\n"), "{forwarded}");
        assert!(forwarded.ends_with("To: me@example.it, bob@example.com\n\nCi vediamo?\nA dopo"), "{forwarded}");
        let many: String = (0..40).map(|i| format!("<m{i}@x> ")).collect();
        assert_eq!(thread_of(&Original { references: many, ..original }).split(' ').count(), 20, "the newest ids");
    }

    fn file(name: &str, bytes: &[u8]) -> crate::smtp::Attachment {
        crate::smtp::Attachment { name: name.into(), mime: crate::smtp::mime_of(name), bytes: bytes.to_vec() }
    }

    fn reply_to_lunch() -> crate::smtp::Outgoing {
        crate::smtp::Outgoing {
            to: vec!["ada@example.com".into()],
            cc: vec![],
            subject: "Re: Lunch".into(),
            body: "See you at 1.".into(),
            attachments: vec![file("menu.pdf", b"menu"), file("map.png", b"map")],
            in_reply_to: Some("<a@example.com>".into()),
            references: Some("<a@example.com>".into()),
        }
    }

    /// Send as it was, Send as changed, Discard and no click read as four different things.
    #[test]
    fn the_cards_answer_says_how_the_email_goes() {
        assert_eq!(card_answer(Some("allow")), Ok(None));
        let changed = json!({ "revised": { "to": ["ada@example.com"] } }).to_string();
        assert_eq!(card_answer(Some(&changed)), Ok(Some(json!({ "to": ["ada@example.com"] }))));
        assert!(card_answer(Some("deny")).unwrap_err().contains("discarded"));
        assert!(card_answer(None).unwrap_err().contains("not sent"));
        assert!(card_answer(Some("{\"answers\":{}}")).is_err(), "a question's answer is not an email");
    }

    /// The user's changes replace the AI's, and the reply stays in its conversation.
    #[test]
    fn the_email_goes_as_the_user_left_it() {
        let mut mail = reply_to_lunch();
        let revised = json!({
            "to": ["ada@example.com", "grace@example.com"], "cc": ["bob@example.com"],
            "subject": "Re: Lunch tomorrow", "body": "See you at 1, Grace comes too.", "keep": [1], "add": [],
        });
        let changed = revise(&mut mail, &revised).unwrap();
        assert_eq!(changed, vec!["who it goes to", "the subject", "the text", "the files attached"]);
        assert_eq!(mail.to, vec!["ada@example.com", "grace@example.com"]);
        assert_eq!(mail.cc, vec!["bob@example.com"]);
        assert_eq!(mail.subject, "Re: Lunch tomorrow");
        assert_eq!(mail.body, "See you at 1, Grace comes too.");
        assert_eq!(mail.attachments.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["map.png"]);
        assert_eq!(mail.in_reply_to.as_deref(), Some("<a@example.com>"));
        assert_eq!(mail.references.as_deref(), Some("<a@example.com>"));
    }

    /// Sent unchanged, nothing is said to have changed; a missing `keep` keeps every file.
    #[test]
    fn an_email_left_as_it_was_has_no_changes() {
        let mut mail = reply_to_lunch();
        let same = json!({ "to": ["ADA@example.com"], "cc": [], "subject": "Re: Lunch", "body": "See you at 1." });
        assert_eq!(revise(&mut mail, &same).unwrap(), Vec::<&str>::new());
        assert_eq!(mail.attachments.len(), 2);
        let sent = with_changes("Sent to ada@example.com.".into(), &[], "me@example.com", &mail);
        assert_eq!(sent, "Sent to ada@example.com.");
    }

    /// What the card sends back is checked as the AI's email is: nothing goes on a bad one.
    #[test]
    fn a_bad_email_from_the_card_is_refused() {
        let base = json!({ "to": ["ada@example.com"], "subject": "Hi", "body": "Hello" });
        let with = |key: &str, value: serde_json::Value| {
            let mut v = base.clone();
            v[key] = value;
            revise(&mut reply_to_lunch(), &v)
        };
        assert!(with("to", json!([])).is_err(), "nobody to send to");
        assert!(with("to", json!(["grace@example"])).is_err(), "an address with no domain");
        assert!(with("cc", json!(["not an address"])).is_err());
        assert!(with("body", json!("  ")).is_err(), "no text");
        assert!(with("subject", json!("x".repeat(crate::smtp::MAX_SUBJECT + 1))).is_err());
        let many: Vec<String> = (0..=crate::smtp::MAX_RECIPIENTS).map(|i| format!("p{i}@example.com")).collect();
        assert!(with("to", json!(many)).is_err());
    }

    /// Only a file picked with Attach on the card is added: a path the page names is not enough.
    #[test]
    fn only_files_picked_on_the_card_are_added() {
        let dir = std::env::temp_dir().join(format!("lumo-mail-pick-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let picked = dir.join("notes.txt");
        let other = dir.join("secret.txt");
        std::fs::write(&picked, b"notes").unwrap();
        std::fs::write(&other, b"secret").unwrap();
        PICKED.lock().unwrap().push((picked.canonicalize().unwrap(), std::time::Instant::now()));
        let base = json!({ "to": ["ada@example.com"], "subject": "Hi", "body": "Hello", "keep": [] });
        let mut ok = base.clone();
        ok["add"] = json!([picked.to_string_lossy()]);
        let mut mail = reply_to_lunch();
        assert_eq!(revise(&mut mail, &ok).unwrap().last(), Some(&"the files attached"));
        assert_eq!(mail.attachments.len(), 1);
        assert_eq!(mail.attachments[0].name, "notes.txt");
        assert_eq!(mail.attachments[0].bytes, b"notes");
        let mut refused = base.clone();
        refused["add"] = json!([other.to_string_lossy()]);
        assert!(revise(&mut reply_to_lunch(), &refused).unwrap_err().contains("not picked"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The AI reads what went when the user changed it, not its own version.
    #[test]
    fn the_ai_is_told_what_went() {
        let mut mail = reply_to_lunch();
        let revised = json!({ "to": ["ada@example.com"], "subject": "Re: Lunch", "body": "Make it 2.", "keep": [0, 1] });
        let changed = revise(&mut mail, &revised).unwrap();
        let said = with_changes("Sent to ada@example.com.".into(), &changed, "me@example.com", &mail);
        assert!(said.starts_with("Sent to ada@example.com.\nBefore Send the user changed the email on its card (the text)."), "{said}");
        assert!(said.contains("From: me@example.com\nTo: ada@example.com\nSubject: Re: Lunch\nFiles: menu.pdf, map.png\nText:\nMake it 2."), "{said}");
    }

    /// The card gets the limits it checks its fields against, and the accounts only when there is a choice.
    #[test]
    fn the_card_knows_its_limits() {
        let card = card_mail("me@example.com", &reply_to_lunch(), &[], &[]);
        assert_eq!(card["limits"]["files"], crate::smtp::MAX_ATTACHMENTS);
        assert_eq!(card["limits"]["bytes"], crate::smtp::MAX_ATTACHED_BYTES);
        assert_eq!(card["accounts"], json!([]));
        let card = card_mail("me@example.com", &reply_to_lunch(), &[], &["me@example.com", "work@example.com"]);
        assert_eq!(card["accounts"], json!(["me@example.com", "work@example.com"]));
    }
}
