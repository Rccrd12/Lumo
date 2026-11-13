// The Email pill: new messages in the user's inbox, read over IMAP with an app
// password (Gmail, Outlook, iCloud, any IMAP server), for the closed island's
// email preview and the pill's card. The server says when one arrives (IDLE),
// so it shows within seconds. The classic Outlook on this PC can be a source
// too, alone or with IMAP (Settings → Pills → Email, outlook.rs): the island
// and the agents get both, the emails of each kept by their own ids.
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
// What more they may do is Settings → Security → Email's: with
// "Read and send", send, reply in the conversation and forward with the files
// (each email on its card, gone only when the user clicks Send; smtp.rs),
// and save drafts in the mailbox's Drafts; with "Read, send and manage",
// also mark read or unread, star, move, archive and trash one email, each on
// a card of its own. Nothing here ever deletes an email for good.

use std::collections::BTreeMap;
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
/// At most this many IMAP accounts. The first (the default: a new email goes
/// out of it) keeps the keys above; the others add their number to them
/// ("mail-address-2"…). Removing one moves the ones after it up, so the first
/// is always there while any is.
pub const MAX_ACCOUNTS: usize = 5;

/// The credential store's key of field `base` for account `slot` (1 = the first).
pub fn slot_key(base: &str, slot: usize) -> String {
    if slot <= 1 { base.to_string() } else { format!("{base}-{slot}") }
}

/// One IMAP account, as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub slot: usize,
    pub address: String,
    /// What the user typed, maybe nothing (then found from the address).
    pub server: String,
    pub(crate) password: String,
}

impl Account {
    fn host(&self) -> (String, u16) {
        server_of(&self.server, &self.address)
    }
}

/// Account `slot`, if it has its address and password.
fn account(slot: usize) -> Option<Account> {
    let address = secrets::get(&slot_key(ADDRESS_KEY, slot))?;
    let password = secrets::get(&slot_key(PASSWORD_KEY, slot))?;
    let server = secrets::get(&slot_key(SERVER_KEY, slot)).unwrap_or_default();
    Some(Account { slot, address, server, password })
}

/// Every account stored, the first (the default) first.
pub fn accounts() -> Vec<Account> {
    (1..=MAX_ACCOUNTS).filter_map(account).collect()
}

// ── Settings → Pills → Email → IMAP: the accounts ─────────────────────────────

/// One account as Settings lists it: never its password.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AccountRow {
    pub slot: usize,
    pub address: String,
    /// The server it reads, typed or found from the address.
    pub host: String,
    /// "ok" (read), "error", "paused", or "connecting".
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The accounts, the first (the default) first, each with how it is going.
#[tauri::command(async)]
pub fn mail_accounts(app: AppHandle) -> Vec<AccountRow> {
    let off = !imap_on(&app);
    accounts()
        .into_iter()
        .map(|a| {
            let host = a.host().0;
            let (state, error) = if off || is_paused(&app, &a.address) {
                ("paused", None)
            } else {
                match account_state(a.slot) {
                    Some(Ok(())) => ("ok", None),
                    Some(Err(e)) => ("error", Some(e)),
                    None => ("connecting", None),
                }
            };
            AccountRow { slot: a.slot, address: a.address.trim().to_string(), host, state, error }
        })
        .collect()
}

/// The server an address is read from when the user types none.
#[tauri::command]
pub fn mail_server_for(address: String) -> String {
    if address.contains('@') { server_of("", &address).0 } else { String::new() }
}

/// Adds an account, once its server took the address and the password: what
/// the user typed is tried first, and nothing is kept when it fails.
#[tauri::command(async)]
pub async fn mail_account_add(address: String, password: String, server: String) -> Result<String, String> {
    let (address, password, server) = (address.trim().to_string(), password.trim().to_string(), server.trim().to_string());
    if !crate::smtp::valid_address(&address) {
        return Err(t("This isn't an email address."));
    }
    if password.is_empty() {
        return Err(t("Paste the account's app password."));
    }
    if server.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(t("The IMAP server is a name like imap.example.com, with no spaces."));
    }
    compact();
    let stored = accounts();
    if stored.iter().any(|a| a.address.trim().eq_ignore_ascii_case(&address)) {
        return Err(t("This account is already in the list."));
    }
    if stored.len() >= MAX_ACCOUNTS {
        return Err(tf("At most {count} accounts: remove one first.", &[("count", &MAX_ACCOUNTS.to_string())]));
    }
    let host = try_account(&address, &password, &server).await?;
    let slot = stored.len() + 1;
    let saved = secrets::set(&slot_key(ADDRESS_KEY, slot), &address)
        .and_then(|_| secrets::set(&slot_key(PASSWORD_KEY, slot), &password))
        .and_then(|_| secrets::set(&slot_key(SERVER_KEY, slot), &server));
    if let Err(e) = saved {
        for base in [ADDRESS_KEY, PASSWORD_KEY, SERVER_KEY] {
            let _ = secrets::clear(&slot_key(base, slot));
        }
        return Err(e);
    }
    log::line(format!("[mail] account {slot} added ({host})"));
    keys_changed();
    Ok(host)
}

/// Removes the account of `address` from the credential store; the ones
/// after it move up. By its address, so a list shown before a change can't
/// remove another.
#[tauri::command(async)]
pub fn mail_account_remove(address: String) -> Result<(), String> {
    let slot = accounts()
        .into_iter()
        .find(|a| a.address.trim().eq_ignore_ascii_case(address.trim()))
        .map(|a| a.slot)
        .ok_or_else(|| format!("no account {address}"))?;
    for base in [ADDRESS_KEY, PASSWORD_KEY, SERVER_KEY] {
        secrets::clear(&slot_key(base, slot))?;
    }
    compact();
    log::line(format!("[mail] account {slot} removed"));
    keys_changed();
    Ok(())
}

/// The accounts with no gap between them: one missing (removed, or only half
/// stored) lets the ones after it move up, so the first is there while any is.
fn compact() {
    let mut to = 1;
    for from in 1..=MAX_ACCOUNTS {
        let address = secrets::get(&slot_key(ADDRESS_KEY, from));
        let password = secrets::get(&slot_key(PASSWORD_KEY, from));
        let (Some(address), Some(password)) = (address, password) else { continue };
        if from != to {
            let server = secrets::get(&slot_key(SERVER_KEY, from)).unwrap_or_default();
            let moved = secrets::set(&slot_key(ADDRESS_KEY, to), &address)
                .and_then(|_| secrets::set(&slot_key(PASSWORD_KEY, to), &password))
                .and_then(|_| secrets::set(&slot_key(SERVER_KEY, to), &server));
            if let Err(e) = moved {
                log::line(format!("[mail] account {from} couldn't move up: {e}"));
                return;
            }
            for base in [ADDRESS_KEY, PASSWORD_KEY, SERVER_KEY] {
                let _ = secrets::clear(&slot_key(base, from));
            }
        }
        to += 1;
    }
}

/// Settings → Pills → Email: the user paused this account (its switch).
fn paused(settings: &Settings, address: &str) -> bool {
    settings.mail_paused.iter().any(|a| a.trim().eq_ignore_ascii_case(address.trim()))
}

fn is_paused(app: &AppHandle, address: &str) -> bool {
    app.try_state::<crate::Shared>().is_some_and(|s| paused(&s.settings.lock().unwrap(), address))
}

/// The accounts Lumo reads: IMAP on, each not paused. The first of them is
/// the one a new email goes out of.
fn live_accounts(app: &AppHandle) -> Vec<Account> {
    if !imap_on(app) {
        return Vec::new();
    }
    accounts().into_iter().filter(|a| !is_paused(app, &a.address)).collect()
}

