// The plan a local model follows on Lumo's Plan island, kept up to date.
//
// A model makes it with Lumo's `update_plan` tool and is told, once, to call
// it again as each step finishes. Small local models forget after a tool or
// two, and the plan stays on its first step while the work goes on, which
// makes it useless. So Lumo keeps reminding them, as Claude Code's own
// harness does with its to-do list (turn.rs):
//
// - while it works: after two rounds of other tools with the plan left as it
//   was, a line under the last tool's result says which step it shows;
// - at the end: an answer given with the plan still behind the work sends the
//   model back once, to put each step where it really stands;
// - a list of steps written in the answer, right before its first tools, is
//   shown as the plan, and the model is told so, so it ticks it off;
// - each new question in a chat with a plan under way says where it stands
//   (`turn_note`, sent by the app with the question).

use serde_json::{json, Value};

/// Lumo's plan tool (src-tauri island_tools.rs UPDATE_PLAN).
pub const TOOL: &str = "update_plan";

/// Rounds of other tools, with the plan left as it was, before the model is reminded.
pub const QUIET_ROUNDS: usize = 2;

/// Steps kept of one plan (the tool's own `maxItems`).
const MAX_STEPS: usize = 30;
/// Longest step text kept from a list in the answer.
const MAX_TEXT: usize = 160;
/// Longest step text in the notes to the model.
const NOTE_TEXT: usize = 80;

/// Where a step stands, in the tool's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pending,
    InProgress,
    Completed,
}

impl Status {
    fn parse(raw: &str) -> Status {
        let s = raw.trim().to_ascii_lowercase().replace([' ', '-'], "_");
        match s.as_str() {
            "completed" | "complete" | "done" | "finished" | "cancelled" | "canceled" | "skipped" => Status::Completed,
            "in_progress" | "inprogress" | "active" | "running" | "doing" | "current" => Status::InProgress,
            _ => Status::Pending,
        }
    }

    fn word(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::InProgress => "in_progress",
            Status::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub text: String,
    pub status: Status,
}

/// A plan, as `update_plan` takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
}

impl Plan {
    /// The plan an `update_plan` call gave (`plan`, or `steps`, of `{ step, status }`).
    pub fn from_input(input: &Value) -> Option<Plan> {
        let items = input.get("plan").or_else(|| input.get("steps")).and_then(Value::as_array)?;
        let steps: Vec<Step> = items
            .iter()
            .filter_map(|item| {
                let text = ["step", "text", "content", "title"].iter().filter_map(|k| item.get(*k).and_then(Value::as_str)).map(str::trim).find(|s| !s.is_empty())?;
                Some(Step { text: text.to_string(), status: Status::parse(item.get("status").and_then(Value::as_str).unwrap_or("")) })
            })
            .take(MAX_STEPS)
            .collect();
        (!steps.is_empty()).then_some(Plan { steps })
    }

    /// The plan as `update_plan` takes it.
    pub fn to_input(&self) -> Value {
        json!({ "plan": self.steps.iter().map(|s| json!({ "step": s.text, "status": s.status.word() })).collect::<Vec<_>>() })
    }

    /// Some step is not completed.
    pub fn open(&self) -> bool {
        self.steps.iter().any(|s| s.status != Status::Completed)
    }

    /// Work on it has started and isn't over: a step in progress, or some
    /// done and some not. A plan only proposed (all pending) isn't.
    pub fn under_way(&self) -> bool {
        self.open() && self.steps.iter().any(|s| s.status != Status::Pending)
    }

    /// The step it shows now: in progress, or else the first not completed;
    /// its number (from 1) and its text.
    pub fn current(&self) -> Option<(usize, &str)> {
        self.steps
            .iter()
            .position(|s| s.status == Status::InProgress)
            .or_else(|| self.steps.iter().position(|s| s.status != Status::Completed))
            .map(|i| (i + 1, self.steps[i].text.as_str()))
    }

    fn left(&self) -> usize {
        self.steps.iter().filter(|s| s.status != Status::Completed).count()
    }

