// `/test` in the chat (experimental branch only): how well the chat's agent
// clicks. Lumo covers the screen with a test page (calibrate.html: nine
// numbered circles at TARGETS) and asks the agent to click the centre of each,
// from 1 to 9. Every call of the computer tools during the test is recorded:
// what the model wrote (its raw input), the point Lumo read from it, where the
// click really landed, the circle it meant and how far off it was, and the
// screenshots it was given. At the end the chat gets a summary, and the whole
// test goes to `%LOCALAPPDATA%\com.rccrd12.lumo\computer-test\<time>\`
// (report.json and the screenshots), with a line per click in lumo.log.
//
// The summary also checks three readings of the model's numbers, to tell
// where a miss comes from: the screenshot's pixels (what Lumo asks for), a
// 0–999 grid over the screenshot (how Gemini's own computer use counts) and
// the screen's full resolution (a model that ignores the screenshot's size).
//
// Outside the test, the chat's own use of the computer is recorded the same
// way (record_start, record_stop): every call, the screenshots and where each
// click landed, in `computer-test\<time>-uso\`, so a click that went wrong
// can be looked at afterwards: what the model saw, what it asked, where the
// mouse went.
//
// During the test only looking, left clicks and moving the mouse are allowed,
// and only on the test's screen, which the page covers whole: nothing but the
// page can be clicked, so Lumo shows no card for them.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::computer::View;

/// The test page's window.
pub const WINDOW: &str = "calibrate";

/// Each circle's centre, as fractions of the screen (src/calibrate/main.ts TARGETS, same order).
pub const TARGETS: [(f64, f64); 9] = [
    (0.08, 0.12), (0.5, 0.18), (0.92, 0.1),
    (0.18, 0.5), (0.63, 0.42), (0.87, 0.6),
    (0.07, 0.86), (0.41, 0.8), (0.94, 0.88),
];

/// A circle's radius, as a fraction of the screen's shorter side (main.ts RADIUS).
const RADIUS: f64 = 0.018;

/// What the agent is asked; `{points}`: how it gives the points.
const PROMPT: &str = "This is a test of Lumo's computer tools, asked for by the user. Lumo is showing a test screen with 9 red circles numbered 1 to 9, each with a small white cross in its centre. \
Take one screenshot, then click the centre of each circle exactly once with left_click, in order from 1 to 9, giving coordinate: [x, y] {points}. \
Don't take another screenshot between the clicks, don't correct a click that missed, and use no other tool. \
When you are done, answer with the 9 coordinates you clicked, one per line, as \"n: [x, y]\".";

/// The test under way, or the chat's use of the computer being recorded.
struct Test {
    /// The click test (/test); false: the chat's own use, only recorded.
    test: bool,
    /// The screen it is on, in physical pixels.
    rect: (i32, i32, i32, i32),
    dir: PathBuf,
    /// Every call of the computer tools, in order.
    calls: Vec<Value>,
    shots: usize,
    clicks: usize,
}

static TEST: Mutex<Option<Test>> = Mutex::new(None);

/// The chat's question is the test.
pub fn is_test(query: &str) -> bool {
    query.trim().eq_ignore_ascii_case("/test")
}

/// The click test is under way.
pub fn testing() -> bool {
    TEST.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|t| t.test)
}

/// The folder for a test or a recording made now.
fn new_dir(suffix: &str) -> Result<PathBuf, String> {
    let t = crate::platform::local_time();
    let stamp = format!("{:04}{:02}{:02}-{:02}{:02}{:02}{suffix}", t.year, t.month, t.day, t.hour, t.minute, t.second);
    let dir = crate::settings::local_dir().join("computer-test").join(&stamp);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cartella del test non creata: {e}"))?;
    Ok(dir)
}

/// The chat's use of the computer starts being recorded, at its first call
/// (experimental branch): every call, the screenshots and where each click
/// landed go to `computer-test\<time>-uso\`, to see a miss afterwards. A
/// test under way, or a recording already, is left as it is.
pub fn record_start() {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    if test.is_some() {
        return;
    }
    let Ok(dir) = new_dir("-uso") else { return };
    crate::log::line(format!("computer use: recorded in {}", dir.display()));
    *test = Some(Test { test: false, rect: (0, 0, 0, 0), dir, calls: Vec::new(), shots: 0, clicks: 0 });
}