/// One step with the server: connect and sign in, or look.
const TIMEOUT: Duration = Duration::from_secs(25);
/// The server's answer to IDLE and to DONE, which comes at once on a live
/// connection: a connection that went quiet (sleep, a new network) is told
/// apart sooner.
const IDLE_ANSWER: Duration = Duration::from_secs(10);
/// What one check may read from the server, all answers together.
const MAX_READ: usize = 4 * 1024 * 1024;
/// What a search for every email of a folder may read: its UIDs, for some
/// four million emails.
const MAX_SEARCH_READ: usize = 32 * 1024 * 1024;
/// The newest unread messages kept: the island shows three, and the next ones
/// move up when one is ignored.
pub(crate) const FETCH: usize = 8;
/// Of each message's body, enough for a preview and for the AI to answer it.
const BODY_BYTES: usize = 24 * 1024;
pub(crate) const BODY_CHARS: usize = 6000;
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

/// The highest UID seen per account (by its number): what is above it is new.
/// The first check only takes note, so what was already unread is not announced.
static LAST_UID: Mutex<BTreeMap<usize, (String, u32)>> = Mutex::new(BTreeMap::new());
/// What the island was last sent, so an unchanged inbox sends nothing.
static LAST_SENT: Mutex<Option<String>> = Mutex::new(None);
/// What each source last read, or why it couldn't: the island and the chat
/// (chat.rs) get them together. IMAP's by account number.
static IMAP_NOW: Mutex<BTreeMap<usize, Result<Read, String>>> = Mutex::new(BTreeMap::new());
static OUTLOOK_NOW: Mutex<Option<Result<Read, String>>> = Mutex::new(None);

/// One source's inbox: how many unread, the newest unread, where to open it.
#[derive(Clone)]
struct Read {
    unread: usize,
    messages: Vec<Message>,
    inbox: Option<String>,
}

// ── Watching the inbox ────────────────────────────────────────────────────────

/// Woken by the pill's Refresh, a change of settings or of the keys.
static WAKE: Notify = Notify::const_new();
/// Bumped when the address, server or password change: the connection is redone.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Look again now (Refresh).
pub fn wake() {
    *LAST_SENT.lock().unwrap() = None;
    WAKE.notify_waiters();
    crate::outlook::wake();
}

/// Whether a change of settings concerns the Email pill: turned on or off (its
/// connection opens or closes now), its promotions filter, or the language its
/// errors are written in. Any other change leaves the inbox alone.
/// What the AI may do with the email (Settings → Security): "none",
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
    on(before) != on(after)
        || before.mail_hide_promotions != after.mail_hide_promotions
        || before.language != after.language
        || before.mail_imap != after.mail_imap
        || before.mail_outlook != after.mail_outlook
        || before.outlook_start != after.outlook_start
        || before.mail_paused != after.mail_paused
}

/// Settings → Pills → Email → "IMAP": on unless the user turned it off.
fn imap_on(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>().is_some_and(|s| s.settings.lock().unwrap().mail_imap)
}

/// IMAP is on and has an account to read.
fn imap_ready(app: &AppHandle) -> bool {
    !live_accounts(app).is_empty()
}

/// The keys changed: sign in again with the new ones.
pub fn keys_changed() {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    WAKE.notify_waiters();
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
///
/// Each account has a connection of its own; their emails come together.
pub async fn run(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(4)).await;
    let each: Vec<_> = (1..=MAX_ACCOUNTS).map(|slot| tauri::async_runtime::spawn(run_account(app.clone(), slot))).collect();
    for one in each {
        let _ = one.await;
    }
}

