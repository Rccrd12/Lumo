// The Email pill: new messages in the user's inbox, read over IMAP with an app
// password (Gmail, Outlook, iCloud, any IMAP server), for the closed island's
// email preview and the pill's card. The server says when one arrives (IDLE),
// so it shows within seconds.
//
// The pill itself only reads: the inbox is opened with EXAMINE (the server
// refuses any change to it) and message bodies are fetched with BODY.PEEK
// (they stay unread). The address, the server and the app password are in the
// credential store (secrets.rs); the connection is TLS only, to the server the
// user typed.
//
// The agents read it too: a question about email in the chat brings the
// newest emails, read or not, and the CLIs get Lumo's email tools
// (`lumo-hook --mcp --tools=mail`): the newest emails of a folder, a search
// of every folder, one email in full with its files (one saved with the chat's
// files, to read), the list of folders. They answer only while an agent of
// the island is at work (`agent_turn`), each on a short connection of its own.
//
// What more they may do is Settings → General → Security → Email's: with
// "Read and send", send, reply in the conversation and forward with the files
// (each email on its card, gone only when the user clicks Send; smtp.rs),
// and save drafts in the mailbox's Drafts; with "Read, send and manage",
// also mark read or unread, star, move, archive and trash one email, each on
// a card of its own. Nothing here ever deletes an email for good.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_rustls::rustls::{self, pki_types::ServerName, ClientConfig, RootCertStore};
use tokio_rustls::{client::TlsStream, TlsConnector};

use crate::i18n::{t, tf};
use crate::integrations::{emit, IntegrationUpdate};
use crate::island::WINDOW_LABEL;
use crate::settings::Settings;
use crate::{log, secrets};

pub const ID: &str = "integration_mail";
pub const ADDRESS_KEY: &str = "mail-address";
pub const SERVER_KEY: &str = "mail-imap-server";
pub const PASSWORD_KEY: &str = "mail-app-password";

/// One step with the server: connect and sign in, or look.
const TIMEOUT: Duration = Duration::from_secs(25);
/// The server's answer to IDLE and to DONE, which comes at once on a live
/// connection: a connection that went quiet (sleep, a new network) is told
/// apart sooner.
const IDLE_ANSWER: Duration = Duration::from_secs(10);
/// What one check may read from the server, all answers together.
const MAX_READ: usize = 4 * 1024 * 1024;
/// The newest unread messages kept: the island shows three, and the next ones
/// move up when one is ignored.
const FETCH: usize = 8;
/// Of each message's body, enough for a preview and for the AI to answer it.
const BODY_BYTES: usize = 24 * 1024;
const BODY_CHARS: usize = 6000;
const PREVIEW_CHARS: usize = 180;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Message {
    /// The server's UID, with the account, so the island shows it once.
    pub id: String,
    pub from: String,
    pub address: String,
    pub subject: String,
    pub preview: String,
    pub body: String,
    pub date: String,
    /// Where to read it in the browser, for a webmail we know.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// The highest UID seen per account: what is above it is new. The first
/// check only takes note, so what was already unread is not announced.
static LAST_UID: Mutex<Option<(String, u32)>> = Mutex::new(None);
/// What the island was last sent, so an unchanged inbox sends nothing.
static LAST_SENT: Mutex<Option<String>> = Mutex::new(None);
/// The inbox as last read (unread count, newest unread emails), for the chat
/// (chat.rs): any provider can say what the newest emails are.
static INBOX: Mutex<Option<(usize, Vec<Message>)>> = Mutex::new(None);

// ── Watching the inbox ────────────────────────────────────────────────────────

/// Woken by the pill's Refresh, a change of settings or of the keys.
static WAKE: Notify = Notify::const_new();
/// Bumped when the address, server or password change: the connection is redone.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Look again now (Refresh).
pub fn wake() {
    *LAST_SENT.lock().unwrap() = None;
    WAKE.notify_one();
}

/// Whether a change of settings concerns the Email pill: turned on or off (its
/// connection opens or closes now), its promotions filter, or the language its
/// errors are written in. Any other change leaves the inbox alone.
/// What the AI may do with the email (Settings → General → Security): "none",
/// "read", "send" (read, and send what the user approves on a card), or
/// "manage" (and mark, move, archive and trash, each on a card).
/// Anything else reads as "read", as before the setting.
pub fn access(settings: &Settings) -> &'static str {
    match settings.ai_mail_access.as_str() {
        "none" => "none",
        "send" => "send",
        "manage" => "manage",
        _ => "read",
    }
}

/// The `--tools=` of lumo-hook's email tools the agents get: "" (none: the
/// Email pill is off, or Security keeps it from the AI), "mail" (reading),
/// "mail,mailsend" (and sending, each email only with the user's click),
/// "mail,mailsend,mailmanage" (and changing the mailbox, each change on a card).
pub fn ai_tools(app: &AppHandle) -> &'static str {
    if !crate::integrations::enabled(app, ID) {
        return "";
    }
    match access(&app.state::<crate::Shared>().settings.lock().unwrap()) {
        "none" => "",
        "send" => "mail,mailsend",
        "manage" => "mail,mailsend,mailmanage",
        _ => "mail",
    }
}

/// The Email pill is on and the AI may read what it reads: the chat, Gemini
/// Live's helper and Lumo's email tools go by it.
pub fn for_ai(app: &AppHandle) -> bool {
    !ai_tools(app).is_empty()
}

pub fn concerned(before: &Settings, after: &Settings) -> bool {
    let on = |s: &Settings| s.active_integrations.iter().any(|id| id == ID);
    on(before) != on(after) || before.mail_hide_promotions != after.mail_hide_promotions || before.language != after.language
}

/// The keys changed: sign in again with the new ones.
pub fn keys_changed() {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    WAKE.notify_one();
}

/// The server tells Lumo about a new email as it arrives (IMAP IDLE), on one
/// connection kept open while the pill is on. A server without IDLE is asked
/// every 30 seconds instead. Nothing happens while the pill is off, Lumo is
/// paused or the keys are missing.
///
/// A connection that fails (the network not back yet after sleep, a
/// connection the server or a router dropped without a word, a passing
/// refusal from the server) is redone within seconds, and the emails already
/// read stay on screen: the error shows only after a few failures in a row
/// (`shows_error`), or at the second when nothing was read yet.
pub async fn run(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(4)).await;
    let mut health = Health::default();
    let mut generation = GENERATION.load(Ordering::Relaxed);
    loop {
        if !crate::integrations::enabled(&app, ID) || crate::integrations::PAUSED.load(Ordering::Relaxed) {
            *INBOX.lock().unwrap() = None;
            health = Health::default();
            let _ = tokio::time::timeout(Duration::from_secs(60), WAKE.notified()).await;
            continue;
        }
        let Some((address, password)) = secrets::get(ADDRESS_KEY).zip(secrets::get(PASSWORD_KEY)) else {
            *INBOX.lock().unwrap() = None;
            health = Health::default();
            let _ = tokio::time::timeout(Duration::from_secs(60), WAKE.notified()).await;
            continue;
        };
        // New keys: what the old ones read says nothing about them.
        let now = GENERATION.load(Ordering::Relaxed);
        if now != generation {
            generation = now;
            health = Health::default();
        }
        let server = secrets::get(SERVER_KEY).unwrap_or_default();
        let (host, port) = server_of(&server, &address);
        if let Err(error) = watch(&app, &host, port, &address, &password, &mut health).await {
            health.failures += 1;
            if shows_error(health.failures, health.has_read) {
                fail(&app, error);
            } else {
                log::line(format!("[mail] {error} (trying again)"));
            }
            // Waits before trying again (longer each time), unless woken.
            let _ = tokio::time::timeout(retry_in(health.failures), WAKE.notified()).await;
        }
    }
}

/// How the connection has been going since the pill was turned on.
#[derive(Default)]
struct Health {
    /// Connections in a row that failed before reading the inbox.
    failures: u32,
    /// The inbox was read at least once, with these keys.
    has_read: bool,
}

/// The first failures are tried again at once; then 30 s, doubled each time.
const RETRY_SOON: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(5)];
const RETRY_FIRST: Duration = Duration::from_secs(30);
const RETRY_MOST: Duration = Duration::from_secs(300);
/// Failures in a row before the error replaces the emails already read.
const FAILURES_SHOWN: u32 = 3;

/// After `failures` failures in a row, the wait before the next try.
fn retry_in(failures: u32) -> Duration {
    let soon = RETRY_SOON.len() as u32;
    if failures <= soon {
        return RETRY_SOON[failures.saturating_sub(1) as usize];
    }
    RETRY_FIRST.saturating_mul(1 << (failures - soon - 1).min(8)).min(RETRY_MOST)
}

/// Whether a failure is shown, or the emails already read are kept: with
/// nothing read yet (a wrong password) it shows at the second.
fn shows_error(failures: u32, has_read: bool) -> bool {
    failures >= if has_read { FAILURES_SHOWN } else { 2 }
}
/// How long one IDLE lasts before Lumo looks again anyway. The server should
/// say at once when an email arrives, but some (Gmail) can be slow to: looking
/// every 20 seconds costs one tiny SEARCH, as only new emails are fetched.
/// Settings → General → Energy makes it 5 seconds with nothing spared, a
/// minute while saving energy.
fn idle_for() -> Duration {
    Duration::from_secs(crate::energy::pick(5, 20, 60))
}
/// Without IDLE, how often the inbox is asked.
fn poll_every() -> Duration {
    Duration::from_secs(crate::energy::pick(5, 30, 90))
}

/// One connection: sign in, then look each time the server says something
/// changed. Returns Ok when it should be redone (keys changed, pill off).
async fn watch(app: &AppHandle, host: &str, port: u16, address: &str, password: &str, health: &mut Health) -> Result<(), String> {
    let generation = GENERATION.load(Ordering::Relaxed);
    let mut imap = timed(host, sign_in(host, port, address, password)).await?;
    let idle = imap.capabilities.iter().any(|c| c == "IDLE");
    let account = format!("{address}@{host}");
    let mut known = std::collections::HashMap::new();
    let mut hiding = hides_promotions(app);
    loop {
        imap.read = 0;
        let hide = hides_promotions(app);
        if hide != hiding {
            // The filter changed: what it lets through now is not news.
            *LAST_UID.lock().unwrap() = None;
            hiding = hide;
        }
        let (unread, messages) = timed(host, look(&mut imap, host, hide, &mut known)).await?;
        report(app, &account, host, unread, messages);
        health.failures = 0;
        health.has_read = true;
        let stop = || {
            GENERATION.load(Ordering::Relaxed) != generation
                || !crate::integrations::enabled(app, ID)
                || crate::integrations::PAUSED.load(Ordering::Relaxed)
        };
        if stop() {
            let _ = tokio::time::timeout(Duration::from_secs(5), imap.run("LOGOUT")).await;
            return Ok(());
        }
        if idle {
            imap.idle(host).await?;
        } else {
            let _ = tokio::time::timeout(poll_every(), WAKE.notified()).await;
        }
        if stop() {
            let _ = tokio::time::timeout(Duration::from_secs(5), imap.run("LOGOUT")).await;
            return Ok(());
        }
    }
}