/// The chat's turn is over: its recording is written (a test is finish's to end).
pub fn record_stop() {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    if !test.as_ref().is_some_and(|t| !t.test) {
        return;
    }
    let Some(t) = test.take() else { return };
    let report = json!({ "calls": t.calls, "shots": t.shots, "clicks": t.clicks });
    let _ = std::fs::write(t.dir.join("report.json"), serde_json::to_string_pretty(&report).unwrap_or_default());
}

/// The tools the test allows: looking, left clicks and moving the mouse.
pub fn allows(tool: &str) -> bool {
    matches!(tool, "screenshot" | "zoom" | "cursor_position" | "wait" | "left_click" | "mouse_move")
}

/// An action on `view` (the screen the agent works on) is on the test's own screen.
pub fn on_test_screen(view: Option<View>) -> bool {
    let test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    match (test.as_ref().filter(|t| t.test), view) {
        (Some(t), Some(v)) => v.rect == t.rect,
        // No test: not this check's to refuse. No screenshot yet: the click is refused anyway.
        _ => true,
    }
}

fn page_url<R: Runtime>(app: &AppHandle<R>) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/calibrate.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("calibrate.html".into())
}

/// The test starts: the page over the screen under the mouse, and the
/// question for the agent. Err with what is missing.
pub fn begin(app: &AppHandle, computer_on: bool, provider_can: bool, grid: bool) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("Il test del computer use c'è solo su Windows.".into());
    }
    if !computer_on {
        return Err("Per il test accendi Impostazioni → Sicurezza → Lascia che Claude usi il computer.".into());
    }
    if !provider_can {
        return Err("Il test funziona con Claude Code, Codex, Antigravity CLI, Copilot CLI e Cursor CLI: scegline uno sopra la chat.".into());
    }
    let rects = crate::screen::monitor_rects();
    let index = crate::screen::display_under_cursor().unwrap_or(0);
    let rect = *rects.get(index).or(rects.first()).ok_or("Nessuno schermo trovato.")?;
    let dir = new_dir("")?;
    if let Some(old) = app.get_webview_window(WINDOW) {
        let _ = old.destroy();
    }
    let win = WebviewWindowBuilder::new(app, WINDOW, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Lumo · test")
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| format!("La pagina del test non si è aperta: {e}"))?;
    let _ = win.set_position(tauri::PhysicalPosition::new(rect.0, rect.1));
    let _ = win.set_size(tauri::PhysicalSize::new((rect.2 - rect.0).max(1) as u32, (rect.3 - rect.1).max(1) as u32));
    let _ = win.show();
    let scale = win.scale_factor().unwrap_or(1.0);
    crate::log::line(format!(
        "computer test: started on screen {} {:?} (scale {scale}), files in {}",
        index + 1,
        rect,
        dir.display()
    ));
    // A recording left by a turn before is written first; the test replaces it.
    record_stop();
    *TEST.lock().unwrap_or_else(|e| e.into_inner()) = Some(Test { test: true, rect, dir, calls: Vec::new(), shots: 0, clicks: 0 });
    let points = if grid { "on a 0–999 grid over that screenshot ([0, 0] top left, [999, 999] bottom right)" } else { "in that screenshot's pixels" };
    Ok(PROMPT.replace("{points}", points))
}

/// A call of the computer tools during the test, as the model wrote it.
pub fn note_call(tool: &str, input: &Value) {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    let Some(t) = test.as_mut() else { return };
    t.calls.push(json!({ "tool": tool, "input": input }));
}

/// The call just noted, its points turned from the 0–999 grid into the screenshot's pixels.
pub fn note_pixels(input: &Value) {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    let Some(call) = test.as_mut().and_then(|t| t.calls.last_mut()) else { return };
    call["grid"] = json!(true);
    call["as_pixels"] = input.clone();
}

/// The call just noted was refused, with `why`.
pub fn note_refused(why: &str) {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    let Some(call) = test.as_mut().and_then(|t| t.calls.last_mut()) else { return };
    call["refused"] = json!(why);
}

