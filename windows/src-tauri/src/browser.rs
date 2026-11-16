// A browser for the island chat's agents (Settings → Security → "Let agents
// browse the web", off by default, Windows only).
//
// The chat's agents (Claude Code and the agents it starts, Codex, Copilot
// CLI, Cursor CLI, Antigravity CLI, the API providers and the local models,
// and their agents) open web pages in hidden tabs inside Lumo, so several of
// them browse at once and none of them touches the user's mouse. A tab is a hidden WebView2 window of its own
// (`agent-browser-<n>`), in a profile apart from the user's browser and
// from Lumo's own pages: an InPrivate one under `AgentBrowser`, with none of
// the user's cookies or accounts. Pages are real: their JavaScript runs, as
// in Edge.
//
// Each call of lumo-hook --mcp's browser tools (`browser_open`,
// `browser_read`…) comes here over the relay pipe as
// `{"lumo_browser": {"tool": …, "input": …, "chat": …}}` (pipe.rs, `serve`);
// the API providers' and the local models' come straight from their chat's
// tool loop (tools.rs `call_for_chat`, `call`). Each is answered with the
// page as text, a screenshot, what was done, or why not. Lumo drives each tab through the DevTools protocol WebView2 lets
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
// * What changes a page (open, click, type, scroll, close) waits for the
//   user's click on the island's card, as the chat's permission mode says:
//   Claude Code's own permission for Claude Code; Lumo's card for the other
//   CLIs (`AskTurn`, their own prompts let Lumo's tools through) and for the
//   API and local models (tools.rs). Reading and screenshots only look.
// * A tab belongs to the agent that opened it, and closes with it, or after
//   IDLE unused: Claude Code's PreToolUse hook says which agent (`claim`);
//   an API or local model's agent is known to the call itself; the other
//   CLIs' tabs are the conversation's.
//
// The island sees the tabs as `browser-tabs` (each tab's chat, agent and
// site), sent only when they change: one timer runs while a tab is open,
// asleep until the next one is due to close. A tab is never on screen: Watch
// shows it inside the island (views/browser-watch.ts), which asks for a
// picture of it (`frame`) only while that picture is on screen, and draws
// where the agent last clicked or typed (`Act`) over it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The conversation itself, not one of its agents.
const MAIN: &str = crate::computer_turns::MAIN;
/// The most tabs open at once, every chat together.
pub const MAX_TABS: usize = 8;
/// The MCP server the CLIs know Lumo's tools by (lumo-hook --mcp).
const SERVER: &str = "lumo";
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
/// The JPEG quality of the island's pictures of a tab (`frame`): enough to
/// read the page at the island's size, light enough for a few a second.
const FRAME_QUALITY: u32 = 70;
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
/// Never a sound: a tab nobody sees plays none (`--mute-audio`, and each
/// tab muted too, `mute`), and a video waits for a click to start.
const AGENT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
--mute-audio --autoplay-policy=user-gesture-required";

const OFF: &str = "Browsing is off in Lumo. Turn it on in Lumo's Settings, under Security.";
/// The user said no on the island's card.
const DENIED: &str = "The user said no to this on Lumo's card. Don't do it another way: ask them what to do.";
/// A call that needs Lumo's card, with no turn of its CLI running to ask for.
const TURN_OVER: &str = "This chat's turn is over: nothing was done. Answer the user, or wait for their next message.";
/// The chat is in Plan only.
const PLAN_ONLY: &str = "The chat is in Plan only: you may read pages already open and take screenshots, but not open, click, type or scroll. Say what you would do instead.";
/// The browser tools that only look: never a card.
pub const LOOKING: [&str; 2] = ["browser_read", "browser_screenshot"];
/// Every browser tool (hook/src/browser_tools.rs BROWSER_NAMES has the same).
pub const NAMES: [&str; 7] = ["browser_open", "browser_read", "browser_click", "browser_type", "browser_scroll", "browser_screenshot", "browser_close"];

#[derive(Debug, Clone)]
struct Tab {
    n: u32,
    chat: String,
    /// The Agents card's row id, or "main".
    agent: String,
    label: String,
    url: String,
    /// The address browser_open asked for, as `normalize` wrote it: what
    /// a CLI's stream names when it tells whose call it was (`agent_called`).
    asked: String,
    title: String,
    used: Instant,
    opened: Instant,
    /// Its agent was listed open on the Agents card once.
    seen: bool,
    /// What its agent did in it, oldest first (at most STEPS_KEPT), for
    /// the island's picture: the last one now, the others as steps done.
    acts: Vec<Act>,
    /// A page is loading in it (from its start to its end).
    loading: bool,
}

impl Tab {
    /// The number of what its agent last did in it: 0 before anything.
    fn last_seq(&self) -> u64 {
        self.acts.last().map_or(0, |a| a.seq)
    }
}

/// The steps each tab keeps for the island's picture.
const STEPS_KEPT: usize = 6;
/// Numbers each action, so the island sees a new one even when it is the same as the last.
static ACT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// What an agent did in its tab: the island draws its pointer where, the
/// box of what it clicked or typed in, and says what, under the tab's
/// picture while the user watches it.
#[derive(Debug, Clone, PartialEq)]
struct Act {
    /// "open", "click", "type", "scroll" or "read" (a read or a screenshot).
    kind: &'static str,
    /// The site opened, the name of what was clicked, what was typed
    /// ("•••" in a password field), or "down" or "up".
    what: String,
    /// Where on the page, in CSS pixels of the tab's viewport, when the
    /// action has a place: x, y, width, height.
    rect: Option<[f64; 4]>,
    /// The point the mouse went to, in the same pixels.
    point: Option<(f64, f64)>,
    /// The page's scroll then: the box moves with the page after.
    scroll_y: f64,
    at: Instant,
    /// Its number, one more than the action before (of any tab).
    seq: u64,
}

impl Act {
    fn new(kind: &'static str, what: String, rect: Option<[f64; 4]>, point: Option<(f64, f64)>, scroll_y: f64) -> Act {
        let seq = ACT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Act { kind, what, rect, point, scroll_y, at: Instant::now(), seq }
    }
}

