// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { isComingSoon, pillDefinition } from "../core/pills";
import { refreshHookPills } from "../island/integrations";
import { readActivity, readPulse, readStats } from "../core/github";
import { githubDetail, githubPulseCard } from "./github";
import { N_, language, t, tn } from "../i18n/i18n";
import { askAboutMail } from "../island/compact";
import type { MailPeek } from "../core/compact";
import { PLAN_TEXT, dominantPct, planColor } from "../core/plan";
import { formatDuration, mergedSeconds, mondayOf, type RecapHistory } from "../recap/summary";
import { folderOf, groupSessions, type CodeSession } from "../core/sessions";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return t("just now");
  if (diff < 3600) return t("{n}m", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n}h", { n: Math.floor(diff / 3600) });
  return t("{n}d", { n: Math.floor(diff / 86400) });
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

/** IntegrationCardView.statusLabel on macOS. */
export function idleStatus(
  id: string,
  info: { configured: boolean; error: string | null } | undefined,
  chatModel: string,
): { label: string; color: string } {
  if (isComingSoon(id)) return { label: t("Coming soon"), color: "#6B7079" };
  if (info?.error) return { label: info.error, color: "#F4505E" };
  const configured = info?.configured ?? false;
  const def = pillDefinition(id);
  const ok = (label: string) => ({ label, color: "#22C55E" });
  const missing = (label: string) => ({ label, color: "#F4505E" });
  // Pills driven by hooks never have a key: they are connected once the hooks
  // are in place (Mac #183). A session replaces this card; nothing is loading.
  if (def?.connect.kind === "hooks") return configured ? ok(t("Hooks installed")) : missing(t("Hooks not installed"));
  if (def?.connect.kind === "none") return ok(t("Ready · no setup needed"));
  if (def?.connect.kind === "server") return configured ? ok(t("Connected")) : missing(t("Not connected"));
  if (def?.category === "ai") {
    if (!configured) return missing(t("Key not configured"));
    return ok(id === "ai_anthropic" ? t("Key configured · {model}", { model: chatModel }) : t("Key configured"));
  }
  return configured ? ok(t("Connected · loading…")) : missing(t("Key not configured"));
}

// ── The tool's card: what it is, how it is doing, what it did lately ──────────

const TOOL_TEXT = {
  lastSession: N_("Last session"),
  sessionsWeek: N_("Sessions this week"),
  timeWeek: N_("Time this week"),
  linesChanged: N_("Lines changed"),
  noSession: N_("No session this week yet"),
  planUsage: N_("Plan usage"),
  notInstalled: N_("Not installed"),
  model: N_("Model"),
  refresh: N_("Refresh"),
  refreshing: N_("Refreshing…"),
  allSessions: N_("All sessions"),
  sessions: N_("Sessions"),
  noSessions: N_("No session in the last 30 days. Sessions are kept by the weekly recap (Settings → General)."),
  openProject: N_("Open the project"),
};

/** A Refresh in progress or done, by pill: the card shows it until the next one. */
interface Refreshed {
  busy: boolean;
  at: number;
  error: string | null;
}

const refreshes = new Map<string, Refreshed>();

/** The sessions the weekly recap keeps (recap.rs), read again at most once a minute. */
let recap: RecapHistory | null = null;
let recapAt = 0;
let recapLoading: Promise<void> | null = null;

function loadRecap(force = false): Promise<void> {
  if (recapLoading) return recapLoading;
  if (!force && Date.now() - recapAt < 60_000) return Promise.resolve();
  recapLoading = Bridge.recapHistory(Date.now() / 1000 - 30 * 86_400)
    .then((h) => {
      recap = h && Array.isArray(h.turns) ? h : null;
    })
    .finally(() => {
      recapAt = Date.now();
      recapLoading = null;
      State.notify();
    });
  return recapLoading;
}

