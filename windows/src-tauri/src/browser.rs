// A browser for the island chat's agents (Settings → Security → "Let agents
// browse the web", off by default, Windows only).
//
// Claude Code and the agents it starts open web pages in hidden tabs inside
// Lumo, so several of them browse at once and none of them touches the
// user's mouse. A tab is a hidden WebView2 window of its own
// (`agent-browser-<n>`), in a profile apart from the user's browser and
// from Lumo's own pages: an InPrivate one under `AgentBrowser`, with none of
// the user's cookies or accounts. Pages are real: their JavaScript runs, as
// in Edge.
//
// Each call of lumo-hook --mcp's browser tools (`browser_open`,
// `browser_read`…) comes here over the relay pipe as
// `{"lumo_browser": {"tool": …, "input": …, "chat": …}}` (pipe.rs) and is
// answered with one line: the page as text, a screenshot, what was done, or
// why not. Lumo drives each tab through the DevTools protocol WebView2 lets
// the app itself speak (`CallDevToolsProtocolMethod`): never a debugging
// port another program could reach.
//
// What keeps it in hand:
// * Nothing runs while the setting is off; turning it off closes every tab.
// * A tab never shows Lumo's own pages (`*.localhost`, and in a debug build
//   the dev server's): refused as the page's address and blocked as anything
//   a page loads (Network.setBlockedURLs), since Tauri's pages can call Lumo.
//   Whatever gets past that, a frame included, still can't: lib.rs refuses
//   every command that comes from a tab (`from_tab`).
// * What changes a page (open, click, type, scroll) goes through Claude
//   Code's own permission, the island's card; reading and screenshots only look.
// * A tab belongs to the agent that opened it (the chat's PreToolUse hook
//   says which: `claim`), and closes with it, or after IDLE unused.
//
// The island sees the tabs as `browser-tabs` (each tab's chat, agent, site
// and whether the user is watching it), sent only when they change: one
// timer runs while a tab is open, asleep until the next one is due to close.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The conversation itself, not one of its agents.
const MAIN: &str = crate::computer_turns::MAIN;
/// The most tabs open at once, every chat together.
pub const MAX_TABS: usize = 8;
/// A tab unused this long closes.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// A claim no call took within this long is forgotten: longer than the
/// permission card between the claim and the call waits (pipe.rs
/// DECISION_TIMEOUT).
const CLAIM_LIFE: Duration = Duration::from_secs(150);
/// A tab whose agent the Agents card never listed yet stays this long
/// before its agent's end closes it: the row may come after the tab.
const UNSEEN_GRACE: Duration = Duration::from_secs(30);
/// One DevTools call, at most.
const STEP: Duration = Duration::from_secs(10);
/// How long a page is waited for after an action.
const LOAD_WAIT: Duration = Duration::from_secs(10);
/// A screenshot, at most.
const SHOT_LIMIT: Duration = Duration::from_secs(10);
/// What browser_read gives when the agent says nothing, and at most.
const READ_CHARS: usize = 12_000;
const READ_CHARS_MAX: usize = 40_000;
/// The window's label: never in capabilities/default.json, so a page in it
/// can call none of the plugins' commands, and refused by lib.rs for Lumo's
/// own (`from_tab`).
const LABEL: &str = "agent-browser-";
/// The tabs' profile folder, beside Lumo's own WebView data (EBWebView).
const PROFILE_DIR: &str = "AgentBrowser";

/// The tabs' browser: its own data folder, so its own arguments (lib.rs
/// BROWSER_ARGS are the island's, and must stay as they are). A hidden tab
/// keeps running as if on screen: no throttled timers, no paused rendering,
/// so pages load, scroll and can be photographed. Never a debugging port.
const AGENT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";

const OFF: &str = "Browsing is off in Lumo. Turn it on in Lumo's Settings, under Security.";

#[derive(Debug, Clone)]
struct Tab {
    n: u32,
    chat: String,
    /// The Agents card's row id, or "main".
    agent: String,
    label: String,
    url: String,
    title: String,
    used: Instant,
    opened: Instant,
    /// The user is watching it (Watch on the Agents card).
    visible: bool,
    /// Its agent was listed open on the Agents card once.
    seen: bool,
}

/// Which agent is about to open a tab, as the chat's PreToolUse hook said.
#[derive(Debug, Clone)]
struct Claim {
    chat: String,
    agent: String,
    url: String,
    at: Instant,
}

#[derive(Debug, Default)]
struct Tabs {
    next: u32,
    open: Vec<Tab>,
    claims: Vec<Claim>,
    /// The idle timer runs (one for every tab).
    timer: bool,
}

/// The tabs, as the island draws them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsView {
    pub tabs: Vec<TabView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub chat: String,
    pub agent: String,
    pub tab: u32,
    pub host: String,
    pub title: String,
    pub visible: bool,
}

impl Tabs {
    /// The agent of the oldest claim of `chat` for `url` (taken), forgetting
    /// the claims past CLAIM_LIFE.
    fn take_claim(&mut self, chat: &str, url: &str, now: Instant) -> Option<String> {
        self.claims.retain(|c| now.duration_since(c.at) < CLAIM_LIFE);
        let i = self.claims.iter().position(|c| c.chat == chat && c.url == url)?;
        Some(self.claims.remove(i).agent)
    }

    fn find(&mut self, chat: &str, n: u32) -> Option<&mut Tab> {
        self.open.iter_mut().find(|t| t.chat == chat && t.n == n)
    }

    /// The tabs of `chat` whose agent ended (not in `ids`), taken out: their
    /// labels. "main" stays; a tab whose agent was never listed yet stays
    /// UNSEEN_GRACE.
    fn agents_open(&mut self, chat: &str, ids: &[String], now: Instant) -> Vec<String> {
        let mut gone = Vec::new();
        self.open.retain_mut(|tab| {
            if tab.chat != chat || tab.agent == MAIN {
                return true;
            }
            if ids.contains(&tab.agent) {
                tab.seen = true;
                return true;
            }
            if tab.seen || now.duration_since(tab.opened) >= UNSEEN_GRACE {
                gone.push(tab.label.clone());
                return false;
            }
            true
        });
        gone
    }

    /// The tabs unused for `idle`, taken out: their labels.
    fn expired(&mut self, now: Instant, idle: Duration) -> Vec<String> {
        let mut gone = Vec::new();
        self.open.retain(|tab| {
            let keep = now.duration_since(tab.used) < idle;
            if !keep {
                gone.push(tab.label.clone());
            }
            keep
        });
        gone
    }

    fn view(&self) -> TabsView {
        TabsView {
            tabs: self
                .open
                .iter()
                .map(|t| TabView {
                    chat: t.chat.clone(),
                    agent: t.agent.clone(),
                    tab: t.n,
                    host: host_of(&t.url),
                    title: t.title.clone(),
                    visible: t.visible,
                })
                .collect(),
        }
    }
}

