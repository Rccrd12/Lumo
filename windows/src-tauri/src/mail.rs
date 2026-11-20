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
//
// This file is the pill itself: the accounts, watching the inbox, the island's
// Email view and an email as its sender drew it. What the agents' tools do is
// mail_agents.rs, the emails they write mail_send.rs, IMAP itself
// mail_imap.rs, and reading an email's headers, parts and text mail_parse.rs.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::i18n::{t, tf};
use crate::integrations::{emit, IntegrationUpdate};
use crate::island::WINDOW_LABEL;
use crate::mail_agents::{bad_id, close, date_key, enter, gone, newest_in, open, parse_id, try_account, uid_of, Folder, PILL_OFF};
use crate::mail_imap::{inbox_link, look, sign_in, Imap, Part};
use crate::mail_parse::{decode_body, in_charset, node, param_of, percent_decode, tokens, utf8_or_1252, Node, Tok};
use crate::settings::Settings;
use crate::{log, secrets};

// What the rest of Lumo asks of the Email pill as `crate::mail::…`, wherever
// it lives now: mail_agents.rs, mail_send.rs, mail_imap.rs and mail_parse.rs.
pub(crate) use crate::mail_agents::{agent_turn, is_archive_name, serve, Found, MAX_ATTACHMENT_BYTES};
pub(crate) use crate::mail_imap::{hides_promotions, server_of, tls};
pub(crate) use crate::mail_parse::{preview, strip_html, tidy};
pub(crate) use crate::mail_send::too_heavy;

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
    pub(crate) fn host(&self) -> (String, u16) {
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
pub(crate) fn live_accounts(app: &AppHandle) -> Vec<Account> {
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
pub(crate) const IDLE_ANSWER: Duration = Duration::from_secs(10);
/// What one check may read from the server, all answers together.
pub(crate) const MAX_READ: usize = 4 * 1024 * 1024;
/// What a search for every email of a folder may read: its UIDs, for some
/// four million emails.
pub(crate) const MAX_SEARCH_READ: usize = 32 * 1024 * 1024;
/// The newest unread messages kept: the island shows three, and the next ones
/// move up when one is ignored.
pub(crate) const FETCH: usize = 8;
/// Of each message's body, enough for a preview and for the AI to answer it.
pub(crate) const BODY_BYTES: usize = 24 * 1024;
pub(crate) const BODY_CHARS: usize = 6000;
pub(crate) const PREVIEW_CHARS: usize = 180;

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
pub(crate) static WAKE: Notify = Notify::const_new();
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
pub(crate) fn imap_on(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>().is_some_and(|s| s.settings.lock().unwrap().mail_imap)
}

/// IMAP is on and has an account to read.
pub(crate) fn imap_ready(app: &AppHandle) -> bool {
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
pub(crate) fn idle_for() -> Duration {
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
pub(crate) async fn timed<T>(host: &str, step: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    timed_for(TIMEOUT, host, step).await
}

pub(crate) async fn timed_for<T>(wait: Duration, host: &str, step: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
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
pub(crate) fn account_link(link: String, acct: &Account) -> String {
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
        // An error shown is remembered too: the account that had it paused or
        // removed, the island is told there is nothing left to show.
        let shown = match &error {
            Some(error) => LAST_SENT.lock().unwrap().replace(format!("error:{error}")).is_some(),
            None => LAST_SENT.lock().unwrap().take().is_some(),
        };
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
    /// The page of Settings its error's button opens, when not Pills.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<&'static str>,
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
            settings: None,
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
            settings: None,
        };
        account
    });
    let mut results = Vec::new();
    for (account, task) in started {
        results.push((account, task.await.unwrap_or_else(|e| Err(e.to_string()))));
    }
    // Outlook answers on its own thread (outlook.rs), while the servers above
    // do; closed, it is started first when the user allowed it, and what went
    // wrong is said for the user, not for the agents.
    if let Some(mut account) = outlook {
        let read = crate::outlook::for_view(&app, VIEW_COUNT, unread_only).await.map_err(|(why, page)| {
            account.settings = Some(page);
            why
        });
        results.push((account, read));
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
        let (html, pictures, codepage) = crate::outlook::html(own.to_string(), HTML_PART_BYTES, INLINE_IMAGE_BYTES, INLINE_IMAGES_BYTES).await?;
        let charset = outlook_charset(&html, codepage);
        return Ok(assemble(vec![(html, charset)], pictures));
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
pub(crate) fn park(acct: &Account, host: String, imap: Imap, folder: Folder) {
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

/// The charset of an Outlook email's HTML: the one its own bytes say (a
/// byte-order mark, its `<meta>`), else the code page Outlook keeps it in
/// (`InternetCodepage`); "" when neither says (read as UTF-8, else Windows-1252).
fn outlook_charset(html: &[u8], codepage: u32) -> String {
    if !html_charset(html).is_empty() {
        return String::new();
    }
    codepage_charset(codepage).to_string()
}

/// The charset a Windows code page stands for, as a browser's TextDecoder
/// knows it; "" for one Lumo doesn't know.
fn codepage_charset(codepage: u32) -> &'static str {
    match codepage {
        65001 => "utf-8",
        1200 => "utf-16le",
        1201 => "utf-16be",
        20127 => "us-ascii",
        874 => "windows-874",
        1250..=1258 => ["windows-1250", "windows-1251", "windows-1252", "windows-1253", "windows-1254", "windows-1255", "windows-1256", "windows-1257", "windows-1258"][(codepage - 1250) as usize],
        28591 => "iso-8859-1",
        28592 => "iso-8859-2",
        28593 => "iso-8859-3",
        28594 => "iso-8859-4",
        28595 => "iso-8859-5",
        28596 => "iso-8859-6",
        28597 => "iso-8859-7",
        28598 => "iso-8859-8",
        28599 => "iso-8859-9",
        28603 => "iso-8859-13",
        28605 => "iso-8859-15",
        20866 => "koi8-r",
        21866 => "koi8-u",
        932 => "shift_jis",
        50220..=50222 => "iso-2022-jp",
        51932 => "euc-jp",
        936 => "gbk",
        54936 => "gb18030",
        949 | 51949 => "euc-kr",
        950 => "big5",
        _ => "",
    }
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
        // The island reads one charset: the first Lumo doesn't read, with every
        // part in it and every part in plain ASCII (the same in all but UTF-16),
        // in their order; a part in yet another charset is left out.
        let cs = parts.iter().find(|(_, cs)| !read_here(cs)).map(|(_, cs)| cs.clone()).unwrap_or_default();
        let wide = cs.to_ascii_lowercase().contains("16") || cs.eq_ignore_ascii_case("ucs-2") || cs.eq_ignore_ascii_case("unicode");
        let mut b: Vec<u8> = Vec::new();
        for (bytes, part_cs) in &parts {
            if part_cs.eq_ignore_ascii_case(&cs) || (!wide && bytes.is_ascii()) {
                if !b.is_empty() {
                    b.push(b'\n');
                }
                b.extend_from_slice(bytes);
            }
        }
        b.truncate(HTML_KEPT_BYTES);
        (b, Some(cs))
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn acct(slot: usize, address: &str) -> Account {
        Account { slot, address: address.into(), server: String::new(), password: "pw".into() }
    }

    pub(crate) fn found(id: &str, date: &str, link: Option<&str>) -> Found {
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

    pub(crate) fn structure(text: &str) -> Vec<Part> {
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
    fn every_html_part_in_the_islands_charset_is_kept() {
        // Apple Mail's parts around a picture, in Shift_JIS, and one in plain ASCII between them.
        let a = b"<p>\x82\xa0</p>".to_vec();
        let b = b"<p>ok</p>".to_vec();
        let c = b"<p>\x82\xa2</p>".to_vec();
        let out = assemble(vec![(a.clone(), "Shift_JIS".into()), (b.clone(), "us-ascii".into()), (c.clone(), "shift_jis".into())], vec![]);
        assert_eq!(out.charset.as_deref(), Some("Shift_JIS"));
        assert_eq!(out.bytes, Some(crate::claude::base64_for(&[a.clone(), b"\n".to_vec(), b, b"\n".to_vec(), c].concat())));
        // A part in yet another charset (and not ASCII) is left out.
        let cyr = b"<p>\xcf\xf0</p>".to_vec();
        let out = assemble(vec![(a.clone(), "Shift_JIS".into()), (cyr, "windows-1251".into())], vec![]);
        assert_eq!(out.bytes, Some(crate::claude::base64_for(&a)));
    }

    #[test]
    fn an_outlook_email_without_its_charset_is_read_in_its_code_page() {
        // Its <meta> says: that one (assemble reads it).
        assert_eq!(outlook_charset(b"<meta charset=\"utf-8\"><p>ciao</p>", 1252), "");
        // None: Outlook's code page.
        assert_eq!(outlook_charset(b"<p>Perch\xe8</p>", 1252), "windows-1252");
        assert_eq!(outlook_charset(b"<p>x</p>", 932), "shift_jis");
        assert_eq!(outlook_charset(b"<p>x</p>", 0), "");
        assert_eq!(codepage_charset(1250), "windows-1250");
        assert_eq!(codepage_charset(1258), "windows-1258");
        assert_eq!(codepage_charset(28605), "iso-8859-15");
        assert_eq!(codepage_charset(65001), "utf-8");
        assert_eq!(codepage_charset(12345), "");
        // Windows-1252 bytes are read here, as Lumo reads that charset.
        let out = assemble(vec![(b"<p>Perch\xe8</p>".to_vec(), outlook_charset(b"<p>Perch\xe8</p>", 1252))], vec![]);
        assert!(out.html.contains("Perchè"), "{}", out.html);
        // Windows-1251 goes to the island with its charset.
        let out = assemble(vec![(b"<p>\xcf</p>".to_vec(), outlook_charset(b"<p>\xcf</p>", 1251))], vec![]);
        assert_eq!(out.charset.as_deref(), Some("windows-1251"));
    }

    #[test]
    fn the_email_view_lists_every_account_newest_first_and_says_which_failed() {
        let button = |key: &str, unread: usize| ViewAccount {
            key: key.into(), label: key.into(), state: "ok", error: None, unread, inbox: None, settings: None,
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
    fn the_ai_reads_the_email_unless_security_says_none() {
        assert_eq!(access(&Settings::default()), "manage", "the first start: each change waits for a click");
        assert_eq!(access(&Settings { ai_mail_access: "read".into(), ..Settings::default() }), "read");
        assert_eq!(access(&Settings { ai_mail_access: "none".into(), ..Settings::default() }), "none");
        assert_eq!(access(&Settings { ai_mail_access: "send".into(), ..Settings::default() }), "send");
        assert_eq!(access(&Settings { ai_mail_access: "manage".into(), ..Settings::default() }), "manage");
        assert_eq!(access(&Settings { ai_mail_access: "anything".into(), ..Settings::default() }), "read");
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
}