/// A step that must not hang: the server has TIMEOUT to answer.
async fn timed<T>(host: &str, step: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    timed_for(TIMEOUT, host, step).await
}

async fn timed_for<T>(wait: Duration, host: &str, step: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(wait, step)
        .await
        .unwrap_or_else(|_| Err(tf("{server} did not answer in time.", &[("server", host)])))
}

/// What the island gets: the newest unread emails, and the ones that are new.
fn report(app: &AppHandle, account: &str, host: &str, unread: usize, messages: Vec<Message>) {
    let newest = messages.iter().filter_map(|m| uid_of(&m.id)).max().unwrap_or(0);
    let fresh: Vec<Message> = {
        let mut last = LAST_UID.lock().unwrap();
        let seen = match last.as_ref() {
            Some((a, seen)) if a == account => Some(*seen),
            _ => None,
        };
        let fresh = match seen {
            Some(seen) => messages.iter().filter(|m| uid_of(&m.id).is_some_and(|u| u > seen)).cloned().collect(),
            None => Vec::new(),
        };
        *last = Some((account.to_string(), newest.max(seen.unwrap_or(0))));
        fresh
    };
    *INBOX.lock().unwrap() = Some((unread, messages.clone()));
    // Only what changed reaches the island: a quiet inbox wakes nothing.
    let data = json!({ "messages": messages, "unread": unread, "inbox": inbox_link(host) });
    let text = data.to_string();
    let changed = {
        let mut sent = LAST_SENT.lock().unwrap();
        let changed = sent.as_deref() != Some(text.as_str());
        *sent = Some(text);
        changed
    };
    if changed {
        emit(app, IntegrationUpdate { id: ID, data, error: None, event: None });
    }
    if !fresh.is_empty() {
        crate::listen_events::heard_mail(app, &fresh);
        let _ = app.emit_to(WINDOW_LABEL, "mail-new", &fresh);
    }
}

fn fail(app: &AppHandle, error: String) {
    *LAST_SENT.lock().unwrap() = None;
    *INBOX.lock().unwrap() = None;
    log::line(format!("[mail] {error}"));
    emit(app, IntegrationUpdate { id: ID, data: json!({}), error: Some(error), event: None });
}

// ── For the chat ──────────────────────────────────────────────────────────────

/// Of each email's text, what goes to the chat with a question about email.
const CHAT_BODY_CHARS: usize = 1500;

/// The inbox as last read, while the pill is on and signed in.
pub fn inbox() -> Option<(usize, Vec<Message>)> {
    INBOX.lock().unwrap().clone()
}

/// Whether `query` speaks of email ("le ultime email", "any new mail?",
/// "la posta", "my inbox"): only then does the inbox go with it.
pub fn asks_about(query: &str) -> bool {
    const WORDS: &[&str] = &["mail", "email", "inbox", "posta", "correo", "courriel", "postfach", "newsletter"];
    // Each keyword starts a word of the question, as desk.rs does: "proposta"
    // and "impostazioni" are not about the post, nor "Mailchimp" about mail.
    let q = query.to_lowercase();
    q.split(|c: char| !c.is_alphanumeric()).any(|word| WORDS.iter().any(|w| word.starts_with(w)))
}

/// The newest unread emails, as the chat's provider reads them.
pub fn context_text(unread: usize, messages: &[Message]) -> String {
    let mut out = String::from(CAN);
    if messages.is_empty() {
        out.push_str("Right now there is no unread email.\n");
        return out;
    }
    out.push_str(&format!(
        "Their newest unread emails, newest first ({} of {} unread; emails already read are not listed):\n",
        messages.len(),
        unread.max(messages.len())
    ));
    for m in messages {
        let from = match (m.from.trim(), m.address.trim()) {
            ("", a) => a.to_string(),
            (f, "") => f.to_string(),
            (f, a) => format!("{f} <{a}>"),
        };
        let subject = if m.subject.trim().is_empty() { "(no subject)" } else { m.subject.trim() };
        out.push_str(&format!("- From {from}, {}: {subject}\n", m.date.trim()));
        let text = if m.body.trim().is_empty() { &m.preview } else { &m.body };
        let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            let cut: String = text.chars().take(CHAT_BODY_CHARS).collect();
            let more = if cut.len() < text.len() { "…" } else { "" };
            out.push_str(&format!("  {cut}{more}\n"));
        }
    }
    out.push_str("Answer questions about the user's email from this list. To reply, use mail_reply (or mail_send) if you have it, else write a draft for them to send themselves.\n");
    out
}

// ── For the agents ────────────────────────────────────────────────────────────