/// Adds `act` to a tab's steps: a read, or a scroll the same way, after
/// the same takes its place (an agent reading again and again is one step).
fn remember(acts: &mut Vec<Act>, act: Act) {
    let same = acts.last().is_some_and(|last| last.kind == act.kind && last.what == act.what && matches!(act.kind, "read" | "scroll"));
    if same {
        acts.pop();
    }
    acts.push(act);
    if acts.len() > STEPS_KEPT {
        let extra = acts.len() - STEPS_KEPT;
        acts.drain(..extra);
    }
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
    /// The number of what its agent last did in it (`Act::seq`): Watch shows
    /// the tab its agent used last, which isn't always its newest.
    pub seq: u64,
}

impl Tabs {
    /// The agent of the oldest claim of `chat` for `url` (taken), forgetting
    /// the claims past CLAIM_LIFE.
    fn take_claim(&mut self, chat: &str, url: &str, now: Instant) -> Option<String> {
        self.claims.retain(|c| now.duration_since(c.at) < CLAIM_LIFE);
        let i = self.claims.iter().position(|c| c.chat == chat && c.url == url)?;
        Some(self.claims.remove(i).agent)
    }

    /// Notes that `agent` of `chat` is about to open `url`, for CLAIM_LIFE.
    fn add_claim(&mut self, chat: &str, agent: &str, url: String, now: Instant) {
        self.claims.retain(|c| now.duration_since(c.at) < CLAIM_LIFE);
        // A handful at most: an agent that never calls is soon forgotten.
        if self.claims.len() >= 64 {
            self.claims.remove(0);
        }
        self.claims.push(Claim { chat: chat.to_string(), agent: agent.to_string(), url, at: now });
    }

    /// `agent_called`: true when a tab became the agent's.
    fn agent_called(&mut self, chat: &str, agent: &str, tool: &str, input: &Value, now: Instant) -> bool {
        let n = input.get("tab").filter(|t| !t.is_null()).map(|_| whole(input, "tab"));
        let Some(n) = n else {
            if tool != "browser_open" {
                return false;
            }
            let Some(url) = input.get("url").and_then(Value::as_str) else { return false };
            let url = normalize(url).map(|u| u.to_string()).unwrap_or_else(|_| url.trim().to_string());
            let recent = |tab: &Tab| tab.chat == chat && tab.asked == url && now.duration_since(tab.opened) < CLAIM_LIFE;
            // Told again (agy repeats a step): the tab is the agent's already.
            if self.open.iter().any(|tab| recent(tab) && tab.agent == agent) {
                return false;
            }
            // The call reached Lumo first: the tab it opened as the conversation's.
            if let Some(tab) = self.open.iter_mut().filter(|tab| recent(tab) && tab.agent == MAIN).max_by_key(|tab| tab.n) {
                tab.agent = agent.to_string();
                return true;
            }
            self.add_claim(chat, agent, url, now);
            return false;
        };
        // A tab of the conversation the agent uses: the agent's (another agent's stays its own).
        match self.open.iter_mut().find(|tab| Some(tab.n) == n && tab.chat == chat && tab.agent == MAIN) {
            Some(tab) => {
                tab.agent = agent.to_string();
                true
            }
            None => false,
        }
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
                    seq: t.last_seq(),
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
    with_tabs(|t| t.add_claim(chat, agent, url, Instant::now()));
}

/// Lumo's browser tool an MCP call names, as a CLI's stream tells it: the
/// server `lumo` and one of NAMES, or, with no server, the two together
/// ("mcp__lumo__browser_open", Antigravity's "mcp_lumo_browser_open").
pub fn tool_of(server: &str, tool: &str) -> Option<&'static str> {
    let (server, tool) = (server.trim(), tool.trim());
    let name = if server.is_empty() {
        let lower = tool.to_ascii_lowercase();
        let rest = ["mcp__lumo__", "mcp_lumo_"].iter().find_map(|p| lower.strip_prefix(p).map(str::len))?;
        &tool[tool.len() - rest..]
    } else if server.eq_ignore_ascii_case(SERVER) {
        tool
    } else {
        return None;
    };
    NAMES.iter().find(|n| n.eq_ignore_ascii_case(name)).copied()
}

