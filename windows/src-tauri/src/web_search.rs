// Lumo's own web search, for the chat's providers that have none of their
// own (the local servers, OpenAI, Google, OpenRouter): Settings → General →
// Security → Web search, off until the user turns it on.
//
// No key, no account, nothing to pay. The question goes at once to
// DuckDuckGo (its HTML form), Brave, Bing and Mojeek, with Bing News' latest
// next to them, as Unsloth Studio's search does; Wikipedia only when none of
// them answers, and said so to the model (an engine that takes Lumo for a
// robot gives a page with no results: an error, in the log, not an empty
// search). The pages found are read from this
// computer, their text pulled out of the HTML, cut into passages and ranked
// against the question here (BM25, and the embedding model of the chat's
// Ollama or LM Studio when it has one). The model gets only the best
// passages, each with its page's title and link, so a small local context
// goes a long way.
//
// Only public addresses are opened: never this machine or the home network,
// redirects included.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde_json::{json, Value};

use crate::claude_code::Activity;

pub const SEARCH: &str = "web_search";
pub const FETCH: &str = "web_fetch";
pub const NAMES: [&str; 2] = [SEARCH, FETCH];

/// How long a search engine may take.
const TIMEOUT: Duration = Duration::from_secs(6);
/// How long a page may take, redirects and all: the search goes on with the
/// pages that came, and a slow one's snippet stands for it.
const PAGE_TIMEOUT: Duration = Duration::from_millis(3_500);
/// The most of a page that is read.
const MAX_PAGE: usize = 2 * 1024 * 1024;
/// The results whose pages are read.
const PAGES: usize = 6;
/// The passages a search gives the model, the most from one page, and their length in all.
const PASSAGES: usize = 8;
const PER_PAGE: usize = 3;
const BUDGET: usize = 9_000;
/// The length of a passage, about.
const CHUNK: usize = 700;
/// The most of a page web_fetch gives.
const FETCH_MAX: usize = 15_000;
/// The same question within this long is answered from what was found.
const FRESH: Duration = Duration::from_secs(10 * 60);
/// What the pages and the search engines are told is asking: a browser's
/// words, as the engines block whatever else (Lumo's name in it included).
const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

static CACHE: Mutex<Option<HashMap<String, (Instant, String)>>> = Mutex::new(None);

/// Whether the user turned the search on (Settings → General → Security).
pub fn enabled() -> bool {
    crate::settings::load().chat_web_search
}

/// The two tools, as the chat's API providers take them: id, the words the
/// model reads, and the schema of the input.
pub fn api_tools() -> Vec<(String, String, Value)> {
    vec![
        (
            SEARCH.into(),
            "Search the web. Returns the most relevant passages of the top pages, each with its title and link, then other results. Use it for anything current, specific or that you are not sure of: news, prices, opening hours, versions, people, places, facts to check. Write the query as you would in a search engine, in the language most likely to find good pages.".into(),
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to search for." },
                    "time_range": { "type": "string", "enum": ["day", "week", "month", "year"], "description": "Only pages from this recent period." },
                    "sites": { "type": "array", "items": { "type": "string" }, "description": "Only these sites, such as wikipedia.org." }
                },
                "required": ["query"]
            }),
        ),
        (
            FETCH.into(),
            "Read a web page: its title and main text, without menus or ads. Use it for a link the user gives you, or to read more of a page web_search found. With focus, only the passages about it.".into(),
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The page's http or https address." },
                    "focus": { "type": "string", "description": "What to look for in the page." }
                },
                "required": ["url"]
            }),
        ),
    ]
}

/// What the system prompt says of the two tools.
pub const NOTE: &str = " Web search: web_search searches the web and gives you the best passages of the top pages with their links; web_fetch reads a page. Search whenever the answer depends on current or specific facts, instead of guessing, and search again with other words when the first results don't answer. Base the answer on what you found and cite the pages you used as Markdown links.";

/// What the island shows while the tool runs.
pub fn activity(id: &str) -> Activity {
    if id == SEARCH {
        Activity::new("web", "")
    } else {
        Activity::new("tool", crate::claude_code::pretty_tool(id))
    }
}

/// A call from the chat: what goes back to the model, and whether it failed.
pub async fn call(id: &str, input: &Value, provider: &str) -> (String, bool) {
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let result = if id == SEARCH {
        let sites: Vec<String> = input
            .get("sites")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).filter_map(site).take(5).collect())
            .unwrap_or_default();
        let range = text("time_range");
        search(&text("query"), &range, &sites, provider).await
    } else {
        fetch(&text("url"), &text("focus"), provider).await
    };
    match result {
        Ok(text) => (text, false),
        Err(e) => (e, true),
    }
}

// ── Search ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Default)]
struct Hit {
    title: String,
    url: String,
    snippet: String,
    /// When it was published, as the engine says (the news).
    date: String,
}

async fn search(query: &str, range: &str, sites: &[String], provider: &str) -> Result<String, String> {
    let query: String = query.chars().take(400).collect();
    if query.is_empty() {
        return Err("Write what to search for in query.".into());
    }
    let range = match range {
        "day" | "week" | "month" | "year" => range,
        _ => "",
    };
    let key = format!("{query}\u{1}{range}\u{1}{}", sites.join(","));
    if let Some(found) = cached(&key) {
        return Ok(found);
    }
    let asked = if sites.is_empty() {
        query.clone()
    } else {
        format!("{query} {}", sites.iter().map(|s| format!("site:{s}")).collect::<Vec<_>>().join(" OR "))
    };
    let (engine, hits, failed) = find(&asked, &query, range).await?;
    let hits: Vec<Hit> = dedupe(hits).into_iter().take(10).collect();
    if hits.is_empty() {
        return Ok(format!("No web results for \"{query}\". Try other words."));
    }
    // The top pages, read at once.
    let mut jobs = Vec::new();
    for hit in hits.iter().take(PAGES) {
        let url = hit.url.clone();
        jobs.push(tauri::async_runtime::spawn(async move { tokio::time::timeout(PAGE_TIMEOUT, read_page(&url)).await.ok().and_then(Result::ok) }));
    }
    let mut pages = Vec::new();
    for job in jobs {
        pages.push(job.await.ok().flatten());
    }
    let mut chunks: Vec<(usize, String)> = Vec::new();
    for (i, page) in pages.iter().enumerate() {
        let read = page.as_ref().map(|p| chunk(&p.text)).unwrap_or_default();
        if read.is_empty() {
            // Too slow, blocked or built by JavaScript: the engine's snippet stands for the page.
            if !hits[i].snippet.is_empty() {
                chunks.push((i, hits[i].snippet.clone()));
            }
        } else {
            chunks.extend(read.into_iter().map(|c| (i, c)));
        }
    }
    let picked = rank(&query, &chunks, provider).await;
    let mut text = format_search(&query, engine, &hits, &pages, &chunks, &picked);
    if engine == "Wikipedia" {
        // Not the web: the model is told, so it says the search didn't work
        // rather than that nothing happened.
        text = format!(
            "Only Wikipedia answered: the web search engines gave nothing ({}). These are encyclopedia articles, not the web or the news: if they don't answer, tell the user the web search didn't work this time, and don't say nothing exists.\n\n{text}",
            failed.join("; ")
        );
    } else {
        remember(key, &text);
    }
    Ok(text)
}