/// What the agents' tools give at most, and by default.
const MOST: usize = 25;
const DEFAULT_COUNT: usize = 10;
/// Of an email read in full: what is fetched, and what the agent reads.
const FULL_BYTES: usize = 256 * 1024;
const FULL_CHARS: usize = 20_000;
/// Of each email in a list: the start of its text.
const LIST_CHARS: usize = 400;
/// Of the email answered, what is quoted under a reply.
const QUOTED_CHARS: usize = 4000;
/// At most this many folders searched, or counted in mail_folders.
const MOST_FOLDERS: usize = 60;
/// A step that may take longer: every folder searched, files fetched.
const SLOW_TIMEOUT: Duration = Duration::from_secs(55);
/// The most a file attached to an email may weigh as it comes (in base64).
const MAX_ATTACHMENT_READ: usize = 32 * 1024 * 1024;
/// How long the chat waits for the newest emails before it makes do with the unread ones.
const CHAT_WAIT: Duration = Duration::from_secs(12);

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
enum Folder {
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
fn parse_id(id: &str) -> Option<(Folder, u32)> {
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

/// A short connection for an agent: the Email pill must be on, and signed in.
async fn open(app: &AppHandle) -> Result<(Imap, String), String> {
    if !crate::integrations::enabled(app, ID) {
        return Err("The Email pill is off in Lumo: the user can turn it on in Lumo's Settings.".into());
    }
    let (address, password) = secrets::get(ADDRESS_KEY)
        .zip(secrets::get(PASSWORD_KEY))
        .ok_or_else(|| NO_ACCOUNT.to_string())?;
    let server = secrets::get(SERVER_KEY).unwrap_or_default();
    let (host, port) = server_of(&server, &address);
    let imap = timed(&host, sign_in(&host, port, &address, &password)).await?;
    Ok((imap, host))
}

const NO_ACCOUNT: &str = "Lumo has no email account yet: the user adds one in Lumo's Settings, under the Email pill.";

/// Ends a short connection, without waiting long for the server's goodbye.
async fn close(mut imap: Imap) {
    let _ = tokio::time::timeout(Duration::from_secs(5), imap.run("LOGOUT")).await;
}

// ── Folders ───────────────────────────────────────────────────────────────────

/// A folder of the mailbox, as LIST gives it.
#[derive(Clone, Debug, PartialEq)]
struct Mailbox {
    /// As the server names it (modified UTF-7), for its commands.
    wire: String,
    /// As people read it.
    name: String,
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
enum Role {
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
fn find_role(boxes: &[Mailbox], role: Role) -> Option<&Mailbox> {
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

async fn mailboxes(imap: &mut Imap) -> Result<Vec<Mailbox>, String> {
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
async fn enter(imap: &mut Imap, folder: &Folder, change: bool) -> Result<String, String> {
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
    let (mut imap, host) = open(app).await?;
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
fn full_text(unit: &[Part]) -> String {
    let (header, body) = header_and_body(unit);
    let headers = parse_headers(header);
    let field = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).unwrap_or("");
    tidy(&extract_text(field("Content-Type"), field("Content-Transfer-Encoding"), body))
}

/// A FETCH answer's header and body literals.
fn header_and_body(unit: &[Part]) -> (&[u8], &[u8]) {
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
    let (mut imap, host) = open(app).await?;
    let found = timed(&host, async {
        let folder = match folder {
            Some(asked) => folder_named(&mut imap, &host, asked).await?,
            None => Folder::Inbox,
        };
        if folder != Folder::Inbox {
            enter(&mut imap, &folder, false).await?;
        }
        let units = imap.run(if unread_only { "UID SEARCH UNSEEN" } else { "UID SEARCH ALL" }).await?;
        let mut uids = search_uids(&units);
        uids.sort_unstable();
        let newest: Vec<u32> = uids.iter().rev().take(count.clamp(1, MOST)).copied().collect();
        fetch(&mut imap, &host, &folder, &newest, BODY_BYTES, BODY_CHARS).await
    })
    .await;
    close(imap).await;
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
    let units = match search_command(host, query) {
        (command, None) => imap.run(&command).await?,
        (command, Some(literal)) => imap.run_literal(&command, &literal).await?,
    };
    let mut uids = search_uids(&units);
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
    let (mut imap, host) = open(app).await?;
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
    let (folder, uid) = parse_id(id).ok_or_else(|| bad_id(id))?;
    let (mut imap, host) = open(app).await?;
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
    let found = found.into_iter().next().ok_or_else(|| gone(id))?;
    Ok((found, files))
}

fn bad_id(id: &str) -> String {
    format!("{id} is not an email id: use one mail_recent or mail_search gave.")
}

fn gone(id: &str) -> String {
    format!("No email {id}: it may have been moved or deleted.")
}

/// An email's Date header as seconds since 1970 (UTC), to put the emails of
/// several folders in order; 0 when it can't be read.
fn date_key(date: &str) -> i64 {
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

// ── Attachments ───────────────────────────────────────────────────────────────

/// A file attached to an email received, as its BODYSTRUCTURE says.
#[derive(Clone, Debug, PartialEq)]
pub struct Attached {
    /// The part's number, for `BODY[…]`: "2", "1.3".
    section: String,
    pub name: String,
    pub mime: String,
    encoding: String,
    /// Its size as sent (in base64, a third more than the file).
    size: usize,
}

impl Attached {
    /// About how much the file weighs.
    fn file_size(&self) -> usize {
        if self.encoding.eq_ignore_ascii_case("base64") { self.size / 4 * 3 } else { self.size }
    }
}

/// A piece of a FETCH answer, for its BODYSTRUCTURE: a parenthesis, a string
/// (an atom, a quoted string, a literal) or NIL.
#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Open,
    Close,
    Word(String),
    Nil,
}

fn tokens(unit: &[Part]) -> Vec<Tok> {
    let mut out = Vec::new();
    for part in unit {
        let text = match part {
            Part::Literal(bytes) => {
                out.push(Tok::Word(String::from_utf8_lossy(bytes).to_string()));
                continue;
            }
            Part::Text(text) => text,
        };
        // The "{123}" that ends a line is the literal next to it.
        let text = if literal_size(text).is_some() { &text[..text.rfind('{').unwrap_or(text.len())] } else { text.as_str() };
        let mut chars = text.chars().peekable();
        while let Some(&c) = chars.peek() {
            match c {
                '(' => {
                    chars.next();
                    out.push(Tok::Open);
                }
                ')' => {
                    chars.next();
                    out.push(Tok::Close);
                }
                '"' => {
                    chars.next();
                    let mut s = String::new();
                    while let Some(c) = chars.next() {
                        match c {
                            '\\' => s.extend(chars.next()),
                            '"' => break,
                            c => s.push(c),
                        }
                    }
                    out.push(Tok::Word(s));
                }
                c if c.is_whitespace() => {
                    chars.next();
                }
                _ => {
                    let mut s = String::new();
                    while let Some(&c) = chars.peek() {
                        if c.is_whitespace() || c == '(' || c == ')' {
                            break;
                        }
                        s.push(c);
                        chars.next();
                    }
                    out.push(if s.eq_ignore_ascii_case("NIL") { Tok::Nil } else { Tok::Word(s) });
                }
            }
        }
    }
    out
}

/// A BODYSTRUCTURE as a tree: lists of strings and lists.
#[derive(Clone, Debug, PartialEq)]
enum Node {
    List(Vec<Node>),
    Str(String),
    Nil,
}

fn node(toks: &[Tok], i: &mut usize, depth: usize) -> Option<Node> {
    if depth > 32 {
        return None;
    }
    match toks.get(*i)? {
        Tok::Open => {
            *i += 1;
            let mut list = Vec::new();
            loop {
                if toks.get(*i)? == &Tok::Close {
                    *i += 1;
                    return Some(Node::List(list));
                }
                list.push(node(toks, i, depth + 1)?);
            }
        }
        Tok::Close => None,
        Tok::Word(w) => {
            *i += 1;
            Some(Node::Str(w.clone()))
        }
        Tok::Nil => {
            *i += 1;
            Some(Node::Nil)
        }
    }
}

/// The files attached to an email, from a FETCH answer with its BODYSTRUCTURE.
fn attached_files(unit: &[Part]) -> Vec<Attached> {
    let toks = tokens(unit);
    let Some(at) = toks.iter().position(|t| matches!(t, Tok::Word(w) if w.eq_ignore_ascii_case("BODYSTRUCTURE"))) else {
        return Vec::new();
    };
    let mut i = at + 1;
    let mut out = Vec::new();
    if let Some(tree) = node(&toks, &mut i, 0) {
        walk(&tree, "", &mut out, 0);
    }
    out
}

/// The attachments in a part (RFC 3501's body): each part of a multipart in turn, else the part itself.
fn walk(part: &Node, section: &str, out: &mut Vec<Attached>, depth: usize) {
    let Node::List(items) = part else { return };
    if depth > 12 {
        return;
    }
    if matches!(items.first(), Some(Node::List(_))) {
        for (n, child) in items.iter().take_while(|c| matches!(c, Node::List(_))).enumerate() {
            let at = if section.is_empty() { (n + 1).to_string() } else { format!("{section}.{}", n + 1) };
            walk(child, &at, out, depth + 1);
        }
        return;
    }
    let word = |i: usize| match items.get(i) {
        Some(Node::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let (kind, sub) = (word(0).to_ascii_lowercase(), word(1).to_ascii_lowercase());
    // After the size: a text part has its lines, an email its envelope, body and lines; then MD5, then the disposition.
    let ext = match (kind.as_str(), sub.as_str()) {
        ("text", _) => 8,
        ("message", "rfc822") => 10,
        _ => 7,
    };
    let (disposition, disposition_params) = match items.get(ext + 1) {
        Some(Node::List(d)) => (
            match d.first() {
                Some(Node::Str(s)) => s.to_ascii_lowercase(),
                _ => String::new(),
            },
            d.get(1),
        ),
        _ => (String::new(), None),
    };
    let name = param_of(disposition_params, "filename").or_else(|| param_of(items.get(2), "name"));
    // An attachment, or a named file not shown inside the text (an inline
    // PDF, as Apple Mail sends it); not the pictures of an HTML email.
    let attached = disposition == "attachment"
        || (disposition.is_empty() && name.is_some() && kind != "text")
        || (disposition == "inline" && name.is_some() && kind != "image" && kind != "text");
    if !attached {
        return;
    }
    let name = name.unwrap_or_else(|| if sub == "rfc822" { "email.eml".to_string() } else { format!("attachment-{}", out.len() + 1) });
    out.push(Attached {
        section: if section.is_empty() { "1".into() } else { section.to_string() },
        name,
        mime: format!("{kind}/{sub}"),
        encoding: word(5),
        size: word(6).parse().unwrap_or(0),
    });
}

/// A parameter of a part (`("name" "a.pdf" …)`): plain, RFC 2047 words, or
/// RFC 2231 (`filename*=UTF-8''…`, in pieces `filename*0*`, `filename*1`…).
fn param_of(params: Option<&Node>, key: &str) -> Option<String> {
    let Some(Node::List(items)) = params else { return None };
    let pairs: Vec<(String, &str)> = items
        .chunks(2)
        .filter_map(|p| match p {
            [Node::Str(k), Node::Str(v)] => Some((k.to_ascii_lowercase(), v.as_str())),
            _ => None,
        })
        .collect();
    let get = |k: &str| pairs.iter().find(|(name, _)| name == k).map(|(_, v)| *v);
    let text = if let Some(v) = get(key) {
        decode_words(v)
    } else if let Some(v) = get(&format!("{key}*")) {
        utf8_or_1252(&percent_decode(v.splitn(3, '\'').nth(2).unwrap_or(v)))
    } else {
        let mut bytes = Vec::new();
        for n in 0..64 {
            let (v, encoded) = match (get(&format!("{key}*{n}*")), get(&format!("{key}*{n}"))) {
                (Some(v), _) => (v, true),
                (None, Some(v)) => (v, false),
                _ => break,
            };
            // Only the first piece says its charset (`UTF-8''`).
            let v = if n == 0 && encoded { v.splitn(3, '\'').nth(2).unwrap_or(v) } else { v };
            bytes.extend(if encoded { percent_decode(v) } else { v.as_bytes().to_vec() });
        }
        if bytes.is_empty() {
            return None;
        }
        utf8_or_1252(&bytes)
    };
    let name = clean_header(&text);
    (!name.is_empty()).then_some(name)
}

/// `%E2%80%99` and the like, as bytes.
fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// The files attached to email `uid` of the open folder.
async fn structure(imap: &mut Imap, uid: u32) -> Result<Vec<Attached>, String> {
    let units = imap.run(&format!("UID FETCH {uid} (UID BODYSTRUCTURE)")).await?;
    Ok(units.iter().find(|u| matches!(u.first(), Some(Part::Text(l)) if l.contains(" FETCH "))).map(|u| attached_files(u)).unwrap_or_default())
}

/// One attached file of email `uid` of the open folder, its bytes decoded.
async fn attached_bytes(imap: &mut Imap, uid: u32, file: &Attached) -> Result<Vec<u8>, String> {
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
async fn save_attachment(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let (folder, uid) = parse_id(id).ok_or_else(|| bad_id(id))?;
    let (mut imap, host) = open(app).await?;
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
    Ok(format!("Saved {} ({}) with the files attached to the chat: {}. Read it from there.", saved.name, size_text(saved.size as usize), saved.path))
}

/// "120 KB", "3.4 MB".
fn size_text(bytes: usize) -> String {
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

/// What the AI is told of what Lumo lets it do with the email.
const CAN: &str = "Lumo reads the user's mailbox (the Email pill). It sends, moves, marks or trashes an email only through its email tools, when they are offered, and only once the user clicks on the email's card in Lumo; it never deletes one for good. ";

/// The newest emails, read or not, as the chat's provider reads them.
pub fn recent_text(found: &[Found], unread: Option<usize>) -> String {
    let mut out = String::from(CAN);
    if found.is_empty() {
        out.push_str("The inbox is empty.\n");
        return out;
    }
    out.push_str(&format!("Their {} newest emails, newest first, read or not", found.len()));
    if let Some(n) = unread {
        out.push_str(&format!(" ({n} unread in all)"));
    }
    out.push_str(":\n");
    out.push_str(&list_text(found, CHAT_BODY_CHARS));
    out.push_str("Answer questions about the user's email from this list. To reply, use mail_reply (or mail_send) if you have it, else write a draft for them to send themselves.\n");
    out
}

/// What a question about email brings to the chat: the newest emails read or
/// not, or, when the server is slow or says no, the unread ones last read.
pub async fn for_chat(app: &AppHandle) -> Option<String> {
    let cached = inbox();
    match tokio::time::timeout(CHAT_WAIT, newest(app, DEFAULT_COUNT, false, None)).await {
        Ok(Ok(found)) => Some(recent_text(&found, cached.map(|(n, _)| n))),
        Ok(Err(e)) => {
            log::line(format!("[mail] for the chat: {e}"));
            cached.map(|(n, m)| context_text(n, &m))
        }
        Err(_) => cached.map(|(n, m)| context_text(n, &m)),
    }
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
        return refuse("The user turned off the AI's access to their email in Lumo (Settings → General → Security).".into());
    }
    let tool = request.get("tool").and_then(|v| v.as_str()).unwrap_or("");
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    if SEND_TOOLS.contains(&tool) {
        if level == "read" {
            return refuse("The user lets the AI only read their email (Lumo's Settings → General → Security): write a draft for them to send instead.".into());
        }
        let done = match tool {
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
            return refuse("The user doesn't let the AI change their mailbox (Lumo's Settings → General → Security → Email): tell them what you would do instead.".into());
        }
        return match manage(app, tool, &input).await {
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
            newest(app, count, unread_only, folder).await.map(|found| {
                if found.is_empty() {
                    if unread_only { format!("No unread email in {place}.") } else { format!("No email in {place}.") }
                } else {
                    format!("{} newest emails in {place}, newest first:\n{}", found.len(), list_text(&found, LIST_CHARS))
                }
            })
        }
        "mail_search" => {
            let query = input.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            search(app, &query, count, folder).await.map(|found| {
                if found.is_empty() {
                    format!("No email matches {query}.")
                } else {
                    format!("{} emails match, newest first:\n{}", found.len(), list_text(&found, LIST_CHARS))
                }
            })
        }
        "mail_read" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            read(app, &id).await.map(|(f, files)| {
                let m = &f.message;
                let state = if f.unread { "unread" } else { "read" };
                let mut text = format!("From: {} <{}>\nDate: {}\nSubject: {}\nState: {state}\n", m.from, m.address, m.date, m.subject);
                if let Some(link) = &m.link {
                    text.push_str(&format!("Link: {link}\n"));
                }
                if !files.is_empty() {
                    text.push_str("Files attached (mail_attachment saves one where you can read it):\n");
                    for (n, file) in files.iter().enumerate() {
                        text.push_str(&format!("  {}. {} ({}, {})\n", n + 1, file.name, file.mime, size_text(file.file_size())));
                    }
                }
                text.push('\n');
                text.push_str(if m.body.trim().is_empty() { &m.preview } else { &m.body });
                text
            })
        }
        "mail_folders" => folders(app).await,
        "mail_attachment" => save_attachment(app, &input).await,
        _ => Err(format!("Lumo has no email tool called {tool}.")),
    };
    match answer {
        Ok(text) => json!({ "text": text }),
        Err(e) => refuse(e),
    }
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

fn too_heavy() -> String {
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
async fn send(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let (mail, paths) = outgoing(input)?;
    let files = card_files(&mail, &paths);
    deliver(app, "mail_send", mail, files).await
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
/// and sent only once the user clicks Send. Then a copy in Sent, where the
/// server keeps none itself.
async fn deliver(app: &AppHandle, tool: &str, mail: crate::smtp::Outgoing, files: Vec<serde_json::Value>) -> Result<String, String> {
    let names: Vec<&str> = mail.attachments.iter().map(|f| f.name.as_str()).collect();
    let from = secrets::get(ADDRESS_KEY).ok_or_else(|| NO_ACCOUNT.to_string())?;
    let card = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "tool_name": format!("mcp__lumo__{tool}"),
        "tool_input": { "to": mail.to, "cc": mail.cc, "subject": mail.subject, "attachments": names },
        "lumo_mail_send": { "from": from, "to": mail.to, "cc": mail.cc, "subject": mail.subject, "body": mail.body, "attachments": files },
    });
    match crate::pipe::ask(app, card).await.as_deref() {
        Some("allow") => {}
        Some(_) => return Err("The user discarded the email: it was not sent. Ask them what to change if they want it sent.".into()),
        None => return Err("Lumo couldn't show the email to the user (the island is paused or busy): it was not sent.".into()),
    }
    let sent = crate::smtp::send(&mail).await.inspect_err(|e| log::line(format!("[mail] send: {e}")))?;
    log::line(format!("[mail] sent through {} to {} people", sent.host, mail.to.len() + mail.cc.len()));
    keep_copy(app, sent);
    Ok(format!("Sent to {}.", mail.to.iter().chain(&mail.cc).cloned().collect::<Vec<_>>().join(", ")))
}

/// How long after sending Lumo looks in Sent for the server's own copy.
const SENT_COPY_AFTER: Duration = Duration::from_secs(10);

/// Gmail keeps in Sent what it sends, and so do most servers; for one that
/// didn't, a copy goes there over IMAP, a little later, once.
fn keep_copy(app: &AppHandle, sent: crate::smtp::Sent) {
    let address = secrets::get(ADDRESS_KEY).unwrap_or_default();
    let (host, _) = server_of(&secrets::get(SERVER_KEY).unwrap_or_default(), &address);
    if is_gmail(&host) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SENT_COPY_AFTER).await;
        match sent_copy(&app, &sent).await {
            Ok(true) => log::line("[mail] a copy of the email sent put in Sent"),
            Ok(false) => {}
            Err(e) => log::line(format!("[mail] no copy in Sent: {e}")),
        }
    });
}

/// Puts the email sent in Sent, unless the server already did. Whether it did.
async fn sent_copy(app: &AppHandle, sent: &crate::smtp::Sent) -> Result<bool, String> {
    let (mut imap, host) = open(app).await?;
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
    let (mut quoted, mut angle) = (false, false);
    for c in decode_words(raw).chars() {
        match c {
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
async fn fetch_original(app: &AppHandle, id: &str, with_files: bool) -> Result<(Original, Vec<crate::smtp::Attachment>), String> {
    let (folder, uid) = parse_id(id).ok_or_else(|| bad_id(id))?;
    let (mut imap, host) = open(app).await?;
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
            for file in structure(&mut imap, uid).await?.iter().take(crate::smtp::MAX_ATTACHMENTS) {
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
    got
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
async fn reply(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (_, body) = subject_and_body(input)?;
    let all = input.get("reply_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let more_cc = addresses(input.get("cc"), "cc")?;
    let (files, paths): (Vec<_>, Vec<_>) = attachments(input.get("attachments"))?.into_iter().unzip();
    let me = secrets::get(ADDRESS_KEY).ok_or_else(|| NO_ACCOUNT.to_string())?;
    let (original, _) = fetch_original(app, &id, false).await?;
    let (to, mut cc) = reply_people(&original, &me, all);
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
    deliver(app, "mail_reply", mail, files).await
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
async fn forward(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
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
    let (original, files) = fetch_original(app, &id, with_files).await?;
    let mail = crate::smtp::Outgoing {
        to,
        cc,
        subject: fwd_subject(&original.subject),
        body: forwarded_text(note, &original),
        attachments: files,
        ..Default::default()
    };
    let files = card_files(&mail, &[]);
    deliver(app, "mail_forward", mail, files).await
}

/// `mail_draft`: an email saved in the mailbox's Drafts (IMAP APPEND), for the
/// user to finish and send themselves. Nothing is sent. With `reply_to`, a
/// reply to that email, in its conversation.
async fn draft(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let (mut mail, _) = outgoing_for(input, false)?;
    if let Some(id) = input.get("reply_to").and_then(|v| v.as_str()).filter(|i| !i.trim().is_empty()) {
        let me = secrets::get(ADDRESS_KEY).ok_or_else(|| NO_ACCOUNT.to_string())?;
        let (original, _) = fetch_original(app, id, false).await?;
        if mail.to.is_empty() {
            mail.to = reply_people(&original, &me, false).0;
        }
        if mail.subject.is_empty() {
            mail.subject = re_subject(&original.subject);
        }
        mail.body = format!("{}{}", mail.body.trim_end(), quoted_text(&original));
        mail.in_reply_to = Some(original.message_id.clone()).filter(|m| !m.is_empty());
        mail.references = Some(thread_of(&original)).filter(|r| !r.is_empty());
    }
    let from = secrets::get(ADDRESS_KEY).ok_or_else(|| NO_ACCOUNT.to_string())?;
    let (left, secs) = crate::smtp::new_id();
    let data = crate::smtp::message(&from, &mail, secs, &left);
    let (mut imap, host) = open(app).await?;
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
    let (folder, uid) = parse_id(&id).ok_or_else(|| bad_id(&id))?;
    let (mut imap, host) = open(app).await?;
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
    let (mut imap, host) = open(app).await?;
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

fn uid_of(id: &str) -> Option<u32> {
    id.rsplit(':').next()?.parse().ok()
}

/// The server the user typed ("imap.example.com" or "imap.example.com:993"),
/// or the usual one for the address's provider.
pub fn server_of(typed: &str, address: &str) -> (String, u16) {
    let typed = typed.trim().trim_start_matches("imaps://").trim_end_matches('/');
    if !typed.is_empty() {
        if let Some((host, port)) = typed.rsplit_once(':') {
            if let Ok(port) = port.parse::<u16>() {
                return (host.to_ascii_lowercase(), port);
            }
        }
        return (typed.to_ascii_lowercase(), 993);
    }
    let domain = address.rsplit('@').next().unwrap_or("").trim().to_ascii_lowercase();
    let host = match domain.as_str() {
        "gmail.com" | "googlemail.com" => "imap.gmail.com".to_string(),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.it" | "hotmail.it" | "live.it" => {
            "outlook.office365.com".to_string()
        }
        "icloud.com" | "me.com" | "mac.com" => "imap.mail.me.com".to_string(),
        "yahoo.com" | "yahoo.it" | "ymail.com" => "imap.mail.yahoo.com".to_string(),
        "libero.it" => "imapmail.libero.it".to_string(),
        "aol.com" => "imap.aol.com".to_string(),
        d => format!("imap.{d}"),
    };
    (host, 993)
}

fn is_gmail(host: &str) -> bool {
    host.ends_with("gmail.com") || host.ends_with("googlemail.com")
}

fn inbox_link(host: &str) -> Option<String> {
    if is_gmail(host) {
        Some("https://mail.google.com/mail/u/0/#inbox".into())
    } else if host.contains("office365") || host.contains("outlook") {
        Some("https://outlook.live.com/mail/0/inbox".into())
    } else {
        None
    }
}

fn message_link(host: &str, message_id: &str) -> Option<String> {
    let id = message_id.trim().trim_start_matches('<').trim_end_matches('>');
    if !is_gmail(host) || id.is_empty() {
        return inbox_link(host);
    }
    let encoded: String = id
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    Some(format!("https://mail.google.com/mail/u/0/#search/rfc822msgid%3A{encoded}"))
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

/// A piece of an answer: the text of a line, or a literal (`{n}` bytes) inside it.
#[derive(Debug, Clone, PartialEq)]
enum Part {
    Text(String),
    Literal(Vec<u8>),
}

struct Imap {
    stream: BufReader<TlsStream<TcpStream>>,
    tag: u32,
    read: usize,
    /// What may be read before `read` is reset: MAX_READ, more for a file attached.
    limit: usize,
    capabilities: Vec<String>,
}

pub(crate) fn tls() -> Result<Arc<ClientConfig>, String> {
    let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

impl Imap {
    async fn connect(host: &str, port: u16) -> Result<Self, String> {
        let unreachable = |_| tf("Can't reach {server}.", &[("server", host)]);
        let tcp = TcpStream::connect((host, port)).await.map_err(unreachable)?;
        let name = ServerName::try_from(host.to_string()).map_err(|_| tf("Not a valid address: {address}", &[("address", host)]))?;
        let stream = TlsConnector::from(tls()?)
            .connect(name, tcp)
            .await
            .map_err(|e| tf("No secure connection to {server}: {error}", &[("server", host), ("error", &e.to_string())]))?;
        let mut imap = Imap { stream: BufReader::new(stream), tag: 0, read: 0, limit: MAX_READ, capabilities: Vec::new() };
        // The greeting.
        let greeting = imap.read_unit().await?;
        match greeting.first() {
            Some(Part::Text(line)) if line.starts_with("* OK") || line.starts_with("* PREAUTH") => Ok(imap),
            _ => Err(tf("{server} is not an IMAP server.", &[("server", host)])),
        }
    }

    /// One line from the server, with the literals it announces.
    async fn read_unit(&mut self) -> Result<Vec<Part>, String> {
        let mut parts = Vec::new();
        loop {
            let mut line = Vec::new();
            let n = self.stream.read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(t("The mail server closed the connection."));
            }
            self.count(n)?;
            let text = String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string();
            let literal = literal_size(&text);
            parts.push(Part::Text(text));
            let Some(size) = literal else { return Ok(parts) };
            self.count(size)?;
            let mut bytes = vec![0u8; size];
            self.stream.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
            parts.push(Part::Literal(bytes));
        }
    }

    fn count(&mut self, n: usize) -> Result<(), String> {
        self.read += n;
        if self.read > self.limit {
            return Err(t("The mail server sent too much."));
        }
        Ok(())
    }

    /// Sends a command; the untagged answers, or why the server said no.
    async fn run(&mut self, command: &str) -> Result<Vec<Vec<Part>>, String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        let line = format!("{tag} {command}\r\n");
        let stream = self.stream.get_mut();
        stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())?;
        let mut untagged = Vec::new();
        loop {
            let unit = self.read_unit().await?;
            let Some(Part::Text(first)) = unit.first() else { continue };
            if let Some(rest) = first.strip_prefix(&format!("{tag} ")) {
                if rest.starts_with("OK") {
                    return Ok(untagged);
                }
                return Err(rest.split_once(' ').map_or(rest, |x| x.1).trim().to_string());
            }
            untagged.push(unit);
        }
    }
}

impl Imap {
    /// `run`, with a string sent as a literal after the command: the
    /// server's "+" first, then its bytes.
    async fn run_literal(&mut self, command: &str, literal: &str) -> Result<Vec<Vec<Part>>, String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        self.send(&format!("{tag} {command} {{{}}}\r\n", literal.len())).await?;
        loop {
            let unit = self.read_unit().await?;
            match unit.first() {
                Some(Part::Text(line)) if line.starts_with('+') => break,
                Some(Part::Text(line)) if line.starts_with(&format!("{tag} ")) => {
                    let rest = &line[tag.len() + 1..];
                    return Err(rest.split_once(' ').map_or(rest, |x| x.1).trim().to_string());
                }
                _ => {}
            }
        }
        self.send(&format!("{literal}\r\n")).await?;
        let mut untagged = Vec::new();
        loop {
            let unit = self.read_unit().await?;
            let Some(Part::Text(first)) = unit.first() else { continue };
            if let Some(rest) = first.strip_prefix(&format!("{tag} ")) {
                if rest.starts_with("OK") {
                    return Ok(untagged);
                }
                return Err(rest.split_once(' ').map_or(rest, |x| x.1).trim().to_string());
            }
            untagged.push(unit);
        }
    }

    async fn send(&mut self, line: &str) -> Result<(), String> {
        let stream = self.stream.get_mut();
        stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())
    }

    /// Waits in IDLE until the server says the mailbox changed, Lumo is
    /// woken, or idle_for() goes by; then ends the IDLE.
    async fn idle(&mut self, host: &str) -> Result<(), String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        self.send(&format!("{tag} IDLE\r\n")).await?;
        timed_for(IDLE_ANSWER, host, self.idling(&tag)).await?;
        let deadline = tokio::time::Instant::now() + idle_for();
        loop {
            // The server speaks, or the time is up, or Lumo is woken.
            let wait = tokio::time::timeout_at(deadline, WAKE.notified());
            let changed = match first_of(self.read_unit(), wait).await {
                First::A(unit) => {
                    let unit = unit?;
                    matches!(unit.first(), Some(Part::Text(line)) if line.starts_with("* ") && (line.ends_with("EXISTS") || line.ends_with("EXPUNGE") || line.contains(" FETCH ")))
                }
                First::B(_) => true,
            };
            self.read = 0;
            if changed {
                break;
            }
        }
        self.send("DONE\r\n").await?;
        timed_for(IDLE_ANSWER, host, self.done(&tag)).await
    }

    /// The server's "+ idling".
    async fn idling(&mut self, tag: &str) -> Result<(), String> {
        loop {
            let unit = self.read_unit().await?;
            match unit.first() {
                Some(Part::Text(line)) if line.starts_with('+') => return Ok(()),
                Some(Part::Text(line)) if line.starts_with(&format!("{tag} ")) => {
                    return Err(line[tag.len() + 1..].trim().to_string());
                }
                _ => {}
            }
        }
    }

    /// The IDLE's own answer, after DONE.
    async fn done(&mut self, tag: &str) -> Result<(), String> {
        loop {
            let unit = self.read_unit().await?;
            if let Some(Part::Text(line)) = unit.first() {
                if let Some(rest) = line.strip_prefix(&format!("{tag} ")) {
                    return if rest.starts_with("OK") { Ok(()) } else { Err(rest.trim().to_string()) };
                }
            }
        }
    }
}

enum First<A, B> {
    A(A),
    B(B),
}

/// Whichever of two futures is ready first; the other is dropped.
async fn first_of<A: std::future::Future, B: std::future::Future>(a: A, b: B) -> First<A::Output, B::Output> {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    std::future::poll_fn(|cx| {
        if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) {
            return std::task::Poll::Ready(First::A(v));
        }
        if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) {
            return std::task::Poll::Ready(First::B(v));
        }
        std::task::Poll::Pending
    })
    .await
}

/// `{123}` at the end of a line announces 123 bytes that follow it.
fn literal_size(line: &str) -> Option<usize> {
    let open = line.strip_suffix('}')?.rfind('{')?;
    line[open + 1..line.len() - 1].trim_end_matches('+').parse().ok()
}

/// A string as IMAP takes it: quoted, with `\` and `"` escaped.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Connected, signed in, the inbox open read only.
async fn sign_in(host: &str, port: u16, address: &str, password: &str) -> Result<Imap, String> {
    let mut imap = Imap::connect(host, port).await?;
    // App passwords are shown with spaces ("abcd efgh ijkl mnop"); Google takes them either way.
    imap.run(&format!("LOGIN {} {}", quoted(address.trim()), quoted(password.trim())))
        .await
        .map_err(|why| sign_in_error(host, &why))?;
    let caps = imap.run("CAPABILITY").await?;
    imap.capabilities = caps
        .iter()
        .filter_map(|u| match u.first() {
            Some(Part::Text(line)) => line.strip_prefix("* CAPABILITY"),
            _ => None,
        })
        .flat_map(|rest| rest.split_whitespace().map(str::to_ascii_uppercase).collect::<Vec<_>>())
        .collect();
    imap.run("EXAMINE INBOX").await?;
    Ok(imap)
}

/// Why the server refused, in words: the usual cases said plainly.
fn sign_in_error(host: &str, why: &str) -> String {
    let lower = why.to_ascii_lowercase();
    if lower.contains("application-specific password") || lower.contains("app password") {
        return t("Gmail wants an app password here, not your account's password. Create one at myaccount.google.com/apppasswords (it needs 2-Step Verification) and paste it in Settings → Email.");
    }
    if lower.contains("authenticationfailed") || lower.contains("invalid credentials") || lower.contains("login failed") {
        return t("The address or the app password is wrong.");
    }
    // "[ALERT] … https://… (Failure)": the words, without the code and the address.
    let words: Vec<&str> = why
        .split_whitespace()
        .filter(|w| !w.starts_with('[') && !w.starts_with("http") && *w != "(Failure)")
        .collect();
    tf("{server} refused to sign in: {error}", &[("server", host), ("error", words.join(" ").trim_end_matches(':'))])
}

/// Settings → Pills → Email: the promotional emails are left out.
fn hides_promotions(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| shared.settings.lock().unwrap().mail_hide_promotions)
        .unwrap_or(false)
}

/// The search for the unread emails: all of them, or without the promotional
/// ones — on Gmail its own Promotions category, elsewhere the emails that carry
/// an unsubscribe link (List-Unsubscribe, RFC 2369: newsletters and offers).
fn unseen_search(host: &str, hide_promotions: bool) -> &'static str {
    if !hide_promotions {
        "UID SEARCH UNSEEN"
    } else if is_gmail(host) {
        "UID SEARCH UNSEEN X-GM-RAW \"-category:promotions\""
    } else {
        "UID SEARCH UNSEEN NOT HEADER List-Unsubscribe \"\""
    }
}

/// The unread count and the newest unread emails; `known` keeps the ones
/// already fetched on this connection, so only new ones are asked for.
async fn look(
    imap: &mut Imap,
    host: &str,
    hide_promotions: bool,
    known: &mut std::collections::HashMap<u32, Message>,
) -> Result<(usize, Vec<Message>), String> {
    let search = unseen_search(host, hide_promotions);
    let found = match imap.run(search).await {
        Ok(found) => found,
        // A server that cannot filter so still lists every unread email.
        Err(why) if search != "UID SEARCH UNSEEN" => {
            log::line(format!("[mail] {host} cannot leave out the promotions: {why}"));
            imap.run("UID SEARCH UNSEEN").await?
        }
        Err(why) => return Err(why),
    };
    let mut uids = search_uids(&found);
    let unread = uids.len();
    uids.sort_unstable();
    let newest: Vec<u32> = uids.iter().rev().take(FETCH).copied().collect();
    known.retain(|uid, _| newest.contains(uid));
    let missing: Vec<u32> = newest.iter().copied().filter(|u| !known.contains_key(u)).collect();
    if !missing.is_empty() {
        let set = missing.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched = imap
            .run(&format!(
                "UID FETCH {set} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.{BODY_BYTES}>)"
            ))
            .await?;
        for unit in &fetched {
            if let Some(m) = parse_fetch(unit, host) {
                if let Some(uid) = uid_of(&m.id) {
                    known.insert(uid, m);
                }
            }
        }
    }
    let mut messages: Vec<Message> = newest.iter().filter_map(|u| known.get(u).cloned()).collect();
    messages.sort_by_key(|m| std::cmp::Reverse(uid_of(&m.id).unwrap_or(0)));
    Ok((unread, messages))
}

fn search_uids(units: &[Vec<Part>]) -> Vec<u32> {
    units
        .iter()
        .filter_map(|u| match u.first() {
            Some(Part::Text(line)) => line.strip_prefix("* SEARCH"),
            _ => None,
        })
        .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()).collect::<Vec<u32>>())
        .collect()
}

fn parse_fetch(unit: &[Part], host: &str) -> Option<Message> {
    let Some(Part::Text(first)) = unit.first() else { return None };
    if !first.starts_with("* ") || !first.contains(" FETCH ") {
        return None;
    }
    let text: String = unit
        .iter()
        .filter_map(|p| match p {
            Part::Text(s) => Some(s.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let uid = text
        .split("UID ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse::<u32>().ok())?;
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
    let headers = parse_headers(header);
    let field = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).unwrap_or("");
    let (from, address) = parse_from(&decode_words(field("From")));
    let from = clean_header(&from);
    let subject = clean_header(&decode_words(field("Subject")));
    let content = extract_text(field("Content-Type"), field("Content-Transfer-Encoding"), body);
    let clean = tidy(&content);
    Some(Message {
        id: format!("{host}:{uid}"),
        from,
        address,
        subject: subject.trim().to_string(),
        preview: preview(&clean),
        body: clean.chars().take(BODY_CHARS).collect(),
        date: field("Date").trim().to_string(),
        link: message_link(host, field("Message-ID")),
    })
}

// ── Messages ──────────────────────────────────────────────────────────────────

/// "Name: value" pairs, folded lines unfolded.
fn parse_headers(raw: &[u8]) -> Vec<(String, String)> {
    let text = header_text(raw);
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.starts_with([' ', '\t']) {
            if let Some(last) = out.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    out
}

/// `"Ada Lovelace" <ada@example.com>` → ("Ada Lovelace", "ada@example.com").
fn parse_from(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if let (Some(open), Some(close)) = (raw.rfind('<'), raw.rfind('>')) {
        if open < close {
            let address = raw[open + 1..close].trim().to_string();
            let name = raw[..open].trim().trim_matches('"').trim().to_string();
            let name = if name.is_empty() { address.clone() } else { name };
            return (name, address);
        }
    }
    (raw.to_string(), raw.to_string())
}

/// RFC 2047 words (`=?UTF-8?B?…?=`) in a header, decoded; the space between
/// two of them goes. Adjacent words in the same charset are joined before they
/// are read: senders split a character's bytes across two words ("McDonald=E2"
/// "=80=99s"), which read one by one would come out as "McDonaldâ€™s".
pub fn decode_words(raw: &str) -> String {
    fn flush(out: &mut String, pending: &mut Option<(String, Vec<u8>)>) {
        if let Some((charset, bytes)) = pending.take() {
            out.push_str(&in_charset(&bytes, &charset));
        }
    }
    let mut out = String::new();
    let mut pending: Option<(String, Vec<u8>)> = None;
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        let (plain, tail) = rest.split_at(start);
        match decode_word(tail) {
            Some((charset, bytes, used)) => {
                let next_to_last = pending.is_some() && plain.trim().is_empty();
                match pending.as_mut() {
                    Some((cs, held)) if next_to_last && cs.eq_ignore_ascii_case(&charset) => held.extend(bytes),
                    _ => {
                        flush(&mut out, &mut pending);
                        if !next_to_last {
                            out.push_str(plain);
                        }
                        pending = Some((charset, bytes));
                    }
                }
                rest = &tail[used..];
            }
            None => {
                flush(&mut out, &mut pending);
                out.push_str(plain);
                out.push_str("=?");
                rest = &tail[2..];
            }
        }
    }
    flush(&mut out, &mut pending);
    out.push_str(rest);
    out
}

/// One encoded word at the start of `s`: its charset, its bytes and how many
/// bytes of `s` it took.
fn decode_word(s: &str) -> Option<(String, Vec<u8>, usize)> {
    let inner = s.strip_prefix("=?")?;
    let (charset, inner) = inner.split_once('?')?;
    let (encoding, inner) = inner.split_once('?')?;
    if charset.is_empty() || charset.contains(char::is_whitespace) {
        return None;
    }
    let end = inner.find("?=")?;
    let payload = &inner[..end];
    let bytes = match encoding.to_ascii_uppercase().as_str() {
        "B" => base64(payload.as_bytes()),
        "Q" => quoted_printable(payload.replace('_', " ").as_bytes()),
        _ => return None,
    };
    let used = 2 + charset.len() + 1 + encoding.len() + 1 + end + 2;
    Some((charset.to_string(), bytes, used))
}

/// Bytes in the given charset, as text. UTF-16 is read as such; anything else
/// as UTF-8 where the bytes are UTF-8 and as Windows-1252 (Latin-1 with the
/// curly quotes) where they are not, byte by byte, so one stray byte does not
/// spoil the rest. Text that was UTF-8 read as Windows-1252 on its way here
/// ("â€™") is put back.
fn in_charset(bytes: &[u8], charset: &str) -> String {
    let cs = charset.trim().trim_matches('"').to_ascii_lowercase();
    let cs = cs.split('*').next().unwrap_or(&cs);
    let text = match cs {
        "utf-16" | "utf16" | "ucs-2" => utf16(bytes, false),
        "utf-16be" | "unicodefffe" => utf16(bytes, false),
        "utf-16le" | "unicode" => utf16(bytes, true),
        "iso-8859-15" | "iso8859-15" | "latin9" if std::str::from_utf8(bytes).is_err() => {
            bytes.iter().map(|&b| if b == 0xA4 { '€' } else { cp1252(b) }).collect()
        }
        _ => utf8_or_1252(bytes),
    };
    repair(&text)
}

/// Valid UTF-8 runs as UTF-8, every other byte as Windows-1252.
fn utf8_or_1252(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                return out;
            }
            Err(e) => {
                let good = e.valid_up_to();
                out.push_str(std::str::from_utf8(&rest[..good]).unwrap_or_default());
                out.push(cp1252(rest[good]));
                rest = &rest[good + 1..];
            }
        }
    }
}

/// UTF-16, its byte order from the BOM, else `little_endian`.
fn utf16(bytes: &[u8], little_endian: bool) -> String {
    let (le, body) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (true, rest),
        [0xFE, 0xFF, rest @ ..] => (false, rest),
        _ => (little_endian, bytes),
    };
    let units: Vec<u16> = body
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| if le { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// UTF-8 that was read as Windows-1252 somewhere before ("McDonaldâ€™s",
/// "CaffÃ¨"), read again as UTF-8, word by word. A word that is not such a
/// mix-up stays as is: put back into Windows-1252 bytes it is not valid UTF-8
/// ("Caffè"), or it holds what Windows-1252 has not (an emoji).
fn repair(text: &str) -> String {
    if text.is_ascii() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let fix = |word: &str, out: &mut String| {
        let bytes: Option<Vec<u8>> = if word.is_ascii() { None } else { word.chars().map(to_cp1252).collect() };
        match bytes.map(String::from_utf8) {
            Some(Ok(fixed)) if !fixed.is_ascii() => out.push_str(&fixed),
            _ => out.push_str(word),
        }
    };
    for c in text.chars() {
        if c.is_whitespace() {
            fix(&word, &mut out);
            word.clear();
            out.push(c);
        } else {
            word.push(c);
        }
    }
    fix(&word, &mut out);
    out
}

/// One Windows-1252 byte as a character: Latin-1, with the curly quotes,
/// dashes, the euro and the rest in 0x80–0x9F.
fn cp1252(b: u8) -> char {
    if (0x80..0xA0).contains(&b) { CP1252_HIGH[(b - 0x80) as usize] } else { b as char }
}

/// The byte a character is in Windows-1252, if it is there.
fn to_cp1252(c: char) -> Option<u8> {
    let code = c as u32;
    if code < 0x80 || (0xA0..=0xFF).contains(&code) {
        return Some(code as u8);
    }
    CP1252_HIGH.iter().position(|&h| h == c && !('\u{80}'..'\u{A0}').contains(&h)).map(|i| 0x80 + i as u8)
}

const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž', '\u{8F}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}', 'ž', 'Ÿ',
];

/// A sender's name or a subject, ready to show: entities read (`&amp;`,
/// `&rsquo;`), control characters of Windows-1252 that came as numbers
/// (`&#146;`) read as the characters they stand for, and the apostrophe some
/// mailers turn into "ÿ" between two letters ("McDonaldÿs") put back.
fn clean_header(text: &str) -> String {
    let text = repair(&entities(text));
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        let letter = |j: Option<usize>| j.and_then(|j| chars.get(j)).is_some_and(|c| c.is_ascii_alphabetic());
        match c {
            '\u{80}'..='\u{9F}' => out.push(cp1252(c as u8)),
            'ÿ' if letter(i.checked_sub(1)) && letter(Some(i + 1)) => out.push('’'),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Header bytes as text: UTF-8 when they are, else Windows-1252.
fn header_text(raw: &[u8]) -> String {
    in_charset(raw, "")
}

/// Base64, spaces and line breaks ignored; a cut-off end is dropped.
pub fn base64(input: &[u8]) -> Vec<u8> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in input {
        if c == b'=' {
            break;
        }
        let Some(v) = value(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

pub fn quoted_printable(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let c = input[i];
        if c == b'=' {
            // A soft line break.
            if input.get(i + 1) == Some(&b'\r') && input.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
            if input.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            let hex = input.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// A Content-Type's type and parameters: ("multipart/alternative", [("boundary", "x")]).
fn content_type(raw: &str) -> (String, Vec<(String, String)>) {
    let mut pieces = raw.split(';');
    let kind = pieces.next().unwrap_or("").trim().to_ascii_lowercase();
    let params = pieces
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().trim_matches('"').to_string()))
        .collect();
    (if kind.is_empty() { "text/plain".into() } else { kind }, params)
}

fn param<'a>(params: &'a [(String, String)], name: &str) -> &'a str {
    params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()).unwrap_or("")
}

fn decode_body(encoding: &str, bytes: &[u8]) -> Vec<u8> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "base64" => base64(bytes),
        "quoted-printable" => quoted_printable(bytes),
        _ => bytes.to_vec(),
    }
}

/// The readable text of a message (or one of its parts): the plain text when
/// there is one, else the HTML without its tags.
pub fn extract_text(ctype: &str, encoding: &str, body: &[u8]) -> String {
    extract(ctype, encoding, body, 0).map(|(text, _)| text).unwrap_or_default()
}

/// The text, and whether it is plain (preferred over HTML).
fn extract(ctype: &str, encoding: &str, body: &[u8], depth: usize) -> Option<(String, bool)> {
    let (kind, params) = content_type(ctype);
    if kind.starts_with("multipart/") && depth < 6 {
        let boundary = param(&params, "boundary");
        if boundary.is_empty() {
            return None;
        }
        let mut html: Option<String> = None;
        for part in split_parts(body, boundary) {
            let (head, content) = split_head(part);
            let headers = parse_headers(head);
            let get = |n: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone()).unwrap_or_default();
            if get("Content-Disposition").to_ascii_lowercase().starts_with("attachment") {
                continue;
            }
            match extract(&get("Content-Type"), &get("Content-Transfer-Encoding"), content, depth + 1) {
                Some((text, true)) if !text.trim().is_empty() => return Some((text, true)),
                Some((text, false)) if html.is_none() && !text.trim().is_empty() => html = Some(text),
                _ => {}
            }
        }
        return html.map(|h| (h, false));
    }
    let charset = param(&params, "charset");
    match kind.as_str() {
        "text/plain" => Some((in_charset(&decode_body(encoding, body), charset), true)),
        "text/html" => Some((strip_html(&in_charset(&decode_body(encoding, body), charset)), false)),
        _ => None,
    }
}

