// The Email pill for the agents (mail.rs): what Lumo's email tools give them
// (`lumo-hook --mcp --tools=mail`), only while an agent of the island is at
// work: the newest emails of a folder, a search of every folder, one email in
// full with its files, the list of folders, from IMAP, the classic Outlook or
// both. With Settings → Security → Email's "Read, send and manage", also
// marking, starring, moving, archiving and trashing one email, each on a card
// of its own. What they write (send, reply, forward, drafts) is mail_send.rs.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::log;
use crate::mail::{access, account_link, accounts, imap_on, imap_ready, live_accounts, park, timed, timed_for, wake, Account, BODY_BYTES, BODY_CHARS, ID, MAX_READ, MAX_SEARCH_READ, Message};
use crate::mail_imap::{both, is_gmail, parse_fetch, quoted, search_uids, server_of, sign_in, Imap, Part};
use crate::mail_parse::{attached_files, base64, decode_body, extract_text, parse_headers, tidy, Attached};
use crate::mail_send::{draft, forward, outlook_draft, outlook_forward, outlook_reply, outlook_send, reply, send, sends_from_outlook};

// ── For the agents ────────────────────────────────────────────────────────────

/// What the agents' tools give at most, and by default.
pub(crate) const MOST: usize = 25;
const DEFAULT_COUNT: usize = 10;
/// Of an email read in full: what is fetched, and what the agent reads.
pub(crate) const FULL_BYTES: usize = 256 * 1024;
pub(crate) const FULL_CHARS: usize = 20_000;
/// Of each email in a list: the start of its text.
const LIST_CHARS: usize = 400;
/// Of the email answered, what is quoted under a reply.
pub(crate) const QUOTED_CHARS: usize = 4000;
/// At most this many folders searched, or counted in mail_folders.
const MOST_FOLDERS: usize = 60;
/// A step that may take longer: every folder searched, files fetched.
pub(crate) const SLOW_TIMEOUT: Duration = Duration::from_secs(55);
/// The most a file attached to an email may weigh as it comes (in base64).
const MAX_ATTACHMENT_READ: usize = 32 * 1024 * 1024;
/// The same, decoded: what an Outlook file may weigh (outlook.rs).
pub(crate) const MAX_ATTACHMENT_BYTES: usize = MAX_ATTACHMENT_READ / 4 * 3;

/// Agents of the island at work (a chat turn of a signed-in CLI, Gemini Live's
/// helper): Lumo's email tools answer only meanwhile.
static AGENT_TURNS: AtomicUsize = AtomicUsize::new(0);

/// While it lives, an agent of the island is at work.
pub struct AgentTurn(());

impl Drop for AgentTurn {
    fn drop(&mut self) {
        AGENT_TURNS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn agent_turn() -> AgentTurn {
    AGENT_TURNS.fetch_add(1, Ordering::SeqCst);
    AgentTurn(())
}

/// Where an email is: the inbox, (on Gmail) all the mail, or another folder,
/// by its name as `mail_folders` gives it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Folder {
    Inbox,
    All,
    Named(String),
}

impl Folder {
    fn tag(&self) -> &str {
        match self {
            Folder::Inbox => "inbox",
            Folder::All => "all",
            Folder::Named(name) => name,
        }
    }
}

/// An email as the agents get it.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    /// What `mail_read` takes: "inbox:123", "all:4567", "Sent:12".
    pub id: String,
    pub message: Message,
    pub unread: bool,
}

/// "inbox:123", "Archivio/2025:7" → the folder and the UID.
pub(crate) fn parse_id(id: &str) -> Option<(Folder, u32)> {
    let (folder, uid) = id.trim().rsplit_once(':')?;
    let folder = match folder.trim() {
        "" => return None,
        f if f.eq_ignore_ascii_case("inbox") => Folder::Inbox,
        "all" => Folder::All,
        f => Folder::Named(f.to_string()),
    };
    Some((folder, uid.parse::<u32>().ok().filter(|u| *u > 0)?))
}

/// Whether a FETCH answer says the email was read (`\Seen` among its FLAGS).
fn seen(unit: &[Part]) -> bool {
    unit.iter().any(|p| match p {
        Part::Text(s) => s
            .find("FLAGS (")
            .and_then(|i| s[i + 7..].split(')').next())
            .is_some_and(|flags| flags.split_whitespace().any(|f| f.eq_ignore_ascii_case("\\Seen"))),
        _ => false,
    })
}

/// The IMAP accounts an agent may use: the Email pill on, IMAP on, each
/// account not paused. The first is the one a new email goes out of.
pub(crate) fn tool_accounts(app: &AppHandle) -> Result<Vec<Account>, String> {
    if !crate::integrations::enabled(app, ID) {
        return Err(PILL_OFF.into());
    }
    if !imap_on(app) {
        return Err("IMAP is off in Lumo's Settings (the Email pill): Lumo reads only Outlook.".into());
    }
    let live = live_accounts(app);
    if live.is_empty() {
        return Err(if accounts().is_empty() { NO_ACCOUNT.into() } else { "The user paused their email accounts in Lumo's Settings (the Email pill).".into() });
    }
    Ok(live)
}

/// The account email `id` is of, and the id without it: "work@x.it:inbox:12"
/// names its account; a plain "inbox:12" is of the first.
pub(crate) fn account_for(app: &AppHandle, id: &str) -> Result<(Account, String), String> {
    let live = tool_accounts(app)?;
    let id = id.trim();
    if let Some((head, rest)) = id.split_once(':') {
        if head.contains('@') {
            if let Some(a) = live.iter().find(|a| a.address.trim().eq_ignore_ascii_case(head.trim())) {
                return Ok((a.clone(), rest.to_string()));
            }
            if accounts().iter().any(|a| a.address.trim().eq_ignore_ascii_case(head.trim())) {
                return Err(format!("The user paused the account {head} in Lumo's Settings: its emails can't be used now."));
            }
            // "who@x.it:inbox:12" of an account no longer there; "a@b:12" is folder a@b's.
            if rest.contains(':') {
                return Err(format!("Lumo has no email account {head} now: use an id mail_recent or mail_search gives."));
            }
        }
    }
    Ok((live[0].clone(), id.to_string()))
}

/// The ids an agent gets: with their account's address when there are more
/// than one ("work@x.it:inbox:12"), so the next tool finds the right one.
fn of_account_found(found: Vec<Found>, acct: &Account, many: bool) -> Vec<Found> {
    found
        .into_iter()
        .map(|mut f| {
            if many {
                f.id = format!("{}:{}", acct.address.trim(), f.id);
            }
            f.message.link = f.message.link.map(|l| account_link(l, acct));
            f
        })
        .collect()
}

/// `step` on each account at once; each answer with its account.
async fn each_account<T, F, Fut>(accounts: Vec<Account>, step: F) -> Vec<(Account, Result<T, String>)>
where
    T: Send + 'static,
    F: Fn(Account) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>> + Send + 'static,
{
    let started: Vec<_> = accounts.into_iter().map(|a| (a.clone(), tauri::async_runtime::spawn(step(a)))).collect();
    let mut out = Vec::new();
    for (a, task) in started {
        out.push((a, task.await.unwrap_or_else(|e| Err(e.to_string()))));
    }
    out
}

/// The accounts' emails as one list, newest first: an account that fails
/// (a folder it hasn't) leaves the others'; all failing, the first's error.
fn merged(results: Vec<(Account, Result<Vec<Found>, String>)>, count: usize) -> Result<Vec<Found>, String> {
    let many = results.len() > 1;
    let mut all = Vec::new();
    let mut first_error = None;
    let mut any = false;
    for (acct, result) in results {
        match result {
            Ok(found) => {
                any = true;
                all.extend(of_account_found(found, &acct, many));
            }
            Err(e) => {
                log::line(format!("[mail] one account: {e}"));
                first_error.get_or_insert(e);
            }
        }
    }
    if !any {
        return Err(first_error.unwrap_or_else(|| NO_ACCOUNT.into()));
    }
    all.sort_by_key(|f| std::cmp::Reverse(date_key(&f.message.date)));
    all.truncate(count);
    Ok(all)
}

/// A short connection to account `acct`, signed in.
pub(crate) async fn open(acct: &Account) -> Result<(Imap, String), String> {
    let (host, port) = acct.host();
    let imap = timed(&host, sign_in(&host, port, &acct.address, &acct.password)).await?;
    Ok((imap, host))
}

/// Settings → Email → Add an account: signs in with what the user typed, and
/// says why not in their words. Nothing is saved here.
pub async fn try_account(address: &str, password: &str, server: &str) -> Result<String, String> {
    let (host, port) = server_of(server, address);
    let imap = timed(&host, sign_in(&host, port, address, password)).await?;
    close(imap).await;
    Ok(host)
}