/// A call of Lumo's browser by agent `agent` of `chat`, as its CLI's own
/// stream tells it: Antigravity's and Codex's subagents, whose calls reach
/// Lumo through the conversation's one MCP server, which can't say whose
/// they are, so their tabs would all be the conversation's. The stream may
/// tell before the call reaches Lumo or after: a browser_open is claimed
/// for the agent, or the tab it just opened as the conversation's becomes
/// the agent's; a call on one of the conversation's tabs makes it the
/// agent's too. Then the agent's row says its site and has Watch.
pub fn agent_called(app: &AppHandle, chat: &str, agent: &str, tool: &str, input: &Value) {
    let agent = agent.trim();
    if chat.is_empty() || agent.is_empty() || agent == MAIN || !NAMES.contains(&tool) {
        return;
    }
    if with_tabs(|t| t.agent_called(chat, agent, tool, input, Instant::now())) {
        show(app);
    }
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

/// The tab of `agent` in `chat` it used last (else its newest), the one the
/// Agents card names (chat-agents.ts browserOf): an agent with several tabs
/// open at once is watched where it works now. Its window's label, number,
/// last action, and the address and title Lumo last saw there.
fn newest(t: &Tabs, chat: &str, agent: &str) -> Option<Newest> {
    let tab = t.open.iter().filter(|tab| tab.chat == chat && tab.agent == agent).max_by_key(|tab| (tab.last_seq(), tab.n))?;
    Some(Newest {
        label: tab.label.clone(),
        n: tab.n,
        acts: tab.acts.clone(),
        page: Page { title: tab.title.clone(), url: tab.url.clone() },
        loading: tab.loading,
    })
}

/// `newest`'s answer.
#[derive(Debug, Clone, PartialEq)]
struct Newest {
    label: String,
    n: u32,
    acts: Vec<Act>,
    page: Page,
    loading: bool,
}

/// `frame`'s error for an agent with no tab: the island stops asking.
pub const NO_TAB: &str = "This agent has no browser tab open.";

/// Watch (views/browser-watch.ts): a picture of what `agent`'s tab shows
/// now, its address, and what the agent last did there. Asked only while
/// the picture is on screen in the island; it neither shows the tab's
/// window nor keeps the tab from closing when unused. A tab whose window is
/// still being built answers `opening` with no picture (its window's
/// Destroyed takes a closed one off the list, so it is never forgotten
/// here: that would fail the agent's browser_open).
pub async fn frame(app: &AppHandle, chat: &str, agent: &str) -> Result<Value, String> {
    let Newest { label, n, acts, page: known, loading } = with_tabs(|t| newest(t, chat, agent)).ok_or_else(|| NO_TAB.to_string())?;
    let Some(win) = app.get_webview_window(&label) else {
        return Ok(json!({
            "tab": n, "opening": true, "url": known.url, "host": host_of(&known.url), "title": known.title,
            "steps": steps_json(&acts, Instant::now()),
        }));
    };
    // A page that has only begun to load has nothing drawn yet: its picture
    // would be blank (black, in a hidden tab). The island keeps the last one,
    // dimmed, until there is something to see.
    if loading && eval(&win, "document.readyState").await.map_or(true, |s| s == "loading") {
        return Ok(not_drawn(n, &known, &acts));
    }
    let shot = match cdp(&win, "Page.captureScreenshot", json!({ "format": "jpeg", "quality": FRAME_QUALITY }), SHOT_LIMIT).await {
        Ok(shot) => shot,
        Err(err) => {
            log_frame_error(&err);
            return Err(err);
        }
    };
    let image = shot["data"].as_str().filter(|d| !d.is_empty()).ok_or("The tab gave no picture.")?;
    // Still loading and next to nothing in the picture: not drawn yet either.
    if loading && image.len() < BLANK_SHOT {
        return Ok(not_drawn(n, &known, &acts));
    }
    // The page answers where it is scrolled; one changing, or one that
    // breaks the script, still has its picture, with the last address seen
    // and the viewport DevTools reports.
    let at = match eval(&win, FRAME_JS).await {
        Ok(at) if at.is_array() => at,
        _ => {
            // The window's own size, scrollbar included as in the picture
            // (DevTools' viewport leaves it out).
            let m = cdp(&win, "Page.getLayoutMetrics", json!({}), STEP).await.unwrap_or(Value::Null);
            let scale = win.scale_factor().unwrap_or(1.0);
            let (w, h) = win.inner_size().map(|s| (f64::from(s.width) / scale, f64::from(s.height) / scale)).unwrap_or((0.0, 0.0));
            json!([w, h, m["cssVisualViewport"]["pageY"], known.title, known.url])
        }
    };
    Ok(frame_json(n, &at, image, &acts, loading, Instant::now()))
}

/// A picture that failed goes in Lumo's log once, not every time it is asked again.
fn log_frame_error(err: &str) {
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last != err {
        *last = err.to_string();
        crate::log::line(format!("chat_browser_frame: {err}"));
    }
}

/// The steps for the island, oldest first.
fn steps_json(acts: &[Act], now: Instant) -> Value {
    Value::Array(acts.iter().map(|a| act_json(a, now)).collect())
}

fn act_json(a: &Act, now: Instant) -> Value {
    json!({
        "seq": a.seq,
        "kind": a.kind,
        "what": a.what,
        "rect": a.rect.map(|[x, y, w, h]| json!({ "x": x, "y": y, "w": w, "h": h })),
        "point": a.point.map(|(x, y)| json!({ "x": x, "y": y })),
        "scrollY": a.scroll_y,
        "ago": now.saturating_duration_since(a.at).as_millis() as u64,
    })
}

/// What `frame` gives the island: the picture (a JPEG, base64), the
/// viewport it shows in CSS pixels, where the page is scrolled, its address,
/// whether a page is loading, the last action with how long ago it was (ms)
/// and the steps before it.
/// Under this many base64 characters, a picture of a loading page is one
/// colour: the page isn't drawn yet. A drawn page's is many times more.
const BLANK_SHOT: usize = 12_000;

/// `frame`'s answer for a page not drawn yet: no picture (the island keeps
/// the last one), the address it loads, and what the agent did.
fn not_drawn(n: u32, known: &Page, acts: &[Act]) -> Value {
    json!({
        "tab": n, "image": "", "width": 0, "height": 0, "scrollY": 0,
        "title": known.title, "url": known.url, "host": host_of(&known.url),
        "loading": true,
        "action": acts.last().map(|a| act_json(a, Instant::now())),
        "steps": steps_json(acts, Instant::now()),
    })
}

fn frame_json(n: u32, at: &Value, image: &str, acts: &[Act], loading: bool, now: Instant) -> Value {
    let num = |i: usize| at[i].as_f64().filter(|v| v.is_finite()).unwrap_or(0.0);
    let url = at[4].as_str().unwrap_or("");
    let action = acts.last().map(|a| act_json(a, now));
    json!({
        "tab": n,
        "image": image,
        "width": num(0),
        "height": num(1),
        "scrollY": num(2),
        "title": at[3].as_str().unwrap_or(""),
        "url": url,
        "host": host_of(url),
        "loading": loading,
        "action": action,
        "steps": steps_json(acts, now),
    })
}

/// Notes what the agent did in tab `label`.
fn note_act(label: &str, act: Act) {
    with_tabs(|t| {
        if let Some(tab) = t.open.iter_mut().find(|tab| tab.label == label) {
            remember(&mut tab.acts, act);
        }
    });
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

// ── Who asks the user ───────────────────────────────────────────────────────
//
// Claude Code asks for its own browser calls (its PermissionRequest hook, the
// island's card). The other CLIs let Lumo's MCP tools through without asking
// (Codex's "approve", Copilot's --allow-tool lumo, Cursor's Mcp(lumo:*), agy's
// card skipped for them in hook/src/reply.rs), so for the turns they run
// Lumo asks itself: each turn is listed here while it lasts (`AskTurn`).

use crate::computer::Asks;

#[derive(Debug, Clone)]
struct Asker {
    id: u64,
    chat: String,
    /// The provider, for the chat's permission mode now (settings.rs permission_mode_for).
    provider: &'static str,
    /// The card's `lumo_agent`: the pill of the CLI asking (src/core/pills.ts).
    agent: &'static str,
    /// How the turn started.
    started: Asks,
    /// When it began (ms since 1970): a call the CLI sent before is an earlier turn's.
    begun_ms: u64,
}

static ASKERS: Mutex<Vec<Asker>> = Mutex::new(Vec::new());
static ASKER_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn askers() -> std::sync::MutexGuard<'static, Vec<Asker>> {
    ASKERS.lock().unwrap_or_else(|e| e.into_inner())
}

/// A turn of a CLI that doesn't ask for Lumo's tools itself, in chat `chat`:
/// from `begin` until it is dropped, its browser calls that change a page
/// wait for Lumo's card (as `mode` asks: none on Auto, refused on Plan only).
pub struct AskTurn {
    id: u64,
}

impl AskTurn {
    pub fn begin(provider: &'static str, chat: &str, agent: &'static str, mode: &str) -> AskTurn {
        let id = ASKER_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let begun_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        askers().push(Asker { id, chat: chat.to_string(), provider, agent, started: asks_for(provider, mode), begun_ms });
        AskTurn { id }
    }
}

impl Drop for AskTurn {
    fn drop(&mut self) {
        askers().retain(|a| a.id != self.id);
        TURN_ENDED.notify_waiters();
    }
}

/// Rings each time a turn ends: its cards leave the island.
static TURN_ENDED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Resolves once the turn `id` has ended (Stop, or its answer done).
async fn turn_over(id: u64) {
    loop {
        let woken = TURN_ENDED.notified();
        if !askers().iter().any(|a| a.id == id) {
            return;
        }
        woken.await;
    }
}

/// How a CLI's turn asks in permission `mode`, read as the chat shows it for
/// that provider: Antigravity CLI has modes of its own ("turbo"), the others
/// read theirs as Claude Code's (an old "turbo" is Ask for them, as the chat says).
fn asks_for(provider: &str, mode: &str) -> Asks {
    if provider == crate::antigravity_cli::PROVIDER {
        Asks::of(mode)
    } else {
        Asks::of(crate::claude_code::permission_mode(mode))
    }
}

/// The chat a call that named none is for: the only one Antigravity CLI is
/// asking for (agy doesn't always pass LUMO_CHAT_ID on to lumo-hook). None
/// with none or several, or with another CLI's turn running too: a call
/// can't be told apart from that CLI's.
fn only_asking_chat(list: &[Asker]) -> Option<String> {
    let first = &list.first()?.chat;
    let agy = |a: &Asker| a.provider == crate::antigravity_cli::PROVIDER;
    (!first.is_empty() && list.iter().all(|a| &a.chat == first && agy(a))).then(|| first.clone())
}

/// lumo-hook's `--tools=` for the `lumo` server of a CLI that lets Lumo's
/// tools run unasked: the email's kits as Security lets the AI have them
/// (`mail`, mail.rs ai_tools), the browser while agents may browse (its calls
/// marked as Lumo's to ask for, `browsercard`), and the island's tools.
pub fn kit(mail: &str, browser: bool) -> String {
    let mut kits: Vec<&str> = mail.split(',').map(str::trim).filter(|k| !k.is_empty()).collect();
    if browser {
        kits.push("browsercard");
    }
    kits.push("island");
    format!("--tools={}", kits.join(","))
}

/// Whether `tool` changes a page: the user is asked first.
pub fn changes(tool: &str) -> bool {
    NAMES.contains(&tool) && !LOOKING.contains(&tool)
}

/// Asks the user on the island's card for `tool` with `input`, as `asks`
/// says; `agent` is the card's `lumo_agent` (none: the chat's own provider).
/// Ok to go on, or why not.
pub async fn ask(app: &AppHandle, asks: Asks, agent: Option<&str>, tool: &str, input: &Value) -> Result<(), String> {
    if !changes(tool) {
        return Ok(());
    }
    match asks {
        Asks::Free => Ok(()),
        Asks::LookOnly => Err(PLAN_ONLY.into()),
        Asks::Card => {
            let mut card = json!({
                "hook_event_name": "PermissionRequest",
                "lumo_island": true,
                "tool_name": format!("mcp__lumo__{tool}"),
                "tool_input": input,
            });
            if let Some(agent) = agent {
                card["lumo_agent"] = json!(agent);
            }
            match crate::pipe::ask(app, card).await.as_deref() {
                Some("allow") => Ok(()),
                Some(_) => Err(DENIED.into()),
                None => Err("Lumo couldn't ask the user (the island is paused or busy). Try again in a moment.".into()),
            }
        }
    }
}

// ── The calls ───────────────────────────────────────────────────────────────

/// One call of lumo-hook's browser tools: `{"tool", "input", "chat"}` in,
/// `{"text"}`, `{"text", "image"}` (a PNG) or `{"error"}` out. The tab it
/// opens is the agent's Claude Code's hook claimed it for, else the
/// conversation's; a CLI turn that doesn't ask itself is asked for here.
pub async fn serve(app: &AppHandle, request: &Value) -> Value {
    let tool = request.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    let named = request.get("chat").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let asker = {
        let list = askers();
        let chat = if named.is_empty() { only_asking_chat(&list).unwrap_or_default() } else { named.clone() };
        list.iter().find(|a| a.chat == chat).cloned().map(|a| (chat, a))
    };
    let chat = asker.as_ref().map_or(named, |(chat, _)| chat.clone());
    if !is_on(app) {
        return refuse(OFF);
    }
    // A call Lumo has to ask for, from a CLI whose turn is over (stopped, or
    // a server kept between messages): nobody to ask, so nothing done.
    let card = request.get("card").and_then(Value::as_bool) == Some(true);
    if card && asker.is_none() && changes(&tool) {
        return refuse(TURN_OVER);
    }
    if let Some((_, a)) = &asker {
        // Sent before this turn began: an earlier turn's, which was stopped.
        let sent = request.get("sent_ms").and_then(Value::as_u64);
        if changes(&tool) && sent.is_some_and(|s| s < a.begun_ms) {
            return refuse(TURN_OVER);
        }
        let mode = app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).permission_mode_for(a.provider);
        let asked = async { Some(ask(app, a.started.stricter(asks_for(a.provider, &mode)), Some(a.agent), &tool, &input).await) };
        // The turn ending takes its card off the island (dropped, it settles).
        let ended = async {
            turn_over(a.id).await;
            None
        };
        match crate::pipe::first_of(asked, ended).await {
            None => return refuse(TURN_OVER),
            Some(Err(why)) => return refuse(why),
            Some(Ok(())) => {}
        }
        // Stop while the card waited: the turn is over, nothing is done.
        if changes(&tool) && !askers().iter().any(|x| x.id == a.id) {
            return refuse(TURN_OVER);
        }
    }
    call(app, &chat, None, &tool, &input).await
}