/// The parts between `--boundary` lines (the closing one may be cut off).
fn split_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let marker = format!("--{boundary}");
    let marker = marker.as_bytes();
    let mut starts = Vec::new();
    let mut i = 0;
    while i + marker.len() <= body.len() {
        if &body[i..i + marker.len()] == marker && (i == 0 || body[i - 1] == b'\n') {
            starts.push(i);
            i += marker.len();
        } else {
            i += 1;
        }
    }
    let mut parts = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        let after = start + marker.len();
        if body.get(after..after + 2) == Some(b"--") {
            break;
        }
        let end = starts.get(n + 1).copied().unwrap_or(body.len());
        let part = &body[after..end];
        let part = part.strip_prefix(b"\r\n").or_else(|| part.strip_prefix(b"\n")).unwrap_or(part);
        parts.push(part);
    }
    parts
}

/// A part's headers and its content, split at the first blank line.
fn split_head(part: &[u8]) -> (&[u8], &[u8]) {
    for (i, w) in part.windows(2).enumerate() {
        if w == b"\n\n" {
            return (&part[..i], &part[i + 2..]);
        }
        if w == b"\n\r" && part.get(i + 2) == Some(&b'\n') {
            return (&part[..i], &part[i + 3..]);
        }
    }
    (part, &[])
}