pub(crate) const PILL_OFF: &str = "The Email pill is off in Lumo: the user can turn it on in Lumo's Settings.";
const NO_ACCOUNT: &str = "Lumo has no email account yet: the user adds one in Lumo's Settings, under the Email pill.";

/// Ends a short connection, without waiting long for the server's goodbye.
pub(crate) async fn close(mut imap: Imap) {
    let _ = tokio::time::timeout(Duration::from_secs(5), imap.run("LOGOUT")).await;
}

// ── Folders ───────────────────────────────────────────────────────────────────

/// A folder of the mailbox, as LIST gives it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Mailbox {
    /// As the server names it (modified UTF-7), for its commands.
    pub(crate) wire: String,
    /// As people read it.
    pub(crate) name: String,
    flags: Vec<String>,
}

impl Mailbox {
    fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f.eq_ignore_ascii_case(flag))
    }

    /// A folder that holds emails, not only other folders ("[Gmail]").
    fn selectable(&self) -> bool {
        !self.has("\\Noselect") && !self.has("\\NonExistent")
    }

    fn is_inbox(&self) -> bool {
        self.wire.eq_ignore_ascii_case("INBOX")
    }
}

/// What a folder is for: the server marks it (RFC 6154), or its usual name says so.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Role {
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    All,
}

const ROLES: [Role; 6] = [Role::Sent, Role::Drafts, Role::Trash, Role::Junk, Role::Archive, Role::All];

impl Role {
    fn flag(self) -> &'static str {
        match self {
            Role::Sent => "\\Sent",
            Role::Drafts => "\\Drafts",
            Role::Trash => "\\Trash",
            Role::Junk => "\\Junk",
            Role::Archive => "\\Archive",
            Role::All => "\\All",
        }
    }

    /// The word the agents read and may give for it.
    fn word(self) -> &'static str {
        match self {
            Role::Sent => "sent",
            Role::Drafts => "drafts",
            Role::Trash => "trash",
            Role::Junk => "spam",
            Role::Archive => "archive",
            Role::All => "all mail",
        }
    }

    /// The folder's usual names, lowercase, for a server that doesn't mark it.
    fn names(self) -> &'static [&'static str] {
        match self {
            Role::Sent => &["sent", "sent items", "sent mail", "sent messages", "posta inviata", "inviata", "inviati", "elementi inviati", "enviados", "envoyés", "gesendet"],
            Role::Drafts => &["drafts", "draft", "bozze", "borradores", "brouillons", "entwürfe"],
            Role::Trash => &["trash", "bin", "deleted", "deleted items", "deleted messages", "cestino", "posta eliminata", "elementi eliminati", "papelera", "corbeille", "papierkorb"],
            Role::Junk => &["junk", "spam", "junk e-mail", "junk email", "posta indesiderata", "indesiderata", "correo no deseado", "indésirables"],
            Role::Archive => &["archive", "archives", "archivio", "archivo", "archiv"],
            Role::All => &["all mail"],
        }
    }
}

/// Whether a folder's name says it is the archive (an Outlook folder, outlook.rs).
pub(crate) fn is_archive_name(name: &str) -> bool {
    Role::Archive.names().contains(&name.trim().to_lowercase().as_str())
}

fn role_of(b: &Mailbox) -> Option<Role> {
    if b.is_inbox() {
        return None;
    }
    ROLES.iter().copied().find(|r| b.has(r.flag())).or_else(|| {
        let last = b.name.rsplit(['/', '.']).next().unwrap_or(&b.name).trim().to_lowercase();
        ROLES.iter().copied().find(|r| r.names().contains(&last.as_str()))
    })
}

/// The folder for `role`: the one the server marks, else the one named so.
pub(crate) fn find_role(boxes: &[Mailbox], role: Role) -> Option<&Mailbox> {
    let open = || boxes.iter().filter(|b| b.selectable() && !b.is_inbox());
    open().find(|b| b.has(role.flag())).or_else(|| open().find(|b| role_of(b) == Some(role)))
}

/// One line of a LIST answer: `* LIST (\HasNoChildren \Sent) "/" "Sent"`.
fn parse_list(unit: &[Part]) -> Option<Mailbox> {
    let Some(Part::Text(line)) = unit.first() else { return None };
    let rest = line.strip_prefix("* LIST (")?;
    let (flags, rest) = rest.split_once(')')?;
    let wire = match unit.get(1) {
        Some(Part::Literal(name)) => String::from_utf8_lossy(name).to_string(),
        _ => list_name(rest.trim())?,
    };
    Some(Mailbox { name: utf7_decode(&wire), wire, flags: flags.split_whitespace().map(str::to_string).collect() })
}

pub(crate) async fn mailboxes(imap: &mut Imap) -> Result<Vec<Mailbox>, String> {
    let units = imap.run("LIST \"\" \"*\"").await?;
    Ok(units.iter().filter_map(|u| parse_list(u)).collect())
}

/// Gmail keeps every email in a folder of its own ("[Gmail]/All Mail", named
/// in the account's language), which IMAP marks `\All`.
async fn all_mail(imap: &mut Imap) -> Option<String> {
    let boxes = mailboxes(imap).await.ok()?;
    boxes.into_iter().find(|b| b.has("\\All")).map(|b| b.wire)
}

/// The mailbox name at the end of a LIST line, after its delimiter: `"/" "[Gmail]/All Mail"`.
fn list_name(rest: &str) -> Option<String> {
    let rest = if let Some(r) = rest.strip_prefix('"') {
        let mut escaped = false;
        let end = r.char_indices().find(|&(_, c)| {
            let close = c == '"' && !escaped;
            escaped = c == '\\' && !escaped;
            close
        })?;
        &r[end.0 + 1..]
    } else {
        rest.strip_prefix("NIL")?
    };
    let name = rest.trim();
    let name = match name.strip_prefix('"').and_then(|n| n.strip_suffix('"')) {
        Some(quoted) => quoted.replace("\\\"", "\"").replace("\\\\", "\\"),
        None => name.to_string(),
    };
    (!name.is_empty()).then_some(name)
}