/** What the card depends on besides the pill's own data, for the overview to know when to redraw it. */
export function idleCardKey(id: string, now = Date.now()): string {
  const r = refreshes.get(id);
  const refreshed = r ? `${r.busy}|${r.at}|${r.error}|${Math.floor((now - r.at) / 60_000)}` : "";
  const plan = id === "integration_claude" ? `${State.settings.planRelayInstalled}|${dominantPct(State.planUsage, now)}`
    : id === "agent_codex" ? String(dominantPct(State.codexPlanUsage, now)) : "";
  return `${refreshed}~${recapAt}~${plan}`;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Refresh: a hook pill reads its hooks (and its sessions) again; a service
 * asks its server, and the card waits for the answer (or 15 s). The button
 * turns while it works, then says when it was done, or what went wrong.
 */
async function refresh(id: string, hookPill: boolean) {
  if (refreshes.get(id)?.busy) return;
  const started = Date.now();
  refreshes.set(id, { busy: true, at: started, error: null });
  State.notify();
  let error: string | null = null;
  try {
    if (hookPill) {
      await Promise.all([refreshHookPills(), loadRecap(true)]);
      if (!(State.integrations[id]?.configured ?? false)) error = t("Hooks not installed");
    } else {
      const before = State.integrations[id];
      await Bridge.refreshIntegration(id);
      for (let waited = 0; State.integrations[id] === before && waited < 15_000; waited += 200) await sleep(200);
      error = State.integrations[id]?.error ?? null;
    }
  } catch (err) {
    error = String(err).replace(/^Error:\s*/, "");
  }
  // The turning stays long enough to be seen, even when the answer is instant.
  await sleep(Math.max(0, 500 - (Date.now() - started)));
  refreshes.set(id, { busy: false, at: Date.now(), error });
  State.notify();
}

/** "just now", "5 min ago", "3 h ago", else the day. */
function when(ms: number, now = Date.now()): string {
  const mins = Math.floor((now - ms) / 60_000);
  if (mins < 1) return PLAN_TEXT.justNow;
  if (mins < 60) return PLAN_TEXT.minAgo(mins);
  if (mins < 24 * 60) return PLAN_TEXT.hAgo(Math.floor(mins / 60));
  return new Date(ms).toLocaleDateString(language(), { weekday: "short", day: "numeric", month: "short" });
}

/** The pill's sessions from the recap: the last one, and this week's. */
function sessionFacts(id: string, now = Date.now()): [string, string][] {
  if (!recap || recap.prefs?.enabled === false) return [];
  const turns = recap.turns.filter((x) => x.agent === id);
  const facts: [string, string][] = [];
  const last = turns.reduce<(typeof turns)[number] | null>((a, b) => (!a || b.end > a.end ? b : a), null);
  const since = mondayOf(new Date(now)).getTime() / 1000;
  const week = turns.filter((x) => x.start >= since);
  if (last) facts.push([t(TOOL_TEXT.lastSession), [last.project, when(last.end * 1000, now)].filter(Boolean).join(" · ")]);
  if (!week.length) {
    if (last) facts.push([t(TOOL_TEXT.sessionsWeek), "0"]);
    else facts.push([t(TOOL_TEXT.noSession), ""]);
    return facts;
  }
  facts.push([t(TOOL_TEXT.sessionsWeek), String(week.length)]);
  facts.push([t(TOOL_TEXT.timeWeek), formatDuration(Math.max(1, Math.round(mergedSeconds(week) / 60)))]);
  const added = week.reduce((n, x) => n + x.linesAdded, 0);
  const removed = week.reduce((n, x) => n + x.linesRemoved, 0);
  if (added || removed) facts.push([t(TOOL_TEXT.linesChanged), `+${added} −${removed}`]);
  return facts;
}

/** Facts worth a line on this pill's card. */
function toolFacts(task: AgentTask, configured: boolean, hookPill: boolean): { label: string; value: string; color?: string }[] {
  const out: { label: string; value: string; color?: string }[] = [];
  if (task.id === "integration_claude") {
    const pct = dominantPct(State.planUsage);
    out.push(State.settings.planRelayInstalled
      ? { label: t(TOOL_TEXT.planUsage), value: pct == null ? PLAN_TEXT.none : `${Math.round(pct)}%`, color: pct == null ? undefined : planColor(pct) }
      : { label: t(TOOL_TEXT.planUsage), value: t(TOOL_TEXT.notInstalled) });
  }
  if (task.id === "agent_codex") {
    const pct = dominantPct(State.codexPlanUsage);
    if (pct != null) out.push({ label: t(TOOL_TEXT.planUsage), value: `${Math.round(pct)}%`, color: planColor(pct) });
  }
  if (task.id === "ai_anthropic" && configured) out.push({ label: t(TOOL_TEXT.model), value: State.settings.model });
  if (hookPill && configured) {
    loadRecap();
    for (const [label, value] of sessionFacts(task.id)) out.push({ label, value });
  }
  return out;
}

/** A button of the card: lit under the mouse, pressed in on a click. */
function toolButton(label: string, onclick: () => void, primary = false, color?: string): HTMLElement {
  const b = h("button", { class: primary ? "tool-action primary" : "tool-action", title: label, onclick }, h("span", { text: label }));
  if (color) b.style.setProperty("--tool", color);
  return b;
}

function idleCard(task: AgentTask, openSettings: () => void, openSessions?: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const def = pillDefinition(task.id);
  const status = idleStatus(task.id, info, State.settings.model);
  const color = task.color;

  const actions = h("div", { class: "tool-actions" });
  if (task.id === "integration_claude") {
    actions.append(toolButton(t("Open {name}", { name: "VS Code" }), () => void Bridge.openInVSCode(task.sessionCwd ?? null), true, color));
  } else if (task.id === "agent_claude-desktop") {
    actions.append(toolButton(t("Open Claude"), () => void Bridge.openClaudeDesktop(), true, color));
  } else if (task.id === "integration_n8n") {
    actions.append(toolButton(t("Open {name}", { name: "n8n" }), () => void Bridge.openN8n(), true, color));
  } else if (OPEN_URLS[task.id]) {
    actions.append(toolButton(t("Open {name}", { name: task.name }), () => void Bridge.openUrl(OPEN_URLS[task.id]), true, color));
  }
  const hookPill = def?.connect.kind === "hooks";
  const done = refreshes.get(task.id);
  if (isComingSoon(task.id) || def?.connect.kind === "none") {
    // Nothing to set up, and nothing to refresh.
  } else if (configured && (hookPill || def?.category !== "ai")) {
    // A hook pill has nothing to poll: Refresh looks at its hooks (and sessions) again.
    const busy = done?.busy ?? false;
    const button = h("button", {
      class: busy ? "tool-action busy" : "tool-action",
      "aria-busy": busy ? "true" : "false",
      onclick: () => void refresh(task.id, hookPill),
    },
    busy ? h("i", { class: "tool-spin" }) : svg(ICONS.arrowClockwise, 10, { stroke: 2.4 }),
    h("span", { text: t(busy ? TOOL_TEXT.refreshing : TOOL_TEXT.refresh) }));
    button.toggleAttribute("disabled", busy);
    actions.append(button);
  } else if (!configured) {
    actions.append(toolButton(t("Settings…"), openSettings));
  }

  const facts = h("div", { class: "tool-facts" });
  const factList = toolFacts(task, configured, hookPill);
  for (const f of factList) {
    const value = h("span", { class: "tool-fact-value", text: f.value, title: f.value });
    if (f.color) value.style.color = f.color;
    facts.append(h("div", { class: f.value ? "tool-fact" : "tool-fact alone" }, h("span", { class: "tool-fact-label", text: f.label }), value));
  }

  // When it was last refreshed, or what went wrong.
  const note = done && !done.busy
    ? h("div", { class: done.error ? "tool-note bad" : "tool-note", text: done.error ?? t("Updated {when}", { when: when(done.at) }), title: done.error ?? "" })
    : null;

  // The sessions themselves, one click away (sessionsDetail).
  const sessionsLink = hookPill && configured && openSessions && recap && groupSessions(recap.turns, task.id, 1).length
    ? h("button", { class: "tool-more", onclick: openSessions }, h("span", { text: t(TOOL_TEXT.allSessions) }), svg(ICONS.chevronRight, 9, { stroke: 2.4 }))
    : null;

  return h(
    "div",
    { class: "int-card tool-card" },
    header(color, task.id === "integration_claude" ? "VS Code" : task.name, t(def?.subtitle ?? N_("Integration"))),
    h("div", { class: "int-status" }, dot(status.color, 6), h("span", { class: "int-status-label", text: status.label, title: status.label })),
    facts,
    sessionsLink,
    h("div", { class: "tool-foot" }, actions, note),
  );
}

/** "Today 14:20", "Wed 9:30", "12 Sep 9:30". */
function sessionWhen(sec: number, now = Date.now()): string {
  const d = new Date(sec * 1000);
  const time = d.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(new Date(now).toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return `${t("Today")} ${time}`;
  if (days < 7) return `${d.toLocaleDateString(language(), { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(language(), { day: "numeric", month: "short" })} ${time}`;
}

/**
 * A tool's recent sessions (from the weekly recap): the project, when, how
 * long, the files and lines changed and the commands run. A click opens the
 * project again (its folder in VS Code), when Lumo has seen where it is.
 */
function sessionsDetail(task: AgentTask, onBack: () => void): HTMLElement {
  loadRecap();
  const sessions: CodeSession[] = recap ? groupSessions(recap.turns, task.id) : [];
  const list = h("div", { class: "session-list" });
  if (!sessions.length) list.append(h("div", { class: "int-empty", text: t(TOOL_TEXT.noSessions) }));
  for (const s of sessions) {
    const folder = s.project ? folderOf(s.project) : null;
    const meta = [
      formatDuration(s.minutes),
      s.filesChanged ? tn("{count} file", "{count} files", s.filesChanged) : "",
      s.linesAdded || s.linesRemoved ? `+${s.linesAdded} −${s.linesRemoved}` : "",
      s.commandsRun ? tn("{count} command", "{count} commands", s.commandsRun) : "",
    ].filter(Boolean).join(" · ");
    const row = h(folder ? "button" : "div", {
      class: folder ? "session-row link" : "session-row",
      title: folder ? `${t(TOOL_TEXT.openProject)} · ${folder}` : s.project,
    },
    h("span", { class: "session-top" },
      h("b", { class: "session-project", text: s.project || "—" }),
      h("span", { class: "session-when", text: sessionWhen(s.start) })),
    h("span", { class: "session-meta", text: meta }),
    folder ? h("i", { class: "session-open" }, svg(ICONS.arrowUpRight, 8)) : null);
    if (folder) row.addEventListener("click", () => void Bridge.openSession(null, folder));
    list.append(row);
  }
  return h(
    "div",
    { class: "int-card detail sessions" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(task.color, 6),
      h("b", { text: task.id === "integration_claude" ? "VS Code" : task.name }),
      h("span", { class: "int-badge", text: t(TOOL_TEXT.sessions) }),
    ),
    list,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: t("Details"), onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", t("Deployments")), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? t("Ready") : d.state === "CANCELED" ? t("Canceled") : t("Error");
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: t("{time} ago", { time: timeAgo(d.createdAt) }) }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? t("Deployment")) }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", t("Emails"), extra), rows);
}