/// The results, from the first engine that gives any, with the news of the
/// last days next to them (Bing News, read at the same time). Why each engine
/// gave nothing goes to the log, and the reasons come back too, for when only
/// Wikipedia answered.
async fn find(asked: &str, query: &str, range: &str) -> Result<(&'static str, Vec<Hit>, Vec<String>), String> {
    let news = {
        let (asked, range) = (asked.to_string(), range.to_string());
        tauri::async_runtime::spawn(async move { bing_news(&asked, &range).await })
    };
    let (_, web, mut failed) = find_web(asked, range).await;
    let news = match news.await.map_err(|e| e.to_string()).and_then(|r| r) {
        Ok(news) => news,
        Err(e) => {
            failed.push(e);
            Vec::new()
        }
    };
    for e in &failed {
        crate::log::line(format!("[web] {e}"));
    }
    let recent = matches!(range, "day" | "week" | "month");
    if !web.is_empty() || !news.is_empty() {
        let engine = match (web.is_empty(), news.is_empty()) {
            (true, _) => "Bing News",
            (false, true) => "the web",
            (false, false) => "the web and Bing News",
        };
        return Ok((engine, merge(web, news, recent), failed));
    }
    // Wikipedia knows nothing of the last days: no use for news.
    if !matches!(range, "day" | "week") {
        match wikipedia(query).await {
            Ok(hits) if !hits.is_empty() => return Ok(("Wikipedia", hits, failed)),
            Ok(_) => {}
            Err(e) => failed.push(e),
        }
    }
    // Every engine failed (none said it simply had nothing): the search didn't work.
    if !failed.is_empty() && !failed.iter().any(|e| e.ends_with("gave no results")) {
        return Err(format!("The web search engines gave no results ({}). Tell the user the web search didn't work this time, not that nothing exists.", failed.join("; ")));
    }
    Ok(("", Vec::new(), failed))
}

/// The web results: DuckDuckGo, Brave, Bing and Mojeek asked at once (a
/// slow or blocked one costs no more than the others), their results taken
/// in turn, best first, and why the ones that gave nothing gave nothing.
async fn find_web(asked: &str, range: &str) -> (&'static str, Vec<Hit>, Vec<String>) {
    let (q, r) = (asked.to_string(), range.to_string());
    let (q2, r2, q3, r3, q4) = (q.clone(), r.clone(), q.clone(), r.clone(), q.clone());
    let jobs = [
        ("DuckDuckGo", tauri::async_runtime::spawn(async move { duckduckgo(&q, &r).await })),
        ("Brave", tauri::async_runtime::spawn(async move { brave(&q2, &r2).await })),
        ("Bing", tauri::async_runtime::spawn(async move { bing(&q3, &r3).await })),
        ("Mojeek", tauri::async_runtime::spawn(async move { mojeek(&q4).await })),
    ];
    let mut failed = Vec::new();
    let mut found: Vec<(&'static str, Vec<Hit>)> = Vec::new();
    for (name, job) in jobs {
        match job.await.map_err(|e| e.to_string()).and_then(|r| r) {
            Ok(hits) if !hits.is_empty() => found.push((name, hits)),
            Ok(_) => failed.push(format!("{name} gave no results")),
            Err(e) => failed.push(e),
        }
    }
    let Some(engine) = found.first().map(|(name, _)| *name) else {
        return ("", Vec::new(), failed);
    };
    (engine, take_turns(found.into_iter().map(|(_, hits)| hits).collect()), failed)
}

/// Each engine's first result, then each one's second, and so on.
fn take_turns(lists: Vec<Vec<Hit>>) -> Vec<Hit> {
    let mut lists: Vec<std::vec::IntoIter<Hit>> = lists.into_iter().map(Vec::into_iter).collect();
    let mut out = Vec::new();
    loop {
        let before = out.len();
        for list in &mut lists {
            out.extend(list.next());
        }
        if out.len() == before {
            return out;
        }
    }
}

/// The web's results and the news, together: for a recent period the news
/// first, else the first web results, then the news, then the rest.
fn merge(web: Vec<Hit>, news: Vec<Hit>, recent: bool) -> Vec<Hit> {
    if recent {
        return news.into_iter().chain(web).collect();
    }
    let mut web = web.into_iter();
    let first: Vec<Hit> = web.by_ref().take(3).collect();
    first.into_iter().chain(news.into_iter().take(3)).chain(web).collect()
}

fn client(redirects: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(AGENT)
        .connect_timeout(Duration::from_secs(5))
        .timeout(TIMEOUT)
        .redirect(if redirects { reqwest::redirect::Policy::limited(5) } else { reqwest::redirect::Policy::none() })
        .build()
        .map_err(|e| e.to_string())
}

/// The language pages are asked in: the app's.
fn language() -> String {
    let lang = crate::i18n::current();
    let short = lang.split('-').next().unwrap_or("en");
    if short == "en" {
        "en".into()
    } else {
        format!("{lang},{short};q=0.9,en;q=0.6")
    }
}

/// A search engine's page, as text.
async fn engine_page(url: Url) -> Result<String, String> {
    let host = url.host_str().unwrap_or("").to_string();
    let response = client(true)?
        .get(url)
        .header("Accept", "text/html")
        .header("Accept-Language", language())
        .send()
        .await
        .map_err(|_| format!("{host} didn't answer"))?;
    engine_text(&host, response).await
}

/// An engine's answer as text: only a page of results, never one that asks
/// to prove one isn't a robot.
async fn engine_text(host: &str, response: reqwest::Response) -> Result<String, String> {
    let status = response.status().as_u16();
    // DuckDuckGo answers 202 with a page asking to prove it's not a robot.
    if status != 200 {
        return Err(format!("{host} answered {status}{}", if status == 202 || status == 403 || status == 429 { " (it took Lumo for a robot)" } else { "" }));
    }
    let page = String::from_utf8_lossy(&read_some(response, MAX_PAGE).await).into_owned();
    if is_challenge(&page) {
        return Err(format!("{host} asked to prove it's not a robot"));
    }
    Ok(page)
}

/// A page that asks to prove one isn't a robot instead of giving results.
fn is_challenge(page: &str) -> bool {
    let head: String = page.chars().take(200_000).collect::<String>().to_ascii_lowercase();
    ["anomaly-modal", "challenge-form", "g-recaptcha", "h-captcha", "cf-challenge", "/captcha", "id=\"captcha"].iter().any(|m| head.contains(m))
}

/// DuckDuckGo's HTML page, sent as its own form sends it (POST): a GET is
/// what it takes for a robot first.
async fn duckduckgo(query: &str, range: &str) -> Result<Vec<Hit>, String> {
    let mut params = vec![("q", query), ("b", ""), ("l", "wt-wt")];
    let df = range.get(..1).unwrap_or("");
    if !df.is_empty() {
        params.push(("df", df));
    }
    let form = Url::parse_with_params("https://x.invalid/", &params).map_err(|e| e.to_string())?.query().unwrap_or("").to_string();
    let url = Url::parse("https://html.duckduckgo.com/html/").map_err(|e| e.to_string())?;
    let host = "html.duckduckgo.com";
    let response = client(true)?
        .post(url)
        .header("Accept", "text/html")
        .header("Accept-Language", language())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Origin", "https://html.duckduckgo.com")
        .header("Referer", "https://html.duckduckgo.com/")
        .body(form)
        .send()
        .await
        .map_err(|_| format!("{host} didn't answer"))?;
    Ok(parse_duckduckgo(&engine_text(host, response).await?))
}

/// Brave Search's page (its own index, not Bing's or Google's).
async fn brave(query: &str, range: &str) -> Result<Vec<Hit>, String> {
    let mut params = vec![("q", query), ("source", "web")];
    let tf = match range {
        "day" => "pd",
        "week" => "pw",
        "month" => "pm",
        "year" => "py",
        _ => "",
    };
    if !tf.is_empty() {
        params.push(("tf", tf));
    }
    let url = Url::parse_with_params("https://search.brave.com/search", &params).map_err(|e| e.to_string())?;
    let response = client(true)?
        .get(url)
        .header("Accept", "text/html")
        .header("Accept-Language", language())
        .header("Cookie", "useLocation=0")
        .send()
        .await
        .map_err(|_| "search.brave.com didn't answer".to_string())?;
    Ok(parse_brave(&engine_text("search.brave.com", response).await?))
}

async fn mojeek(query: &str) -> Result<Vec<Hit>, String> {
    let url = Url::parse_with_params("https://www.mojeek.com/search", &[("q", query)]).map_err(|e| e.to_string())?;
    Ok(parse_mojeek(&engine_page(url).await?))
}

async fn bing(query: &str, range: &str) -> Result<Vec<Hit>, String> {
    let lang = crate::i18n::current().split('-').next().unwrap_or("en").to_lowercase();
    let mut params = vec![("q", query.to_string()), ("setlang", lang)];
    // Bing's own filter for a recent period.
    let filter = match range {
        "day" => "ex1:\"ez1\"",
        "week" => "ex1:\"ez2\"",
        "month" => "ex1:\"ez3\"",
        _ => "",
    };
    if !filter.is_empty() {
        params.push(("filters", filter.to_string()));
    }
    let url = Url::parse_with_params("https://www.bing.com/search", &params).map_err(|e| e.to_string())?;
    Ok(parse_bing(&engine_page(url).await?))
}

/// The news of the last days on the question (Bing News' RSS), with their date.
async fn bing_news(query: &str, range: &str) -> Result<Vec<Hit>, String> {
    let lang = crate::i18n::current().split('-').next().unwrap_or("en").to_lowercase();
    let mut params = vec![("q", query.to_string()), ("format", "rss".to_string()), ("setlang", lang)];
    let interval = match range {
        "day" => "7",
        "week" => "8",
        "month" => "9",
        _ => "",
    };
    if !interval.is_empty() {
        params.push(("qft", format!("interval=\"{interval}\"")));
    }
    let url = Url::parse_with_params("https://www.bing.com/news/search", &params).map_err(|e| e.to_string())?;
    Ok(parse_news_rss(&engine_page(url).await.map_err(|e| format!("Bing News: {e}"))?).into_iter().take(6).collect())
}

async fn wikipedia(query: &str) -> Result<Vec<Hit>, String> {
    let lang = crate::i18n::current().split('-').next().unwrap_or("en").to_lowercase();
    let lang = if lang.chars().all(|c| c.is_ascii_lowercase()) && (2..=3).contains(&lang.len()) { lang } else { "en".into() };
    let api = format!("https://{lang}.wikipedia.org/w/api.php");
    let url = Url::parse_with_params(&api, &[("action", "query"), ("list", "search"), ("srsearch", query), ("format", "json"), ("srlimit", "6"), ("utf8", "1")])
        .map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_str(&engine_page(url).await?).map_err(|_| "Wikipedia gave no results".to_string())?;
    Ok(parse_wikipedia(&body, &lang))
}

fn parse_duckduckgo(html: &str) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for (tag, start, end) in tags(html, "a") {
        let class = attr(tag, "class").unwrap_or_default();
        if class.split_whitespace().any(|c| c == "result__a") {
            let Some(url) = attr(tag, "href").and_then(|h| duckduckgo_target(&h)) else { continue };
            hits.push(Hit { title: inline_text(&html[start..end]), url, snippet: String::new(), date: String::new() });
        } else if class.split_whitespace().any(|c| c == "result__snippet") {
            if let Some(last) = hits.last_mut().filter(|h| h.snippet.is_empty()) {
                last.snippet = inline_text(&html[start..end]);
            }
        }
    }
    hits
}