/// A folder's name as IMAP sends it (modified UTF-7, RFC 3501 5.1.3:
/// "Posta eliminata", "&AMk-l&AOk-ments supprim&AOk-s"), as people read it.
fn utf7_decode(wire: &str) -> String {
    let mut out = String::new();
    let mut rest = wire;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let encoded = &after[..end];
        if encoded.is_empty() {
            out.push('&');
        } else {
            let bytes = base64(encoded.replace(',', "/").as_bytes());
            let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|&c| u16::from_be_bytes(c)).collect();
            out.push_str(&String::from_utf16_lossy(&units));
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The folder an agent named: "inbox", "all" (Gmail), a name mail_folders
/// gave, or what it is for ("sent", "trash", "archive"…).
async fn folder_named(imap: &mut Imap, host: &str, asked: &str) -> Result<Folder, String> {
    let asked = asked.trim();
    if asked.eq_ignore_ascii_case("inbox") {
        return Ok(Folder::Inbox);
    }
    if asked == "all" && is_gmail(host) {
        return Ok(Folder::All);
    }
    let boxes = mailboxes(imap).await?;
    let open: Vec<&Mailbox> = boxes.iter().filter(|b| b.selectable()).collect();
    let named = open.iter().find(|b| b.name == asked).or_else(|| open.iter().find(|b| b.name.eq_ignore_ascii_case(asked)));
    if let Some(b) = named {
        return Ok(if b.is_inbox() { Folder::Inbox } else { Folder::Named(b.name.clone()) });
    }
    let word = asked.to_lowercase();
    if let Some(b) = ROLES.iter().find(|r| r.word() == word || r.names().contains(&word.as_str())).and_then(|r| find_role(&boxes, *r)) {
        return Ok(Folder::Named(b.name.clone()));
    }
    Err(format!("The mailbox has no folder called {asked}: mail_folders lists them."))
}

/// Opens `folder`, to look (EXAMINE) or to change (SELECT). Its name as the server has it.
pub(crate) async fn enter(imap: &mut Imap, folder: &Folder, change: bool) -> Result<String, String> {
    let wire = match folder {
        Folder::Inbox => "INBOX".to_string(),
        Folder::All => all_mail(imap).await.ok_or_else(|| "This mailbox has no folder with all the mail.".to_string())?,
        Folder::Named(name) => {
            let boxes = mailboxes(imap).await?;
            let found = boxes.into_iter().find(|b| b.name == *name && b.selectable());
            found.map(|b| b.wire).ok_or_else(|| format!("The mailbox has no folder called {name}: mail_folders lists them."))?
        }
    };
    let verb = if change { "SELECT" } else { "EXAMINE" };
    imap.run(&format!("{verb} {}", quoted(&wire)))
        .await
        .map_err(|why| format!("Lumo couldn't open the folder {}: {why}", folder.tag()))?;
    Ok(wire)
}

/// `mail_folders`: every folder, what it is for, and how many emails it holds.
async fn folders(app: &AppHandle) -> Result<String, String> {
    let live = tool_accounts(app)?;
    if live.len() == 1 {
        return folders_of(live[0].clone()).await;
    }
    let mut out = String::new();
    let mut first_error = None;
    let mut any = false;
    for (acct, listed) in each_account(live, folders_of).await {
        match listed {
            Ok(list) => {
                any = true;
                out.push_str(&format!("Account {}:\n{list}\n", acct.address.trim()));
            }
            Err(e) => {
                out.push_str(&format!("Account {}: it didn't answer ({e}).\n\n", acct.address.trim()));
                first_error.get_or_insert(e);
            }
        }
    }
    if !any {
        return Err(first_error.unwrap_or_else(|| NO_ACCOUNT.into()));
    }
    out.push_str("A folder's name is the same for every account: mail_recent and mail_search look in each account that has it.\n");
    Ok(out)
}

/// One account's folders.
async fn folders_of(acct: Account) -> Result<String, String> {
    let (mut imap, host) = open(&acct).await?;
    let listed = timed_for(SLOW_TIMEOUT, &host, async {
        let boxes = mailboxes(&mut imap).await?;
        let mut out = String::from("The mailbox's folders (give the name as mail_recent's or mail_search's folder, or mail_move's):\n");
        for (n, b) in boxes.iter().filter(|b| b.selectable()).enumerate() {
            let name = if b.is_inbox() { "inbox" } else { b.name.as_str() };
            out.push_str(&format!("- {name}"));
            if let Some(role) = role_of(b) {
                out.push_str(&format!(" ({})", role.word()));
            }
            if n < MOST_FOLDERS {
                imap.read = 0;
                if let Ok(units) = imap.run(&format!("STATUS {} (MESSAGES UNSEEN)", quoted(&b.wire))).await {
                    if let Some((all, unseen)) = units.iter().find_map(|u| status_counts(u)) {
                        out.push_str(&format!(": {all} emails, {unseen} unread"));
                    }
                }
            }
            out.push('\n');
        }
        Ok(out)
    })
    .await;
    close(imap).await;
    listed
}

/// A STATUS answer's counts: `* STATUS "Sent" (MESSAGES 12 UNSEEN 0)`.
fn status_counts(unit: &[Part]) -> Option<(u32, u32)> {
    let Some(Part::Text(first)) = unit.first() else { return None };
    if !first.starts_with("* STATUS") {
        return None;
    }
    let text = match unit.last() {
        Some(Part::Text(last)) => last.as_str(),
        _ => first.as_str(),
    };
    let count = |key: &str| text.split(key).nth(1).and_then(|r| r.split(|c: char| !c.is_ascii_digit()).find(|n| !n.is_empty())).and_then(|n| n.parse().ok());
    Some((count("MESSAGES ")?, count("UNSEEN ")?))
}

// ── Reading ───────────────────────────────────────────────────────────────────

/// The emails `uids` (newest first), with the first `body_bytes` of their text.
async fn fetch(imap: &mut Imap, host: &str, folder: &Folder, uids: &[u32], body_bytes: usize, body_chars: usize) -> Result<Vec<Found>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let units = imap
        .run(&format!(
            "UID FETCH {set} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.{body_bytes}>)"
        ))
        .await?;
    let mut found: Vec<Found> = units
        .iter()
        .filter_map(|unit| {
            let mut message = parse_fetch(unit, host)?;
            let uid = uid_of(&message.id)?;
            if body_chars > BODY_CHARS {
                // parse_fetch keeps BODY_CHARS: the whole email is read again from what came.
                message.body = full_text(unit).chars().take(body_chars).collect();
            }
            Some(Found { id: format!("{}:{uid}", folder.tag()), unread: !seen(unit), message })
        })
        .collect();
    found.sort_by_key(|f| std::cmp::Reverse(uid_of(&f.message.id).unwrap_or(0)));
    Ok(found)
}

/// The text of a FETCH answer's body, without parse_fetch's cut.
pub(crate) fn full_text(unit: &[Part]) -> String {
    let (header, body) = header_and_body(unit);
    let headers = parse_headers(header);
    let field = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).unwrap_or("");
    tidy(&extract_text(field("Content-Type"), field("Content-Transfer-Encoding"), body))
}

/// A FETCH answer's header and body literals.
pub(crate) fn header_and_body(unit: &[Part]) -> (&[u8], &[u8]) {
    let mut header: &[u8] = &[];
    let mut body: &[u8] = &[];
    let mut before = "";
    for part in unit {
        match part {
            Part::Text(s) => before = s,
            Part::Literal(bytes) if before.to_ascii_uppercase().contains("HEADER") => header = bytes,
            Part::Literal(bytes) => body = bytes,
        }
    }
    (header, body)
}

/// The newest `count` emails of the inbox (or of `folder`), read or not (or only the unread ones).
pub async fn newest(app: &AppHandle, count: usize, unread_only: bool, folder: Option<&str>) -> Result<Vec<Found>, String> {
    let count = count.clamp(1, MOST);
    let folder = folder.map(str::to_string);
    let results = each_account(tool_accounts(app)?, move |a| {
        let folder = folder.clone();
        async move { newest_in(&a, count, unread_only, folder.as_deref(), false).await }
    })
    .await;
    merged(results, count)
}

/// `newest`, of one account. With `keep` (the Email view's), its connection
/// stays open a little for the email the user opens next (`park`).
pub(crate) async fn newest_in(acct: &Account, count: usize, unread_only: bool, folder: Option<&str>, keep: bool) -> Result<Vec<Found>, String> {
    let (mut imap, host) = open(acct).await?;
    let mut opened = Folder::Inbox;
    let found = timed(&host, async {
        let folder = match folder {
            Some(asked) => folder_named(&mut imap, &host, asked).await?,
            None => Folder::Inbox,
        };
        if folder != Folder::Inbox {
            enter(&mut imap, &folder, false).await?;
            opened = folder.clone();
        }
        // Every UID of a big mailbox can weigh more than MAX_READ: about 8
        // bytes each, 4 MB past half a million emails.
        imap.read = 0;
        imap.limit = MAX_SEARCH_READ;
        let units = imap.run(if unread_only { "UID SEARCH UNSEEN" } else { "UID SEARCH ALL" }).await;
        imap.limit = MAX_READ;
        imap.read = 0;
        let mut uids = search_uids(&units?);
        uids.sort_unstable();
        let newest: Vec<u32> = uids.iter().rev().take(count.clamp(1, MOST)).copied().collect();
        fetch(&mut imap, &host, &folder, &newest, BODY_BYTES, BODY_CHARS).await
    })
    .await;
    if keep && found.is_ok() {
        park(acct, host, imap, opened);
    } else {
        close(imap).await;
    }
    found
}

/// The IMAP search for `query`: Gmail's own search on Gmail, the words in the
/// email elsewhere. Quotes and line breaks are taken out of the query. Plain
/// ASCII goes in quotes; anything else in UTF-8, as a literal after the
/// command (IMAP's quoted strings are 7-bit).
fn search_command(host: &str, query: &str) -> (String, Option<String>) {
    let clean: String = query.chars().map(|c| if c.is_control() || c == '"' || c == '\\' { ' ' } else { c }).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let key = if is_gmail(host) { "X-GM-RAW" } else { "TEXT" };
    if clean.is_ascii() {
        (format!("UID SEARCH {key} {}", quoted(&clean)), None)
    } else {
        (format!("UID SEARCH CHARSET UTF-8 {key}"), Some(clean))
    }
}

/// The newest `count` UIDs of the open folder that match `query`.
async fn search_here(imap: &mut Imap, host: &str, query: &str, count: usize) -> Result<Vec<u32>, String> {
    // What matches can be most of a big mailbox: its UIDs may weigh more
    // than MAX_READ, as in `newest`.
    imap.read = 0;
    imap.limit = MAX_SEARCH_READ;
    let units = match search_command(host, query) {
        (command, None) => imap.run(&command).await,
        (command, Some(literal)) => imap.run_literal(&command, &literal).await,
    };
    imap.limit = MAX_READ;
    imap.read = 0;
    let mut uids = search_uids(&units?);
    uids.sort_unstable();
    Ok(uids.iter().rev().take(count).copied().collect())
}

/// The newest `count` emails that match `query`: in `folder` when given; else
/// on Gmail in all the mail, elsewhere in every folder but the trash and spam.
pub async fn search(app: &AppHandle, query: &str, count: usize, folder: Option<&str>) -> Result<Vec<Found>, String> {
    if query.trim().is_empty() {
        return Err("Say what to search for.".into());
    }
    let count = count.clamp(1, MOST);
    let query = query.to_string();
    let folder = folder.map(str::to_string);
    let results = each_account(tool_accounts(app)?, move |a| {
        let (query, folder) = (query.clone(), folder.clone());
        async move { search_in(&a, &query, count, folder.as_deref()).await }
    })
    .await;
    merged(results, count)
}