static TABS: Mutex<Option<Tabs>> = Mutex::new(None);

/// Whether a command comes from one of the tabs (lib.rs refuses them all,
/// whatever page or frame of the tab sends it).
pub fn from_tab(label: &str) -> bool {
    label.starts_with(LABEL)
}
/// What the island was last told.
static SHOWN: Mutex<Option<TabsView>> = Mutex::new(None);

/// `f` on the tabs. Never held across an await.
fn with_tabs<T>(f: impl FnOnce(&mut Tabs) -> T) -> T {
    let mut tabs = TABS.lock().unwrap_or_else(|e| e.into_inner());
    f(tabs.get_or_insert_with(|| Tabs { next: 1, ..Tabs::default() }))
}

/// Tells the island the tabs, when they differ from what it was told.
fn show(app: &AppHandle) {
    let view = with_tabs(|t| t.view());
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    if shown.as_ref() == Some(&view) || (shown.is_none() && view == TabsView::default()) {
        return;
    }
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "browser-tabs", &view);
    *shown = Some(view);
}

/// The site of an address, as the Agents card says it ("example.com").
fn host_of(url: &str) -> String {
    Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_default()
}

// ── Addresses ───────────────────────────────────────────────────────────────

/// Whether a tab may show `url`: a web page (http, https) or the empty
/// page, never one of Lumo's own. Tauri serves Lumo's pages, which can call
/// its commands, as `*.localhost` (tauri.localhost, ipc.localhost…), and in
/// a debug build from the dev server on port 1420. The user's own dev
/// servers on localhost are fine: Claude Code reaches them anyway.
pub fn allowed(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.ends_with(".localhost") {
        return false;
    }
    if cfg!(debug_assertions) && url.port_or_known_default() == Some(1420) {
        let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0");
        if local {
            return false;
        }
    }
    true
}

/// What subresources and frames may never load: Lumo's own pages.
fn blocked_urls() -> Vec<&'static str> {
    let mut urls = vec!["*://*.localhost/*", "*://*.localhost:*/*"];
    if cfg!(debug_assertions) {
        urls.extend(["*://localhost:1420/*", "*://127.0.0.1:1420/*", "*://[::1]:1420/*"]);
    }
    urls
}

/// The address an agent gave, as a tab opens it: `example.com` is
/// `https://example.com/`. Only http and https, and never Lumo's own pages.
fn normalize(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Give the address to open, e.g. https://example.com.".into());
    }
    let full = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    let url = Url::parse(&full).map_err(|_| format!("{raw} is not a web address."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https addresses open in the browser.".into());
    }
    if !allowed(&url) {
        return Err(format!("{raw} is one of Lumo's own pages, which agents can't open."));
    }
    Ok(url)
}

// ── What the hook and the island ask ────────────────────────────────────────

/// An agent of `chat` is about to open `url` (the chat's PreToolUse hook,
/// lumo-hook --browser-claim): the tab that call opens is that agent's.
pub fn claim(chat: &str, agent: &str, url: &str) {
    let url = normalize(url).map(|u| u.to_string()).unwrap_or_else(|_| url.trim().to_string());
    let agent = if agent.trim().is_empty() { MAIN } else { agent.trim() };
    with_tabs(|t| {
        let now = Instant::now();
        t.claims.retain(|c| now.duration_since(c.at) < CLAIM_LIFE);
        // A handful at most: an agent that never calls is soon forgotten.
        if t.claims.len() >= 64 {
            t.claims.remove(0);
        }
        t.claims.push(Claim { chat: chat.to_string(), agent: agent.to_string(), url, at: now });
    });
}

/// The agents of `chat` still open (chat_agents.rs, on each change): the
/// tabs of those that ended close.
pub fn agents_open(app: &AppHandle, chat: &str, ids: &[String]) {
    let gone = {
        let mut tabs = TABS.lock().unwrap_or_else(|e| e.into_inner());
        match tabs.as_mut() {
            Some(t) if t.open.iter().any(|tab| tab.chat == chat) => t.agents_open(chat, ids, Instant::now()),
            _ => return,
        }
    };
    if !gone.is_empty() {
        destroy(app, gone);
        show(app);
    }
}

/// Closes every tab: browsing was turned off.
pub fn close_all(app: &AppHandle) {
    let gone = {
        let mut tabs = TABS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(t) = tabs.as_mut() else { return };
        t.claims.clear();
        t.open.drain(..).map(|tab| tab.label).collect::<Vec<_>>()
    };
    if !gone.is_empty() {
        destroy(app, gone);
        show(app);
    }
}

/// Watch on an agent's row: its tab, the newest, the one the row names
/// (chat-agents.ts browserOf), comes on screen. Closing the window only
/// hides it again.
pub fn watch(app: &AppHandle, chat: &str, agent: &str) -> Result<(), String> {
    let (label, title) = with_tabs(|t| {
        let tab = t.open.iter_mut().filter(|tab| tab.chat == chat && tab.agent == agent).max_by_key(|tab| tab.n)?;
        tab.visible = true;
        Some((tab.label.clone(), window_title(&tab.url, &tab.title)))
    })
    .ok_or_else(|| "This agent has no browser tab open.".to_string())?;
    let Some(win) = app.get_webview_window(&label) else {
        forget(&label);
        show(app);
        return Err("This agent's tab has closed.".into());
    };
    let _ = win.set_title(&title);
    let _ = win.set_skip_taskbar(false);
    let _ = win.unminimize();
    let _ = win.center();
    let _ = win.show();
    let _ = win.set_focus();
    show(app);
    Ok(())
}

/// A watched tab's window title: the site first, which the page can't
/// choose (there is no address bar), then the page's own title.
fn window_title(url: &str, title: &str) -> String {
    let host = Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = if title.chars().count() > 80 { title.chars().take(79).chain(['…']).collect() } else { title };
    match (host.is_empty(), title.is_empty()) {
        (true, true) => "Lumo · browser".into(),
        (true, false) => format!("Lumo · browser · {title}"),
        (false, true) => format!("Lumo · {host}"),
        (false, false) => format!("Lumo · {host} · {title}"),
    }
}

/// A watched tab's window says its site and title again (they changed).
fn retitle(app: &AppHandle, label: &str) {
    let shown = with_tabs(|t| t.open.iter().find(|tab| tab.label == label && tab.visible).map(|tab| window_title(&tab.url, &tab.title)));
    if let (Some(title), Some(win)) = (shown, app.get_webview_window(label)) {
        let _ = win.set_title(&title);
    }
}

/// Takes a tab out of the list (its window is gone or going).
fn forget(label: &str) {
    with_tabs(|t| t.open.retain(|tab| tab.label != label));
}