/// The page a DuckDuckGo result leads to (its links go through /l/?uddg=); none for its ads.
fn duckduckgo_target(href: &str) -> Option<String> {
    let href = decode_entities(href);
    let full = if href.starts_with("//") { format!("https:{href}") } else { href };
    let url = Url::parse(&full).ok()?;
    let host = url.host_str()?.to_lowercase();
    let target = if host.ends_with("duckduckgo.com") {
        if url.path() != "/l/" {
            return None;
        }
        url.query_pairs().find(|(k, _)| k == "uddg").map(|(_, v)| v.into_owned())?
    } else {
        full
    };
    page_url(&target)
}

fn parse_mojeek(html: &str) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for (tag, start, end) in tags(html, "a") {
        let class = attr(tag, "class").unwrap_or_default();
        if !class.split_whitespace().any(|c| c == "title") {
            continue;
        }
        let Some(url) = attr(tag, "href").and_then(|h| page_url(&decode_entities(&h))) else { continue };
        // The snippet: the <p class="s"> after the title.
        let rest = &html[end..];
        let next = rest.find("class=\"title\"").unwrap_or(rest.len());
        let snippet = rest[..next]
            .find("<p class=\"s\"")
            .and_then(|at| {
                let from = at + rest[at..].find('>')? + 1;
                let to = from + rest[from..].find("</p>")?;
                Some(inline_text(&rest[from..to]))
            })
            .unwrap_or_default();
        hits.push(Hit { title: inline_text(&html[start..end]), url, snippet, date: String::new() });
    }
    hits
}

/// Bing's results: each `b_algo` block, its link in the `h2`, its snippet in the first paragraph.
fn parse_bing(html: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut blocks: Vec<&str> = html.split("class=\"b_algo").skip(1).collect();
    if blocks.is_empty() {
        blocks = html.split("class=\"b_algo ").skip(1).collect();
    }
    for block in blocks {
        let block = block.split("class=\"b_algo").next().unwrap_or(block);
        let Some((_, h2, h2_end)) = tags(block, "h2").into_iter().next() else { continue };
        let Some((tag, start, end)) = tags(&block[h2..h2_end], "a").into_iter().next() else { continue };
        let Some(url) = attr(tag, "href").and_then(|h| bing_target(&decode_entities(&h))) else { continue };
        let title = inline_text(&block[h2..h2_end][start..end]);
        let snippet = tags(&block[h2_end..], "p").into_iter().next().map(|(_, s, e)| inline_text(&block[h2_end..][s..e])).unwrap_or_default();
        hits.push(Hit { title, url, snippet, date: String::new() });
    }
    hits
}

