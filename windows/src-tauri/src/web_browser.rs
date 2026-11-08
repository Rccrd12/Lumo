// A search engine's page read by WebView2 itself, when the engine takes
// Lumo's own requests for a robot (web_search.rs).
//
// Lumo's requests are a Rust client's, whatever it says it is, and some
// engines (DuckDuckGo, Brave) tell by how it connects. WebView2 is Edge: a
// window that is never shown opens the page, its HTML is read once it has
// loaded (a page that asks to prove it isn't a robot is waited past), and the
// window goes. It runs only for that search: nothing is left open, and no
// capability is given to the page (capabilities/default.json names Lumo's own
// windows only).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::Url;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use webview2_com::ExecuteScriptCompletedHandler;

static APP: OnceLock<AppHandle> = OnceLock::new();
static NEXT: AtomicU32 = AtomicU32::new(0);

type Reply = Arc<Mutex<Option<tokio::sync::oneshot::Sender<String>>>>;

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// The page at `url` once it has loaded and isn't a robot check, within `wait`.
pub async fn page(url: Url, wait: Duration) -> Result<String, String> {
    let host = url.host_str().unwrap_or("").to_string();
    let app = APP.get().ok_or_else(|| "the browser isn't ready".to_string())?.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let reply: Reply = Arc::new(Mutex::new(Some(tx)));
    let label = format!("lumo-web-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let on_load = reply.clone();
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Lumo")
        .inner_size(1280.0, 900.0)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .decorations(false)
        .disable_drag_drop_handler()
        .on_page_load(move |win, payload| {
            if payload.event() == PageLoadEvent::Finished {
                read_html(&win, on_load.clone());
            }
        })
        .build()
        .map_err(|e| format!("{host} in the browser: {e}"))?;
    let html = tokio::time::timeout(wait, rx).await;
    let _ = win.destroy();
    match html {
        Ok(Ok(html)) => Ok(html),
        Ok(Err(_)) => Err(format!("{host} in the browser: closed")),
        Err(_) => Err(format!("{host} in the browser: no results page in time")),
    }
}

/// The page's HTML, to `reply` unless it is a robot check (the next load is waited for).
fn read_html(win: &WebviewWindow, reply: Reply) {
    let _ = win.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let script = wv2_core::HSTRING::from("document.documentElement.outerHTML");
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_, json| {
            // The script's result comes as JSON: a string, here.
            let html: String = serde_json::from_str(&json).unwrap_or_default();
            if !html.is_empty() && !crate::web_search::is_challenge(&html) {
                if let Some(tx) = reply.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = tx.send(html);
                }
            }
            Ok(())
        }));
        let _ = core.ExecuteScript(&script, &handler);
    });
}