    /// Where each step stands, in a few words: "done: …; in progress: …; pending: …".
    pub fn summary(&self) -> String {
        let of = |status: Status| {
            self.steps.iter().filter(|s| s.status == status).map(|s| format!("\"{}\"", short(&s.text))).collect::<Vec<_>>().join(", ")
        };
        [("done", Status::Completed), ("in progress", Status::InProgress), ("pending", Status::Pending)]
            .into_iter()
            .map(|(label, status)| (label, of(status)))
            .filter(|(_, steps)| !steps.is_empty())
            .map(|(label, steps)| format!("{label}: {steps}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// A list of steps written in an answer: numbered from 1 (`1.`, `1)`) or
    /// ticked (`- [ ]`, `- [x]`), two or more. The first one not ticked is in
    /// progress. Only the first list: what follows it is something else.
    pub fn from_list(text: &str) -> Option<Plan> {
        let mut steps: Vec<Step> = Vec::new();
        let mut in_code = false;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("```") {
                in_code = !in_code;
                continue;
            }
            if in_code {
                continue;
            }
            let item = numbered(line, steps.len() + 1).map(|t| (t, false)).or_else(|| ticked(line));
            match item {
                Some((text, done)) => {
                    let text = clean(text);
                    if text.is_empty() {
                        return None;
                    }
                    steps.push(Step { text, status: if done { Status::Completed } else { Status::Pending } });
                }
                // A list ends at the first line of text that isn't one of
                // its items (a blank line or a bullet under an item doesn't).
                None if !steps.is_empty() && !line.is_empty() && !line.starts_with(['-', '*', '•']) => break,
                None => {}
            }
        }
        if steps.len() < 2 || steps.len() > MAX_STEPS {
            return None;
        }
        if let Some(next) = steps.iter_mut().find(|s| s.status == Status::Pending) {
            next.status = Status::InProgress;
        }
        Some(Plan { steps })
    }
}

/// A numbered item, numbered `n`: its text.
fn numbered(line: &str, n: usize) -> Option<&str> {
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || line[..digits].parse::<usize>().ok()? != n {
        return None;
    }
    let rest = &line[digits..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    rest.starts_with(' ').then(|| rest.trim())
}

/// A ticked item: its text, and whether it is ticked.
fn ticked(line: &str) -> Option<(&str, bool)> {
    let rest = line.strip_prefix("- ").or_else(|| line.strip_prefix("* "))?;
    if let Some(t) = rest.strip_prefix("[ ] ") {
        return Some((t.trim(), false));
    }
    rest.strip_prefix("[x] ").or_else(|| rest.strip_prefix("[X] ")).map(|t| (t.trim(), true))
}

/// A step's words, without Markdown's marks.
fn clean(text: &str) -> String {
    let text = text.replace("**", "").replace("__", "").replace('`', "");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > MAX_TEXT {
        format!("{}…", text.chars().take(MAX_TEXT - 1).collect::<String>())
    } else {
        text
    }
}

fn short(text: &str) -> String {
    if text.chars().count() > NOTE_TEXT {
        format!("{}…", text.chars().take(NOTE_TEXT - 1).collect::<String>())
    } else {
        text.to_string()
    }
}

/// Under a tool's result, after `rounds` rounds of tools with the plan left as it was.
pub fn reminder(plan: &Plan, rounds: usize) -> String {
    let now = match plan.current() {
        Some((n, text)) => format!("step {n} \"{}\" in progress", short(text)),
        None => "steps still open".to_string(),
    };
    format!(
        "(Lumo: your plan on the Plan island shows {now}, and you haven't updated it for {rounds} rounds of tools. \
If that step is done, call update_plan now with the whole list, it completed and the next one in_progress; if not, carry on.)"
    )
}

/// For an answer given with the plan behind the work.
pub fn end_note(plan: &Plan) -> String {
    let now = match plan.current() {
        Some((n, text)) => format!(" (step {n} \"{}\" in progress)", short(text)),
        None => String::new(),
    };
    format!(
        "(Lumo: you answered, but your plan on the Plan island still shows {} of {} steps not completed{now}, and you didn't update it \
after your last tools. Call update_plan now with the whole list and where each step really stands: completed only what you actually did. \
Then give your answer again.)",
        plan.left(),
        plan.steps.len()
    )
}

/// Under the results of the tools that came with a list shown as the plan.
pub fn list_note(plan: &Plan) -> String {
    let first = plan.current().map(|(n, text)| format!(", step {n} \"{}\" in progress", short(text))).unwrap_or_default();
    format!(
        "(Lumo: the list of steps in your answer is now shown to the user as your plan on the Plan island{first}. Keep it up to date: \
as each step finishes, call update_plan with the whole list, that step completed and the next one in_progress.)"
    )
}

/// With a new question in a chat whose plan isn't done.
pub fn turn_note(plan: &Plan) -> String {
    format!(
        "(Lumo's note, not shown to the user: your plan on the Plan island in this chat — {}. If you go on with it, keep it up to date with \
update_plan as each step finishes; if the user asks for something else, make a new plan with update_plan or leave this one.)",
        plan.summary()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(steps: &[(&str, Status)]) -> Plan {
        Plan { steps: steps.iter().map(|(t, s)| Step { text: t.to_string(), status: *s }).collect() }
    }

    #[test]
    fn a_call_s_plan_is_read_and_given_back_the_same() {
        let input = json!({ "plan": [
            { "step": "Scrivere index.html", "status": "completed" },
            { "step": "Scrivere style.css", "status": "in_progress" },
            { "step": "Provare", "status": "pending" },
        ] });
        let p = Plan::from_input(&input).unwrap();
        assert_eq!(p.to_input(), input);
        assert_eq!(p.current(), Some((2, "Scrivere style.css")));
        assert!(p.open() && p.under_way());
        // Other words for where a step stands, and `steps` for `plan`.
        let p = Plan::from_input(&json!({ "steps": [{ "text": "A", "status": "done" }, { "text": "B", "status": "Active" }, { "text": " " }] })).unwrap();
        assert_eq!(p.steps.iter().map(|s| s.status).collect::<Vec<_>>(), [Status::Completed, Status::InProgress]);
        assert!(Plan::from_input(&json!({ "plan": [] })).is_none());
        assert!(Plan::from_input(&json!({ "nope": 1 })).is_none());
    }

    #[test]
    fn a_plan_only_proposed_or_done_is_not_under_way() {
        assert!(!plan(&[("A", Status::Pending), ("B", Status::Pending)]).under_way());
        assert!(!plan(&[("A", Status::Completed), ("B", Status::Completed)]).under_way());
        assert!(!plan(&[("A", Status::Completed)]).open());
        assert!(plan(&[("A", Status::Completed), ("B", Status::Pending)]).under_way());
        assert_eq!(plan(&[("A", Status::Completed), ("B", Status::Pending)]).current(), Some((2, "B")));
    }

    #[test]
    fn a_numbered_list_in_the_answer_is_a_plan_from_its_first_step() {
        let p = Plan::from_list("Ecco come procedo:\n\n1. Creare la **cartella**\n2. Scrivere `index.html`\n3) Provare il sito\n\nInizio dal primo.").unwrap();
        assert_eq!(p.steps.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["Creare la cartella", "Scrivere index.html", "Provare il sito"]);
        assert_eq!(p.current(), Some((1, "Creare la cartella")));
        assert_eq!(p.steps[1].status, Status::Pending);
        // Ticked items: the first not ticked is under way.
        let p = Plan::from_list("- [x] Leggere il file\n- [ ] Correggere\n- [ ] Salvare").unwrap();
        assert_eq!(p.steps.iter().map(|s| s.status).collect::<Vec<_>>(), [Status::Completed, Status::InProgress, Status::Pending]);
    }

    #[test]
    fn what_isn_t_a_list_of_steps_is_no_plan() {
        assert!(Plan::from_list("Ho letto il file.").is_none());
        assert!(Plan::from_list("1. Una cosa sola").is_none());
        // Not numbered from 1, or a list in code.
        assert!(Plan::from_list("2. B\n3. C").is_none());
        assert!(Plan::from_list("```\n1. a\n2. b\n```").is_none());
        // Only the first list: the second one is something else.
        let p = Plan::from_list("1. A\n2. B\n\nNote:\n1. x\n2. y\n3. z").unwrap();
        assert_eq!(p.steps.len(), 2);
    }

    #[test]
    fn the_notes_say_which_step_the_plan_shows() {
        let p = plan(&[("Scrivere index.html", Status::Completed), ("Scrivere style.css", Status::InProgress), ("Provare", Status::Pending)]);
        assert!(reminder(&p, 2).contains("step 2 \"Scrivere style.css\" in progress"), "{}", reminder(&p, 2));
        assert!(reminder(&p, 2).contains("for 2 rounds"));
        assert!(end_note(&p).contains("2 of 3 steps not completed (step 2 \"Scrivere style.css\" in progress)"), "{}", end_note(&p));
        assert!(list_note(&p).contains("step 2 \"Scrivere style.css\" in progress"));
        assert!(turn_note(&p).contains("done: \"Scrivere index.html\"; in progress: \"Scrivere style.css\"; pending: \"Provare\""), "{}", turn_note(&p));
        let long = "x".repeat(200);
        assert!(reminder(&plan(&[(&long, Status::InProgress)]), 2).contains(&format!("{}…", "x".repeat(NOTE_TEXT - 1))));
    }
}