/// The connection of account `slot`, while it is there and on.
async fn run_account(app: AppHandle, slot: usize) {
    let mut health = Health::default();
    let mut generation = GENERATION.load(Ordering::Relaxed);
    loop {
        let on = crate::integrations::enabled(&app, ID) && !crate::integrations::PAUSED.load(Ordering::Relaxed) && imap_on(&app);
        let Some(acct) = account(slot).filter(|a| on && !is_paused(&app, &a.address)) else {
            clear_imap(&app, slot);
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
        if let Err(error) = watch(&app, &acct, &mut health).await {
            health.failures += 1;
            if shows_error(health.failures, health.has_read) {
                fail(&app, slot, error);
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
async fn watch(app: &AppHandle, acct: &Account, health: &mut Health) -> Result<(), String> {
    let generation = GENERATION.load(Ordering::Relaxed);
    let (host, port) = acct.host();
    let host = host.as_str();
    let mut imap = timed(host, sign_in(host, port, &acct.address, &acct.password)).await?;
    let idle = imap.capabilities.iter().any(|c| c == "IDLE");
    let account = format!("{}@{host}", acct.address);
    let mut known = std::collections::HashMap::new();
    let mut hiding = hides_promotions(app);
    loop {
        imap.read = 0;
        let hide = hides_promotions(app);
        if hide != hiding {
            // The filter changed: what it lets through now is not news.
            LAST_UID.lock().unwrap().remove(&acct.slot);
            hiding = hide;
        }
        let (unread, messages) = timed(host, look(&mut imap, host, hide, &mut known)).await?;
        let messages = messages.into_iter().map(|m| of_account(m, acct)).collect();
        report(app, acct, &account, host, unread, messages);
        health.failures = 0;
        health.has_read = true;
        let stop = || {
            GENERATION.load(Ordering::Relaxed) != generation
                || !crate::integrations::enabled(app, ID)
                || crate::integrations::PAUSED.load(Ordering::Relaxed)
                || !imap_on(app)
                || is_paused(app, &acct.address)
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
fn report(app: &AppHandle, acct: &Account, account: &str, host: &str, unread: usize, messages: Vec<Message>) {
    let newest = messages.iter().filter_map(|m| uid_of(&m.id)).max().unwrap_or(0);
    let fresh: Vec<Message> = {
        let mut last = LAST_UID.lock().unwrap();
        let seen = match last.get(&acct.slot) {
            Some((a, seen)) if a == account => Some(*seen),
            _ => None,
        };
        let fresh = match seen {
            Some(seen) => messages.iter().filter(|m| uid_of(&m.id).is_some_and(|u| u > seen)).cloned().collect(),
            None => Vec::new(),
        };
        last.insert(acct.slot, (account.to_string(), newest.max(seen.unwrap_or(0))));
        fresh
    };
    let inbox = inbox_link(host).map(|l| account_link(l, acct));
    IMAP_NOW.lock().unwrap().insert(acct.slot, Ok(Read { unread, messages, inbox }));
    publish(app);
    announce(app, fresh);
}

/// An email of account `acct` as the island keeps it: the first account's as
/// before, another's id with its address (two Gmail accounts share a server,
/// not their UIDs), and its Gmail link to that account.
fn of_account(mut m: Message, acct: &Account) -> Message {
    m.link = m.link.map(|l| account_link(l, acct));
    if acct.slot > 1 {
        m.id = format!("{}/{}", acct.address.to_ascii_lowercase(), m.id);
    }
    m
}

/// Outlook.com's own names, before a country's ending: hotmail.com,
/// hotmail.co.uk, outlook.de, live.fr, msn.com…
const OUTLOOK_PERSONAL_NAMES: [&str; 5] = ["outlook", "hotmail", "live", "msn", "windowslive"];

/// An Outlook.com account, not a work or school one (Microsoft 365): its
/// address is at one of Outlook.com's own names with only a country's ending
/// after it ("outlook.mycompany.com" is a company's), or the user typed
/// Outlook.com's own IMAP server.
pub(crate) fn outlook_personal(address: &str, imap_typed: &str) -> bool {
    if imap_typed.trim().eq_ignore_ascii_case("imap-mail.outlook.com") {
        return true;
    }
    let domain = address.trim().rsplit('@').next().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    let mut labels = domain.split('.');
    let name = labels.next().unwrap_or("");
    let ending: Vec<&str> = labels.collect();
    OUTLOOK_PERSONAL_NAMES.contains(&name) && !ending.is_empty() && ending.len() <= 2 && ending.iter().all(|l| (2..=3).contains(&l.len()))
}

/// A web mail link to the account it is of. A Gmail link (".../mail/u/0/..."),
/// when that is not the first: Gmail takes the address in place of the number.
/// An Outlook.com link, for a work or school account: Microsoft 365's Outlook.
fn account_link(link: String, acct: &Account) -> String {
    if acct.slot > 1 && link.starts_with("https://mail.google.com/mail/u/0/") {
        return link.replacen("/mail/u/0/", &format!("/mail/u/{}/", acct.address.trim()), 1);
    }
    match link.strip_prefix("https://outlook.live.com/mail/0/") {
        Some(rest) if !outlook_personal(&acct.address, &acct.server) => format!("https://outlook.office.com/mail/{rest}"),
        _ => link,
    }
}

/// Emails that just arrived: on the closed island, and to Gemini Live.
fn announce(app: &AppHandle, fresh: Vec<Message>) {
    if !fresh.is_empty() {
        crate::listen_events::heard_mail(app, &fresh);
        let _ = app.emit_to(WINDOW_LABEL, "mail-new", &fresh);
    }
}

fn fail(app: &AppHandle, slot: usize, error: String) {
    log::line(format!("[mail] {error}"));
    IMAP_NOW.lock().unwrap().insert(slot, Err(error));
    publish(app);
}

/// The account off, or gone: the others' emails, and Outlook's, stay.
fn clear_imap(app: &AppHandle, slot: usize) {
    let was = IMAP_NOW.lock().unwrap().remove(&slot);
    LAST_UID.lock().unwrap().remove(&slot);
    if was.is_some() {
        publish(app);
    }
}

/// What account `slot`'s connection says now, for Settings: Ok when it read
/// the inbox, the error shown, or None (off, or not connected yet).
pub fn account_state(slot: usize) -> Option<Result<(), String>> {
    IMAP_NOW.lock().unwrap().get(&slot).map(|r| r.as_ref().map(|_| ()).map_err(Clone::clone))
}

/// What Outlook's side read (outlook.rs): its inbox, why not (closed), or
/// nothing (off); with the emails that just arrived.
pub fn from_outlook(app: &AppHandle, read: Option<Result<(usize, Vec<Message>), String>>, fresh: Vec<Message>) {
    let inbox = Some(format!("{}inbox", crate::outlook::LINK_PREFIX));
    *OUTLOOK_NOW.lock().unwrap() = read.map(|r| r.map(|(unread, messages)| Read { unread, messages, inbox: inbox.clone() }));
    publish(app);
    announce(app, fresh);
}

/// The island gets the two sources together: an error only when neither has
/// emails to show. Only what changed reaches it: a quiet inbox wakes nothing.
fn publish(app: &AppHandle) {
    let mut sources: Vec<Result<Read, String>> = IMAP_NOW.lock().unwrap().values().cloned().collect();
    sources.extend(OUTLOOK_NOW.lock().unwrap().clone());
    let read: Vec<Read> = sources.iter().filter_map(|s| s.as_ref().ok().cloned()).collect();
    if read.is_empty() {
        let error = sources.iter().find_map(|s| s.as_ref().err().cloned());
        let shown = LAST_SENT.lock().unwrap().take().is_some();
        match error {
            Some(error) => emit(app, IntegrationUpdate { id: ID, data: json!({}), error: Some(error), event: None }),
            None if shown => emit(app, IntegrationUpdate { id: ID, data: json!({ "messages": [], "unread": 0 }), error: None, event: None }),
            None => {}
        }
        return;
    }
    let inbox = read.iter().find_map(|r| r.inbox.clone());
    let (unread, messages) = together(read);
    let data = json!({ "messages": messages, "unread": unread, "inbox": inbox });
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
}

/// The sources' unread emails as one inbox: newest first, the unread added up.
fn together(read: Vec<Read>) -> (usize, Vec<Message>) {
    let unread = read.iter().map(|r| r.unread).sum();
    if read.len() == 1 {
        let one = read.into_iter().next().map(|r| r.messages).unwrap_or_default();
        return (unread, one);
    }
    let mut all: Vec<Message> = read.into_iter().flat_map(|r| r.messages).collect();
    all.sort_by_key(|m| std::cmp::Reverse(date_key(&m.date)));
    all.truncate(FETCH);
    (unread, all)
}

// ── The island's Email view ───────────────────────────────────────────────────
//
// A click on the home's Email tile opens the island's Email view
// (views/mail-view.ts): one button per address, the emails of each, an email
// read there. It asks each account on a short connection of its own, as the
// agents' tools do, and like them never marks anything read (EXAMINE,
// BODY.PEEK). The island's own watch (above) goes on as it was.

/// How many emails the view lists of each account.
const VIEW_COUNT: usize = 20;
/// The view's key of the classic Outlook on this PC; an IMAP account's is "imap:" and its number.
const OUTLOOK_KEY: &str = "outlook";

/// One of the view's buttons: an IMAP account, or Outlook on this PC.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ViewAccount {
    /// What the view and its emails go by: "imap:1"…, "outlook".
    pub key: String,
    /// The address, or "Outlook".
    pub label: String,
    /// "ok", or "error" with why.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Unread in its inbox: as the watch last counted, else as many as were listed.
    pub unread: usize,
    /// Where its inbox opens: a webmail Lumo knows, Outlook, or nowhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbox: Option<String>,
}

/// An email in the view, with the account it is of.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ViewMail {
    pub account: String,
    #[serde(flatten)]
    pub message: Message,
    pub unread: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MailView {
    pub accounts: Vec<ViewAccount>,
    /// Every account's emails together, newest first.
    pub messages: Vec<ViewMail>,
}

/// The accounts' answers as the view gets them: the emails with their
/// account (ids made unique across accounts), newest first; an account that
/// failed says why on its button and leaves the others'.
fn view_of(results: Vec<(ViewAccount, Result<Vec<Found>, String>)>) -> MailView {
    let mut accounts = Vec::new();
    let mut messages = Vec::new();
    for (mut account, result) in results {
        match result {
            Ok(found) => {
                let unread_here = found.iter().filter(|f| f.unread).count();
                account.unread = account.unread.max(unread_here);
                messages.extend(found.into_iter().map(|f| {
                    let mut message = f.message;
                    message.id = format!("{}/{}", account.key, f.id);
                    ViewMail { account: account.key.clone(), message, unread: f.unread }
                }));
            }
            Err(e) => {
                account.state = "error";
                account.error = Some(e);
            }
        }
        accounts.push(account);
    }
    messages.sort_by_key(|m| std::cmp::Reverse(date_key(&m.message.date)));
    MailView { accounts, messages }
}

/// The Email view's accounts and their newest emails (only the unread ones, or
/// all the recent ones). Paused accounts are left out; an account that can't
/// be read now is listed with why.
#[tauri::command(async)]
pub async fn mail_view(app: AppHandle, unread_only: bool) -> MailView {
    if !crate::integrations::enabled(&app, ID) {
        return MailView { accounts: Vec::new(), messages: Vec::new() };
    }
    let imap: Vec<Account> = live_accounts(&app);
    let watched: BTreeMap<usize, Result<Read, String>> = IMAP_NOW.lock().unwrap().clone();
    let mut started = Vec::new();
    for acct in imap {
        let (host, _) = acct.host();
        let unread = match watched.get(&acct.slot) {
            Some(Ok(read)) => read.unread,
            _ => 0,
        };
        let account = ViewAccount {
            key: format!("imap:{}", acct.slot),
            label: acct.address.trim().to_string(),
            state: "ok",
            error: None,
            unread,
            inbox: inbox_link(&host).map(|l| account_link(l, &acct)),
        };
        let task = tauri::async_runtime::spawn(async move {
            newest_in(&acct, VIEW_COUNT, unread_only, None, true).await.map(|found| {
                found.into_iter().map(|mut f| {
                    f.message.link = f.message.link.map(|l| account_link(l, &acct));
                    f
                }).collect::<Vec<_>>()
            })
        });
        started.push((account, task));
    }
    let outlook = crate::outlook::on(&app).then(|| {
        let unread = match OUTLOOK_NOW.lock().unwrap().as_ref() {
            Some(Ok(read)) => read.unread,
            _ => 0,
        };
        let account = ViewAccount {
            key: OUTLOOK_KEY.into(),
            label: "Outlook".into(),
            state: "ok",
            error: None,
            unread,
            inbox: Some(format!("{}inbox", crate::outlook::LINK_PREFIX)),
        };
        account
    });
    let mut results = Vec::new();
    for (account, task) in started {
        results.push((account, task.await.unwrap_or_else(|e| Err(e.to_string()))));
    }
    // Outlook answers on its own thread (outlook.rs), while the servers above do.
    if let Some(account) = outlook {
        results.push((account, crate::outlook::newest(VIEW_COUNT, unread_only, None).await));
    }
    view_of(results)
}

// ── An email as its sender drew it ────────────────────────────────────────────
//
// The Email view shows an email's HTML when it has some (views/mail-view.ts):
// in a frame with no scripts, its links opened in the browser by a click, and
// nothing of it fetched from the web. The CSP of the island lets images in
// only from the app, data: and blob:, so the images an email links to stay
// hidden until a click on Load images, which downloads them through
// web_image.rs. The pictures inside the email itself (`cid:`) come with it,
// as data: URLs. Read as everything else here: EXAMINE, BODY.PEEK, nothing
// marked read. Only the parts it needs are fetched (its BODYSTRUCTURE says
// which): its HTML and the pictures that HTML names, never its files.

/// The most of one HTML part fetched (as sent: base64 is a third more).
const HTML_PART_BYTES: usize = 4 * 1024 * 1024;
/// The most of an email's HTML kept, its pictures aside.
const HTML_KEPT_BYTES: usize = 2 * 1024 * 1024;
/// The pictures inside an email (`cid:`) shown: each, and all together.
const INLINE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const INLINE_IMAGES_BYTES: usize = 6 * 1024 * 1024;
/// What the pictures may add to the HTML, every reference together: past it,
/// a picture named again and again stays a hidden reference.
const INLINE_URLS_BYTES: usize = 12 * 1024 * 1024;

/// An email's HTML for the view. `html` when Lumo reads its charset (UTF-8,
/// Latin-1/Windows-1252, UTF-16); otherwise its bytes, in base64, with the
/// charset the island reads them in (TextDecoder knows them all). Both empty
/// when it has no HTML: the view shows its text.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct MailHtml {
    pub html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
}

/// The HTML of the email `id` of the view ("imap:1/inbox:9", "outlook/outlook-3").
#[tauri::command(async)]
pub async fn mail_html(app: AppHandle, id: String) -> Result<MailHtml, String> {
    if !crate::integrations::enabled(&app, ID) {
        return Err(PILL_OFF.into());
    }
    let (key, own) = id.trim().split_once('/').ok_or_else(|| bad_id(&id))?;
    if key == OUTLOOK_KEY {
        if !crate::outlook::on(&app) {
            return Ok(MailHtml::default());
        }
        let (html, pictures) = crate::outlook::html(own.to_string(), HTML_PART_BYTES, INLINE_IMAGE_BYTES, INLINE_IMAGES_BYTES).await?;
        return Ok(assemble(vec![(html, String::new())], pictures));
    }
    let slot: usize = key.strip_prefix("imap:").and_then(|n| n.parse().ok()).ok_or_else(|| bad_id(&id))?;
    let acct = live_accounts(&app).into_iter().find(|a| a.slot == slot).ok_or_else(|| gone(&id))?;
    let (folder, uid) = parse_id(own).ok_or_else(|| bad_id(&id))?;
    let (host, _) = acct.host();
    // The connection the view's list or the email before left open: no new sign-in.
    if let Some((mut imap, at)) = take_warm(&acct, &host) {
        let mut answered = false;
        let got = timed(&host, html_parts(&mut imap, &at, &folder, uid, &id, Some(&mut answered))).await;
        match got {
            Ok((html, pictures)) => {
                park(&acct, host, imap, folder);
                return Ok(assemble(html, pictures));
            }
            // It works but the email's parts didn't come (too slow, too big):
            // a new connection would only fetch them again.
            Err(why) if answered => {
                drop_warm(imap);
                return Err(why);
            }
            // Closed by the server, or the network changed since: a new one.
            Err(_) => drop_warm(imap),
        }
    }
    let (mut imap, host) = open(&acct).await?;
    match timed(&host, html_parts(&mut imap, &Folder::Inbox, &folder, uid, &id, None)).await {
        Ok((html, pictures)) => {
            park(&acct, host, imap, folder);
            Ok(assemble(html, pictures))
        }
        Err(why) => {
            close(imap).await;
            Err(why)
        }
    }
}

/// The HTML parts and the pictures of email `uid` of `folder`, on a connection
/// that has `at` open. On a connection kept open (`warm` given), the server
/// has WARM_ANSWER to give its first answer: one that went quiet is given up
/// fast; `warm` turns true once the email's structure came, the connection
/// working.
async fn html_parts(imap: &mut Imap, at: &Folder, folder: &Folder, uid: u32, id: &str, warm: Option<&mut bool>) -> Result<(Vec<(Vec<u8>, String)>, Vec<(String, Vec<u8>)>), String> {
    imap.read = 0;
    imap.limit = MAX_READ;
    let first = async {
        if folder != at {
            enter(imap, folder, false).await?;
        }
        imap.run(&format!("UID FETCH {uid} (UID BODYSTRUCTURE)")).await
    };
    let units = if warm.is_some() {
        tokio::time::timeout(WARM_ANSWER, first).await.unwrap_or_else(|_| Err("The kept connection went quiet.".into()))?
    } else {
        first.await?
    };
    let unit = units.iter().find(|u| matches!(u.first(), Some(Part::Text(l)) if l.contains(" FETCH ") && l.to_ascii_uppercase().contains("BODYSTRUCTURE")));
    let plan = unit.map(|u| html_plan(u)).ok_or_else(|| gone(id))?;
    if let Some(answered) = warm {
        *answered = true;
    }
    let asked = plan.asked();
    if asked.html.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut items: Vec<String> = asked.html.iter().map(|p| format!("BODY.PEEK[{}]<0.{HTML_PART_BYTES}>", p.section)).collect();
    items.extend(asked.images.iter().map(|p| format!("BODY.PEEK[{}]", p.section)));
    imap.read = 0;
    imap.limit = asked.html.len() * HTML_PART_BYTES + asked.images.iter().map(|p| p.size).sum::<usize>() + 64 * 1024;
    let units = imap.run(&format!("UID FETCH {uid} (UID {})", items.join(" "))).await;
    imap.limit = MAX_READ;
    imap.read = 0;
    let sections = sections_of(&units?);
    let take = |p: &HtmlPiece| sections.get(&p.section).map(|b| decode_body(&p.encoding, b));
    let html: Vec<(Vec<u8>, String)> = asked.html.iter().filter_map(|p| take(p).map(|b| (b, p.charset.clone()))).collect();
    let pictures: Vec<(String, Vec<u8>)> = asked.images.iter().filter_map(|p| take(p).map(|b| (p.cid.clone(), b))).collect();
    Ok((html, pictures))
}

// ── A connection kept open for the next email ────────────────────────────────
//
// Signing in to Gmail and opening the inbox takes a second or more, most of
// the wait for an email's HTML. So the Email view's connections are not
// closed at once: the one that read its list, then the one that read an
// email, stays open WARM_FOR (one per account), and the email opened next
// uses it. Nothing runs on it meanwhile (0 % CPU): after WARM_FOR unused it
// is closed. One that went quiet is closed and a new one opened.

/// How long the Email view's connection stays open unused.
const WARM_FOR: Duration = Duration::from_secs(60);
/// How long a kept connection has for its first answer before a new one is opened.
const WARM_ANSWER: Duration = Duration::from_secs(5);

struct Warm {
    address: String,
    host: String,
    imap: Imap,
    /// The folder it has open.
    folder: Folder,
    ticket: u64,
}

static WARM: Mutex<BTreeMap<usize, Warm>> = Mutex::new(BTreeMap::new());
static WARM_TICKET: AtomicU64 = AtomicU64::new(0);

/// The connection kept open for `acct`, if it is still the same account; it is
/// taken: the next email asked meanwhile opens its own.
fn take_warm(acct: &Account, host: &str) -> Option<(Imap, Folder)> {
    let warm = WARM.lock().unwrap().remove(&acct.slot)?;
    if warm.address == acct.address && warm.host == host {
        return Some((warm.imap, warm.folder));
    }
    drop_warm(warm.imap);
    None
}

/// Keeps `imap` open WARM_FOR for the next email of `acct`, in place of the one before.
fn park(acct: &Account, host: String, imap: Imap, folder: Folder) {
    let ticket = WARM_TICKET.fetch_add(1, Ordering::Relaxed) + 1;
    let slot = acct.slot;
    let before = WARM.lock().unwrap().insert(slot, Warm { address: acct.address.clone(), host, imap, folder, ticket });
    if let Some(before) = before {
        drop_warm(before.imap);
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARM_FOR).await;
        let unused = {
            let mut warm = WARM.lock().unwrap();
            if warm.get(&slot).is_some_and(|w| w.ticket == ticket) { warm.remove(&slot) } else { None }
        };
        if let Some(unused) = unused {
            close(unused.imap).await;
        }
    });
}

/// Closes a kept connection without waiting for it.
fn drop_warm(imap: Imap) {
    tauri::async_runtime::spawn(close(imap));
}

/// A part of an email that its HTML is made of, as its BODYSTRUCTURE says.
#[derive(Clone, Debug, PartialEq, Default)]
struct HtmlPiece {
    /// For `BODY[…]`: "1", "1.2".
    section: String,
    encoding: String,
    /// A text part's charset ("" when it names none).
    charset: String,
    /// A picture's Content-ID, without its `<>`.
    cid: String,
    /// As sent.
    size: usize,
}

#[derive(Clone, Debug, PartialEq, Default)]
struct HtmlPlan {
    /// The HTML parts shown, in order (Apple Mail splits an email around its pictures).
    html: Vec<HtmlPiece>,
    /// The pictures that have a Content-ID, which the HTML may name.
    images: Vec<HtmlPiece>,
}

impl HtmlPlan {
    /// What is fetched of it: the pictures that fit INLINE_IMAGE_BYTES each
    /// and INLINE_IMAGES_BYTES together (base64 counted as the bytes it gives).
    fn asked(&self) -> HtmlPlan {
        let mut total = 0;
        let mut images = Vec::new();
        for p in &self.images {
            let bytes = if p.encoding.eq_ignore_ascii_case("base64") { p.size / 4 * 3 } else { p.size };
            if bytes == 0 || bytes > INLINE_IMAGE_BYTES || total + bytes > INLINE_IMAGES_BYTES {
                continue;
            }
            total += bytes;
            images.push(p.clone());
        }
        HtmlPlan { html: self.html.iter().take(8).cloned().collect(), images }
    }
}

/// What the email's HTML is made of, from a FETCH answer with its BODYSTRUCTURE.
fn html_plan(unit: &[Part]) -> HtmlPlan {
    let toks = tokens(unit);
    let Some(at) = toks.iter().position(|t| matches!(t, Tok::Word(w) if w.eq_ignore_ascii_case("BODYSTRUCTURE"))) else {
        return HtmlPlan::default();
    };
    let mut i = at + 1;
    node(&toks, &mut i, 0).map(|tree| plan_of(&tree, "", 0)).unwrap_or_default()
}

/// Of a multipart/alternative, the richest version that has HTML (the last);
/// of any other multipart, the HTML of each of its parts in turn; of a single
/// part, itself when it is HTML (not attached) or a picture with a Content-ID.
fn plan_of(part: &Node, section: &str, depth: usize) -> HtmlPlan {
    let Node::List(items) = part else { return HtmlPlan::default() };
    if depth > 12 {
        return HtmlPlan::default();
    }
    if matches!(items.first(), Some(Node::List(_))) {
        let children: Vec<HtmlPlan> = items
            .iter()
            .take_while(|c| matches!(c, Node::List(_)))
            .enumerate()
            .map(|(n, child)| plan_of(child, &if section.is_empty() { (n + 1).to_string() } else { format!("{section}.{}", n + 1) }, depth + 1))
            .collect();
        let subtype = match items.iter().find(|c| !matches!(c, Node::List(_))) {
            Some(Node::Str(s)) => s.to_ascii_lowercase(),
            _ => String::new(),
        };
        if subtype == "alternative" {
            return children.into_iter().rev().find(|c| !c.html.is_empty()).unwrap_or_default();
        }
        let mut out = HtmlPlan::default();
        for c in children {
            out.html.extend(c.html);
            out.images.extend(c.images);
        }
        return out;
    }
    let word = |i: usize| match items.get(i) {
        Some(Node::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let (kind, sub) = (word(0).to_ascii_lowercase(), word(1).to_ascii_lowercase());
    let ext = match (kind.as_str(), sub.as_str()) {
        ("text", _) => 8,
        ("message", "rfc822") => 10,
        _ => 7,
    };
    let attached = matches!(items.get(ext + 1), Some(Node::List(d)) if matches!(d.first(), Some(Node::Str(s)) if s.eq_ignore_ascii_case("attachment")));
    let piece = HtmlPiece {
        section: if section.is_empty() { "1".into() } else { section.to_string() },
        encoding: word(5),
        charset: param_of(items.get(2), "charset").unwrap_or_default(),
        cid: word(3).trim().trim_start_matches('<').trim_end_matches('>').trim().to_string(),
        size: word(6).parse().unwrap_or(0),
    };
    let mut out = HtmlPlan::default();
    if kind == "text" && sub == "html" && !attached {
        out.html.push(piece);
    } else if kind == "image" && !piece.cid.is_empty() {
        out.images.push(piece);
    }
    out
}

/// The literals of a FETCH answer by the section they are of: `BODY[1.2]<0> {n}` → "1.2".
fn sections_of(units: &[Vec<Part>]) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    for unit in units {
        let mut before = "";
        for part in unit {
            match part {
                Part::Text(s) => before = s,
                Part::Literal(bytes) => {
                    let upper = before.to_ascii_uppercase();
                    if let Some(at) = upper.rfind("BODY[") {
                        if let Some(end) = before[at + 5..].find(']') {
                            out.insert(before[at + 5..at + 5 + end].to_string(), bytes.clone());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Whether Lumo reads the charset itself (in_charset): else the island does.
fn read_here(charset: &str) -> bool {
    let cs = charset.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
    matches!(
        cs.as_str(),
        "" | "utf-8" | "utf8" | "us-ascii" | "ascii" | "iso-8859-1" | "iso8859-1" | "latin1" | "l1" | "windows-1252" | "cp1252" | "iso-8859-15" | "iso8859-15" | "latin9"
            | "utf-16" | "utf16" | "utf-16le" | "utf-16be" | "unicode" | "unicodefffe" | "ucs-2"
    )
}

/// The charset an HTML's bytes say they are in: a byte-order mark, else its `<meta>`; "" for none.
pub(crate) fn html_charset(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return "utf-16le".into();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return "utf-16be".into();
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return "utf-8".into();
    }
    let start = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    start
        .find("charset=")
        .map(|i| start[i + 8..].trim_start_matches(['"', '\'', ' ']).chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')).collect())
        .unwrap_or_default()
}

/// The view's HTML from the email's HTML parts (their bytes and charset, ""
/// when the part names none) and its pictures (Content-ID, bytes): the parts
/// one after the other, cut at HTML_KEPT_BYTES, the pictures put in for their
/// `cid:` as data: URLs.
pub(crate) fn assemble(parts: Vec<(Vec<u8>, String)>, pictures: Vec<(String, Vec<u8>)>) -> MailHtml {
    let parts: Vec<(Vec<u8>, String)> = parts
        .into_iter()
        .filter(|(b, _)| !b.is_empty())
        .map(|(b, cs)| {
            let cs = if cs.trim().is_empty() { html_charset(&b) } else { cs.trim().to_string() };
            (b, cs)
        })
        .collect();
    if parts.is_empty() {
        return MailHtml::default();
    }
    // Text Lumo reads becomes UTF-8; a part in another charset goes as it is,
    // alone (the island reads one charset).
    let (mut bytes, charset) = if parts.iter().all(|(_, cs)| read_here(cs)) {
        let text: String = parts.iter().map(|(b, cs)| in_charset(b, cs)).collect::<Vec<_>>().join("\n");
        let mut end = text.len().min(HTML_KEPT_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        (text.as_bytes()[..end].to_vec(), None)
    } else {
        let (b, cs) = parts.into_iter().find(|(_, cs)| !read_here(cs)).unwrap_or_default();
        (b[..b.len().min(HTML_KEPT_BYTES)].to_vec(), Some(cs))
    };
    let mut urls: BTreeMap<String, String> = BTreeMap::new();
    let mut total = 0;
    for (cid, data) in pictures {
        let Some(kind) = crate::web_image::sniff(&data) else { continue };
        if cid.is_empty() || data.len() > INLINE_IMAGE_BYTES || total + data.len() > INLINE_IMAGES_BYTES || urls.contains_key(&cid) {
            continue;
        }
        total += data.len();
        urls.insert(cid, format!("data:{kind};base64,{}", crate::claude::base64_for(&data)));
    }
    if !urls.is_empty() {
        bytes = inline_pictures(&bytes, &urls);
    }
    match charset {
        None => MailHtml { html: String::from_utf8_lossy(&bytes).into_owned(), bytes: None, charset: None },
        Some(cs) => MailHtml { html: String::new(), bytes: Some(crate::claude::base64_for(&bytes)), charset: Some(cs) },
    }
}

/// Each whole `cid:<id>` reference of a picture in `urls` replaced by its data:
/// URL, while what they add stays under INLINE_URLS_BYTES; "cid:a" never
/// matches inside "cid:ab".
fn inline_pictures(html: &[u8], urls: &BTreeMap<String, String>) -> Vec<u8> {
    let ends = |c: u8| matches!(c, b'"' | b'\'' | b'(' | b')' | b'<' | b'>' | b'&' | b';' | b',') || c.is_ascii_whitespace();
    let mut out = Vec::with_capacity(html.len());
    let mut added = 0usize;
    let mut i = 0;
    while i < html.len() {
        if html.len() - i >= 4 && html[i..i + 4].eq_ignore_ascii_case(b"cid:") {
            let start = i + 4;
            let end = html[start..].iter().position(|&c| ends(c)).map(|e| start + e).unwrap_or(html.len());
            let id = String::from_utf8_lossy(&html[start..end]).into_owned();
            let url = urls.get(&id).or_else(|| urls.get(&utf8_or_1252(&percent_decode(&id))));
            if let Some(url) = url.filter(|u| added + u.len() <= INLINE_URLS_BYTES) {
                added += url.len();
                out.extend_from_slice(url.as_bytes());
                i = end;
                continue;
            }
            out.extend_from_slice(&html[i..end.max(i + 4)]);
            i = end.max(i + 4);
            continue;
        }
        out.push(html[i]);
        i += 1;
    }
    out
}

// ── For the chat ──────────────────────────────────────────────────────────────

/// Of each email's text, what goes to the chat with a question about email.
const CHAT_BODY_CHARS: usize = 1500;

/// The inbox as last read, while the pill is on and signed in.
pub fn inbox() -> Option<(usize, Vec<Message>)> {
    let mut read: Vec<Read> = IMAP_NOW.lock().unwrap().values().filter_map(|r| r.as_ref().ok().cloned()).collect();
    read.extend(OUTLOOK_NOW.lock().unwrap().clone().and_then(Result::ok));
    (!read.is_empty()).then(|| together(read))
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
pub(crate) const MOST: usize = 25;
const DEFAULT_COUNT: usize = 10;
/// Of an email read in full: what is fetched, and what the agent reads.
const FULL_BYTES: usize = 256 * 1024;
pub(crate) const FULL_CHARS: usize = 20_000;
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
/// The same, decoded: what an Outlook file may weigh (outlook.rs).
pub(crate) const MAX_ATTACHMENT_BYTES: usize = MAX_ATTACHMENT_READ / 4 * 3;
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

/// The IMAP accounts an agent may use: the Email pill on, IMAP on, each
/// account not paused. The first is the one a new email goes out of.
fn tool_accounts(app: &AppHandle) -> Result<Vec<Account>, String> {
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
fn account_for(app: &AppHandle, id: &str) -> Result<(Account, String), String> {
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
async fn open(acct: &Account) -> Result<(Imap, String), String> {
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

const PILL_OFF: &str = "The Email pill is off in Lumo: the user can turn it on in Lumo's Settings.";
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
async fn newest_in(acct: &Account, count: usize, unread_only: bool, folder: Option<&str>, keep: bool) -> Result<Vec<Found>, String> {
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

fn bad_id(id: &str) -> String {
    format!("{id} is not an email id: use one mail_recent or mail_search gave.")
}

fn gone(id: &str) -> String {
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
    Ok(format!("Saved {} ({}) with the files attached to the chat: {}. Read it from there.", saved.name, size_text(saved.size as usize), saved.path))
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
    match tokio::time::timeout(CHAT_WAIT, newest_anywhere(app, DEFAULT_COUNT, false, None)).await {
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
            if crate::outlook::is_id(&id) {
                crate::outlook::save_attachment(id, input.get("attachment").cloned()).await
            } else {
                save_attachment(app, &input).await
            }
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

/// A new email goes out of Outlook when it is on and running, else over SMTP.
async fn sends_from_outlook(app: &AppHandle) -> bool {
    crate::outlook::on(app) && (!imap_ready(app) || crate::outlook::running().await)
}

/// `mail_send` out of Outlook.
async fn outlook_send(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let (mail, paths) = outgoing(input)?;
    let draft = crate::outlook::Draft::New { to: mail.to, cc: mail.cc };
    outlook_deliver(app, "mail_send", draft, mail.subject, mail.body, paths).await
}

/// `mail_reply` to an Outlook email: Outlook's own reply, in its conversation.
async fn outlook_reply(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
    let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (_, body) = subject_and_body(input)?;
    let all = input.get("reply_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let cc = addresses(input.get("cc"), "cc")?;
    let (_, paths): (Vec<_>, Vec<_>) = attachments(input.get("attachments"))?.into_iter().unzip();
    let draft = crate::outlook::Draft::Reply { id, all, cc };
    outlook_deliver(app, "mail_reply", draft, String::new(), body, paths).await
}

/// `mail_forward` of an Outlook email, with its files unless `with_files` is false.
async fn outlook_forward(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
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
async fn outlook_draft(input: &serde_json::Value) -> Result<String, String> {
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
async fn send(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
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
async fn reply(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
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
async fn draft(app: &AppHandle, input: &serde_json::Value) -> Result<String, String> {
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
        // Outlook.com, on any country's ending (hotmail.co.uk, outlook.de…).
        _ if outlook_personal(&domain, "") => "outlook.office365.com".to_string(),
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
            // A line never reads past what is left to read: a server that never
            // ends one cannot fill the memory before `count` stops it.
            let room = self.limit.saturating_sub(self.read).saturating_add(1) as u64;
            let n = (&mut self.stream).take(room).read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
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
        // Saturating: a literal announced as {18446744073709551615} is too much,
        // never a wrap back to a small number.
        self.read = self.read.saturating_add(n);
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

/// Both futures, run together, and both their outputs.
async fn both<A: std::future::Future, B: std::future::Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut got_a, mut got_b) = (None, None);
    std::future::poll_fn(|cx| {
        if got_a.is_none() {
            if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) {
                got_a = Some(v);
            }
        }
        if got_b.is_none() {
            if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) {
                got_b = Some(v);
            }
        }
        if got_a.is_some() && got_b.is_some() {
            if let (Some(a), Some(b)) = (got_a.take(), got_b.take()) {
                return std::task::Poll::Ready((a, b));
            }
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
pub(crate) fn hides_promotions(app: &AppHandle) -> bool {
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
                if whole_tag(&lower[i..], skip) {
                    let close = format!("</{}", &skip[1..]);
                    let mut at = i + skip.len();
                    i = loop {
                        match lower[at..].find(&close).map(|e| at + e) {
                            Some(e) if whole_tag(&lower[e..], &close) => break e,
                            Some(e) => at = e + close.len(),
                            None => break bytes.len(),
                        }
                    };
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

/// Whether `text` starts with the tag `name` ("<head", "</head") as a whole
/// name: `<head>` or `<head …>`, never `<header>`.
fn whole_tag(text: &str, name: &str) -> bool {
    text.starts_with(name) && text[name.len()..].chars().next().is_none_or(|c| c == '>' || c == '/' || c.is_ascii_whitespace())
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
pub(crate) fn tidy(text: &str) -> String {
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

pub(crate) fn preview(text: &str) -> String {
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

    fn acct(slot: usize, address: &str) -> Account {
        Account { slot, address: address.into(), server: String::new(), password: "pw".into() }
    }

    fn found(id: &str, date: &str, link: Option<&str>) -> Found {
        Found {
            id: id.into(),
            message: Message { id: id.into(), date: date.into(), link: link.map(String::from), ..Default::default() },
            unread: false,
        }
    }

    #[test]
    fn the_first_account_keeps_the_keys_of_before_the_others_are_numbered() {
        assert_eq!(slot_key(ADDRESS_KEY, 1), "mail-address");
        assert_eq!(slot_key(PASSWORD_KEY, 1), "mail-app-password");
        assert_eq!(slot_key(SERVER_KEY, 3), "mail-imap-server-3");
        assert_eq!(slot_key(ADDRESS_KEY, MAX_ACCOUNTS), "mail-address-5");
    }

    #[test]
    fn a_paused_account_is_known_by_its_address_whatever_its_case() {
        let mut settings = Settings::default();
        assert!(!paused(&settings, "a@x.it"));
        settings.mail_paused = vec!["A@X.it".into()];
        assert!(paused(&settings, " a@x.it "));
        assert!(!paused(&settings, "b@x.it"));
    }

    #[test]
    fn the_island_keeps_the_first_accounts_ids_and_tells_the_others_apart() {
        let m = Message { id: "imap.gmail.com:7".into(), link: Some("https://mail.google.com/mail/u/0/#inbox".into()), ..Default::default() };
        assert_eq!(of_account(m.clone(), &acct(1, "me@gmail.com")), m);
        let other = of_account(m, &acct(2, "Work@Gmail.com"));
        assert_eq!(other.id, "work@gmail.com/imap.gmail.com:7");
        assert_eq!(uid_of(&other.id), Some(7));
        assert_eq!(other.link.as_deref(), Some("https://mail.google.com/mail/u/Work@Gmail.com/#inbox"));
        let outlook = "https://outlook.live.com/mail/0/inbox".to_string();
        assert_eq!(account_link(outlook.clone(), &acct(2, "a@Hotmail.it")), outlook);
        assert_eq!(account_link(outlook.clone(), &acct(1, "ada@school.edu")), "https://outlook.office.com/mail/inbox", "Microsoft 365");
        let work = Message { id: "outlook.office365.com:3".into(), link: Some(outlook.clone()), ..Default::default() };
        assert_eq!(of_account(work, &acct(1, "ada@company.it")).link.as_deref(), Some("https://outlook.office.com/mail/inbox"));
    }

    #[test]
    fn outlook_com_on_any_countrys_ending_is_a_personal_account() {
        for address in ["a@hotmail.co.uk", "a@outlook.de", "a@live.fr", "a@hotmail.com.br", "a@msn.com", "a@Outlook.it", "a@outlook.com"] {
            assert!(outlook_personal(address, ""), "{address}");
        }
        for address in ["a@company.it", "a@school.edu", "a@outlook.mycompany.com", "a@live.example.org", "a@hotmail"] {
            assert!(!outlook_personal(address, ""), "{address}");
        }
        // Outlook.com's own IMAP server, typed: personal whatever the address.
        assert!(outlook_personal("me@mydomain.eu", "imap-mail.outlook.com"));
        assert_eq!(crate::smtp::server_of("", "a@hotmail.co.uk").0, "smtp-mail.outlook.com");
        assert_eq!(crate::smtp::server_of("outlook.office365.com", "a@company.it").0, "smtp.office365.com");
    }

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
    fn two_inboxes_are_one_newest_first_and_their_unread_add_up() {
        let mail = |id: &str, date: &str| Message { id: id.into(), date: date.into(), ..Default::default() };
        let imap = Read { unread: 3, messages: vec![mail("imap:9", "Sun, 8 Nov 2026 10:00:00 +0100"), mail("imap:8", "Sat, 7 Nov 2026 10:00:00 +0100")], inbox: None };
        let outlook = Read { unread: 1, messages: vec![mail("outlook-1", "Sun, 8 Nov 2026 09:30:00 +0000")], inbox: None };
        let (unread, messages) = together(vec![imap.clone(), outlook]);
        assert_eq!(unread, 4);
        let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["outlook-1", "imap:9", "imap:8"], "09:30 UTC is after 10:00 in +01:00");
        // One source keeps its own order.
        assert_eq!(together(vec![imap]).1.len(), 2);
    }

    fn structure(text: &str) -> Vec<Part> {
        vec![Part::Text(format!("* 3 FETCH (UID 9 BODYSTRUCTURE {text})"))]
    }

    #[test]
    fn the_html_of_an_email_is_its_richest_version_with_its_pictures_never_its_files() {
        // mixed { related { alternative { plain, html }, logo (cid) }, attached photo, attached page }
        let unit = structure(concat!(
            r#"(((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)"#,
            r#"("TEXT" "HTML" ("CHARSET" "iso-8859-1") NIL NIL "QUOTED-PRINTABLE" 200 4 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "a") NIL NIL NIL)"#,
            r#"("IMAGE" "PNG" ("NAME" "logo.png") "<logo@shop>" NIL "BASE64" 400 NIL ("INLINE" ("FILENAME" "logo.png")) NIL NIL) "RELATED" ("BOUNDARY" "r") NIL NIL NIL)"#,
            r#"("IMAGE" "JPEG" ("NAME" "photo.jpg") NIL NIL "BASE64" 90000 NIL ("ATTACHMENT" ("FILENAME" "photo.jpg")) NIL NIL)"#,
            r#"("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 30 1 NIL ("ATTACHMENT" ("FILENAME" "page.html")) NIL NIL) "MIXED" ("BOUNDARY" "m") NIL NIL NIL))"#,
        ));
        let plan = html_plan(&unit);
        assert_eq!(plan.html.len(), 1);
        assert_eq!((plan.html[0].section.as_str(), plan.html[0].charset.as_str(), plan.html[0].encoding.as_str()), ("1.1.2", "iso-8859-1", "QUOTED-PRINTABLE"));
        assert_eq!(plan.images.len(), 1);
        assert_eq!((plan.images[0].section.as_str(), plan.images[0].cid.as_str()), ("1.2", "logo@shop"));
        // A single-part email is its part 1.
        let single = html_plan(&structure(r#"("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "BASE64" 300 5 NIL NIL NIL NIL))"#));
        assert_eq!(single.html.iter().map(|p| p.section.as_str()).collect::<Vec<_>>(), ["1"]);
        // Plain text only: no HTML.
        assert!(html_plan(&structure(r#"("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL))"#)).html.is_empty());
        // Apple Mail: mixed { html, picture, html }: both pieces of HTML, in order.
        let apple = html_plan(&structure(concat!(
            r#"(("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)"#,
            r#"("IMAGE" "JPEG" ("NAME" "a.jpg") "<a1>" NIL "BASE64" 400 NIL ("INLINE" ("FILENAME" "a.jpg")) NIL NIL)"#,
            r#"("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL) "MIXED" ("BOUNDARY" "m") NIL NIL NIL))"#,
        )));
        assert_eq!(apple.html.iter().map(|p| p.section.as_str()).collect::<Vec<_>>(), ["1", "3"]);
        assert_eq!(apple.images[0].cid, "a1");
    }

    #[test]
    fn pictures_too_big_are_not_fetched() {
        let piece = |n: usize, size: usize| HtmlPiece { section: n.to_string(), encoding: "BASE64".into(), cid: format!("c{n}"), size, ..Default::default() };
        let plan = HtmlPlan {
            html: vec![HtmlPiece { section: "1".into(), ..Default::default() }],
            images: vec![piece(2, 4 * 1024 * 1024), piece(3, 1000), piece(4, 0), piece(5, 2 * 1024 * 1024)],
        };
        let asked = plan.asked();
        assert_eq!(asked.images.iter().map(|p| p.section.as_str()).collect::<Vec<_>>(), ["3", "5"]);
    }

    #[test]
    fn the_parts_fetched_are_found_by_their_section() {
        let units = vec![vec![
            Part::Text("* 3 FETCH (UID 9 BODY[1.1.2]<0> {5}".into()),
            Part::Literal(b"<p>A</p>".to_vec()),
            Part::Text(" BODY[1.2] {3}".into()),
            Part::Literal(b"PNG".to_vec()),
            Part::Text(")".into()),
        ]];
        let found = sections_of(&units);
        assert_eq!(found.get("1.1.2").map(|b| b.as_slice()), Some(&b"<p>A</p>"[..]));
        assert_eq!(found.get("1.2").map(|b| b.as_slice()), Some(&b"PNG"[..]));
    }

    #[test]
    fn the_html_comes_with_its_own_pictures_each_reference_whole_and_within_bounds() {
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let url = format!("data:image/png;base64,{}", crate::claude::base64_for(&png));
        let html = br#"<img src="cid:img1"><img src='cid:img10'><img src=CID:img1>"#.to_vec();
        let out = assemble(vec![(html, "utf-8".into())], vec![("img1".into(), png.clone()), ("img10".into(), png.clone())]);
        assert_eq!(out.html, format!("<img src=\"{url}\"><img src='{url}'><img src={url}>"));
        assert_eq!(out.bytes, None);
        // An "image" that is an SVG (it can carry scripts) is not put in.
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>".to_vec();
        let out = assemble(vec![(br#"<img src="cid:a">"#.to_vec(), String::new())], vec![("a".into(), svg)]);
        assert_eq!(out.html, r#"<img src="cid:a">"#);
        // A picture named a million times: only what fits INLINE_URLS_BYTES is put in.
        let big = {
            let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
            b.resize(1024 * 1024, 7);
            b
        };
        let many = "<img src=\"cid:x\">".repeat(100_000).into_bytes();
        let out = assemble(vec![(many, String::new())], vec![("x".into(), big)]);
        assert!(out.html.len() < HTML_KEPT_BYTES + INLINE_URLS_BYTES + 1024, "{}", out.html.len());
        assert!(out.html.contains("cid:x"));
    }

    #[test]
    fn the_html_charset_is_read_here_or_left_to_the_island() {
        // From its <meta>, as Latin-1.
        let latin = b"<meta charset=\"iso-8859-1\"><p>Perch\xe8</p>".to_vec();
        assert!(assemble(vec![(latin, String::new())], vec![]).html.contains("<p>Perchè</p>"));
        // Shift_JIS: its bytes go to the island, which reads them with TextDecoder.
        let sjis = b"<p>\x82\xa0</p>".to_vec();
        let out = assemble(vec![(sjis.clone(), "Shift_JIS".into())], vec![]);
        assert_eq!(out.html, "");
        assert_eq!(out.charset.as_deref(), Some("Shift_JIS"));
        assert_eq!(out.bytes, Some(crate::claude::base64_for(&sjis)));
        // No HTML at all: nothing.
        assert_eq!(assemble(vec![], vec![]), MailHtml::default());
        assert_eq!(html_charset(b"\xff\xfe<\0"), "utf-16le");
        assert_eq!(html_charset(b"<meta http-equiv=Content-Type content='text/html; charset=windows-1251'>"), "windows-1251");
    }

    #[test]
    fn the_email_view_lists_every_account_newest_first_and_says_which_failed() {
        let button = |key: &str, unread: usize| ViewAccount {
            key: key.into(), label: key.into(), state: "ok", error: None, unread, inbox: None,
        };
        let mail = |id: &str, date: &str, unread: bool| Found {
            id: id.into(),
            message: Message { id: "9".into(), date: date.into(), ..Default::default() },
            unread,
        };
        let view = view_of(vec![
            (button("imap:1", 5), Ok(vec![mail("inbox:9", "Sun, 8 Nov 2026 10:00:00 +0100", true), mail("inbox:8", "Sat, 7 Nov 2026 10:00:00 +0100", false)])),
            (button("imap:2", 0), Err("The server refused the app password.".into())),
            (button("outlook", 0), Ok(vec![mail("outlook-1", "Sun, 8 Nov 2026 09:30:00 +0000", true)])),
        ]);
        let ids: Vec<&str> = view.messages.iter().map(|m| m.message.id.as_str()).collect();
        // The same UID in two accounts stays two emails: each id has its account.
        assert_eq!(ids, ["outlook/outlook-1", "imap:1/inbox:9", "imap:1/inbox:8"]);
        assert_eq!(view.messages[1].account, "imap:1");
        assert!(view.messages[1].unread && !view.messages[2].unread);
        // The watch's count stays when it is more than the list shows; else the list's.
        assert_eq!(view.accounts[0].unread, 5);
        assert_eq!(view.accounts[2].unread, 1);
        assert_eq!((view.accounts[1].state, view.accounts[1].error.as_deref()), ("error", Some("The server refused the app password.")));
        assert_eq!(view.accounts.len(), 3);
    }

    #[test]
    fn an_outlook_folder_named_archive_in_any_language_is_the_archive() {
        assert!(is_archive_name("Archive") && is_archive_name(" archivio ") && !is_archive_name("Lavoro"));
    }

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
        assert_eq!(strip_html("<html><head><title>x</title></head><body><header>Newsletter</header><p>Hi</p></body></html>").trim(), "Newsletter\nHi");
        assert_eq!(strip_html("<head>\n<style>p{}</style></head ><p>Ok</p>").trim(), "Ok");
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