/// Brave's results: each `data-type="web"` block, its link the one around
/// the title, its snippet in the `content` of the `snippet`.
fn parse_brave(html: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    for block in html.split("data-type=\"web\"").skip(1) {
        let block = block.split("data-type=\"").next().unwrap_or(block);
        let link = tags(block, "a").into_iter().find_map(|(tag, start, end)| {
            let inner = &block[start..end];
            (inner.contains("title") || inner.contains("sitename")).then(|| attr(tag, "href")).flatten().and_then(|h| page_url(&decode_entities(&h)))
        });
        let Some(url) = link else { continue };
        let class_has = |tag: &str, word: &str| attr(tag, "class").is_some_and(|c| c.split_whitespace().any(|c| c.contains(word)));
        let has_class = |tag: &str, word: &str| attr(tag, "class").is_some_and(|c| c.split_whitespace().any(|c| c == word));
        let divs = nested_tags(block, "div");
        let title = divs.iter().filter(|(tag, _, _)| class_has(tag, "title")).map(|(_, s, e)| inline_text(&block[*s..*e])).find(|t| !t.is_empty()).unwrap_or_default();
        let snippet = divs.iter().filter(|(tag, _, _)| has_class(tag, "content") || has_class(tag, "snippet-description")).map(|(_, s, e)| inline_text(&block[*s..*e])).find(|t| !t.is_empty()).unwrap_or_default();
        if !title.is_empty() {
            hits.push(Hit { title, url, snippet, date: String::new() });
        }
    }
    hits
}

/// The page a Bing result leads to: its links may go through bing.com/ck/a,
/// the address in `u` as "a1" and base64.
fn bing_target(href: &str) -> Option<String> {
    let url = Url::parse(href).ok()?;
    let host = url.host_str()?.to_lowercase();
    if host.ends_with("bing.com") || host.ends_with("microsoft.com") {
        let u = url.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.into_owned())?;
        let decoded = base64url(u.strip_prefix("a1")?)?;
        return page_url(&String::from_utf8(decoded).ok()?);
    }
    page_url(href)
}

/// Base64 in its URL alphabet (or the usual one), padding or not.
fn base64url(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// A news RSS: each item's title, the article it leads to, and its date before its summary.
fn parse_news_rss(xml: &str) -> Vec<Hit> {
    let field = |item: &str, name: &str| {
        tags(item, name).into_iter().next().map(|(_, s, e)| {
            let raw = item[s..e].trim();
            let raw = raw.strip_prefix("<![CDATA[").and_then(|r| r.strip_suffix("]]>")).unwrap_or(raw);
            inline_text(&decode_entities(raw))
        })
    };
    let mut hits = Vec::new();
    for (_, start, end) in tags(xml, "item") {
        let item = &xml[start..end];
        let Some(link) = field(item, "link") else { continue };
        // Bing News' links go through apiclick.aspx, the article in `url`.
        let target = Url::parse(&link)
            .ok()
            .filter(|u| u.host_str().is_some_and(|h| h.to_lowercase().ends_with("bing.com")))
            .and_then(|u| u.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned()))
            .unwrap_or(link);
        let Some(url) = page_url(&target) else { continue };
        let title = field(item, "title").unwrap_or_default();
        let date = field(item, "pubdate").unwrap_or_default();
        let snippet = field(item, "description").unwrap_or_default();
        hits.push(Hit { title, url, snippet, date });
    }
    hits
}

fn parse_wikipedia(body: &Value, lang: &str) -> Vec<Hit> {
    body.pointer("/query/search")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let title = r["title"].as_str()?;
                    let mut url = Url::parse(&format!("https://{lang}.wikipedia.org/wiki/")).ok()?;
                    url.path_segments_mut().ok()?.pop().push(&title.replace(' ', "_"));
                    Some(Hit { title: title.to_string(), url: url.to_string(), snippet: inline_text(r["snippet"].as_str().unwrap_or("")), date: String::new() })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// An http(s) address of a page, without its fragment; none for anything else.
fn page_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

/// A site the model limits the search to: a bare host name.
fn site(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_start_matches("https://").trim_start_matches("http://");
    let host = raw.split('/').next()?.trim().to_lowercase();
    (!host.is_empty() && host.len() <= 100 && host.contains('.') && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')).then_some(host)
}

fn dedupe(hits: Vec<Hit>) -> Vec<Hit> {
    let mut seen = HashSet::new();
    hits.into_iter().filter(|h| seen.insert(h.url.trim_end_matches('/').to_string())).collect()
}

fn cached(key: &str) -> Option<String> {
    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.as_ref()?.get(key).filter(|(at, _)| at.elapsed() < FRESH).map(|(_, text)| text.clone())
}

fn remember(key: String, text: &str) {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let all = cache.get_or_insert_with(HashMap::new);
    all.retain(|_, (at, _)| at.elapsed() < FRESH);
    if all.len() >= 50 {
        all.clear();
    }
    all.insert(key, (Instant::now(), text.to_string()));
}

// ── Pages ──────────────────────────────────────────────────────────────────

#[derive(Debug)]
struct Page {
    title: String,
    url: String,
    text: String,
}

async fn fetch(raw: &str, focus: &str, provider: &str) -> Result<String, String> {
    let url = page_url(raw).ok_or_else(|| "Give an http or https address in url.".to_string())?;
    let page = read_page(&url).await?;
    if page.text.trim().is_empty() {
        return Ok(format!("{}\n{}\n\nThe page has no text Lumo can read (it may need JavaScript, or be an image or a file).", page.title, page.url));
    }
    let focus = focus.trim();
    let body = if focus.is_empty() || page.text.len() <= FETCH_MAX {
        clip(&page.text, FETCH_MAX)
    } else {
        let chunks: Vec<(usize, String)> = chunk(&page.text).into_iter().map(|c| (0, c)).collect();
        let picked = rank(focus, &chunks, provider).await;
        let mut out = String::new();
        for &i in picked.iter().take(12) {
            if out.len() + chunks[i].1.len() > FETCH_MAX {
                break;
            }
            out.push_str(&chunks[i].1);
            out.push_str("\n\n[…]\n\n");
        }
        out
    };
    Ok(format!("{}\n{}\n\n{}", page.title, page.url, body.trim_end()))
}

/// A page read from this computer: only a public address, redirects too.
async fn read_page(raw: &str) -> Result<Page, String> {
    let mut url = Url::parse(raw).map_err(|_| "Not a web address.".to_string())?;
    for _ in 0..6 {
        // The connection goes to the very addresses checked: a name that
        // answers a public address to the check and 127.0.0.1 to the
        // connection (DNS rebinding) reaches nothing on this computer.
        let addrs = check_public(&url).await?;
        let client = pinned_client(&url, &addrs)?;
        let response = client
            .get(url.clone())
            .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
            .header("Accept-Language", language())
            .send()
            .await
            .map_err(|e| format!("{} didn't answer: {}", url.host_str().unwrap_or(""), if e.is_timeout() { "too slow" } else { "no connection" }))?;
        let status = response.status();
        if status.is_redirection() {
            let next = response.headers().get("location").and_then(|l| l.to_str().ok()).and_then(|l| url.join(l).ok());
            url = next.filter(|u| matches!(u.scheme(), "http" | "https")).ok_or_else(|| "The page sent a broken redirect.".to_string())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("{} answered {}.", url, status.as_u16()));
        }
        let kind = response.headers().get("content-type").and_then(|c| c.to_str().ok()).unwrap_or("").to_lowercase();
        let text_like = kind.is_empty() || kind.contains("html") || kind.contains("text/plain") || kind.contains("xml");
        if !text_like {
            return Err(format!("{url} is not a web page ({}).", kind.split(';').next().unwrap_or("")));
        }
        let body = String::from_utf8_lossy(&read_some(response, MAX_PAGE).await).into_owned();
        let (title, text) = if kind.contains("text/plain") { (String::new(), body) } else { extract(&body) };
        let title = if title.is_empty() { url.host_str().unwrap_or("").to_string() } else { title };
        return Ok(Page { title, url: url.to_string(), text });
    }
    Err("The page redirects too many times.".into())
}

/// Up to `limit` bytes of the body; what comes after is left.
async fn read_some(mut response: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= limit {
            body.truncate(limit);
            break;
        }
    }
    body
}