/// `search`, in one account.
async fn search_in(acct: &Account, query: &str, count: usize, folder: Option<&str>) -> Result<Vec<Found>, String> {
    let (mut imap, host) = open(acct).await?;
    let found = timed_for(SLOW_TIMEOUT, &host, async {
        let one = match folder {
            Some(asked) => Some(folder_named(&mut imap, &host, asked).await?),
            None if is_gmail(&host) => Some(if all_mail(&mut imap).await.is_some() { Folder::All } else { Folder::Inbox }),
            None => None,
        };
        if let Some(folder) = one {
            if folder != Folder::Inbox {
                enter(&mut imap, &folder, false).await?;
            }
            let uids = search_here(&mut imap, &host, query, count).await?;
            return fetch(&mut imap, &host, &folder, &uids, BODY_BYTES, BODY_CHARS).await;
        }
        // Every folder, one after the other; the newest of them all.
        let boxes = mailboxes(&mut imap).await?;
        let mut all = Vec::new();
        let searched = boxes
            .iter()
            .filter(|b| b.selectable() && !matches!(role_of(b), Some(Role::Trash | Role::Junk)))
            .take(MOST_FOLDERS);
        for b in searched {
            imap.read = 0;
            let folder = if b.is_inbox() { Folder::Inbox } else { Folder::Named(b.name.clone()) };
            if imap.run(&format!("EXAMINE {}", quoted(&b.wire))).await.is_err() {
                continue;
            }
            let Ok(uids) = search_here(&mut imap, &host, query, count).await else { continue };
            all.extend(fetch(&mut imap, &host, &folder, &uids, BODY_BYTES, BODY_CHARS).await?);
        }
        all.sort_by_key(|f| std::cmp::Reverse(date_key(&f.message.date)));
        all.truncate(count);
        Ok(all)
    })
    .await;
    close(imap).await;
    found
}

/// One email in full, by the id `newest` or `search` gave, with its attachments.
pub async fn read(app: &AppHandle, id: &str) -> Result<(Found, Vec<Attached>), String> {
    let (acct, plain) = account_for(app, id)?;
    let (folder, uid) = parse_id(&plain).ok_or_else(|| bad_id(id))?;
    let (mut imap, host) = open(&acct).await?;
    let found = timed(&host, async {
        if folder != Folder::Inbox {
            enter(&mut imap, &folder, false).await?;
        }
        let found = fetch(&mut imap, &host, &folder, &[uid], FULL_BYTES, FULL_CHARS).await?;
        let files = structure(&mut imap, uid).await.unwrap_or_default();
        Ok((found, files))
    })
    .await;
    close(imap).await;
    let (found, files) = found?;
    let mut found = found.into_iter().next().ok_or_else(|| gone(id))?;
    found.id = id.trim().to_string();
    found.message.link = found.message.link.map(|l| account_link(l, &acct));
    Ok((found, files))
}

pub(crate) fn bad_id(id: &str) -> String {
    format!("{id} is not an email id: use one mail_recent or mail_search gave.")
}

pub(crate) fn gone(id: &str) -> String {
    format!("No email {id}: it may have been moved or deleted.")
}

/// An email's Date header as seconds since 1970 (UTC), to put the emails of
/// several folders in order; 0 when it can't be read.
pub(crate) fn date_key(date: &str) -> i64 {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let words: Vec<&str> = date.split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).collect();
    let month = |w: &str| MONTHS.iter().position(|m| w.get(..3).is_some_and(|p| p.eq_ignore_ascii_case(m)));
    let Some((at, m)) = words.iter().enumerate().find_map(|(i, w)| month(w).map(|m| (i, m))) else { return 0 };
    let number = |j: Option<usize>| j.and_then(|j| words.get(j)).and_then(|w| w.parse::<i64>().ok());
    let (Some(d), Some(mut y)) = (number(at.checked_sub(1)), number(Some(at + 1))) else { return 0 };
    if y < 100 {
        y += if y < 50 { 2000 } else { 1900 };
    }
    let time: Vec<i64> = words.get(at + 2).map(|t| t.split(':').filter_map(|n| n.parse().ok()).collect()).unwrap_or_default();
    let zone = words.get(at + 3).copied().unwrap_or("");
    let offset = match zone.as_bytes() {
        [sign @ (b'+' | b'-'), ..] if zone.len() == 5 => {
            let hhmm: i64 = zone[1..].parse().unwrap_or(0);
            let secs = (hhmm / 100) * 3600 + (hhmm % 100) * 60;
            if *sign == b'-' { -secs } else { secs }
        }
        _ => match zone.to_ascii_uppercase().as_str() {
            "EST" | "CDT" => -5 * 3600,
            "EDT" => -4 * 3600,
            "CST" | "MDT" => -6 * 3600,
            "MST" | "PDT" => -7 * 3600,
            "PST" => -8 * 3600,
            _ => 0,
        },
    };
    // Days since 1970-01-01 of a date in the Gregorian calendar (H. Hinnant's days_from_civil).
    let (y, m) = if m < 2 { (y - 1, m as i64 + 10) } else { (y, m as i64 - 2) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let at = |i: usize| time.get(i).copied().unwrap_or(0);
    days * 86_400 + at(0) * 3600 + at(1) * 60 + at(2) - offset
}

/// The files attached to email `uid` of the open folder.
pub(crate) async fn structure(imap: &mut Imap, uid: u32) -> Result<Vec<Attached>, String> {
    let units = imap.run(&format!("UID FETCH {uid} (UID BODYSTRUCTURE)")).await?;
    // The answer that holds it: one the server sends on its own first (a flag
    // another client changed) is a FETCH too, with no files in it.
    let holds = |u: &&Vec<Part>| matches!(u.first(), Some(Part::Text(l)) if l.contains(" FETCH ")) && u.iter().any(|p| matches!(p, Part::Text(t) if t.to_ascii_uppercase().contains("BODYSTRUCTURE")));
    Ok(units.iter().find(holds).map(|u| attached_files(u)).unwrap_or_default())
}

/// One attached file of email `uid` of the open folder, its bytes decoded.
pub(crate) async fn attached_bytes(imap: &mut Imap, uid: u32, file: &Attached) -> Result<Vec<u8>, String> {
    if file.size > MAX_ATTACHMENT_READ {
        return Err(format!("{} is too big for Lumo to fetch ({} MB at most).", file.name, MAX_ATTACHMENT_READ / (1024 * 1024) * 3 / 4));
    }
    imap.read = 0;
    imap.limit = MAX_ATTACHMENT_READ + 64 * 1024;
    let units = imap.run(&format!("UID FETCH {uid} (UID BODY.PEEK[{}])", file.section)).await;
    imap.limit = MAX_READ;
    imap.read = 0;
    let units = units?;
    let bytes = units
        .iter()
        .find_map(|u| u.iter().find_map(|p| if let Part::Literal(b) = p { Some(b) } else { None }))
        .ok_or_else(|| format!("The mail server didn't give {}.", file.name))?;
    Ok(decode_body(&file.encoding, bytes))
}

/// Which of the email's files the agent asked for: its number in mail_read's list, or its name.
fn pick<'a>(files: &'a [Attached], which: Option<&serde_json::Value>) -> Result<&'a Attached, String> {
    if files.is_empty() {
        return Err("This email has no files attached.".into());
    }
    let nth = |n: u64| (n as usize).checked_sub(1).and_then(|i| files.get(i));
    let found = match which {
        None | Some(serde_json::Value::Null) if files.len() == 1 => files.first(),
        Some(serde_json::Value::Number(n)) => n.as_u64().and_then(nth),
        Some(serde_json::Value::String(s)) => match s.trim().parse::<u64>() {
            Ok(n) => nth(n),
            Err(_) => files.iter().find(|f| f.name.eq_ignore_ascii_case(s.trim())),
        },
        _ => None,
    };
    found.ok_or_else(|| format!("Say which file: its number in mail_read's list (1 to {}) or its name.", files.len()))
}

/// `mail_attachment`: a file attached to an email, saved with the files
/// attached to the chat, where the agent can read it.
async fn save_attachment(app: &AppHandle, input: &serde_json::Value) -> Result<crate::files::DroppedFile, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let (acct, plain) = account_for(app, id)?;
    let (folder, uid) = parse_id(&plain).ok_or_else(|| bad_id(id))?;
    let (mut imap, host) = open(&acct).await?;
    let got = timed_for(SLOW_TIMEOUT, &host, async {
        if folder != Folder::Inbox {
            enter(&mut imap, &folder, false).await?;
        }
        let files = structure(&mut imap, uid).await?;
        let file = pick(&files, input.get("attachment"))?.clone();
        let bytes = attached_bytes(&mut imap, uid, &file).await?;
        Ok((file, bytes))
    })
    .await;
    close(imap).await;
    let (file, bytes) = got?;
    let saved = crate::files::write_in(&file.name, &bytes)?;
    log::line(format!("[mail] a file of an email saved for the chat ({} bytes)", saved.size));
    Ok(saved)
}