/// What the island's typing line says of a browser call: the site it opens, else "web".
pub fn activity(input: &Value) -> crate::claude_code::Activity {
    // As browser_open reads it: "example.com" is https://example.com/.
    let url = input.get("url").and_then(Value::as_str).map(|u| normalize(u).map(|u| u.to_string()).unwrap_or_else(|_| u.to_string()));
    match url.as_deref().map(host_of).filter(|h| !h.is_empty()) {
        Some(h) => crate::claude_code::Activity::new("read", h),
        None => crate::claude_code::Activity::new("web", ""),
    }
}

/// The system prompt's note for a model the chat calls itself, with the browser on.
pub fn note() -> String {
    format!(" {}", crate::browser_tool_defs::BROWSER_INSTRUCTIONS)
}

/// Agents may browse (Settings → Security), read from the settings file: for
/// the API providers' and local models' tool lists (tools.rs chat_tools).
pub fn enabled() -> bool {
    crate::settings::load().chat_browser
}

fn is_on(app: &AppHandle) -> bool {
    app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).chat_browser
}

/// Runs browser tool `tool` for chat `chat`, once the user was asked: the
/// tab it opens is `agent`'s (an API or local model's agent, api_agents.rs),
/// else the agent a claim names, else the conversation's.
pub async fn call(app: &AppHandle, chat: &str, agent: Option<&str>, tool: &str, input: &Value) -> Value {
    if !is_on(app) {
        return refuse(OFF);
    }
    if chat.is_empty() {
        return refuse("Lumo couldn't tell which chat this call is for.");
    }
    let done = match tool {
        "browser_open" => open(app, chat, agent, input).await,
        "browser_read" => read(app, chat, input).await,
        "browser_click" => click(app, chat, input).await,
        "browser_type" => type_text(app, chat, input).await,
        "browser_scroll" => scroll(app, chat, input).await,
        "browser_screenshot" => screenshot(app, chat, input).await,
        "browser_close" => close(app, chat, input),
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

async fn open(app: &AppHandle, chat: &str, agent: Option<&str>, input: &Value) -> Result<Value, String> {
    let url = normalize(input.get("url").and_then(Value::as_str).unwrap_or(""))?;
    if input.get("tab").is_some_and(|t| !t.is_null()) {
        // A tab that has its agent: a claim made for this call (lumo-hook
        // makes none now) is not left for another agent's new tab.
        with_tabs(|t| t.take_claim(chat, url.as_str(), Instant::now()));
        let (n, win) = tab_window(app, chat, input)?;
        note_act(win.label(), Act::new("open", host_of(url.as_str()), None, None, 0.0));
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
        // The caller's own agent (in Lumo, it can't be faked), else a claim.
        let claimed = t.take_claim(chat, url.as_str(), now);
        let agent = agent.filter(|a| !a.trim().is_empty()).map(str::to_string).or(claimed).unwrap_or_else(|| MAIN.to_string());
        // The agent's steps go on in its new tab: what it did before stays told.
        let mut acts = t
            .open
            .iter()
            .filter(|tab| tab.chat == chat && tab.agent == agent)
            .max_by_key(|tab| tab.n)
            .map(|tab| tab.acts.clone())
            .unwrap_or_default();
        remember(&mut acts, Act::new("open", host_of(url.as_str()), None, None, 0.0));
        let n = t.next.max(1);
        t.next = n + 1;
        let label = format!("{LABEL}{n}");
        t.open.push(Tab {
            n,
            chat: chat.to_string(),
            agent,
            label: label.clone(),
            url: url.to_string(),
            asked: url.to_string(),
            title: String::new(),
            used: now,
            opened: now,
            seen: false,
            acts,
            loading: true,
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
            show(win.app_handle());
        })
        // A new page: the island's Agents card says its site at once.
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
                    tab.loading = started;
                }
            });
            show(win.app_handle());
        })
        .build()
        .map_err(|e| format!("The browser tab could not open: {e}"))?;
    let gone = win.clone();
    let app = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            forget(gone.label());
            show(&app);
        }
    });
    Ok(win)
}