/// A client that reaches `url`'s host only at `addrs` (none: an address given as is).
fn pinned_client(url: &Url, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(AGENT)
        .connect_timeout(Duration::from_secs(5))
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let (Some(host), false) = (url.host_str(), addrs.is_empty()) {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Only addresses on the internet: never this machine or the local network.
/// The addresses the host's name gave, to connect to those and no others.
async fn check_public(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let refused = || format!("{url} is not a public web address.");
    if !matches!(url.scheme(), "http" | "https") {
        return Err(refused());
    }
    let host = url.host_str().ok_or_else(refused)?.trim_start_matches('[').trim_end_matches(']').to_string();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if is_public(ip) { Ok(Vec::new()) } else { Err(refused()) };
    }
    let lower = host.to_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") || lower.ends_with(".internal") || !lower.contains('.') {
        return Err(refused());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| format!("{host} was not found."))?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(refused());
    }
    Ok(addrs)
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            let first = seg[0];
            let v4 = |hi: u16, lo: u16| IpAddr::V4(Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8));
            // An IPv4 address carried in an IPv6 one counts as that address:
            // NAT64 (64:ff9b::/96) at its end, 6to4 (2002::/16) after the prefix.
            if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return is_public(v4(seg[6], seg[7]));
            }
            if first == 0x2002 {
                return is_public(v4(seg[1], seg[2]));
            }
            // Documentation (2001:db8::/32) and the old IPv4-compatible ::a.b.c.d.
            if (first == 0x2001 && seg[1] == 0x0db8) || seg[..6] == [0, 0, 0, 0, 0, 0] {
                return false;
            }
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80)
        }
    }
}

// ── HTML ───────────────────────────────────────────────────────────────────

/// Tags whose content is never the page's text.
const SKIP: &[&str] = &["script", "style", "noscript", "svg", "template", "iframe", "nav", "footer", "aside", "form", "button", "select", "canvas", "dialog", "head"];
/// Tags that end a line.
const BLOCK: &[&str] = &[
    "p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section", "article", "main", "blockquote", "pre", "dd", "dt", "figcaption", "hr", "header", "td", "th",
];

/// Tags inside a line of text: nothing in their place.
const INLINE: &[&str] = &["a", "b", "i", "em", "strong", "span", "u", "small", "sup", "sub", "code", "mark", "abbr", "time", "font", "s", "q", "cite", "label", "kbd", "var", "bdi", "wbr"];

/// The page's title and its main text, one paragraph a line: what is in its
/// <article> (or <main>) when that holds enough, else the whole body, without
/// scripts, menus, footers and the short lines around them.
fn extract(html: &str) -> (String, String) {
    let title = tags(html, "title").first().map(|(_, s, e)| inline_text(&html[*s..*e])).unwrap_or_default();
    let lower = html.to_ascii_lowercase();
    let region = |name: &str| -> Option<&str> {
        let start = lower.find(&format!("<{name}"))?;
        let end = lower.rfind(&format!("</{name}>"))?;
        (end > start).then(|| &html[start..end])
    };
    let whole = text_of(html);
    for name in ["article", "main"] {
        if let Some(part) = region(name) {
            let text = text_of(part);
            if text.len() >= 500 {
                return (title, text);
            }
        }
    }
    (title, whole)
}

/// The text of an HTML fragment, one line per block.
fn text_of(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let mut text_from = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        out.push_str(&decode_entities(&html[text_from..i]));
        if lower[i..].starts_with("<!--") {
            i = lower[i..].find("-->").map(|e| i + e + 3).unwrap_or(bytes.len());
            text_from = i;
            continue;
        }
        let Some(close) = lower[i..].find('>') else {
            text_from = bytes.len();
            break;
        };
        let tag = &lower[i + 1..i + close];
        let closing = tag.starts_with('/');
        let name: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        let mut next = i + close + 1;
        if !closing && SKIP.contains(&name.as_str()) && !tag.ends_with('/') {
            next = lower[next..].find(&format!("</{name}")).map(|e| next + e).and_then(|e| lower[e..].find('>').map(|c| e + c + 1)).unwrap_or(bytes.len());
        } else if BLOCK.contains(&name.as_str()) {
            out.push('\n');
            if name == "li" && !closing {
                out.push_str("- ");
            }
        } else if !INLINE.contains(&name.as_str()) {
            out.push(' ');
        }
        i = next;
        text_from = next;
    }
    if text_from < bytes.len() {
        out.push_str(&decode_entities(&html[text_from..]));
    }
    clean_lines(&out)
}

/// Lines of real text: spaces collapsed, the short ones (menus, buttons,
/// "Share") and the repeated ones dropped.
fn clean_lines(text: &str) -> String {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let words = line.split(' ').filter(|w| w.chars().any(char::is_alphanumeric)).count();
        if line.is_empty() || line == "-" || (words < 4 && line.chars().count() < 40) {
            continue;
        }
        if seen.insert(line.clone()) {
            out.push(line);
        }
    }
    out.join("\n")
}

/// The text inside a tag, on one line.
fn inline_text(html: &str) -> String {
    text_of(&format!("<p>{html}</p>")).replace('\n', " ").trim().to_string().pipe_or(|| {
        // Short texts (a title) would be dropped as a short line: taken as they are.
        let mut s = String::new();
        let mut inside = false;
        for c in html.chars() {
            match c {
                '<' => inside = true,
                '>' => inside = false,
                c if !inside => s.push(c),
                _ => {}
            }
        }
        decode_entities(&s).split_whitespace().collect::<Vec<_>>().join(" ")
    })
}

trait PipeOr {
    fn pipe_or(self, f: impl FnOnce() -> String) -> String;
}

impl PipeOr for String {
    fn pipe_or(self, f: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            f()
        } else {
            self
        }
    }
}

