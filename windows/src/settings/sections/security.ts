// Settings → Security: what the AI may read and do, and what it asks first.

import { Bridge } from "../../core/bridge";
import { parsePermissionMode, permissionModesFor } from "../../core/providers";
import { aiReads } from "../../core/state";
import { h } from "../../views/dom";
import { group, sectionHead, setting } from "../parts";
import { N_, t } from "../../i18n/i18n";
import { declaredViews, save, select, settings, toggle, whileShown } from "../store";

// ── Security ─────────────────────────────────────────────────────────────────

const SECURITY = {
  get title() { return t("Security"); },
  get intro() { return t("What the AI may see and do on its own."); },
  get onItsOwn() { return t("What it may do on its own"); },
  get permissions() { return t("Default permissions"); },
  get permissionsHint() { return t("How free the agents are in a new chat."); },
  get computerHint() { return t("Claude uses the mouse and keyboard once it has shown you its plan."); },
  get webHint() { return t("Lumo searches the web for the models that can't."); },
  get sees() { return t("What it sees with every message"); },
  get seesHint() { return t("Lumo adds them to every message in the chat."); },
  get windows() { return t("Open windows"); },
  get windowsHint() { return t("Their titles and the documents they show."); },
  get folders() { return t("File Explorer folders"); },
  get foldersHint() { return t("The open folders and the list of their files."); },
  get tabs() { return t("Browser tabs"); },
  get tabsHint() { return t("The tabs open in your browsers."); },
  get accounts() { return t("Your accounts"); },
  get mailHint() { return t("What the AI may do with your email."); },
  get calendarHint() { return t("Read your coming events, or nothing."); },
  get outlookStart() { return t("Open Outlook if it's closed"); },
  get outlookStartHint() { return t("Starts Outlook in the background when Lumo starts, and when you open the Email view."); },
  get githubHint() { return t("Read your pull requests, issues and checks."); },
  get otherFiles() { return t("Other chats' files"); },
  get otherFilesHint() { return t("Agents also read the files given to other chats."); },
  get readAndSend() { return t("Read and send"); },
  get readSendManage() { return t("Read, send and manage"); },
  get readOnly() { return t("Read only"); },
  get noAccess() { return t("No access"); },
  get alwaysOn() { return t("Always on"); },
  get clicks() { return t("Every permission and every send waits for your click."); },
  get keys() { return t("Keys and passwords stay in Windows Credential Manager."); },
  get noData() { return t("Lumo talks only to the services you set up."); },
  get pipe() { return t("Only your Windows account can talk to Lumo."); },
  get updates() { return t("An update is installed only if it matches the one GitHub published."); },
};

/** The chat's permission modes, by the names its shield gives them (views/chat.ts). */
const PERMISSION_NAMES: Record<string, string> = {
  default: N_("Ask every time"), auto: N_("Auto"), plan: N_("Plan only"),
};

/** Lumo's own web search (web_search.rs), for the providers that have none. */
const WEB_SETTINGS = {
  get label() { return t("Search the web for the AI"); },
};

/** The images in the chat's answers (views/rich/image.ts, web_image.rs). */
const WEB_IMAGES = {
  get label() { return t("Images from the web"); },
  get hint() { return t("Shows the images in answers and emails."); },
};

const MAIL_IMAGES = {
  get label() { return t("Email images always"); },
  get hint() { return t("Loads every email's images at once."); },
};

const COMPUTER_SETTINGS = {
  get label() { return t("Let Claude use the computer"); },
  get claudeOnly() { return t("In the chat, pick Claude Code or Antigravity CLI as the provider to use it."); },
};

/** The agents' own hidden browser tabs (browser.rs), for every chat provider. */
const BROWSER_SETTINGS = {
  get label() { return t("Let agents browse the web"); },
  get hint() { return t("Agents open websites in hidden tabs of their own."); },
};