/// Closes these tabs' windows, away from whatever thread asks.
fn destroy(app: &AppHandle, labels: Vec<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for label in labels {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.destroy();
            }
        }
    });
}

/// The idle timer: one task while any tab is open, asleep until the first
/// one is due to close (no CPU meanwhile), gone with the last tab.
fn start_timer(app: &AppHandle) {
    let start = with_tabs(|t| !std::mem::replace(&mut t.timer, true));
    if !start {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let (gone, next) = with_tabs(|t| {
                let gone = t.expired(Instant::now(), IDLE);
                let next = t.open.iter().map(|tab| tab.used + IDLE).min();
                if next.is_none() {
                    // Under the lock: a tab opening now starts a timer of its own.
                    t.timer = false;
                }
                (gone, next)
            });
            if !gone.is_empty() {
                destroy(&app, gone);
                show(&app);
            }
            let Some(next) = next else { break };
            tokio::time::sleep_until(tokio::time::Instant::from_std(next)).await;
        }
    });
}

// ── The calls ───────────────────────────────────────────────────────────────

/// One call of lumo-hook's browser tools: `{"tool", "input", "chat"}` in,
/// `{"text"}`, `{"text", "image"}` (a PNG) or `{"error"}` out.
pub async fn serve(app: &AppHandle, request: &Value) -> Value {
    let on = app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).chat_browser;
    if !on {
        return refuse(OFF);
    }
    let tool = request.get("tool").and_then(Value::as_str).unwrap_or("");
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    let chat = request.get("chat").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let done = match tool {
        "browser_open" => open(app, &chat, &input).await,
        "browser_read" => read(app, &chat, &input).await,
        "browser_click" => click(app, &chat, &input).await,
        "browser_type" => type_text(app, &chat, &input).await,
        "browser_scroll" => scroll(app, &chat, &input).await,
        "browser_screenshot" => screenshot(app, &chat, &input).await,
        "browser_close" => close(app, &chat, &input),
        _ => Err(format!("Lumo's browser has no tool called {tool}.")),
    };
    match done {
        Ok(answer) => answer,
        Err(message) => refuse(message),
    }
}

fn refuse(message: impl Into<String>) -> Value {
    json!({ "error": message.into() })
}

/// A number of the input. Only a JSON number, as the schema says: the
/// island's card (agent-browser.ts) reads no other, and what runs is what the
/// user allowed.
fn number(input: &Value, key: &str) -> Option<f64> {
    input.get(key)?.as_f64().filter(|n| n.is_finite())
}

fn whole(input: &Value, key: &str) -> Option<u32> {
    number(input, key).filter(|n| *n >= 0.0 && n.fract() == 0.0 && *n <= u32::MAX as f64).map(|n| n as u32)
}

/// A yes or no of the input: only a JSON boolean, as for `number`.
fn flag(input: &Value, key: &str, default: bool) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn no_tab(n: u32) -> String {
    format!("No tab {n} in this chat. Open one with browser_open.")
}

/// The window of tab `n` of `chat`, its use noted.
fn tab_window(app: &AppHandle, chat: &str, input: &Value) -> Result<(u32, WebviewWindow), String> {
    let n = whole(input, "tab").ok_or("Give tab: your tab's number, as browser_open gave it.")?;
    let label = with_tabs(|t| {
        let tab = t.find(chat, n)?;
        tab.used = Instant::now();
        Some(tab.label.clone())
    })
    .ok_or_else(|| no_tab(n))?;
    match app.get_webview_window(&label) {
        Some(win) => Ok((n, win)),
        None => {
            forget(&label);
            show(app);
            Err(no_tab(n))
        }
    }
}

/// Notes what a tab shows now; the island hears of a new site or title.
fn note_page(app: &AppHandle, label: &str, page: &Page) {
    with_tabs(|t| {
        if let Some(tab) = t.open.iter_mut().find(|tab| tab.label == label) {
            tab.url = page.url.clone();
            tab.title = page.title.clone();
            tab.used = Instant::now();
        }
    });
    retitle(app, label);
    show(app);
}

/// The tab is still wanted while it opens: browsing is on and nothing closed
/// it meanwhile. Closing a tab whose window isn't built yet finds no window
/// to destroy, so the one being built would be left behind.
fn kept(app: &AppHandle, label: &str) -> Result<(), String> {
    let on = app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).chat_browser;
    if !on {
        return Err(OFF.into());
    }
    if !with_tabs(|t| t.open.iter().any(|tab| tab.label == label)) {
        return Err("The tab was closed while it opened.".into());
    }
    Ok(())
}

/// What a tab shows: its title and address.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Page {
    title: String,
    url: String,
}

impl Page {
    fn heading(&self) -> String {
        let title = if self.title.trim().is_empty() { "(no title)" } else { self.title.trim() };
        format!("{title}\n{}", self.url)
    }
}

async fn page(win: &WebviewWindow) -> Page {
    let found = eval(win, "[document.title, location.href]").await.unwrap_or(Value::Null);
    Page {
        title: found[0].as_str().unwrap_or("").to_string(),
        url: found[1].as_str().unwrap_or("").to_string(),
    }
}

/// Then, when the page changed, what it is now.
fn changed(before: &Page, after: &Page) -> String {
    if before == after { String::new() } else { format!("\nNow: {}", after.heading()) }
}

async fn open(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let url = normalize(input.get("url").and_then(Value::as_str).unwrap_or(""))?;
    if input.get("tab").is_some_and(|t| !t.is_null()) {
        // A tab that has its agent: a claim made for this call (lumo-hook
        // makes none now) is not left for another agent's new tab.
        with_tabs(|t| t.take_claim(chat, url.as_str(), Instant::now()));
        let (n, win) = tab_window(app, chat, input)?;
        load(&win, &url).await?;
        let now = page(&win).await;
        note_page(app, win.label(), &now);
        return Ok(json!({ "text": format!("Tab {n}: {}\nUse browser_read with tab {n} to read it.", now.heading()) }));
    }
    let now = Instant::now();
    let (n, label) = with_tabs(|t| {
        if t.open.len() >= MAX_TABS {
            return Err(format!("{MAX_TABS} tabs are open, the most Lumo keeps: close one first with browser_close."));
        }
        let agent = t.take_claim(chat, url.as_str(), now).unwrap_or_else(|| MAIN.to_string());
        let n = t.next.max(1);
        t.next = n + 1;
        let label = format!("{LABEL}{n}");
        t.open.push(Tab {
            n,
            chat: chat.to_string(),
            agent,
            label: label.clone(),
            url: url.to_string(),
            title: String::new(),
            used: now,
            opened: now,
            visible: false,
            seen: false,
        });
        Ok((n, label))
    })?;
    show(app);
    start_timer(app);
    let win = match create(app, &label) {
        Ok(win) => win,
        Err(err) => {
            forget(&label);
            destroy(app, vec![label]);
            show(app);
            return Err(err);
        }
    };
    // From here the window is Tauri's, so closing the tab finds it; while it
    // was built, nothing could: asked again.
    let ready = async {
        kept(app, &label)?;
        setup(&win).await?;
        load(&win, &url).await?;
        kept(app, &label)
    }
    .await;
    if let Err(err) = ready {
        forget(&label);
        let _ = win.destroy();
        show(app);
        return Err(err);
    }
    let now = page(&win).await;
    note_page(app, &label, &now);
    Ok(json!({ "text": format!("Tab {n}: {}\nUse browser_read with tab {n} to read it.", now.heading()) }))
}