/// What a new tab needs before its first page: muted, Lumo's own pages
/// blocked as anything a page loads (a frame of tauri.localhost could call
/// Lumo), and the page kept acting focused while hidden. A tab that can't be
/// guarded doesn't open.
async fn setup(win: &WebviewWindow) -> Result<(), String> {
    mute(win).await?;
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
    note_act(win.label(), Act::new("read", String::new(), None, None, 0.0));
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

/// Element [k] of the last read, scrolled into view first: the centre of
/// what shows of it and its box, in CSS pixels, its name and the scroll.
#[derive(Debug, Clone, PartialEq)]
struct Place {
    point: (f64, f64),
    rect: [f64; 4],
    name: String,
    secret: bool,
    scroll_y: f64,
}

fn place_of(found: &Value) -> Option<Place> {
    let n = |v: &Value| v.as_f64().filter(|v| v.is_finite());
    let r = &found["rect"];
    Some(Place {
        point: (n(&found["x"])?, n(&found["y"])?),
        rect: [n(&r[0])?, n(&r[1])?, n(&r[2])?, n(&r[3])?],
        name: found["name"].as_str().unwrap_or("").to_string(),
        secret: found["secret"].as_bool().unwrap_or(false),
        scroll_y: n(&found["scroll"]).unwrap_or(0.0),
    })
}

async fn place(win: &WebviewWindow, k: u32) -> Result<Place, String> {
    let found = eval(win, &REF_POINT_JS.replace("__REF__", &k.to_string())).await?;
    place_of(&found).ok_or_else(|| format!("No element [{k}]: read the page again."))
}

/// Where to click: ref, or x and y of the last screenshot. The place, as
/// the island draws it, and how the answer names it.
async fn target(win: &WebviewWindow, input: &Value) -> Result<(Place, String), String> {
    let r = whole(input, "ref");
    let x = number(input, "x");
    let y = number(input, "y");
    match (r, x, y) {
        (Some(k), None, None) => Ok((place(win, k).await?, format!("[{k}]"))),
        (None, Some(x), Some(y)) => {
            // The screenshot's pixels are the device's: CSS pixels times the scale.
            let at = eval(win, "[devicePixelRatio, scrollY]").await.unwrap_or(Value::Null);
            let scale = at[0].as_f64().filter(|s| *s > 0.0).unwrap_or(1.0);
            let (cx, cy) = (x / scale, y / scale);
            let spot = Place {
                point: (cx, cy),
                rect: [cx - 14.0, cy - 14.0, 28.0, 28.0],
                name: String::new(),
                secret: false,
                scroll_y: at[1].as_f64().unwrap_or(0.0),
            };
            Ok((spot, format!("{}, {}", x.round(), y.round())))
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
    note_act(win.label(), Act::new("click", at.name.clone(), Some(at.rect), Some(at.point), at.scroll_y));
    mouse_click(&win, at.point).await?;
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
    let (field, spot) = match whole(input, "ref") {
        Some(k) => {
            let spot = place(&win, k).await?;
            mouse_click(&win, spot.point).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            (format!(" in [{k}]"), Some(spot))
        }
        None => (String::new(), None),
    };
    // What the island says was typed: never a password field's text.
    let secret = match &spot {
        Some(spot) => spot.secret,
        None => false,
    } || eval(&win, SECRET_JS).await.ok().and_then(|v| v.as_bool()).unwrap_or(true);
    note_act(
        win.label(),
        Act::new(
            "type",
            if secret { "•••".into() } else { text.chars().take(60).collect() },
            spot.as_ref().map(|s| s.rect),
            spot.as_ref().map(|s| s.point),
            spot.as_ref().map_or(0.0, |s| s.scroll_y),
        ),
    );
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
    let way = if down { "down" } else { "up" };
    let y = now[0].as_f64().unwrap_or(0.0);
    with_tabs(|t| {
        if let Some(tab) = t.find(chat, n) {
            tab.used = Instant::now();
            remember(&mut tab.acts, Act::new("scroll", way.into(), None, None, y));
        }
    });
    let int = |v: &Value| v.as_f64().unwrap_or(0.0).round() as i64;
    Ok(json!({ "text": format!("Scrolled {way} on tab {n}. Scroll: {} of {} (viewport {}).", int(&now[0]), int(&now[1]), int(&now[2])) }))
}

async fn screenshot(app: &AppHandle, chat: &str, input: &Value) -> Result<Value, String> {
    let (n, win) = tab_window(app, chat, input)?;
    note_act(win.label(), Act::new("read", String::new(), None, None, 0.0));
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
    for group in text.as_bytes().as_chunks::<4>().0 {
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
/// what shows of it and its box, in CSS pixels, the name the island shows
/// (its label or its first line, never what a field holds), whether it is a
/// password field, and the scroll; or null.
const REF_POINT_JS: &str = r#"(function () {
  var el = document.querySelector('[data-lumo-ref="__REF__"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var r = el.getBoundingClientRect();
  var left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
  var top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
  if (right <= left || bottom <= top) return null;
  var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  var name = el.getAttribute('aria-label') || '';
  if (!name && field && el.labels && el.labels.length) name = el.labels[0].innerText;
  if (!name && field) name = el.getAttribute('placeholder') || '';
  if (!name && !field) name = (el.innerText || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
  if (!name) name = el.getAttribute('title') || el.getAttribute('alt') || '';
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 60) name = name.slice(0, 59) + '…';
  return {
    x: (left + right) / 2, y: (top + bottom) / 2,
    rect: [r.left, r.top, r.width, r.height],
    name: name,
    secret: el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password',
    scroll: window.scrollY
  };
})()"#;

/// The field that has the focus is a password field, or may be: the focus
/// is in a frame of another site, which can't be looked into.
const SECRET_JS: &str = r#"(function () {
  var el = document.activeElement;
  for (;;) {
    if (el && el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      var doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      if (!doc) return true;
      el = doc.activeElement;
      continue;
    }
    break;
  }
  return !!el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password';
})()"#;

/// What `frame` needs besides the picture: [innerWidth, innerHeight, scrollY, title, href].
const FRAME_JS: &str = "[innerWidth, innerHeight, scrollY, document.title, location.href]";

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

/// Mutes a tab: a page it opens (a video, an ad) never plays a sound the
/// user would hear with nothing on screen. The browser runs with
/// `--mute-audio` too; this holds even when a WebView2 doesn't take it.
#[cfg(windows)]
async fn mute(win: &WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use wv2_core::Interface;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let queued = win.with_webview(move |webview| {
        // SAFETY: WebView2's own calls, on the main thread with_webview runs us on.
        let done = unsafe { webview.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_8>()).and_then(|core| core.SetIsMuted(true)) };
        let _ = tx.send(done.map_err(|err| format!("The tab could not be muted: {}", err.message())));
    });
    if let Err(err) = queued {
        return Err(format!("The tab could not be reached: {err}"));
    }
    match tokio::time::timeout(STEP, rx).await {
        Ok(Ok(done)) => done,
        Ok(Err(_)) => Err("The tab closed.".into()),
        Err(_) => Err(format!("The tab didn't answer within {} s (mute).", STEP.as_secs())),
    }
}

#[cfg(not(windows))]
async fn mute(_win: &WebviewWindow) -> Result<(), String> {
    Ok(())
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
            asked: format!("https://www.site{n}.com/page"),
            title: format!("Site {n}"),
            used: at,
            opened: at,
            seen: false,
            acts: Vec::new(),
            loading: false,
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
    fn a_cli_s_stream_gives_its_agent_the_tab_it_opened_before_or_after_the_call() {
        let t0 = Instant::now();
        let open = |url: &str| json!({ "url": url });
        // The call reached Lumo first: its tab was the conversation's, and becomes the agent's.
        let mut tabs = Tabs { next: 3, ..Tabs::default() };
        tabs.open = vec![tab(1, "c1", MAIN, t0), tab(2, "c1", MAIN, t0)];
        assert!(tabs.agent_called("c1", "agy-1", "browser_open", &open("www.site2.com/page"), t0 + Duration::from_secs(2)));
        assert_eq!(tabs.open.iter().map(|t| t.agent.as_str()).collect::<Vec<_>>(), [MAIN, "agy-1"]);
        // Told again (agy repeats a step): nothing more, and no claim left for another tab.
        assert!(!tabs.agent_called("c1", "agy-1", "browser_open", &open("https://www.site2.com/page"), t0 + Duration::from_secs(3)));
        assert!(tabs.claims.is_empty());
        // Another chat's tab, or one opened long ago, is not this call's.
        assert!(!tabs.agent_called("c2", "agy-2", "browser_open", &open("https://www.site1.com/page"), t0));
        assert_eq!(tabs.take_claim("c2", "https://www.site1.com/page", t0).as_deref(), Some("agy-2"));
        assert!(!tabs.agent_called("c1", "agy-2", "browser_open", &open("https://www.site1.com/page"), t0 + CLAIM_LIFE));
        assert_eq!(tabs.open[0].agent, MAIN);
        // The stream came first: the call that comes takes the claim.
        assert_eq!(tabs.take_claim("c1", "https://www.site1.com/page", t0 + CLAIM_LIFE).as_deref(), Some("agy-2"));
        // A call on a tab of the conversation makes it the agent's; another agent's stays its own.
        assert!(tabs.agent_called("c1", "agy-3", "browser_read", &json!({ "tab": 1 }), t0));
        assert_eq!(tabs.open[0].agent, "agy-3");
        assert!(!tabs.agent_called("c1", "agy-4", "browser_click", &json!({ "tab": 1, "ref": 2 }), t0));
        assert!(!tabs.agent_called("c1", "agy-4", "browser_read", &json!({ "tab": 9 }), t0), "no such tab");
        assert!(!tabs.agent_called("c1", "agy-4", "browser_read", &json!({}), t0), "no tab named");
        assert_eq!(tabs.open.iter().map(|t| t.agent.as_str()).collect::<Vec<_>>(), ["agy-3", "agy-1"]);
    }

    #[test]
    fn lumo_s_browser_tools_are_known_by_server_or_by_their_full_name() {
        assert_eq!(tool_of("lumo", "browser_open"), Some("browser_open"));
        assert_eq!(tool_of(" Lumo ", "BROWSER_READ"), Some("browser_read"));
        assert_eq!(tool_of("", "mcp__lumo__browser_click"), Some("browser_click"));
        assert_eq!(tool_of("", "mcp_lumo_browser_close"), Some("browser_close"));
        assert_eq!(tool_of("github", "browser_open"), None, "another server's tool of the same name");
        assert_eq!(tool_of("lumo", "update_plan"), None);
        assert_eq!(tool_of("", "browser_open"), None, "no server, no full name");
        assert_eq!(tool_of("", "mcp_github_browser_open"), None);
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
        let view = serde_json::to_value(tabs.view()).unwrap();
        assert_eq!(view, json!({ "tabs": [{ "chat": "c1", "agent": "a1", "tab": 1, "host": "site1.com", "title": "Site 1", "seq": 0 }] }));
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
    fn watch_shows_the_newest_tab_of_the_agent_and_what_it_last_did() {
        let t0 = Instant::now();
        let mut tabs = Tabs { next: 4, ..Tabs::default() };
        tabs.open = vec![tab(1, "c1", "a1", t0), tab(2, "c1", "a1", t0), tab(3, "c2", "a1", t0)];
        let opened = Act { kind: "open", what: "example.com".into(), rect: None, point: None, scroll_y: 0.0, at: t0, seq: 7 };
        let click = Act {
            kind: "click",
            what: "Trastevere · Casa".into(),
            rect: Some([10.0, 20.0, 300.0, 120.5]),
            point: Some((160.0, 80.0)),
            scroll_y: 640.0,
            at: t0,
            seq: 8,
        };
        tabs.open[1].acts = vec![opened.clone(), click.clone()];
        tabs.open[1].url = "https://www.example.com/s/Rome".into();
        tabs.open[1].title = "Rome · stays".into();
        tabs.open[1].loading = true;
        let got = newest(&tabs, "c1", "a1").unwrap();
        assert_eq!((got.label.as_str(), got.n, got.acts.last()), ("agent-browser-2", 2, Some(&click)), "the newest of this chat's agent");
        assert_eq!(got.page, Page { title: "Rome · stays".into(), url: "https://www.example.com/s/Rome".into() }, "its last address, for a picture the page can't describe");
        assert!(got.loading);
        assert_eq!(newest(&tabs, "c1", "zz"), None);
        assert_eq!(newest(&tabs, "c2", "a1").map(|x| x.n), Some(3), "another chat's agent of the same id is another");
        // Several tabs open at once: the one it used last, not the newest.
        let mut both = Tabs { next: 4, ..Tabs::default() };
        both.open = vec![tab(1, "c1", "a1", t0), tab(2, "c1", "a1", t0), tab(3, "c1", "a1", t0)];
        both.open[0].acts = vec![Act { seq: 20, ..click.clone() }];
        both.open[2].acts = vec![Act { seq: 12, ..opened.clone() }];
        assert_eq!(newest(&both, "c1", "a1").map(|x| x.n), Some(1), "it clicks in tab 1 after opening tab 3");
        assert_eq!(both.view().tabs.iter().map(|t| t.seq).collect::<Vec<_>>(), [20, 0, 12]);
        both.open[0].acts.clear();
        assert_eq!(newest(&both, "c1", "a1").map(|x| x.n), Some(3));

        // A page not drawn yet: no picture, the island keeps the last one.
        let blank = not_drawn(2, &got.page, &got.acts);
        assert_eq!((blank["image"].as_str(), blank["loading"].as_bool(), blank["host"].as_str()), (Some(""), Some(true), Some("example.com")));
        assert_eq!(blank["action"]["kind"], "click");

        let at = json!([1280, 800, 700.5, "Rome · stays", "https://www.example.com/s/Rome"]);
        let frame = frame_json(2, &at, "AAAA", &got.acts, true, t0 + Duration::from_millis(1500));
        let clicked = json!({
            "seq": 8, "kind": "click", "what": "Trastevere · Casa", "rect": { "x": 10.0, "y": 20.0, "w": 300.0, "h": 120.5 },
            "point": { "x": 160.0, "y": 80.0 }, "scrollY": 640.0, "ago": 1500,
        });
        assert_eq!(
            frame,
            json!({
                "tab": 2, "image": "AAAA", "width": 1280.0, "height": 800.0, "scrollY": 700.5,
                "title": "Rome · stays", "url": "https://www.example.com/s/Rome", "host": "example.com", "loading": true,
                "action": clicked,
                "steps": [
                    { "seq": 7, "kind": "open", "what": "example.com", "rect": null, "point": null, "scrollY": 0.0, "ago": 1500 },
                    clicked,
                ],
            })
        );
        let scrolled = Act { kind: "scroll", what: "down".into(), rect: None, point: None, scroll_y: 800.0, at: t0, seq: 9 };
        let frame = frame_json(1, &json!([]), "B", &[scrolled], false, t0);
        assert_eq!(frame["action"]["rect"], Value::Null);
        assert_eq!((frame["width"].clone(), frame["host"].clone()), (json!(0.0), json!("")), "a page that couldn't say is drawn as nothing");
        assert_eq!(frame_json(1, &at, "B", &[], false, t0)["action"], Value::Null);
        assert_eq!(frame_json(1, &at, "B", &[], false, t0)["steps"], json!([]));
    }

    #[test]
    fn the_steps_keep_the_last_ones_and_a_read_again_is_one_step() {
        let mut acts = Vec::new();
        let first = Act::new("open", "example.com".into(), None, None, 0.0);
        let read = Act::new("read", String::new(), None, None, 0.0);
        assert!(read.seq > first.seq, "each action has the next number");
        remember(&mut acts, first);
        remember(&mut acts, read.clone());
        remember(&mut acts, Act::new("read", String::new(), None, None, 0.0));
        assert_eq!(acts.iter().map(|a| a.kind).collect::<Vec<_>>(), ["open", "read"], "reading again is the same step");
        assert!(acts[1].seq > read.seq, "with the newer number, so the island sees it again");
        remember(&mut acts, Act::new("click", "Go".into(), Some([0.0, 0.0, 10.0, 10.0]), Some((5.0, 5.0)), 0.0));
        remember(&mut acts, Act::new("click", "Go".into(), Some([0.0, 0.0, 10.0, 10.0]), Some((5.0, 5.0)), 0.0));
        assert_eq!(acts.len(), 4, "a click again is another click");
        for _ in 0..10 {
            remember(&mut acts, Act::new("scroll", "down".into(), None, None, 0.0));
            remember(&mut acts, Act::new("type", "Rome".into(), None, None, 0.0));
        }
        assert_eq!(acts.len(), STEPS_KEPT);
        assert_eq!(acts.last().map(|a| a.kind), Some("type"));
    }

    #[test]
    fn a_place_is_read_whole_or_not_at_all() {
        let found = json!({ "x": 50, "y": 60.5, "rect": [10, 20, 80, 81], "name": "Go", "secret": false, "scroll": 300 });
        assert_eq!(
            place_of(&found),
            Some(Place { point: (50.0, 60.5), rect: [10.0, 20.0, 80.0, 81.0], name: "Go".into(), secret: false, scroll_y: 300.0 })
        );
        assert_eq!(place_of(&json!({ "x": 1, "y": 2, "rect": [1, 2, 3] })), None);
        assert_eq!(place_of(&Value::Null), None);
        assert!(place_of(&json!({ "x": 1, "y": 2, "rect": [1, 2, 3, 4], "secret": true })).unwrap().secret);
        assert!(REF_POINT_JS.contains("password") && !REF_POINT_JS.contains("el.value"), "a field's text is never its name");
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

    #[test]
    fn the_other_clis_have_their_page_changes_asked_for_by_lumo() {
        assert_eq!(kit("", false), "--tools=island");
        assert_eq!(kit("mail, mailsend", true), "--tools=mail,mailsend,browsercard,island");
        // Looking at a page never asks; changing it does.
        for tool in LOOKING {
            assert!(!changes(tool), "{tool}");
        }
        for tool in ["browser_open", "browser_click", "browser_type", "browser_scroll", "browser_close"] {
            assert!(changes(tool), "{tool}");
        }
        assert!(!changes("mail_send"), "only the browser's");
        // The hook's list and the app's are the same.
        assert_eq!(crate::browser_tool_defs::BROWSER_NAMES, NAMES);
        assert_eq!(Asks::of("auto"), Asks::Free);
        assert_eq!(Asks::of("plan"), Asks::LookOnly);
        assert_eq!(Asks::of("default"), Asks::Card);
    }

    #[test]
    fn a_call_naming_no_chat_is_for_the_only_one_asking() {
        let asker = |id, chat: &str| Asker { id, chat: chat.into(), provider: crate::antigravity_cli::PROVIDER, agent: "antigravity", started: Asks::Card, begun_ms: 0 };
        assert_eq!(only_asking_chat(&[]), None);
        assert_eq!(only_asking_chat(&[asker(1, "a")]).as_deref(), Some("a"));
        assert_eq!(only_asking_chat(&[asker(1, "a"), asker(2, "a")]).as_deref(), Some("a"));
        assert_eq!(only_asking_chat(&[asker(1, "a"), asker(2, "b")]), None, "two chats: neither");
        assert_eq!(only_asking_chat(&[asker(1, "")]), None);
        // Another CLI's turn: its calls name their chat, and one that doesn't is nobody's.
        let codex = Asker { id: 3, chat: "a".into(), provider: "codex", agent: "codex", started: Asks::Card, begun_ms: 0 };
        assert_eq!(only_asking_chat(std::slice::from_ref(&codex)), None);
        assert_eq!(only_asking_chat(&[asker(1, "a"), codex]), None);
        // The mode as the chat shows it: an old "turbo" is Ask, but Antigravity's own.
        assert_eq!(asks_for("codex", "turbo"), Asks::Card);
        assert_eq!(asks_for("copilot", "bypassPermissions"), Asks::Card);
        assert_eq!(asks_for("codex", "auto"), Asks::Free);
        assert_eq!(asks_for("cursor", "plan"), Asks::LookOnly);
        assert_eq!(asks_for(crate::antigravity_cli::PROVIDER, "turbo"), Asks::Free);
        // A turn asks from its start until it ends.
        let turn = AskTurn::begin("codex", "chat-turn-test", "codex", "default");
        assert!(askers().iter().any(|a| a.chat == "chat-turn-test" && a.started == Asks::Card));
        let id = askers().iter().find(|a| a.chat == "chat-turn-test").map(|a| a.id).unwrap();
        let ended = std::thread::spawn(move || tauri::async_runtime::block_on(turn_over(id)));
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(turn);
        ended.join().unwrap();
        assert!(!askers().iter().any(|a| a.chat == "chat-turn-test"));
    }
}