/// A screenshot the agent was given: saved, and its size noted.
pub fn note_shot(png: &[u8], view: &View) {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    let Some(t) = test.as_mut() else { return };
    t.shots += 1;
    let name = format!("shot-{}.png", t.shots);
    let _ = std::fs::write(t.dir.join(&name), png);
    if let Some(call) = t.calls.last_mut() {
        call["shot"] = json!({ "file": name, "w": view.w, "h": view.h, "screen": [view.rect.0, view.rect.1, view.rect.2, view.rect.3] });
    }
}

/// A click: where Lumo read it (`asked`, screenshot pixels) and where it
/// landed on the screen (`landed`, physical pixels), measured against the circles.
pub fn note_click(asked: Option<(i64, i64)>, landed: (i32, i32), view: &View) {
    let mut test = TEST.lock().unwrap_or_else(|e| e.into_inner());
    let Some(t) = test.as_mut() else { return };
    t.clicks += 1;
    let n = t.clicks;
    let measured = if t.test {
        measure(n, asked, landed, view)
    } else {
        // The chat's own click: what was asked and where it landed, in the screenshot's pixels.
        let shot = view.point_in_shot(landed.0, landed.1);
        let off = asked.map(|a| (shot.0 - a.0).abs().max((shot.1 - a.1).abs()));
        json!({ "n": n, "asked": asked.map(|a| json!([a.0, a.1])), "landed_shot": [shot.0, shot.1], "landed_screen": [landed.0, landed.1], "landed_off_asked": off, "shot": t.shots })
    };
    crate::log::line(format!("computer {}: click {n} {measured}", if t.test { "test" } else { "use" }));
    if let Some(call) = t.calls.last_mut() {
        call["click"] = measured;
    }
}

/// Where circle `i` (from 0) is in `view`'s screenshot pixels.
fn target_in_shot(i: usize, view: &View) -> (f64, f64) {
    let (fx, fy) = TARGETS[i];
    (fx * view.w as f64, fy * view.h as f64)
}