/// A new hidden tab's window, showing nothing yet.
fn create(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let blank: Url = "about:blank".parse().map_err(|_| "about:blank".to_string())?;
    let profile = crate::platform::local_dir().join(PROFILE_DIR);
    let handle = app.clone();
    let tab_label = label.to_string();
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .title("Lumo · browser")
        .inner_size(1280.0, 800.0)
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        // As in a release, so the end-to-end tests' debug build is the same.
        .devtools(false)
        .incognito(true)
        .data_directory(profile)
        .additional_browser_args(AGENT_BROWSER_ARGS)
        .on_navigation(allowed)
        // A pop-up opens in the same tab instead, when it may.
        .on_new_window(move |url, _| {
            if allowed(&url) && url.as_str() != "about:blank" {
                let app = handle.clone();
                let label = tab_label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(win) = app.get_webview_window(&label) {
                        let _ = win.navigate(url);
                    }
                });
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .on_document_title_changed(|win, title| {
            let label = win.label().to_string();
            with_tabs(|t| {
                if let Some(tab) = t.open.iter_mut().find(|tab| tab.label == label) {
                    tab.title = title.clone();
                }
            });
            retitle(win.app_handle(), &label);
            show(win.app_handle());
        })
        // A new page, the agent's or a click of the user watching: the
        // window's title says its site at once.
        .on_page_load(|win, payload| {
            let label = win.label().to_string();
            let url = payload.url().to_string();
            let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            with_tabs(|t| {
                if let Some(tab) = t.open.iter_mut().find(|tab| tab.label == label) {
                    if started && tab.url != url {
                        // The last page's title isn't this one's.
                        tab.title.clear();
                    }
                    tab.url = url;
                }
            });
            retitle(win.app_handle(), &label);
            show(win.app_handle());
        })
        .build()
        .map_err(|e| format!("The browser tab could not open: {e}"))?;
    let hidden = win.clone();
    let app = app.clone();
    win.on_window_event(move |event| match event {
        // The user closes a tab they watch: it only hides again, the agent's still.
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = hidden.hide();
            let _ = hidden.set_skip_taskbar(true);
            let label = hidden.label().to_string();
            with_tabs(|t| {
                if let Some(tab) = t.open.iter_mut().find(|tab| tab.label == label) {
                    tab.visible = false;
                }
            });
            show(&app);
        }
        tauri::WindowEvent::Destroyed => {
            forget(hidden.label());
            show(&app);
        }
        _ => {}
    });
    Ok(win)
}

/// What a new tab needs before its first page: Lumo's own pages blocked as
/// anything a page loads (a frame of tauri.localhost could call Lumo), and
/// the page kept acting focused while hidden. A tab that can't be guarded
/// doesn't open.
async fn setup(win: &WebviewWindow) -> Result<(), String> {
    cdp(win, "Network.enable", json!({}), STEP).await?;
    cdp(win, "Network.setBlockedURLs", json!({ "urls": blocked_urls() }), STEP).await?;
    cdp(win, "Page.enable", json!({}), STEP).await?;
    cdp(win, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), STEP).await?;
    Ok(())
}

/// Loads `url` in a tab and waits for it.
async fn load(win: &WebviewWindow, url: &Url) -> Result<(), String> {
    let went = cdp(win, "Page.navigate", json!({ "url": url.as_str() }), LOAD_WAIT).await?;
    if let Some(error) = went["errorText"].as_str().filter(|e| !e.is_empty()) {
        return Err(format!("{url} could not be opened: {error}."));
    }
    settle(win).await;
    Ok(())
}

/// Waits for the page after an action: a moment for a navigation to start,
/// then until it is loaded, LOAD_WAIT at most (a page that never finishes is
/// read as it is). A page in the middle of changing can't answer: it is
/// asked again.
async fn settle(win: &WebviewWindow) {
    tokio::time::sleep(Duration::from_millis(300)).await;
    let deadline = Instant::now() + LOAD_WAIT;
    while Instant::now() < deadline {
        if eval(win, "document.readyState").await.is_ok_and(|s| s == "complete") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn read(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let (n, win) = tab_window(app, chat, input)?;
    let max = whole(input, "max_chars").map(|m| m as usize).unwrap_or(READ_CHARS).clamp(200, READ_CHARS_MAX);
    let found = eval(&win, READ_JS).await?;
    let now = Page { title: found["title"].as_str().unwrap_or("").into(), url: found["url"].as_str().unwrap_or("").into() };
    note_page(app, win.label(), &now);
    Ok(json!({ "text": read_text(n, &found, max) }))
}

/// browser_read's answer from what READ_JS found: the header, then the text
/// cut at `max` characters.
fn read_text(n: u32, found: &Value, max: usize) -> String {
    let int = |key: &str| found[key].as_f64().unwrap_or(0.0).round() as i64;
    let title = found["title"].as_str().unwrap_or("").trim();
    let title = if title.is_empty() { "(no title)" } else { title };
    let mut out = format!(
        "Tab {n} · {title}\nURL: {}\nScroll: {} of {} (viewport {})\n\n",
        found["url"].as_str().unwrap_or(""),
        int("y"),
        int("height"),
        int("viewport")
    );
    let text = found["text"].as_str().unwrap_or("");
    let total = text.chars().count();
    if total <= max {
        out.push_str(if text.trim().is_empty() { "(The page shows no text.)" } else { text });
    } else {
        out.extend(text.chars().take(max));
        out.push_str(&format!(
            "\n… {} more characters left out: scroll down and read again, or read with a larger max_chars.",
            total - max
        ));
    }
    out
}

/// The centre of element [k] of the last read, in CSS pixels, scrolled
/// into view first.
async fn point_of(win: &WebviewWindow, k: u32) -> Result<(f64, f64), String> {
    let found = eval(win, &REF_POINT_JS.replace("__REF__", &k.to_string())).await?;
    match (found["x"].as_f64(), found["y"].as_f64()) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(format!("No element [{k}]: read the page again.")),
    }
}

/// Where to click: ref, or x and y of the last screenshot.
async fn target(win: &WebviewWindow, input: &Value) -> Result<((f64, f64), String), String> {
    let r = whole(input, "ref");
    let x = number(input, "x");
    let y = number(input, "y");
    match (r, x, y) {
        (Some(k), None, None) => Ok((point_of(win, k).await?, format!("[{k}]"))),
        (None, Some(x), Some(y)) => {
            // The screenshot's pixels are the device's: CSS pixels times the scale.
            let scale = eval(win, "devicePixelRatio").await.ok().and_then(|v| v.as_f64()).filter(|s| *s > 0.0).unwrap_or(1.0);
            Ok(((x / scale, y / scale), format!("{}, {}", x.round(), y.round())))
        }
        (Some(_), _, _) => Err("Give either ref or x and y, not both.".into()),
        _ => Err("Give ref, from browser_read, or x and y, from browser_screenshot.".into()),
    }
}

/// A real click of the left button at (x, y), in CSS pixels.
async fn mouse_click(win: &WebviewWindow, (x, y): (f64, f64)) -> Result<(), String> {
    cdp(win, "Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }), STEP).await?;
    let press = json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 });
    cdp(win, "Input.dispatchMouseEvent", press, STEP).await?;
    let release = json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1 });
    cdp(win, "Input.dispatchMouseEvent", release, STEP).await?;
    Ok(())
}