/// What `mail_attachment` answers: where the file is, moved into the folder
/// of the chat that asked (files.rs adopt), the one its CLI reads without
/// asking. No chat (a provider of the island's own, a task of Gemini Live):
/// in the inbox, until Lumo starts again.
pub(crate) fn saved_text(saved: &crate::files::DroppedFile, chat: &str) -> String {
    let path = crate::files::adopt(&[crate::files::Adopt { chat: chat.to_string(), path: saved.path.clone(), name: Some(saved.name.clone()) }]).remove(0);
    format!("Saved {} ({}) with the files attached to the chat: {}. Read it from there.", saved.name, size_text(saved.size as usize), path)
}

/// "120 KB", "3.4 MB".
pub(crate) fn size_text(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

/// A list of emails as an agent reads it.
pub fn list_text(found: &[Found], text_chars: usize) -> String {
    let mut out = String::new();
    for f in found {
        let m = &f.message;
        let from = match (m.from.trim(), m.address.trim()) {
            ("", a) => a.to_string(),
            (n, "") => n.to_string(),
            (n, a) => format!("{n} <{a}>"),
        };
        let subject = if m.subject.trim().is_empty() { "(no subject)" } else { m.subject.trim() };
        let state = if f.unread { "unread" } else { "read" };
        out.push_str(&format!("- [{}] {state}, from {from}, {}: {subject}\n", f.id, m.date.trim()));
        let text = if m.body.trim().is_empty() { &m.preview } else { &m.body };
        let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            let cut: String = text.chars().take(text_chars).collect();
            let more = if cut.len() < text.len() { "…" } else { "" };
            out.push_str(&format!("  {cut}{more}\n"));
        }
    }
    out
}

/// The tools that send or write an email: Security's "Read and send" and up.
const SEND_TOOLS: &[&str] = &["mail_send", "mail_reply", "mail_forward", "mail_draft"];
/// The tools that change the mailbox, each on a card: "Read, send and manage".
const MANAGE_TOOLS: &[&str] = &["mail_mark", "mail_move", "mail_archive", "mail_trash"];

/// One call of Lumo's email tools (`{"lumo_mail": …}` from lumo-hook, pipe.rs), answered.
pub async fn serve(app: &AppHandle, request: &serde_json::Value) -> serde_json::Value {
    let refuse = |why: String| json!({ "error": why });
    if AGENT_TURNS.load(Ordering::SeqCst) == 0 {
        return refuse("Lumo gives its email tools only to the agent answering in the island.".into());
    }
    let level = access(&app.state::<crate::Shared>().settings.lock().unwrap());
    if level == "none" {
        return refuse("The user turned off the AI's access to their email in Lumo (Settings → Security).".into());
    }
    let tool = request.get("tool").and_then(|v| v.as_str()).unwrap_or("");
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    if SEND_TOOLS.contains(&tool) {
        if level == "read" {
            return refuse("The user lets the AI only read their email (Lumo's Settings → Security): write a draft for them to send instead.".into());
        }
        // A reply, a forward go out of the email's own mailbox; a new email
        // out of Outlook when it is on.
        let about = |key: &str| input.get(key).and_then(|v| v.as_str()).is_some_and(crate::outlook::is_id);
        let answers = input.get("reply_to").and_then(|v| v.as_str()).is_some_and(|r| !r.trim().is_empty());
        let new_in_outlook = (tool == "mail_send" || (tool == "mail_draft" && !answers)) && sends_from_outlook(app).await;
        let done = match tool {
            "mail_reply" if about("id") => outlook_reply(app, &input).await,
            "mail_forward" if about("id") => outlook_forward(app, &input).await,
            "mail_draft" if about("reply_to") || new_in_outlook => outlook_draft(&input).await,
            "mail_send" if new_in_outlook => outlook_send(app, &input).await,
            "mail_send" => send(app, &input).await,
            "mail_reply" => reply(app, &input).await,
            "mail_forward" => forward(app, &input).await,
            _ => draft(app, &input).await,
        };
        return match done {
            Ok(text) => json!({ "text": text }),
            Err(e) => refuse(e),
        };
    }
    if MANAGE_TOOLS.contains(&tool) {
        if level != "manage" {
            return refuse("The user doesn't let the AI change their mailbox (Lumo's Settings → Security → Email): tell them what you would do instead.".into());
        }
        let outlook = input.get("id").and_then(|v| v.as_str()).is_some_and(crate::outlook::is_id);
        let done = if outlook { outlook_manage(app, tool, &input).await } else { manage(app, tool, &input).await };
        return match done {
            Ok(text) => json!({ "text": text }),
            Err(e) => refuse(e),
        };
    }
    let count = input.get("count").and_then(|v| v.as_u64()).map_or(DEFAULT_COUNT, |n| n as usize);
    let folder = input.get("folder").and_then(|v| v.as_str()).map(str::trim).filter(|f| !f.is_empty());
    let answer = match tool {
        "mail_recent" => {
            let unread_only = input.get("unread_only").and_then(|v| v.as_bool()).unwrap_or(false);
            let place = folder.unwrap_or("inbox");
            newest_anywhere(app, count, unread_only, folder).await.map(|found| {
                if found.is_empty() {
                    if unread_only { format!("No unread email in {place}.") } else { format!("No email in {place}.") }
                } else {
                    format!("{} newest emails in {place}, newest first:\n{}", found.len(), list_text(&found, LIST_CHARS))
                }
            })
        }
        "mail_search" => {
            let query = input.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            search_anywhere(app, &query, count, folder).await.map(|found| {
                if found.is_empty() {
                    format!("No email matches {query}.")
                } else {
                    format!("{} emails match, newest first:\n{}", found.len(), list_text(&found, LIST_CHARS))
                }
            })
        }
        "mail_read" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if crate::outlook::is_id(&id) {
                crate::outlook::read(id, FULL_CHARS)
                    .await
                    .map(|(f, files)| read_text(&f, files.iter().map(|x| (x.name.as_str(), x.mime, x.size)).collect()))
            } else {
                read(app, &id).await.map(|(f, files)| read_text(&f, files.iter().map(|x| (x.name.as_str(), x.mime.as_str(), x.file_size())).collect()))
            }
        }
        "mail_folders" => folders_anywhere(app).await,
        "mail_attachment" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let saved = if crate::outlook::is_id(&id) {
                crate::outlook::save_attachment(id, input.get("attachment").cloned()).await
            } else {
                save_attachment(app, &input).await
            };
            let chat = request.get("chat").and_then(|v| v.as_str()).unwrap_or("");
            saved.map(|saved| saved_text(&saved, chat))
        }
        _ => Err(format!("Lumo has no email tool called {tool}.")),
    };
    match answer {
        Ok(text) => json!({ "text": text }),
        Err(e) => refuse(e),
    }
}

/// `mail_read`'s answer: the email's header lines, its files, its text.
fn read_text(f: &Found, files: Vec<(&str, &str, usize)>) -> String {
    let m = &f.message;
    let state = if f.unread { "unread" } else { "read" };
    let mut text = format!("From: {} <{}>\nDate: {}\nSubject: {}\nState: {state}\n", m.from, m.address, m.date, m.subject);
    if let Some(link) = m.link.as_ref().filter(|l| l.starts_with("http")) {
        text.push_str(&format!("Link: {link}\n"));
    }
    if !files.is_empty() {
        text.push_str("Files attached (mail_attachment saves one where you can read it):\n");
        for (n, (name, mime, size)) in files.iter().enumerate() {
            text.push_str(&format!("  {}. {name} ({mime}, {})\n", n + 1, size_text(*size)));
        }
    }
    text.push('\n');
    text.push_str(if m.body.trim().is_empty() { &m.preview } else { &m.body });
    text
}

// ── IMAP, Outlook or both ─────────────────────────────────────────────────────

/// Which source a reading tool asks.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Sources {
    Imap,
    Outlook,
    Both,
}

/// The folder names both sources understand, each its own way.
fn shared_folder(asked: &str) -> bool {
    ["inbox", "sent", "drafts", "archive", "trash", "spam", "junk", "deleted"].iter().any(|w| asked.trim().eq_ignore_ascii_case(w))
}

