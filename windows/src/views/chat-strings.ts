// The chat's words and small constants (views/chat.ts): what its buttons,
// menus and notes say, the effort and permission names, and the limits it
// keeps to.

import { usesLumoTools, type PermissionMode, type ProviderDef, type SandboxLevel } from "../core/providers";
import { N_, t } from "../i18n/i18n";

/** At most this many watches wait for the user's word in one chat: the latest are kept. */
export const MAX_LISTEN_ASKS = 6;

export const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  /** The field, while a question is asked of one agent (Ask). */
  askPlaceholder: N_("Ask {name}…"),
  /** Over the field and in the queued question: who the question goes to. */
  asking: N_("Asking {name}"),
  planKeep: N_("Keep planning"),
  planApprove: N_("Approve the plan"),
  listenAsk: N_("Start listening?"),
  listenWhy: N_("The answer asks Lumo to listen. What Lumo hears goes back to the chat as a message."),
  listenThen: N_("then: {task}"),
  listenNo: N_("Not now"),
  listenYes: N_("Listen"),
  listenDoesOnce: N_("{helper} will do it by itself when it happens, without asking you again."),
  listenDoesEvery: N_("{helper} will do it by itself each time it happens, without asking you again."),
  heardAsk: N_("Ask {helper}"),
  heardOpen: N_("Open that chat"),
  heardClose: N_("Close"),
  heardIn: N_("Heard in the chat «{chat}»"),
  heardDoing: N_("{helper} takes care of it in its chat, «{chat}»"),
  heardUnsent: N_("The task did not start"),
  planChange: N_("Or write what to change…"),
  send: N_("Send"),
  toEnd: N_("Go to the bottom"),
  showMore: N_("Show more"),
  showLess: N_("Show less"),
  /** The picker's last current row: Claude Code's older versions, as many as {count}, open under it. */
  moreModels: N_("More models ({count})"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  noProvider: N_("No provider is set up yet: add a key, or install Claude Code's or Antigravity's hooks, in Settings."),
  openSettings: N_("Open Settings"),
  newChat: N_("New chat"),
  pastChats: N_("Past chats"),
  attachments: N_("Attachments"),
  noAttachments: N_("Nothing is attached yet."),
  attachHint: N_("Files, screenshots, windows, pages and selected text wait here for your next question."),
  removeAll: N_("Remove all"),
  chatFiles: N_("Chat files"),
  noChatFiles: N_("No files in this chat yet."),
  chatFilesHint: N_("The files attached here, and the ones the AI reads, edits or creates, stay here to open again."),
  computer: N_("Computer"),
  computerHint: N_("Folders, windows, pages, screenshots and text from your computer"),
  removeFromContext: N_("Remove from the chat's context"),
  fileMissing: N_("No longer found"),
  openFile: N_("Open"),
  openLocation: N_("Open file location"),
  copyPath: N_("Copy path"),
  noPastChats: N_("No past chats yet."),
  searchChats: N_("Search the past chats"),
  noMatch: N_("No chat says that."),
  deleteChat: N_("Delete this chat"),
  renameChat: N_("Rename this chat"),
  renameKeys: N_("Enter saves · Esc cancels"),
  attach: N_("Attach a file"),
  attachShots: N_("Attach"),
  cancel: N_("Cancel"),
  effort: N_("Effort"),
  effortAuto: N_("Auto"),
  recommended: N_("Recommended"),
  autoHint: N_("Auto: Claude Code picks the effort its model is made for."),
  permissions: N_("Permissions"),
  sandbox: N_("Sandbox"),
  isolate: N_("How to isolate code?"),
  welcome: N_("What can I do for you?"),
  askFile: N_("Ask about a file"),
  lookScreen: N_("Look at my screen"),
  writeMessage: N_("Write a message"),
  writeMessageStart: N_("Help me write a message to "),
  stop: N_("Stop"),
  stopped: N_("Stopped"),
  edit: N_("Edit"),
  retry: N_("Retry"),
  editing: N_("Editing a message"),
  editingHint: N_("Sending replaces this message and everything after it."),
  sentWith: N_("Sent with this message"),
  comeBack: N_("Come back with the message"),
  leaveContext: N_("Leave the context"),
  comeBackHint: N_("What comes back waits in the attachments: take anything out with its ×."),
  queued: N_("Queued"),
  queuedHint: N_("Sent as soon as this answer ends"),
};

/**
 * A message held because it would start the chat's CLI again under the
 * agents it left at work (another model, effort, mode, folder or tools:
 * chat_agents.rs WOULD_STOP): the bar above the field.
 */
export const HOLD_TEXT = {
  stops: N_("{name} starts again with the new settings and stops the {count} agents still working."),
  choose: N_("Your message can wait for them to finish, or go now."),
  waiting: N_("Your message goes when the {count} agents still working finish."),
  wait: N_("Send when they finish"),
  now: N_("Send now and stop them"),
  /** An edited question (Edit, Retry) starts the chat's CLI again: its agents stop with it. */
  editStops: N_("Editing the question starts {name} again and stops the {count} agents still working."),
  editChoose: N_("You can wait for them to finish, or edit it now."),
  editWaiting: N_("Your edit goes when the {count} agents still working finish."),
  editWait: N_("Edit when they finish"),
  editNow: N_("Edit now and stop them"),
};