/** A local model's terminal (terminal.rs): commands in its chat's folder, in the Windows sandbox. */
const TERMINAL_SETTINGS = {
  get label() { return t("Let local models use a terminal"); },
  get hint() { return t("Commands in the Windows sandbox, in the chat's folder only."); },
  get network() { return t("Internet in commands"); },
  get networkHint() { return t("A command that wants the internet asks on its card."); },
  get ask() { return t("Ask every time"); },
  get never() { return t("Never"); },
  get timeout() { return t("Longest a command may take"); },
  get timeoutHint() { return t("Then Lumo stops it, with whatever it started."); },
};

/** The times a command may take (terminal.rs TIMEOUTS), in seconds. */
const TERMINAL_TIMEOUTS = [30, 120, 600];

/**
 * Settings → Security: what the chat's agents may do on their own (the
 * permissions, computer use, the agents' browser, web search), what goes with every message,
 * what the AI may do with the email, the calendar and GitHub, and what Lumo
 * always does without a switch. "Open Outlook if it's closed" shows only
 * while Outlook is an Email source of the Email pill, the calendar's row only
 * with a calendar set (Google Calendar or an iCal address, Settings →
 * Island), GitHub's only with its token saved.
 */
export function securitySection(): HTMLElement {
  // The mode every new chat starts from (Antigravity CLI keeps its own; the shield in a chat changes that chat's).
  const mode = parsePermissionMode(settings.chatPermissionMode, "claude-code");
  const permissions = select(
    permissionModesFor("claude-code").map((m): [string, string] => [m, t(PERMISSION_NAMES[m])]),
    mode,
    (v) => { settings.chatPermissionMode = v; void save(); },
  );
  const access = (value: string, onChange: (v: string) => void, send = false) => select(
    [
      ...(send ? [["manage", SECURITY.readSendManage], ["send", SECURITY.readAndSend]] as [string, string][] : []),
      ["read", SECURITY.readOnly],
      ["none", SECURITY.noAccess],
    ],
    send && (value === "send" || value === "manage") ? value : aiReads(value) ? "read" : "none",
    onChange,
  );
  const mailAccess = access(settings.aiMailAccess, (v) => { settings.aiMailAccess = v; void save(); }, true);
  const calendarAccess = access(settings.aiCalendarAccess, (v) => { settings.aiCalendarAccess = v; void save(); });
  const githubAccess = access(settings.aiGithubAccess === "read" ? "read" : "none", (v) => { settings.aiGithubAccess = v; void save(); });
  // The section's menus, one width, one under the other.
  for (const menu of [permissions, mailAccess, calendarAccess, githubAccess]) menu.classList.add("security-select");
  // An email's images at once: only with the images from the web on.
  const mailImages = setting(MAIL_IMAGES.label, MAIL_IMAGES.hint,
    toggle(settings.mailImagesAlways === true, (on) => { settings.mailImagesAlways = on; void save(); }),
  );
  mailImages.hidden = settings.webImages !== true;
  const outlookRow = setting(SECURITY.outlookStart, SECURITY.outlookStartHint,
    toggle(settings.outlookStart === true, (on) => { settings.outlookStart = on; void save(); }),
  );
  const calendarAccessRow = setting(t("Calendar"), SECURITY.calendarHint, calendarAccess);
  const githubRow = setting("GitHub", SECURITY.githubHint, githubAccess);
  calendarAccessRow.hidden = true;
  githubRow.hidden = true;
  const showAccounts = async () => {
    outlookRow.hidden = !(settings.mailOutlook && settings.activeIntegrations.includes("integration_mail"));
    const [ics, google, github] = await Promise.all([
      Bridge.secretPresent("calendar-ics-url"),
      Bridge.googleCalendarStatus(),
      Bridge.secretPresent("github-token"),
    ]);
    calendarAccessRow.hidden = !(ics === true || google?.signedIn === true);
    githubRow.hidden = github !== true;
  };
  void showAccounts();
  declaredViews.push(() => void showAccounts());
  whileShown(githubRow, "focus", () => void showAccounts());
  const note = h("p", { class: "hint", text: COMPUTER_SETTINGS.claudeOnly });
  const showNote = () => {
    // The two providers that use it.
    const cli = ["claude-code", "antigravity-cli"].includes(settings.chatProvider);
    note.hidden = !(settings.chatComputerUse && !cli);
  };
  showNote();
  // The terminal's own rows, only while it is on.
  const terminalNetwork = setting(TERMINAL_SETTINGS.network, TERMINAL_SETTINGS.networkHint,
    select([["ask", TERMINAL_SETTINGS.ask], ["never", TERMINAL_SETTINGS.never]], settings.localTerminalNetwork === "never" ? "never" : "ask", (v) => {
      settings.localTerminalNetwork = v === "never" ? "never" : "ask";
      void save();
    }),
  );
  const timeout = TERMINAL_TIMEOUTS.includes(settings.localTerminalTimeout) ? settings.localTerminalTimeout : 120;
  const terminalTimeout = setting(TERMINAL_SETTINGS.timeout, TERMINAL_SETTINGS.timeoutHint,
    select(TERMINAL_TIMEOUTS.map((s): [string, string] => [String(s), s < 60 ? t("{seconds} s", { seconds: s }) : t("{minutes} min", { minutes: s / 60 })]), String(timeout), (v) => {
      settings.localTerminalTimeout = Number(v);
      void save();
    }),
  );
  for (const row of [terminalNetwork, terminalTimeout]) {
    row.classList.add("setting-under");
    row.querySelector("select")?.classList.add("security-select");
  }
  const showTerminal = () => {
    terminalNetwork.hidden = !settings.localTerminal;
    terminalTimeout.hidden = !settings.localTerminal;
  };
  showTerminal();
  return h(
    "section",
    {},
    ...sectionHead(SECURITY.title, SECURITY.intro),
    group(SECURITY.onItsOwn),
    setting(SECURITY.permissions, SECURITY.permissionsHint, permissions),
    setting(COMPUTER_SETTINGS.label, SECURITY.computerHint,
      toggle(settings.chatComputerUse === true, (on) => {
        settings.chatComputerUse = on;
        showNote();
        void save();
      }),
    ),
    note,
    setting(BROWSER_SETTINGS.label, BROWSER_SETTINGS.hint,
      toggle(settings.chatBrowser === true, (on) => {
        settings.chatBrowser = on;
        void save();
      }),
    ),
    setting(TERMINAL_SETTINGS.label, TERMINAL_SETTINGS.hint,
      toggle(settings.localTerminal === true, (on) => {
        settings.localTerminal = on;
        showTerminal();
        void save();
      }),
    ),
    terminalNetwork,
    terminalTimeout,
    setting(WEB_SETTINGS.label, SECURITY.webHint,
      toggle(settings.chatWebSearch === true, (on) => { settings.chatWebSearch = on; void save(); }),
    ),
    setting(WEB_IMAGES.label, WEB_IMAGES.hint,
      toggle(settings.webImages === true, (on) => {
        settings.webImages = on;
        mailImages.hidden = !on;
        void save();
      }),
    ),
    mailImages,
    setting(SECURITY.otherFiles, SECURITY.otherFilesHint,
      toggle(settings.chatOtherFiles === true, (on) => { settings.chatOtherFiles = on; void save(); }),
    ),
    group(SECURITY.sees),
    h("p", { class: "hint group-hint", text: SECURITY.seesHint }),
    setting(SECURITY.windows, SECURITY.windowsHint,
      toggle(settings.chatShareOpen === true, (on) => { settings.chatShareOpen = on; void save(); }),
    ),
    setting(SECURITY.folders, SECURITY.foldersHint,
      toggle(settings.chatShareExplorer, (on) => { settings.chatShareExplorer = on; void save(); }),
    ),
    setting(SECURITY.tabs, SECURITY.tabsHint,
      toggle(settings.chatShareTabs === true, (on) => { settings.chatShareTabs = on; void save(); }),
    ),
    group(SECURITY.accounts),
    setting(t("Email"), SECURITY.mailHint, mailAccess),
    outlookRow,
    calendarAccessRow,
    githubRow,
    group(SECURITY.alwaysOn),
    h("ul", { class: "always-on" },
      h("li", { text: SECURITY.clicks }),
      h("li", { text: SECURITY.keys }),
      h("li", { text: SECURITY.noData }),
      h("li", { text: SECURITY.pipe }),
      h("li", { text: SECURITY.updates }),
    ),
  );
}
