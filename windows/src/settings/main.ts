// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "../core/legacy";
import "./settings.css";
import { Bridge, EMBEDDED, onEvent, type ShortcutsReport } from "../core/bridge";
import { CUSTOM_SERVER_KEY, UNSLOTH_SERVER_KEY, providerDef } from "../core/providers";
import type { Settings } from "../core/state";
import { availablePills, sanitizeDeclared } from "../core/pills";
import { h, clear } from "../views/dom";
import { agentsSection } from "./agents";
import { setting } from "./parts";
import { SEARCH_STRINGS, applySearch } from "./search";
import { betaChanged, changelogSection, updatesSection } from "./updates";
import { installTextMenu } from "../views/context-menu";
import { FRAME_CLOSE, FRAME_READY, FRAME_SHOWN } from "../views/settings-frame";
import { VOICE_SETTINGS } from "../live/strings";
import { N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t } from "../i18n/i18n";
import { CLOUD, chatNamesSection, chatProvidersSection, chatUsageSection } from "./sections/chat";
import { COPILOT_MISSING, CURSOR_MISSING, apiSection, backgroundSection, chatAgentsSection, cliSection, planSection } from "./sections/claude";
import { antigravityCard, claudeCard } from "./sections/agent-cards";
import { energyRedraw, generalSection } from "./sections/general";
import { islandSection } from "./sections/island";
import { type LocalId, localRedraw, localSection, setLocalRedraw } from "./sections/local";
import { activePillsSection, integrationsSection } from "./sections/pills";
import { securitySection } from "./sections/security";
import { setShortcutsListener, shortcutsListener, shortcutsSection } from "./sections/shortcuts";
import { voiceSection } from "./sections/voice";
import { applyLanguage, declaredViews, onRerender, save, setOnBattery, setSettings, setVersion, settings, toggle, version } from "./store";

const root = document.getElementById("settings-root")!;

// ── Language ──────────────────────────────────────────────────────────────────

function applyDirection() {
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = t("Settings — Lumo");
}

let rendering: Promise<void> | null = null;
let renderAgain = false;