/** The providers whose CLI an edited question starts again (chat_rewind closes it): their agents at work stop with it. */
export const RESTART_ON_EDIT: ReadonlySet<string> = new Set(["claude-code", "codex", "antigravity-cli"]);

/** The commands' icons drawn filled (core/slash.ts); the others are strokes. */
export const FILLED_ICONS = new Set(["plus", "gear", "timer", "stack"]);

/** The effort levels by name, "Auto" for the CLI's own default. */
/** Two arrows meeting at a line: the chat pressed together. */
export const COMPACT_ICON = "M12 3.5v5.5M9 6.5l3 2.5 3-2.5M12 20.5V15M9 17.5l3-2.5 3 2.5M5 12h14";

/** How full a local model's context is (%) before the chat compacts itself. */
export const AUTO_COMPACT_PCT = 80;

/** /compact with the providers called by their API. */
export const COMPACT_STRINGS = {
  action: N_("Compact the chat"),
  working: N_("Compacting the chat…"),
  done: N_("Chat compacted: the model now starts from its summary"),
  auto: N_("Context at {pct}%: compacting the chat before answering…"),
  autoDone: N_("Chat compacted by itself: the model starts again from its summary"),
  nothing: N_("Nothing new to compact"),
};

/** The picker's − and + on a local model: in and out of the server's memory. */
export const LOAD_STRINGS = {
  load: N_("Load into memory"),
  eject: N_("Eject from memory"),
  loading: N_("Loading the model…"),
};
const LOAD_RING = "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z";
export const LOAD_MINUS = `${LOAD_RING}M8.5 12h7`;
export const LOAD_PLUS = `${LOAD_RING}M8.5 12h7M12 8.5v7`;

const EFFORT_NAMES: Record<string, string> = {
  // A local model that thinks or doesn't (local_models.rs).
  off: N_("Off"),
  on: N_("On"),
  low: N_("Low"),
  medium: N_("Medium"),
  high: N_("High"),
  xhigh: N_("Extra high"),
  max: N_("Max"),
};

/** Each permission mode of the CLIs: its name and what it lets through. */
const PERMISSION_TEXT: Record<Exclude<PermissionMode, "off">, { name: string; note: string }> = {
  default: { name: N_("Ask every time"), note: N_("Asks before each action that needs a permission.") },
  auto: { name: N_("Auto"), note: N_("The AI decides what is safe to do without asking, and asks for the rest.") },
  plan: { name: N_("Plan only"), note: N_("Reads and plans, and changes nothing.") },
};

/** Auto with Antigravity CLI: agy's own Turbo preset (antigravity_cli.rs). */
const AGY_AUTO_NOTE = N_("Runs every command and changes any file without asking.");
/** Auto with Copilot CLI or Cursor CLI: an action allowed once is allowed for the rest of the chat (acp_chat.rs). */
const ACP_AUTO_NOTE = N_("Asks when the CLI asks. What you allow is allowed for the rest of the chat.");
/**
 * The modes with a local model or a provider called by its API, whose actions
 * are the user's tools and the web (local_chat.rs, tools.rs Asking).
 */
const LOCAL_TEXT: Record<PermissionMode, { name: string; note: string }> = {
  default: { name: N_("Ask for approval"), note: N_("Asks before using tools or the internet.") },
  auto: { name: N_("Approve for me"), note: N_("Only asks for risky actions.") },
  off: { name: N_("Run automatically"), note: N_("Never asks. Code stays in the sandbox.") },
  plan: { name: PERMISSION_TEXT.plan.name, note: N_("Gets none of your tools: it only answers and plans.") },
};

/** A mode's name and note with `provider`. */
export function modeText(provider: ProviderDef, mode: PermissionMode): { name: string; note: string } {
  if (usesLumoTools(provider.id) || mode === "off") return LOCAL_TEXT[mode];
  const text = PERMISSION_TEXT[mode];
  if (mode === "auto" && provider.id === "antigravity-cli") return { ...text, note: AGY_AUTO_NOTE };
  if (mode === "auto" && (provider.id === "copilot-cli" || provider.id === "cursor-cli")) return { ...text, note: ACP_AUTO_NOTE };
  return text;
}

/**
 * How far a local model's tools are kept from the computer (Settings.localSandbox).
 * Its "Low" and "High" are not the effort's: other languages may say them
 * another way (Italian: Bassa, not Basso), so their keys carry the context
 * before a "|" (`tc`).
 */
export const SANDBOX_TEXT: Record<SandboxLevel, { name: string; note: string; color: string }> = {
  low: { name: N_("sandbox|Low"), note: N_("Only Lumo's protections. Risky code asks first."), color: "#f5a524" },
  high: { name: N_("sandbox|High"), note: N_("Tools also run in the Windows sandbox."), color: "#4ade80" },
};

/** A key with its context ("sandbox|Low"): its translation, else its English after the "|". */
export function tc(key: string): string {
  const text = t(key);
  return text === key ? key.slice(key.indexOf("|") + 1) : text;
}

/** What the effort says, in the interface language. */
export function effortLabel(effort: string): string {
  return effort ? t(EFFORT_NAMES[effort] ?? effort) : t(STRINGS.effortAuto);
}