/// The circle nearest to `p` (screenshot pixels): its index from 0 and how far.
fn nearest(p: (f64, f64), view: &View) -> (usize, f64) {
    (0..TARGETS.len())
        .map(|i| {
            let (tx, ty) = target_in_shot(i, view);
            (i, ((p.0 - tx).powi(2) + (p.1 - ty).powi(2)).sqrt())
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap_or((0, f64::MAX))
}

/// The radius of a circle in `view`'s screenshot pixels.
fn radius_in_shot(view: &View) -> f64 {
    RADIUS * (view.w.min(view.h) as f64)
}

/// The three readings of the model's numbers, as points of the screenshot.
fn readings(asked: (i64, i64), view: &View) -> [(&'static str, (f64, f64)); 3] {
    let (x, y) = (asked.0 as f64, asked.1 as f64);
    let (sw, sh) = ((view.rect.2 - view.rect.0) as f64, (view.rect.3 - view.rect.1) as f64);
    let (w, h) = (view.w as f64, view.h as f64);
    [
        ("pixel dello screenshot", (x, y)),
        ("griglia 0–999", (x * w / 1000.0, y * h / 1000.0)),
        ("risoluzione piena dello schermo", (x * w / sw, y * h / sh)),
    ]
}

/// What click `n` (from 1) did, as JSON.
fn measure(n: usize, asked: Option<(i64, i64)>, landed: (i32, i32), view: &View) -> Value {
    let landed_shot = view.point_in_shot(landed.0, landed.1);
    let expected = n.min(TARGETS.len()) - 1;
    let (ex, ey) = target_in_shot(expected, view);
    let mut out = json!({
        "n": n,
        "landed_screen": [landed.0, landed.1],
        "landed_shot": [landed_shot.0, landed_shot.1],
        "expected_circle": expected + 1,
        "expected_at": [ex.round() as i64, ey.round() as i64],
        "radius": radius_in_shot(view).round() as i64,
        "shot_size": [view.w, view.h],
    });
    let Some(asked) = asked else {
        out["asked"] = Value::Null;
        return out;
    };
    out["asked"] = json!([asked.0, asked.1]);
    out["off_from_expected"] = json!(((asked.0 as f64 - ex).powi(2) + (asked.1 as f64 - ey).powi(2)).sqrt().round() as i64);
    out["landed_off_asked"] = json!(((landed_shot.0 - asked.0).abs()).max((landed_shot.1 - asked.1).abs()));
    let mut reads = serde_json::Map::new();
    for (name, p) in readings(asked, view) {
        let (i, d) = nearest(p, view);
        let (tx, ty) = target_in_shot(expected, view);
        reads.insert(
            name.into(),
            json!({ "nearest_circle": i + 1, "off": d.round() as i64, "off_from_expected": ((p.0 - tx).powi(2) + (p.1 - ty).powi(2)).sqrt().round() as i64 }),
        );
    }
    out["readings"] = Value::Object(reads);
    out
}

/// The test is over: the page closes, the report is written, and the chat's summary comes back.
pub fn finish<R: Runtime>(app: &AppHandle<R>, answer: &str) -> String {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.destroy();
    }
    let Some(test) = TEST.lock().unwrap_or_else(|e| e.into_inner()).take_if(|t| t.test) else {
        return String::new();
    };
    let clicks: Vec<&Value> = test.calls.iter().filter_map(|c| c.get("click")).collect();
    let summary = summary(&clicks, test.shots, test.calls.len());
    let report = json!({
        "screen": [test.rect.0, test.rect.1, test.rect.2, test.rect.3],
        "targets": TARGETS.iter().map(|(x, y)| json!([x, y])).collect::<Vec<_>>(),
        "calls": test.calls,
        "answer": answer,
        "summary": summary,
    });
    let path = test.dir.join("report.json");
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap_or_default());
    crate::log::line(format!("computer test: over, report in {}", path.display()));
    format!("{summary}\n\nIl rapporto completo, con gli screenshot, è in `{}`.", test.dir.display())
}

/// The summary for the chat: each click, and which reading of the numbers fits best.
fn summary(clicks: &[&Value], shots: usize, calls: usize) -> String {
    let mut lines = vec![format!("**Test dei clic**: {} clic, {} screenshot, {} chiamate in tutto.", clicks.len(), shots, calls)];
    if clicks.is_empty() {
        lines.push("Nessun clic: l'agente non ha cliccato (guarda la sua risposta qui sopra e il rapporto).".into());
        return lines.join("\n");
    }
    let off = |c: &Value, key: &str| c[key].as_f64();
    let mut hits = 0;
    let mut landed_wrong = 0;
    for c in clicks {
        let n = c["n"].as_u64().unwrap_or(0);
        let radius = c["radius"].as_f64().unwrap_or(0.0);
        match (c["asked"].as_array(), off(c, "off_from_expected")) {
            (Some(a), Some(d)) => {
                let hit = d <= radius;
                hits += usize::from(hit);
                let landed = c["landed_off_asked"].as_i64().unwrap_or(0);
                landed_wrong += usize::from(landed > 3);
                let at = c["expected_at"].as_array().map(|e| format!("[{}, {}]", e[0], e[1])).unwrap_or_default();
                lines.push(format!(
                    "- {n} → cerchio {}: chiesto [{}, {}], il centro era a {at}, {} {d} px{}",
                    c["expected_circle"],
                    a[0],
                    a[1],
                    if hit { "preso, a" } else { "mancato di" },
                    if landed > 3 { format!(" · il mouse è finito a {} px da dove chiesto", landed) } else { String::new() },
                ));
            }
            _ => lines.push(format!("- {n}: nessun punto, cliccato dove era già il mouse")),
        }
    }
    lines.push(format!("Presi {hits} su {}.", clicks.len()));
    // Which reading of the numbers puts the clicks nearest to the circles meant.
    let mut best: Vec<(String, f64)> = ["pixel dello screenshot", "griglia 0–999", "risoluzione piena dello schermo"]
        .iter()
        .map(|name| {
            let ds: Vec<f64> = clicks.iter().filter_map(|c| c["readings"][*name]["off_from_expected"].as_f64()).collect();
            let mean = if ds.is_empty() { f64::MAX } else { ds.iter().sum::<f64>() / ds.len() as f64 };
            (name.to_string(), mean)
        })
        .collect();
    best.sort_by(|a, b| a.1.total_cmp(&b.1));
    if best[0].1 < f64::MAX {
        lines.push(format!(
            "Errore medio se i numeri sono {}: {:.0} px · {}: {:.0} px · {}: {:.0} px.",
            best[0].0, best[0].1, best[1].0, best[1].1, best[2].0, best[2].1
        ));
        if best[0].0 != "pixel dello screenshot" && best[0].1 < best[1].1 * 0.5 {
            lines.push(format!("I clic tornano molto meglio leggendo i numeri come {}: il modello conta le coordinate in un altro modo.", best[0].0));
        }
    }
    if landed_wrong > 0 {
        lines.push(format!("In {landed_wrong} clic il mouse non è arrivato dove Lumo voleva: questo è un problema di Lumo o di Windows, non del modello."));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view() -> View {
        // A 2560×1440 screen, its screenshot 1456×819.
        View::new(0, (0, 0, 2560, 1440))
    }

    #[test]
    fn only_the_test_command_starts_it() {
        assert!(is_test("/test") && is_test("  /TEST \n"));
        assert!(!is_test("/test now") && !is_test("test"));
        for ok in ["screenshot", "zoom", "left_click", "mouse_move", "wait", "cursor_position"] {
            assert!(allows(ok));
        }
        for no in ["type", "key", "right_click", "double_click", "left_click_drag", "scroll"] {
            assert!(!allows(no), "{no}");
        }
    }

    #[test]
    fn a_click_is_measured_against_the_circle_it_meant_in_three_readings() {
        let v = view();
        let (tx, ty) = target_in_shot(4, &v);
        // Click 5, right on circle 5, in the screenshot's pixels.
        let asked = (tx.round() as i64, ty.round() as i64);
        let landed = v.to_screen(asked.0, asked.1).unwrap();
        let m = measure(5, Some(asked), landed, &v);
        assert_eq!(m["expected_circle"], 5);
        assert!(m["off_from_expected"].as_f64().unwrap() <= 1.0);
        assert!(m["landed_off_asked"].as_i64().unwrap() <= 1);
        assert_eq!(m["readings"]["pixel dello screenshot"]["nearest_circle"], 5);

        // The same circle written on a 0–999 grid: the grid reading fits, the pixel one doesn't.
        let grid = ((TARGETS[4].0 * 1000.0) as i64, (TARGETS[4].1 * 1000.0) as i64);
        let m = measure(5, Some(grid), v.to_screen(grid.0.min(v.w as i64 - 1), grid.1.min(v.h as i64 - 1)).unwrap(), &v);
        assert!(m["readings"]["griglia 0–999"]["off_from_expected"].as_f64().unwrap() <= 2.0);
        assert!(m["readings"]["pixel dello screenshot"]["off_from_expected"].as_f64().unwrap() > 20.0);

        // Written in the screen's full resolution.
        let full = ((TARGETS[4].0 * 2560.0) as i64, (TARGETS[4].1 * 1440.0) as i64);
        let m = measure(5, Some(full), (full.0 as i32, full.1 as i32), &v);
        assert!(m["readings"]["risoluzione piena dello schermo"]["off_from_expected"].as_f64().unwrap() <= 2.0);
    }

    #[test]
    fn the_summary_says_which_reading_fits_and_when_the_mouse_went_elsewhere() {
        let v = view();
        // The circles a 0–999 grid can name inside this screenshot (819 pixels high).
        let clicks: Vec<Value> = (0..9)
            .map(|i| (i, ((TARGETS[i].0 * 1000.0) as i64, (TARGETS[i].1 * 1000.0) as i64)))
            .filter(|(_, g)| g.0 < v.w as i64 && g.1 < v.h as i64)
            .map(|(i, grid)| measure(i + 1, Some(grid), v.to_screen(grid.0, grid.1).unwrap(), &v))
            .collect();
        assert!(clicks.len() >= 5);
        let refs: Vec<&Value> = clicks.iter().collect();
        let text = summary(&refs, 1, 10);
        assert!(text.contains(&format!("{} clic", clicks.len())) && text.contains("griglia 0–999:"), "{text}");
        assert!(text.contains("leggendo i numeri come griglia 0–999"), "{text}");
        assert!(!text.contains("non è arrivato"), "{text}");

        let mut off = measure(1, Some((100, 100)), (900, 900), &v);
        off["n"] = json!(1);
        let text = summary(&[&off], 1, 2);
        assert!(text.contains("non è arrivato dove Lumo voleva"), "{text}");
        assert!(summary(&[], 0, 0).contains("Nessun clic"));
    }
}
