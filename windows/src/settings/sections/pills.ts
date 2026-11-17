// Settings → Pills: the pills on the island and their colours, and each
// integration's keys, including Email's two sources (Outlook and IMAP accounts).

import { Bridge, type MailAccount } from "../../core/bridge";
import { MAX_DECLARED, PILL_CATEGORIES, availablePills, chooseMainPill, mainPillChoices, toggleDeclared, type PillDefinition } from "../../core/pills";
import { h, clear } from "../../views/dom";
import { colorDot } from "../colors";
import { errorText, sectionHead, setting, statusDot } from "../parts";
import { N_, t } from "../../i18n/i18n";
import { CHAT_STRINGS } from "./chat";
import { KEY_STORE, declaredViews, pickColor, save, settings, toggle, whileShown } from "../store";

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use: pick the main workspace tool, which is
 * always on and takes no slot, and declare the agents and chat providers you
 * want as pills. Services are declared in Integrations below, next to their keys.
 */
export function activePillsSection(connected: Record<string, boolean>): HTMLElement {
  const slots = h("div", { class: "hint" });
  const main = h("select", {}) as HTMLSelectElement;
  for (const def of mainPillChoices()) main.append(h("option", { value: def.id, text: def.name }));
  main.addEventListener("change", () => {
    const next = chooseMainPill(settings, main.value);
    if (!next) return;
    settings.mainPill = next.mainPill;
    settings.activeIntegrations = next.activeIntegrations;
    declaredChanged();
  });
  const groups = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  /** Why a pill would show nothing yet. */
  function hint(def: PillDefinition): string | null {
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id] && !(def.connect.orSetting && settings[def.connect.orSetting])) {
      return t("Key not configured");
    }
    if (def.connect.kind === "server" && !settings[def.connect.field]) return t("Not connected");
    return null;
  }

  function row(def: PillDefinition): HTMLElement {
    const isMain = def.id === settings.mainPill;
    const on = settings.activeIntegrations.includes(def.id);
    const full = !isMain && !on && settings.activeIntegrations.length >= MAX_ACTIVE;
    const el = h("div", { class: full ? "pill-row full" : "pill-row" },
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { class: "name", text: def.name }),
    );
    if (isMain) {
      el.append(h("span", { class: "state", text: t("Main") }));
      return el;
    }
    const why = hint(def);
    el.append(h("span", { class: "state", text: why ?? "" }));
    const sw = h("button", { class: on ? "switch on" : "switch" }) as HTMLButtonElement;
    sw.disabled = full;
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });
    el.append(sw);
    return el;
  }

  function draw() {
    const used = settings.activeIntegrations.length;
    slots.textContent = t("{used}/{max} slots in use — the main tool doesn't take one.", { used, max: MAX_ACTIVE });
    slots.classList.toggle("full", used >= MAX_ACTIVE);
    main.value = settings.mainPill;
    clear(groups);
    for (const cat of PILL_CATEGORIES) {
      if (cat.id === "service") continue;
      const pills = availablePills().filter((p) => p.category === cat.id);
      if (pills.length === 0) continue;
      groups.append(h("div", { class: "pill-group" }, h("h3", { text: t(cat.title) }), ...pills.map(row)));
    }
  }
  declaredViews.push(draw);
  draw();

  return h(
    "section",
    {},
    ...sectionHead(t("Active pills"), t("Choose the tools you use. Lumo only shows what you declare here.")),
    setting(t("Main tool"), slots, main),
    groups,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** What the key needs, shown under its field. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.") },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }] },
  // The inbox over IMAP (mail.rs), and the classic Outlook on this PC (outlook.rs): mailSourceRows,
  // with the IMAP accounts listed by imapAccounts rather than these fields.
  { id: "integration_mail", name: N_("Email"), color: "#EA4335",
    fields: [],
    hint: N_("New emails show on the closed island. You can use Outlook, IMAP or both together.") },
];

