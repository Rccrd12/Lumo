// Gemini Live — the tools that work the computer itself: its settings (volume,
// brightness, power plan, lock), its windows, its files, how it is doing, its
// notifications and reminders at a time of day. What the model is told of
// them and what it hears back, as pure functions like protocol.ts (which lists
// them with its own); pc-tools.ts runs them.
//
// Moving files takes two calls, the second only after the user said yes to
// the plan the first one gave, and the last move can be put back.

import type { PcFilePlan, PcStatus } from "../core/bridge";
import { parseDuration } from "../core/compact";
import type { FunctionDeclaration } from "./protocol";

export const PC_TOOL = {
  control: "control_computer",
  windows: "arrange_windows",
  status: "computer_status",
  moveFiles: "move_files",
  confirmMove: "confirm_file_moves",
  undoMove: "undo_file_moves",
  notifications: "read_notifications",
  remind: "set_reminder",
  reminders: "list_reminders",
  cancelReminder: "cancel_reminder",
} as const;

export const CONTROL_ACTIONS = ["volume", "volume_up", "volume_down", "mute", "unmute", "brightness", "brightness_up", "brightness_down", "power_plan", "lock"];
export const WINDOW_ACTIONS = ["focus", "left", "right", "maximize", "minimize", "restore", "close"];

type Schema = NonNullable<FunctionDeclaration["parameters"]>;
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema =>
  required.length ? { type: "OBJECT", properties, required } : { type: "OBJECT", properties };
const str = (description: string): Schema => ({ type: "STRING", description });
const int = (description: string): Schema => ({ type: "INTEGER", description });

/** What the model may ask for, besides the tools of protocol.ts. */
export function pcToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: PC_TOOL.control,
      description: "Changes the computer's volume, the screen's brightness or the power plan, or locks the computer. Without a value it tells how they are now.",
      parameters: obj({
        action: str(`One of: ${CONTROL_ACTIONS.join(", ")}.`),
        value: int("For volume or brightness: the level to set, 0–100. Leave it out to just read it."),
        plan: str("For power_plan: \"saver\", \"balanced\" or \"performance\". Leave it out to just read it."),
      }, ["action"]),
    },
    {
      name: PC_TOOL.windows,
      description: "Brings a window to the front, puts it on the left or right half of its screen, maximises, minimises, restores or closes it, by its app or title.",
      parameters: obj({
        window: str("The app or words of the title, e.g. \"Chrome\", \"Excel\", \"budget\"."),
        action: str(`One of: ${WINDOW_ACTIONS.join(", ")}.`),
      }, ["window", "action"]),
    },
    {
      name: PC_TOOL.status,
      description: "How the computer is doing right now: processor, memory, disks, battery, and the programs using the most of them.",
    },
    {
      name: PC_TOOL.moveFiles,
      description: "Plans moving or renaming files and folders and making new folders, in the user's home folder. It changes nothing: it gives a plan with an id. Tell the user what it will do and call confirm_file_moves only once they say yes.",
      parameters: obj({
        moves: {
          type: "ARRAY",
          description: "Each file or folder to move: from its absolute path to a new absolute path, or into a folder.",
          items: obj({ from: str("Absolute path now."), to: str("New absolute path, or the folder to put it in.") }, ["from", "to"]),
        },
        folders: { type: "ARRAY", description: "Absolute paths of folders to make first.", items: str("Absolute path.") },
      }),
    },
    {
      name: PC_TOOL.confirmMove,
      description: "Does the plan of move_files the user just agreed to. Never call it before the user said yes.",
      parameters: obj({ plan_id: int("The plan's id, from move_files.") }, ["plan_id"]),
    },
    { name: PC_TOOL.undoMove, description: "Puts back the files the last confirm_file_moves moved." },
    { name: PC_TOOL.notifications, description: "Reads the notifications in Windows' notification centre: which app, what it says, when." },
    {
      name: PC_TOOL.remind,
      description: "Sets a reminder that rings on Lumo's island at a date and time, even after a restart. For a few minutes from now, set_timer is simpler.",
      parameters: obj({
        at: str("Local date and time, \"YYYY-MM-DDTHH:MM\", e.g. \"2026-10-15T09:30\"."),
        in: str("Or how long from now: \"2h\", \"1h30m\", \"45m\"."),
        text: str("What to remind, in the user's language, a few words."),
      }, ["text"]),
    },
    { name: PC_TOOL.reminders, description: "Lists the reminders still to ring, with their ids." },
    {
      name: PC_TOOL.cancelReminder,
      description: "Cancels a reminder by its id, from list_reminders.",
      parameters: obj({ id: int("The reminder's id.") }, ["id"]),
    },
  ];
}