/// Every `<name …>…</name>` in `html`: the opening tag's text, and where its content starts and ends.
fn tags<'a>(html: &'a str, name: &str) -> Vec<(&'a str, usize, usize)> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = lower[at..].find(&open) {
        let start = at + found;
        let after = lower.as_bytes().get(start + open.len()).copied().unwrap_or(b'>');
        if !(after == b'>' || after.is_ascii_whitespace()) {
            at = start + open.len();
            continue;
        }
        let Some(gt) = lower[start..].find('>') else { break };
        let content = start + gt + 1;
        let end = lower[content..].find(&close).map(|e| content + e).unwrap_or(lower.len());
        out.push((&html[start..content], content, end));
        at = end.max(content);
    }
    out
}

/// Like `tags`, with the ones inside another too (its content ends at the
/// first closing tag, so a leaf's text is whole).
fn nested_tags<'a>(html: &'a str, name: &str) -> Vec<(&'a str, usize, usize)> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = lower[at..].find(&open) {
        let start = at + found;
        at = start + open.len();
        let after = lower.as_bytes().get(at).copied().unwrap_or(b'>');
        if !(after == b'>' || after.is_ascii_whitespace()) {
            continue;
        }
        let Some(gt) = lower[start..].find('>') else { break };
        let content = start + gt + 1;
        let end = lower[content..].find(&close).map(|e| content + e).unwrap_or(lower.len());
        out.push((&html[start..content], content, end));
    }
    out
}