/// IMAP for its own folders, Outlook for its own ("outlook:…"), both for the
/// inbox, the sent, the trash… when both are on.
fn sources_for(imap: bool, outlook: bool, folder: Option<&str>) -> Result<Sources, String> {
    let either = match (imap, outlook) {
        (true, true) => Sources::Both,
        (true, false) => Sources::Imap,
        (false, true) => Sources::Outlook,
        (false, false) => return Err(NO_ACCOUNT.into()),
    };
    Ok(match folder {
        Some(f) if crate::outlook::is_folder(f) => {
            if !outlook {
                return Err("Outlook is off in Lumo's Settings (the Email pill): its folders can't be read.".into());
            }
            Sources::Outlook
        }
        Some(f) if !shared_folder(f) => {
            if imap {
                Sources::Imap
            } else {
                Sources::Outlook
            }
        }
        _ => either,
    })
}

async fn which(app: &AppHandle, folder: Option<&str>) -> Result<Sources, String> {
    if !crate::integrations::enabled(app, ID) {
        return Err(PILL_OFF.into());
    }
    sources_for(imap_ready(app), crate::outlook::on(app), folder)
}

/// The two answers as one list, newest first; one source failing leaves the other's.
fn both_found(imap: Result<Vec<Found>, String>, outlook: Result<Vec<Found>, String>, count: usize) -> Result<Vec<Found>, String> {
    let mut all: Vec<Found> = match (imap, outlook) {
        (Ok(a), Ok(b)) => a.into_iter().chain(b).collect(),
        (Ok(a), Err(e)) | (Err(e), Ok(a)) => {
            log::line(format!("[mail] one source: {e}"));
            a
        }
        (Err(a), Err(_)) => return Err(a),
    };
    all.sort_by_key(|f| std::cmp::Reverse(date_key(&f.message.date)));
    all.truncate(count);
    Ok(all)
}

/// `newest`, from IMAP, Outlook or both.
async fn newest_anywhere(app: &AppHandle, count: usize, unread_only: bool, folder: Option<&str>) -> Result<Vec<Found>, String> {
    let count = count.clamp(1, MOST);
    let owned = folder.map(str::to_string);
    match which(app, folder).await? {
        Sources::Imap => newest(app, count, unread_only, folder).await,
        Sources::Outlook => crate::outlook::newest(count, unread_only, owned).await,
        Sources::Both => {
            let (a, b) = both(newest(app, count, unread_only, folder), crate::outlook::newest(count, unread_only, owned)).await;
            both_found(a, b, count)
        }
    }
}

/// `search`, in IMAP, Outlook or both.
async fn search_anywhere(app: &AppHandle, query: &str, count: usize, folder: Option<&str>) -> Result<Vec<Found>, String> {
    let count = count.clamp(1, MOST);
    let owned = folder.map(str::to_string);
    match which(app, folder).await? {
        Sources::Imap => search(app, query, count, folder).await,
        Sources::Outlook => crate::outlook::search(query.to_string(), count, owned).await,
        Sources::Both => {
            let (a, b) = both(search(app, query, count, folder), crate::outlook::search(query.to_string(), count, owned)).await;
            both_found(a, b, count)
        }
    }
}

/// `mail_folders`, of each source on.
async fn folders_anywhere(app: &AppHandle) -> Result<String, String> {
    let outlook_list = || async {
        crate::outlook::folders()
            .await
            .map(|list| format!("Outlook's folders, on this PC (give the name as it is, with outlook:, to mail_recent's, mail_search's or mail_move's folder):\n{list}"))
    };
    match which(app, None).await? {
        Sources::Imap => folders(app).await,
        Sources::Outlook => outlook_list().await,
        Sources::Both => {
            let (a, b) = both(folders(app), outlook_list()).await;
            match (a, b) {
                (Ok(a), Ok(b)) => Ok(format!("{a}\n{b}\ninbox, sent, drafts, archive, trash and spam name both mailboxes' own.")),
                (Ok(one), Err(e)) | (Err(e), Ok(one)) => Ok(format!("{one}\n(The other mailbox didn't answer: {e})")),
                (Err(a), Err(_)) => Err(a),
            }
        }
    }
}

// ── Managing ──────────────────────────────────────────────────────────────────

/// What a managing tool does to one email.
#[derive(Clone, Debug, PartialEq)]
enum Change {
    /// Flags put and taken off: `\Seen` (read), `\Flagged` (starred).
    Flags { add: Vec<&'static str>, remove: Vec<&'static str> },
    /// To another folder (its name as the server has it, and as people read it).
    Move { wire: String, name: String },
    /// Gmail, an email of All Mail: out of the inbox, where it stays in All Mail.
    Unlabel,
}

/// The card's words for a mail_mark: "read", "unread", "star", "unstar".
fn marks(input: &serde_json::Value) -> Result<(Change, Vec<&'static str>), String> {
    let mut add = Vec::new();
    let mut remove = Vec::new();
    let mut said = Vec::new();
    match input.get("read").and_then(|v| v.as_bool()) {
        Some(true) => {
            add.push("\\Seen");
            said.push("read");
        }
        Some(false) => {
            remove.push("\\Seen");
            said.push("unread");
        }
        None => {}
    }
    match input.get("starred").and_then(|v| v.as_bool()) {
        Some(true) => {
            add.push("\\Flagged");
            said.push("star");
        }
        Some(false) => {
            remove.push("\\Flagged");
            said.push("unstar");
        }
        None => {}
    }
    if said.is_empty() {
        return Err("Say what to mark: read (true or false), starred (true or false).".into());
    }
    Ok((Change::Flags { add, remove }, said))
}

/// Where an email goes: the folder named, unless it is there already.
fn moving(to: &Mailbox, from: &Folder) -> Result<Change, String> {
    let here = match from {
        Folder::Inbox => to.is_inbox(),
        Folder::All => to.has("\\All"),
        Folder::Named(name) => to.name == *name,
    };
    if here {
        return Err(format!("The email is already in {}.", to.name));
    }
    Ok(Change::Move { wire: to.wire.clone(), name: if to.is_inbox() { "inbox".into() } else { to.name.clone() } })
}

/// `mail_mark`, `mail_move`, `mail_archive`, `mail_trash`: one email changed,
/// on a card of its own first, and only on the user's click. Nothing is ever
/// deleted for good: the trash is a folder like the others.
async fn manage(app: &AppHandle, tool: &str, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (acct, plain) = account_for(app, &id)?;
    let (folder, uid) = parse_id(&plain).ok_or_else(|| bad_id(&id))?;
    let (mut imap, host) = open(&acct).await?;
    // The email, for its card, and what to do to it.
    let planned = timed(&host, async {
        if folder != Folder::Inbox {
            enter(&mut imap, &folder, false).await?;
        }
        let found = fetch(&mut imap, &host, &folder, &[uid], 1024, BODY_CHARS).await?.into_iter().next().ok_or_else(|| gone(&id))?;
        let boxes = mailboxes(&mut imap).await?;
        let (change, words) = match tool {
            "mail_mark" => marks(input)?,
            "mail_move" => {
                let asked = input.get("folder").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if asked.is_empty() {
                    return Err("Say which folder to move it to (mail_folders lists them).".into());
                }
                let to = match folder_named(&mut imap, &host, &asked).await? {
                    Folder::Inbox => boxes.iter().find(|b| b.is_inbox()),
                    Folder::All => boxes.iter().find(|b| b.has("\\All")),
                    Folder::Named(name) => boxes.iter().find(|b| b.name == name),
                }
                .ok_or_else(|| format!("The mailbox has no folder called {asked}: mail_folders lists them."))?;
                (moving(to, &folder)?, vec!["move"])
            }
            "mail_archive" => {
                let change = if is_gmail(&host) {
                    match &folder {
                        Folder::Inbox => {
                            let all = boxes.iter().find(|b| b.has("\\All")).ok_or_else(|| "This mailbox has no folder with all the mail.".to_string())?;
                            Change::Move { wire: all.wire.clone(), name: all.name.clone() }
                        }
                        Folder::All => Change::Unlabel,
                        Folder::Named(_) => return Err("On Gmail only an email of the inbox is archived: use mail_move for one in a label.".into()),
                    }
                } else {
                    let archive = find_role(&boxes, Role::Archive).ok_or_else(|| "This mailbox has no Archive folder: use mail_move with one mail_folders lists.".to_string())?;
                    moving(archive, &folder)?
                };
                (change, vec!["archive"])
            }
            _ => {
                let trash = find_role(&boxes, Role::Trash).ok_or_else(|| "This mailbox has no Trash folder: Lumo never deletes an email for good.".to_string())?;
                if matches!(&folder, Folder::Named(name) if *name == trash.name) {
                    return Err("The email is already in the trash: Lumo never deletes an email for good.".into());
                }
                (moving(trash, &folder)?, vec!["trash"])
            }
        };
        Ok((found, change, words))
    })
    .await;
    close(imap).await;
    let (found, change, words) = planned?;
    let m = &found.message;
    let from = if m.from.is_empty() || m.from == m.address { m.address.clone() } else { format!("{} <{}>", m.from, m.address) };
    let target = match &change {
        Change::Move { name, .. } => name.clone(),
        _ => String::new(),
    };
    let card = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "tool_name": format!("mcp__lumo__{tool}"),
        "tool_input": { "id": id },
        "lumo_mail_action": { "actions": words, "folder": target, "from": from, "subject": m.subject, "date": m.date },
    });
    match crate::pipe::ask(app, card).await.as_deref() {
        Some("allow") => {}
        Some(_) => return Err("The user said no: the email was left as it is.".into()),
        None => return Err("Lumo couldn't show the card to the user (the island is paused or busy): nothing was changed.".into()),
    }
    let (mut imap, host) = open(&acct).await?;
    let done = timed(&host, async {
        enter(&mut imap, &folder, true).await?;
        apply(&mut imap, uid, &change).await
    })
    .await;
    close(imap).await;
    done.inspect_err(|e| log::line(format!("[mail] {tool}: {e}")))?;
    log::line(format!("[mail] {tool} done"));
    wake();
    Ok(match change {
        Change::Flags { .. } => format!("Done: the email is marked {}.", words.join(", ")),
        Change::Move { name, .. } => format!("Done: the email is in {name} now."),
        Change::Unlabel => "Done: the email is archived (out of the inbox, still in All Mail).".into(),
    })
}