/** Redraws every section from fresh state, keeping the scroll position. */
async function rerender() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  rendering = render();
  try {
    await rendering;
  } finally {
    rendering = null;
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
  if (renderAgain) {
    renderAgain = false;
    await rerender();
  }
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** The list on the left, in its order; each entry shows one page of cards. */
const PAGES = [
  { id: "general", label: N_("General") },
  { id: "island", label: N_("Island") },
  { id: "chat", label: N_("Chat") },
  { id: "voice", label: VOICE_SETTINGS.page },
  { id: "agents", label: N_("Agents") },
  { id: "pills", label: N_("Pills & integrations") },
  { id: "shortcuts", label: N_("Shortcuts") },
  { id: "security", label: N_("Security") },
  { id: "updates", label: N_("Updates") },
] as const;

type PageId = (typeof PAGES)[number]["id"];

/** Where the selected section is remembered between openings (this window only). */
const PAGE_KEY = "lumo.settings.page";

function isPage(id: unknown): id is PageId {
  return PAGES.some((p) => p.id === id);
}

function storedPage(): PageId {
  try {
    const id = window.localStorage.getItem(PAGE_KEY);
    if (isPage(id)) return id;
  } catch {
    // No storage (private mode, blocked): start on the first section.
  }
  return "general";
}

/** The section on screen; it survives every redraw of the window. */
let currentPage: PageId = storedPage();

/** Shows one section and marks it in the list; `fromClick` also scrolls back to the top. */
function showPage(id: PageId, fromClick = true) {
  if (fromClick && id !== currentPage) {
    // A shortcut being recorded would otherwise catch keys typed elsewhere.
    shortcutsListener?.stop();
    currentPage = id;
    try {
      window.localStorage.setItem(PAGE_KEY, id);
    } catch {
      // Not remembered next time; it still shows now.
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-page]")) {
    const on = el.dataset.page === currentPage;
    if (el.classList.contains("page")) el.hidden = !on;
    else {
      el.classList.toggle("on", on);
      if (on) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/** Shown inside the island (views/settings-frame.ts) rather than in its own window. */
const embedded = EMBEDDED || new URLSearchParams(location.search).has("embedded");

function tellIsland(message: string) {
  window.parent.postMessage(message, location.origin);
}

export async function main() {
  onRerender(rerender);
  // Never the webview's menu: Cut, Copy, Paste and Select all in a field.
  installTextMenu();
  // The island's "Customize this menu…" picked a page while this window was open.
  window.addEventListener("storage", (e) => {
    if (e.key === PAGE_KEY && isPage(e.newValue)) showPage(e.newValue);
  });
  if (embedded) {
    document.body.classList.add("embedded");
    // settings.html paints its window colour inline, before any style loads.
    document.body.style.background = "transparent";
    // Escape closes the island, as it does from any other view. The shortcut
    // recorder takes its own Escape first (capture), and so does a colour palette.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) tellIsland(FRAME_CLOSE);
    });
  }
  const boot = await Bridge.boot();
  if (boot) {
    setSettings({ ...settings, ...boot.settings });
    setVersion(boot.version);
    setOnBattery(boot.onBattery === true);
  }
  void onEvent<boolean>("energy-power", (now) => {
    setOnBattery(now === true);
    energyRedraw?.();
  });
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyDirection();
  applyLook();
  onLanguageChange(() => {
    applyDirection();
    void rerender();
  });
  // Whatever goes wrong drawing a section, the island stops waiting for the
  // page (and the error is in lumo.log), rather than saying "Opening Settings…" for ever.
  try {
    await render();
  } catch (err) {
    void Bridge.log(`settings: ${String(err)}`);
  }
  if (embedded) tellIsland(FRAME_READY);

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  // Settings saved elsewhere since they were drawn (the island, the other
  // window): the page, which stays loaded, is drawn again when it comes back
  // on screen. Its own saves come back here too, with nothing new in them.
  let stale = false;
  const backOnScreen = () => {
    if (!stale) return;
    stale = false;
    void rerender();
  };
  if (embedded) {
    window.addEventListener("message", (e) => {
      if (e.source === window.parent && e.origin === location.origin && e.data === FRAME_SHOWN) backOnScreen();
    });
  } else {
    window.addEventListener("focus", backOnScreen);
  }
  void onEvent<Settings>("settings-changed", (s) => {
    // Where the island sits and its size, saved as it is dragged or resized,
    // are on no page here: they never draw the page again, which would wipe
    // what is being typed (an API key) or the diff open.
    if (Object.entries(s).some(([k, v]) => !UNSHOWN_KEYS.has(k) && JSON.stringify(v) !== JSON.stringify((settings as unknown as Record<string, unknown>)[k]))) {
      stale = true;
    }
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.unslothUrl}|${settings.mayaUrl}|${settings.customUrl}`;
    setSettings({ ...settings, ...s });
    shortcutsListener?.settingsChanged();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.unslothUrl}|${settings.mayaUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    applyLanguage();
  });
}

/** The settings the island keeps for itself, shown by no page of Settings. */
const UNSHOWN_KEYS = new Set(["islandDock", "islandOffset", "islandFloat", "islandWidth", "islandHeight", "islandSizes"]);

/** Inside the island, Settings take the island's look (settings.css, html.look-new). */
function applyLook() {
  if (embedded) document.documentElement.classList.add("look-new");
}

/** Reads what the sections show and draws them all. */
export async function render() {
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, current: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const agents = await Bridge.agentHooksList();

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const shortcutReport = await Bridge.shortcutsStatus();

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
    "mail-address", "mail-app-password", "mail-imap-server",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  // A main pill this build can run, and no pill declared twice.
  setSettings({ ...settings, ...sanitizeDeclared(settings) });
  const connected: Record<string, boolean> = { ...((await Bridge.agentHooksStatus()) ?? {}) };
  for (const def of availablePills()) {
    if (def.connect.kind === "key") {
      connected[def.id] = present[def.connect.key] ?? (await Bridge.secretPresent(def.connect.key)) ?? false;
    }
  }
  /** A chat provider's or an integration's key was saved or removed: its pill's row says so at once. */
  const keyChanged = (key: string, on: boolean) => {
    for (const def of availablePills()) {
      if (def.connect.kind === "key" && def.connect.key === key) connected[def.id] = on;
    }
    for (const redraw of declaredViews) redraw();
  };
  const chatKeys: Record<string, boolean> = {};
  for (const def of CLOUD) {
    const key = providerDef(def.id).key!;
    chatKeys[key] = (await Bridge.secretPresent(key)) ?? false;
  }
  const serverKeys: Partial<Record<LocalId, boolean>> = {
    custom: (await Bridge.secretPresent(CUSTOM_SERVER_KEY)) ?? false,
    unsloth: (await Bridge.secretPresent(UNSLOTH_SERVER_KEY)) ?? false,
  };

  declaredViews.length = 0;
  setLocalRedraw(null);
  // A shortcut being recorded ends with the section it was in.
  shortcutsListener?.stop();
  setShortcutsListener(null);

  // Every section is built, so what one redraws (declaredViews, the local
  // models, the shortcuts) works as before; only the selected one shows.
  const pages: Record<PageId, HTMLElement[]> = {
    general: [generalSection()],
    island: [islandSection()],
    chat: [apiSection(hasKey), cliSection("antigravity-cli", N_("Uses your Google account. No key needed.")), cliSection("codex", N_("Uses your ChatGPT account. No key needed.")), cliSection("copilot-cli", N_("Uses your GitHub Copilot plan. No key needed."), COPILOT_MISSING), cliSection("cursor-cli", N_("Uses your Cursor plan. No key needed."), CURSOR_MISSING), chatProvidersSection(chatKeys, keyChanged), localSection(serverKeys), chatNamesSection(), chatUsageSection()],
    voice: [voiceSection(chatKeys, keyChanged, shortcutReport)],
    agents: [claudeCard(status), antigravityCard(agents?.find((a) => a.id === "antigravity") ?? null, connected), chatAgentsSection(), agentsSection(agents), backgroundSection(), planSection(connected)],
    pills: [activePillsSection(connected), integrationsSection(present, keyChanged)],
    shortcuts: [shortcutsSection(shortcutReport)],
    security: [securitySection()],
    updates: [
      updatesSection(version, setting(t("Check when Lumo opens"),
        t("Each time Lumo opens, it asks GitHub once whether a newer version is out, and says so on the island."),
        toggle(settings.updateCheckOnOpen !== false, (v) => { settings.updateCheckOnOpen = v; void save(); }),
      ), setting(t("Beta versions"),
        t("One build with every change not released yet, to try them before they come out. It can have bugs."),
        toggle(settings.updateBeta === true, (v) => { settings.updateBeta = v; void save(); betaChanged(); }),
      ), () => settings.updateBeta === true),
      changelogSection(version),
    ],
  };

  const nav = h("nav", { class: "nav", "aria-label": t("Settings") });
  const content = h("main", { class: "content" });
  for (const page of PAGES) {
    const button = h("button", {
      class: "nav-item",
      "data-page": page.id,
      text: t(page.label),
      onclick: () => {
        // A section picked from the list: the search is done.
        if (searchQuery) {
          searchQuery = "";
          const field = root.querySelector<HTMLInputElement>(".settings-search");
          if (field) field.value = "";
          showSearch();
        }
        showPage(page.id);
      },
    });
    nav.append(button);
    content.append(h("div", { class: "page", "data-page": page.id }, ...pages[page.id]));
  }

  // The search above the list: what is typed shows the matching settings of every section.
  const search = h("input", {
    type: "search",
    class: "settings-search",
    placeholder: t(SEARCH_STRINGS.placeholder),
    "aria-label": t(SEARCH_STRINGS.placeholder),
    spellcheck: "false",
  }) as HTMLInputElement;
  search.value = searchQuery;
  search.addEventListener("input", () => {
    searchQuery = search.value;
    showSearch();
  });
  search.addEventListener("keydown", (e) => {
    // Escape empties the field first; a second one closes the island, as ever.
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      searchQuery = "";
      showSearch();
    }
  });
  const noMatch = h("p", { class: "search-none" });
  content.prepend(noMatch);

  clear(root);
  root.append(
    h("aside", { class: "sidebar" },
      h("h1", {}, h("span", { text: "Lumo" }), h("span", { class: "version", text: version })),
      search,
      nav,
    ),
    content,
  );
  showPage(currentPage, false);
  showSearch();
}

/** What the search field holds; kept when the sections are drawn again. */
let searchQuery = "";

/** Every section with the settings that match the search, or the open section when it is empty. */
function showSearch() {
  const content = root.querySelector<HTMLElement>(".content");
  const noMatch = root.querySelector<HTMLElement>(".search-none");
  if (!content || !noMatch) return;
  const searching = searchQuery.trim() !== "";
  root.classList.toggle("searching", searching);
  if (!searching) {
    applySearch(content, "");
    noMatch.hidden = true;
    showPage(currentPage, false);
    return;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-page]")) {
    if (el.classList.contains("page")) el.hidden = false;
    else {
      el.classList.remove("on");
      el.removeAttribute("aria-current");
    }
  }
  const found = applySearch(content, searchQuery);
  noMatch.textContent = t(SEARCH_STRINGS.none, { query: searchQuery.trim() });
  noMatch.hidden = found;
}

void main();