const MAX_ACTIVE = MAX_DECLARED;

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

export function integrationsSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const note = h("p", { class: "section-intro" });
  const list = h("div", { class: "setting-list" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = t("Pick up to {max} pills to show next to Lumo — {used}/{max} in use. Keys are stored in the {store}, never on disk.", { max: MAX_ACTIVE, used, store: KEY_STORE });
  }
  declaredViews.push(updateNote);

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      declaredChanged();
    });

    const rows = h("div", { class: "field-rows" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : t(field.placeholder),
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
      const dotEl = statusDot(present[field.key] ?? false);
      const refresh = () => {
        input.placeholder = present[field.key] ? CHAT_STRINGS.stored : t(field.placeholder);
        dotEl.style.background = present[field.key] ? "#22c55e" : "#f4505e";
        removeBtn.style.display = present[field.key] ? "" : "none";
      };
      // An empty field saves nothing: what is stored goes only with Remove.
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) return;
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = true;
          input.value = "";
          refresh();
          keyChanged(field.key, true);
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      removeBtn.addEventListener("click", async () => {
        try {
          await Bridge.secretClear(field.key);
          present[field.key] = false;
          refresh();
          keyChanged(field.key, false);
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      refresh();
      rows.append(
        h("div", { class: "field-row" },
          h("label", { text: t(field.label) }),
          input, saveBtn, removeBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { class: "integration" },
        setting(
          // Service names stay as they are ("Resend" is a name, not "send again"); only "Email" is a word.
          h("span", { class: "with-dot" }, colorDot(def, "", () => settings.pillColors, pickColor), def.id === "integration_mail" ? t(def.name) : def.name),
          def.hint ? t(def.hint) : null,
          sw,
        ),
        ...(def.id === "integration_mail" ? mailSourceRows(imapAccounts(keyChanged)) : [rows]),
        def.id === "integration_mail" ? promotionsRow() : null,
      ),
    );
  }

  updateNote();
  return h("section", {}, ...sectionHead(t("Integrations")), note, list);
}

const MAIL_SOURCES = {
  get outlook() { return t("Outlook on this PC"); },
  get outlookHint() { return t("Classic Outlook, already set up: no password."); },
  get account() { return t("Account"); },
  get imapHint() { return t("Gmail, iCloud or another server, with an app password. Gmail's is made at myaccount.google.com/apppasswords, with 2-Step Verification on."); },
  get closed() { return t("Outlook is closed: the emails come back as soon as you open it."); },
  get missing() { return t("Classic Outlook isn't installed on this PC. The new Outlook can't be read by other apps: use IMAP."); },
};

/**
 * Settings → Pills → Email's two sources, one switch each: the classic
 * Outlook on this PC with the accounts it has (outlook.rs), and IMAP with its
 * address, app password and server (mail.rs). Both can be on.
 */
function mailSourceRows(imapFields: HTMLElement): HTMLElement[] {
  const found = h("span", { style: "flex:1 1 auto;min-width:0;opacity:.9" });
  const dot = statusDot(false);
  const account = h("div", { class: "field-rows" },
    h("div", { class: "field-row" }, h("label", { text: MAIL_SOURCES.account }), found, dot));
  // What Outlook says now: asked only while it runs, it is never started from here.
  const showOutlook = async () => {
    account.hidden = !settings.mailOutlook;
    if (!settings.mailOutlook) return;
    const status = await Bridge.outlookStatus();
    if (!status) return;
    const running = status.installed && status.running;
    found.textContent = !status.installed ? MAIL_SOURCES.missing
      : !status.running ? MAIL_SOURCES.closed
      : status.accounts.join(", ") || "Outlook";
    found.title = found.textContent;
    found.style.opacity = running ? ".9" : ".6";
    dot.style.background = running ? "#22c55e" : status.installed ? "#8a8f98" : "#f4505e";
  };
  const showImap = () => { imapFields.hidden = !settings.mailImap; };
  void showOutlook();
  showImap();
  whileShown(found, "focus", () => void showOutlook());
  return [
    setting(MAIL_SOURCES.outlook, MAIL_SOURCES.outlookHint,
      toggle(settings.mailOutlook, (v) => { settings.mailOutlook = v; void showOutlook(); void save(); })),
    account,
    setting("IMAP", MAIL_SOURCES.imapHint,
      toggle(settings.mailImap, (v) => { settings.mailImap = v; showImap(); void save(); })),
    imapFields,
  ];
}

/** Settings → Pills → Email → IMAP's words. */
const IMAP_ACCOUNTS = {
  get add() { return t("+ Add an account"); },
  get title() { return t("New IMAP account"); },
  get check() { return t("Check and save"); },
  get checking() { return t("Checking…"); },
  get notSaved() { return t("Nothing was saved."); },
  get defaultTip() { return t("New emails go out from this account. A reply goes out from the account the email came to."); },
  found: (server: string) => t("found from the address: {server}", { server }),
};

/** As many IMAP accounts as mail.rs keeps (MAX_ACCOUNTS). */
const MAX_MAIL_ACCOUNTS = 5;

/** An account's dot: read, refused, paused, or not connected yet. */
const ACCOUNT_DOT: Record<MailAccount["state"], string> = {
  ok: "#22c55e", error: "#f4505e", paused: "#8a8f98", connecting: "#f5a524",
};

/**
 * Settings → Pills → Email → IMAP: the accounts stored (mail.rs), each with
 * its state, a switch that pauses it and Remove; under them, one form to add
 * another, saved only once its server took the address and the password.
 * The first account is the default: a new email goes out of it.
 */
function imapAccounts(keyChanged: (key: string, on: boolean) => void): HTMLElement {
  const box = h("div", { class: "mail-accounts" });
  const list = h("div", { class: "mail-account-list" });
  const addBtn = h("button", { text: IMAP_ACCOUNTS.add });
  const addRow = h("div", { class: "mail-account-add" }, addBtn);
  let shown: MailAccount[] = [];

  const address = h("input", { type: "text", placeholder: "you@gmail.com", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const password = h("input", { type: "password", placeholder: "abcd efgh ijkl mnop", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const server = h("input", { type: "text", placeholder: t("found from the address"), autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const problem = h("div", { class: "mail-account-error" });
  const cancel = h("button", { text: t("Cancel") }) as HTMLButtonElement;
  const checkBtn = h("button", { class: "primary", text: IMAP_ACCOUNTS.check }) as HTMLButtonElement;
  const field = (label: string, input: HTMLElement) => h("div", { class: "field-row" }, h("label", { text: label }), input);
  const form = h("div", { class: "mail-account-form" },
    h("div", { class: "mail-account-form-title", text: IMAP_ACCOUNTS.title }),
    field(t("Address"), address),
    field(t("App password"), password),
    field(t("IMAP server"), server),
    problem,
    h("div", { class: "mail-account-actions" }, cancel, checkBtn),
  );
  form.hidden = true;
  problem.hidden = true;

  const paused = (a: string) => settings.mailPaused.some((p) => p.toLowerCase() === a.toLowerCase());
  const setPaused = (a: string, on: boolean) => {
    const rest = settings.mailPaused.filter((p) => p.toLowerCase() !== a.toLowerCase());
    settings.mailPaused = on ? [...rest, a.toLowerCase()] : rest;
    void save();
  };

  const row = (a: MailAccount, first: boolean): HTMLElement => {
    const line = a.state === "error" && a.error ? `${a.host} · ${a.error}`
      : a.state === "paused" ? `${a.host} · ${t("Paused")}`
      : a.state === "connecting" ? `${a.host} · ${t("Connecting…")}`
      : a.host;
    const chip = first ? h("span", { class: "mail-account-default", text: t("Default"), title: IMAP_ACCOUNTS.defaultTip }) : null;
    const remove = h("button", { class: "danger", text: CHAT_STRINGS.remove }) as HTMLButtonElement;
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await Bridge.mailAccountRemove(a.address);
        if (paused(a.address)) setPaused(a.address, false);
      } catch {
        remove.disabled = false;
        return;
      }
      await refresh();
    });
    const on = !paused(a.address);
    return h("div", { class: on ? "mail-account" : "mail-account off" },
      h("i", { class: "dot", style: `background:${ACCOUNT_DOT[a.state] ?? ACCOUNT_DOT.connecting}` }),
      h("div", { class: "mail-account-text" },
        h("div", { class: "mail-account-name" }, h("span", { class: "mail-account-address", text: a.address, title: a.address }), chip),
        h("span", { class: a.state === "error" ? "mail-account-line bad" : "mail-account-line", text: line, title: line }),
      ),
      toggle(on, (v) => { setPaused(a.address, !v); later(); }),
      remove,
    );
  };

  async function refresh() {
    const accounts = (await Bridge.mailAccounts()) ?? [];
    const had = shown.length > 0;
    shown = accounts;
    list.replaceChildren(...accounts.map((a, i) => row(a, i === 0)));
    list.hidden = accounts.length === 0;
    addRow.hidden = !form.hidden || accounts.length >= MAX_MAIL_ACCOUNTS;
    if (had !== accounts.length > 0) keyChanged("mail-app-password", accounts.length > 0);
  }
  /** The state of a connection that just started, a few seconds on. */
  let timers: number[] = [];
  const later = () => {
    for (const id of timers) clearTimeout(id);
    timers = [1500, 6000, 15000].map((ms) => window.setTimeout(() => void refresh(), ms));
    void refresh();
  };

  const close = () => {
    form.hidden = true;
    problem.hidden = true;
    address.value = password.value = server.value = "";
    server.placeholder = t("found from the address");
    addRow.hidden = shown.length >= MAX_MAIL_ACCOUNTS;
  };
  addBtn.addEventListener("click", () => {
    form.hidden = false;
    addRow.hidden = true;
    address.focus();
  });
  cancel.addEventListener("click", close);
  address.addEventListener("input", async () => {
    const typed = address.value.trim();
    const found = typed.includes("@") ? (await Bridge.mailServerFor(typed)) ?? "" : "";
    if (address.value.trim() !== typed) return;
    server.placeholder = found ? IMAP_ACCOUNTS.found(found) : t("found from the address");
  });
  const submit = async () => {
    if (checkBtn.disabled) return;
    if (!address.value.trim() || !password.value.trim()) {
      (address.value.trim() ? password : address).focus();
      return;
    }
    checkBtn.disabled = cancel.disabled = true;
    checkBtn.textContent = IMAP_ACCOUNTS.checking;
    problem.hidden = true;
    try {
      await Bridge.mailAccountAdd(address.value.trim(), password.value.trim(), server.value.trim());
      close();
      later();
    } catch (err) {
      problem.replaceChildren(h("i", { class: "dot", style: "background:#f4505e" }), h("span", { text: `${errorText(err)} ${IMAP_ACCOUNTS.notSaved}` }));
      problem.hidden = false;
    } finally {
      checkBtn.disabled = cancel.disabled = false;
      checkBtn.textContent = IMAP_ACCOUNTS.check;
    }
  };
  checkBtn.addEventListener("click", () => void submit());
  for (const input of [address, password, server]) {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
  }
  whileShown(box, "focus", () => void refresh());
  void refresh();
  box.append(list, form, addRow);
  return box;
}

/** Settings → Pills → Email: the promotional emails left out of the island (mail.rs). */
function promotionsRow(): HTMLElement {
  return setting(
    t("Hide promotional emails"),
    t("On Gmail, the ones in its Promotions tab; with other providers, the ones with an unsubscribe link (newsletters, offers)."),
    toggle(settings.mailHidePromotions, (v) => { settings.mailHidePromotions = v; void save(); }),
  );
}