async fn click(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let (n, win) = tab_window(app, chat, input)?;
    let before = page(&win).await;
    let (at, what) = target(&win, input).await?;
    mouse_click(&win, at).await?;
    settle(&win).await;
    let after = page(&win).await;
    note_page(app, win.label(), &after);
    let what = if what.starts_with('[') { what } else { format!("at {what}") };
    Ok(json!({ "text": format!("Clicked {what} on tab {n}.{}", changed(&before, &after)) }))
}

async fn type_text(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let (n, win) = tab_window(app, chat, input)?;
    let text = input.get("text").and_then(Value::as_str).ok_or("Give text: what to type.")?;
    let before = page(&win).await;
    let field = match whole(input, "ref") {
        Some(k) => {
            mouse_click(&win, point_of(&win, k).await?).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            format!(" in [{k}]")
        }
        None => String::new(),
    };
    if flag(input, "clear", true) {
        let selected = eval(&win, CLEAR_JS).await?;
        if selected == "none" {
            return Err("Nothing on the page has the focus: give ref, the field's [k] from browser_read.".into());
        }
    }
    if !text.is_empty() {
        cdp(&win, "Input.insertText", json!({ "text": text }), STEP).await?;
    }
    let submit = flag(input, "submit", false);
    if submit {
        let key = |kind: &str| {
            json!({ "type": kind, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13, "text": "\r" })
        };
        cdp(&win, "Input.dispatchKeyEvent", key("keyDown"), STEP).await?;
        let mut up = key("keyUp");
        if let Some(fields) = up.as_object_mut() {
            fields.remove("text");
        }
        cdp(&win, "Input.dispatchKeyEvent", up, STEP).await?;
        settle(&win).await;
    }
    let after = page(&win).await;
    note_page(app, win.label(), &after);
    let shown: String = text.chars().take(60).collect();
    let more = if text.chars().count() > 60 { "…" } else { "" };
    let then = if submit { " and pressed Enter" } else { "" };
    Ok(json!({ "text": format!("Typed \"{shown}{more}\"{field} on tab {n}{then}.{}", changed(&before, &after)) }))
}

async fn scroll(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let (n, win) = tab_window(app, chat, input)?;
    let down = match input.get("direction").and_then(Value::as_str).map(str::trim) {
        Some("down") => true,
        Some("up") => false,
        _ => return Err("Give direction: up or down.".into()),
    };
    let pages = number(input, "pages").filter(|p| *p > 0.0).unwrap_or(1.0).min(20.0);
    let size = eval(&win, "[innerWidth, innerHeight]").await?;
    let (w, h) = (size[0].as_f64().unwrap_or(1280.0), size[1].as_f64().unwrap_or(800.0));
    let delta = 0.8 * h * pages * if down { 1.0 } else { -1.0 };
    let before = eval(&win, SCROLL_JS).await?;
    let wheel = json!({ "type": "mouseWheel", "x": w / 2.0, "y": h / 2.0, "deltaX": 0, "deltaY": delta });
    cdp(&win, "Input.dispatchMouseEvent", wheel, STEP).await?;
    // A smooth scroll takes a moment.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mut now = eval(&win, SCROLL_JS).await?;
    if now[0] == before[0] {
        // The wheel moved nothing (a page that only scrolls itself, or one
        // not drawn yet): the page is scrolled instead.
        let _ = eval(&win, &format!("window.scrollBy(0, {delta})")).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        now = eval(&win, SCROLL_JS).await?;
    }
    with_tabs(|t| {
        if let Some(tab) = t.find(chat, n) {
            tab.used = Instant::now();
        }
    });
    let int = |v: &Value| v.as_f64().unwrap_or(0.0).round() as i64;
    let way = if down { "down" } else { "up" };
    Ok(json!({ "text": format!("Scrolled {way} on tab {n}. Scroll: {} of {} (viewport {}).", int(&now[0]), int(&now[1]), int(&now[2])) }))
}

async fn screenshot(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let (n, win) = tab_window(app, chat, input)?;
    let shot = cdp(&win, "Page.captureScreenshot", json!({ "format": "png" }), SHOT_LIMIT).await?;
    let data = shot["data"].as_str().filter(|d| !d.is_empty()).ok_or("The tab gave no picture.")?;
    let (w, h) = png_size(data).unwrap_or((0, 0));
    Ok(json!({
        "image": data,
        "text": format!("Tab {n}, {w}×{h} pixels. browser_click takes x, y in these pixels."),
    }))
}

fn close(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let n = whole(input, "tab").ok_or("Give tab: the number of the tab to close.")?;
    let label = with_tabs(|t| {
        let i = t.open.iter().position(|tab| tab.chat == chat && tab.n == n)?;
        Some(t.open.remove(i).label)
    })
    .ok_or_else(|| no_tab(n))?;
    destroy(app, vec![label]);
    show(app);
    Ok(json!({ "text": format!("Tab {n} closed.") }))
}

/// A PNG's width and height, from the start of its base64.
fn png_size(base64: &str) -> Option<(u32, u32)> {
    // 24 bytes: the signature, IHDR's length and name, then width and height.
    let bytes = base64_start(base64.get(..32)?)?;
    if bytes.get(..8)? != b"\x89PNG\r\n\x1a\n" || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    Some((be(16), be(20)))
}