/// An attribute's value in an opening tag.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut at = 0;
    while let Some(found) = lower[at..].find(name) {
        let start = at + found;
        at = start + name.len();
        let before = lower[..start].chars().last().unwrap_or(' ');
        if !before.is_ascii_whitespace() {
            continue;
        }
        let rest = lower[at..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let offset = tag.len() - rest.len();
        let raw = tag[offset..].trim_start();
        let value = match raw.chars().next()? {
            q @ ('"' | '\'') => raw[1..].split(q).next()?.to_string(),
            _ => raw.split(|c: char| c.is_ascii_whitespace() || c == '>').next()?.to_string(),
        };
        return Some(value);
    }
    None
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest[1..].find(';').map(|e| e + 1).filter(|e| *e <= 10);
        let decoded = end.and_then(|e| {
            let name = &rest[1..e];
            let c = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" | "#39" => '\'',
                "nbsp" => ' ',
                "ndash" => '–',
                "mdash" => '—',
                "hellip" => '…',
                "laquo" => '«',
                "raquo" => '»',
                "rsquo" | "lsquo" => '\'',
                "rdquo" | "ldquo" => '"',
                "euro" => '€',
                "copy" => '©',
                _ => {
                    let n = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")).map(|h| u32::from_str_radix(h, 16));
                    let n = n.or_else(|| name.strip_prefix('#').map(|d| d.parse::<u32>()));
                    char::from_u32(n?.ok()?)?
                }
            };
            Some((c, e + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n\n[…the page goes on]", &text[..cut])
}

// ── Passages ───────────────────────────────────────────────────────────────

/// The page's text in passages of about CHUNK characters, at line ends
/// (sentence ends inside a long line).
fn chunk(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let pieces: Vec<String> = if line.len() > CHUNK * 2 { sentences(line) } else { vec![line.to_string()] };
        for piece in pieces {
            if !current.is_empty() && current.len() + piece.len() > CHUNK {
                out.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(&piece);
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out.into_iter().take(200).collect()
}

/// A long line in pieces of about CHUNK characters, cut after a sentence.
fn sentences(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for word in line.split(' ') {
        current.push_str(word);
        current.push(' ');
        let ends = word.ends_with('.') || word.ends_with('!') || word.ends_with('?');
        if (current.len() >= CHUNK && ends) || current.len() >= CHUNK * 2 {
            out.push(current.trim_end().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim_end().to_string());
    }
    out
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(str::to_string).collect()
}

/// BM25 of each passage for the question.
fn bm25(query: &str, chunks: &[(usize, String)]) -> Vec<f64> {
    let terms: Vec<String> = {
        let mut seen = HashSet::new();
        words(query).into_iter().filter(|w| seen.insert(w.clone())).collect()
    };
    let docs: Vec<Vec<String>> = chunks.iter().map(|(_, c)| words(c)).collect();
    let n = docs.len().max(1) as f64;
    let avg = docs.iter().map(Vec::len).sum::<usize>().max(1) as f64 / n;
    let df: Vec<f64> = terms.iter().map(|t| docs.iter().filter(|d| d.contains(t)).count() as f64).collect();
    docs.iter()
        .map(|d| {
            let len = d.len() as f64;
            terms
                .iter()
                .zip(&df)
                .map(|(t, df)| {
                    let tf = d.iter().filter(|w| *w == t).count() as f64;
                    if tf == 0.0 {
                        return 0.0;
                    }
                    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                    idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len / avg))
                })
                .sum()
        })
        .collect()
}

/// The passages in order of how well they answer, best first: BM25, a little
/// for the engine's own order, and the embedding model's similarity when the
/// chat's Ollama or LM Studio has one.
async fn rank(query: &str, chunks: &[(usize, String)], provider: &str) -> Vec<usize> {
    if chunks.is_empty() {
        return Vec::new();
    }
    let lexical = bm25(query, chunks);
    let top = lexical.iter().cloned().fold(0.0_f64, f64::max).max(1e-9);
    let mut scores: Vec<f64> = lexical.iter().zip(chunks).map(|(s, (page, _))| s / top + 0.15 * (1.0 - *page as f64 / PAGES as f64)).collect();
    if matches!(provider, "ollama" | "lmstudio") {
        // The best 60 by BM25 go to the embedding model, with the question first.
        let mut order: Vec<usize> = (0..chunks.len()).collect();
        order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
        order.truncate(60);
        let mut texts = vec![query.to_string()];
        texts.extend(order.iter().map(|&i| chunks[i].1.clone()));
        if let Some(vectors) = crate::local_models::embed(provider, &texts).await.filter(|v| v.len() == texts.len()) {
            for (k, &i) in order.iter().enumerate() {
                scores[i] = 0.4 * scores[i] + 1.2 * cosine(&vectors[0], &vectors[k + 1]);
            }
            for (i, s) in scores.iter_mut().enumerate() {
                if !order.contains(&i) {
                    *s *= 0.4;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..chunks.len()).filter(|&i| lexical[i] > 0.0 || scores[i] > 0.5).collect();
    order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    order
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let dot: f64 = a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum();
    let na: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    let nb: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// What the model gets: the best passages under their page, then the other results.
fn format_search(query: &str, engine: &str, hits: &[Hit], pages: &[Option<Page>], chunks: &[(usize, String)], picked: &[usize]) -> String {
    let mut chosen: Vec<usize> = Vec::new();
    let mut per_page: HashMap<usize, usize> = HashMap::new();
    let mut used = 0;
    for &i in picked {
        let (page, text) = &chunks[i];
        let count = per_page.entry(*page).or_default();
        if *count >= PER_PAGE || used + text.len() > BUDGET {
            continue;
        }
        *count += 1;
        used += text.len();
        chosen.push(i);
        if chosen.len() >= PASSAGES {
            break;
        }
    }
    let mut out = format!("Web results for \"{query}\" ({engine}, pages read on the user's computer):\n");
    // Grouped by page, in the engine's order.
    let mut shown_pages = HashSet::new();
    let mut n = 0;
    for (p, hit) in hits.iter().enumerate() {
        let mine: Vec<&String> = chosen.iter().filter(|&&i| chunks[i].0 == p).map(|&i| &chunks[i].1).collect();
        if mine.is_empty() {
            continue;
        }
        n += 1;
        shown_pages.insert(p);
        let page = pages.get(p).and_then(Option::as_ref);
        let title = page.map(|pg| pg.title.as_str()).filter(|t| !t.is_empty()).unwrap_or(&hit.title);
        let date = if hit.date.is_empty() { String::new() } else { format!("Published: {}\n", hit.date) };
        out.push_str(&format!("\n[{n}] {title}\n{}\n{date}", page.map(|pg| pg.url.as_str()).unwrap_or(&hit.url)));
        for passage in mine {
            out.push_str(&format!("{passage}\n…\n"));
        }
    }
    let others: Vec<&Hit> = hits.iter().enumerate().filter(|(p, _)| !shown_pages.contains(p)).map(|(_, h)| h).collect();
    if !others.is_empty() {
        out.push_str(if n == 0 { "\nResults (their pages could not be read; web_fetch one to read it):\n" } else { "\nOther results:\n" });
        for hit in others {
            let snippet = if hit.snippet.is_empty() { String::new() } else { format!(": {}", clip(&hit.snippet, 300)) };
            let date = if hit.date.is_empty() { String::new() } else { format!(" ({})", hit.date) };
            out.push_str(&format!("- {}{date} — {}{snippet}\n", hit.title, hit.url));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duckduckgo_results_lead_to_their_pages_and_its_ads_are_left_out() {
        let html = r#"
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpasta%3Fa%3D1&amp;rut=abc">How to cook <b>pasta</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Boil water &amp; add <b>salt</b>.</a>
</div>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.com">Buy pasta</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwiki.org%2FPasta%23top">Pasta - Wiki</a></div>"#;
        let hits = parse_duckduckgo(html);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0], Hit { title: "How to cook pasta".into(), url: "https://example.com/pasta?a=1".into(), snippet: "Boil water & add salt.".into(), date: String::new() });
        assert_eq!(hits[1].url, "https://wiki.org/Pasta");
    }

    #[test]
    fn mojeek_and_wikipedia_results_are_read() {
        let html = r#"<ul class="results-standard"><li class="r1"><a class="ob" href="https://a.com/x"><p class="i">a.com</p></a><h2><a class="title" href="https://a.com/x">Alpha &ndash; page</a></h2><p class="s">The first <strong>result</strong>.</p></li>
<li><h2><a class="title" href="https://b.org/">Beta</a></h2><p class="s">Second.</p></li></ul>"#;
        let hits = parse_mojeek(html);
        assert_eq!(hits.iter().map(|h| (h.title.as_str(), h.url.as_str(), h.snippet.as_str())).collect::<Vec<_>>(), vec![
            ("Alpha – page", "https://a.com/x", "The first result."),
            ("Beta", "https://b.org/", "Second."),
        ]);
        let body = json!({ "query": { "search": [{ "title": "Leonardo da Vinci", "snippet": "<span class=\"searchmatch\">Leonardo</span> was" }] } });
        let hits = parse_wikipedia(&body, "it");
        assert_eq!(hits[0].url, "https://it.wikipedia.org/wiki/Leonardo_da_Vinci");
        assert_eq!(hits[0].snippet, "Leonardo was");
    }

    #[test]
    fn bing_results_lead_to_their_pages_through_its_redirects() {
        // https://example.com/news?id=1 as Bing writes it: "a1" and base64 without padding.
        let html = r#"<ol id="b_results"><li class="b_algo" data-id=""><div class="b_tpcn"><a class="tilk" href="https://example.com/news?id=1"><div class="tptt">Example</div></a></div>
<h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9uZXdzP2lkPTE&amp;ntb=1" h="ID=SERP,1">Shooting in <strong>Kraków</strong></a></h2>
<div class="b_caption"><p class="b_lineclamp2"><span class="news_dt">7 Nov 2026</span> &#0183; Police said two people were hurt.</p></div></li>
<li class="b_algo"><h2><a href="https://b.org/page">B page</a></h2><div class="b_caption"><p>Second one.</p><ul><li>deep link</li></ul></div></li>
<li class="b_ad"><h2><a href="https://ads.example/">Ad</a></h2></li></ol>"#;
        let hits = parse_bing(html);
        assert_eq!(hits.iter().map(|h| (h.title.as_str(), h.url.as_str())).collect::<Vec<_>>(), vec![
            ("Shooting in Kraków", "https://example.com/news?id=1"),
            ("B page", "https://b.org/page"),
        ]);
        assert!(hits[0].snippet.ends_with("Police said two people were hurt."), "{}", hits[0].snippet);
        assert_eq!(hits[1].snippet, "Second one.");
        assert_eq!(base64url("aGk").as_deref(), Some(&b"hi"[..]));
        assert_eq!(bing_target("https://www.bing.com/ck/a?u=zz"), None);
    }

    #[test]
    fn brave_results_are_read_and_engines_take_turns() {
        let html = r#"<div id="results"><div class="snippet svelte-1" data-type="web" data-pos="0"><div class="result-wrapper"><div class="result-content"><a href="https://example.com/a" class="svelte-1 l1"><div class="site-name-wrapper"><div class="sitename-container"><div class="sitename">example.com</div></div></div><div class="title search-snippet-title line-clamp-1">Kraków &amp; news</div></a><div class="generic-snippet"><div class="content desktop-default-regular t-primary">Two people were <strong>hurt</strong>.</div></div></div></div></div>
<div class="snippet" data-type="web" data-pos="1"><a href="https://b.org/"><div class="title">B</div></a><div class="snippet-description">Second.</div></div>
<div class="snippet" data-type="video"><a href="https://v.com/"><div class="title">Video</div></a></div></div>"#;
        let hits = parse_brave(html);
        assert_eq!(hits.iter().map(|h| (h.title.as_str(), h.url.as_str(), h.snippet.as_str())).collect::<Vec<_>>(), vec![
            ("Kraków & news", "https://example.com/a", "Two people were hurt."),
            ("B", "https://b.org/", "Second."),
        ]);
        let hit = |t: &str| Hit { title: t.into(), ..Default::default() };
        let order = take_turns(vec![vec![hit("d1"), hit("d2"), hit("d3")], vec![hit("b1")], vec![hit("m1"), hit("m2")]]);
        assert_eq!(order.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), ["d1", "b1", "m1", "d2", "m2", "d3"]);
    }

    #[test]
    fn news_come_with_their_article_and_date() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Bing</title><link>https://www.bing.com/news</link>
<item><title>Sparatoria a Cracovia, due feriti</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=x&amp;url=https%3a%2f%2fwww.ansa.it%2fsito%2fnotizie%2fmondo%2f1.html&amp;c=1&amp;mkt=it-it</link><description>La polizia &lt;b&gt;polacca&lt;/b&gt; ha arrestato un uomo.</description><pubDate>Sat, 07 Nov 2026 18:20:00 GMT</pubDate><News:Source>ANSA</News:Source></item>
<item><title>Senza link</title></item>
</channel></rss>"#;
        let hits = parse_news_rss(xml);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Sparatoria a Cracovia, due feriti");
        assert_eq!(hits[0].url, "https://www.ansa.it/sito/notizie/mondo/1.html");
        assert_eq!(hits[0].snippet, "La polizia polacca ha arrestato un uomo.");
        assert_eq!(hits[0].date, "Sat, 07 Nov 2026 18:20:00 GMT");
        let text = format_search("cracovia", "Bing News", &hits, &[None], &[], &[]);
        assert!(text.contains("Sparatoria a Cracovia, due feriti (Sat, 07 Nov 2026 18:20:00 GMT) — https://www.ansa.it/"), "{text}");
    }

    #[test]
    fn a_page_that_asks_to_prove_one_is_not_a_robot_is_no_results_page() {
        assert!(is_challenge(r#"<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form>"#));
        assert!(!is_challenge(r#"<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=x">Pasta</a></div>"#));
    }

    #[test]
    fn the_news_come_first_for_a_recent_period_and_after_the_first_results_else() {
        let hit = |t: &str| Hit { title: t.into(), url: format!("https://{t}.com/"), ..Default::default() };
        let web = vec![hit("w1"), hit("w2"), hit("w3"), hit("w4")];
        let news = vec![hit("n1"), hit("n2")];
        let titles = |h: Vec<Hit>| h.into_iter().map(|h| h.title).collect::<Vec<_>>().join(" ");
        assert_eq!(titles(merge(web.clone(), news.clone(), true)), "n1 n2 w1 w2 w3 w4");
        assert_eq!(titles(merge(web, news, false)), "w1 w2 w3 n1 n2 w4");
    }

    #[test]
    fn a_page_gives_its_title_and_main_text_without_menus_or_scripts() {
        let html = r#"<html><head><title>Carbonara &amp; co</title><style>p{}</style></head><body>
<nav><a href="/">Home</a> <a href="/menu">Menu with a lot of words in it</a></nav>
<script>var x = "<p>not text</p>";</script>
<article><h1>Spaghetti alla carbonara</h1>
<p>Carbonara is a Roman pasta dish made with eggs, pecorino romano, guanciale and black pepper.</p>
<p>Share</p>
<!-- a comment that is not text at all -->
<ul><li>Two hundred grams of guanciale, cut in strips</li><li>Four egg yolks and one whole egg</li></ul>
<p>Cook the pasta in salted water and keep a cup of it for the sauce at the end.</p>
<p>Carbonara is a Roman pasta dish made with eggs, pecorino romano, guanciale and black pepper.</p>
<p>Serve at once, with more pecorino and pepper on top, while it is still creamy and hot.</p>
</article><footer>Copyright notice with enough words to be a line</footer></body></html>"#;
        let (title, text) = extract(html);
        assert_eq!(title, "Carbonara & co");
        assert!(text.starts_with("Carbonara is a Roman pasta dish"), "{text}");
        assert!(text.contains("- Two hundred grams of guanciale"), "{text}");
        for gone in ["Menu", "not text", "Share", "comment", "Copyright", "p{}"] {
            assert!(!text.contains(gone), "{gone} in {text}");
        }
        assert_eq!(text.matches("Roman pasta dish").count(), 1, "repeated lines go");
    }

    #[test]
    fn entities_and_attributes_are_read_as_written() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt; &#8364; &#x41; &unknown; & d"), "a & b <c> € A &unknown; & d");
        assert_eq!(attr(r#"<a data-class="x" class='result__a big' href=//x.com/a>"#, "class").as_deref(), Some("result__a big"));
        assert_eq!(attr(r#"<a class="c" href=//x.com/a>"#, "href").as_deref(), Some("//x.com/a"));
        assert_eq!(attr("<a class=\"c\">", "href"), None);
    }

    #[test]
    fn only_public_addresses_are_opened() {
        for ip in ["127.0.0.1", "10.0.0.2", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:192.168.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:c0a8:101::1", "2001:db8::1", "::7f00:1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::5db8:d822", "2002:5db8:d822::1"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for url in ["http://127.0.0.1:11434/api/tags", "http://localhost/", "http://router/", "file:///C:/x", "http://[::1]/", "http://printer.local/"] {
            let url = Url::parse(url).unwrap();
            assert!(rt.block_on(check_public(&url)).is_err(), "{url}");
        }
        assert_eq!(page_url("javascript:alert(1)"), None);
        assert_eq!(page_url("https://user:pw@x.com/"), None);
        assert_eq!(site("https://Wikipedia.org/wiki"), Some("wikipedia.org".into()));
        assert_eq!(site("bad site"), None);
    }

    #[test]
    fn the_passages_that_answer_come_first_and_each_page_gives_a_few() {
        let chunks: Vec<(usize, String)> = vec![
            (0, "The weather in Rome is sunny today with mild winds.".into()),
            (0, "Carbonara needs guanciale, eggs and pecorino; cream is not used in Rome.".into()),
            (1, "A history of the Colosseum and its games.".into()),
            (1, "Guanciale is cured pork cheek, the key to carbonara.".into()),
        ];
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let order = rt.block_on(rank("carbonara guanciale", &chunks, "openai"));
        let mut best = order[..2].to_vec();
        best.sort();
        assert_eq!(best, vec![1, 3]);
        assert!(!order.contains(&2), "nothing in common: left out");
        let hits = vec![
            Hit { title: "Recipes".into(), url: "https://a.com/".into(), snippet: String::new(), date: String::new() },
            Hit { title: "Pork".into(), url: "https://b.com/".into(), snippet: String::new(), date: String::new() },
            Hit { title: "Unread".into(), url: "https://c.com/".into(), snippet: "A snippet.".into(), date: String::new() },
        ];
        let pages = vec![Some(Page { title: "Recipes from Rome".into(), url: "https://a.com/".into(), text: String::new() }), None, None];
        let text = format_search("carbonara guanciale", "DuckDuckGo", &hits, &pages, &chunks, &order);
        assert!(text.contains("[1] Recipes from Rome\nhttps://a.com/\nCarbonara needs"), "{text}");
        assert!(text.contains("[2] Pork\nhttps://b.com/\nGuanciale is cured"), "{text}");
        assert!(text.contains("Other results:\n- Unread — https://c.com/: A snippet."), "{text}");
    }

    #[test]
    fn a_long_text_is_cut_into_passages_of_about_the_same_size() {
        let line = "This is a sentence about something that matters. ".repeat(80);
        let parts = chunk(&format!("Short line here.\n{line}\nAnother line at the end of the page."));
        assert!(parts.len() >= 3, "{}", parts.len());
        assert!(parts.iter().all(|p| p.len() <= CHUNK * 2 + 60), "{:?}", parts.iter().map(String::len).collect::<Vec<_>>());
    }
}
