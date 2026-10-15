// Gemini Live — runs the tools for the computer itself (pc-protocol.ts
// declares them): each once, when the model asks, through Rust.

import { Bridge } from "../core/bridge";
import { timerLeft } from "../core/compact";
import { N_, t } from "../i18n/i18n";
import {
  CONTROL_ACTIONS, PC_TOOL, WINDOW_ACTIONS, hideCodes, numberArg, planResult, reminderTime, said, statusResult, textArg,
} from "./pc-protocol";
import type { FunctionCall } from "./protocol";

/** What the call view says the model is doing. */
export const PC_STRINGS = {
  adjusting: N_("Adjusting the computer"),
  arranging: N_("Arranging the windows"),
  checking: N_("Checking how the computer is doing"),
  movingFiles: N_("Moving files"),
  readingNotifications: N_("Reading the notifications"),
  reminding: N_("Setting a reminder"),
};

/** Runs one of pc-protocol.ts's tools; throws what the model hears as the error. */
export async function runPcTool(call: FunctionCall, doing: (label: string | null) => void): Promise<unknown> {
  const a = call.args;
  switch (call.name) {
    case PC_TOOL.control: {
      const action = textArg(a.action);
      if (!CONTROL_ACTIONS.includes(action)) throw new Error(`Say one of: ${CONTROL_ACTIONS.join(", ")}.`);
      doing(t(PC_STRINGS.adjusting));
      return await Bridge.pcControl(action, numberArg(a.value), textArg(a.plan) || null);
    }
    case PC_TOOL.windows: {
      const action = textArg(a.action);
      if (!WINDOW_ACTIONS.includes(action)) throw new Error(`Say one of: ${WINDOW_ACTIONS.join(", ")}.`);
      doing(t(PC_STRINGS.arranging));
      const done = await Bridge.pcWindow(textArg(a.window), action);
      return { done: action, window: done.title, app: done.app };
    }
    case PC_TOOL.status:
      doing(t(PC_STRINGS.checking));
      return statusResult(await Bridge.pcStatus());
    case PC_TOOL.moveFiles: {
      const moves = (Array.isArray(a.moves) ? a.moves : [])
        .map((m) => (m && typeof m === "object" ? { from: textArg((m as Record<string, unknown>).from), to: textArg((m as Record<string, unknown>).to) } : null))
        .filter((m): m is { from: string; to: string } => !!m && !!m.from && !!m.to);
      const folders = (Array.isArray(a.folders) ? a.folders : []).map(textArg).filter(Boolean);
      return planResult(await Bridge.pcFilesPlan(moves, folders));
    }
    case PC_TOOL.confirmMove: {
      const id = numberArg(a.plan_id);
      if (id == null) throw new Error("Give the plan_id move_files returned.");
      doing(t(PC_STRINGS.movingFiles));
      return await Bridge.pcFilesApply(id);
    }
    case PC_TOOL.undoMove:
      doing(t(PC_STRINGS.movingFiles));
      return await Bridge.pcFilesUndo();
    case PC_TOOL.notifications: {
      doing(t(PC_STRINGS.readingNotifications));
      const list = await Bridge.pcNotifications();
      if (list.length === 0) return { none: "There are no notifications." };
      return { notifications: list.map((x) => ({ app: x.app, text: hideCodes(x.text), when: x.at ? said(x.at * 1000) : undefined })) };
    }
    case PC_TOOL.remind: {
      const text = textArg(a.text);
      if (!text) throw new Error("Say what the reminder is for.");
      const now = Date.now();
      const at = reminderTime(a, now);
      if (at == null) throw new Error("Say when: at \"YYYY-MM-DDTHH:MM\" or in \"2h\".");
      doing(t(PC_STRINGS.reminding));
      const r = await Bridge.remindersAdd(Math.round(at), text);
      return { set: true, id: r.id, rings: said(r.at), in: timerLeft(r.at - now) };
    }
    case PC_TOOL.reminders: {
      const list = (await Bridge.remindersList()) ?? [];
      if (list.length === 0) return { none: "No reminders are set." };
      return { reminders: list.map((r) => ({ id: r.id, rings: said(r.at), text: r.text })) };
    }
    case PC_TOOL.cancelReminder: {
      const id = numberArg(a.id);
      if (id == null) throw new Error("Give the reminder's id, from list_reminders.");
      if (!(await Bridge.remindersCancel(id))) throw new Error("There is no reminder with that id.");
      return { cancelled: true };
    }
    default:
      throw new Error(`There is no tool called ${call.name}.`);
  }
}