/// Base64 without padding to bytes (whole groups of four only).
fn base64_start(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::new();
    for group in text.as_bytes().chunks_exact(4) {
        let n = group.iter().try_fold(0u32, |acc, c| Some((acc << 6) | value(*c)?))?;
        out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]);
    }
    Some(out)
}

// ── The page's side ─────────────────────────────────────────────────────────

/// The page as text, in reading order, each link, button and field numbered
/// `[k] role "label"` and marked `data-lumo-ref="k"` for browser_click and
/// browser_type. A control that holds others or lines of text (a card-sized
/// link, an app's `<div onclick>`) gets its number and only its own label,
/// and what it holds is read on, numbered too; so is what a control of no
/// size holds. What isn't shown (display none, visibility hidden,
/// aria-hidden, no size) is left out. One evaluation, nothing kept.
const READ_JS: &str = r#"(function () {
  var SEL = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable]:not([contenteditable=false])';
  var old = document.querySelectorAll('[data-lumo-ref]');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-lumo-ref');
  var out = '', k = 0, seen = 0, NODES = 60000, CAP = 400000;
  function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function quote(s) { return '"' + squash(s).replace(/"/g, "'") + '"'; }
  function line() { if (out && out.charAt(out.length - 1) !== '\n') out += '\n'; }
  function label(el) {
    var l = el.getAttribute('aria-label') || '';
    var by = el.getAttribute('aria-labelledby');
    if (!l && by) l = by.split(/\s+/).map(function (id) { var e = document.getElementById(id); return e ? e.innerText : ''; }).join(' ');
    var field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    if (!l && el.labels && el.labels.length) l = el.labels[0].innerText;
    if (!l && !field) l = el.innerText;
    if (!l && el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) l = el.value;
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (!l && el.querySelector) { var img = el.querySelector('img[alt]'); if (img) l = img.alt; }
    if (!l) l = el.getAttribute('name') || '';
    l = squash(l);
    return l.length > 80 ? l.slice(0, 79) + '…' : l;
  }
  function role(el) {
    var r = el.getAttribute('role');
    if (r) return r;
    var t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      var ty = (el.type || 'text').toLowerCase();
      if (/^(submit|button|reset|image)$/.test(ty)) return 'button';
      return ty === 'text' ? 'textbox' : ty;
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }
  function sized(el) {
    var r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  // A control that is a whole part of the page: its own controls, or more
  // than a line of text. Fields and editors stay one control.
  function holder(el) {
    if (el === document.body) return true;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return false;
    return !!el.querySelector(SEL) || /\n/.test(el.innerText || '');
  }
  // Its number and its own name only (aria-label, title): what it holds follows.
  function mark(el) {
    k++;
    el.setAttribute('data-lumo-ref', String(k));
    var own = squash(el.getAttribute('aria-label') || el.getAttribute('title') || '');
    out += ' [' + k + '] ' + role(el) + (own ? ' ' + quote(own.length > 80 ? own.slice(0, 79) + '…' : own) : '') + ' ';
  }
  function control(el) {
    k++;
    el.setAttribute('data-lumo-ref', String(k));
    var ro = role(el), text = '[' + k + '] ' + ro + ' ' + quote(label(el));
    var t = el.tagName, ty = (el.type || '').toLowerCase();
    if (t === 'INPUT' && (ty === 'checkbox' || ty === 'radio')) {
      if (el.checked) text += ' (checked)';
    } else if ((t === 'INPUT' && ro !== 'button') || t === 'TEXTAREA') {
      var v = ty === 'password' ? (el.value ? '•••' : '') : String(el.value || '');
      text += ' = ' + quote(v.length > 200 ? v.slice(0, 199) + '…' : v);
    } else if (t === 'SELECT') {
      var o = el.options[el.selectedIndex];
      text += ' = ' + quote(o ? o.text : '');
    } else if (el.getAttribute('aria-checked') === 'true') {
      text += ' (checked)';
    } else if (el.isContentEditable && ro === 'textbox') {
      text = '[' + k + '] textbox ' + quote(label(el) === squash(el.innerText) ? '' : label(el)) + ' = ' + quote(el.innerText.slice(0, 200));
    }
    out += ' ' + text + ' ';
  }
  function walk(node) {
    if (++seen > NODES || out.length > CAP) return;
    if (node.nodeType === 3) { out += node.nodeValue.replace(/\s+/g, ' '); return; }
    if (node.nodeType !== 1) return;
    var el = node, tag = el.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|IFRAME|SVG|svg)$/.test(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return;
    var block = !/^inline/.test(s.display) && s.display !== 'contents';
    if (block) line();
    if (el.matches(SEL) && sized(el) && !holder(el)) {
      control(el);
    } else if (el.matches(SEL) && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      if (sized(el)) mark(el);
      for (var d = el.firstChild; d; d = d.nextSibling) walk(d);
    } else if (el.matches(SEL)) {
      // A field of no size: nothing to read or reach.
    } else if (tag === 'IMG') {
      var alt = squash(el.alt);
      if (alt) out += ' ' + alt + ' ';
    } else if (tag === 'BR') {
      line();
    } else {
      for (var c = el.firstChild; c; c = c.nextSibling) walk(c);
    }
    if (block) line();
  }
  if (document.body) walk(document.body);
  var lines = out.split('\n').map(function (l) { return l.replace(/ {2,}/g, ' ').trim(); }).filter(function (l) { return l; });
  return {
    title: document.title,
    url: location.href,
    y: window.scrollY,
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    text: lines.join('\n')
  };
})()"#;

/// Element [__REF__] of the last read, scrolled into view: the centre of
/// what shows of it, in CSS pixels, or null.
const REF_POINT_JS: &str = r#"(function () {
  var el = document.querySelector('[data-lumo-ref="__REF__"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var r = el.getBoundingClientRect();
  var left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
  var top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
  if (right <= left || bottom <= top) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
})()"#;

/// Selects all of the field that has the focus, so what is typed replaces
/// it: "none" when nothing has the focus.
const CLEAR_JS: &str = r#"(function () {
  var el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return 'none';
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.select === 'function') { el.select(); return 'selected'; }
  if (el.isContentEditable) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return 'selected';
  }
  return 'kept';
})()"#;

/// Where the page is scrolled: [y, height, viewport].
const SCROLL_JS: &str = "[window.scrollY, document.documentElement.scrollHeight, window.innerHeight]";

// ── The DevTools protocol ───────────────────────────────────────────────────

/// Runs `expression` in the tab's page: its value, or what it threw.
async fn eval(win: &WebviewWindow, expression: &str) -> Result<Value, String> {
    let answer = cdp(win, "Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": false }), STEP).await?;
    if let Some(details) = answer.get("exceptionDetails") {
        let said = details["exception"]["description"].as_str().or_else(|| details["text"].as_str()).unwrap_or("the page's script failed");
        return Err(format!("The page refused: {said}"));
    }
    Ok(answer["result"]["value"].clone())
}