/** What the system instruction says of them. */
export function pcInstructions(): string[] {
  return [
    "- control_computer sets the volume, the brightness or the power plan, or locks the computer. \"Turn it up\" is volume_up; give a value for \"volume at 30\". Lock only when the user asks. Windows has no way for you to turn on Do not disturb: say so if asked.",
    "- arrange_windows brings a window to the front, puts it on the left or right half of the screen, maximises, minimises or closes it. For \"VS Code on the left and Chrome on the right\", call it twice. Closing works like the window's ×: the app asks about unsaved work itself.",
    "- computer_status tells how the computer is doing and which programs use the most; use it when the user says it is slow, hot, full or the battery drains.",
    "- move_files plans moving, renaming or sorting files into folders (\"tidy up my Downloads\"): first look at the folder with read_file, then call move_files. It moves nothing: tell the user in a sentence what the plan does (how many files, where) and what it skips, and call confirm_file_moves with its id only after they say yes. Nothing is ever deleted or overwritten. undo_file_moves puts the last move back.",
    "- read_notifications reads Windows' notifications. Summarise them; never read codes or private messages aloud unless asked.",
    "- set_reminder rings on the island at a date and time, even after a restart (\"remind me tomorrow at 9 to call the bank\"). list_reminders and cancel_reminder manage them.",
  ];
}

export const isPcTool = (name: string): boolean => (Object.values(PC_TOOL) as string[]).includes(name);

export const textArg = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const numberArg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** "2026-10-15T09:30" (local time) as ms, or null; a bare date is 9 in the morning. */
export function parseLocalTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 9, m[5] ? Number(m[5]) : 0];
  const date = new Date(y, mo - 1, d, hh, mm, 0, 0);
  // new Date rolls 31 February over to March: that is not what was said.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== hh) return null;
  return date.getTime();
}

/** When a reminder rings, from `at` or `in`. */
export function reminderTime(args: Record<string, unknown>, now: number): number | null {
  const at = textArg(args.at);
  if (at) return parseLocalTime(at);
  const after = parseDuration(textArg(args.in));
  return after == null ? null : now + after;
}

/** A time as the model says it back: "Thu 15 Oct, 09:30". */
export function said(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** A notification's text with its codes hidden: a run of 4 to 8 digits, spaces
 *  or dashes between them allowed, is most likely a sign-in code, and it has no
 *  business going to Google. */
export function hideCodes(text: string): string {
  return text.replace(/(?<!\d)\d(?:[ -]?\d){3,7}(?!\d)/g, "••••");
}

/** What the model hears of a plan. */
export function planResult(plan: PcFilePlan): Record<string, unknown> {
  return {
    plan_id: plan.id,
    moves: plan.moves.length,
    ...(plan.moves.length ? { examples: plan.moves.slice(0, 8) } : {}),
    ...(plan.newFolders.length ? { new_folders: plan.newFolders } : {}),
    ...(plan.skipped.length ? { skipped: plan.skipped.slice(0, 10) } : {}),
    note: "Nothing has moved yet. Tell the user what this does and call confirm_file_moves with plan_id only once they say yes.",
  };
}

/** What the model hears of the computer's state. */
export function statusResult(st: PcStatus): Record<string, unknown> {
  return {
    processor: `${st.cpuPercent}%`,
    memory: `${st.memoryUsedGb} of ${st.memoryTotalGb} GB in use`,
    disks: st.disks.map((d) => `${d.drive} ${d.freeGb} GB free of ${d.totalGb}`),
    ...(st.battery ? { battery: `${st.battery.percent}%${st.battery.charging ? ", charging" : st.battery.minutesLeft != null ? `, about ${st.battery.minutesLeft} min left` : ""}` } : {}),
    on_for: `${st.uptimeHours} hours`,
    busiest: st.busiest.map((p) => `${p.name} ${p.cpuPercent}%`),
    most_memory: st.biggest.map((p) => `${p.name} ${p.memoryMb} MB`),
  };
}