/// Does `change` to email `uid` of the folder open to change (SELECT).
async fn apply(imap: &mut Imap, uid: u32, change: &Change) -> Result<(), String> {
    match change {
        Change::Flags { add, remove } => {
            if !add.is_empty() {
                imap.run(&format!("UID STORE {uid} +FLAGS.SILENT ({})", add.join(" "))).await?;
            }
            if !remove.is_empty() {
                imap.run(&format!("UID STORE {uid} -FLAGS.SILENT ({})", remove.join(" "))).await?;
            }
            Ok(())
        }
        Change::Unlabel => imap.run(&format!("UID STORE {uid} -X-GM-LABELS (\\Inbox)")).await.map(|_| ()),
        Change::Move { wire, .. } => {
            let can = |c: &str| imap.capabilities.iter().any(|x| x == c);
            if can("MOVE") {
                imap.run(&format!("UID MOVE {uid} {}", quoted(wire))).await.map(|_| ())
            } else if can("UIDPLUS") {
                // A copy, then this one email only taken out of here (UID EXPUNGE): never any other.
                imap.run(&format!("UID COPY {uid} {}", quoted(wire))).await?;
                imap.run(&format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)")).await?;
                imap.run(&format!("UID EXPUNGE {uid}")).await.map(|_| ())
            } else {
                Err("This mail server can't move one email without touching others, so Lumo leaves it where it is.".into())
            }
        }
    }
}

/// `mail_mark`, `mail_move`, `mail_archive`, `mail_trash` on an Outlook
/// email: on its card first, done only on the user's click. The trash is
/// Deleted Items: nothing is deleted for good.
async fn outlook_manage(app: &AppHandle, tool: &str, input: &serde_json::Value) -> Result<String, String> {
    use crate::outlook::Change as OutlookChange;
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (change, words) = match tool {
        "mail_mark" => {
            let (_, words) = marks(input)?;
            let flag = |key: &str| input.get(key).and_then(|v| v.as_bool());
            (OutlookChange::Mark { read: flag("read"), starred: flag("starred") }, words)
        }
        "mail_move" => {
            let asked = input.get("folder").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if asked.is_empty() {
                return Err("Say which folder to move it to (mail_folders lists them).".into());
            }
            (OutlookChange::Move(asked), vec!["move"])
        }
        "mail_archive" => (OutlookChange::Archive, vec!["archive"]),
        _ => (OutlookChange::Trash, vec!["trash"]),
    };
    let (planned, change) = crate::outlook::plan(id.clone(), change).await?;
    let card = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "tool_name": format!("mcp__lumo__{tool}"),
        "tool_input": { "id": id },
        "lumo_mail_action": { "actions": words, "folder": planned.folder, "from": planned.from, "subject": planned.subject, "date": planned.date },
    });
    match crate::pipe::ask(app, card).await.as_deref() {
        Some("allow") => {}
        Some(_) => return Err("The user said no: the email was left as it is.".into()),
        None => return Err("Lumo couldn't show the card to the user (the island is paused or busy): nothing was changed.".into()),
    }
    let done = crate::outlook::apply(id, change).await.inspect_err(|e| log::line(format!("[outlook] {tool}: {e}")))?;
    log::line(format!("[outlook] {tool} done"));
    wake();
    Ok(if tool == "mail_mark" { format!("Done: the email is marked {}.", words.join(", ")) } else { done })
}