/// One DevTools protocol call on the tab's own webview (never a debugging
/// port), answered within `limit`. The call is made on the main thread,
/// which never waits for it: the answer comes back through a channel.
#[cfg(windows)]
async fn cdp(win: &WebviewWindow, method: &str, params: Value, limit: Duration) -> Result<Value, String> {
    use std::sync::Arc;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use wv2_core::HSTRING;

    type Answer = tokio::sync::oneshot::Sender<Result<String, String>>;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    // Only the closure and the handler hold the answer's sender: one dropped
    // without running (the tab closed first) drops it, and the call ends at
    // once ("The tab closed.") instead of waiting out `limit`.
    let inside: Arc<Mutex<Option<Answer>>> = Arc::new(Mutex::new(Some(tx)));
    let give = |slot: &Arc<Mutex<Option<Answer>>>, answer: Result<String, String>| {
        if let Some(tx) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(answer);
        }
    };
    let name = method.to_string();
    let json = params.to_string();
    let queued = win.with_webview(move |webview| {
        let done = inside.clone();
        let call = || -> wv2_core::Result<()> {
            // SAFETY: WebView2's own calls, on the main thread with_webview runs us on.
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, answer| {
                    let answer = match result {
                        Ok(()) => Ok(answer),
                        Err(err) => Err(cdp_error(&answer, &err.message())),
                    };
                    if let Some(tx) = done.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        let _ = tx.send(answer);
                    }
                    Ok(())
                }));
                core.CallDevToolsProtocolMethod(&HSTRING::from(name.as_str()), &HSTRING::from(json.as_str()), &handler)
            }
        };
        if let Err(err) = call() {
            give(&inside, Err(format!("The tab could not be reached: {}", err.message())));
        }
    });
    if let Err(err) = queued {
        return Err(format!("The tab could not be reached: {err}"));
    }
    match tokio::time::timeout(limit, rx).await {
        Ok(Ok(Ok(text))) => Ok(serde_json::from_str(&text).unwrap_or(Value::Null)),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err("The tab closed.".into()),
        Err(_) => Err(format!("The tab didn't answer within {} s ({method}).", limit.as_secs())),
    }
}

#[cfg(not(windows))]
async fn cdp(_win: &WebviewWindow, _method: &str, _params: Value, _limit: Duration) -> Result<Value, String> {
    Err("The browser needs Windows.".into())
}