// ── Email ─────────────────────────────────────────────────────────────────────

const MAIL_CARD_TEXT = {
  name: N_("Email"),
  unread: N_("Unread"),
  none: N_("No unread email"),
  summarize: N_("Summarize"),
  reply: N_("Draft a reply"),
};

/** The newest unread emails (mail.rs); a click has the chat summarize one or draft a reply. */
function mailCard(openChat: () => void): HTMLElement {
  const messages = arr("integration_mail", "messages");
  const unread = Number(get("integration_mail").unread ?? messages.length);
  const inbox = get("integration_mail").inbox;
  const extra = h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(unread) }));
  const rows = h("div", { class: "int-rows" });
  if (!messages.length) rows.append(h("div", { class: "int-row first" }, h("span", { class: "int-name", text: t(MAIL_CARD_TEXT.none) })));
  let newest: (MailPeek & { body: string }) | null = null;
  messages.slice(0, 3).forEach((m, i) => {
    const mail = {
      id: String(m.id ?? ""), from: String(m.from ?? ""), address: String(m.address ?? ""),
      subject: String(m.subject ?? ""), preview: String(m.preview ?? ""), body: String(m.body ?? ""),
    };
    const cells: Node[] = [
      h("span", { class: "int-name", text: mail.from || mail.address }),
      h("span", { class: "int-ago", text: m.date ? timeAgo(m.date) : "" }),
    ];
    if (i === 0) {
      cells.push(h("span", { class: "int-sub", text: mail.subject }));
      newest = mail;
    }
    const row = listRow("#EA4335", i === 0, ...cells);
    row.title = mail.subject;
    rows.append(row);
  });
  // The newest one's two buttons, under the list.
  const first = newest as (MailPeek & { body: string }) | null;
  if (first) {
    const ask = (what: "summary" | "reply") => (e: Event) => {
      e.stopPropagation();
      askAboutMail(first, what);
      openChat();
    };
    rows.append(h("div", { class: "int-mail-actions" },
      h("button", { class: "int-mail-action", onclick: ask("summary") }, t(MAIL_CARD_TEXT.summarize)),
      h("button", { class: "int-mail-action", onclick: ask("reply") }, t(MAIL_CARD_TEXT.reply)),
    ));
  }
  const head = header("#EA4335", t(MAIL_CARD_TEXT.name), t(MAIL_CARD_TEXT.unread), extra);
  if (typeof inbox === "string" && inbox) {
    head.style.cursor = "pointer";
    head.addEventListener("click", () => void Bridge.openUrl(inbox));
  }
  return h("div", { class: "int-card" }, head, rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

function githubCard(): HTMLElement {
  const d = get("integration_github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", t("Overview")),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#F5A524", t("Total stars"), fmt(stars)),
      statRow(ICONS.stack, "#6B7079", t("Repositories"), String(repos)),
    ),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? t("Payment")) }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", t("Payments")),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? t("Untitled")) }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", t("Recent")), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: t("No calls scheduled") }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(language(), { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? t("Meeting")) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", t("Schedule")), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", t("Workflow")),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? t("Workflow") }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? t("Workflow") }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? t("Success") : t("Failed"),
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? t("Completed successfully.") : t("No error details available."),
        }),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
  /** The chat, where an email's question was just put (island/compact.ts askAboutMail). */
  openChat(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return get(id).totalRepos != null || readPulse(get(id)) != null;
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
    case "integration_mail":
      return info.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  // A tool fed by hooks: its card, or the list of its sessions.
  if (pillDefinition(task.id)?.connect.kind === "hooks") {
    return hooks.detailOpen ? sessionsDetail(task, hooks.closeDetail) : idleCard(task, hooks.openSettings, hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  // With the pulse in, GitHub gets the Mac's richer card and its lists.
  if (task.id === "integration_github") {
    const d = get(task.id);
    const pulse = readPulse(d);
    if (pulse) {
      return hooks.detailOpen
        ? githubDetail(pulse, readStats(d), readActivity(d), hooks.closeDetail)
        : githubPulseCard(pulse, readStats(d), readActivity(d), hooks.openDetail);
    }
  }

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    case "integration_mail":
      return mailCard(hooks.openChat);
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
