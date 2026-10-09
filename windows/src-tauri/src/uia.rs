// What is on the screen that can be clicked, and exactly where: the names and
// rectangles Windows' UI Automation gives for the window the user is in, the
// desktop's icons and the taskbar — what screen readers read. Gemini Live's
// point_at (live.rs) looks here first: a rectangle Windows gives is exact,
// where a position guessed from a screenshot is not.
//
// Only read when the model points, once; nothing is kept, nothing watches.
// Linux has no equivalent here yet: the list is empty and pointing falls back
// to reading the screenshot.

/// One element of the user interface.
#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    pub name: String,
    /// "button", "list item"…: what it is, in words for the model.
    pub kind: &'static str,
    /// Left, top, right, bottom, in physical desktop pixels.
    pub rect: (i32, i32, i32, i32),
    /// Where it was found: the app's name, "desktop" or "taskbar".
    pub source: String,
    /// It is in the window the user is in.
    pub front: bool,
}

impl Element {
    pub fn center(&self) -> (i32, i32) {
        ((self.rect.0 + self.rect.2) / 2, (self.rect.1 + self.rect.3) / 2)
    }
}

/// UI Automation's control types worth pointing at, by id; the containers
/// (windows, panes, groups, lists, toolbars…) are not.
#[cfg_attr(not(windows), allow(dead_code))] // read only where UI Automation is
pub fn kind_name(control_type: i32) -> Option<&'static str> {
    Some(match control_type {
        50000 => "button",
        50002 => "check box",
        50003 => "combo box",
        50004 => "text field",
        50005 => "link",
        50006 => "image",
        50007 => "list item",
        50011 => "menu item",
        50013 => "radio button",
        50015 => "slider",
        50019 => "tab",
        50020 => "text",
        50024 => "tree item",
        50025 => "control",
        50029 => "item",
        50031 => "split button",
        50035 => "column header",
        _ => return None,
    })
}

/// A name as compared: lowercase words, punctuation out.
pub fn normalize(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// How well an element's `name` is the `query`: 100 the same, 70 one starts
/// with the other, 50 every word of the query is in it; 0 otherwise.
pub fn name_score(query: &str, name: &str) -> u32 {
    let (q, n) = (normalize(query), normalize(name));
    if q.is_empty() || n.is_empty() {
        return 0;
    }
    if q == n {
        return 100;
    }
    if q.len() >= 3 && (n.starts_with(&format!("{q} ")) || q.starts_with(&format!("{n} "))) {
        return 70;
    }
    let words: Vec<&str> = n.split(' ').collect();
    if q.split(' ').all(|w| words.contains(&w)) {
        return 50;
    }
    0
}

/// The element whose name is the query, when it is clearly one: the best
/// score is at least "starts with", and any other element as good is the same
/// thing (its centre inside it, as a desktop icon's label and its icon).
pub fn by_name<'a>(elements: &'a [Element], query: &str) -> Option<&'a Element> {
    let scored: Vec<(u32, &Element)> = elements.iter().map(|e| (name_score(query, &e.name), e)).filter(|(s, _)| *s >= 70).collect();
    let best = scored.iter().map(|(s, _)| *s).max()?;
    let top: Vec<&Element> = scored.iter().filter(|(s, _)| *s == best).map(|(_, e)| *e).collect();
    let first = top[0];
    let same = |e: &Element| {
        let (cx, cy) = e.center();
        cx >= first.rect.0 && cx <= first.rect.2 && cy >= first.rect.1 && cy <= first.rect.3
    };
    top.iter().all(|e| same(e)).then_some(first)
}

/// At most `max` elements for the model to choose from, the likeliest first:
/// those whose name shares words with what is asked, then those in the window
/// the user is in.
pub fn shortlist<'a>(elements: &'a [Element], asked: &str, max: usize) -> Vec<&'a Element> {
    let words: Vec<String> = normalize(asked).split(' ').filter(|w| w.len() > 1).map(str::to_string).collect();
    let overlap = |e: &Element| {
        let name = normalize(&e.name);
        let have: Vec<&str> = name.split(' ').collect();
        words.iter().filter(|w| have.contains(&w.as_str())).count()
    };
    let mut list: Vec<&Element> = elements.iter().collect();
    // Stable: the order Windows gave stays within each rank.
    list.sort_by_key(|e| (std::cmp::Reverse(overlap(e)), !e.front));
    list.truncate(max);
    list
}