/// A failed DevTools call, readable: the protocol's own message
/// (`{"code":…,"message":…}`) when it gave one, else Windows'.
fn cdp_error(answer: &str, fallback: &str) -> String {
    let said = serde_json::from_str::<Value>(answer).ok().and_then(|v| v["message"].as_str().map(str::to_string));
    let said = said.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| fallback.trim().to_string());
    format!("The browser refused: {said}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_tab_never_shows_lumos_own_pages() {
        for ok in ["https://example.com/a?b=1", "http://example.com", "about:blank", "http://localhost:3000/", "http://127.0.0.1:8080/x", "http://localhost/"] {
            assert!(allowed(&url(ok)), "{ok}");
        }
        for refused in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://ipc.localhost/plugin",
            "asset://localhost/x",
            "http://asset.localhost/C:/x",
            "http://x.localhost:8080/",
            "http://TAURI.LOCALHOST./",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,hi",
            "tauri://localhost/",
            "ftp://example.com/",
        ] {
            assert!(!allowed(&url(refused)), "{refused}");
        }
        // The dev server serves Lumo's own pages in a debug build.
        assert_eq!(allowed(&url("http://localhost:1420/")), !cfg!(debug_assertions));
        assert_eq!(allowed(&url("http://127.0.0.1:1420/settings.html")), !cfg!(debug_assertions));
        assert!(blocked_urls().contains(&"*://*.localhost/*") && blocked_urls().contains(&"*://*.localhost:*/*"));
        assert_eq!(blocked_urls().iter().any(|u| u.contains("1420")), cfg!(debug_assertions));
    }

    #[test]
    fn an_address_without_its_scheme_is_https_and_only_the_web_opens() {
        assert_eq!(normalize("example.com").unwrap().as_str(), "https://example.com/");
        assert_eq!(normalize("  https://example.com/a b ").unwrap().as_str(), "https://example.com/a%20b");
        assert_eq!(normalize("localhost:3000/x").unwrap().as_str(), "https://localhost:3000/x");
        assert_eq!(normalize("http://127.0.0.1:5173/").unwrap().as_str(), "http://127.0.0.1:5173/");
        assert!(normalize("").is_err());
        assert!(normalize("file:///C:/x").is_err());
        assert!(normalize("ftp://example.com").is_err());
        assert!(normalize("javascript:alert(1)").is_err());
        assert!(normalize("http://tauri.localhost/").unwrap_err().contains("Lumo's own"));
        assert!(normalize("ipc.localhost").is_err());
    }

    fn tab(n: u32, chat: &str, agent: &str, at: Instant) -> Tab {
        Tab {
            n,
            chat: chat.into(),
            agent: agent.into(),
            label: format!("{LABEL}{n}"),
            url: format!("https://www.site{n}.com/page"),
            title: format!("Site {n}"),
            used: at,
            opened: at,
            visible: false,
            seen: false,
        }
    }

    #[test]
    fn a_new_tab_is_the_agent_s_that_claimed_its_address_and_else_the_conversation_s() {
        let t0 = Instant::now();
        let mut tabs = Tabs { next: 1, ..Tabs::default() };
        let claim = |chat: &str, agent: &str, url: &str, at: Instant| Claim { chat: chat.into(), agent: agent.into(), url: url.into(), at };
        tabs.claims.push(claim("c1", "a1", "https://example.com/", t0));
        tabs.claims.push(claim("c1", "a2", "https://example.com/", t0 + Duration::from_secs(1)));
        tabs.claims.push(claim("c2", "b1", "https://other.com/", t0));
        let now = t0 + Duration::from_secs(2);
        assert_eq!(tabs.take_claim("c1", "https://example.com/", now).as_deref(), Some("a1"), "the oldest first");
        assert_eq!(tabs.take_claim("c2", "https://example.com/", now), None, "another chat's claim is not ours");
        assert_eq!(tabs.take_claim("c1", "https://example.com/", now).as_deref(), Some("a2"));
        assert_eq!(tabs.take_claim("c1", "https://example.com/", now), None, "each claim once");
        // A claim no call took is forgotten.
        let late = t0 + CLAIM_LIFE + Duration::from_secs(1);
        assert_eq!(tabs.take_claim("c2", "https://other.com/", late), None);
        assert!(tabs.claims.is_empty());
    }

    #[test]
    fn a_tab_closes_with_its_agent_and_the_conversation_s_stays() {
        let t0 = Instant::now();
        let mut tabs = Tabs { next: 5, ..Tabs::default() };
        tabs.open = vec![tab(1, "c1", "a1", t0), tab(2, "c1", MAIN, t0), tab(3, "c2", "a1", t0), tab(4, "c1", "a2", t0)];
        let ids = vec!["a1".to_string(), "a2".to_string()];
        assert!(tabs.agents_open("c1", &ids, t0).is_empty());
        // a2 ends: its tab goes; another chat's agent of the same id stays.
        assert_eq!(tabs.agents_open("c1", &["a1".to_string()], t0), [format!("{LABEL}4")]);
        assert_eq!(tabs.agents_open("c1", &[], t0), [format!("{LABEL}1")]);
        assert_eq!(tabs.open.iter().map(|t| t.n).collect::<Vec<_>>(), [2, 3]);
        // An agent the card hasn't listed yet keeps its tab a while.
        tabs.open.push(tab(5, "c2", "new", t0));
        assert!(tabs.agents_open("c2", &["a1".to_string()], t0 + Duration::from_secs(1)).is_empty());
        assert_eq!(tabs.agents_open("c2", &["a1".to_string()], t0 + UNSEEN_GRACE), [format!("{LABEL}5")]);
    }

    #[test]
    fn a_tab_unused_for_ten_minutes_closes() {
        let t0 = Instant::now();
        let mut tabs = Tabs { next: 3, ..Tabs::default() };
        tabs.open = vec![tab(1, "c1", "a1", t0), tab(2, "c1", MAIN, t0 + Duration::from_secs(60))];
        assert!(tabs.expired(t0 + IDLE - Duration::from_secs(1), IDLE).is_empty());
        assert_eq!(tabs.expired(t0 + IDLE, IDLE), [format!("{LABEL}1")]);
        assert_eq!(tabs.open.len(), 1);
    }

    #[test]
    fn the_island_sees_each_tab_s_chat_agent_and_site() {
        let t0 = Instant::now();
        let mut tabs = Tabs { next: 2, ..Tabs::default() };
        tabs.open = vec![tab(1, "c1", "a1", t0)];
        tabs.open[0].visible = true;
        let view = serde_json::to_value(tabs.view()).unwrap();
        assert_eq!(
            view,
            json!({ "tabs": [{ "chat": "c1", "agent": "a1", "tab": 1, "host": "site1.com", "title": "Site 1", "visible": true }] })
        );
        assert_eq!(host_of("http://localhost:3000/x"), "localhost");
        assert_eq!(host_of("about:blank"), "");
    }

    #[test]
    fn what_browser_read_gives_has_a_header_and_is_cut_where_asked() {
        let found = json!({ "title": "Hello", "url": "https://example.com/", "y": 0, "height": 2400.4, "viewport": 800, "text": "Hello from e2e\n[1] button \"Go\"" });
        let text = read_text(3, &found, 12_000);
        assert!(text.starts_with("Tab 3 · Hello\nURL: https://example.com/\nScroll: 0 of 2400 (viewport 800)\n\nHello from e2e\n[1] button \"Go\""), "{text}");
        let long = json!({ "title": "", "url": "u", "text": "é".repeat(500) });
        let cut = read_text(1, &long, 200);
        assert!(cut.contains("(no title)") && cut.contains("300 more characters left out"), "{cut}");
        assert_eq!(cut.matches('é').count(), 200);
        assert!(read_text(1, &json!({ "text": "" }), 100).contains("no text"));
    }

    #[test]
    fn a_screenshot_says_its_size() {
        // A 1×1 PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        assert_eq!(png_size(png), Some((1, 1)));
        // 1280×800: the header only.
        let header = [b"\x89PNG\r\n\x1a\n".as_slice(), &[0, 0, 0, 13], b"IHDR", &1280u32.to_be_bytes(), &800u32.to_be_bytes()].concat();
        let b64 = crate::claude::base64_for(&header);
        assert_eq!(png_size(&b64), Some((1280, 800)));
        assert_eq!(png_size("not a png at all, really not one"), None);
        assert_eq!(png_size("short"), None);
    }

    #[test]
    fn numbers_and_flags_are_json_ones_only_as_the_card_reads_them() {
        let input = json!({ "tab": 2, "ref": "7", "x": 10.5, "bad": "x", "neg": -1, "half": 1.5, "clear": "false", "submit": true });
        assert_eq!(whole(&input, "tab"), Some(2));
        assert_eq!(whole(&input, "ref"), None, "a number as text is no number");
        assert_eq!(number(&input, "x"), Some(10.5));
        assert_eq!(whole(&input, "bad"), None);
        assert_eq!(whole(&input, "neg"), None);
        assert_eq!(whole(&input, "half"), None);
        assert!(flag(&input, "clear", true), "text is no flag: the default");
        assert!(flag(&input, "submit", false));
        assert!(flag(&input, "missing", true) && !flag(&input, "missing", false));
    }

    #[test]
    fn a_watched_tab_s_title_starts_with_its_site() {
        assert_eq!(window_title("https://www.example.com/a", "Sign in"), "Lumo · www.example.com · Sign in");
        assert_eq!(window_title("https://evil.example/", "Lumo:  enter\nyour key"), "Lumo · evil.example · Lumo: enter your key");
        assert_eq!(window_title("about:blank", ""), "Lumo · browser");
        assert_eq!(window_title("https://example.com/", " "), "Lumo · example.com");
        assert!(window_title("https://example.com/", &"x".repeat(200)).ends_with("x…"));
    }

    #[test]
    fn a_claim_outlives_the_permission_card() {
        assert!(CLAIM_LIFE > crate::pipe::DECISION_TIMEOUT);
        assert!(from_tab("agent-browser-3") && !from_tab("island") && !from_tab("settings"));
    }

    #[test]
    fn a_refused_devtools_call_says_why() {
        assert_eq!(cdp_error(r#"{"code":-32000,"message":"Cannot navigate to invalid URL"}"#, "E_FAIL"), "The browser refused: Cannot navigate to invalid URL");
        assert_eq!(cdp_error("", "Unspecified error "), "The browser refused: Unspecified error");
    }

    #[test]
    fn the_tabs_profile_has_its_own_arguments_and_no_debugging_port() {
        assert!(!AGENT_BROWSER_ARGS.contains("remote-debugging"));
        assert_ne!(AGENT_BROWSER_ARGS, crate::BROWSER_ARGS);
        assert!(AGENT_BROWSER_ARGS.contains("--disable-backgrounding-occluded-windows"));
        assert!(READ_JS.contains("data-lumo-ref") && REF_POINT_JS.contains("__REF__"));
    // The page's script: a regex's \n stays the two characters JavaScript reads.
    assert!(READ_JS.contains(r"/\n/.test"));
    }
}