/// HTML as text: no styles, scripts or tags, the common entities read.
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            for skip in ["<style", "<script", "<head"] {
                if lower[i..].starts_with(skip) {
                    let close = format!("</{}", &skip[1..]);
                    i = lower[i..].find(&close).map(|e| i + e).unwrap_or(bytes.len());
                    break;
                }
            }
            if i >= bytes.len() {
                break;
            }
            let tag_end = html[i..].find('>').map(|e| i + e + 1).unwrap_or(bytes.len());
            let tag = &lower[i..tag_end];
            if tag.starts_with("<br") || tag.starts_with("<p") || tag.starts_with("</p") || tag.starts_with("<div") || tag.starts_with("</div") || tag.starts_with("<tr") || tag.starts_with("<li") {
                out.push('\n');
            }
            i = tag_end;
            continue;
        }
        let next = html[i..].find('<').map(|e| i + e).unwrap_or(bytes.len());
        out.push_str(&html[i..next]);
        i = next;
    }
    entities(&out)
}

/// `&rsquo;`, `&#8217;`, `&#x2019;` and the other common entities, read.
pub fn entities(text: &str) -> String {
    const NAMED: &[(&str, &str)] = &[
        ("nbsp", " "), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("amp", "&"),
        ("zwnj", ""), ("zwj", ""), ("shy", ""), ("lsquo", "‘"), ("rsquo", "’"), ("ldquo", "“"),
        ("rdquo", "”"), ("laquo", "«"), ("raquo", "»"), ("hellip", "…"), ("ndash", "–"), ("mdash", "—"),
        ("euro", "€"), ("pound", "£"), ("copy", "©"), ("reg", "®"), ("trade", "™"), ("deg", "°"),
        ("middot", "·"), ("bull", "•"), ("agrave", "à"), ("aacute", "á"), ("egrave", "è"),
        ("eacute", "é"), ("igrave", "ì"), ("iacute", "í"), ("ograve", "ò"), ("oacute", "ó"),
        ("ugrave", "ù"), ("uacute", "ú"), ("Agrave", "À"), ("Egrave", "È"), ("Eacute", "É"),
        ("ccedil", "ç"), ("ntilde", "ñ"), ("auml", "ä"), ("ouml", "ö"), ("uuml", "ü"), ("szlig", "ß"),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail[1..].find(|c: char| c == ';' || c.is_whitespace() || c == '&').map(|e| e + 1);
        let decoded = end.filter(|&e| tail.as_bytes().get(e) == Some(&b';') && e <= 12).and_then(|e| {
            let name = &tail[1..e];
            let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok()
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse::<u32>().ok()
            } else {
                None
            };
            let text = match code {
                // 128–159 are Windows-1252's, as browsers read them (`&#146;` is ’).
                Some(c @ 0x80..=0x9F) => Some(cp1252(c as u8).to_string()),
                Some(c) => char::from_u32(c).map(|ch| if ch == '\u{a0}' { " ".to_string() } else { ch.to_string() }),
                None => NAMED.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string()),
            };
            text.map(|t| (t, e + 1))
        });
        match decoded {
            Some((t, used)) => {
                out.push_str(&t);
                rest = &tail[used..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Lines trimmed, runs of blank lines down to one, quoted replies cut off.
fn tidy(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // What follows "On … wrote:" / "> …" is the conversation before.
        if line.starts_with('>') {
            break;
        }
        if line.is_empty() && out.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        out.push(line);
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out.join("\n")
}

fn preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PREVIEW_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(PREVIEW_CHARS).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ai_reads_the_email_unless_security_says_none() {
        assert_eq!(access(&Settings::default()), "read", "as before the setting");
        assert_eq!(access(&Settings { ai_mail_access: "none".into(), ..Settings::default() }), "none");
        assert_eq!(access(&Settings { ai_mail_access: "send".into(), ..Settings::default() }), "send");
        assert_eq!(access(&Settings { ai_mail_access: "manage".into(), ..Settings::default() }), "manage");
        assert_eq!(access(&Settings { ai_mail_access: "anything".into(), ..Settings::default() }), "read");
    }

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
    fn only_a_change_that_concerns_the_email_pill_wakes_it() {
        let before = Settings { active_integrations: vec![ID.to_string()], ..Settings::default() };
        assert!(!concerned(&before, &before.clone()));
        let mut other = before.clone();
        other.island_zoom += 0.1;
        other.autostart = !other.autostart;
        assert!(!concerned(&before, &other), "nothing of the pill's");
        let off = Settings { active_integrations: Vec::new(), ..before.clone() };
        assert!(concerned(&before, &off), "turned off");
        let filtered = Settings { mail_hide_promotions: !before.mail_hide_promotions, ..before.clone() };
        assert!(concerned(&before, &filtered), "its filter");
        let italian = Settings { language: "it".into(), ..before.clone() };
        assert!(concerned(&before, &italian), "its errors' language");
    }

    #[test]
    fn questions_about_email_bring_the_inbox() {
        assert!(asks_about("quali sono le ultime email?"));
        assert!(asks_about("Any new MAIL from Ada?"));
        assert!(asks_about("cosa c'è nella posta"));
        assert!(asks_about("leggi la mia e-mail"));
        assert!(!asks_about("what is Claude doing?"));
        // The inbox is the user's: a word that merely holds one of ours never brings it.
        assert!(!asks_about("fammi una proposta"));
        assert!(!asks_about("apri le impostazioni"));
        assert!(!asks_about("l'ho fatto apposta"));
    }

    #[test]
    fn the_inbox_reads_as_a_list_for_the_chat() {
        let m = Message {
            id: "a@x:4".into(), from: "Ada".into(), address: "ada@example.org".into(), subject: "Lunch".into(),
            preview: "Shall we".into(), body: "Shall we\n  meet at noon?".into(), date: "Wed, 14 Oct 2026 12:00".into(),
            link: None,
        };
        let text = context_text(5, std::slice::from_ref(&m));
        assert!(text.contains("1 of 5 unread"));
        assert!(text.contains("- From Ada <ada@example.org>, Wed, 14 Oct 2026 12:00: Lunch\n  Shall we meet at noon?\n"));
        let long = Message { body: "x".repeat(CHAT_BODY_CHARS + 10), ..m };
        assert!(context_text(1, &[long]).contains(&format!("{}…", "x".repeat(CHAT_BODY_CHARS))));
        assert!(context_text(0, &[]).contains("no unread email"));
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
        let text = list_text(&[unread.clone(), read.clone()], 100);
        assert!(text.contains("- [inbox:43] unread, from Ada <ada@example.org>, Wed, 14 Oct 2026 12:00: (no subject)\n"), "{text}");
        assert!(text.contains("- [inbox:42] read, from Ada"), "{text}");
        let chat = recent_text(&[unread, read], Some(3));
        assert!(chat.contains("2 newest emails, newest first, read or not (3 unread in all)"), "{chat}");
        assert!(!chat.contains("already read are not listed"));
        assert!(recent_text(&[], None).contains("inbox is empty"));
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
    fn the_files_attached_come_from_the_bodystructure() {
        // A text with its HTML, a PDF and a picture named in UTF-8 (RFC 2231), a picture inside the HTML.
        let line = concat!(
            r#"* 1 FETCH (UID 9 BODYSTRUCTURE ((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL)"#,
            r#"("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 40 2 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "b2") NIL NIL)"#,
            r#"("IMAGE" "PNG" ("NAME" "logo.png") "<logo>" NIL "BASE64" 400 NIL ("INLINE" ("FILENAME" "logo.png")) NIL)"#,
            r#"("APPLICATION" "PDF" ("NAME" "=?UTF-8?Q?Fattura_n=C2=B0_7.pdf?=") NIL NIL "BASE64" 1336 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?Q?Fattura_n=C2=B0_7.pdf?=")) NIL)"#,
            r#"("IMAGE" "JPEG" NIL NIL NIL "BASE64" 800 NIL ("attachment" ("filename*" "UTF-8''foto%20citt%C3%A0.jpg")) NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL))"#,
        );
        let files = attached_files(&[Part::Text(line.into())]);
        let names: Vec<(&str, &str, &str)> = files.iter().map(|f| (f.section.as_str(), f.name.as_str(), f.mime.as_str())).collect();
        assert_eq!(names, [("3", "Fattura n° 7.pdf", "application/pdf"), ("4", "foto città.jpg", "image/jpeg")]);
        assert_eq!(files[0].file_size(), 1002);
        // One part only, the whole email a PDF; a name that came as a literal.
        let single = [
            Part::Text(r#"* 2 FETCH (UID 3 BODYSTRUCTURE ("APPLICATION" "PDF" ("NAME" {5}"#.into()),
            Part::Literal(b"a.pdf".to_vec()),
            Part::Text(r#") NIL NIL "BASE64" 100 NIL NIL NIL))"#.into()),
        ];
        let one = attached_files(&single);
        assert_eq!((one[0].section.as_str(), one[0].name.as_str()), ("1", "a.pdf"));
        // RFC 2231 in pieces.
        let pieces = Node::List(["filename*0*", "UTF-8''Analisi%20", "filename*1", "2.pdf"].iter().map(|s| Node::Str(s.to_string())).collect());
        assert_eq!(param_of(Some(&pieces), "filename").as_deref(), Some("Analisi 2.pdf"));
        assert!(attached_files(&[Part::Text("* 1 FETCH (UID 9 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 1 1))".into())]).is_empty());
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

    #[test]
    fn the_server_comes_from_the_address_unless_typed() {
        assert_eq!(server_of("", "ada@gmail.com"), ("imap.gmail.com".into(), 993));
        assert_eq!(server_of("", "ada@outlook.it"), ("outlook.office365.com".into(), 993));
        assert_eq!(server_of("", "ada@example.org"), ("imap.example.org".into(), 993));
        assert_eq!(server_of("Mail.Example.org:1993", "ada@gmail.com"), ("mail.example.org".into(), 1993));
        assert_eq!(server_of("imaps://imap.example.org/", "x"), ("imap.example.org".into(), 993));
    }

    #[test]
    fn literals_are_announced_at_the_end_of_a_line() {
        assert_eq!(literal_size("* 1 FETCH (UID 4 BODY[TEXT]<0> {120}"), Some(120));
        assert_eq!(literal_size("* OK hello"), None);
        assert_eq!(literal_size("a {12+}"), Some(12));
    }

    #[test]
    fn a_failed_connection_is_tried_again_soon() {
        let secs: Vec<u64> = (1..=8).map(|f| retry_in(f).as_secs()).collect();
        assert_eq!(secs, [2, 5, 30, 60, 120, 240, 300, 300]);
        assert_eq!(retry_in(u32::MAX), RETRY_MOST);
    }

    #[test]
    fn the_emails_read_stay_until_a_few_failures_in_a_row() {
        assert!(!shows_error(1, true));
        assert!(!shows_error(2, true));
        assert!(shows_error(3, true));
        // Nothing read yet (a wrong password): shown at the second.
        assert!(!shows_error(1, false));
        assert!(shows_error(2, false));
    }

    #[test]
    fn promotions_are_left_out_only_when_asked() {
        assert_eq!(unseen_search("imap.gmail.com", false), "UID SEARCH UNSEEN");
        assert_eq!(unseen_search("imap.example.com", false), "UID SEARCH UNSEEN");
        assert_eq!(unseen_search("imap.gmail.com", true), r#"UID SEARCH UNSEEN X-GM-RAW "-category:promotions""#);
        assert_eq!(unseen_search("imap.example.com", true), r#"UID SEARCH UNSEEN NOT HEADER List-Unsubscribe """#);
    }

    #[test]
    fn imap_strings_are_quoted() {
        assert_eq!(quoted(r#"pa"ss\word"#), r#""pa\"ss\\word""#);
    }

    #[test]
    fn encoded_headers_are_read() {
        assert_eq!(decode_words("=?UTF-8?B?Q2lhbyDwn5GL?="), "Ciao 👋");
        assert_eq!(decode_words("=?ISO-8859-1?Q?Caf=E9_ouvert?= today"), "Café ouvert today");
        assert_eq!(decode_words("=?UTF-8?Q?a?= =?UTF-8?Q?b?="), "ab");
        assert_eq!(decode_words("Plain subject"), "Plain subject");
    }

    #[test]
    fn html_entities_are_read() {
        assert_eq!(entities("McDonald&rsquo;s &amp; co &#8217; &#x2019; &egrave; &unknown; 5 & 6"), "McDonald’s & co ’ ’ è &unknown; 5 & 6");
        assert_eq!(strip_html("<p>Caff&egrave;&nbsp;<b>pronto</b></p>").trim(), "Caffè pronto");
    }

    #[test]
    fn windows_1252_reads_as_it_should() {
        // "McDonald’s" with the curly apostrophe of Windows-1252, encoded or raw.
        assert_eq!(decode_words("=?windows-1252?Q?McDonald=92s_Italia?="), "McDonald’s Italia");
        assert_eq!(decode_words("=?ISO-8859-1?Q?McDonald=92s?="), "McDonald’s");
        assert_eq!(parse_headers(b"From: McDonald\x92s <a@b.c>\r\n")[0].1, "McDonald’s <a@b.c>");
        assert_eq!(in_charset(b"Prezzo 5\x80", "unknown-8bit"), "Prezzo 5€");
        assert_eq!(in_charset("Caffè".as_bytes(), "iso-8859-1"), "Caffè");
        assert_eq!(in_charset(b"\xA4 10", "iso-8859-15"), "€ 10");
    }

    #[test]
    fn real_senders_and_subjects_read_right() {
        let from = |raw: &str| clean_header(&parse_from(&decode_words(raw)).0);
        let subject = |raw: &str| clean_header(&decode_words(raw));
        // The curly apostrophe, in every way it comes.
        assert_eq!(from("=?UTF-8?Q?McDonald=E2=80=99s_Italia?= <news@mcdonalds.it>"), "McDonald’s Italia");
        assert_eq!(from("=?utf-8?B?TWNEb25hbGTigJlzIEl0YWxpYQ==?= <news@mcdonalds.it>"), "McDonald’s Italia");
        assert_eq!(from("\"=?UTF-8?Q?McDonald=E2=80=99s?= Italia\" <news@mcdonalds.it>"), "McDonald’s Italia");
        assert_eq!(from("=?windows-1252?Q?McDonald=92s_Italia?= <a@b.it>"), "McDonald’s Italia");
        // Its bytes split across two words, in Q or in B.
        assert_eq!(from("=?UTF-8?Q?McDonald=E2=80?= =?UTF-8?Q?=99s_Italia?= <a@b.it>"), "McDonald’s Italia");
        assert_eq!(from("=?UTF-8?B?TWNEb25hbGTi?=\r\n =?UTF-8?B?gJlzIEl0YWxpYQ==?= <a@b.it>"), "McDonald’s Italia");
        // UTF-8 read as Windows-1252 before it got here, and the "ÿ" some mailers leave.
        assert_eq!(from("McDonaldâ€™s Italia <a@b.it>"), "McDonald’s Italia");
        assert_eq!(from("McDonaldÿs Italia <a@b.it>"), "McDonald’s Italia");
        assert_eq!(subject("L&#146;offerta &amp; il regalo"), "L’offerta & il regalo");
        assert_eq!(subject("Aÿ, L'Haÿ-les-Roses"), "Aÿ, L'Haÿ-les-Roses");
        // Quotes, Italian accents and emoji.
        assert_eq!(subject("=?UTF-8?Q?=E2=80=9CSaldi=E2=80=9D_fino_al_50%_=E2=80=94_cos=C3=AC_=C3=A8_pi=C3=B9_facile?="), "“Saldi” fino al 50% — così è più facile");
        assert_eq!(subject("=?ISO-8859-1?Q?Perch=E9_s=EC=2C_citt=E0?="), "Perché sì, città");
        assert_eq!(subject("=?UTF-8?B?8J+OgSBVbiBwaWNjb2xvIHJlZ2FsbyBwZXIgdGUg8J+Ogg==?="), "🎁 Un piccolo regalo per te 🎂");
        assert_eq!(subject("=?utf-8?q?Huntr/x_o_Saja_Boys=3F?="), "Huntr/x o Saja Boys?");
        assert_eq!(subject("Re: =?UTF-8?Q?Caff=C3=A8?= domani"), "Re: Caffè domani");
        // UTF-16, rare but seen.
        assert_eq!(subject("=?UTF-16?B?/v8AQwBpAGEAbwAgIBk=?="), "Ciao ’");
        // A stray Latin-1 byte does not spoil the UTF-8 around it.
        assert_eq!(in_charset(b"Caff\xE8 \xE2\x80\x99", "utf-8"), "Caffè ’");
    }

    #[test]
    fn bodies_in_any_charset_read_right() {
        let qp = b"Content-Type: text/plain; charset=utf-8\r\n\r\nL=E2=80=99offerta =C3=A8 qui =F0=9F=8E=89";
        let (_, body) = split_head(qp);
        assert_eq!(extract_text("text/plain; charset=utf-8", "quoted-printable", body), "L’offerta è qui 🎉");
        assert_eq!(extract_text("text/plain; charset=\"windows-1252\"", "quoted-printable", b"Citt=E0 =96 l=92ora"), "Città – l’ora");
        assert_eq!(extract_text("text/html; charset=iso-8859-1", "", b"<p>Perch&eacute; l&#8217;ho &#146;detto&#148;</p>").trim(), "Perché l’ho ’detto”");
    }

    #[test]
    fn the_sender_is_split_into_name_and_address() {
        assert_eq!(parse_from("\"Ada Lovelace\" <ada@example.com>"), ("Ada Lovelace".into(), "ada@example.com".into()));
        assert_eq!(parse_from("<ada@example.com>"), ("ada@example.com".into(), "ada@example.com".into()));
        assert_eq!(parse_from("ada@example.com"), ("ada@example.com".into(), "ada@example.com".into()));
    }

    #[test]
    fn plain_text_is_preferred_and_decoded() {
        let body = b"--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>HTML</b></p>\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaff=C3=A8 alle 10?\r\n--b1--\r\n";
        assert_eq!(extract_text("multipart/alternative; boundary=\"b1\"", "", body).trim(), "Caffè alle 10?");
        let html_only = b"--x\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\nPHA+SGVsbG8gJmFtcDsgYnllPC9wPg==\r\n--x--";
        assert_eq!(extract_text("multipart/mixed; boundary=x", "", html_only).trim(), "Hello & bye");
    }

    #[test]
    fn nested_parts_and_cut_off_bodies_still_give_text() {
        let body = b"--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain\r\n\r\nInside\r\n--inner--\r\n--outer\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment\r\n\r\nJVBER";
        assert_eq!(extract_text("multipart/mixed; boundary=outer", "", body).trim(), "Inside");
        // Base64 cut in the middle of a group.
        assert_eq!(base64(b"SGVsbG8gd29y"), b"Hello wor");
        assert_eq!(base64(b"SGVsbG8gd29yb"), b"Hello wor");
    }

    #[test]
    fn quoted_replies_and_blank_runs_go() {
        assert_eq!(tidy("Hi\n\n\n  there \n> old\n> older"), "Hi\n\nthere");
    }

    #[test]
    fn a_fetch_answer_becomes_a_message() {
        let header = b"From: =?UTF-8?Q?Jos=C3=A9?= <jose@example.com>\r\nSubject: Lunch\r\nMessage-ID: <abc@mail.gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n".to_vec();
        let unit = vec![
            Part::Text("* 3 FETCH (UID 42 BODY[HEADER.FIELDS (FROM SUBJECT)] {10}".into()),
            Part::Literal(header),
            Part::Text(" BODY[TEXT]<0> {5}".into()),
            Part::Literal(b"Hey!\n".to_vec()),
            Part::Text(")".into()),
        ];
        let m = parse_fetch(&unit, "imap.gmail.com").unwrap();
        assert_eq!(m.id, "imap.gmail.com:42");
        assert_eq!(m.from, "José");
        assert_eq!(m.address, "jose@example.com");
        assert_eq!(m.subject, "Lunch");
        assert_eq!(m.preview, "Hey!");
        assert_eq!(m.link.as_deref(), Some("https://mail.google.com/mail/u/0/#search/rfc822msgid%3Aabc%40mail.gmail.com"));
        assert_eq!(uid_of(&m.id), Some(42));
    }

    #[test]
    fn a_refused_sign_in_says_what_to_do() {
        let gmail = "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)";
        assert!(sign_in_error("imap.gmail.com", gmail).contains("myaccount.google.com/apppasswords"));
        assert_eq!(sign_in_error("x", "[AUTHENTICATIONFAILED] Invalid credentials (Failure)"), "The address or the app password is wrong.");
        assert_eq!(
            sign_in_error("imap.example.org", "[UNAVAILABLE] Try later: https://example.org/status (Failure)"),
            "imap.example.org refused to sign in: Try later"
        );
    }

    #[test]
    fn search_answers_list_uids() {
        let units = vec![vec![Part::Text("* SEARCH 4 9 12".into())], vec![Part::Text("* OK".into())]];
        assert_eq!(search_uids(&units), vec![4, 9, 12]);
    }
}