/// The elements on screen now. Blocking; empty where UI Automation is not there.
pub fn elements() -> Vec<Element> {
    imp::elements()
}

#[cfg(not(windows))]
mod imp {
    use super::Element;

    pub fn elements() -> Vec<Element> {
        Vec::new()
    }
}

#[cfg(windows)]
mod imp {
    use super::{kind_name, Element};

    use ::windows::core::{w, BOOL, PCWSTR};
    use ::windows::Win32::Foundation::{HWND, LPARAM, POINT};
    use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use ::windows::Win32::System::Variant::VARIANT;
    use ::windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId,
        UIA_IsOffscreenPropertyId, UIA_NamePropertyId,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, WindowFromPoint,
        GA_ROOT,
    };

    /// A window tree as big as a web page's is cut here.
    const MAX_ELEMENTS: i32 = 6000;

    fn pid(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    fn root(hwnd: HWND) -> HWND {
        unsafe { GetAncestor(hwnd, GA_ROOT) }
    }

    /// The list view of the desktop's icons: under Progman, or under one of
    /// the WorkerW windows once the wallpaper has been changed.
    fn desktop_icons() -> Option<HWND> {
        fn list_in(parent: HWND) -> Option<HWND> {
            let view = unsafe { FindWindowExW(Some(parent), None, w!("SHELLDLL_DefView"), PCWSTR::null()) }.ok()?;
            unsafe { FindWindowExW(Some(view), None, w!("SysListView32"), PCWSTR::null()) }.ok()
        }
        if let Some(list) = unsafe { FindWindowW(w!("Progman"), PCWSTR::null()) }.ok().and_then(list_in) {
            return Some(list);
        }
        unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
            let found = unsafe { &mut *(data.0 as *mut Option<HWND>) };
            if let Some(list) = list_in(hwnd) {
                *found = Some(list);
                return false.into();
            }
            true.into()
        }
        let mut found: Option<HWND> = None;
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
        }
        found
    }

    /// What is at `p` on screen belongs to `source`'s window (or to Lumo,
    /// which sits over everything and lets clicks through where it is empty).
    fn visible_at(p: POINT, source: HWND, own: u32) -> bool {
        let at = unsafe { WindowFromPoint(p) };
        if at.is_invalid() {
            return false;
        }
        let at = root(at);
        at == root(source) || pid(at) == own
    }

    pub fn elements() -> Vec<Element> {
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let out = collect().unwrap_or_else(|e| {
            crate::log::line(format!("point: UI Automation: {}", e.message()));
            Vec::new()
        });
        if com.is_ok() {
            unsafe { CoUninitialize() };
        }
        out
    }

    fn collect() -> ::windows::core::Result<Vec<Element>> {
        let ua: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
        let cache = unsafe { ua.CreateCacheRequest()? };
        for property in [UIA_NamePropertyId, UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_IsOffscreenPropertyId] {
            unsafe { cache.AddProperty(property)? };
        }
        let onscreen = unsafe { ua.CreatePropertyCondition(UIA_IsOffscreenPropertyId, &VARIANT::from(false))? };
        let controls = unsafe { ua.ControlViewCondition()? };
        let condition = unsafe { ua.CreateAndCondition(&onscreen, &controls)? };

        let own = std::process::id();
        let mut sources: Vec<(HWND, String, bool)> = Vec::new();
        let front = unsafe { GetForegroundWindow() };
        if !front.is_invalid() && pid(root(front)) != own {
            let front = root(front);
            sources.push((front, crate::screen::exe_name(pid(front)), true));
        }
        if let Some(list) = desktop_icons() {
            sources.push((list, "desktop".into(), false));
        }
        if let Ok(taskbar) = unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) } {
            sources.push((taskbar, "taskbar".into(), false));
        }

        let mut out: Vec<Element> = Vec::new();
        for (hwnd, source, front) in sources {
            let Ok(element) = (unsafe { ua.ElementFromHandle(hwnd) }) else { continue };
            let Ok(found) = (unsafe { element.FindAllBuildCache(TreeScope_Descendants, &condition, &cache) }) else { continue };
            let count = unsafe { found.Length() }.unwrap_or(0).min(MAX_ELEMENTS);
            for i in 0..count {
                let Ok(e) = (unsafe { found.GetElement(i) }) else { continue };
                let Some(kind) = unsafe { e.CachedControlType() }.ok().and_then(|k| kind_name(k.0)) else { continue };
                let name = unsafe { e.CachedName() }.map(|b| b.to_string()).unwrap_or_default();
                let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
                if name.is_empty() {
                    continue;
                }
                let Ok(r) = (unsafe { e.CachedBoundingRectangle() }) else { continue };
                if r.right - r.left < 2 || r.bottom - r.top < 2 {
                    continue;
                }
                let center = POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
                // Covered by another window (a desktop icon under an app): not clickable now.
                if !visible_at(center, hwnd, own) {
                    continue;
                }
                let rect = (r.left, r.top, r.right, r.bottom);
                if out.iter().any(|o| o.rect == rect && o.name == name) {
                    continue;
                }
                out.push(Element { name, kind, rect, source: source.clone(), front });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(name: &str, rect: (i32, i32, i32, i32), front: bool) -> Element {
        Element { name: name.into(), kind: "list item", rect, source: "desktop".into(), front }
    }

    #[test]
    fn names_are_compared_as_words() {
        assert_eq!(normalize("  Open-WebUI (2) "), "open webui 2");
        assert_eq!(name_score("Open WebUI", "Open WebUI"), 100);
        assert_eq!(name_score("open webui", "Open WebUI - Shortcut"), 70);
        assert_eq!(name_score("Send", "Send message"), 70);
        assert_eq!(name_score("message send", "Send message"), 50);
        assert_eq!(name_score("Chrome", "Google Chrome"), 50);
        assert_eq!(name_score("Open", "OpenAI"), 0, "a word, not a part of one");
        assert_eq!(name_score("", "x"), 0);
    }

    #[test]
    fn a_name_picks_the_element_only_when_it_is_clearly_one() {
        let desktop = [
            el("Microsoft Edge", (10, 90, 70, 160), false),
            el("Open WebUI", (10, 520, 70, 590), false),
            el("LM Studio", (10, 350, 70, 420), false),
        ];
        assert_eq!(by_name(&desktop, "open webui").unwrap().rect, (10, 520, 70, 590));
        assert!(by_name(&desktop, "Visual Studio Code").is_none());
        // Two different "Settings": the model chooses.
        let two = [el("Settings", (0, 0, 10, 10), true), el("Settings", (500, 500, 510, 510), false)];
        assert!(by_name(&two, "Settings").is_none());
        // The icon and its label, one inside the other: the same thing.
        let nested = [el("Open WebUI", (10, 520, 70, 590), false), el("Open WebUI", (12, 560, 68, 588), false)];
        assert!(by_name(&nested, "Open WebUI").is_some());
    }

    #[test]
    fn the_shortlist_puts_what_is_asked_first_then_the_front_window() {
        let list = [el("Cestino", (0, 0, 1, 1), false), el("Send", (0, 0, 1, 1), true), el("Send message", (0, 0, 1, 1), false)];
        let names: Vec<&str> = shortlist(&list, "the send message button", 10).iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Send message", "Send", "Cestino"]);
        assert_eq!(shortlist(&list, "", 1).len(), 1);
    }

    #[test]
    fn containers_are_not_pointed_at() {
        assert_eq!(kind_name(50000), Some("button"));
        assert_eq!(kind_name(50007), Some("list item"));
        assert_eq!(kind_name(50032), None, "a window");
        assert_eq!(kind_name(50033), None, "a pane");
    }
}