pub(crate) fn uid_of(id: &str) -> Option<u32> {
    id.rsplit(':').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::tests::{acct, found};

    #[test]
    fn the_accounts_emails_come_as_one_list_each_id_with_its_account() {
        let one = vec![(acct(1, "me@gmail.com"), Ok(vec![found("inbox:5", "Mon, 3 Nov 2025 10:00:00 +0000", None)]))];
        assert_eq!(merged(one, 10).unwrap()[0].id, "inbox:5");

        let two = vec![
            (acct(1, "me@gmail.com"), Ok(vec![found("inbox:5", "Mon, 3 Nov 2025 10:00:00 +0000", None)])),
            (acct(2, "work@x.it"), Ok(vec![found("Sent:9", "Tue, 4 Nov 2025 10:00:00 +0000", None)])),
            (acct(3, "old@y.it"), Err("The mailbox has no folder called Sent".into())),
        ];
        let all = merged(two, 10).unwrap();
        let ids: Vec<&str> = all.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["work@x.it:Sent:9", "me@gmail.com:inbox:5"]);
        assert_eq!(parse_id(all[0].id.split_once(':').unwrap().1), Some((Folder::Named("Sent".into()), 9)));

        let none = vec![(acct(1, "a@x.it"), Err::<Vec<Found>, _>("first".to_string())), (acct(2, "b@x.it"), Err("second".into()))];
        assert_eq!(merged(none, 10), Err("first".into()));
    }

    #[test]
    fn imap_folders_go_to_imap_outlook_folders_to_outlook_the_shared_ones_to_both() {
        assert_eq!(sources_for(true, true, None), Ok(Sources::Both));
        assert_eq!(sources_for(true, true, Some("Sent")), Ok(Sources::Both));
        assert_eq!(sources_for(true, true, Some("Archivio/2025")), Ok(Sources::Imap));
        assert_eq!(sources_for(true, true, Some("outlook:ada@outlook.it/Inbox")), Ok(Sources::Outlook));
        assert_eq!(sources_for(false, true, Some("Lavoro")), Ok(Sources::Outlook));
        assert_eq!(sources_for(true, false, None), Ok(Sources::Imap));
        assert!(sources_for(true, false, Some("outlook:ada@outlook.it/Inbox")).is_err());
        assert_eq!(sources_for(false, false, None), Err(NO_ACCOUNT.to_string()));
    }

    #[test]
    fn an_outlook_folder_named_archive_in_any_language_is_the_archive() {
        assert!(is_archive_name("Archive") && is_archive_name(" archivio ") && !is_archive_name("Lavoro"));
    }

    #[test]
    fn an_emails_file_is_told_in_the_folder_of_the_chat_that_asked() {
        let saved = crate::files::write_in("saved-text-test.pdf", b"%PDF").unwrap();
        let chat = "saved-text-test-chat";
        crate::files::forget_chat(chat);
        let told = saved_text(&saved, chat);
        let moved = crate::files::chat_dir(chat).join("saved-text-test.pdf");
        assert!(told.contains(&moved.to_string_lossy().to_string()), "{told}");
        assert_eq!(std::fs::read(&moved).unwrap(), b"%PDF");
        assert!(!std::path::Path::new(&saved.path).exists(), "it left the inbox");
        // No chat (an API provider, a task of Gemini Live): the inbox's own path.
        let waiting = crate::files::write_in("saved-text-test.pdf", b"%PDF").unwrap();
        assert!(saved_text(&waiting, "").contains(&waiting.path));
        crate::files::forget_chat(chat);
        let _ = std::fs::remove_file(&waiting.path);
    }

    #[test]
    fn the_agents_get_read_and_unread_emails_with_ids() {
        let m = Message {
            id: "imap.gmail.com:42".into(), from: "Ada".into(), address: "ada@example.org".into(), subject: "Lunch".into(),
            preview: "Shall we".into(), body: "Shall we\n  meet at noon?".into(), date: "Wed, 14 Oct 2026 12:00".into(),
            link: None,
        };
        let read = Found { id: "inbox:42".into(), message: m.clone(), unread: false };
        let unread = Found { id: "inbox:43".into(), message: Message { subject: String::new(), ..m }, unread: true };
        let text = list_text(&[unread, read], 100);
        assert!(text.contains("- [inbox:43] unread, from Ada <ada@example.org>, Wed, 14 Oct 2026 12:00: (no subject)\n"), "{text}");
        assert!(text.contains("- [inbox:42] read, from Ada"), "{text}");
    }

    #[test]
    fn email_ids_and_folders_are_read_back() {
        assert_eq!(parse_id("inbox:42"), Some((Folder::Inbox, 42)));
        assert_eq!(parse_id("INBOX:42"), Some((Folder::Inbox, 42)));
        assert_eq!(parse_id(" all:7 "), Some((Folder::All, 7)));
        assert_eq!(parse_id("[Gmail]/Posta inviata:7"), Some((Folder::Named("[Gmail]/Posta inviata".into()), 7)));
        assert_eq!(parse_id("Clienti: 2025:9"), Some((Folder::Named("Clienti: 2025".into()), 9)), "a colon in the name");
        assert_eq!(parse_id(":42"), None);
        assert_eq!(parse_id("inbox:0"), None);
        assert_eq!(parse_id("inbox:x"), None);
        assert_eq!(parse_id("42"), None);
        assert_eq!(list_name(r#""/" "[Gmail]/All Mail""#).as_deref(), Some("[Gmail]/All Mail"));
        assert_eq!(list_name(r#""/" "[Gmail]/Tutti i messaggi""#).as_deref(), Some("[Gmail]/Tutti i messaggi"));
        assert_eq!(list_name("NIL Archive").as_deref(), Some("Archive"));
        assert_eq!(list_name(r#""\\" "A \"b\"""#).as_deref(), Some("A \"b\""));
    }

    #[test]
    fn folder_names_read_as_people_write_them() {
        assert_eq!(utf7_decode("&AMk-l&AOk-ments supprim&AOk-s"), "Éléments supprimés");
        assert_eq!(utf7_decode("Posta inviata"), "Posta inviata");
        assert_eq!(utf7_decode("Tom &- Jerry"), "Tom & Jerry");
        assert_eq!(utf7_decode("&ZeVnLIqe-"), "日本語");
        assert_eq!(utf7_decode("Ciao &2D3cSw-"), "Ciao 👋");
        assert_eq!(utf7_decode("Rotto &AMk"), "Rotto &AMk", "never closed: as it came");
    }

    #[test]
    fn folders_say_what_they_are_for() {
        let unit = |line: &str| vec![Part::Text(line.into())];
        let boxes: Vec<Mailbox> = [
            r#"* LIST (\HasNoChildren) "/" "INBOX""#,
            r#"* LIST (\HasChildren \Noselect) "/" "[Gmail]""#,
            r#"* LIST (\HasNoChildren \Sent) "/" "[Gmail]/Posta inviata""#,
            r#"* LIST (\HasNoChildren \Trash) "/" "[Gmail]/Cestino""#,
            r#"* LIST (\HasNoChildren) "." "INBOX.Drafts""#,
            r#"* LIST (\HasNoChildren) "/" "Archivio""#,
            r#"* LIST (\HasNoChildren) "/" "&AMk-l&AOk-ments supprim&AOk-s""#,
        ]
        .iter()
        .filter_map(|l| parse_list(&unit(l)))
        .collect();
        assert_eq!(boxes.len(), 7);
        assert!(!boxes[1].selectable());
        assert_eq!(boxes[6].name, "Éléments supprimés");
        assert_eq!(boxes[6].wire, "&AMk-l&AOk-ments supprim&AOk-s");
        assert_eq!(find_role(&boxes, Role::Sent).map(|b| b.name.as_str()), Some("[Gmail]/Posta inviata"));
        assert_eq!(find_role(&boxes, Role::Trash).map(|b| b.name.as_str()), Some("[Gmail]/Cestino"), "marked first");
        assert_eq!(find_role(&boxes, Role::Drafts).map(|b| b.name.as_str()), Some("INBOX.Drafts"), "by its name");
        assert_eq!(find_role(&boxes, Role::Archive).map(|b| b.name.as_str()), Some("Archivio"));
        assert_eq!(find_role(&boxes, Role::Junk), None);
        assert_eq!(role_of(&boxes[0]), None, "the inbox is the inbox");
        let literal = vec![Part::Text(r#"* LIST (\HasNoChildren) "/" {9}"#.into()), Part::Literal(b"Bozze \"x".to_vec()), Part::Text(String::new())];
        assert_eq!(parse_list(&literal).map(|b| b.name), Some("Bozze \"x".to_string()));
        let status = vec![Part::Text(r#"* STATUS "Sent" (MESSAGES 12 UNSEEN 3)"#.into())];
        assert_eq!(status_counts(&status), Some((12, 3)));
        assert_eq!(status_counts(&[Part::Text("* OK".into())]), None);
    }

    #[test]
    fn dates_of_several_folders_are_put_in_order() {
        assert_eq!(date_key("Thu, 1 Jan 1970 00:00:00 +0000"), 0);
        assert_eq!(date_key("Wed, 28 Oct 2026 21:51:05 +0000"), 1_793_224_265);
        assert_eq!(date_key("Wed, 28 Oct 2026 23:51:05 +0200"), 1_793_224_265);
        assert_eq!(date_key("28 Oct 2026 16:51:05 EST (Eastern)"), 1_793_224_265);
        assert!(date_key("Tue, 3 Mar 2026 10:00:00 +0100") < date_key("Mon, 2 Nov 2026 09:00:00 +0100"));
        assert_eq!(date_key("nonsense"), 0);
    }

    #[test]
    fn the_file_asked_for_is_its_number_or_its_name() {
        let file = |n: &str| Attached { section: "2".into(), name: n.into(), mime: "application/pdf".into(), encoding: "base64".into(), size: 4 };
        let files = [file("a.pdf"), file("B.pdf")];
        assert_eq!(pick(&files, Some(&json!(2))).unwrap().name, "B.pdf");
        assert_eq!(pick(&files, Some(&json!("1"))).unwrap().name, "a.pdf");
        assert_eq!(pick(&files, Some(&json!("b.PDF"))).unwrap().name, "B.pdf");
        assert!(pick(&files, Some(&json!(3))).is_err());
        assert!(pick(&files, None).is_err(), "two files: say which");
        assert_eq!(pick(&files[..1], None).unwrap().name, "a.pdf");
        assert!(pick(&[], Some(&json!(1))).is_err());
    }

    #[test]
    fn marking_says_what_it_does() {
        let (change, words) = marks(&json!({ "read": true, "starred": false })).unwrap();
        assert_eq!(change, Change::Flags { add: vec!["\\Seen"], remove: vec!["\\Flagged"] });
        assert_eq!(words, ["read", "unstar"]);
        assert_eq!(marks(&json!({ "read": false })).unwrap().1, ["unread"]);
        assert!(marks(&json!({})).is_err());
        let trash = Mailbox { wire: "Trash".into(), name: "Trash".into(), flags: vec!["\\Trash".into()] };
        assert_eq!(moving(&trash, &Folder::Inbox), Ok(Change::Move { wire: "Trash".into(), name: "Trash".into() }));
        assert!(moving(&trash, &Folder::Named("Trash".into())).is_err(), "already there");
    }

    #[test]
    fn the_flags_say_whether_an_email_was_read() {
        let unit = |line: &str| vec![Part::Text(line.into()), Part::Literal(b"From: a".to_vec())];
        assert!(seen(&unit("* 3 FETCH (UID 9 FLAGS (\\Seen \\Flagged) BODY[HEADER.FIELDS (FROM)] {7}")));
        assert!(!seen(&unit("* 3 FETCH (UID 9 FLAGS () BODY[HEADER.FIELDS (FROM)] {7}")));
        assert!(!seen(&unit("* 3 FETCH (UID 9 FLAGS (\\Answered) BODY[HEADER.FIELDS (FROM)] {7}")));
    }

    #[test]
    fn a_search_never_breaks_out_of_its_quotes() {
        let plain = |c: &str| (c.to_string(), None);
        assert_eq!(search_command("imap.gmail.com", "from:amazon newer_than:7d"), plain(r#"UID SEARCH X-GM-RAW "from:amazon newer_than:7d""#));
        assert_eq!(search_command("imap.libero.it", "fattura"), plain(r#"UID SEARCH TEXT "fattura""#));
        assert_eq!(search_command("imap.libero.it", "x\" OR ALL\r\nL1 LOGOUT"), plain(r#"UID SEARCH TEXT "x OR ALL L1 LOGOUT""#));
        assert_eq!(search_command("imap.gmail.com", "caffè\r\n"), ("UID SEARCH CHARSET UTF-8 X-GM-RAW".to_string(), Some("caffè".to_string())));
    }
}
